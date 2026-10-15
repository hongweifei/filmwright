// GL 舞台：程序/纹理/帧缓冲的分配与复用、各 pass 的执行、`apply()` 的效果链主循环。
// ⚠️ 模块级单例 `STAGE` 与暂存画布**不在这里** —— `applyEffects` 会给 `STAGE` 赋值，
// 而 ESM 的 import 绑定是只读的（`STAGE = …` 会抛 TypeError）⇒ 状态要跟**改它的地方**放在一起。
import {VS, FS_BLUR, FS_COPY, FS_BRIGHT, FS_GLOW_ADD, FS_COLOR, FS_VIGNETTE, FS_CHROMATIC, FS_GRAIN, FS_PIXELATE, FS_RADIAL, FS_DISPLACE, FS_DISTORT, SIMPLE_PASSES} from './shaders.js';
import {blurPlan, pyramidLevel} from './blurPlan.js';


/** 一个可复用的 GPU 阶段实例。尺寸变化时重建缓冲。 */
export class GpuStage {
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
      displace: this._prog(FS_DISPLACE),
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
    /** 金字塔各层的缓冲池（按需建，换分辨率时在 _ensure 里作废）。 */
    this.levels = [];
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

  _target(w = 0, h = 0) {
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
    // 目标要**记住自己的尺寸**：多分辨率的趟要按目标尺寸设 viewport（金字塔用）
    return {tex, fb, w, h};
  }

  /** 给一张离屏缓冲分配存储（尺寸已定）。**不分配的话 FBO 是不完整的、渲染静默失败**。 */
  _alloc(t) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, t.w, t.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    return t;
  }

  /** 尺寸变了就重建离屏纹理（只在第一帧或改分辨率时发生）。 */
  _ensure(w, h) {
    if (this.w === w && this.h === h) return;
    this.canvas.width = w; this.canvas.height = h;
    for (const t of this.targets) {
      t.w = w; t.h = h;
      this._alloc(t);
    }
    // 金字塔各层的尺寸是全尺寸的 1/2^L，所以换分辨率时整批作废（下次用到再建）
    this.levels = [];
    this.w = w; this.h = h;
  }

  /** 取（或建）金字塔第 L 层的缓冲池。每层 3 张：降采样目标 + 两张 ping-pong。 */
  _level(L) {
    const w = Math.max(1, this.w >> L);
    const h = Math.max(1, this.h >> L);
    let lv = this.levels[L];
    if (!lv || lv.w !== w || lv.h !== h) {
      // ⚠️ 建完必须**分配存储**：`_target()` 只建纹理与 FBO，不分配的话
      // 帧缓冲是不完整的 —— WebGL 不会抛错，只是**什么都不画**（全黑）。
      // 实测踩到过：半径 34/80/200 输出完全相同、平均亮度 1.1（几乎全黑）。
      const pool = [this._target(w, h), this._target(w, h), this._target(w, h)].map((t) => this._alloc(t));
      lv = this.levels[L] = {w, h, pool};
    }
    return lv;
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
    // viewport 按**目标自己的尺寸**（金字塔的趟在低分辨率上跑）；画到画布时用全尺寸
    gl.viewport(0, 0, outTarget ? outTarget.w : this.w, outTarget ? outTarget.h : this.h);
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
   *
   * ## 大半径：金字塔（降采样 → 小核 → 升采样）
   *
   * 迭代法的趟数是 O(σ²)：半径 36 已经要 16 趟，半径 200 要几百趟。
   * 而"在低分辨率上做小核"与"在高分辨率上做大核"是等价的（同样的实际半径），
   * 趟数只取决于**降采样后**的半径。所以大半径走金字塔，全分辨率那段保持不变。
   */
  blurTex(inTex, radius, protect) {
    const L = pyramidLevel(radius);
    if (L === 0) return this._blurCore(inTex, radius, this.w, this.h, this.targets, protect);
    const lv = this._level(L);
    const down = lv.pool[0];
    this._pass(this.progs.copy, inTex, down);                 // 双线性降采样
    const small = this._blurCore(down.tex, radius / (1 << L), lv.w, lv.h, lv.pool, [down.tex]);
    const [up] = this._free(protect, 1);                      // 全分辨率的输出目标
    this._pass(this.progs.copy, small.tex, up);               // 双线性升采样
    return up;
  }

  /** 迭代式可分离高斯（在给定的分辨率与缓冲池上跑）。 */
  _blurCore(inTex, radius, w, h, pool, protect = []) {
    const gl = this.gl;
    const {n, s} = blurPlan(radius);
    const free = pool.filter((t) => t.tex !== inTex && !protect.includes(t.tex));
    if (free.length < 2) throw new Error('filmwright: GPU 离屏缓冲不足（这是内部错误）');
    const [a, b] = free;
    const u = (prog, dirX, dirY) => {
      gl.uniform2f(gl.getUniformLocation(prog, 'dir'), dirX, dirY);
      gl.uniform2f(gl.getUniformLocation(prog, 'texel'), s / w, s / h);
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
