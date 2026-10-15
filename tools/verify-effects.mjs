// 验收：效果链（最小闭环 blur）真的生效、方向正确、代价可量。
//
//   node tools/verify-effects.mjs [<仓库根>] [--gpu] [--negative]
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
//
// ## 它自己的负面对照（`--negative`）
//
// 上面那些判据自己也要能被证伪，否则就是"永远绿的检查"。`--negative` 把**效果链**
// 故意弄坏（让 blur 那一趟不再生效），在**临时副本仓库根**上重跑本工具，要求它**红**
// 且红在**预期的那组判据**上、且真的跑完了全程。真源码一个字节都不动。
// ⚠️ CI 是**无参**调用 ⇒ 这一段不进 CI 的墙钟（它要跑一整遍，只适合手动/改判据时跑）。
import {spawnSync} from 'node:child_process';
import {cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {EFFECT_TYPES} from '../src/contract/effects.js';

// resolve() 保证 ROOT 是**绝对路径**：下面要用它拼 file:// URL 或 pathToFileURL，
// 相对路径会抛 ERR_INVALID_FILE_URL_PATH（CI 步骤里传 `.` 时踩到过）。
//
// ⚠️ 位置参数必须**跳过选项**：选项也是 argv 元素，直接取 `argv[2]` 会让
// `node tools/verify-effects.mjs --gpu` 把 ROOT 解析成 `<cwd>/--gpu`（选项写在前面就崩）。
const ARGV = process.argv.slice(2);
const ROOT = resolve(ARGV.filter((a) => !a.startsWith('--'))[0] || process.cwd()).replace(/\\/g, '/');
const USE_GPU = ARGV.includes('--gpu');
const NEGATIVE = ARGV.includes('--negative');
const KIT = join(ROOT, 'bin', 'filmwright.mjs');
const SRC = join(ROOT, 'examples', 'scenecast');
const P = join(ROOT, '.work', 'fx-e2e');

let bad = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) bad++; };
const line = (c = '─') => console.log(c.repeat(76));

// `--negative`：换成跑**本工具自己的负面对照**（见文件头与文件末尾的 runNegativeControl）。
// ⚠️ 这一句必须放在 `ok` / `line` 之后：它们都是 const，函数里要用到，
// 提前调用会踩"Cannot access before initialization"（写这版时真踩过）。
if (NEGATIVE) process.exit(runNegativeControl());

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
  // 传输层偶发抖动（`fetch failed`）会造出**假失败**。这个工具现在在 CI 里跑，
  // 所以对"看起来像传输问题"的失败重试一次 —— 但**只重试传输错误**：
  // 真正的渲染失败（页面报错、校验不过）照旧直接失败，不能被重试掩盖。
  for (let attempt = 0; attempt < 2; attempt++) {
    rmSync(dir, {recursive: true, force: true});
    const r = run(['stills', '--project', P, '--frames', String(frame), '--dir', dir]);
    if (r.status === 0) {
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
    const out = String(r.stderr || r.stdout);
    if (attempt === 0 && /fetch failed|ECONNRESET|socket hang up/i.test(out)) {
      console.log(`  （传输抖动，重试一次：${tag}）`);
      continue;
    }
    console.log(`渲染失败(${tag})：` + out.slice(-400));
    process.exit(1);
  }
}

/** 边缘能量：相邻像素灰度差的和（模糊会让它下降）。 */
function edgeEnergy(gray) {
  let s = 0;
  for (let i = 1; i < gray.length; i++) s += Math.abs(gray[i] - gray[i - 1]);
  return s / gray.length;
}

/**
 * **掩码内**的边缘能量（水平方向）。
 *
 * 为什么需要它：效果只作用于镜头层，而整帧里 2/3 的像素是引擎画的背板 ——
 * 背板自己的边缘不受模糊影响，会把"大半径到底糊了多少"稀释掉。
 * 实测：半径 34 时镜头内容已经基本抹平，但整帧边缘能量只降到基线的 62%，
 * 看上去像"大半径没生效"（其实是我的判据在量不该量的地方）。
 */
function maskedEdgeEnergy(gray, mask, w) {
  let s = 0, n = 0;
  for (let y = 0; y < mask.length / w; y++) {
    for (let x = 1; x < w; x++) {
      const j = y * w + x;
      if (!mask[j] || !mask[j - 1]) continue;
      s += Math.abs(gray[j] - gray[j - 1]);
      n++;
    }
  }
  return n ? s / n : 0;
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

/**
 * 块状均匀性：`pixelate` 的判据。
 *
 * 马赛克的定义就是"每 size×size 块内颜色相同"，所以**块内的水平相邻差应当 ≈ 0**，
 * 而块边界处可以有差。这条比"画面变了"锋利得多 —— 它能区分
 * "真的按方块取色"与"只是把画面弄糊了一点"。
 *
 * ⚠️ 必须只在**镜头内容掩码**内统计：效果只作用于镜头层，
 * 背板（引擎画的底色/网格）没有马赛克化 —— 整帧统计会被它稀释（实测踩到过）。
 */
function blockUniformity(gray, w, h, size, mask) {
  let inSum = 0, inN = 0, bSum = 0, bN = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 1; x < w; x++) {
      const j = y * w + x;
      if (mask && (!mask[j] || !mask[j - 1])) continue;
      const d = Math.abs(gray[j] - gray[j - 1]);
      if (x % size === 0) { bSum += d; bN++; } else { inSum += d; inN++; }
    }
  }
  return {inside: inN ? inSum / inN : 0, boundary: bN ? bSum / bN : 0};
}

/**
 * 腐蚀掩码：只留下"四周 r 像素都在掩码内"的像素。
 *
 * 为什么需要：掩码是"blur 改变了哪些像素"，它含一圈**外溢环** —— 环里镜头层是
 * 透明的（露出背板），背板自己的边缘不受模糊影响。于是大半径时镜头内容早已抹平，
 * 但边缘能量卡在一个"背板地板"上（≈1.0），小半径与大半径的差别被淹没，
 * 看起来像"越大反而越不糊"（实测踩到过：半径 34→80 出现 5% 的回升）。
 * 腐蚀之后只量内容深处，地板消失。
 */
function erodeMask(mask, w, h, r) {
  const out = new Uint8Array(mask.length);
  for (let y = r; y < h - r; y++) {
    for (let x = r; x < w - r; x++) {
      const j = y * w + x;
      if (!mask[j]) continue;
      let all = true;
      for (let dy = -r; dy <= r && all; dy += r) {
        for (let dx = -r; dx <= r; dx += r) {
          if (!mask[(y + dy) * w + (x + dx)]) { all = false; break; }
        }
      }
      if (all) out[j] = 1;
    }
  }
  return out;
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
// 基准帧与**镜头内容掩码**先算好：后面每一节都只在镜头内容上量。
// 效果只作用于镜头层，而整帧里约 2/3 是引擎画的背板（不受影响）——
// 在整帧上量会把结论稀释掉（这个坑在三个不同的判据上各踩过一次）。
const base100 = still(null, 100, 'base100');
const maskRef = still([{type: 'blur', radius: 30}], 100, 'maskref');
const mask = contentMask(base100.rgb, maskRef.rgb);
const maskPct = (mask.reduce((a, b) => a + b, 0) / mask.length * 100).toFixed(1);
// 大半径的判据要量**内容深处**（腐蚀掉外溢环），否则会卡在"背板地板"上，见 erodeMask
const inner = erodeMask(mask, W, H, 8);
const innerPct = (inner.reduce((a, b) => a + b, 0) / inner.length * 100).toFixed(1);
console.log(`镜头内容区域（自动标定）：占整帧 ${maskPct}%；腐蚀后（内容深处）${innerPct}% —— 其余是背板，效果不作用于它\n`);
// **下限断言**：掩码是拿"blur 改动了哪些像素"标定的，所以它非空本身就证明效果真的改了画面。
// 空集上算出来的均值恒为 0，后面每一条"掩码内"的判据都会退化成比 0 与 0 —— 打印出来
// 有数字、看着像在量，其实什么都没量（审计就点名过这类"算了不用的量"）。
{
  const maskN = mask.reduce((a, b) => a + b, 0);
  const innerN = inner.reduce((a, b) => a + b, 0);
  ok(maskN > 0 && innerN > 0,
    `标定出的内容掩码与腐蚀后的掩码都**非空**（${maskN} / ${innerN} 像素）⇒ 后面的"掩码内"判据不是在空集上取值`);
}

line('═');
console.log('一、radius=0 必须**逐位等于**不写 effects（短路保证）');
line();
const none = base100;
const r0 = still([{type: 'blur', radius: 0}], 100, 'r0');
console.log(`  不写 effects : ${none.hash}`);
console.log(`  radius=0     : ${r0.hash}`);
ok(none.hash === r0.hash, 'radius=0 与不写 effects **逐位相同**（效果被短路，没产生额外趟）');

line('═');
console.log('二、模糊必须真的生效，且**半径越大越模糊**（量**镜头内容内**的边缘能量）');
line();
// 半径范围**跨过全部金字塔层**：16 以下全分辨率，16→32 走 1 层，32→64 走 2 层，
// 64→128 走 3 层，128 以上走 4 层。当年就是在半径 24 处抓到"越大反而越锐"的振铃。
const radii = [2, 8, 20, 34, 80, 200];
const samples = [];
for (const rad of radii) {
  const s = still([{type: 'blur', radius: rad}], 100, 'r' + rad);
  samples.push({rad, ...s, e: maskedEdgeEnergy(s.gray, inner, W)});
}
const eNone = maskedEdgeEnergy(none.gray, inner, W);
console.log(`  不写 effects : 掩码内边缘能量 ${eNone.toFixed(3)}  hash ${none.hash}`);
for (const s of samples) {
  console.log(`  radius=${String(s.rad).padStart(3)}    : 掩码内边缘能量 ${s.e.toFixed(3)}  hash ${s.hash}` +
    `   ${s.hash === none.hash ? '（与不写 effects 相同 ← 可疑）' : ''}`);
}
ok(samples.every((s) => s.hash !== none.hash), 'radius>0 的画面都与不写 effects **不同**（效果确实上了）');
ok(samples.every((s) => s.e < eNone), '半径>0 的边缘能量都**低于**不写 effects（确实变模糊了）');
// **单调性只在"未饱和区间"断言**（2–34）。
// 为什么：半径 34 之后镜头内容已经基本抹平，掩码内的残差 ≈1.2 是**背板**透过
// 半透明层露出的边缘 —— 指标饱和了，再比大小就是比噪声（实测 34→80 有 5% 的回升，
// 那不是振铃，是地板）。当年抓振铃（"半径越大反而越锐"）正是在这个区间。
const unsat = samples.filter((s) => s.rad <= 34);
let mono = true;
for (let i = 1; i < unsat.length; i++) {
  if (!(unsat[i].e < unsat[i - 1].e)) mono = false;
}
ok(mono, `未饱和区间（${unsat.map((s) => s.rad).join('/')}）边缘能量**单调下降**` +
  `（${unsat.map((s) => s.e.toFixed(2)).join(' → ')}）—— 没有振铃`);

// 大半径改验**它们各自能证明的性质**：
// ① 每一档都要与其它档**不同** —— 这条抓的正是"金字塔缓冲没分配存储"那个 bug
//    （当时 34/80/200 输出**完全相同**、整幅几乎全黑）。
const bigHashes = samples.filter((s) => s.rad > 34).map((s) => s.hash);
ok(new Set(bigHashes).size === bigHashes.length,
  `大半径各档输出互不相同（${bigHashes.join(' / ')}）—— 不是被截断/退化成同一个结果`);
// ② 大半径要**真的糊掉**（相对基线）；③ 不能崩成黑屏/NaN
const big = samples[samples.length - 1];
const bigMean = meanGray(big.gray);
console.log(`  半径 ${big.rad}：掩码内边缘能量 ${big.e.toFixed(3)}（基线 ${eNone.toFixed(3)}），整帧平均亮度 ${bigMean.toFixed(1)}`);
ok(big.e < eNone * 0.2, `半径 ${big.rad} 把镜头内容的高频压到基线的 ${(big.e / eNone * 100).toFixed(0)}% ⇒ 真的糊了`);
ok(bigMean > 1 && bigMean < 250, `平均亮度 ${bigMean.toFixed(1)} 在合理区间 ⇒ 没有崩成黑屏/NaN`);

// 金字塔**层切换处**不能有跳变：16→17 跨 0→1 层，32→33 跨 1→2 层。
// 这是金字塔最容易出问题的地方（降/升采样的接缝）。
console.log('  层切换处（seam）检查：');
let seamOk = true;
for (const [a, b] of [[16, 17], [32, 33], [64, 65]]) {
  const sa = still([{type: 'blur', radius: a}], 100, 'seam' + a);
  const sb = still([{type: 'blur', radius: b}], 100, 'seam' + b);
  const ea = maskedEdgeEnergy(sa.gray, inner, W), eb = maskedEdgeEnergy(sb.gray, inner, W);
  const jump = Math.abs(ea - eb) / Math.max(ea, eb);
  const dm = Math.abs(meanGray(sa.gray) - meanGray(sb.gray));
  console.log(`    半径 ${a}→${b}：掩码内边缘能量 ${ea.toFixed(3)} → ${eb.toFixed(3)}（跳变 ${(jump * 100).toFixed(1)}%），平均亮度差 ${dm.toFixed(2)}`);
  if (jump > 0.25 || dm > 3) seamOk = false;
}
ok(seamOk, '层切换处没有明显跳变（降/升采样的接缝是连续的）');

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
// （基准帧与掩码在文件开头已经算好，这里直接复用。）
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
// ⚠️ 判据用**归一化比值**（本帧边缘能量 ÷ 本帧无效果的边缘能量），不用原始值 ——
// 模板本身在动，源内容的边缘能量随时间变，原始值会出现 1.6% 级的反向
// （CI 实测：1.115 → 1.071 → 1.088 → 1.031 被判"非单调"而红）。
// 归一化把**内容漂移**除掉，剩下的才是"模糊在渐入"。
const kfRatio = kfSamples.map((s) => s.e / s.baseE);
let monoT = true;
for (let i = 1; i < kfRatio.length; i++) {
  if (!(kfRatio[i] < kfRatio[i - 1])) monoT = false;
}
ok(monoT, `模糊比例随时间**单调下降**（${kfRatio.map((r) => r.toFixed(3)).join(' → ')}）`
  + ` —— 确实在渐入。（原始边缘能量 ${kfSamples.map((s) => s.e.toFixed(2)).join(' → ')}；`
  + `用同帧无效果归一化，除掉模板自身的内容漂移。）`);

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
console.log('六、五个新效果（每个都给可量化的判据）');
line();
{
  // ── chromatic：红/蓝分开，且越靠边越开 ──
  const c0 = still([{type: 'chromatic', amount: 12}], 100, 'ch12');
  const chDiff = maskedMeanAbsDiff(base100.rgb, c0.rgb, mask);
  console.log(`  chromatic：与不写效果的差异 ${chDiff.toFixed(2)} 级`);
  ok(chDiff > 1, '色差确实改变了画面');
  // 红蓝通道"错位"的度量：把红通道整体平移回去，差异应当变小
  const shiftScore = (rgb, k) => {
    // 比较 R[x] 与 B[x+k]：如果色差把红往右推，那么 k>0 时应当更接近
    let s = 0, nn = 0;
    for (let y = 40; y < H - 40; y += 3) {
      for (let x = 200; x < W - 200; x += 3) {
        const i = (y * W + x) * 3, j = (y * W + x + k) * 3;
        if (j < 0 || j + 2 >= rgb.length) continue;
        s += Math.abs(rgb[i] - rgb[j + 2]);
        nn++;
      }
    }
    return s / nn;
  };
  const s0 = shiftScore(c0.rgb, 0), s8 = shiftScore(c0.rgb, 8);
  console.log(`  红蓝错位：不平移 ${s0.toFixed(2)}  平移 8px 后 ${s8.toFixed(2)}`);
  ok(s8 < s0, '红通道与"平移后的蓝通道"更接近 ⇒ 确实是**通道分离**，不是别的变化');
  const ch0 = still([{type: 'chromatic', amount: 0}], 100, 'ch0');
  ok(ch0.hash === base100.hash, 'chromatic amount=0 与不写 effects **逐位相同**');

  // ── grain：噪点是 (像素, 帧号) 的纯函数 ──
  const g = still([{type: 'grain', amount: 0.35}], 100, 'gr');
  const gAgain = still([{type: 'grain', amount: 0.35}], 100, 'gr2');
  const gNext = still([{type: 'grain', amount: 0.35}], 101, 'gr101');
  ok(g.hash === gAgain.hash, 'grain：**同一帧两次渲染逐字节一致**（噪点不读时钟）');
  ok(g.hash !== gNext.hash, 'grain：不同帧的颗粒不同（是"会动的胶片颗粒"而不是静态纹理）');
  const gd = maskedMeanAbsDiff(base100.rgb, g.rgb, mask);
  const gSmall = still([{type: 'grain', amount: 0.1}], 100, 'grS');
  const gdSmall = maskedMeanAbsDiff(base100.rgb, gSmall.rgb, mask);
  console.log(`  grain：强度 0.1 → 差 ${gdSmall.toFixed(2)} 级；强度 0.35 → 差 ${gd.toFixed(2)} 级`);
  ok(gd > gdSmall && gdSmall > 0, '颗粒强度越大偏离原图越多（单调）');
  const g0 = still([{type: 'grain', amount: 0}], 100, 'gr0');
  ok(g0.hash === base100.hash, 'grain amount=0 与不写 effects **逐位相同**');

  // ── pixelate：**块内相邻差应当 ≈ 0** ──
  const px = still([{type: 'pixelate', size: 8}], 100, 'px8');
  // 掩码用"**被马赛克改变了的像素**"：blur 掩码里含一圈模糊外溢环，
  // 那里镜头层是透明的（露出背板的渐变），轮不到马赛克去管 —— 用它会把残差算进来。
  const mPx = contentMask(base100.rgb, px.rgb);
  const baseU = blockUniformity(base100.gray, W, H, 8, mPx);
  const pxU = blockUniformity(px.gray, W, H, 8, mPx);
  console.log(`  pixelate size=8（只在"被马赛克改变的像素"内统计）：块内相邻差 ${baseU.inside.toFixed(3)} → ${pxU.inside.toFixed(3)}` +
    `；块边界处 ${pxU.boundary.toFixed(3)}`);
  // 判据用**相对下降**而不是"≈0"：马赛克层在抗锯齿边缘是**半透明**的，
  // 叠在有渐变的背板上时背板的起伏会透出来 —— 那是物理正确的结果，不是缺陷。
  // 块内降到原来的 10% 以下、且块边界远高于块内，足以证明"真的按方块取色"。
  const drop = pxU.inside / baseU.inside;
  ok(drop < 0.1, `块内相邻差降到原来的 ${(drop * 100).toFixed(1)}%（${baseU.inside.toFixed(2)} → ${pxU.inside.toFixed(2)}）⇒ 按方块取色`);
  ok(pxU.boundary > pxU.inside * 5,
    `块边界处远高于块内（${pxU.boundary.toFixed(1)} vs ${pxU.inside.toFixed(2)}，${(pxU.boundary / Math.max(pxU.inside, 1e-6)).toFixed(0)}×）⇒ 不是把整幅抹平了`);
  const px1 = still([{type: 'pixelate', size: 1}], 100, 'px1');
  ok(px1.hash === base100.hash, 'pixelate size=1 与不写 effects **逐位相同**');

  // ── radialBlur：径向拖尾 ⇒ 边缘能量下降，且**离中心越远降得越多** ──
  const rb = still([{type: 'radialBlur', amount: 0.15}], 100, 'rb');
  const rbE = edgeEnergy(rb.gray), baseE = edgeEnergy(base100.gray);
  console.log(`  radialBlur：边缘能量 ${baseE.toFixed(3)} → ${rbE.toFixed(3)}`);
  ok(rbE < baseE, '径向模糊让高频下降');
  // 与"均匀模糊"的区别：径向模糊在中心几乎不动，在边缘动得多
  const rbC = maskedMeanAbsDiff(base100.rgb, rb.rgb, mask);
  const blC = maskedMeanAbsDiff(base100.rgb, still([{type: 'blur', radius: 6}], 100, 'blcmp').rgb, mask);
  console.log(`  radialBlur 与不写效果的差异 ${rbC.toFixed(2)} 级（对照：radius=6 均匀模糊 ${blC.toFixed(2)} 级）`);
  ok(rbC > 0 && Math.abs(rbC - blC) > 0.5, '径向模糊与**均匀模糊**是不同的东西（不是同一个效果换名）');
  const rb0 = still([{type: 'radialBlur', amount: 0}], 100, 'rb0');
  ok(rb0.hash === base100.hash, 'radialBlur amount=0 与不写 effects **逐位相同**');

  // ── distort：把采样位置推开 ──
  const d1 = still([{type: 'distort', amount: 0.3}], 100, 'di1');
  const d2 = still([{type: 'distort', amount: 0.9}], 100, 'di2');
  const dd1 = maskedMeanAbsDiff(base100.rgb, d1.rgb, mask);
  const dd2 = maskedMeanAbsDiff(base100.rgb, d2.rgb, mask);
  console.log(`  distort：幅度 0.3 → 差 ${dd1.toFixed(2)} 级；幅度 0.9 → 差 ${dd2.toFixed(2)} 级`);
  ok(dd1 > 0 && dd2 > dd1, '扭曲幅度越大偏离原图越多（单调）');
  const dp = still([{type: 'distort', amount: 0.3, phase: 90}], 100, 'diP');
  ok(dp.hash !== d1.hash, 'phase 会平移波纹（相位是有效的参数，不是摆设）');
  const d0 = still([{type: 'distort', amount: 0}], 100, 'di0');
  ok(d0.hash === base100.hash, 'distort amount=0 与不写 effects **逐位相同**');
}

line('═');
console.log('七、**每个效果**都必须"同一帧两次渲染逐字节一致"（核心不变量）');
line();
{
  // 为什么单列一节、且**遍历全部效果**：
  // 原来只有 grain 一条确定性判据（"噪点不读时钟"），其余效果**没人验过**。
  // 而 `displace` 的一次实现正是栽在这里 —— 同一帧两次渲染像素不同，
  // 直接违反"第 N 帧只是 N 的函数"。**这条若覆盖全部效果，它当场就会被抓住。**
  //
  // 顺带排除两个常见猜测（都**有证据**、不是推断）：
  //   · grain 用 `fract(sin(dot(...)) * 43758.5453)` 这种 hash ⇒ 它一致，**hash 没问题**；
  //   · distort 会偏移纹理采样坐标 ⇒ 它一致，**偏移采样也没问题**。
  const PARAMS = {
    blur: {radius: 12}, glow: {intensity: 0.6, threshold: 0.6}, color: {saturation: 0.6},
    vignette: {amount: 0.5}, chromatic: {amount: 0.5}, grain: {amount: 0.35},
    pixelate: {size: 10}, radialBlur: {amount: 0.3}, distort: {amount: 0.5},
    grade: {look: 'noir', amount: 1},
    displace: {amount: 0.8, frequency: 8},
  };
  let inconsistent = 0;
  for (const t of EFFECT_TYPES) {
    const fx = [{type: t, ...PARAMS[t]}];
    const a = still(fx, 100, `det-${t}-a`);
    const b = still(fx, 100, `det-${t}-b`);
    const same = a.hash === b.hash;
    if (!same) inconsistent++;
    ok(same, `${t}：同一帧两次渲染${same ? '逐字节一致' : `**不一致**（${a.hash} ≠ ${b.hash}）`}`);
  }
  console.log(`  覆盖 ${EFFECT_TYPES.length} 个效果，${inconsistent} 个不一致`);

  // ── displace：参数真的生效吗（与上面那条确定性判据合起来才算验完）──
  // ⚠️ 只用**站得住**的判据。原本想写"frequency 大 ⇒ 高频含量上升"，
  // 但实测**不成立**（位移类效果对边缘能量的影响不稳定），
  // 改成"不同 frequency 输出不同" —— 能证伪、也不会假阳性。
  const dA = still([{type: 'displace', amount: 0.8, frequency: 8}], 100, 'dsp-a');
  ok(dA.hash !== base100.hash, 'displace 确实改变了画面');
  const d0 = still([{type: 'displace', amount: 0}], 100, 'dsp-0');
  ok(d0.hash === base100.hash, 'displace amount=0 与不写 effects **逐位相同**（直通）');
  const dF = still([{type: 'displace', amount: 0.8, frequency: 30}], 100, 'dsp-f');
  ok(dF.hash !== dA.hash, `frequency 真的在起作用（8 → ${dA.hash}，30 → ${dF.hash}）`);
  const dD = still([{type: 'distort', amount: 0.8, frequency: 8}], 100, 'dsp-dist');
  ok(dA.hash !== dD.hash,
    `同参数下 displace 与 distort **输出不同**（${dA.hash} ≠ ${dD.hash}）—— 不是同一个效果`);
  const ph = [{frame: 1, v: 0}, {frame: 40, v: 150, ease: 'linear'}];
  const p1 = still([{type: 'displace', amount: 0.8, phase: ph}], 100, 'dsp-p1');
  const p2 = still([{type: 'displace', amount: 0.8, phase: ph}], 130, 'dsp-p2');
  const p1b = still([{type: 'displace', amount: 0.8, phase: ph}], 100, 'dsp-p1b');
  ok(p1.hash !== p2.hash, 'phase 关键帧让不同帧的画面不同（热浪在流动）');
  ok(p1.hash === p1b.hash, '带 phase 轨道时同一帧仍逐字节一致');
}

line('═');
console.log('八、调色预设 grade（编译期展开成 color，不额外开销）');
line();
{
  // noir 的去色用**自参照判据**（与 color saturation=0 同一条）：
  // 灰度之后再转色相必须**逐位不变** —— 色相旋转矩阵每行系数和为 1，灰进灰出。
  // 这比"画面变了"锋利：它能区分"真的去色"与"只是变暗/变对比了"。
  const noir = still([{type: 'grade', look: 'noir', amount: 1}], 100, 'gr-noir');
  const noirHue = still([{type: 'grade', look: 'noir', amount: 1}, {type: 'color', hue: 90}], 100, 'gr-noir-hue');
  const dNoir = maskedMeanAbsDiff(noir.rgb, noirHue.rgb, contentMask(noir.rgb, noirHue.rgb));
  console.log(`  noir：与不写效果的差异 ${maskedMeanAbsDiff(base100.rgb, noir.rgb, mask).toFixed(2)} 级；` +
    `再转色相的差异 ${dNoir.toFixed(2)} 级`);
  ok(noir.hash !== base100.hash, 'noir 确实改变了画面');
  ok(noir.hash === noirHue.hash, 'noir 之后转色相**逐位不变** ⇒ 画面确实被去色了');

  // warm / cool 的方向：比"红减蓝"的均值。warm 应当大于 cool。
  const warm = still([{type: 'grade', look: 'warm', amount: 1}], 100, 'gr-warm');
  const cool = still([{type: 'grade', look: 'cool', amount: 1}], 100, 'gr-cool');
  const rb = (rgb, m) => {
    let r = 0, b = 0, n = 0;
    for (let i = 0, j = 0; j < m.length; i += 3, j++) {
      if (!m[j]) continue;
      r += rgb[i]; b += rgb[i + 2]; n++;
    }
    return {r: r / n, b: b / n};
  };
  const w = rb(warm.rgb, mask), c = rb(cool.rgb, mask);
  console.log(`  warm 红/蓝 ${w.r.toFixed(1)}/${w.b.toFixed(1)}；cool 红/蓝 ${c.r.toFixed(1)}/${c.b.toFixed(1)}`);
  ok(warm.hash !== cool.hash, 'warm 与 cool 画面不同');
  ok((w.r - w.b) > (c.r - c.b), `warm 的"红减蓝"更大 ⇒ 方向正确（${(w.r - w.b).toFixed(1)} > ${(c.r - c.b).toFixed(1)}）`);

  // amount 插值：0 直通、半量夹在"原样"与"全量"之间
  const zero = still([{type: 'grade', look: 'noir', amount: 0}], 100, 'gr-0');
  ok(zero.hash === base100.hash, 'amount=0 与不写 effects **逐位相同**（展开成全恒等 ⇒ 直通）');
  const half = still([{type: 'grade', look: 'noir', amount: 0.5}], 100, 'gr-half');
  ok(half.hash !== base100.hash && half.hash !== noir.hash,
    '半量与"原样""全量"都不同 ⇒ 插值真的在生效（不是只有 0/1 两档）');
  // 更强的插值判据：半量的**通道差**应当夹在两者之间（去色程度居中）
  const sp0 = maskedSpread(base100.rgb, mask), spHalf = maskedSpread(half.rgb, mask), spFull = maskedSpread(noir.rgb, mask);
  console.log(`  通道差（去色程度）：原样 ${sp0.toFixed(2)} → 半量 ${spHalf.toFixed(2)} → 全量 ${spFull.toFixed(2)}`);
  ok(spFull < spHalf && spHalf < sp0, '半量的去色程度**夹在中间** ⇒ amount 是连续插值，不是开关');
}

line('═');
console.log('九、代价：同一次运行内配对测有/无效果的端到端 ms/帧');
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
// ⚠️ 这里原先是 `ok(true, ...)` —— **恒真**，等于没有判据（审计点名过）。
// 改成量**方向**：模糊至少要多过几趟 GPU，端到端只会更贵。
// 两档在**同一次运行内配对**测（先无效果、后有模糊），跨运行比会被负载漂移污染。
// 唯一会让它假红的是"测量期间负载突变"，所以两数反了时再配对重测一轮、仍反才算红
// —— 与 still() 的传输抖动重试同一口径（只对"看起来像噪声"的失败重试）。
let msNo = tNo, msBlur = tBlur;
if (msNo && msBlur && !(msBlur > msNo)) {
  console.log(`  （第一轮配对反了：${msBlur.toFixed(1)} ≤ ${msNo.toFixed(1)} ms/帧，重测一轮）`);
  msNo = bench(null, 'no2');
  msBlur = bench([{type: 'blur', radius: 12}], 'blur2');
}
if (msNo && msBlur) {
  console.log(`  不写 effects : ${msNo.toFixed(1)} ms/帧`);
  console.log(`  blur radius=12: ${msBlur.toFixed(1)} ms/帧`);
  console.log(`  ⇒ 代价 +${(msBlur - msNo).toFixed(1)} ms/帧（${(msBlur / msNo).toFixed(2)}×）`);
  ok(msBlur > msNo,
    `有模糊**更贵**（${msBlur.toFixed(1)} > ${msNo.toFixed(1)} ms/帧）⇒ 效果链真的在跑 GPU 趟，不是空转`);
} else {
  ok(false, '性能测量渲染成功');
}

rmSync(P, {recursive: true, force: true});
line('═');
console.log(bad === 0 ? '✓ 效果链最小闭环验收通过' : `✗ ${bad} 项失败`);
process.exit(bad ? 1 : 0);

// ═════════════════════════════════════════════════════════════════════════════
// 本工具自己的负面对照（`--negative`）。
//
// 上面那些判据自己也要能被证伪 —— "一个永远绿的检查不是检查"。这一段只改
// **临时副本仓库根**里的源码，真仓库一个字节都不动；跑完（含被 Ctrl-C）即清理。
//
// ⚠️ CI 不跑它（CI 是无参调用）：它要让本工具**完整跑一遍**，成本与正常一轮同量级。
// 手动跑法（改完判据、或怀疑某条判据变成恒真时）：
//   node tools/verify-effects.mjs --negative
// 对照成立 ⇒ 退出码 0；**对照失效**或判据漏了这种缺陷 ⇒ 退出码 1。
// ═════════════════════════════════════════════════════════════════════════════
function runNegativeControl() {
  const tmp = mkdtempSync(join(tmpdir(), 'fw-fx-neg-'));
  const wipe = () => { try { rmSync(tmp, {recursive: true, force: true}); } catch { /* 尽力而为 */ } };
  // ⚠️ 光靠 try/finally 挡不住"被 kill"：Node 收到 SIGINT/SIGTERM 默认直接终止、
  // **不走 finally**（SIGKILL 更挡不住）⇒ 另挂钩子：先清理，再按惯例退出码退出。
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.on(sig, () => { wipe(); process.exit(code); });
  }
  let bad = 0;
  const say = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) bad++; };

  line('═');
  console.log('负面对照：故意让 blur 那一趟不再生效，要求本工具**红**（改的是临时副本，真源码不动）');
  line();
  console.log(`  临时仓库根：${tmp}（跑完即删）`);
  const fixture = join(ROOT, 'examples', 'scenecast');
  try {
    // 只带渲染真正用到的那些。audio / renders / .work 与大音频素材都不必带
    // （前两类本工具自己也会从项目副本里删掉，后两类它根本不碰）。
    const skipTop = new Set(['audio', 'renders', '.work']);
    cpSync(join(ROOT, 'bin'), join(tmp, 'bin'), {recursive: true});
    cpSync(join(ROOT, 'src'), join(tmp, 'src'), {recursive: true});
    // 渲染页不用单独拷了：它在 `src/host/pages/render.html`，跟着上面的 src/ 一起过去
    cpSync(join(ROOT, 'package.json'), join(tmp, 'package.json'));
    // 临时仓库根就是新的「库根」⇒ 库自带的那份字体也要跟过去（见 `/fonts/` 的兜底）。
    cpSync(join(ROOT, 'fonts'), join(tmp, 'fonts'), {recursive: true});
    cpSync(fixture, join(tmp, 'examples', 'scenecast'), {
      recursive: true,
      filter: (s) => {
        const rel = relative(fixture, s).replace(/\\/g, '/');
        if (!rel) return true;                                   // 根自己
        if (skipTop.has(rel.split('/')[0])) return false;
        return rel !== 'public/assets/scenecast';                // 大音频素材，渲染不需要
      },
    });
    mkdirSync(join(tmp, '.work'), {recursive: true});
    mkdirSync(join(tmp, 'tools'), {recursive: true});
    cpSync(fileURLToPath(import.meta.url), join(tmp, 'tools', 'verify-effects.mjs'));

    // ── 注入缺陷：`apply()` 里 blur 的分支条件恒假 ──
    // 这**不是**崩溃式的缺陷：画面照常出，只是 `touched` 一直是 false ⇒
    // `applyEffects` 返回 null ⇒ 调用方走原路 ⇒ 输出与"不写 effects"逐位相同。
    // "效果没接上"正是第二节要抓的那类缺陷；反过来，把语法改坏、把命令拔掉这种
    // 注入连渲染都过不去，红了也证明不了判据有牙。
    const gpu = join(tmp, 'src', 'runtime', 'fx', 'gpu.js');
    const ANCHOR = "if (step.type === 'blur' && step.radius > 0) {";
    const before = readFileSync(gpu, 'utf8');
    if (!before.includes(ANCHOR)) {
      // 锚点漂移时**判失败**，不是判通过 —— 否则这条对照会在没人发现的情况下空转，
      // 变成"永远绿"（仓库里踩过这个坑：字符串替换没命中，四条断言全在空气上绿着）。
      say(false, `注入点没找到（${ANCHOR}）⇒ **对照失效**（不是通过）：gpu.js 改过就得修这条对照`);
      return 1;
    }
    writeFileSync(gpu, before.replace(ANCHOR, "if (step.type === 'blur' && false) {"), 'utf8');

    // ── 在缺陷版上重跑本工具：同一个工具、仓库根指向副本 ──
    // ⚠️ 只给子进程放宽 **boot 预算**（`session.mjs` 的 `FILMWRIGHT_BOOT_TRIES`，默认 1200×100ms）：
    // 这条对照要把本工具完整跑一遍（约 90 次浏览器启动），机器一忙就会有一次
    // "渲染页 130s 内没就绪" 把对照打成"环境没起来" —— 那是噪声、不是判据的结论。
    // 它只改**等页面就绪的耐心**，一条判据都不读这个变量；操作者自己设了就用操作者的。
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [join(tmp, 'tools', 'verify-effects.mjs'), tmp],
      {encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, cwd: tmp,
        env: {...process.env, FILMWRIGHT_BOOT_TRIES: process.env.FILMWRIGHT_BOOT_TRIES || '3600'}});
    const out = String(r.stdout || '') + String(r.stderr || '');
    const fails = out.split('\n').filter((l) => l.startsWith('✗'));
    console.log(`  缺陷版：退出码 ${r.status}，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，` +
      `结尾「${out.trimEnd().split('\n').slice(-1)[0] ?? ''}」`);
    for (const l of fails) console.log(`  | ${l}`);

    // 三条一起成立才算对照成立 —— 缺任何一条，"红了"都可能红得没有意义。
    say(r.status !== 0, `带缺陷的引擎让本工具**退出码非 0**（实测 ${r.status}）`);
    // "效果没接上"由这两条判据之一负责抓：blur 不生效 ⇒ 掩码标定出来的内容区是**空集**
    // （下限断言先响），而第二节的"radius>0 必须与不写 effects 不同"是同一条性质的正面判据。
    // 只要求**至少命中一条**：两条都要求会把对照绑死在实现细节上；一条都不要求则是空话。
    const EXPECTS = [
      '✗ 标定出的内容掩码与腐蚀后的掩码都**非空**',
      '✗ radius>0 的画面都与不写 effects',
    ];
    const hits = EXPECTS.filter((e) => out.includes(e));
    say(hits.length > 0, `红在**预期的那组判据**上（命中 ${hits.length}/${EXPECTS.length} 条：` +
      `${hits.map((h) => h.replace(/^✗ /, '')).join(' ／ ') || '一条都没有'}）`);
    const finished = /✗ \d+ 项失败/.test(out);
    say(finished, '跑完了**全程**（结尾有"✗ N 项失败"）—— 不是启动/渲染崩掉所以红');
    if (!finished) {
      // 没跑完 ⇒ 把尾巴打出来。若是"渲染页没就绪"这类**本机负载**问题（不是判据的结论），
      // 那就说明这一次对照没跑成，重跑一次即可 —— 但也**不许当作通过**。
      const envFail = /渲染失败|没就绪/.test(out);
      console.log(envFail
        ? '  （这一次是渲染环境没起来：本机负载高时的已知抖动，不算判据的结论，重跑即可）'
        : '  （没跑完的原因见下；多半是副本缺东西之类的环境问题，不是判据的事）');
      for (const l of out.trimEnd().split('\n').slice(-12)) console.log(`  | ${l}`);
    }
    console.log(bad === 0
      ? '\n  ⇒ 负面对照成立：确有缺陷时本工具会红，且红在该红的那条判据上。'
      : '\n  ⇒ **负面对照不成立**：要么这条对照失效，要么判据漏了这种缺陷 —— 别当它通过。');
  } finally {
    wipe();
    console.log('  （已清理临时仓库根）');
  }
  return bad ? 1 : 0;
}
