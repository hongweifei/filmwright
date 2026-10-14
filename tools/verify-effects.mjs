// 验收：效果链（最小闭环 blur）真的生效、方向正确、代价可量。
//
//   node tools/verify-effects.mjs [<仓库根>] [--gpu]
//
// ## 判据为什么这样设计
//
// "画面变了"不足以证明模糊生效 —— 任何 bug 都能让画面变。所以这里量
// **边缘能量**（相邻像素差的和）：模糊必然让它下降，半径越大降得越多。
// 这是个**方向明确、可量化**的判据，能真正抓住"效果没接上"或"接反了"。
//
// 另外三条：
//   · radius=0 必须**逐位等于**不写 effects（短路保证）
//   · 加了 radius>0 的帧必须与不写 effects 不同（否则效果没上）
//   · 性能：同一次运行内配对测有/无效果的 ms/帧（跨运行比会受负载漂移污染）
import {spawnSync} from 'node:child_process';
import {cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';

const ROOT = (process.argv[2] || process.cwd()).replace(/\\/g, '/');
const USE_GPU = process.argv.includes('--gpu');
const KIT = join(ROOT, 'bin', 'filmwright.mjs');
const SRC = join(ROOT, 'examples', 'scenecast');
const P = join(ROOT, '.work', 'fx-e2e');

let bad = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) bad++; };
const line = (c = '─') => console.log(c.repeat(76));

rmSync(P, {recursive: true, force: true});
cpSync(SRC, P, {recursive: true});
for (const d of ['audio', 'renders', 'public/assets/scenecast']) {
  rmSync(join(P, d), {recursive: true, force: true});
}

/** 给 scene.json 的第一个非 title 镜头挂上 effects（null = 不写）。 */
function setEffects(effects) {
  const sc = JSON.parse(readFileSync(join(SRC, 'scene.json'), 'utf8'));
  const t = sc.shots.find((s) => s.type !== 'title') || sc.shots[0];
  // 固定到具体帧：用第 100 帧（第一个镜头区间内）
  const clone = JSON.parse(JSON.stringify(sc));
  const c = clone.shots.find((s) => s.type !== 'title') || clone.shots[0];
  if (effects) c.effects = effects; else delete c.effects;
  // 只留这一个镜头，避免别的镜头干扰对比（at:1 覆盖全片）
  writeFileSync(join(P, 'scene.json'),
    JSON.stringify({shots: [{...c, at: 1}]}, null, 2) + '\n', 'utf8');
  return t;
}

const run = (args) => spawnSync('node', [KIT, ...args], {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});

/**
 * 渲一帧静帧，返回 `{hash, gray, rgb, w, h}`。
 *
 * 为什么要 RGB 而不只是灰度：`color` 的"灰度化"判据是**通道差**（max−min 应趋于 0），
 * 只看灰度是量不出来的。灰度由 RGB 自己算，避免解两遍。
 */
function still(effects, frame, tag) {
  setEffects(effects);
  const dir = join(P, '.work', 's-' + tag);
  rmSync(dir, {recursive: true, force: true});
  const r = run(['stills', '--project', P, '--frames', String(frame), '--dir', dir]);
  if (r.status !== 0) { console.log(`渲染失败(${tag})：` + String(r.stderr || r.stdout).slice(-400)); process.exit(1); }
  const f = readdirSync(dir).find((x) => x.endsWith('.png'));
  const p = join(dir, f);
  const bytes = readFileSync(p);
  const g = spawnSync('ffmpeg', ['-v', 'error', '-i', p, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    {maxBuffer: 96 * 1024 * 1024});
  if (g.status !== 0) { console.log('ffmpeg 解码失败'); process.exit(1); }
  const rgb = g.stdout;
  const gray = Buffer.alloc(rgb.length / 3);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j++) {
    gray[j] = Math.round(0.2126 * rgb[i] + 0.7152 * rgb[i + 1] + 0.0722 * rgb[i + 2]);
  }
  return {hash: createHash('sha256').update(bytes).digest('hex').slice(0, 12), gray, rgb};
}

/** 边缘能量：相邻像素灰度差的和（模糊会让它下降）。 */
function edgeEnergy(gray) {
  let s = 0;
  for (let i = 1; i < gray.length; i++) s += Math.abs(gray[i] - gray[i - 1]);
  return s / gray.length;
}

/** 平均亮度（0–255）。 */
function meanGray(gray) {
  let s = 0;
  for (let i = 0; i < gray.length; i++) s += gray[i];
  return s / gray.length;
}

/** 平均通道差（max(r,g,b) − min(r,g,b)）。灰度化时应趋于 0。 */
function channelSpread(rgb) {
  let s = 0;
  for (let i = 0; i < rgb.length; i += 3) {
    const r = rgb[i], g = rgb[i + 1], b = rgb[i + 2];
    s += Math.max(r, g, b) - Math.min(r, g, b);
  }
  return s / (rgb.length / 3);
}

/** 中心区域与四角区域的平均亮度（用于暗角：角应比中心暗得更多）。 */
function centerVsCorner(gray, w, h) {
  const box = 60;
  const at = (x, y) => gray[y * w + x];
  const avgBox = (x0, y0) => {
    let s = 0, n = 0;
    for (let y = y0; y < y0 + box; y++) for (let x = x0; x < x0 + box; x++) { s += at(x, y); n++; }
    return s / n;
  };
  const center = avgBox(Math.floor(w / 2 - box / 2), Math.floor(h / 2 - box / 2));
  const corners = [avgBox(0, 0), avgBox(w - box, 0), avgBox(0, h - box), avgBox(w - box, h - box)];
  return {center, corner: corners.reduce((a, b) => a + b, 0) / corners.length};
}

const W = 1280, H = 720;

/**
 * 自动标定**镜头内容**所在的区域。
 *
 * 为什么需要它：**效果只作用于镜头层，而背板（底色/网格/暗角）是引擎画的、不受影响**。
 * 实测这一帧的镜头内容只覆盖中部约 33% 的像素，四角与边缘全是背板 ——
 * 拿整帧统计去判"饱和度为 0 应该变灰""暗角应该压暗四角"，会被未受影响的背板稀释，
 * 甚至给出 0% 变化的假象（第一版就是这么错判的）。
 *
 * 标定方式：拿"blur 改变了哪些像素"当镜头内容的掩码（模糊一定会改动镜头内容）。
 * 这样不写死任何版面坐标 —— 换项目、换模板都不用改判据。
 */
function contentMask(baseRgb, refRgb, thresh = 6) {
  const m = new Uint8Array(baseRgb.length / 3);
  for (let i = 0, j = 0; i < baseRgb.length; i += 3, j++) {
    const d = Math.abs(baseRgb[i] - refRgb[i])
      + Math.abs(baseRgb[i + 1] - refRgb[i + 1])
      + Math.abs(baseRgb[i + 2] - refRgb[i + 2]);
    m[j] = d > thresh ? 1 : 0;
  }
  return m;
}

/** 掩码内的平均亮度。 */
function maskedMeanGray(gray, mask) {
  let s = 0, n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) { s += gray[i]; n++; }
  return n ? s / n : 0;
}

/** 掩码内的平均通道差（max−min）。灰度化时应趋于 0。 */
function maskedSpread(rgb, mask) {
  let s = 0, n = 0;
  for (let i = 0, j = 0; j < mask.length; i += 3, j++) {
    if (!mask[j]) continue;
    const r = rgb[i], g = rgb[i + 1], b = rgb[i + 2];
    s += Math.max(r, g, b) - Math.min(r, g, b);
    n++;
  }
  return n ? s / n : 0;
}

/** 掩码内的平均逐像素绝对差（用于量"两张图差多少级"）。 */
function maskedMeanAbsDiff(a, b, mask) {
  let s = 0, n = 0;
  for (let i = 0, j = 0; j < mask.length; i += 3, j++) {
    if (!mask[j]) continue;
    s += (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3;
    n++;
  }
  return n ? s / n : 0;
}

/** 掩码内的**最大**逐通道绝对差（用于"往返是否局部崩坏"这类判据）。 */
function maskedMaxAbsDiff(a, b, mask) {
  let mx = 0;
  for (let i = 0, j = 0; j < mask.length; i += 3, j++) {
    if (!mask[j]) continue;
    const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
    if (d > mx) mx = d;
  }
  return mx;
}

/**
 * 暗角的径向剖面：掩码内、按"离中心的归一化距离"分两档，各算平均压暗系数
 * （1 = 没变暗，0 = 完全压黑）。近处应比远处压得少。
 */
function vignetteProfile(baseGray, effGray, mask, w, h) {
  let nearS = 0, nearN = 0, farS = 0, farN = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const j = y * w + x;
      if (!mask[j] || baseGray[j] < 8) continue;      // 太暗的像素算比值没意义
      const d = Math.hypot((x / w - 0.5) * 2, (y / h - 0.5) * 2);
      const f = effGray[j] / baseGray[j];
      if (d < 0.35) { nearS += f; nearN++; } else if (d > 0.6) { farS += f; farN++; }
    }
  }
  return {near: nearN ? nearS / nearN : 1, far: farN ? farS / farN : 1, nearN, farN};
}

console.log(`效果链验收：blur 最小闭环（${USE_GPU ? '--gpu 放开 GPU' : '默认档（软件 WebGL）'}）\n`);
line('═');
console.log('一、radius=0 必须**逐位等于**不写 effects（短路保证）');
line();
const none = still(null, 100, 'none');
const r0 = still([{type: 'blur', radius: 0}], 100, 'r0');
console.log(`  不写 effects : ${none.hash}`);
console.log(`  radius=0     : ${r0.hash}`);
ok(none.hash === r0.hash, 'radius=0 与不写 effects **逐位相同**（效果被短路，没产生额外趟）');

line('═');
console.log('二、模糊必须真的生效，且**半径越大越模糊**（量边缘能量）');
line();
const radii = [2, 8, 20, 34];
const samples = [];
for (const rad of radii) {
  const s = still([{type: 'blur', radius: rad}], 100, 'r' + rad);
  samples.push({rad, ...s, e: edgeEnergy(s.gray)});
}
const eNone = edgeEnergy(none.gray);
console.log(`  不写 effects : 边缘能量 ${eNone.toFixed(3)}  hash ${none.hash}`);
for (const s of samples) {
  console.log(`  radius=${String(s.rad).padStart(2)}     : 边缘能量 ${s.e.toFixed(3)}  hash ${s.hash}` +
    `   ${s.hash === none.hash ? '（与不写 effects 相同 ← 可疑）' : ''}`);
}
ok(samples.every((s) => s.hash !== none.hash), 'radius>0 的画面都与不写 effects **不同**（效果确实上了）');
ok(samples.every((s) => s.e < eNone), '半径>0 的边缘能量都**低于**不写 effects（确实变模糊了）');
let mono = true;
for (let i = 1; i < samples.length; i++) {
  if (!(samples[i].e < samples[i - 1].e)) mono = false;
}
ok(mono, `边缘能量随半径**单调下降**（${samples.map((s) => s.e.toFixed(1)).join(' → ')}）—— 方向正确`);

line('═');
console.log('三、GPU 往返保真（这一条能抓住一整类 bug，放在最前面）');
line();
// 用 `vignette amount=1e-6`：**不是**直通值（会真的进 GPU），但数学上几乎恒等。
// 于是"与不写效果的差异"就只剩 **GPU 往返**本身的代价（上传 → 离屏 → 取回）。
//
// 为什么必须有这一条：往返出问题时，**效果的判据全都照样通过** ——
// 实测踩过一次整帧**上下翻转**（`texImage2D(canvas)` 把画布首行放在 v=0，
// 而 GL 的裁剪空间 y 朝上），翻转后的模糊还是模糊、边缘能量照样单调、
// 端点一致性也照样成立。**只有看图才发现**。
// 往返保真不依赖任何版面知识，能同时抓住翻转、预乘/反预乘错配、以及别的破坏。
const base100 = still(null, 100, 'base100');
const maskRef = still([{type: 'blur', radius: 30}], 100, 'maskref');
const mask = contentMask(base100.rgb, maskRef.rgb);
const maskPct = (mask.reduce((a, b) => a + b, 0) / mask.length * 100).toFixed(1);
console.log(`  镜头内容区域（自动标定）：占整帧 ${maskPct}% —— 其余是引擎画的背板，效果不作用于它`);
{
  const rt = still([{type: 'vignette', amount: 0.000001}], 100, 'rt');
  const md = maskedMeanAbsDiff(base100.rgb, rt.rgb, mask);
  const mx = maskedMaxAbsDiff(base100.rgb, rt.rgb, mask);
  console.log(`  恒等往返与不写效果的差异：平均 ${md.toFixed(3)} 级，最大 ${mx} 级`);
  ok(md <= 0.5, `往返平均差 ≤0.5 级（实际 ${md.toFixed(3)}）—— 没有翻转/预乘错配`);
  ok(mx <= 2, `往返最大差 ≤2 级（实际 ${mx}）—— 没有局部崩坏`);
}

line('═');
console.log('四、关键帧参数：模糊**渐入**（radius 从 0 长到 24）');
line();
const kfFx = [{type: 'blur', radius: [{frame: 1, v: 0}, {frame: 60, v: 24}]}];
// 基准要在**同一帧**上取：上面那个 none 是第 100 帧的画面，拿来跟第 1 帧比是错的
// （不同帧的内容本来就不一样，画面不同不能说明短路有没有生效）。
const none1 = still(null, 1, 'none1');
const kf1 = still(kfFx, 1, 'kf1');
console.log(`  第  1 帧 不写 effects hash ${none1.hash}`);
console.log(`  第  1 帧 轨道起点   hash ${kf1.hash}   （radius=0）`);
ok(kf1.hash === none1.hash,
  '起点（radius=0）与不写 effects **逐位相同** —— 逐帧短路生效，起点不吃一趟 GPU');

const eNone1 = edgeEnergy(none1.gray);
const kfSamples = [];
for (const fr of [15, 30, 45, 60]) {
  // **同帧配对**：模糊有没有生效，只能拿"这一帧有效果"与"这一帧没效果"比。
  // 跨帧比是错的 —— 镜头的要点在错峰入场，不同帧的内容本来就不一样，
  // 画面差异里混着内容差异（第一版就是这么错判的）。
  const withFx = still(kfFx, fr, 'kf' + fr);
  const base = still(null, fr, 'base' + fr);
  const e = edgeEnergy(withFx.gray), be = edgeEnergy(base.gray);
  kfSamples.push({fr, e, baseE: be, hash: withFx.hash});
  console.log(`  第 ${String(fr).padStart(2)} 帧 有模糊 ${e.toFixed(3)}  无效果 ${be.toFixed(3)}   hash ${withFx.hash}`);
}
ok(kfSamples.every((s) => s.e < s.baseE), '每一帧都比**同帧**的不写 effects 更模糊');
let monoT = true;
for (let i = 1; i < kfSamples.length; i++) {
  if (!(kfSamples[i].e < kfSamples[i - 1].e)) monoT = false;
}
ok(monoT, `边缘能量随时间**单调下降**（${kfSamples.map((s) => s.e.toFixed(2)).join(' → ')}）—— 确实在渐入`);

// 最锋利的一条：关键帧的**终点**应当与等值静态参数逐位相同 ——
// 它同时证明了「插值端点精确」与「轨道求值没错位」两件事。
const static24 = still([{type: 'blur', radius: 24}], 60, 'st24');
ok(static24.hash === kfSamples[kfSamples.length - 1].hash,
  '第 60 帧（轨道终点 v=24）与静态 radius=24 **逐位相同**（端点精确、没错位）');

line('═');
console.log('五、三个新效果（判据只测**镜头内容所在的区域**）');
line();
// 判据只测**镜头内容区域**（第三节已经标定好 base100 / mask），
// 否则会被"不受效果影响的背板"稀释 —— 效果只作用于镜头层。
console.log(`  （镜头内容占整帧 ${maskPct}%，四角与边缘是引擎画的背板）\n`);

// ── glow ─────────────────────────────────────────────────────────────────
{
  const g1 = still([{type: 'glow', intensity: 0.4}], 100, 'g1');
  const g2 = still([{type: 'glow', intensity: 1.2}], 100, 'g2');
  const m0 = maskedMeanGray(base100.gray, mask);
  const m1 = maskedMeanGray(g1.gray, mask);
  const m2 = maskedMeanGray(g2.gray, mask);
  console.log(`  glow 平均亮度（镜头内）：无 ${m0.toFixed(2)} → 0.4 ${m1.toFixed(2)} → 1.2 ${m2.toFixed(2)}`);
  ok(m1 > m0 && m2 > m1, 'glow 让画面**变亮**，且强度越大越亮（单调）');

  // 负面对照：threshold=1 没有任何像素达标 ⇒ 输出应当只剩"GPU 往返"的量化差。
  // ⚠️ 这里**不能**要求逐位相同：有效果的路径要经过预乘上传 → 8bit 离屏 → 取回，
  // 半透明像素会掉 1 级左右。逐位相同只在"直通条件命中的帧"（根本不进 GPU）才保证。
  const gT = still([{type: 'glow', intensity: 1, threshold: 1}], 100, 'g-t1');
  const d = maskedMeanAbsDiff(base100.rgb, gT.rgb, mask);
  console.log(`  threshold=1（无像素达标）与不写效果的差异：平均 ${d.toFixed(3)} 级`);
  ok(d <= 1.0, `threshold=1 时输出与不写效果只差量化误差（${d.toFixed(3)} ≤ 1 级）—— 边界值不出 NaN/黑屏`);

  const g0 = still([{type: 'glow', intensity: 0}], 100, 'g0');
  ok(g0.hash === base100.hash, 'intensity=0 与不写 effects **逐位相同**（直通条件命中，根本没进 GPU）');
}

// ── color ────────────────────────────────────────────────────────────────
{
  const cs = still([{type: 'color', saturation: 0}], 100, 'c-sat0');
  // **自参照判据**（不依赖 alpha 与版面）：灰度之后再转色相，结果必须**完全相同** ——
  // 色相旋转矩阵每一行系数和为 1，所以灰色输入进灰、出还是灰。
  // 为什么不用"通道差应趋于 0"：镜头层在文字抗锯齿边缘是**半透明**的，
  // 灰层叠在彩色背板上本来就还带蓝，那个差值降不到 0（第一版就是这么错判的）。
  const cs2 = still([{type: 'color', saturation: 0, hue: 90}], 100, 'c-sat0-hue');
  const dHue = maskedMeanAbsDiff(cs.rgb, cs2.rgb, contentMask(cs.rgb, cs2.rgb));
  const same = cs.hash === cs2.hash;
  console.log(`  saturation=0 之后再转 90° 色相：与不转的差异 ${same ? '0' : dHue.toFixed(3)} 级`);
  ok(same, '灰化后再转色相**逐位不变** ⇒ 镜头内容确实被完全去色了');

  // 反面：不去色时转色相必须**有变化**（否则上面那条判据可能恒真）
  const b0 = still([{type: 'color', brightness: 1.001}], 100, 'c-b0');
  const b90 = still([{type: 'color', brightness: 1.001, hue: 90}], 100, 'c-b0-hue');
  ok(b0.hash !== b90.hash, '不去色时转色相**会变** —— 证明上面那条不是恒真');

  const cb = still([{type: 'color', brightness: 1.5}], 100, 'c-b15');
  const mb = maskedMeanGray(cb.gray, mask);
  console.log(`  平均亮度：无 ${maskedMeanGray(base100.gray, mask).toFixed(2)} → brightness=1.5 ${mb.toFixed(2)}`);
  ok(mb > maskedMeanGray(base100.gray, mask), 'brightness>1 让画面变亮');

  const ce = still([{type: 'color', exposure: 1}], 100, 'c-exp1');
  ok(maskedMeanGray(ce.gray, mask) > mb, 'exposure=1（约 2 倍）比 brightness=1.5 更亮 —— 顺序与量级都对');

  const ci = still([{type: 'color', saturation: 1}], 100, 'c-id');
  ok(ci.hash === base100.hash, '恒等参数与不写 effects **逐位相同**（直通条件命中）');
}

// ── vignette ─────────────────────────────────────────────────────────────
{
  const v = still([{type: 'vignette', amount: 0.8}], 100, 'v8');
  // 内容掩码（blur 标定）上比"近/远"两档的压暗系数。
  // 不用"效果改变了的像素"当掩码：暗角在中心几乎不改变像素，那一档会是空的。
  const p = vignetteProfile(base100.gray, v.gray, mask, W, H);
  console.log(`  压暗系数（1=没变暗）：近中心 ${p.near.toFixed(3)}（${p.nearN} 像素）` +
    `  远中心 ${p.far.toFixed(3)}（${p.farN} 像素）`);
  ok(p.farN > 500 && p.nearN > 500, '两档都有足够像素可比（否则判据不可信）');
  ok(p.far < p.near - 0.05, `暗角**远处比近处压得多**（${p.far.toFixed(2)} < ${p.near.toFixed(2)}）—— 是径向而不是整体变暗`);
  ok(p.near > 0.95, '近中心几乎不受影响（暗角不该把画面整体压暗）');

  // 另一条独立佐证：被暗角**改变**的像素，平均离中心更远
  const mV = contentMask(base100.rgb, v.rgb);
  const meanR = (m) => {
    let s = 0, n = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const j = y * W + x;
        if (!m[j]) continue;
        s += Math.hypot((x / W - 0.5) * 2, (y / H - 0.5) * 2);
        n++;
      }
    }
    return n ? s / n : 0;
  };
  const rContent = meanR(mask), rChanged = meanR(mV);
  console.log(`  平均离中心距离：内容 ${rContent.toFixed(3)} → 被改变的像素 ${rChanged.toFixed(3)}`);
  ok(rChanged > rContent + 0.1, '被暗角改变的像素**更靠外**（径向作用的独立佐证）');

  const v0 = still([{type: 'vignette', amount: 0}], 100, 'v0');
  ok(v0.hash === base100.hash, 'amount=0 与不写 effects **逐位相同**（直通条件命中）');
}

line('═');
console.log('六、代价：同一次运行内配对测有/无效果的端到端 ms/帧');
line();
const N = 60;
function bench(effects, tag) {
  setEffects(effects);
  const out = join(P, '.work', 'b-' + tag + '.mp4');
  rmSync(out, {force: true});
  const t0 = Date.now();
  const args = ['render', '--project', P, '--from', '40', '--to', String(40 + N - 1), '--shards', '1', '--out', out];
  if (USE_GPU) args.push('--gpu');
  const r = run(args);
  const secs = (Date.now() - t0) / 1000;
  if (r.status !== 0) { console.log(`渲染失败(${tag})：` + String(r.stderr || r.stdout).slice(-300)); return null; }
  return secs * 1000 / N;
}
const tNo = bench(null, 'no');
const tBlur = bench([{type: 'blur', radius: 12}], 'blur');
if (tNo && tBlur) {
  console.log(`  不写 effects : ${tNo.toFixed(1)} ms/帧`);
  console.log(`  blur radius=12: ${tBlur.toFixed(1)} ms/帧`);
  console.log(`  ⇒ 代价 +${(tBlur - tNo).toFixed(1)} ms/帧（${(tBlur / tNo).toFixed(2)}×）`);
  ok(true, '两档都渲染成功（数字见上，这是**实测**不是外推）');
} else {
  ok(false, '性能测量渲染成功');
}

rmSync(P, {recursive: true, force: true});
line('═');
console.log(bad === 0 ? '✓ 效果链最小闭环验收通过' : `✗ ${bad} 项失败`);
process.exit(bad ? 1 : 0);
