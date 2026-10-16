// 像素出口的**同会话交替**对比：JPEG blob（现状）vs WebCodecs 软/硬。
//
//   node tools/probes/probe-export-paired.mjs [<仓库根>] [A|C]
//
// ## 为什么必须同会话交替
//
// 本会话反复踩到机器负载漂移：同一配置在不同时刻量到 14.7ms 与 65ms（差 4 倍）。
// 所以"tier A 的 JPEG 20ms vs tier C 的 WebCodecs 5.4ms"这种**跨运行**比较毫无意义。
// 这里把三种出口放在**同一个会话、同一轮里轮流跑**，负载同时打到三者，
// 只有同轮内的相对关系可信。
//
// 三种出口都要**含 await POST**（渲染循环实际付的成本就是这个）。
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const ROOT = (argv[0] && !argv[0].startsWith('--') ? argv[0] : resolve(HERE, '..', '..')).replace(/\\/g, '/');
const TIER = (argv[1] || 'A').toUpperCase();
const P = join(ROOT, 'examples', 'minimal');
const ROUNDS = 5;
const PER = 16;

const imp = (rel) => import(pathToFileURL(`${ROOT}/${rel}`).href);
const {openProjectSession} = await imp('src/host/media/renderRange.mjs');
const {loadProject} = await imp('src/host/project/load.mjs');
const proj = await loadProject(P);

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const f2 = (v) => (v === undefined || v === null ? '—' : Number(v).toFixed(2));
const line = (c = '─') => console.log(c.repeat(78));

/** 页面侧：一轮里把三种出口轮流跑一遍，各自返回 ms/帧（含 POST）。 */
async function pagePaired(args) {
  const c = document.querySelector('canvas');
  const ctx = c.getContext('2d');
  const frames = args.frames;
  const out = {jpeg: null, wcSw: null, wcHw: null, wcSwBytes: 0, wcHwBytes: 0, wcChunks: 0};
  const post = async (n, body) => {
    const r = await fetch('/__filmwright/frame?n=' + n, {method: 'POST', body});
    if (!r.ok) throw new Error('POST ' + r.status);
  };

  // ── 出口 1：JPEG blob（现状）
  {
    const t0 = performance.now();
    for (const n of frames) {
      window.__renderFrame(n);
      const b = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
      await post(n, b);
    }
    out.jpeg = (performance.now() - t0) / frames.length;
  }

  // ── 出口 2/3：WebCodecs 软 / 硬
  //
  // 两个关键修正（第一版不公平）：
  //   1. **编码器复用**：第一次调用时建好、存在 window 上，之后各轮复用。
  //      真实渲染是一整片用同一个编码器，不是每 16 帧重开一个。
  //      第一版每次新建，把硬件编码的**初始化成本**反复付了 —— 那正是
  //      "硬件比软件慢"的假象来源（probe-encode 复用编码器时硬件只有 5.55ms）。
  //   2. **含 POST**：把 output 回调收到的块真的传上去，
  //      否则与 JPEG 那条"含 POST"不是同一口径。
  const wc = async (hw) => {
    window.__encCfg = window.__encCfg || {};
    if (!window.__encCfg[hw]) {
      const cfg = {
        codec: 'avc1.42001f', width: c.width, height: c.height,
        bitrate: 8000000, framerate: 30, hardwareAcceleration: hw,
      };
      const sup = await VideoEncoder.isConfigSupported(cfg);
      if (!sup.supported) { window.__encCfg[hw] = {unsupported: true}; return null; }
      const rec = {bytes: 0, chunks: 0, err: null, pending: []};
      rec.enc = new VideoEncoder({
        output: (ch) => { rec.chunks++; rec.bytes += ch.byteLength; rec.pending.push(ch); },
        error: (e) => { rec.err = String(e); },
      });
      rec.enc.configure(cfg);
      window.__encCfg[hw] = rec;
    }
    const rec = window.__encCfg[hw];
    if (rec.unsupported) return null;
    rec.pending.length = 0;
    const t0 = performance.now();
    for (const n of frames) {
      window.__renderFrame(n);
      const f = new VideoFrame(c, {timestamp: n * 33333});
      rec.enc.encode(f, {keyFrame: n % 30 === 0});
      f.close();
      while (rec.enc.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 0));
    }
    await rec.enc.flush();
    // **上传**：与 JPEG 那条同口径
    for (let i = 0; i < rec.pending.length; i++) {
      const ch = rec.pending[i];
      const u8 = new Uint8Array(ch.byteLength);
      ch.copyTo(u8);
      await post(frames[i % frames.length], u8);
    }
    const ms = (performance.now() - t0) / frames.length;
    rec.pending.length = 0;
    return {ms, bytes: rec.bytes / Math.max(1, rec.chunks), chunks: rec.chunks, err: rec.err};
  };

  const sw = await wc('prefer-software');
  if (sw) { out.wcSw = sw.ms; out.wcSwBytes = sw.bytes / Math.max(1, sw.chunks); out.wcChunks = sw.chunks; }
  const hw = await wc('prefer-hardware');
  if (hw) { out.wcHw = hw.ms; out.wcHwBytes = hw.bytes / Math.max(1, hw.chunks); }
  return JSON.stringify(out);
}

const TIERS = {
  A: {label: 'A 全软件（CPU 画布）', opts: {}},
  C: {label: 'C 全硬件（GPU 画布）', opts: {gpu: true}},
};
const tier = TIERS[TIER] || TIERS.A;
console.log(`同会话交替对比：${tier.label}，${ROUNDS} 轮 × 每轮每出口 ${PER} 帧\n`);

const r = await openProjectSession(P, proj, {...tier.opts, frameSink: {write: async () => {}}});
const acc = {jpeg: [], wcSw: [], wcHw: []};
const bytes = {wcSwBytes: 0, wcHwBytes: 0};
try {
  const frames = Array.from({length: PER}, (_, i) => 100 + i * 7);
  // 预热
  await r.sess.evaluate(`(${pagePaired.toString()})(${JSON.stringify({frames: frames.slice(0, 3)})})`);
  for (let i = 0; i < ROUNDS; i++) {
    const o = JSON.parse(await r.sess.evaluate(`(${pagePaired.toString()})(${JSON.stringify({frames})})`));
    if (o.jpeg != null) acc.jpeg.push(o.jpeg);
    if (o.wcSw != null) acc.wcSw.push(o.wcSw);
    if (o.wcHw != null) acc.wcHw.push(o.wcHw);
    if (o.wcSwBytes) bytes.wcSwBytes = o.wcSwBytes;
    if (o.wcHwBytes) bytes.wcHwBytes = o.wcHwBytes;
    console.log(`  第 ${i + 1} 轮  JPEG ${f2(o.jpeg)}  |  WebCodecs软 ${f2(o.wcSw)}  |  WebCodecs硬 ${f2(o.wcHw)}`);
  }
} finally {
  try { await r.sess.close(); } catch {}
  try { r.server.close(); } catch {}
}

line('═');
console.log('汇总（ms/帧，含 await POST）');
line();
const labels = [['jpeg', 'JPEG blob → POST（现状）'], ['wcSw', 'WebCodecs 软件 → POST'], ['wcHw', 'WebCodecs 硬件 → POST']];
const base = acc.jpeg.length ? med(acc.jpeg) : null;
for (const [k, label] of labels) {
  if (!acc[k].length) { console.log(`  ${label.padEnd(28)} 不可用`); continue; }
  const m = med(acc[k]);
  const rel = base ? `  ${(m / base).toFixed(2)}× vs 现状` : '';
  const kb = k === 'wcSw' && bytes.wcSwBytes ? `  ${(bytes.wcSwBytes / 1024).toFixed(0)}KB/块` : '';
  console.log(`  ${label.padEnd(28)} ${f2(m).padStart(7)}${rel}${kb}`);
}
if (acc.wcSw.length && base) {
  const m = med(acc.wcSw);
  line();
  if (m < base * 0.9) console.log(`  ⇒ WebCodecs 软件**比现状快 ${(base / m).toFixed(2)}×** —— 这条值得做。`);
  else if (m > base * 1.1) console.log('  ⇒ WebCodecs 比现状慢 —— 不值得做。');
  else console.log('  ⇒ 两者相当 —— 不值得为它改管线。');
}
line('═');
