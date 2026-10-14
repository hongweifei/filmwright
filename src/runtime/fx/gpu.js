// GPU 效果阶段（最小闭环：只有 blur）。
//
// 这一版刻意只做**一条路**，目的是证明
// 「Canvas 2D 画 → 上传纹理 → GPU 效果 → 画回」这条链在真实渲染里通，并量出
// 端到端代价 —— 而不是先把 11 个效果铺开。
//
// ## 关键实现选择
//
// 1. **不读回像素**。两趟高斯之后把最后一趟直接画到 WebGL 画布的默认帧缓冲上，
//    再用 `ctx.drawImage(glCanvas, 0, 0)` 贴回主画布。这样避免了
//    `readPixels` + `putImageData`（那是 GPU→CPU→GPU 的往返，最贵的一步）。
// 2. **离屏缓冲复用**（两张 ping-pong 纹理），不每帧新建。
// 3. **radius=0 短路**：不产生任何趟，直接返回 null，让调用方走原路。
// 4. **同任务内 drawImage**。WebGL 画布的绘制缓冲在合成后会被清空，
//    所以"渲染 + drawImage"必须在同一个同步任务里完成 —— 这里的调用链是
//    drawFrame → applyEffects → drawImage，全是同步的。
//    （实测这是 WebGL 画布最容易踩的坑：跨任务读会拿到空白，
//    表现为"效果时有时无"的间歇故障。）
import {compileEffects, evalEffects} from './compile.js';

const VS = `attribute vec2 p; varying vec2 uv;
void main(){ uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;

// 9 tap 近似高斯，权重和为 1（避免整体亮度漂移）
const FS_BLUR = `precision mediump float; varying vec2 uv;
uniform sampler2D t; uniform vec2 dir; uniform vec2 texel;
void main(){
  float w[5];
  w[0]=0.227027; w[1]=0.194594; w[2]=0.121622; w[3]=0.054054; w[4]=0.016216;
  vec4 c = texture2D(t, uv) * w[0];
  for (int i = 1; i < 5; i++) {
    vec2 o = dir * texel * float(i) * 3.0;
    c += texture2D(t, uv + o) * w[i];
    c += texture2D(t, uv - o) * w[i];
  }
  gl_FragColor = c;
}`;

const FS_COPY = `precision mediump float; varying vec2 uv; uniform sampler2D t;
void main(){ gl_FragColor = texture2D(t, uv); }`;

/** 一个可复用的 GPU 阶段实例。尺寸变化时重建缓冲。 */
class GpuStage {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.gl = this.canvas.getContext('webgl', {premultipliedAlpha: false, alpha: true});
    this.w = 0;
    this.h = 0;
    this.ok = !!this.gl;
    if (!this.ok) return;
    const gl = this.gl;
    this.progBlur = this._prog(VS, FS_BLUR);
    this.progCopy = this._prog(VS, FS_COPY);
    this.ok = !!this.progBlur && !!this.progCopy;
    if (!this.ok) return;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.srcTex = gl.createTexture();
    this.targets = [this._target(), this._target()];
  }

  _prog(vsSrc, fsSrc) {
    const gl = this.gl;
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, vsSrc); gl.compileShader(vs);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, fsSrc); gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) return null;
    const p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
    return gl.getProgramParameter(p, gl.LINK_STATUS) ? p : null;
  }

  _target() {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return {tex, fb};
  }

  /** 尺寸变了就重建离屏纹理（只在第一帧或改分辨率时发生）。 */
  _ensure(w, h) {
    if (this.w === w && this.h === h) return;
    const gl = this.gl;
    this.canvas.width = w; this.canvas.height = h;
    for (const t of this.targets) {
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    this.w = w; this.h = h;
  }

  _pass(prog, outTarget, inTex, setUniforms) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, outTarget ? outTarget.fb : null);
    gl.viewport(0, 0, this.w, this.h);
    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inTex);
    gl.uniform1i(gl.getUniformLocation(prog, 't'), 0);
    if (setUniforms) setUniforms(prog);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /**
   * 对 `srcCanvas` 应用模糊，返回**已画好结果的 canvas**（就是 WebGL 画布本身）。
   * 调用方必须**在同一个同步任务里**立刻 drawImage 它。
   *
   * ## 为什么要迭代而不是加大抽头间距
   *
   * 第一版把半径直接映射成抽头间距，结果**大半径下模糊反而更"锐"**
   * （实测边缘能量 1.62 → 1.32 → 1.39，半径 24 处回升）。
   * 原因是 9 个抽头被摊到很宽的跨度上 —— 抽头间距 8px 时核成了**稀疏采样**，
   * 出现振铃，高频不降反升。
   *
   * 修法：**保持抽头间距 ≤2px（采样充分），用多趟迭代逼近大半径**。
   * 高斯可组合：σ_total² = Σσ_i²，所以 N 趟、每趟 σ_total/√N 等价。
   * 趟数按 `(radius/9)²` 估（σ 与半径按 radius/3 换算）。
   *
   * 契约把 radius 上限定在 **36**，正是"16 趟、间距 ≤2px"能保证正确的范围；
   * 更大的半径要靠**金字塔**（降采样 → 小核模糊 → 升采样），那是下一步。
   */
  blur(srcCanvas, radius) {
    const gl = this.gl;
    const w = srcCanvas.width, h = srcCanvas.height;
    this._ensure(w, h);
    // 上传
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, srcCanvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const sigmaTotal = Math.max(radius, 0) / 3;
    // 每趟的 σ 上限：抽头间距 = 3s，要让间距 ≤2px ⇒ s ≤ 2/3 ⇒ σ ≤ 4.5·(2/3) = 3
    const SIGMA_PER_PASS = 3;
    const n = Math.max(1, Math.min(16, Math.ceil((sigmaTotal / SIGMA_PER_PASS) ** 2)));
    const sigmaPass = sigmaTotal / Math.sqrt(n);
    const s = sigmaPass / 4.5;                 // 核的抽头间距（像素）

    const texelX = 1 / w, texelY = 1 / h;
    const pass = (outTarget, inTex, dirX, dirY) => {
      this._pass(this.progBlur, outTarget, inTex, (p) => {
        gl.uniform2f(gl.getUniformLocation(p, 'dir'), dirX, dirY);
        gl.uniform2f(gl.getUniformLocation(p, 'texel'), texelX * s, texelY * s);
      });
    };
    // 逐趟：水平 → 离屏 0，垂直 → 离屏 1（最后一趟垂直直接画到默认帧缓冲）
    let src = this.srcTex;
    for (let i = 0; i < n; i++) {
      const last = i === n - 1;
      pass(this.targets[0], src, 1, 0);
      pass(last ? null : this.targets[1], this.targets[0].tex, 0, 1);
      src = this.targets[1].tex;
    }
    return this.canvas;
  }
}

let STAGE = null;

/** 主画布尺寸（用于建离屏缓冲）。 */
let scratchCanvas = null;
function getScratch(w, h) {
  if (!scratchCanvas) scratchCanvas = document.createElement('canvas');
  if (scratchCanvas.width !== w || scratchCanvas.height !== h) {
    scratchCanvas.width = w; scratchCanvas.height = h;
  }
  return scratchCanvas;
}

/**
 * 对一个已经画好的画布应用效果链，**返回结果画布**（不自己往主画布上画）。
 *
 * 为什么返回而不是自己画：合成方式与透明度该由调用方决定
 * （转场淡入要乘 alpha；合成要用 source-over 以保留引擎已画的背景）。
 *
 * ⚠️ 调用方必须**在同一个同步任务里**立刻 drawImage 结果 ——
 * WebGL 画布的绘制缓冲在合成后会被清空。
 *
 * @param {HTMLCanvasElement} srcCanvas 已经把镜头画好的画布
 * @param {object} compiled             compileEffects 的结果
 * @param {number} n                    当前帧号（效果参数可以是关键帧轨道）
 * @returns {HTMLCanvasElement|null}    结果画布；全短路时返回 null（调用方走原路）
 */
export function applyEffects(srcCanvas, compiled, n) {
  if (!compiled || !compiled.steps.length) return null;
  if (!STAGE) STAGE = new GpuStage();
  if (!STAGE.ok) {
    // 没有 WebGL 就如实报错，不要静默跳过（静默跳过会让人以为效果生效了）
    throw new Error('filmwright: 这个环境拿不到 WebGL，无法应用 effects');
  }
  let out = srcCanvas;
  let applied = false;
  for (const step of evalEffects(compiled, n)) {
    if (step.type === 'blur') {
      if (!(step.radius > 0)) continue;          // **短路**：radius=0 直通，不产生趟
      out = STAGE.blur(out, step.radius);
      applied = true;
    }
  }
  return applied ? out : null;
}

/**
 * 「把内容画进离屏画布 → 过效果 → 贴回主画布」的共用流程。
 *
 * 镜头级与层级都走这一个函数，避免两处各写一遍合成逻辑（那会漂移）。
 *
 * @param {CanvasRenderingContext2D} ctx   目标上下文
 * @param {object} fx                      compileEffects 的结果
 * @param {number} alpha                   整体透明度
 * @param {number} n                       当前帧号
 * @param {(ctx: CanvasRenderingContext2D) => void} drawInto 把内容画到给定上下文
 * @returns {boolean} 是否走了效果路径（false ⇒ 调用方应走原路）
 */
export function paintWithEffects(ctx, fx, alpha, n, drawInto) {
  const w = ctx.canvas.width, h = ctx.canvas.height;
  const sc = getScratch(w, h);
  const sctx = sc.getContext('2d');
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.clearRect(0, 0, w, h);
  drawInto(sctx);
  const res = applyEffects(sc, fx, n);
  if (!res) return false;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (alpha < 1) ctx.globalAlpha = alpha;
  // source-over：结果带 alpha（内容没画到的地方透明），正常合成才不抹掉背景
  ctx.drawImage(res, 0, 0);
  ctx.restore();
  return true;
}

export {getScratch};
