// 配置校验的单元测试。
// 重点在**错误路径**：写错的配置必须当场报错，不能静默退回默认值
// —— 静默退回会让一个拼错的字段变成「看起来正常但不对」的片子。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeConfig, DEFAULT_THEME, DEFAULT_FONTS, DEFAULT_FONT_FILES,
  install, accent,
} from '../src/contract/config.js';

const minimal = {slug: 'x', size: {width: 1280, height: 720}, fps: 30};

test('最小配置：补齐全部默认值', () => {
  const c = normalizeConfig(minimal);
  assert.equal(c.slug, 'x');
  assert.deepEqual(c.size, {width: 1280, height: 720});
  assert.equal(c.fps, 30);
  assert.deepEqual(c.hud, []);
  assert.deepEqual(c.chapterTech, []);
  assert.equal(c.credit, null);
  assert.equal(c.builtBy, '');
  assert.deepEqual(c.theme.accents, DEFAULT_THEME.accents);
  assert.deepEqual(c.fonts, DEFAULT_FONTS);
  assert.deepEqual(c.fontFiles, DEFAULT_FONT_FILES);
  assert.equal(c.endingFade, 30);
});

test('空配置要报错，而不是给出一部空片', () => {
  assert.throws(() => normalizeConfig(null), /配置为空/);
  assert.throws(() => normalizeConfig(undefined), /配置为空/);
});

test('size 非法要报错', () => {
  for (const size of [{width: 0, height: 720}, {width: 1280, height: -1},
    {width: 'a', height: 720}, {}]) {
    assert.throws(() => normalizeConfig({...minimal, size}), /size\.width/,
      `size=${JSON.stringify(size)} 应被拒`);
  }
});

test('size 会取整（避免半像素）', () => {
  const c = normalizeConfig({...minimal, size: {width: 1280.7, height: 719.2}});
  assert.deepEqual(c.size, {width: 1281, height: 719});
});

test('fps 非法要报错', () => {
  for (const fps of [0, -30, 'x']) {
    assert.throws(() => normalizeConfig({...minimal, fps}), /fps 必须是正数/);
  }
});

test('theme.accents 不能为空（章节色会取模，空数组会算出 undefined）', () => {
  assert.throws(() => normalizeConfig({...minimal, theme: {accents: []}}), /accents/);
});

test('theme 是浅合并：只覆盖给了的键', () => {
  const c = normalizeConfig({...minimal, theme: {bg: '#000'}});
  assert.equal(c.theme.bg, '#000');
  assert.equal(c.theme.text, DEFAULT_THEME.text, '没覆盖的键应保留默认');
});

test('hud 每项必须有 fromS/toS/label', () => {
  assert.throws(
    () => normalizeConfig({...minimal, hud: [{fromS: 'S01', toS: 'S02'}]}),
    /fromS \/ toS \/ label/
  );
  const ok = normalizeConfig({...minimal, hud: [{fromS: 'S01', toS: 'S02', label: '一'}]});
  assert.equal(ok.hud.length, 1);
});

test('title 可以给字符串（简写）或对象', () => {
  const s = normalizeConfig({...minimal, title: '片名'});
  assert.deepEqual(s.title, {big: '片名', rest: '', en: '', tagline: ''});
  const o = normalizeConfig({...minimal, title: {big: 'a', rest: 'b'}});
  assert.deepEqual(o.title, {big: 'a', rest: 'b', en: '', tagline: ''});
  assert.equal(normalizeConfig(minimal).title, null);
});

// ---- 状态色与安全取色 ----
//
// 这一组是补一个真实的坑：运行时代码把 theme 的键当**默认参数值**用
// （`{okColor = C.green}` 这种）。键不存在时不是报错，而是默认值变成 undefined，
// 一直传到绘制才崩 —— 崩的地方离原因很远。
// 迁 7465 帧真实片子时，`matrix()` 没传颜色就撞上了，报的是
// 「Cannot read properties of undefined (reading 'replace')」（在 hexA 里）。

test('theme 必须有语义状态色 ok / bad / hi', () => {
  for (const k of ['ok', 'bad', 'hi']) {
    assert.ok(typeof DEFAULT_THEME[k] === 'string' && DEFAULT_THEME[k].length,
      `DEFAULT_THEME.${k} 必须存在（绘制组件的默认色要用）`);
  }
});

test('theme 里任何一个键变成空/undefined 都要当场报错', () => {
  // 这是那道防线：默认值变 undefined 会拖到绘制时才崩，必须在配置期拦下
  assert.throws(() => normalizeConfig({...minimal, theme: {ok: undefined}}),
    /theme\.ok/, '显式给 undefined 要报');
  assert.throws(() => normalizeConfig({...minimal, theme: {bad: ''}}),
    /theme\.bad/, '空串要报');
  assert.throws(() => normalizeConfig({...minimal, theme: {text: null}}),
    /theme\.text/, 'null 要报');
});

test('theme.accents 里的元素也要校验', () => {
  assert.throws(() => normalizeConfig({...minimal, theme: {accents: ['#fff', undefined]}}),
    /accents\[1\]/, '要指出是第几个出错');
});

test('accent(i) 会回绕，越界不会给 undefined', () => {
  // 主题的 accents 长度由使用者定（示例只给 3 个），
  // 所以绘制组件的默认色必须走 accent()，不能写 accents[3]
  install({...minimal, theme: {accents: ['#111111', '#222222', '#333333']}});
  assert.equal(accent(0), '#111111');
  assert.equal(accent(2), '#333333');
  assert.equal(accent(3), '#111111', '越界应回绕到第 0 个');
  assert.equal(accent(5), '#333333');
  assert.ok(typeof accent(-1) === 'string' && accent(-1).length > 0,
    '负数也不该给出 undefined');
});
