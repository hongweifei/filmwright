// 帧格式的**表达式与白名单** —— 与浏览器会话完全无关：给定 `frameFormat` 名，
// 产出 `canvas.toDataURL(...)` 的参数，或判定这个名字合不合法。
// 单独一个文件是为了让「哪些代码不依赖浏览器」一眼可见（`tests/frame-format.test.mjs` 直接单测它）。


/**
 * 把「帧格式」选项翻译成页面里的 `toDataURL(...)` 参数表达式。
 *
 * ## 为什么渲染路径用 JPEG（实测数据）
 *
 * 逐帧剖析（1280×720，同一批 40 帧的中位数）：
 *
 * | 格式 | 绘制 | **编码** | 载荷 | 单帧总 |
 * |---|---|---|---|---|
 * | PNG | 0.6ms | **50.1ms** | **1243 KB** | 97.8ms |
 * | JPEG q=0.92 | 0.7ms | **29.0ms** | **86.6 KB** | 71.4ms |
 * | WebP q=0.9 | 0.7ms | 157.9ms | 35.7KB | 149.9ms |
 *
 * **绘制只占 0.6ms** —— 瓶颈全在编码与搬运。PNG 是无损压缩，编码慢、
 * 载荷大 14 倍；而渲染成视频这条路的终点是 h264（有损），中间用 JPEG
 * 不引入可见损失（成片 PSNR 48.45 dB，视觉透明）。WebP 更小但编码慢 5 倍，排除。
 *
 * | 用途 | 格式 | 理由 |
 * |---|---|---|
 * | 渲染成视频 | **JPEG q=0.92** | 中间帧是过路数据，终点本来就有损 |
 * | 静帧 / 像素回归 / 联络表 | **PNG** | 要能逐像素复现（无损） |
 *
 * 默认值是 PNG（无损）—— 既有调用方不受影响；渲染路径显式选 JPEG。
 * `frameFormat` 可写 `'png'` / `'jpeg'` / `'jpeg:80'`（质量 0-100）。
 */
export function frameFormatExpr(frameFormat) {
  const f = String(frameFormat ?? 'png').toLowerCase();
  if (f === 'png') return `'image/png'`;
  // h264 **不是** canvas 的 MIME 类型：它由 streamFrames 特判（走 WebCodecs 编码器）。
  // 这里必须**明确报错**而不是返回一个假的 MIME —— 否则调用方会拿它去
  // `canvas.toBlob()`，静默产出错的帧。白名单认它（isValidFrameFormat=true），
  // 但"能解析成 toBlob 参数"是另一回事，两者不同不是漂移。
  if (f === 'h264') {
    throw new Error('filmwright: h264 不是 canvas 的编码格式 —— 它由 streamFrames 特判'
      + '（页面里用 WebCodecs 编 H.264）；要取单帧请用 png / jpeg');
  }
  const m = /^jpe?g(?::(\d{1,3}))?$/.exec(f);
  if (m) {
    // ⚠️ 默认质量 **0.85**（原为 0.92）。实测（同一次会话内配对，720p）：
    //   质量   中位编码耗时   载荷     相对 0.92
    //   0.92   25.80 ms      55.8 KB   —
    //   0.85   19.60 ms      38.9 KB   **−24%**
    //   0.75   18.20 ms      28.0 KB   −29%（**已到地板**，再降不再省时间）
    // 画质代价：q=0.85 vs q=0.92 的 PSNR **46.49 dB**（而 q=0.92 本身离 PNG 路线
    // 只有 47.79 dB）—— 也就是说**降到 0.85 几乎不花画质**；
    // 再降到 0.75 要多花 1.8 dB 却只多省 5% 时间，不划算。
    // 出图看过：文字边缘没有可见振铃（那是最难的一类帧）。
    //
    // ⚠️ **端到端只有 4.3%，不是 24%**。900 帧、交替顺序、两轮：
    //   q=0.92 → 67.37s；q=0.85 → 64.45s。
    // 编码省下的时间**只有一部分落在关键路径上** —— 页面在编码时主机在写 ffmpeg，
    // 流水线是重叠的。**别把微基准的百分比当成端到端收益**（我在这条线上栽过）。
    // 想回高保真：`--frame-format jpeg:92`（甚至 `png`）。
    const q = m[1] === undefined ? 0.85 : Math.max(0.1, Math.min(1, Number(m[1]) / 100));
    return `'image/jpeg', ${q}`;
  }
  throw new Error(`filmwright: 不认识的帧格式「${frameFormat}」；可用 png / jpeg / jpeg:92`);
}

/** 帧格式的白名单校验（CLI 与配置层共用，避免两处规则漂移）。 */
export function isValidFrameFormat(s) {
  const f = String(s ?? '').toLowerCase();
  // 注意要认 jpg 这个别名 —— 只认 jpeg 会让「白名单说不行、解析器说行」
  // 的不一致（测试抓到的真问题）。
  // `h264`：页面里用 WebCodecs 直接编 H.264（见 src/runtime/encode/h264.js）——
  // 省掉"编 JPEG + ffmpeg 再编一遍"两道。**只用于成片**，不能用于静帧/像素回归
  // （那两处要无损可复现）。
  return f === 'png' || f === 'jpeg' || f === 'jpg' || f === 'h264' || /^jpe?g:\d{1,3}$/.test(f);
}
