// `openSocket`：连 CDP 的 WebSocket —— 失败必须是**带原因的真 `Error`**。
//
// ## 这条判据守的是什么（一个实测过的坑）
//
// 老代码是 `await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; })`：
// 失败时抛出去的是浏览器的 **ErrorEvent 对象**，顶层 `output.mjs` 用 `String(e)`
// 一转换，用户/agent 只看到一行 **`[object ErrorEvent]`** ——
// 既不知道是"连接"失败，也不知道为什么。本机实测（空闲内存 2.6GB）
// `verify-effects` 跑到一半就这么报过一次，而**同一份夹具单独跑 30/30 全过**
// ⇒ 是连接层的偶发失败，被那行文案藏住了。
//
// 所以这里的判据是**双向**的：
//   ① 失败时必须抛 `Error`，文案里带**原因**与**端口**；
//   ② `String(err)` **不许**是 `[object …]` 那种没有信息的东西。
//
// ②不是凑数：把 `openSocket.mjs` 改回"把事件对象直接抛出去"（见
// `.work/open-socket-control.mjs` 的变异），①与②都必须变红。
//
// ## 为什么用假 WebSocket
//
// 真浏览器上"连不上"只能靠偶发复现来验证 —— 那不是判据。`openSocket` 把
// `WebSocketImpl` / `sleep` 做成可注入，就是为了这里能演「前两次 error、
// 第三次 open」「一直 error」「连上之前就被关掉」「浏览器已经退出」四种情形。
import assert from 'node:assert/strict';
import test from 'node:test';
import {openSocket} from '../src/host/browser/openSocket.mjs';

/**
 * 造一个假 WebSocket 类。
 * @param {object} plan
 * @param {number} [plan.failTimes] 前 N 次构造：派发 `onerror`
 * @param {number} [plan.closeTimes] 接着 N 次构造：派发 `onclose`
 * 其余构造派发 `onopen`。
 *
 * ⚠️ 用 `queueMicrotask` 派发：真实 WebSocket 的回调也不在构造函数里同步跑，
 * 而 `openSocket` 是在 `new` 之后才挂 `onopen`/`onerror` 的。
 */
function fakeWs({failTimes = 0, closeTimes = 0} = {}) {
  const made = [];
  class FakeWs {
    constructor(url) {
      this.url = url;
      made.push(this);
      const nth = made.length;
      queueMicrotask(() => {
        if (nth <= failTimes) { this.onerror?.(); return; }
        if (nth <= failTimes + closeTimes) { this.onclose?.(); return; }
        this.onopen?.();
      });
    }
  }
  return {FakeWs, made};
}

/** 真的睡一小会儿（顺便记下每次的毫秒数）：用它才能诚实地验"预算到了就放弃"。 */
const spySleep = (slept) => (ms) => {
  slept.push(ms);
  return new Promise((r) => setTimeout(r, ms));
};

test('第一次就连上：返回那一个实例，且只构造一次（不该有多余的重试）', async () => {
  const {FakeWs, made} = fakeWs();
  const ws = await openSocket('ws://x/1', {WebSocketImpl: FakeWs});
  assert.equal(ws, made[0], '返回的应当是第一次构造出来的那个连接');
  assert.equal(made.length, 1, '一次就成功就不该再建第二个连接');
});

test('前两次失败、第三次成功：重试真的发生了（不是一次就放弃）', async () => {
  const {FakeWs, made} = fakeWs({failTimes: 2});
  const slept = [];
  const ws = await openSocket('ws://x/1', {
    WebSocketImpl: FakeWs, sleep: spySleep(slept), retryMs: 5, budgetMs: 500,
  });
  assert.equal(made.length, 3, '应当试到第三次才成功');
  assert.equal(ws, made[2], '返回的应当是最后那个连上的连接');
  assert.deepEqual(slept, [5, 5], '两次失败之间各睡一次 retryMs');
});

test('一直失败：按时放弃，抛带原因与端口的 Error，且文案里没有 [object …]', async () => {
  const {FakeWs, made} = fakeWs({failTimes: 999});
  const slept = [];
  const err = await openSocket('ws://x/1', {
    WebSocketImpl: FakeWs, sleep: spySleep(slept), retryMs: 5, budgetMs: 60, port: 9222,
  }).then(() => null, (e) => e);

  assert.ok(err instanceof Error, '失败必须抛真 Error（老代码抛的是事件对象）');
  assert.match(err.message, /连不上 DevTools 的 WebSocket/, '文案要说清是哪一步失败');
  assert.match(err.message, /WebSocket 出错/, '文案要带**原因**（onerror / onclose 哪一种）');
  assert.match(err.message, /端口 9222/, '文案要带端口，否则没法排查');
  assert.ok(!/\[object /.test(String(err)), 'String(err) 不许是没有信息的那种字符串');

  // 下限：真的重试过（不是第一次失败就退出），且每次间隔就是 retryMs。
  assert.ok(made.length >= 3, `应当重试多次，实际只构造了 ${made.length} 次`);
  assert.ok(slept.length >= 2, `每次重试之间都要睡，实际只睡了 ${slept.length} 次`);
  assert.ok(slept.every((ms) => ms === 5), '重试间隔应当就是 retryMs');
});

test('连上之前就被关掉：也算失败，且原因写的是"关了"不是"出错"', async () => {
  const {FakeWs} = fakeWs({closeTimes: 999});
  const err = await openSocket('ws://x/1', {
    WebSocketImpl: FakeWs, sleep: () => Promise.resolve(), retryMs: 0, budgetMs: 0,
  }).then(() => null, (e) => e);
  assert.ok(err instanceof Error);
  assert.match(err.message, /连上之前就关了/, 'onclose 与 onerror 是两种不同的原因，不能混');
});

test('浏览器已经退出：立刻放弃（不空等到预算），文案带退出原因', async () => {
  const {FakeWs, made} = fakeWs({failTimes: 999});
  const slept = [];
  const err = await openSocket('ws://x/1', {
    WebSocketImpl: FakeWs, sleep: spySleep(slept), retryMs: 5, budgetMs: 60000,
    shouldStop: () => true,
    stopReason: () => 'chrome stderr 片段',
  }).then(() => null, (e) => e);

  assert.ok(err instanceof Error);
  assert.match(err.message, /浏览器已退出/);
  assert.match(err.message, /chrome stderr 片段/, 'Chrome 的 stderr 要带出来，否则还是查不出为什么');
  assert.equal(made.length, 1, '已经确定浏览器死了，就不该再建连接');
  assert.deepEqual(slept, [], '确定死了要立刻抛，不该睡');
});
