// 关键帧求值器的单元测试（阶段 ① 的核心）。
//
// 判据来自 docs/design/DESIGN-keyframes.md §10.1。三条最要紧的：
//   1. **夹紧不外推** —— 外推是"元素无声飞出画面"的主要来源，且很难查
//   2. **端点精确** —— ease(0)=0、ease(1)=1，关键帧处的值不因缓动而有偏差
//   3. **`kf` 向后兼容** —— 扩展加缓动后，原来只传两元组的调用方行为必须不变
import {test} from 'node:test';
import assert from 'node:assert/strict';
// 注意：EASE_NAMES 从 **contract** 取（schema 的归属层），EASES 从 **runtime** 取。
// 两份规则因分层规则而分开写，下面的交叉一致性测试负责钉住它们不漂移。
import {EASES, kf, clamp, step} from '../src/runtime/motion/ease.js';
import {ANIM_PROPS, compileAnimate, evalAnimate, mergeAnimate} from '../src/runtime/scene/animate.js';
import {validateAnimate, EASE_NAMES} from '../src/contract/scene.js';
import {setTimeline} from '../src/contract/timeline.js';
import {compileScene} from '../src/runtime/scene/templates.js';
import {setShots, bindShots, shots} from '../src/runtime/stage/shots.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ─────────────────────────── kf：向后兼容与基本语义 ───────────────────────────

test('kf 向后兼容：只传两元组时行为与扩展前一致（chapterCard 依赖它）', () => {
  // chapterCard.js 的真实用法：kf(N, [[0,0],[26,1]])
  const keys = [[0, 0], [26, 1]];
  const ref = (t) => clamp(t / 26);
  for (const t of [-5, 0, 1, 13, 25, 26, 40]) {
    assert.ok(near(kf(t, keys), ref(t)), `t=${t}: ${kf(t, keys)} vs ${ref(t)}`);
  }
});

test('kf 夹紧：首键之前取首值、末键之后取末值（**不外推**）', () => {
  const keys = [[100, 40], [200, 0]];
  assert.equal(kf(1, keys), 40, '首键之前应是首值');
  assert.equal(kf(99, keys), 40);
  assert.equal(kf(200, keys), 0);
  assert.equal(kf(999, keys), 0, '末键之后应是末值，不是继续往负走');
  // 外推会给出 -0.6 这种值（元素飞出画面）——显式断言它没有发生
  assert.notEqual(kf(999, keys), -0.6);
});

test('kf 线性段：中点等于两值平均', () => {
  assert.equal(kf(50, [[0, 0], [100, 100]]), 50);
  // ⚠️ 这里不能写 t=150 —— 150 已超出末键 100，按设计要**夹紧到末值**（见上一条）。
  // 中点要落在区间内。
  assert.equal(kf(50, [[0, 10], [100, 30]]), 20);
});

test('kf 缓动：用「走到该键」的那个缓动函数，且端点精确落位', () => {
  const keys = [[0, 0], [10, 100, EASES.out3]];
  // u = 0.5 → out3(0.5) = 1 - 0.5^3 = 0.875
  assert.ok(near(kf(5, keys), 87.5), `中途应为 87.5，实际 ${kf(5, keys)}`);
  assert.equal(kf(0, keys), 0, '起点必须精确为 0');
  assert.equal(kf(10, keys), 100, '终点必须精确为 100（不因缓动偏移）');
});

test('kf 多段：在段边界处取到正确的那一段', () => {
  const keys = [[0, 0], [10, 10], [20, 0]];
  assert.equal(kf(0, keys), 0);
  assert.equal(kf(10, keys), 10, '边界属于"到达"的那一段');
  assert.equal(kf(15, keys), 5, '第二段的中间');
  assert.equal(kf(20, keys), 0);
});

// ─────────────────────────── 缓动词汇表 ───────────────────────────

test('每种缓动的端点精确：e(0)=0、e(1)=1', () => {
  for (const name of EASE_NAMES) {
    const e = EASES[name];
    assert.ok(near(e(0), 0), `${name}(0) 应为 0，实际 ${e(0)}`);
    assert.ok(near(e(1), 1), `${name}(1) 应为 1，实际 ${e(1)}`);
  }
});

test('缓动单调性：除 back（刻意过冲）外都应单调不减', () => {
  for (const name of EASE_NAMES) {
    if (name === 'back') continue;   // easeOutBack 的定义就是过冲
    const e = EASES[name];
    let prev = -Infinity;
    for (let i = 0; i <= 40; i++) {
      const v = e(i / 40);
      assert.ok(v >= prev - 1e-12, `${name} 在 ${i / 40} 处回退了：${prev} → ${v}`);
      prev = v;
    }
  }
});

test('back 的定义性特征：过冲超过 1，最后回到 1', () => {
  let mx = 0;
  for (let i = 0; i <= 100; i++) mx = Math.max(mx, EASES.back(i / 100));
  assert.ok(mx > 1.0, `back 应该过冲，实际最大值 ${mx}`);
  assert.ok(near(EASES.back(1), 1), '最后必须回到 1');
});

test('step：u<1 保持前一键的值，u==1 才跳变', () => {
  assert.equal(step(0), 0);
  assert.equal(step(0.5), 0);
  assert.equal(step(0.999), 0);
  assert.equal(step(1), 1);
  assert.equal(step(2), 1, '超过 1 也夹到 1');
  const keys = [[0, 0], [10, 100, step]];
  assert.equal(kf(9, keys), 0, '跳变前保持 0');
  assert.equal(kf(10, keys), 100, '到点才跳');
});

test('词汇表名字与实现一一对应（不能有名字指向 undefined）', () => {
  for (const name of EASE_NAMES) {
    assert.equal(typeof EASES[name], 'function', `${name} 必须是函数`);
  }
  assert.deepEqual(EASE_NAMES.sort(), ['back', 'in3', 'inout3', 'linear', 'out3', 'out4', 'step']);
});

// ─────────────────────────── compileAnimate ───────────────────────────

test('compileAnimate：beat / frame 都是 **1 起序数**', () => {
  const beats = [100, 130, 160];           // 第 1、2、3 拍
  const c = compileAnimate({
    y: [{beat: 1, v: 40}, {beat: 3, v: 0}],
    alpha: [{frame: 1, v: 0}, {frame: 20, v: 1}],
  }, {beats, from: 90});
  assert.equal(c.y[0][0], 100, 'beat:1 应落在 beats[0]');
  assert.equal(c.y[1][0], 160, 'beat:3 应落在 beats[2]');
  assert.equal(c.alpha[0][0], 90, 'frame:1 应落在节点第一帧（from）');
  assert.equal(c.alpha[1][0], 109, 'frame:20 应是 from + 19');
});

test('compileAnimate：没写 animate / 空对象都返回 null（走快路径）', () => {
  assert.equal(compileAnimate(undefined, {from: 1}), null);
  assert.equal(compileAnimate(null, {from: 1}), null);
  assert.equal(compileAnimate({}, {from: 1}), null);
});

test('compileAnimate：缓动名编译成函数；不写则 null（等于线性）', () => {
  const c = compileAnimate({
    y: [{frame: 1, v: 0}, {frame: 10, v: 1, ease: 'out3'}, {frame: 20, v: 2}],
  }, {from: 1});
  assert.equal(c.y[0][2], null);
  assert.equal(c.y[1][2], EASES.out3);
  assert.equal(c.y[2][2], null);
});

test('compileAnimate：beat 超出实际拍数时**抛出并说出实际拍数**（防御，校验期应已拦）', () => {
  const beats = [100, 130];
  assert.throws(
    () => compileAnimate({y: [{beat: 5, v: 0}]}, {beats, from: 1}),
    /只有 2 拍/,
    '报错必须带上实际拍数，否则改不对',
  );
});

test('compileAnimate：没有 beats 时用 beat 锚点会抛错（SCENE_ANIM_NO_BEATS 的运行期兜底）', () => {
  assert.throws(() => compileAnimate({y: [{beat: 1, v: 0}]}, {from: 1}), /只有 0 拍/);
});

// ─────────────────────────── evalAnimate / mergeAnimate ───────────────────────────

test('evalAnimate：单键等于常量，多键按帧变化', () => {
  const c = compileAnimate({y: [{frame: 1, v: 7}]}, {from: 1});
  assert.deepEqual(evalAnimate(c, 1), {y: 7});
  assert.deepEqual(evalAnimate(c, 999), {y: 7}, '单键在任何帧都是常量');

  const c2 = compileAnimate({y: [{frame: 1, v: 0}, {frame: 11, v: 100}]}, {from: 1});
  assert.deepEqual(evalAnimate(c2, 1), {y: 0});
  assert.deepEqual(evalAnimate(c2, 6), {y: 50});
  assert.deepEqual(evalAnimate(c2, 11), {y: 100});
});

test('evalAnimate：无编译结果时返回 null（不是空对象，便于调用方判快路径）', () => {
  assert.equal(evalAnimate(null, 1), null);
});

test('mergeAnimate：**没有 animate 时返回原对象本身**（不分配，保住快路径）', () => {
  const tr = {x: 1, y: 2};
  assert.equal(mergeAnimate(tr, null, 5), tr, '必须是同一个引用，不是拷贝');
  assert.equal(mergeAnimate(undefined, null, 5), null);
});

test('mergeAnimate：animate 覆盖同名属性，未动画的属性保留', () => {
  const tr = {x: 5, scale: 1.2, blend: 'screen'};
  const c = compileAnimate({y: [{frame: 1, v: 0}, {frame: 11, v: 100}]}, {from: 1});
  const m = mergeAnimate(tr, c, 6);
  assert.equal(m.x, 5, '未动画的属性要保留');
  assert.equal(m.scale, 1.2);
  assert.equal(m.blend, 'screen');
  assert.equal(m.y, 50, '动画属性生效');
  assert.notEqual(m, tr, '有 animate 时必须产生新对象，不能改到原 transform');
});

test('纯度：同输入求值两次逐位相同（不变量「第 N 帧只依赖 N」的前提）', () => {
  const c = compileAnimate({
    y: [{beat: 1, v: 0}, {beat: 2, v: 100, ease: 'out4'}],
    alpha: [{frame: 3, v: 0}, {frame: 30, v: 1}],
  }, {beats: [10, 40], from: 10});
  for (const n of [1, 10, 25, 40, 100]) {
    const a = mergeAnimate({x: 1}, c, n);
    const b = mergeAnimate({x: 1}, c, n);
    assert.deepEqual(a, b);
  }
});

// ─────────────────────────── 与 transform 的字段一致性 ───────────────────────────

test('可动画属性集合与 transform 一一对应（不引入新概念）', () => {
  assert.deepEqual(ANIM_PROPS, ['x', 'y', 'scale', 'rotate', 'alpha']);
});

// ─────────────────────────── contract 形状校验（负面对照，每个码一条） ───────────────────────────

const codesOf = (animate, transform) => validateAnimate(animate, transform).map((e) => e.code);

test('SCENE_ANIM_SHAPE：animate 不是对象 / 是空对象 / 值不是非空数组', () => {
  assert.deepEqual(codesOf('nope'), ['SCENE_ANIM_SHAPE']);
  assert.deepEqual(codesOf(null), ['SCENE_ANIM_SHAPE']);
  assert.deepEqual(codesOf([]), ['SCENE_ANIM_SHAPE']);
  assert.deepEqual(codesOf({}), ['SCENE_ANIM_SHAPE']);
  assert.deepEqual(codesOf({y: []}), ['SCENE_ANIM_SHAPE']);
  assert.deepEqual(codesOf({y: 'x'}), ['SCENE_ANIM_SHAPE']);
});

test('SCENE_ANIM_PROP：未知属性，且 hint 要列出可用属性', () => {
  const errs = validateAnimate({z: [{frame: 1, v: 0}]});
  assert.deepEqual(errs.map((e) => e.code), ['SCENE_ANIM_PROP']);
  for (const p of ANIM_PROPS) assert.ok(errs[0].hint.includes(p), `hint 应列出 ${p}`);
});

test('SCENE_ANIM_KEY：缺 v / beat 与 frame 都给 / 都不给 / 不是对象 / 非正整数', () => {
  assert.deepEqual(codesOf({y: [{frame: 1}]}), ['SCENE_ANIM_KEY']);
  assert.deepEqual(codesOf({y: [{frame: 1, beat: 1, v: 0}]}), ['SCENE_ANIM_KEY']);
  assert.deepEqual(codesOf({y: [{v: 0}]}), ['SCENE_ANIM_KEY']);
  assert.deepEqual(codesOf({y: ['x']}), ['SCENE_ANIM_KEY']);
  assert.deepEqual(codesOf({y: [{frame: 0, v: 0}]}), ['SCENE_ANIM_KEY']);
  assert.deepEqual(codesOf({y: [{frame: 1.5, v: 0}]}), ['SCENE_ANIM_KEY']);
});

test('SCENE_ANIM_KEY：同一属性内**不允许混用 beat 与 frame**', () => {
  const errs = validateAnimate({y: [{beat: 1, v: 0}, {frame: 5, v: 10}]});
  assert.deepEqual(errs.map((e) => e.code), ['SCENE_ANIM_KEY']);
  assert.ok(/混用/.test(errs[0].message), '消息要说清是混用时间基');
});

test('SCENE_ANIM_EASE：未知缓动，且 hint 要列出全部可用名', () => {
  const errs = validateAnimate({y: [{frame: 1, v: 0}, {frame: 2, v: 1, ease: 'bounce'}]});
  assert.deepEqual(errs.map((e) => e.code), ['SCENE_ANIM_EASE']);
  for (const n of EASE_NAMES) assert.ok(errs[0].hint.includes(n), `hint 应列出 ${n}`);
});

test('SCENE_ANIM_ORDER：时间必须严格递增（重复也不行）', () => {
  assert.deepEqual(codesOf({y: [{frame: 10, v: 0}, {frame: 5, v: 1}]}), ['SCENE_ANIM_ORDER']);
  assert.deepEqual(codesOf({y: [{frame: 5, v: 0}, {frame: 5, v: 1}]}), ['SCENE_ANIM_ORDER']);
});

test('SCENE_ANIM_CONFLICT：同名属性同时出现在 transform 与 animate', () => {
  const errs = validateAnimate({y: [{frame: 1, v: 0}]}, {y: 5});
  assert.deepEqual(errs.map((e) => e.code), ['SCENE_ANIM_CONFLICT']);
  assert.ok(errs[0].hint.includes('二选一'), 'hint 要说清出路');
  // 不同属性则不应报冲突
  assert.deepEqual(codesOf({y: [{frame: 1, v: 0}]}, {x: 5}), []);
});

test('SCENE_ANIM_VALUE：alpha 越界、scale ≤ 0', () => {
  assert.deepEqual(codesOf({alpha: [{frame: 1, v: 1.5}]}), ['SCENE_ANIM_VALUE']);
  assert.deepEqual(codesOf({alpha: [{frame: 1, v: -0.1}]}), ['SCENE_ANIM_VALUE']);
  assert.deepEqual(codesOf({scale: [{frame: 1, v: 0}]}), ['SCENE_ANIM_VALUE']);
  assert.deepEqual(codesOf({alpha: [{frame: 1, v: 0}, {frame: 2, v: 1}]}), []);
});

test('交叉一致性：contract 的缓动名 与 runtime 的实现 **一一对应**（不能漂移）', () => {
  assert.deepEqual(EASE_NAMES.slice().sort(), Object.keys(EASES).sort());
});

// ─────────────────────────── 运行期两条（需要节拍表） ───────────────────────────

test('SCENE_ANIM_NO_BEATS：手写镜头没声明 beats 却用 beat 锚点 ⇒ 报错并给出两条出路', () => {
  setShots([{start: 1, draw() {}, animate: {y: [{beat: 1, v: 0}]}}]);
  try {
    bindShots([{start: 1, draw() {}, animate: {y: [{beat: 1, v: 0}]}}], 60);
    assert.fail('应当抛错');
  } catch (e) {
    assert.equal(e.code, 'SCENE_ANIM_NO_BEATS');
    assert.ok(/frame/.test(e.hint) && /beats/.test(e.hint), 'hint 要给两条出路');
  }
});

test('SCENE_ANIM_RANGE：beat 超出实际拍数 ⇒ 报错并说出**实际几拍**', () => {
  try {
    bindShots([{start: 1, draw() {}, beats: [10, 20], animate: {y: [{beat: 5, v: 0}]}}], 60);
    assert.fail('应当抛错');
  } catch (e) {
    assert.equal(e.code, 'SCENE_ANIM_RANGE');
    assert.ok(/只有 2 拍/.test(e.message), '报错必须带上实际拍数，否则 AI 改不对');
    assert.ok(/1–2/.test(e.hint), 'hint 要给出合法拍号范围');
  }
});

// ─────────────────────────── §10.4 改解说词后 beat 锚点仍对齐 ───────────────────────────

test('§10.4 改解说词后 **beat 锚点仍对齐**，而 frame 锚点不跟随（这是 beat 时间基的全部意义）', () => {
  // 两句**起点相同、长度不同**的解说词：节拍表会因此重排（staggerFrames 有压缩路径），
  // 所以 beat 锚点的绝对帧会变，而 frame 锚点（相对节点起点）不变。
  const mkTl = (to) => {
    const from = 1;                                  // 从第 1 帧起，单镜头覆盖全片
    const step = Math.floor((to - from) / 3);
    const subs = [0, 1, 2].map((i) => ({
      from: from + i * step, to: from + i * step + step - 10, text: '块' + (i + 1),
    }));
    return {
      fps: 30, total_frames: 900,
      chapters: [{n: 1, title: '一章', from}],
      sentences: [{id: 'S01', chapter: 1, from, to, text: '一句话'}],
      subs,
    };
  };
  // 5 个要点 > 3 个字幕块 ⇒ 走"补齐 + 压缩"路径，节拍表与句子长度相关
  const items = ['a', 'b', 'c', 'd', 'e'].map((t) => ({t}));
  const mkScene = (anim) => ({shots: [{type: 'bullets', at: 'S01', heading: 'h', items, animate: anim}]});

  const run = (tl, anim) => {
    setTimeline(tl);
    const declared = compileScene(mkScene(anim), tl);
    bindShots(declared, tl.total_frames);
    const s = shots()[0];
    return {beats: s.beats, anchor: s.anim.y[1][0]};
  };

  const beatAnim = {y: [{beat: 1, v: 0}, {beat: 2, v: 100}]};
  const a = run(mkTl(150), beatAnim);      // 短句 ⇒ 节拍被压缩
  const b = run(mkTl(600), beatAnim);      // 长句 ⇒ 不压缩

  assert.notDeepEqual(a.beats, b.beats, '句子长度变了，节拍表应当重排（前提成立才谈得上"跟随"）');
  assert.notEqual(a.anchor, b.anchor, 'beat 锚点必须**跟着节拍移动**');
  assert.equal(a.anchor, a.beats[1], '且它精确落在第 2 拍上');
  assert.equal(b.anchor, b.beats[1]);

  // 负面对照：frame 锚点是"节点内第几帧"，同一起点下**不随时间轴长度变化**
  const frameAnim = {y: [{frame: 1, v: 0}, {frame: 31, v: 100}]};
  const fa = run(mkTl(150), frameAnim);
  const fb = run(mkTl(600), frameAnim);
  assert.equal(fa.anchor, fb.anchor, 'frame 锚点不该跟随（起点相同）');
  assert.equal(fa.anchor, 31, 'frame:31 ⇒ start(1) + 30');
});
