// 素材注册表：图片在 boot 时**全部加载完**才开画。
//
// 为什么必须预加载：这个引擎的核心不变量是「第 N 帧是 N 的纯函数」，
// 绘制是**同步**的。图片没加载完就画，canvas 什么都不画 —— 那不是报错，
// 是一帧空白，而且只在前几帧出现，最难查。
//
// 与字体处理的差别（有意为之）：
//   字体加载失败 → 记一句 `:FAILED`，让浏览器回退，片子还能看。
//   图片加载失败 → **直接抛错**。图片没加载就是「该有的东西没了」，
//                  静默变成空白帧比崩溃更糟。
// 同理，镜头里引用一个没声明的素材名也会当场抛错，并列出可用的名字。

/** name -> {el, w, h, src} */
const REG = new Map();
/** 声明过的顺序（报错时按它列出可用名字） */
let declared = [];

/**
 * 加载全部素材。任何一张失败都会抛错（带上路径）。
 * @param {Array<{name:string, src:string}>} list
 */
export async function loadAssets(list) {
  REG.clear();
  declared = list.map((a) => a.name);

  const results = await Promise.all(list.map(async (a) => {
    try {
      const el = await loadOne(a.src);
      return {ok: true, name: a.name, el, src: a.src};
    } catch (e) {
      return {ok: false, name: a.name, src: a.src, err: e && e.message ? e.message : String(e)};
    }
  }));

  const bad = results.filter((r) => !r.ok);
  if (bad.length) {
    throw new Error(
      'filmwright: 素材加载失败\n' +
      bad.map((b) => `  - ${b.name}（${b.src}）：${b.err}`).join('\n') +
      '\n  素材要在 film.config.mjs 的 assets 里声明，文件放在项目的 public/ 下。'
    );
  }

  for (const r of results) {
    REG.set(r.name, {
      el: r.el,
      w: naturalW(r.el),
      h: naturalH(r.el),
      src: r.src,
    });
  }
  return results.map((r) => r.name);
}

function loadOne(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('取不到这张图（404 或格式不对）'));
    im.src = src;
  });
}

const naturalW = (el) => el.naturalWidth || el.width || 0;
const naturalH = (el) => el.naturalHeight || el.height || 0;

/**
 * 取一张已加载的素材。名字没声明过就抛错 —— 并列出可用的名字。
 *
 * 这条是照 `themeKeys` 那个坑写的：引用一个不存在的名字，如果不报错，
 * 就会一路传成 undefined，最后在某个画图调用里崩，离原因很远。
 */
export function img(name) {
  const a = REG.get(name);
  if (!a) {
    throw new Error(
      `filmwright: 没有名为「${name}」的素材\n` +
      (declared.length
        ? '  已声明的素材：' + declared.join('、')
        : '  配置里一个素材都没声明（film.config.mjs 的 assets）')
    );
  }
  return a.el;
}

/** 素材原始尺寸（按它算版面的人要用）。 */
export function imgSize(name) {
  const a = REG.get(name);
  if (!a) throw new Error(`filmwright: 没有名为「${name}」的素材`);
  return {w: a.w, h: a.h};
}

/** 已加载的素材名（诊断用）。 */
export const assetNames = () => [...REG.keys()];

/** 是否已加载（boot 之前为 false）。 */
export const assetsReady = () => REG.size > 0;
