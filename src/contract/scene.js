// 场景规格（scene.json）的数据层：校验 + 对齐解析。纯函数——不碰 DOM、不碰 Node，
// 所以 Node 里的静态自检与浏览器里的模板编译器共用这一份实现（不会漂移）。
//
// 规格是 AI 的落点：AI 只填内容与节拍，节奏（入场/呼吸/离场/配色）由模板镜头负责。
// 因此校验必须**可行动**：每条错误带 code / path / hint，模型读完能直接改，
// 而不是一个「格式不对」。
//
// 对齐 token（at）：
//   12                      → 第 12 帧
//   "S05"                   → 该句开口前的静音里（= cutBefore('S05')，提前 8 帧）
//   {s:"S05"}               → 同上
//   {s:"S05", lead:12}      → 提前 12 帧
//   {s:"S05", block:2}      → 锚在该句第 2 个字幕块的起点（再按 lead 提前）
//   {s:"S05", block:2, offset:-4} → 锚点后再偏移（负数=更早）
// 结果下限 1 帧。句 id / 块号不存在 → 报错并说明有几块。

/** 规格结构版本。写错或没写都按 v0 处理；写了别的值直接报。 */
export const SCENE_SCHEMA = 'filmwright/scene-v0';

/** 模板镜头类型。运行时的注册表必须与这里一致（有测试钉住）。 */
export const SHOT_TYPES = ['title', 'bullets', 'stat', 'flow', 'code', 'image', 'compare'];

// ---------- 时间轴数据的纯查询（与 contract/timeline.js 的 S/BLK 语义一致，有测试钉住） ----------

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

// ---------- 每类的字段规格（校验与文档共用这一份声明） ----------
// 取值：'str' 必填字符串；'str?' 可选字符串；'num' 必填数；'arr' 必填非空数组；
// 'obj' 必填对象；'assets' 素材名（须在配置声明过）。其余键一律视为未知字段。
const FIELDS = {
  title: {title: 'str', sub: 'str?', en: 'str?', kicker: 'str?'},
  bullets: {heading: 'str?', items: 'arr<{t, d?}>'},
  stat: {value: 'num', label: 'str', unit: 'str?', label2: 'str?'},
  flow: {heading: 'str?', boxes: 'arr<{label, sub?}>'},
  code: {heading: 'str?', lines: 'arr<line>'},
  image: {asset: 'assets', heading: 'str?', note: 'str?'},
  compare: {heading: 'str?', left: 'obj', right: 'obj'},
};

const err = (code, path, message, hint) => ({code, path, message, hint});

function checkStr(v, path, name, errors, required) {
  if (v === undefined) {
    if (required) errors.push(err('SCENE_MISSING_FIELD', path, `${name} 必填`, `补上 ${name}（非空字符串）`));
    return;
  }
  if (typeof v !== 'string' || !v.length) {
    errors.push(err('SCENE_BAD_FIELD', path, `${name} 必须是非空字符串，收到 ${JSON.stringify(v)}`,
      '文本字段写字符串；没有就整个键删掉'));
  }
}

function validateItems(v, path, errors) {
  if (!Array.isArray(v) || v.length === 0) {
    errors.push(err('SCENE_BAD_FIELD', path, 'items 必须是非空数组', '至少一条 {t, d?}'));
    return;
  }
  v.forEach((it, i) => {
    const p = `${path}[${i}]`;
    if (!it || typeof it !== 'object') {
      errors.push(err('SCENE_BAD_FIELD', p, '条目必须是 {t, d?}', '例：{"t": "标题", "d": "说明"}'));
      return;
    }
    const unknown = Object.keys(it).filter((k) => k !== 't' && k !== 'd');
    if (unknown.length) {
      errors.push(err('SCENE_UNKNOWN_FIELD', `${p}.${unknown[0]}`, `未知字段 ${unknown.join(', ')}`,
        '模板没有这个字段；拼错了就改对，想自定义画面上报镜头层（shots/index.js）'));
    }
    checkStr(it.t, `${p}.t`, 't', errors, true);
    if (it.d !== undefined) checkStr(it.d, `${p}.d`, 'd', errors, false);
  });
}

function validateSide(v, path, errors) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    errors.push(err('SCENE_BAD_FIELD', path, '必须是 {title, items}', '例：{"title": "旧做法", "items": ["…"]}'));
    return;
  }
  const unknown = Object.keys(v).filter((k) => k !== 'title' && k !== 'items');
  if (unknown.length) errors.push(err('SCENE_UNKNOWN_FIELD', `${path}.${unknown[0]}`, `未知字段 ${unknown.join(', ')}`, ''));
  checkStr(v.title, `${path}.title`, 'title', errors, true);
  if (!Array.isArray(v.items) || v.items.length === 0) {
    errors.push(err('SCENE_BAD_FIELD', `${path}.items`, 'items 必须是非空数组', '字符串数组即可'));
  } else {
    v.items.forEach((s, i) => checkStr(s, `${path}.items[${i}]`, 'items[' + i + ']', errors, true));
  }
}

/**
 * 校验场景规格。
 * @param {object} raw scene.json 解析结果
 * @param {{timeline: object, assetNames?: string[]}} ctx 时间轴数据（resolveAt 用）；
 *        assetNames 给了才交叉校验 image.asset（没给就只查形状）
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
    errors.push(err('SCENE_UNKNOWN_FIELD', topUnknown[0], `顶层未知字段 ${topUnknown.join(', ')}`,
      '顶层只认 $schema 与 shots'));
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
        `v0 可用：${SHOT_TYPES.join(' / ')}`));
      // 类型都不对，字段没法查；继续查下一个镜头
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
        switch (kind) {
          case 'str': checkStr(v, p, k, errors, true); break;
          case 'str?': if (v !== undefined) checkStr(v, p, k, errors, false); break;
          case 'num':
            if (v === undefined) errors.push(err('SCENE_MISSING_FIELD', p, `${k} 必填`, '数值，例如 81'));
            else if (typeof v !== 'number' || !Number.isFinite(v)) {
              errors.push(err('SCENE_BAD_FIELD', p, `${k} 必须是数字，收到 ${JSON.stringify(v)}`, '别写成字符串'));
            }
            break;
          case 'obj':
            if (type === 'compare') validateSide(v, p, errors);
            break;
          case 'assets':
            if (v === undefined) errors.push(err('SCENE_MISSING_FIELD', p, 'asset 必填', '素材名，见配置的 assets'));
            else if (typeof v !== 'string' || !v) {
              errors.push(err('SCENE_BAD_FIELD', p, 'asset 必须是非空字符串', ''));
            } else if (assetNames && !assetNames.includes(v)) {
              errors.push(err('SCENE_NO_ASSET', p, `素材 ${JSON.stringify(v)} 没在配置里声明`,
                `已声明：${assetNames.join(' / ') || '（无）'}`));
            }
            break;
          case 'arr<{t, d?}>': validateItems(v, p, errors); break;
          case 'arr<{label, sub?}>':
            if (!Array.isArray(v) || v.length < 2) {
              errors.push(err('SCENE_BAD_FIELD', p, 'boxes 必须是至少 2 项的数组', '流程至少两步'));
            } else {
              v.forEach((b, j) => {
                const bp = `${p}[${j}]`;
                if (!b || typeof b !== 'object') errors.push(err('SCENE_BAD_FIELD', bp, '必须是 {label, sub?}', ''));
                else {
                  const unk = Object.keys(b).filter((k) => k !== 'label' && k !== 'sub');
                  if (unk.length) errors.push(err('SCENE_UNKNOWN_FIELD', `${bp}.${unk[0]}`, `未知字段 ${unk.join(', ')}`, ''));
                  checkStr(b.label, `${bp}.label`, 'label', errors, true);
                  if (b.sub !== undefined) checkStr(b.sub, `${bp}.sub`, 'sub', errors, false);
                }
              });
            }
            break;
          case 'arr<line>':
            if (!Array.isArray(v) || v.length === 0) {
              errors.push(err('SCENE_BAD_FIELD', p, 'lines 必须是非空数组', '字符串或 {text, mark?}'));
            } else {
              v.forEach((l, j) => {
                const lp = `${p}[${j}]`;
                if (typeof l === 'string') return;
                if (!l || typeof l !== 'object' || typeof l.text !== 'string') {
                  errors.push(err('SCENE_BAD_FIELD', lp, '行必须是字符串或 {text, mark?}', ''));
                } else if (l.mark !== undefined && !['add', 'hl', 'err', 'ok'].includes(l.mark)) {
                  errors.push(err('SCENE_BAD_FIELD', `${lp}.mark`, `不认识的高亮 ${JSON.stringify(l.mark)}`,
                    '可用：add / hl / err / ok'));
                }
              });
            }
            break;
        }
      }
    }
    // 对齐
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
