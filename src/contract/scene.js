// 场景规格（scene.json）的数据层：校验 + 对齐解析 + 机器可读 schema。
// 纯函数 —— 不碰 DOM、不碰 Node，所以 Node 里的静态自检与浏览器里的模板编译器
// 共用这一份实现（不会漂移）。
//
// 规格是 AI 的落点：AI 只填内容与节拍，节奏（入场/呼吸/离场/配色）由模板镜头负责。
// 因此校验必须**可行动**：每条错误带 code / path / hint，模型读完能直接改。
//
// ⚠️ 本文件原先 1391 行，已按职责拆成 8 个文件（**纯搬运，逻辑一行未改**）：
//   `scene/tables.js`        纯数据表与词汇表
//   `scene/timelineQuery.js` `at` 写句 id / 块号时的解析
//   `scene/primitives.js`    共用校验原语（报错、字段形状、关键帧轨道）
//   `scene/effects.js` / `scene/mask.js` / `scene/three.js` / `scene/layers.js`  各叶子校验器
//   `scene/validate.js`      `validateScene` 与机器可读 schema（唯一的总调度）
// 这里只转出**原本就公开**的名字（不顺手把内部原语也公开）——
// 8 个测试 + 2 个验收工具都按 `contract/scene.js` 这个路径取东西，一行未改。

export {SCENE_SCHEMA, SHOT_TYPES, CONTAINER_TYPES, TEMPLATE_TYPES, SHOT_MAXES, SCENE_ERROR_CODES, TRANSITION_TYPES, TRANSITION_DIRECTIONS, BLEND_MODES, ANIM_PROPS, EASE_NAMES} from './scene/tables.js';
export {resolveAt} from './scene/timelineQuery.js';
export {isValidTransition, isValidTransform, validateAnimate} from './scene/primitives.js';
export {validateEffects} from './scene/effects.js';
export {MASK_SHAPES, validateMask} from './scene/mask.js';
export {validate3D, needsThree} from './scene/three.js';
export {validateLayers} from './scene/layers.js';
export {assertNoCyclesPlain, validateScene, sceneSchema} from './scene/validate.js';
