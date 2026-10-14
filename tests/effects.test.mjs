// 效果链的契约测试：形状、词汇表边界、以及每个错误码的负面对照。
//
// 要点：
//   · 效果是**有界词汇表**（枚举类型 + 有界参数），不是任意 shader；
//   · 每条错误提示都要带**实际可用值/范围**，让 AI 拿到报错能自己改对；
//   · 参数范围不是随手定的 —— radius 上限 36 对应"小核多趟让抽头间距 ≤2px"
//     这个能保证正确性的范围（超了会振铃，实测过）。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateEffects, validateScene} from '../src/contract/scene.js';
import {EFFECT_TYPES, EFFECT_SPECS, EFFECT_CHAIN_MAX} from '../src/contract/effects.js';
import {compileEffects, isNoopEffects, evalEffects} from '../src/runtime/fx/compile.js';
import {bindShots} from '../src/runtime/stage/shots.js';

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
  // 注意别拿一个**真有效果**当"未知"的例子 —— 早先这里用的是 glow，
  // 等 glow 真做出来之后这条就变成假失败了。
  const errs = validateEffects([{type: 'sparkle', radius: 1}]);
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

test('SCENE_FX_PARAM：效果参数既不是数值也不是关键帧数组', () => {
  assert.deepEqual(codes([{type: 'blur', radius: '8'}]), ['SCENE_FX_PARAM']);
  assert.deepEqual(codes([{type: 'blur', radius: {v: 8}}]), ['SCENE_FX_PARAM']);
  assert.deepEqual(codes([{type: 'blur', radius: null}]), ['SCENE_FX_PARAM']);
});

// ─────────────────────── 三个新效果的契约 ───────────────────────

test('glow：不给参数就是一次**默认辉光**（不是空转，所以不报错）', () => {
  assert.deepEqual(codes([{type: 'glow'}]), [], '缺省值能做出像样的辉光 ⇒ 合法');
  assert.deepEqual(codes([{type: 'glow', intensity: 0.8}]), []);
  assert.deepEqual(codes([{type: 'glow', intensity: 0.8, radius: 20, threshold: 0.6}]), []);
  assert.ok(codes([{type: 'glow', intensity: 9}]).includes('SCENE_FX_RANGE'));
  assert.ok(codes([{type: 'glow', intensity: 1, threshold: 2}]).includes('SCENE_FX_RANGE'));
});

test('color：每个参数都可省，但**一个都不给等于空转** ⇒ 报错并列出可用参数', () => {
  assert.deepEqual(codes([{type: 'color', saturation: 1.2}]), [], '给一个就合法');
  assert.deepEqual(codes([{type: 'color', exposure: 1, hue: 30}]), []);
  const errs = validateEffects([{type: 'color'}]);
  assert.deepEqual(errs.map((e) => e.code), ['SCENE_FX_PARAM']);
  assert.ok(/至少/.test(errs[0].message), '消息要说清"至少要给一个"：' + errs[0].message);
  for (const k of Object.keys(EFFECT_SPECS.color.params)) {
    assert.ok(errs[0].hint.includes(k), `hint 要列出可用参数 ${k}`);
  }
});

test('vignette：必须给 amount；radius 有下界（太小会把整幅压黑）', () => {
  assert.deepEqual(codes([{type: 'vignette', amount: 0.5}]), []);
  assert.ok(codes([{type: 'vignette'}]).includes('SCENE_FX_PARAM'));
  assert.ok(codes([{type: 'vignette', amount: 0.5, radius: 0.1}]).includes('SCENE_FX_RANGE'));
  assert.deepEqual(codes([{type: 'vignette', amount: 0.5, radius: 0.2, softness: 0.01}]), []);
});

test('新效果的参数也能用关键帧（与 animate 同一套规则）', () => {
  assert.deepEqual(codes([{type: 'glow', intensity: [{beat: 1, v: 0}, {beat: 2, v: 1}]}]), []);
  assert.deepEqual(codes([{type: 'color', saturation: [{frame: 1, v: 1}, {frame: 30, v: 0}]}]), []);
  assert.deepEqual(codes([{type: 'vignette', amount: [{frame: 1, v: 0}, {frame: 20, v: 0.6}]}]), []);
});

test('缺省值要给"合理的默认效果"，**不是**直通值（这条防的是把两者搞混）', () => {
  // glow 缺省应当做出一份辉光（radius 16 / intensity 0.8），而不是什么都不做
  assert.equal(EFFECT_SPECS.glow.params.radius.def, 16);
  assert.equal(EFFECT_SPECS.glow.params.intensity.def, 0.8);
  // color 每个参数缺省都落在直通条件里 —— 所以它在 §"至少要给一个"那一条里被要求显式给参数
  for (const [k, ps] of Object.entries(EFFECT_SPECS.color.params)) {
    if (ps.def === undefined) continue;
    const cond = EFFECT_SPECS.color.noopWhen[0];
    assert.equal(ps.def, cond[k], `color.${k} 的缺省值应落在直通条件里`);
  }
});

test('noopWhen 是"任一成立即直通"（OR）—— glow 的两种情形都要被认出来', () => {
  const N = {from: 1};
  const noop = (fx) => isNoopEffects(compileEffects([fx], N), 1);
  assert.equal(noop({type: 'glow', intensity: 0}), true, 'intensity=0 ⇒ 直通');
  assert.equal(noop({type: 'glow', intensity: 0.5, radius: 0}), true, 'radius=0 也 ⇒ 直通');
  assert.equal(noop({type: 'glow', intensity: 0.5, radius: 16}), false);
  // 单元级别也验一遍契约数据本身
  assert.ok(EFFECT_SPECS.glow.noopWhen.length >= 2, 'glow 的直通条件是 OR 的两条');
});

// ─────────────────────── 效果参数的关键帧（与 animate 同一套规则）───────────────────────

test('效果参数可以是关键帧轨道（让模糊渐入）', () => {
  assert.deepEqual(codes([{type: 'blur', radius: [{beat: 1, v: 0}, {beat: 2, v: 12, ease: 'out3'}]}]), []);
  assert.deepEqual(codes([{type: 'blur', radius: [{frame: 1, v: 0}, {frame: 30, v: 20}]}]), []);
});

test('效果参数的关键帧走**同一套**规则：形状/缓动/顺序/时间基都报 SCENE_ANIM_*', () => {
  const p = (keys) => validateEffects([{type: 'blur', radius: keys}]).map((e) => e.code);
  assert.deepEqual(p([{frame: 1}]), ['SCENE_ANIM_KEY'], '缺 v');
  assert.deepEqual(p([{beat: 1, frame: 1, v: 0}]), ['SCENE_ANIM_KEY'], 'beat/frame 都给');
  assert.deepEqual(p([{beat: 1, v: 0}, {frame: 5, v: 3}]), ['SCENE_ANIM_KEY'], '混用时间基');
  assert.deepEqual(p([{frame: 1, v: 0}, {frame: 2, v: 1, ease: 'bounce'}]), ['SCENE_ANIM_EASE']);
  assert.deepEqual(p([{frame: 5, v: 0}, {frame: 5, v: 1}]), ['SCENE_ANIM_ORDER']);
  assert.deepEqual(p([]), ['SCENE_ANIM_SHAPE'], '空数组');
  // 出错路径要精确到那条轨道，便于定位
  const err = validateEffects([{type: 'blur', radius: [{frame: 0, v: 0}]}])[0];
  assert.ok(/effects\[0\]\.radius\[0\]\.frame/.test(err.path), '路径要精确：' + err.path);
});

test('效果参数的关键帧取值要**逐个**查范围（不是只看第一个）', () => {
  const errs = validateEffects([{type: 'blur', radius: [{frame: 1, v: 0}, {frame: 10, v: 999}, {frame: 20, v: 5}]}]);
  assert.deepEqual(errs.map((e) => e.code), ['SCENE_FX_RANGE']);
  assert.ok(/radius\[1\]\.v/.test(errs[0].path), '要指到越界的那一个关键帧：' + errs[0].path);
  assert.deepEqual(codes([{type: 'blur', radius: [{frame: 1, v: 0}, {frame: 10, v: 36}]}]), []);
  assert.deepEqual(codes([{type: 'blur', radius: [{frame: 1, v: -1}]}]), ['SCENE_FX_RANGE']);
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

test('compileEffects：静态参数与关键帧参数分开存（求值时按帧选）', () => {
  const c = compileEffects([{type: 'blur', radius: 7}], {from: 1});
  assert.equal(c.steps.length, 1);
  assert.equal(c.steps[0].type, 'blur');
  assert.equal(c.steps[0].static.radius, 7, '静态值进 static');
  assert.equal(c.steps[0].tracks.radius, null, '静态值没有轨道');
});

test('compileEffects + evalEffects：关键帧参数逐帧求值，端点精确', () => {
  const c = compileEffects([{type: 'blur', radius: [{frame: 1, v: 0}, {frame: 11, v: 20}]}], {from: 1});
  assert.ok(Array.isArray(c.steps[0].tracks.radius), '关键帧参数进 tracks');
  assert.equal(c.steps[0].static.radius, null);
  const at = (n) => evalEffects(c, n)[0].radius;
  assert.equal(at(1), 0, '起点精确');
  assert.equal(at(6), 10, '中点线性');
  assert.equal(at(11), 20, '终点精确');
  assert.equal(at(999), 20, '末键之后夹紧');
});

test('evalEffects：静态参数在任何帧都是同一个值', () => {
  const c = compileEffects([{type: 'blur', radius: 9}], {from: 1});
  for (const n of [1, 50, 999]) assert.equal(evalEffects(c, n)[0].radius, 9);
});

test('isNoopEffects 要**按帧**判：从 0 渐入的轨道在起点那一帧是直通的', () => {
  const c = compileEffects([{type: 'blur', radius: [{frame: 1, v: 0}, {frame: 11, v: 12}]}], {from: 1});
  assert.equal(isNoopEffects(c, 1), true, '第 1 帧 radius=0 ⇒ 直通（不该进 GPU）');
  assert.equal(isNoopEffects(c, 6), false, '第 6 帧 radius=6 ⇒ 要进 GPU');
  assert.equal(isNoopEffects(c, 11), false);
  // 纯静态的两种情形
  assert.equal(isNoopEffects(compileEffects([{type: 'blur', radius: 0}], {from: 1}), 1), true);
  assert.equal(isNoopEffects(compileEffects([{type: 'blur', radius: 5}], {from: 1}), 1), false);
});

test('isNoopEffects 是**数据驱动**的：每个效果按契约的 identity 判，不在这里写死逻辑', () => {
  const N = {from: 1};
  const noop = (fx) => isNoopEffects(compileEffects([fx], N), 1);
  // glow：intensity=0 或 radius=0 都是直通
  assert.equal(noop({type: 'glow', intensity: 0}), true);
  assert.equal(noop({type: 'glow', intensity: 0.5, radius: 0}), true);
  assert.equal(noop({type: 'glow', intensity: 0.5}), false);
  // color：全恒等值是直通（brightness/contrast/saturation=1，其余 0）
  assert.equal(noop({type: 'color', brightness: 1, contrast: 1, saturation: 1}), true);
  assert.equal(noop({type: 'color', saturation: 1.01}), false);
  assert.equal(noop({type: 'color', hue: 0.5}), false);
  // vignette：amount=0 直通
  assert.equal(noop({type: 'vignette', amount: 0}), true);
  assert.equal(noop({type: 'vignette', amount: 0.3}), false);
});

test('多效果链：任意一个不是恒等值，整链就不是直通', () => {
  const N = {from: 1};
  const c = compileEffects([
    {type: 'blur', radius: 0},                      // 直通
    {type: 'color', saturation: 1.2},               // 不直通
  ], N);
  assert.equal(isNoopEffects(c, 1), false);
  const c2 = compileEffects([{type: 'blur', radius: 0}, {type: 'vignette', amount: 0}], N);
  assert.equal(isNoopEffects(c2, 1), true, '全直通 ⇒ 不走 GPU');
});

// ─────────────────────── 效果参数的 beat 锚点（与 animate 同一套时间基）───────────────────────

test('效果参数用 beat 锚点：解析到节拍表的绝对帧（1 起序数）', () => {
  const c = compileEffects([{type: 'blur', radius: [{beat: 1, v: 0}, {beat: 2, v: 12}]}],
    {beats: [100, 130], from: 90});
  const track = c.steps[0].tracks.radius;
  assert.equal(track[0][0], 100, 'beat:1 → beats[0]');
  assert.equal(track[1][0], 130, 'beat:2 → beats[1]');
  assert.equal(evalEffects(c, 115)[0].radius, 6, '两点之间线性');
});

test('效果参数的 beat 超出实际拍数 ⇒ 绑定期报错**并说出实际几拍**', () => {
  try {
    bindShots([{start: 1, draw() {}, beats: [10, 20],
      effects: [{type: 'blur', radius: [{beat: 5, v: 1}]}]}], 60);
    assert.fail('应当抛错');
  } catch (e) {
    assert.equal(e.code, 'SCENE_ANIM_RANGE');
    assert.ok(/只有 2 拍/.test(e.message), '必须带实际拍数：' + e.message);
    assert.ok(/effects\[0\]/.test(e.message), '消息要指出是哪个效果：' + e.message);
  }
});

test('效果参数用 beat 但镜头没有节拍表 ⇒ SCENE_ANIM_NO_BEATS（给两条出路）', () => {
  try {
    bindShots([{start: 1, draw() {}, effects: [{type: 'blur', radius: [{beat: 1, v: 1}]}]}], 60);
    assert.fail('应当抛错');
  } catch (e) {
    assert.equal(e.code, 'SCENE_ANIM_NO_BEATS');
    assert.ok(/frame/.test(e.hint) && /beats/.test(e.hint));
  }
});

test('效果参数是**静态数值**时不触发那两条（没有 beat 可查）', () => {
  // 没有节拍表也能用静态参数
  const shots = bindShots([{start: 1, draw() {}, effects: [{type: 'blur', radius: 5}]}], 60);
  assert.ok(shots[0].fx, '静态度也能正常编译');
});
