// 素材支持的单元测试：配置校验、摆放计算、以及"引错名字要报"。
// 不需要 DOM —— 只测纯逻辑（真正加载图片的部分由 tools/verify-assets.mjs 真开浏览器验）。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeConfig} from '../src/contract/config.js';
import {fitBox} from '../src/runtime/draw/picture.js';
import {img, imgSize, assetNames, assetsReady} from '../src/runtime/assets.js';

const minimal = {slug: 'x', size: {width: 1280, height: 720}, fps: 30};

// ---------- 配置：素材声明 ----------

test('assets 可以只写路径，名字取文件名（去掉扩展名）', () => {
  const c = normalizeConfig({...minimal, assets: ['assets/pipeline.png']});
  assert.deepEqual(c.assets, [{name: 'pipeline', src: '/assets/pipeline.png'}]);
});

test('assets 也可以显式命名', () => {
  const c = normalizeConfig({...minimal, assets: [{name: '架构图', src: 'assets/a.png'}]});
  assert.deepEqual(c.assets, [{name: '架构图', src: '/assets/a.png'}]);
});

test('路径前面的斜杠会补齐（页面按根路径取）', () => {
  const a = normalizeConfig({...minimal, assets: ['assets/a.png']}).assets[0];
  const b = normalizeConfig({...minimal, assets: ['/assets/a.png']}).assets[0];
  assert.equal(a.src, '/assets/a.png');
  assert.equal(b.src, '/assets/a.png', '已经带斜杠的不要变成两条斜杠');
});

test('没写 assets 时是空数组，不是 undefined', () => {
  assert.deepEqual(normalizeConfig(minimal).assets, []);
});

test('素材名重复要在配置期报错（镜头引用它时无法区分）', () => {
  assert.throws(
    () => normalizeConfig({...minimal, assets: ['assets/a.png', {name: 'a', src: 'assets/b.png'}]}),
    /重复/
  );
});

test('assets 不是数组要报错', () => {
  assert.throws(() => normalizeConfig({...minimal, assets: 'assets/a.png'}), /必须是数组/);
});

test('缺 src、或名字算不出来，都要报错', () => {
  assert.throws(() => normalizeConfig({...minimal, assets: [{name: 'a'}]}), /都要有 src/);
  assert.throws(() => normalizeConfig({...minimal, assets: [{}]}), /都要有 src/);
  // 没有扩展名的路径算不出名字 → 要求显式给 name
  assert.throws(() => normalizeConfig({...minimal, assets: ['assets/']}), /名字算不出来/);
});

test('assets 每项类型不对要报错', () => {
  assert.throws(() => normalizeConfig({...minimal, assets: [42]}), /要么是路径字符串/);
});

// ---------- 摆放计算 ----------

test('fitBox contain：等比装进框内，不超出', () => {
  // 640×160 装进 640×96：sx=1、sy=0.6，contain 取较小的 → 384×96（宽留白）
  assert.deepEqual(fitBox(640, 160, 640, 96, 'contain'), {dw: 384, dh: 96});
});

test('fitBox cover：铺满框，会超出（靠裁剪）', () => {
  // cover 取较大的缩放比 → 两个方向都不小于框，超出的部分被裁掉。
  // 640×160 进 640×96：sx=1、sy=0.6，取 1 → 640×160（高溢出，被裁）
  const r = fitBox(640, 160, 640, 96, 'cover');
  assert.deepEqual(r, {dw: 640, dh: 160});
  assert.ok(r.dw >= 640 && r.dh >= 96, 'cover 两个方向都不能小于框');
});

test('fitBox contain 与 cover 的关系：contain 一个方向贴边、另一个不溢出', () => {
  const r = fitBox(640, 160, 640, 96, 'contain');
  assert.ok(r.dw <= 640 + 1e-9 && r.dh <= 96 + 1e-9, 'contain 不许溢出');
  assert.ok(Math.abs(r.dw - 640) < 1e-9 || Math.abs(r.dh - 96) < 1e-9,
    'contain 至少要有一个方向贴边');
});

test('fitBox stretch：直接拉成框的尺寸', () => {
  assert.deepEqual(fitBox(640, 160, 300, 90, 'stretch'), {dw: 300, dh: 90});
});

test('fitBox：方图进方框是 1:1', () => {
  assert.deepEqual(fitBox(100, 100, 200, 200, 'contain'), {dw: 200, dh: 200});
});

test('fitBox：原始尺寸为 0 时不除零（退化情况）', () => {
  assert.deepEqual(fitBox(0, 0, 300, 150, 'contain'), {dw: 300, dh: 150});
  assert.deepEqual(fitBox(0, 160, 300, 150, 'contain'), {dw: 300, dh: 150});
});

test('fitBox：框比图小得多时也不出 NaN', () => {
  for (const fit of ['contain', 'cover', 'stretch']) {
    const r = fitBox(4000, 3000, 1, 1, fit);
    assert.ok(Number.isFinite(r.dw) && Number.isFinite(r.dh), `${fit} 出了 NaN`);
    assert.ok(r.dw > 0 && r.dh > 0);
  }
});

// ---------- 引错名字要报（这是照 themeKeys 那个坑写的）----------

test('boot 之前没有素材，assetNames 是空、assetsReady 是 false', () => {
  assert.deepEqual(assetNames(), []);
  assert.equal(assetsReady(), false);
});

test('img(未声明) 要抛出，而不是返回 undefined', () => {
  // 返回 undefined 的话，会一路传进 ctx.drawImage，在很远的地方才崩
  assert.throws(() => img('nope'), /没有名为「nope」的素材/);
});

test('imgSize(未声明) 也要抛出', () => {
  assert.throws(() => imgSize('nope'), /没有名为「nope」的素材/);
});

test('没有声明任何素材时，错误信息要说清"一个都没声明"', () => {
  try {
    img('nope');
    assert.fail('应该抛错');
  } catch (e) {
    assert.ok(e.message.includes('一个素材都没声明'), '要给出可操作的提示：' + e.message);
  }
});
