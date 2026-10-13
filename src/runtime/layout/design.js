// 画布缩放：让镜头按「设计基准 1280×720」写坐标，实际输出可以更大。
//
// 引擎内建件（HUD / 字幕 / 章节卡 / 进度条）自己读 view 并按比例摆，
// 但镜头内容里的 x/y 是设计坐标。所以提供一层换算：
//
//   const {sX, sY, sSize} = scale();
//   text(ctx, '标题', sX(640), sY(150), {size: sSize(36)});
//
// 用法二（推荐）：在镜头入口整体缩放，镜头里直接写设计坐标：
//
//   draw(ctx, n, t, accent) {
//     ctx.save();
//     applyDesignScale(ctx);        // 之后所有坐标都按 1280×720 写
//     ... 正常画 ...
//     ctx.restore();
//   }
import {view, DESIGN} from '../../contract/viewport.js';

export {DESIGN};

/** 当前画布相对设计基准的缩放系数（x/y 分开，便于非等比输出）。 */
export function scaleFactors() {
  return {sx: view.W / DESIGN.W, sy: view.H / DESIGN.H};
}

/** 单个坐标/尺寸的换算。名字不与 index.js 的 S（句查询）冲突。 */
export function sX(x) { return x * (view.W / DESIGN.W); }
export function sY(y) { return y * (view.H / DESIGN.H); }
export function sSize(size) { return size * (view.W / DESIGN.W); }
export const scale = () => ({sX, sY, sSize});

/**
 * 把画布坐标系整体变成设计坐标系：之后镜头里写 1280×720 的坐标即可，
 * 输出是 1080p 也会等比放大。等比缩放取较小的一侧，居中留边。
 */
export function applyDesignScale(ctx) {
  const {sx, sy} = scaleFactors();
  const s = Math.min(sx, sy);
  const ox = (view.W - DESIGN.W * s) / 2;
  const oy = (view.H - DESIGN.H * s) / 2;
  ctx.translate(ox, oy);
  ctx.scale(s, s);
  return s;
}

/** 设计坐标系下镜头可用的内容区（扣除顶部 HUD 与底部字幕带）。 */
export const DESIGN_SAFE = {x: 60, y: 110, w: 1160, h: 510};
