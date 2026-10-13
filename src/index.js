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

// ---- 运行时：版面 ----
export {applyDesignScale, scale, scaleFactors, sX, sY, sSize, DESIGN_SAFE} from './runtime/layout/design.js';

// ---- 运行时：阶段（镜头与装配）----
export {drawFrame, shotAt, shots, chapterCards} from './runtime/stage/index.js';
