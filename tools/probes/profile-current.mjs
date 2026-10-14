// 当前渲染管线的**逐段耗时**：绘制 / JPEG 编码 / WebCodecs 编码。
//
//   node tools/probes/profile-current.mjs [<仓库根>] [帧数]
//
// ## 为什么要重测
//
// 仓库里已有 `profile-frame.mjs`，但它量的是 **CDP 路径**（`toDataURL` + base64 回传）。
// 现在的默认传输是**二进制 POST 流**，所以那份数据对当前管线**已经不准**。
// 性能结论必须建立在当前代码的实测上 —— 拿旧数字做决策是错的。
//
// ## 量什么、为什么这么量
//
// 每帧的页面内时间拆成三段（都在**页面里**量，避免把传输与 JSON 解析算进去）：
//   1) `window.__renderFrame(n)` —— Canvas 2D 绘制
//   2) `canvas.toBlob('image/jpeg', 0.92)` —— 当前默认的取像素方式
//   3) `VideoEncoder`（H.264）—— 备选：**在页面里直接编成视频**，
//      省掉"JPEG 编码 + ffmpeg 重编码"两道
//
// 关键问题：**瓶颈到底在哪一段**，以及 WebCodecs 是否真的更便宜。
// 只有量出来才谈得上决定改不改。
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {withSession} from '../../src/host/media/renderRange.mjs';
import {loadProject} from '../../src/host/project/load.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const ROOT = (argv[0] && !argv[0].startsWith('--') ? argv[0] : resolve(HERE, '..', '..')).replace(/\\/g, '/');
const N = Number(argv.find((a) => /^\d+$/.test(a)) ?? 60);
const USE_GPU = argv.includes('--gpu');
const PROJECT = join(ROOT, 'examples', 'scenecast');
const line = (c = '─') => console.log(c.repeat(78));

console.log(`当前管线逐段耗时（${USE_GPU ? '--gpu' : '默认档'}，${N} 帧，720p）\n`);
line('═');

const proj = await loadProject(PROJECT);
await withSession(PROJECT, proj, {gpu: USE_GPU}, async (sess) => {
  // 三段都在页面里量：绘制 / JPEG 编码 / WebCodecs 编码
  const r = await sess.evaluate(`(async () => {
    const cv = document.getElementById('c');
    const W = cv.width, H = cv.height;
    const N = ${N};
    const stat = (a) => { const s = [...a].sort((x, y) => x - y);
      return {p50: s[Math.floor(s.length / 2)], mean: a.reduce((x, y) => x + y, 0) / a.length}; };

    // 预热（第一帧有字体/缓存开销）
    window.__renderFrame(1);
    await new Promise((res) => cv.toBlob(res, 'image/jpeg', 0.92));

    const draw = [], jpeg = [];
    for (let i = 0; i < N; i++) {
      const n = 1 + i;
      let a = performance.now();
      window.__renderFrame(n);
      let b = performance.now();
      await new Promise((res) => cv.toBlob(res, 'image/jpeg', 0.92));
      let c = performance.now();
      draw.push(b - a); jpeg.push(c - b);
    }

    // WebCodecs：能不能用、每帧编码多久
    const out = {w: W, h: H, draw: stat(draw), jpeg: stat(jpeg), jpegBytes: null, wc: null, wcErr: null};
    const blob = await new Promise((res) => cv.toBlob(res, 'image/jpeg', 0.92));
    out.jpegBytes = blob.size;
    if (typeof VideoEncoder === 'undefined') { out.wcErr = '没有 VideoEncoder'; return out; }
    try {
      const chunks = [];
      const enc = new VideoEncoder({
        output: (chunk) => chunks.push(chunk.byteLength),
        error: (e) => { out.wcErr = String(e); },
      });
      enc.configure({codec: 'avc1.42001f', width: W, height: H, bitrate: 8000000, framerate: 30});
      const cfg = enc.state;
      const times = [];
      for (let i = 0; i < N; i++) {
        const n = 1 + i;
        window.__renderFrame(n);
        const vf = new VideoFrame(cv, {timestamp: Math.round(i * 1000000 / 30)});
        const a = performance.now();
        enc.encode(vf, {keyFrame: i === 0});
        times.push(performance.now() - a);   // encode() 是**入队**，真正的编码在别处
        vf.close();
      }
      const flush0 = performance.now();
      await enc.flush();
      const flushMs = performance.now() - flush0;
      enc.close();
      out.wc = {state: cfg, enqueue: stat(times), flushMs, chunks: chunks.length,
        totalBytes: chunks.reduce((a, b) => a + b, 0)};
    } catch (e) { out.wcErr = String(e && e.message || e); }
    return out;
  })()`);

  console.log(`帧尺寸 ${r.w}×${r.h}，${N} 帧\n`);
  console.log('① 绘制 renderFrame');
  console.log(`   p50 ${r.draw.p50.toFixed(2)} ms   平均 ${r.draw.mean.toFixed(2)} ms`);
  console.log('② 取像素 canvas.toBlob(JPEG q=0.92)');
  console.log(`   p50 ${r.jpeg.p50.toFixed(2)} ms   平均 ${r.jpeg.mean.toFixed(2)} ms   （约 ${(r.jpegBytes / 1024).toFixed(0)} KB/帧）`);
  console.log(`   ⇒ 占"绘制+编码"的 ${(r.jpeg.mean / (r.draw.mean + r.jpeg.mean) * 100).toFixed(0)}%`);
  console.log('③ WebCodecs VideoEncoder（H.264）');
  if (r.wcErr) console.log('   不可用：' + r.wcErr);
  else {
    console.log(`   入队 p50 ${r.wc.enqueue.p50.toFixed(2)} ms（这是**入队**耗时，不是编码耗时）`);
    console.log(`   flush ${r.wc.flushMs.toFixed(0)} ms 摊到 ${N} 帧 = ${(r.wc.flushMs / N).toFixed(2)} ms/帧`);
    console.log(`   产出 ${r.wc.chunks} 个 chunk，共 ${(r.wc.totalBytes / 1024).toFixed(0)} KB`);
    const perFrame = r.wc.flushMs / N;
    const jpegTotal = r.jpeg.mean;
    console.log(`\n   对比（每帧，不含绘制）：JPEG 取像素 ${jpegTotal.toFixed(2)} ms  vs  WebCodecs ${perFrame.toFixed(2)} ms`);
    console.log(`   ⇒ ${perFrame < jpegTotal ? `WebCodecs 快 ${(jpegTotal / perFrame).toFixed(2)}×` : `WebCodecs **更慢**（${(perFrame / jpegTotal).toFixed(2)}×）`}`);
    console.log('   ⚠️ 还要算上：走 WebCodecs 能**省掉 ffmpeg 的重编码**（chunk 可直接 -c copy 封装），');
    console.log('      而 JPEG 路径必须让 ffmpeg 再编一次 H.264。');
  }
  console.log(`\n   当前端到端下界（绘制+取像素）：${(r.draw.mean + r.jpeg.mean).toFixed(1)} ms/帧`);
  console.log(`   720p30 的 10× realtime 需要 ≤ ${(1000 / 30 / 10).toFixed(2)} ms/帧`);
});
line('═');
