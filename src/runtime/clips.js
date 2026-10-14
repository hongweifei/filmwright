// 片段素材的**运行时取帧**：同步、纯函数。
//
// ## 不变量怎么保住的
//
// 绘制是同步的，所以这里不能 await、不能碰视频元素。做法是：
// 宿主在 boot 前把片段抽成图片序列（host/media/clips.mjs），这里只维护
// 「名字 → 帧文件 URL 列表 + 已解码的 Image」的映射，取帧就是一次查表：
//
//     源帧号 = clamp(round((n - from) / fps_out × clip.fps) + 1, 1, frames)
//
// 源帧号只由**全局帧 n**、镜头起点 from、帧率与帧数决定 —— 都是纯数据。
// 所以「第 N 帧只是 N 的函数」在整条链上成立：同一 n 永远取同一张图。
//
// ## 预解码
//
// 图片元素在第一次 `drawImage` 时才解码是**异步**的 —— 那会让第一帧空白。
// 所以 boot 时把会用到的帧全部预解码（`img.decode()`），和图片素材同一个道理。
// 帧数可能很多（一段 10 秒 30fps = 300 帧），所以这里按**实际用到的区间**懒加载：
// 镜头声明 range 时只预解码那一段；没声明就整段预解码并在诊断里报数。
import {clamp} from './motion/ease.js';

/** name -> {fps, frames, urls: string[], imgs: (HTMLImageElement|null)[], ranges: [from,to][]} */
const REG = new Map();
let declaredNames = [];

/**
 * 注册片段（boot 时调用，宿主已把帧抽好）。
 * @param {object} clips {name: {dir, frames, fps, src}}
 * @param {string} baseUrl 帧目录的 URL 前缀（浏览器里是 '/clips/<key>/'）
 */
export function setClips(clips, baseUrl = '/__filmwright/clips/') {
  REG.clear();
  declaredNames = Object.keys(clips ?? {});
  for (const [name, c] of Object.entries(clips ?? {})) {
    const urls = [];
    for (let i = 1; i <= c.frames; i++) {
      urls.push(`${baseUrl}${name}/f${String(i).padStart(5, '0')}.png`);
    }
    REG.set(name, {fps: c.fps, frames: c.frames, urls, imgs: new Array(c.frames).fill(null), src: c.src});
  }
  return declaredNames;
}

/** 载入并**解码**某一帧（返回已就绪的 Image）。 */
async function decodeFrame(reg, idx) {
  if (reg.imgs[idx]) return reg.imgs[idx];
  const im = new Image();
  im.src = reg.urls[idx];
  // decode() 会等到真正可绘制；失败就抛，让 boot 报清楚是哪一帧
  if (typeof im.decode === 'function') {
    await im.decode();
  } else {
    await new Promise((res, rej) => {
      im.onload = res;
      im.onerror = () => rej(new Error('取不到 ' + im.src));
    });
  }
  reg.imgs[idx] = im;
  return im;
}

/**
 * 预解码片段用到的帧。
 *
 * @param {Array<{name:string, from:number, to:number, clipFps:number, outFps:number}>} uses
 *   每个「用到片段的地方」：镜头区间 + 片段帧率 + 输出帧率。只解码这段区间覆盖的源帧。
 * @returns {Promise<{decoded:number, perClip:object}>}
 */
export async function preloadClipFrames(uses, outFps = 30) {
  const perClip = {};
  let decoded = 0;
  for (const u of uses) {
    const reg = REG.get(u.name);
    if (!reg) throw new Error(`filmwright: 没有名为「${u.name}」的片段\n` +
      (declaredNames.length ? '  已声明的片段：' + declaredNames.join('、') : '  配置里一个片段都没声明（filmwright clip 或 clips）'));
    // **必须传 u.clipFrom**：它表示「全局帧 u.from 对应片段的第 1 帧」。
    // 漏传会按「全局帧 == 源帧」算，于是区间整体偏移、前若干帧没预解码 ——
    // 实测表现为「镜头前 18 帧取不到图」（而后面正常），很难一眼看出。
    const from = u.clipFrom ?? 1;
    const a = sourceIndex(u.from, reg, outFps, from);
    const b = sourceIndex(u.to, reg, outFps, from);
    const lo = Math.max(0, Math.min(a, b) - 1);            // 前后各多解一帧：取整边界不差图
    const hi = Math.min(reg.frames - 1, Math.max(a, b) + 1);
    for (let i = lo; i <= hi; i++) {
      await decodeFrame(reg, i);
      decoded++;
    }
    perClip[u.name] = {lo: lo + 1, hi: hi + 1, frames: reg.frames};
  }
  return {decoded, perClip};
}

/** 全局帧 → 源帧下标（0 基）。**这是纯函数，也是不需要视频元素的原因。** */
export function sourceIndex(n, reg, outFps, from = 1) {
  const srcFps = reg.fps ?? outFps;
  const t = (n - from) / outFps;                 // 相对镜头起点过了多少秒
  const raw = Math.round(t * srcFps);
  return clamp(raw, 0, reg.frames - 1);
}

/**
 * 取片段在全局帧 n 的那一帧图像（同步）。
 *
 * @param {string} name 片段名（必须声明过）
 * @param {number} n 全局帧号
 * @param {object} [o] {from, fps} —— from 是「这一帧对应片段的哪一帧」，默认 1
 */
export function clipFrame(name, n, o = {}) {
  const reg = REG.get(name);
  if (!reg) {
    throw new Error(`filmwright: 没有名为「${name}」的片段\n` +
      (declaredNames.length ? '  已声明的片段：' + declaredNames.join('、') : '  配置里一个片段都没声明'));
  }
  const idx = sourceIndex(n, reg, o.fps ?? 30, o.from ?? 1);
  const im = reg.imgs[idx];
  if (!im) {
    // 没预解码就说明 boot 的 uses 算漏了 —— 抛错比画空白好（同图片素材的取舍）
    throw new Error(`filmwright: 片段「${name}」的源第 ${idx + 1} 帧没预解码` +
      `（n=${n}，共 ${reg.frames} 帧）—— 检查这个镜头是否在 boot 的片段使用清单里`);
  }
  return im;
}

/** 片段信息（尺寸、帧数）—— 版面计算可能要用。 */
export function clipInfo(name) {
  const reg = REG.get(name);
  if (!reg) throw new Error(`filmwright: 没有名为「${name}」的片段`);
  const any = reg.imgs.find((x) => x);
  return {
    frames: reg.frames,
    fps: reg.fps,
    src: reg.src,
    w: any ? (any.naturalWidth || any.width || 0) : 0,
    h: any ? (any.naturalHeight || any.height || 0) : 0,
  };
}

export const clipNames = () => [...REG.keys()];
export const clipsReady = () => REG.size > 0;

/** 已就绪（可同步取用）的帧数 —— 诊断与自检用。 */
export function decodedCount(name) {
  const reg = REG.get(name);
  if (!reg) return 0;
  return reg.imgs.filter(Boolean).length;
}
