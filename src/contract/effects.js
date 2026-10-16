// 效果链的**词汇表**：有哪些效果、每个有哪些参数、参数范围、默认值、恒等值。
// 外加**校验**（`validateEffects`，在文件末尾）—— 手写镜头的 `effects` 字段
// 由 `runtime/stage/shots.js` 在 `setShots` 时调它，写错当场报。
//
// 这是 contract 层的一部分，所以放在 contract 下 —— runtime 依赖它。
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
import {err} from './errors.js';
import {validateKeyTrack} from './animate.js';

export const EFFECT_TYPES = ['blur', 'glow', 'color', 'vignette', 'chromatic', 'grain', 'pixelate', 'radialBlur', 'distort', 'grade', 'displace'];

/**
 * 调色预设（`grade`）。
 *
 * 每个预设就是一**组 `color` 参数** —— 所以 `grade` 不需要自己的着色器：
 * 编译期把它展开成一个 `color` 步骤即可，连短路判据（`noopWhen`）都是现成的。
 *
 * `amount` 在**恒等值与该预设之间插值**：0 直通、1 全量、0.5 一半。
 * 这样"轻微加一点电影感"不用自己算参数。
 */
export const GRADE_LOOKS = {
  'teal-orange': {note: '青橙（商业片最常见的冷暖对比）',
    params: {saturation: 1.18, contrast: 1.12, temperature: 0.28, hue: -8}},
  filmic: {note: '电影感（略压饱和、抬对比）',
    params: {saturation: 0.88, contrast: 1.22, brightness: 0.97}},
  noir: {note: '黑白硬调（去色 + 强对比）',
    params: {saturation: 0, contrast: 1.38}},
  warm: {note: '偏暖（加红减蓝）', params: {temperature: 0.38, saturation: 1.06}},
  cool: {note: '偏冷（减红加蓝）', params: {temperature: -0.38, saturation: 1.06}},
};

export const EFFECT_SPECS = {
  blur: {
    note: '高斯模糊（可分离，多趟迭代）。radius=0 时直通，不产生额外趟',
    noopWhen: [{radius: 0}],
    params: {
      // 上限 400：全分辨率上小核能"采样充分"地处理到约 16px，再大走**金字塔**
      // （降采样 → 小核 → 升采样），所以这里不再是"实现撑不住"的边界，
      // 而是"再大也没有视觉意义"的产品边界（400px 半径在 720p 上几乎等于整幅糊掉）。
      radius: {kind: 'num', min: 0, max: 400, required: true, note: '模糊半径（像素）'},
    },
  },

  glow: {
    note: '辉光/泛光：把亮度超过阈值的部分抽出来模糊，再叠加回原图。不给参数就是一次默认辉光',
    noopWhen: [{intensity: 0}, {radius: 0}],
    params: {
      radius: {kind: 'num', min: 0, max: 200, def: 16, note: '辉光扩散半径（像素）'},
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

  chromatic: {
    note: '色差（RGB 分离）：越靠边分得越开，中心干净',
    noopWhen: [{amount: 0}],
    params: {
      amount: {kind: 'num', min: 0, max: 30, required: true, note: '边缘处红/蓝的最大偏移（像素）'},
      angle: {kind: 'num', min: -180, max: 180, def: 0, note: '分离方向（度，0=水平）'},
    },
  },

  grain: {
    note: '胶片颗粒。噪点是 (像素, 帧号) 的**纯函数** —— 不读时钟，所以同一帧永远同一张',
    noopWhen: [{amount: 0}],
    params: {
      amount: {kind: 'num', min: 0, max: 1, required: true, note: '颗粒强度（0=不变）'},
      size: {kind: 'num', min: 1, max: 8, def: 1, note: '颗粒尺寸（像素，越大颗粒越粗）'},
    },
  },

  pixelate: {
    note: '马赛克：按方块取色。size=1 是直通',
    noopWhen: [{size: 1}],
    params: {
      size: {kind: 'num', min: 1, max: 64, required: true, note: '方块边长（像素）'},
    },
  },

  radialBlur: {
    note: '径向/缩放模糊：沿"从中心往外"的方向拖尾（8 个采样点，固定）',
    noopWhen: [{amount: 0}],
    params: {
      amount: {kind: 'num', min: 0, max: 0.5, required: true, note: '拖尾长度（占画面比例，0.2 已很明显）'},
      centerX: {kind: 'num', min: 0, max: 1, def: 0.5, note: '中心 X（0=左，1=右）'},
      centerY: {kind: 'num', min: 0, max: 1, def: 0.5, note: '中心 Y（0=上，1=下）'},
    },
  },

  distort: {
    note: '波状扭曲（水波/玻璃感）：用正弦把采样位置推开',
    noopWhen: [{amount: 0}],
    params: {
      amount: {kind: 'num', min: 0, max: 1, required: true, note: '扭曲幅度（0=不变，1≈画面 5%）'},
      frequency: {kind: 'num', min: 1, max: 20, def: 4, note: '波纹密度（一个方向上的波数）'},
      phase: {kind: 'num', min: -180, max: 180, def: 0, note: '相位（度）：让波纹的位置平移'},
    },
  },

  grade: {
    note: '调色预设（青橙 / 电影感 / 黑白 / 暖 / 冷）。编译期展开成一个 color 步骤，不额外开销',
    noopWhen: [{amount: 0}],
    params: {
      look: {kind: 'enum', values: ['teal-orange', 'filmic', 'noir', 'warm', 'cool'],
        required: true, note: '预设名'},
      amount: {kind: 'num', min: 0, max: 1, required: true,
        note: '强度：在"原样"与该预设之间插值（0=直通，1=全量）'},
    },
  },

  displace: {
    note: '程序化噪声置换（热浪/水汽/有机抖动）。与 distort 的区别：distort 是正弦（像水波），这里是值噪声（像热浪）',
    noopWhen: [{amount: 0}],
    params: {
      amount: {kind: 'num', min: 0, max: 1, required: true, note: '最大位移（0=不变，1≈画面 6%）'},
      frequency: {kind: 'num', min: 1, max: 40, def: 8, note: '噪声尺度：越大块越碎'},
      phase: {kind: 'num', min: -180, max: 180, def: 0, note: '相位（度）：噪声场的平移，可写关键帧让热浪流动'},
    },
  },
};

/** 一条效果链的长度上限：链越长越慢，且多半是写错了。 */
export const EFFECT_CHAIN_MAX = 12;

export const EFFECT_ERROR_CODES = [
  'SCENE_FX_SHAPE', 'SCENE_FX_TYPE', 'SCENE_FX_PARAM', 'SCENE_FX_RANGE', 'SCENE_FX_CHAIN',
];

/**
 * 校验一处 `effects`（效果链）。
 *
 * 形状：`[{"type": "blur", "radius": 8}, …]` —— 顺序即应用顺序。
 *
 * 为什么单独一个函数而不是走通用字段机制：**每个效果的参数不同**，
 * 通用机制只表达得了"元素有哪几个键"，表达不了"blur 有 radius、glow 有 radius/intensity"。
 *
 * @returns {Array} 错误数组（可能为空）
 */
export function validateEffects(effects, path = 'effects') {
  const out = [];
  const push = (code, where, message, hint) => out.push(err(code, where, message, hint));
  if (!Array.isArray(effects) || !effects.length) {
    push('SCENE_FX_SHAPE', path, 'effects 必须是非空数组',
      '形如 [{"type":"blur","radius":8}]；顺序即应用顺序');
    return out;
  }
  if (effects.length > EFFECT_CHAIN_MAX) {
    push('SCENE_FX_CHAIN', path, `效果链最多 ${EFFECT_CHAIN_MAX} 条，收到 ${effects.length} 条`,
      '链越长越慢；多数观感两三条就够 —— 检查是不是写重了');
  }
  effects.forEach((fx, i) => {
    const fp = `${path}[${i}]`;
    if (!fx || typeof fx !== 'object' || Array.isArray(fx)) {
      push('SCENE_FX_SHAPE', fp, '每条效果必须是对象', '形如 {"type":"blur","radius":8}');
      return;
    }
    const spec = EFFECT_SPECS[fx.type];
    if (!spec) {
      push('SCENE_FX_TYPE', `${fp}.type`, `不认识的效果 ${JSON.stringify(fx.type)}`,
        `可用：${EFFECT_TYPES.join(' / ')}`);
      return;
    }
    for (const k of Object.keys(fx)) {
      if (k === 'type') continue;
      if (!(k in spec.params)) {
        push('SCENE_FX_PARAM', `${fp}.${k}`, `${fx.type} 没有参数 ${JSON.stringify(k)}`,
          `可用：${Object.keys(spec.params).join(' / ')}`);
      }
    }
    for (const [k, ps] of Object.entries(spec.params)) {
      const v = fx[k];
      const rangeCheck = (val, valPath, push2) => {
        if (val < ps.min || val > ps.max) {
          push2('SCENE_FX_RANGE', valPath,
            `${k} 超出范围：${val}（允许 ${ps.min}–${ps.max}）`,
            `${k}：${ps.note} —— 允许范围就是 ${ps.min}–${ps.max}`);
        }
      };
      if (v === undefined) {
        if (ps.required) {
          push('SCENE_FX_PARAM', `${fp}.${k}`, `${fx.type} 需要参数 ${k}`,
            `${k}：${ps.note}（${ps.min}–${ps.max}）`);
        }
        continue;
      }
      // 枚举参数（如 grade.look）：只能是给定值之一，且**不能**用关键帧
      // （关键帧的值是数值 v，枚举没有插值语义）
      if (ps.kind === 'enum') {
        if (!ps.values.includes(v)) {
          push('SCENE_FX_PARAM', `${fp}.${k}`,
            `${k} 只能是 ${ps.values.join(' / ')}，收到 ${JSON.stringify(v)}`,
            `${k}：${ps.note}；可用：${ps.values.join(' / ')}`);
        }
        continue;
      }
      // 参数可以是**静态数值**，也可以是**关键帧轨道**（让模糊渐入、辉光脉冲）。
      // 轨道形状走 validateKeyTrack —— 与 animate 是**同一份**规则，不另写一套。
      if (Array.isArray(v)) {
        out.push(...validateKeyTrack(v, `${fp}.${k}`, {
          valueNote: `${k}：${ps.note}（每个关键帧的 v 都要在 ${ps.min}–${ps.max} 内）`,
          checkValue: rangeCheck,
        }));
        continue;
      }
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        push('SCENE_FX_PARAM', `${fp}.${k}`,
          `${k} 必须是数值或关键帧数组，收到 ${JSON.stringify(v)}`,
          `${k}：${ps.note}（${ps.min}–${ps.max}）；也可以写成 [{"beat":1,"v":0},{"beat":2,"v":12,"ease":"out3"}]`);
        continue;
      }
      rangeCheck(v, `${fp}.${k}`, push);
    }
    // 有些效果（如 color）每个参数都可省，而**全用缺省值恰好是直通** ⇒ 空转、白花一趟。
    // 这条**从数据推导**，不靠手写标志位：把"全部取缺省值"代入直通条件，命中就要求
    // 至少显式给一个参数。这样以后加效果不用记得补一个 flag。
    //
    // ⚠️ 但要**先确认必填参数都在**：否则缺 radius 的 blur 会同时报"缺少 radius"
    // 和"至少要给一个参数"，后者既多余又误导（缺的不是"一个"，是那个必填的）。
    const missingRequired = Object.entries(spec.params)
      .some(([k, ps]) => ps.required && fx[k] === undefined);
    if (!missingRequired && spec.noopWhen?.length) {
      const allDefaults = {};
      for (const [k, ps] of Object.entries(spec.params)) {
        allDefaults[k] = ps.def ?? ps.min ?? 0;
      }
      const wouldNoop = spec.noopWhen.some((cond) =>
        Object.entries(cond).every(([k, v]) => Math.abs((allDefaults[k] ?? v) - v) < 1e-9));
      const given = Object.keys(fx).filter((k) => k !== 'type').length;
      if (wouldNoop && given === 0) {
        push('SCENE_FX_PARAM', fp,
          `${fx.type} 至少要给一个参数（全用缺省值等于什么都没做）`,
          `可用：${Object.keys(spec.params).join(' / ')} —— 不给参数会白花一趟 GPU`);
      }
    }
  });
  return out;
}
