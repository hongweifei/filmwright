// 负面对照：故意做坏，确认画质自检真的会报。
//
// 这是「检查本身有没有用」的证明 —— 一个永远绿的检查等于没有检查。
// 用**纯函数**直接喂构造数据，不必真渲染，几毫秒跑完。
//
//   node tools/quality-negative.mjs
import {
  aggregateShots, judgeQuality, THRESHOLDS,
} from '../src/host/checks/browser/quality.mjs';

const STEP = THRESHOLDS.sampleStep;

/** 造一段采样：stillRun 帧静止，其余按 beatEvery 给落位，否则给呼吸级微动。 */
function makeSamples(from, to, {stillRun = 0, ink = 0.2, beatEvery = 60} = {}) {
  const out = [];
  for (let n = from; n <= to; n += STEP) {
    const idx = out.length;
    const inStill = idx * STEP < stillRun;        // 落在静止段内
    let diff = null;
    let diffW = null;
    if (idx > 0) {
      if (inStill) { diff = 0.02; diffW = 0.02; }               // 静止：相邻与窗口都小
      else if ((n - from) % beatEvery === 0) { diff = 6.0; diffW = 6.0; }   // 落位
      else { diff = 0.3; diffW = 6.0; }                          // 呼吸：相邻小、窗口大
    }
    out.push({n, diff, diffW, ink});
  }
  return out;
}

const shots = [{id: 'SH', from: 1, to: 600}];
// 声明了节拍的镜头：末拍稳定期是硬判据（scene 模板自动声明；手写镜头可选声明）
const shotsWithBeats = (beats) => [{id: 'SHB', from: 1, to: 600, beats}];
const cases = [
  {
    name: '正常片（有落位、有呼吸、墨迹够）',
    samples: makeSamples(1, 600, {ink: 0.2}),
    expect: 0,
  },
  {
    name: '静止过久（连续 150 帧不动）',
    samples: makeSamples(1, 600, {stillRun: 150, ink: 0.2}),
    expect: '静止',
  },
  {
    name: '空白帧（墨迹 0.01%）',
    samples: makeSamples(1, 600, {ink: 0.0001}),
    expect: '墨迹',
  },
  {
    name: '声明节拍：末拍后只停留 10 帧（硬判据）',
    samples: makeSamples(1, 600, {ink: 0.2}),
    shots: shotsWithBeats([40, 590]),
    expect: '末拍后只停留',
  },
  {
    name: '声明节拍：停留充足（不该报）',
    samples: makeSamples(1, 600, {ink: 0.2}),
    shots: shotsWithBeats([40, 120, 300]),
    expect: 0,
  },
  {
    name: '声明节拍：节拍排到镜头结束之后（硬判据）',
    samples: makeSamples(1, 600, {ink: 0.2}),
    shots: shotsWithBeats([40, 700]),
    expect: '镜头结束之后',
  },
];

let bad = 0;
for (const c of cases) {
  const stats = aggregateShots(c.samples, c.shots ?? shots, THRESHOLDS);
  const problems = judgeQuality(stats, THRESHOLDS);
  const ok = c.expect === 0
    ? problems.length === 0
    : problems.some((p) => p.includes(c.expect));
  console.log(`${ok ? '✓' : '✗'} ${c.name}`);
  for (const p of problems) console.log('     ' + p);
  if (!ok) {
    bad++;
    console.log(`     —— 期望${c.expect === 0 ? '不报' : `报含「${c.expect}」`}，实际报了 ${problems.length} 条`);
  }
}

// 再确认「不判失败」的那条不会误伤：只有呼吸、没有落位、**且没声明节拍**的镜头
// （像素推断分不清入场/离场，所以这条路径只报告；声明了节拍的由上面的用例覆盖）
const noBeat = aggregateShots(makeSamples(1, 600, {ink: 0.2, beatEvery: 10 ** 9}), shots, THRESHOLDS);
const noBeatProblems = judgeQuality(noBeat, THRESHOLDS);
const noBeatOk = !noBeatProblems.some((p) => p.includes('末拍'));
console.log(`${noBeatOk ? '✓' : '✗'} 未声明节拍 + 全程呼吸的镜头不会被判「末拍稳定期不足」`);
if (!noBeatOk) { bad++; for (const p of noBeatProblems) console.log('     ' + p); }

console.log(bad === 0 ? '\n负面对照全部符合预期。' : `\n${bad} 项不符合预期。`);
process.exit(bad ? 1 : 0);
