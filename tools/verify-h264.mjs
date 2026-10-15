// 验收：页面侧 H.264 编码器（src/runtime/frame/h264.js）。
//
//   node tools/verify-h264.mjs [<仓库根>] [帧数] [--gpu]
//
// ## 判据为什么这样设计
//
// "编码器没报错"远远不够 —— 要证明**产出的是一段有效视频**：
//   · ffprobe 能读出 h264 流，且**帧数与请求一致**（少一帧就是丢帧）
//   · 分辨率与配置一致
//   · **背压生效**：编码队列从未超过上限（否则 VideoFrame 会堆爆内存）
//   · **报出实际用的编码配置**（无头下可能只有软编码，不能让人以为走了硬件）
//
// 编码结果**不要求逐字节可复现**（H.264 跨机器不稳定），
// 但要求**画面**不变 —— 画面那一条由像素回归与 verify-determinism 守。
import {execFileSync} from 'node:child_process';
import {rmSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {withSession} from '../src/host/media/renderRange.mjs';
import {loadProject} from '../src/host/project/load.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const ROOT = (argv[0] && !argv[0].startsWith('--') ? argv[0] : resolve(HERE, '..')).replace(/\\/g, '/');
const N = Number(argv.find((a) => /^\d+$/.test(a)) ?? 45);
const USE_GPU = argv.includes('--gpu');
const PROJECT = join(ROOT, 'examples', 'scenecast');
const OUT = join(ROOT, '.work', 'h264-out.h264');
const FPS = 30;

let bad = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) bad++; };
const line = (c = '─') => console.log(c.repeat(76));

console.log(`H.264 编码器验收（${USE_GPU ? '--gpu' : '默认档'}，${N} 帧）\n`);
line('═');

const proj = await loadProject(PROJECT);
await withSession(PROJECT, proj, {gpu: USE_GPU}, async (sess) => {
  // 在页面里用**产品模块**跑：编码 → 收集 chunk（base64 回传，量很小）
  const r = await sess.evaluate(`(async () => {
    const cv = document.getElementById('c');
    const {createH264Encoder, h264Available} = await import('/kit/runtime/frame/h264.js');
    if (!h264Available()) return {err: '这个环境没有 WebCodecs'};
    const parts = [];
    let desc = null;
    const maxQueueSeen = {v: 0};
    const enc = await createH264Encoder({
      width: cv.width, height: cv.height, fps: ${FPS}, bitrate: 8000000,
      onChunk: (chunk, meta) => {
        // 第一帧的 metadata 带 decoderConfig.description（SPS/PPS）—— 转 Annex-B 要用
        if (meta?.decoderConfig?.description && !desc) {
          const d = new Uint8Array(meta.decoderConfig.description);
          let ds = '';
          for (let i = 0; i < d.length; i++) ds += String.fromCharCode(d[i]);
          desc = btoa(ds);
        }
        const buf = new Uint8Array(chunk.byteLength);
        chunk.copyTo(buf);
        let s = '';
        for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
        parts.push(btoa(s));
      },
    });
    const times = [];
    for (let i = 0; i < ${N}; i++) {
      const n = 1 + i;
      window.__renderFrame(n);
      const t0 = performance.now();
      await enc.encode(cv, n);
      times.push(performance.now() - t0);
      if (enc.queueSize > maxQueueSeen.v) maxQueueSeen.v = enc.queueSize;
    }
    const flush0 = performance.now();
    const stat = await enc.flush();
    const flushMs = performance.now() - flush0;
    enc.close();
    return {ok: true, stat, flushMs, maxQueue: maxQueueSeen.v,
      p50: times.sort((a, b) => a - b)[Math.floor(times.length / 2)],
      parts, desc, w: cv.width, h: cv.height};
  })()`);

  if (r?.err) { ok(false, r.err); return; }
  if (!r?.ok) { ok(false, '页面侧编码失败：' + JSON.stringify(r).slice(0, 300)); return; }

  console.log(`  实际编码配置：${JSON.stringify(r.stat.config)}`);
  console.log(`  编码 ${r.stat.frames} 帧 → ${r.stat.chunks} 个 chunk，共 ${(r.stat.bytes / 1024).toFixed(0)} KB`);
  console.log(`  入队 p50 ${r.p50.toFixed(2)} ms/帧；flush ${r.flushMs.toFixed(0)} ms`);
  // ⚠️ 上限从**实现报出来的值**读，不硬编码 —— 实测踩过：默认从 4 改成 8 之后，
  // 这里写死 `<= 4` 就红了，而实现完全正确。**判据不该复制实现的常量。**
  const limit = r.stat.maxQueue;
  console.log(`  编码队列峰值 ${r.maxQueue}（上限 ${limit}，由实现报出）\n`);

  ok(r.stat.frames === N, `编码帧数与请求一致（${r.stat.frames}/${N}）`);
  ok(r.stat.chunks > 0 && r.stat.bytes > 0, '产出了编码数据');
  ok(r.maxQueue <= limit, `**背压生效**：队列峰值 ${r.maxQueue} ≤ ${limit}（不等队列会堆爆内存）`);
  ok(!!r.stat.config.codec && /^avc1\./.test(r.stat.config.codec),
    `报出了实际用的编码配置（${r.stat.config.codec}）—— 不让人以为走了硬件`);

  // 落盘：**必须转 Annex-B**（WebCodecs 给的是 AVCC 长度前缀；直接拼不是有效裸流）
  const {annexBFromChunk} = await import('../src/runtime/frame/h264.js');
  const descBytes = r.desc ? new Uint8Array(Buffer.from(r.desc, 'base64')) : null;
  const pieces = r.parts.map((p, i) => annexBFromChunk(new Uint8Array(Buffer.from(p, 'base64')),
    i === 0 ? descBytes : null));
  const bytes = Buffer.concat(pieces.map((u) => Buffer.from(u)));
  writeFileSync(OUT, bytes);
  ok(descBytes !== null, '第一帧带回了 decoderConfig.description（SPS/PPS）');
  let probe = null;
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames',
      '-show_entries', 'stream=codec_name,width,height,nb_read_frames', '-of', 'json', OUT],
      {encoding: 'utf8'});
    probe = JSON.parse(out).streams?.[0];
  } catch (e) {
    console.log('  ffprobe 读不了：' + String(e && e.message || e).slice(0, 200));
  }
  console.log(`  ffprobe：${probe ? JSON.stringify(probe) : '（读不了）'}`);
  ok(probe?.codec_name === 'h264', `ffprobe 认出 h264 流（${probe?.codec_name ?? '—'}）`);
  ok(Number(probe?.nb_read_frames) === N,
    `ffprobe 数出的帧数与请求一致（${probe?.nb_read_frames ?? '—'}/${N}）—— 没有丢帧`);
  ok(Number(probe?.width) === r.w && Number(probe?.height) === r.h,
    `分辨率一致（${probe?.width}×${probe?.height}）`);
});

rmSync(OUT, {force: true});
line('═');
console.log(bad === 0 ? '✓ 页面侧 H.264 编码器可用且产出有效视频' : `✗ ${bad} 项失败`);
process.exit(bad ? 1 : 0);
