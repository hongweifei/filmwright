// 底部进度条：按帧推进，颜色取当前章节主色。
import {view, accentFor} from '../../contract/config.js';
import {clamp} from '../motion/ease.js';
import {chapterAt, timeline} from '../../contract/timeline.js';

export function drawProgress(ctx, n) {
  const p = clamp((n - 1) / Math.max(1, timeline.totalFrames - 1));
  const barH = Math.max(3, Math.round(4 * (view.H / 720)));
  const accent = accentFor(chapterAt(n));
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.07)';
  ctx.fillRect(0, view.H - barH, view.W, barH);
  ctx.fillStyle = accent;
  ctx.shadowColor = accent;
  ctx.shadowBlur = 10;
  ctx.fillRect(0, view.H - barH, view.W * p, barH);
  ctx.restore();
}
