// `layers` 容器校验：并发多层、父子绑定、空物体。它是容器，向下调各叶子校验器。
import {SHOT_TYPES, TRANSFORM_HINT} from './tables.js';
import {isValidTransform, validateAnimate, err} from './primitives.js';
import {validateEffects} from './effects.js';
import {validateMask} from './mask.js';


/**
 * 校验 `type: "layers"` 的容器镜头。
 *
 * 每层：`{z?, from?, to?, transform?, animate?, content: {type, ...字段}}`
 *   · `content` 是一次**模板调用**，但**不能带 `at`** —— 层的位置由它自己的
 *     `from`/`to`（相对本镜头起点的偏移）决定，写 `at` 是坐标系统混用，直接报错；
 *   · `from`/`to` 是 1 起的相对帧；`to` 缺省到镜头末尾（绑定期才知道，见 runtime）；
 *   · `z` 缺省按声明顺序（后面的在上）；
 *   · 不允许 `content.type === 'layers'`（嵌套容器先不开，避免无界嵌套）。
 */
export function validateLayers(raw, path = 'shots') {
  const out = [];
  const push = (code, where, message, hint) => out.push(err(code, where, message, hint));
  const list = raw?.layers;
  if (!Array.isArray(list) || !list.length) {
    push('SCENE_LAYER_SHAPE', `${path}.layers`, 'layers 必须是非空数组',
      '每层形如 {"content":{"type":"bullets","items":[…]},"z":1,"from":1,"to":60}');
    return out;
  }
  list.forEach((layer, i) => {
    const lp = `${path}.layers[${i}]`;
    if (!layer || typeof layer !== 'object' || Array.isArray(layer)) {
      push('SCENE_LAYER_SHAPE', lp, '层必须是对象', '形如 {"content":{…},"z":0}');
      return;
    }
    if (layer.z !== undefined && !Number.isInteger(layer.z)) {
      push('SCENE_LAYER_SHAPE', `${lp}.z`, `z 必须是整数，收到 ${JSON.stringify(layer.z)}`,
        'z 是层序：数值大的画在上面；不写则按声明顺序（后面的在上）');
    }
    for (const k of ['from', 'to']) {
      if (layer[k] !== undefined && (!Number.isInteger(layer[k]) || layer[k] < 1)) {
        push('SCENE_LAYER_RANGE', `${lp}.${k}`,
          `${k} 必须是 ≥1 的整数（相对本镜头起点的偏移），收到 ${JSON.stringify(layer[k])}`,
          'from/to 是层自己的时间窗；不写 from 则从镜头第一帧开始，不写 to 则到镜头末尾');
      }
    }
    if (Number.isInteger(layer.from) && Number.isInteger(layer.to) && layer.to < layer.from) {
      push('SCENE_LAYER_RANGE', `${lp}.to`, `时间窗是空的：from=${layer.from} > to=${layer.to}`,
        'to 必须 ≥ from');
    }
    // ── 父子绑定 / 空物体（阶段 ④）──
    // `follow`：跟着**同一个容器里**的另一层动（声明下标）。
    // 有效变换 = 父的变换 ∘ 自己的变换 ⇒ 仍是帧号的纯函数（守住核心不变量）。
    if (layer.follow !== undefined) {
      const cnt = list.length;
      if (!Number.isInteger(layer.follow) || layer.follow < 0 || layer.follow >= cnt) {
        push('SCENE_LAYER_FOLLOW', `${lp}.follow`,
          `follow 必须是 0..${cnt - 1} 的整数（同容器里图层的**声明下标**），`
          + `收到 ${JSON.stringify(layer.follow)}`,
          `本容器有 ${cnt} 层，下标从 0 起（不是 z 值）`);
      } else if (layer.follow === i) {
        const others = [...Array(cnt).keys()].filter((k) => k !== i);
        push('SCENE_LAYER_FOLLOW', `${lp}.follow`, '层不能 follow 自己',
          others.length
            ? `可用的下标：${others.join(' / ')}（本容器共 ${cnt} 层）`
            : `本容器只有这 ${cnt} 层 ⇒ 没有可 follow 的目标；要「一套变换驱动多层」得先加一个空物体（{"empty": true}）`);
      }
    }
    // 空物体：不画内容、只给别的层提供变换 ⇒ **不要求 content**（写了反而报）
    if (layer.empty !== undefined && typeof layer.empty !== 'boolean') {
      push('SCENE_LAYER_SHAPE', `${lp}.empty`,
        `empty 必须是布尔值，收到 ${JSON.stringify(layer.empty)}`,
        'empty: true 表示这一层不画内容、只提供变换（配合别的层的 follow 用）');
    }
    if (layer.empty === true) {
      if (layer.content !== undefined) {
        push('SCENE_LAYER_CONTENT', `${lp}.content`,
          '空物体（empty: true）不能同时给 content —— 它不画任何东西',
          '要么去掉 empty，要么去掉 content');
      }
      if (layer.transform !== undefined && !isValidTransform(layer.transform)) {
        push('SCENE_LAYER_SHAPE', `${lp}.transform`, '层的 transform 形状不对',
          '与镜头 transform 同一套字段；' + TRANSFORM_HINT);
      }
      if (layer.animate !== undefined) {
        out.push(...validateAnimate(layer.animate, layer.transform, `${lp}.animate`));
      }
      // ⚠️ **空物体不能挂 `effects`**：它不画任何内容 ⇒ 效果链没有作用对象。
      // 不报的话就是「写了没用也不说」—— 那种静默 no-op 是最难查的一类配置错误。
      if (layer.effects !== undefined) {
        push('SCENE_LAYER_CONTENT', `${lp}.effects`,
          '空物体（empty: true）不能挂 effects —— 它不画任何内容，效果链没有作用对象',
          '去掉 effects，或者把它挪到真正画内容的那一层');
      }
      return;                                  // 空物体不查 content
    }
    const c = layer.content;
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      push('SCENE_LAYER_CONTENT', `${lp}.content`, '层必须给 content（一次模板调用）',
        `形如 {"content":{"type":"${SHOT_TYPES[0]}",…}}`);
      return;
    }
    if (c.at !== undefined) {
      push('SCENE_LAYER_CONTENT', `${lp}.content.at`,
        '层内容里不能写 at —— 层的位置由该层自己的 from/to 决定',
        '把 at 换成层的 from/to（相对本镜头起点的偏移，1 起）');
    }
    if (c.type === 'layers') {
      push('SCENE_LAYER_NEST', `${lp}.content.type`, '层里不能再放 layers 容器（v1 不开嵌套）',
        `层的 content 用模板类型：${SHOT_TYPES.filter((t) => t !== 'layers').join(' / ')}`);
    } else if (!SHOT_TYPES.includes(c.type)) {
      push('SCENE_LAYER_CONTENT', `${lp}.content.type`,
        `不认识的层内容类型 ${JSON.stringify(c.type)}`,
        `可用：${SHOT_TYPES.filter((t) => t !== 'layers').join(' / ')}`);
    }
    if (layer.transform !== undefined && !isValidTransform(layer.transform)) {
      push('SCENE_LAYER_SHAPE', `${lp}.transform`, '层的 transform 形状不对',
        '与镜头 transform 同一套字段；' + TRANSFORM_HINT);
    }
    if (layer.animate !== undefined) {
      out.push(...validateAnimate(layer.animate, layer.transform, `${lp}.animate`));
    }
    if (layer.effects !== undefined) {
      out.push(...validateEffects(layer.effects, `${lp}.effects`));
    }
    if (layer.mask !== undefined) out.push(...validateMask(layer.mask, `${lp}.mask`));
  });
  // 成环检查：`follow` 必须是一条链，绕回自己就没有「最外层」可言了。
  // 运行时另有一道 `seen` 守卫（不会死循环），但**配置错了要当场报** ——
  // 否则表现是「绑定莫名其妙只生效一层」，属于最难查的那种静默错。
  list.forEach((layer, i) => {
    if (!layer || typeof layer !== 'object' || !Number.isInteger(layer.follow)) return;
    const seen = new Set([i]);
    let cur = layer;
    while (cur && Number.isInteger(cur.follow)) {
      const nx = cur.follow;
      if (seen.has(nx)) {
        push('SCENE_LAYER_FOLLOW', `${path}.layers[${i}].follow`,
          `follow 成环：${[...seen].join(' → ')} → ${nx}`,
          '父子关系必须是一条链，不能绕回自己');
        return;
      }
      seen.add(nx);
      cur = list[nx];
    }
  });
  return out;
}
