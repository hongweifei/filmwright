// 帧 → 画面。**纯函数：第 N 帧只依赖 N**，不读上一帧、不累积状态。
// 这一条买来三件事：可任意顺序/分片并行渲染、可随时跳帧出静帧、可全量跑一遍查错。
//
// 这里只做「按 z 序把各层拼起来」，每层自己的画法在 runtime/chrome/ 下。
// 早先这些全挤在一个 254 行的文件里，改一处要读全篇。
import {config, accentFor, view} from '../../contract/config.js';
import {isReady, chapterAt, timeline, tailFrom} from '../../contract/timeline.js';
import {shotAt, shots, normalizeTransition} from './shots.js';
import {withLayer} from '../composite/layer.js';
import {mergeAnimate} from '../scene/animate.js';
import {drawBackdrop} from '../chrome/backdrop.js';
import {drawHud} from '../chrome/hud.js';
import {drawChapterCard} from '../chrome/chapterCard.js';
import {drawSubtitle} from '../chrome/subtitle.js';
import {drawProgress} from '../chrome/progress.js';
import {drawEnding} from '../chrome/ending.js';

/**
 * 转场：当前镜头 `start` 起的 transition.frames 帧内，与**前一个镜头**交叠或推挤。
 *
 * 不变量仍然成立：两个 draw 都只依赖 n，混合系数与位移量也只是 n 的纯函数 ——
 * 所以第 N 帧依然只由 N 决定（分片、跳帧、全量自检都不受影响）。
 *
 * | 类型 | 效果 | 用到的量 |
 * |---|---|---|
 * | `crossfade` | 前镜头淡出 + 当前镜头淡入（同时可见） | alpha |
 * | `fade` | 当前镜头从**背景色**淡入（不画前镜头） | alpha |
 * | `slide` | 当前镜头从一侧推进，把前镜头推出画面 | 位移 |
 * | `wipe` | 一条边扫过，逐步露出当前镜头 | 裁剪矩形 |
 * | `zoom` | 当前镜头从放大/缩小状态归位，前镜头淡出 | 缩放 + alpha |
 *
 * `slide` / `wipe` 的方向由 `direction` 给（`left`/`right`/`up`/`down`，默认 `left`，
 * 指**当前镜头推进的方向**）。
 *
 * 返回 `{cur, prevShot, prevAlpha, motion}`：
 *   cur/prevAlpha 是透明度；motion 描述几何（{dx, dy, scale} 或 {clip}），
 *   由调用方在画镜头时应用 —— 这样「转场的几何」与「镜头的图层变换」是两件事，
 *   互不覆盖（此前 alpha 被覆盖过一次，教训在 drawShotWithAlpha 的注释里）。
 *
 * @returns {{cur:number, prevShot:object|null, prevAlpha:number, motion:object|null}}
 */
export function transitionAt(n, list = shots()) {
  const none = {cur: 1, prevShot: null, prevAlpha: 0, motion: null};
  const cur = list.find((s) => n >= s.from && n <= s.to) ?? null;
  if (!cur) return none;
  const tr = normalizeTransition(cur.transition);
  if (!tr) return none;
  const span = Math.min(tr.frames, cur.to - cur.from + 1);   // 不能超过镜头自身长度
  const local = n - cur.from;                                // 0..span-1
  if (local >= span) return none;
  // 用 (local+1)/span 而不是 local/span：转场占 span 帧，**最后一帧要恰好走完**
  // （local/span 会让末帧停在 (span-1)/span，永远到不了 1 —— 实测 fade 末帧读 0.9）。
  const p = Math.min(1, (local + 1) / span);
  const idx = list.indexOf(cur);
  const prev = idx > 0 ? list[idx - 1] : null;
  const dir = tr.direction ?? 'left';
  const W = view.W;
  const H = view.H;

  if (tr.type === 'fade') {
    // 从背景色淡入：只有当前镜头，alpha 从 0 到 1
    return {cur: p, prevShot: null, prevAlpha: 0, motion: null};
  }

  if (tr.type === 'slide') {
    // 当前镜头从一侧滑入，前镜头同时被推出去（两者都在画，位移相反）。
    // 前镜头用 alpha=1（它是被「推走」，不是淡出），位移由 motion 表达。
    const q = 1 - p;
    let dx = 0, dy = 0;
    if (dir === 'left') dx = W * q;          // 从右边进来 → 向左推进
    else if (dir === 'right') dx = -W * q;
    else if (dir === 'up') dy = H * q;
    else dy = -H * q;
    return {cur: 1, prevShot: prev, prevAlpha: 1,
            motion: {dx, dy, prevDx: -dx, prevDy: -dy, kind: 'slide'}};
  }

  if (tr.type === 'wipe') {
    // 一条边扫过：当前镜头用裁剪矩形逐步露出，前镜头保持不动。
    // 裁剪比「画一半再画一半」稳：不会在两个镜头之间留缝。
    const frac = p;
    let clip;
    if (dir === 'left') clip = {x: W * (1 - frac), y: 0, w: W * frac, h: H};
    else if (dir === 'right') clip = {x: 0, y: 0, w: W * frac, h: H};
    else if (dir === 'up') clip = {x: 0, y: H * (1 - frac), w: W, h: H * frac};
    else clip = {x: 0, y: 0, w: W, h: H * frac};
    return {cur: 1, prevShot: prev, prevAlpha: 1,
            motion: {clip, kind: 'wipe'}};
  }

  if (tr.type === 'zoom') {
    // 当前镜头从放大状态归位（1.12 → 1.0），前镜头淡出。
    // 用「归位」而不是「缩到很小」：放大归位更接近镜头推近的观感，
    // 也避免画面中心出现一圈背景。
    const scale = 1 + 0.12 * (1 - p);
    return {cur: p, prevShot: prev, prevAlpha: 1 - p,
            motion: {scale, kind: 'zoom'}};
  }

  // crossfade（默认）：前镜头从 1 淡到 0，当前镜头从 0 淡到 1
  return {cur: p, prevShot: prev, prevAlpha: 1 - p, motion: null};
}

/**
 * 把转场的几何作用到画布上（纯函数：只依赖传入的 motion 与帧号）。
 *
 * - `slide`：整体平移；`prev` 为真时用反向位移（前镜头被推走）
 * - `zoom`：以画布中心缩放
 * - `wipe`：不在这里处理（用裁剪，见 withClip）
 */
function applyMotion(ctx, motion, {prev = false, n = 0} = {}) {
  if (!motion) return;
  if (motion.kind === 'slide') {
    ctx.translate(prev ? motion.prevDx : motion.dx, prev ? motion.prevDy : motion.dy);
  } else if (motion.kind === 'zoom' && !prev) {
    const cx = view.W / 2, cy = view.H / 2;
    ctx.translate(cx, cy);
    ctx.scale(motion.scale, motion.scale);
    ctx.translate(-cx, -cy);
  }
}

/** 用矩形裁剪画一段内容（wipe 用）。 */
function withClip(ctx, clip, fn) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(clip.x, clip.y, clip.w, clip.h);
  ctx.clip();
  try {
    fn();
  } finally {
    ctx.restore();
  }
}

/** 用给定 alpha 画一个镜头（含各自的 this 绑定、图层变换与混合模式）。 */
function drawShotWithAlpha(ctx, shot, n, t, accent, fadeAlpha) {
  if (!shot || fadeAlpha <= 0.001) return;
  // 有 animate 才求值合并；没有就**沿用 shot.transform 本身**（同一个引用、不分配）
  // —— 这是保住快路径与像素回归的关键：没写 animate 的项目必须逐字节与之前相同。
  const tr = shot.anim ? mergeAnimate(shot.transform, shot.anim, n) : (shot.transform ?? null);
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
    const motion = tr.motion;
    // crossfade / slide / zoom：先画前一个镜头（它已过自己的区间，但 draw 是纯函数，
    // 用 n 直接画即可），再叠加当前镜头。
    // wipe：前镜头保持不动，当前镜头用裁剪逐步露出。
    const drawPrev = () => {
      if (!tr.prevShot) return;
      const run = () => drawShotWithAlpha(ctx, tr.prevShot, n, t, accent, tr.prevAlpha);
      if (motion) { ctx.save(); applyMotion(ctx, motion, {prev: true, n}); try { run(); } finally { ctx.restore(); } }
      else run();
    };
    const drawCur = () => {
      const run = () => drawShotWithAlpha(ctx, shot, n, t, accent, tr.cur);
      if (motion?.kind === 'wipe') withClip(ctx, motion.clip, run);
      else if (motion) { ctx.save(); applyMotion(ctx, motion, {prev: false, n}); try { run(); } finally { ctx.restore(); } }
      else run();
    };
    drawPrev();
    drawCur();
  }

  drawChapterCard(ctx, n);
  drawHud(ctx, n);
  drawEnding(ctx, n);
  if (n < tail) drawSubtitle(ctx, n);
  drawProgress(ctx, n);
}

export {view, timeline};
