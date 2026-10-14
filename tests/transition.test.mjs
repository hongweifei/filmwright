// 转场的单元测试：混合系数是 N 的纯函数、区间与边界正确、第一个镜头不许 crossfade。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setShots, bindShots, shots, normalizeTransition} from '../src/runtime/stage/shots.js';

const mk = (start, transition) => ({
  start,
  ...(transition === undefined ? {} : {transition}),   // 注意 0 也要带上（它本身非法）
  draw() {},
});

/** 装两个镜头的片子：SH1 1..100，SH2 101..200（SH2 带转场）。 */
function setup(transition, len = 10) {
  const list = [mk(1), mk(101, transition)];
  setShots(list);
  bindShots(list, 200);
  return shots()[1];
}

test('normalizeTransition：数字=帧数（crossfade）；对象={type,frames}；非法返回 null', () => {
  assert.deepEqual(normalizeTransition(12), {type: 'crossfade', frames: 12});
  assert.deepEqual(normalizeTransition({type: 'fade', frames: 8}), {type: 'fade', frames: 8});
  assert.deepEqual(normalizeTransition({frames: 5}), {type: 'crossfade', frames: 5}, '默认 crossfade');
  for (const bad of [0, -3, 1.5, '', null, {}, {frames: 0}, {type: 'wipe', frames: 5}]) {
    assert.equal(normalizeTransition(bad), null, '应判非法：' + JSON.stringify(bad));
  }
});

test('setShots 负面对照：转场形状不对当场报错', () => {
  for (const bad of [0, {frames: 0}, {type: 'wipe', frames: 4}, 'fade']) {
    assert.throws(() => setShots([mk(1), mk(50, bad)]),
      /transition 形状不对/, '应报错：' + JSON.stringify(bad));
  }
});

test('setShots 负面对照：第一个镜头不能 crossfade（前面没有镜头可混）', () => {
  assert.throws(() => setShots([mk(1, {type: 'crossfade', frames: 10}), mk(50)]),
    /第一个镜头不能用 crossfade/);
  // 但第一个镜头可以用 fade（从背景色淡入）
  assert.doesNotThrow(() => setShots([mk(1, {type: 'fade', frames: 10}), mk(50)]));
});

test('transitionAt 是纯函数：同一帧多次调用结果一致', async () => {
  const {transitionAt} = await import('../src/runtime/stage/drawFrame.js');
  setup(10);
  for (const n of [101, 105, 110, 111]) {
    const a = transitionAt(n);
    const b = transitionAt(n);
    assert.equal(a.cur, b.cur);
    assert.equal(a.prevAlpha, b.prevAlpha);
  }
});

test('crossfade：区间内系数变化，区间外 cur=1 且不画前镜头', async () => {
  const {transitionAt} = await import('../src/runtime/stage/drawFrame.js');
  setup({type: 'crossfade', frames: 10});
  // 起始帧：当前镜头刚开始淡入（1/10），前镜头接近全不透明
  const at0 = transitionAt(101);
  assert.ok(at0.cur > 0 && at0.cur <= 0.1, '起始帧当前镜头几乎全透明，实际 ' + at0.cur);
  assert.ok(at0.prevAlpha > 0.85, '起始帧前镜头几乎全不透明，实际 ' + at0.prevAlpha);
  assert.ok(at0.prevShot, 'crossfade 起始帧应有前镜头');
  // 中点：各一半（取第 5 帧，local=4 → (4+1)/10=0.5）
  const mid = transitionAt(105);
  assert.ok(Math.abs(mid.cur - 0.5) < 1e-9, '中点 cur≈0.5，实际 ' + mid.cur);
  assert.ok(Math.abs(mid.prevAlpha - 0.5) < 1e-9, '中点 prevAlpha≈0.5');
  // 结束后：完全回到当前镜头
  const after = transitionAt(111);
  assert.equal(after.cur, 1);
  assert.equal(after.prevShot, null, '区间外不画前镜头');
  assert.equal(after.prevAlpha, 0);
  // 区间之前（属于 SH1）不该有转场
  const before = transitionAt(100);
  assert.equal(before.prevShot, null);
});

test('fade：不用前镜头，cur 从接近 0 到 1', async () => {
  const {transitionAt} = await import('../src/runtime/stage/drawFrame.js');
  setup({type: 'fade', frames: 10});
  const at0 = transitionAt(101);
  assert.ok(at0.cur > 0 && at0.cur <= 0.1, '起始帧几乎全透明，实际 ' + at0.cur);
  assert.equal(at0.prevShot, null, 'fade 不画前镜头');
  assert.equal(transitionAt(110).cur, 1, '转场末帧应完全淡入');
  assert.equal(transitionAt(111).cur, 1, '区间外保持 1');
});

test('转场长度被镜头自身长度夹住（不会溢出到下一个镜头）', async () => {
  const {transitionAt} = await import('../src/runtime/stage/drawFrame.js');
  // SH2 只有 101..200，但声明 500 帧转场 → 实际最多用它自己的长度
  setup({type: 'crossfade', frames: 500});
  assert.ok(transitionAt(101).cur > 0 && transitionAt(101).cur <= 0.01);
  assert.ok(transitionAt(150).cur > 0 && transitionAt(150).cur <= 1);
  assert.equal(transitionAt(200).cur, 1, '镜头末帧应完成（夹到镜头长度）');
});

test('没有声明转场的镜头行为完全不变（回归保护）', async () => {
  const {transitionAt} = await import('../src/runtime/stage/drawFrame.js');
  setup(undefined);
  for (const n of [1, 50, 100, 101, 150, 200]) {
    const t = transitionAt(n);
    assert.equal(t.cur, 1, '未声明时 cur 恒为 1');
    assert.equal(t.prevShot, null);
    assert.equal(t.prevAlpha, 0);
  }
});
