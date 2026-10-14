// 效果链的**词汇表**：有哪些效果、每个有哪些参数、参数范围。
//
// 这是 contract 层的一部分（schema 的归属），所以放在 contract 下 —— runtime 依赖它。
//
// ## 为什么是"有界词汇表"而不是"一段 shader"
//
// AI 要能写对、校验要能拦住。所以：
//   · 效果是**枚举类型 + 有界参数**，不是任意着色器源码；
//   · 参数有类型与范围，越界在**校验期**报错（带实际范围，便于 AI 自己改对）；
//   · 不提供"自定义 shader"逃生舱 —— 真要就把它做成一个具名效果。
//
// v1 目标 11 个效果，本文件先落 `blur`，
// 因为最小闭环只做一条以证明「上传 → 效果 → 取回」这条路通）。

/** v1 第一步先落一个效果；其余按设计清单逐个加。 */
export const EFFECT_TYPES = ['blur'];

/**
 * 每个效果的规格。
 *
 * `params[k]`：{kind, min?, max?, required?, note}
 * 目前只支持数值参数（静态值）。**关键帧参数**（`"radius": [{beat:1,v:0},…]`）
 * 是设计里明确要有的，放在下一步 —— 那一步要先把关键帧的"单条轨道"校验
 * 从 validateAnimate 里抽出来共用，而不是复制一份规则。
 */
export const EFFECT_SPECS = {
  blur: {
    note: '高斯模糊（可分离，多趟迭代）。radius=0 时直通，不产生额外趟',
    params: {
      // 上限 36 不是随手定的：实现用"小核多趟"保证抽头间距始终 ≤2px（采样充分），
      // 36 是 16 趟能覆盖的范围。更大的半径要靠金字塔（降采样→小核→升采样），
      // 那是下一步；现在放开上限会出现"半径越大反而越锐"的振铃（实测过）。
      radius: {kind: 'num', min: 0, max: 36, required: true, note: '模糊半径（像素）'},
    },
  },
};

/** 一条效果链的长度上限：链越长越慢，且多半是写错了。 */
export const EFFECT_CHAIN_MAX = 12;

export const EFFECT_ERROR_CODES = [
  'SCENE_FX_SHAPE', 'SCENE_FX_TYPE', 'SCENE_FX_PARAM', 'SCENE_FX_RANGE', 'SCENE_FX_CHAIN',
];
