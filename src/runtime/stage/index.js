// 阶段装配：boot（装配置/时间轴/镜头/章节卡）与各层的出口。
//
// 渲染页只需要 import 这个文件，不必知道内部怎么分层。
import {install as installConfig, config, view} from '../../contract/config.js';
import {setTimeline, timeline, cardRange, tailFrom} from '../../contract/timeline.js';
import {setShots, bindShots, shotAt, shots} from './shots.js';
import {setChapterCards, chapterCards} from '../chrome/chapterCard.js';
import {loadAssets} from '../assets.js';
import {drawFrame} from './drawFrame.js';

export {drawFrame, shotAt, shots, chapterCards, timeline, view, tailFrom};

/** 字体就绪后才画：否则首帧用回退字体，度量全错。 */
async function loadFonts(files) {
  const loaded = [];
  for (const [family, url, desc] of files) {
    try {
      const ff = new FontFace(family, `url(${url})`, desc || {});
      await ff.load();
      document.fonts.add(ff);
      loaded.push(family);
    } catch {
      loaded.push(family + ':FAILED');
    }
  }
  await document.fonts.ready;
  return loaded;
}

/**
 * 装载一个片子。
 *
 * **镜头模块必须在时间轴之后才求值**：镜头文件在模块顶层就调用 `cutBefore('S01')`
 * 这类查询（那是它的价值：不写硬编码帧号），而查询要求时间轴已装载。
 * 所以这里收的是一个 **加载函数** 而不是已求值的模块 —— 由我们决定求值时机。
 *
 * @param {object} p
 * @param {object} p.config   配置
 * @param {object} p.timeline 时间轴
 * @param {() => Promise<any>} p.loadShots 延迟加载镜头模块
 * @param {(w:number,h:number)=>void} [resize] 画布尺寸回调（浏览器里用）
 */
export async function boot(p, resize) {
  if (!p?.config) throw new Error('filmwright: 缺 config');
  if (!p.timeline) throw new Error('filmwright: 缺 timeline —— 先跑 filmwright tts');
  if (typeof p.loadShots !== 'function' && !p.shots) {
    throw new Error('filmwright: 缺 loadShots（或已求值的 shots）');
  }

  const cfg = installConfig(p.config);
  setTimeline(p.timeline);
  if (resize) resize(cfg.size.width, cfg.size.height);

  // 字体与素材都要就绪才开画：
  //   - 字体没就绪 → 首帧用回退字体，度量全错
  //   - 素材没就绪 → 图片那几帧是空的（canvas 对未加载的图什么都不画）
  // 两者都必须在**求值镜头模块之前**做完：镜头在模块顶层可能就要用素材尺寸算版面。
  const loaded = await loadFonts(cfg.fontFiles);
  const assets = await loadAssets(cfg.assets);

  // 时间轴就绪之后才求值镜头模块
  const mod = p.shots ?? await p.loadShots();
  const list = mod.default ?? mod.SHOTS ?? mod;
  if (!Array.isArray(list)) throw new Error('filmwright: 镜头模块要导出 SHOTS 数组');
  bindShots(setShots(list), timeline.totalFrames);

  // 章节卡：第 2 章起，落在时间轴留出的空白里
  const cards = [];
  for (const ch of timeline.chapters.slice(1)) {
    const r = cardRange(ch.n);
    if (r) {
      cards.push({n: ch.n, title: ch.title, from: r.from, to: r.to, tech: cfg.chapterTech[ch.n - 1] ?? ''});
    }
  }
  setChapterCards(cards);

  // 带上每个镜头的**实际可绘制区间**：宿主侧的画质自检要按镜头聚合，
  // 而镜头区间只有这里知道（镜头文件只声明 start，区间是 bindShots 串出来的）。
  //
  // 末尾要按 tailFrom 截断：片尾区里 drawFrame 根本不画镜头（那里是压黑与署名卡），
  // 所以最后一个镜头的真实内容到 tailFrom-1 为止。不截断的话，画质自检会把
  // 片尾卡的静止误算成那个镜头的「末拍稳定期」（实测报了 18 帧，其实是片尾）。
  const tail = tailFrom();
  const ranges = shots().map((s, i) => ({
    id: s.id ?? `SH${String(i + 1).padStart(2, '0')}`,
    from: s.from,
    to: Math.min(s.to, tail - 1),
  }));

  return {
    loaded,
    assets,
    total: timeline.totalFrames,
    w: cfg.size.width,
    h: cfg.size.height,
    shots: list.length,
    cards: cards.length,
    ranges,
  };
}

export {config};
