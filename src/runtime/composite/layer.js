// 图层合成：变换、混合模式、整组透明度、离屏缓冲池。
//
// 两条设计约束（都来自这个项目的核心卖点）：
//
// 1. **组不透明度必须走离屏缓冲**。`ctx.globalAlpha` 是「逐个绘制操作」生效的：
//    一个图层里画两个重叠的不透明矩形、alpha=0.5 时，重叠处会被混合两次
//    （比不重叠处更暗）—— 那不是「整组半透明」，是个视觉 bug。正确做法是先把
//    整组画进缓冲、再把缓冲整体按 alpha 合成。
//
// 2. **只在需要时才走缓冲**。纯位移/旋转/缩放、alpha=1、blend 默认时直接在主画布
//    上变换 —— 少一层缓冲，也保证「没用到新特性时输出逐字节不变」。像素回归基线
//    靠的就是这条：加了图层合成之后，minimal 的 6 帧必须仍然逐字节相同。
//
// 坐标语义（容易搞错，写明）：
//   - `applyLayerTransform`：变换量是**设计坐标**（1280×720 那套），用在
//     **已经被 applyDesignScale 缩放过**的上下文里（模板内部）。
//   - `applyShotTransform`：同样以设计坐标表达，但用在**单位矩阵**的上下文里，
//     作用于一个稍后会自己调 applyDesignScale 的镜头 —— 它做的是共轭变换
//     T_device = D ∘ T_design ∘ D⁻¹，使最终结果恰好是 D ∘ T_design ∘ 内容。
import {view, DESIGN} from '../../contract/viewport.js';

/** 允许的混合模式（Canvas 2D 的 globalCompositeOperation 里与合成相关的子集）。 */
export const BLEND_MODES = [
  'source-over', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
  'color-dodge', 'color-burn', 'hard-light', 'soft-light',
  'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity',
];
const BLENDS = new Set(BLEND_MODES);

/** 变换形状校验（scene 规格与手写镜头共用）。 */
export function isValidTransform(t) {
  if (t === undefined || t === null) return true;   // 可选
  if (typeof t !== 'object' || Array.isArray(t)) return false;
  const num = (v) => v === undefined || (typeof v === 'number' && Number.isFinite(v));
  if (!num(t.x) || !num(t.y) || !num(t.scale) || !num(t.rotate)) return false;
  if (t.scale !== undefined && t.scale <= 0) return false;       // 缩放必须为正
  if (t.alpha !== undefined && !(typeof t.alpha === 'number' && t.alpha >= 0 && t.alpha <= 1)) return false;
  if (t.blend !== undefined && !BLENDS.has(t.blend)) return false;
  if (t.origin !== undefined) {
    if (!Array.isArray(t.origin) || t.origin.length !== 2) return false;
    if (!t.origin.every((v) => typeof v === 'number' && Number.isFinite(v))) return false;
  }
  return true;
}

/** 是否真的需要离屏缓冲（组透明度或非默认混合模式）。 */
export function needsBuffer(t) {
  if (!t) return false;
  // 注意用 != null：`blend: null` 与 `alpha: undefined` 都表示「没设」，
  // 用 !== undefined 会把 null 当成「设了一个非 source-over 的值」，
  // 结果每个图层都走缓冲、快路径永久失效（实测踩过）。
  if (t.alpha != null && t.alpha < 1) return true;
  if (t.blend != null && t.blend !== 'source-over') return true;
  // 有遮罩就必须走缓冲：`clip()` 要裁在**图层自己的**画布上，不能裁到主画布
  if (t.mask) return true;
  return false;
}

/**
 * 在设计坐标系里应用变换（调用方上下文已按设计基准缩放）。
 * 绕 `origin`（默认画布中心）旋转/缩放，再平移 x/y。
 */
export function applyLayerTransform(ctx, t = {}) {
  const {x = 0, y = 0, scale = 1, rotate = 0, origin} = t;
  const ax = origin ? origin[0] : DESIGN.W / 2;
  const ay = origin ? origin[1] : DESIGN.H / 2;
  ctx.translate(ax + x, ay + y);
  if (rotate) ctx.rotate((rotate * Math.PI) / 180);
  if (scale !== 1) ctx.scale(scale, scale);
  ctx.translate(-ax, -ay);
}

/**
 * 在单位矩阵上下文里应用「设计坐标」变换 —— 给镜头用。
 *
 * 镜头自己会调 applyDesignScale（把设计坐标映射到设备像素），所以这里做共轭：
 *   T_device = D ∘ T_design ∘ D⁻¹
 * 于是 `T_device` 之后再叠加镜头的 D，结果就是 D ∘ T_design ∘ 内容 ——
 * 也就是「先在设计空间里摆好这个图层，再按设计基准整体缩放」。
 * D 是等比缩放 s 加居中位移 (ox, oy)，共轭化简后就是下面这几步。
 */
export function applyShotTransform(ctx, t = {}) {
  const {x = 0, y = 0, scale = 1, rotate = 0, origin} = t;
  const s = Math.min(view.W / DESIGN.W, view.H / DESIGN.H);
  const ox = (view.W - DESIGN.W * s) / 2;
  const oy = (view.H - DESIGN.H * s) / 2;
  const ax = origin ? origin[0] : DESIGN.W / 2;
  const ay = origin ? origin[1] : DESIGN.H / 2;
  ctx.translate(ox + (ax + x) * s, oy + (ay + y) * s);
  if (rotate) ctx.rotate((rotate * Math.PI) / 180);
  if (scale !== 1) ctx.scale(scale, scale);
  ctx.translate(-(ox + ax * s), -(oy + ay * s));
}

// ---------- 离屏缓冲池 ----------
// 每帧每层都新建 canvas 会非常慢（长片几千帧 × 多层）。池按尺寸复用，
// 并对池大小设上限，避免长片渲染时内存无限增长。
const pool = new Map();
let live = 0;
const POOL_MAX_PER_SIZE = 4;

function makeBuffer(w, h) {
  // 用 document.createElement 而不是 OffscreenCanvas：与主画布走同一条光栅化
  // 路径，确定性风险最小 —— 这个项目的核心卖点是逐像素可复现。
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function acquire(w, h) {
  const key = w + 'x' + h;
  const list = pool.get(key) ?? [];
  const c = list.pop() ?? makeBuffer(w, h);
  live++;
  const ctx = c.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, w, h);
  return c;
}

function release(c) {
  live--;
  const key = c.width + 'x' + c.height;
  const list = pool.get(key) ?? [];
  if (list.length < POOL_MAX_PER_SIZE) list.push(c);
  pool.set(key, list);
}

/** 把缓冲 ctx 还原成干净状态（单位矩阵、无 alpha/混合残留）。 */
function resetCtx(c) {
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalAlpha = 1;
  c.globalCompositeOperation = 'source-over';
}

/** 诊断用：池里缓存了几种尺寸、当前借出几个。 */
export function bufferStats() {
  return {sizes: pool.size, cached: [...pool.values()].reduce((a, l) => a + l.length, 0), live};
}

/**
 * 把一个遮罩规格建成路径并裁剪当前上下文。
 *
 * 坐标是**设计坐标的归一化值**（0–1，相对设计画布）—— 这样遮罩与分辨率无关，
 * 换竖屏/换尺寸不用改数字（与模板的 `scale()` 体系一致）。
 *
 * `invert`（反选/挖洞）用 **even-odd 填充规则**实现：路径里先放整幅矩形、再放遮罩形状，
 * 偶数奇数规则下中间那块就成了洞 —— 不需要 `destination-out` 那一套，也不用第二张缓冲。
 */
function clipMask(ctx, m) {
  const W = view.W, H = view.H;
  const x = (m.x ?? 0) * W, y = (m.y ?? 0) * H;
  const w = (m.w ?? 1) * W, h = (m.h ?? 1) * H;
  ctx.beginPath();
  if (m.invert) ctx.rect(0, 0, W, H);          // 反选：先铺满，形状成为洞
  if (m.shape === 'rounded') {
    const r = Math.max(0, Math.min(m.r ?? 0.12, 0.5)) * Math.min(w, h);
    ctx.roundRect(x, y, w, h, r);
  } else if (m.shape === 'ellipse') {
    ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  } else if (m.shape === 'polygon') {
    for (const [i, p] of (m.points ?? []).entries()) {
      const X = p[0] * W, Y = p[1] * H;
      if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y);
    }
    ctx.closePath();
  } else {
    ctx.rect(x, y, w, h);                       // 默认 rect
  }
  ctx.clip(m.invert ? 'evenodd' : 'nonzero');
}

/**
 * 画一个图层：可选变换 + 组透明度 + 混合模式 + 遮罩。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{transform?:object, alpha?:number, blend?:string, mode?:'shot'|'design'}} opts
 *   mode='design'（默认）：变换量按设计坐标、用在已缩放的上下文里（模板内部）
 *   mode='shot'：用在单位矩阵上下文里、内容稍后会自己 applyDesignScale（镜头层）
 * @param {(c:CanvasRenderingContext2D)=>void} fn 图层内容
 */
export function withLayer(ctx, opts, fn) {
  const {transform: t = null, alpha = 1, blend = null, mode = 'design', mask = null} = opts ?? {};
  const apply = mode === 'shot' ? applyShotTransform : applyLayerTransform;

  if (!needsBuffer({...t, alpha, blend, mask})) {
    // 快路径：直接在主画布上变换绘制 —— 不引入缓冲，输出与「没有图层合成」时一致
    ctx.save();
    if (t) apply(ctx, t);
    try {
      fn(ctx);
    } finally {
      ctx.restore();
    }
    return;
  }

  // 慢路径：整组先画进缓冲，再整体按 alpha/blend 合成
  const buf = acquire(view.W, view.H);
  const bctx = buf.getContext('2d');
  try {
    // 承接当前上下文的变换：这样无论调用点在哪一层（单位矩阵或已按设计缩放），
    // 缓冲里的内容都与直接绘制时落在同样的设备坐标上。
    bctx.setTransform(ctx.getTransform());
    // ⚠️ **裁剪必须包在 save/restore 里**：`clip()` 是画布状态的一部分，
    // 而缓冲是**池化复用**的 —— 不还原的话裁剪区会残留，后续帧的裁剪与它**相交**，
    // 于是第 N 帧依赖"之前渲过多少帧"，**直接违反核心不变量**（实测：同一帧两次渲染不一致）。
    bctx.save();
    // 遮罩裁在**图层变换之前**（即设计坐标里）—— 语义是「这块内容只在遮罩内可见」，
    // 而不是「遮罩跟着图层一起位移/旋转」。要跟着动就把遮罩写进图层内容的坐标系里。
    if (mask) clipMask(bctx, mask);
    if (t) apply(bctx, t);
    fn(bctx);
    bctx.restore();
  } catch (e) {
    // fn 抛错：缓冲**必须**归还再放行 —— 长片渲染中任何一层抛错漏掉一个缓冲，
    // 几千帧累加就是 OOM（这条有专门的负面对照测试）。
    resetCtx(bctx);
    release(buf);
    throw e;
  }
  resetCtx(bctx);

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);          // 缓冲已是设备像素，直接贴
  if (alpha < 1) ctx.globalAlpha = alpha;
  if (blend) ctx.globalCompositeOperation = blend;
  try {
    ctx.drawImage(buf, 0, 0);
  } finally {
    ctx.restore();
    release(buf);
  }
}
