// 场景规格（scene.json）的数据层：校验 + 对齐解析 + 机器可读 schema。
// 纯函数 —— 不碰 DOM、不碰 Node，所以 Node 里的静态自检与浏览器里的模板编译器
// 共用这一份实现（不会漂移）。
//
// 规格是 AI 的落点：AI 只填内容与节拍，节奏（入场/呼吸/离场/配色）由模板镜头负责。
// 因此校验必须**可行动**：每条错误带 code / path / hint，模型读完能直接改。
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
];

/** 每类的容量上限（版面算出来的，超了会挤/溢出）。 */
export const SHOT_MAXES = {
  bullets: {items: 6},
  steps: {steps: 6},
  flow: {boxes: 5},
  code: {lines: 10},
  table: {columns: 4, rows: 8},
  chips: {items: 12},
  bars: {items: 6},
  compare: {items: 5},   // left.items / right.items 各
};

/** 全部错误码（schema 输出与源码扫描测试共用；新增码必须登记到这里）。 */
export const SCENE_ERROR_CODES = [
  'SCENE_NOT_OBJECT', 'SCENE_SCHEMA', 'SCENE_UNKNOWN_FIELD', 'SCENE_NO_SHOTS', 'SCENE_BAD_SHOT',
  'SCENE_UNKNOWN_TYPE', 'SCENE_MISSING_FIELD', 'SCENE_MISSING_AT', 'SCENE_BAD_FIELD',
  'SCENE_TOO_MANY', 'SCENE_TABLE_WIDTH', 'SCENE_NO_ASSET', 'SCENE_FIRST_NOT_1', 'SCENE_NOT_INCREASING',
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
  title: {title: 'str', sub: 'str?', en: 'str?', kicker: 'str?'},
  bullets: {heading: 'str?', items: 'arr<{t, d?}>'},
  stat: {value: 'num', label: 'str', unit: 'str?', label2: 'str?'},
  flow: {heading: 'str?', boxes: 'arr<{label, sub?}>'},
  code: {heading: 'str?', lines: 'arr<line>'},
  image: {asset: 'assets', heading: 'str?', note: 'str?'},
  compare: {heading: 'str?', left: 'side', right: 'side'},
  steps: {heading: 'str?', steps: 'arr<{t, d?}>'},
  table: {heading: 'str?', columns: 'arr<str>', rows: 'arr<row>'},
  quote: {text: 'text', who: 'str?', from: 'str?'},
  terminal: {heading: 'str?', title: 'str?', lines: 'arr<term>'},
  chips: {heading: 'str?', items: 'arr<chip>'},
  bars: {heading: 'str?', items: 'arr<bar>', unit: 'str?'},
};

/** 每类的说明（schema 输出给 agent 看，一句话讲清"什么时候用它"）。 */
const TYPE_NOTES = {
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
};

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
    errors.push(err('SCENE_BAD_FIELD', path, `必须是至少 ${min} 项的数组`, ''));
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
    }
  });
  return v.length;
}

const SHAPE_KEYS = {
  '{t, d?}': ['t', 'd'],
  step: ['t', 'd'],
  '{label, sub?}': ['label', 'sub'],
  line: ['text', 'mark'],
  term: ['text', 'color'],
  chip: ['label'],
  bar: ['v', 'label', 'unit'],
};
const SHAPE_HINT = {
  '{t, d?}': '例：{"t": "要点", "d": "说明"}',
  step: '例：{"t": "步骤名", "d": "说明"}',
  '{label, sub?}': '例：{"label": "环节"}',
  line: '字符串或 {"text": "…", "mark": "hl"}',
  term: '字符串或 {"text": "…", "color": "#…"}',
  chip: '字符串或 {"label": "关键词"}',
  bar: '例：{"v": 81, "label": "Chrome", "unit": "ms"}',
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
export function validateScene(raw, {timeline, assetNames} = {}) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(err('SCENE_NOT_OBJECT', 'scene', '场景规格必须是一个对象', '形如 {"shots": [...]}'));
    return {ok: false, errors};
  }
  if (raw.$schema !== undefined && raw.$schema !== SCENE_SCHEMA) {
    errors.push(err('SCENE_SCHEMA', '$schema', `不认识的结构版本 ${JSON.stringify(raw.$schema)}`,
      `用 "${SCENE_SCHEMA}"，或整个删掉`));
  }
  const topUnknown = Object.keys(raw).filter((k) => k !== '$schema' && k !== 'shots');
  if (topUnknown.length) {
    errors.push(err('SCENE_UNKNOWN_FIELD', topUnknown[0], `顶层未知字段 ${topUnknown.join(', ')}`, '顶层只认 $schema 与 shots'));
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
    const type = shot.type;
    if (!SHOT_TYPES.includes(type)) {
      errors.push(err('SCENE_UNKNOWN_TYPE', `${path}.type`, `不认识的镜头类型 ${JSON.stringify(type)}`,
        `可用：${SHOT_TYPES.join(' / ')}`));
    } else {
      const spec = FIELDS[type];
      const unknown = Object.keys(shot).filter((k) => k !== 'type' && k !== 'at' && !(k in spec));
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
      note: TYPE_NOTES[t],
      fields: Object.fromEntries(Object.entries(FIELDS[t]).map(([k, kind]) => [k, {
        kind,
        required: !kind.endsWith('?'),
      }])),
      max: SHOT_MAXES[t] ?? {},
    }])),
    errorCodes: SCENE_ERROR_CODES,
  };
}
