// 嵌套合成：具名子合成 + 实例化 + 循环。
//
// ## 时间基契约（这里最容易出错，先讲清楚）
//
//   全局帧 n  →  实例的本地帧 local  →  子合成里某个子镜头
//
// - 子合成内部的 `at` **只能是数字，表示本地帧**（从 1 开始）。
//   这样做的理由：如果允许子镜头用句 id 指向全局时间轴，就会出现「本地时间轴」
//   与「全局时间轴」两套坐标混用，递归时代码要在每层换算 —— 那是 bug 温床。
//   需要跟解说词对齐时，在**实例化那一层**用 `at: "S05"` 即可。
// - 不循环：local = n - from + 1（本地从 1 开始）
// - 循环：local = ((n - from) mod compLen) + 1
//   compLen 优先取子合成声明的 `frames`，否则由子镜头串接推出。
//
// ## 为什么不变量还成立
//
// 给定全局 n，local 是 n 的纯函数；子镜头的 draw 只依赖它收到的帧号；
// 所以整个递归链条上「第 N 帧只是 N 的函数」依然成立 —— 分片并行、跳帧、
// 全量自检都不受影响。**这也是嵌套合成能在引擎内做的前提**：它只是
// 「换了时间基再调用一个纯函数」，不是状态机。

/** 编译期环检测：comps 之间不能互相引用成环（否则递归会栈溢出）。 */
/**
 * 串接子镜头：只声明 start，区间由这里算（与主镜头同一套规则，但用本地帧）。
 * 与 stage/shots.js 的 setShots/bindShots 同规则 —— 但那里有全局单例状态
 * （SHOTS），子合成不能共用，所以这里做一份**纯函数版**。
 */
export function bindLocalShots(list, totalFrames) {
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('filmwright: 子合成的镜头表为空');
  }
  const declared = [...list].sort((a, b) => a.start - b.start);
  for (const s of declared) {
    if (!Number.isInteger(s.start) || s.start < 1) {
      throw new Error('filmwright: 子镜头 start 必须是 ≥1 的整数，收到 ' + s.start);
    }
    if (typeof s.draw !== 'function') {
      throw new Error('filmwright: 子镜头缺少 draw（start=' + s.start + '）');
    }
  }
  for (let i = 1; i < declared.length; i++) {
    if (declared[i].start <= declared[i - 1].start) {
      throw new Error(`filmwright: 子镜头 start 必须严格递增：${declared[i - 1].start} → ${declared[i].start}`);
    }
  }
  if (declared[0].start !== 1) {
    throw new Error('filmwright: 子合成的第一个镜头必须从本地第 1 帧开始，收到 ' + declared[0].start);
  }
  const total = totalFrames ?? (declared.length ? declared[declared.length - 1].start + 60 : 1);
  const out = declared.map((s, i) => ({
    ...s,
    from: s.start,
    to: i + 1 < declared.length ? declared[i + 1].start - 1 : total,
  }));
  return out;
}

/** 子合成长度：显式 frames 优先，否则末镜头的 to。 */
export function compLength(def, localShots) {
  if (Number.isInteger(def.frames) && def.frames >= 1) return def.frames;
  const last = localShots[localShots.length - 1];
  return last ? last.to : 1;
}

/**
 * 全局帧 → 实例本地帧。
 * @param {number} n 全局帧
 * @param {number} from 实例起始帧
 * @param {number} len 子合成长度（帧）
 * @param {boolean} loop 是否循环
 * @returns {number} 本地帧（1 起）
 */
export function localFrame(n, from, len, loop) {
  // 必须查整数：长度是 1.5 时取模不会报错，会算出「半帧」这种没有意义的值，
  // 而它一路传进 draw 就是难以定位的错位（测试里专门有这条）。
  if (!Number.isInteger(len) || len < 1) {
    throw new Error('filmwright: 子合成长度必须是 ≥1 的整数，收到 ' + len);
  }
  const off = n - from;
  if (off < 0) return 1;                       // 实例还没开始（理论上不会发生）
  if (!loop) return off + 1;                   // 超出 len 时由调用方决定是否还画
  return (off % len) + 1;
}

/**
 * 画一个子合成实例（在给定帧号下）。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} inst 实例：{comp, localShots, len, from, loop, transform}
 * @param {number} n 全局帧
 * @param {number} t 秒
 * @param {string} accent 章节主色
 */
export function drawCompInstance(ctx, inst, n, t, accent) {
  const {localShots, len, from, loop = false} = inst;
  const local = localFrame(n, from, len, loop);
  // 不循环且已播完：不再画（实例区间内但内容已结束 → 留空，由上层决定是否补别的东西）
  if (!loop && local > len) return false;
  const shot = localShots.find((s) => local >= s.from && local <= s.to);
  if (!shot) return false;
  shot.draw.call(shot, ctx, local, local / 30, accent);
  return true;
}

/** 把子镜头的节拍（本地帧）映射到全局帧，供画质自检用。 */
export function mapBeats(beats, from, len, loop, instTo) {
  if (!Array.isArray(beats) || beats.length === 0) return [from];
  if (!loop) {
    return beats.map((b) => from + b - 1).filter((b) => b <= instTo);
  }
  // 循环：映射到**实例当前所在的周期**。不是「最后一个完整周期」——
  // 若 instTo 落在周期中途，该周期里已落位的节拍才是观众看到的末拍，
  // 上一个已走完的周期对应的是更早的画面。
  const cycles = Math.max(0, Math.floor((instTo - from) / len));
  const cycleStart = from + cycles * len;
  return beats.map((b) => cycleStart + b - 1).filter((b) => b >= from && b <= instTo);
}

/** 编译期环检测：comps 之间不能互相引用成环（否则递归会栈溢出）。 */
export function assertNoCycles(comps) {
  const state = new Map();   // name -> 'visiting' | 'done'
  const visit = (name, path) => {
    const st = state.get(name);
    if (st === 'done') return;
    if (st === 'visiting') {
      throw new Error('filmwright: 子合成循环引用：' + [...path, name].join(' → '));
    }
    state.set(name, 'visiting');
    const def = comps[name];
    for (const sh of def?.shots ?? []) {
      if (sh.type === 'comp') {
        if (!comps[sh.comp]) {
          throw new Error(`filmwright: 子合成 ${name} 引用了不存在的 comp「${sh.comp}」`);
        }
        visit(sh.comp, [...path, name]);
      }
    }
    state.set(name, 'done');
  };
  for (const name of Object.keys(comps ?? {})) visit(name, []);
}
