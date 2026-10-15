// 章节卡：第 2 章起，落在上一章末句结束 +3 → 本章首句 −9 的空白里。
import {theme as C, fonts as F, view, accentFor} from '../../contract/config.js';
import {text, rule} from '../draw/primitives.js';
import {hexA} from '../draw/color.js';
import {inv, easeOut3, kf} from '../motion/ease.js';

let CARDS = [];

/** 装章节卡（由渲染页 boot 时按时间轴算好交进来）。 */
export function setChapterCards(cards) {
  CARDS = cards;
}

export const chapterCards = () => CARDS;

export function drawChapterCard(ctx, n) {
  const card = CARDS.find((c) => n >= c.from && n <= c.to);
  if (!card) return;
  const N = n - card.from;
  const len = card.to - card.from;
  const inT = easeOut3(inv(N, 0, 22));
  const outT = inv(N, len - 14, len);
  const op = inT * (1 - outT);
  const dy = (1 - inT) * 34 - outT * 40;
  const accent = accentFor(card.n);

  // 必须先盖住底下那一段镜头：章节卡跨在两章之间，相接的镜头在边界前后都还有内容。
  ctx.save();
  const cover = Math.min(1, easeOut3(inv(N, 0, 14)) * 1.35);
  ctx.globalAlpha = cover;
  ctx.fillStyle = C.bgDeep;
  ctx.fillRect(0, 0, view.W, view.H);
  ctx.restore();
  if (op <= 0.02) return;

  ctx.save();
  ctx.globalAlpha = op;
  ctx.translate(0, dy);
  const cx = view.W / 2;
  text(ctx, '0' + card.n, cx, 236, {
    size: 46, family: F.num, weight: 700, color: accent, align: 'center', baseline: 'middle',
    spacing: 6, glow: accent, glowBlur: 24,
  });
  text(ctx, card.title, cx, 330, {
    size: 76, weight: 900, color: C.text, align: 'center', baseline: 'middle',
    spacing: 8, maxW: view.W * 0.78, glow: hexA(accent, 0.8), glowBlur: 30,
  });
  rule(ctx, cx, 388, 420, kf(N, [[0, 0], [26, 1]]), {color: accent, lw: 3, align: 'center'});
  if (card.tech) {
    text(ctx, card.tech, cx, 424, {
      size: 20, family: F.mono, weight: 500, color: C.faint, align: 'center', baseline: 'middle', spacing: 4,
    });
  }
  ctx.restore();
}
