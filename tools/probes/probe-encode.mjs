// 复核"硬件编码比软件慢一倍"这个反常结果。
//
//   node tools/probes/probe-encode.mjs [<仓库根>] [A|C]
//
// ## 为什么怀疑上次的结论
//
// probe-render.mjs 量到：硬件 27.4ms vs 软件 14.1ms（硬件慢一倍）。但只测了 **20 帧**。
// 硬件编码器有两个已知的固定/前期成本，20 帧根本摊不开：
//   1. **初始化**：建 DXVA/D3D11 会话、分配 GPU 表面，可能几十到几百毫秒；
//   2. **上传**：硬件编码要求帧在 GPU 显存里。我们的画布是 **CPU 后备**的
//      （B 档还特意 `--disable-accelerated-2d-canvas`），所以每帧都要上传一次。
//
// 所以这次的设计：
//   - **多批次**（每批 30 帧、共 6 批）把"启动"和"稳态"分开看
//   - **软硬交替**（同一轮里先软后硬，逐批轮换）—— 机器负载漂移会同时打到两边
//   - 第二个参数可选档位：`A`（CPU 画布）或 `C`（GPU 画布），
//     用来验证"CPU 画布上传"这个猜想：若 C 档下硬件明显变快，猜想成立
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const ROOT = (argv[0] && !argv[0].startsWith('--') ? argv[0] : resolve(HERE, '..', '..')).replace(/\\/g, '/');
const TIER = (argv[1] || 'A').toUpperCase();
const P = join(ROOT, 'examples', 'minimal');

const imp = (rel) => import(pathToFileURL(`${ROOT}/${rel}`).href);
const {openProjectSession} = await imp('src/host/media/renderRange.mjs');
const {loadProject} = await imp('src/host/project/load.mjs');
const proj = await loadProject(P);

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const f2 = (v) => (v === undefined || v === null ? '—' : Number(v).toFixed(2));
const line = (c = '─') => console.log(c.repeat(78));

const TIERS = {
  A: {label: 'A 全软件（CPU 画布）', opts: {}},
  C: {label: 'C 全硬件（GPU 画布）', opts: {gpu: true}},
};

/** 页面侧：两个编码器同时建好，逐批**交替**编码，把启动与稳态分开。 */
async function pageEncBatches(args) {
  const c = document.querySelector('canvas');
  const mk = async (hw) => {
    const cfg = {
      codec: args.codec, width: c.width, height: c.height,
      bitrate: args.bitrate, framerate: 30, hardwareAcceleration: hw,
    };
    const sup = await VideoEncoder.isConfigSupported(cfg);
    if (!sup.supported) return {hw, supported: false};
    const rec = {hw, supported: true, batches: [], bytes: 0, chunks: 0, err: null, initMs: 0};
    const t0 = performance.now();
    rec._enc = new VideoEncoder({
      output: (ch) => { rec.chunks++; rec.bytes += ch.byteLength; },
      error: (e) => { rec.err = String(e); },
    });
    rec._enc.configure(cfg);
    rec.initMs = performance.now() - t0;
    return rec;
  };
  const sw = await mk('prefer-software');
  const hw = await mk('prefer-hardware');
  const out = {software: sw, hardware: hw};
  if (!sw.supported && !hw.supported) return JSON.stringify({error: '两种都不支持'});

  const live = [sw, hw].filter((x) => x.supported);
  const encodeBatch = async (rec, b) => {
    const t0 = performance.now();
    for (let i = 0; i < args.perBatch; i++) {
      const n = args.frames0 + ((b * args.perBatch + i) % args.span);
      window.__renderFrame(n);
      const f = new VideoFrame(c, {timestamp: (b * args.perBatch + i) * 33333});
      rec._enc.encode(f, {keyFrame: i === 0});
      f.close();
      while (rec._enc.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 0));
    }
    await rec._enc.flush();
    const ms = (performance.now() - t0) / args.perBatch;
    rec.batches.push(ms);
    return ms;
  };

  // 预热一批（不计入）：让两个编码器都走完首次初始化/分配
  for (const rec of live) await encodeBatch(rec, 0);

  for (let b = 0; b < args.batches; b++) {
    for (const rec of live) await encodeBatch(rec, b + 1);
  }
  for (const rec of live) { try { rec._enc.close(); } catch {} delete rec._enc; }
  return JSON.stringify(out);
}

const tier = TIERS[TIER] || TIERS.A;
console.log(`复核硬件编码：档位 ${tier.label}，项目 ${P}\n`);

const r = await openProjectSession(P, proj, {...tier.opts, frameSink: {write: async () => {}}});
let result;
try {
  const raw = await r.sess.evaluate(`(${pageEncBatches.toString()})(${JSON.stringify({
    codec: 'avc1.42001f', bitrate: 8000000, batches: 5, perBatch: 30, frames0: 100, span: 120,
  })})`);
  result = JSON.parse(raw);
} finally {
  try { await r.sess.close(); } catch {}
  try { r.server.close(); } catch {}
}

if (result.error) { console.log('  ' + result.error); process.exit(0); }

line('═');
console.log('每批 30 帧的 ms/帧（第 0 批是预热，不计）');
line();
for (const [k, label] of [['software', '软件 prefer-software'], ['hardware', '硬件 prefer-hardware']]) {
  const x = result[k];
  if (!x || !x.supported) { console.log(`  ${label}：不支持`); continue; }
  console.log(`  ${label}`);
  console.log(`    初始化 configure 耗时 ${f2(x.initMs)} ms`);
  console.log(`    各批：${x.batches.map((v) => f2(v)).join('  ')}`);
  console.log(`    稳态（第 2 批起中位）${f2(med(x.batches.slice(1)))} ms/帧 | ` +
    `含启动（第 1 批）${f2(x.batches[0])} ms/帧 | ${(x.bytes / Math.max(1, x.chunks) / 1024).toFixed(0)}KB/块 ×${x.chunks}` +
    (x.err ? `  ⚠ ${x.err.slice(0, 60)}` : ''));
}

line('═');
const sw = result.software, hw = result.hardware;
if (sw && hw && sw.supported && hw.supported && sw.batches.length > 1 && hw.batches.length > 1) {
  const swS = med(sw.batches.slice(1)), hwS = med(hw.batches.slice(1));
  const swF = sw.batches[0], hwF = hw.batches[0];
  console.log('读法：');
  console.log(`  稳态：软件 ${f2(swS)} vs 硬件 ${f2(hwS)} ⇒ 硬/软 = ${(hwS / swS).toFixed(2)}×`);
  console.log(`  首批：软件 ${f2(swF)} vs 硬件 ${f2(hwF)} ⇒ 硬/软 = ${(hwF / swF).toFixed(2)}×`);
  if (hwF > hwS * 1.4 && hwS <= swS * 1.15) {
    console.log('  ⇒ 上次"硬件更慢"是**启动成本**造成的假象：首批慢、稳态不慢甚至更快。');
    console.log('    结论要改：硬件编码可用于长片（启动摊薄），短片段会吃亏。');
  } else if (hwS > swS * 1.15) {
    console.log('  ⇒ 硬件**稳态下也慢**，不是启动的锅。上次的结论成立。');
    console.log('    可能原因：CPU 画布每帧要上传到显存（这正是要对比 C 档的原因）。');
  } else {
    console.log('  ⇒ 稳态两者接近；差别主要在首批启动。');
  }
}
line('═');
