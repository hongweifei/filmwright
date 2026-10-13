// 顶部 HUD 胶囊：按句 id 区间给标签，跨章节卡时淡出。
import {theme as C, fonts as F, view, config, accentFor} from '../../contract/config.js';
import {panel, text} from '../draw/primitives.js';
import {hexA} from '../draw/color.js';
import {inv, easeOut3} from '../motion/ease.js';
import {S, chapterAt} from '../../contract/timeline.js';

function entryAt(n) {
  const entries = config().hud;
  for (let i = 0; i < entries.length; i++) {
    const a = S(entries[i].fromS);
    const b = S(entries[i].toS);
    if (n >= a.from - 8 && n <= b.to + 2) {
      const next = entries[i + 1];
      const fadeOut = next ? inv(n, S(next.fromS).from - 10, S(next.fromS).from - 2) : 0;
      return {...entries[i], a: 1 - fadeOut, chapter: chapterAt(n)};
    }
  }
  return null;
}

export function drawHud(ctx, n) {
  if (config().hud.length === 0) return;
  const e = entryAt(n);
  if (!e) return;
  const a = S(e.fromS);
  const inA = easeOut3(inv(n, a.from - 8, a.from + 6));
  const op = e.a * inA;
  if (op <= 0.01) return;

  const w = 40 + e.label.length * 30;
  const accent = accentFor(e.chapter);
  const cx = view.W / 2;
  ctx.save();
  ctx.globalAlpha = op;
  panel(ctx, cx - w / 2, 26, w, 46, {
    r: 23, fill: hexA(accent, 0.20), stroke: accent, lw: 1.6, glow: accent, glowBlur: 18,
  });
  text(ctx, e.label, cx, 47, {
    size: 25, weight: 700, color: C.text, align: 'center', baseline: 'middle', spacing: 1,
  });
  if (e.tech) {
    text(ctx, e.tech, cx, 86, {
      size: 17, family: F.mono, weight: 400, color: C.faint, align: 'center', baseline: 'middle',
    });
  }
  ctx.restore();
}
