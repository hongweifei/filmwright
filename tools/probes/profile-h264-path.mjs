// h264 路径**真实循环**的逐段耗时，并对比不同 `latencyMode`。
//
//   node tools/probes/profile-h264-path.mjs [<仓库根>] [帧数]
//
// ## 为什么要单独量这个
//
// 页面内拆解（profile-current.mjs）说 h264 只要 2.4ms/帧，但端到端实测 13.7ms/帧。
// 把真实循环拆开之后发现：**时间全在页面的编码步骤**（绘制 0.42 / 编码 13.71 / POST 1.43）。
//
// 而隔离探针测到的 2.18ms 是 `flush()/N` —— 那是**吞吐**；真实循环里
// `await enc.encode()` 是**逐帧锁步**，量到的是**延迟**。两个量不能混。
//
// 这里就回答"锁步延迟能不能消掉"：同一个循环跑 quality 与 realtime 两遍。
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
console.log(`h264 真实循环逐段耗时 + latencyMode 对比（${N} 帧，720p）\n`);
line('═');

const rows = [];
for (const mode of ['quality', 'realtime']) {
  // 接收端**把字节丢掉**：量到的是"页面循环 + 传输"，不含 ffmpeg。
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
          width: canvas.width, height: canvas.height, fps: 30, latencyMode: '${mode}',
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
        const info = enc.info();
        enc.close();
        return {draw: avg(tDraw), enc: avg(tEnc), post: avg(tPost),
          p50enc: p50(tEnc), kb: bytes / 1024 / N, codec: info.config.codec,
          ha: info.config.hardwareAcceleration};
      } catch (e) { return {err: String(e && e.stack || e).slice(0, 300)}; }
    })()`);
    if (r?.err) { rows.push({mode, err: r.err}); return; }
    rows.push({mode, ...r});
  });
}

for (const r of rows) {
  if (r.err) { console.log(`  ${r.mode.padEnd(9)} ✗ ${r.err.replace(/\n/g, ' ').slice(0, 120)}`); continue; }
  console.log(`  ${r.mode.padEnd(9)} 绘制 ${r.draw.toFixed(2)}  编码 ${r.enc.toFixed(2)}（p50 ${r.p50enc.toFixed(2)}）  POST ${r.post.toFixed(2)}` +
    `  ⇒ 合计 **${(r.draw + r.enc + r.post).toFixed(2)} ms/帧**  ${r.kb.toFixed(1)} KB/帧  ${r.codec}/${r.ha}`);
}
const ok = rows.filter((r) => !r.err);
if (ok.length === 2) {
  const q = ok.find((r) => r.mode === 'quality'), rt = ok.find((r) => r.mode === 'realtime');
  const d = q.enc - rt.enc;
  console.log(`\n  ⇒ realtime 比 quality 每帧${d > 0 ? `**省 ${d.toFixed(2)} ms**` : `**多花 ${(-d).toFixed(2)} ms**`}`);
  console.log(d > 3 ? '     （锁步延迟确实与 latencyMode 有关，值得默认用 realtime）'
    : '     （差别不大 ⇒ 延迟不来自 latencyMode，得换别的方向查）');
}
line('═');
