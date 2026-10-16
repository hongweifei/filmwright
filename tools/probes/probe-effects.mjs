// 效果链的两条路：Canvas 2D `ctx.filter` vs GPU shader。
//
//   node tools/probes/probe-effects.mjs [<仓库根>]
//
// ## 背景（先纠正一个我自己的说法）
//
// 我先前说"Canvas 2D 做不了效果" —— **太绝对**。Canvas 2D 有 `ctx.filter`：
// blur / brightness / contrast / saturate / hue-rotate / drop-shadow / grayscale / sepia …
// 所以真正的问题不是"能不能"，而是：
//   · `ctx.filter` 够快吗？
//   · 它缺什么？（**自定义效果**：位移扭曲、色差、置换、多重叠加…这些表达不出来）
//   · 把合成搬到 GPU 的**上传成本**有多大？
//
// ## 量的四件事
//
//   A. Canvas 2D 只画（基线）
//   B. Canvas 2D 画 + `ctx.filter: blur()`（现成能做到的效果）
//   C. Canvas 2D 画 → 上传纹理 → GPU 两趟可分离高斯模糊 → 读回
//   D. 上传成本本身（画 → texImage2D，不做效果）
//
// A vs B = `ctx.filter` 的效果成本
// C vs D = GPU 效果本身（不含上传）
// D vs A = **上传成本**（"保留 Canvas 2D 绘制、只把合成与效果搬到 GPU"这条路的核心代价）
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const ROOT = (argv[0] && !argv[0].startsWith('--') ? argv[0] : resolve(HERE, '..', '..')).replace(/\\/g, '/');
const P = join(ROOT, 'examples', 'minimal');
const N = 20;

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const f2 = (v) => (v === undefined || v === null ? '—' : Number(v).toFixed(2));
const line = (c = '─') => console.log(c.repeat(78));

/** 页面侧：四种路线的逐帧成本。 */
function pageEffects(args) {
  const W = args.w, H = args.h;
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

  // 画布 1：内容源（模拟一次镜头绘制）
  const src = document.createElement('canvas');
  src.width = W; src.height = H;
  const sx = src.getContext('2d');
  const drawContent = (n) => {
    const bg = sx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#0a0d14'); bg.addColorStop(1, '#141a26');
    sx.filter = 'none';
    sx.globalCompositeOperation = 'source-over';
    sx.fillStyle = bg; sx.fillRect(0, 0, W, H);
    for (let i = 0; i < 3; i++) {
      const x = 90 + i * 380, y = 120 + ((n + i * 7) % 12);
      const g = sx.createLinearGradient(x, y, x + 320, y + 200);
      g.addColorStop(0, 'rgba(90,155,255,0.20)');
      g.addColorStop(1, 'rgba(53,208,127,0.12)');
      sx.fillStyle = g; sx.fillRect(x, y, 320, 200);
    }
    sx.font = `700 34px ${args.font}`;
    sx.textBaseline = 'middle';
    for (let i = 0; i < 10; i++) {
      sx.fillStyle = i % 2 ? '#9fb2d0' : '#e8eefc';
      sx.fillText(`效果链对比 ${i} · frame ${n}`, 70 + (i % 2) * 520, 90 + Math.floor(i / 2) * 74);
    }
  };
  // 输出画布
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const ox = out.getContext('2d');

  // ── A：只画（含把内容贴到输出画布，模拟正常合成）
  const routeA = (n) => {
    drawContent(n);
    ox.filter = 'none';
    ox.clearRect(0, 0, W, H);
    ox.drawImage(src, 0, 0);
  };
  // ── B：+ ctx.filter 模糊（Canvas 2D 现成效果）
  const routeB = (n) => {
    drawContent(n);
    ox.filter = 'blur(12px)';
    ox.clearRect(0, 0, W, H);
    ox.drawImage(src, 0, 0);
    ox.filter = 'none';
  };

  // ── WebGL 侧
  const glc = document.createElement('canvas');
  glc.width = W; glc.height = H;
  const gl = glc.getContext('webgl2') || glc.getContext('webgl');
  let glReady = false, progBlit = null, progBlur = null, fb = [], texSrc = null, noiseTex = null;
  const mkProg = (frag) => {
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, `attribute vec2 p; varying vec2 uv;
      void main(){ uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`);
    gl.compileShader(vs);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, frag); gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) return null;
    const pr = gl.createProgram();
    gl.attachShader(pr, vs); gl.attachShader(pr, fs); gl.linkProgram(pr);
    return gl.getProgramParameter(pr, gl.LINK_STATUS) ? pr : null;
  };
  const mkTarget = (w, h) => {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return {tex, f};
  };
  if (gl) {
    progBlit = mkProg(`precision mediump float; varying vec2 uv; uniform sampler2D t;
      void main(){ gl_FragColor = texture2D(t, uv); }`);
    // 两趟可分离高斯（9 tap 近似）—— 代表"自定义效果"
    progBlur = mkProg(`precision mediump float; varying vec2 uv;
      uniform sampler2D t; uniform vec2 dir; uniform vec2 texel;
      void main(){
        float w[5]; w[0]=0.227027; w[1]=0.194594; w[2]=0.121622; w[3]=0.054054; w[4]=0.016216;
        vec4 c = texture2D(t, uv) * w[0];
        for (int i = 1; i < 5; i++) {
          vec2 o = dir * texel * float(i) * 3.0;
          c += texture2D(t, uv + o) * w[i];
          c += texture2D(t, uv - o) * w[i];
        }
        gl_FragColor = c;
      }`);
    if (progBlit && progBlur) {
      glReady = true;
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      texSrc = gl.createTexture();
      fb = [mkTarget(W, H), mkTarget(W, H)];
      const px = new Uint8Array(1);
      noiseTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, noiseTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
    }
  }
  const upload = () => {
    gl.bindTexture(gl.TEXTURE_2D, texSrc);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  };
  const passTo = (target, prog, setu) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.f : null);
    gl.viewport(0, 0, W, H);
    gl.useProgram(prog);
    if (setu) setu(prog);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  const readback = (target) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.f);
    const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  };
  // ── D：只上传（不效果）→ 读回
  const routeD = (n) => {
    drawContent(n);
    upload();
    passTo(fb[0], progBlit, (p) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texSrc);
      gl.uniform1i(gl.getUniformLocation(p, 't'), 0);
    });
    readback(fb[0]);
  };
  // ── C：上传 + 两趟高斯 + 读回
  const routeC = (n) => {
    drawContent(n);
    upload();
    const texel = [1 / W, 1 / H];
    passTo(fb[0], progBlur, (p) => {
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texSrc);
      gl.uniform1i(gl.getUniformLocation(p, 't'), 0);
      gl.uniform2f(gl.getUniformLocation(p, 'dir'), 1, 0);
      gl.uniform2f(gl.getUniformLocation(p, 'texel'), texel[0], texel[1]);
    });
    passTo(fb[1], progBlur, (p) => {
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, fb[0].tex);
      gl.uniform1i(gl.getUniformLocation(p, 't'), 0);
      gl.uniform2f(gl.getUniformLocation(p, 'dir'), 0, 1);
      gl.uniform2f(gl.getUniformLocation(p, 'texel'), texel[0], texel[1]);
    });
    readback(fb[1]);
  };

  const measure = (fn, extra) => {
    for (let i = 0; i < 3; i++) { fn(i); if (extra) extra(i); }
    const t = [];
    for (let f = 0; f < args.n; f++) {
      const t0 = performance.now();
      fn(f);
      if (extra) extra();
      t.push(performance.now() - t0);
    }
    return med(t);
  };

  const A = measure(routeA, () => ox.getImageData(0, 0, W, H));
  const B = measure(routeB, () => ox.getImageData(0, 0, W, H));
  const D = glReady ? measure(routeD) : null;
  const C = glReady ? measure(routeC) : null;
  const drawOnly = measure((n) => drawContent(n));
  return JSON.stringify({A, B, C, D, drawOnly, glReady, W, H});
}

const imp = (rel) => import(pathToFileURL(`${ROOT}/${rel}`).href);
const {openProjectSession} = await imp('src/host/media/renderRange.mjs');
const {loadProject} = await imp('src/host/project/load.mjs');
const proj = await loadProject(P);

console.log(`效果链两条路的对比：${N} 帧，1280×720\n`);
const r = await openProjectSession(P, proj, {gpu: true, frameSink: {write: async () => {}}});
let o;
try {
  const expr = `(async () => {
    try { const f = new FontFace('FWProbe', 'url(/fonts/NotoSansSC.ttf)');
      await f.load(); document.fonts.add(f); } catch (e) {}
    return (${pageEffects.toString()})(${JSON.stringify({w: 1280, h: 720, n: N, font: 'FWProbe'})});
  })()`;
  o = JSON.parse(await r.sess.evaluate(expr));
} finally {
  try { await r.sess.close(); } catch {}
  try { r.server.close(); } catch {}
}

line('═');
console.log('逐帧成本（ms，含取像素/读回）');
line();
console.log(`  内容绘制本身（不合成不取像素）        ${f2(o.drawOnly)}`);
console.log(`  A. Canvas 2D 合成（无效果）          ${f2(o.A)}`);
console.log(`  B. Canvas 2D ` + '`ctx.filter: blur(12px)`' + `   ${f2(o.B)}`);
if (o.glReady) {
  console.log(`  D. 上传纹理 + GPU 直通 + 读回         ${f2(o.D)}`);
  console.log(`  C. 上传 + GPU 两趟高斯 + 读回         ${f2(o.C)}`);
} else {
  console.log('  WebGL 不可用（本轮未测 C/D）');
}
line('═');
console.log('拆出来的三个关键数：');
if (o.B != null && o.A != null) {
  console.log(`  ① ctx.filter blur 的效果成本 = ${f2(o.B - o.A)} ms（相对基线 ${(( o.B / o.A - 1) * 100).toFixed(0)}%）`);
}
if (o.glReady && o.D != null && o.A != null) {
  console.log(`  ② **上传+读回成本**（D − A）= ${f2(o.D - o.A)} ms ← 「保留 Canvas 2D 绘制、只把合成与效果搬 GPU」这条路的核心代价`);
}
if (o.glReady && o.C != null && o.D != null) {
  console.log(`  ③ GPU 两趟高斯本身（C − D）= ${f2(o.C - o.D)} ms`);
}
if (o.glReady && o.C != null && o.B != null) {
  const win = o.B / o.C;
  console.log('');
  console.log(`  ⇒ 同为"模糊"，Canvas 2D ${f2(o.B)} vs GPU ${f2(o.C)} = **${win.toFixed(2)}×**`);
  console.log(`     （GPU 还顺带能表达 ctx.filter 做不到的：位移扭曲、色差、置换、多重叠加）`);
}
console.log('');
console.log('  ⚠ 合成场景；且 GPU 效果走"上传→效果→读回"，未走"GPU 上直接编码"（那条能省掉读回）。');
line('═');
