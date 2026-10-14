// 镜头注册与串接。只声明 start，区间由这里算 —— 手算 from/to 会让区间重叠。
import {isValidTransform} from '../composite/layer.js';

let SHOTS = [];

/**
 * 装上镜头表。每个镜头声明 `start`（从哪一帧接管画面），后面串接。
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
  // crossfade 需要「上一个镜头」才有东西可混；第一个镜头只能用 fade
  const first = declared[0];
  if (first.transition && normalizeTransition(first.transition).type === 'crossfade') {
    throw new Error('filmwright: 第一个镜头不能用 crossfade（前面没有镜头可混合）；用 fade');
  }
  return declared;
}

/** 转场声明归一化：数字 = crossfade 帧数；对象 = {type, frames}。非法返回 null。 */
export function normalizeTransition(v) {
  if (typeof v === 'number') {
    return Number.isInteger(v) && v >= 1 ? {type: 'crossfade', frames: v} : null;
  }
  if (!v || typeof v !== 'object') return null;
  const type = v.type ?? 'crossfade';
  if (type !== 'crossfade' && type !== 'fade') return null;
  if (!Number.isInteger(v.frames) || v.frames < 1) return null;
  return {type, frames: v.frames};
}

/**
 * 按总帧数串接成带 from/to 的区间表。
 * 与 setShots 分开，是因为总帧数要等时间轴装好才知道。
 */
export function bindShots(declared, totalFrames) {
  SHOTS = declared.map((s, i) => ({
    ...s,
    from: s.start,
    to: i + 1 < declared.length ? declared[i + 1].start - 1 : totalFrames,
  }));
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
