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
export {DEFAULT_FONTS, DEFAULT_FONT_FILES, DEFAULT_THEME, DESIGN, accent, accentFor, config, fonts, install, isInstalled, normalizeConfig, theme, view} from './contract/config.js';

// ---- 契约：时间轴查询 ----
export {BLK, S, cardFrom, cardRange, chapterAt, cutBefore, isReady, setTimeline, tailFrom, timeline} from './contract/timeline.js';

// ---- 契约：场景规格与校验（scene.json 的规则本身） ----
export {ANIM_PROPS, CONTAINER_TYPES, MASK_SHAPES, SCENE_ERROR_CODES, SCENE_SCHEMA, SHOT_MAXES, SHOT_TYPES, TEMPLATE_TYPES, TRANSITION_DIRECTIONS, TRANSITION_TYPES, assertNoCyclesPlain, isValidTransition, needsThree, resolveAt, sceneSchema, validate3D, validateAnimate, validateEffects, validateLayers, validateMask, validateScene} from './contract/scene.js';

// ---- 契约：效果链与 3D 的词汇表 ----
export {EFFECT_CHAIN_MAX, EFFECT_ERROR_CODES, EFFECT_SPECS, EFFECT_TYPES, GRADE_LOOKS} from './contract/effects.js';
export {ANIM3D_PROPS, LIGHT_ANIM_PROPS, LIGHT_TYPES, MAX_LIGHTS, MAX_OBJECTS, SHAPES, THEME_COLOR_KEYS, THREE_ERROR_CODES} from './contract/three.js';

// ---- 运行时：动效（缓动） ----
export {EASES, EASE_NAMES, clamp, easeIn3, easeInOut, easeOut3, easeOut4, easeOutBack, enter, exit, inv, kf, lerp, pulse, rnd, step} from './runtime/motion/ease.js';

// ---- 运行时：绘制原语与组合件 ----
export {arrowR, bars, caret, codeBlock, fit, font, glowWith, grid, hexdump, measure, panel, pill, roundRect, rule, spotlight, terminal, text, wrap} from './runtime/draw/primitives.js';
export {bigStat, chips, code, counter, flow, matrix, section} from './runtime/draw/widgets.js';
export {fitBox, picture} from './runtime/draw/picture.js';
export {hexA} from './runtime/draw/color.js';

// ---- 运行时：素材与片段 ----
export {assetNames, assetsReady, img, imgSize, loadAssets} from './runtime/assets.js';
export {clipFrame, clipInfo, clipNames, clipsReady, decodedCount, preloadClipFrames, setClips, sourceIndex} from './runtime/clips.js';

// ---- 运行时：图层合成与嵌套合成 ----
export {BLEND_MODES, applyLayerTransform, applyShotTransform, bufferStats, isValidTransform, needsBuffer, withLayer} from './runtime/composite/layer.js';
export {assertNoCycles, bindLocalShots, compLength, drawCompInstance, localFrame, mapBeats} from './runtime/composite/comp.js';

// ---- 运行时：版面 ----
export {DESIGN_SAFE, applyDesignScale, sSize, sX, sY, scale, scaleFactors} from './runtime/layout/design.js';

// ---- 运行时：声明式引擎（scene.json → 镜头） ----
export {TEMPLATES, compileScene} from './runtime/scene/templates.js';
export {compileAnimate, evalAnimate, mergeAnimate} from './runtime/scene/animate.js';

// ---- 运行时：效果链（编译与执行） ----
export {compileEffects, evalEffects, isNoopEffects} from './runtime/fx/compile.js';
export {applyEffects, getScratch, paintWithEffects} from './runtime/fx/gpu.js';
export {blurPlan, pyramidLevel} from './runtime/fx/blurPlan.js';

// ---- 运行时：阶段（镜头装配与逐帧绘制） ----
export {boot, chapterCards, drawFrame, shotAt, shots} from './runtime/stage/index.js';
export {bindShots, normalizeTransition, setShots} from './runtime/stage/shots.js';
export {transitionAt} from './runtime/stage/drawFrame.js';

// ---- 运行时：overlay（背板 / 章节卡 / HUD / 进度 / 字幕 / 结尾） ----
export {drawBackdrop} from './runtime/overlay/backdrop.js';
export {drawChapterCard, setChapterCards} from './runtime/overlay/chapterCard.js';
export {drawEnding} from './runtime/overlay/ending.js';
export {drawHud} from './runtime/overlay/hud.js';
export {drawProgress} from './runtime/overlay/progress.js';
export {drawSubtitle} from './runtime/overlay/subtitle.js';

// ---- 运行时：画面自检的**页面侧采样器** ----
export {INK_THR, contentRect, installAnalysis} from './runtime/qc/analysis.js';

// ---- 运行时：页面侧 h264 编码 ----
export {annexBFromChunk, createH264Encoder, h264Available} from './runtime/encode/h264.js';

// ---- 运行时：3D 图层（现成的 three，**可选**依赖） ----
export {create3D, ensureThree, getRenderer, getThree, loadThree} from './runtime/three/stage.js';
export {reset3D, threeT} from './runtime/three/scene3d.js';
