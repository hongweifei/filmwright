// 转场类型的**单一来源**。
//
// `runtime/stage/shots.js` 的 `normalizeTransition` 与报错文案都从这里取 ——
// 抄一份的代价是**实测到的**：那边曾经把可用名单写成 `crossfade|fade` 两种，
// 而真实名单有五种，用户照着报错去写 `slide` 会被自己的报错信息误导。
export const TRANSITION_TYPES = ['crossfade', 'fade', 'slide', 'wipe', 'zoom'];

export const TRANSITION_DIRECTIONS = ['left', 'right', 'up', 'down'];
