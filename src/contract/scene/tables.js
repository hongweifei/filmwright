// 纯数据表与词汇表：类型清单、容量上限、错误码、字段表、转场 / 混合 / 可动画属性的词汇。
import {EFFECT_TYPES, EFFECT_SPECS, EFFECT_CHAIN_MAX, EFFECT_ERROR_CODES} from '../effects.js';
import {SHAPES, ANIM3D_PROPS, MAX_OBJECTS, THEME_COLOR_KEYS, THREE_ERROR_CODES,
  LIGHT_TYPES, MAX_LIGHTS, LIGHT_ANIM_PROPS} from '../three.js';

// 容量上限也在这里钉死 —— AI 该被校验告知边界，而不是靠肉眼发现画面溢出。
//
// 对齐 token（at）：
//   12                      → 第 12 帧
//   "S05"                   → 该句开口前的静音里（= cutBefore('S05')，提前 8 帧）
//   {s:"S05"}               → 同上
//   {s:"S05", lead:12}      → 提前 12 帧
//   {s:"S05", block:2}      → 锚在该句第 2 个字幕块的起点（再按 lead 提前）
//   {s:"S05", block:2, offset:-4} → 锚点后再偏移（负数=更早）
// 结果下限 1 帧。句 id / 块号不存在 → 报错并说明有几块。

/** 规格结构版本。写错直接报；没写按 v0 处理。 */
export const SCENE_SCHEMA = 'filmwright/scene-v0';


/** 模板镜头类型。运行时的注册表必须与这里一致（tests/scene-templates.test.mjs 钉住）。 */
export const SHOT_TYPES = [
  'title', 'bullets', 'stat', 'flow', 'code', 'image', 'compare',
  'steps', 'table', 'quote', 'terminal', 'chips', 'bars',
  'comp',   // 嵌套合成实例：引用 comps 里定义的一个子合成
  'clip',   // 视频/图片序列片段：按源帧号取图（见配置的 clips）
  'line',   // 折线图：逐段绘制 + 数值滚动（适合随时间的趋势）
  'three',  // 声明式 3D：形状/相机/关键帧动画（需要可选的 three，见 contract/three.js）
  'layers', // **容器**（不是模板）：同一个镜头区间里并发多层，各有 z 序与时间窗
];


/**
 * **容器**类型：它们不是模板（没有自己的内容与 TEMPLATES 条目），
 * 而是把别的东西组合起来。显式列出来，好让「SHOT_TYPES === TEMPLATES 键」
 * 这条不变量变成「SHOT_TYPES − 容器 === TEMPLATES 键」，而不是留一个静默例外。
 */
export const CONTAINER_TYPES = ['layers'];


/** 真正有模板实现的类型（供测试与 schema 用）。 */
export const TEMPLATE_TYPES = SHOT_TYPES.filter((t) => !CONTAINER_TYPES.includes(t));


/** 每类的容量上限（版面算出来的，超了会挤/溢出）。 */
export const SHOT_MAXES = {
  layers: {layers: 8},   // 并发层上限：每层都是一次完整绘制，太多会拖垮帧时间
  three: {objects: 24},  // 每个 3D 对象是一次 draw call，上限同 contract/three.js 的 MAX_OBJECTS
  bullets: {items: 6},
  steps: {steps: 6},
  flow: {boxes: 5},
  code: {lines: 10},
  table: {columns: 4, rows: 8},
  chips: {items: 12},
  bars: {items: 6},
  line: {points: 8},
  compare: {items: 5},   // left.items / right.items 各
};


/** 全部错误码（schema 输出与源码扫描测试共用；新增码必须登记到这里）。 */
export const SCENE_ERROR_CODES = [
  'SCENE_NOT_OBJECT', 'SCENE_SCHEMA', 'SCENE_UNKNOWN_FIELD', 'SCENE_NO_SHOTS', 'SCENE_BAD_SHOT',
  'SCENE_UNKNOWN_TYPE', 'SCENE_MISSING_FIELD', 'SCENE_MISSING_AT', 'SCENE_BAD_FIELD',
  'SCENE_TOO_MANY', 'SCENE_TABLE_WIDTH', 'SCENE_NO_ASSET', 'SCENE_FIRST_NOT_1', 'SCENE_NOT_INCREASING',
  'SCENE_BAD_TRANSITION', 'SCENE_BAD_TRANSFORM',
  'SCENE_ANIM_SHAPE', 'SCENE_ANIM_PROP', 'SCENE_ANIM_KEY', 'SCENE_ANIM_EASE',
  'SCENE_ANIM_ORDER', 'SCENE_ANIM_CONFLICT', 'SCENE_ANIM_VALUE',
  'SCENE_ANIM_RANGE', 'SCENE_ANIM_NO_BEATS',
  'SCENE_LAYER_SHAPE', 'SCENE_LAYER_CONTENT', 'SCENE_LAYER_RANGE', 'SCENE_LAYER_NEST',
  'SCENE_LAYER_FOLLOW',
  'SCENE_MASK_SHAPE', 'SCENE_MASK_RANGE', 'SCENE_MASK_POLYGON',
  ...EFFECT_ERROR_CODES,
  ...THREE_ERROR_CODES,
  'SCENE_BAD_COMP', 'SCENE_NO_COMP', 'SCENE_COMP_CYCLE', 'SCENE_COMP_LOCAL_AT',
  'SCENE_NO_CLIP',
  'SCENE_AT_FRAME', 'SCENE_AT_SHAPE', 'SCENE_AT_LEAD', 'SCENE_AT_OFFSET',
  'SCENE_NO_SENTENCE', 'SCENE_NO_BLOCK',
];


// ---------- 每类的字段规格（校验、schema 输出、文档共用这一份声明） ----------
// kind：'str' 必填字符串；'str?' 可选；'num' 必填数；'text' 必填长文本；
// 'assets' 素材名；'arr<shape>' 数组（shape 见 validateArr）。

export const FIELDS = {
  // **容器**：同一镜头区间里并发多层。每层自己有 z 序、时间窗、变换与关键帧。
  // 它没有"自己的内容"—— 内容全在 layers 里，所以不存在"镜头自身算不算一层"的歧义。
  layers: {layers: 'arr<layer>'},
  // 声明式 3D：形状/相机是有界词汇表，动画走关键帧轨道（见 validate3D）。
  // 键级检查走 SHAPE_KEYS.threeobj / threecam，语义检查在 validate3D。
  // lights 用 'obj?' 而不是 'arr<threelight>?'：通用校验器**不认带 ? 的数组 kind**
  // （它会把元素字段当成未知字段误报）。数组形状与元素字段全部在 validate3D 里查，
  // 那里本来就已经在做（键级 + 语义）。
  three: {camera: 'obj?', objects: 'arr<threeobj>', lights: 'obj?'},
  title: {title: 'str', sub: 'str?', en: 'str?', kicker: 'str?', reveal: 'obj?'},
  bullets: {heading: 'str?', items: 'arr<{t, d?}>', reveal: 'obj?'},
  stat: {value: 'num', label: 'str', unit: 'str?', label2: 'str?'},
  flow: {heading: 'str?', boxes: 'arr<{label, sub?}>'},
  code: {heading: 'str?', lines: 'arr<line>'},
  image: {asset: 'assets', heading: 'str?', note: 'str?'},
  compare: {heading: 'str?', left: 'side', right: 'side'},
  steps: {heading: 'str?', steps: 'arr<{t, d?}>'},
  table: {heading: 'str?', columns: 'arr<str>', rows: 'arr<row>'},
  quote: {text: 'text', who: 'str?', from: 'str?', reveal: 'obj?'},
  terminal: {heading: 'str?', title: 'str?', lines: 'arr<term>'},
  chips: {heading: 'str?', items: 'arr<chip>'},
  bars: {heading: 'str?', items: 'arr<bar>', unit: 'str?'},
  comp: {comp: 'compName', loop: 'bool?', frames: 'num?'},
  clip: {clip: 'clipName', heading: 'str?', note: 'str?', fit: 'fit?', from: 'num?', fps: 'num?'},
  line: {heading: 'str?', points: 'arr<point>', unit: 'str?', baseline: 'num?'},
};

/** 每类的说明（schema 输出给 agent 看，一句话讲清"什么时候用它"）。 */
export const TYPE_NOTES = {
  layers: '容器：同一镜头区间里**并发多层**，每层有 z 序（数值大在上）、时间窗（from/to，是相对本镜头起点的偏移，1 起）、以及自己的 transform 与 animate',
  title: '片头/章头：大标题 + 副题 + 英文行 + 眉题',
  bullets: '要点列表：每行「主文案 + 右侧说明」，跟着字幕块逐行进',
  stat: '一个大数字：滚动计数 + 单位 + 标签（+ 等宽小字）',
  flow: '横向流程盒（2–5 步）：输入 → 处理 → 输出',
  code: '代码块：逐行揭示，行可标 add/hl/err/ok，光标常闪',
  image: '图片素材居中：asset 必须在配置 assets 里声明',
  compare: '左右两栏对比：各一个标题 + 条目列表',
  steps: '编号步骤（2–6 步）：竖排序号 + 标题 + 说明，连接线生长',
  table: '表格：表头 + 最多 4 列 × 8 行，行跟着字幕块进',
  quote: '引言/强调：居中大段文字 + 出处署名',
  terminal: '终端窗口：标题栏 + 逐行输出，光标常闪',
  chips: '标签胶囊（≤12 个）：关键词平铺，自动折行',
  bars: '竖向条形图（2–6 根）：数值 + 标签，适合性能/占比对比',
  line: '折线图（2–8 个点）：逐段绘制 + 数值滚动，适合随时间的趋势',
  comp: '嵌套合成实例：引用 comps 里定义的可复用子合成（可循环）',
  clip: '视频/图片序列片段：按源帧号取图，随时间播放（片段在配置的 clips 里声明）',
  three: '声明式 3D：形状/相机是有界词汇表，动画走关键帧轨道（需要可选的 three）',
};


/** 转场类型与方向的**单一来源**（`runtime/stage/shots.js` 从这里 import，不再各抄一份）。 */
export const TRANSITION_TYPES = ['crossfade', 'fade', 'slide', 'wipe', 'zoom'];

export const TRANSITION_DIRECTIONS = ['left', 'right', 'up', 'down'];


/**
 * 允许的混合模式（Canvas 2D 的 `globalCompositeOperation` 里与合成相关的子集）。
 * **单一来源**：`runtime/composite/layer.js` 从这里 import 并原样再导出（公共面不变）。
 *
 * 它**必须**在 contract 里，不能只在 runtime：`scene.json` 的校验走 contract，而取值不合法
 * 要**在校验期就报**。原来只有 runtime 判白名单，于是 `{"blend":"不存在的模式"}` 通过校验，
 * 到了 runtime `withLayer` 直接 `ctx.globalCompositeOperation = blend`，而 Canvas 对非法值
 * 是**静默忽略**的 ⇒ 按 `source-over` 画，不报错、不崩（实测 `check --static-only` 8 道全过）。
 */
export const BLEND_MODES = [
  'source-over', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
  'color-dodge', 'color-burn', 'hard-light', 'soft-light',
  'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity',
];

export const BLENDS = new Set(BLEND_MODES);


/** `transform` 的字段说明（三处报错共用；`blend` 直接列出可用取值，别让用户去猜）。 */
export const TRANSFORM_HINT = '可用字段：x / y（设计坐标位移）、scale（>0）、rotate（度）、alpha（0–1）、'
  + `blend（以下之一：${BLEND_MODES.join(' / ')}）、origin（[x,y] 旋转缩放中心）`;


/**
 * 可动画属性。与 `transform` 的字段一一对应（**不引入新概念**）。
 * `blend` / `origin` 刻意不在列：混合模式是枚举不是连续量，变换中心动画很罕见。
 */
export const ANIM_PROPS = ['x', 'y', 'scale', 'rotate', 'alpha'];


/**
 * 缓动名白名单 —— **这里只有名字**。
 *
 * 实现放在 `runtime/motion/ease.js` 的 `EASES`，而 contract 不能 import runtime
 * （依赖只能向下），所以两份规则分开写、由**交叉一致性测试**钉住
 * （tests/animate.test.mjs 断言「名字集合」与「实现集合」一一对应）。
 *
 * 为什么只给词汇表、不做自定义贝塞尔：贝塞尔是 4 个数字，**AI 无法推理**，
 * 产出会变成"随手填的参数"，也无法静态判断好坏 —— 观感差异主要来自时机与层次。
 */
export const EASE_NAMES = ['linear', 'out3', 'out4', 'in3', 'inout3', 'back', 'step'];
