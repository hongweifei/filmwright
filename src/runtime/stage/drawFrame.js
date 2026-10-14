// 帧 → 画面。**纯函数：第 N 帧只依赖 N**，不读上一帧、不累积状态。
// 这一条买来三件事：可任意顺序/分片并行渲染、可随时跳帧出静帧、可全量跑一遍查错。
//
// 这里只做「按 z 序把各层拼起来」，每层自己的画法在 runtime/chrome/ 下。
// 早先这些全挤在一个 254 行的文件里，改一处要读全篇。
import {config, accentFor, view} from '../../contract/config.js';
import {isReady, chapterAt, timeline, tailFrom} from '../../contract/timeline.js';
import {shotAt, shots, normalizeTransition} from './shots.js';
import {withLayer} from '../composite/layer.js';
import {drawBackdrop} from '../chrome/backdrop.js';
import {drawHud} from '../chrome/hud.js';
import {drawChapterCard} from '../chrome/chapterCard.js';
import {drawSubtitle} from '../chrome/subtitle.js';
import {drawProgress} from '../chrome/progress.js';
import {drawEnding} from '../chrome/ending.js';

/**
 * 转场混合：当前镜头 `start` 起的 transition.frames 帧内，与**前一个镜头**交叠。
 *
 * 不变量仍然成立：两个 draw 都只依赖 n，混合系数 alpha 也只是 n 的纯函数 ——
 * 所以第 N 帧依然只由 N 决定（分片、跳帧、全量自检都不受影响）。
 *
 * 两种：
 *   crossfade —— 前镜头淡出 + 当前镜头淡入（都在画）
 *   fade      —— 当前镜头从**背景色**淡入（不画前镜头，只用 alpha 渐显）
 *
 * @returns {{cur:number, prevShot:object|null, prevAlpha:number}}
 */
export function transitionAt(n, list = shots()) {
  const cur = list.find((s) => n >= s.from && n <= s.to) ?? null;
  if (!cur) return {cur: 1, prevShot: null, prevAlpha: 0};
  const tr = normalizeTransition(cur.transition);
  if (!tr) return {cur: 1, prevShot: null, prevAlpha: 0};
  const span = Math.min(tr.frames, cur.to - cur.from + 1);   // 不能超过镜头自身长度
  const local = n - cur.from;                                // 0..span-1
  if (local >= span) return {cur: 1, prevShot: null, prevAlpha: 0};
  // 用 (local+1)/span 而不是 local/span：转场占 span 帧，**最后一帧要恰好走完**
  // （local/span 会让末帧停在 (span-1)/span，永远到不了 1 —— 实测 fade 末帧读 0.9）。
  const p = Math.min(1, (local + 1) / span);
  const idx = list.indexOf(cur);
  const prev = idx > 0 ? list[idx - 1] : null;
  if (tr.type === 'fade') {
    // 从背景色淡入：只有当前镜头，alpha 从 0 到 1
    return {cur: p, prevShot: null, prevAlpha: 0};
  }
  // crossfade：前镜头从 1 淡到 0，当前镜头从 0 淡到 1
  return {cur: p, prevShot: prev, prevAlpha: 1 - p};
}

/** 用给定 alpha 画一个镜头（含各自的 this 绑定、图层变换与混合模式）。 */
function drawShotWithAlpha(ctx, shot, n, t, accent, fadeAlpha) {
  if (!shot || fadeAlpha <= 0.001) return;
  const tr = shot.transform ?? null;
  // 图层自身透明度与转场淡入**相乘**：两者是独立的语义
  // （转场是「这一帧该露多少」，transform.alpha 是「这个图层半透明」）。
  // 曾把转场 alpha 直接当图层的 alpha 传，把 transform.alpha 覆盖掉了 ——
  // 表现是「alpha 字段设了没反应」。
  const combined = fadeAlpha * (tr?.alpha ?? 1);
  const hasLayer = !!tr && (tr.x || tr.y || tr.rotate || (tr.scale !== undefined && tr.scale !== 1)
    || tr.alpha !== undefined || tr.blend !== undefined || tr.origin !== undefined);

  // 未声明 transform 且无需淡入 → 与「没有图层合成」时逐字节一致（快路径）。
  // 这是像素回归基线不被打破的关键：老项目一个字段都不用改。
  if (!hasLayer && combined >= 1) {
    ctx.save();
    shot.draw.call(shot, ctx, n, t, accent);
    ctx.restore();
    return;
  }
  withLayer(ctx, {
    transform: tr,
    alpha: combined,
    blend: tr?.blend ?? null,
    mode: 'shot',
  }, (c) => shot.draw.call(shot, c, n, t, accent));
}

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
    const tr = transitionAt(n);
    // crossfade：先画前一个镜头（它已过自己的区间，但 draw 是纯函数，用 n 直接画即可），
    // 再以 alpha 叠加当前镜头。fade：只画当前镜头，用它的 alpha。
    if (tr.prevShot) drawShotWithAlpha(ctx, tr.prevShot, n, t, accent, tr.prevAlpha);
    drawShotWithAlpha(ctx, shot, n, t, accent, tr.cur);
  }

  drawChapterCard(ctx, n);
  drawHud(ctx, n);
  drawEnding(ctx, n);
  if (n < tail) drawSubtitle(ctx, n);
  drawProgress(ctx, n);
}

export {view, timeline};
