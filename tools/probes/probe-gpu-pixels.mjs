// GPU 像素影响探针：回答"放开 GPU 让 2D 像素变了，到底有什么影响"。
//
//   node tools/probes/probe-gpu-pixels.mjs [<仓库根>]
//
// 上一个探针（probe-render.mjs）只证明了 A 档与 C 档的**哈希不同**。
// 哈希不同只说"不是逐位相同"，**说不了视觉上有没有差别** —— 这两件事差别很大。
// 这个探针量三个决定性的事实：
//
//   1. **差多少**：逐像素通道差的最大值 / 平均值 / 不同像素占比
//      —— 判断是"肉眼不可见"还是"看得出"
//   2. **同配置跑两次一样吗**（运行间确定性）
//      —— 若不稳定，C 档的验证机制全线失效（比跨机器不同严重得多）
//   3. **两个实例并发出图一致吗**
//      —— 决定分片渲染在 GPU 下是否还安全
//
// 第 2、3 条**不只关乎 C 档**：B 档下 3D 图层的像素也来自 GPU，
// 所以它们决定了 3D 能不能纳入像素回归。
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const ROOT = (argv[0] && !argv[0].startsWith('--') ? argv[0] : resolve(HERE, '..')).replace(/\\/g, '/');
const P = join(ROOT, 'examples', 'scenecast');
const FRAME = 200;

const imp = (rel) => import(pathToFileURL(`${ROOT}/${rel}`).href);
const {openProjectSession} = await imp('src/host/media/renderRange.mjs');
const {loadProject} = await imp('src/host/project/load.mjs');
const proj = await loadProject(P);

const line = (c = '─') => console.log(c.repeat(76));

/** 页面侧：取某帧的采样 RGBA（每 2 个像素取 1 个，4 通道全取），base64 回传。 */
function pageSample(args) {
  const c = document.querySelector('canvas');
  const ctx = c.getContext('2d');
  window.__renderFrame(args.frame);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  const step = args.step;                       // 每 step 个像素取 1 个
  const n = Math.floor(d.length / 4 / step);
  const out = new Uint8Array(n * 4);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const src = i * step * 4;
    out[j] = d[src]; out[j + 1] = d[src + 1]; out[j + 2] = d[src + 2]; out[j + 3] = d[src + 3];
  }
  // 分块转 base64，避免一次 btoa 遇到超长字符串
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < out.length; i += CH) {
    bin += String.fromCharCode.apply(null, out.subarray(i, i + CH));
  }
  return JSON.stringify({b64: btoa(bin), w: c.width, h: c.height, step, n});
}

const TIERS = {
  A: {label: 'A 全软件', opts: {}},
  B: {label: 'B 2D软件+GPU', opts: {gpu: true, extraArgs: ['--disable-accelerated-2d-canvas']}},
  C: {label: 'C 全硬件', opts: {gpu: true}},
};

async function sample(tierId) {
  const r = await openProjectSession(P, proj, TIERS[tierId].opts);
  try {
    const raw = await r.sess.evaluate(`(${pageSample.toString()})(${JSON.stringify({frame: FRAME, step: 2})})`);
    const o = JSON.parse(raw);
    return {buf: Buffer.from(o.b64, 'base64'), w: o.w, h: o.h, step: o.step, n: o.n};
  } finally {
    try { await r.sess.close(); } catch {}
    try { r.server.close(); } catch {}
  }
}

/** 两张采样图逐通道比：最大差 / 平均差 / 不同像素占比 / 差 1 级以内的占比。 */
function diff(a, b) {
  const n = Math.min(a.buf.length, b.buf.length);
  let max = 0, sum = 0, pxDiff = 0, pxTotal = 0, within1 = 0, within2 = 0;
  for (let i = 0; i < n; i += 4) {
    pxTotal++;
    let pmax = 0;
    for (let k = 0; k < 3; k++) {           // 只比 RGB，忽略 alpha
      const d = Math.abs(a.buf[i + k] - b.buf[i + k]);
      if (d > pmax) pmax = d;
      sum += d;
      if (d > max) max = d;
    }
    if (pmax > 0) { pxDiff++; if (pmax <= 1) within1++; else if (pmax <= 2) within2++; }
  }
  return {
    max, mean: sum / (pxTotal * 3),
    pctDiff: pxDiff / pxTotal * 100,
    pctWithin1: within1 / pxTotal * 100,
    pctWithin2: within2 / pxTotal * 100,
    pxTotal,
  };
}

const fmt = (d) => `最大差 ${d.max} 级 | 平均差 ${d.mean.toFixed(3)} | 不同像素 ${d.pctDiff.toFixed(2)}%` +
  ` | 其中差≤1级 ${d.pctWithin1.toFixed(2)}%`;

console.log(`探针项目：${P}，第 ${FRAME} 帧，采样间隔 2 像素（约 ${(1280 * 720 / 2 / 1000).toFixed(0)}k 像素）\n`);

// ── 1. 三档之间的差（同一时刻各采一次）────────────────────────────────────
line('═');
console.log('① 三档之间差多少（决定"看不看得出"）');
line();
const A = await sample('A');
const B = await sample('B');
const C = await sample('C');
console.log(`  A vs B：${fmt(diff(A, B))}`);
console.log(`  A vs C：${fmt(diff(A, C))}`);
console.log(`  B vs C：${fmt(diff(B, C))}`);

// ── 2. 同一配置跑两次（运行间确定性）─────────────────────────────────────
line('═');
console.log('② 同一配置跑两次一样吗（运行间确定性）—— 这一条最关键');
line();
const A2 = await sample('A');
const C2 = await sample('C');
const dA = diff(A, A2);
const dC = diff(C, C2);
console.log(`  A 跑两次：${fmt(dA)}  ${dA.pctDiff === 0 ? '⇒ 逐位一致' : '⇒ **不稳定**'}`);
console.log(`  C 跑两次：${fmt(dC)}  ${dC.pctDiff === 0 ? '⇒ 逐位一致' : '⇒ **不稳定**'}`);

// ── 3. 两个实例并发（分片安全）───────────────────────────────────────────
line('═');
console.log('③ 两个实例并发出图一致吗（决定 GPU 下分片是否安全）');
line();
{
  const [x, y] = await Promise.all([sample('C'), sample('C')]);
  const d = diff(x, y);
  console.log(`  C 两实例并发：${fmt(d)}  ${d.pctDiff === 0 ? '⇒ 逐位一致' : '⇒ **不一致**'}`);
}
{
  const [x, y] = await Promise.all([sample('B'), sample('B')]);
  const d = diff(x, y);
  console.log(`  B 两实例并发：${fmt(d)}  ${d.pctDiff === 0 ? '⇒ 逐位一致' : '⇒ **不一致**'}`);
}

// ── 结论 ────────────────────────────────────────────────────────────────
line('═');
console.log('结论');
line();
const ac = diff(A, C);
if (ac.pctDiff === 0) {
  console.log('  A 与 C 逐位一致 —— 与上一个探针的哈希结论矛盾，需要复查。');
} else if (ac.max <= 2 && ac.pctDiff < 5) {
  console.log(`  放开 GPU 的 2D 差异**很小**（最大 ${ac.max} 级、${ac.pctDiff.toFixed(2)}% 像素、且差≤1级占 ${ac.pctWithin1.toFixed(2)}%）：`);
  console.log('  ⇒ 视觉上不可见。影响落在**验证机制**上（基线要按机器重采），不是画质。');
} else {
  console.log(`  放开 GPU 的 2D 差异**显著**（最大 ${ac.max} 级、${ac.pctDiff.toFixed(2)}% 像素不同）：`);
  console.log('  ⇒ 不只是"哈希变了"，是画质会变 —— C 档不能作为输出档。');
}
console.log('');
console.log(`  运行间确定性：A ${dA.pctDiff === 0 ? '稳定' : '不稳定'}，C ${dC.pctDiff === 0 ? '稳定' : '不稳定'}`);
if (dC.pctDiff !== 0) {
  console.log('  ⇒ **C 档运行间不稳定** —— 这会同时打坏像素回归、增量复用验证与分片一致性。');
  console.log('    （即便 3D 也要注意：B 档下 3D 图层的像素同样来自 GPU）');
} else {
  console.log('  ⇒ C 档在同机同配置下可复现，所以问题只是"基线须按机器重采"，不是"没法验证"。');
}
line('═');
