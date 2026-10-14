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

/** 硬切：u < 1 时保持前一键的值，到 u == 1 才跳变。给"无过渡"的状态切换用。 */
export const step = (t) => (clamp(t) >= 1 ? 1 : 0);

/**
 * 缓动词汇表：**名字 → 函数**。
 *
 * 这是给 `scene.json` 的 `animate` 用的**有界**词汇（AI 要能写对、校验要能拦住）。
 * 名字取现有导出名去掉 `ease` 前缀，让代码与 JSON 的名字对得上、能 grep。
 *
 * 为什么只给词汇表、不给自定义贝塞尔：贝塞尔是 4 个数字，**AI 无法推理**，
 * 产出会变成"随手填的参数"，也无法静态判断好坏。观感的差异主要来自
 * **时机与层次**，不来自曲线的精细形状。
 */
export const EASES = {
  linear: (t) => clamp(t),
  out3: easeOut3,
  out4: easeOut4,
  in3: easeIn3,
  inout3: easeInOut,
  back: easeOutBack,
  step,
};

/** 缓动名白名单（校验与错误提示共用，避免两处规则漂移）。 */
export const EASE_NAMES = Object.keys(EASES);

/** 分段关键帧；t 小于首帧返回首值，大于末帧返回末值（**夹紧，不外推**）。
 *
 * `keys` 是 `[[t, value], [t, value, easeFn], ...]`：
 * 第 3 项是「**走到这一键**所用的缓动」，不传即线性。
 *
 * 两个刻意的设计：
 *   · **夹紧不外推** —— 外推（"y 从 40 到 0 继续往负走"）是"元素无声飞出画面"
 *     的主要来源，且很难查；
 *   · **缓动作用在归一化进度 u 上**，不作用在值差上 —— 保证 ease(0)=0、ease(1)=1，
 *     关键帧处的值**精确落位**，不因缓动而有微小偏差。
 *
 * 扩展方式保持向后兼容：原来只传 `[t, v]` 的调用方行为**不变**（默认线性）。
 */
export const kf = (t, keys) => {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, v0] = keys[i - 1];
      const [t1, v1, e] = keys[i];
      const u = inv(t, t0, t1);
      return lerp(v0, v1, e ? e(u) : u);
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
