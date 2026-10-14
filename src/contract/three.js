// 声明式 3D 图层的**词汇表**：能用哪些形状、哪些可以动、范围是多少。
//
// 与效果链同一原则：**有界词汇表**，不是"随便写一段 three 代码"。
//   · 形状是枚举；   · 数值有范围；   · 动画只用关键帧轨道（与 animate 同一套时间基）
//   · 不提供"自定义几何/自定义 shader"逃生舱 —— 真要自由发挥就走**命令式**
//     （`shots/index.js` 里 `await loadThree()`，那条路引擎不背书但也不限制）。
//
// ## 为什么动画必须走关键帧，而不是 three 自带的 clock
//
// 核心不变量是「第 N 帧只是 N 的函数」。three 的 `Clock`/`deltaTime` 让画面依赖
// **真实经过了多久**，那会直接破坏分片渲染、跳帧与增量复用。
// 所以声明式这边只给关键帧轨道（`beat`/`frame` 锚点、缓动都是现成那一套），
// 求值结果是帧号的纯函数。
export const SHAPES = ['box', 'sphere', 'torus', 'plane', 'icosahedron'];

/**
 * 3D 对象上可以动（关键帧）的属性。
 *
 * 刻意与 2D 的 `ANIM_PROPS` **分开**：2D 的 rotate 是绕屏幕法线的单角、
 * alpha/blend 是合成概念，搬到 3D 上语义不同。混在一起会让两边的校验都变糊。
 */
export const ANIM3D_PROPS = ['x', 'y', 'z', 'rx', 'ry', 'rz', 'scale'];

/** 一个镜头里最多几个 3D 对象：每个都是一次 draw call，太多会拖垮帧时间。 */
export const MAX_OBJECTS = 24;

/**
 * 可用的光源类型（有界词汇表，与形状同一原则）。
 *
 *   · `ambient`     环境光：均匀铺底，不产生明暗（没有它，背光面全黑）
 *   · `directional` 平行光：像太阳，有方向无位置衰减 —— 立体感主要靠它
 *   · `point`       点光源：有位置、随距离衰减 —— 像灯泡
 *
 * **不给 lights 时对象用无光照材质**（`MeshBasicMaterial`），画面与之前**逐位相同**；
 * 给了 lights 才切到受光材质（`MeshStandardMaterial`）。这样"加光"是一个显式动作，
 * 老项目不受影响。
 */
export const LIGHT_TYPES = ['ambient', 'directional', 'point'];

/** 一个镜头里最多几盏灯（受光材质的着色成本随灯数上升）。 */
export const MAX_LIGHTS = 6;

export const THREE_ERROR_CODES = [
  'SCENE_3D_SHAPE', 'SCENE_3D_CAMERA', 'SCENE_3D_OBJECTS', 'SCENE_3D_SHAPE_KIND',
  'SCENE_3D_VALUE', 'SCENE_3D_COLOR', 'SCENE_3D_ANIM', 'SCENE_3D_LIGHT',
];

/** 颜色可以是主题色名（accent/text/…）或 #rrggbb。 */
export const THEME_COLOR_KEYS = ['accent', 'text', 'muted', 'bg', 'panel', 'line', 'hl'];
