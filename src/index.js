// filmwright 的**运行时公开面**：项目镜头文件只需要 import 这个。
//
//   import {text, panel, S, BLK, inv, easeOut3} from 'filmwright';
//
// 镜头契约：{start, draw(ctx, n, t, accent)}
//   start = 从哪一帧开始接管画面（区间由 filmwright 串接，不要自己写 to）
//   n     = 当前帧号（1 起）
//   t     = n / fps（秒）
//   accent= 当前章节主色
//
// 这里只导出**浏览器里跑**的东西。宿主层（Node 侧：渲染、自检、CLI）不在公开面上，
// 镜头不该 import 它们 —— 那会让库的内部结构和镜头耦合。
//
// **宿主页面也是这个公开面的使用者**：`src/host/pages/render.html` 与 `preview.html`
// 原先深链 `/kit/runtime/stage/index.js` 之类去拿 `boot` 等符号 —— 那等于宿主页面
// 自己违反「只从公开面取东西」这条规则，规则就没人信了。现在两份页面只 import
// `/kit/index.js`，并由 `tests/public-api.test.mjs` 常驻盯着（页面用到的名字必须在公开面上）。

// ---- 契约：配置与视口 ----
export {theme, fonts, view, DESIGN, config, accentFor} from './contract/config.js';

// ---- 契约：时间轴查询 ----
export {S, BLK, cutBefore, cardFrom, cardRange, chapterAt, tailFrom, timeline} from './contract/timeline.js';

// ---- 运行时：动效 ----
export * from './runtime/motion/ease.js';

// ---- 运行时：绘制原语与组合件 ----
export {font, measure, fit, roundRect, panel, pill, text, wrap, glowWith, arrowR,
        codeBlock, terminal, caret, rule, bars, hexdump, spotlight, grid} from './runtime/draw/primitives.js';
export {counter, bigStat, matrix, flow, chips, section, code} from './runtime/draw/widgets.js';
export {picture, fitBox} from './runtime/draw/picture.js';
export {hexA} from './runtime/draw/color.js';

// ---- 运行时：素材（图片；boot 时全部加载完）----
export {img, imgSize, assetNames, assetsReady} from './runtime/assets.js';

// ---- 运行时：片段（视频/图片序列；抽帧在宿主侧，这里按源帧号同步取帧）----
export {clipFrame, clipInfo, clipNames, clipsReady, decodedCount, sourceIndex} from './runtime/clips.js';

// ---- 运行时：图层合成（变换 / 组透明度 / 混合模式）----
export {withLayer, applyLayerTransform, applyShotTransform, isValidTransform, BLEND_MODES, bufferStats} from './runtime/composite/layer.js';

// ---- 运行时：嵌套合成（子合成实例与循环）----
export {bindLocalShots, compLength, localFrame, drawCompInstance, mapBeats} from './runtime/composite/comp.js';

// ---- 运行时：版面 ----
export {applyDesignScale, scale, scaleFactors, sX, sY, sSize, DESIGN_SAFE} from './runtime/layout/design.js';

// ---- 运行时：阶段（镜头与装配）----
// `boot` 公开在这里，理由见文件头：两份宿主页面都要用它。
export {boot, drawFrame, shotAt, shots, chapterCards} from './runtime/stage/index.js';

// ---- 运行时：画面自检的**页面侧采样器** ----
// 画质自检要读 canvas 像素，只能在页面里做；**判定**在 Node 侧
// （`host/checks/browser/quality.mjs`）。宿主页面负责把它装上，所以它在公开面上。
export {installAnalysis} from './runtime/qc/analysis.js';

// ---- 运行时：3D 图层（现成的 three，**可选**依赖）----
// 不在文件顶层 `import 'three'` —— 那样所有项目都要付 2.2MB 的加载代价。
// 由镜头模块自己 `await loadThree()`，顶层 await 也是那里的事（draw 是同步的）。
export {loadThree, create3D} from './runtime/three/stage.js';
