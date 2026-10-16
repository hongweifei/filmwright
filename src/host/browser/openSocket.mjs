// 连上 CDP 的 WebSocket —— **失败必须报出可归因的原因**。
//
// ## 为什么要单独一个文件（而不是写在 `session.mjs` 里）
//
// 原来这里是一行：
//
//   const ws = new WebSocket(target.webSocketDebuggerUrl);
//   await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
//
// `ws.onerror = rej` 抛出去的是浏览器的 **ErrorEvent 对象**（不是 `Error`）。
// 它一路冒到 CLI 顶层，被 `output.mjs` 的 `String(e)` 变成**一行
// `[object ErrorEvent]`** —— 看不出跟"连接"有关，更看不出为什么连不上。
// 实测（本机 16GB / 空闲 2.6GB）`verify-effects` 跑到一半就这么报，
// 同一份夹具单独跑 30/30 全过 ⇒ 是**连接**那一层的偶发失败，不是渲染。
//
// 所以这里做两件事：**有限重试**（端点可能还没开始接受连接）+ **失败时自己造
// `Error`**（带端口、原因、Chrome 的 stderr；Chrome 已经死了就立刻失败、不空等）。
//
// ## 为什么可注入
//
// `WebSocketImpl` / `sleep` / `shouldStop` 都能传进来，是为了**能被单测**：
// `tests/open-socket.test.mjs` 用一个假 WebSocket 演「前两次 error、第三次 open」
// 与「一直 error」，判据是**重试真的发生了**、**错误是带原因的真 Error**
// （而不是 `[object ErrorEvent]`）。不注入的话这条路径只能靠偶发复现来验证。

/** 默认重试间隔（毫秒）。 */
const RETRY_MS = 200;

/**
 * 连一个 WebSocket，直到连上或超出预算。
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.budgetMs] 总预算（毫秒），默认 20000。
 * @param {number} [opts.retryMs] 每次失败后的等待，默认 200。
 * @param {number|null} [opts.port] 只用于错误文案（DevTools 端口）。
 * @param {() => boolean} [opts.shouldStop] 为真就立刻放弃（浏览器已退出）。
 * @param {() => string} [opts.stopReason] 放弃时附上的原因（Chrome 的 stderr）。
 * @param {typeof WebSocket} [opts.WebSocketImpl] 注入用。
 * @param {(ms: number) => Promise<void>} [opts.sleep] 注入用。
 * @returns {Promise<WebSocket>}
 */
export async function openSocket(url, opts = {}) {
  const {
    budgetMs = 20000,
    retryMs = RETRY_MS,
    port = null,
    shouldStop = null,
    stopReason = () => '',
    WebSocketImpl = globalThis.WebSocket,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = opts;

  const where = port === null ? url : `端口 ${port}`;
  const deadline = Date.now() + budgetMs;
  let lastWhy = '还没连上';

  for (;;) {
    const w = new WebSocketImpl(url);
    // ⚠️ 三条路径都**只回传事实**（哪一步失败），绝不要把事件对象本身当错误抛出去。
    const r = await new Promise((res) => {
      w.onopen = () => res({ok: true, ws: w});
      w.onerror = () => res({ok: false, why: 'WebSocket 出错'});
      w.onclose = () => res({ok: false, why: 'WebSocket 在连上之前就关了'});
    });
    if (r.ok) return r.ws;
    lastWhy = r.why;

    if (shouldStop && shouldStop()) {
      const why = stopReason();
      throw new Error(`filmwright: 连不上 DevTools 的 WebSocket（${lastWhy}）；` +
        `浏览器已退出${why ? '：' + why : ''}`);
    }
    if (Date.now() >= deadline) {
      const why = stopReason();
      throw new Error(`filmwright: ${Math.round(budgetMs / 1000)}s 内连不上 DevTools 的 WebSocket` +
        `（${where}，${lastWhy}）${why ? '；stderr=' + why : ''}`);
    }
    await sleep(retryMs);
  }
}
