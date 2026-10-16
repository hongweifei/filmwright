// 读 Chrome DevTools 的 HTTP 端点（默认 `/json/list`）。
//
// ## 为什么不用 `fetch`
//
// Fetch 规范里有一份「坏端口」名单（`1`、`7`、`9`…`6000`、`6667`、`6697`、`10080`…），
// `fetch()` 对名单里的端口**直接拒绝**，报 `TypeError: fetch failed`、cause 是
// `Error: bad port` —— 而那个端口本身是好的，服务好好地听着。
//
// 浏览器用 `--remote-debugging-port=0` 启动时**自己随机挑**调试端口，可能正好挑到名单里的；
// 于是整个会话在「读 `/json/list`」这一步就死，报出来只有一句看不出原因的 `fetch failed`
// （本机实测：16 个探针连跑的那一批里出现过一次，单独重跑又好了 —— 典型的「时不时」）。
// `node:http` 没有这份名单。
//
// ## 为什么要重试
//
// `DevToolsActivePort` 文件出现**不等于**端点已经在接受连接 —— 和「文件在 Windows 上
// 会被锁住」是同一类「还没就绪」（`session.mjs` 等端口文件时已经在处理那一类）。
// 所以这里带**总时限**地重试；时限到了把最后一次的错因写进报错里，带上端口号。
import {get as httpGet} from 'node:http';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 取 DevTools 端点并解析 JSON（等价于 `GET http://127.0.0.1:<port><path>`）。
 *
 * @param {number|string} port DevTools 端口
 * @param {{path?:string, deadlineMs?:number, delayMs?:number, timeoutMs?:number,
 *          shouldStop?:() => boolean}} [opts]
 *   `deadlineMs` 是**重试总时限**（不是单次超时）；`shouldStop` 返回真就立刻放弃
 *   （会话用它判断浏览器进程是不是已经退了，避免白等）。
 * @returns {Promise<any>} 解析后的 JSON
 */
export async function devtoolsJson(port, opts = {}) {
  const {path = '/json/list', deadlineMs = 20000, delayMs = 100, timeoutMs = 5000, shouldStop = null} = opts;
  const until = Date.now() + deadlineMs;
  let last = null;
  for (;;) {
    if (shouldStop && shouldStop()) throw new Error('浏览器进程已经退出');
    try {
      return await once(Number(port), path, timeoutMs);
    } catch (e) {
      last = e;
      if (Date.now() + delayMs > until) break;
      await sleep(delayMs);
    }
  }
  throw new Error(`取 DevTools ${path} 失败（端口 ${port}）：${last ? last.message : '未知原因'}`);
}

/** 一次请求。连不上/超时/不是 JSON 都抛错（由调用方决定要不要重试）。 */
function once(port, path, timeoutMs) {
  return new Promise((res, rej) => {
    const req = httpGet({host: '127.0.0.1', port, path, timeout: timeoutMs}, (r) => {
      let body = '';
      r.setEncoding('utf8');
      r.on('data', (d) => (body += d));
      r.on('end', () => {
        try {
          res(JSON.parse(body));
        } catch (e) {
          // 端口通了但返回的不是 JSON（例如被别的服务占了）——说清是什么，别只说「解析失败」
          rej(new Error(`返回的不是 JSON：${body.slice(0, 120)}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`超过 ${timeoutMs}ms 没响应`)));
    req.on('error', rej);
  });
}
