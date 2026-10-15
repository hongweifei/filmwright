// 15 段 GLSL 与「简单效果 → 程序名 + uniform」的映射表。**纯字符串，零 GL 依赖** ——
// 单独一个文件是刻意的：它占了原 gpu.js 的 38%，而读代码的人几乎从不需要读它。


export const VS = `attribute vec2 p; varying vec2 uv;
void main(){ uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;


// 亮度权重（Rec.709）
const LUMA = 'vec3(0.2126, 0.7152, 0.0722)';


/** 预乘 → 直通色；配合 `repromote` 使用。 */
const UNPREMUL = `
vec3 unpremul(vec4 c) { return c.a > 0.001 ? c.rgb / c.a : c.rgb; }
vec4 repremul(vec3 rgb, float a) { return vec4(clamp(rgb, 0.0, 1.0) * a, a); }`;


// 9 tap 近似高斯，权重和为 1（避免整体亮度漂移）
export const FS_BLUR = `precision mediump float; varying vec2 uv;
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


export const FS_COPY = `precision mediump float; varying vec2 uv; uniform sampler2D t;
void main(){ gl_FragColor = texture2D(t, uv); }`;


/** 辉光第一步：只留下比阈值亮的部分（在直通色空间算亮度，避免受 alpha 影响）。 */
export const FS_BRIGHT = `precision mediump float; varying vec2 uv;
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
export const FS_GLOW_ADD = `precision mediump float; varying vec2 uv;
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
export const FS_COLOR = `precision mediump float; varying vec2 uv;
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
export const FS_VIGNETTE = `precision mediump float; varying vec2 uv;
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
export const FS_CHROMATIC = `precision mediump float; varying vec2 uv;
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
export const FS_GRAIN = `precision mediump float; varying vec2 uv;
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
export const FS_PIXELATE = `precision mediump float; varying vec2 uv;
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
export const FS_RADIAL = `precision mediump float; varying vec2 uv;
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


/** `displace`：程序化值噪声置换采样位置（热浪 / 水汽 / 有机抖动）。
 *
 * 与 `distort` 的区别：`distort` 是**正弦**（规则，像水波/玻璃），
 * 这里是**值噪声**（不规则，像热浪）。
 *
 * ⚠️ 噪声必须是 `uv`/`phase` 的**纯函数**：不能读时钟、不能用随机数。
 * 流动由可关键帧的 `phase` 驱动。
 *
 * ⚠️ **hash 不能用 `fract(sin(x) * 43758.5453)`** —— 那是这类噪声最常见的写法，
 * 但依赖**大参数的 `sin`**，mediump 下精度实现相关。这里用不含 sin 的 hash。
 * （`grain` 用的是 sin 版，实测也是稳定的 —— 所以这不是唯一写法，只是更稳的选择。）
 *
 * ⚠️ 新增效果时**别忘了三处**：`this.progs` 注册表、`SIMPLE_PASSES`、
 * 以及契约里的 `EFFECT_TYPES`/`EFFECT_SPECS`。**漏掉注册表那一处会拿到
 * `undefined` 程序，产出不稳定且看起来像"着色器数学有问题"** ——
 * 实测在这上面绕过一大圈（见 docs/scene.md 的排查记录）。
 */
export const FS_DISPLACE = `precision mediump float; varying vec2 uv;
uniform sampler2D t; uniform float amount, frequency, phase;
float h(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vn(vec2 p){
  vec2 i = floor(p); vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h(i), h(i + vec2(1.0, 0.0)), f.x),
             mix(h(i + vec2(0.0, 1.0)), h(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main(){
  float ph = radians(phase);
  vec2 q = uv * frequency + ph;
  vec2 d = vec2(vn(q), vn(q + vec2(37.7, 17.3))) - 0.5;
  gl_FragColor = texture2D(t, clamp(uv + d * amount * 0.06, vec2(0.0), vec2(1.0)));
}`;


/** 波状扭曲：用正弦把采样位置推开。phase 让波纹平移（仍与时间无关）。 */
export const FS_DISTORT = `precision mediump float; varying vec2 uv;
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
export const SIMPLE_PASSES = {
  color: {prog: 'color', uniforms: ['exposure', 'brightness', 'contrast', 'saturation', 'hue', 'temperature']},
  vignette: {prog: 'vignette', uniforms: ['amount', 'radius', 'softness']},
  chromatic: {prog: 'chromatic', uniforms: ['amount', 'angle', 'texelX', 'texelY']},
  grain: {prog: 'grain', uniforms: ['amount', 'size', 'seed', 'texelX', 'texelY']},
  pixelate: {prog: 'pixelate', uniforms: ['size', 'texelX', 'texelY']},
  radialBlur: {prog: 'radialBlur', uniforms: ['amount', 'centerX', 'centerY']},
  distort: {prog: 'distort', uniforms: ['amount', 'frequency', 'phase']},
  displace: {prog: 'displace', uniforms: ['amount', 'frequency', 'phase']},
};
