// 渲染管线探针：把"要不要改渲染架构"从争论变成一张数据表。
//
//   node tools/probes/probe-render.mjs [<仓库根>]
//
// ## 它要回答的问题
//
// 1. **那 ~29ms 的"取像素"里，光栅化占多少、编码占多少？**
//    —— 这是决定性的：若编码主导，则"不编码"（原始像素 / 本地渲染）就是正解；
//    若光栅化主导，换本地渲染**帮不上忙**（两边都是 Skia CPU 光栅化），得走 GPU 光栅化。
// 2. **每帧那 ~35ms 的固定开销是什么？**（从两次实测反推出的：全分辨率 66.5ms、
//    代理 1/4 像素 42.6ms ⇒ 解得固定项 ≈35ms、每像素项 ≈32ms@720p）
// 3. **三种像素出口哪个最快**：JPEG blob → POST（现状）/ 原始 RGBA → POST /
//    WebCodecs 编码 → POST。
// 4. **无头环境有没有硬件编码器？**（WebCodecs 走硬件的收益与可行性）
// 5. **GPU 会不会改变 2D 的像素？**（三档对比）——决定"2D 搬 GPU"的确定性代价。
// 6. **无头环境能不能拿到 WebGL / WebGPU，是硬件还是软件渲染器？**
//
// ## 页面侧代码的写法
//
// 所有要在页面里跑的逻辑都写成**普通函数**，再 `toString()` 注入执行。
// 理由：GLSL/WGSL 要塞进模板字符串里，转义会变成一团糟；写成真函数就没有这问题。
// 代价是页面函数**不能引用外层作用域**，参数一律显式传进去。
import {spawnSync} from 'node:child_process';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const ROOT = (argv[0] && !argv[0].startsWith('--') ? argv[0] : resolve(HERE, '..')).replace(/\\/g, '/');
const P = join(ROOT, 'examples', 'scenecast');

const imp = (rel) => import(pathToFileURL(`${ROOT}/${rel}`).href);
const {openProjectSession} = await imp('src/host/media/renderRange.mjs');
const {loadProject} = await imp('src/host/project/load.mjs');

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const f1 = (v) => (v === undefined || v === null ? '—' : Number(v).toFixed(1));
const f2 = (v) => (v === undefined || v === null ? '—' : Number(v).toFixed(2));
const line = (c = '─') => console.log(c.repeat(78));

// ────────────────────────────────────────────────────────────────────────────
// 页面侧探针（每个都是独立函数，靠 toString 注入）
// ────────────────────────────────────────────────────────────────────────────

/** 2D 像素哈希：用来判断 GPU 有没有改变 2D 光栅化的结果。 */
function pageHash2d(args) {
  const c = document.querySelector('canvas');
  window.__renderFrame(args.frame);
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < d.length; i++) {
    h ^= d[i]; h = Math.imul(h, 16777619) >>> 0;
  }
  return JSON.stringify({hash: h.toString(16), w: c.width, h: c.height});
}

/** 成本分解：只绘制 / 光栅化+读回 / +JPEG / +PNG / toBlob。 */
function pageDecompose(args) {
  const c = document.querySelector('canvas');
  const ctx = c.getContext('2d');
  const frames = args.frames;
  const blobs = [];
  const push = (arr, v) => arr.push(v);

  const draw = [], readback = [], readCrop = [], jpeg = [], png = [], blob = [];
  for (const n of frames) {
    let t = performance.now(); window.__renderFrame(n); push(draw, performance.now() - t);
    t = performance.now(); ctx.getImageData(0, 0, c.width, c.height); push(readback, performance.now() - t);
    t = performance.now(); ctx.getImageData(0, 0, 8, 8); push(readCrop, performance.now() - t);
    t = performance.now(); c.toDataURL('image/jpeg', 0.92); push(jpeg, performance.now() - t);
    t = performance.now(); c.toDataURL('image/png'); push(png, performance.now() - t);
  }
  return {draw, readback, readCrop, jpeg, png};
}

/** toBlob 的成本（不走 base64）。 */
async function pageToBlob(args) {
  const c = document.querySelector('canvas');
  const times = [];
  let bytes = 0;
  for (const n of args.frames) {
    window.__renderFrame(n);
    const t = performance.now();
    const b = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
    times.push(performance.now() - t);
    bytes = b.size;
  }
  return {times, bytes};
}

/** 三种像素出口的端到端耗时（含 await fetch POST，即渲染循环实际付的成本）。 */
async function pageExportPaths(args) {
  const c = document.querySelector('canvas');
  const ctx = c.getContext('2d');
  const frames = args.frames;
  const out = {};
  const post = async (n, body) => {
    const r = await fetch('/__filmwright/frame?n=' + n + '&probe=' + encodeURIComponent(args.tag),
      {method: 'POST', body});
    if (!r.ok) throw new Error('POST 失败 ' + r.status + ' ' + (await r.text()));
  };

  // 出口 1：JPEG blob → POST（现状）
  {
    const t = [];
    for (const n of frames) {
      const t0 = performance.now();
      window.__renderFrame(n);
      const b = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
      await post(n, b);
      t.push(performance.now() - t0);
    }
    out.jpeg = t;
  }
  // 出口 2：原始 RGBA → POST（不在浏览器里编码）
  {
    const t = [];
    for (const n of frames) {
      const t0 = performance.now();
      window.__renderFrame(n);
      const img = ctx.getImageData(0, 0, c.width, c.height);
      await post(n, new Uint8Array(img.data.buffer));
      t.push(performance.now() - t0);
    }
    out.raw = t;
  }
  // 出口 3：WebCodecs → POST（只传已压缩的视频帧）
  // 硬件与软件各试一次并把结果分开记 —— 这一条的价值就在"硬件到底可不可用"
  if (typeof VideoEncoder !== 'undefined') {
    out.webcodecs = {};
    for (const hw of ['prefer-hardware', 'prefer-software']) {
      try {
        const cfg = {
          codec: 'avc1.42001f', width: c.width, height: c.height,
          bitrate: 8000000, framerate: 30, hardwareAcceleration: hw,
        };
        const sup = await VideoEncoder.isConfigSupported(cfg);
        if (!sup.supported) { out.webcodecs[hw] = {supported: false}; continue; }
        const chunks = [];
        let encErr = null;
        const enc = new VideoEncoder({
          output: (ch) => chunks.push(ch),
          error: (e) => { encErr = String(e); },
        });
        enc.configure(cfg);
        const t0 = performance.now();
        for (let i = 0; i < frames.length; i++) {
          window.__renderFrame(frames[i]);
          const f = new VideoFrame(c, {timestamp: i * 33333});
          enc.encode(f, {keyFrame: i % 30 === 0});
          f.close();
          while (enc.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 0));
        }
        await enc.flush();
        const encMs = (performance.now() - t0) / frames.length;
        enc.close();
        // **必须把 POST 也算进来** —— 否则与「JPEG blob → POST」那行不是同一口径
        // （前者只量编码，后者含上传）。分开记两个数，再给合计。
        const tp0 = performance.now();
        let posted = 0;
        for (let i = 0; i < chunks.length; i++) {
          const ch = chunks[i];
          if (!ch || ch.__err) continue;
          const u8 = new Uint8Array(ch.byteLength);
          ch.copyTo(u8);
          await post(i, u8);
          posted++;
        }
        const postMs = (performance.now() - tp0) / frames.length;
        out.webcodecs[hw] = {
          supported: true, ms: encMs, postMs, total: encMs + postMs,
          chunks: posted,
          bytes: chunks.reduce((a, x) => a + (x.byteLength || 0), 0),
          err: encErr,
        };
      } catch (e) {
        out.webcodecs[hw] = {supported: false, error: String(e).slice(0, 160)};
      }
    }
  } else {
    out.webcodecsMissing = true;
  }
  return out;
}

/** WebCodecs 可用性与硬件编码器探测。 */
async function pageWebCodecs(args) {
  const out = {api: typeof VideoEncoder !== 'undefined'};
  if (!out.api) return out;
  out.configs = [];
  for (const hw of ['prefer-hardware', 'prefer-software', 'no-preference']) {
    const cfg = {
      codec: 'avc1.42001f', width: args.w, height: args.h,
      bitrate: 8000000, framerate: 30, hardwareAcceleration: hw,
    };
    try {
      const s = await VideoEncoder.isConfigSupported(cfg);
      out.configs.push({hw, supported: !!s.supported, resolved: s.config ? s.config.hardwareAcceleration : null});
    } catch (e) {
      out.configs.push({hw, error: String(e).slice(0, 120)});
    }
  }
  return out;
}

/** WebGL / WebGPU 可用性与渲染器身份（软件 vs 硬件）。 */
async function pageGpu(args) {
  const out = {};
  // WebGL
  try {
    const cv = document.createElement('canvas');
    cv.width = args.w; cv.height = args.h;
    const g = cv.getContext('webgl2') || cv.getContext('webgl');
    out.webgl = !!g;
    if (g) {
      out.webglVersion = g.getParameter(g.VERSION);
      const dbg = g.getExtension('WEBGL_debug_renderer_info');
      out.webglRenderer = dbg ? g.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER);
      out.webglVendor = dbg ? g.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : g.getParameter(g.VENDOR);
      // 简单吞吐：清屏 + 一个三角形，量 N 帧
      const vs = g.createShader(g.VERTEX_SHADER);
      g.shaderSource(vs, 'attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }');
      g.compileShader(vs);
      const fs = g.createShader(g.FRAGMENT_SHADER);
      g.shaderSource(fs, 'precision mediump float; uniform vec4 c; void main(){ gl_FragColor = c; }');
      g.compileShader(fs);
      const pr = g.createProgram();
      g.attachShader(pr, vs); g.attachShader(pr, fs); g.linkProgram(pr);
      const ok = g.getProgramParameter(pr, g.LINK_STATUS);
      out.webglProgram = !!ok;
      if (ok) {
        g.useProgram(pr);
        const buf = g.createBuffer();
        g.bindBuffer(g.ARRAY_BUFFER, buf);
        // 一个铺满的大三角形（近似填满整屏，量填充率）
        g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), g.STATIC_DRAW);
        g.enableVertexAttribArray(0);
        g.vertexAttribPointer(0, 2, g.FLOAT, false, 0, 0);
        const drawOne = () => {
          g.viewport(0, 0, cv.width, cv.height);
          g.clearColor(0.05, 0.06, 0.1, 1); g.clear(g.COLOR_BUFFER_BIT);
          g.uniform4f(g.getUniformLocation(pr, 'c'), 0.3, 0.6, 1.0, 1.0);
          g.drawArrays(g.TRIANGLES, 0, 3);
        };
        // ⚠️ 不逐帧 finish()：实测它返回 0.00ms —— 无头环境里 finish 不同步，
        // 而且 performance.now() 在无头下精度被钳到 ~0.1ms。改用"一次提交 N 帧、
        // 量总量再摊"，这量的是**命令提交吞吐**（能区分软件与硬件路径），
        // 不是 GPU 完成时间 —— 但它才是渲染循环实际付的成本。
        drawOne();                       // 预热，排除首次编译/分配
        const t = [];
        for (let i = 0; i < args.n; i++) {
          const t0 = performance.now();
          for (let k = 0; k < 50; k++) drawOne();
          // **必须强制刷出**：只提交命令的话 GPU 可以一直排队，
          // 实测那样量到的是 0.00ms（命令没执行）。读回 1 个像素
          // 会逼着驱动把前面的绘制做完 —— 这才是真实的每帧成本。
          const px = new Uint8Array(4);
          g.readPixels(0, 0, 1, 1, g.RGBA, g.UNSIGNED_BYTE, px);
          t.push((performance.now() - t0) / 50);
        }
        out.webglFillMsPerFrame = t;
        out.webglFlushed = true;
      }
    }
  } catch (e) { out.webglError = String(e).slice(0, 160); }
  // WebGPU
  try {
    out.webgpuApi = !!navigator.gpu;
    if (navigator.gpu) {
      const a = await navigator.gpu.requestAdapter();
      out.webgpuAdapter = !!a;
      if (a && a.info) {
        out.webgpuVendor = a.info.vendor;
        out.webgpuArch = a.info.architecture;
        out.webgpuDesc = a.info.description;
      }
    }
  } catch (e) { out.webgpuError = String(e).slice(0, 160); }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
const proj = await loadProject(P);
console.log(`探针项目：${P}\n分辨率：${proj.raw.size?.width ?? 1280}×${proj.raw.size?.height ?? 720}`);

const TIERS = [
  {id: 'A', label: 'A 全软件（现状：--disable-gpu）', opts: {}},
  {id: 'B', label: 'B 2D 软件 + GPU（--disable-accelerated-2d-canvas）', opts: {gpu: true, extraArgs: ['--disable-accelerated-2d-canvas']}},
  {id: 'C', label: 'C 全硬件（放开 GPU）', opts: {gpu: true}},
];

const tierResults = {};

for (const tier of TIERS) {
  line('═');
  console.log(`档位 ${tier.label}`);
  line();
  const before = {count: 0, bytes: 0};
  const sink = {
    write: async (buf) => { before.count++; before.bytes += buf.length; },
  };
  let sess = null, server = null;
  try {
    const r = await openProjectSession(P, proj, {...tier.opts, frameSink: sink});
    sess = r.sess; server = r.server;

    // 2D 像素哈希（三档对比的关键）
    const h = JSON.parse(await sess.evaluate(`(${pageHash2d.toString()})(${JSON.stringify({frame: 200})})`));
    // GPU 探测
    const gpu = await sess.evaluate(`(${pageGpu.toString()})(${JSON.stringify({w: 1280, h: 720, n: 20})})`);
    const wc = await sess.evaluate(`(${pageWebCodecs.toString()})(${JSON.stringify({w: 1280, h: 720})})`);

    tierResults[tier.id] = {hash: h.hash, size: `${h.w}×${h.h}`, gpu, wc};
    console.log(`  2D 像素哈希（第 200 帧）：${h.hash}   ${h.w}×${h.h}`);
    console.log(`  WebGL：${gpu.webgl ? '可用' : '不可用'}` +
      (gpu.webglRenderer ? ` | 渲染器：${gpu.webglRenderer}` : ''));
    if (gpu.webglFillMsPerFrame) {
      console.log(`  WebGL 满屏填充（提交吞吐）：${f2(med(gpu.webglFillMsPerFrame))} ms/帧`);
    }
    console.log(`  WebGPU：API ${gpu.webgpuApi ? '有' : '无'} | 适配器 ${gpu.webgpuAdapter ? '拿到' : '拿不到'}` +
      (gpu.webgpuDesc ? ` | ${gpu.webgpuDesc}` : (gpu.webgpuVendor ? ` | ${gpu.webgpuVendor} ${gpu.webgpuArch || ''}` : '')));
    console.log(`  WebCodecs：${wc.api ? '有' : '无'}` +
      (wc.configs ? ` | ${wc.configs.map((c) => `${c.hw}=${c.supported ? '支持' : (c.error ? '错误' : '不支持')}`).join(', ')}` : ''));

    // 只有 A 档跑完整的成本分解（避免把三档都跑成十分钟）
    if (tier.id === 'A') {
      line();
      console.log('成本分解（40 帧中位数，单位 ms/帧）');
      line();
      const frames = Array.from({length: 40}, (_, i) => 100 + i * 7);
      const d = await sess.evaluate(`(${pageDecompose.toString()})(${JSON.stringify({frames})})`);
      const drawMs = med(d.draw), readMs = med(d.readback), cropMs = med(d.readCrop);
      const jpegMs = med(d.jpeg), pngMs = med(d.png);
      const tb = await sess.evaluate(`(${pageToBlob.toString()})(${JSON.stringify({frames: frames.slice(0, 20)})})`);
      const blobMs = med(tb.times);
      console.log(`  1. 只绘制（不读像素）        ${f2(drawMs)}`);
      console.log(`  2. 光栅化+读回 getImageData  ${f2(readMs)}   ← 不含编码`);
      console.log(`  3. 只读 8×8 小角             ${f2(cropMs)}   ← 看"读回"本身要多少`);
      console.log(`  4. toDataURL('image/jpeg')   ${f2(jpegMs)}`);
      console.log(`  5. toDataURL('image/png')    ${f2(pngMs)}`);
      console.log(`  6. toBlob('image/jpeg')      ${f2(blobMs)}   （${(tb.bytes / 1024).toFixed(0)} KB，不走 base64）`);
      line();
      // ⚠️ 这几个数**不能**直接相减来分离"光栅化 / 编码"：
      // 实测出现 jpeg(6.7) < 读回(15.2) < toBlob jpeg(19.0) 这种反直觉次序，
      // 原因是三条 API 的路径不同 —— getImageData 要把 3.7MB 拷进 JS 堆（贵），
      // toDataURL 在 C++ 内部完成光栅化+编码（不拷进 JS），toBlob 又多一次任务往返。
      // 所以这里只如实列出，**不推导**"编码占多少"。
      console.log('  ⚠ 这三条 API 的路径不同（getImageData 要拷 3.7MB 进 JS 堆；');
      console.log('    toDataURL 在 C++ 内部完成；toBlob 多一次任务往返），');
      console.log('    因此**不能相减**来分离光栅化与编码 —— 下面的数只用来看量级与次序。');
      console.log(`  toBlob 产物：${(tb.bytes / 1024).toFixed(0)} KB/帧`);

      // CDP 往返与 POST 往返（固定开销的两个候选来源）
      line();
      console.log('固定开销归因');
      line();
      let t0 = Date.now();
      for (let i = 0; i < 20; i++) await sess.evaluate('1');
      const cdpRtt = (Date.now() - t0) / 20;
      t0 = Date.now();
      for (let i = 0; i < 20; i++) {
        await fetch(`http://127.0.0.1:${r.port}/__filmwright/frame?n=0&probe=rtt`, {method: 'POST', body: new Uint8Array(1)});
      }
      const postRtt = (Date.now() - t0) / 20;
      console.log(`  CDP evaluate 往返（no-op）   ${f2(cdpRtt)} ms`);
      console.log(`  HTTP POST 往返（1 字节）     ${f2(postRtt)} ms`);
      console.log(`  ⇒ 合计 ${f2(cdpRtt + postRtt)} ms —— **这就是进程边界的真实成本**`);
    }

    // 像素出口对比：A 与 B 都跑（硬件编码要 GPU 可用才有）
    if (tier.id === 'A' || tier.id === 'B') {
      line();
      console.log(`三种像素出口端到端（档位 ${tier.id}，含 await POST，单位 ms/帧）`);
      line();
      const frames2 = Array.from({length: 20}, (_, i) => 100 + i * 7);
      const ex = await sess.evaluate(`(${pageExportPaths.toString()})(${JSON.stringify({frames: frames2, tag: 'exp-' + tier.id})})`);
      if (ex.jpeg) console.log(`  ${'JPEG blob → POST（现状）'.padEnd(28)} ${f2(med(ex.jpeg))}`);
      if (ex.raw) console.log(`  ${'原始 RGBA → POST'.padEnd(28)} ${f2(med(ex.raw))}   ${(1280 * 720 * 4 / 1048576).toFixed(1)}MB/帧`);
      for (const hw of ['prefer-hardware', 'prefer-software']) {
        const w = ex.webcodecs && ex.webcodecs[hw];
        if (!w) continue;
        if (!w.supported) { console.log(`  ${('WebCodecs ' + hw).padEnd(28)} 不支持`); continue; }
        const kb = w.chunks ? (w.bytes / w.chunks / 1024).toFixed(0) : '?';
        console.log(`  ${('WebCodecs ' + hw).padEnd(28)} ${f2(w.total)}   （编码 ${f2(w.ms)} + 上传 ${f2(w.postMs)}）` +
          `  ${kb}KB/块 ×${w.chunks}` + (w.err ? `  ⚠ ${w.err.slice(0, 50)}` : ''));
      }
      if (ex.webcodecsMissing) console.log('  WebCodecs：页面里没有 VideoEncoder');
      console.log(`\n  POST 累计收到 ${before.count} 次、${(before.bytes / 1048576).toFixed(1)} MB`);
    }
  } catch (e) {
    console.log(`  档位 ${tier.id} 失败：${String(e.message).slice(0, 240)}`);
  } finally {
    try { if (sess) await sess.close(); } catch {}
    try { if (server) server.close(); } catch {}
  }
}

// ────────────────────────────────────────────────────────────────────────────
line('═');
console.log('三档对比：GPU 有没有改变 2D 的像素？');
line();
const hA = tierResults.A?.hash, hB = tierResults.B?.hash, hC = tierResults.C?.hash;
console.log(`  A（全软件）        ${hA || '（未取到）'}`);
console.log(`  B（2D软件+GPU）    ${hB || '（未取到）'}`);
console.log(`  C（全硬件）        ${hC || '（未取到）'}`);
if (hA && hB && hA === hB) {
  console.log('\n  ⇒ **A 与 B 完全相同** —— 这就是要的那一档：');
  console.log('    `--disable-accelerated-2d-canvas` + 放开 GPU ⇒ 2D 逐像素不变，');
  console.log('    而 3D / WebGPU / 硬件编码都拿到了真 GPU。');
  console.log('    （即：确定性不必牺牲，就能上 GPU）');
} else if (hA && hB) {
  console.log('\n  ⇒ A 与 B 不同：强制 2D 走 CPU 没能保住原像素，需要进一步查。');
}
if (hC && hA && hC !== hA) {
  console.log('\n  ⇒ C 与 A 不同：**放开 GPU 会让 2D 像素变化**（基线不再跨机器成立）。');
  console.log('    所以不要用 C 档当默认；要用 GPU 就走 B 档。');
}

// Node 侧的 WebGPU（决定"本地渲染"这条路是否真的可用）
line('═');
console.log('Node 侧能力（决定"搬本地"这条路是否可用）');
line();
const nodeGpu = spawnSync(process.execPath, ['-e',
  'const o={};o.navigator=typeof navigator;o.webgpu=typeof navigator!=="undefined"&&!!navigator.gpu;' +
  'try{const {createCanvas}=require("@napi-rs/canvas");o.napiCanvas=true;}catch(e){o.napiCanvas=false;o.napiErr=String(e.message).slice(0,80);}' +
  'try{require("canvas");o.nodeCanvas=true;}catch(e){o.nodeCanvas=false;}' +
  'try{require("gl");o.headlessGl=true;}catch(e){o.headlessGl=false;}' +
  'console.log(JSON.stringify(o));'], {encoding: 'utf8', cwd: ROOT});
console.log(`  ${String(nodeGpu.stdout).trim() || String(nodeGpu.stderr).trim().slice(0, 200)}`);
console.log(`  Node 版本：${process.version}`);
line('═');
console.log('读法：');
console.log('  · CDP + POST 往返 = 进程边界的真实成本。**若它只有几毫秒**，');
console.log('    那么"搬本地渲染能消掉一大笔固定开销"这个说法就不成立。');
console.log('  · 若原始 RGBA 直传明显慢于 JPEG blob ⇒ 方向 B（不编码、传原始像素）被否掉。');
console.log('  · 若 WebCodecs 硬件档可用且端到端更快 ⇒ 方向 A 成立（且只在 GPU 档可用）。');
console.log('  · 若 B 档与 A 档 2D 像素哈希相同 ⇒ 能做到「2D 确定 + 3D/编码走 GPU」两全。');
line('═');
