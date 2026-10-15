// 画面质量自检：采样要真开浏览器（取像素），判定用 quality.mjs 里的纯函数。
import {withSession} from '../../media/renderRange.mjs';
import {aggregateShots, judgeQuality, summarize, THRESHOLDS} from './quality.mjs';

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
    const raw = await sess.evaluate(
      `window.__sampleFrames({from: 1, to: ${total}, step: ${th.sampleStep}, windowFrames: ${th.staticWindowFrames}})`
    );
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error('filmwright: 画面采样拿不到数据（分析器没装上？见 src/host/pages/render.html 的 installAnalysis）');
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
