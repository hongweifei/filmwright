// 缓动与确定性伪随机。全部纯函数，同一帧永远得到同一个结果。
export const clamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const inv = (t, a, b) => (b === a ? 1 : clamp((t - a) / (b - a)));

export const easeOut3 = (t) => 1 - Math.pow(1 - clamp(t), 3);
export const easeOut4 = (t) => 1 - Math.pow(1 - clamp(t), 4);
export const easeIn3 = (t) => Math.pow(clamp(t), 3);
export const easeInOut = (t) => {
  const x = clamp(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};
export const easeOutBack = (t) => {
  const c1 = 1.70158, c3 = c1 + 1, x = clamp(t);
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
};
/** 0→1→0 的脉冲，中心在 center，半宽 w。 */
export const pulse = (t, center, w) => Math.max(0, 1 - Math.abs(t - center) / w);

/** 确定性哈希随机：[0,1)。同一 seed 永远同一串。 */
export const rnd = (seed) => {
  let x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/** 分段关键帧；t 小于首帧返回首值。 */
export const kf = (t, keys) => {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, v0] = keys[i - 1], [t1, v1] = keys[i];
      return lerp(v0, v1, inv(t, t0, t1));
    }
  }
  return keys[keys.length - 1][1];
};

/** 入场：f0 起 dur 帧内从 y+dy 升到位并淡入（首帧 = 0，不会先亮一帧）。 */
export const enter = (n, f0, dur = 14, dy = 26) => {
  const t = inv(n, f0, f0 + dur);
  return {a: easeOut3(t), dy: (1 - easeOut3(t)) * dy};
};
/** 离场：末 f1 帧内上移淡出，末帧归零。 */
export const exit = (n, f1, dur = 12, dy = 22) => {
  const t = inv(n, f1 - dur, f1);
  return {a: 1 - easeIn3(t), dy: -easeIn3(t) * dy};
};
