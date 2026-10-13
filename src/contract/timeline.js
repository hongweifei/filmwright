// 时间轴：数据 + 查询。
//
// 引擎不 import 任何具体片子 —— 时间轴是**数据**，不是代码。
// 原先拆成 timeline.js（数据）与 time.js（查询）两个文件，名字分不出谁是谁；
// 合在一起，因为它们只有一个概念。
//
// **本模块不 import 任何镜头**，所以不会与 stage.js 成环
// （那次的报错是 "Cannot access 'CARDS' before initialization"）。

const state = {
  fps: 30,
  totalFrames: 0,
  chapters: [],   // [{n, title, from}]
  sentences: [],  // [{id, chapter, from, to, text}]
  subs: [],       // [{from, to, text}]
};

/** 装载时间轴（由 tts 生成，或使用者自己按同样格式产出）。 */
export function setTimeline(data) {
  if (!data) throw new Error('filmwright: 时间轴为空');
  const fps = data.fps ?? 30;
  if (!(fps > 0)) throw new Error('filmwright: 时间轴 fps 非法：' + fps);
  const sentences = data.sentences ?? [];
  if (sentences.length === 0) {
    throw new Error('filmwright: 时间轴里一句都没有 —— 先跑 filmwright tts');
  }
  for (const s of sentences) {
    if (!s.id || !(s.from > 0) || !(s.to >= s.from)) {
      throw new Error('filmwright: 句子的 id/from/to 不合法：' + JSON.stringify(s).slice(0, 120));
    }
  }
  state.fps = fps;
  state.totalFrames = data.total_frames ?? 1;
  state.chapters = data.chapters ?? [];
  state.sentences = sentences;
  state.subs = data.subs ?? [];
  return state;
}

export const timeline = state;
export const isReady = () => state.sentences.length > 0;

/** 句 id → 句对象。 */
export function S(id) {
  if (!isReady()) throw new Error('filmwright: 时间轴未装载就查询了 ' + id);
  const s = state.sentences.find((x) => x.id === id);
  if (!s) throw new Error('filmwright: 不存在的句 id ' + id);
  return s;
}

/** 句 id 第 k 个字幕块的起始帧（1 起，含端点）。 */
export function BLK(id, k) {
  const s = S(id);
  const blocks = state.subs.filter((b) => b.from >= s.from && b.to <= s.to);
  if (!blocks[k - 1]) {
    throw new Error(`filmwright: 句 ${id} 没有第 ${k} 个字幕块（它共 ${blocks.length} 块）`);
  }
  return blocks[k - 1].from;
}

/** 镜头边界：落在「上一句说完、这句开口」之前的静音里。 */
export function cutBefore(id, lead = 8) {
  return Math.max(1, S(id).from - lead);
}

/** 第 n 章之前那张章节卡的起始帧；第 1 章没有卡，返回 undefined。 */
export function cardFrom(n) {
  const r = cardRange(n);
  return r ? r.from : undefined;
}

/** 章节卡区间（含首尾）；第 1 章返回 null。 */
export function cardRange(n) {
  const first = state.sentences.find((s) => s.chapter === n);
  if (!first) throw new Error('filmwright: 第 ' + n + ' 章里没有句子');
  const prev = [...state.sentences].reverse().find((s) => s.to < first.from);
  return prev ? {from: prev.to + 3, to: first.from - 9} : null;
}

/** 帧号 → 章节号（1 起）。 */
export function chapterAt(frame) {
  let c = 1;
  for (const ch of state.chapters) if (frame >= ch.from) c = ch.n;
  return c;
}

/** 末句结束之后留给片尾的起点。 */
export function tailFrom() {
  const last = state.sentences[state.sentences.length - 1];
  return last.to + 12;
}
