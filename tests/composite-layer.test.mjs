// 图层合成的单元测试。
//
// 用**记录矩阵的假 ctx**（不依赖浏览器）验证两件最难的事：
//   1. applyShotTransform 的共轭变换数学正确 —— 它的正确性判据是
//      「先 applyShotTransform 再 applyDesignScale」≡「先在设计空间变换，再整体缩放」
//   2. 组透明度/混合模式走离屏缓冲，而**默认参数走快路径**（不引入缓冲）
//      —— 后者是像素回归基线不被打破的前提
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {view, DESIGN} from '../src/contract/viewport.js';

// ---------- 假 canvas / ctx（带矩阵追踪） ----------

const mat = () => ({a: 1, b: 0, c: 0, d: 1, e: 0, f: 0});
const mul = (m, n) => ({
  a: m.a * n.a + m.c * n.b,
  b: m.b * n.a + m.d * n.b,
  c: m.a * n.c + m.c * n.d,
  d: m.b * n.c + m.d * n.d,
  e: m.a * n.e + m.c * n.f + m.e,
  f: m.b * n.e + m.d * n.f + m.f,
});
const apply = (m, p) => ({x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f});

function mockCtx(id = 'main') {
  let m = mat();
  const stack = [];
  const calls = [];
  const ctx = {
    __id: id,
    calls,
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    save() { stack.push({m: {...m}, ga: ctx.globalAlpha, gc: ctx.globalCompositeOperation}); calls.push('save'); },
    restore() { const s = stack.pop(); m = s.m; ctx.globalAlpha = s.ga; ctx.globalCompositeOperation = s.gc; calls.push('restore'); },
    setTransform(...a) {
      if (a.length === 1) m = {...a[0]};
      else if (a.length === 6) m = {a: a[0], b: a[1], c: a[2], d: a[3], e: a[4], f: a[5]};
      calls.push('setTransform');
    },
    getTransform() { return {...m}; },
    translate(x, y) { m = mul(m, {a: 1, b: 0, c: 0, d: 1, e: x, f: y}); calls.push('translate'); },
    scale(x, y) { m = mul(m, {a: x, b: 0, c: 0, d: y, e: 0, f: 0}); calls.push('scale'); },
    rotate(r) { const c = Math.cos(r), s = Math.sin(r); m = mul(m, {a: c, b: s, c: -s, d: c, e: 0, f: 0}); calls.push('rotate'); },
    clearRect() { calls.push('clearRect'); },
    drawImage(img) { calls.push('drawImage:' + (img && img.__id)); },
    matrix: () => ({...m}),
  };
  return ctx;
}

// 假 document：每个 canvas 的 ctx 记忆化（compute 出的层要能被再次取到）
let bufSeq = 0;
const created = [];
globalThis.document = {
  createElement() {
    const c = {__id: 'buf' + (++bufSeq), width: 0, height: 0, _ctx: null};
    c.getContext = () => (c._ctx ??= mockCtx(c.__id));
    created.push(c);
    return c;
  },
};

const layer = await import('../src/runtime/composite/layer.js');
const design = await import('../src/runtime/layout/design.js');

// ---------- 形状校验 ----------

test('isValidTransform：合法形状通过，非法当场判否', () => {
  const ok = [
    undefined, null, {}, {x: 10}, {y: -5}, {scale: 1.5}, {rotate: 30},
    {alpha: 0.5}, {blend: 'multiply'}, {origin: [640, 360]},
    {x: 1, y: 2, scale: 2, rotate: 45, alpha: 1, blend: 'screen', origin: [0, 0]},
  ];
  for (const t of ok) assert.equal(layer.isValidTransform(t), true, '应合法：' + JSON.stringify(t));
  const bad = [
    'x', 42, [], {x: 'a'}, {scale: 0}, {scale: -1}, {rotate: 'r'},
    {alpha: 2}, {alpha: -0.1}, {blend: 'lighten2'}, {blend: 1},
    {origin: [1]}, {origin: 'center'}, {origin: [1, 'y']},
  ];
  for (const t of bad) assert.equal(layer.isValidTransform(t), false, '应非法：' + JSON.stringify(t));
});

test('blend 白名单与非默认判定', () => {
  assert.ok(layer.BLEND_MODES.includes('multiply') && layer.BLEND_MODES.includes('screen'));
  assert.equal(layer.needsBuffer({blend: 'source-over'}), false, 'source-over 是默认，不该走缓冲');
  assert.equal(layer.needsBuffer({blend: 'multiply'}), true);
  assert.equal(layer.needsBuffer({alpha: 1}), false);
  assert.equal(layer.needsBuffer({alpha: 0.99}), true);
  assert.equal(layer.needsBuffer({x: 100, rotate: 45}), false, '纯几何变换不需要缓冲');
  assert.equal(layer.needsBuffer(null), false);
  assert.equal(layer.needsBuffer({alpha: null, blend: null}), false, 'null 表示没设，不是非默认值');
});

test('交叉一致性：contract/scene.js 与 runtime/composite/layer.js 的 transform 规则不漂移', async () => {
  // contract 不能 import runtime（分层规则），所以 transform 的形状校验写了两份。
  // 这条测试钉住两份判定结果一致 —— 漂移的后果是「校验放过了运行时画不出的东西」。
  const contract = await import('../src/contract/scene.js');
  const cases = [
    undefined, null, {}, {x: 1}, {y: -2}, {scale: 1.5}, {rotate: 30}, {alpha: 0.5},
    {blend: 'multiply'}, {origin: [1, 2]},
    'x', 42, [], {x: 'a'}, {scale: 0}, {scale: -1}, {rotate: 'r'},
    {alpha: 2}, {alpha: -0.1}, {origin: [1]}, {origin: 'c'}, {origin: [1, 'y']},
  ];
  for (const c of cases) {
    assert.equal(contract.isValidTransform(c), layer.isValidTransform(c),
      `两处判定不一致：${JSON.stringify(c)}（contract=${contract.isValidTransform(c)} runtime=${layer.isValidTransform(c)}）`);
  }
  // blend 白名单只在 runtime 有（contract 只判「是字符串」），这是**有意的不对称**：
  // contract 层不知道 Canvas 支持哪些模式，运行时会兜住非法名（画不出就退回默认）。
  assert.equal(layer.isValidTransform({blend: '不存在的模式'}), false, 'runtime 应拒非法混合模式');
  assert.equal(contract.isValidTransform({blend: '不存在的模式'}), true, 'contract 只判类型（有意）');
});

// ---------- 设计坐标变换 ----------

test('applyLayerTransform：绕 origin 旋转 90° 的映射正确', () => {
  const ctx = mockCtx();
  // 原点 (0,0)，绕原点转 90°：(10,0) → (0,10)（Canvas 的 y 向下、正角为顺时针）
  layer.applyLayerTransform(ctx, {rotate: 90, origin: [0, 0]});
  const p = apply(ctx.matrix(), {x: 10, y: 0});
  assert.ok(Math.abs(p.x - 0) < 1e-9, 'x 应≈0，实际 ' + p.x);
  assert.ok(Math.abs(p.y - 10) < 1e-9, 'y 应≈10，实际 ' + p.y);
});

test('applyLayerTransform：绕中心缩放，中心点不动', () => {
  const ctx = mockCtx();
  layer.applyLayerTransform(ctx, {scale: 2, origin: [640, 360]});
  const c = apply(ctx.matrix(), {x: 640, y: 360});
  assert.ok(Math.abs(c.x - 640) < 1e-9 && Math.abs(c.y - 360) < 1e-9, '中心应不动');
  const p = apply(ctx.matrix(), {x: 740, y: 360});
  assert.ok(Math.abs(p.x - 840) < 1e-9, '距中心 100 → 200，实际 ' + p.x);
});

test('applyLayerTransform：x/y 是平移，与缩放可叠加', () => {
  const ctx = mockCtx();
  layer.applyLayerTransform(ctx, {x: 50, y: -20, origin: [640, 360]});
  const c = apply(ctx.matrix(), {x: 640, y: 360});
  assert.ok(Math.abs(c.x - 690) < 1e-9 && Math.abs(c.y - 340) < 1e-9);
});

// ---------- 共轭变换（镜头模式）——最关键的一条 ----------

test('applyShotTransform 的共轭正确性：与「设计空间变换 + 整体缩放」等价', () => {
  const saved = {W: view.W, H: view.H};
  try {
    // 选一个会产生居中留边的尺寸（s<1 且 oy≠0），才能验证位移项没写错
    view.W = 1000; view.H = 1000;
    const s = Math.min(view.W / DESIGN.W, view.H / DESIGN.H);
    const ox = (view.W - DESIGN.W * s) / 2;
    const oy = (view.H - DESIGN.H * s) / 2;
    const D = (p) => ({x: ox + s * p.x, y: oy + s * p.y});

    const t = {x: 50, y: -30, scale: 1.4, rotate: 25, origin: [640, 360]};
    // 期望：先在**设计空间**做变换，再整体缩放
    const inDesign = (q) => {
      const ctxD = mockCtx();
      layer.applyLayerTransform(ctxD, t);
      return apply(ctxD.matrix(), q);
    };
    const probes = [{x: 0, y: 0}, {x: 300, y: 200}, {x: 640, y: 360}, {x: 1279, y: 719}, {x: 700, y: 100}];
    for (const q of probes) {
      const want = D(inDesign(q));
      // 实际：先 applyShotTransform（单位矩阵上下文），再由镜头调 applyDesignScale
      const ctxS = mockCtx();
      layer.applyShotTransform(ctxS, t);
      design.applyDesignScale(ctxS);
      const got = apply(ctxS.matrix(), q);
      assert.ok(Math.abs(got.x - want.x) < 1e-6 && Math.abs(got.y - want.y) < 1e-6,
        `q=${JSON.stringify(q)} 期望 ${JSON.stringify(want)} 实际 ${JSON.stringify(got)}`);
    }
  } finally {
    view.W = saved.W; view.H = saved.H;
  }
});

test('applyShotTransform：2x 分辨率下同样等价（等比缩放）', () => {
  const saved = {W: view.W, H: view.H};
  try {
    view.W = 2560; view.H = 1440;
    const s = Math.min(view.W / DESIGN.W, view.H / DESIGN.H);
    const ox = (view.W - DESIGN.W * s) / 2;
    const oy = (view.H - DESIGN.H * s) / 2;
    const D = (p) => ({x: ox + s * p.x, y: oy + s * p.y});
    const t = {x: -100, y: 40, scale: 0.8, rotate: -15, origin: [300, 500]};
    const q = {x: 415, y: 233};
    const ctxD = mockCtx();
    layer.applyLayerTransform(ctxD, t);
    const want = D(apply(ctxD.matrix(), q));
    const ctxS = mockCtx();
    layer.applyShotTransform(ctxS, t);
    design.applyDesignScale(ctxS);
    const got = apply(ctxS.matrix(), q);
    assert.ok(Math.abs(got.x - want.x) < 1e-6 && Math.abs(got.y - want.y) < 1e-6,
      `期望 ${JSON.stringify(want)} 实际 ${JSON.stringify(got)}`);
  } finally {
    view.W = saved.W; view.H = saved.H;
  }
});

// ---------- 快路径 / 缓冲路径 ----------

test('默认参数走快路径：不建缓冲、fn 拿到的是同一个 ctx', () => {
  const main = mockCtx('main');
  let seen = null;
  let callsDuring = null;
  layer.withLayer(main, {transform: {x: 10, rotate: 5, scale: 1.2}}, (c) => {
    seen = c;
    callsDuring = main.calls.slice();   // 必须在 fn **执行期间**取样：返回后已 restore
  });
  assert.equal(seen, main, '快路径下 fn 应直接用主 ctx');
  assert.equal(callsDuring.filter((c) => c.startsWith('drawImage')).length, 0, '不该有 drawImage');
  assert.ok(callsDuring.includes('translate') && callsDuring.includes('rotate'), '几何变换应生效');
  assert.equal(main.calls[main.calls.length - 1], 'restore', '应成对 save/restore');
});

test('组透明度走缓冲：fn 拿到缓冲的 ctx，主 ctx 收到 drawImage', () => {
  const main = mockCtx('main');
  let seen = null;
  layer.withLayer(main, {alpha: 0.5}, (c) => { seen = c; });
  assert.notEqual(seen, main, '缓冲路径下 fn 必须画在缓冲上（否则重叠处会被混合两次）');
  assert.equal(seen.__id.startsWith('buf'), true);
  const draws = main.calls.filter((c) => c.startsWith('drawImage'));
  assert.equal(draws.length, 1, '主 ctx 应只贴一次缓冲，实际 ' + JSON.stringify(draws));
});

test('混合模式也走缓冲，且设在主 ctx 上、不在缓冲上', () => {
  const main = mockCtx('main');
  let bufCtx = null;
  let bufBlend = null;
  let mainBlend = null;
  layer.withLayer(main, {blend: 'multiply'}, (c) => {
    bufCtx = c;
    bufBlend = c.globalCompositeOperation;   // 缓冲内部
    mainBlend = main.globalCompositeOperation; // 贴图前的主 ctx（在 fn 期间还未设置）
  });
  assert.ok(bufCtx, '应走缓冲');
  assert.equal(bufBlend, 'source-over', '缓冲内部应按正常模式画');
  assert.ok(mainBlend !== 'multiply', 'fn 执行期间主 ctx 还未设混合模式（设在贴图时）');
  // 返回后可查主 ctx 的最终状态：drawImage 那一次是带 multiply 的
  assert.ok(main.calls.some((c) => c.startsWith('drawImage')));
});

test('缓冲路径继承调用点的变换（嵌在已缩放的上下文里也落在同样坐标）', () => {
  const main = mockCtx('main');
  main.translate(7, 11);           // 模拟「外层已经位移过」
  const outer = main.matrix();
  let bufMatrix = null;
  layer.withLayer(main, {alpha: 0.4}, (c) => { bufMatrix = c.matrix(); });
  // 缓冲在 fn 开始时应当带着与调用点一致的变换（否则内容会错位）
  assert.deepEqual(bufMatrix, outer, '缓冲应继承调用点变换');
});

test('缓冲会被归还池里，不泄漏（live 归零）', () => {
  const main = mockCtx('main');
  const before = layer.bufferStats();
  for (let i = 0; i < 5; i++) layer.withLayer(main, {alpha: 0.3}, () => {});
  const after = layer.bufferStats();
  assert.equal(after.live, 0, '借用数应归零，实际 ' + after.live);
  assert.ok(after.cached >= 1, '应有缓冲被缓存复用，实际 ' + after.cached);
  assert.ok(after.cached <= 4, '同尺寸缓存不该超过上限，实际 ' + after.cached);
  void before;
});

test('负面对照：fn 抛错时也要归还缓冲（否则长片会泄漏到 OOM）', () => {
  const main = mockCtx('main');
  assert.throws(() => layer.withLayer(main, {alpha: 0.5}, () => { throw new Error('渲染中抛错'); }),
    /渲染中抛错/);
  assert.equal(layer.bufferStats().live, 0, '抛错后 live 也必须归零，实际 ' + layer.bufferStats().live);
});

test('shot 模式 + 组透明度：缓冲里也带上共轭变换', () => {
  const saved = {W: view.W, H: view.H};
  try {
    view.W = 1000; view.H = 1000;
    const main = mockCtx('main');
    let bufMatrix = null;
    const t = {x: 20, scale: 1.1};
    layer.withLayer(main, {transform: t, alpha: 0.5, mode: 'shot'}, (c) => {
      bufMatrix = c.matrix();   // fn 执行期间：应当是「调用点变换 ∘ 共轭变换」
    });
    assert.ok(bufMatrix, '应走缓冲');
    // 期望：单位矩阵 ∘ applyShotTransform(t)（调用点是单位矩阵）
    const expect = mockCtx();
    layer.applyShotTransform(expect, t);
    const b = expect.matrix();
    for (const k of ['a', 'b', 'c', 'd', 'e', 'f']) {
      assert.ok(Math.abs(bufMatrix[k] - b[k]) < 1e-9,
        `矩阵分量 ${k} 不一致：缓冲 ${bufMatrix[k]} vs 期望 ${b[k]}`);
    }
  } finally {
    view.W = saved.W; view.H = saved.H;
  }
});
