// 遮罩校验：手写镜头的 `mask` 字段与 `withLayer` 的 `mask` 选项共用这一份。
//
// 它**不是**某个入口专属：`runtime/composite/layer.js` 收 `mask`，
// `runtime/stage/drawFrame.js` 把 `shot.mask` 传下去 —— 所以校验留在 contract，
// 由 `runtime/stage/shots.js` 在 `setShots` 时调用（写错当场报，而不是画到那一帧才崩）。
import {err} from './errors.js';

/** 遮罩支持的四形状（有界词汇表 —— 与效果那套同一立场）。 */
export const MASK_SHAPES = ['rect', 'rounded', 'ellipse', 'polygon'];

export const MASK_ERROR_CODES = ['SCENE_MASK_SHAPE', 'SCENE_MASK_RANGE', 'SCENE_MASK_POLYGON'];


/**
 * 校验遮罩规格。
 *
 * 坐标是**设计坐标的归一化值**（0–1，相对设计画布）—— 与分辨率无关，
 * 换竖屏/换尺寸不用改数字（与模板的 `scale()` 体系一致）。
 *
 * 刻意**不做羽化**：设计里那条标着「若做」，而且要靠 `ctx.filter = 'blur()'`，
 * 它的确定性与性能都要单独验。**宁可少一个参数，也不要一个不确定的旋钮。**
 */
export function validateMask(mask, path = 'mask') {
  const out = [];
  const push = (code, p, message, hint) => out.push(err(code, p, message, hint));
  if (!mask || typeof mask !== 'object' || Array.isArray(mask)) {
    push('SCENE_MASK_SHAPE', path, 'mask 必须是对象',
      '形如 {"shape":"ellipse","x":0.2,"y":0.2,"w":0.6,"h":0.6}');
    return out;
  }
  if (!MASK_SHAPES.includes(mask.shape)) {
    push('SCENE_MASK_SHAPE', `${path}.shape`,
      `shape 只能是 ${MASK_SHAPES.join(' / ')}，收到 ${JSON.stringify(mask.shape)}`,
      'rect 铺满默认、rounded 用 r 给圆角、ellipse 椭圆、polygon 用 points');
    return out;
  }
  for (const k of ['x', 'y', 'w', 'h', 'r']) {
    const v = mask[k];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
      push('SCENE_MASK_RANGE', `${path}.${k}`,
        `${k} 必须是 0–1 的数值（归一化设计坐标），收到 ${JSON.stringify(v)}`,
        '归一化：0.5 就是设计画布的一半；不用写像素');
    }
  }
  if (mask.shape === 'polygon') {
    const pts = mask.points;
    if (!Array.isArray(pts) || pts.length < 3) {
      push('SCENE_MASK_POLYGON', `${path}.points`, 'polygon 至少要 3 个点',
        '形如 [[0.5,0.1],[0.9,0.9],[0.1,0.9]]');
    } else {
      for (const [i, p] of pts.entries()) {
        const okP = Array.isArray(p) && p.length === 2
          && p.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1);
        if (!okP) {
          push('SCENE_MASK_POLYGON', `${path}.points[${i}]`,
            `每个点必须是 [x, y] 且都在 0–1，收到 ${JSON.stringify(p)}`,
            '归一化坐标：[[0.5,0.1],[0.9,0.9],[0.1,0.9]]');
        }
      }
    }
  }
  if (mask.invert !== undefined && typeof mask.invert !== 'boolean') {
    push('SCENE_MASK_SHAPE', `${path}.invert`, 'invert 必须是布尔值（反选：形状变成洞）',
      `收到 ${JSON.stringify(mask.invert)}`);
  }
  return out;
}
