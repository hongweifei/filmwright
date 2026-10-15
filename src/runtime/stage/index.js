// 阶段装配：boot（装配置/时间轴/镜头/章节卡）与各层的出口。
//
// 渲染页只需要 import 这个文件，不必知道内部怎么分层。
import {install as installConfig, config, view} from '../../contract/config.js';
import {setTimeline, timeline, cardRange, tailFrom} from '../../contract/timeline.js';
import {validateScene, needsThree} from '../../contract/scene.js';
import {setShots, bindShots, shotAt, shots} from './shots.js';
import {setChapterCards, chapterCards} from '../overlay/chapterCard.js';
import {loadAssets} from '../assets.js';
import {setClips, preloadClipFrames} from '../clips.js';
import {compileScene} from '../scene/templates.js';
import {ensureThree} from '../three/stage.js';
import {drawFrame} from './drawFrame.js';

/**
 * 从 scene 规格里收集「哪里用到了哪个片段」——用来决定预解码哪些帧。
 *
 * 只解实际用到的区间（一个 10 秒 30fps 的片段有 300 帧，全解太浪费；
 * 而镜头往往只用其中几秒）。找不到就整段解，宁可慢也不要缺帧。
 */
function collectClipUses(scene, clipMap, outFps) {
  const uses = [];
  // from 是「这一帧对应片段的第 1 帧」——与 clipFrame 的 from 参数同一个含义。
  // 它必须随 uses 一起传下去，否则预解码区间会整体偏移（实测漏解前 18 帧）。
  const push = (clipName, from, to, clipFrom) => {
    const c = clipMap[clipName];
    if (!c) return;
    uses.push({
      name: clipName,
      from: Math.max(1, from),
      to: Math.max(1, to),
      clipFrom: clipFrom ?? 1,
      outFps,
    });
  };
  const shots = scene?.shots ?? [];
  // 记下每个镜头的起点，`to` 就是下一个镜头的起点 - 1
  const starts = shots.map((s) => {
    if (typeof s.at === 'number') return s.at;
    if (typeof s.at === 'string') return null;    // 需要时间轴，交给下面的兜底
    return s.at?.s ? null : 1;
  });
  shots.forEach((s, i) => {
    const name = s.clip ?? s.asset;
    if (!name || !clipMap[name]) return;
    const from = starts[i] ?? 1;
    const to = (starts[i + 1] ?? (from + 300)) - 1;
    // clipFrom = 这个镜头的起始帧（该帧对应片段第 1 帧）—— 与 clipT 里
    // clipFrame(..., {from: this.from}) 用的是同一个量
    push(name, from, to, from);
  });
  // 拿不到精确区间时：整段解（保证不缺帧，代价是 boot 慢一些）
  if (uses.length === 0) {
    for (const [name, c] of Object.entries(clipMap)) {
      uses.push({name, from: 1, to: Math.max(1, Math.ceil((c.frames / c.fps) * outFps)), clipFrom: 1, outFps});
    }
  }
  return uses;
}

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
 * 镜头有两个来源，可以混用：
 *   - `scene`：scene.json 声明式规格（AI/模板路线），校验失败当场报可行动的错；
 *   - `loadShots` / `shots`：手写镜头（逃生舱）。
 * 两者合并后交给 setShots/bindShots —— 起始帧冲突会在那里报，不在这里和稀泥。
 *
 * @param {object} p
 * @param {object} p.config   配置
 * @param {object} p.timeline 时间轴
 * @param {object} [p.scene]  scene.json 解析结果（可选）
 * @param {() => Promise<any>} [p.loadShots] 延迟加载镜头模块（没有 scene 时必填）
 * @param {(w:number,h:number)=>void} [resize] 画布尺寸回调（浏览器里用）
 */
export async function boot(p, resize) {
  if (!p?.config) throw new Error('filmwright: 缺 config');
  if (!p.timeline) throw new Error('filmwright: 缺 timeline —— 先跑 filmwright tts');
  if (!p.scene && typeof p.loadShots !== 'function' && !p.shots) {
    throw new Error('filmwright: 既没有 scene.json 也没有镜头表 —— 项目里至少放一样');
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

  // 片段素材：注册帧序列（抽帧已在宿主侧完成），并按**实际用到的区间**预解码。
  // 预解码必须在开画前做完 —— drawImage 一张没解码的图会静默什么都不画
  // （同图片素材的取舍：宁可 boot 时慢一点，也不要空白帧）。
  let clipsInfo = null;
  if (cfg.clips.length && p.clips) {
    setClips(p.clips, '/clips/');
    // 用到的区间：scene 里的 image/clip 镜头（或手写镜头自己声明的 clipUses）
    const uses = collectClipUses(p.scene, p.clips, cfg.fps ?? 30);
    clipsInfo = await preloadClipFrames(uses, cfg.fps ?? 30);
  } else if (cfg.clips.length && !p.clips) {
    throw new Error('filmwright: 配置里声明了 clips，但宿主没提供抽好的帧 —— ' +
      '跑一次 filmwright clips --project <目录>，或用 render/preview（它们会自动抽）');
  }

  // 时间轴就绪之后才求值镜头模块
  const list = [];
  if (p.scene) {
    const v = validateScene(p.scene, {
      timeline,
      assetNames: cfg.assets.map((a) => a.name),
      clipNames: new Set(Object.keys(p.clips ?? {})),
    });
    if (!v.ok) {
      throw new Error('filmwright: scene.json 校验失败：\n'
        + v.errors.map((e) => `  [${e.code}] ${e.path}：${e.message}${e.hint ? '（' + e.hint + '）' : ''}`).join('\n'));
    }
    list.push(...compileScene(p.scene, timeline));
    // 声明式 3D 的模板 draw 是**同步**的，而 three 的加载是异步的 ——
    // 所以在这里（boot 本身是 async）预加载一次。
    // 只有规格里真有 3D 才拉：不用 3D 的项目一个字节都不加载（three 有 2.2MB）。
    if (needsThree(p.scene)) await ensureThree();
  }
  if (p.shots || p.loadShots) {
    const mod = p.shots ?? await p.loadShots();
    const manual = mod.default ?? mod.SHOTS ?? mod;
    if (!Array.isArray(manual)) throw new Error('filmwright: 镜头模块要导出 SHOTS 数组');
    list.push(...manual);
  }
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
    // 声明过的节拍（scene 模板自动带、手写镜头可选）：画质自检的入场/离场信号
    beats: Array.isArray(s.beats) && s.beats.length ? s.beats : null,
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
