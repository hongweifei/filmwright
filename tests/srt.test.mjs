// SRT 导出的单元测试：时间戳换算、块间空隙不闪断、双语轨、错误路径。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildSrt, frameToTime, exportSrt, readTranslation} from '../src/host/media/srt.mjs';

const tl = {
  fps: 30,
  subs: [
    {from: 1, to: 60, text: '第一块'},
    {from: 75, to: 120, text: '第二块'},   // 与上一块之间有 15 帧空隙
  ],
};

test('frameToTime：帧 1 是 0 点，按 fps 换算到毫秒', () => {
  assert.equal(frameToTime(1, 30), '00:00:00,000');
  assert.equal(frameToTime(31, 30), '00:00:01,000');
  assert.equal(frameToTime(1, 25), '00:00:00,000');
  // 第 1801 帧 @30fps = 60 秒
  assert.equal(frameToTime(1801, 30), '00:01:00,000');
  // 毫秒位补零
  assert.equal(frameToTime(2, 30), '00:00:00,033');
});

test('buildSrt：序号、时间轴、文本齐全', () => {
  const s = buildSrt(tl);
  assert.ok(s.startsWith('1\n00:00:00,000 --> '), '第一块应以序号 1 与时间戳开头');
  assert.ok(s.includes('第一块'));
  assert.ok(s.includes('第二块'));
  assert.ok(s.trimEnd().endsWith('第二块'), '最后一块是末行');
});

test('块间空隙不闪断：结束时间取下一块的开始，而不是本块的 to', () => {
  const s = buildSrt(tl);
  // 第一块 to=60（=1.97s），第二块 from=75（=2.47s）→ 结束应取 75 帧
  const end = frameToTime(75, 30);
  assert.ok(s.includes(`--> ${end}`), '第一块的结束时间应延到下一块开始（避免空隙里字幕消失）');
  assert.ok(!s.includes(`--> ${frameToTime(60, 30)}`), '不该用本块 to 作为结束');
});

test('末块用自身 to 收尾', () => {
  const s = buildSrt(tl);
  assert.ok(s.includes(`--> ${frameToTime(120, 30)}`));
});

test('双语：Map 按块序号对齐，缺项只出原文（不编内容）', () => {
  const s = buildSrt(tl, {translation: new Map([[1, 'Block one']])});
  assert.ok(s.includes('第一块\nBlock one'), '第一块应带译文');
  assert.ok(s.includes('第二块\n\n') || s.trimEnd().endsWith('第二块'), '第二块没译文就只出原文');
  assert.ok(!s.includes('undefined') && !s.includes('null'), '缺项不得写出占位文本');
});

test('双语：数组按 from 帧对齐', () => {
  const s = buildSrt(tl, {translation: [{from: 75, to: 120, text: 'Block two'}]});
  assert.ok(s.includes('第二块\nBlock two'));
  // 第一块没给译文：它的正文之后应直接是空行（即下一块的分隔），而不是多出一行文本
  assert.ok(s.includes('第一块\n\n'), '没译文的块只出原文，不凭空加行');
  assert.ok(!s.includes('Block two\n第一块'), '译文不得错位到别的块');
});

test('负面对照：没有字幕块要报 NO_SUBS 并给出路', () => {
  assert.throws(() => buildSrt({fps: 30, subs: []}),
    (e) => e.code === 'NO_SUBS' && e.hint.includes('tts'));
});

test('负面对照：没有时间轴要报 NO_TIMELINE', () => {
  assert.throws(() => exportSrt({paths: {}, raw: {slug: 'x'}, timeline: null}),
    (e) => e.code === 'NO_TIMELINE');
});

test('负面对照：译文文件不存在要报 NO_TRANSLATION_FILE 并说明两种格式', () => {
  assert.throws(() => readTranslation(join(tmpdir(), 'definitely-not-here-xyz.json')),
    (e) => e.code === 'NO_TRANSLATION_FILE' && e.hint.includes('from'));
});

test('readTranslation：数组原样返回；对象转成按块序号的 Map', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fw-srt-'));
  const arr = join(dir, 'a.json');
  writeFileSync(arr, JSON.stringify([{from: 1, to: 2, text: 'x'}]), 'utf8');
  assert.ok(Array.isArray(readTranslation(arr)));
  const obj = join(dir, 'b.json');
  writeFileSync(obj, JSON.stringify({1: '甲', 2: '乙'}), 'utf8');
  const m = readTranslation(obj);
  assert.ok(m instanceof Map);
  assert.equal(m.get(1), '甲');
  assert.equal(m.get(2), '乙');
});

test('exportSrt：真写文件，默认落在 script/<slug>.srt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fw-srt2-'));
  const proj = {
    raw: {slug: 'demo'},
    paths: {timeline: join(dir, 'script', 'timeline.json')},
    timeline: tl,
  };
  const r = exportSrt(proj);
  assert.equal(r.out, join(dir, 'script', 'demo.srt'));
  assert.equal(r.blocks, 2);
  assert.equal(r.bilingual, false);
  const body = readFileSync(r.out, 'utf8');
  assert.ok(body.includes('第一块') && body.includes('第二块'));
});
