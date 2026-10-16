// 「2D 走 GPU 是不是更快」的配对测量。
//
//   node tools/probes/probe-2d-gpu.mjs [<仓库根>]
//
// ## 为什么不能靠推理
//
// GPU 光栅化在**绘制**上快，但我们的管线**每帧都要把像素读回来**
// （getImageData / toBlob / toDataURL —— 终点是编码成视频帧）。
// GPU 画布读回要走 GPU→CPU 拷贝，历史上正是最贵的一步。
// 所以"2D 走 GPU 更快"在**交互式渲染**里成立（从不读回），
// 在我们这种**逐帧取像素**的管线里**可能反而更慢**。
//
// ## 为什么要配对测量
//
// 本会话已经被机器负载漂移坑过多次（同一配置量到 31ms 与 55ms）。
// 所以这里把 A 档（全软件）与 C 档（2D 走 GPU）**两个会话同时开着**，
// **交替**跑每一轮测量 —— 两边的负载条件被绑在一起，
// 只有同轮的相对关系才可信。
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const ROOT = (argv[0] && !argv[0].startsWith('--') ? argv[0] : resolve(HERE, '..')).replace(/\\/g, '/');
const P = join(ROOT, 'examples', 'minimal');
const ROUNDS = 8;
const FRAMES = 24;

const imp = (rel) => import(pathToFileURL(`${ROOT}/${rel}`).href);
const {openProjectSession} = await imp('src/host/media/renderRange.mjs');
const {loadProject} = await imp('src/host/project/load.mjs');
const proj = await loadProject(P);

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const f2 = (v) => (v === undefined || v === null ? '—' : Number(v).toFixed(2));
const line = (c = '─') => console.log(c.repeat(78));

/** 页面侧：一轮测量，返回四种操作的耗时。 */
async function pageRound(args) {
  const c = document.querySelector('canvas');
  const ctx = c.getContext('2d');
  const frames = args.frames;
  const push = (a, v) => a.push(v);
  const draw = [], read = [], blob = [], full = [];
  for (const n of frames) {
    let t = performance.now(); window.__renderFrame(n); push(draw, performance.now() - t);
    t = performance.now(); ctx.getImageData(0, 0, c.width, c.height); push(read, performance.now() - t);
    t = performance.now();
    window.__renderFrame(n);
    const b = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
    push(blob, performance.now() - t);
    // 端到端：绘制 + 编码 + 上传（即渲染循环真正付的成本）
    t = performance.now();
    window.__renderFrame(n);
    const b2 = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
    await fetch('/__filmwright/frame?n=' + n, {method: 'POST', body: b2});
    push(full, performance.now() - t);
  }
  return {draw, read, blob, full};
}

const fmtArr = (a) => `绘制 ${f2(med(a.draw))} | 读回 ${f2(med(a.read))} | 编码 ${f2(med(a.blob))} | 端到端 ${f2(med(a.full))}`;

console.log(`配对测量：A 档（全软件）vs C 档（2D 走 GPU），同一批帧、交替跑 ${ROUNDS} 轮\n`);

const sink = {write: async () => {}};
const sessA = await openProjectSession(P, proj, {frameSink: sink});
const sessC = await openProjectSession(P, proj, {gpu: true, frameSink: sink});

const rowsA = {draw: [], read: [], blob: [], full: []};
const rowsC = {draw: [], read: [], blob: [], full: []};
const frames = Array.from({length: FRAMES}, (_, i) => 100 + i * 11);

try {
  // 预热：每个会话先跑一轮，排掉首次编译/字体/分配的影响
  await sessA.sess.evaluate(`(${pageRound.toString()})(${JSON.stringify({frames: frames.slice(0, 4)})})`);
  await sessC.sess.evaluate(`(${pageRound.toString()})(${JSON.stringify({frames: frames.slice(0, 4)})})`);

  for (let r = 0; r < ROUNDS; r++) {
    const a = await sessA.sess.evaluate(`(${pageRound.toString()})(${JSON.stringify({frames})})`);
    const c = await sessC.sess.evaluate(`(${pageRound.toString()})(${JSON.stringify({frames})})`);
    for (const k of ['draw', 'read', 'blob', 'full']) {
      rowsA[k].push(med(a[k]));
      rowsC[k].push(med(c[k]));
    }
    console.log(`  第 ${r + 1} 轮  A: ${fmtArr(a)}`);
    console.log(`            C: ${fmtArr(c)}`);
  }
} finally {
  try { await sessA.sess.close(); } catch {}
  try { sessA.server.close(); } catch {}
  try { await sessC.sess.close(); } catch {}
  try { sessC.server.close(); } catch {}
}

line('═');
console.log('汇总（**配对**：每轮各算一次 C/A，再取这些比值的中位数）');
line();
// ⚠️ 不能拿"A 的中位数"与"C 的中位数"相除 —— 实测会出现"全局负载中途变慢"
// （某一轮之后 A 与 C 同时从 ~25ms 跳到 ~64ms），那样相比就是把
// "快档的 A"与"慢档的 C"混在一起，得出完全错误的倍数（第一次跑就中招了）。
// 配对设计的正确做法是**先算每轮的比值，再对这些比值取中位数**。
const paired = {};
for (const k of ['draw', 'read', 'blob', 'full']) {
  paired[k] = rowsA[k].map((a, i) => (a > 0 ? rowsC[k][i] / a : NaN)).filter(Number.isFinite);
}
console.log('  操作                  A 中位      C 中位     **配对 C/A 中位**   区间');
for (const [k, label] of [['draw', '只绘制'], ['read', '读回 getImageData'], ['blob', '绘制+JPEG 编码'], ['full', '端到端（含上传）']]) {
  const a = med(rowsA[k]), c = med(rowsC[k]);
  const p = med(paired[k]);
  const lo = Math.min(...paired[k]), hi = Math.max(...paired[k]);
  const tag = p < 0.95 ? '更快' : p > 1.05 ? '**更慢**' : '相当';
  console.log(`  ${label.padEnd(20)} ${f2(a).padStart(8)}   ${f2(c).padStart(8)}   ${p.toFixed(2)}×  ${tag}    ${lo.toFixed(2)}–${hi.toFixed(2)}`);
}

// 负载漂移检测：某轮的 A 与上一轮相差很大 ⇒ 那一轮不可信
line();
console.log('负载漂移自检（相邻轮 A 档端到端变化超过 50% 的轮次会被标出）');
let drift = [];
for (let i = 1; i < rowsA.full.length; i++) {
  const r = rowsA.full[i] / rowsA.full[i - 1];
  if (r > 1.5 || r < 0.67) drift.push(i + 1);
}
console.log(drift.length ? `  第 ${drift.join('、')} 轮发生负载漂移 —— 这些轮的配对值不可信` : '  未检出明显漂移');

line('═');
const pFull = med(paired.full);
console.log('读法：');
console.log(`  · 端到端（决定渲染吞吐的那个数）配对 C/A = ${pFull.toFixed(2)}×`);
if (pFull < 0.95) console.log('    ⇒ 2D 走 GPU **对渲染吞吐有收益**，可以考虑。');
else if (pFull > 1.05) console.log('    ⇒ 2D 走 GPU **对渲染吞吐是负收益**。');
else console.log('    ⇒ 2D 走 GPU 对渲染吞吐**没有实质差别** ⇒ 收益不成立，别为它付基线代价。');
console.log('  · 注意「只绘制」两档都是 0.4ms —— 因为 Canvas 2D 的绘制命令只是**记录**，');
console.log('    光栅化发生在读回/编码那一步。所以"绘制快"这个说法在这里没有意义。');
line('═');
