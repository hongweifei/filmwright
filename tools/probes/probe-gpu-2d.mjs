// 「全都用 3D 画 2D」值不值：把「光栅化」与「合成」分开量。
//
//   node tools/probes/probe-gpu-2d.mjs [<仓库根>]
//
// ## 要回答什么
//
// "用 3D（WebGL）画所有 2D 内容，是不是更快？"
//
// 这在技术上完全成立 —— 所有 GPU UI 渲染器都是"朝向相机的四边形 + 纹理"。
// 问题不是能不能，而是**能省下哪一段**。逐帧剖析已测出：
//   · 绘制命令 0.4ms（只是记录，无所谓）
//   · 光栅化/合成 5–15ms  ← GPU 的强项（满屏填充实测快 15×）
//   · 编码 7–17ms         ← 省不掉（软硬编码实测同样快）
//
// 但**文字是这条路的坎**：Canvas 2D 的中文排版是白送的，GPU 渲染器要用
// 字形图集/SDF，而那是 CPU 光栅化（只是搬到缓存）。所以本探针把三件事分开量：
//
//   A. Canvas 2D 逐行 fillText（**含文字光栅化**，刷新字符串）
//   B. Canvas 2D 贴同一个缓存纹理（等价于"文字已缓存"，只量合成）
//   C. WebGL 贴同一个缓存纹理（**只量 GPU 合成**）
//
// A vs B = **文字光栅化的代价**（GPU 方案若用图集，这笔要单独付）
// B vs C = **GPU 合成相对 CPU 合成的收益**（这才是"用 3D 画 2D"的真正收益）
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const ROOT = (argv[0] && !argv[0].startsWith('--') ? argv[0] : resolve(HERE, '..', '..')).replace(/\\/g, '/');
const P = join(ROOT, 'examples', 'minimal');
const N = 24;

const imp = (rel) => import(pathToFileURL(`${ROOT}/${rel}`).href);
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const f2 = (v) => (v === undefined || v === null ? '—' : Number(v).toFixed(2));
const line = (c = '─') => console.log(c.repeat(78));

/** 页面侧：三种画法各量「只画」与「画+取像素」。 */
function pageCompare(args) {
  const c = document.querySelector('canvas');
  const W = c.width, H = c.height;
  const ctx = c.getContext('2d');
  const font = args.font;
  const LINES = args.lines;
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

  // 造一份"缓存纹理"：一段文字块（模拟字形图集里的一段）
  const tc = document.createElement('canvas');
  tc.width = 1024; tc.height = 48;
  const tx = tc.getContext('2d');
  tx.fillStyle = '#e8eefc';
  tx.font = `700 30px ${font}`;
  tx.textBaseline = 'middle';
  tx.fillText('第 12 行 · Panel 3 — 渲染性能对比 456', 4, 24);

  const drawText = (n) => {
    ctx.fillStyle = '#0a0d14';
    ctx.fillRect(0, 0, W, H);
    ctx.textBaseline = 'middle';
    for (let i = 0; i < LINES; i++) {
      ctx.font = `${i % 5 === 0 ? '700 ' : ''}${[46, 30, 22, 17][i % 4]}px ${font}`;
      ctx.fillStyle = i % 3 === 0 ? '#e8eefc' : '#9fb2d0';
      ctx.fillText(`第 ${i + 1} 行 · Panel ${n} — 渲染性能对比 ${(i * 37 + n) % 1000}`,
        70 + (i % 2) * 520, 40 + Math.floor(i / 2) * 62);
    }
  };
  const drawBlit = (n) => {
    ctx.fillStyle = '#0a0d14';
    ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < LINES; i++) {
      ctx.drawImage(tc, 70 + (i % 2) * 520, 24 + Math.floor(i / 2) * 62, 1024, 48);
    }
  };

  // WebGL：把同一份纹理当四边形贴上去
  const glc = document.createElement('canvas');
  glc.width = W; glc.height = H;
  const gl = glc.getContext('webgl2') || glc.getContext('webgl');
  let glReady = false;
  if (gl) {
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, `attribute vec2 p; attribute vec2 uv; varying vec2 vUv;
      void main(){ vUv = uv; gl_Position = vec4(p, 0.0, 1.0); }`);
    gl.compileShader(vs);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, `precision mediump float; varying vec2 vUv; uniform sampler2D tex;
      void main(){ gl_FragColor = texture2D(tex, vUv); }`);
    gl.compileShader(fs);
    const pr = gl.createProgram();
    gl.attachShader(pr, vs); gl.attachShader(pr, fs); gl.linkProgram(pr);
    glReady = !!gl.getProgramParameter(pr, gl.LINK_STATUS);
    if (glReady) {
      gl.useProgram(pr);
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tc);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.uniform1i(gl.getUniformLocation(pr, 'tex'), 0);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    }
  }
  const drawGL = (n) => {
    if (!glReady) return;
    gl.viewport(0, 0, W, H);
    gl.clearColor(0.04, 0.05, 0.08, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    for (let i = 0; i < LINES; i++) {
      // 把像素坐标换算成 NDC
      const x = 70 + (i % 2) * 520, y = 24 + Math.floor(i / 2) * 62, w = 1024, h = 48;
      const x0 = x / W * 2 - 1, y0 = 1 - y / H * 2;
      const x1 = (x + w) / W * 2 - 1, y1 = 1 - (y + h) / H * 2;
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        x0, y0, 0, 0, x1, y0, 1, 0, x0, y1, 0, 1,
        x1, y0, 1, 0, x1, y1, 1, 1, x0, y1, 0, 1,
      ]), gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
  };
  const readGL = () => {
    if (!glReady) return;
    const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  };

  const warm = (fn) => { for (let i = 0; i < 4; i++) fn(i); };
  warm(drawText); warm(drawBlit); if (glReady) warm(drawGL);

  const meas = (draw, flush) => {
    const tDraw = [], tTotal = [];
    for (let f = 0; f < args.n; f++) {
      let t0 = performance.now();
      draw(f);
      tDraw.push(performance.now() - t0);
      if (flush) { t0 = performance.now(); flush(); tTotal.push(performance.now() - t0); }
    }
    return {draw: med(tDraw), flush: tTotal.length ? med(tTotal) : 0};
  };

  const A = meas(drawText, () => ctx.getImageData(0, 0, W, H));
  const B = meas(drawBlit, () => ctx.getImageData(0, 0, W, H));
  const C = glReady ? meas(drawGL, readGL) : null;
  return JSON.stringify({A, B, C, glReady, lines: LINES, W, H});
}

const imp2 = (rel) => import(pathToFileURL(`${ROOT}/${rel}`).href);
const {openProjectSession} = await imp2('src/host/media/renderRange.mjs');
const {loadProject} = await imp2('src/host/project/load.mjs');
const proj = await loadProject(P);

console.log(`「用 3D 画 2D」拆解测量：${N} 帧，${P}\n`);
const sink = {write: async () => {}};
const r = await openProjectSession(P, proj, {gpu: true, frameSink: sink});   // 用 GPU 档，否则 WebGL 是软件
let o;
try {
  // 用库自带字体（与渲染一致）。走 `/fonts/` 路由：项目里没有就兜到库根那份 ——
  // 别写成 `/proj/public/fonts/...`，那条绕过兜底，字体搬走后会静默 404 成回退字体。
  const expr = `(async () => {
    try {
      const face = new FontFace('FWProbe', 'url(/fonts/NotoSansSC.ttf)');
      await face.load(); document.fonts.add(face);
    } catch (e) {}
    const pageCompare = ${pageCompare.toString()};
    return pageCompare(${JSON.stringify({font: 'FWProbe', lines: 28, n: N})});
  })()`;
  o = JSON.parse(await r.sess.evaluate(expr));
} finally {
  try { await r.sess.close(); } catch {}
  try { r.server.close(); } catch {}
}

line('═');
console.log(`画 ${o.lines} 行内容（${o.W}×${o.H}），单位 ms/帧`);
line();
const row = (label, x) => {
  if (!x) { console.log(`  ${label.padEnd(34)} 不可用`); return; }
  console.log(`  ${label.padEnd(34)} 只画 ${f2(x.draw).padStart(6)}   取像素 ${f2(x.flush).padStart(6)}   合计 ${f2(x.draw + x.flush).padStart(6)}`);
};
row('A. Canvas 2D fillText（含文字光栅化）', o.A);
row('B. Canvas 2D 贴缓存纹理', o.B);
row('C. WebGL 贴缓存纹理（GPU 合成）', o.C);
line('═');
console.log('拆出来的两个数：');
if (o.A && o.B) {
  const t = (o.A.draw + o.A.flush) - (o.B.draw + o.B.flush);
  console.log(`  ① 文字光栅化的代价（A − B）= **${f2(t)} ms/帧**`);
  console.log('     ⇒ GPU 方案若用字形图集，这笔钱**不是消失，而是搬到缓存**；');
  console.log('       字符串每镜头都变 ⇒ 命中只能靠"字形"级缓存（SDF 图集），而中文正是它最难的地方。');
}
if (o.B && o.C) {
  const t2 = (o.C.draw + o.C.flush) - (o.B.draw + o.B.flush);
  const ratio = (o.B.draw + o.B.flush) / (o.C.draw + o.C.flush);
  console.log(`  ② GPU 合成的收益（C vs B）= **${f2(-t2)} ms/帧（${ratio.toFixed(2)}×）**`);
  if (ratio > 1.5) console.log('     ⇒ 合成这一段 GPU 确实明显更快 —— "用 3D 画 2D"的收益是真的。');
  else console.log('     ⇒ 合成这一段收益不明显 —— GPU 不是免费的。');
}
console.log('');
console.log('  ⚠ 这是**合成场景**，且 C 用预烘纹理（等于假设图集已缓存）。');
console.log('    真实模板还要处理：字形图集生成、字号多样性、阴影/渐变/混合模式的 shader 化、');
console.log('    以及像素基线全废（实测放开 GPU 会让 67.66% 像素变化）。');
line('═');
