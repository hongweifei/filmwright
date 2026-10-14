// h264 路径**真实循环**的逐段耗时：绘制 / 编码 / POST。
//
//   node tools/probes/profile-h264-path.mjs [<仓库根>] [帧数]
//
// ## 为什么要单独量这个
//
// 页面内拆解（profile-current.mjs）说 h264 只要 2.4ms/帧（绘制 0.19 + 编码 2.18），
// 但端到端实测是 13.7ms/帧（扣掉启动后）—— **差 11.3ms 在传输/ffmpeg**；
// 而 JPEG 路径的同一差额只有 3.3ms（页面 16.7 → 端到端 20.0）。
// 所以"慢"不在页面侧，**不能靠猜，要在这里把循环拆开量**。
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {withSession} from '../../src/host/media/renderRange.mjs';
import {loadProject} from '../../src/host/project/load.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const ROOT = (argv[0] && !argv[0].startsWith('--') ? argv[0] : resolve(HERE, '..', '..')).replace(/\\/g, '/');
const N = Number(argv.find((a) => /^\d+$/.test(a)) ?? 120);
const PROJECT = join(ROOT, 'examples', 'scenecast');
const line = (c = '─') => console.log(c.repeat(78));

const proj = await loadProject(PROJECT);
console.log(`h264 路径真实循环的逐段耗时（${N} 帧，720p）\n`);
line('═');

// 直接跑真实循环：绘制 → 编码 → POST。
// 接收端**把字节丢掉**：这样量到的是"页面循环 + 传输"，**不含 ffmpeg** ——
// 正是要把这两部分分开才量得清。
const sink = {write: async () => {}};
await withSession(PROJECT, proj, {frameSink: sink}, async (sess) => {
  const r = await sess.evaluate(`(async () => {
   try {
    const canvas = document.querySelector('canvas');
    const {createH264Encoder, annexBFromChunk} = await import('/kit/runtime/frame/h264.js');
    const N = ${N};
    const p50 = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    let desc = null, descUsed = false;
    const pending = [];
    const enc = await createH264Encoder({
      width: canvas.width, height: canvas.height, fps: 30,
      onChunk: (chunk, meta) => {
        if (meta?.decoderConfig?.description && !desc) desc = new Uint8Array(meta.decoderConfig.description);
        const buf = new Uint8Array(chunk.byteLength);
        chunk.copyTo(buf);
        pending.push(annexBFromChunk(buf, descUsed ? null : desc));
        if (desc) descUsed = true;
      },
    });
    const tDraw = [], tEnc = [], tPost = [];
    let bytes = 0;
    for (let i = 0; i < N; i++) {
      const n = 1 + i;
      let a = performance.now();
      window.__renderFrame(n);
      let b = performance.now();
      await enc.encode(canvas, n);            // 含编码器内部背压等待
      let c = performance.now();
      while (pending.length) {
        const body = pending.shift();
        bytes += body.byteLength;
        const resp = await fetch('/__filmwright/frame?n=' + n, {method: 'POST', body});
        if (!resp.ok) throw new Error('上传被拒');
      }
      tDraw.push(b - a); tEnc.push(c - b); tPost.push(performance.now() - c);
    }
    await enc.flush();
    while (pending.length) { bytes += pending.shift().byteLength; }
    enc.close();
    return {draw: p50(tDraw), enc: p50(tEnc), post: p50(tPost),
      drawAvg: avg(tDraw), encAvg: avg(tEnc), postAvg: avg(tPost), bytes, kb: bytes / 1024};
   } catch (e) { return {err: String(e && e.stack || e).slice(0, 400)}; }
  })()`);

  if (r?.err) { console.log('  页面循环失败：\n    ' + r.err.replace(/\n/g, '\n    ')); return; }

  console.log(`  绘制 p50 ${r.draw.toFixed(2)} ms  平均 ${r.drawAvg.toFixed(2)}`);
  console.log(`  编码 p50 ${r.enc.toFixed(2)} ms  平均 ${r.encAvg.toFixed(2)}   ← 含编码器背压等待`);
  console.log(`  POST p50 ${r.post.toFixed(2)} ms  平均 ${r.postAvg.toFixed(2)}`);
  const sum = r.drawAvg + r.encAvg + r.postAvg;
  console.log(`  ─────────────────────────────────`);
  console.log(`  页面循环合计 ${sum.toFixed(2)} ms/帧（${(r.kb / N).toFixed(1)} KB/帧）`);
  console.log(`\n  对照：端到端实测约 13.7 ms/帧（扣启动后）`);
  console.log(`  ⇒ 循环之外的差额 ${(13.7 - sum).toFixed(1)} ms/帧（ffmpeg 侧 / 会话开销）`);
});
line('═');
