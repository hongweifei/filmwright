// 容器镜头 `layers`：并发多层的语义与校验。
//
// 设计见 docs/design/TODO.md §3 阶段 ②。要点：
//   · 层 = 一次**模板调用**（content），但**不带 at**（位置由层自己的 from/to 决定）
//   · z 序：数值大在上；不写则按声明顺序（后面的在上）
//   · 时间窗：from/to 是相对本镜头起点的偏移（1 起）；窗口外的帧不画它，也不报错
//   · 每层有自己的 transform 与 animate（**复用阶段 ① 的同一套机制**）
//   · **不写 layers 的镜头像素完全不变**（快路径）
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateScene, validateLayers, CONTAINER_TYPES, TEMPLATE_TYPES, SHOT_TYPES} from '../src/contract/scene.js';
import {setTimeline} from '../src/contract/timeline.js';
import {compileScene} from '../src/runtime/scene/templates.js';

const TL = {
  fps: 30, total_frames: 600,
  chapters: [{n: 1, title: '一章', from: 1}],
  sentences: [{id: 'S01', chapter: 1, from: 1, to: 200, text: '一句话'}],
  subs: [{from: 1, to: 100, text: '块1'}, {from: 110, to: 200, text: '块2'}],
};
setTimeline(TL);

const vScene = (shot) => validateScene(
  {shots: [shot]}, {timeline: TL, assetNames: ['a'], clipNames: new Set(['broll'])});

const codes = (shot) => vScene(shot).errors.map((e) => e.code);

// ─────────────────────── 类型分层：容器不是模板 ───────────────────────

test('容器与模板在契约里是分开的两类（「N 类模板」的判据因此仍成立）', () => {
  assert.deepEqual(CONTAINER_TYPES, ['layers']);
  assert.ok(SHOT_TYPES.includes('layers'), '容器也要在 SHOT_TYPES 里，否则校验认不出');
  assert.ok(!TEMPLATE_TYPES.includes('layers'), '容器不是模板');
  assert.equal(TEMPLATE_TYPES.length, 16, '模板仍是 16 类');
  assert.equal(SHOT_TYPES.length, 17, 'SHOT_TYPES = 16 模板 + 1 容器');
});

// ─────────────────────── 校验：每个错误码一条负面对照 ───────────────────────

test('合法的最小容器镜头通过校验', () => {
  assert.deepEqual(codes({
    type: 'layers', at: 'S01',
    layers: [{content: {type: 'title', title: 'x'}}],
  }), []);
});

test('SCENE_LAYER_SHAPE：layers 不是数组 / 空数组 / 层不是对象 / z 不是整数', () => {
  assert.ok(codes({type: 'layers', at: 1, layers: []}).includes('SCENE_LAYER_SHAPE'));
  assert.ok(codes({type: 'layers', at: 1, layers: 'x'}).includes('SCENE_LAYER_SHAPE'));
  assert.ok(codes({type: 'layers', at: 1, layers: [1]}).includes('SCENE_LAYER_SHAPE'));
  const zErr = validateLayers({layers: [{content: {type: 'title', title: 'x'}, z: 1.5}]});
  assert.ok(zErr.some((e) => e.code === 'SCENE_LAYER_SHAPE' && /z/.test(e.path)));
});

test('SCENE_LAYER_CONTENT：缺 content / content 不是对象 / 未知类型 / **content 里写了 at**', () => {
  const run = (layer) => validateLayers({layers: [layer]}).map((e) => e.code);
  assert.ok(run({z: 1}).includes('SCENE_LAYER_CONTENT'));
  assert.ok(run({content: 'x'}).includes('SCENE_LAYER_CONTENT'));
  assert.ok(run({content: {type: 'nope'}}).includes('SCENE_LAYER_CONTENT'));

  // 这条最重要：层内容里写 at 是**坐标系统混用**，必须报错并指出改成 from/to
  const errs = validateLayers({layers: [{content: {type: 'title', at: 'S01', title: 'x'}}]});
  const atErr = errs.find((e) => /content\.at/.test(e.path));
  assert.ok(atErr, '必须报 content.at');
  assert.equal(atErr.code, 'SCENE_LAYER_CONTENT');
  assert.ok(/from\/to/.test(atErr.hint), 'hint 要说清改成 from/to');
});

test('SCENE_LAYER_CONTENT 的 hint 要列出全部**可用模板**（不含容器自己）', () => {
  const errs = validateLayers({layers: [{content: {type: 'nope'}}]});
  const e = errs.find((x) => /content\.type/.test(x.path));
  for (const t of TEMPLATE_TYPES) assert.ok(e.hint.includes(t), `hint 应列出 ${t}`);
  assert.ok(!/layers/.test(e.hint), 'hint 不该把容器列成可用内容');
});

test('SCENE_LAYER_NEST：层里不能再放容器（v1 不开嵌套）', () => {
  const errs = validateLayers({layers: [{content: {type: 'layers'}}]});
  assert.deepEqual(errs.map((e) => e.code), ['SCENE_LAYER_NEST']);
});

test('SCENE_LAYER_RANGE：from/to 必须 ≥1 整数；to < from 是空窗口', () => {
  const run = (layer) => validateLayers({layers: [layer]}).map((e) => e.code);
  const c = {type: 'title', title: 'x'};
  assert.ok(run({content: c, from: 0}).includes('SCENE_LAYER_RANGE'));
  assert.ok(run({content: c, to: 1.5}).includes('SCENE_LAYER_RANGE'));
  assert.ok(run({content: c, from: 50, to: 10}).includes('SCENE_LAYER_RANGE'));
  assert.deepEqual(run({content: c, from: 10, to: 10}), [], '单帧窗口是合法的');
});

test('层支持自己的 transform 与 animate，且用**同一套**校验', () => {
  assert.deepEqual(validateLayers({
    layers: [{content: {type: 'title', title: 'x'}, transform: {x: 10},
      animate: {y: [{frame: 1, v: 0}, {frame: 20, v: 30}]}}],
  }), []);
  // 形状错要走 SCENE_ANIM_*
  const errs = validateLayers({layers: [{content: {type: 'title', title: 'x'}, animate: {z: [{frame: 1, v: 0}]}}]});
  assert.deepEqual(errs.map((e) => e.code), ['SCENE_ANIM_PROP']);
  // transform 形状错要走 SCENE_LAYER_SHAPE
  const e2 = validateLayers({layers: [{content: {type: 'title', title: 'x'}, transform: 'x'}]});
  assert.deepEqual(e2.map((e) => e.code), ['SCENE_LAYER_SHAPE']);
});

test('未知字段走通用机制（键级检查由 SHAPE_KEYS.layer 提供）', () => {
  const errs = validateLayers({layers: [{content: {type: 'title', title: 'x'}, nope: 1}]});
  // validateLayers 不管键级，通用机制（validateArr）会报 —— 这里直接走完整场景校验
  assert.ok(codes({type: 'layers', at: 1, layers: [{content: {type: 'title', title: 'x'}, nope: 1}]})
    .includes('SCENE_UNKNOWN_FIELD'));
});

test('SCENE_TOO_MANY：并发层有上限（每层都是一次完整绘制）', () => {
  const many = Array.from({length: 9}, () => ({content: {type: 'title', title: 'x'}}));
  assert.ok(codes({type: 'layers', at: 1, layers: many}).includes('SCENE_TOO_MANY'));
  const eight = Array.from({length: 8}, () => ({content: {type: 'title', title: 'x'}}));
  assert.ok(!codes({type: 'layers', at: 1, layers: eight}).includes('SCENE_TOO_MANY'));
});

// ─────────────────────── 编译：节拍归集与层内容起点 ───────────────────────

test('compileScene：容器镜头的 start 来自 at，beats 是各层节拍的**并集**（排序去重）', () => {
  const tl = {...TL};
  setTimeline(tl);
  const shots = compileScene({
    shots: [{type: 'layers', at: 'S01', layers: [
      {content: {type: 'title', title: 'a'}},
      {content: {type: 'bullets', items: [{t: 'x'}, {t: 'y'}, {t: 'z'}]}},
    ]}],
  }, tl);
  assert.equal(shots.length, 1);
  assert.equal(shots[0].start, 1, 'start 来自 at 解析');
  assert.ok(Array.isArray(shots[0].beats) && shots[0].beats.length >= 2, 'beats 应归集多个层的节拍');
  // 排序且去重
  const b = shots[0].beats;
  assert.deepEqual(b, [...new Set(b)].sort((x, y) => x - y));
});

test('compileScene：层的 from 决定其内容的绝对起点（层内容的 beats 跟着偏移）', () => {
  const tl = {...TL};
  setTimeline(tl);
  const shots = compileScene({
    shots: [{type: 'layers', at: 'S01', layers: [
      // 从镜头第 60 帧开始的层：它的 beats 应当 ≥ 60
      {content: {type: 'title', title: 'late'}, from: 60},
    ]}],
  }, tl);
  for (const be of shots[0].beats) assert.ok(be >= 60, `层的节拍应 ≥ 层的起点，收到 ${be}`);
});

test('compileScene：容器镜头也透传 animate（与普通镜头同一机制）', () => {
  const tl = {...TL};
  setTimeline(tl);
  const shots = compileScene({
    shots: [{type: 'layers', at: 1, animate: {y: [{frame: 1, v: 0}, {frame: 10, v: 5}]},
      layers: [{content: {type: 'title', title: 'x'}}]}],
  }, tl);
  assert.ok(shots[0].animate, 'animate 要透传到镜头层（否则绑定/求值链断掉）');
});
