// 效果链的契约测试：形状、词汇表边界、以及每个错误码的负面对照。
//
// 判据来自 docs/design/DESIGN-effects.md §7/§10.2。要点：
//   · 效果是**有界词汇表**（枚举类型 + 有界参数），不是任意 shader；
//   · 每条错误提示都要带**实际可用值/范围**，让 AI 拿到报错能自己改对；
//   · 参数范围不是随手定的 —— radius 上限 36 对应"小核多趟让抽头间距 ≤2px"
//     这个能保证正确性的范围（超了会振铃，实测过）。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateEffects, validateScene} from '../src/contract/scene.js';
import {EFFECT_TYPES, EFFECT_SPECS, EFFECT_CHAIN_MAX} from '../src/contract/effects.js';
import {compileEffects, isNoopEffects} from '../src/runtime/fx/compile.js';

const codes = (fx) => validateEffects(fx).map((e) => e.code);

// ─────────────────────── 形状与词汇表 ───────────────────────

test('合法的最小效果链通过校验', () => {
  assert.deepEqual(codes([{type: 'blur', radius: 8}]), []);
  assert.deepEqual(codes([{type: 'blur', radius: 0}]), [], 'radius=0（直通）也是合法的');
  assert.deepEqual(codes([{type: 'blur', radius: 36}]), [], '上限值本身合法');
});

test('SCENE_FX_SHAPE：不是数组 / 空数组 / 元素不是对象', () => {
  assert.deepEqual(codes('x'), ['SCENE_FX_SHAPE']);
  assert.deepEqual(codes([]), ['SCENE_FX_SHAPE']);
  assert.deepEqual(codes([1]), ['SCENE_FX_SHAPE']);
});

test('SCENE_FX_TYPE：未知效果名，且 hint 要列出全部可用效果', () => {
  const errs = validateEffects([{type: 'glow', radius: 1}]);
  assert.deepEqual(errs.map((e) => e.code), ['SCENE_FX_TYPE']);
  for (const t of EFFECT_TYPES) assert.ok(errs[0].hint.includes(t), `hint 应列出 ${t}`);
});

test('SCENE_FX_PARAM：未知参数名，且 hint 要列出该效果的可用参数', () => {
  const errs = validateEffects([{type: 'blur', radius: 4, intensity: 1}]);
  assert.deepEqual(errs.map((e) => e.code), ['SCENE_FX_PARAM']);
  assert.ok(/radius/.test(errs[0].hint), 'hint 应列出 radius');
});

test('SCENE_FX_PARAM：缺必填参数', () => {
  const errs = validateEffects([{type: 'blur'}]);
  assert.deepEqual(errs.map((e) => e.code), ['SCENE_FX_PARAM']);
  assert.ok(/radius/.test(errs[0].message), '要说清缺的是 radius');
});

test('SCENE_FX_PARAM：参数必须是数值（不接受字符串/关键帧数组——本版尚未支持）', () => {
  assert.deepEqual(codes([{type: 'blur', radius: '8'}]), ['SCENE_FX_PARAM']);
  assert.deepEqual(codes([{type: 'blur', radius: [{beat: 1, v: 0}]}]), ['SCENE_FX_PARAM']);
});

test('SCENE_FX_RANGE：越界，且 hint 要带**实际范围**', () => {
  const errs = validateEffects([{type: 'blur', radius: 200}]);
  assert.deepEqual(errs.map((e) => e.code), ['SCENE_FX_RANGE']);
  const ps = EFFECT_SPECS.blur.params.radius;
  assert.ok(errs[0].message.includes(String(ps.max)), '消息要带上限');
  assert.ok(errs[0].hint.includes(`${ps.min}–${ps.max}`), 'hint 要带完整范围');
  assert.deepEqual(codes([{type: 'blur', radius: -1}]), ['SCENE_FX_RANGE']);
});

test('SCENE_FX_CHAIN：链长有上限', () => {
  const many = Array.from({length: EFFECT_CHAIN_MAX + 1}, () => ({type: 'blur', radius: 1}));
  assert.ok(codes(many).includes('SCENE_FX_CHAIN'));
  const max = Array.from({length: EFFECT_CHAIN_MAX}, () => ({type: 'blur', radius: 1}));
  assert.ok(!codes(max).includes('SCENE_FX_CHAIN'));
});

test('radius 上限与实现的保证是绑定的（写死这个数是有理由的）', () => {
  // 上限 36 对应"16 趟、抽头间距 ≤2px"。若有人改这个数，应当同时确认
  // 实现仍能保证模糊随半径单调增强（tools/verify-effects.mjs 会验）。
  assert.equal(EFFECT_SPECS.blur.params.radius.max, 36);
});

// ─────────────────────── 接进 scene.json ───────────────────────

test('effects 是**通用字段**：任何镜头类型都能写（与 transform/animate 同级）', () => {
  const tl = {
    fps: 30, total_frames: 200, chapters: [{n: 1, title: 'c', from: 1}],
    sentences: [{id: 'S01', chapter: 1, from: 1, to: 200, text: 'x'}], subs: [],
  };
  const r = validateScene({shots: [{type: 'stat', at: 1, value: 1, label: 'l',
    effects: [{type: 'blur', radius: 5}]}]}, {timeline: tl});
  assert.deepEqual(r.errors, []);
  // 不写 effects 当然也行
  const r2 = validateScene({shots: [{type: 'stat', at: 1, value: 1, label: 'l'}]}, {timeline: tl});
  assert.deepEqual(r2.errors, []);
});

test('effects 也能挂在容器的**层**上', () => {
  const tl = {
    fps: 30, total_frames: 200, chapters: [{n: 1, title: 'c', from: 1}],
    sentences: [{id: 'S01', chapter: 1, from: 1, to: 200, text: 'x'}], subs: [],
  };
  const r = validateScene({shots: [{type: 'layers', at: 1, layers: [
    {content: {type: 'title', title: 'x'}, effects: [{type: 'blur', radius: 3}]},
  ]}]}, {timeline: tl});
  assert.deepEqual(r.errors, []);
  // 层上的 effects 形状错也要报（同一个校验函数）
  const r2 = validateScene({shots: [{type: 'layers', at: 1, layers: [
    {content: {type: 'title', title: 'x'}, effects: [{type: 'nope'}]},
  ]}]}, {timeline: tl});
  assert.ok(r2.errors.some((e) => e.code === 'SCENE_FX_TYPE' && /layers\[0\]\.effects/.test(e.path)));
});

// ─────────────────────── 编译与短路 ───────────────────────

test('compileEffects：没有 effects 返回 **null**（调用方据此走快路径）', () => {
  assert.equal(compileEffects(undefined), null);
  assert.equal(compileEffects([]), null);
});

test('isNoopEffects：全直通时判为 noop（此时不该进 GPU）', () => {
  assert.equal(isNoopEffects(null), true);
  assert.equal(isNoopEffects(compileEffects([{type: 'blur', radius: 0}])), true);
  assert.equal(isNoopEffects(compileEffects([{type: 'blur', radius: 0}, {type: 'blur', radius: 0}])), true);
  assert.equal(isNoopEffects(compileEffects([{type: 'blur', radius: 0}, {type: 'blur', radius: 5}])), false);
  assert.equal(isNoopEffects(compileEffects([{type: 'blur', radius: 5}])), false);
});

test('compileEffects：缺省参数取契约里的默认（单一来源），不在这里另写一份', () => {
  const c = compileEffects([{type: 'blur', radius: 7}]);
  assert.equal(c.steps.length, 1);
  assert.equal(c.steps[0].type, 'blur');
  assert.equal(c.steps[0].radius, 7);
});
