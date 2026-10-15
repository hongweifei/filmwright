// 模糊半径 → 金字塔层数 / 每层半径的**纯数学**。零 GL 依赖，可以单独单测。


/** 模糊的趟数与抽头间距。抽头间距 ≤2px 是"采样充分"的保证（见 blurTex 注释）。 */
export function blurPlan(radius) {
  const sigmaTotal = Math.max(radius, 0) / 3;
  const SIGMA_PER_PASS = 3;   // 间距 = 3s，要 ≤2px ⇒ s ≤ 2/3 ⇒ σ ≤ 4.5·(2/3) = 3
  const n = Math.max(1, Math.min(16, Math.ceil((sigmaTotal / SIGMA_PER_PASS) ** 2)));
  return {n, s: (sigmaTotal / Math.sqrt(n)) / 4.5};
}


/**
 * 金字塔层数：全分辨率上小核能"采样充分"地处理到约 16px 半径；
 * 再大就**降采样 → 在低分辨率上用小核 → 升采样**。
 *
 * 为什么要这样：小核的抽头间距必须 ≤2px 才不会变成稀疏采样（否则出振铃，
 * 实测过"半径越大反而越锐"）。半径越大，要么趟数爆炸（O(σ²) 趟），
 * 要么间距变稀。降采样把这两个问题一起解决 —— 在低分辨率上，
 * 同样的像素间距对应更大的实际半径，而趟数只取决于**降采样后的**半径。
 *
 * 上限 4 层（1/16）是经验值：再降就只剩几十个像素，bilinear 升采样会明显块状。
 */
export function pyramidLevel(radius) {
  const L = Math.floor(Math.log2(Math.max(radius, 1) / 16));
  return Math.max(0, Math.min(4, L));
}
