// 片尾：末句结束 +12 起压黑并出署名卡。
// 片尾区不再画镜头，否则最后一个镜头会在署名卡淡出后又冒出内容。
import {theme as C, view, config} from '../../contract/config.js';
import {text, rule} from '../draw/primitives.js';
import {inv, easeOut3} from '../motion/ease.js';
import {timeline, tailFrom} from '../../contract/timeline.js';

export function drawEnding(ctx, n) {
  const cfg = config();
  const from = tailFrom();
  const to = timeline.totalFrames - 20;
  if (n < from) return;
  const op = Math.min(easeOut3(inv(n, from, from + 12)), 1 - inv(n, to - 10, to));
  if (op <= 0.01) return;

  // 必须铺底：最后一个镜头一直画到片尾，不盖住会看到署名卡与镜头内容叠字。
  ctx.save();
  ctx.globalAlpha = Math.min(1, op * 1.6);
  ctx.fillStyle = C.bgDeep;
  ctx.fillRect(0, 0, view.W, view.H);
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = op;
  const cx = view.W / 2;
  const c = cfg.credit;
  if (c) {
    text(ctx, c.kicker, cx, 300, {size: 24, weight: 500, color: C.dim, align: 'center', baseline: 'middle', spacing: 4});
    text(ctx, c.title, cx, 352, {size: 38, weight: 700, color: C.text, align: 'center', baseline: 'middle', maxW: view.W * 0.8});
    text(ctx, c.byline, cx, 404, {size: 24, weight: 500, color: C.dim, align: 'center', baseline: 'middle'});
    rule(ctx, cx, 438, 160, easeOut3(inv(n, from + 10, from + 26)), {color: C.line, lw: 2, align: 'center'});
    if (c.note) {
      text(ctx, c.note, cx, 472, {size: 21, weight: 500, color: C.faint, align: 'center', baseline: 'middle'});
    }
  }
  if (cfg.builtBy) {
    text(ctx, cfg.builtBy, cx, c ? 524 : 384, {
      size: 21, weight: 500, color: C.faint, align: 'center', baseline: 'middle', spacing: 2,
    });
  }
  ctx.restore();
}
