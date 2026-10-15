// CDP 驱动：启动一个无头浏览器，打开渲染页，按帧截图。
// 每个渲染分片一个独立实例（独立 user-data-dir），互不干扰。
import {spawn} from 'node:child_process';
import {mkdtempSync, readFileSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {findBrowser} from './find.mjs';
import {frameFormatExpr} from './frameFormat.mjs';



const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 这里曾有一份 `serveProject` 的**重复实现**：自带一份更短的 MIME 表，而且 `/fonts/`
// 只查项目 `public/`、**没有库根兜底**。全仓没有任何地方 import 它 —— 真正的那个在
// `src/host/project/server.mjs`（`preview` / `renderRange` / 各验收工具走的都是它）。
// 留着的代价是**上膛的枪**：谁把它接回去，库自带的字体就会静默 404 ——
// 字体加载失败**不报错**，只会回退系统字体，在没装中文字体的机器上等于中文全丢。
// 已删（连同它专用的 `MIME` 表）。

/**
 * 打开一个渲染会话。
 * @param {string} url 渲染页地址
 * @param {{width:number,height:number}} size 画布尺寸
 * @param {object} opts {colorProfile, extraArgs, browser, readyExpr}
 *   readyExpr：覆盖就绪信号（默认等渲染页的 window.__ready，预览页传
 *   'window.__preview && window.__preview.ready === true'）。只判布尔，
 *   不读 info / __bootError —— 那两个是渲染页 boot 的语义。
 */
export async function openSession(url, size, opts = {}) {
  const browser = findBrowser(opts.browser);
  const profile = mkdtempSync(join(tmpdir(), 'filmwright-'));
  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    // 无头是必须的：CI / 服务器上没有 X server，有头模式直接退出
    // （实测报 "Missing X server or $DISPLAY"）。headless=new 与有头同一条渲染路径。
    '--headless=new',
    `--window-size=${size.width},${size.height}`,
    '--hide-scrollbars',
    // GPU 默认**关闭**（确定性优先）：Canvas 2D 走 CPU 光栅化（Skia 软件），
    // 跨机器逐像素一致。`opts.gpu: true` 才放开 —— 但那会让 2D 也可能走
    // GPU 光栅化路径，像素基线不再跨机器成立（探针 `tools/probes/probe-render.mjs`
    // 量的就是这件事：GPU 到底有没有改变 2D 像素）。
    ...(opts.gpu ? [] : ['--disable-gpu']),
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
      try {
        const txt = readFileSync(portFile, 'utf8').split('\n')[0].trim();
        // 端口必须是数字：文件可能只写了一半（Windows 上更常见）
        if (/^\d+$/.test(txt)) { devPort = txt; break; }
      } catch (e) {
        // ⚠️ **Windows 上 Chrome 还锁着这个文件**：`existsSync` 为真，
        // `readFileSync` 抛 `EBUSY: resource busy or locked`（CI 的 windows 那条实测红过）。
        // 那是"**还没就绪**"，不是失败 —— 继续等，别把它抛出去。
        // （`close()` 里删 profile 时踩过同一个 EBUSY，那边是等进程退出；
        //   这边是文件正在被写，处理方式不同。）
        if (e.code !== 'EBUSY' && e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
      }
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

  /**
   * WebSocket 断开 / 出错时**立即拒绝所有 pending 调用**。
   *
   * 这是「浏览器中途退出」的正确处理：不处理的话，所有在飞的 CDP 调用
   * （尤其无超时的 send）永远不 resolve，整个渲染/自检挂到 job 超时，
   * 报出来还是「进程被杀」——看不出是浏览器掉了。
   * 实测 CI 的 windows runner 上会出现（步骤耗时异常长然后失败）。
   */
  let wsClosed = null;
  const rejectAll = (why) => {
    wsClosed = why;
    for (const [, entry] of pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.rej(new Error('filmwright: 浏览器连接已断开（' + why + '）'));
    }
    pending.clear();
  };
  ws.onclose = () => rejectAll('WebSocket closed');
  ws.onerror = () => rejectAll('WebSocket error');
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    const entry = msg.id ? pending.get(msg.id) : null;
    if (entry) {
      if (entry.timer) clearTimeout(entry.timer);
      pending.delete(msg.id);
      entry.res(msg);
    }
  };

  /**
   * CDP 调用（统一带超时 + 断开即拒）。
   *
   * 为什么全部都要超时：无超时的调用在浏览器卡死或退出时永远不返回，
   * 整个流程挂到 job 超时，报出来是「进程被杀」，掩盖真实原因。
   * 默认 30s；单帧渲染/截图给 60s（正常 ~80ms，超了就是真卡住）。
   */
  const sendTimeout = (method, params = {}, ms = 30000, label = '') => new Promise((res, rej) => {
    if (wsClosed) { rej(new Error('filmwright: 浏览器连接已断开（' + wsClosed + '）')); return; }
    const myId = ++id;
    const timer = setTimeout(() => {
      pending.delete(myId);
      // `label` 说清**当时在干什么** —— 原先只报 `CDP Runtime.evaluate`，出问题时看不出是哪一步
      // （画面采样？逐帧绘制？截图？），排查得靠猜。
      rej(new Error(`filmwright: CDP ${method}${label ? `（${label}）` : ''} 超过 ${ms}ms 没响应`
        + '（浏览器可能卡死或已退出）'));
    }, ms);
    pending.set(myId, {res, rej, timer});
    ws.send(JSON.stringify({id: myId, method, params}));
  });
  /** 默认超时的简写（协议握手这类快调用）。 */
  const send = (method, params = {}) => sendTimeout(method, params, 30000);

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false,
  });
  await send('Page.navigate', {url});

  let info = null;
  let bootError = null;
  // 页面侧的结构化字段（`code` / `hint`）要单独带回来 —— 见 src/host/pages/render.html 里的说明。
  let bootCode = null;
  let bootHint = null;
  let ready = false;
  // 就绪预算：默认 120s。为什么这么长 —— 分片渲染时多个浏览器**同时冷启**，
  // 在内存吃紧的机器上（实测 16 核但只剩 5GB）单个实例的 boot 可以慢到几十秒。
  // 40s 的旧预算会把「慢」误报成「坏」，而错误信息还指向字体与 import ——
  // 使用者会去查一个根本没问题的地方。
  const tries = Number(process.env.FILMWRIGHT_BOOT_TRIES) || 1200;
  const t0 = Date.now();
  let lastSeen = null;
  for (let i = 0; i < tries; i++) {
    const expr = opts.readyExpr
      ? `Boolean(${opts.readyExpr})`
      : '({ready: window.__ready === true, info: window.__info || null, err: window.__bootError || null, errCode: window.__bootErrorCode || null, errHint: window.__bootErrorHint || null})';
    const r = await send('Runtime.evaluate', {expression: expr, returnByValue: true});
    const v = r.result?.result?.value;
    if (opts.readyExpr) {
      if (v === true) { ready = true; break; }
      lastSeen = String(v);
    } else {
      if (v?.err) { bootError = v.err; bootCode = v.errCode ?? null; bootHint = v.errHint ?? null; break; }
      if (v?.ready) { ready = true; info = v.info; break; }
      lastSeen = v ? `ready=${v.ready}（页面已连上但 boot 未完成）` : '页面还没响应';
    }
    await sleep(100);
  }
  if (!ready) {
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    try { ws.close(); } catch {}
    try { chrome.kill(); } catch {}
    try { rmSync(profile, {recursive: true, force: true}); } catch {}
    if (bootError) {
      const e = new Error('filmwright: 渲染页启动失败\n' + bootError);
      // 把页面侧的结构化字段接回错误对象 —— 否则 CLI 的 `--json` 只能报 code: "ERROR"，
      // AI 拿不到可分支的码（那正是这个项目对 agent 的核心承诺之一）。
      if (bootCode) e.code = bootCode;
      if (bootHint) e.hint = bootHint;
      throw e;
    }
    // 如实说「等了多久 + 最后看到什么」，而不是猜一个原因。
    // 慢（机器忙/内存不足）与坏（字体路径错、import 错）的排查方向完全不同。
    throw new Error(`filmwright: 渲染页 ${secs}s 内没就绪（最后状态：${lastSeen ?? '未知'}）\n` +
      '  两种可能，按这个顺序排：\n' +
      '    1) 机器忙或内存不足：减小 --shards（每个分片是一个独立浏览器实例，' +
      '约需 500MB），或等负载降下来\n' +
      '    2) 项目本身有问题：字体路径、模块 import、镜头代码抛错 —— ' +
      '用 filmwright preview 打开页面能直接看到 boot 错误\n' +
      `  要放宽预算：FILMWRIGHT_BOOT_TRIES=${tries * 2}（每轮 100ms）`);
  }

  let lastErr = null;
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') {
      lastErr = m.params?.exceptionDetails?.exception?.description || 'exception';
    }
  });

  /**
   * 把「帧格式」选项翻译成页面里的 `toDataURL(...)` 参数。
   *
   * ## 为什么渲染路径默认用 JPEG（实测数据）
   *
   * 逐帧剖析（1280×720，同一批 40 帧的中位数）：
   *
   * | 格式 | 绘制 | **编码** | 载荷 | 单帧总 |
   * |---|---|---|---|---|
   * | PNG | 0.6ms | **50.1ms** | **1243 KB** | 97.8ms |
   * | JPEG q=0.92 | 0.7ms | **29.0ms** | **86.6 KB** | 71.4ms |
   * | WebP q=0.9 | 0.7ms | 157.9ms | 35.7KB | 149.9ms |
   *
   * 绘制只占 0.6ms —— 瓶颈全在**编码与搬运**。PNG 是无损压缩，编码慢、
   * 载荷大 14 倍；而这条路的终点是 h264（有损），所以中间用 JPEG 不引入
   * 额外可见损失（q=0.92 是视觉透明档），却省掉一半编码时间与 93% 的载荷。
   * WebP 更小但编码慢 5 倍，排除。
   *
   * **stills / 基线那条路仍用 PNG**（无损、便于逐像素比对）—— 两条路的目的不同：
   *   - 渲染成视频：中间帧只是过路数据，够好就行 → JPEG
   *   - 出静帧 / 像素回归：要能逐像素复现 → PNG
   *
   * **帧格式的默认值是 PNG**（无损）—— 既有调用方不受影响；
   * **渲染成视频的那条路显式选 JPEG**（见 renderRange）：那是唯一「够好就行」的场景。
   *
   * `frameFormat` 可显式指定：`'png'`、`'jpeg'`、`'jpeg:80'`（质量 0-100）。
   */
  return {
    info,
    /** 原始 CDP 调用（Input / Emulation 等高级用法）；普通取值用 evaluate。 */
    send,
    async frame(n, opts2 = {}) {
      // **一次 CDP 往返**做完「渲染 + 编码 + 取回」。
      //
      // 之前是两次 evaluate（先 __renderFrame，再 toDataURL），而实测每次往返的
      // 固定开销约 20ms —— 与载荷大小几乎无关（载荷差 14 倍时总时间只差 5ms），
      // 说明瓶颈是**往返次数**而不是数据量。合并后直接省掉一次往返。
      //
      // 用带超时的调用：浏览器在长渲染里卡死时，`send` 会**永远不返回**，
      // 整个渲染挂到 job 超时，报出来还是「进程被杀」，看不出是浏览器的问题。
      // 给足 60s（单帧正常 ~30ms，60s 只可能是真卡住），让失败可诊断。
      const fmt = frameFormatExpr(opts2.frameFormat);
      const expr = `(() => {
        window.__renderFrame(${n});
        return document.querySelector('canvas').toDataURL(${fmt});
      })()`;
      const r = await sendTimeout('Runtime.evaluate', {expression: expr, returnByValue: true}, 60000,
        `单帧渲染+取图（第 ${n} 帧）`);
      if (r.result?.exceptionDetails) {
        throw new Error('filmwright: 第 ' + n + ' 帧抛错：' + JSON.stringify(r.result.exceptionDetails).slice(0, 400));
      }
      const dataUrl = r.result?.result?.value;
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
        throw new Error('filmwright: 第 ' + n + ' 帧取像素失败（toDataURL 没返回图像）');
      }
      return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
    },

    /**
     * 流式渲染一段帧：**页面自己循环**，每帧编码后以二进制 POST 给本地服务。
     *
     * ## 为什么这条比「逐帧 CDP 取回」快
     *
     * 逐帧那条路每帧要一次 `Runtime.evaluate` 往返（实测固定开销约 20ms，
     * 与载荷大小几乎无关），而且图片要以 base64 走 JSON（多 33% 体积 + 两端编解码）。
     * 这条路：
     *   - **整段只有一次 CDP 调用**（启动页面循环），没有逐帧往返；
     *   - 帧以**二进制** POST，不走 base64 也不走 JSON 序列化；
     *   - 服务端写完 ffmpeg 才回响应 → 页面在 `await fetch` 处自然限速（背压）。
     *
     * 不变量不受影响：每个 n 仍只依赖 n，页面循环只是「换个地方顺序调用」。
     *
     * @param {{from:number,to:number,frameFormat?:string,onPage?:Function,timeoutMs?:number}} o
     * @returns {Promise<number>} 页面报告写完的帧数
     */
    async streamFrames({from, to, frameFormat = 'jpeg', fps = 30, timeoutMs}) {
      const total = to - from + 1;
      if (total <= 0) return 0;
      // 逐帧超时预算：正常一帧几十毫秒，给 3s/帧 + 120s 余量；上限 6 小时。
      // 不用固定 60s —— 长片一段几千帧，固定超时必挂（旧代码的隐患）。
      const budget = Math.min(6 * 3600 * 1000, total * 3000 + 120000);
      const expr = frameFormat === 'h264' ? `(async () => {
        // ── H.264 路径：页面里直接编码，chunk 转 Annex-B 后二进制 POST ──
        // 实测（720p）：绘制 0.19ms + 编码 2.18ms，而 JPEG 取像素要 16.47ms。
        // 主机侧因此可以 -c:v copy 直接封装，**不重编**。
        const canvas = document.querySelector('canvas');
        const {createH264Encoder, annexBFromChunk, h264Available} =
          await import('/kit/runtime/encode/h264.js');
        if (!h264Available()) throw new Error('这个环境没有 WebCodecs；用 --frame-format jpeg');
        let desc = null, descUsed = false;
        const pending = [];
        const enc = await createH264Encoder({
          width: canvas.width, height: canvas.height, fps: ${fps},
          // onChunk 是**同步**的，而 POST 是异步的 —— 先入队，由渲染循环排空。
          // 不排队直接 await 会把编码器的回调卡住。
          onChunk: (chunk, meta) => {
            if (meta && meta.decoderConfig && meta.decoderConfig.description && !desc) {
              desc = new Uint8Array(meta.decoderConfig.description);
            }
            const buf = new Uint8Array(chunk.byteLength);
            chunk.copyTo(buf);
            // SPS/PPS 只在第一帧写一次（重复写虽然合法但白费字节）
            pending.push(annexBFromChunk(buf, descUsed ? null : desc));
            if (desc) descUsed = true;
          },
        });
        let sent = 0;
        const post = async (bytes) => {
          const resp = await fetch('/__filmwright/frame?n=' + (${from} + sent),
            {method: 'POST', body: bytes});
          if (!resp.ok) throw new Error('第 ' + (${from} + sent) + ' 帧上传被拒：' + (await resp.text()));
          sent++;
        };
        const drain = async () => { while (pending.length) await post(pending.shift()); };
        for (let n = ${from}; n <= ${to}; n++) {
          window.__renderFrame(n);
          await enc.encode(canvas, n);   // encode 是入队；背压在编码器内部
          await drain();
        }
        await enc.flush();               // 冲掉编码器里剩下的
        await drain();
        enc.close();
        return sent;
      })()` : `(async () => {
        const canvas = document.querySelector('canvas');
        for (let n = ${from}; n <= ${to}; n++) {
          window.__renderFrame(n);
          const blob = await new Promise((res, rej) => canvas.toBlob(
            (b) => (b ? res(b) : rej(new Error('toBlob 返回空'))),
            ${frameFormatExpr(frameFormat)}));
          const resp = await fetch('/__filmwright/frame?n=' + n, {method: 'POST', body: blob});
          if (!resp.ok) throw new Error('第 ' + n + ' 帧上传被拒：' + (await resp.text()));
        }
        return ${total};
      })()`;
      const r = await sendTimeout('Runtime.evaluate',
        {expression: expr, returnByValue: true, awaitPromise: true}, timeoutMs ?? budget,
        `流式渲染（${from}–${to} 帧）`);
      if (r.result?.exceptionDetails) {
        const d = r.result.exceptionDetails;
        const msg = d.exception?.description || d.text || JSON.stringify(d);
        throw new Error('filmwright: 页面流式渲染中断：' + String(msg).slice(0, 400));
      }
      return Number(r.result?.result?.value) || total;
    },

    /**
     * 只取当前画布（不重新渲染）——给「渲染完再额外存一份」的场景用。
     * 常规渲染请用 frame(n)，它把两步合并成一次往返。
     */
    async captureCanvas(n, opts2 = {}) {
      const r = await sendTimeout('Runtime.evaluate', {
        expression: `document.querySelector('canvas').toDataURL(${frameFormatExpr(opts2.frameFormat)})`,
        returnByValue: true,
      }, 60000, `取画布（第 ${n} 帧）`);
      const dataUrl = r.result?.result?.value;
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
        throw new Error('filmwright: 第 ' + n + ' 帧从 canvas 读数失败（toDataURL 没返回图像）');
      }
      return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
    },
    /** 只跑绘制代码、不截图：用来把每帧都过一遍查错（比截图快得多）。 */
    async drawOnly(n) {
      const r = await sendTimeout('Runtime.evaluate', {
        expression: `(window.__lastError = null, window.__renderFrame(${n}), window.__lastError)`,
        returnByValue: true,
      }, 30000, `逐帧绘制检查（第 ${n} 帧）`);
      return r.result?.result?.value ?? null;
    },
    async screenshot() {
      const shot = await send('Page.captureScreenshot', {format: 'png', captureBeyondViewport: false});
      if (!shot.result?.data) throw new Error('filmwright: 截图失败');
      return Buffer.from(shot.result.data, 'base64');
    },
    /**
     * 页面求值。
     *
     * `ms` 是**这一次往返**的预算。贵的页面工作要**自己分片**，不要靠把预算调大 ——
     * 调大只是把悬崖往后挪，真卡住时会白等更久。（实测教训：整条时间轴的画面采样
     * 塞进一次调用，2100 帧的片子要 13–55 秒，卡在 30s 默认值上，
     * 于是时不时报「超过 30000ms 没响应」，而浏览器其实好好的。
     * 现在采样在 `host/checks/browser/qualityCheck.mjs` 里分片。）
     */
    async evaluate(expr, ms = 30000, label = '页面求值') {
      const r = await sendTimeout('Runtime.evaluate',
        {expression: expr, returnByValue: true, awaitPromise: true}, ms, label);
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
