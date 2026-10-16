// 自定义效果（逃生舱）的**作者入口**：`customPass(src, uniforms)`。
//
// ## 为什么是一个函数，而不是让作者手写 `{type:'custom', src, uniforms}`
//
// 因为要**可发现**：`docs/api.md` 里得有一个名字，读文档的 AI 才找得到这条路；
// 手写对象只存在于散文里，模型很难确信自己写对了。函数本身是**零逻辑**的糖 ——
// 校验不在这里，**不做第二套规则**（形状、上限、保留名、关键帧都由
// `contract/effects.js` 的 `validateEffects` 在 boot 期报，那是唯一一份）。
//
// ## 引擎补齐的那一半
//
// `src` 只写**自己的 uniform 声明与 `void main(){ … }`**；前面这段头由引擎拼上
// （见 `fx/shaders.js` 的 `CUSTOM_HEAD`）：
//
//     precision mediump float;
//     varying vec2 uv;
//     uniform sampler2D t;
//     uniform float texelX, texelY, frame;
//
// 所以作者手里一定有：`uv`（0–1 坐标）、`t`（输入纹理）、`texelX`/`texelY`（一个像素的
// uv 步长）、`frame`（帧号）。**没有时钟** —— 同一帧永远同一张是结构上成立的。
//
// 例：
//
//     effects: [customPass(`
//       uniform float u;
//       void main(){ gl_FragColor = texture2D(t, uv) * vec4(u, 1.0, 1.0, 1.0); }
//     `, {u: 0.5})]
//
// @param {string} src       GLSL ES 1.0 片段着色器的函数体（含 `void main`）
// @param {object} [uniforms] 名字 → 数值，或名字 → 关键帧轨道
// @returns {{type: 'custom', src: string, uniforms: object}} 可直接放进 `effects`
export function customPass(src, uniforms = {}) {
  return {type: 'custom', src, uniforms};
}
