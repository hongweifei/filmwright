// 运行时检查：要真开浏览器、真画帧才知道。
import {withSession} from '../../media/renderRange.mjs';

/**
 * 每一帧的绘制都真跑一遍（不截图），抓「只在某一帧才炸」。
 * 比截图快得多：1389 帧约 20 秒。
 */
export async function checkFrames(projectDir, proj, opts = {}, step = 1) {
  const total = proj.timeline.total_frames;
  const problems = [];
  let checked = 0;
  await withSession(projectDir, proj, opts, async (sess) => {
    for (let n = 1; n <= total; n += step) {
      checked++;
      const err = await sess.drawOnly(n);
      if (err) problems.push(err);
    }
  });
  return {name: 'frames', ok: problems.length === 0, checked, problems};
}
