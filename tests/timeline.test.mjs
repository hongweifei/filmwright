// 时间轴查询的单元测试。
// 这里最容易错的是**块归属**：字幕块要按句区间过滤，取错了就会让镜头对错节拍。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  setTimeline, isReady, timeline, S, BLK, cutBefore, cardFrom, cardRange,
  chapterAt, tailFrom,
} from '../src/contract/timeline.js';

/** 造一份时间轴：2 章、3 句、每句 2 块。 */
function sample() {
  return {
    fps: 30,
    total_frames: 900,
    chapters: [{n: 1, title: '一', from: 1}, {n: 2, title: '二', from: 500}],
    sentences: [
      {id: 'S01', chapter: 1, from: 100, to: 200, text: 'a'},
      {id: 'S02', chapter: 1, from: 220, to: 320, text: 'b'},
      {id: 'S03', chapter: 2, from: 520, to: 620, text: 'c'},
    ],
    subs: [
      {from: 100, to: 150, text: 'a1'}, {from: 151, to: 200, text: 'a2'},
      {from: 220, to: 270, text: 'b1'}, {from: 271, to: 320, text: 'b2'},
      {from: 520, to: 560, text: 'c1'}, {from: 561, to: 620, text: 'c2'},
    ],
  };
}

test('装载前的查询要报错，而不是给出 undefined', () => {
  // 注意：模块级单例，所以这里只验证错误信息形状（别的用例会装载）
  setTimeline(sample());
  assert.equal(isReady(), true);
  assert.throws(() => S('S99'), /不存在的句 id/);
});

test('空时间轴要报错（否则会画出一部空片）', () => {
  assert.throws(() => setTimeline(null), /时间轴为空/);
  assert.throws(() => setTimeline({sentences: []}), /一句都没有/);
});

test('句子字段非法要报错', () => {
  assert.throws(() => setTimeline({sentences: [{id: 'S1', from: 0, to: 5}]}), /id\/from\/to/);
  assert.throws(() => setTimeline({sentences: [{id: 'S1', from: 10, to: 5}]}), /id\/from\/to/);
  assert.throws(() => setTimeline({sentences: [{from: 1, to: 5}]}), /id\/from\/to/);
});

test('S / BLK：块要按句区间过滤，不能取到别句的块', () => {
  setTimeline(sample());
  assert.equal(S('S01').from, 100);
  assert.equal(BLK('S01', 1), 100);
  assert.equal(BLK('S01', 2), 151);
  assert.equal(BLK('S02', 1), 220, 'S02 的第 1 块不能被 S01 的块顶掉');
  assert.equal(BLK('S03', 2), 561);
});

test('BLK 越界要报错并说清有几块', () => {
  setTimeline(sample());
  assert.throws(() => BLK('S01', 3), /没有第 3 个字幕块（它共 2 块）/);
  assert.throws(() => BLK('S01', 0), /没有第 0 个字幕块/);
});

test('cutBefore：落在该句起点之前', () => {
  setTimeline(sample());
  assert.equal(cutBefore('S02'), 212);
  assert.equal(cutBefore('S02', 20), 200);
  // 不能算出 0 或负数（第 1 帧是最小值）
  assert.equal(cutBefore('S01', 999), 1);
});

test('cardRange：第 1 章没有卡，第 2 章落在两句之间的空白里', () => {
  setTimeline(sample());
  assert.equal(cardRange(1), null, '第 1 章不该有章节卡');
  const r = cardRange(2);
  assert.deepEqual(r, {from: 323, to: 511}, '应落在 S02 结束+3 到 S03 起点-9');
  assert.equal(cardFrom(2), 323);
});

test('cardRange：不存在的章要报错', () => {
  setTimeline(sample());
  assert.throws(() => cardRange(9), /第 9 章里没有句子/);
});

test('chapterAt：按章起点判定，边界取该章', () => {
  setTimeline(sample());
  assert.equal(chapterAt(1), 1);
  assert.equal(chapterAt(499), 1);
  assert.equal(chapterAt(500), 2, '章起点那一帧应算第 2 章');
  assert.equal(chapterAt(900), 2);
});

test('tailFrom：末句结束 +12', () => {
  setTimeline(sample());
  assert.equal(tailFrom(), 632);
});

test('timeline 是活引用（镜头靠它读 fps / 总帧数）', () => {
  setTimeline(sample());
  assert.equal(timeline.fps, 30);
  assert.equal(timeline.totalFrames, 900);
  assert.equal(timeline.subs.length, 6);
});
