// 模板注册表与规格层的契约测试：两层各自演进时，这里钉住它们不许漂移。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SHOT_TYPES, TEMPLATE_TYPES} from '../src/contract/scene.js';
import {setTimeline} from '../src/contract/timeline.js';
import {TEMPLATES, compileScene} from '../src/runtime/scene/templates.js';

test('TEMPLATES 的键与「SHOT_TYPES 去掉容器」严格一致（多一个少一个都算错）', () => {
  // 容器（如 layers）**没有** TEMPLATES 条目 —— 它的绘制是组合出来的，不是一个模板。
  // 容器在 contract 里用 CONTAINER_TYPES 显式列出，所以这条不变量仍然严格，
  // 只是从「全等」改成「去掉容器后全等」，不是留静默例外。
  assert.deepEqual(Object.keys(TEMPLATES).sort(), [...TEMPLATE_TYPES].sort());
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
  // compileScene 编译期就要查 S()/BLK()（算节拍），所以时间轴必须先装载 ——
  // 浏览器里 boot 保证这一点，测试要自己装。
  setTimeline(tl);
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

test('compileScene：每个模板都产出整数节拍，且与元素数一致', () => {
  const tl = {
    fps: 30, total_frames: 900,
    sentences: ['S01', 'S02'].map((id, i) => ({id, chapter: 1, from: 100 + i * 200, to: 260 + i * 200, text: 'x'})),
    subs: [
      {from: 100, to: 160, text: 'a'}, {from: 160, to: 220, text: 'b'}, {from: 220, to: 260, text: 'c'},
      {from: 300, to: 360, text: 'd'}, {from: 360, to: 420, text: 'e'},
    ],
  };
  setTimeline(tl);
  const shots = compileScene({
    shots: [
      {type: 'title', at: 1, title: 't'},
      {type: 'bullets', at: 'S01', items: [{t: 'a'}, {t: 'b'}, {t: 'c'}]},
      {type: 'table', at: 'S02', columns: ['A', 'B'], rows: [['1', '2'], ['3', '4']]},
    ],
  }, tl);
  assert.equal(shots[0].beats.length, 3, 'title 固定三拍');
  assert.deepEqual(shots[0].beats, [9, 41, 59]);
  // bullets 三行 → 三拍；table 表头 + 2 行 → 三拍。具体帧号由字幕块决定，
  // 断言结构与「跟着块走」的事实，不钉死算术（算术变了要连着改三处）。
  assert.equal(shots[1].beats.length, 3);
  assert.equal(shots[2].beats.length, 3);
  assert.ok(shots[1].beats.every((b, i) => i === 0 || b > shots[1].beats[i - 1]), 'bullets 节拍必须递增');
  // S01 的三个块起点是 100/160/220，节拍 = 块起点 - 4（被镜头起始夹住第一拍）
  assert.deepEqual(shots[1].beats.slice(1), [156, 216], '后两拍必须锚在字幕块前 4 帧');
  for (const s of shots) {
    assert.ok(s.beats.every((b) => Number.isInteger(b) && b >= 1), '节拍必须是整数帧号');
    assert.ok(s.beats.every((b) => b >= s.start), '节拍不得早于镜头起始');
  }
});

test('结构守卫：任何模板的节拍都必须落在镜头窗口内（末拍留够停留）', () => {
  // 用**短句**构造最容易越界的情形：句子区间只有 120 帧，而模板内容取满上限。
  const tl = {
    fps: 30, total_frames: 2000,
    sentences: Array.from({length: 12}, (_, i) => ({
      id: 'S' + String(i + 1).padStart(2, '0'), chapter: 1,
      from: 100 + i * 130, to: 220 + i * 130, text: 'x',
    })),
    subs: [],
  };
  setTimeline(tl);
  const many = (n, f) => Array.from({length: n}, (_, i) => f(i));
  const scene = {
    shots: [
      {type: 'title', at: 1, title: 't'},
      {type: 'bullets', at: 'S01', items: many(6, (i) => ({t: 'x' + i}))},
      {type: 'steps', at: 'S02', steps: many(6, (i) => ({t: 'x' + i}))},
      {type: 'flow', at: 'S03', boxes: many(5, (i) => ({label: 'x' + i}))},
      {type: 'code', at: 'S04', lines: many(10, (i) => 'line' + i)},
      {type: 'terminal', at: 'S05', lines: many(10, (i) => 'line' + i)},
      {type: 'chips', at: 'S06', items: many(12, (i) => 'chip' + i)},
      {type: 'bars', at: 'S07', items: many(6, (i) => ({v: i + 1, label: 'b' + i}))},
      {type: 'quote', at: 'S08', text: '一句' + '很长'.repeat(30)},
      {type: 'table', at: 'S09', columns: ['A', 'B'], rows: many(8, (i) => ['a', 'b'])},
      {type: 'image', at: 'S10', asset: 'a'},
      {type: 'stat', at: 'S11', value: 1, label: 'l'},
      {type: 'compare', at: 'S12', left: {title: 'L', items: many(5, (i) => 'x' + i)},
        right: {title: 'R', items: many(5, (i) => 'x' + i)}},
    ],
  };
  const shots = compileScene(scene, tl);
  const problems = [];
  for (const s of shots) {
    const type = s.scene.type;
    // 镜头末帧 = 下一个镜头的 start - 1（最后一个用总帧数）
    const idx = shots.indexOf(s);
    const end = idx + 1 < shots.length ? shots[idx + 1].start - 1 : tl.total_frames;
    const last = Math.max(...s.beats);
    if (last > end) problems.push(`${type}: 末拍 f${last} 超出镜头末 f${end}`);
    if (s.beats.some((b) => !Number.isInteger(b) || b < s.start)) {
      problems.push(`${type}: 节拍不在镜头内（${JSON.stringify(s.beats)}）`);
    }
  }
  assert.deepEqual(problems, [], '模板节拍越界：' + problems.join('；'));
});

test('compileScene：没有模板的类型当场抛错', () => {
  assert.throws(() => compileScene({shots: [{type: 'nope', at: 1}]}, {sentences: [], subs: []}),
    /没有模板的类型/);
});
