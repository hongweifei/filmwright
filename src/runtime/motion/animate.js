// 关键帧动画：把镜头声明的 `animate` 编译成求值用的形状，再逐帧求值。
//
// 三条要点：
//
//   1. **编译期归一化**：`beat` → 绝对帧、缓动名 → 函数，都在编译期一次做完
//      （那时 beats 已算好、校验也刚过）。求值期只剩算术 —— 所以写错的
//      缓动名在编译期就报，而不是等到某一帧才炸。
//   2. **与节点解耦**：这个模块不认识"镜头"或"图层"，只吃 `{beats, from}`。
//      所以图层用自己那份 beats/from 传进来即可，求值器一行不用改。
//   3. **纯函数**：求值只依赖 `(编译结果, 帧号)` ⇒「第 N 帧只依赖 N」不受影响，
//      分片、跳帧、全量自检全部照旧。
import {EASES, kf} from './ease.js';
import {ANIM_PROPS} from '../../contract/animate.js';

// 可动画属性从 contract 引入（**单一来源**）：contract 是字段校验的归属层，
// runtime 依赖它符合分层规则。这里 re-export 只是为了调用方方便。
export {ANIM_PROPS};

/**
 * 把一处 `animate` 声明编译成 `{属性: [[绝对帧, 值, 缓动函数|null], ...]}`。
 *
 * 形状（已经过 contract 校验）：
 *   { "y": [{"beat": 1, "v": 40}, {"beat": 2, "v": 0, "ease": "out4"}], ... }
 *
 * @param {object} animate  镜头声明的 animate
 * @param {{beats?: number[], from: number}} node  该节点的时间信息
 * @returns {{[prop: string]: Array<[number, number, Function|null]>}|null}
 *          没有 animate 时返回 null（调用方据此走**快路径**，不分配、不合并）
 */
export function compileAnimate(animate, node) {
  if (!animate || typeof animate !== 'object') return null;
  const props = Object.keys(animate);
  if (!props.length) return null;

  const beats = node.beats || [];
  const from = node.from ?? 1;
  const out = {};
  for (const prop of props) {
    const keys = animate[prop];
    const compiled = [];
    for (const k of keys) {
      // beat / frame 都是 **1 起序数**（与 `S()` / `BLK()` 的序数口径一致）。
      // 内部换算：beat k → beats[k-1]；frame k → from + (k-1)。
      let abs;
      if (k.beat !== undefined) {
        const b = beats[k.beat - 1];
        if (b === undefined) {
          // 校验期应该已经拦住了（SCENE_ANIM_NO_BEATS / SCENE_ANIM_RANGE）；
          // 这里是防御，且消息要说清"实际有几拍"，便于定位。
          throw new Error(
            `filmwright: 关键帧用了第 ${k.beat} 拍，但这个节点只有 ${beats.length} 拍` +
            `（属性 ${prop}）`);
        }
        abs = b;
      } else {
        abs = from + (k.frame - 1);
      }
      compiled.push([abs, k.v, k.ease ? EASES[k.ease] : null]);
    }
    out[prop] = compiled;
  }
  return out;
}

/**
 * 求值：给出该节点在**这一帧**的部分 transform。
 *
 * @param {object|null} compiled  compileAnimate 的结果
 * @param {number} n              绝对帧号
 * @returns {object|null}         `{y: 12.3, alpha: 0.8}`；无 animate 时为 null
 */
export function evalAnimate(compiled, n) {
  if (!compiled) return null;
  let out = null;
  for (const prop of Object.keys(compiled)) {
    const v = kf(n, compiled[prop]);
    if (out === null) out = {};
    out[prop] = v;
  }
  return out;
}

/**
 * 合并「静态 transform」与「animate 求值结果」。
 *
 * 同名属性**不应同时出现**（contract 会报 `SCENE_ANIM_CONFLICT`），
 * 这里以 animate 为准只是防御。
 *
 * **没有 animate 时返回原对象**（不分配），这是保住快路径与像素回归的关键：
 * 没写 animate 的项目必须逐字节与之前相同。
 */
export function mergeAnimate(transform, compiled, n) {
  const anim = evalAnimate(compiled, n);
  if (!anim) return transform ?? null;
  return {...(transform ?? {}), ...anim};
}
