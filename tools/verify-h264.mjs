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
//
// ## 它自己的负面对照（"一个永远绿的检查不是检查"）
//
// 上面的判据跑在**真实产物**上；真产物恰好正确时，`ok(true, ...)` 那种恒真式也会绿。
// 所以本工具每次运行都**自己造缺陷**、要求判据把它们判红。判据只写在 `judgeStream` /
// `judgeBackpressure` 两个纯函数里 —— 真实产物与缺陷**吃同一口锅**，谁被架空了都藏不住：
//   · 丢最后一帧的 chunk —— 帧数判据必须红
//   · 不转 Annex-B（直接拼 AVCC 长度前缀，`h264.js` 里记着的那个真坑）—— 必须红
//   · 第一帧不带 SPS/PPS —— 必须红
//   · 再把「编解码器不是 h264 / 少一帧 / 分辨率不符 / ffprobe 什么都没读出来 /
//     队列上限报成 Infinity」这些缺陷**数据**直接喂给判据 —— 每条比较必须红
// 缺陷产物只落在系统临时目录里、跑完即删，**绝不碰真源码**。
// 任何一条没被判红 ⇒ 判据退化成橡皮图章 ⇒ 本工具 exit 1。
import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
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
/** 判据跑完的样子：把没通过的那些 key 摘出来（负面对照就看这个）。 */
const failedKeys = (items) => items.filter((i) => !i.pass).map((i) => i.key);

/**
 * 用 ffprobe 读一份产物。读不了返回 `{probe: null, note}`、**不抛** —— 读不了本身就该判红。
 * ⚠️ stderr 收进 pipe 而不是继承：负面对照会故意喂坏流，ffprobe 会对它们刷一屏解码告警，
 * 那些告警只是对照的**预期反应**，不该淹掉本工具的判据输出。
 */
function probeStream(file) {
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames',
      '-show_entries', 'stream=codec_name,width,height,nb_read_frames', '-of', 'json', file],
      {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
    return {probe: JSON.parse(out).streams?.[0] ?? null, note: ''};
  } catch (e) {
    const note = String((e && e.stderr) || (e && e.message) || e).replace(/\s+/g, ' ').trim().slice(0, 160);
    return {probe: null, note};
  }
}

/**
 * 产物判据（纯函数：ffprobe 读到的结果 × 期望值）。拆出来是为了让负面对照能把缺陷产物 /
 * 缺陷数据**从同一个口子**喂进来。
 * 期望值全部由**实现报出的事实**算：帧数是命令行的请求、分辨率是画布尺寸。
 */
function judgeStream(probe, exp) {
  const item = (key, pass, msg) => ({key, pass, msg});
  return [
    item('codec', probe?.codec_name === 'h264',
      `ffprobe 认出 h264 流（${probe?.codec_name ?? '—'}）`),
    item('frames', Number(probe?.nb_read_frames) === exp.frames,
      `ffprobe 数出的帧数与请求一致（${probe?.nb_read_frames ?? '—'}/${exp.frames}）—— 没有丢帧`),
    item('resolution', Number(probe?.width) === exp.w && Number(probe?.height) === exp.h,
      `分辨率一致（${probe?.width ?? '—'}×${probe?.height ?? '—'}，期望 ${exp.w}×${exp.h}）`),
  ];
}

/**
 * 背压判据（纯函数：实测峰值 × **实现报出的上限**）。同样是为了让负面对照能喂缺陷数据。
 *
 * ⚠️ 上限是自报的 ⇒ 只比 `峰值 ≤ 上限` 有个洞：报 `Infinity` 的实现恒绿（等于没有背压）。
 * 所以先要求它是**有限正数**。**不写死是 4 还是 8** —— 那是实现的自由，写死过就红过一次。
 */
function judgeBackpressure(peak, limit) {
  return [
    {key: 'limit-finite', pass: Number.isFinite(limit) && limit > 0,
      msg: `实现报出的队列上限是有限正数（${limit}）—— 报 Infinity 就等于没有背压`},
    {key: 'peak-under-limit', pass: peak <= limit,
      msg: `**背压生效**：队列峰值 ${peak} ≤ ${limit}（不等队列会堆爆内存）`},
  ];
}

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

  // 拿不到编码数据 ⇒ 后面的判据与负面对照都无从谈起，如实红一条（不是"跳过即绿"）。
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
  for (const it of judgeBackpressure(r.maxQueue, limit)) ok(it.pass, it.msg);
  ok(!!r.stat.config.codec && /^avc1\./.test(r.stat.config.codec),
    `报出了实际用的编码配置（${r.stat.config.codec}）—— 不让人以为走了硬件`);

  // 落盘：**必须转 Annex-B**（WebCodecs 给的是 AVCC 长度前缀；直接拼不是有效裸流）
  const {annexBFromChunk} = await import('../src/runtime/frame/h264.js');
  const descBytes = r.desc ? new Uint8Array(Buffer.from(r.desc, 'base64')) : null;
  /** chunk 列表 → Annex-B 字节（第一帧再前置 SPS/PPS；负面对照换掉 desc 就是"没 SPS/PPS"那个缺陷）。 */
  const toAnnexB = (parts, desc) => parts.map((p, i) => annexBFromChunk(
    new Uint8Array(Buffer.from(p, 'base64')), i === 0 ? desc : null));
  const pieces = toAnnexB(r.parts, descBytes);
  const bytes = Buffer.concat(pieces.map((u) => Buffer.from(u)));
  writeFileSync(OUT, bytes);
  ok(descBytes !== null, '第一帧带回了 decoderConfig.description（SPS/PPS）');

  const {probe, note} = probeStream(OUT);
  console.log(`  ffprobe：${probe ? JSON.stringify(probe) : `（读不了${note ? '：' + note : ''}）`}`);
  for (const it of judgeStream(probe, {frames: N, w: r.w, h: r.h})) ok(it.pass, it.msg);

  // ── 负面对照：自己造缺陷，要求上面这些判据把它们判红 ────────────────────────
  if (probe === null) {
    line('─');
    console.log('  ⚠️ 负面对照跳过：ffprobe 连真实产物都读不了 —— 上面的判据已经红了，无从再谈区分力');
  } else {
    const negDir = mkdtempSync(join(tmpdir(), 'fw-h264-neg-'));
    try {
      line('─');
      console.log('  负面对照（真造缺陷，要求判据判红；只在系统临时目录里、跑完即删）：');
      const asBuf = (parts, desc) => Buffer.concat(toAnnexB(parts, desc).map((u) => Buffer.from(u)));
      const artifacts = [
        {name: `丢最后一帧的 chunk（${N} → ${N - 1}）`, expect: ['frames'],
          bytes: Buffer.concat(pieces.slice(0, pieces.length - 1).map((u) => Buffer.from(u)))},
        {name: '不转 Annex-B（直接拼 AVCC 长度前缀）', expect: ['frames'],
          bytes: Buffer.concat(r.parts.map((p) => Buffer.from(p, 'base64')))},
        {name: '第一帧不带 SPS/PPS', expect: ['frames'], bytes: asBuf(r.parts, null)},
      ];
      for (const [i, c] of artifacts.entries()) {
        const f = join(negDir, `neg-${i}.h264`);
        writeFileSync(f, c.bytes);
        const failed = failedKeys(judgeStream(probeStream(f).probe, {frames: N, w: r.w, h: r.h}));
        ok(c.expect.every((k) => failed.includes(k)),
          `缺陷「${c.name}」被判红（判红的是 ${failed.join('、') || '—— 一条都没有！'}）`);
      }
      // 判据自检：把缺陷**数据**直接喂给判据 —— 真实产物恰好正确时，恒真式也会绿，
      // 这几条证明每条比较都真的在比。
      const synth = [
        {name: '编解码器不是 h264',
          probe: {codec_name: 'hevc', width: r.w, height: r.h, nb_read_frames: String(N)}, expect: ['codec']},
        {name: '少一帧',
          probe: {codec_name: 'h264', width: r.w, height: r.h, nb_read_frames: String(N - 1)}, expect: ['frames']},
        {name: '分辨率不符',
          probe: {codec_name: 'h264', width: r.w + 2, height: r.h, nb_read_frames: String(N)}, expect: ['resolution']},
        {name: 'ffprobe 什么都没读出来', probe: null, expect: ['codec', 'frames', 'resolution']},
      ];
      for (const c of synth) {
        const failed = failedKeys(judgeStream(c.probe, {frames: N, w: r.w, h: r.h}));
        ok(c.expect.every((k) => failed.includes(k)),
          `判据自检「${c.name}」被判红（判红的是 ${failed.join('、')}）`);
      }
      if (Number.isFinite(limit) && limit > 0) {
        const bp = [
          {name: '队列上限报成 Infinity（自报的上限把背压判据架空）',
            peak: r.maxQueue, limit: Infinity, expect: ['limit-finite']},
          {name: '队列峰值超过实现报出的上限',
            peak: limit + 1, limit, expect: ['peak-under-limit']},
        ];
        for (const c of bp) {
          const failed = failedKeys(judgeBackpressure(c.peak, c.limit));
          ok(c.expect.every((k) => failed.includes(k)),
            `判据自检「${c.name}」被判红（判红的是 ${failed.join('、')}）`);
        }
      } else {
        console.log(`  ⚠️ 背压那两条自检跳过：实现报出的上限不是有限正数（${limit}）—— 上面已红`);
      }
    } finally {
      // ⚠️ try/finally 挡得住正常路径与异常，**挡不住进程被 SIGINT/SIGTERM 杀掉**
      // （残留物在系统 temp 目录里，无害）。真产物那份由下面的 rmSync 收尾。
      rmSync(negDir, {recursive: true, force: true});
    }
  }
});

rmSync(OUT, {force: true});
line('═');
console.log(bad === 0 ? '✓ 页面侧 H.264 编码器可用且产出有效视频' : `✗ ${bad} 项失败`);
process.exit(bad ? 1 : 0);
