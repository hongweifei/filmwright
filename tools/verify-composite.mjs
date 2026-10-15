// 图层合成与嵌套合成的端到端验收（真浏览器 + 真像素）。
//
//   node tools/verify-composite.mjs [<仓库根>]
//
// 三块内容：
//
//   A 图层变换的**逐属性隔离**（examples/scenecast）：
//     · 声明了但全是默认值的 transform ⇒ 与不写 transform 逐字节相同（快路径）；
//     · x / rotate / alpha / blend 各自的改动**互不相同**（逐块亮度差向量两两不等）；
//     · alpha 的**方向**可量化：同帧同区域的平均亮度差随 (1-alpha) 线性变化，
//       比值由我们传进去的 alpha 算出 —— 不是「画面变了」这种无区分力的判据。
//     并带一条**负面对照**：把「全默认值」改成 x:1，同一个谓词必须判红。
//
//   B 混合夹具：图层变换、嵌套循环、素材片段三种能力在**同一个项目里同时启用**，
//     然后逐个关掉其中一种 —— 只在它所属镜头的区间上要求画面变化，
//     在另外两个镜头的区间上要求**逐块不变**（证明量的是那块区域，不是整帧）。
//     代理渲染与增量复用的判据在 verify-incremental.mjs，这里不重复。
//
//   C 嵌套合成实例：声明式 comps + type:comp 在真浏览器里编译成实例并**真的画出来**；
//     实例看到的本地帧与 comp.js 的 localFrame 在像素上逐位一致，且循环周期取
//     子合成声明的 frames，而不是实例在时间轴上占用的帧数
//     （这一条是 verify-comp.mjs 删除后必须补上的空档：它自己拿常量重算了一遍
//      localFrame，接错 cycleLen 也照样全绿）。
//
//   D 父子绑定（`follow`）与空物体（`empty`）：量**方向 / 单调 / 逐字节等价**，不是
//     「画面变了」。父=空物体 ⇒ 画面里能动的东西只有子层，于是「只动父、不动子」时
//     子的重心必须同向移动；父只旋转 90° 时子的 +x 偏置必须转到下方（相加式/替换式/
//     忽略父的实现都做不到）；父变换全默认时写不写 `follow` 逐字节相同；空物体把变换
//     设成任意值画面逐字节不变。负面对照：去掉 `follow`（绑定失效）⇒ 同一个谓词判红。
//
// 每个变异都在**同一个渲染页里重新 boot 一次**（boot 是公开入口，会走
// 校验 → compileScene → 装镜头表这条真路），不逐个变异开浏览器：
// 开一次约 1.7s，十几次就是十几秒和十几个 Chrome 实例（机器忙时会等 boot 等到超时）。
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// resolve() 保证 ROOT 是**绝对路径**：下面要用它拼 file:// URL（相对路径会抛
// ERR_INVALID_FILE_URL_PATH）。⚠️ 必须给兜底：CI 里这个工具是**不带参数**跑的
// （`node tools/verify-X.mjs`），`resolve(undefined)` 会抛 ERR_INVALID_ARG_TYPE。
const ROOT = resolve(process.argv[2] ?? resolve(HERE, '..')).replace(/\\/g, '/');
const KIT = `${ROOT}/bin/filmwright.mjs`;
const MIX = `${ROOT}/.work/composite-mixed`;

let bad = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) bad++; };
const hash = (b) => createHash('sha256').update(b).digest('hex').slice(0, 12);
const clone = (o) => JSON.parse(JSON.stringify(o));

const imp = (rel) => import(pathToFileURL(`${ROOT}/${rel}`).href);
const {serveProject} = await imp('src/host/project/server.mjs');
const {openSession} = await imp('src/host/browser/session.mjs');
const {loadProject} = await imp('src/host/project/load.mjs');
const {openProjectSession} = await imp('src/host/media/renderRange.mjs');

// ---------- 区域测量：把一个画面分成小块，逐块算平均亮度 ----------
// 分块数只决定「量在哪块区域」，不是被测实现的常数。
const COLS = 32;
const ROWS = 18;

const gridExpr = (n) => `(() => {
  window.__renderFrame(${n});
  const c = document.querySelector('canvas');
  const g = c.getContext('2d');
  const d = g.getImageData(0, 0, c.width, c.height).data;
  const cols = ${COLS}, rows = ${ROWS};
  const out = [];
  for (let gy = 0; gy < rows; gy++) {
    const y0 = Math.floor((gy * c.height) / rows), y1 = Math.floor(((gy + 1) * c.height) / rows);
    for (let gx = 0; gx < cols; gx++) {
      const x0 = Math.floor((gx * c.width) / cols), x1 = Math.floor(((gx + 1) * c.width) / cols);
      let s = 0, k = 0;
      for (let y = y0; y < y1; y++) {
        let o = (y * c.width + x0) * 4;
        for (let x = x0; x < x1; x++, o += 4) {
          s += 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
          k++;
        }
      }
      out.push(k ? s / k : null);
    }
  }
  return out;
})()`;

const gridAt = (sess, n) => sess.evaluate(gridExpr(n));

/** 逐块亮度差超过 tol 的块下标 —— 判据只在**这些块**上量。 */
const changedBlocks = (a, b, tol = 0.5) => {
  const idx = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] === null || b[i] === null) continue;
    if (Math.abs(a[i] - b[i]) > tol) idx.push(i);
  }
  return idx;
};
const meanOf = (g, idx) => (idx.length ? idx.reduce((s, i) => s + g[i], 0) / idx.length : NaN);
/** 区域统计：本变体相对基线的平均亮度差（正 = 更亮，负 = 更暗）。 */
const regionStats = (grid, baseGrid, idx) => {
  const mean = meanOf(grid, idx);
  return {mean, delta: mean - meanOf(baseGrid, idx)};
};
const signedDiff = (a, b) => a.map((v, i) => (v === null || b[i] === null ? 0 : v - b[i]));
const maxAbsDiff = (a, b) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);

/** 指定块集合上的亮度加权重心（块坐标：x 向右、y 向下）。 */
const centroid = (grid, idx) => {
  let sx = 0, sy = 0, w = 0;
  for (const i of idx) {
    const v = grid[i];
    if (v === null || v <= 0) continue;
    sx += v * (i % COLS);
    sy += v * Math.floor(i / COLS);
    w += v;
  }
  return w > 0 ? {x: sx / w, y: sy / w, w} : null;
};

/**
 * 「变化覆盖的那块区域」内的重心位移 —— 只在**改动覆盖的区域**上量。
 * 位移为 0 有两种情况：区域为空（画面没动）或重心恰好没移，都在 blocks 里分得清。
 */
const moveOf = (g0, g1, tol = 0.5) => {
  const idx = changedBlocks(g0, g1, tol);
  const c0 = centroid(g0, idx);
  const c1 = centroid(g1, idx);
  return {blocks: idx.length, dx: c0 && c1 ? c1.x - c0.x : 0, dy: c0 && c1 ? c1.y - c0.y : 0};
};

/** D 段「跟着父往右动」的谓词本体：正反两处都用它，负面对照才有意义。 */
const followedRight = (m) => m.blocks > 0 && m.dx > 0;

/**
 * 在**同一个页面里**用另一份 scene 重新 boot。
 * 走的是真路：boot → validateScene → compileScene → 装镜头表，
 * 之后 `window.__renderFrame` 画的就是新规格。
 */
const bootSceneExpr = (sc) => `(async () => {
  const {boot} = await import('/kit/runtime/stage/index.js');
  const p = await import('/__filmwright/project.js');
  const c = document.querySelector('canvas');
  await boot({config: p.config, timeline: p.timeline, scene: ${JSON.stringify(sc)}, clips: p.clips ?? null},
    (w, h) => {
      c.width = w; c.height = h; c.style.width = w + 'px'; c.style.height = h + 'px';
    });
  return {w: c.width, h: c.height};
})()`;

// 镜头起点与总帧数**由实现报出**（页面里的 timeline 状态是 camelCase 的
// totalFrames，不是时间轴文件里的 total_frames —— 写错会静默变成 undefined）。
const shotInfoExpr = (sc) => `(async () => {
  try {
    const templates = await import('/kit/runtime/scene/templates.js');
    const tl = window.__filmwright.timeline;
    const shots = templates.compileScene(${JSON.stringify(sc)}, tl);
    return {
      starts: shots.map((s) => s.start),
      types: shots.map((s) => (s.scene && s.scene.type) || null),
      total: tl.totalFrames,
    };
  } catch (e) {
    return {err: String((e && e.stack) || e)};
  }
})()`;

/** 页面探针出错时**明确报错**，别让它退化成 NaN 之后再在别处炸。 */
const shotInfoOf = async (sess, sc) => {
  const info = await sess.evaluate(shotInfoExpr(sc));
  if (!info || info.err || !Array.isArray(info.starts) || !(info.total > 0)) {
    throw new Error('filmwright 页面探针拿不到镜头信息：' + JSON.stringify(info).slice(0, 400));
  }
  return info;
};

/** 从实现报出的镜头起点算每个镜头的区间与端点。 */
const spansOf = (info) => {
  const ends = info.starts.map((s, i) => (i + 1 < info.starts.length ? info.starts[i + 1] - 1 : info.total));
  return info.starts.map((s, i) => ({from: s, to: ends[i], mid: Math.floor((s + ends[i]) / 2)}));
};

/**
 * 在页面里跑嵌套合成探针：编译场景 → 拿 comp 实例 → 反复画到离屏画布上。
 * 参考画法：把夹具声明的子镜头当顶层镜头编译，再按 localFrame 算出的本地帧画，
 * 与实例那条路嵌套同样的 applyDesignScale 层数 —— 两者逐像素比。
 * 探针帧全部从实例自己的 start / len / span 推出来，不写死帧号。
 */
const compProbe = async (sess, sc, {compIndex, fps}) => sess.evaluate(`(async () => {
  const templates = await import('/kit/runtime/scene/templates.js');
  const compMod = await import('/kit/runtime/composite/comp.js');
  const design = await import('/kit/runtime/layout/design.js');
  const tl = window.__filmwright.timeline;
  const scene = ${JSON.stringify(sc)};
  const ci = ${compIndex};
  const fps = ${fps};
  const canvas = document.querySelector('canvas');
  const W = canvas.width, H = canvas.height;
  const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };
  const A = mk(), B = mk();
  const ga = A.getContext('2d'), gb = B.getContext('2d');
  const SENT = [255, 0, 255, 255];
  const fill = (g) => {
    g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    g.fillStyle = '#ff00ff'; g.fillRect(0, 0, W, H);
  };
  const px = (g) => g.getImageData(0, 0, W, H).data;
  const same = (x, y) => { const a = px(x), b = px(y); for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
  const painted = (g) => {
    const a = px(g); let k = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (!(a[i] === SENT[0] && a[i + 1] === SENT[1] && a[i + 2] === SENT[2] && a[i + 3] === SENT[3])) k++;
    }
    return k;
  };
  const shots = templates.compileScene(scene, tl);
  const inst = shots[ci];
  const raw = scene.shots[ci];
  const def = scene.comps[raw.comp];
  const len = def.frames;          // 子合成声明的长度（循环周期）
  const span = raw.frames;         // 实例在时间轴上占用的帧数
  const loop = !!raw.loop;
  const from = inst.start;
  const subs = [...def.shots].sort((a, b) => a.at - b.at);
  // 参考：按引擎自己的规则把子镜头画在本地帧上，与「comp 实例 → 子镜头 draw」
  // 那条路同构：区间由 bindLocalShots 定，模板直调（this 绑定带 from/to，
  // 外层补一层 applyDesignScale 对齐嵌套层数）。
  //
  // ⚠️ 不能用「把小镜头当顶层镜头编译」来代替 —— 顶层编译出来的镜头**没有 from/to**
  // （那对字段是 bindShots 给的），模板读 this.from 时拿到 undefined，
  // chips 的 staggerFrames 会算出 NaN、整段不落位（第一版就这么错，参考帧帧不等）。
  const bounds = compMod.bindLocalShots(subs.map((r) => ({start: r.at, draw() {}})), def.frames);
  const specIndex = (L) => { let k = -1; for (let i = 0; i < subs.length; i++) if (subs[i].at <= L) k = i; return k; };
  const drawRef = (g, L) => {
    fill(g);
    const k = specIndex(L);
    if (k < 0) return -1;
    const rawSpec = subs[k];
    const tpl = templates.TEMPLATES[rawSpec.type];
    if (!tpl) return -1;
    const start = rawSpec.at;
    const shotArg = {...rawSpec, start, sid: null, beats: tpl.beats ? tpl.beats(rawSpec, start, null) : [start]};
    // this 绑定照抄 bindLocalShots 的结果（多一个 draw 也没关系，模板只读 from/to/beats）
    const thisArg = {start, from: bounds[k].from, to: bounds[k].to, beats: shotArg.beats,
      ...(rawSpec.transform !== undefined ? {transform: rawSpec.transform} : {})};
    g.save(); design.applyDesignScale(g);
    try { tpl.draw.call(thisArg, g, L, shotArg, '#3FA7FF'); } finally { g.restore(); }
    return k;
  };
  const drawInst = (g, i, n) => { fill(g); i.draw(g, n, n / fps, '#3FA7FF'); };
  const frames = [from, from + Math.floor(len / 2), from + len - 1, from + len + 2, from + span - 1];
  const out = {
    from, len, span, loop,
    isComp: !!(inst.scene && inst.scene.type === 'comp'),
    declaredShots: def.shots.length,
    probes: [], noLoop: [],
  };
  for (const n of frames) {
    const L = compMod.localFrame(n, from, len, loop);
    drawInst(ga, inst, n);
    const p = {n, local: L, painted: painted(ga), spec: specIndex(L) >= 0 ? subs[specIndex(L)].type : null};
    drawRef(gb, L);
    p.refSame = same(ga, gb);
    const Lb = compMod.localFrame(n, from, span, loop);
    p.localSpan = Lb;
    if (Lb !== L && specIndex(Lb) >= 0) { drawRef(gb, Lb); p.spanRefSame = same(ga, gb); }
    out.probes.push(p);
  }
  // 周期：同一个实例在 n 与 n+len 必须逐像素相同
  drawInst(ga, inst, from);
  drawInst(gb, inst, from + len);
  out.periodSame = same(ga, gb);
  // 不循环：超出子合成长度就不画
  const noLoopScene = JSON.parse(JSON.stringify(scene));
  noLoopScene.shots[ci].loop = false;
  const inst2 = templates.compileScene(noLoopScene, tl)[ci];
  for (const n of [from + 1, from + len - 1, from + len + 3]) {
    const L = compMod.localFrame(n, inst2.start, len, false);
    drawInst(ga, inst2, n);
    out.noLoop.push({n, local: L, painted: painted(ga),
      refSame: L <= len ? (drawRef(gb, L), same(ga, gb)) : null});
  }
  return out;
})()`);

// ================= A) 图层变换逐属性隔离（scenecast） =================
console.log('=== A) 图层变换：逐属性隔离 + alpha 的方向 ===');
const P = `${ROOT}/examples/scenecast`;
const proj = await loadProject(P);
const SIZE = proj.raw.size ?? {width: 1280, height: 720};
const sceneA = clone(proj.scene);

const serverA = await serveProject(P, {raw: proj.raw, timeline: proj.timeline, shotsRel: null, scene: sceneA});
const sessA = await openSession(`http://127.0.0.1:${serverA.address().port}/`, SIZE);

const infoA = await shotInfoOf(sessA, sceneA);
const spansA = spansOf(infoA);
// 探针帧**从实现报出的镜头区间算**：找总时长中点所在的镜头，取它区间的中点。
// （不要写死帧号：镜头起点随解说词变，写死就会去看隔壁镜头的画面 —— 踩过。）
const TI = infoA.starts.findIndex((s, i) => Math.floor(infoA.total / 2) >= s && Math.floor(infoA.total / 2) <= spansA[i].to);
const FRAME = spansA[TI].mid;
console.log(`探针帧 ${FRAME}：shots[${TI}]（${infoA.types[TI]}），` +
  `区间 ${spansA[TI].from}..${spansA[TI].to}，总帧数 ${infoA.total} —— 均由实现报出\n`);

/** 在 A 的页面里换一份 transform 重新 boot，取该帧的 PNG 与逐块亮度。 */
const renderA = async (transform) => {
  const s = clone(sceneA);
  if (transform) s.shots[TI].transform = transform;
  await sessA.evaluate(bootSceneExpr(s));
  return {png: await sessA.frame(FRAME), grid: await gridAt(sessA, FRAME)};
};

const baseA = {png: await sessA.frame(FRAME), grid: await gridAt(sessA, FRAME)};
const noop = await renderA({x: 0, y: 0, scale: 1, rotate: 0});

// 判据本体：同一个谓词正反两处都用它，负面对照才有意义。
const sameBytes = (a, b) => a.equals(b);
console.log('—— 快路径：声明了但全默认值的 transform ——');
console.log(`  基线 ${hash(baseA.png)} / 全默认值 ${hash(noop.png)}`);
ok(sameBytes(baseA.png, noop.png),
  '声明了但全默认值的 transform ⇒ 与不写 transform **逐字节相同**（快路径没改输出）');

const x1 = await renderA({x: 1});
ok(sameBytes(baseA.png, x1.png) === false,
  `负面对照：把这条 transform 改成 x:1 —— 同一个谓词必须判红（${hash(baseA.png)} ≠ ${hash(x1.png)}）`);

console.log('\n—— 四个属性各自的改动：都在变化的块上量，且互不相同 ——');
const VARIANTS = [
  ['位移 x=200', {x: 200}],
  ['旋转 15°', {rotate: 15}],
  ['半透明 alpha=0.35', {alpha: 0.35}],
  ['半透明 alpha=0.7', {alpha: 0.7}],
  ['混合模式 multiply', {blend: 'multiply'}],
];
const gotA = {};
for (const [label, t] of VARIANTS) {
  const r = await renderA(t);
  gotA[label] = r;
  const ch = changedBlocks(baseA.grid, r.grid);
  const frac = (100 * ch.length / baseA.grid.length).toFixed(0);
  console.log(`  ${label}：${hash(r.png)}，变化的块 ${ch.length}/${baseA.grid.length}（${frac}%）`);
  ok(ch.length > 0, `${label} ⇒ 目标镜头区间内确有变化的块（不是整帧噪声）`);
}

const sigA = (label) => signedDiff(gotA[label].grid, baseA.grid);
const labelsA = VARIANTS.map(([l]) => l);
let distinctPairs = 0;
for (let i = 0; i < labelsA.length; i++) {
  for (let j = i + 1; j < labelsA.length; j++) {
    const d = maxAbsDiff(sigA(labelsA[i]), sigA(labelsA[j]));
    if (d > 2) distinctPairs++;
    else console.log(`  ✗ ${labelsA[i]} 与 ${labelsA[j]} 的改动几乎一样（逐块最大差 ${d.toFixed(2)}）`);
  }
}
ok(distinctPairs === (labelsA.length * (labelsA.length - 1)) / 2,
  `四类改动**互不相同**：${labelsA.length} 个属性两两比较，逐块亮度差向量都不相等`);

console.log('\n—— alpha 的方向：线性合成，比值由 (1-alpha) 决定 ——');
{
  const IDX = changedBlocks(baseA.grid, gotA['半透明 alpha=0.35'].grid);
  const s035 = regionStats(gotA['半透明 alpha=0.35'].grid, baseA.grid, IDX);
  const s070 = regionStats(gotA['半透明 alpha=0.7'].grid, baseA.grid, IDX);
  const expectRatio = (1 - 0.35) / (1 - 0.7);
  const ratio = Math.abs(s035.delta) / Math.abs(s070.delta);
  console.log(`  在 alpha=0.35 改到的那 ${IDX.length} 块上：Δ(0.35)=${s035.delta.toFixed(3)}，` +
    `Δ(0.7)=${s070.delta.toFixed(3)}（${s035.delta < 0 ? '更暗' : '更亮'}）`);
  ok(Math.sign(s035.delta) === Math.sign(s070.delta) && Math.abs(s035.delta) > Math.abs(s070.delta)
     && Math.abs(s070.delta) > 0.05,
    'alpha 方向：同一区域的亮度差同号，且随 (1-alpha) 单调增大（不是「画面变了」）');
  ok(Math.abs(ratio / expectRatio - 1) < 0.1,
    `alpha 线性：|Δ(0.35)|/|Δ(0.7)| = ${ratio.toFixed(3)}，理论 ${expectRatio.toFixed(3)}（±10%）`);
}

await sessA.close();
serverA.closeProject();

// ================= B) 混合夹具：三能力同项目同时启用 =================
console.log('\n=== B) 混合夹具：三种能力同项目同时启用，逐个关掉 ===');
rmSync(MIX, {recursive: true, force: true});
mkdirSync(join(MIX, 'public', 'assets'), {recursive: true});
mkdirSync(join(MIX, 'script'), {recursive: true});

// 造一段视频（clip 能力的输入）
const broll = join(MIX, 'public', 'assets', 'broll.mp4');
const ff = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi',
  '-i', 'testsrc2=size=320x180:rate=30:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', broll],
  {stdio: 'ignore'});
if (ff.status !== 0 || !existsSync(broll)) {
  console.log('✗ 夹具建不起来：ffmpeg 没能生成 clip 源视频');
  process.exit(1);
}

// theme 给全（缺键会让内建件崩）
const theme = `{
    bg: '#080B14', bgDeep: '#050710', panel: '#101725', panelHi: '#182136',
    line: '#22304A', lineSoft: '#182238', text: '#E9F0FA', dim: '#8B99B4',
    faint: '#5A677F', codeBg: '#0C1220', termBg: '#05080F',
    ok: '#35D07F', bad: '#FF6B6B', hi: '#F5B942',
    accents: ['#3FA7FF', '#35D07F', '#F5B942'],
  }`;
writeFileSync(join(MIX, 'film.config.mjs'), `export default {
  slug: 'composite-mixed', size: {width: 1280, height: 720}, fps: 30,
  theme: ${theme},
  clips: [{name: 'broll', src: 'assets/broll.mp4', fps: 30, width: 320}],
};\n`, 'utf8');

writeFileSync(join(MIX, 'script', 'timeline.json'), JSON.stringify({
  fps: 30, total_frames: 200,
  sentences: [
    {id: 'S01', chapter: 1, from: 20, to: 90, text: '图层与嵌套'},
    {id: 'S02', chapter: 1, from: 100, to: 180, text: '素材与增量'},
  ],
  subs: [
    {from: 20, to: 55, text: '图层与'},
    {from: 55, to: 90, text: '嵌套'},
    {from: 100, to: 140, text: '素材与'},
    {from: 140, to: 180, text: '增量'},
  ],
}, null, 1), 'utf8');

// scene：三种能力全用上（代理/增量是渲染开关，判据在 verify-incremental）
writeFileSync(join(MIX, 'scene.json'), JSON.stringify({
  comps: {
    badge: {
      frames: 40,
      shots: [
        {type: 'stat', at: 1, value: 81, label: 'ms'},
        {type: 'chips', at: 21, items: ['嵌套', '循环']},
      ],
    },
  },
  shots: [
    // ① 图层合成：位移 + 缩放 + 旋转 + 组透明度 + 混合模式
    {type: 'title', at: 1, title: '合成验收',
     transform: {y: -20, scale: 0.95, rotate: 2, alpha: 0.95, blend: 'screen'}},
    // ② 嵌套合成：循环实例（周期 = 子合成声明长度，实例占用帧数不同）
    {type: 'comp', at: 'S01', comp: 'badge', loop: true, frames: 70,
     transform: {x: 40, alpha: 0.9}},
    // ③ 素材片段 + ① 变换
    {type: 'clip', at: 'S02', clip: 'broll', heading: '素材管线',
     fit: 'cover', transform: {rotate: -2, alpha: 0.95}},
  ],
}, null, 1), 'utf8');

console.log('夹具项目:', MIX);
{
  const r = spawnSync('node', [KIT, 'check', '--project', MIX, '--static-only', '--json'],
    {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024});
  let j = null; try { j = JSON.parse(r.stdout); } catch { /* 留到下面报 */ }
  ok(j?.ok === true, `三能力混用的规格合法（静态自检 ${j?.errors?.length ?? '?'} 个错误）` +
    (j?.ok ? '' : '：' + JSON.stringify(j?.errors ?? String(r.stderr).slice(-200))));
}

const mixProj = await loadProject(MIX);
const mixScene = clone(mixProj.scene);
// 打开一次混合项目会话（openProjectSession 会顺手把 clip 抽帧准备好 ——
// 那是渲染 clip 镜头的**前置条件**，不是本工具要判的东西）。
const mixOpen = await openProjectSession(MIX, {...mixProj, scene: mixScene});
const sessM = mixOpen.sess;

const infoM = await shotInfoOf(sessM, mixScene);
const spansM = spansOf(infoM);
const probeM = spansM.map((s) => s.mid);
const iTitle = infoM.types.indexOf('title');
const iComp = infoM.types.indexOf('comp');
const iClip = infoM.types.indexOf('clip');
console.log('  镜头区间（由实现报出）：' + infoM.types.map((t, i) =>
  `${i}:${t}(${spansM[i].from}..${spansM[i].to})`).join('  '));
console.log(`  每种能力在自己的区间中点取一帧：${probeM.join(', ')}\n`);

const gridsM = [];
for (const n of probeM) gridsM.push(await gridAt(sessM, n));
const comp = await compProbe(sessM, mixScene, {compIndex: iComp, fps: mixProj.raw.fps ?? 30});

const MUTATIONS = [
  {tag: '关掉 title 镜头的图层变换', at: iTitle, what: '图层变换',
   mut: (s) => { delete s.shots[iTitle].transform; }},
  {tag: '关掉 comp 镜头的图层变换', at: iComp, what: '图层变换 × 嵌套合成',
   mut: (s) => { delete s.shots[iComp].transform; }},
  {tag: '把 comp 镜头换成 title', at: iComp, what: '嵌套合成',
   mut: (s) => { s.shots[iComp] = {type: 'title', at: s.shots[iComp].at, title: '替代'}; }},
  {tag: '关掉 clip 镜头的图层变换', at: iClip, what: '图层变换 × 素材片段',
   mut: (s) => { delete s.shots[iClip].transform; }},
  {tag: '把 clip 镜头换成 title', at: iClip, what: '素材片段',
   mut: (s) => { s.shots[iClip] = {type: 'title', at: s.shots[iClip].at, title: '替代'}; }},
];

for (const m of MUTATIONS) {
  const s = clone(mixScene);
  m.mut(s);
  await sessM.evaluate(bootSceneExpr(s));
  const g = [];
  for (const n of probeM) g.push(await gridAt(sessM, n));
  const nCh = changedBlocks(g[m.at], gridsM[m.at]).length;
  ok(nCh > 0, `${m.what}：${m.tag} ⇒ shots[${m.at}]（${infoM.types[m.at]}，帧 ${probeM[m.at]}）` +
    `区间内变了 ${nCh} 块`);
  for (let i = 0; i < probeM.length; i++) {
    if (i === m.at) continue;
    const nSame = changedBlocks(g[i], gridsM[i]).length;
    ok(nSame === 0, `  ↳ 隔离：shots[${i}]（${infoM.types[i]}，帧 ${probeM[i]}）` +
      `区间逐块不变（变了 ${nSame} 块）`);
  }
}

// ================= C) 嵌套合成实例：编译 + 真的画出来 =================
console.log('\n=== C) 嵌套合成：声明式 comps 编译成实例，并在真浏览器里画出来 ===');
{
  const declaredLen = mixScene.comps[mixScene.shots[iComp].comp].frames;
  const declaredSpan = mixScene.shots[iComp].frames;
  ok(comp.isComp === true && comp.from === infoM.starts[iComp],
    `comps + type:comp 在真浏览器里编译成了实例（起点 ${comp.from}，子镜头 ${comp.declaredShots} 个，` +
    `周期 ${comp.len}，实例占用 ${comp.span} 帧）`);
  ok(comp.len === declaredLen && comp.span === declaredSpan && comp.len !== comp.span,
    `实例的长度对得上夹具声明（周期 ${comp.len} vs 占用 ${comp.span}）—— 两者不同，判据才有区分力`);
  // 模板可以前几帧还在入场（chips 要等本地第 33 帧才落位），所以不要求**每一帧**
  // 都有像素；但一个都没画出来就说明实例根本没落地，必须红。
  const paintedProbes = comp.probes.filter((p) => p.painted > 0);
  ok(paintedProbes.length >= 2,
    `实例**真的画出了内容**（${paintedProbes.length}/${comp.probes.length} 个探针有非哨兵像素：` +
    comp.probes.map((p) => `${p.n}→${p.painted}`).join(', ') + '）');
  ok(comp.probes.every((p) => p.refSame),
    `实例看到的本地帧与 comp.js 的 localFrame **逐像素一致**（` +
    comp.probes.map((p) => `${p.n}→本地 ${p.local}(${p.spec})`).join(', ') + '）');
  const spanProbes = comp.probes.filter((p) => p.spanRefSame !== undefined);
  ok(spanProbes.length > 0 && spanProbes.every((p) => p.spanRefSame === false),
    `负面对照：若把**实例占用帧数**当循环周期，同一批探针的参考必须对不上` +
    `（测了 ${spanProbes.length} 个：` + spanProbes.map((p) => `${p.n}→本地 ${p.localSpan}`).join(', ') + '）');
  ok(comp.periodSame === true, `循环周期 = 子合成声明的长度：帧 n 与帧 n+${comp.len} 逐像素相同`);
  const inside = comp.noLoop.filter((p) => p.local <= comp.len);
  const beyond = comp.noLoop.filter((p) => p.local > comp.len);
  ok(inside.length > 0 && inside.every((p) => p.refSame === true),
    `不循环时本地帧同样与 localFrame 一致（` + inside.map((p) => `${p.n}→${p.local}`).join(', ') + '）');
  ok(beyond.length > 0 && beyond.every((p) => p.painted === 0),
    `不循环且超出子合成长度 ⇒ 一帧都不画（` + beyond.map((p) => `${p.n}→本地 ${p.local}`).join(', ') + '）');
}

await sessM.close();
if (typeof mixOpen.server.closeProject === 'function') mixOpen.server.closeProject();
else mixOpen.server.close();

// ================= D) 父子绑定（follow）与空物体（empty） =================
// 判据要有**区分力**：这里量的是方向 / 单调 / 逐字节等价，不是「画面变了」。
console.log('\n=== D) 父子绑定（follow）与空物体（empty） ===');
{
  const P_LB = `${ROOT}/examples/scenecast`;
  const projLB = await loadProject(P_LB);
  const SIZE_LB = projLB.raw.size ?? {width: 1280, height: 720};
  const layerScene = (layers) => ({shots: [{type: 'layers', at: 1, layers}]});
  // 子层内容只用 ASCII：不依赖宿主机装没装中文字体（那是另一条守卫的事）。
  const KID = {content: {type: 'title', title: 'BIND', sub: 'follow-empty'}, z: 1};
  // 父用**空物体**：它自己不画像素 ⇒ 画面里唯一能动的东西就是子层。
  const EMPTY_AT = (t) => ({empty: true, z: 0, ...(t ? {transform: t} : {})});
  const sceneLB = layerScene([EMPTY_AT({x: 0}), {...KID, follow: 0}]);
  const serverLB = await serveProject(P_LB, {raw: projLB.raw, timeline: projLB.timeline,
    shotsRel: null, scene: sceneLB});
  const sessLB = await openSession(`http://127.0.0.1:${serverLB.address().port}/`, SIZE_LB);
  try {
    // 帧号**由实现报出**（不写死帧号：镜头起点与总帧数随夹具变）。
    const infoLB = await shotInfoOf(sessLB, sceneLB);
    const FRAME_LB = Math.floor((infoLB.starts[0] + infoLB.total) / 2);
    console.log(`  探针帧 ${FRAME_LB}：镜头起点 ${infoLB.starts[0]}、总帧数 ${infoLB.total}（由实现报出）`);
    const renderLB = async (sc) => {
      await sessLB.evaluate(bootSceneExpr(sc));
      return {png: await sessLB.frame(FRAME_LB), grid: await gridAt(sessLB, FRAME_LB)};
    };

    // —— D1 只动父、不动子 ⇒ 子也动（方向 + 单调）——
    const kidBefore = JSON.stringify(KID);
    const base = await renderLB(sceneLB);
    const moves = [];
    for (const dx of [60, 120]) {
      const m = moveOf(base.grid, (await renderLB(layerScene([EMPTY_AT({x: dx}), {...KID, follow: 0}]))).grid);
      moves.push({dx, ...m});
      console.log(`  父 x=${dx}：变化块 ${m.blocks}/${base.grid.length}，` +
        `重心位移 dx=${m.dx.toFixed(3)} dy=${m.dy.toFixed(3)}（块坐标）`);
    }
    ok(moves.every((m) => m.blocks > 0),
      '只动父的变换 ⇒ 画面里确有变化的块（父是空物体，动的只能是子层）');
    ok(moves.every(followedRight),
      `跟随层的重心随父**同向**右移（${moves.map((m) => m.dx.toFixed(2)).join(' < ')} 块）`);
    ok(moves[1].dx > moves[0].dx && moves[0].dx > 0,
      `位移**单调**：父右移 60 → ${moves[0].dx.toFixed(2)} 块，右移 120 → ${moves[1].dx.toFixed(2)} 块`);
    ok(JSON.stringify(KID) === kidBefore,
      '两次之间**子层声明一个字都没改**（只改了父的变换）—— 所以动的是「绑定」而不是各自独立');

    // —— D2 有效变换 = 父的变换 ∘ 自己的变换（组合，不是替换、不是相加）——
    const cParent = await renderLB(layerScene([EMPTY_AT({x: 100}), {...KID, follow: 0}]));
    const cChild = await renderLB(layerScene([EMPTY_AT({x: 0}), {...KID, follow: 0, transform: {x: 100}}]));
    const cNone = await renderLB(layerScene([EMPTY_AT({x: 0}), {...KID, follow: 0}]));
    console.log(`  父 x=100 + 子 x=0 ${hash(cParent.png)} / 父 x=0 + 子 x=100 ${hash(cChild.png)} /` +
      ` 都不动 ${hash(cNone.png)}`);
    ok(cParent.png.equals(cChild.png),
      '纯平移的两种写法**逐字节相同**（父的位移进子的坐标系 = 子的位移进父的坐标系）');
    ok(!cParent.png.equals(cNone.png),
      '负面对照：两者都**不等于「都不动」** ⇒ 父与自己的变换**都**真的参与了合成（丢任一侧都会塌回基准）');
    const mFlat = moveOf(cNone.grid,
      (await renderLB(layerScene([EMPTY_AT({}), {...KID, follow: 0, transform: {x: 100}}]))).grid);
    const mRot = moveOf(cNone.grid,
      (await renderLB(layerScene([EMPTY_AT({rotate: 90}), {...KID, follow: 0, transform: {x: 100}}]))).grid);
    console.log(`  父 rotate=0° + 子 x=100：dx=${mFlat.dx.toFixed(3)} dy=${mFlat.dy.toFixed(3)}；` +
      `父 rotate=90° + 子 x=100：dx=${mRot.dx.toFixed(3)} dy=${mRot.dy.toFixed(3)}`);
    ok(mFlat.dx > 0 && Math.abs(mFlat.dy) < Math.abs(mFlat.dx), '父不旋转时，子的 +x 偏置把重心推**右**');
    ok(mRot.blocks > 0 && mRot.dy > 0 && Math.abs(mRot.dx) < Math.abs(mRot.dy),
      '父**只旋转 90°（没有任何平移）**时子的 +x 偏置落到**下方** —— 相加式/替换式/忽略父都得不到这个结果');

    // —— D3 父是全默认变换 ⇒ 写不写 follow 逐字节相同（快路径没被破坏）——
    const DEF = {x: 0, y: 0, scale: 1, rotate: 0};
    const withFollow = await renderLB(layerScene([EMPTY_AT(DEF), {...KID, follow: 0, transform: {x: 30}}]));
    const noFollow = await renderLB(layerScene([EMPTY_AT(DEF), {...KID, transform: {x: 30}}]));
    ok(withFollow.png.equals(noFollow.png),
      `父变换全默认 ⇒ 绑定等价于恒等变换（${hash(withFollow.png)} = ${hash(noFollow.png)}）`);

    // —— D4 空物体自己不产生任何像素 ——
    const e1 = await renderLB(layerScene([EMPTY_AT({})]));
    const e2 = await renderLB(layerScene([EMPTY_AT({x: 400, y: -120, rotate: 33, scale: 1.5,
      alpha: 0.4, blend: 'multiply'})]));
    const e3 = await renderLB(layerScene([{content: {type: 'title', title: 'E'}, z: 0}]));
    ok(e1.png.equals(e2.png),
      `把空物体的变换设成任意值（位移/旋转/缩放/透明度/混合）⇒ 画面**逐字节不变**（${hash(e1.png)}）`);
    ok(!e1.png.equals(e3.png),
      `负面对照：同一位置换成真有内容的层 ⇒ 画面必须不同（${hash(e1.png)} ≠ ${hash(e3.png)}），` +
      '证明上面那条不是「整帧本来就空」的假绿');

    // —— D5 空物体自己的 animate（它没有内容 ⇒ 没有自己的节拍表，借本容器的）——
    // 空物体最常见的用法就是「按节拍转/呼吸」，所以带 `beat` 的关键帧必须能编译：
    // 借不到拍号时 compileAnimate 会当场抛「这个节点只有 0 拍」。
    const kid200 = {...KID, follow: 0, transform: {x: 200}};
    const still = await renderLB(layerScene([EMPTY_AT({}), kid200]));
    const beatKeyed = await renderLB(layerScene([
      {empty: true, z: 0, animate: {rotate: [{beat: 1, v: 0}]}}, kid200]));
    ok(beatKeyed.png.equals(still.png),
      `空物体的 \`beat\` 键能编译：单拍 v=0 与不写 animate 逐字节相同（${hash(still.png)}）`);
    const driven = await renderLB(layerScene([
      {empty: true, z: 0, animate: {rotate: [{frame: 1, v: 0}, {frame: 2, v: 90}]}}, kid200]));
    const mDrive = moveOf(still.grid, driven.grid);
    console.log(`  空物体按帧旋转 90° ⇒ 子层（自身 x=200）：变化块 ${mDrive.blocks}，` +
      `dx=${mDrive.dx.toFixed(3)} dy=${mDrive.dy.toFixed(3)}`);
    ok(mDrive.blocks > 0 && mDrive.dy > 0 && Math.abs(mDrive.dx) < Math.abs(mDrive.dy),
      '空物体自己的 animate 真的驱动了跟随者：子的 +x 偏置被转到**下方**');

    // —— D6 负面对照：绑定失效（去掉 follow）⇒ 同一个谓词必须判红 ——
    const broke = await renderLB(layerScene([EMPTY_AT({x: 120}), {...KID}]));
    const mBroke = moveOf(base.grid, broke.grid);
    console.log(`  父 x=120、子**不跟随**：变化块 ${mBroke.blocks}，重心 dx=${mBroke.dx.toFixed(3)}`);
    ok(broke.png.equals(base.png),
      '绑定失效时画面与「父不动」**逐字节相同**（父是空物体、子不跟随 ⇒ 什么都不该动）');
    ok(followedRight(moves[1]) === true && followedRight(mBroke) === false,
      '同一个谓词：跟随 ⇒ true，绑定失效 ⇒ false（判据有牙，不是恒真）');

    // —— D8 contract：合法写法要过、非法要报、码已登记（纯函数，不启浏览器）——
    const {validateScene, SCENE_ERROR_CODES} = await imp('src/contract/scene.js');
    const declared = new Set(SCENE_ERROR_CODES);
    const errsOf = (layers) => validateScene({shots: [{type: 'layers', at: 1, layers}]},
      {timeline: projLB.timeline}).errors;
    const kid2 = {content: {type: 'title', title: 'X'}, z: 2};
    const CASES = [
      ['合法：follow 1 → 0', [EMPTY_AT({}), {...KID, follow: 0}], false],
      ['合法：空物体不给 content', [EMPTY_AT({}), kid2], false],
      ['follow 不是整数', [EMPTY_AT({}), {...KID, follow: 0.5}], true],
      ['follow 越界', [EMPTY_AT({}), {...KID, follow: 2}], true],
      ['follow 自引用', [EMPTY_AT({}), {...KID, follow: 1}], true],
      ['follow 成环 1→2→1', [EMPTY_AT({}), {...KID, follow: 2}, {...kid2, follow: 1}], true],
      ['empty 不是布尔 / 又给了 content',
        [{empty: 'yes', content: {type: 'title', title: 'X'}, z: 0}, kid2], true],
    ];
    const seen = new Set();
    for (const [label, layers, wantErr] of CASES) {
      const errs = errsOf(layers);
      for (const e of errs) {
        seen.add(e.code);
        // 错误是给模型读的 prompt：hint 不能是空的（否则模型只知道"错了"、不知道怎么改）。
        if (!e.hint) ok(false, `  ↳ ${e.code}@${e.path} 的 hint 是空的`);
      }
      ok((errs.length > 0) === wantErr, `${label} ⇒ ${wantErr ? '要报' : '要过'}：` +
        (errs.map((e) => `${e.code}@${e.path}`).join(', ') || '（无错误）'));
    }
    const unregistered = [...seen].filter((c) => !declared.has(c));
    ok(unregistered.length === 0,
      `报出来的码都在 SCENE_ERROR_CODES 里登记过（用到未登记：${unregistered.join(', ') || '无'}）`);
  } finally {
    await sessLB.close();
    serverLB.closeProject();
  }
}

// ================= 收尾 =================
rmSync(MIX, {recursive: true, force: true});
console.log(bad === 0
  ? '\n✓ 图层合成 + 嵌套合成端到端全部符合预期'
  : `\n✗ ${bad} 项失败`);
process.exit(bad ? 1 : 0);
