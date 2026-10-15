# 运行时 API 参考

镜头文件只 import 一个入口：

```js
import {text, panel, S, BLK, cutBefore, inv, easeOut3, applyDesignScale} from 'filmwright';
```

`'filmwright'` 由渲染页的 import map 解析到 `src/index.js`。**公开面上只有浏览器里跑的东西**——Node 侧（CLI、渲染、自检）不在公开面上，镜头不该 import 它们。

以下按组列全公开导出。签名以源码为准；每个函数的完整选项见对应源文件（都在 `src/runtime/` 与 `src/contract/` 下）。

## 镜头契约

一个镜头是一个对象：

```js
{
  start: cutBefore('S02'),     // 从哪一帧接管画面（≥1，第一个镜头必须是 1）
  draw(ctx, n, t, accent) {…}, // n：当前帧号（1 起）；t = n / fps；accent：本章主色
}
```

- **只声明 `start`**，区间由引擎串接（下一镜头的 `start − 1` 就是本镜头的末帧），并做覆盖自检——漏一段直接报错，不会静默画空帧。
- `draw` 里可以读 **`this.from` / `this.to`**（本镜头的实际区间）。所以 `draw` 必须是**普通函数**，箭头函数会把 `this` 丢掉，每帧都抛错。
- 镜头模块顶层就调 `cutBefore()` 这类查询（这是它不写硬编码帧号的原因），所以引擎在时间轴装载**之后**才求值镜头模块——`boot()` 收的是加载函数，不是已求值的模块。
- 模块导出 `SHOTS` 数组：`export const SHOTS = [TITLE, PURE, …]`。

## 配置与视口

| 导出 | 说明 |
|---|---|
| `theme` | 当前配色（`bg` / `panel` / `text` / `accents` / `ok`…，全表见[配置参考](config.md)） |
| `fonts` | 当前字体栈（`sans` / `num` / `wide` / `mono`） |
| `view` | 实际输出尺寸 `{W, H}`（活引用） |
| `DESIGN` | 设计基准 `{W: 1280, H: 720}` |
| `config()` | 取完整已装配置；未装时抛错 |
| `accentFor(i)` | 第 i 章主色（1 起，超出回绕） |

镜头里读颜色直接 `theme.accents[k]`（注意长度由使用者定，越界是 `undefined`）或用 `accentFor`。

## 时间轴查询

| 导出 | 说明 |
|---|---|
| `S(id)` | 句 id → 句对象 `{id, chapter, from, to, text}`；不存在则抛错 |
| `BLK(id, k)` | 句 `id` 的第 k 个字幕块（1 起）的起始帧；没有第 k 块则报错并说明共几块 |
| `cutBefore(id, lead = 8)` | 镜头边界：上一句说完与这句开口之间的静音里，减 `lead` 帧 |
| `cardFrom(n)` | 第 n 章章节卡的起始帧；第 1 章没有卡（`undefined`） |
| `cardRange(n)` | 第 n 章章节卡区间 `{from, to}`；第 1 章 `null` |
| `chapterAt(frame)` | 帧号 → 章节号（1 起） |
| `tailFrom()` | 末句结束之后留给片尾的起点 |
| `timeline` | 时间轴原始数据（`fps` / `totalFrames` / `chapters` / `sentences` / `subs`，活引用） |

## 动效（全部纯函数）

| 导出 | 说明 |
|---|---|
| `clamp(v, lo = 0, hi = 1)` | 夹紧 |
| `lerp(a, b, t)` | 线性插值 |
| `inv(t, a, b)` | t 在 `[a, b]` 里的进度（0→1，夹紧）；`a === b` 返回 1，不会除零 |
| `easeOut3(t)` / `easeOut4(t)` | 三次 / 四次缓出 |
| `easeIn3(t)` | 三次缓入 |
| `easeInOut(t)` | 三次缓入缓出 |
| `easeOutBack(t)` | 回弹缓出 |
| `pulse(t, center, w)` | 0→1→0 脉冲，中心 `center`，半宽 `w` |
| `rnd(seed)` | 确定性哈希随机 `[0,1)`；同一 seed 永远同一串 |
| `kf(t, keys)` | 分段关键帧；`keys` 为 `[帧, 值]` 数组 |
| `enter(n, f0, dur = 14, dy = 26)` | 入场：返回 `{a, dy}`（淡入 + 上移落位，**首帧全透明**） |
| `exit(n, f1, dur = 12, dy = 22)` | 离场：返回 `{a, dy}`（上移淡出，末帧归零） |

惯用法：`const a = easeOut3(inv(n, from, to)); if (a > 0.01) { ctx.globalAlpha = a; … }`。

## 绘制原语（`runtime/draw/primitives.js`）

| 导出 | 说明 |
|---|---|
| `text(ctx, s, x, y, o)` | 文本；选项：`size` / `family` / `weight` / `color` / `align` / `baseline` / `alpha` / `spacing`（字距）/ `glow` + `glowBlur` / `maxW`（按宽缩字号）/ `stroke` + `lw`。返回实际用的字号 |
| `panel(ctx, x, y, w, h, o)` | 圆角面板：`r` / `fill` / `stroke` / `lw` / `glow` + `glowBlur` / `alpha` |
| `pill(ctx, x, y, w, h, o)` | 胶囊（圆角 = 半高），选项同 `panel` |
| `rule(ctx, x, y, w, p, o)` | 水平分隔线，`p` 是 0→1 的展开进度；`align`：`left` / `center` / `right` |
| `wrap(ctx, s, maxW, f)` | 按最大宽度折行，返回行数组（中文长文本用这个） |
| `measure(s, f)` / `fit(s, maxW, size, family, weight)` | 真实字体度量宽度 / 缩字号到装得下 |
| `font(size, family, weight)` | 拼 canvas 字体串 |
| `roundRect(ctx, x, y, w, h, r)` | 圆角矩形路径 |
| `glowWith(ctx, color, blur, fn)` | 回调里画的东西带光晕 |
| `arrowR(ctx, x, y, w, o)` | 横向箭头：`color` / `lw` / `head` |
| `codeBlock(ctx, x, y, lines, o)` | 代码块：行号、按行上色、`mark: 'add'|'hl'|'err'`；返回 `{w, h}` |
| `terminal(ctx, x, y, w, lines, o)` | 终端窗口：标题栏 + 三色圆点 + 内容行；返回 `{w, h}` |
| `caret(ctx, x, y, h, n, o)` | 闪烁光标（n 是帧号；`period` 控制节奏） |
| `bars(ctx, x, y, w, h, items, o)` | 竖向条形图：`items: {v, label, unit?, color?}`、`hiIndex`、`p` 进度 |
| `hexdump(ctx, x, y, bytes, o)` | 十六进制转储：`hi` 高亮字节下标集合、`divideAfter` 分界虚线 |
| `spotlight(ctx, x, y, w, h, strength, r)` | 放大镜：矩形外压暗 |
| `grid(ctx, n, o)` | 网格底纹：`step` / `color` / `drift` |

## 组合件（`runtime/draw/widgets.js`）

| 导出 | 说明 |
|---|---|
| `counter(value, t)` | 滚动计数：t 0→1 时从 0 数到 value |
| `bigStat(ctx, x, y, value, label, t, o)` | 大数字 + 单位 + 标签；`unit` / `label2` / `size` |
| `matrix(ctx, x, y, cols, cells, o)` | 格子矩阵；`cells: {ok, label}[]` 行优先，`reveal` 控制逐格亮起 |
| `flow(ctx, x, y, w, h, boxes, o)` | 「输入 → 处理 → 输出」流程盒；`boxes: {label, sub, color}[]`，箭头随进度点亮 |
| `chips(ctx, x, y, w, items, o)` | 标签胶囊列表（自动折行）；`items` 可为字符串或 `{label, color}`；返回总高 |
| `section(ctx, x, y, w, title, p, o)` | 带标题的区块头；`sub` 是等宽小字 |
| `code(ctx, s, x, y, o)` | 行内代码片（等宽 + 可选底色）；返回宽 |

## 图片与素材

| 导出 | 说明 |
|---|---|
| `picture(ctx, name, x, y, w, h, o)` | 把声明的素材摆进框。选项：`fit`（`contain` / `cover` / `stretch`）、`align` / `valign`、`alpha`、`r`（圆角）、`pad`、`border` + `lw`、`glow` + `glowBlur`。返回实际绘制尺寸 `{w, h}` |
| `fitBox(natW, natH, boxW, boxH, fit)` | 纯函数：按 fit 规则算框内实际尺寸，可单独用来排版 |
| `img(name)` | 取图片元素（高级用法）；未声明的名字**当场抛错**并列出可用名字 |
| `imgSize(name)` | 原始尺寸 `{w, h}` |
| `assetNames()` | 全部已声明素材名 |
| `assetsReady()` | 素材是否全部就绪 |

素材在配置里声明、文件放 `public/` 下；`boot()` 会**全部加载完才开画**（图片加载失败是抛错——该有的东西没了必须响）。视频走 `clips`（宿主抽帧 + 运行时按源帧同步取图，见 [clips 段](config.md#clips视频--图片序列素材)），不直接用 `video` 元素，原因见[已知限制](../LIMITATIONS.md)。

## 版面缩放

设计基准是 1280×720；输出更大时镜头内容要跟着放大：

| 导出 | 说明 |
|---|---|
| `applyDesignScale(ctx)` | **推荐**：在镜头入口整体变换坐标系，之后照 1280×720 写坐标，等比放大居中 |
| `scale()` / `scaleFactors()` | 取换算函数 / 系数 `{sx, sy}` |
| `sX(x)` / `sY(y)` / `sSize(size)` | 单值换算 |
| `DESIGN_SAFE` | 设计坐标系下的内容区 `{x: 60, y: 110, w: 1160, h: 510}`（扣掉 HUD 与字幕带） |

引擎内建件（HUD / 字幕 / 章节卡 / 进度条 / 片尾）自己读 `view` 按比例摆，与分辨率无关；**镜头内容**的缩放要自己调 `applyDesignScale`。

## 阶段（一般不用，自检与调试用）

| 导出 | 说明 |
|---|---|
| `boot(project, resize)` | 装配：装配置 / 时间轴 → 等字体与素材就绪 → 求值镜头模块 → 串接区间。**两份宿主页面（`src/host/pages/`）用的就是它** |
| `drawFrame(ctx, n)` | 按帧号画完整一帧（内建件 + 当前镜头 + 片尾） |
| `shots()` / `shotAt(n)` | 镜头表（带串接好的 `from` / `to`）/ 帧号 → 所在镜头 |
| `chapterCards()` | 已组装的章节卡 |

`boot` 与下一节的 `installAnalysis` 之所以在公开面上，是因为**宿主页面也要用**：
两份宿主页面只 `import` 公开面（`/kit/index.js`），不深链 `/kit/runtime/…` ——
深链会让它们依赖库的内部结构，改一个目录名就静默 404。这条有常驻判据盯着。

## 画面自检的页面侧采样器

| 导出 | 说明 |
|---|---|
| `installAnalysis(ctx, render)` | 把逐帧采样器装到页面上（`window.__sampleFrames` / `window.__frameStats`）。画质自检要读 canvas 像素，**采样只能在页面里做，判定在 Node 侧**（`src/host/checks/browser/`） |

## 一个完整的镜头示例

节选自 `examples/minimal/shots/index.js`（可运行的完整版以它为准）：

```js
import {text, panel, rule, view, theme as C, fonts as F,
        S, BLK, cutBefore, inv, easeOut3, hexA, applyDesignScale} from 'filmwright';

const withDesign = function (fn) {
  return function (ctx, n, t, accent) {
    ctx.save();
    applyDesignScale(ctx);
    try { fn.call(this, ctx, n, t, accent); } finally { ctx.restore(); }
  };
};

const PURE = {
  start: cutBefore('S01'),
  draw(ctx, n) {
    const a = easeOut3(inv(n, BLK('S02', 1) - 4, BLK('S02', 1) + 16));
    if (a > 0.01) {
      ctx.save();
      ctx.globalAlpha = a;
      panel(ctx, 240, 220, 800, 150, {r: 16, fill: hexA(C.accents[0], 0.10), stroke: C.accents[0], lw: 2.4});
      text(ctx, 'drawFrame(ctx, N)', 640, 278, {size: 40, family: F.mono, align: 'center', baseline: 'middle'});
      ctx.restore();
    }
  },
};

export const SHOTS = [PURE].map((s) => ({...s, draw: withDesign(s.draw)}));
```
