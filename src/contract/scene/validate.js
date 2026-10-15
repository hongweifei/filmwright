// 总调度：`validateScene` 与机器可读 schema。它是唯一把各部分串起来的地方。
import {EFFECT_TYPES, EFFECT_SPECS, EFFECT_CHAIN_MAX, EFFECT_ERROR_CODES} from '../effects.js';
import {SCENE_SCHEMA, SHOT_TYPES, CONTAINER_TYPES, SHOT_MAXES, SCENE_ERROR_CODES, FIELDS, TYPE_NOTES, TRANSITION_TYPES, TRANSITION_DIRECTIONS, TRANSFORM_HINT} from './tables.js';
import {resolveAt} from './timelineQuery.js';
import {isValidTransition, isValidTransform, validateAnimate, err, checkStr, validateArr, validateSide} from './primitives.js';
import {validateEffects} from './effects.js';
import {validateMask} from './mask.js';
import {validate3D} from './three.js';
import {validateLayers} from './layers.js';


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
        TRANSFORM_HINT));
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

