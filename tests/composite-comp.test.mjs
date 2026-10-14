// 嵌套合成的单元测试。
//
// 最需要钉住的是**时间基换算**（全局帧 → 本地帧）与循环边界 ——
// 这类算术错一位就会在成片里表现为「动效晚一帧」或「循环处跳一下」，
// 而且逐帧看很难发现。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bindLocalShots, compLength, localFrame, drawCompInstance, mapBeats, assertNoCycles} from '../src/runtime/composite/comp.js';

const shot = (start, tag) => ({start, draw() { this.drawn = tag; }});

test('bindLocalShots：只声明 start 就串接成本地区间，首个必须从 1 起', () => {
  const out = bindLocalShots([shot(1, 'a'), shot(30, 'b'), shot(80, 'c')], 120);
  assert.deepEqual(out.map((s) => [s.from, s.to]), [[1, 29], [30, 79], [80, 120]]);
});

test('bindLocalShots 负面对照：空表 / 首个不从 1 / start 不递增 / 缺 draw 都要报错', () => {
  assert.throws(() => bindLocalShots([]), /镜头表为空/);
  assert.throws(() => bindLocalShots([shot(5)]), /第一个镜头必须从本地第 1 帧开始/);
  assert.throws(() => bindLocalShots([shot(1), shot(1)]), /start 必须严格递增/);
  assert.throws(() => bindLocalShots([{start: 1}]), /缺少 draw/);
  assert.throws(() => bindLocalShots([shot(0)]), /必须是 ≥1 的整数/);
  assert.throws(() => bindLocalShots([{...shot(1), start: 1.5}]), /必须是 ≥1 的整数/);
});

test('compLength：显式 frames 优先，否则取末镜头 to', () => {
  const shots = bindLocalShots([shot(1), shot(30)], undefined);
  // 未给 total 时末镜头 to = start + 60 = 90
  assert.equal(compLength({}, shots), 90);
  assert.equal(compLength({frames: 40}, shots), 40, '显式 frames 应优先');
  assert.equal(compLength({frames: 0}, shots), 90, '非法 frames 忽略');
});

test('localFrame：不循环时本地帧从 1 线性增长', () => {
  // 实例从全局 100 起，长度 30，不循环
  assert.equal(localFrame(100, 100, 30, false), 1);
  assert.equal(localFrame(101, 100, 30, false), 2);
  assert.equal(localFrame(129, 100, 30, false), 30);
  assert.equal(localFrame(130, 100, 30, false), 31, '不循环时会超出 len（由调用方决定画不画）');
  assert.equal(localFrame(99, 100, 30, false), 1, '早于 from 时夹到 1');
});

test('localFrame：循环时在 [1, len] 内绕圈，且周期正确', () => {
  const from = 100, len = 12;
  assert.equal(localFrame(100, from, len, true), 1);
  assert.equal(localFrame(111, from, len, true), 12);
  assert.equal(localFrame(112, from, len, true), 1, '第 13 帧应回到本地第 1 帧');
  assert.equal(localFrame(123, from, len, true), 12);
  assert.equal(localFrame(124, from, len, true), 1, '第二个周期');
  // 跨多个周期
  assert.equal(localFrame(100 + 12 * 10, from, len, true), 1);
  assert.equal(localFrame(100 + 12 * 10 + 5, from, len, true), 6);
});

test('localFrame 负面对照：长度非正整数要报错（1.5 会算出「半帧」）', () => {
  for (const bad of [0, -1, 1.5, NaN, '4', null]) {
    assert.throws(() => localFrame(10, 1, bad, true), /长度必须是 ≥1 的整数/, '应报错：' + bad);
  }
});

test('drawCompInstance：把本地帧交给子镜头，并用本地帧调它的 draw', () => {
  const shots = bindLocalShots([shot(1, 'a'), shot(10, 'b')], 20);
  const inst = {localShots: shots, len: 20, from: 100, loop: false};
  const calls = [];
  // 用假 ctx 记录收到多少帧
  const fakeShotDraw = (ctx, local) => calls.push(local);
  shots[0].draw = fakeShotDraw;
  shots[1].draw = fakeShotDraw;
  drawCompInstance({}, inst, 100, 0, '#fff');
  drawCompInstance({}, inst, 105, 0, '#fff');
  drawCompInstance({}, inst, 110, 0, '#fff');
  // 局部帧从 1 起：from=100 → n=100 是本地 1、n=105 是本地 6、n=110 是本地 11
  assert.deepEqual(calls, [1, 6, 11], '子镜头应收到本地帧 1/6/11');
});

test('drawCompInstance：不循环且已播完时返回 false 且不画', () => {
  const shots = bindLocalShots([shot(1, 'a')], 5);
  const inst = {localShots: shots, len: 5, from: 100, loop: false};
  let called = 0;
  shots[0].draw = () => { called++; };
  assert.equal(drawCompInstance({}, inst, 100, 0, '#fff'), true, '区间内应画');
  assert.equal(drawCompInstance({}, inst, 106, 0, '#fff'), false, '超出长度应返回 false');
  assert.equal(called, 1, '超出后不该再调用 draw');
});

test('drawCompInstance：循环实例永远有内容可画', () => {
  const shots = bindLocalShots([shot(1, 'a')], 5);
  const inst = {localShots: shots, len: 5, from: 100, loop: true};
  let called = 0;
  shots[0].draw = () => { called++; };
  for (const n of [100, 105, 110, 137, 500]) {
    assert.equal(drawCompInstance({}, inst, n, 0, '#fff'), true, `n=${n} 应能画`);
  }
  assert.equal(called, 5);
});

test('mapBeats：不循环时本地节拍平移到全局，并裁掉越界的', () => {
  // 子镜头节拍（本地）1、10、20；实例 from=100，区间到 115
  const b = mapBeats([1, 10, 20], 100, 20, false, 115);
  assert.deepEqual(b, [100, 109], '本地 20 映射到 119 > 115，应被裁掉');
});

test('mapBeats：循环时映射到**实例所在的那个周期**的节拍', () => {
  // 实例 from=100，len=10，循环，区间到 137。
  // 周期：100-109、110-119、120-129、130-139。137 落在**第 4 个周期**（130-139）里，
  // 该周期的节拍 130、134 都已落位（137 > 134），所以它们才是「末拍」候选 ——
  // 而不是上一个已走完的周期 120-129（那时实例已经进入新周期，画面早就变了）。
  const b = mapBeats([1, 5], 100, 10, true, 137);
  assert.deepEqual(b, [130, 134], '应映射到实例当前所在周期');
  // 区间刚好整除时（129 落在第 3 个周期 120-129 的末尾）
  const c = mapBeats([1], 100, 10, true, 129);
  assert.deepEqual(c, [120]);
  // 不足一个周期：仍在第 1 个周期里，取第一周期的节拍并裁掉越界的
  const d = mapBeats([1, 5], 100, 10, true, 104);
  assert.deepEqual(d, [100, 104]);
  // 越界的节拍要被裁掉：周期 130-139，区间只到 132 → 只有 130 落位
  const e = mapBeats([1, 5], 100, 10, true, 132);
  assert.deepEqual(e, [130], '134 > 132 应被裁掉');
});

test('mapBeats：空节拍退化为实例起始帧（画质自检至少有个锚点）', () => {
  assert.deepEqual(mapBeats([], 100, 10, false, 120), [100]);
  assert.deepEqual(mapBeats(null, 100, 10, true, 120), [100]);
});

test('assertNoCycles 负面对照：自引用与互引用都要报错，且指出链条', () => {
  assert.throws(() => assertNoCycles({A: {shots: [{type: 'comp', comp: 'A'}]}}),
    /循环引用：A → A/);
  assert.throws(() => assertNoCycles({
    A: {shots: [{type: 'comp', comp: 'B'}]},
    B: {shots: [{type: 'comp', comp: 'C'}]},
    C: {shots: [{type: 'comp', comp: 'A'}]},
  }), /循环引用：A → B → C → A/);
});

test('assertNoCycles：引用不存在的 comp 要报错并说明是谁引用的', () => {
  assert.throws(() => assertNoCycles({A: {shots: [{type: 'comp', comp: 'Nope'}]}}),
    /子合成 A 引用了不存在的 comp「Nope」/);
});

test('assertNoCycles：合法的嵌套（DAG）通过；菱形引用不算环', () => {
  assert.doesNotThrow(() => assertNoCycles({
    A: {shots: [{type: 'comp', comp: 'B'}, {type: 'comp', comp: 'C'}]},
    B: {shots: [{type: 'comp', comp: 'D'}]},
    C: {shots: [{type: 'comp', comp: 'D'}]},   // 菱形：D 被两条路径引用，不是环
    D: {shots: []},
  }));
});
