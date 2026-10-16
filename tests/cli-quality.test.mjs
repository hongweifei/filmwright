// 参数解析与画质判定的单元测试。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseArgs, num, str} from '../src/host/cli/args.mjs';
import {
  aggregateShots, judgeQuality, THRESHOLDS,
} from '../src/host/checks/browser/quality.mjs';

// ---------- 参数解析 ----------

test('parseArgs：--k v 与 --flag 两种形态', () => {
  assert.deepEqual(parseArgs(['check', '--project', 'x']), {_: ['check'], project: 'x'});
  assert.deepEqual(parseArgs(['--no-quality']), {_: [], 'no-quality': true});
});

test('parseArgs：-- 之后全当位置参数（值里带 -- 时靠它）', () => {
  const a = parseArgs(['render', '--', '--weird']);
  assert.deepEqual(a._, ['render', '--weird']);
});

test('parseArgs：值以下一个 -- 开头时，当前是 flag 不是 key', () => {
  const a = parseArgs(['--flag', '--other', 'v']);
  assert.equal(a.flag, true);
  assert.equal(a.other, 'v');
});

test('num：默认值、合法值、非法值报错', () => {
  assert.equal(num({}, 'n', 5), 5);
  assert.equal(num({n: '42'}, 'n'), 42);
  assert.throws(() => num({n: 'abc'}, 'n'), /要是整数/);
  assert.throws(() => num({}, 'n'), /缺 --n/, '既没给又没默认值要报错');
});

test('str：默认值与字符串化', () => {
  assert.equal(str({}, 's', 'd'), 'd');
  assert.equal(str({s: 7}, 's'), '7');
  assert.throws(() => str({}, 's'), /缺 --s/);
});

// ---------- 画质判定 ----------

const STEP = THRESHOLDS.sampleStep;
const shots = [{id: 'SH', from: 1, to: 600}];

/** 造采样：stillRun 帧静止，其余按 beatEvery 给落位，否则给呼吸级微动。
 *  diffW（窗口差）是判定静止用的，所以必须一起造：
 *  静止段两端一样 → 小；呼吸段相邻小但窗口两端不同 → 大。 */
function samples({stillRun = 0, ink = 0.2, beatEvery = 60} = {}) {
  const out = [];
  for (let n = 1; n <= 600; n += STEP) {
    const idx = out.length;
    const inStill = idx * STEP < stillRun;
    let diff = null;
    let diffW = null;
    if (idx > 0) {
      if (inStill) { diff = 0.02; diffW = 0.02; }
      else if ((n - 1) % beatEvery === 0) { diff = 6.0; diffW = 6.0; }
      else { diff = 0.3; diffW = 6.0; }
    }
    out.push({n, diff, diffW, ink});
  }
  return out;
}

test('静止过久会被报出，并给出起点', () => {
  const stats = aggregateShots(samples({stillRun: 150}), shots, THRESHOLDS);
  const problems = judgeQuality(stats, THRESHOLDS);
  assert.ok(problems.some((p) => p.includes('连续静止')), '应报静止过久');
  assert.ok(problems.some((p) => p.includes('从 f')), '应指出从哪一帧起');
  // 读数要扣掉入场豁免那 20 帧（那段不参与判定），所以是 150-20 上下，
  // 不是 150。断言写成「明显超过阈值」而不是死等 150。
  assert.ok(stats[0].longestStatic >= 120,
    `静止段应被量出（实际 ${stats[0].longestStatic}，阈值 ${THRESHOLDS.staticFrames}）`);
});

test('墨迹过低会被报出', () => {
  const stats = aggregateShots(samples({ink: 0.0001}), shots, THRESHOLDS);
  const problems = judgeQuality(stats, THRESHOLDS);
  assert.ok(problems.some((p) => p.includes('墨迹')), '应报空白帧');
});

test('正常片不报任何问题', () => {
  const stats = aggregateShots(samples(), shots, THRESHOLDS);
  assert.deepEqual(judgeQuality(stats, THRESHOLDS), []);
});

test('入场期豁免：镜头开场那几帧空白不算空白帧', () => {
  // 前 15 帧 ink=0，之后正常
  const s = samples({ink: 0.2}).map((x) => (x.n < 1 + THRESHOLDS.entranceGrace ? {...x, ink: 0} : x));
  const stats = aggregateShots(s, shots, THRESHOLDS);
  assert.deepEqual(judgeQuality(stats, THRESHOLDS), [],
    '入场期空白应被豁免，不该报「几乎空」');
});

test('首帧 diff=null 不该被当成静止起点', () => {
  const stats = aggregateShots(samples({beatEvery: 60}), shots, THRESHOLDS);
  // 首点 diff 为 null；静止起点不该是第 1 帧
  if (stats[0].staticAt !== null) {
    assert.ok(stats[0].staticAt > 1, `静止起点不该是首帧，实际 ${stats[0].staticAt}`);
  }
});

test('全程只有呼吸（无落位）的镜头不会因「末拍」被判失败', () => {
  const stats = aggregateShots(samples({beatEvery: 10 ** 9}), shots, THRESHOLDS);
  const problems = judgeQuality(stats, THRESHOLDS);
  assert.equal(problems.filter((p) => p.includes('末拍')).length, 0);
});

test('末拍稳定期是「只报告」读数：hold 可以是 null，且不进 problems', () => {
  const stats = aggregateShots(samples(), shots, THRESHOLDS);
  assert.ok('hold' in stats[0], '统计里应有 hold 字段供报告');
  assert.equal(judgeQuality(stats, THRESHOLDS).filter((p) => p.includes('末拍')).length, 0);
  assert.equal(stats[0].holdSource, 'inferred', '没声明节拍时走像素推断');
});

// ---------- 声明节拍（手写镜头自己在 beats 里给）：末拍稳定期升级为硬判据 ----------

const shotB = (beats) => [{id: 'SHB', from: 1, to: 600, beats}];

test('声明节拍：停留足够 → 不报，hold 按声明算', () => {
  const stats = aggregateShots(samples(), shotB([40, 120, 300]), THRESHOLDS);
  assert.equal(stats[0].holdSource, 'declared');
  assert.equal(stats[0].hold, 300);
  assert.deepEqual(judgeQuality(stats, THRESHOLDS), []);
});

test('负面对照：末拍后停留不足要判失败（像素推断做不到这条）', () => {
  const stats = aggregateShots(samples(), shotB([40, 590]), THRESHOLDS);
  assert.equal(stats[0].hold, 10);
  const problems = judgeQuality(stats, THRESHOLDS);
  assert.ok(problems.some((p) => p.includes('末拍后只停留 10 帧')), JSON.stringify(problems));
  assert.ok(problems[0].includes('at'), 'hint 要给出路（对齐更靠前 / 下一镜头更晚）');
});

test('负面对照：节拍排到镜头结束之后要判失败', () => {
  const stats = aggregateShots(samples(), shotB([40, 700]), THRESHOLDS);
  assert.equal(stats[0].beatsBeyond, 100);
  const problems = judgeQuality(stats, THRESHOLDS);
  assert.ok(problems.some((p) => p.includes('镜头结束之后')), JSON.stringify(problems));
});

test('声明路径不受呼吸像素干扰：像素全程呼吸，仍按声明判出停留不足', () => {
  // 呼吸动效让像素推断读不出落位（这正是当年降级成"仅报告"的原因）；
  // 有声明节拍时它不该干扰判定。
  const stats = aggregateShots(samples({beatEvery: 10 ** 9}), shotB([40, 585]), THRESHOLDS);
  assert.equal(stats[0].holdSource, 'declared');
  assert.equal(stats[0].hold, 15);
  assert.ok(judgeQuality(stats, THRESHOLDS).some((p) => p.includes('末拍后只停留')));
});

test('聚合：镜头区间为空时不产生条目（不报假问题）', () => {
  const stats = aggregateShots(samples(), [{id: 'X', from: 5000, to: 6000}], THRESHOLDS);
  assert.deepEqual(stats, []);
});
