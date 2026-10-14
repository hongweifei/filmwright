// 效果链的**词汇表**：有哪些效果、每个有哪些参数、参数范围、默认值、恒等值。
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
// ## 每个参数三个字段各自的用途
//
//   · `min` / `max`   校验范围（越界报错，hint 里带实际范围）
//   · `def`           **可选参数缺省时的取值** —— 给的是"合理的默认效果"，不是直通值。
//                     比如 glow 的 radius 缺省 16：`{"type":"glow"}` 应该得到一个
//                     像样的辉光，而不是什么都不做。
//   · `noopWhen`      **直通条件**，一组条件之间是**「任一成立即直通」**（OR）。
//                     每个条件是一组"参数 = 值"（组内是 AND）。
//                     用于**逐帧短路**：直通的效果不产生 GPU 趟，也让"从 0 渐入"的
//                     第一帧与不写效果逐位一致。
//
// 为什么是 OR 而不是单个"恒等值"：glow 在 `intensity=0` **或** `radius=0` 时都等于
// 什么都没做，单个恒等值表达不了这种关系（第一版就卡在这）。
export const EFFECT_TYPES = ['blur', 'glow', 'color', 'vignette'];

export const EFFECT_SPECS = {
  blur: {
    note: '高斯模糊（可分离，多趟迭代）。radius=0 时直通，不产生额外趟',
    noopWhen: [{radius: 0}],
    params: {
      // 上限 36 不是随手定的：实现用"小核多趟"保证抽头间距始终 ≤2px（采样充分），
      // 36 是 16 趟能覆盖的范围。更大的半径要靠金字塔（降采样→小核→升采样），
      // 还没做；现在放开上限会出现"半径越大反而越锐"的振铃（实测过）。
      radius: {kind: 'num', min: 0, max: 36, required: true, note: '模糊半径（像素）'},
    },
  },

  glow: {
    note: '辉光/泛光：把亮度超过阈值的部分抽出来模糊，再叠加回原图。不给参数就是一次默认辉光',
    noopWhen: [{intensity: 0}, {radius: 0}],
    params: {
      radius: {kind: 'num', min: 0, max: 36, def: 16, note: '辉光扩散半径（像素）'},
      intensity: {kind: 'num', min: 0, max: 3, def: 0.8, note: '叠加强度'},
      threshold: {kind: 'num', min: 0, max: 1, def: 0.7,
        note: '亮度阈值：只有比它亮的像素才发光（调低则光晕铺得更开）'},
    },
  },

  color: {
    note: '调色：曝光 / 亮度 / 对比 / 饱和 / 色相 / 色温。参数都可省，但至少得给一个，否则是空转',
    // 全参数都在"什么都不改"的取值上 ⇒ 直通。注意这也是**唯一**的直通条件。
    noopWhen: [{brightness: 1, contrast: 1, saturation: 1, hue: 0, temperature: 0, exposure: 0}],
    params: {
      exposure: {kind: 'num', min: -4, max: 4, def: 0, note: '曝光补偿（EV，即 2^n 倍）'},
      brightness: {kind: 'num', min: 0, max: 4, def: 1, note: '亮度倍数'},
      contrast: {kind: 'num', min: 0, max: 4, def: 1, note: '对比度（围绕中灰）'},
      saturation: {kind: 'num', min: 0, max: 4, def: 1, note: '饱和度（0=灰度，1=原样）'},
      hue: {kind: 'num', min: -180, max: 180, def: 0, note: '色相旋转（度）'},
      temperature: {kind: 'num', min: -1, max: 1, def: 0, note: '色温：正=偏暖（加红减蓝）'},
    },
  },

  vignette: {
    note: '暗角：以中心为原点径向压暗',
    noopWhen: [{amount: 0}],
    params: {
      amount: {kind: 'num', min: 0, max: 1, required: true, note: '压暗强度（0=不变，1=最强）'},
      radius: {kind: 'num', min: 0.2, max: 2, def: 1, note: '暗角开始的位置（1 大约在画面边缘）'},
      softness: {kind: 'num', min: 0.01, max: 1, def: 0.5, note: '过渡柔和度（越大越平缓）'},
    },
  },
};

/** 一条效果链的长度上限：链越长越慢，且多半是写错了。 */
export const EFFECT_CHAIN_MAX = 12;

export const EFFECT_ERROR_CODES = [
  'SCENE_FX_SHAPE', 'SCENE_FX_TYPE', 'SCENE_FX_PARAM', 'SCENE_FX_RANGE', 'SCENE_FX_CHAIN',
];
