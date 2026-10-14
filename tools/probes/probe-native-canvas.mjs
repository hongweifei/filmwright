// 本地渲染库 vs 浏览器：**同一份绘制代码两边跑**的对比。
//
//   node tools/probes/probe-native-canvas.mjs [<仓库根>]
//
// ## 要回答什么
//
// "换本地渲染库（@napi-rs/canvas 等）渲染性能会不会更好？"
//
// 关键认知：本地库换的是**代码在哪儿跑**，不是**跑什么算法** ——
// 两边都是 **Skia**（`@napi-rs/canvas` 链接的正是 Skia，与 Chrome 同一套）。
// 所以光栅化本身不会有数量级差别；可能省的只有：
//   · 浏览器进程边界（后实测只有 2ms）
//   · 像素读出时的 JS 堆拷贝（浏览器的 getImageData 要拷 3.7MB 进 JS）
//   · JPEG/视频编码（两边都有，看实现）
//
// ## 方法
//
// 用**同一个 `drawScene` 函数**（纯 Canvas 2D API）在两边画同一个合成场景：
// 背景渐变 + 面板 + 圆角 + 大量中英文字 + 混合模式 + 图像贴图 ——
// 接近我们模板的负载特征（文字密集）。
//
// ⚠️ **这是合成场景，不是真实模板**。真实模板跑在浏览器的模块系统里，
// 搬到本地要改接线。所以这里的数只用来看"量级"，判断"值不值得往下查"。
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const ROOT = (argv[0] && !argv[0].startsWith('--') ? argv[0] : resolve(HERE, '..')).replace(/\\/g, '/');
const P = join(ROOT, 'examples', 'scenecast');
const W = 1280, H = 720;
const N = 30;

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const f2 = (v) => (v === undefined || v === null ? '—' : Number(v).toFixed(2));
const line = (c = '─') => console.log(c.repeat(78));

/**
 * 代表性的合成场景。**两边共用这一份代码** —— 这是对比公平的前提。
 * 不引用任何外层变量（要 toString 注入浏览器）。
 */
function drawScene(ctx, W, H, n, font) {
  // 背景：竖直渐变 + 一点噪点感
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#0a0d14');
  bg.addColorStop(1, '#141a26');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // 三个面板：圆角 + 边框 + 内部渐变
  for (let i = 0; i < 3; i++) {
    const x = 90 + i * 380;
    const y = 120 + ((n + i * 7) % 12);
    const g = ctx.createLinearGradient(x, y, x + 320, y + 200);
    g.addColorStop(0, 'rgba(90,155,255,0.16)');
    g.addColorStop(1, 'rgba(53,208,127,0.10)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(x + 14, y);
    ctx.arcTo(x + 320, y, x + 320, y + 200, 14);
    ctx.arcTo(x + 320, y + 200, x, y + 200, 14);
    ctx.arcTo(x, y + 200, x, y, 14);
    ctx.arcTo(x, y, x + 320, y, 14);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(120,170,255,0.35)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // 大量文字：接近模板的负载特征（中英混排、多字号）
  ctx.textBaseline = 'middle';
  const sizes = [46, 30, 22, 17];
  for (let i = 0; i < 16; i++) {
    const s = sizes[i % sizes.length];
    ctx.font = `${i % 5 === 0 ? '700 ' : ''}${s}px ${font}`;
    ctx.fillStyle = i % 3 === 0 ? '#e8eefc' : (i % 3 === 1 ? '#9fb2d0' : '#5B9BFF');
    const x = 70 + (i % 2) * 560;
    const y = 90 + Math.floor(i / 2) * 74;
    ctx.fillText(`第 ${i + 1} 行 · Panel ${n} — 渲染性能对比 ${(i * 37 + n) % 1000}`, x, y);
  }

  // 混合模式叠加（模板里大量用）
  ctx.globalCompositeOperation = 'screen';
  ctx.fillStyle = 'rgba(90,155,255,0.20)';
  ctx.beginPath();
  ctx.arc(980, 560 + (n % 10), 130, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';

  // 图像贴图（模拟素材层）
  if (!drawScene._tile) {
    const tc = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(64, 64) : null;
    if (tc) {
      const tx = tc.getContext('2d');
      tx.fillStyle = '#2a3550';
      tx.fillRect(0, 0, 64, 64);
      tx.fillStyle = '#5B9BFF';
      tx.fillRect(0, 0, 32, 32);
      tx.fillRect(32, 32, 32, 32);
      drawScene._tile = tc;
    }
  }
  if (drawScene._tile) {
    ctx.globalAlpha = 0.55;
    ctx.drawImage(drawScene._tile, 60, 560, 180, 100);
    ctx.globalAlpha = 1;
  }

  // 进度条（引擎内建件的代表）
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fillRect(0, H - 6, W, 6);
  ctx.fillStyle = '#5B9BFF';
  ctx.fillRect(0, H - 6, W * ((n % 60) / 60), 6);
}

// ─────────────────────────────────────────────────────────────────────────────
// 一、本地（@napi-rs/canvas）
// ─────────────────────────────────────────────────────────────────────────────
console.log(`对比：本地 @napi-rs/canvas vs 浏览器 Canvas 2D，场景 ${W}×${H}，${N} 帧\n`);
line('═');
console.log('一、本地 @napi-rs/canvas');
line();

let native = null;
const FONT_FILE = 'NotoSansSC.ttf';
const FONT_FAMILY = 'FWProbe';
try {
  const {createCanvas, GlobalFonts} = await import('@napi-rs/canvas');
  const {existsSync, readFileSync} = await import('node:fs');
  const fontPath = join(P, 'public', 'fonts', FONT_FILE);
  let fontOk = false;
  if (existsSync(fontPath)) {
    // ⚠️ register 要的是 **Buffer/TypedArray**，不是路径 —— 传路径会抛
    // "Get TypedArray info failed"（第一版就栽在这，结果本地用了系统字体、
    // 而浏览器用项目字体，文字负载根本不可比）。
    try {
      GlobalFonts.register(readFileSync(fontPath), FONT_FAMILY);
      fontOk = GlobalFonts.has(FONT_FAMILY);
    } catch (e) {
      console.log(`  字体注册失败：${String(e.message).slice(0, 120)}`);
    }
  }
  const font = FONT_FAMILY;
  console.log(`  字体：${fontOk ? `${FONT_FILE} → ${FONT_FAMILY}（两边同用这一个文件）` : '★ 未注册成功，文字负载不可比'}`);

  const c = createCanvas(W, H);
  const ctx = c.getContext('2d');
  // 预热
  for (let i = 0; i < 5; i++) drawScene(ctx, W, H, i, font);

  const tDraw = [], tRead = [], tJpeg = [];
  for (let f = 0; f < N; f++) {
    let t0 = performance.now();
    drawScene(ctx, W, H, f, font);
    tDraw.push(performance.now() - t0);

    t0 = performance.now();
    ctx.getImageData(0, 0, W, H);
    tRead.push(performance.now() - t0);

    t0 = performance.now();
    try { c.toBuffer('image/jpeg', 92); } catch (e) { tJpeg.push(NaN); }
    tJpeg.push(performance.now() - t0);
  }
  native = {draw: med(tDraw), read: med(tRead), jpeg: med(tJpeg), font};
  console.log(`  只绘制            ${f2(native.draw)} ms`);
  console.log(`  读回 getImageData  ${f2(native.read)} ms`);
  console.log(`  toBuffer('image/jpeg', 92)  ${f2(native.jpeg)} ms`);
  console.log(`  端到端（绘制+JPEG）  ${f2(native.draw + native.jpeg)} ms`);

  // 额外：本地能直接拿 raw 缓冲（不用经过 JS 堆拷贝）
  const t0 = performance.now();
  const raw = ctx.getImageData(0, 0, W, H).data;
  console.log(`  （raw 缓冲长度 ${raw.length}，${(raw.length / 1048576).toFixed(1)}MB）`);
} catch (e) {
  console.log(`  ✗ 本地库不可用：${String(e.message).slice(0, 200)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 二、浏览器（同一份 drawScene）
// ─────────────────────────────────────────────────────────────────────────────
line('═');
console.log('二、浏览器 Canvas 2D（同一份绘制代码）');
line();
let browser = null;
try {
  const imp = (rel) => import(pathToFileURL(`${ROOT}/${rel}`).href);
  const {openProjectSession} = await imp('src/host/media/renderRange.mjs');
  const {loadProject} = await imp('src/host/project/load.mjs');
  const proj = await loadProject(P);
  const r = await openProjectSession(P, proj, {frameSink: {write: async () => {}}});
  try {
    const expr = `(async () => {
      const drawScene = ${drawScene.toString()};
      const c = document.querySelector('canvas');
      const ctx = c.getContext('2d');
      const W = c.width, H = c.height;
      // 用**同一个字体文件**：本地注册了 ${FONT_FILE} → ${FONT_FAMILY}，
      // 浏览器这边也从项目服务器拿同一个文件注册同名 family，否则文字负载不可比。
      let fontOk = false;
      try {
        const face = new FontFace(${JSON.stringify(FONT_FAMILY)}, 'url(/proj/public/fonts/${FONT_FILE})');
        await face.load();
        document.fonts.add(face);
        fontOk = document.fonts.check('16px ${FONT_FAMILY}');
      } catch (e) { fontOk = false; }
      const font = fontOk ? ${JSON.stringify(FONT_FAMILY)} : 'sans-serif';
      const med = (a) => { const s = [...a].sort((x,y)=>x-y); return s[Math.floor(s.length/2)]; };
      for (let i = 0; i < 5; i++) drawScene(ctx, W, H, i, font);
      const tDraw = [], tRead = [], tJpeg = [];
      for (let f = 0; f < ${N}; f++) {
        let t0 = performance.now();
        drawScene(ctx, W, H, f, font);
        tDraw.push(performance.now() - t0);
        t0 = performance.now();
        ctx.getImageData(0, 0, W, H);
        tRead.push(performance.now() - t0);
        t0 = performance.now();
        await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.92));
        tJpeg.push(performance.now() - t0);
      }
      return JSON.stringify({draw: med(tDraw), read: med(tRead), jpeg: med(tJpeg), fontOk});
    })()`;
    const o = JSON.parse(await r.sess.evaluate(expr));
    browser = o;
    console.log(`  字体：${o.fontOk ? `${FONT_FAMILY}（同一个文件）` : '★ 未加载成功，文字负载不可比'}`);
    console.log(`  只绘制            ${f2(o.draw)} ms`);
    console.log(`  读回 getImageData  ${f2(o.read)} ms`);
    console.log(`  toBlob('image/jpeg', 0.92)  ${f2(o.jpeg)} ms`);
    console.log(`  端到端（绘制+JPEG）  ${f2(o.draw + o.jpeg)} ms`);
  } finally {
    try { await r.sess.close(); } catch {}
    try { r.server.close(); } catch {}
  }
} catch (e) {
  console.log(`  ✗ 浏览器侧失败：${String(e.message).slice(0, 200)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
if (native && browser) {
  line('═');
  console.log('对比（本地 / 浏览器）');
  line();
  const row = (label, a, b) => {
    const ratio = a > 0 ? b / a : NaN;
    console.log(`  ${label.padEnd(24)} 本地 ${f2(a).padStart(7)}   浏览器 ${f2(b).padStart(7)}   本地/浏览器 ${ratio.toFixed(2)}×`);
  };
  row('只绘制', native.draw, browser.draw);
  row('读回 getImageData', native.read, browser.read);
  row('JPEG 编码', native.jpeg, browser.jpeg);
  row('端到端（绘制+JPEG）', native.draw + native.jpeg, browser.draw + browser.jpeg);
  line();
  const rd = native.draw / browser.draw;
  const re = (native.draw + native.jpeg) / (browser.draw + browser.jpeg);
  console.log('读法：');
  if (rd < 0.8) console.log(`  · 本地**绘制**更快（${rd.toFixed(2)}×）—— 值得往下查。`);
  else if (rd > 1.25) console.log(`  · 本地绘制反而更慢（${rd.toFixed(2)}×）。`);
  else console.log(`  · 绘制量级相当（${rd.toFixed(2)}×）—— 与"两边都是 Skia"的预期一致。`);
  if (re < 0.85) console.log(`  · 端到端本地明显更快（${re.toFixed(2)}×）⇒ 换本地有实质收益，值得立项。`);
  else if (re > 1.15) console.log(`  · 端到端本地更慢（${re.toFixed(2)}×）⇒ 换本地没有收益。`);
  else console.log(`  · 端到端量级相当（${re.toFixed(2)}×）⇒ 换本地的收益不足以抵掉代价。`);
  console.log('  ⚠ 合成场景、非真实模板；且本地是 CPU Skia（浏览器可用 GPU）。');
  line('═');
}
