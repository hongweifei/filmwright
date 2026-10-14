// 效果链的编译：把 scene.json 的形状归一成求值用的内部形状。
//
// 与关键帧那一层同构（`runtime/scene/animate.js` 的 compileAnimate）：
//   · **编译期**做归一化（此刻校验刚过），求值期只剩算术；
//   · 与"节点"解耦 —— 只吃 effects 数组，不认识镜头或图层；
//   · **纯函数**：效果只依赖 `(编译结果, 帧号)`。
//
// 这一版参数只支持静态数值。关键帧参数（`"radius": [{beat:1,v:0},…]`）是设计里
// 明确要有的，属下一步 —— 那一步要先把"单条轨道"的校验从 validateAnimate
// 里抽出来共用，而不是复制一份规则。
import {EFFECT_SPECS} from '../../contract/effects.js';

/** 默认值来自契约（单一来源），只有契约未规定可选默认时才在这里补。 */
const DEFAULTS = {};

/**
 * @param {Array} effects  scene.json 里的 effects（已过 contract 校验）
 * @returns {{steps: Array<object>}|null}  没有 effects 时返回 **null**（调用方走快路径）
 */
export function compileEffects(effects) {
  if (!Array.isArray(effects) || !effects.length) return null;
  const steps = [];
  for (const fx of effects) {
    const spec = EFFECT_SPECS[fx.type];
    if (!spec) continue;                        // 校验期已报，这里跳过
    const step = {type: fx.type};
    for (const [k, ps] of Object.entries(spec.params)) {
      const v = fx[k];
      step[k] = v === undefined ? DEFAULTS[`${fx.type}.${k}`] ?? ps.min ?? 0 : v;
    }
    steps.push(step);
  }
  return steps.length ? {steps} : null;
}

/**
 * 整条链是否**全都是直通**（每个效果都在它的直通值上）。
 *
 * 用在校验之外的快速判断：全直通时不进 GPU，直接走原路 —— 这既是性能优化，
 * 也让"写了 effects 但参数恰好是直通值"的镜头输出与不写时一致。
 */
export function isNoopEffects(compiled) {
  if (!compiled) return true;
  for (const s of compiled.steps) {
    if (s.type === 'blur' && s.radius > 0) return false;
  }
  return true;
}
