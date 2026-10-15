// 在**浏览器里**跑的逐帧画面分析。Node 侧只负责按镜头聚合。
//
// 为什么放在页面里：取像素要走 canvas.getImageData，把 PNG 传出来再解码太慢。
// 这里每采一帧就地把内容区降采样成一个小网格，只把标量（diff / ink）交出去。
//
// 判据（沿用一部真实片子校准过的阈值）：
//   diff — 相邻采样帧内容区灰度平均变化；小于阈值就算「这一拍没动」
//   ink  — 内容区里与主色调明显不同的像素占比；接近 0 说明画面几乎是空的
//
// ⚠️ **阈值不在这里**：这个文件只负责「在浏览器里采样、把标量交出去」，判定在
// `src/host/checks/browser/quality.mjs` 的 `THRESHOLDS`（判定放 Node 侧才单测得动）。
// 这里曾另有一个 `STATIC_THR = 0.5`，**没有任何代码读它** —— 真正生效的是 quality.mjs
// 的 `staticThr`。它之所以没被 `dead-exports` 棘轮抓到，是因为上面注释里提了一次
// 它的名字（那个棘轮按「符号名出现次数」判，分不清注释与代码）。已删。
import {view} from '../../contract/viewport.js';

export const INK_THR = 12;       // 与主色调差多少算「画了东西」
const GRID = {cols: 32, rows: 18};

let installed = null;
/**
 * 分片**续采**用的尾部状态：`{key, next, grids}`。
 *
 * 为什么要有它：整条时间轴的采样塞进一次 `Runtime.evaluate` 会撞上 CDP 预算（实测 2100 帧
 * 的片子要 22 秒，30s 预算下时不时报「没响应」）。分片是解法，但**每片重渲一遍预热窗口**
 * 实测把总耗时从 22s 抬到 63s（2.9×）—— 不能接受。
 * 所以这里把上一片末尾的 `winSteps + 1` 个网格留下来，下一片**接着采**：
 * 零重渲，而且逐点结果与「整片一次采完」**由构造保证相同**（就是同一次累加）。
 */
let tail = null;

/** 采样并降采样；返回内容区灰度网格（Float32Array，长度 cols*rows）。 */
function gridOf(ctx, rect) {
  const img = ctx.getImageData(rect.x, rect.y, rect.w, rect.h);
  const d = img.data;
  const out = new Float32Array(GRID.cols * GRID.rows);
  // 每格稀疏取样（每 4 个像素取一个），够稳且快
  for (let gy = 0; gy < GRID.rows; gy++) {
    const y0 = Math.floor((gy * rect.h) / GRID.rows);
    const y1 = Math.floor(((gy + 1) * rect.h) / GRID.rows);
    for (let gx = 0; gx < GRID.cols; gx++) {
      const x0 = Math.floor((gx * rect.w) / GRID.cols);
      const x1 = Math.floor(((gx + 1) * rect.w) / GRID.cols);
      let sum = 0, n = 0;
      for (let y = y0; y < y1; y += 4) {
        let o = (y * rect.w + x0) * 4;
        for (let x = x0; x < x1; x += 4, o += 16) {
          sum += 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
          n++;
        }
      }
      out[gy * GRID.cols + gx] = n ? sum / n : 0;
    }
  }
  return out;
}

function meanDiff(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

/**
 * 逐格最大差。
 *
 * 为什么要它：**平均值会把缓慢的局部移动洗掉**。
 * 实测一部真实片子里一组元素在 3 秒里缓慢位移，内容区平均灰度变化只有 0.04–0.12
 * （远低于 0.5 的阈值，被判「静止」），可像素上 PSNR 只有 22.7 dB —— 画面明显不同。
 * 原因是变化集中在少数格子上，被 32×18 个格子一平均就没了。
 * 逐格最大差看得见它。
 */
function maxDiff(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > m) m = d;
  }
  return m;
}

/** 与主色调（取中位数近似）差得明显的像素占比。 */
function inkOf(grid) {
  const sorted = Array.from(grid).sort((p, q) => p - q);
  const med = sorted[sorted.length >> 1];
  let n = 0;
  for (let i = 0; i < grid.length; i++) if (Math.abs(grid[i] - med) > INK_THR) n++;
  return n / grid.length;
}

/** 内容区：扣掉顶部 HUD 与底部字幕带。 */
export function contentRect() {
  return {x: 60, y: 110, w: view.W - 120, h: view.H - 230};
}

/**
 * 装到 window 上。渲染页 boot 之后调用一次。
 * @param {CanvasRenderingContext2D} ctx 渲染用的 2d context
 * @param {(n:number)=>void} render 渲染第 n 帧
 */
export function installAnalysis(ctx, render) {
  installed = {ctx, render};

  /**
   * 采样 from..to、步长 step。
   *
   * 每个点带四个标量：
   *   diff   与上一个采样点的平均差（相邻）
   *   diffW  与 `windowFrames` 帧前的平均差（滑动窗口）
   *   maxW   与 `windowFrames` 帧前的**逐格最大差**（抓被平均洗掉的局部移动）
   *   ink    与主色调明显不同的像素占比
   *
   * 判定「静止」要靠调用方**累加**这些量：缓慢漂移的画面每个窗口看都很小，
   * 累加才看得出「3 秒里一直在动」。见 host/checks/browser/quality.mjs。
   *
   * ⚠️ `warmFrames`：**切片采样**用的预热。`diff` 要看上一个采样点、`diffW`/`maxW` 要看
   * `windowFrames` 帧前的那个采样点 —— 所以从中间某帧开始采时，块首那几个点会**丢上下文**
   * （`null`），而 `null` 会被判成「这一拍没动」⇒ 把「在动」误判成「静止」。
   * 传 `warmFrames` 就从 `from - warmFrames` 开始**渲染**（只为攒上下文），
   * 但只**返回** `n >= from` 的点。整片一次采完时它是 0，行为与从前逐字相同。
   */
  window.__sampleFrames = (opts) => {
    const {from, to, step = 3, rect, windowFrames = 90, warmFrames = 0, cont = false} = opts;
    const r = rect || contentRect();
    const winSteps = Math.max(1, Math.round(windowFrames / step));
    const keep = winSteps + 1;                       // `back` 要看 n - step*(winSteps+1) 那一格
    const key = `${step}|${winSteps}|${r.x},${r.y},${r.w},${r.h}`;

    let grids = [];
    let start = from;
    if (cont && tail && tail.key === key && tail.next === from) {
      grids = tail.grids.slice();                    // 接着上一片继续：**不重渲**
    } else if (warmFrames > 0) {
      // 兜底（续采不可用时）：从 from 往前多渲 `warmFrames` 帧，只为攒上下文。
      // ⚠️ 预热要够 `windowFrames + step`：`back` 取的是 n - step*(winSteps+1) 那一格，
      // 少一个采样点它就成了 null，而 null 会被判成「这一拍没动」⇒ 把「在动」判成「静止」。
      start = Math.max(1, from - Math.max(0, warmFrames));
    }
    const out = [];
    let lastN = null;
    for (let n = start; n <= to; n += step) {
      render(n);
      const grid = gridOf(ctx, r);
      const prev = grids.length ? grids[grids.length - 1] : null;
      const back = grids.length > winSteps ? grids[grids.length - 1 - winSteps] : null;
      if (n >= from) {                               // 预热段只进 `grids`，不进结果
        out.push({
          n,
          diff: prev ? meanDiff(grid, prev) : null,
          diffW: back ? meanDiff(grid, back) : null,
          maxW: back ? maxDiff(grid, back) : null,
          ink: inkOf(grid),
        });
      }
      grids.push(grid);
      lastN = n;
    }
    if (lastN !== null) tail = {key, next: lastN + step, grids: grids.slice(-keep)};
    return out;
  };
  /** 单帧的内容区统计（诊断用）。 */
  window.__frameStats = (n, rect) => {
    const r = rect || contentRect();
    render(n);
    const grid = gridOf(ctx, r);
    let sum = 0, mn = Infinity, mx = -Infinity;
    for (const v of grid) { sum += v; mn = Math.min(mn, v); mx = Math.max(mx, v); }
    return {n, mean: sum / grid.length, min: mn, max: mx, ink: inkOf(grid)};
  };

  return true;
}

export const isInstalled = () => installed !== null;
