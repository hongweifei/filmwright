// 片段素材：映射函数的单元测试。
//
// 最需要钉住的是 `sourceIndex`（全局帧 → 源帧）——它是「不变量仍然成立」的
// 数学基础：同一 n 必须永远得到同一张图，且边界要夹得住。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sourceIndex, setClips, clipFrame, clipInfo, clipNames, decodedCount} from '../src/runtime/clips.js';
import {clipKey, isPrepared, countFrames} from '../src/host/media/clips.mjs';

const reg = (frames, fps) => ({frames, fps, urls: [], imgs: new Array(frames).fill(null)});

test('sourceIndex：同源帧率时一一对应（30fps → 30fps）', () => {
  const r = reg(300, 30);
  assert.equal(sourceIndex(1, r, 30, 1), 0, '全局第 1 帧 → 源下标 0');
  assert.equal(sourceIndex(2, r, 30, 1), 1);
  assert.equal(sourceIndex(31, r, 30, 1), 30, '第 31 帧（1 秒后）→ 源第 31 帧');
});

test('sourceIndex：源帧率高于输出时按比例抽（60fps 源 → 30fps 输出）', () => {
  const r = reg(600, 60);
  assert.equal(sourceIndex(1, r, 30, 1), 0);
  assert.equal(sourceIndex(2, r, 30, 1), 2, '输出第 2 帧 → 源第 3 帧（0 基 2）');
  assert.equal(sourceIndex(31, r, 30, 1), 60, '输出 1 秒后 → 源 2 秒处');
});

test('sourceIndex：源帧率低于输出时重复取同一帧（不越界、不插值）', () => {
  const r = reg(100, 10);
  assert.equal(sourceIndex(1, r, 30, 1), 0);
  assert.equal(sourceIndex(2, r, 30, 1), 0, '0.033s × 10fps = 0.33 → 取整 0');
  assert.equal(sourceIndex(4, r, 30, 1), 1, '0.1s × 10fps = 1');
});

test('sourceIndex：边界夹紧 —— 起点前、终点后都不越界', () => {
  const r = reg(50, 30);
  assert.equal(sourceIndex(1, r, 30, 100), 0, 'n 早于 from 时夹到第 1 帧');
  assert.equal(sourceIndex(1000, r, 30, 1), 49, '超出末尾时夹到最后一帧');
  assert.equal(sourceIndex(60, r, 30, 1), 49, '正好到末尾');
});

test('sourceIndex 是纯函数：同一输入多次调用结果相同', () => {
  const r = reg(200, 25);
  for (const [n, fps, from] of [[1, 30, 1], [37, 30, 1], [37, 60, 10], [500, 30, 1]]) {
    assert.equal(sourceIndex(n, r, fps, from), sourceIndex(n, r, fps, from));
  }
});

test('setClips / clipFrame 负面对照：未声明的片段名要报错并列出可用的', () => {
  setClips({a: {dir: '/x/a', frames: 10, fps: 30, src: '/a.mp4'}});
  assert.deepEqual(clipNames(), ['a']);
  assert.throws(() => clipFrame('nope', 1), /没有名为「nope」的片段.*已声明的片段：a/s);
});

test('clipFrame 负面对照：没预解码的帧要抛错（而不是画空白）', () => {
  setClips({a: {dir: '/x/a', frames: 10, fps: 30, src: '/a.mp4'}});
  // 一个 Image 都没预解码
  assert.throws(() => clipFrame('a', 1), /没预解码/);
  assert.equal(decodedCount('a'), 0);
});

test('clipKey：源或参数变化都会产生不同的键（内容寻址）', () => {
  const st = {size: 1000, mtimeMs: 12345};
  const base = {name: 'a', src: '/a.mp4', fps: 30, width: 0, start: 0, maxSec: 0};
  const k1 = clipKey(base, st);
  assert.notEqual(clipKey({...base, fps: 60}, st), k1, 'fps 变了键要变');
  assert.notEqual(clipKey({...base, width: 640}, st), k1, 'width 变了键要变');
  assert.notEqual(clipKey({...base, start: 5}, st), k1, 'start 变了键要变');
  assert.notEqual(clipKey({...base, maxSec: 3}, st), k1, 'maxSec 变了键要变');
  assert.notEqual(clipKey(base, {size: 2000, mtimeMs: 12345}), k1, '源文件大小变了键要变');
  assert.notEqual(clipKey(base, {size: 1000, mtimeMs: 99999}), k1, '源文件时间变了键要变');
  assert.equal(clipKey(base, st), k1, '同样的源与参数 → 同样的键（缓存命中）');
  assert.match(k1, /^a-[0-9a-f]{8}$/, '键的形状：名字-8位哈希');
});

test('isPrepared / countFrames：非目录、缺完成标记、空序列都算未就绪', async () => {
  const {mkdtempSync, mkdirSync, writeFileSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const base = mkdtempSync(join(tmpdir(), 'fw-clip-'));

  assert.equal(isPrepared(join(base, 'nope')), false, '目录不存在');

  const noDone = join(base, 'nodone');
  mkdirSync(noDone, {recursive: true});
  writeFileSync(join(noDone, 'f00001.png'), 'x');
  assert.equal(isPrepared(noDone), false, '有帧但没有 .done 标记 → 未就绪（防止把抽到一半的当完整）');

  const empty = join(base, 'empty');
  mkdirSync(empty, {recursive: true});
  writeFileSync(join(empty, '.done'), '{}');
  assert.equal(isPrepared(empty), false, '有标记但没有帧 → 未就绪');

  const good = join(base, 'good');
  mkdirSync(good, {recursive: true});
  writeFileSync(join(good, 'f00001.png'), 'x');
  writeFileSync(join(good, 'f00002.png'), 'x');
  writeFileSync(join(good, '.done'), '{}');
  assert.equal(isPrepared(good), true, '帧 + 标记 → 就绪');
  assert.equal(countFrames(good), 2, '应数出 2 帧（.done 不算）');
});

test('clipInfo：未声明时报错；声明的返回帧数与帧率', () => {
  setClips({a: {dir: '/x/a', frames: 42, fps: 24, src: '/a.mp4'}});
  const info = clipInfo('a');
  assert.equal(info.frames, 42);
  assert.equal(info.fps, 24);
  assert.equal(info.src, '/a.mp4');
  assert.throws(() => clipInfo('nope'), /没有名为「nope」的片段/);
});
