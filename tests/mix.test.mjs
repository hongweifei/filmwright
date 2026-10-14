// 配乐混音的单测：滤镜链构造（纯函数）+ 配置校验的错误路径。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildMixFilter} from '../src/host/media/mix.mjs';
import {normalizeConfig} from '../src/contract/config.js';

// ---------- 滤镜链 ----------

test('默认链：音乐被 sidechain 压，amix 不归一化（人声电平不被稀释）', () => {
  const f = buildMixFilter({voiceDur: 60, musicDur: 90, gain: -14, duck: 10, fadeIn: 1, fadeOut: 2});
  assert.match(f, /\[1:a\]volume=-14dB/, '音乐先按 gain 压');
  assert.match(f, /afade=t=in:st=0:d=1/, '片头淡入');
  assert.match(f, /afade=t=out:st=88\.000:d=2\.000/, '淡出按音乐实际时长（90s）算，不是人声时长');
  assert.match(f, /\[bg\]\[sc\]sidechaincompress=/, '**音乐在前、人声在后**（写反会压到人声）');
  assert.match(f, /\[0:a\]asplit=2\[voice\]\[sc\]/, '人声分成两路：一路输出、一路当 sidechain');
  assert.match(f, /amix=inputs=2:duration=first:normalize=0\[out\]/, 'amix 必须 normalize=0');
  // sidechain 之后**不能**再挂音量层：那会让音乐在人声停下后仍被永久压低
  // （实测纯音乐段比 duck=0 低 4dB —— 闪避没释放）
  const afterSidechain = f.split('sidechaincompress')[1] ?? '';
  assert.ok(!/volume=-/.test(afterSidechain),
    'sidechain 之后不该再有无条件音量下压（否则闪避不释放）：' + afterSidechain);
  // 参数必须在 ffmpeg 允许范围内（makeup ≥1、ratio ≤20、mix ≤1）
  const makeup = Number((f.match(/makeup=([\d.]+)/) ?? [])[1]);
  const ratio = Number((f.match(/ratio=([\d.]+)/) ?? [])[1]);
  const mix = Number((f.match(/:mix=([\d.]+)/) ?? [])[1]);
  assert.ok(makeup >= 1, 'makeup 必须 ≥1（文档范围 1–64），实际 ' + makeup);
  assert.ok(ratio >= 1 && ratio <= 20, 'ratio 必须在 1–20，实际 ' + ratio);
  assert.ok(mix > 0 && mix <= 1, 'mix 必须在 0–1，实际 ' + mix);
});

test('duck 越大压得越深：ratio 与 mix 单调不减', () => {
  const a = buildMixFilter({voiceDur: 60, musicDur: 90, gain: -14, duck: 4, fadeIn: 0, fadeOut: 0});
  const b = buildMixFilter({voiceDur: 60, musicDur: 90, gain: -14, duck: 16, fadeIn: 0, fadeOut: 0});
  const num = (f, k) => Number((f.match(new RegExp(k + '=([\\d.]+)')) ?? [])[1]);
  assert.ok(num(b, 'ratio') > num(a, 'ratio'), 'duck 大 → ratio 大');
  assert.ok(num(b, 'mix') >= num(a, 'mix'), 'duck 大 → mix 不小');
});

test('duck=0 关掉 sidechain：直接混合，不出现 sidechaincompress', () => {
  const f = buildMixFilter({voiceDur: 60, musicDur: 90, gain: -14, duck: 0, fadeIn: 0, fadeOut: 0});
  assert.ok(!f.includes('sidechaincompress'), 'duck=0 时不该有 sidechain');
  assert.match(f, /\[0:a\]\[bg\]amix=inputs=2:duration=first:normalize=0\[out\]/);
  assert.ok(!f.includes('afade'), 'fadeIn/fadeOut=0 时不加淡入淡出');
});

test('音乐比片子短：淡出按音乐长度算，且不超过其一半', () => {
  const f = buildMixFilter({voiceDur: 120, musicDur: 4, gain: -14, duck: 10, fadeIn: 1, fadeOut: 10});
  // 音乐 4s、fadeOut 要 10s → 夹到 2s（一半），起点 2s
  assert.match(f, /afade=t=out:st=2\.000:d=2\.000/, '淡出夹到音乐一半：' + f);
});

test('音乐时长未知：回落到人声时长，不崩', () => {
  const f = buildMixFilter({voiceDur: 60, musicDur: null, gain: -14, duck: 10, fadeIn: 0, fadeOut: 2});
  assert.match(f, /afade=t=out:st=58\.000:d=2\.000/, '用 voiceDur 兜底');
});

test('负面对照：人声时长非法要报错', () => {
  for (const bad of [0, -1, null, undefined, NaN]) {
    assert.throws(() => buildMixFilter({voiceDur: bad}), /人声时长必须是正数/, '应报错：' + bad);
  }
});

// ---------- 配置校验 ----------

const base = {slug: 'x', theme: {accents: ['#fff']}};

test('music 可以省略（默认无配乐）', () => {
  assert.equal(normalizeConfig(base).music, null);
});

test('music 字符串写法：补默认 gain/duck/fade', () => {
  const m = normalizeConfig({...base, music: 'assets/bgm.mp3'}).music;
  assert.equal(m.src, '/assets/bgm.mp3', '路径补前导斜杠（与 assets 同一种取法）');
  assert.equal(m.gain, -14);
  assert.equal(m.duck, 10);
  assert.equal(m.fadeIn, 1);
  assert.equal(m.fadeOut, 2);
});

test('music 对象写法：逐字段覆盖', () => {
  const m = normalizeConfig({...base, music: {src: '/assets/b.mp3', gain: -20, duck: 6, fadeIn: 0, fadeOut: 3}}).music;
  assert.deepEqual(m, {src: '/assets/b.mp3', gain: -20, duck: 6, fadeIn: 0, fadeOut: 3});
});

test('负面对照：music 写错要当场报错并说清是哪个字段', () => {
  const cases = [
    [{src: ''}, /music\.src 必填/],
    [{}, /music\.src 必填/],
    [{src: 'a.mp3', gain: 'loud'}, /music\.gain 要是数字/],
    [{src: 'a.mp3', gain: -100}, /music\.gain 不能小于 -60/],
    [{src: 'a.mp3', gain: 20}, /music\.gain 不能大于 12/],
    [{src: 'a.mp3', duck: -1}, /music\.duck 不能小于 0/],
    [{src: 'a.mp3', duck: 99}, /music\.duck 不能大于 40/],
    [{src: 'a.mp3', fadeIn: -1}, /music\.fadeIn 不能小于 0/],
    [{src: 'a.mp3', fadeOut: 'x'}, /music\.fadeOut 要是数字/],
    [42, /music 要么是路径字符串/],
    [[], /music 要么是路径字符串/],
  ];
  for (const [bad, re] of cases) {
    assert.throws(() => normalizeConfig({...base, music: bad}), re, '应报错：' + JSON.stringify(bad));
  }
});
