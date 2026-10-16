// 关键帧的**字段校验**：`animate`（变换属性）与效果参数里的轨道共用这一份。
//
// ## 为什么在 contract
//
// 关键帧的形状校验原先在 contract 与 runtime **各写一套**，实测漂移过 ——
// 现在规则只有一份：`runtime/stage/shots.js` 在 `setShots` 时直接调这里，
// 所以「写错当场报」对两种写法同时成立。
//
// ## 为什么拍数相关的两条不在这里
//
// `beat` 超出拍数、节点没有节拍表 —— 这两条要知道**该节点的节拍表**，
// 而节拍表是手写镜头自己声明的，到绑定期才齐。它们在 `runtime/stage/shots.js` 里查，
// 码（`SCENE_ANIM_RANGE` / `SCENE_ANIM_NO_BEATS`）仍登记在本文件的 `ANIM_ERROR_CODES` 里。
import {err} from './errors.js';

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
 * （`tests/animate.test.mjs` 断言「名字集合」与「实现集合」一一对应）。
 *
 * 为什么只给词汇表、不做自定义贝塞尔：贝塞尔是 4 个数字，**AI 无法推理**，
 * 产出会变成"随手填的参数"，也无法静态判断好坏 —— 观感差异主要来自时机与层次。
 */
export const EASE_NAMES = ['linear', 'out3', 'out4', 'in3', 'inout3', 'back', 'step'];

/** 关键帧这一族的全部错误码（后两个在 `runtime/stage/shots.js` 的绑定期抛出）。 */
export const ANIM_ERROR_CODES = [
  'SCENE_ANIM_SHAPE', 'SCENE_ANIM_PROP', 'SCENE_ANIM_KEY', 'SCENE_ANIM_EASE',
  'SCENE_ANIM_ORDER', 'SCENE_ANIM_CONFLICT', 'SCENE_ANIM_VALUE',
  'SCENE_ANIM_RANGE', 'SCENE_ANIM_NO_BEATS',
];

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

/**
 * 校验一处 `animate`（形状层，不需要节拍表）。
 *
 * @param {object} animate `{属性: [关键帧…]}`
 * @param {object} [transform] 该节点的静态 transform —— 同名属性同时出现在两处是歧义，要报
 * @returns {Array} 错误数组（可能为空）
 */
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
