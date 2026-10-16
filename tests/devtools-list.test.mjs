// `src/host/browser/devtoolsList.mjs` 的判据。
//
// 它存在的理由只有一条：**Fetch 规范的「坏端口」名单会让 `fetch()` 拒掉一个完全正常的端口**，
// 而 Chrome 自己随机挑的调试端口可能正好落在名单里。所以这里的判据不是「能读到 JSON」
// （那太弱，随便哪种写法都能过），而是「**在一个 fetch 一定会拒绝的端口上**也能读到」。
//
// 因此每条用到坏端口的判据都自带**负面对照**：先用 `fetch` 证明这个端口真的被拒绝，
// 不然夹具就退化成普通端口，判据失去意义（本仓的老规矩：一个永远绿的检查不是检查）。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {devtoolsJson} from '../src/host/browser/devtoolsList.mjs';

// Fetch 规范坏端口名单里**非特权**的那些（<1024 的要 root，不用）。
const BAD_PORTS = [
  2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
];

/** 依次试着绑 BAD_PORTS，返回第一个绑上的 server（绑不上就说明这些端口都被占了）。 */
async function listenOnBadPort(handler) {
  for (const p of BAD_PORTS) {
    const s = createServer(handler);
    const ok = await new Promise((res) => {
      s.once('error', () => res(false));
      s.listen(p, '127.0.0.1', () => res(true));
    });
    if (ok) return s;
  }
  return null;
}

/** 证明这个端口真的在坏端口名单里（否则夹具无效，判据也就无效）。 */
async function assertFetchRefuses(port) {
  await assert.rejects(
    fetch(`http://127.0.0.1:${port}/json/list`),
    (e) => /bad port/.test(String(e.cause?.message ?? e.message)),
    `夹具失效：${port} 不在坏端口名单里（fetch 没拒绝它）——这条判据什么都没证明`,
  );
}

test('坏端口上的 DevTools 端点也读得到（fetch 会拒绝，它不会）', async () => {
  const server = await listenOnBadPort((req, res) => {
    res.writeHead(200, {'content-type': 'application/json'});
    res.end('[{"type":"page","webSocketDebuggerUrl":"ws://x"}]');
  });
  assert.ok(server, `坏端口名单里的 ${BAD_PORTS.length} 个端口一个都绑不上，夹具跑不了`);
  try {
    const port = server.address().port;
    await assertFetchRefuses(port);
    const list = await devtoolsJson(port);
    assert.equal(list[0].type, 'page');
    assert.equal(list[0].webSocketDebuggerUrl, 'ws://x');
  } finally {
    server.close();
  }
});

test('端点还没起来时会重试（端口文件出现 ≠ 已经能连）', async () => {
  const server = await listenOnBadPort((req, res) => {
    res.writeHead(200, {'content-type': 'application/json'});
    res.end('[]');
  });
  assert.ok(server, '一个坏端口都绑不上，夹具跑不了');
  const port = server.address().port;
  server.close();
  // 300ms 后才开始听：前几次必然 ECONNREFUSED，重试要能熬过去。
  const late = setTimeout(() => server.listen(port, '127.0.0.1'), 300);
  try {
    const list = await devtoolsJson(port, {deadlineMs: 5000, delayMs: 20, timeoutMs: 500});
    assert.deepEqual(list, []);
  } finally {
    clearTimeout(late);
    server.close();
  }
});

test('一直连不上就按时放弃，错误里带端口号', async () => {
  const server = await listenOnBadPort(() => {});
  assert.ok(server, '一个坏端口都绑不上，夹具跑不了');
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  const t0 = Date.now();
  await assert.rejects(
    devtoolsJson(port, {deadlineMs: 400, delayMs: 20, timeoutMs: 100}),
    (e) => new RegExp(`端口 ${port}`).test(e.message) && /ECONNREFUSED|没响应/.test(e.message),
  );
  assert.ok(Date.now() - t0 < 4000, '重试没有按 deadlineMs 收敛');
});

test('端口通了但返回的不是 JSON：说清是什么，别只说解析失败', async () => {
  const server = await listenOnBadPort((req, res) => {
    res.writeHead(200, {'content-type': 'text/plain'});
    res.end('<html>别的服务</html>');
  });
  assert.ok(server, '一个坏端口都绑不上，夹具跑不了');
  try {
    await assert.rejects(
      devtoolsJson(server.address().port, {deadlineMs: 500, delayMs: 20, timeoutMs: 200}),
      /返回的不是 JSON：<html>别的服务<\/html>/,
    );
  } finally {
    server.close();
  }
});
