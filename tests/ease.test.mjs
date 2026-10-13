// 缓动与关键帧的单元测试。
// 这些是纯函数，用 Node 自带 test runner 就够（零依赖）。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  clamp, lerp, inv, easeOut3, easeOut4, easeIn3, easeInOut, easeOutBack,
  pulse, rnd, kf, enter, exit,
} from '../src/runtime/motion/ease.js';

test('clamp：默认夹在 0..1，且不交换边界', () => {
  assert.equal(clamp(-1), 0);
  assert.equal(clamp(2), 1);
  assert.equal(clamp(0.5), 0.5);
  assert.equal(clamp(-5, -10, 10), -5);
  assert.equal(clamp(5, 0, 3), 3);
});

test('lerp：端点与中点', () => {
  assert.equal(lerp(0, 10, 0), 0);
  assert.equal(lerp(0, 10, 1), 10);
  assert.equal(lerp(0, 10, 0.5), 5);
});

test('inv：区间外会被 clamp，起止相等时不除零', () => {
  assert.equal(inv(5, 0, 10), 0.5);
  assert.equal(inv(-1, 0, 10), 0, '低于下界应夹到 0');
  assert.equal(inv(99, 0, 10), 1, '高于上界应夹到 1');
  // 起止相等是最容易除零的地方：约定返回 1（视作已完成）
  assert.equal(inv(3, 3, 3), 1, 'a===b 时不能返回 NaN');
});

test('缓动：起止点固定', () => {
  // 端点用容差比：easeOutBack 的公式在 t=0 处算出 2.22e-16 而不是精确 0
  // （浮点误差，不是 bug）。用 === 比会在数学上正确的实现上误报。
  const EPS = 1e-9;
  for (const [name, fn] of [['easeOut3', easeOut3], ['easeOut4', easeOut4],
    ['easeIn3', easeIn3], ['easeInOut', easeInOut], ['easeOutBack', easeOutBack]]) {
    assert.ok(Math.abs(fn(0)) < EPS, `${name}(0) 应约为 0，实际 ${fn(0)}`);
    assert.ok(Math.abs(fn(1) - 1) < EPS, `${name}(1) 应约为 1，实际 ${fn(1)}`);
  }
});

test('单调缓动：全程不回退', () => {
  // easeOutBack 不在此列：它的**定义**就是过冲后再回落，
  // 在 t≈0.65 处必然回退（实测 1.0994 → 1.0926）。
  // 拿单调性去断言它是错的 —— 那是它的用途，不是缺陷。
  const EPS = 1e-9;
  for (const [name, fn] of [['easeOut3', easeOut3], ['easeOut4', easeOut4],
    ['easeIn3', easeIn3], ['easeInOut', easeInOut]]) {
    let prev = -Infinity;
    for (let t = 0; t <= 1.0001; t += 0.02) {
      const v = fn(t);
      assert.ok(v >= prev - EPS, `${name} 在 t=${t.toFixed(2)} 处回退了：${v} < ${prev}`);
      prev = v;
    }
  }
});

test('easeOutBack：会过冲（这正是它的用途）', () => {
  let maxV = 0;
  for (let t = 0; t <= 1; t += 0.01) maxV = Math.max(maxV, easeOutBack(t));
  assert.ok(maxV > 1, 'easeOutBack 应该过冲超过 1');
});

test('pulse：中心处最强，半宽外为 0，且不为负', () => {
  assert.equal(pulse(10, 10, 5), 1);
  assert.equal(pulse(20, 10, 5), 0);
  assert.equal(pulse(0, 10, 5), 0);
  assert.ok(pulse(12, 10, 5) > 0 && pulse(12, 10, 5) < 1);
  assert.ok(pulse(100, 10, 5) >= 0, '远处不能是负数');
});

test('rnd：确定性（同 seed 同结果），且落在 [0,1)', () => {
  for (let s = 0; s < 50; s++) {
    const a = rnd(s);
    assert.equal(a, rnd(s), `seed=${s} 两次结果不同`);
    assert.ok(a >= 0 && a < 1, `seed=${s} 的值 ${a} 越界`);
  }
});

test('kf：低于首帧返回首值，高于末帧返回末值（首值陷阱）', () => {
  const keys = [[10, 0], [20, 100], [30, 50]];
  assert.equal(kf(5, keys), 0, 't 小于首关键帧应返回首值，不是 0 以外的值');
  assert.equal(kf(10, keys), 0);
  assert.equal(kf(20, keys), 100);
  assert.equal(kf(25, keys), 75, '中段应线性插值');
  assert.equal(kf(999, keys), 50);
});

test('enter：首帧 alpha 为 0（不能先亮一帧）', () => {
  const at0 = enter(0, 0, 14, 26);
  assert.equal(at0.a, 0, '入场首帧必须全透明');
  const done = enter(100, 0, 14, 26);
  assert.equal(done.a, 1);
  assert.equal(done.dy, 0);
});

test('exit：末帧归零', () => {
  const atEnd = exit(100, 100, 12, 22);
  assert.ok(Math.abs(atEnd.a) < 1e-9, '离场末帧应透明');
  const before = exit(0, 100, 12, 22);
  assert.equal(before.a, 1, '离场开始前应完全不透明');
});
