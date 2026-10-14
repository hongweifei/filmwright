// GPU 效果阶段：把画好的画布送进 GPU 过效果链，再贴回主画布。
//
// ## 关键实现选择
//
// 1. **不读回像素**：最后一趟直接画到 WebGL 画布的默认帧缓冲，再用
//    `ctx.drawImage(glCanvas, 0, 0)` 贴回。避开 `readPixels` + `putImageData`
//    （GPU→CPU→GPU 往返，最贵的一步）。
// 2. **4 张离屏缓冲复用**，不每帧新建。为什么是 4 张：辉光要"提亮 → 模糊 → 与原图叠加"，
//    而模糊本身要两张 ping-pong —— 叠加时必须还留着原图，所以 2 张不够。
// 3. **预乘 alpha**：上下文用 `premultipliedAlpha: true`、上传时
//    `UNPACK_PREMULTIPLY_ALPHA_WEBGL = true`。模糊与叠加都是线性运算，
//    在预乘空间才正确（直通 alpha 会让透明边缘的 RGB 往外渗）。
//    需要"真实颜色"的效果（调色、辉光阈值）在着色器里反预乘再乘回去。
// 4. **直通值不产生趟**：由调用方按帧判定（`isNoopEffects`），全直通时不进 GPU。
// 5. **同任务内 drawImage**：WebGL 画布的绘制缓冲在合成后会被清空，
//    所以"渲染 + drawImage"必须在同一个同步任务里完成 —— 调用链
//    drawFrame → applyEffects → drawImage 全是同步的。
//    （实测这是 WebGL 画布最容易踩的坑：跨任务读会拿到空白，
//    表现为"效果时有时无"的间歇故障。）
import {compileEffects, evalEffects} from './compile.js';

const VS = `attribute vec2 p; varying vec2 uv;
void main(){ uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;

// 亮度权重（Rec.709）
const LUMA = 'vec3(0.2126, 0.7152, 0.0722)';

/** 预乘 → 直通色；配合 `repromote` 使用。 */
const UNPREMUL = `
vec3 unpremul(vec4 c) { return c.a > 0.001 ? c.rgb / c.a : c.rgb; }
vec4 repremul(vec3 rgb, float a) { return vec4(clamp(rgb, 0.0, 1.0) * a, a); }`;

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

/** 辉光第一步：只留下比阈值亮的部分（在直通色空间算亮度，避免受 alpha 影响）。 */
const FS_BRIGHT = `precision mediump float; varying vec2 uv;
uniform sampler2D t; uniform float threshold;
${UNPREMUL}
void main(){
  vec4 c = texture2D(t, uv);
  vec3 rgb = unpremul(c);
  float lum = dot(rgb, ${LUMA});
  // ⚠️ 不能写 smoothstep(threshold, 1.0, lum)：threshold=1 时 edge0 == edge1，
  // 那是**未定义行为**（实测可能出 NaN，整帧变黑）。用 knee 保证 edge1 > edge0。
  float knee = max(0.001, 1.0 - threshold);
  float k = smoothstep(threshold, threshold + knee, lum);
  gl_FragColor = c * k;              // 预乘空间：整体乘 k 即可
}`;

/** 辉光第三步：把模糊后的光晕**加性**叠回原图。 */
const FS_GLOW_ADD = `precision mediump float; varying vec2 uv;
uniform sampler2D t;    // 原图
uniform sampler2D t2;   // 模糊后的光晕
uniform float intensity;
void main(){
  vec4 base = texture2D(t, uv);
  vec4 glow = texture2D(t2, uv);
  gl_FragColor = vec4(base.rgb + glow.rgb * intensity, clamp(base.a + glow.a * intensity, 0.0, 1.0));
}`;

/**
 * 调色。顺序按设计：曝光 → 亮度 → 对比 → 饱和 → 色相 → 色温。
 * 色相旋转用 CSS `hue-rotate` 的同一组系数（标准、可核对），不用自创矩阵。
 */
const FS_COLOR = `precision mediump float; varying vec2 uv;
uniform sampler2D t;
uniform float exposure, brightness, contrast, saturation, hue, temperature;
${UNPREMUL}
vec3 hueRotate(vec3 c, float deg) {
  float a = radians(deg);
  float cs = cos(a), sn = sin(a);
  float r = (0.213 + cs*0.787 - sn*0.213) * c.r
          + (0.715 - cs*0.715 - sn*0.715) * c.g
          + (0.072 - cs*0.072 + sn*0.928) * c.b;
  float g = (0.213 - cs*0.213 + sn*0.143) * c.r
          + (0.715 + cs*0.285 + sn*0.140) * c.g
          + (0.072 - cs*0.072 - sn*0.283) * c.b;
  float b = (0.213 - cs*0.213 - sn*0.787) * c.r
          + (0.715 - cs*0.715 + sn*0.715) * c.g
          + (0.072 + cs*0.928 + sn*0.072) * c.b;
  return vec3(r, g, b);
}
void main(){
  vec4 src = texture2D(t, uv);
  vec3 c = unpremul(src);
  c *= pow(2.0, exposure);                       // 曝光（EV）
  c *= brightness;
  c = (c - 0.5) * contrast + 0.5;                // 围绕中灰
  float lum = dot(clamp(c, 0.0, 1.0), ${LUMA});
  c = mix(vec3(lum), c, saturation);
  if (abs(hue) > 0.001) c = hueRotate(c, hue);
  float warm = temperature * 0.15;                // 正=暖（加红减蓝）
  c.r += warm; c.b -= warm;
  gl_FragColor = repremul(c, src.a);
}`;

/** 暗角：以中心为原点径向压暗。amount=0 时由调用方短路，不会进这里。 */
const FS_VIGNETTE = `precision mediump float; varying vec2 uv;
uniform sampler2D t; uniform float amount, radius, softness;
void main(){
  vec4 src = texture2D(t, uv);
  vec2 p = (uv - 0.5) * 2.0;
  float d = length(p);
  // smoothstep 要求 edge0 < edge1，所以写成"1 减去从 [r-soft, r] 的上升"
  float v = 1.0 - smoothstep(max(radius - softness, 0.0), radius, d);
  gl_FragColor = vec4(src.rgb * mix(1.0, v, amount), src.a);
}`;

/**
 * 色差：红/蓝沿一个方向分开，**越靠边分得越开**（中心干净才像真镜头）。
 *
 * ⚠️ 尺寸用**两个 float**（texelX/texelY）而不是 `vec2 texel` —— 调度表统一按
 * `uniform1f` 逐个传，声明成 vec2 会让 `getUniformLocation('texelX')` 返回 null，
 * 于是 texel 永远是 0、除以 0 变 inf、整幅 NaN（实测踩到过：效果"什么都不做"）。
 */
const FS_CHROMATIC = `precision mediump float; varying vec2 uv;
uniform sampler2D t; uniform float amount, angle, texelX, texelY;
void main(){
  vec2 dir = vec2(cos(radians(angle)), sin(radians(angle)));
  vec2 p = uv - 0.5;
  float d = length(p) * 2.0;                    // 0=中心，≈1.41=四角
  vec2 off = dir * vec2(texelX, texelY) * amount * d;
  vec4 c = texture2D(t, uv);
  float r = texture2D(t, uv + off).r;
  float b = texture2D(t, uv - off).b;
  gl_FragColor = vec4(r, c.g, b, c.a);
}`;

/**
 * 胶片颗粒。
 *
 * ⚠️ 噪点必须是 **(像素, 帧号) 的纯函数** —— 用 `hash(格子 + 帧号)`，
 * **绝不读时钟**。读时钟会让同一帧两次渲染不同，直接破坏"第 N 帧只是 N 的函数"
 * （分片/跳帧/增量复用全崩）。这也让"同一帧永远同一张颗粒"成为可验收的性质。
 */
const FS_GRAIN = `precision mediump float; varying vec2 uv;
uniform sampler2D t; uniform float amount, size, seed, texelX, texelY;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main(){
  vec4 c = texture2D(t, uv);
  vec2 cell = floor(uv / (vec2(texelX, texelY) * size));
  float n = hash(cell + vec2(seed * 17.13, seed * 7.71));
  float d = (n - 0.5) * 2.0 * amount;
  gl_FragColor = vec4(clamp(c.rgb + d * c.a, 0.0, 1.0), c.a);
}`;

/** 马赛克：整块取色（取块中心，避免偏移半格）。 */
const FS_PIXELATE = `precision mediump float; varying vec2 uv;
uniform sampler2D t; uniform float size, texelX, texelY;
void main(){
  vec2 cell = floor(uv / (vec2(texelX, texelY) * size));
  vec2 p = (cell + 0.5) * vec2(texelX, texelY) * size;
  gl_FragColor = texture2D(t, clamp(p, vec2(0.0), vec2(1.0)));
}`;

/**
 * 径向（缩放）模糊：沿"从中心往外"的方向拖尾。
 *
 * 固定 8 个采样点：**GLSL ES 1.0 要求循环边界是常量**，
 * 所以采样数不做成参数（动态边界在 WebGL1 上不可移植）。
 */
const FS_RADIAL = `precision mediump float; varying vec2 uv;
uniform sampler2D t; uniform float amount; uniform vec2 center;
void main(){
  vec2 dir = uv - center;
  vec4 sum = vec4(0.0);
  for (int i = 0; i < 8; i++) {
    float k = float(i) / 7.0;
    sum += texture2D(t, clamp(uv - dir * amount * k, vec2(0.0), vec2(1.0)));
  }
  gl_FragColor = sum / 8.0;
}`;

/** 波状扭曲：用正弦把采样位置推开。phase 让波纹平移（仍与时间无关）。 */
const FS_DISTORT = `precision mediump float; varying vec2 uv;
uniform sampler2D t; uniform float amount, frequency, phase;
void main(){
  float ph = radians(phase);
  vec2 p = uv;
  p.x += sin(uv.y * frequency * 6.28318 + ph) * amount * 0.05;
  p.y += cos(uv.x * frequency * 6.28318 + ph) * amount * 0.05;
  gl_FragColor = texture2D(t, clamp(p, vec2(0.0), vec2(1.0)));
}`;

/**
 * **单趟效果**的调度表：program 名 + 要传的 uniform 名。
 *
 * 加一个"一趟就够"的效果只需要在这里加一条 + 写一个 FS_* —— 不再往
 * apply() 的 if/else 链里塞分支（那条链越长越容易漏传 uniform）。
 * 需要多趟的（blur/glow）仍在 apply() 里单独处理。
 */
const SIMPLE_PASSES = {
  color: {prog: 'color', uniforms: ['exposure', 'brightness', 'contrast', 'saturation', 'hue', 'temperature']},
  vignette: {prog: 'vignette', uniforms: ['amount', 'radius', 'softness']},
  chromatic: {prog: 'chromatic', uniforms: ['amount', 'angle', 'texelX', 'texelY']},
  grain: {prog: 'grain', uniforms: ['amount', 'size', 'seed', 'texelX', 'texelY']},
  pixelate: {prog: 'pixelate', uniforms: ['size', 'texelX', 'texelY']},
  radialBlur: {prog: 'radialBlur', uniforms: ['amount', 'centerX', 'centerY']},
  distort: {prog: 'distort', uniforms: ['amount', 'frequency', 'phase']},
};

/** 模糊的趟数与抽头间距。抽头间距 ≤2px 是"采样充分"的保证（见 blurTex 注释）。 */
function blurPlan(radius) {
  const sigmaTotal = Math.max(radius, 0) / 3;
  const SIGMA_PER_PASS = 3;   // 间距 = 3s，要 ≤2px ⇒ s ≤ 2/3 ⇒ σ ≤ 4.5·(2/3) = 3
  const n = Math.max(1, Math.min(16, Math.ceil((sigmaTotal / SIGMA_PER_PASS) ** 2)));
  return {n, s: (sigmaTotal / Math.sqrt(n)) / 4.5};
}

/** 一个可复用的 GPU 阶段实例。尺寸变化时重建缓冲。 */
class GpuStage {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.gl = this.canvas.getContext('webgl', {premultipliedAlpha: true, alpha: true,
      preserveDrawingBuffer: false});
    this.w = 0;
    this.h = 0;
    this.ok = !!this.gl;
    if (!this.ok) return;
    const gl = this.gl;
    this.progs = {
      blur: this._prog(FS_BLUR),
      copy: this._prog(FS_COPY),
      bright: this._prog(FS_BRIGHT),
      glowAdd: this._prog(FS_GLOW_ADD),
      color: this._prog(FS_COLOR),
      vignette: this._prog(FS_VIGNETTE),
      chromatic: this._prog(FS_CHROMATIC),
      grain: this._prog(FS_GRAIN),
      pixelate: this._prog(FS_PIXELATE),
      radialBlur: this._prog(FS_RADIAL),
      distort: this._prog(FS_DISTORT),
    };
    this.ok = Object.values(this.progs).every(Boolean);
    if (!this.ok) return;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.srcTex = gl.createTexture();
    this.targets = [this._target(), this._target(), this._target(), this._target()];
  }

  _prog(fsSrc) {
    const gl = this.gl;
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, VS); gl.compileShader(vs);
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

  /** 把画布传到 srcTex（预乘 + **翻 Y**）。 */
  _upload(canvas) {
    const gl = this.gl;
    // ⚠️ UNPACK_FLIP_Y_WEBGL 必须开：
    // `texImage2D(canvas)` 默认把画布的**第一行（顶）**放在 v=0，而 GL 的裁剪空间 y 朝上
    // —— 两者相反，结果整帧**上下翻转**。翻转后"模糊还是模糊"，所以边缘能量、
    // 端点一致性这些判据全都照样通过，**只有看图才发现**（踩过）。
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return this.srcTex;
  }

  _pass(prog, inTex, outTarget, setu, inTex2) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, outTarget ? outTarget.fb : null);
    gl.viewport(0, 0, this.w, this.h);
    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inTex);
    gl.uniform1i(gl.getUniformLocation(prog, 't'), 0);
    if (inTex2) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, inTex2);
      gl.uniform1i(gl.getUniformLocation(prog, 't2'), 1);
    }
    if (setu) setu(prog);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** 取 n 张不与 `protect` 中任何纹理相同的离屏缓冲。 */
  _free(protect, n) {
    const out = this.targets.filter((t) => !protect.includes(t.tex));
    if (out.length < n) throw new Error('filmwright: GPU 离屏缓冲不足（这是内部错误）');
    return out.slice(0, n);
  }

  /**
   * 可分离高斯，纹理进、纹理出。返回结果所在的离屏缓冲。
   *
   * ## 为什么要迭代而不是加大抽头间距
   *
   * 第一版把半径直接映射成抽头间距，结果**大半径下模糊反而更"锐"**
   * （实测边缘能量 1.62 → 1.32 → 1.39，半径 24 处回升）：
   * 9 个抽头被摊到很宽的跨度上成了**稀疏采样**，出现振铃。
   *
   * 修法：**保持抽头间距 ≤2px（采样充分），用多趟迭代逼近大半径**。
   * 高斯可组合：σ_total² = Σσ_i²，所以 N 趟、每趟 σ_total/√N 等价。
   */
  blurTex(inTex, radius, protect) {
    const gl = this.gl;
    const {n, s} = blurPlan(radius);
    const [a, b] = this._free([...protect, inTex], 2);
    const u = (prog, dirX, dirY) => {
      gl.uniform2f(gl.getUniformLocation(prog, 'dir'), dirX, dirY);
      gl.uniform2f(gl.getUniformLocation(prog, 'texel'), s / this.w, s / this.h);
    };
    let src = inTex;
    for (let i = 0; i < n; i++) {
      this._pass(this.progs.blur, src, a, (p) => u(p, 1, 0));
      this._pass(this.progs.blur, a.tex, b, (p) => u(p, 0, 1));
      src = b.tex;
    }
    return b;
  }

  /** 走完一整条效果链，返回画布（结果已在默认帧缓冲上）。 */
  apply(srcCanvas, steps, n) {
    const gl = this.gl;
    const w = srcCanvas.width, h = srcCanvas.height;
    this._ensure(w, h);
    let curTex = this._upload(srcCanvas);
    let curTarget = null;
    let touched = false;

    for (const step of steps) {
      const u1 = (name, v) => (p) => gl.uniform1f(gl.getUniformLocation(p, name), v);
      if (step.type === 'blur' && step.radius > 0) {
        curTarget = this.blurTex(curTex, step.radius, curTarget ? [curTarget.tex] : []);
        curTex = curTarget.tex;
        touched = true;
      } else if (step.type === 'glow' && step.intensity > 0 && step.radius > 0) {
        // 提亮 → 模糊 → 加性叠加。叠加要读**原图**，所以它全程不能被覆盖。
        // ⚠️ 输出目标必须在**模糊之后**再取：模糊自己要用两张 ping-pong，
        // 提前取好的目标可能被它借走（第一版就是这么错的）。
        const protect0 = [curTex];
        const [ak] = this._free(protect0, 1);
        this._pass(this.progs.bright, curTex, ak, u1('threshold', step.threshold));
        const blurT = this.blurTex(ak.tex, step.radius, [...protect0, ak.tex]);
        const [out] = this._free([...protect0, blurT.tex], 1);
        this._pass(this.progs.glowAdd, curTex, out, u1('intensity', step.intensity), blurT.tex);
        curTarget = out; curTex = out.tex;
        touched = true;
      } else {
        // 单趟效果：表驱动（见 SIMPLE_PASSES）。texelX/texelY 与 seed 由这里补上。
        const spec = SIMPLE_PASSES[step.type];
        if (!spec) continue;
        const [out] = this._free([curTex], 1);
        const vals = {...step, texelX: 1 / w, texelY: 1 / h, seed: n ?? 0};
        this._pass(this.progs[spec.prog], curTex, out, (p) => {
          for (const k of spec.uniforms) gl.uniform1f(gl.getUniformLocation(p, k), vals[k]);
        });
        curTarget = out; curTex = out.tex;
        touched = true;
      }
    }
    if (!touched) return null;
    // 最终一趟：复制到默认帧缓冲（画布）
    this._pass(this.progs.copy, curTex, null);
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
  return STAGE.apply(srcCanvas, evalEffects(compiled, n), n);
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
