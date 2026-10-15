// 画面质量自检：采样要真开浏览器（取像素），判定用 quality.mjs 里的纯函数。
import {withSession} from '../../media/renderRange.mjs';
import {aggregateShots, judgeQuality, summarize, THRESHOLDS} from './quality.mjs';

/**
 * 把 `[1, total]` 切成若干片，**每片最多渲染 `capSamples` 个采样帧**。
 *
 * ⚠️ **为什么必须切片（实测到的 bug）**：原先整条时间轴塞进**一次** `Runtime.evaluate`，
 * 而那次调用吃的是 30s 的默认预算。`sampleStep: 3` ⇒ 2100 帧的片子一次要渲染 + 分析
 * 约 **700 帧**；本机实测单帧 19–78ms（负载波动极大）⇒ 一次调用 **13–55 秒**，
 * 正好卡在 30s 上 ⇒ 时不时报「CDP Runtime.evaluate 超过 30000ms 没响应（浏览器可能卡死或已退出）」，
 * **而浏览器其实好好的**。⇒ 预算该管的是一次**往返**，不是整件工作。
 *
 * 切片点**对齐采样栅格**：片长 = `step × capSamples`，所以每片的起点都 ≡ 1 (mod step)，
 * 拼起来既无空洞也无重复（这条有单测钉着）。
 *
 * `warmFrames` 见 `runtime/qc/analysis.js`：块首要靠它攒上下文，
 * 否则 `diffW` / `maxW` 是 `null`，而 `null` 会被判成「这一拍没动」⇒ 把「在动」误判成「静止」。
 */
export function planSampleChunks(total, {step = 3, windowFrames = 90, capSamples = 48} = {}) {
  const s = Math.max(1, step);
  const span = s * Math.max(1, capSamples);
  // 预热要 `windowFrames + step`（不是 `windowFrames`）：`back` 取的是 `n - step*(winSteps+1)`
  // 那一格 —— 少一个采样点它就成 `null`，而 `null` 会被判成「这一拍没动」。
  // （实测踩过：用 `windowFrames` 时每片第一个点的 `diffW`/`maxW` 都是 null，
  // 逐点比对当场抓到。正常路径走续采、用不到预热，这是续采不可用时的兜底。）
  const warm = Math.max(0, windowFrames) + s;
  const chunks = [];
  for (let from = 1; from <= total; from += span) {
    chunks.push({from, to: Math.min(total, from + span - 1), warmFrames: warm});
  }
  return chunks;
}

/** 单片采样的 CDP 预算。一片只渲染 ~48 帧（1–4 秒）⇒ 60s 意味着「真的卡住了」，不是「有点慢」。 */
const SAMPLE_BUDGET_MS = 60000;

/** 按 `step` 在 `[1, total]` 上应当采到的点数（少一个就会静默改变判定，所以它是**下限**）。 */
export const expectedSamples = (total, step) => Math.floor((total - 1) / Math.max(1, step)) + 1;

/**
 * 采样 + 聚合 + 判定。
 * 采样在页面里做（runtime/qc/analysis.js 装了 window.__sampleFrames），
 * 因为取像素走 canvas.getImageData，把 PNG 传出来再解码太慢。
 */
export async function checkQuality(projectDir, proj, opts = {}, th = THRESHOLDS) {
  const total = proj.timeline.total_frames;
  let stats = [];
  let ranges = [];
  await withSession(projectDir, proj, opts, async (sess) => {
    ranges = sess.info?.ranges ?? [];
    if (ranges.length === 0) {
      throw new Error('filmwright: 渲染页没交出镜头区间（boot 的返回值里缺 ranges）');
    }
    // 分片采样：每片一次往返、各自带预热。整片一次采完会撞上 30s 预算（见上）。
    const chunks = planSampleChunks(total, {
      step: th.sampleStep, windowFrames: th.staticWindowFrames,
    });
    const raw = [];
    for (const [i, c] of chunks.entries()) {
      // `cont: i > 0` —— 让页面**接着上一片继续采**（用上一片留下的尾部网格当上下文）：
      // 零重渲，而且结果与「整片一次采完」由构造保证相同。`warmFrames` 只是续采不可用时的兜底。
      const part = await sess.evaluate(
        `window.__sampleFrames({from: ${c.from}, to: ${c.to}, step: ${th.sampleStep}, `
        + `windowFrames: ${th.staticWindowFrames}, warmFrames: ${c.warmFrames}, cont: ${i > 0}})`,
        SAMPLE_BUDGET_MS, `画面采样（第 ${i + 1}/${chunks.length} 片，${c.from}–${c.to} 帧）`);
      if (!Array.isArray(part) || part.length === 0) {
        throw new Error('filmwright: 画面采样拿不到数据（分析器没装上？见 src/host/pages/render.html 的 installAnalysis）'
          + `（第 ${c.from}–${c.to} 帧那一片）`);
      }
      raw.push(...part);
    }
    const want = expectedSamples(total, th.sampleStep);
    if (raw.length !== want) {
      throw new Error(`filmwright: 画面采样点数不对 —— 期望 ${want} 个（1..${total} 每 ${th.sampleStep} 帧一个），`
        + `实际 ${raw.length} 个（分 ${chunks.length} 片）`);
    }
    stats = aggregateShots(raw, ranges, th);
  });

  const problems = judgeQuality(stats, th);
  return {
    name: 'quality',
    ok: problems.length === 0,
    checked: stats.length,
    problems,
    stats,
    detail: summarize(stats),
    // 只报告、不判失败的读数：**没有声明节拍**的镜头，末拍稳定期是像素推断出来的，
    // 分不清入场/离场，所以只进摘要（声明了节拍的由 judgeQuality 硬判）。
    notes: stats
      .filter((s) => s.holdSource === 'inferred' && s.hold !== null && s.hold < th.holdFrames)
      .map((s) => `镜头 ${s.id} 末拍稳定期 ${s.hold} 帧（<${th.holdFrames}，像素推断，仅报告）`),
  };
}

export {THRESHOLDS, aggregateShots, judgeQuality, summarize};
