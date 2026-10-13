// 字幕：按时间轴的 subs 显示，底部带一条半透明底，保证任何画面上都可读。
import {theme as C, view} from '../../contract/config.js';
import {text} from '../draw/primitives.js';
import {inv, easeOut3} from '../motion/ease.js';
import {timeline} from '../../contract/timeline.js';

export function drawSubtitle(ctx, n) {
  const sb = timeline.subs.find((s) => n >= s.from && n <= s.to);
  if (!sb) return;
  const inT = easeOut3(inv(n, sb.from, sb.from + 5));
  const outT = inv(n, sb.to - 4, sb.to);
  const op = inT * (1 - outT);
  const size = Math.round(42 * (view.W / 1280));
  const y = view.H - 52 + (1 - inT) * 10;
  const cx = view.W / 2;
  ctx.save();
  ctx.globalAlpha = op;
  const w = 40 + sb.text.length * size * 0.98;
  ctx.fillStyle = 'rgba(3,5,10,0.55)';
  ctx.fillRect(cx - w / 2, y - size - 4, w, size + 22);
  text(ctx, sb.text, cx, y, {
    size, weight: 700, color: C.text, align: 'center', baseline: 'alphabetic',
    spacing: 1, glow: 'rgba(0,0,0,0.9)', glowBlur: 8,
  });
  ctx.restore();
}
