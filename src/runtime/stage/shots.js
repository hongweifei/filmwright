// 镜头注册与串接。只声明 start，区间由这里算 —— 手算 from/to 会让区间重叠。
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
  return declared;
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
