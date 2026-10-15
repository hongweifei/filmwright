// 字幕：按时间轴的 subs 显示，底部带一条半透明底，保证任何画面上都可读。
//
// 支持**双语**：`subs[i].text2` 是第二语言（通常是译文），存在时上排小字显示译文、
// 下排大字显示原文 —— 这是中文技术视频的常见排版（母语大字、外语小字，
// 或者反过来：外语大字、母语小字）。哪一排大由 `subtitle.primary` 决定。
import {theme as C, view, config} from '../../contract/config.js';
import {text} from '../draw/primitives.js';
import {inv, easeOut3} from '../motion/ease.js';
import {timeline} from '../../contract/timeline.js';

/** 字幕排版设置（配置里可调；都有默认值，老项目不用改）。 */
function subtitleStyle() {
  let s = {};
  try {
    s = config()?.subtitle ?? {};
  } catch {
    s = {};   // 配置还没装好（极端情况）→ 用默认值，不因为排版设置崩掉整帧
  }
  return {
    // 'first' = 原文大字、译文小字（默认）；'second' = 反过来
    primary: s.primary === 'second' ? 'second' : 'first',
    size: Number(s.size) || 42,
    size2: Number(s.size2) || 26,
    gap: Number.isFinite(s.gap) ? s.gap : 8,
    // 双语时整体上移一点，避免小字贴到画面底边
    lift: Number.isFinite(s.lift) ? s.lift : 14,
  };
}

export function drawSubtitle(ctx, n) {
  const sb = timeline.subs.find((s) => n >= s.from && n <= s.to);
  if (!sb) return;
  const st = subtitleStyle();
  const dual = typeof sb.text2 === 'string' && sb.text2.length > 0;
  const scale = view.W / 1280;

  const inT = easeOut3(inv(n, sb.from, sb.from + 5));
  const outT = inv(n, sb.to - 4, sb.to);
  const op = inT * (1 - outT);

  // 主行与次行分别取谁
  const mainText = st.primary === 'second' && dual ? sb.text2 : sb.text;
  const subText = dual ? (st.primary === 'second' ? sb.text : sb.text2) : null;

  const mainSize = Math.round(st.size * scale);
  const subSize = Math.round(st.size2 * scale);
  const gap = Math.round(st.gap * scale);
  const lift = dual ? Math.round(st.lift * scale) : 0;

  const cx = view.W / 2;
  const baseY = view.H - Math.round(52 * scale) - lift + (1 - inT) * 10;

  ctx.save();
  ctx.globalAlpha = op;

  // 底板宽度按**较宽的那一行**算（双语时不能只按主行算，否则小字会露在底板外）
  const wMain = mainText.length * mainSize * 0.98;
  const wSub = subText ? subText.length * subSize * 0.98 : 0;
  const boxW = 40 + Math.max(wMain, wSub);
  const boxH = mainSize + 22 + (subText ? subSize + gap : 0);
  ctx.fillStyle = 'rgba(3,5,10,0.55)';
  ctx.fillRect(cx - boxW / 2, baseY - mainSize - 4 - (subText ? subSize + gap : 0), boxW, boxH);

  if (subText) {
    // 次行在上、主行在下 —— 阅读顺序自然（先小字后大字会显得跳）
    text(ctx, subText, cx, baseY - mainSize - gap, {
      size: subSize, weight: 500, color: C.dim, align: 'center', baseline: 'alphabetic',
      spacing: 0.5, glow: 'rgba(0,0,0,0.9)', glowBlur: 6,
    });
  }
  text(ctx, mainText, cx, baseY, {
    size: mainSize, weight: 700, color: C.text, align: 'center', baseline: 'alphabetic',
    spacing: 1, glow: 'rgba(0,0,0,0.9)', glowBlur: 8,
  });
  ctx.restore();
}
