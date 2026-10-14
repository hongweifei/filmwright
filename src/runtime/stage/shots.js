// 镜头注册与串接。只声明 start，区间由这里算 —— 手算 from/to 会让区间重叠。
import {isValidTransform} from '../composite/layer.js';
import {compileAnimate} from '../scene/animate.js';
import {validateAnimate} from '../../contract/scene.js';
import {compileEffects} from '../fx/compile.js';
import {EFFECT_SPECS} from '../../contract/effects.js';

let SHOTS = [];

/**
 * 查一处的 `beat` 锚点是否可用（**只有绑定期才知道**的两条）。
 *
 * 为什么不能放在 contract 里：它们都要知道**该节点的节拍表**，
 * 而节拍表是编译期（templates.js）或手写镜头自己声明的 —— 到绑定这一步才齐。
 * 好消息是绑定发生在任何绘制之前，所以它仍是"绘制前就报"，不是渲染期崩。
 *
 * 形状层的校验（属性名/键序/缓动名/取值）已在 contract 里做过，这里不重复。
 */
function checkBeatAnchors(tracks, beats, s, what) {
  for (const [name, keys] of Object.entries(tracks ?? {})) {
    if (!Array.isArray(keys)) continue;              // contract 已报，这里跳过
    for (const k of keys) {
      if (!k || typeof k !== 'object' || k.beat === undefined) continue;
      if (!beats.length) {
        const e = new Error(
          `filmwright: 关键帧用了 beat 锚点，但这个节点没有节拍表（${what} ${name}，start=${s.start}）`);
        e.code = 'SCENE_ANIM_NO_BEATS';
        e.hint = '两条出路：改用 frame 锚点（节点内第几帧），或给这个节点声明 beats';
        throw e;
      }
      if (k.beat > beats.length) {
        const e = new Error(
          `filmwright: 关键帧用了第 ${k.beat} 拍，但这个节点只有 ${beats.length} 拍` +
          `（${what} ${name}，start=${s.start}）`);
        e.code = 'SCENE_ANIM_RANGE';
        e.hint = `这个节点的拍号是 1–${beats.length}`;
        throw e;
      }
    }
  }
}

/**
 * 编译一个节点的关键帧：`animate`（变换属性）与 `effects`（效果参数）**都编译**。
 *
 * 两处的 beat 锚点都要查 —— 效果参数的关键帧同样可能写到不存在的拍上，
 * 而 contract 只能查形状（它不知道拍数）。
 */
function compileNodeTracks(s) {
  const beats = Array.isArray(s.beats) ? s.beats : [];
  const node = {beats, from: s.start};
  if (s.animate) checkBeatAnchors(s.animate, beats, s, 'animate');
  // 效果参数里是**关键帧轨道**的那些也要查（静态数值没有 beat，会被跳过）
  for (const [i, fx] of (s.effects ?? []).entries()) {
    if (!fx || typeof fx !== 'object') continue;
    const spec = EFFECT_SPECS[fx.type];
    if (!spec) continue;
    const tracks = {};
    for (const [k, ps] of Object.entries(spec.params)) {
      if (Array.isArray(fx[k])) tracks[k] = fx[k];
    }
    checkBeatAnchors(tracks, beats, s, `effects[${i}]`);
  }
  return {anim: compileAnimate(s.animate, node), fx: compileEffects(s.effects, node)};
}

/**
 * 装上镜头表。每个镜头声明 `start`（从哪一帧接管画面）。
 * 覆盖自检：没有镜头接管的帧直接报错，而不是静默画空帧。
 */
export function setShots(list) {
  if (!Array.isArray(list) || list.length === 0) throw new Error('filmwright: 镜头表为空');
  const declared = [...list].sort((a, b) => a.start - b.start);
  for (const s of declared) {
    if (!Number.isFinite(s.start) || s.start < 1) {
      throw new Error('filmwright: 镜头 start 必须是 ≥1 的整数，收到 ' + s.start);
    }
    if (typeof s.draw !== 'function') {
      throw new Error('filmwright: 镜头缺少 draw 函数（start=' + s.start + '）');
    }
    // 可选的节拍声明（绝对帧号）：画质自检靠它区分「入场/离场」，把末拍稳定期
    // 从读数升级成硬判据。scene 模板自动带上；手写镜头自愿声明，不声明就维持原样。
    if (s.beats !== undefined) {
      if (!Array.isArray(s.beats) || s.beats.some((b) => !Number.isInteger(b) || b < 1)) {
        throw new Error('filmwright: 镜头 beats 必须是 ≥1 的整数帧号数组（start=' + s.start + '）');
      }
    }
    // 关键帧动画：形状校验与 scene.json 走**同一套规则**（手写镜头不走 scene 校验，
    // 所以在这里补上）。拍数相关的两条要到绑定期才知道，见 compileShotAnimate。
    if (s.animate !== undefined) {
      const errs = validateAnimate(s.animate, s.transform);
      if (errs.length) {
        const first = errs[0];
        const e = new Error(`filmwright: 镜头 animate 形状不对（start=${s.start}）：${first.message}`);
        e.code = first.code;
        e.hint = first.hint;
        throw e;
      }
    }
    // 可选的入场转场。**不破坏核心不变量**：两个镜头的 draw 都是只依赖 N 的纯函数，
    // 混合系数也是 N 的纯函数，所以「第 N 帧只是 N 的函数」仍然成立。
    if (s.transition !== undefined) {
      const tr = normalizeTransition(s.transition);
      if (!tr) {
        throw new Error('filmwright: 镜头 transition 形状不对（start=' + s.start +
          '）：要 {type:"crossfade"|"fade", frames:N}，或直接给帧数');
      }
    }
    // 可选的图层变换 / 混合模式（同样不破坏纯函数不变量：它只是 N 的函数）。
    if (s.transform !== undefined && !isValidTransform(s.transform)) {
      throw new Error('filmwright: 镜头 transform 形状不对（start=' + s.start + '）：' +
        JSON.stringify(s.transform) + '；可用字段 x/y/scale/rotate/alpha/blend/origin');
    }
  }
  for (let i = 1; i < declared.length; i++) {
    if (declared[i].start <= declared[i - 1].start) {
      throw new Error(
        `filmwright: 镜头 start 必须严格递增：${declared[i - 1].start} 之后是 ${declared[i].start}`);
    }
  }
  if (declared[0].start !== 1) {
    throw new Error('filmwright: 第一个镜头必须从第 1 帧开始，收到 ' + declared[0].start);
  }
  // 需要「上一个镜头」才有东西可混/可推的转场，第一个镜头不能用：
  // crossfade（没东西淡出）、slide（没东西被推走）、wipe（没东西被盖住）、
  // zoom（没东西淡出）。只有 fade 是从背景色淡入，第一个镜头可以用。
  const first = declared[0];
  if (first.transition) {
    const ft = normalizeTransition(first.transition);
    if (ft && ft.type !== 'fade') {
      throw new Error(`filmwright: 第一个镜头不能用 ${ft.type}（前面没有镜头可混合/推挤）；用 fade`);
    }
  }
  return declared;
}

/** 转场类型与方向（contract 层的校验用同一份名单）。 */
export const TRANSITION_TYPES = ['crossfade', 'fade', 'slide', 'wipe', 'zoom'];
export const DIRECTIONS = ['left', 'right', 'up', 'down'];

/**
 * 转场声明归一化。接受三种写法，统一成 `{type, frames, direction}`：
 *   `12`                                          → {type:'crossfade', frames:12, direction:null}
 *   `{type:'crossfade', frames:12}`               → 原样
 *   `{type:'slide', frames:20, direction:'left'}` → 带方向
 *
 * 非法返回 null（调用方报错，不静默忽略）。
 */
export function normalizeTransition(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') {
    return Number.isInteger(v) && v >= 1 ? {type: 'crossfade', frames: v, direction: null} : null;
  }
  if (typeof v !== 'object' || Array.isArray(v)) return null;
  const type = v.type ?? 'crossfade';
  if (!TRANSITION_TYPES.includes(type)) return null;
  if (!Number.isInteger(v.frames) || v.frames < 1) return null;
  let direction = v.direction ?? null;
  if (direction !== null && !DIRECTIONS.includes(direction)) return null;
  // 方向只对 slide / wipe 有意义：别的类型给了也**忽略**而不报错 ——
  // 报错会让「统一写 direction 的生成器」很难用，而忽略是无害的。
  if (type !== 'slide' && type !== 'wipe') direction = null;
  return {type, frames: v.frames, direction};
}

/**
 * 按总帧数串接成带 from/to 的区间表。
 * 与 setShots 分开，是因为总帧数要等时间轴装好才知道。
 */
export function bindShots(declared, totalFrames) {
  SHOTS = declared.map((s, i) => {
    const from = s.start;
    const to = i + 1 < declared.length ? declared[i + 1].start - 1 : totalFrames;
    return {...s, from, to, ...compileNodeTracks({...s, start: from})};
  });
  let cursor = 1;
  for (const s of SHOTS) {
    if (s.from !== cursor) throw new Error(`filmwright: 第 ${cursor}–${s.from - 1} 帧没有镜头接管`);
    cursor = s.to + 1;
  }
  if (cursor !== totalFrames + 1) {
    throw new Error(`filmwright: 镜头只覆盖到第 ${cursor - 1} 帧，时间轴共 ${totalFrames} 帧`);
  }
  return SHOTS;
}

export const shots = () => SHOTS;

export function shotAt(n) {
  for (const s of SHOTS) if (n >= s.from && n <= s.to) return s;
  return null;
}
