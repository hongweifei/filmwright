// 场景规格（scene.json）的数据层：校验 + 对齐解析 + 机器可读 schema。
// 纯函数 —— 不碰 DOM、不碰 Node，所以 Node 里的静态自检与浏览器里的模板编译器
// 共用这一份实现（不会漂移）。
//
// 规格是 AI 的落点：AI 只填内容与节拍，节奏（入场/呼吸/离场/配色）由模板镜头负责。
// 因此校验必须**可行动**：每条错误带 code / path / hint，模型读完能直接改。
import {EFFECT_TYPES, EFFECT_SPECS, EFFECT_CHAIN_MAX, EFFECT_ERROR_CODES} from './effects.js';
import {SHAPES, ANIM3D_PROPS, MAX_OBJECTS, THEME_COLOR_KEYS, THREE_ERROR_CODES,
  LIGHT_TYPES, MAX_LIGHTS, LIGHT_ANIM_PROPS} from './three.js';
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

// ---------- 时间轴数据的纯查询（与 contract/timeline.js 的 S/BLK/cutBefore 语义一致，有测试钉住） ----------

function sentenceById(tl, id) {
  return (tl?.sentences ?? []).find((x) => x.id === id) ?? null;
}

function blocksOf(tl, id) {
  const s = sentenceById(tl, id);
  if (!s) return null;
  return (tl?.subs ?? []).filter((b) => b.from >= s.from && b.to <= s.to);
}

/** 解析对齐 token → 起始帧号。失败抛错并带 code。 */
export function resolveAt(at, tl) {
  const fail = (code, msg) => {
    const e = new Error('filmwright: scene 对齐解析失败：' + msg);
    e.code = code;
    throw e;
  };
  if (typeof at === 'number') {
    if (!Number.isInteger(at) || at < 1) fail('SCENE_AT_FRAME', `数字对齐必须是 ≥1 的整数，收到 ${at}`);
    return at;
  }
  const spec = typeof at === 'string' ? {s: at} : at;
  if (!spec || typeof spec !== 'object' || typeof spec.s !== 'string') {
    fail('SCENE_AT_SHAPE', 'at 必须是帧号、句 id（"S05"）、或 {s, block?, lead?, offset?}，收到 ' + JSON.stringify(at));
  }
  const s = sentenceById(tl, spec.s);
  if (!s) fail('SCENE_NO_SENTENCE', `句 id ${spec.s} 不在时间轴里（先跑 filmwright tts，或核对 script/timeline.md）`);
  let anchor = s.from;
  if (spec.block !== undefined) {
    const blocks = blocksOf(tl, spec.s);
    const b = blocks[spec.block - 1];
    if (!b) fail('SCENE_NO_BLOCK', `句 ${spec.s} 没有第 ${spec.block} 个字幕块（共 ${blocks.length} 块）`);
    anchor = b.from;
  }
  const lead = spec.lead ?? 8;
  if (!Number.isInteger(lead) || lead < 0) fail('SCENE_AT_LEAD', `lead 必须是 ≥0 的整数，收到 ${spec.lead}`);
  const offset = spec.offset ?? 0;
  if (!Number.isInteger(offset)) fail('SCENE_AT_OFFSET', `offset 必须是整数，收到 ${spec.offset}`);
  return Math.max(1, anchor - lead + offset);
}

// ---------- 每类的字段规格（校验、schema 输出、文档共用这一份声明） ----------
// kind：'str' 必填字符串；'str?' 可选；'num' 必填数；'text' 必填长文本；
// 'assets' 素材名；'arr<shape>' 数组（shape 见 validateArr）。

const FIELDS = {
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
const TYPE_NOTES = {
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

/** 转场类型与方向（与 runtime/stage/shots.js 同一份名单，有交叉测试钉住）。 */
export const TRANSITION_TYPES = ['crossfade', 'fade', 'slide', 'wipe', 'zoom'];
export const TRANSITION_DIRECTIONS = ['left', 'right', 'up', 'down'];

/** 转场声明是否合法（与 runtime/stage/shots.js 的 normalizeTransition 同一套规则）。 */
export function isValidTransition(v) {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 1;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const type = v.type ?? 'crossfade';
  if (!TRANSITION_TYPES.includes(type)) return false;
  if (!Number.isInteger(v.frames) || v.frames < 1) return false;
  // direction 只对 slide / wipe 有意义；给了别的类型也不报错（运行时忽略它）
  if (v.direction !== undefined && !TRANSITION_DIRECTIONS.includes(v.direction)) return false;
  return true;
}

/**
 * 图层变换是否合法。
 *
 * 与 runtime/composite/layer.js 的 isValidTransform **必须一致** —— 但 contract
 * 不能 import runtime（分层规则），所以这里重写一份，并由测试钉住两者一致
 * （tests/composite-layer.test.mjs 有交叉断言）。规则很简单，重复的代价小于破层。
 */
export function isValidTransform(t) {
  if (t === undefined || t === null) return true;
  if (typeof t !== 'object' || Array.isArray(t)) return false;
  const num = (v) => v === undefined || (typeof v === 'number' && Number.isFinite(v));
  if (!num(t.x) || !num(t.y) || !num(t.scale) || !num(t.rotate)) return false;
  if (t.scale !== undefined && t.scale <= 0) return false;
  if (t.alpha !== undefined && !(typeof t.alpha === 'number' && t.alpha >= 0 && t.alpha <= 1)) return false;
  if (t.blend !== undefined && typeof t.blend !== 'string') return false;
  if (t.origin !== undefined) {
    if (!Array.isArray(t.origin) || t.origin.length !== 2) return false;
    if (!t.origin.every((v) => typeof v === 'number' && Number.isFinite(v))) return false;
  }
  return true;
}

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

/**
 * 校验一处 `effects`（效果链）。
 *
 * 形状：`[{"type": "blur", "radius": 8}, …]` —— 顺序即应用顺序。
 *
 * 为什么单独一个函数而不是走通用字段机制：**每个效果的参数不同**，
 * 通用机制只表达得了"元素有哪几个键"，表达不了"blur 有 radius、glow 有 radius/intensity"。
 *
 * @returns {Array} 错误数组（可能为空）
 */
export function validateEffects(effects, path = 'effects') {
  const out = [];
  const push = (code, where, message, hint) => out.push(err(code, where, message, hint));
  if (!Array.isArray(effects) || !effects.length) {
    push('SCENE_FX_SHAPE', path, 'effects 必须是非空数组',
      '形如 [{"type":"blur","radius":8}]；顺序即应用顺序');
    return out;
  }
  if (effects.length > EFFECT_CHAIN_MAX) {
    push('SCENE_FX_CHAIN', path, `效果链最多 ${EFFECT_CHAIN_MAX} 条，收到 ${effects.length} 条`,
      '链越长越慢；多数观感两三条就够 —— 检查是不是写重了');
  }
  effects.forEach((fx, i) => {
    const fp = `${path}[${i}]`;
    if (!fx || typeof fx !== 'object' || Array.isArray(fx)) {
      push('SCENE_FX_SHAPE', fp, '每条效果必须是对象', '形如 {"type":"blur","radius":8}');
      return;
    }
    const spec = EFFECT_SPECS[fx.type];
    if (!spec) {
      push('SCENE_FX_TYPE', `${fp}.type`, `不认识的效果 ${JSON.stringify(fx.type)}`,
        `可用：${EFFECT_TYPES.join(' / ')}`);
      return;
    }
    for (const k of Object.keys(fx)) {
      if (k === 'type') continue;
      if (!(k in spec.params)) {
        push('SCENE_FX_PARAM', `${fp}.${k}`, `${fx.type} 没有参数 ${JSON.stringify(k)}`,
          `可用：${Object.keys(spec.params).join(' / ')}`);
      }
    }
    for (const [k, ps] of Object.entries(spec.params)) {
      const v = fx[k];
      const rangeCheck = (val, valPath, push2) => {
        if (val < ps.min || val > ps.max) {
          push2('SCENE_FX_RANGE', valPath,
            `${k} 超出范围：${val}（允许 ${ps.min}–${ps.max}）`,
            `${k}：${ps.note} —— 允许范围就是 ${ps.min}–${ps.max}`);
        }
      };
      if (v === undefined) {
        if (ps.required) {
          push('SCENE_FX_PARAM', `${fp}.${k}`, `${fx.type} 需要参数 ${k}`,
            `${k}：${ps.note}（${ps.min}–${ps.max}）`);
        }
        continue;
      }
      // 枚举参数（如 grade.look）：只能是给定值之一，且**不能**用关键帧
      // （关键帧的值是数值 v，枚举没有插值语义）
      if (ps.kind === 'enum') {
        if (!ps.values.includes(v)) {
          push('SCENE_FX_PARAM', `${fp}.${k}`,
            `${k} 只能是 ${ps.values.join(' / ')}，收到 ${JSON.stringify(v)}`,
            `${k}：${ps.note}；可用：${ps.values.join(' / ')}`);
        }
        continue;
      }
      // 参数可以是**静态数值**，也可以是**关键帧轨道**（让模糊渐入、辉光脉冲）。
      // 轨道形状走 validateKeyTrack —— 与 animate 是**同一份**规则，不另写一套。
      if (Array.isArray(v)) {
        out.push(...validateKeyTrack(v, `${fp}.${k}`, {
          valueNote: `${k}：${ps.note}（每个关键帧的 v 都要在 ${ps.min}–${ps.max} 内）`,
          checkValue: rangeCheck,
        }));
        continue;
      }
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        push('SCENE_FX_PARAM', `${fp}.${k}`,
          `${k} 必须是数值或关键帧数组，收到 ${JSON.stringify(v)}`,
          `${k}：${ps.note}（${ps.min}–${ps.max}）；也可以写成 [{"beat":1,"v":0},{"beat":2,"v":12,"ease":"out3"}]`);
        continue;
      }
      rangeCheck(v, `${fp}.${k}`, push);
    }
    // 有些效果（如 color）每个参数都可省，而**全用缺省值恰好是直通** ⇒ 空转、白花一趟。
    // 这条**从数据推导**，不靠手写标志位：把"全部取缺省值"代入直通条件，命中就要求
    // 至少显式给一个参数。这样以后加效果不用记得补一个 flag。
    //
    // ⚠️ 但要**先确认必填参数都在**：否则缺 radius 的 blur 会同时报"缺少 radius"
    // 和"至少要给一个参数"，后者既多余又误导（缺的不是"一个"，是那个必填的）。
    const missingRequired = Object.entries(spec.params)
      .some(([k, ps]) => ps.required && fx[k] === undefined);
    if (!missingRequired && spec.noopWhen?.length) {
      const allDefaults = {};
      for (const [k, ps] of Object.entries(spec.params)) {
        allDefaults[k] = ps.def ?? ps.min ?? 0;
      }
      const wouldNoop = spec.noopWhen.some((cond) =>
        Object.entries(cond).every(([k, v]) => Math.abs((allDefaults[k] ?? v) - v) < 1e-9));
      const given = Object.keys(fx).filter((k) => k !== 'type').length;
      if (wouldNoop && given === 0) {
        push('SCENE_FX_PARAM', fp,
          `${fx.type} 至少要给一个参数（全用缺省值等于什么都没做）`,
          `可用：${Object.keys(spec.params).join(' / ')} —— 不给参数会白花一趟 GPU`);
      }
    }
  });
  return out;
}

/** 遮罩支持的四形状（有界词汇表 —— 与 2.1 的立场一致）。 */
export const MASK_SHAPES = ['rect', 'rounded', 'ellipse', 'polygon'];

/**
 * 校验遮罩规格。
 *
 * 坐标是**设计坐标的归一化值**（0–1，相对设计画布）—— 与分辨率无关，
 * 换竖屏/换尺寸不用改数字（与模板的 `scale()` 体系一致）。
 *
 * 刻意**不做羽化**：设计里那条标着「若做」，而且要靠 `ctx.filter = 'blur()'`，
 * 它的确定性与性能都要单独验。**宁可少一个参数，也不要一个不确定的旋钮。**
 */
export function validateMask(mask, path = 'mask') {
  const out = [];
  const push = (code, p, message, hint) => out.push({code, path: p, message, hint});
  if (!mask || typeof mask !== 'object' || Array.isArray(mask)) {
    push('SCENE_MASK_SHAPE', path, 'mask 必须是对象',
      '形如 {"shape":"ellipse","x":0.2,"y":0.2,"w":0.6,"h":0.6}');
    return out;
  }
  if (!MASK_SHAPES.includes(mask.shape)) {
    push('SCENE_MASK_SHAPE', `${path}.shape`,
      `shape 只能是 ${MASK_SHAPES.join(' / ')}，收到 ${JSON.stringify(mask.shape)}`,
      'rect 铺满默认、rounded 用 r 给圆角、ellipse 椭圆、polygon 用 points');
    return out;
  }
  for (const k of ['x', 'y', 'w', 'h', 'r']) {
    const v = mask[k];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
      push('SCENE_MASK_RANGE', `${path}.${k}`,
        `${k} 必须是 0–1 的数值（归一化设计坐标），收到 ${JSON.stringify(v)}`,
        '归一化：0.5 就是设计画布的一半；不用写像素');
    }
  }
  if (mask.shape === 'polygon') {
    const pts = mask.points;
    if (!Array.isArray(pts) || pts.length < 3) {
      push('SCENE_MASK_POLYGON', `${path}.points`, 'polygon 至少要 3 个点',
        '形如 [[0.5,0.1],[0.9,0.9],[0.1,0.9]]');
    } else {
      for (const [i, p] of pts.entries()) {
        const okP = Array.isArray(p) && p.length === 2
          && p.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1);
        if (!okP) {
          push('SCENE_MASK_POLYGON', `${path}.points[${i}]`,
            `每个点必须是 [x, y] 且都在 0–1，收到 ${JSON.stringify(p)}`,
            '归一化坐标：[[0.5,0.1],[0.9,0.9],[0.1,0.9]]');
        }
      }
    }
  }
  if (mask.invert !== undefined && typeof mask.invert !== 'boolean') {
    push('SCENE_MASK_SHAPE', `${path}.invert`, 'invert 必须是布尔值（反选：形状变成洞）',
      `收到 ${JSON.stringify(mask.invert)}`);
  }
  return out;
}

/**
 * 校验一个声明式 3D 镜头（`{"type": "three", "camera": …, "objects": […]}`）。
 *
 * 形状是**有界词汇表**（见 contract/three.js）。动画只走关键帧轨道 ——
 * 复用 `validateKeyTrack`，所以 `beat`/`frame` 锚点、缓动白名单、键序递增
 * 与 `animate` 是**同一套规则**，不复制第二份。
 */
export function validate3D(spec, path = 'three') {
  const out = [];
  const push = (code, where, message, hint) => out.push(err(code, where, message, hint));
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    push('SCENE_3D_SHAPE', path, 'three 镜头必须是对象',
      '形如 {"camera":{"z":4.2},"objects":[{"shape":"box","size":1.6,"color":"accent"}]}');
    return out;
  }
  // 通用字段（type/at/transition/transform/animate/effects）由外层统一处理，
  // 这里只管 three 自己的两个。**漏掉通用字段会误报** —— 第一版就报出
  // "three 没有字段 type/at"，等于所有合法写法都过不了。
  const COMMON = ['type', 'at', 'transition', 'transform', 'animate', 'effects', 'mask'];
  for (const k of Object.keys(spec)) {
    if (k === 'camera' || k === 'objects' || k === 'lights' || COMMON.includes(k)) continue;
    push('SCENE_3D_SHAPE', `${path}.${k}`, `three 没有字段 ${JSON.stringify(k)}`,
      '可用：camera / objects / lights（3D 动画写在每个对象的 animate 里）');
  }

  // ── camera ──
  const CAM = ['x', 'y', 'z', 'fov', 'lookAt'];
  if (spec.camera !== undefined) {
    const c = spec.camera;
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      push('SCENE_3D_CAMERA', `${path}.camera`, 'camera 必须是对象',
        '形如 {"x":0,"y":0,"z":4.2,"fov":50}；lookAt 是 [x,y,z]');
    } else {
      for (const k of Object.keys(c)) {
        if (!CAM.includes(k)) {
          push('SCENE_3D_CAMERA', `${path}.camera.${k}`, `camera 没有字段 ${JSON.stringify(k)}`,
            `可用：${CAM.join(' / ')}`);
        }
      }
      for (const k of ['x', 'y', 'z', 'fov']) {
        const v = c[k];
        if (v === undefined) continue;
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          push('SCENE_3D_CAMERA', `${path}.camera.${k}`, `camera.${k} 必须是数值，收到 ${JSON.stringify(v)}`,
            k === 'fov' ? 'fov：视场角（度），常用 30–70' : `${k}：相机位置（世界单位）`);
        } else if (k === 'fov' && (v <= 1 || v >= 179)) {
          push('SCENE_3D_CAMERA', `${path}.camera.fov`, `fov 超出范围：${v}`,
            'fov：视场角，允许 1–179（常用 30–70）');
        }
      }
      if (c.lookAt !== undefined) {
        const l = c.lookAt;
        if (!Array.isArray(l) || l.length !== 3 || l.some((x) => typeof x !== 'number')) {
          push('SCENE_3D_CAMERA', `${path}.camera.lookAt`, 'lookAt 必须是三个数值的数组',
            '形如 [0, 0, 0]（相机看向的点）');
        }
      }
    }
  }

  // ── lights（可选；给了才切到受光材质）──
  const LIGHT_KEYS = ['type', 'color', 'intensity', 'position', 'animate'];
  if (spec.lights !== undefined) {
    if (!Array.isArray(spec.lights) || !spec.lights.length) {
      push('SCENE_3D_LIGHT', `${path}.lights`, 'lights 必须是非空数组（不想打光就别写这个字段）',
        '形如 [{"type":"directional","intensity":2,"position":[3,4,5]}]');
    } else if (spec.lights.length > MAX_LIGHTS) {
      push('SCENE_3D_LIGHT', `${path}.lights`, `最多 ${MAX_LIGHTS} 盏灯，收到 ${spec.lights.length} 盏`,
        '受光材质的着色成本随灯数上升；够用就好');
    } else {
      spec.lights.forEach((L, i) => {
        const lp = `${path}.lights[${i}]`;
        if (!L || typeof L !== 'object' || Array.isArray(L)) {
          push('SCENE_3D_LIGHT', lp, '每盏灯必须是对象', '形如 {"type":"point","position":[2,3,4]}');
          return;
        }
        for (const k of Object.keys(L)) {
          if (!LIGHT_KEYS.includes(k)) {
            push('SCENE_3D_LIGHT', `${lp}.${k}`, `灯没有字段 ${JSON.stringify(k)}`,
              `可用：${LIGHT_KEYS.join(' / ')}`);
          }
        }
        if (!LIGHT_TYPES.includes(L.type)) {
          push('SCENE_3D_LIGHT', `${lp}.type`, `不认识的光源类型 ${JSON.stringify(L.type)}`,
            `可用：${LIGHT_TYPES.join(' / ')}（ambient 铺底、directional 像太阳、point 像灯泡）`);
        }
        if (L.intensity !== undefined && (typeof L.intensity !== 'number' || !Number.isFinite(L.intensity))) {
          push('SCENE_3D_LIGHT', `${lp}.intensity`, `intensity 必须是数值，收到 ${JSON.stringify(L.intensity)}`,
            'intensity：强度，常用 0.5–3（点光源随距离衰减，需要更大）');
        } else if (L.intensity !== undefined && (L.intensity < 0 || L.intensity > 20)) {
          push('SCENE_3D_LIGHT', `${lp}.intensity`, `intensity 超出范围：${L.intensity}`,
            'intensity：允许 0–20');
        }
        if (L.color !== undefined) {
          const okTheme = THEME_COLOR_KEYS.includes(L.color);
          const okHex = typeof L.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(L.color);
          if (!okTheme && !okHex) {
            push('SCENE_3D_COLOR', `${lp}.color`, `灯的颜色 ${JSON.stringify(L.color)} 不认识`,
              `可用主题色：${THEME_COLOR_KEYS.join(' / ')}；或 #rrggbb`);
          }
        }
        // 位置：ambient 不需要（它没有方向），另两种需要。
        // **但若用关键帧给了 x/y/z，就可以不写静态 position** —— 位置由轨道算出来。
        const anim = L.animate && typeof L.animate === 'object' ? L.animate : null;
        const posFromAnim = !!(anim && ('x' in anim || 'y' in anim || 'z' in anim));
        if (L.type !== 'ambient' && !posFromAnim) {
          if (L.position === undefined) {
            push('SCENE_3D_LIGHT', `${lp}.position`, `${L.type} 光源需要 position`,
              '形如 [3, 4, 5]（世界坐标）；也可以用 animate 的 x/y/z 轨道代替');
          } else if (!Array.isArray(L.position) || L.position.length !== 3
            || L.position.some((x) => typeof x !== 'number' || !Number.isFinite(x))) {
            push('SCENE_3D_LIGHT', `${lp}.position`, 'position 必须是三个数值的数组',
              '形如 [3, 4, 5]');
          }
        } else if (L.type === 'ambient' && L.position !== undefined) {
          push('SCENE_3D_LIGHT', `${lp}.position`, 'ambient 光源不需要 position（它没有方向）',
            '要方向就换 directional 或 point');
        }
        // 灯的关键帧：走**同一套**轨道校验（beat/frame 锚点、缓动白名单、键序递增）
        if (L.animate !== undefined) {
          if (!anim) {
            push('SCENE_3D_LIGHT', `${lp}.animate`, 'animate 必须是对象：{属性: [关键帧…]}',
              `可用属性：${LIGHT_ANIM_PROPS.join(' / ')}`);
          } else {
            for (const prop of Object.keys(anim)) {
              if (!LIGHT_ANIM_PROPS.includes(prop)) {
                push('SCENE_3D_LIGHT', `${lp}.animate.${prop}`, `灯的光照动画不支持属性 ${JSON.stringify(prop)}`,
                  `可用：${LIGHT_ANIM_PROPS.join(' / ')}（intensity 脉冲、x/y/z 光扫过；颜色不能动）`);
                continue;
              }
              // ambient 没有方向 ⇒ 位置轨道是**静默空操作**，报出来而不是放过
              if (L.type === 'ambient' && prop !== 'intensity') {
                push('SCENE_3D_LIGHT', `${lp}.animate.${prop}`,
                  `ambient 光源没有方向，${prop} 轨道不会有效果`,
                  'ambient 只支持 intensity 轨道；要让光动就换 directional 或 point');
                continue;
              }
              out.push(...validateKeyTrack(anim[prop], `${lp}.animate.${prop}`, {
                valueNote: prop === 'intensity' ? 'intensity：强度，常用 0.5–3' : `${prop}：世界坐标`,
                checkValue: prop === 'intensity'
                  ? (v, kp, p) => {
                    if (v < 0 || v > 20) {
                      p('SCENE_3D_LIGHT', kp, `intensity 的关键帧值超出范围：${v}`, 'intensity：允许 0–20');
                    }
                  }
                  : null,
              }));
            }
          }
        }
      });
    }
  }

  // ── objects ──
  // 空数组/非数组由**通用字段校验**报（它现在会带上这个形状的示例）——
  // 这里只提前返回，不再重复报一遍（两处报同一件事是噪声）。
  if (!Array.isArray(spec.objects) || !spec.objects.length) return out;
  if (spec.objects.length > MAX_OBJECTS) {
    push('SCENE_3D_OBJECTS', `${path}.objects`,
      `最多 ${MAX_OBJECTS} 个对象，收到 ${spec.objects.length} 个`,
      '每个对象是一次 draw call；要更多就走命令式，或拆成几个镜头');
  }

  const OBJ_KEYS = ['shape', 'size', 'color', 'opacity', 'wireframe', 'position', 'rotate', 'animate', 'material'];
  spec.objects.forEach((o, i) => {
    const op = `${path}.objects[${i}]`;
    if (!o || typeof o !== 'object' || Array.isArray(o)) {
      push('SCENE_3D_SHAPE', op, '每个对象必须是对象', '形如 {"shape":"box","size":1.6}');
      return;
    }
    for (const k of Object.keys(o)) {
      if (!OBJ_KEYS.includes(k)) {
        push('SCENE_3D_SHAPE', `${op}.${k}`, `对象没有字段 ${JSON.stringify(k)}`,
          `可用：${OBJ_KEYS.join(' / ')}`);
      }
    }
    if (!SHAPES.includes(o.shape)) {
      push('SCENE_3D_SHAPE_KIND', `${op}.shape`, `不认识的形状 ${JSON.stringify(o.shape)}`,
        `可用：${SHAPES.join(' / ')}`);
    }
    for (const k of ['size', 'opacity']) {
      const v = o[k];
      if (v === undefined) continue;
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        push('SCENE_3D_VALUE', `${op}.${k}`, `${k} 必须是数值，收到 ${JSON.stringify(v)}`,
          k === 'size' ? 'size：尺寸（世界单位），常用 0.2–5' : 'opacity：不透明度 0–1');
      } else if (k === 'size' && (v <= 0 || v > 20)) {
        push('SCENE_3D_VALUE', `${op}.size`, `size 超出范围：${v}`, 'size：允许 0–20（世界单位）');
      } else if (k === 'opacity' && (v < 0 || v > 1)) {
        push('SCENE_3D_VALUE', `${op}.opacity`, `opacity 超出范围：${v}`, 'opacity：允许 0–1');
      }
    }
    if (o.wireframe !== undefined && typeof o.wireframe !== 'boolean') {
      push('SCENE_3D_VALUE', `${op}.wireframe`, 'wireframe 必须是 true/false', '例：true 只画线框');
    }
    if (o.material !== undefined && o.material !== 'basic' && o.material !== 'standard') {
      push('SCENE_3D_VALUE', `${op}.material`, `material 只能是 basic 或 standard，收到 ${JSON.stringify(o.material)}`,
        'basic=不受光（平涂）；standard=受光（有明暗）。默认：有 lights 时 standard，否则 basic');
    }
    if (o.color !== undefined) {
      const okTheme = THEME_COLOR_KEYS.includes(o.color);
      const okHex = typeof o.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(o.color);
      if (!okTheme && !okHex) {
        push('SCENE_3D_COLOR', `${op}.color`, `颜色 ${JSON.stringify(o.color)} 不认识`,
          `可用主题色：${THEME_COLOR_KEYS.join(' / ')}；或 #rrggbb`);
      }
    }
    for (const k of ['position', 'rotate']) {
      const v = o[k];
      if (v === undefined) continue;
      if (!v || typeof v !== 'object' || Array.isArray(v)) {
        push('SCENE_3D_VALUE', `${op}.${k}`, `${k} 必须是 {x,y,z} 对象`,
          '例：{"x":0,"y":0,"z":0}' + (k === 'rotate' ? '（角度制）' : '（世界单位）'));
      } else {
        for (const ax of Object.keys(v)) {
          if (!['x', 'y', 'z'].includes(ax)) {
            push('SCENE_3D_VALUE', `${op}.${k}.${ax}`, `${k} 没有轴 ${JSON.stringify(ax)}`, '可用：x / y / z');
          } else if (typeof v[ax] !== 'number' || !Number.isFinite(v[ax])) {
            push('SCENE_3D_VALUE', `${op}.${k}.${ax}`, `${k}.${ax} 必须是数值`, `例：{"${ax}": 1.5}`);
          }
        }
      }
    }
    // 动画：走**同一套**轨道校验（beat/frame 锚点、缓动白名单、键序递增）
    if (o.animate !== undefined) {
      const an = o.animate;
      if (!an || typeof an !== 'object' || Array.isArray(an)) {
        push('SCENE_3D_ANIM', `${op}.animate`, 'animate 必须是对象：{属性: [关键帧…]}',
          `可用属性：${ANIM3D_PROPS.join(' / ')}`);
      } else {
        for (const prop of Object.keys(an)) {
          if (!ANIM3D_PROPS.includes(prop)) {
            push('SCENE_3D_ANIM', `${op}.animate.${prop}`, `3D 动画不支持属性 ${JSON.stringify(prop)}`,
              `可用：${ANIM3D_PROPS.join(' / ')}（rx/ry/rz 是绕各轴的角度，度）`);
            continue;
          }
          out.push(...validateKeyTrack(an[prop], `${op}.animate.${prop}`, {
            valueNote: prop === 'scale' ? 'scale：倍数，1 为原大' : undefined,
            checkValue: prop === 'scale'
              ? (v, kp, p) => {
                if (v <= 0) p('SCENE_3D_ANIM', kp, `scale 的关键帧值必须 > 0，收到 ${v}`, 'scale 是倍数，1 为原大');
              }
              : null,
          }));
        }
      }
    }
  });
  return out;
}

/**
 * 这个规格里有没有声明式 3D？—— 引擎据此决定**要不要预加载 three**。
 *
 * 为什么需要一个显式判断：three 有 2.2MB，**不用 3D 的项目一个字节都不该加载**。
 * 判断要在**原始规格**上做（在编译成镜头之前），这样图层容器里的 3D 也能被发现。
 */
export function needsThree(scene) {
  if (!scene || typeof scene !== 'object') return false;
  const hits = (shots) => (Array.isArray(shots) ? shots.some((s) => {
    if (!s || typeof s !== 'object') return false;
    if (s.type === 'three') return true;
    if (s.type === 'layers' && Array.isArray(s.layers)) {
      return s.layers.some((l) => l && l.content && l.content.type === 'three');
    }
    return false;
  }) : false);
  if (hits(scene.shots)) return true;
  // comps 是可以被复用的子合成，也要算上
  if (scene.comps) {
    for (const v of Object.values(scene.comps)) {
      if (v && hits(v.shots)) return true;
    }
  }
  return false;
}

/**
 * 校验 `type: "layers"` 的容器镜头。
 *
 * 每层：`{z?, from?, to?, transform?, animate?, content: {type, ...字段}}`
 *   · `content` 是一次**模板调用**，但**不能带 `at`** —— 层的位置由它自己的
 *     `from`/`to`（相对本镜头起点的偏移）决定，写 `at` 是坐标系统混用，直接报错；
 *   · `from`/`to` 是 1 起的相对帧；`to` 缺省到镜头末尾（绑定期才知道，见 runtime）；
 *   · `z` 缺省按声明顺序（后面的在上）；
 *   · 不允许 `content.type === 'layers'`（嵌套容器先不开，避免无界嵌套）。
 */
export function validateLayers(raw, path = 'shots') {
  const out = [];
  const push = (code, where, message, hint) => out.push(err(code, where, message, hint));
  const list = raw?.layers;
  if (!Array.isArray(list) || !list.length) {
    push('SCENE_LAYER_SHAPE', `${path}.layers`, 'layers 必须是非空数组',
      '每层形如 {"content":{"type":"bullets","items":[…]},"z":1,"from":1,"to":60}');
    return out;
  }
  list.forEach((layer, i) => {
    const lp = `${path}.layers[${i}]`;
    if (!layer || typeof layer !== 'object' || Array.isArray(layer)) {
      push('SCENE_LAYER_SHAPE', lp, '层必须是对象', '形如 {"content":{…},"z":0}');
      return;
    }
    if (layer.z !== undefined && !Number.isInteger(layer.z)) {
      push('SCENE_LAYER_SHAPE', `${lp}.z`, `z 必须是整数，收到 ${JSON.stringify(layer.z)}`,
        'z 是层序：数值大的画在上面；不写则按声明顺序（后面的在上）');
    }
    for (const k of ['from', 'to']) {
      if (layer[k] !== undefined && (!Number.isInteger(layer[k]) || layer[k] < 1)) {
        push('SCENE_LAYER_RANGE', `${lp}.${k}`,
          `${k} 必须是 ≥1 的整数（相对本镜头起点的偏移），收到 ${JSON.stringify(layer[k])}`,
          'from/to 是层自己的时间窗；不写 from 则从镜头第一帧开始，不写 to 则到镜头末尾');
      }
    }
    if (Number.isInteger(layer.from) && Number.isInteger(layer.to) && layer.to < layer.from) {
      push('SCENE_LAYER_RANGE', `${lp}.to`, `时间窗是空的：from=${layer.from} > to=${layer.to}`,
        'to 必须 ≥ from');
    }
    // ── 父子绑定 / 空物体（阶段 ④）──
    // `follow`：跟着**同一个容器里**的另一层动（声明下标）。
    // 有效变换 = 父的变换 ∘ 自己的变换 ⇒ 仍是帧号的纯函数（守住核心不变量）。
    if (layer.follow !== undefined) {
      const cnt = list.length;
      if (!Number.isInteger(layer.follow) || layer.follow < 0 || layer.follow >= cnt) {
        push('SCENE_LAYER_FOLLOW', `${lp}.follow`,
          `follow 必须是 0..${cnt - 1} 的整数（同容器里图层的**声明下标**），`
          + `收到 ${JSON.stringify(layer.follow)}`,
          `本容器有 ${cnt} 层，下标从 0 起（不是 z 值）`);
      } else if (layer.follow === i) {
        push('SCENE_LAYER_FOLLOW', `${lp}.follow`, '层不能 follow 自己',
          '指向本容器里的**另一个**层');
      }
    }
    // 空物体：不画内容、只给别的层提供变换 ⇒ **不要求 content**（写了反而报）
    if (layer.empty !== undefined && typeof layer.empty !== 'boolean') {
      push('SCENE_LAYER_SHAPE', `${lp}.empty`,
        `empty 必须是布尔值，收到 ${JSON.stringify(layer.empty)}`,
        'empty: true 表示这一层不画内容、只提供变换（配合别的层的 follow 用）');
    }
    if (layer.empty === true) {
      if (layer.content !== undefined) {
        push('SCENE_LAYER_CONTENT', `${lp}.content`,
          '空物体（empty: true）不能同时给 content —— 它不画任何东西',
          '要么去掉 empty，要么去掉 content');
      }
      if (layer.transform !== undefined && !isValidTransform(layer.transform)) {
        push('SCENE_LAYER_SHAPE', `${lp}.transform`, '层的 transform 形状不对',
          '与镜头 transform 同一套字段：x / y / scale / rotate / alpha / blend / origin');
      }
      if (layer.animate !== undefined) {
        out.push(...validateAnimate(layer.animate, layer.transform, `${lp}.animate`));
      }
      return;                                  // 空物体不查 content
    }
    const c = layer.content;
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      push('SCENE_LAYER_CONTENT', `${lp}.content`, '层必须给 content（一次模板调用）',
        `形如 {"content":{"type":"${SHOT_TYPES[0]}",…}}`);
      return;
    }
    if (c.at !== undefined) {
      push('SCENE_LAYER_CONTENT', `${lp}.content.at`,
        '层内容里不能写 at —— 层的位置由该层自己的 from/to 决定',
        '把 at 换成层的 from/to（相对本镜头起点的偏移，1 起）');
    }
    if (c.type === 'layers') {
      push('SCENE_LAYER_NEST', `${lp}.content.type`, '层里不能再放 layers 容器（v1 不开嵌套）',
        `层的 content 用模板类型：${SHOT_TYPES.filter((t) => t !== 'layers').join(' / ')}`);
    } else if (!SHOT_TYPES.includes(c.type)) {
      push('SCENE_LAYER_CONTENT', `${lp}.content.type`,
        `不认识的层内容类型 ${JSON.stringify(c.type)}`,
        `可用：${SHOT_TYPES.filter((t) => t !== 'layers').join(' / ')}`);
    }
    if (layer.transform !== undefined && !isValidTransform(layer.transform)) {
      push('SCENE_LAYER_SHAPE', `${lp}.transform`, '层的 transform 形状不对',
        '与镜头 transform 同一套字段：x / y / scale / rotate / alpha / blend / origin');
    }
    if (layer.animate !== undefined) {
      out.push(...validateAnimate(layer.animate, layer.transform, `${lp}.animate`));
    }
    if (layer.effects !== undefined) {
      out.push(...validateEffects(layer.effects, `${lp}.effects`));
    }
    if (layer.mask !== undefined) out.push(...validateMask(layer.mask, `${lp}.mask`));
  });
  // 成环检查：`follow` 必须是一条链，绕回自己就没有「最外层」可言了。
  // 运行时另有一道 `seen` 守卫（不会死循环），但**配置错了要当场报** ——
  // 否则表现是「绑定莫名其妙只生效一层」，属于最难查的那种静默错。
  list.forEach((layer, i) => {
    if (!layer || typeof layer !== 'object' || !Number.isInteger(layer.follow)) return;
    const seen = new Set([i]);
    let cur = layer;
    while (cur && Number.isInteger(cur.follow)) {
      const nx = cur.follow;
      if (seen.has(nx)) {
        push('SCENE_LAYER_FOLLOW', `${path}.layers[${i}].follow`,
          `follow 成环：${[...seen].join(' → ')} → ${nx}`,
          '父子关系必须是一条链，不能绕回自己');
        return;
      }
      seen.add(nx);
      cur = list[nx];
    }
  });
  return out;
}

/**
 * 校验一处 `animate`（形状层，不需要节拍表）。**导出**是为了让手写镜头
 * （shots/index.js，不走 scene 校验）也能用同一套规则 —— 规则只能有一份。
 *
 * 拍数相关的两条（`beat` 超范围、节点没有节拍表）**必须等到绑定期**才知道，
 * 所以不在这里 —— 见 runtime/stage/shots.js。
 *
 * @returns {Array} 错误数组（可能为空）
 */
/**
 * 校验**一条关键帧轨道**（单个属性 / 单个效果参数的关键帧数组）。
 *
 * 抽出来共用：`animate` 的每个属性、以及**效果参数**的关键帧，规则完全一样。
 * 规则只能有一份 —— 这个项目在「contract 与 runtime 各写一份校验」上吃过漂移的亏，
 * 所以效果参数的关键帧不另写一套。
 *
 * 关键帧问题一律用**动画那一组错误码**（键形状 / 缓动名 / 顺序），不管轨道挂在哪儿：
 * 它们描述的是**轨道本身的毛病**，与宿主无关；出错路径会精确到
 * `…effects[0].radius[1].ease`，定位不受影响。
 *
 * @param {Array} keys
 * @param {string} where  出错路径
 * @param {object} [opts]
 *   · valueNote  取值说明（拼进 hint）
 *   · checkValue (v, keyPath, push) => void  额外的取值检查（如 alpha 0–1、范围）
 */
function validateKeyTrack(keys, where, {valueNote = '', checkValue = null} = {}) {
  const out = [];
  const push = (code, w, m, h) => out.push(err(code, w, m, h));
  if (!Array.isArray(keys) || !keys.length) {
    push('SCENE_ANIM_SHAPE', where, '关键帧必须是非空数组',
      '形如 [{"beat":1,"v":0},{"beat":2,"v":40,"ease":"out3"}]' + (valueNote ? `；${valueNote}` : ''));
    return out;
  }
  const times = [];
  let base = null;
  keys.forEach((k, i) => {
    const kw = `${where}[${i}]`;
    if (!k || typeof k !== 'object' || Array.isArray(k)) {
      push('SCENE_ANIM_KEY', kw, '关键帧必须是对象', '形如 {"beat":1,"v":0,"ease":"out3"}');
      return;
    }
    if (typeof k.v !== 'number' || !Number.isFinite(k.v)) {
      push('SCENE_ANIM_KEY', `${kw}.v`, `关键帧缺少数值 v，收到 ${JSON.stringify(k.v)}`,
        'v 是要到达的值，例如 40');
      return;   // 没有合法的 v 就没法继续判取值
    }
    const hasBeat = k.beat !== undefined;
    const hasFrame = k.frame !== undefined;
    if (hasBeat === hasFrame) {
      push('SCENE_ANIM_KEY', kw,
        hasBeat ? 'beat 与 frame 只能给一个' : '关键帧必须给 beat 或 frame',
        'beat 是第几拍（1 起），frame 是节点内第几帧（1 起）');
    } else {
      const name = hasBeat ? 'beat' : 'frame';
      const t = hasBeat ? k.beat : k.frame;
      // 同一条轨道内**不允许混用两种时间基** —— 两者的序数不可比，
      // 混用几乎必然是写错，且"递增"检查会变成无意义的比较。
      if (base === null) base = name;
      else if (base !== name) {
        push('SCENE_ANIM_KEY', kw,
          `同一轨道里混用了 ${base} 与 ${name} 两种时间基`,
          '一条轨道内只用一种：要么全 beat（跟着节拍走），要么全 frame（跟绝对帧走）');
      }
      if (!Number.isInteger(t) || t < 1) {
        push('SCENE_ANIM_KEY', `${kw}.${name}`,
          `${name} 必须是 ≥1 的整数，收到 ${JSON.stringify(t)}`,
          name === 'beat' ? 'beat: 1 表示第一拍（1 起序数）' : 'frame: 1 表示该节点的第一帧（1 起序数）');
      } else {
        times.push(t);
      }
    }
    if (k.ease !== undefined && !EASE_NAMES.includes(k.ease)) {
      push('SCENE_ANIM_EASE', `${kw}.ease`, `不认识的缓动 ${JSON.stringify(k.ease)}`,
        `可用：${EASE_NAMES.join(' / ')}`);
    }
    if (checkValue) checkValue(k.v, `${kw}.v`, push);
  });

  for (let i = 1; i < times.length; i++) {
    if (times[i] <= times[i - 1]) {
      push('SCENE_ANIM_ORDER', `${where}[${i}]`,
        `关键帧时间必须严格递增，收到 ${times[i - 1]} → ${times[i]}`,
        '每个关键帧都要比前一个晚；同一时间点上不能有两个值');
      break;
    }
  }
  return out;
}

export function validateAnimate(animate, transform, path = 'animate') {
  const out = [];
  const push = (code, where, message, hint) => out.push(err(code, where, message, hint));

  if (animate === null || typeof animate !== 'object' || Array.isArray(animate)) {
    push('SCENE_ANIM_SHAPE', path, 'animate 必须是对象：{属性: [关键帧…]}',
      `可用属性：${ANIM_PROPS.join(' / ')}`);
    return out;
  }
  const props = Object.keys(animate);
  if (!props.length) {
    push('SCENE_ANIM_SHAPE', path, 'animate 是空对象', '要么删掉它，要么至少写一个属性');
    return out;
  }

  for (const prop of props) {
    const where = `${path}.${prop}`;
    if (!ANIM_PROPS.includes(prop)) {
      push('SCENE_ANIM_PROP', where, `animate 不支持属性 ${JSON.stringify(prop)}`,
        `可用：${ANIM_PROPS.join(' / ')}（它们与 transform 的字段一一对应）`);
      continue;
    }
    if (transform && Object.prototype.hasOwnProperty.call(transform, prop)) {
      push('SCENE_ANIM_CONFLICT', where,
        `${prop} 同时出现在 transform 与 animate 里（有歧义）`,
        '二选一：要静态值就写在 transform，要动画就只留在 animate');
    }
    out.push(...validateKeyTrack(animate[prop], where, {
      checkValue: (v, kp, p) => {
        if (prop === 'alpha' && (v < 0 || v > 1)) {
          p('SCENE_ANIM_VALUE', kp, `alpha 的关键帧值必须在 0–1，收到 ${v}`,
            'alpha: 0 全透明、1 不透明');
        }
        if (prop === 'scale' && v <= 0) {
          p('SCENE_ANIM_VALUE', kp, `scale 的关键帧值必须 > 0，收到 ${v}`,
            'scale 是倍数，1 为原大');
        }
      },
    }));
  }
  return out;
}

/**
 * 环检测（contract 层的一份实现）。
 *
 * 与 runtime/composite/comp.js 的 assertNoCycles 同规则 —— contract 不能 import
 * runtime（分层规则），所以重写一份；tests 里有交叉一致性断言钉住两者。
 * 环必须在**校验期**拦住：运行期递归遇到环会栈溢出，报错信息毫无用处。
 */
export function assertNoCyclesPlain(comps) {
  const state = new Map();
  const visit = (name, path) => {
    const st = state.get(name);
    if (st === 'done') return;
    if (st === 'visiting') throw new Error('子合成循环引用：' + [...path, name].join(' → '));
    state.set(name, 'visiting');
    for (const sh of comps[name]?.shots ?? []) {
      if (sh?.type === 'comp' && sh.comp && comps[sh.comp]) visit(sh.comp, [...path, name]);
    }
    state.set(name, 'done');
  };
  for (const name of Object.keys(comps ?? {})) visit(name, []);
}

/** 各种形状错误的说明（校验与 schema 共用）。 */
const err = (code, path, message, hint) => ({code, path, message, hint});

function checkStr(v, path, name, errors, required, kind = 'str') {
  if (v === undefined) {
    if (required) errors.push(err('SCENE_MISSING_FIELD', path, `${name} 必填`, `补上 ${name}（非空字符串）`));
    return;
  }
  if (typeof v !== 'string' || !v.length) {
    errors.push(err('SCENE_BAD_FIELD', path, `${name} 必须是非空字符串，收到 ${JSON.stringify(v)}`,
      kind === 'text' ? '文本字段写字符串' : '文本字段写字符串；没有就整个键删掉'));
  }
}

/** 数组元素形状逐个校验；返回元素个数（用于容量上限）。 */
function validateArr(v, path, shape, errors, {min = 1, maxName, shot} = {}) {
  if (!Array.isArray(v) || v.length < min) {
    // hint 要**可行动**：带上这个形状的示例。空 hint 等于让模型自己猜 ——
    // 实测 3D 的 objects 为空时只得到"必须是至少 1 项的数组"（hint 空），
    // 而同一件事 validate3D 能给一条带完整示例的提示。这里把通用的那条也补上。
    errors.push(err('SCENE_BAD_FIELD', path, `必须是至少 ${min} 项的数组`,
      SHAPE_HINT[shape] || (Array.isArray(v) ? '把数组填上至少一项' : '这里要写数组，例如 [ … ]')));
    return 0;
  }
  const max = maxName && shot ? SHOT_MAXES[maxName.owner]?.[maxName.key] : undefined;
  if (max !== undefined && v.length > max) {
    errors.push(err('SCENE_TOO_MANY', path, `最多 ${max} 项，收到 ${v.length} 项`,
      `删减内容，或拆成多个镜头（每个 at 对齐一句）——版面是算出来的，超了会溢出`));
  }
  v.forEach((it, i) => {
    const p = `${path}[${i}]`;
    if (shape === 'str') { checkStr(it, p, `${path.split('.').pop()}[${i}]`, errors, true); return; }
    if (shape === 'row') {
      if (!Array.isArray(it) || it.some((c) => typeof c !== 'string' || !c)) {
        errors.push(err('SCENE_BAD_FIELD', p, '行必须是字符串数组', '例：["列一", "列二"]'));
      }
      return;
    }
    if (!it || typeof it !== 'object') {
      // chips/terminal/line 允许裸字符串
      if (['chip', 'term', 'line'].includes(shape) && typeof it === 'string' && it) return;
      errors.push(err('SCENE_BAD_FIELD', p, `条目形状不对（${shape}）`, SHAPE_HINT[shape] ?? ''));
      return;
    }
    const keys = Object.keys(it);
    const allowed = SHAPE_KEYS[shape] ?? [];
    const unknown = keys.filter((k) => !allowed.includes(k));
    if (unknown.length) errors.push(err('SCENE_UNKNOWN_FIELD', `${p}.${unknown[0]}`, `未知字段 ${unknown.join(', ')}`, `可用：${allowed.join(' / ')}`));
    if (shape === '{t, d?}' || shape === 'step') {
      checkStr(it.t, `${p}.t`, 't', errors, true);
      if (it.d !== undefined) checkStr(it.d, `${p}.d`, 'd', errors, false);
    } else if (shape === '{label, sub?}') {
      checkStr(it.label, `${p}.label`, 'label', errors, true);
      if (it.sub !== undefined) checkStr(it.sub, `${p}.sub`, 'sub', errors, false);
    } else if (shape === 'line') {
      checkStr(it.text, `${p}.text`, 'text', errors, true);
      if (it.mark !== undefined && !['add', 'hl', 'err', 'ok'].includes(it.mark)) {
        errors.push(err('SCENE_BAD_FIELD', `${p}.mark`, `不认识的高亮 ${JSON.stringify(it.mark)}`, '可用：add / hl / err / ok'));
      }
    } else if (shape === 'term') {
      checkStr(it.text, `${p}.text`, 'text', errors, true);
      if (it.color !== undefined) checkStr(it.color, `${p}.color`, 'color', errors, false);
    } else if (shape === 'chip') {
      checkStr(it.label, `${p}.label`, 'label', errors, true);
    } else if (shape === 'bar') {
      if (typeof it.v !== 'number' || !Number.isFinite(it.v)) {
        errors.push(err('SCENE_BAD_FIELD', `${p}.v`, 'v 必须是数字', '条形图的数值'));
      }
      checkStr(it.label, `${p}.label`, 'label', errors, true);
      if (it.unit !== undefined) checkStr(it.unit, `${p}.unit`, 'unit', errors, false);
    } else if (shape === 'point') {
      // 折线图的点：v 必填，label 可选（X 轴标签，不写就不显示）
      if (typeof it.v !== 'number' || !Number.isFinite(it.v)) {
        errors.push(err('SCENE_BAD_FIELD', `${p}.v`, 'v 必须是数字', '折线图的数据点值'));
      }
      if (it.label !== undefined) checkStr(it.label, `${p}.label`, 'label', errors, false);
    }
  });
  return v.length;
}

const SHAPE_KEYS = {
  // 容器里的一层。**键级**检查走这里（未知字段），**语义**检查在 validateLayers
  // （content 必须是模板调用且不带 at、from/to 范围、z 类型、嵌套容器禁用）。
  // `follow` / `empty` / `mask` 都是层的合法键 —— **漏登记会把合法写法当成未知字段拒掉**
  // （子代理在只读侦察时指出这一条：我加字段时漏了这张表）。
  layer: ['content', 'z', 'from', 'to', 'transform', 'animate', 'effects', 'mask', 'follow', 'empty'],
  // 声明式 3D 的一个对象。键级检查走这里，语义检查在 validate3D。
  threeobj: ['shape', 'size', 'color', 'opacity', 'wireframe', 'position', 'rotate', 'animate', 'material'],
  threelight: ['type', 'color', 'intensity', 'position', 'animate'],
  threecam: ['x', 'y', 'z', 'fov', 'lookAt'],
  '{t, d?}': ['t', 'd'],
  step: ['t', 'd'],
  '{label, sub?}': ['label', 'sub'],
  line: ['text', 'mark'],
  term: ['text', 'color'],
  chip: ['label'],
  bar: ['v', 'label', 'unit'],
  point: ['v', 'label'],
};
const SHAPE_HINT = {
  layer: '每层形如 {"content":{"type":"bullets","items":[…]},"z":1,"from":1,"to":60}',
  threeobj: '例：{"shape":"box","size":1.6,"color":"accent","animate":{"ry":[{"beat":1,"v":0},{"beat":3,"v":360}]}}',
  threelight: '例：{"type":"directional","color":"#ffffff","intensity":2,"position":[3,4,5]}',
  threecam: '例：{"z":4.2,"fov":50,"lookAt":[0,0,0]}',
  '{t, d?}': '例：{"t": "要点", "d": "说明"}',
  step: '例：{"t": "步骤名", "d": "说明"}',
  '{label, sub?}': '例：{"label": "环节"}',
  line: '字符串或 {"text": "…", "mark": "hl"}',
  term: '字符串或 {"text": "…", "color": "#…"}',
  chip: '字符串或 {"label": "关键词"}',
  bar: '例：{"v": 81, "label": "Chrome", "unit": "ms"}',
  point: '例：{"v": 81, "label": "一月"}（label 可选，作为 X 轴标签）',
};

function validateSide(v, path, errors, owner) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    errors.push(err('SCENE_BAD_FIELD', path, '必须是 {title, items}', '例：{"title": "旧做法", "items": ["…"]}'));
    return;
  }
  const unknown = Object.keys(v).filter((k) => k !== 'title' && k !== 'items');
  if (unknown.length) errors.push(err('SCENE_UNKNOWN_FIELD', `${path}.${unknown[0]}`, `未知字段 ${unknown.join(', ')}`, ''));
  checkStr(v.title, `${path}.title`, 'title', errors, true);
  validateArr(v.items, `${path}.items`, 'str', errors, {min: 1, maxName: {owner: 'compare', key: 'items'}, shot: {}});
}

/**
 * 校验场景规格。
 * @param {object} raw scene.json 解析结果
 * @param {{timeline: object, assetNames?: string[]}} ctx
 * @returns {{ok: boolean, errors: Array<{code, path, message, hint}>}}
 */
export function validateScene(raw, {timeline, assetNames, clipNames} = {}) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(err('SCENE_NOT_OBJECT', 'scene', '场景规格必须是一个对象', '形如 {"shots": [...]}'));
    return {ok: false, errors};
  }
  if (raw.$schema !== undefined && raw.$schema !== SCENE_SCHEMA) {
    errors.push(err('SCENE_SCHEMA', '$schema', `不认识的结构版本 ${JSON.stringify(raw.$schema)}`,
      `用 "${SCENE_SCHEMA}"，或整个删掉`));
  }
  const topUnknown = Object.keys(raw).filter((k) => k !== '$schema' && k !== 'shots' && k !== 'comps');
  if (topUnknown.length) {
    errors.push(err('SCENE_UNKNOWN_FIELD', topUnknown[0], `顶层未知字段 ${topUnknown.join(', ')}`, '顶层只认 $schema / comps / shots'));
  }
  // comps：可复用的子合成定义。每个 comp 有自己的**本地时间轴**（shots 里的
  // at 必须是本地帧号），实例化时用 comp 类型镜头引用它。
  const comps = raw.comps ?? {};
  if (typeof comps !== 'object' || Array.isArray(comps)) {
    errors.push(err('SCENE_BAD_COMP', 'comps', 'comps 必须是对象：{名字: {frames?, shots:[...]}}', ''));
  }
  const compNames = new Set(Object.keys(comps ?? {}));
  for (const [name, def] of Object.entries(comps ?? {})) {
    const p = `comps.${name}`;
    if (!def || typeof def !== 'object' || Array.isArray(def)) {
      errors.push(err('SCENE_BAD_COMP', p, '子合成必须是对象', '要 {frames?, shots:[...]}'));
      continue;
    }
    const unk = Object.keys(def).filter((k) => k !== 'frames' && k !== 'shots');
    if (unk.length) errors.push(err('SCENE_UNKNOWN_FIELD', `${p}.${unk[0]}`, `子合成没有字段 ${unk.join(', ')}`, '只认 frames / shots'));
    if (def.frames !== undefined && (!Number.isInteger(def.frames) || def.frames < 1)) {
      errors.push(err('SCENE_BAD_COMP', `${p}.frames`, 'frames 必须是 ≥1 的整数', '不写就由子镜头串接推出长度'));
    }
    if (!Array.isArray(def.shots) || def.shots.length === 0) {
      errors.push(err('SCENE_BAD_COMP', `${p}.shots`, '子合成里至少要有 1 个镜头', ''));
      continue;
    }
    // 子镜头：只声明本地 start，串接规则与主镜头一致
    const starts = [];
    def.shots.forEach((sh, i) => {
      const sp = `${p}.shots[${i}]`;
      if (!sh || typeof sh !== 'object' || Array.isArray(sh)) {
        errors.push(err('SCENE_BAD_SHOT', sp, '子镜头必须是对象', ''));
        return;
      }
      if (sh.at !== undefined && typeof sh.at !== 'number') {
        errors.push(err('SCENE_COMP_LOCAL_AT', `${sp}.at`,
          '子合成里的 at 只能是**本地帧号**（数字），不能是句 id',
          '本地时间轴与全局时间轴是两套坐标；要跟解说词对齐，在实例化那一层（外层 comp 镜头的 at）写句 id'));
      } else if (typeof sh.at === 'number' && (!Number.isInteger(sh.at) || sh.at < 1)) {
        errors.push(err('SCENE_BAD_FIELD', `${sp}.at`, '本地帧号必须是 ≥1 的整数，收到 ' + sh.at, ''));
      }
      if (sh.type === 'comp' && sh.comp && !compNames.has(sh.comp)) {
        errors.push(err('SCENE_NO_COMP', `${sp}.comp`, `引用了不存在的子合成 ${JSON.stringify(sh.comp)}`,
          `已定义：${[...compNames].join(' / ') || '（无）'}`));
      }
      if (typeof sh.at === 'number') starts.push({i, at: sh.at});
    });
    if (starts.length === def.shots.length && starts.length > 0) {
      if (starts[0].at !== 1) {
        errors.push(err('SCENE_FIRST_NOT_1', `${p}.shots[0].at`,
          `子合成的第一个镜头必须从本地第 1 帧开始，收到 ${starts[0].at}`, ''));
      }
      for (let k = 1; k < starts.length; k++) {
        if (starts[k].at <= starts[k - 1].at) {
          errors.push(err('SCENE_NOT_INCREASING', `${p}.shots[${starts[k].i}].at`,
            `本地帧号必须严格递增：${starts[k - 1].at} → ${starts[k].at}`, ''));
        }
      }
    }
  }
  // 环检测（在 contract 层做：运行期递归遇到环会栈溢出，必须在校验期拦住）
  try {
    assertNoCyclesPlain(comps);
  } catch (e) {
    errors.push(err('SCENE_COMP_CYCLE', 'comps', e.message.replace('filmwright: ', ''), '子合成不能直接或间接引用自己'));
  }
  if (!Array.isArray(raw.shots) || raw.shots.length === 0) {
    errors.push(err('SCENE_NO_SHOTS', 'shots', 'shots 必须是非空数组', '至少一个镜头'));
    return {ok: false, errors};
  }

  const starts = [];
  raw.shots.forEach((shot, i) => {
    const path = `shots[${i}]`;
    if (!shot || typeof shot !== 'object' || Array.isArray(shot)) {
      errors.push(err('SCENE_BAD_SHOT', path, '镜头必须是对象', '形如 {"type": "bullets", "at": "S02", …}'));
      return;
    }
    // transition / transform 是所有类型共用的字段（不是某个模板的），单独校验
    if (shot.transition !== undefined && !isValidTransition(shot.transition)) {
      errors.push(err('SCENE_BAD_TRANSITION', `${path}.transition`,
        `转场形状不对：${JSON.stringify(shot.transition)}`,
        `要 {type:"${TRANSITION_TYPES.join('"|"')}", frames:N}（N≥1），或直接给帧数；` +
        `slide/wipe 可加 direction: ${TRANSITION_DIRECTIONS.join('/')}；第一个镜头只能用 fade`));
    }
    if (shot.transform !== undefined && !isValidTransform(shot.transform)) {
      errors.push(err('SCENE_BAD_TRANSFORM', `${path}.transform`,
        `图层变换形状不对：${JSON.stringify(shot.transform)}`,
        '可用字段：x / y（设计坐标位移）、scale（>0）、rotate（度）、alpha（0–1）、blend（混合模式名）、origin（[x,y] 旋转缩放中心）'));
    }
    if (shot.animate !== undefined) {
      errors.push(...validateAnimate(shot.animate, shot.transform, `${path}.animate`));
    }
    if (shot.type === 'layers') {
      errors.push(...validateLayers(shot, path));
    }
    if (shot.effects !== undefined) {
      errors.push(...validateEffects(shot.effects, `${path}.effects`));
    }
    if (shot.mask !== undefined) errors.push(...validateMask(shot.mask, `${path}.mask`));
    if (shot.type === 'three') {
      errors.push(...validate3D(shot, path));
    }
    const type = shot.type;
    if (!SHOT_TYPES.includes(type)) {
      errors.push(err('SCENE_UNKNOWN_TYPE', `${path}.type`, `不认识的镜头类型 ${JSON.stringify(type)}`,
        `可用：${SHOT_TYPES.join(' / ')}`));
    } else {
      const spec = FIELDS[type];
      // ⚠️ 这处白名单与 `validate3D` 里的 `COMMON` **是两套**，加通用字段要**两处都改**
      // （实测踩到：只改了 COMMON，镜头级仍报 "stat 没有字段 mask"）。
      const SHOT_COMMON = ['type', 'at', 'transition', 'transform', 'animate', 'effects', 'mask'];
      const unknown = Object.keys(shot).filter((k) => !SHOT_COMMON.includes(k) && !(k in spec));
      if (unknown.length) {
        errors.push(err('SCENE_UNKNOWN_FIELD', `${path}.${unknown[0]}`,
          `${type} 没有字段 ${unknown.join(', ')}`, `可用：${Object.keys(spec).map((k) => k.replace(/\?$/, '')).join(' / ')}`));
      }
      for (const [k, kind] of Object.entries(spec)) {
        const v = shot[k];
        const p = `${path}.${k}`;
        if (kind === 'str') checkStr(v, p, k, errors, true);
        else if (kind === 'text') checkStr(v, p, k, errors, true, 'text');
        else if (kind === 'str?') { if (v !== undefined) checkStr(v, p, k, errors, false); }
        else if (kind === 'num') {
          if (v === undefined) errors.push(err('SCENE_MISSING_FIELD', p, `${k} 必填`, '数值，例如 81'));
          else if (typeof v !== 'number' || !Number.isFinite(v)) {
            errors.push(err('SCENE_BAD_FIELD', p, `${k} 必须是数字，收到 ${JSON.stringify(v)}`, '别写成字符串'));
          }
        } else if (kind === 'side') validateSide(v, p, errors, type);
        else if (kind === 'assets') {
          if (v === undefined) errors.push(err('SCENE_MISSING_FIELD', p, 'asset 必填', '素材名，见配置的 assets'));
          else if (typeof v !== 'string' || !v) errors.push(err('SCENE_BAD_FIELD', p, 'asset 必须是非空字符串', ''));
          else if (assetNames && !assetNames.includes(v)) {
            errors.push(err('SCENE_NO_ASSET', p, `素材 ${JSON.stringify(v)} 没在配置里声明`,
              `已声明：${assetNames.join(' / ') || '（无）'}`));
          }
        } else if (kind.startsWith('arr<')) {
          const shape = kind.slice(4, -1);
          const min = shape === '{label, sub?}' ? 2 : 1;   // flow 至少两步
          validateArr(v, p, shape, errors, {min, maxName: {owner: type, key: k}, shot});
        } else if (kind === 'bool?') {
          if (v !== undefined && typeof v !== 'boolean') {
            errors.push(err('SCENE_BAD_FIELD', p, `${k} 必须是 true/false，收到 ${JSON.stringify(v)}`, ''));
          }
        } else if (kind === 'fit?') {
          if (v !== undefined && !['contain', 'cover', 'stretch'].includes(v)) {
            errors.push(err('SCENE_BAD_FIELD', p, `fit 只能是 contain / cover / stretch，收到 ${JSON.stringify(v)}`, ''));
          }
        } else if (kind === 'clipName') {
          if (v === undefined) {
            errors.push(err('SCENE_MISSING_FIELD', p, 'clip 必填', '写配置 clips 里声明的片段名，例如 "broll"'));
          } else if (typeof v !== 'string' || !v) {
            errors.push(err('SCENE_BAD_FIELD', p, 'clip 必须是非空字符串', ''));
          } else if (clipNames && !clipNames.has(v)) {
            errors.push(err('SCENE_NO_CLIP', p, `引用了不存在的片段 ${JSON.stringify(v)}`,
              `已声明：${[...clipNames].join(' / ') || '（无，先在 film.config.mjs 的 clips 里声明）'}`));
          }
        } else if (kind === 'compName') {
          // comp 类型引用 comps 里定义的子合成；不存在就报错（否则运行期才炸）
          if (v === undefined) {
            errors.push(err('SCENE_MISSING_FIELD', p, 'comp 必填', '写 comps 里定义的子合成名，例如 "lowerThird"'));
          } else if (typeof v !== 'string' || !v) {
            errors.push(err('SCENE_BAD_FIELD', p, 'comp 必须是非空字符串', ''));
          } else if (compNames && !compNames.has(v)) {
            errors.push(err('SCENE_NO_COMP', p, `引用了不存在的子合成 ${JSON.stringify(v)}`,
              `已定义：${[...compNames].join(' / ') || '（无，先在顶层 comps 里定义）'}`));
          }
        }
      }
      // 表格的行列交叉检查（需要同时看到 columns 与 rows）
      if (type === 'table' && Array.isArray(shot.columns) && Array.isArray(shot.rows)) {
        const n = shot.columns.length;
        shot.rows.forEach((r, j) => {
          if (Array.isArray(r) && r.length !== n) {
            errors.push(err('SCENE_TABLE_WIDTH', `${path}.rows[${j}]`,
              `这一行有 ${r.length} 列，表头是 ${n} 列`, '每行的单元格数必须等于 columns 数'));
          }
        });
      }
    }
    if (shot.at === undefined) {
      errors.push(err('SCENE_MISSING_AT', `${path}.at`, 'at 必填', '帧号、句 id（"S02"）或 {s, block?, lead?, offset?}'));
    } else {
      try {
        starts.push({i, frame: resolveAt(shot.at, timeline)});
      } catch (e) {
        errors.push(err(e.code ?? 'SCENE_AT_SHAPE', `${path}.at`, e.message.replace('filmwright: scene 对齐解析失败：', ''), ''));
      }
    }
  });

  // 顺序与覆盖：与镜头层同一条纪律 —— 严格递增、第一个从 1 起（区间由引擎串接）
  if (errors.length === 0 && starts.length === raw.shots.length) {
    if (starts[0].frame !== 1) {
      errors.push(err('SCENE_FIRST_NOT_1', 'shots[0].at',
        `第一个镜头必须从第 1 帧开始，${JSON.stringify(raw.shots[0].at)} 落在第 ${starts[0].frame} 帧`,
        '片头用 {"type": "title", "at": 1}'));
    }
    for (let k = 1; k < starts.length; k++) {
      if (starts[k].frame <= starts[k - 1].frame) {
        errors.push(err('SCENE_NOT_INCREASING', `shots[${starts[k].i}].at`,
          `第 ${starts[k].i} 个镜头（第 ${starts[k].frame} 帧）没有接在第 ${starts[k - 1].i} 个（第 ${starts[k - 1].frame} 帧）之后`,
          'shots 按播放顺序排；对齐用时间轴里更靠后的句 id'));
      }
    }
  }
  return {ok: errors.length === 0, errors};
}

/**
 * 机器可读的规格 schema —— `filmwright schema --json` 与 MCP 的 filmwright_schema
 * 都从这里出：agent 不读文档也能发现「有哪些类型、每个字段什么形状、上限多少、
 * 对齐怎么写、错误码什么含义」。
 */
export function sceneSchema() {
  return {
    schema: SCENE_SCHEMA,
    top: {shots: '镜头数组，按播放顺序；第一个必须 at:1；区间由引擎串接'},
    at: {
      number: '帧号（≥1 的整数）',
      string: '句 id，如 "S05" → cutBefore 语义（开口前 8 帧）',
      object: '{s, block?, lead?=8, offset?=0}：锚到句或字幕块起点，提前 lead 帧，再加 offset',
    },
    types: Object.fromEntries(SHOT_TYPES.map((t) => [t, {
      // 容器与模板要分开标出来：容器**没有自己的内容**，是把别的东西组合起来，
      // 所以「N 类模板」不能把容器算进去（早先 CLI 与文档检查都数错了这一点）。
      container: CONTAINER_TYPES.includes(t),
      note: TYPE_NOTES[t],
      fields: Object.fromEntries(Object.entries(FIELDS[t]).map(([k, kind]) => [k, {
        kind,
        required: !kind.endsWith('?'),
      }])),
      max: SHOT_MAXES[t] ?? {},
    }])),
    containers: CONTAINER_TYPES,
    // 效果词汇表：AI 写 effects 之前必须查得到（有界词汇表的全部意义就在这）。
    // 参数带范围，所以模型能自己判断合不合法，而不是写完撞校验。
    effects: {
      chainMax: EFFECT_CHAIN_MAX,
      types: Object.fromEntries(EFFECT_TYPES.map((t) => [t, {
        note: EFFECT_SPECS[t].note,
        params: Object.fromEntries(Object.entries(EFFECT_SPECS[t].params).map(([k, p]) => [k, {
          kind: p.kind,
          min: p.min,
          max: p.max,
          required: !!p.required,
          note: p.note,
        }])),
      }])),
    },
    errorCodes: SCENE_ERROR_CODES,
  };
}
