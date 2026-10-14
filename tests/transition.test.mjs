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

test('normalizeTransition：数字=帧数（crossfade）；对象={type,frames,direction}；非法返回 null', () => {
  assert.deepEqual(normalizeTransition(12), {type: 'crossfade', frames: 12, direction: null});
  assert.deepEqual(normalizeTransition({type: 'fade', frames: 8}), {type: 'fade', frames: 8, direction: null});
  assert.deepEqual(normalizeTransition({frames: 5}), {type: 'crossfade', frames: 5, direction: null}, '默认 crossfade');
  // 五种类型都合法
  for (const type of ['crossfade', 'fade', 'slide', 'wipe', 'zoom']) {
    assert.equal(normalizeTransition({type, frames: 5}).type, type, `${type} 应合法`);
  }
  // direction 只对 slide/wipe 有意义，别的类型给了会被**忽略**（不报错）
  assert.equal(normalizeTransition({type: 'slide', frames: 5, direction: 'up'}).direction, 'up');
  assert.equal(normalizeTransition({type: 'wipe', frames: 5, direction: 'down'}).direction, 'down');
  assert.equal(normalizeTransition({type: 'crossfade', frames: 5, direction: 'up'}).direction, null,
    'crossfade 的 direction 应被忽略（不报错，因为统一写 direction 的生成器很常见）');
  // 非法
  for (const bad of [0, -3, 1.5, '', null, {}, [], {frames: 0}, {type: 'nope', frames: 5},
    {type: 'slide', frames: 5, direction: 'sideways'}]) {
    assert.equal(normalizeTransition(bad), null, '应判非法：' + JSON.stringify(bad));
  }
});

test('setShots 负面对照：转场形状不对当场报错', () => {
  for (const bad of [0, {frames: 0}, {type: 'nope', frames: 4}, 'fade',
    {type: 'wipe', frames: 4, direction: '斜着'}]) {
    assert.throws(() => setShots([mk(1), mk(50, bad)]),
      /transition 形状不对/, '应报错：' + JSON.stringify(bad));
  }
});

test('setShots 负面对照：第一个镜头只能用 fade（其余转场都需要前一个镜头）', () => {
  for (const type of ['crossfade', 'slide', 'wipe', 'zoom']) {
    assert.throws(() => setShots([mk(1, {type, frames: 10}), mk(50)]),
      /第一个镜头不能用/, `${type} 在第一个镜头应报错`);
  }
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
    assert.equal(t.motion, null, '未声明时没有几何位移');
  }
});

// ---------- 扩展转场（slide / wipe / zoom）----------

test('slide：两个镜头反向位移，位移量随进度收敛到 0', async () => {
  const {transitionAt} = await import('../src/runtime/stage/drawFrame.js');
  const {view} = await import('../src/contract/config.js');
  setup({type: 'slide', frames: 10, direction: 'left'});
  const at0 = transitionAt(101);
  assert.ok(at0.motion, 'slide 应有几何位移');
  assert.equal(at0.motion.kind, 'slide');
  assert.ok(Math.abs(at0.motion.dx - view.W * 0.9) < 1e-6,
    `起始帧当前镜头应几乎整屏在右（dx≈${view.W * 0.9}），实际 ${at0.motion.dx}`);
  assert.ok(Math.abs(at0.motion.prevDx + at0.motion.dx) < 1e-9, '前镜头位移应是反向等量');
  // 中点
  const mid = transitionAt(105);
  assert.ok(Math.abs(mid.motion.dx - view.W * 0.5) < 1e-6, '中点位移应是一半屏');
  // 末帧：位移归零
  const last = transitionAt(110);
  assert.ok(Math.abs(last.motion.dx) < 1e-9, `末帧位移应归零，实际 ${last.motion.dx}`);
  // 两个镜头都保持不透明（slide 是推挤，不是淡出）
  assert.equal(mid.cur, 1);
  assert.equal(mid.prevAlpha, 1);
});

test('slide 四个方向：位移轴向正确', async () => {
  const {transitionAt} = await import('../src/runtime/stage/drawFrame.js');
  const {view} = await import('../src/contract/config.js');
  const cases = [
    ['left', 'dx', +1], ['right', 'dx', -1], ['up', 'dy', +1], ['down', 'dy', -1],
  ];
  for (const [dir, axis, sign] of cases) {
    setup({type: 'slide', frames: 10, direction: dir});
    const m = transitionAt(101).motion;
    const v = m[axis];
    assert.ok(v * sign > 0, `${dir} 的 ${axis} 符号应为 ${sign}，实际 ${v}`);
    // 另一个轴不动
    const other = axis === 'dx' ? m.dy : m.dx;
    assert.equal(other, 0, `${dir} 的另一个轴不该动`);
  }
});

test('wipe：裁剪矩形随进度扩张，末帧覆盖整屏', async () => {
  const {transitionAt} = await import('../src/runtime/stage/drawFrame.js');
  const {view} = await import('../src/contract/config.js');
  setup({type: 'wipe', frames: 10, direction: 'left'});
  const at0 = transitionAt(101);
  assert.ok(at0.motion?.clip, 'wipe 应有裁剪矩形');
  assert.equal(at0.motion.kind, 'wipe');
  // 起始帧：只露出一点点（从右侧开始）
  assert.ok(at0.motion.clip.w > 0 && at0.motion.clip.w < view.W * 0.2,
    `起始帧应只露一小条，实际宽 ${at0.motion.clip.w}`);
  assert.ok(at0.motion.clip.x > view.W * 0.8, '起始帧应从右侧开始');
  // 末帧：整屏
  const last = transitionAt(110).motion.clip;
  assert.ok(Math.abs(last.w - view.W) < 1e-6 && Math.abs(last.x) < 1e-6,
    `末帧应覆盖整屏，实际 x=${last.x} w=${last.w}`);
  // wipe 用裁剪而不是淡出：两个镜头都不透明
  assert.equal(at0.cur, 1);
  assert.equal(at0.prevAlpha, 1);
});

test('zoom：从放大归位，前镜头淡出', async () => {
  const {transitionAt} = await import('../src/runtime/stage/drawFrame.js');
  setup({type: 'zoom', frames: 10});
  const at0 = transitionAt(101);
  assert.ok(at0.motion?.scale > 1, `起始应放大（>1），实际 ${at0.motion?.scale}`);
  assert.ok(at0.motion.scale <= 1.13, '放大幅度应克制（≤1.13），否则观感突兀');
  const mid = transitionAt(105);
  assert.ok(mid.motion.scale > 1 && mid.motion.scale < at0.motion.scale, '中点应比起始更接近 1');
  const last = transitionAt(110);
  assert.ok(Math.abs(last.motion.scale - 1) < 1e-9, `末帧应归位到 1，实际 ${last.motion.scale}`);
  assert.ok(at0.cur < 0.2, 'zoom 当前镜头也是淡入的');
  assert.ok(at0.prevAlpha > 0.8, 'zoom 前镜头是淡出的');
});

test('扩展转场同样是纯函数：同一帧多次调用结果一致', async () => {
  const {transitionAt} = await import('../src/runtime/stage/drawFrame.js');
  for (const type of ['slide', 'wipe', 'zoom']) {
    setup({type, frames: 12, direction: 'up'});
    for (const n of [101, 105, 110, 113]) {
      const a = transitionAt(n), b = transitionAt(n);
      assert.deepEqual(a.cur, b.cur, `${type} n=${n} cur 应一致`);
      assert.deepEqual(a.prevAlpha, b.prevAlpha, `${type} n=${n} prevAlpha 应一致`);
      assert.deepEqual(a.motion, b.motion, `${type} n=${n} motion 应一致（几何也是纯函数）`);
    }
  }
});

test('负面对照：扩展转场区间外也必须回到「无转场」状态', async () => {
  const {transitionAt} = await import('../src/runtime/stage/drawFrame.js');
  for (const type of ['slide', 'wipe', 'zoom']) {
    setup({type, frames: 10, direction: 'left'});
    for (const n of [100, 111, 150, 200]) {
      const t = transitionAt(n);
      assert.equal(t.cur, 1, `${type} n=${n} 区间外 cur 应为 1`);
      assert.equal(t.motion, null, `${type} n=${n} 区间外不该有几何位移`);
    }
  }
});
