// 片子级配置：唯一由「使用者」提供的东西。
//
// 引擎不认识任何具体片子，所有尺寸/颜色/字体/文案都从这里进来。
// 早先那版把 1280/720 写死在十几个地方、把 HUD 文案和片尾地址写死在引擎里，
// 换个分辨率或换个主题就得改引擎 —— 这个模块就是为了不再那样。
//
// 这里只做「校验 + 补默认」。填充是**原地**的（见 install），因为绘制模块 import 的是
// theme / fonts 这两个对象本身，换引用它们的绑定就失效了。
import {view, DESIGN} from './viewport.js';

export {view, DESIGN};

export const DEFAULT_THEME = {
  bg: '#080B14',
  bgDeep: '#050710',
  panel: '#101725',
  panelHi: '#182136',
  line: '#22304A',
  lineSoft: '#182238',
  text: '#E9F0FA',
  dim: '#8B99B4',
  faint: '#5A677F',
  codeBg: '#0C1220',
  termBg: '#05080F',
  /** 章节主色循环；章数多于此处长度时回绕。 */
  accents: ['#3FA7FF', '#8B5CF6', '#35D07F', '#22D3EE', '#F5B942', '#FF6B6B'],

  // ---- 状态色 ----
  // 绘制组件（matrix / rows / bars / chips）的默认色表达的是**语义**：
  // 「通过 / 不通过 / 高亮」。它们必须是 theme 的正式键。
  //
  // 这段是补一个真实的坑：库内部原先直接写 `C.green` / `C.red` / `C.amber`，
  // 而 theme 里**没有**这几个键 —— 于是默认值就是 undefined。
  // 只要调用方没传颜色就会走到 `hexA(undefined)` 崩掉。
  // 46 秒的示例恰好每次都显式传色，所以一直没暴露；
  // 迁 7465 帧的真实片子时（`matrix()` 没传色）才炸出来。
  ok: '#35D07F',
  bad: '#FF6B6B',
  hi: '#F5B942',
};

/**
 * 取第 i 个主色（0 基，超出回绕）。
 *
 * 绘制组件的默认色必须用它，**不能写 `C.accents[3]`** ——
 * 主题的 accents 可以由使用者给，长度不定（示例只给 3 个），
 * 下标越界就是 undefined，又回到「默认值是 undefined」那个坑。
 */
export function accent(i) {
  const a = config().theme.accents;
  return a[((i % a.length) + a.length) % a.length];
}

export const DEFAULT_FONTS = {
  sans: '"Noto Sans SC", "Microsoft YaHei", sans-serif',
  num: '"Orbitron", "Noto Sans SC", sans-serif',
  wide: '"Audiowide", "Orbitron", sans-serif',
  mono: '"Cascadia Mono", "Consolas", monospace',
};

/** 需要预加载的字体。字体没就绪就画，度量会全错（首帧会用回退字体）。 */
export const DEFAULT_FONT_FILES = [
  ['Noto Sans SC', 'fonts/NotoSansSC.ttf', {weight: '100 900'}],
  ['Orbitron', 'fonts/Orbitron[wght].ttf', {weight: '400 900'}],
  ['Audiowide', 'fonts/Audiowide-Regular.ttf', {}],
  ['Exo 2', 'fonts/Exo2-Italic.ttf', {weight: '100 900', style: 'italic'}],
];

/** 当前配色与字体：由 install 原地填充，绘制代码直接读。 */
export const theme = {};
export const fonts = {};

let CFG = null;

function normTitle(t) {
  if (!t) return null;
  if (typeof t === 'string') return {big: t, rest: '', en: '', tagline: ''};
  return {big: t.big ?? '', rest: t.rest ?? '', en: t.en ?? '', tagline: t.tagline ?? ''};
}

/**
 * 校验并补全配置。缺什么用默认；**写错的地方直接报出来，不静默退回默认**
 * —— 静默退回会让一个拼错的字段变成「看起来正常但不对」的片子。
 */
export function normalizeConfig(raw) {
  if (!raw) throw new Error('filmwright: 配置为空');
  const size = raw.size ?? {width: 1280, height: 720};
  if (!(size.width > 0) || !(size.height > 0)) {
    throw new Error('filmwright: size.width / size.height 必须是正数，收到 ' + JSON.stringify(size));
  }
  const fps = raw.fps ?? 30;
  if (!(fps > 0)) throw new Error('filmwright: fps 必须是正数，收到 ' + fps);
  const t = {...DEFAULT_THEME, ...(raw.theme ?? {})};
  if (!Array.isArray(t.accents) || t.accents.length === 0) {
    throw new Error('filmwright: theme.accents 必须是非空数组');
  }
  // 颜色键一个都不能是 undefined/空 —— 库内部的绘制默认色直接引用 theme 的键，
  // 少一个就会在绘制时变成 hexA(undefined) 崩掉，而崩的地方离这里很远。
  // 在这里当场拦下，报错信息里直接说清是哪个键。
  // （`accents` 是数组，单独查它的元素。）
  for (const [k, v] of Object.entries(t)) {
    if (k === 'accents') continue;
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(`filmwright: theme.${k} 必须是非空颜色字符串，收到 ${JSON.stringify(v)}`);
    }
  }
  t.accents.forEach((c, i) => {
    if (typeof c !== 'string' || c.length === 0) {
      throw new Error(`filmwright: theme.accents[${i}] 必须是非空颜色字符串，收到 ${JSON.stringify(c)}`);
    }
  });
  for (const h of raw.hud ?? []) {
    if (!h.fromS || !h.toS || !h.label) {
      throw new Error('filmwright: hud 每一项都要有 fromS / toS / label，收到 ' + JSON.stringify(h));
    }
  }
  return {
    slug: raw.slug ?? 'film',
    size: {width: Math.round(size.width), height: Math.round(size.height)},
    fps,
    theme: t,
    fonts: {...DEFAULT_FONTS, ...(raw.fonts ?? {})},
    fontFiles: raw.fontFiles ?? DEFAULT_FONT_FILES,
    title: normTitle(raw.title),
    credit: raw.credit ?? null,
    builtBy: raw.builtBy ?? '',
    hud: raw.hud ?? [],
    chapterTech: raw.chapterTech ?? [],
    assets: normAssets(raw.assets),
    clips: normClips(raw.clips),
    endingFade: raw.endingFade ?? 30,
    music: normMusic(raw.music),
    subtitle: normSubtitle(raw.subtitle),
  };
}

/**
 * 字幕排版（可选）。双语字幕的排版都在这里调。
 *
 *   subtitle: {
 *     primary: 'first',   // 'first' = 原文大字、译文小字；'second' = 反过来
 *     size: 42, size2: 26, gap: 8, lift: 14,
 *   }
 *
 * 为什么这些要可配：不同语言的**行高与字宽差别很大**（中文 1 字≈1 em，
 * 英文 1 词≈5 em），同一套尺寸不可能对所有语言都好看。
 * 默认值是按中文原文 + 英文译文调的。
 */
function normSubtitle(raw) {
  if (raw === undefined || raw === null) return {primary: 'first', size: 42, size2: 26, gap: 8, lift: 14};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('filmwright: subtitle 必须是对象，收到 ' + JSON.stringify(raw));
  }
  const allowed = ['primary', 'size', 'size2', 'gap', 'lift'];
  const unknown = Object.keys(raw).filter((k) => !allowed.includes(k));
  if (unknown.length) {
    throw new Error(`filmwright: subtitle 没有字段 ${unknown.join(', ')}；可用：${allowed.join(' / ')}`);
  }
  if (raw.primary !== undefined && !['first', 'second'].includes(raw.primary)) {
    throw new Error(`filmwright: subtitle.primary 只能是 first / second，收到 ${JSON.stringify(raw.primary)}`);
  }
  const numOr = (v, def, key, {min = 0, max}) => {
    if (v === undefined) return def;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`filmwright: subtitle.${key} 要是数字，收到 ${JSON.stringify(v)}`);
    }
    if (v < min) throw new Error(`filmwright: subtitle.${key} 不能小于 ${min}，收到 ${v}`);
    if (max !== undefined && v > max) throw new Error(`filmwright: subtitle.${key} 不能大于 ${max}，收到 ${v}`);
    return v;
  };
  return {
    primary: raw.primary ?? 'first',
    size: numOr(raw.size, 42, 'size', {min: 8, max: 120}),
    size2: numOr(raw.size2, 26, 'size2', {min: 6, max: 120}),
    gap: numOr(raw.gap, 8, 'gap', {min: 0, max: 60}),
    lift: numOr(raw.lift, 14, 'lift', {min: 0, max: 200}),
  };
}

/**
 * 视频 / 图片序列素材（clips）声明。
 *
 * ## 为什么需要它、以及它如何不破坏核心不变量
 *
 * `assets` 只收图片，且 boot 时全部加载完 —— 视频不行：一段 5 分钟的视频是
 * 9000 帧，全加载进内存不现实。
 *
 * 做法分两层，各守各的规矩：
 *   - **抽帧是 host 的 I/O**（ffmpeg，异步、慢、有磁盘代价）：`filmwright clips`
 *     或渲染前自动跑一遍，把帧抽到 `.work/clips/<name>-<hash>/` 下的图片序列，
 *     并做**内容寻址缓存**（同样的源 + 参数只抽一次）。
 *   - **绘制仍是同步纯函数**：运行时按 `源帧号 = round(t × clip.fps)` 取一张
 *     **已经就绪的图片**。源帧号只由 N 决定，所以「第 N 帧只是 N 的函数」不变；
 *     「取图」这一步的 I/O 由宿主的 prepare 阶段负责（见 runtime/clips.js）。
 *
 * 三种写法：
 *   clips: ['assets/broll.mp4']                                   // 抽帧，默认 30fps
 *   clips: [{name: 'broll', src: 'assets/broll.mp4', fps: 30, width: 960}]
 *   clips: [{name: 'seq', src: 'assets/frames/%04d.png', seq: true, fps: 30}]
 *
 * 字段：
 *   name    素材名（镜头里用它引用；默认取文件名不含扩展名）
 *   src     视频文件，或（seq: true 时）图片序列的路径模式
 *   seq     true = src 已经是图片序列，不需要抽帧
 *   fps     抽帧帧率（默认 30）—— 也是运行时「秒 → 源帧号」的换算基准
 *   width   抽帧宽度（默认不缩放，保留原始尺寸）；高度按比例
 *   start   从源的第几秒开始抽（默认 0）
 *   maxSec  最多抽多少秒（默认不限）—— 长视频只用到一小段时能省很多帧
 */
function normClips(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error('filmwright: clips 必须是数组，收到 ' + JSON.stringify(raw));
  }
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const c = typeof item === 'string' ? {src: item} : item;
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      throw new Error('filmwright: clips 每项要么是路径字符串，要么是 {name, src, ...}，收到 ' + JSON.stringify(item));
    }
    if (typeof c.src !== 'string' || !c.src) {
      throw new Error('filmwright: clips 每项都要有 src，收到 ' + JSON.stringify(item));
    }
    const base = c.src.split('/').pop().replace(/\.[^.]+$/, '');
    const name = c.name ?? base;
    if (typeof name !== 'string' || !name || name.includes('%')) {
      throw new Error(`filmwright: 片段 ${c.src} 的名字算不出来（序列路径带 %04d 时要显式给 name）`);
    }
    if (seen.has(name)) {
      throw new Error(`filmwright: 片段名「${name}」重复了 —— 镜头引用它时无法区分是哪一个`);
    }
    seen.add(name);
    const numOr = (v, def, key, {min = 0, max, integer = false} = {}) => {
      if (v === undefined) return def;
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new Error(`filmwright: clips.${name}.${key} 要是数字，收到 ${JSON.stringify(v)}`);
      }
      if (integer && !Number.isInteger(v)) {
        throw new Error(`filmwright: clips.${name}.${key} 要是整数，收到 ${v}`);
      }
      if (v < min) throw new Error(`filmwright: clips.${name}.${key} 不能小于 ${min}，收到 ${v}`);
      if (max !== undefined && v > max) throw new Error(`filmwright: clips.${name}.${key} 不能大于 ${max}，收到 ${v}`);
      return v;
    };
    out.push({
      name,
      src: c.src.startsWith('/') ? c.src : '/' + c.src,
      seq: c.seq === true,
      fps: numOr(c.fps, 30, 'fps', {min: 1, max: 120}),
      width: numOr(c.width, 0, 'width', {min: 0, max: 8192, integer: true}),
      start: numOr(c.start, 0, 'start', {min: 0}),
      maxSec: numOr(c.maxSec, 0, 'maxSec', {min: 0}),
    });
  }
  return out;
}

/**
 * 配乐声明。**这是 host 层的事**（ffmpeg 混音），不属于浏览器运行时 ——
 * 但配置校验仍在这里，理由同其它字段：写错要当场报错。
 *
 *   music: 'assets/bgm.mp3'                        → 默认闪避设置
 *   music: {src: 'assets/bgm.mp3', gain: -14, duck: 10, fadeIn: 1, fadeOut: 2}
 *
 * 字段：
 *   src      音乐文件（放项目的 public/ 下，与 assets 同一种取法）
 *   gain     音乐相对人声的增益 dB（默认 -14：人声为主，音乐垫底）
 *   duck     闪避强度 dB（默认 10：说话时把音乐压低这么多；0 = 不闪避）
 *   fadeIn   片头淡入秒数（默认 1）
 *   fadeOut  片尾淡出秒数（默认 2）
 */
function normMusic(raw) {
  if (raw === undefined || raw === null) return null;
  const m = typeof raw === 'string' ? {src: raw} : raw;
  if (typeof m !== 'object' || Array.isArray(m)) {
    throw new Error('filmwright: music 要么是路径字符串，要么是 {src, gain?, duck?, fadeIn?, fadeOut?}，收到 ' + JSON.stringify(raw));
  }
  if (typeof m.src !== 'string' || !m.src) {
    throw new Error('filmwright: music.src 必填（音乐文件路径，放项目的 public/ 下）');
  }
  const numOr = (v, def, name, {min, max} = {}) => {
    if (v === undefined) return def;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`filmwright: music.${name} 要是数字，收到 ${JSON.stringify(v)}`);
    }
    if (min !== undefined && v < min) throw new Error(`filmwright: music.${name} 不能小于 ${min}，收到 ${v}`);
    if (max !== undefined && v > max) throw new Error(`filmwright: music.${name} 不能大于 ${max}，收到 ${v}`);
    return v;
  };
  const gain = numOr(m.gain, -14, 'gain', {min: -60, max: 12});
  const duck = numOr(m.duck, 10, 'duck', {min: 0, max: 40});
  const fadeIn = numOr(m.fadeIn, 1, 'fadeIn', {min: 0});
  const fadeOut = numOr(m.fadeOut, 2, 'fadeOut', {min: 0});
  return {src: m.src.startsWith('/') ? m.src : '/' + m.src, gain, duck, fadeIn, fadeOut};
}

/**
 * 素材声明。两种写法都行：
 *   assets: ['assets/a.png', 'assets/b.png']                     → 名字取文件名（不含扩展名）
 *   assets: [{name: 'arch', src: 'assets/arch.png'}]             → 显式命名
 *
 * 名字必须唯一（重复就是配置错误：镜头引用的到底哪一张？），
 * 名字也不能为空 —— 空名字会让镜头里的笔误变成"找到了一个没名字的东西"。
 */
function normAssets(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error('filmwright: assets 必须是数组，收到 ' + JSON.stringify(raw));
  }
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    let name, src;
    if (typeof item === 'string') {
      src = item;
      const base = src.split('/').pop().replace(/\.[^.]+$/, '');
      name = base;
    } else if (item && typeof item === 'object') {
      name = item.name;
      src = item.src;
    } else {
      throw new Error('filmwright: assets 每项要么是路径字符串，要么是 {name, src}，收到 ' + JSON.stringify(item));
    }
    if (typeof src !== 'string' || !src) {
      throw new Error('filmwright: assets 每项都要有 src，收到 ' + JSON.stringify(item));
    }
    if (typeof name !== 'string' || !name) {
      throw new Error(`filmwright: 素材 ${src} 的名字算不出来，请写成 {name, src}`);
    }
    if (seen.has(name)) {
      throw new Error(`filmwright: 素材名「${name}」重复了 —— 镜头引用它时无法区分是哪一张`);
    }
    seen.add(name);
    // 页面按根路径取素材，项目把文件放在 public/ 下
    out.push({name, src: src.startsWith('/') ? src : '/' + src});
  }
  return out;
}

/** 装配置：原地填充 theme / fonts，并设好 view。 */
export function install(raw) {
  CFG = normalizeConfig(raw);
  view.W = CFG.size.width;
  view.H = CFG.size.height;
  Object.assign(theme, CFG.theme);
  Object.assign(fonts, CFG.fonts);
  return CFG;
}

export function config() {
  if (!CFG) throw new Error('filmwright: 还没装配置 —— 渲染页要先 boot 再画帧');
  return CFG;
}

export const isInstalled = () => CFG !== null;

/** 章节色：按序号取，超出则回绕。 */
export function accentFor(chapterNo) {
  const a = config().theme.accents;
  return a[(Math.max(1, chapterNo) - 1) % a.length];
}
