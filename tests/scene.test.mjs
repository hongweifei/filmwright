// scene 规格校验与对齐解析的单元测试。
// 重点是错误路径：每条守卫都必须被故意喂一个坏数据，证明它会红。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveAt, validateScene, SHOT_TYPES, SCENE_SCHEMA, SCENE_ERROR_CODES, sceneSchema, SHOT_MAXES, MASK_SHAPES} from '../src/contract/scene.js';
import {setTimeline, cutBefore, BLK} from '../src/contract/timeline.js';

const tl = {
  fps: 30,
  total_frames: 600,
  chapters: [{n: 1, title: '甲', from: 100}, {n: 2, title: '乙', from: 300}],
  sentences: [
    {id: 'S01', chapter: 1, from: 106, to: 197, text: '第一句'},
    {id: 'S02', chapter: 2, from: 250, to: 340, text: '第二句'},
  ],
  subs: [
    {from: 106, to: 150, text: '一'}, {from: 150, to: 197, text: '二'},
    {from: 250, to: 300, text: '三'}, {from: 300, to: 340, text: '四'},
  ],
};

const codes = (res) => res.errors.map((e) => e.code);

// ---------- resolveAt ----------

test('resolveAt：帧号原样', () => {
  assert.equal(resolveAt(12, tl), 12);
});

test('resolveAt：句 id 提前 8 帧（cutBefore 语义）', () => {
  assert.equal(resolveAt('S01', tl), 98);
});

test('resolveAt：block 锚点 + lead + offset', () => {
  assert.equal(resolveAt({s: 'S01', block: 2, lead: 0}, tl), 150);
  assert.equal(resolveAt({s: 'S01', block: 2}, tl), 142);
  assert.equal(resolveAt({s: 'S01', block: 2, offset: -4}, tl), 138);
  assert.equal(resolveAt({s: 'S02', lead: 12}, tl), 238);
});

test('resolveAt：结果下限 1 帧', () => {
  assert.equal(resolveAt({s: 'S01', lead: 200}, tl), 1);
});

test('resolveAt：不存在的句 id 报 SCENE_NO_SENTENCE', () => {
  assert.throws(() => resolveAt('S99', tl), (e) => e.code === 'SCENE_NO_SENTENCE');
});

test('resolveAt：块号越界要说清共几块（负面对照）', () => {
  assert.throws(() => resolveAt({s: 'S01', block: 5}, tl),
    (e) => e.code === 'SCENE_NO_BLOCK' && e.message.includes('共 2 块'));
});

test('resolveAt：非法形状 / lead / offset（负面对照）', () => {
  assert.throws(() => resolveAt(0, tl), (e) => e.code === 'SCENE_AT_FRAME');
  assert.throws(() => resolveAt(2.5, tl), (e) => e.code === 'SCENE_AT_FRAME');
  assert.throws(() => resolveAt({block: 1}, tl), (e) => e.code === 'SCENE_AT_SHAPE');
  assert.throws(() => resolveAt({s: 'S01', lead: -1}, tl), (e) => e.code === 'SCENE_AT_LEAD');
  assert.throws(() => resolveAt({s: 'S01', offset: 1.5}, tl), (e) => e.code === 'SCENE_AT_OFFSET');
});

test('resolveAt 与 timeline.js 的 S/BLK/cutBefore 语义一致（钉住两份实现不漂移）', () => {
  setTimeline(tl);
  assert.equal(resolveAt('S01', tl), cutBefore('S01'));
  assert.equal(resolveAt('S02', tl), cutBefore('S02'));
  assert.equal(resolveAt({s: 'S01', block: 2, lead: 0}, tl), BLK('S01', 2));
  assert.equal(resolveAt({s: 'S02', block: 1, lead: 0}, tl), BLK('S02', 1));
});

// ---------- validateScene：正例 ----------

test('validateScene：最小合法规格通过', () => {
  const r = validateScene({
    $schema: SCENE_SCHEMA,
    shots: [
      {type: 'title', at: 1, title: '片名', sub: '副题'},
      {type: 'bullets', at: 'S01', heading: '要点', items: [{t: '一', d: '甲'}, {t: '二'}]},
      {type: 'stat', at: {s: 'S01', block: 2}, value: 81, unit: 'ms', label: '每帧'},
      {type: 'image', at: 'S02', asset: 'filmstrip'},
    ],
  }, {timeline: tl, assetNames: ['filmstrip']});
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('validateScene：17 类模板的最小实例都合法', () => {
  // 每类单独成一个规格：单镜头规格里它就是第一个镜头，必须从第 1 帧起。
  const shots = {
    title: {type: 'title', at: 1, title: 't'},
    bullets: {type: 'bullets', at: 1, items: [{t: 'a'}]},
    stat: {type: 'stat', at: 1, value: 1, label: 'l'},
    flow: {type: 'flow', at: 1, boxes: [{label: 'a'}, {label: 'b', sub: 's'}]},
    code: {type: 'code', at: 1, lines: ['x', {text: 'y', mark: 'hl'}]},
    image: {type: 'image', at: 1, asset: 'a'},
    compare: {type: 'compare', at: 1, left: {title: 'L', items: ['x']}, right: {title: 'R', items: ['y']}},
    steps: {type: 'steps', at: 1, steps: [{t: 'a'}, {t: 'b', d: '说明'}]},
    table: {type: 'table', at: 1, columns: ['A', 'B'], rows: [['1', '2'], ['3', '4']]},
    quote: {type: 'quote', at: 1, text: '一句值得放大的话', who: '某人'},
    terminal: {type: 'terminal', at: 1, title: 'demo', lines: ['$ ls', {text: 'out', color: '#fff'}]},
    chips: {type: 'chips', at: 1, items: ['关键词', {label: '另一个'}]},
    bars: {type: 'bars', at: 1, unit: 'ms', items: [{v: 81, label: 'a'}, {v: 120, label: 'b'}]},
    comp: {type: 'comp', at: 1, comp: 'sub'},
    clip: {type: 'clip', at: 1, clip: 'broll'},
    line: {type: 'line', at: 1, unit: 'ms', points: [{v: 10, label: '一月'}, {v: 40, label: '二月'}]},
    // 声明式 3D：最小实例就是一个对象 + 形状
    three: {type: 'three', at: 1, objects: [{shape: 'box', size: 1.6, color: 'accent'}]},
    // 容器：不是模板，但同样要有最小合法实例（它也是 SHOT_TYPES 的一员）
    layers: {type: 'layers', at: 1, layers: [{content: {type: 'title', title: 'x'}}]},
  };
  assert.deepEqual(Object.keys(shots).sort(), [...SHOT_TYPES].sort(), '测试要覆盖全部类型');
  for (const s of Object.values(shots)) {
    const r = validateScene(
      {comps: {sub: {shots: [{type: 'title', at: 1, title: 'x'}]}}, shots: [s]},
      {timeline: tl, assetNames: ['a'], clipNames: new Set(['broll'])});
    assert.equal(r.ok, true, s.type + ' → ' + JSON.stringify(r.errors));
  }
});

// ---------- 片段素材（clip） ----------

test('负面对照：clip 引用不存在的片段要报 SCENE_NO_CLIP 并列出已声明的', () => {
  const r = validateScene({shots: [{type: 'clip', at: 1, clip: 'nope'}]},
    {timeline: tl, clipNames: new Set(['broll', 'screen'])});
  const e = r.errors.find((x) => x.code === 'SCENE_NO_CLIP');
  assert.ok(e, '应报 SCENE_NO_CLIP：' + JSON.stringify(r.errors.map((x) => x.code)));
  assert.ok(e.hint.includes('broll'), 'hint 要列出已声明的片段');
});

test('clip 的 fit 字段只认 contain / cover / stretch', () => {
  const good = validateScene({shots: [{type: 'clip', at: 1, clip: 'b', fit: 'cover'}]},
    {timeline: tl, clipNames: new Set(['b'])});
  assert.equal(good.ok, true, JSON.stringify(good.errors));
  const bad = validateScene({shots: [{type: 'clip', at: 1, clip: 'b', fit: 'zoom'}]},
    {timeline: tl, clipNames: new Set(['b'])});
  assert.ok(bad.errors.some((e) => e.code === 'SCENE_BAD_FIELD' && e.path.endsWith('.fit')),
    '应报 fit 非法：' + JSON.stringify(bad.errors));
});

test('clip 缺 clip 字段要报必填', () => {
  const r = validateScene({shots: [{type: 'clip', at: 1}]}, {timeline: tl, clipNames: new Set(['b'])});
  assert.ok(r.errors.some((e) => e.code === 'SCENE_MISSING_FIELD' && e.path.endsWith('.clip')),
    JSON.stringify(r.errors));
});

// ---------- 嵌套合成（comps / comp） ----------

test('comps：定义子合成 + 用 comp 实例化，合法', () => {
  const r = validateScene({
    comps: {
      lowerThird: {frames: 60, shots: [
        {type: 'bullets', at: 1, items: [{t: '名字'}]},
        {type: 'stat', at: 30, value: 1, label: 'l'},
      ]},
    },
    shots: [
      {type: 'title', at: 1, title: 't'},
      {type: 'comp', at: 'S01', comp: 'lowerThird'},
      {type: 'comp', at: 'S02', comp: 'lowerThird', loop: true, frames: 40},
    ],
  }, {timeline: tl});
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('负面对照：comp 引用不存在的子合成要报 SCENE_NO_COMP 并列出已定义的', () => {
  const r = validateScene({
    comps: {a: {shots: [{type: 'title', at: 1, title: 'x'}]}},
    shots: [{type: 'title', at: 1, title: 't'}, {type: 'comp', at: 2, comp: 'nope'}],
  }, {timeline: tl});
  const e = r.errors.find((x) => x.code === 'SCENE_NO_COMP');
  assert.ok(e, '应报 SCENE_NO_COMP：' + JSON.stringify(r.errors.map((x) => x.code)));
  assert.ok(e.hint.includes('a'), 'hint 要列出已定义的子合成');
});

test('负面对照：子合成里的 at 写成句 id 要报 SCENE_COMP_LOCAL_AT（两套时间轴不能混）', () => {
  const r = validateScene({
    comps: {a: {shots: [{type: 'title', at: 'S01', title: 'x'}]}},
    shots: [{type: 'title', at: 1, title: 't'}],
  }, {timeline: tl});
  const e = r.errors.find((x) => x.code === 'SCENE_COMP_LOCAL_AT');
  assert.ok(e, '应报：' + JSON.stringify(r.errors.map((x) => x.code)));
  assert.ok(e.hint.includes('本地'), 'hint 要解释本地时间轴与全局时间轴的区别');
});

test('负面对照：子合成循环引用要报 SCENE_COMP_CYCLE 并指出链条', () => {
  const r = validateScene({
    comps: {
      a: {shots: [{type: 'comp', at: 1, comp: 'b'}]},
      b: {shots: [{type: 'comp', at: 1, comp: 'a'}]},
    },
    shots: [{type: 'title', at: 1, title: 't'}],
  }, {timeline: tl});
  const e = r.errors.find((x) => x.code === 'SCENE_COMP_CYCLE');
  assert.ok(e, '应报环：' + JSON.stringify(r.errors.map((x) => x.code)));
  assert.ok(e.message.includes('a') && e.message.includes('b'), '要看得出是谁引用谁：' + e.message);
});

test('负面对照：子合成结构错误（空 shots / 首个不从本地 1 起 / frames 非法）', () => {
  const r = validateScene({
    comps: {
      empty: {shots: []},
      badFirst: {shots: [{type: 'title', at: 5, title: 'x'}]},
      badFrames: {frames: 0, shots: [{type: 'title', at: 1, title: 'x'}]},
      unkKey: {shots: [{type: 'title', at: 1, title: 'x'}], extra: 1},
    },
    shots: [{type: 'title', at: 1, title: 't'}],
  }, {timeline: tl});
  const codes = r.errors.map((x) => x.code);
  assert.ok(codes.includes('SCENE_BAD_COMP'), '空 shots / frames 非法：' + JSON.stringify(codes));
  assert.ok(codes.includes('SCENE_FIRST_NOT_1'), '首个不从本地 1 起：' + JSON.stringify(codes));
  assert.ok(codes.includes('SCENE_UNKNOWN_FIELD'), '子合成未知字段：' + JSON.stringify(codes));
  assert.ok(r.errors.some((x) => x.path.startsWith('comps.')), 'path 要指到 comps 里');
});

// ---------- validateScene：负面对照（每条守卫喂一个坏数据） ----------

test('负面对照：顶层与 shots 形状', () => {
  assert.ok(codes(validateScene(null, {timeline: tl})).includes('SCENE_NOT_OBJECT'));
  assert.ok(codes(validateScene({shots: []}, {timeline: tl})).includes('SCENE_NO_SHOTS'));
  assert.ok(codes(validateScene({extra: 1, shots: [{type: 'title', at: 1, title: 't'}]}, {timeline: tl}))
    .includes('SCENE_UNKNOWN_FIELD'));
  assert.ok(codes(validateScene({$schema: 'v9', shots: [{type: 'title', at: 1, title: 't'}]}, {timeline: tl}))
    .includes('SCENE_SCHEMA'));
});

test('负面对照：未知类型要列出可用的', () => {
  const r = validateScene({shots: [{type: 'pie', at: 1}]}, {timeline: tl});
  const e = r.errors.find((x) => x.code === 'SCENE_UNKNOWN_TYPE');
  assert.ok(e, '必须报未知类型');
  assert.ok(e.hint.includes('title') && e.hint.includes('compare'), 'hint 要列出全部可用类型');
});

test('负面对照：缺 at / 缺必填字段 / 字段类型错', () => {
  const r = validateScene({shots: [
    {type: 'title', title: 't'},                       // 缺 at
    {type: 'title', at: 5},                             // 缺 title
    {type: 'stat', at: 6, value: '81', label: 'l'},     // value 写成字符串
    {type: 'bullets', at: 7, items: []},                // items 空
    {type: 'flow', at: 8, boxes: [{label: 'only'}]},    // boxes < 2
  ]}, {timeline: tl});
  const c = codes(r);
  assert.ok(c.includes('SCENE_MISSING_AT'), '缺 at');
  assert.ok(c.includes('SCENE_MISSING_FIELD'), '缺 title 必填');
  assert.ok(c.includes('SCENE_BAD_FIELD'), 'value 类型 / items 空 / boxes 少');
});

test('负面对照：未知字段必须响，不静默忽略', () => {
  const r = validateScene({shots: [
    {type: 'title', at: 1, title: 't', titel: '拼错'},
    {type: 'bullets', at: 2, items: [{t: 'a', text: '多写的'}]},
  ]}, {timeline: tl});
  const c = codes(r);
  assert.ok(c.includes('SCENE_UNKNOWN_FIELD'), JSON.stringify(r.errors));
  const e = r.errors.find((x) => x.code === 'SCENE_UNKNOWN_FIELD');
  assert.ok(e.path.startsWith('shots['), 'path 要指到具体镜头与字段：' + e.path);
});

test('负面对照：image 引用未声明的素材', () => {
  const r = validateScene({shots: [
    {type: 'title', at: 1, title: 't'}, {type: 'image', at: 2, asset: 'nope'},
  ]}, {timeline: tl, assetNames: ['filmstrip']});
  const e = r.errors.find((x) => x.code === 'SCENE_NO_ASSET');
  assert.ok(e && e.hint.includes('filmstrip'), 'hint 要列出已声明的素材');
});

test('负面对照：第一个镜头不从 1 开始', () => {
  const r = validateScene({shots: [{type: 'title', at: 'S01', title: 't'}]}, {timeline: tl});
  const e = r.errors.find((x) => x.code === 'SCENE_FIRST_NOT_1');
  assert.ok(e && e.hint.includes('at'), 'hint 要给出改法：' + JSON.stringify(e));
});

test('负面对照：对齐后顺序不递增要指出是哪两个', () => {
  const r = validateScene({shots: [
    {type: 'title', at: 1, title: 't'},
    {type: 'bullets', at: 'S02', items: [{t: 'a'}]},
    {type: 'stat', at: 'S01', value: 1, label: 'l'},   // 回到更早的句
  ]}, {timeline: tl});
  const e = r.errors.find((x) => x.code === 'SCENE_NOT_INCREASING');
  assert.ok(e && e.path === 'shots[2].at', 'path 指到乱序的那个镜头：' + e.path);
});

test('负面对照：code 行的 mark 不认识要报可选值', () => {
  const r = validateScene({shots: [{type: 'code', at: 1, lines: [{text: 'x', mark: 'boom'}]}]}, {timeline: tl});
  const e = r.errors.find((x) => x.code === 'SCENE_BAD_FIELD');
  assert.ok(e && e.hint.includes('add'), 'hint 要列出可用的 mark');
});

test('负面对照：compare 两侧形状', () => {
  const r = validateScene({shots: [{type: 'compare', at: 1, left: {title: 'L'}, right: 'not-object'}]}, {timeline: tl});
  const c = codes(r);
  assert.ok(c.includes('SCENE_BAD_FIELD'), '缺 items 与右侧非对象都要报：' + JSON.stringify(r.errors));
});

test('对齐解析失败的镜头不炸校验器，转成带 path 的错误', () => {
  const r = validateScene({shots: [{type: 'title', at: 'S99', title: 't'}]}, {timeline: tl});
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].path, 'shots[0].at');
  assert.equal(r.errors[0].code, 'SCENE_NO_SENTENCE');
});

// ---------- 容量上限与表格交叉检查（v0.2 新增守卫，负面对照） ----------

test('负面对照：超出容量上限报 SCENE_TOO_MANY 并给拆镜头的 hint', () => {
  const many = Array.from({length: SHOT_MAXES.bullets.items + 1}, (_, i) => ({t: '行' + i}));
  const r = validateScene({shots: [{type: 'bullets', at: 1, items: many}]}, {timeline: tl});
  const e = r.errors.find((x) => x.code === 'SCENE_TOO_MANY');
  assert.ok(e && e.path === 'shots[0].items', 'path 指到超量的数组字段：' + JSON.stringify(r.errors));
  assert.ok(e.hint.includes('拆成多个镜头'), 'hint 要给可行的出路');
});

test('负面对照：表格行宽与表头不符要报 SCENE_TABLE_WIDTH', () => {
  const r = validateScene({shots: [{type: 'table', at: 1, columns: ['A', 'B'], rows: [['1', '2'], ['3']]}]}, {timeline: tl});
  const e = r.errors.find((x) => x.code === 'SCENE_TABLE_WIDTH');
  assert.ok(e && e.path === 'shots[0].rows[1]', 'path 指到出错的那一行：' + JSON.stringify(r.errors));
});

test('负面对照：bars 的 v 不是数字 / chips 的 label 缺失都要报', () => {
  const r = validateScene({shots: [
    {type: 'bars', at: 1, items: [{v: '81', label: 'a'}, {v: 2, label: 'b'}]},
    {type: 'chips', at: 2, items: [{labelx: '拼错'}]},
  ]}, {timeline: tl});
  const c = codes(r);
  assert.ok(c.includes('SCENE_BAD_FIELD'), 'bars.v：' + JSON.stringify(r.errors));
  assert.ok(c.includes('SCENE_UNKNOWN_FIELD'), 'chips 条目字段拼错：' + JSON.stringify(r.errors));
});

// ---------- 转场（scene 规格层） ----------

test('scene 支持 transition：合法形状通过，且不破坏其它字段校验', () => {
  const r = validateScene({shots: [
    {type: 'title', at: 1, title: 't'},
    {type: 'bullets', at: 2, items: [{t: 'a'}], transition: 12},
    {type: 'stat', at: 3, value: 1, label: 'l', transition: {type: 'fade', frames: 8}},
  ]}, {timeline: tl});
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('负面对照：transition 形状不对报 SCENE_BAD_TRANSITION', () => {
  // 注意 `{type:'wipe',frames:5}` 现在**是合法的**（扩展转场已支持 wipe），
  // 所以从非法集合里去掉它，换成真正非法的：不认识的类型、非法方向。
  for (const bad of [0, -1, 1.5, 'fade', {frames: 0}, {type: 'nope', frames: 5},
    {type: 'slide', frames: 5, direction: '斜着'}, [], {}]) {
    const r = validateScene({shots: [
      {type: 'title', at: 1, title: 't'},
      {type: 'bullets', at: 2, items: [{t: 'a'}], transition: bad},
    ]}, {timeline: tl});
    const e = r.errors.find((x) => x.code === 'SCENE_BAD_TRANSITION');
    assert.ok(e, `应报转场错：${JSON.stringify(bad)}（实际 ${JSON.stringify(r.errors.map((x) => x.code))}）`);
    assert.equal(e.path, 'shots[1].transition', 'path 要指到具体镜头');
  }
});

test('五种转场类型与四个方向都合法（扩展转场）', () => {
  for (const type of ['crossfade', 'fade', 'slide', 'wipe', 'zoom']) {
    const r = validateScene({shots: [
      {type: 'title', at: 1, title: 't'},
      {type: 'bullets', at: 2, items: [{t: 'a'}], transition: {type, frames: 12, direction: 'left'}},
    ]}, {timeline: tl});
    assert.equal(r.ok, true, `${type} 应合法：${JSON.stringify(r.errors)}`);
  }
  for (const direction of ['left', 'right', 'up', 'down']) {
    const r = validateScene({shots: [
      {type: 'title', at: 1, title: 't'},
      {type: 'bullets', at: 2, items: [{t: 'a'}], transition: {type: 'slide', frames: 12, direction}},
    ]}, {timeline: tl});
    assert.equal(r.ok, true, `direction=${direction} 应合法：${JSON.stringify(r.errors)}`);
  }
});

test('line 模板：points 的 v 必填且是数字，label 可选', () => {
  const good = validateScene({shots: [{type: 'line', at: 1, points: [{v: 1}, {v: 2, label: 'x'}]}]},
    {timeline: tl});
  assert.equal(good.ok, true, JSON.stringify(good.errors));
  const bad = validateScene({shots: [{type: 'line', at: 1, points: [{v: 'x'}, {v: 2}]}]}, {timeline: tl});
  assert.ok(bad.errors.some((e) => e.code === 'SCENE_BAD_FIELD' && e.path.includes('.v')),
    'v 不是数字应报错：' + JSON.stringify(bad.errors));
  const tooMany = validateScene({shots: [{type: 'line', at: 1,
    points: Array.from({length: 9}, (_, i) => ({v: i}))}]}, {timeline: tl});
  assert.ok(tooMany.errors.some((e) => e.code === 'SCENE_TOO_MANY'),
    '超过 8 个点应报 SCENE_TOO_MANY：' + JSON.stringify(tooMany.errors.map((e) => e.code)));
});

test('transition 是通用字段：不会因「未知字段」被误报', () => {
  const r = validateScene({shots: [
    {type: 'title', at: 1, title: 't', transition: {type: 'fade', frames: 5}},
  ]}, {timeline: tl});
  assert.ok(!r.errors.some((e) => e.code === 'SCENE_UNKNOWN_FIELD'),
    'transition 不该被当成未知字段：' + JSON.stringify(r.errors));
});

// ---------- 机器可读 schema ----------

test('sceneSchema()：13 类齐、每类有 note/fields/max，错误码表完整', () => {
  const s = sceneSchema();
  assert.equal(s.schema, SCENE_SCHEMA);
  assert.deepEqual(Object.keys(s.types).sort(), [...SHOT_TYPES].sort());
  for (const [name, t] of Object.entries(s.types)) {
    assert.ok(t.note && t.note.length > 4, name + ' 缺说明');
    assert.ok(Object.keys(t.fields).length >= 1, name + ' 缺字段表');
    assert.ok(t.max && typeof t.max === 'object', name + ' max 形状不对');
  }
  assert.ok(s.errorCodes.length >= 15);
});

test('错误码登记表与源码一致：用了没登记、登记了没用，都算错', async () => {
  const {readFileSync, readdirSync} = await import('node:fs');
  const {join: j, resolve: r} = await import('node:path');
  const {fileURLToPath} = await import('node:url');
  // 登记表在 contract/scene.js，但**并非所有码都在那里抛**：
  // `SCENE_ANIM_RANGE` / `SCENE_ANIM_NO_BEATS` 要知道该节点的**节拍表**才能判，
  // 而节拍表到绑定期才齐（scene 镜头在编译期算、手写镜头自己声明），
  // 所以校验逻辑在 runtime/stage/shots.js。登记仍是单一表。
  //
  // ⚠️ 扫描范围**扫全树**，不列文件清单 —— 这里曾经写着
  // `['../src/contract/scene.js', '../src/runtime/stage/shots.js']`，那是个**硬编码清单**：
  // 新文件一旦开始抛 scene 码，`used` 里就没有它，测试会误报"登记了没用"，
  // 而那个方向的修法往往是**把登记删掉** —— 比漏报更糟。
  // 扫全树对新增文件免疫，也不需要维护。（同类问题真实发生过一次：
  // frame-format 的候选清单硬编码，h264 进了白名单却漏过了守卫。）
  const SRC_ROOT = r(fileURLToPath(new URL('../src', import.meta.url)));
  const srcFiles = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, {withFileTypes: true})) {
      const p = j(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs)$/.test(e.name)) srcFiles.push(p);
    }
  };
  walk(SRC_ROOT);
  const used = new Set();
  for (const abs of srcFiles) {
    const src = readFileSync(abs, 'utf8');
    // 去掉登记表本身再扫，避免自引用
    const body = src.replace(/export const SCENE_ERROR_CODES[\s\S]*?\];/, '');
    // 码名可含数字（SCENE_FIRST_NOT_1）；标识符 SCENE_ERROR_CODES 本身不是码
    for (const m of body.matchAll(/\bSCENE_[A-Z0-9_]+\b/g)) {
      if (m[0] !== 'SCENE_ERROR_CODES') used.add(m[0]);
    }
  }
  assert.ok(srcFiles.length > 20, `只扫到 ${srcFiles.length} 个源文件 —— 扫描逻辑写错了`);
  const declared = new Set(SCENE_ERROR_CODES);
  const undeclared = [...used].filter((c) => !declared.has(c));
  const unused = [...declared].filter((c) => !used.has(c));
  assert.deepEqual(undeclared, [], '源码用了未登记的错误码');
  assert.deepEqual(unused, [], '登记表里有源码没用到的码');
});

// ─────────────────────── 遮罩（阶段 ③）───────────────────────

/** 本文件里取错误列表的小工具（与上面几处用同一条时间轴形状）。 */
const TL_FX = {fps: 30, total_frames: 300,
  chapters: [{n: 1, title: 'c', from: 1}],
  sentences: [{id: 'S01', chapter: 1, from: 1, to: 300, text: 'x',
    subs: [{from: 1, to: 300, text: 'x'}]}],
  subs: [{from: 1, to: 300, text: 'x'}]};
const errs = (sceneObj) => validateScene(sceneObj, {timeline: TL_FX}).errors;

const maskErrs = (mask) => errs({shots: [{type: 'bullets', at: 1, items: [{t: '一'}], mask}]});

test('mask：四种形状都合法，不认识的形状要报并列出可用值', () => {
  assert.deepEqual(maskErrs({shape: 'rect'}), []);
  assert.deepEqual(maskErrs({shape: 'rounded', x: 0.1, y: 0.1, w: 0.5, h: 0.5, r: 0.3}), []);
  assert.deepEqual(maskErrs({shape: 'ellipse', x: 0, y: 0, w: 1, h: 1}), []);
  assert.deepEqual(maskErrs({shape: 'polygon', points: [[0, 0], [1, 0], [0.5, 1]]}), []);
  assert.deepEqual(maskErrs({shape: 'rect', invert: true}), [], '反选是合法参数');
  const e = maskErrs({shape: 'star'});
  assert.deepEqual(e.map((x) => x.code), ['SCENE_MASK_SHAPE']);
  for (const s of MASK_SHAPES) assert.ok(e[0].hint.includes(s) || e[0].message.includes(s), `要列出 ${s}`);
});

test('mask：坐标必须是 0–1 归一化（写像素值要报出来）', () => {
  const codes = (m) => maskErrs(m).map((x) => x.code);
  assert.deepEqual(codes({shape: 'rect', x: 1.5}), ['SCENE_MASK_RANGE']);
  assert.deepEqual(codes({shape: 'rect', w: -0.1}), ['SCENE_MASK_RANGE']);
  assert.deepEqual(codes({shape: 'rect', r: 2}), ['SCENE_MASK_RANGE']);
  // 常见误用：写像素（640/1280）—— 必须报，否则遮罩会静默跑到画外
  // （x 与 w 都越界 ⇒ 两条错误，所以用 includes 而不是等值）
  const px = codes({shape: 'ellipse', x: 640, w: 1280});
  assert.ok(px.length >= 2 && px.every((c) => c === 'SCENE_MASK_RANGE'),
    '写像素值必须报出来：' + JSON.stringify(px));
  assert.deepEqual(codes({shape: 'rect', invert: 'yes'}), ['SCENE_MASK_SHAPE']);
});

test('mask：polygon 至少 3 个点，每个点都要在 0–1', () => {
  const codes = (m) => maskErrs(m).map((x) => x.code);
  assert.deepEqual(codes({shape: 'polygon', points: [[0, 0], [1, 1]]}), ['SCENE_MASK_POLYGON']);
  assert.deepEqual(codes({shape: 'polygon', points: 'x'}), ['SCENE_MASK_POLYGON']);
  assert.deepEqual(codes({shape: 'polygon', points: [[0, 0], [1, 0], [2, 1]]}), ['SCENE_MASK_POLYGON']);
  assert.deepEqual(codes({shape: 'polygon', points: [[0, 0], [1, 0], [0.5]]}), ['SCENE_MASK_POLYGON']);
});

test('mask：图层级也能挂（镜头与图层两处都要校验）', () => {
  const s = {type: 'layers', at: 1, layers: [
    {content: {type: 'bullets', items: [{t: '一'}]}, z: 0},
    {content: {type: 'bullets', items: [{t: '二'}]}, z: 1, mask: {shape: 'star'}},
  ]};
  const e = errs({shots: [s]});
  assert.ok(e.some((x) => x.code === 'SCENE_MASK_SHAPE' && /mask/.test(x.path)),
    '图层上的非法遮罩要报：' + JSON.stringify(e.map((x) => x.path)));
});

// ─────────────────────── 逐字入场（阶段 ④）───────────────────────

test('title.reveal：对象合法，且不写就与以前逐字节相同（opt-in）', () => {
  const t = (reveal) => errs({shots: [{type: 'title', at: 1, title: '标题', ...(reveal ? {reveal} : {})}]});
  assert.deepEqual(t(null), [], '不写 reveal 当然合法');
  assert.deepEqual(t({}), [], '空对象合法（全用默认值）');
  assert.deepEqual(t({stagger: 3, dur: 12, dy: 26}), []);
  // 字段白名单：reveal 必须被 title 认识，否则连合法写法都过不了
  const e = errs({shots: [{type: 'title', at: 1, title: '标题', reveal: {stagger: 2}}]});
  assert.deepEqual(e, [], 'reveal 不该被当成"title 没有字段"');
});

test('quote.reveal：同一套机制下沉到 quote（跨行接着数）', () => {
  const q = (reveal) => errs({shots: [{type: 'quote', at: 1, text: '一句话',
    ...(reveal ? {reveal} : {})}]});
  assert.deepEqual(q(null), [], '不写 reveal 当然合法');
  assert.deepEqual(q({stagger: 2, dur: 10, dy: 18}), []);
  assert.deepEqual(q({}), [], '空对象合法（全用默认值）');
  // 同样必须被 quote 的字段白名单认识，否则连合法写法都过不了
  assert.deepEqual(q({stagger: 2}), [], 'reveal 不该被当成"quote 没有字段"');
});
