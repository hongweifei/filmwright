# 运行时 API 参考

**这是命令式逐帧渲染的公开面。** 镜头只有一个来源：`shots/index.js` 导出 `SHOTS` 数组，
每一项是一个**镜头对象**；引擎按 `start` 串接区间，逐帧调 `draw(ctx, n, shot)`。

```js
import {text, panel, S, BLK, cutBefore, inv, easeOut3, applyDesignScale} from 'filmwright';
```

`'filmwright'` 由渲染页的 import map 解析到 `src/index.js`。**公开面上只有浏览器里跑的东西**——
Node 侧（CLI、渲染、自检）不在公开面上，镜头不该 import 它们。

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

### 镜头对象的可选字段

通用字段对每个镜头都可用，与 `draw` 同级。**写错在装配期当场报**（带 `code` / `hint`）：

| 字段 | 作用 | 校验来源 |
|---|---|---|
| `beats` | 节拍表（≥1 的整数帧号数组）。声明了它，画质自检的「末拍稳定期」从读数升级为**硬判据**；也是 `animate` 里 `beat` 锚点可用的前提 | 装配期（`setShots`） |
| `transform` | 位移 / 缩放 / 旋转 / `alpha` 组透明度 / `blend` 混合模式 / `origin` 变换中心 | `isValidTransform` + `BLEND_MODES` 白名单 |
| `animate` | 按关键帧驱动 `x` / `y` / `scale` / `rotate` / `alpha`（**属性与 `transform` 一一对应**；同名属性不能两处都写） | `validateAnimate` / `validateKeyTrack` |
| `effects` | 效果链，数组顺序即应用顺序；参数可以是关键帧轨道 | `validateEffects`（词汇表见[效果链](effects.md)） |
| `mask` | `rect` / `rounded` / `ellipse` / `polygon` + `invert` 反选，坐标是归一化设计坐标 | `validateMask` |
| `transition` | 入场转场：`{type, frames, direction}` 或直接给帧数 | `normalizeTransition`（第一个镜头只能用 `fade`） |

⚠️ 这些校验跑在**浏览器装配期**，所以 `check --static-only`（Node 侧、不开浏览器）**抓不到**；
要跑到渲染或预览才会报。这与「自检越早越好」的方向相反，是有意如实记下的现状。

## 配置与视口

| 导出 | 说明 |
|---|---|
| `theme` | 当前配色（`bg` / `panel` / `text` / `accents` / `ok`…，全表见[配置参考](config.md)） |
| `fonts` | 当前字体栈（`sans` / `num` / `wide` / `mono`） |
| `view` | 实际输出尺寸 `{W, H}`（活引用） |
| `DESIGN` | 设计基准 `{W: 1280, H: 720}` |
| `config()` | 取完整已装配置；未装时抛错 |
| `accentFor(i)` | 第 i 章主色（1 起，超出回绕） |
| `accent(i)` | 同 `accentFor`，但用于「第 i 个装饰元素」时的简写（回绕语义相同） |
| `install(cfg)` / `isInstalled()` | 装上配置 / 配置装没装（宿主装配用；镜头里一般不用） |
| `normalizeConfig(raw)` | 配置校验 + 补默认值（**写错的字段当场报错**，不静默退回默认） |
| `DEFAULT_THEME` / `DEFAULT_FONTS` / `DEFAULT_FONT_FILES` | 默认配色 / 默认字体栈 / 要预加载的字体文件清单 |

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
| `setTimeline(tl)` / `isReady()` | 装时间轴 / 时间轴装没装（宿主装配用；镜头模块在装载后才求值，所以镜头里读到的总是就绪的） |

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
| `kf(t, keys)` | 分段关键帧；`keys` 为 `[[t, 值], [t, 值, 缓动函数], …]`（第 3 项是「走到这一键」的缓动，不传即线性）。夹紧不外推 |
| `enter(n, f0, dur = 14, dy = 26)` | 入场：返回 `{a, dy}`（淡入 + 上移落位，**首帧全透明**） |
| `exit(n, f1, dur = 12, dy = 22)` | 离场：返回 `{a, dy}`（上移淡出，末帧归零） |
| `step(t)` | 硬切：`t < 1` 为 0，`t ≥ 1` 为 1（无过渡的状态切换用） |
| `EASE_NAMES` / `EASES` | 有界缓动词汇表的**名单** / 名字 → 函数（关键帧的 `ease` 字段只认这些名字：`linear` / `out3` / `out4` / `in3` / `inout3` / `back` / `step`） |

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
| `hexA(hex, alpha)` | 颜色 + 透明度 → `rgba(...)` 串（自己拼颜色时用；面板与光晕内部也用它） |

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

**逐字入场**（原来是模板的 `reveal` 字段，现在是原语的一个选项）：`title` / `quote` 那类标题文案
可以把长文本交给 `text` 的 `spacing` / `glow` 自己排，逐字进场则是「每个字自己的进度只依赖 n」
——按码点切字、每字按自己的 advance 居中，落位后与整块画法残差极小（实测最大差 24 级，来自光晕叠加）。

## 图片与素材

| 导出 | 说明 |
|---|---|
| `picture(ctx, name, x, y, w, h, o)` | 把声明的素材摆进框。选项：`fit`（`contain` / `cover` / `stretch`）、`align` / `valign`、`alpha`、`r`（圆角）、`pad`、`border` + `lw`、`glow` + `glowBlur`。返回实际绘制尺寸 `{w, h}` |
| `fitBox(natW, natH, boxW, boxH, fit)` | 纯函数：按 fit 规则算框内实际尺寸，可单独用来排版 |
| `img(name)` | 取图片元素（高级用法）；未声明的名字**当场抛错**并列出可用名字 |
| `imgSize(name)` | 原始尺寸 `{w, h}` |
| `assetNames()` | 全部已声明素材名 |
| `assetsReady()` | 素材是否全部就绪 |
| `loadAssets(list)` | 按清单加载素材（宿主装配用；`boot()` 已经替你调了） |

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

## 关键帧求值

| 导出 | 说明 |
|---|---|
| `compileAnimate(animate, node)` | 把 `animate` 声明编译成「帧号 → 值」的求值器（`node` 给 `{beats, from}`） |
| `evalAnimate(compiled, n)` | 按绝对帧号求值（关键帧的锚点在这一步落地） |
| `mergeAnimate(transform, compiled, n)` | 把静态 `transform` 与动画结果合并成一份变换 |

镜头对象上的 `animate` 字段由引擎在装配期自动编译，一般不用手调这三个；
它们公开是因为**手写镜头自己组装子合成 / 自定义节点时**要用到同一套时间基。

## 阶段（一般不用，自检与调试用）

| 导出 | 说明 |
|---|---|
| `boot(project, resize)` | 装配：装配置 / 时间轴 → 等字体与素材就绪 → 求值镜头模块 → 串接区间。**两份宿主页面（`src/host/pages/`）用的就是它** |
| `drawFrame(ctx, n)` | 按帧号画完整一帧（内建件 + 当前镜头 + 片尾） |
| `shots()` / `shotAt(n)` | 镜头表（带串接好的 `from` / `to`）/ 帧号 → 所在镜头 |
| `chapterCards()` | 已组装的章节卡 |
| `bindShots(list, totalFrames)` / `setShots(list)` | 把镜头表串接成带 `from` / `to` 的区间 / 直接装上（装配与测试用） |
| `normalizeTransition(t)` / `transitionAt(n)` | 转场声明归一化 / 帧号 → 当前转场（内建件用） |

`boot` 与下一节的 `installAnalysis` 之所以在公开面上，是因为**宿主页面也要用**：
两份宿主页面只 `import` 公开面（`/kit/index.js`），不深链 `/kit/runtime/…` ——
深链会让它们依赖库的内部结构，改一个目录名就静默 404。这条有常驻判据盯着。

## 画面自检的页面侧采样器

| 导出 | 说明 |
|---|---|
| `installAnalysis(ctx, render)` | 把逐帧采样器装到页面上（`window.__sampleFrames` / `window.__frameStats`）。画质自检要读 canvas 像素，**采样只能在页面里做，判定在 Node 侧**（`src/host/checks/browser/`） |
| `INK_THR` / `contentRect(ctx)` | 墨迹阈值（静止判定口径）/ 扣掉 HUD 与字幕带的内容区（**与 Node 侧判定共用同一口径**，所以它在公开面上） |

## 图层合成与嵌套合成

镜头声明 `transform` / `mask` 时走的就是这一组 —— **自己画的多层内容也可以用同一条路径**（`withLayer`），
所以「镜头级变换」与「手工分层」的语义完全一致。

| 导出 | 说明 |
|---|---|
| `withLayer(ctx, …)` | 按层的 `transform` / 透明度 / `blend` 画一次回调；镜头级变换与手工分层共用 |
| `applyLayerTransform(ctx, t, n)` / `applyShotTransform(ctx, …)` | 把（可带关键帧的）变换应用到 ctx |
| `isValidTransform(t)` | 变换字段校验（`blend` 走 `BLEND_MODES` 白名单 —— 非法值不会被 Canvas 静默忽略） |
| `BLEND_MODES` | 16 个混合模式的**单一来源**（契约与运行时指向同一个对象） |
| `bufferStats()` / `needsBuffer(…)` | 合成缓冲区统计 / 这层要不要单独缓冲区 |
| `bindLocalShots(…)` / `compLength(…)` / `localFrame(…)` / `drawCompInstance(…)` / `mapBeats(…)` | 子合成实例的装配、长度、本地帧映射、绘制与节拍映射 |
| `assertNoCycles(comps)` | 子合成引用成环**当场报错**（成环会无限递归） |

子合成的时间基契约：**子合成内部的 `start` 只能是本地帧号**（从 1 起）；要跟解说词对齐，
在实例化那一层用 `cutBefore('S05')` 算好再传进去。全局帧 → 本地帧是纯换算，
所以递归链上「第 N 帧只是 N 的函数」依然成立。

## 片段（视频 / 图片序列）

宿主侧抽帧、运行时按**源帧号**同步取图 —— 不用 `video` 元素，原因见[已知限制](../LIMITATIONS.md)。

| 导出 | 说明 |
|---|---|
| `clipFrame(name, …)` / `clipInfo(name)` | 取某源帧的画面 / 片段的元信息（帧数、尺寸、fps） |
| `clipNames()` / `clipsReady()` / `decodedCount(name)` | 已声明的片段名 / 是否全部就绪 / 已解出多少帧 |
| `sourceIndex(name, n)` / `preloadClipFrames(…)` / `setClips(…)` | 帧号 → 源帧下标 / 预取 / 装配（后两个是宿主与测试用的） |

## 效果链（编译与执行）

有界词汇表（见[效果链](effects.md)）：**枚举效果 + 有界参数**，参数可以写成关键帧轨道。
**唯一的例外**是逃生舱 `custom`：作者交一段自己的 GLSL ES 1.0 片段着色器（单趟、
一张输入纹理、uniform 只能是标量数值，上限见下面三个常量）。

| 导出 | 说明 |
|---|---|
| `EFFECT_TYPES` / `EFFECT_SPECS` / `EFFECT_CHAIN_MAX` / `EFFECT_ERROR_CODES` / `GRADE_LOOKS` | 效果类型 / 每个效果的字段与范围 / 链长上限 / 错误码 / 调色预设 |
| `customPass(src, uniforms?)` | 逃生舱的作者入口：打包成 `{type: 'custom', src, uniforms}`。校验**不在这里**（唯一一份规则在 `validateEffects`） |
| `CUSTOM_SRC_MAX` / `CUSTOM_UNIFORM_MAX` / `CUSTOM_RESERVED` | 源码长度上限 / uniform 条数上限 / 引擎保留的 uniform 名（`t` / `texelX` / `texelY` / `frame` / `type` / `src`） |
| `validateEffects(decl)` | 校验一处 `effects` 声明，返回错误数组（每条带 `code` / `path` / `message` / `hint`） |
| `compileEffects(decl, node?)` | 把 `effects` 声明编译成可执行的步骤序列 |
| `evalEffects(compiled, n)` | 按帧求值（关键帧参数在这一步落地） |
| `isNoopEffects(…)` | 声明是不是等于「什么都不做」（走快路径，不碰 GPU） |
| `applyEffects(srcCanvas, compiled, n)` | 跑一遍效果链，**返回结果画布**（没效果时返回 `null`，调用方走原路） |
| `paintWithEffects(ctx, fx, alpha, n, drawInto)` | 画 + 合成（转场淡入要乘 alpha；合成用 `source-over` 保留引擎已画的背景） |
| `getScratch(w, h)` | 共用暂存画布（避免每帧新建） |
| `blurPlan(radius)` / `pyramidLevel(radius)` | 模糊的金字塔规划 —— **纯数学、零 GL 依赖** |

## 契约校验（镜头字段的规则）

镜头对象的可选字段写错**当场报**，规则只有这一份（引擎在装配期调用，手写镜头也可主动调来自检）：

| 导出 | 说明 |
|---|---|
| `validateAnimate(animate, transform, path?)` | 总校验一处 `animate`，返回错误数组 |
| `validateKeyTrack(keys, where, opts?)` | 校验**一条关键帧轨道**（`animate` 的每个属性、效果参数的关键帧共用同一份规则） |
| `ANIM_PROPS` / `ANIM_ERROR_CODES` | 可动画属性（`x` / `y` / `scale` / `rotate` / `alpha`）/ 关键帧这一族的错误码 |
| `validateMask(mask, path?)` / `MASK_SHAPES` / `MASK_ERROR_CODES` | 遮罩校验 / 四种形状（`rect` / `rounded` / `ellipse` / `polygon`）/ 错误码 |
| `TRANSITION_TYPES` / `TRANSITION_DIRECTIONS` | 转场类型（`crossfade` / `fade` / `slide` / `wipe` / `zoom`）/ 方向（`left` / `right` / `up` / `down`） |
| `ERROR_CODES` | **全部错误码的登记表**（关键帧 + 遮罩 + 效果三族；有测试扫源码与它双向比对） |

## overlay（背板 / 章节卡 / HUD / 进度 / 字幕 / 结尾）

引擎内建件。**自己读 `view` 按比例摆，与分辨率无关**；镜头一般不用它们（`drawFrame` 会调）。

| 导出 | 说明 |
|---|---|
| `drawBackdrop(ctx)` | 背板底纹 |
| `drawChapterCard(ctx, …)` / `setChapterCards(…)` | 章节卡绘制 / 装配 |
| `drawHud(ctx, …)` | 左上角的 HUD |
| `drawProgress(ctx, …)` | 底部进度条 |
| `drawSubtitle(ctx, …)` | 字幕带 |
| `drawEnding(ctx, …)` | 片尾 |

## 页面侧 h264 编码

WebCodecs 编码在**页面里**跑（Node 侧只收裸流）。

| 导出 | 说明 |
|---|---|
| `h264Available()` | 这台机器 / 这个页面能不能用硬件 h264 |
| `createH264Encoder(…)` | 建编码器（含队列与背压） |
| `annexBFromChunk(chunk)` | `EncodedVideoChunk` → Annex-B 裸流（ffmpeg 直接吃） |

## 3D 图层（现成的 three，**可选**依赖）

**不在文件顶层 `import 'three'`** —— 那样所有项目都要付 2.2MB 的加载代价；由镜头模块自己
在顶层 `const T = await loadThree()`（细节见 [3D 图层](three.md)）。

| 导出 | 说明 |
|---|---|
| `loadThree()` | 动态加载 three（返回 three 命名空间；顶层 await 是调用方的事，因为 `draw` 是同步的） |
| `create3D(T, build, opts)` | 建一个 3D 场景实例，返回带同步 `render(ctx, n)` 的对象 |
| `ensureThree()` / `getThree()` / `getRenderer()` | 取（必要时先建）3D 运行时 / three 命名空间 / 共享渲染器 —— 引擎内部与热重载、测试用；命令式镜头走 `loadThree()` + `create3D()` |

## 一个完整的镜头示例

节选自 `examples/minimal/shots/index.js`（可运行的完整版以它为准，全片 4 个镜头）：

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
