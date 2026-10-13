// 比对原片项目里的两份时间轴：src/timeline.js（原引擎读）与 script/timeline.json（迁移后读）。
//
// 如果两者不同步，那「第 N 帧」在两边不是同一时刻 —— 动画中的元素就会差一点，
// 表现为「局部小差异」，且只在**正在动**的元素上。
//
//   node tools/compare-timelines.mjs <原片项目目录>
import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

if (!process.argv[2]) {
  console.error('用法：node tools/compare-timelines.mjs <原片项目目录>');
  process.exit(2);
}
const PROJ = resolve(process.argv[2]);
const js = await import(pathToFileURL(join(PROJ, 'src', 'timeline.js')).href);
const json = JSON.parse(readFileSync(join(PROJ, 'script', 'timeline.json'), 'utf8'));

console.log(`总帧数：js ${js.TOTAL_FRAMES} / json ${json.total_frames}  ` +
  (js.TOTAL_FRAMES === json.total_frames ? '✓' : '✗ 不一致'));
console.log(`FPS：js ${js.FPS} / json ${json.fps}`);

const SJ = js.SENTENCES, SJn = json.sentences;
console.log(`句子：js ${SJ.length} 条 / json ${SJn.length} 条`);
let bad = 0;
for (let i = 0; i < Math.min(SJ.length, SJn.length); i++) {
  const a = SJ[i], b = SJn[i];
  if (a.id !== b.id || a.from !== b.from || a.to !== b.to) {
    bad++;
    if (bad <= 10) console.log(`  不同：${a.id} f${a.from}-${a.to}  vs  ${b.id} f${b.from}-${b.to}`);
  }
}
console.log(bad === 0 ? '  ✓ 句 id 与帧区间完全一致' : `  共 ${bad} 处不同`);

const CJ = js.CHAPTERS, CJn = json.chapters;
let cbad = 0;
for (let i = 0; i < Math.min(CJ.length, CJn.length); i++) {
  if (CJ[i].n !== CJn[i].n || CJ[i].from !== CJn[i].from) {
    cbad++;
    console.log(`  章节不同：${JSON.stringify(CJ[i])} vs ${JSON.stringify(CJn[i])}`);
  }
}
console.log(cbad === 0 ? '章节：✓ 一致' : `章节：${cbad} 处不同`);

if (js.SUBS) {
  const A = js.SUBS, B = json.subs;
  console.log(`字幕块：js ${A.length} 条 / json ${B.length} 条`);
  let d = 0;
  for (let i = 0; i < Math.min(A.length, B.length); i++) {
    if (A[i].from !== B[i].from || A[i].to !== B[i].to || A[i].text !== B[i].text) {
      d++;
      if (d <= 5) console.log(`  不同：f${A[i].from}-${A[i].to} "${A[i].text}" vs f${B[i].from}-${B[i].to} "${B[i].text}"`);
    }
  }
  console.log(d === 0 ? '  ✓ 字幕块完全一致' : `  共 ${d} 处不同`);
} else {
  console.log('字幕块：timeline.js 里没有 SUBS 导出');
}
