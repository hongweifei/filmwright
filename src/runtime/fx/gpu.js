// 效果链的**门面**：`applyEffects`（按编译结果跑一遍）与 `paintWithEffects`（绘制 + 合成）。
// 实现按职责拆在 `shaders.js`（着色器）/ `blurPlan.js`（纯数学）/ `stage.js`（GL 舞台）里，
// 这里只做接线 —— 调用方（模板与镜头）只认这一个路径。
// 模块级单例 `STAGE` 与暂存画布也在这里：它们被本文件的函数创建/赋值（见 `applyEffects`）。
import {compileEffects, evalEffects} from './compile.js';
import {GpuStage} from './stage.js';


let STAGE = null;


/** 主画布尺寸（用于建离屏缓冲）。 */
let scratchCanvas = null;

export function getScratch(w, h) {
  if (!scratchCanvas) scratchCanvas = document.createElement('canvas');
  if (scratchCanvas.width !== w || scratchCanvas.height !== h) {
    scratchCanvas.width = w; scratchCanvas.height = h;
  }
  return scratchCanvas;
}


/**
 * 对一个已经画好的画布应用效果链，**返回结果画布**（不自己往主画布上画）。
 *
 * 为什么返回而不是自己画：合成方式与透明度该由调用方决定
 * （转场淡入要乘 alpha；合成要用 source-over 以保留引擎已画的背景）。
 *
 * ⚠️ 调用方必须**在同一个同步任务里**立刻 drawImage 结果 ——
 * WebGL 画布的绘制缓冲在合成后会被清空。
 *
 * @param {HTMLCanvasElement} srcCanvas 已经把镜头画好的画布
 * @param {object} compiled             compileEffects 的结果
 * @param {number} n                    当前帧号（效果参数可以是关键帧轨道）
 * @returns {HTMLCanvasElement|null}    结果画布；全短路时返回 null（调用方走原路）
 */
export function applyEffects(srcCanvas, compiled, n) {
  if (!compiled || !compiled.steps.length) return null;
  if (!STAGE) STAGE = new GpuStage();
  if (!STAGE.ok) {
    // 没有 WebGL 就如实报错，不要静默跳过（静默跳过会让人以为效果生效了）
    throw new Error('filmwright: 这个环境拿不到 WebGL，无法应用 effects');
  }
  return STAGE.apply(srcCanvas, evalEffects(compiled, n), n);
}


/**
 * 「把内容画进离屏画布 → 过效果 → 贴回主画布」的共用流程。
 *
 * 镜头级与层级都走这一个函数，避免两处各写一遍合成逻辑（那会漂移）。
 *
 * @param {CanvasRenderingContext2D} ctx   目标上下文
 * @param {object} fx                      compileEffects 的结果
 * @param {number} alpha                   整体透明度
 * @param {number} n                       当前帧号
 * @param {(ctx: CanvasRenderingContext2D) => void} drawInto 把内容画到给定上下文
 * @returns {boolean} 是否走了效果路径（false ⇒ 调用方应走原路）
 */
export function paintWithEffects(ctx, fx, alpha, n, drawInto) {
  const w = ctx.canvas.width, h = ctx.canvas.height;
  const sc = getScratch(w, h);
  const sctx = sc.getContext('2d');
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.clearRect(0, 0, w, h);
  drawInto(sctx);
  const res = applyEffects(sc, fx, n);
  if (!res) return false;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (alpha < 1) ctx.globalAlpha = alpha;
  // source-over：结果带 alpha（内容没画到的地方透明），正常合成才不抹掉背景
  ctx.drawImage(res, 0, 0);
  ctx.restore();
  return true;
}


