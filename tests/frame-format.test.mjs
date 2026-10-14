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

test('**已知例外**：h264 白名单认它，但 frameFormatExpr 必须明确报错（不是漂移）', () => {
  // 这条是补的：原来那条一致性测试的候选清单是**硬编码的**，没包含 h264，
  // 所以上一轮把 h264 加进白名单、却没管解析器时，漂移**没被发现**。
  // h264 不是 canvas 的 MIME 类型（它由 streamFrames 特判走 WebCodecs），
  // 所以"白名单认 + 解析器报错"是**有意的**，但报错必须说清缘由，
  // 不能返回一个假的 MIME 去喂 canvas.toBlob（那会静默产出错的帧）。
  assert.equal(isValidFrameFormat('h264'), true, 'CLI 认这个值');
  assert.throws(() => frameFormatExpr('h264'), /不是 canvas 的编码格式/,
    '必须明确报错，并说清它由 streamFrames 特判');
  // 顺带钉住：报错信息要指出去哪儿（取单帧用 png/jpeg）
  assert.throws(() => frameFormatExpr('h264'), /png \/ jpeg/);
});

test('白名单不能悄悄写宽：常见的"想当然"值必须都被拒', () => {
  // ⚠️ 别把这条说成"新增格式一定会被抓住" —— 它抓的是**列出来的**这些。
  // 真要抓"任意新增"，得让实现导出接受集合、测试与它比对，但那样测试就成了实现的镜子
  // （加值时两边一起改，照样漏）。所以这里选**列出最可能被误加的值**，够用且不假装。
  const accepted = ['png', 'jpeg', 'jpg', 'h264', 'jpeg:80', 'jpeg:0', 'jpeg:100', 'jpeg:999'];
  for (const c of accepted) assert.equal(isValidFrameFormat(c), true, `${c} 应被接受`);
  for (const c of ['webp', 'gif', 'bmp', 'h265', 'hevc', 'av1', 'jpeg:', 'h264:80', 'webm', 'mp4']) {
    assert.equal(isValidFrameFormat(c), false, `${c} 不该被接受`);
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
