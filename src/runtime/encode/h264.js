// 页面侧的 H.264 编码器（WebCodecs）。
//
// ## 为什么要有它
//
// 实测（`tools/probes/profile-current.mjs`，720p）：
//
//   绘制 renderFrame          0.19 ms/帧
//   canvas.toBlob(JPEG)      16.47 ms/帧   ← 占"绘制+取像素"的 99%
//   VideoEncoder(H.264)       2.18 ms/帧   ← 快 7.54×
//
// 也就是说：现在同一帧**编了两遍**（页面编 JPEG，ffmpeg 再编 H.264）。
// 在页面里直接编 H.264、把 chunk 交给 ffmpeg `-c:v copy` 封装，就把这一遍省掉。
//
// ## 两个必须守住的点（都是实测/规范上的坑）
//
// 1. **`encode()` 是入队，不是编码**。实测入队耗时 0.00ms —— 真正的编码在后台线程。
//    所以**必须做背压**：不等队列排空，`VideoFrame` 会堆在内存里（每帧 3.7MB 的
//    RGBA 量级），几百帧就能把页面撑爆。这里用 `encodeQueueSize` 轮询等待。
// 2. **必须报出实际用的编码器**。无头 Chrome 里可能只有软编码；
//    让人以为走了硬件是最坏的情况。所以 `isConfigSupported` 的结果与
//    `hardwareAcceleration` 都要如实带回来。
//
// ## 纯函数性不受影响
//
// 编码器只吃画布像素 —— 而画面本身仍是"第 N 帧只是 N 的函数"。
// 变的是"怎么编"，不是"画什么"。H.264 的字节跨机器不稳定，但**没有任何文档
// 承诺成片文件逐字节一致**（承诺的是画面，见 docs/architecture.md）。

/** 按分辨率挑一个能用的 codec 串（level 不够会直接 configure 失败）。 */
function codecCandidates(width, height) {
  const px = width * height;
  // avc1.<profile><constraint><level>：profile 42=Baseline 4d=Main 64=High
  // level 1f=3.1(720p) 28=4.0(1080p) 32=5.0(4K)
  const level = px <= 1280 * 720 ? '1f' : px <= 1920 * 1080 ? '28' : '32';
  return [`avc1.42${level}`, `avc1.4d${level}`, `avc1.6400${level}`];
}

/** 本环境有没有 WebCodecs 编码器。 */
export function h264Available() {
  return typeof globalThis.VideoEncoder !== 'undefined'
    && typeof globalThis.VideoFrame !== 'undefined';
}

/**
 * AVCC（长度前缀）→ Annex-B（起始码）。
 *
 * ⚠️ **必须做这一步**：WebCodecs 吐出的 chunk 是 **AVCC 格式**（每个 NAL 前是 4 字节长度），
 * 而 `.h264` 裸流与 ffmpeg 的 `-f h264` 要的是 **Annex-B**（每个 NAL 前是 `00 00 00 01`）。
 * 直接把 chunk 拼起来写文件，ffprobe 会报
 * `log2_max_frame_num_minus4 out of range` / `missing picture in access unit` ——
 * 看起来像"编码坏了"，其实是**封装格式不对**（实测踩到过，见 tools/verify-h264.mjs）。
 *
 * 另外第一帧还要先写 SPS/PPS（在 `description` 里，AVCDecoderConfigurationRecord），
 * 否则解码器不知道分辨率等参数。
 *
 * @param {Uint8Array} bytes        一个 chunk 的数据
 * @param {Uint8Array|null} description  第一帧的 decoderConfig.description（其余帧给 null）
 */
export function annexBFromChunk(bytes, description) {
  const out = [];
  const push = (u8) => { out.push(new Uint8Array([0, 0, 0, 1])); out.push(u8); };
  // 第一帧：先把 SPS/PPS 写进去（description 是 AVCDecoderConfigurationRecord）
  if (description && description.byteLength > 6) {
    const d = description;
    const numSps = d[5] & 0x1f;
    let off = 6;
    for (let i = 0; i < numSps && off + 2 <= d.byteLength; i++) {
      const len = (d[off] << 8) | d[off + 1];
      off += 2;
      if (off + len > d.byteLength) break;
      push(d.subarray(off, off + len));
      off += len;
    }
    if (off < d.byteLength) {
      const numPps = d[off++];
      for (let i = 0; i < numPps && off + 2 <= d.byteLength; i++) {
        const len = (d[off] << 8) | d[off + 1];
        off += 2;
        if (off + len > d.byteLength) break;
        push(d.subarray(off, off + len));
        off += len;
      }
    }
  }
  // 再把这一帧的每个 NAL 拆出来（AVCC：4 字节长度前缀）
  let p = 0;
  while (p + 4 <= bytes.byteLength) {
    const len = (bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3];
    p += 4;
    if (len <= 0 || p + len > bytes.byteLength) break;
    push(bytes.subarray(p, p + len));
    p += len;
  }
  const total = out.reduce((a, b) => a + b.byteLength, 0);
  const merged = new Uint8Array(total);
  let q = 0;
  for (const u of out) { merged.set(u, q); q += u.byteLength; }
  return merged;
}

/**
 * 建一个 H.264 编码器。
 *
 * @param {object} o
 *   · width/height 帧尺寸
 *   · fps          帧率（时间戳按它算）
 *   · bitrate      目标码率（bit/s）
 *   · onChunk      (chunk: EncodedVideoChunk) => void|Promise  每个编码单元回调
 *   · maxQueue     队列上限（**默认 8**）：达到就等它排空 —— **背压**
 *                  ⚠️ 验收要拿**这里报出来的值**去比对，不要硬编码（改过默认值就会失配，实测踩到）
 * @returns {Promise<{encode, flush, close, config, info}>}
 */
export async function createH264Encoder(o) {
  if (!h264Available()) {
    const err = new Error('filmwright: 这个环境没有 WebCodecs（VideoEncoder 不可用）');
    err.code = 'NO_WEBCODECS';
    err.hint = '需要 Chrome/Edge 94+；也可用 --frame-format jpeg 回到 JPEG 取像素那条路';
    throw err;
  }
  const {width, height, fps = 30, bitrate = 8_000_000, onChunk, maxQueue = 8,
    latencyMode = 'quality'} = o;

  // 逐个试，挑第一个被支持的 —— 不同机器支持的 level/profile 不一样
  let config = null;
  const tried = [];
  for (const codec of codecCandidates(width, height)) {
    const base = {codec, width, height, bitrate, framerate: fps, latencyMode};
    for (const ha of ['prefer-hardware', 'no-preference']) {
      let sup;
      try {
        sup = await globalThis.VideoEncoder.isConfigSupported({...base, hardwareAcceleration: ha});
      } catch (e) {
        tried.push(`${codec}/${ha}: ${String(e && e.message || e).slice(0, 60)}`);
        continue;
      }
      if (sup?.supported) { config = sup.config ?? {...base, hardwareAcceleration: ha}; break; }
      tried.push(`${codec}/${ha}: 不支持`);
    }
    if (config) break;
  }
  if (!config) {
    const err = new Error('filmwright: 找不到可用的 H.264 编码配置');
    err.code = 'NO_H264_CONFIG';
    err.hint = `试过：${tried.join('；')}。可回退 --frame-format jpeg`;
    throw err;
  }

  let frames = 0;
  let bytes = 0;
  let chunks = 0;
  let firstError = null;
  const enc = new globalThis.VideoEncoder({
    output: (chunk, metadata) => {
      chunks++;
      bytes += chunk.byteLength;
      // metadata 只在第一帧带 decoderConfig（里面有 SPS/PPS）—— 转 Annex-B 时要用
      try { onChunk?.(chunk, metadata); } catch (e) { firstError ??= e; }
    },
    error: (e) => { firstError ??= e; },
  });
  enc.configure(config);

  /** 等队列降到上限以下（**背压**：不等的话 VideoFrame 会堆爆内存）。 */
  const drain = async () => {
    let guard = 0;
    // ⚠️ 用 `>=` 而不是 `>`：这一帧入队后队列会 +1，用 `>` 会允许冲到上限+1（实测踩到）
    //
    // ⚠️ 上限别设太小：这里的等待是 `setTimeout(0)`，浏览器把它**钳到 ~1–4ms**，
    // 队列经常触顶会白等。所以设 8（8 个 VideoFrame ≈ 30MB）。
    // **但它不是端到端变慢的原因**：实测 maxQueue 4→8 没有可测差别（6.69s vs 6.99s，
    // 属噪声）。端到端只快 1.34× 的原因**尚未查清**，见 LIMITATIONS §6 —— 别把猜测当结论。
    while (enc.encodeQueueSize >= maxQueue) {
      if (firstError) throw firstError;
      await new Promise((r) => setTimeout(r, 0));
      if (++guard > 100000) throw new Error('filmwright: 编码队列一直排不空（编码器可能卡死）');
    }
  };

  return {
    /** 编一帧（同步入队，队列满时会 await）。 */
    async encode(canvas, n) {
      await drain();
      // 时间戳按帧号算 —— 与 fps 一致，且**不读时钟**（纯函数性）
      const ts = Math.round(((n - 1) * 1e6) / fps);
      const frame = new globalThis.VideoFrame(canvas, {timestamp: ts, duration: Math.round(1e6 / fps)});
      try {
        enc.encode(frame, {keyFrame: frames === 0});
      } finally {
        frame.close();          // 必须关：不关会泄漏 GPU/CPU 缓冲
      }
      frames++;
    },
    /** 冲掉剩余帧并关闭。返回统计。 */
    async flush() {
      await enc.flush();
      if (firstError) throw firstError;
      // **把背压上限也报出来** —— 验收拿它比对，而不是硬编码 4/8。
      // （实测踩过：默认从 4 改成 8，验收里写死 `<= 4` 就红，而实现是对的。）
      return {frames, chunks, bytes, config: {...config}, maxQueue};
    },
    close() { try { enc.close(); } catch { /* 已关 */ } },
    get queueSize() { return enc.encodeQueueSize; },
    /** 给日志/自检用：**实际用的编码配置**（别让人以为走了硬件）。 */
    info: () => ({config: {...config}, frames, chunks, bytes, maxQueue}),
  };
}
