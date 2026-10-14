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
  segmentKey, planSegments, findCached, recordSegment, pruneSegments, engineFingerprint, projectFingerprint,
} from '../src/host/media/incremental.mjs';

const base = {engine: 'e1', project: 'p1', from: 1, to: 300, width: 1280, height: 720, fps: 30, crf: '16'};

test('segmentKey：任一输入变化都要变键（漏一个就会复用旧画面）', () => {
  const k = segmentKey(base);
  const cases = [
    ['engine', {engine: 'e2'}],
    ['project', {project: 'p2'}],
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

test('projectFingerprint：配置/场景/时间轴/镜头/字体/素材任一变化都要变', () => {
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
  const base = projectFingerprint(proj, dir);
  assert.match(base, /^[0-9a-f]{12}$/);
  assert.equal(projectFingerprint(proj, dir), base, '同样内容 → 同指纹');

  const mutations = [
    ['config', () => writeFileSync(paths.config, 'export default {a:1};\n')],
    ['scene', () => writeFileSync(paths.scene, '{"shots":[1]}\n')],
    ['timeline', () => writeFileSync(paths.timeline, '{"fps":25}\n')],
    ['shots', () => writeFileSync(paths.shots, 'export const SHOTS = [1];\n')],
    ['font', () => writeFileSync(join(dir, 'public', 'fonts', 'F.ttf'), 'FONT2')],
    ['asset', () => writeFileSync(join(dir, 'public', 'assets', 'a.png'), 'PNG2')],
  ];
  for (const [name, mutate] of mutations) {
    const before = projectFingerprint(proj, dir);
    mutate();
    assert.notEqual(projectFingerprint(proj, dir), before, `${name} 变化后指纹必须变`);
  }
  void base; void existsSync;
});
