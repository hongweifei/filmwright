// 分片与格式决策：分几个片、用哪种帧格式 / 传输方式 / 预设。**纯函数**，不碰浏览器。
import os from 'node:os';
import {dirname, join, resolve, basename} from 'node:path';
import {isValidFrameFormat} from '../browser/frameFormat.mjs';
import {num, str} from './args.mjs';


/**
 * 分片数解析：数字，或 auto。
 *
 * ## auto 为什么不能只看 CPU 核数
 *
 * 每个分片是**一个独立浏览器实例**，实测各占数百 MB。只看核数的话，
 * 16 核的机器会一次开 15 个实例 —— 内存不够就换页，结果**比分片前更慢**。
 * 实测（16 核 / 剩 5GB 的笔记本）：单片 96s、2 片 181s、4 片 133s。
 * 所以这里同时受三个上限约束，取最小值：
 *   - CPU 核数（留一核给主进程）
 *   - 可用内存（每片预留 PER_SHARD_MB，并给系统留 SYSTEM_MB）
 *   - 帧数（每片至少 ~60 帧，否则启动开销盖过收益）
 *
 * 导出为纯函数（接受 {cores, freeBytes}）以便单测 —— 判据不能只在真机上验。
 */
export const PER_SHARD_MB = 500;    // 一个浏览器实例的经验预留量
export const SYSTEM_MB = 1500;      // 留给系统 + node 主进程的量

export function resolveShards(raw, total, {cores, freeBytes} = {}) {
  const nCores = cores ?? Math.max(1, (os.cpus?.() ?? []).length);
  const free = freeBytes ?? os.freemem?.() ?? 0;
  const byCpu = Math.max(1, nCores - 1);
  const byMem = Math.max(1, Math.floor((free / 1048576 - SYSTEM_MB) / PER_SHARD_MB));
  const byFrames = Math.max(1, Math.ceil(total / 60));
  const cap = Math.max(1, Math.min(byCpu, byMem, byFrames));

  if (raw === undefined || raw === null || raw === '') return 1;   // 默认不分片
  if (raw === 'auto') return cap;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    const e = new Error(`filmwright: --shards 要是正整数或 auto，收到 ${raw}`);
    e.code = 'BAD_SHARDS';
    e.hint = 'auto = 按 CPU 核数与可用内存自动定（每片至少约 60 帧）';
    throw e;
  }
  const want = Math.floor(n);
  // 显式指定的片数**照办**（用户可能知道自己在做什么），但如果明显超出内存，
  // 在 stderr 上提醒一句 —— 静默变慢比报错更难查。
  if (want > byMem) {
    process.stderr.write(`filmwright: 注意：--shards ${want} 超出可用内存能支撑的量` +
      `（约 ${byMem} 片；每片约需 ${PER_SHARD_MB}MB，当前可用 ${(free / 1048576).toFixed(0)}MB）` +
      '—— 可能因换页而更慢。用 --shards auto 或减小片数。\n');
  }
  return want;
}

/**
 * 中间帧格式（渲染成视频时用）。
 *
 * 默认 `jpeg`：实测 PNG 编码 50.1ms / 载荷 1243KB，JPEG q=0.92 编码 29.0ms / 载荷 87KB
 * （1280×720，40 帧中位数），而这条路终点是 h264 有损编码 —— 中间用 JPEG 看不出差别。
 * 想要逐帧无损（例如拿去做像素比对）就传 `--frame-format png`。
 */
export function frameFormatOf(ctx) {
  const raw = ctx.args['frame-format'];
  if (raw === undefined) return 'jpeg';
  const s = String(raw);
  // 用与 session.mjs 同一个白名单判定（避免两处规则漂移）
  if (isValidFrameFormat(s)) return s.toLowerCase();
  const e = new Error(`filmwright: 不认识的帧格式「${s}」；--frame-format 可用 png / jpeg / jpeg:92`);
  e.code = 'BAD_FRAME_FORMAT';
  e.hint = 'jpeg（默认，快）适合出视频；png（无损，慢）适合要逐像素比对的场合';
  throw e;
}

/**
 * 帧传输方式。
 *
 *   stream —— 页面自己循环、二进制 POST 上来（默认；无逐帧 CDP 往返、无 base64）
 *   cdp    —— 逐帧 Runtime.evaluate 取回（旧路径；出静帧必须用这条）
 *
 * 留 cdp 这条路不只是为了兼容：stream 是**页面在跑循环**，一旦页面卡住，
 * 从 node 侧只能等到超时；cdp 每帧一次往返，卡在哪一帧立刻看得出来。
 * 排查渲染卡死时用 cdp。
 */
export function transportOf(ctx) {
  const s = str(ctx.args, 'frame-transport', 'stream');
  if (s !== 'stream' && s !== 'cdp') {
    const e = new Error(`filmwright: --frame-transport 要是 stream / cdp，收到「${s}」`);
    e.code = 'BAD_TRANSPORT';
    e.hint = 'stream（默认，快）让页面自己循环并二进制上传；cdp 逐帧取回，排查卡死时用';
    throw e;
  }
  return s;
}

/** x264 编码预设。默认 medium；慢机器上调快换来的是更短的总时长（文件略大）。 */
export function presetOf(ctx) {
  const s = str(ctx.args, 'preset', 'medium');
  const ok = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'];
  if (!ok.includes(s)) {
    const e = new Error(`filmwright: --preset 不认识「${s}」；可用 ${ok.join(' / ')}`);
    e.code = 'BAD_PRESET';
    e.hint = '编码时间的旋钮：越慢压得越小。渲染瓶颈通常在编码帧，不在这里';
    throw e;
  }
  return s;
}
