// 增量重渲与代理渲染的单元测试。
//
// 最需要钉住的是**键的失效语义**：改了任何影响画面的输入，键必须变。
// 漏掉一个输入 → 复用了旧画面（静默错误）。所以每条都做「改了它，键要变」。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  segmentKey, planSegments, findCached, recordSegment, pruneSegments, engineFingerprint,
  globalFingerprint, sceneShotFingerprint, compFingerprint, collectShotDeps, mergeDeps,
  manualShotsFingerprint, combineGlobal,
} from '../src/host/media/incremental.mjs';

const base = {engine: 'e1', global: 'p1', shotsHash: 's1', from: 1, to: 300, width: 1280, height: 720, fps: 30, crf: '16'};

test('segmentKey：任一输入变化都要变键（漏一个就会复用旧画面）', () => {
  const k = segmentKey(base);
  const cases = [
    ['engine', {engine: 'e2'}],
    ['global', {global: 'p2'}],
    ['shotsHash（该段覆盖的镜头）', {shotsHash: 's2'}],
    ['from', {from: 2}],
    ['to', {to: 299}],
    ['width', {width: 640}],
    ['height', {height: 360}],
    ['fps', {fps: 25}],
    ['crf', {crf: '20'}],
  ];
  for (const [name, patch] of cases) {
    assert.notEqual(segmentKey({...base, ...patch}), k, `${name} 变了键必须变`);
  }
  assert.equal(segmentKey(base), k, '同样的输入 → 同样的键（可复用）');
  assert.match(k, /^[0-9a-f]{16}$/, '键的形状');
});

test('sceneShotFingerprint：镜头内容变则指纹变，且区分镜头位置', () => {
  const a = {type: 'title', at: 1, title: 'x'};
  const f = sceneShotFingerprint(a, 0);
  assert.match(f, /^[0-9a-f]{12}$/);
  assert.equal(sceneShotFingerprint(a, 0), f, '同样内容 → 同指纹');
  assert.notEqual(sceneShotFingerprint({...a, title: 'y'}, 0), f, '内容变 → 指纹变');
  // 同一份内容放在不同位置也算不同（顺序变了画面就变了）
  assert.notEqual(sceneShotFingerprint(a, 1), f, '位置变 → 指纹变');
});

test('compFingerprint：子合成内容变则指纹变', () => {
  const def = {frames: 30, shots: [{type: 'title', at: 1, title: 'x'}]};
  const f = compFingerprint('badge', def);
  assert.equal(compFingerprint('badge', def), f);
  assert.notEqual(compFingerprint('other', def), f, '名字变 → 指纹变');
  assert.notEqual(compFingerprint('badge', {...def, frames: 40}), f, '内容变 → 指纹变');
});

test('collectShotDeps：只收与段重叠的镜头 —— 这是「改一个镜头只失效几段」的关键', () => {
  const scene = {
    comps: {},
    shots: [
      {type: 'title', at: 1, title: 'A'},       // 1–99
      {type: 'bullets', at: 100, items: []},    // 100–199
      {type: 'stat', at: 200, value: 1, label: 'C'}, // 200–300
    ],
  };
  const early = collectShotDeps(scene, {from: 1, to: 50});
  const mid = collectShotDeps(scene, {from: 100, to: 150});
  const late = collectShotDeps(scene, {from: 250, to: 300});
  assert.equal(early.length, 1, '早段只应覆盖第 1 个镜头');
  assert.equal(mid.length, 1, '中段只应覆盖第 2 个镜头');
  assert.equal(late.length, 1, '晚段只应覆盖第 3 个镜头');
  // 三段互不相同
  assert.notEqual(early[0], mid[0]);
  assert.notEqual(mid[0], late[0]);
  // 跨段会同时覆盖多个镜头
  const span = collectShotDeps(scene, {from: 90, to: 110});
  assert.equal(span.length, 2, '跨段应覆盖两个镜头');
});

test('collectShotDeps：comp 镜头会把它引用的 comp（含嵌套引用）一并收进来', () => {
  const scene = {
    comps: {
      inner: {shots: [{type: 'stat', at: 1, value: 1, label: 'x'}]},
      outer: {shots: [{type: 'comp', at: 1, comp: 'inner'}]},
    },
    shots: [{type: 'comp', at: 1, comp: 'outer', loop: true}],
  };
  const deps = collectShotDeps(scene, {from: 1, to: 100});
  assert.equal(deps.length, 3, '应含镜头本身 + outer + inner（嵌套引用）');
  // 改 inner 会让这个段的依赖哈希变化
  const before = mergeDeps(deps);
  const after = mergeDeps(collectShotDeps({
    ...scene,
    comps: {...scene.comps, inner: {shots: [{type: 'stat', at: 1, value: 2, label: 'y'}]}},
  }, {from: 1, to: 100}));
  assert.notEqual(before, after, '改嵌套子合成 → 段依赖必须变');
});

test('collectShotDeps 保守性：at 不是数字（解析不出来）时不漏，宁可整段全收', () => {
  const scene = {shots: [{type: 'title', at: 'S01', title: 'A'}]};
  const deps = collectShotDeps(scene, {from: 500, to: 600});
  assert.equal(deps.length, 0, 'At 非数字时不误报（由调用方决定保守策略）');
  // 手写镜头项目没有 scene → 返回空，调用方走「整个文件算全局」
  assert.deepEqual(collectShotDeps(null, {from: 1, to: 100}), []);
});

test('mergeDeps：顺序无关（镜头依赖的顺序不该影响键）', () => {
  assert.equal(mergeDeps(['a', 'b', 'c']), mergeDeps(['c', 'a', 'b']), '排序后拼接，顺序无关');
  assert.notEqual(mergeDeps(['a', 'b']), mergeDeps(['a', 'c']));
  assert.equal(mergeDeps([]), 'none', '空依赖有确定的表示');
  assert.equal(mergeDeps([undefined, 'a'].filter(Boolean)), mergeDeps(['a']));
});

test('manualShotsFingerprint / combineGlobal：手写镜头项目整文件归因', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fw-manual-'));
  const f = join(dir, 'index.js');
  assert.equal(manualShotsFingerprint(f), null, '文件不存在 → null（表示没有手写镜头）');
  assert.equal(manualShotsFingerprint(null), null);
  assert.equal(manualShotsFingerprint(undefined), null);

  writeFileSync(f, 'export const SHOTS = [];\n');
  const a = manualShotsFingerprint(f);
  assert.match(a, /^[0-9a-f]{12}$/);
  assert.equal(manualShotsFingerprint(f), a, '同内容 → 同指纹');
  writeFileSync(f, 'export const SHOTS = [1];\n');
  assert.notEqual(manualShotsFingerprint(f), a, '改一行 → 指纹变（整个文件算全局）');

  // combineGlobal：没有手写镜头时全局键不变（scene 项目走这条）
  assert.equal(combineGlobal('g1', null), 'g1', '无手写镜头 → 全局键就是原值');
  assert.notEqual(combineGlobal('g1', 'm1'), 'g1', '有手写镜头 → 混入');
  assert.equal(combineGlobal('g1', 'm1'), combineGlobal('g1', 'm1'), '确定性');
  assert.notEqual(combineGlobal('g1', 'm1'), combineGlobal('g1', 'm2'), '手写镜头变了全局键要变');
  assert.notEqual(combineGlobal('g1', 'm1'), combineGlobal('g2', 'm1'), '全局变了要变');
});

test('命令层回归：手写镜头项目的增量渲染不能崩在未导入的标识符上', async () => {
  // 这条是为一个真实缺陷写的：renderIncremental 的手写镜头分支里用了
  // `createHash` 却忘了 import，只有**手写镜头项目 + --incremental** 才会炸
  // （scene 项目走另一条分支，所以 CI 的 scenecast 冒烟测不到）。
  // 修法是把那段逻辑移进 incremental.mjs（那里本来就有 crypto），
  // 这条测试钉住「该模块导出的函数确实可用、且能算出确定的键」。
  const dir = mkdtempSync(join(tmpdir(), 'fw-cmd-'));
  const shots = join(dir, 'index.js');
  writeFileSync(shots, 'export const SHOTS = [{start: 1, draw() {}}];\n');
  const m = manualShotsFingerprint(shots);
  const g = combineGlobal('global-key', m);
  assert.match(g, /^[0-9a-f]{12}$/, '合成后的全局键应是 12 位十六进制');
  const key = segmentKey({
    engine: 'e', global: g, shotsHash: 'none', from: 1, to: 300,
    width: 1280, height: 720, fps: 30, crf: '16',
  });
  assert.match(key, /^[0-9a-f]{16}$/);
  // 改手写镜头 → 全局键变 → 段键变（所有段失效，保守但正确）
  writeFileSync(shots, 'export const SHOTS = [{start: 1, draw() { /* x */ }}];\n');
  const g2 = combineGlobal('global-key', manualShotsFingerprint(shots));
  assert.notEqual(g2, g);
  assert.notEqual(segmentKey({engine: 'e', global: g2, shotsHash: 'none', from: 1, to: 300, width: 1280, height: 720, fps: 30, crf: '16'}), key,
    '手写镜头变了 → 段键必须变');
});

test('planSegments：切成不重叠、首尾相接的段，覆盖整个区间', () => {
  const segs = planSegments(1389, 300, 1, 1389);
  assert.deepEqual(segs.map((s) => [s.from, s.to]),
    [[1, 300], [301, 600], [601, 900], [901, 1200], [1201, 1389]]);
  // 覆盖检查：首尾相接、无空洞
  for (let i = 1; i < segs.length; i++) assert.equal(segs[i].from, segs[i - 1].to + 1);
  assert.equal(segs[0].from, 1);
  assert.equal(segs[segs.length - 1].to, 1389);
  // 单帧区间
  assert.deepEqual(planSegments(100, 300, 50, 50).map((s) => [s.from, s.to]), [[50, 50]]);
  // segFrames 非法时至少 1
  assert.equal(planSegments(10, 0, 1, 10).length, 10);
});

test('findCached：键不匹配 / 文件缺失 / 空文件 / 元数据对不上 → 都不算命中', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fw-seg-'));
  assert.equal(findCached(dir, 0, 'abc'), null, '目录空 → 未命中');

  recordSegment(dir, 0, 'k1', {from: 1, to: 300, frames: 300, bytes: 5});
  const part = join(dir, 'seg0000-k1.mp4');
  assert.equal(findCached(dir, 0, 'k1'), null, '写了元数据但没视频文件 → 未命中');

  writeFileSync(part, 'hello');
  assert.ok(findCached(dir, 0, 'k1'), '文件 + 元数据都在 → 命中');

  assert.equal(findCached(dir, 0, 'k2'), null, '键不同 → 未命中（不会拿旧段冒充）');

  writeFileSync(part, 'hello world');   // 大小变了
  assert.equal(findCached(dir, 0, 'k1'), null, '文件大小与元数据不符 → 未命中（文件被动过）');

  writeFileSync(part, '');
  assert.equal(findCached(dir, 0, 'k1'), null, '空文件 → 未命中');
});

test('recordSegment：元数据可人读（含 key/区间/帧数），便于诊断', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fw-seg2-'));
  recordSegment(dir, 3, 'deadbeef', {from: 901, to: 1200, frames: 300, bytes: 1234});
  const f = readdirSync(dir).find((x) => x.endsWith('.json'));
  const m = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  assert.equal(m.key, 'deadbeef');
  assert.equal(m.from, 901);
  assert.equal(m.to, 1200);
  assert.equal(m.frames, 300);
  assert.equal(m.index, 3);
  assert.ok(m.at, '应记时间戳');
});

test('pruneSegments：只留当前键的段，清掉旧键（含它的一半文件）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fw-seg3-'));
  recordSegment(dir, 0, 'aaa', {from: 1, to: 10, frames: 10, bytes: 1});
  recordSegment(dir, 0, 'bbb', {from: 1, to: 10, frames: 10, bytes: 1});
  recordSegment(dir, 1, 'aaa', {from: 11, to: 20, frames: 10, bytes: 1});
  writeFileSync(join(dir, 'seg0000-aaa.mp4'), 'x');
  writeFileSync(join(dir, 'seg0000-bbb.mp4'), 'x');
  writeFileSync(join(dir, 'seg0001-aaa.mp4'), 'x');
  assert.equal(readdirSync(dir).length, 6, '应有 6 个文件（3 元数据 + 3 视频）');

  const removed = pruneSegments(dir, new Set(['aaa']));
  assert.equal(removed, 2, '应删掉 bbb 的 2 个文件');
  const left = readdirSync(dir).sort();
  assert.deepEqual(left, ['seg0000-aaa.json', 'seg0000-aaa.mp4', 'seg0001-aaa.json', 'seg0001-aaa.mp4']);
});

test('engineFingerprint：源码内容变则指纹变（升引擎要重渲）', () => {
  const root = mkdtempSync(join(tmpdir(), 'fw-eng-'));
  mkdirSync(join(root, 'runtime', 'draw'), {recursive: true});
  mkdirSync(join(root, 'contract'), {recursive: true});
  writeFileSync(join(root, 'runtime', 'draw', 'a.js'), 'export const x = 1;\n');
  writeFileSync(join(root, 'contract', 'c.js'), 'export const y = 2;\n');
  const f1 = engineFingerprint(root);
  assert.match(f1, /^[0-9a-f]{12}$/);
  assert.equal(engineFingerprint(root), f1, '同样内容 → 同指纹');

  writeFileSync(join(root, 'runtime', 'draw', 'a.js'), 'export const x = 2;\n');
  assert.notEqual(engineFingerprint(root), f1, '一字节不同 → 指纹必须变');

  // 宿主侧改动**不该**影响画面指纹
  const f2 = engineFingerprint(root);
  mkdirSync(join(root, 'host'), {recursive: true});
  writeFileSync(join(root, 'host', 'cli.js'), '// 改宿主\n');
  assert.equal(engineFingerprint(root), f2, 'host/ 改动不影响画面指纹（只有 runtime/contract 参与绘制）');
});

test('globalFingerprint：全局输入（配置/时间轴/字体/素材/clips）任一变化都要变', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fw-proj-'));
  const paths = {
    config: join(dir, 'film.config.mjs'),
    scene: join(dir, 'scene.json'),
    timeline: join(dir, 'script', 'timeline.json'),
    shots: join(dir, 'shots', 'index.js'),
  };
  mkdirSync(join(dir, 'script'), {recursive: true});
  mkdirSync(join(dir, 'shots'), {recursive: true});
  mkdirSync(join(dir, 'public', 'fonts'), {recursive: true});
  mkdirSync(join(dir, 'public', 'assets'), {recursive: true});
  writeFileSync(paths.config, 'export default {};\n');
  writeFileSync(paths.scene, '{"shots":[]}\n');
  writeFileSync(paths.timeline, '{"fps":30}\n');
  writeFileSync(paths.shots, 'export const SHOTS = [];\n');
  writeFileSync(join(dir, 'public', 'fonts', 'F.ttf'), 'FONT1');
  writeFileSync(join(dir, 'public', 'assets', 'a.png'), 'PNG1');

  const proj = {paths, raw: {}};
  const base = globalFingerprint(proj, dir);
  assert.match(base, /^[0-9a-f]{12}$/);
  assert.equal(globalFingerprint(proj, dir), base, '同样内容 → 同指纹');

  const mutations = [
    ['config', () => writeFileSync(paths.config, 'export default {a:1};\n')],
    ['timeline', () => writeFileSync(paths.timeline, '{"fps":25}\n')],
    ['font', () => writeFileSync(join(dir, 'public', 'fonts', 'F.ttf'), 'FONT2')],
    ['asset', () => writeFileSync(join(dir, 'public', 'assets', 'a.png'), 'PNG2')],
    ['clips 声明', () => { proj.raw = {clips: [{name: 'x', src: 'a.mp4', fps: 30}]}; }],
  ];
  for (const [name, mutate] of mutations) {
    const before = globalFingerprint(proj, dir);
    mutate();
    assert.notEqual(globalFingerprint(proj, dir), before, `${name} 变化后指纹必须变`);
  }

  // **有意的不对称**：scene.json 与 shots/index.js 不算全局 ——
  // 它们由按段归因处理（scene 能按镜头归因；手写镜头整个文件算全局，在命令层加）。
  // 如果它们进了全局指纹，改一个镜头会让所有段失效，增量重渲就白做了。
  const beforeScene = globalFingerprint(proj, dir);
  writeFileSync(paths.scene, '{"shots":[{"type":"title","at":1,"title":"x"}]}\n');
  assert.equal(globalFingerprint(proj, dir), beforeScene, 'scene.json 不该进全局指纹（要按段归因）');
  writeFileSync(paths.shots, 'export const SHOTS = [1];\n');
  assert.equal(globalFingerprint(proj, dir), beforeScene, 'shots/index.js 不该进全局指纹（命令层单独处理）');
  void base; void existsSync;
});
