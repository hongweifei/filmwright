// 合成（图层变换 / 混合模式）的**单一来源**。
//
// `runtime/composite/layer.js` 从这里 import 并原样再导出（公共面不变）。
//
// 为什么 `BLEND_MODES` 必须在 contract：取值不合法要**在绘制前就报**。
// 原来只有 runtime 判白名单，于是非法的混合模式一路通过，到了 `withLayer` 直接
// `ctx.globalCompositeOperation = blend`，而 Canvas 对非法值是**静默忽略**的
// ⇒ 按 `source-over` 画：不报错、不崩、测试也不红（实测踩过）。
export const BLEND_MODES = [
  'source-over', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
  'color-dodge', 'color-burn', 'hard-light', 'soft-light',
  'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity',
];

export const BLENDS = new Set(BLEND_MODES);

/** `transform` 的字段说明（报错共用；`blend` 直接列出可用取值，别让用户去猜）。 */
export const TRANSFORM_HINT = '可用字段：x / y（设计坐标位移）、scale（>0）、rotate（度）、alpha（0–1）、'
  + `blend（以下之一：${BLEND_MODES.join(' / ')}）、origin（[x,y] 旋转缩放中心）`;

/**
 * 图层变换是否合法。
 *
 * 与 `runtime/composite/layer.js` 的同名函数**判的是同一套规则**：两份都查白名单，
 * 而规则只有这一份 —— `contract` 不能 import `runtime`（分层规则），
 * 所以是 runtime 反过来 import 这里，方向是对的。
 */
export function isValidTransform(t) {
  if (t === undefined || t === null) return true;
  if (typeof t !== 'object' || Array.isArray(t)) return false;
  const num = (v) => v === undefined || (typeof v === 'number' && Number.isFinite(v));
  if (!num(t.x) || !num(t.y) || !num(t.scale) || !num(t.rotate)) return false;
  if (t.scale !== undefined && t.scale <= 0) return false;
  if (t.alpha !== undefined && !(typeof t.alpha === 'number' && t.alpha >= 0 && t.alpha <= 1)) return false;
  if (t.blend !== undefined && !BLENDS.has(t.blend)) return false;
  if (t.origin !== undefined) {
    if (!Array.isArray(t.origin) || t.origin.length !== 2) return false;
    if (!t.origin.every((v) => typeof v === 'number' && Number.isFinite(v))) return false;
  }
  return true;
}
