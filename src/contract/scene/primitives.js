// 共用校验原语：报错构造、字段形状检查、关键帧轨道，以及两个词汇表校验器。
// 各叶子校验器（效果 / 遮罩 / 3D / 层）都只依赖这里。
import {SHOT_MAXES, TRANSITION_TYPES, TRANSITION_DIRECTIONS, BLENDS, ANIM_PROPS, EASE_NAMES} from './tables.js';


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
 * 与 `runtime/composite/layer.js` 的同名函数**判的是同一套规则**：`BLEND_MODES` 已上提到
 * 本文件，两份都查白名单（原先只有 runtime 查，见 `BLEND_MODES` 的注释：那让 scene.json
 * 的非法混合模式静默降级成 `source-over`）。
 *
 * `contract` 仍然不能 import `runtime`（分层规则）—— 现在是 runtime 反过来 import contract，
 * 方向是对的。
 */
export function isValidTransform(t) {
  if (t === undefined || t === null) return true;
  if (typeof t !== 'object' || Array.isArray(t)) return false;
  const num = (v) => v === undefined || (typeof v === 'number' && Number.isFinite(v));
  if (!num(t.x) || !num(t.y) || !num(t.scale) || !num(t.rotate)) return false;
  if (t.scale !== undefined && t.scale <= 0) return false;
  if (t.alpha !== undefined && !(typeof t.alpha === 'number' && t.alpha >= 0 && t.alpha <= 1)) return false;
  if (t.blend !== undefined && !BLENDS.has(t.blend)) return false;
  if (t.origin !== undefined) {
    if (!Array.isArray(t.origin) || t.origin.length !== 2) return false;
    if (!t.origin.every((v) => typeof v === 'number' && Number.isFinite(v))) return false;
  }
  return true;
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
export function validateKeyTrack(keys, where, {valueNote = '', checkValue = null} = {}) {
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


/** 各种形状错误的说明（校验与 schema 共用）。 */
export const err = (code, path, message, hint) => ({code, path, message, hint});


export function checkStr(v, path, name, errors, required, kind = 'str') {
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
export function validateArr(v, path, shape, errors, {min = 1, maxName, shot} = {}) {
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


export const SHAPE_KEYS = {
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

export const SHAPE_HINT = {
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


export function validateSide(v, path, errors, owner) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    errors.push(err('SCENE_BAD_FIELD', path, '必须是 {title, items}', '例：{"title": "旧做法", "items": ["…"]}'));
    return;
  }
  const unknown = Object.keys(v).filter((k) => k !== 'title' && k !== 'items');
  if (unknown.length) errors.push(err('SCENE_UNKNOWN_FIELD', `${path}.${unknown[0]}`, `未知字段 ${unknown.join(', ')}`, ''));
  checkStr(v.title, `${path}.title`, 'title', errors, true);
  validateArr(v.items, `${path}.items`, 'str', errors, {min: 1, maxName: {owner: 'compare', key: 'items'}, shot: {}});
}
