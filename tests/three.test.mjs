// 声明式 3D 的契约测试：形状/相机/动画的边界，以及每个错误码的负面对照。
//
// 判据来自「有界词汇表」这条原则（与效果链同一套思路）：
//   · 形状是枚举，不认识的要报并列出可用值；
//   · 数值有范围，越界要报并带上实际范围；
//   · 动画只走关键帧轨道 —— 与 `animate` 是**同一套规则**（复用 validateKeyTrack）。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateScene, needsThree, SHOT_TYPES, TEMPLATE_TYPES, SHOT_MAXES} from '../src/contract/scene.js';
import {SHAPES, ANIM3D_PROPS, MAX_OBJECTS, LIGHT_TYPES, MAX_LIGHTS} from '../src/contract/three.js';

const tl = {
  fps: 30, total_frames: 200, chapters: [{n: 1, title: 'c', from: 1}],
  sentences: [{id: 'S01', chapter: 1, from: 1, to: 200, text: 'x'}], subs: [],
};
const codes = (shot) => validateScene({shots: [shot]}, {timeline: tl}).errors.map((e) => e.code);
const errs = (shot) => validateScene({shots: [shot]}, {timeline: tl}).errors;
const T = (extra = {}) => ({type: 'three', at: 1, objects: [{shape: 'box', size: 1.6}], ...extra});

test('合法的最小 3D 镜头通过校验', () => {
  assert.deepEqual(codes(T()), []);
  assert.deepEqual(codes(T({camera: {z: 4.2, fov: 50, lookAt: [0, 0, 0]}})), []);
  assert.deepEqual(codes(T({objects: [
    {shape: 'torus', size: 1, color: 'accent', wireframe: true, opacity: 0.5},
    {shape: 'sphere', size: 0.6, color: '#4f9dff', position: {x: 1, y: 0, z: 0}, rotate: {x: 10, y: 20, z: 0}},
  ]})), []);
});

test('SCENE_3D_SHAPE_KIND：不认识的形状，hint 要列出全部可用形状', () => {
  const e = errs(T({objects: [{shape: 'pyramid'}]}));
  assert.deepEqual(e.map((x) => x.code), ['SCENE_3D_SHAPE_KIND']);
  for (const s of SHAPES) assert.ok(e[0].hint.includes(s), `hint 应列出 ${s}`);
});

test('SCENE_3D_VALUE：size / opacity 越界都要报（并带范围）', () => {
  assert.deepEqual(codes(T({objects: [{shape: 'box', size: 99}]})), ['SCENE_3D_VALUE']);
  assert.deepEqual(codes(T({objects: [{shape: 'box', size: 0}]})), ['SCENE_3D_VALUE']);
  assert.deepEqual(codes(T({objects: [{shape: 'box', size: 1, opacity: 2}]})), ['SCENE_3D_VALUE']);
  assert.deepEqual(codes(T({objects: [{shape: 'box', size: 1, wireframe: 'yes'}]})), ['SCENE_3D_VALUE']);
  const e = errs(T({objects: [{shape: 'box', size: 1, position: {w: 1}}]}));
  assert.deepEqual(e.map((x) => x.code), ['SCENE_3D_VALUE'], '位置里写了不存在的轴');
});

test('SCENE_3D_COLOR：颜色只接受主题色名或 #rrggbb', () => {
  assert.deepEqual(codes(T({objects: [{shape: 'box', size: 1, color: 'purple'}]})), ['SCENE_3D_COLOR']);
  assert.deepEqual(codes(T({objects: [{shape: 'box', size: 1, color: '#zzz'}]})), ['SCENE_3D_COLOR']);
  assert.deepEqual(codes(T({objects: [{shape: 'box', size: 1, color: '#4f9dff'}]})), []);
});

test('SCENE_3D_CAMERA：fov 越界、lookAt 形状不对', () => {
  assert.deepEqual(codes(T({camera: {fov: 999}})), ['SCENE_3D_CAMERA']);
  assert.deepEqual(codes(T({camera: {fov: 0}})), ['SCENE_3D_CAMERA']);
  assert.deepEqual(codes(T({camera: {z: '4'}})), ['SCENE_3D_CAMERA']);
  assert.deepEqual(codes(T({camera: {lookAt: [0, 0]}})), ['SCENE_3D_CAMERA']);
  assert.deepEqual(codes(T({camera: {zoom: 2}})), ['SCENE_3D_CAMERA']);
});

test('SCENE_3D_OBJECTS：超上限要报；空数组由通用字段校验报（不重复报）', () => {
  const many = Array.from({length: MAX_OBJECTS + 1}, () => ({shape: 'box', size: 1}));
  assert.ok(codes(T({objects: many})).includes('SCENE_3D_OBJECTS'));
  // 空数组：通用那条报，且 hint 现在**非空**（以前是空字符串，等于让模型自己猜）
  const e = errs(T({objects: []}));
  assert.deepEqual(e.map((x) => x.code), ['SCENE_BAD_FIELD'], '只报一条，不重复');
  assert.ok(e[0].hint && e[0].hint.length > 8, 'hint 要给出可用形状的示例');
  assert.equal(SHOT_MAXES.three.objects, MAX_OBJECTS, '契约上限与词汇表要一致（单一来源）');
});

test('SCENE_3D_ANIM：3D 动画只支持它自己的属性集，hint 要列出', () => {
  const e = errs(T({objects: [{shape: 'box', size: 1, animate: {wobble: [{frame: 1, v: 1}]}}]}));
  assert.deepEqual(e.map((x) => x.code), ['SCENE_3D_ANIM']);
  for (const p of ANIM3D_PROPS) assert.ok(e[0].hint.includes(p), `hint 应列出 ${p}`);
});

test('3D 动画走**同一套**关键帧规则（beat/frame/缓动/顺序都由 validateKeyTrack 管）', () => {
  const p = (anim) => codes(T({objects: [{shape: 'box', size: 1, animate: anim}]}));
  assert.deepEqual(p({ry: [{frame: 1, v: 0}, {frame: 60, v: 180}]}), [], 'frame 锚点');
  assert.deepEqual(p({ry: [{beat: 1, v: 0}, {beat: 2, v: 90, ease: 'out3'}]}), [], 'beat 锚点 + 缓动');
  assert.deepEqual(p({ry: [{frame: 1}]}), ['SCENE_ANIM_KEY'], '缺 v');
  assert.deepEqual(p({ry: [{beat: 1, frame: 1, v: 0}]}), ['SCENE_ANIM_KEY'], 'beat/frame 都给');
  assert.deepEqual(p({ry: [{frame: 1, v: 0}, {frame: 2, v: 1, ease: 'bounce'}]}), ['SCENE_ANIM_EASE']);
  assert.deepEqual(p({ry: [{frame: 5, v: 0}, {frame: 5, v: 1}]}), ['SCENE_ANIM_ORDER']);
  assert.deepEqual(p({scale: [{frame: 1, v: 0}]}), ['SCENE_3D_ANIM'], 'scale 必须 > 0');
});

test('通用字段不该被 3D 校验误报（踩过：type/at 被当成未知字段）', () => {
  // 这条是回归：第一版 validate3D 把 type/at 也当未知字段，于是所有合法写法都过不了
  assert.deepEqual(codes(T({transform: {alpha: 0.9}, animate: {y: [{frame: 1, v: 0}]}})), []);
  assert.deepEqual(codes(T({effects: [{type: 'blur', radius: 4}]})), []);
});

test('类型注册表：three 是**模板**（不是容器），且总数对得上', () => {
  assert.ok(SHOT_TYPES.includes('three'));
  assert.ok(TEMPLATE_TYPES.includes('three'));
  assert.equal(TEMPLATE_TYPES.length, 17);
  assert.equal(SHOT_TYPES.length, 18);
});

test('needsThree：只在真有 3D 时才为真（决定要不要加载 2.2MB 的 three）', () => {
  assert.equal(needsThree({shots: [{type: 'title', at: 1, title: 't'}]}), false);
  assert.equal(needsThree({shots: [T()]}), true);
  // 图层容器里的 3D 也要被发现
  assert.equal(needsThree({shots: [{type: 'layers', at: 1,
    layers: [{content: {type: 'three', objects: [{shape: 'box'}]}}]}]}), true);
  // 只声明了别的层，不算
  assert.equal(needsThree({shots: [{type: 'layers', at: 1,
    layers: [{content: {type: 'title', title: 'x'}}]}]}), false);
  // comps 里复用的子合成也要算
  assert.equal(needsThree({shots: [{type: 'comp', at: 1, comp: 'sub'}],
    comps: {sub: {shots: [T()]}}}), true);
  assert.equal(needsThree(null), false);
});

// ─────────────────────── 光照（有 lights 才切到受光材质）───────────────────────

test('lights：三种光源的合法写法都通过，缺位置/多给位置都要报', () => {
  assert.deepEqual(codes(T({lights: [{type: 'ambient', intensity: 1.2}]})), []);
  assert.deepEqual(codes(T({lights: [{type: 'directional', intensity: 2, position: [3, 4, 5]}]})), []);
  assert.deepEqual(codes(T({lights: [{type: 'point', intensity: 3, position: [0, 0, 2]}]})), []);
  // ambient 没有方向 ⇒ 不需要也不该给 position
  assert.deepEqual(codes(T({lights: [{type: 'ambient', position: [1, 2, 3]}]})), ['SCENE_3D_LIGHT']);
  // 另两种必须有 position
  assert.deepEqual(codes(T({lights: [{type: 'directional'}]})), ['SCENE_3D_LIGHT']);
  assert.deepEqual(codes(T({lights: [{type: 'point', position: [1, 2]}]})), ['SCENE_3D_LIGHT']);
});

test('SCENE_3D_LIGHT：不认识的类型、越界强度、未知字段、空数组、超上限', () => {
  const e = errs(T({lights: [{type: 'spot', position: [1, 2, 3]}]}));
  assert.deepEqual(e.map((x) => x.code), ['SCENE_3D_LIGHT']);
  for (const t of LIGHT_TYPES) assert.ok(e[0].hint.includes(t), `hint 要列出 ${t}`);
  assert.deepEqual(codes(T({lights: [{type: 'ambient', intensity: 99}]})), ['SCENE_3D_LIGHT']);
  assert.deepEqual(codes(T({lights: [{type: 'ambient', intensity: '亮'}]})), ['SCENE_3D_LIGHT']);
  assert.deepEqual(codes(T({lights: [{type: 'ambient', size: 2}]})), ['SCENE_3D_LIGHT']);
  assert.deepEqual(codes(T({lights: []})), ['SCENE_3D_LIGHT'], '空数组要报（不想打光就别写这个字段）');
  const many = Array.from({length: MAX_LIGHTS + 1}, () => ({type: 'ambient'}));
  assert.deepEqual(codes(T({lights: many})), ['SCENE_3D_LIGHT']);
});

test('灯的颜色与对象的颜色走同一套规则（主题色名或 #rrggbb）', () => {
  assert.deepEqual(codes(T({lights: [{type: 'ambient', color: 'accent'}]})), []);
  assert.deepEqual(codes(T({lights: [{type: 'ambient', color: '#ff8800'}]})), []);
  assert.deepEqual(codes(T({lights: [{type: 'ambient', color: 'warm'}]})), ['SCENE_3D_COLOR']);
});

test('对象的 material 可覆盖默认（basic / standard），写别的要报', () => {
  assert.deepEqual(codes(T({objects: [{shape: 'box', material: 'basic'}]})), []);
  assert.deepEqual(codes(T({objects: [{shape: 'box', material: 'standard'}]})), []);
  assert.deepEqual(codes(T({objects: [{shape: 'box', material: 'matte'}]})), ['SCENE_3D_VALUE']);
});

test('不给 lights 时行为**完全不变**（老项目逐位不受影响）', () => {
  // 这条是"加光是一个显式动作"的契约层保证：
  // 没有 lights 字段 ⇒ 用无光照材质 ⇒ 与加光照之前逐位相同。
  assert.deepEqual(codes(T()), [], '不写 lights 当然合法');
  // 而"有 lights"是另一个世界（渲染期用受光材质），由 verify-three 的第七节验
  assert.deepEqual(codes(T({lights: [{type: 'ambient'}]})), []);
});
