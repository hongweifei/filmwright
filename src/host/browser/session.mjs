// CDP 驱动：启动一个无头浏览器，打开渲染页，按帧截图。
// 每个渲染分片一个独立实例（独立 user-data-dir），互不干扰。
import {spawn} from 'node:child_process';
import {mkdtempSync, readFileSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, extname} from 'node:path';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {findBrowser} from './find.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff2': 'font/woff2',
  '.wav': 'audio/wav',
  '.png': 'image/png',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 静态服务器：服务项目根 + 挂载点。
 * mounts 形如 [{prefix:'/lib/', dir:'<库目录>'}，用于把 filmwright 自己的 src 供出去。
 */
export function serveProject(projectDir, mounts = []) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      let p = decodeURIComponent(url.pathname);
      if (p === '/') p = '/index.html';

      const tries = [];
      // 挂载点优先（库自己的 index.html / src）
      for (const m of mounts) {
        if (p.startsWith(m.prefix)) {
          tries.push(join(m.dir, p.slice(m.prefix.length)));
        }
      }
      // 然后是项目目录：/public/ 下的东西按根路径引用
      tries.push(join(projectDir, p));
      if (p.startsWith('/fonts/') || p.startsWith('/assets/')) {
        tries.push(join(projectDir, 'public', p));
      }

      for (const f of tries) {
        try {
          const buf = await readFile(f);
          res.writeHead(200, {
            'Content-Type': MIME[extname(f).toLowerCase()] || 'application/octet-stream',
            'Cache-Control': 'no-store',
          });
          res.end(buf);
          return;
        } catch { /* 试下一个 */ }
      }
      res.writeHead(404).end('not found');
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

/**
 * 打开一个渲染会话。
 * @param {string} url 渲染页地址
 * @param {{width:number,height:number}} size 画布尺寸
 * @param {object} opts {colorProfile, extraArgs, browser}
 */
export async function openSession(url, size, opts = {}) {
  const browser = findBrowser(opts.browser);
  const profile = mkdtempSync(join(tmpdir(), 'filmwright-'));
  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    `--window-size=${size.width},${size.height}`,
    '--hide-scrollbars',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--mute-audio',
    // 色彩配置钉死 sRGB。不同浏览器/机器默认 profile 不同，会让同一帧像素值整体偏移
    // （实测系统 Edge 与 Chrome-for-Testing 有 85% 像素差 1–8 级，钉死之后逐像素完全相同）。
    `--force-color-profile=${opts.colorProfile || 'srgb'}`,
    ...(opts.extraArgs || []),
    'about:blank',
  ];
  const chrome = spawn(browser, args, {stdio: ['ignore', 'pipe', 'pipe']});
  let chromeErr = '';
  chrome.stderr.on('data', (d) => (chromeErr += d.toString().slice(0, 4000)));
  chrome.on('error', (e) => (chromeErr += ' spawn error: ' + e.message));

  const portFile = join(profile, 'DevToolsActivePort');
  let devPort = null;
  for (let i = 0; i < 300; i++) {
    if (existsSync(portFile)) {
      devPort = readFileSync(portFile, 'utf8').split('\n')[0].trim();
      break;
    }
    if (chrome.exitCode !== null) throw new Error('filmwright: 浏览器提前退出：' + chromeErr);
    await sleep(100);
  }
  if (!devPort) throw new Error('filmwright: 等不到 DevToolsActivePort；stderr=' + chromeErr);

  const list = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
  const target = list.find((t) => t.type === 'page');
  if (!target) throw new Error('filmwright: 没有 page target');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const myId = ++id;
    pending.set(myId, res);
    ws.send(JSON.stringify({id: myId, method, params}));
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false,
  });
  await send('Page.navigate', {url});

  let info = null;
  let bootError = null;
  for (let i = 0; i < 400; i++) {
    const r = await send('Runtime.evaluate', {
      expression: '({ready: window.__ready === true, info: window.__info || null, err: window.__bootError || null})',
      returnByValue: true,
    });
    const v = r.result?.result?.value;
    if (v?.err) { bootError = v.err; break; }
    if (v?.ready) { info = v.info; break; }
    await sleep(100);
  }
  if (bootError) {
    try { ws.close(); } catch {}
    try { chrome.kill(); } catch {}
    throw new Error('filmwright: 渲染页启动失败\n' + bootError);
  }
  if (!info) throw new Error('filmwright: 渲染页一直没就绪（检查字体路径与模块 import）');

  let lastErr = null;
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') {
      lastErr = m.params?.exceptionDetails?.exception?.description || 'exception';
    }
  });

  return {
    info,
    async frame(n) {
      const r = await send('Runtime.evaluate', {expression: `window.__renderFrame(${n})`, returnByValue: true});
      if (r.result?.exceptionDetails) {
        throw new Error('filmwright: 第 ' + n + ' 帧抛错：' + JSON.stringify(r.result.exceptionDetails).slice(0, 400));
      }
      const shot = await send('Page.captureScreenshot', {format: 'png', captureBeyondViewport: false});
      if (!shot.result?.data) throw new Error('filmwright: 第 ' + n + ' 帧截图失败');
      return Buffer.from(shot.result.data, 'base64');
    },
    /** 只跑绘制代码、不截图：用来把每帧都过一遍查错（比截图快得多）。 */
    async drawOnly(n) {
      const r = await send('Runtime.evaluate', {
        expression: `(window.__lastError = null, window.__renderFrame(${n}), window.__lastError)`,
        returnByValue: true,
      });
      return r.result?.result?.value ?? null;
    },
    async screenshot() {
      const shot = await send('Page.captureScreenshot', {format: 'png', captureBeyondViewport: false});
      if (!shot.result?.data) throw new Error('filmwright: 截图失败');
      return Buffer.from(shot.result.data, 'base64');
    },
    async evaluate(expr) {
      const r = await send('Runtime.evaluate', {expression: expr, returnByValue: true, awaitPromise: true});
      return r.result?.result?.value;
    },
    lastError: () => lastErr,
    /**
     * 关会话。
     * Windows 上 kill 之后文件句柄不是立刻释放的：只等 300ms 就删 profile 会抛
     * EBUSY（实测 `EBUSY: resource busy or locked, open ...\DevToolsActivePort`），
     * 而且残留的 profile 会一直堆在 %TEMP%。所以这里等进程真的退出，
     * 删不掉也不当失败（那是临时目录，不是本次渲染的结果）。
     */
    async close() {
      try { ws.close(); } catch {}
      try { chrome.kill(); } catch {}
      // 等进程退出，最多 5s
      const gone = await new Promise((res) => {
        if (chrome.exitCode !== null) return res(true);
        const t = setTimeout(() => res(false), 5000);
        chrome.once('exit', () => { clearTimeout(t); res(true); });
      });
      if (!gone) {
        // 还不退就强杀一次；再等一小会儿
        try { chrome.kill('SIGKILL'); } catch {}
        await sleep(300);
      }
      // 重试删除：Windows 释放句柄有延迟
      for (let i = 0; i < 5; i++) {
        try {
          rmSync(profile, {recursive: true, force: true});
          return;
        } catch {
          await sleep(200);
        }
      }
    },
  };
}
