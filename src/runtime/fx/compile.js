// 效果链的编译与求值。
//
// 与关键帧那一层同构（`runtime/scene/animate.js`）：
//   · **编译期**做归一化（`beat` → 绝对帧、缓动名 → 函数），求值期只剩算术；
//   · 与"节点"解耦 —— 只吃 effects 数组 + `{beats, from}`，不认识镜头或图层；
//   · **纯函数**：效果只依赖 `(编译结果, 帧号)`。
//
// 参数可以是**静态数值**，也可以是**关键帧轨道**（让模糊渐入、辉光脉冲）。
// 轨道的编译直接复用 `compileAnimate` —— 规则不复制第二份。
import {EFFECT_SPECS} from '../../contract/effects.js';
import {kf} from '../motion/ease.js';
import {compileAnimate} from '../scene/animate.js';

/** 默认值来自契约（单一来源），只有契约未规定可选默认时才在这里补。 */
const DEFAULTS = {};

/**
 * @param {Array} effects  scene.json 里的 effects（已过 contract 校验）
 * @param {{beats?: number[], from: number}} node 宿主节点的时间信息
 * @returns {{steps: Array<object>}|null}  没有 effects 时返回 **null**（调用方走快路径）
 */
export function compileEffects(effects, node) {
  if (!Array.isArray(effects) || !effects.length) return null;
  const steps = [];
  for (const fx of effects) {
    const spec = EFFECT_SPECS[fx.type];
    if (!spec) continue;                        // 校验期已报，这里跳过
    const step = {type: fx.type, static: {}, tracks: {}};
    for (const [k, ps] of Object.entries(spec.params)) {
      const v = fx[k];
      if (Array.isArray(v)) {
        // 关键帧参数：编译期解析 beat → 绝对帧、缓动名 → 函数
        const compiled = compileAnimate({[k]: v}, node ?? {from: 1});
        step.tracks[k] = compiled ? compiled[k] : null;
        step.static[k] = null;
      } else {
        step.static[k] = v === undefined ? (DEFAULTS[`${fx.type}.${k}`] ?? ps.min ?? 0) : v;
        step.tracks[k] = null;
      }
    }
    steps.push(step);
  }
  return steps.length ? {steps} : null;
}

/**
 * 求值：把**这一帧**的效果参数算出来。
 * @returns {Array<{type: string, [param: string]: number}>}
 */
export function evalEffects(compiled, n) {
  if (!compiled) return [];
  return compiled.steps.map((s) => {
    const out = {type: s.type};
    for (const k of Object.keys(s.static)) {
      const track = s.tracks[k];
      out[k] = track ? kf(n, track) : s.static[k];
    }
    return out;
  });
}

/**
 * 整条链在**这一帧**是否全是直通（每个效果都在它的直通值上）。
 *
 * 注意要按帧判：`radius` 可以是关键帧轨道，"第 1 帧是 0、第 30 帧是 12" 这种
 * 在第 1 帧确实是直通的 —— 那一帧不该进 GPU（省一趟，也让"从 0 开始"的渐入
 * 在起点上与不写效果**逐位一致**）。
 */
export function isNoopEffects(compiled, n) {
  if (!compiled) return true;
  for (const s of evalEffects(compiled, n)) {
    if (s.type === 'blur' && s.radius > 0) return false;
  }
  return true;
}
