// 效果链校验（叶子：只依赖共用原语）。
import {EFFECT_TYPES, EFFECT_SPECS, EFFECT_CHAIN_MAX, EFFECT_ERROR_CODES} from '../effects.js';
import {validateKeyTrack, err} from './primitives.js';


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
