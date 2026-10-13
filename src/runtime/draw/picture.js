// 图片摆放：把素材按 contain / cover 摆进一个框。
//
// 与 `img(name)` 分开：`img` 只取元素（给高级用法），`picture` 负责常用的
// 「按比例摆进这个框」。后者会处理圆角裁剪、描边、发光、透明度这些。
import {theme as C} from '../../contract/config.js';
import {img, imgSize} from '../assets.js';
import {clamp} from '../motion/ease.js';

/**
 * 把素材摆进 (x, y, w, h) 这个框。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} name  素材名（必须在 film.config.mjs 的 assets 里声明过）
 * @param {number} x @param {number} y @param {number} w @param {number} h
 * @param {object} [o]
 * @param {'contain'|'cover'|'stretch'} [o.fit='contain'] 等比装进 / 铺满裁掉 / 拉伸
 * @param {'center'|'left'|'right'} [o.align='center']
 * @param {'middle'|'top'|'bottom'} [o.valign='middle']
 * @param {number} [o.alpha=1]
 * @param {number} [o.r=0]            圆角裁剪半径
 * @param {number} [o.pad=0]          框内留白（等比缩小时一起扣）
 * @param {string|null} [o.border=null] 描边色
 * @param {number} [o.lw=2]           描边宽
 * @param {string|null} [o.glow=null] 发光色（会给图片本身加光晕）
 * @param {number} [o.glowBlur=20]
 */
export function picture(ctx, name, x, y, w, h, o = {}) {
  const {
    fit = 'contain', align = 'center', valign = 'middle',
    alpha = 1, r = 0, pad = 0, border = null, lw = 2,
    glow = null, glowBlur = 20,
  } = o;

  const el = img(name);                      // 名字没声明过 → 这里就抛
  const nat = imgSize(name);
  const pw = w - pad * 2;
  const ph = h - pad * 2;
  if (pw <= 0 || ph <= 0) return {w: 0, h: 0};

  const {dw, dh} = fitBox(nat.w, nat.h, pw, ph, fit);

  // 摆位：先算框内偏移，再按 align/valign 对齐
  let dx = x + pad;
  let dy = y + pad;
  if (align === 'center') dx += (pw - dw) / 2;
  else if (align === 'right') dx += pw - dw;
  if (valign === 'middle') dy += (ph - dh) / 2;
  else if (valign === 'bottom') dy += ph - dh;

  ctx.save();
  ctx.globalAlpha = alpha;

  // cover 或圆角时需要裁剪
  const needClip = fit === 'cover' || r > 0;
  if (needClip) {
    ctx.beginPath();
    roundRectPath(ctx, x, y, w, h, r);
    ctx.clip();
  }
  if (glow) {
    ctx.shadowColor = glow;
    ctx.shadowBlur = glowBlur;
  }
  ctx.drawImage(el, dx, dy, dw, dh);
  ctx.restore();

  if (border) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = border;
    ctx.lineWidth = lw;
    ctx.beginPath();
    roundRectPath(ctx, x, y, w, h, r);
    ctx.stroke();
    ctx.restore();
  }

  return {w: dw, h: dh};
}

/** 按 fit 规则算出在框内的实际尺寸（纯函数，可单测）。 */
export function fitBox(natW, natH, boxW, boxH, fit = 'contain') {
  if (!(natW > 0) || !(natH > 0)) return {dw: boxW, dh: boxH};
  if (fit === 'stretch') return {dw: boxW, dh: boxH};
  const sx = boxW / natW;
  const sy = boxH / natH;
  const s = fit === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy);
  return {dw: natW * s, dh: natH * s};
}

/** 圆角矩形路径（不 fill/stroke，交给调用方）。 */
function roundRectPath(ctx, x, y, w, h, r) {
  const rr = clamp(r, 0, Math.min(w, h) / 2);
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}
