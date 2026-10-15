// 自检总入口：跑哪些检查、怎么汇总。
//
// 分三层看结果：静态（读文件）/ 逐帧（真画）/ 画面质量（真画并看像素）。
// 汇总行跟着实际道数走 —— 写死数字会在加了检查之后自己骗自己。
import {checkPublicApi, checkImports, checkTimeline, checkThemeKeys, checkAssets, checkScene, checkClips} from './static/index.mjs';
import {checkFrames} from './browser/frames.mjs';
import {checkQuality} from './browser/qualityCheck.mjs';

/**
 * @param {string} projectDir
 * @param {object} proj loadProject 的结果
 * @param {object} opts 渲染选项（browser 等）
 * @param {{step?:number, quiet?:boolean, apiFile?:string, runtimeDir?:string,
 *          quality?:boolean, qualityThresholds?:object, staticOnly?:boolean}} [cfg]
 */
export async function runChecks(projectDir, proj, opts = {}, cfg = {}) {
  const {
    step = 1, quiet = false, apiFile, runtimeDir,
    quality = false, qualityThresholds, staticOnly = false,
  } = cfg;
  const results = [];

  if (apiFile) results.push(checkPublicApi(apiFile));
  results.push(checkImports(projectDir + '/shots', projectDir));
  results.push(checkTimeline(projectDir, proj));
  results.push(checkScene(projectDir, proj));
  results.push(checkAssets(projectDir, proj.raw, proj.scene));
  results.push(checkClips(projectDir, proj.raw, proj.scene));
  if (runtimeDir) {
    results.push(checkImports(runtimeDir, 'runtime'));
    results.push(checkThemeKeys(runtimeDir));
  }

  // staticOnly：到此为止，不启浏览器（CI 与快速验证用）
  if (!staticOnly) {
    results.push(await checkFrames(projectDir, proj, opts, step));
    if (quality) results.push(await checkQuality(projectDir, proj, opts, qualityThresholds));
  }

  let failed = 0;
  for (const r of results) {
    if (!quiet) {
      console.log(`  ${r.ok ? 'OK  ' : 'FAIL'}  ${r.name.padEnd(9)} 查了 ${r.checked}`);
      // 只报告、不判失败的读数（末拍稳定期、声明了没用的素材），照实打出来
      for (const n of r.notes ?? []) console.log('        · ' + n);
      for (const h of r.hints ?? []) console.log('        · ' + h);
      if (!r.ok) {
        for (const p of r.problems.slice(0, 12)) console.log('        ' + p);
        if (r.problems.length > 12) console.log(`        …还有 ${r.problems.length - 12} 条`);
      }
    }
    if (!r.ok) failed++;
  }
  if (!quiet) {
    console.log(failed === 0
      ? `${results.length} 道自检全部通过。`
      : `${results.length} 道自检里 ${failed} 道失败。`);
  }
  return {failed, results};
}
