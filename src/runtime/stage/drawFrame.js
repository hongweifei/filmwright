// 帧 → 画面。**纯函数：第 N 帧只依赖 N**，不读上一帧、不累积状态。
// 这一条买来三件事：可任意顺序/分片并行渲染、可随时跳帧出静帧、可全量跑一遍查错。
//
// 这里只做「按 z 序把各层拼起来」，每层自己的画法在 runtime/chrome/ 下。
// 早先这些全挤在一个 254 行的文件里，改一处要读全篇。
import {config, accentFor, view} from '../../contract/config.js';
import {isReady, chapterAt, timeline, tailFrom} from '../../contract/timeline.js';
import {shotAt} from './shots.js';
import {drawBackdrop} from '../chrome/backdrop.js';
import {drawHud} from '../chrome/hud.js';
import {drawChapterCard} from '../chrome/chapterCard.js';
import {drawSubtitle} from '../chrome/subtitle.js';
import {drawProgress} from '../chrome/progress.js';
import {drawEnding} from '../chrome/ending.js';

export function drawFrame(ctx, n) {
  if (!isReady()) throw new Error('filmwright: 时间轴未装载');
  const cfg = config();
  const t = n / cfg.fps;
  const accent = accentFor(chapterAt(n));
  const tail = tailFrom();

  ctx.save();
  drawBackdrop(ctx, t, accent);
  ctx.restore();

  // 片尾区不再画镜头：最后一个镜头会一直画到片尾，在署名卡淡出后又冒出内容
  const shot = n < tail ? shotAt(n) : null;
  if (shot) {
    ctx.save();
    shot.draw(ctx, n, t, accent);
    ctx.restore();
  }

  drawChapterCard(ctx, n);
  drawHud(ctx, n);
  drawEnding(ctx, n);
  if (n < tail) drawSubtitle(ctx, n);
  drawProgress(ctx, n);
}

export {view, timeline};
