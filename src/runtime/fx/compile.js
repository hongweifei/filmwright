// 效果链的编译与求值。
//
// 与关键帧那一层同构（`runtime/motion/animate.js`）：
//   · **编译期**做归一化（`beat` → 绝对帧、缓动名 → 函数），求值期只剩算术；
//   · 与"节点"解耦 —— 只吃 effects 数组 + `{beats, from}`，不认识镜头或图层；
//   · **纯函数**：效果只依赖 `(编译结果, 帧号)`。
//
// 参数可以是**静态数值**，也可以是**关键帧轨道**（让模糊渐入、辉光脉冲）。
// 轨道的编译直接复用 `compileAnimate` —— 规则不复制第二份。
import {EFFECT_SPECS, GRADE_LOOKS} from '../../contract/effects.js';
import {kf} from '../motion/ease.js';
import {compileAnimate} from '../motion/animate.js';

/** `color` 的恒等值（`grade` 插值的起点）。与 contract 里 color 的 identity 一致。 */
const COLOR_IDENTITY = {exposure: 0, brightness: 1, contrast: 1, saturation: 1, hue: 0, temperature: 0};

/**
 * @param {Array} effects  镜头声明的 effects（已过 contract 校验）
 * @param {{beats?: number[], from: number}} node 宿主节点的时间信息
 * @returns {{steps: Array<object>}|null}  没有 effects 时返回 **null**（调用方走快路径）
 */
export function compileEffects(effects, node) {
  if (!Array.isArray(effects) || !effects.length) return null;
  const steps = [];
  for (const fx of effects) {
    const spec = EFFECT_SPECS[fx.type];
    if (!spec) continue;                        // 校验期已报，这里跳过
    // `grade` 是**预设**：编译期展开成一个 `color` 步骤。
    // 这样它不需要自己的着色器，连短路判据（color 的 noopWhen）都是现成的。
    // `amount` 在恒等值与该预设之间插值：0 ⇒ 全恒等 ⇒ 被判为直通、根本不进 GPU。
    if (fx.type === 'grade') {
      const look = GRADE_LOOKS[fx.look];
      if (!look) continue;                      // 校验期已报
      const a = fx.amount ?? 1;
      const st = {};
      for (const [k, idv] of Object.entries(COLOR_IDENTITY)) {
        const target = look.params[k] ?? idv;
        st[k] = idv + (target - idv) * a;
      }
      steps.push({type: 'color', static: st, tracks: {}});
      continue;
    }
    // `custom`：参数形状与别的效果不同（`src` 是字符串、`uniforms` 是嵌套对象），
    // 通用的"遍历 spec.params"表达不了它 ⇒ 单独一条分支。
    // `src` **原样**带进编译结果（编译与缓存由 GL 舞台按源码字符串做，见 fx/stage.js）。
    if (fx.type === 'custom') {
      const statics = {};
      const tracks = {};
      for (const [k, v] of Object.entries(fx.uniforms ?? {})) {
        if (Array.isArray(v)) {
          const compiled = compileAnimate({[k]: v}, node ?? {from: 1});
          tracks[k] = compiled ? compiled[k] : null;
          statics[k] = null;
        } else {
          statics[k] = v;
          tracks[k] = null;
        }
      }
      steps.push({type: 'custom', src: fx.src, static: statics, tracks});
      continue;
    }
    const step = {type: fx.type, static: {}, tracks: {}};
    for (const [k, ps] of Object.entries(spec.params)) {
      const v = fx[k];
      if (Array.isArray(v)) {
        // 关键帧参数：编译期解析 beat → 绝对帧、缓动名 → 函数
        const compiled = compileAnimate({[k]: v}, node ?? {from: 1});
        step.tracks[k] = compiled ? compiled[k] : null;
        step.static[k] = null;
      } else {
        // 缺省值取契约里的 `def` —— 它**必须是恒等值**（见 contract/effects.js 的说明），
        // 否则"没写这个参数"会悄悄改变画面。
        step.static[k] = v === undefined ? (ps.def ?? ps.min ?? 0) : v;
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
    // `custom` 的源码不是"参数"，但它要跟着这一帧一起交给 GL 舞台（缓存键就是它）
    if (s.src !== undefined) out.src = s.src;
    for (const k of Object.keys(s.static)) {
      const track = s.tracks[k];
      out[k] = track ? kf(n, track) : s.static[k];
    }
    return out;
  });
}

/**
 * 整条链在**这一帧**是否全是直通（每个效果都命中它的直通条件）。
 *
 * 判据来自契约里的 `noopWhen`（**数据驱动**，不在这里写死各效果的逻辑）——
 * 每加一个效果不需要改这个函数。一组条件之间是「任一成立即直通」（OR），
 * 因为像 glow 这种 `intensity=0` 或 `radius=0` 都等于没做。
 *
 * 注意要**按帧**判：`radius` 可以是关键帧轨道，"第 1 帧是 0、第 30 帧是 12" 这种
 * 在第 1 帧确实是直通的 —— 那一帧不该进 GPU（省一趟，也让"从 0 开始"的渐入
 * 在起点上与不写效果**逐位一致**）。
 */
export function isNoopEffects(compiled, n) {
  if (!compiled) return true;
  for (const s of evalEffects(compiled, n)) {
    const conds = EFFECT_SPECS[s.type]?.noopWhen;
    if (!conds || !conds.length) return false;      // 没标直通条件的，一律当作有效果
    const hit = conds.some((cond) =>
      Object.entries(cond).every(([k, want]) => Math.abs((s[k] ?? want) - want) < 1e-9));
    if (!hit) return false;
  }
  return true;
}
