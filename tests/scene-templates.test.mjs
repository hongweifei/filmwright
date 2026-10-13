// 模板注册表与规格层的契约测试：两层各自演进时，这里钉住它们不许漂移。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SHOT_TYPES} from '../src/contract/scene.js';
import {TEMPLATES, compileScene} from '../src/runtime/scene/templates.js';

test('TEMPLATES 的键与 SHOT_TYPES 严格一致（多一个少一个都算错）', () => {
  assert.deepEqual(Object.keys(TEMPLATES).sort(), [...SHOT_TYPES].sort());
});

test('每个模板都有 draw(ctx, n, shot, accent)', () => {
  for (const [name, tpl] of Object.entries(TEMPLATES)) {
    assert.equal(typeof tpl.draw, 'function', name + ' 缺 draw');
    // draw 的声明参数：模板自己不管缩放与 this（编译层负责），签名 (ctx, n, shot, accent)
    assert.ok(tpl.draw.length >= 3, name + '.draw 参数太少');
  }
});

test('compileScene：解析 at、绑定 sid，产出 {start, scene, draw} 的镜头表', () => {
  const tl = {
    fps: 30, total_frames: 300,
    sentences: [{id: 'S01', chapter: 1, from: 106, to: 197, text: 'x'}],
    subs: [{from: 106, to: 150, text: 'a'}, {from: 150, to: 197, text: 'b'}],
  };
  const shots = compileScene({
    shots: [
      {type: 'title', at: 1, title: 't'},
      {type: 'bullets', at: 'S01', items: [{t: 'a'}]},
      {type: 'stat', at: {s: 'S01', block: 2, lead: 0}, value: 1, label: 'l'},
    ],
  }, tl);
  assert.equal(shots.length, 3);
  assert.deepEqual(shots.map((s) => s.start), [1, 98, 150]);
  assert.equal(shots[1].scene.sid, 'S01');
  assert.equal(shots[0].scene.sid, null);
  for (const s of shots) assert.equal(typeof s.draw, 'function');
});

test('compileScene：没有模板的类型当场抛错', () => {
  assert.throws(() => compileScene({shots: [{type: 'nope', at: 1}]}, {sentences: [], subs: []}),
    /没有模板的类型/);
});
