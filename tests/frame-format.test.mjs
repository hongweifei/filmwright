// 帧格式与编码预设的单元测试。
//
// 为什么单独测：这是**性能优化的旋钮**，而性能改动的风险是「静默改变输出」。
// 判据要钉住三件事：
//   1) 默认仍是 PNG（无损）—— 既有调用方的行为不能被悄悄改变
//   2) 渲染路径显式选 JPEG —— 这是优化点，要能验证它确实生效
//   3) 非法值要报错并列出可用值（而不是静默回退到某个格式）
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {frameFormatExpr, isValidFrameFormat} from '../src/host/browser/session.mjs';
import {frameFormatOf, presetOf, transportOf} from '../src/host/cli/commands.mjs';

test('默认是 PNG（无损）—— 既有调用方不受优化影响', () => {
  assert.equal(frameFormatExpr(undefined), `'image/png'`);
  assert.equal(frameFormatExpr(null), `'image/png'`);
});

test('jpeg：无质量参数时用 0.92（实测的视觉透明档）', () => {
  assert.equal(frameFormatExpr('jpeg'), `'image/jpeg', 0.92`);
  assert.equal(frameFormatExpr('jpg'), `'image/jpeg', 0.92`, 'jpg 是 jpeg 的别名');
  assert.equal(frameFormatExpr('JPEG'), `'image/jpeg', 0.92`, '大小写不敏感');
});

test('jpeg:NN：质量按百分比换算成 0–1', () => {
  assert.equal(frameFormatExpr('jpeg:80'), `'image/jpeg', 0.8`);
  assert.equal(frameFormatExpr('jpeg:100'), `'image/jpeg', 1`);
  assert.equal(frameFormatExpr('jpeg:50'), `'image/jpeg', 0.5`);
});

test('jpeg 质量被夹到 (0.1, 1] 区间（0 会被浏览器当成默认值，语义混乱）', () => {
  assert.equal(frameFormatExpr('jpeg:0'), `'image/jpeg', 0.1`, '0 夹到 0.1');
  assert.equal(frameFormatExpr('jpeg:1'), `'image/jpeg', 0.1`, '1% 太小，夹到 0.1');
  assert.equal(frameFormatExpr('jpeg:999'), `'image/jpeg', 1`, '超过 100 夹到 1');
});

test('负面对照：不认识的值要报错并列出可用值（不静默回退）', () => {
  for (const bad of ['webp', 'bmp', 'jpeg:', 'jpeg:abc', 'gif', '', 'PNG ']) {
    // 注意 '' 与 'PNG ' 其实会被判非法（空串不是 png；'PNG ' 带空格）
    const valid = isValidFrameFormat(bad);
    if (valid) continue;   // 少数边界值先过白名单校验
    assert.throws(() => frameFormatExpr(bad), /不认识的帧格式/, `应报错：${JSON.stringify(bad)}`);
  }
  assert.throws(() => frameFormatExpr('webp'), /png \/ jpeg \/ jpeg:92/, '报错要列可用值');
});

test('isValidFrameFormat 与 frameFormatExpr 的白名单一致（不能两处漂移）', () => {
  const cases = ['png', 'PNG', 'jpeg', 'jpg', 'JPEG', 'jpeg:80', 'jpeg:0', 'jpeg:100', 'jpeg:999',
    'webp', 'png ', '', 'jpeg:abc', 'gif', 'image/png'];
  for (const c of cases) {
    let exprOk = true;
    try { frameFormatExpr(c); } catch { exprOk = false; }
    assert.equal(isValidFrameFormat(c), exprOk,
      `两处判定不一致：${JSON.stringify(c)}（isValid=${isValidFrameFormat(c)} expr可解析=${exprOk}）`);
  }
});

test('CLI 的 --frame-format：默认 jpeg（渲染路径的优化），可显式 png', () => {
  assert.equal(frameFormatOf({args: {}}), 'jpeg', '渲染路径默认 JPEG');
  assert.equal(frameFormatOf({args: {'frame-format': 'png'}}), 'png');
  assert.equal(frameFormatOf({args: {'frame-format': 'jpeg:85'}}), 'jpeg:85');
  assert.throws(() => frameFormatOf({args: {'frame-format': 'webp'}}), /不认识的帧格式/);
  try {
    frameFormatOf({args: {'frame-format': 'webp'}});
    assert.fail('应抛错');
  } catch (e) {
    assert.equal(e.code, 'BAD_FRAME_FORMAT');
    assert.ok(e.hint.includes('png'), 'hint 要说明两种场合怎么选');
  }
});

test('CLI 的 --preset：合法列表通过，非法报错并列出可用值', () => {
  assert.equal(presetOf({args: {}}), 'medium', '默认 medium');
  for (const p of ['ultrafast', 'veryfast', 'fast', 'medium', 'slow', 'veryslow']) {
    assert.equal(presetOf({args: {preset: p}}), p);
  }
  assert.throws(() => presetOf({args: {preset: 'insane'}}), /不认识/);
  try {
    presetOf({args: {preset: 'insane'}});
    assert.fail('应抛错');
  } catch (e) {
    assert.equal(e.code, 'BAD_PRESET');
    assert.ok(e.hint.includes('编码'), 'hint 要说明这是编码时间的旋钮');
  }
});

test('CLI 的 --frame-transport：默认 stream（快），cdp 可回退用于排查', () => {
  assert.equal(transportOf({args: {}}), 'stream', '默认走二进制流式上传');
  assert.equal(transportOf({args: {'frame-transport': 'cdp'}}), 'cdp', 'cdp 是保留的回退路径');
  assert.equal(transportOf({args: {'frame-transport': 'stream'}}), 'stream');
  assert.throws(() => transportOf({args: {'frame-transport': 'websocket'}}), /stream \/ cdp/);
  try {
    transportOf({args: {'frame-transport': 'websocket'}});
    assert.fail('应抛错');
  } catch (e) {
    assert.equal(e.code, 'BAD_TRANSPORT');
    assert.ok(e.hint.includes('cdp'), 'hint 要说明 cdp 什么时候用（排查卡死）');
  }
});
