# 配置参考：`film.config.mjs`

一个片子的全部外部输入都在这个文件里（default 导出一个对象）。引擎不认识任何片子——尺寸、颜色、字体、文案全从这里进来。写错的地方会**当场报错并指出是哪个字段**，不会静默退回默认值（静默退回会让一个拼错的字段变成「看起来正常但不对」的片子）。

最小可用配置只减不增，任何字段省略都有默认值；见仓库内 `examples/minimal/film.config.mjs`。

## 全部字段

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `slug` | string | `'film'` | 片名标识，决定配音路径 `public/assets/<slug>/audio.wav` 与产物名 |
| `size` | `{width, height}` | `1280×720` | 输出分辨率，必须为正数 |
| `fps` | number | `30` | 帧率，必须为正数 |
| `theme` | object | 见下 | 配色；逐键覆盖默认值 |
| `fonts` | object | 见下 | 字体栈；逐键覆盖默认值 |
| `fontFiles` | 数组 | 见下 | 要预加载的字体文件 |
| `title` | string 或 object | `null` | 片头文案；字符串会转成 `{big}` |
| `hud` | 数组 | `[]` | 顶部标签，按句 id 区间给出 |
| `chapterTech` | string[] | `[]` | 章节副标（第 2 章起显示），下标 = 章号 − 1 |
| `credit` | object | `null` | 片尾署名卡文案 |
| `builtBy` | string | `''` | 片尾「出品」一行 |
| `assets` | 数组 | `[]` | 素材声明，见下 |
| `endingFade` | number | `30` | 片尾压黑帧数 |
| `tts` | object | 见下 | 只被 `tts` 命令读 |

## `title` 与 `credit`

```js
title: {big: 'filmwright', rest: '最小示例', en: 'Draw every frame from its number', tagline: '…'},
credit: {kicker: 'EXAMPLE', title: 'filmwright', byline: '…', note: '…'},
```

`title` 传字符串等价于只给 `big`。

## `hud`

```js
hud: [
  {fromS: 'S01', toS: 'S03', label: '最小示例', tech: 'minimal'},
],
```

每项**必须有** `fromS` / `toS` / `label`（缺了配置期直接报错）；`tech` 是右下角的小字。区间按句 id 对齐，改解说词后帧号自动跟着变。

## `theme`：全部键与默认值

| 键 | 默认 | 用途 |
|---|---|---|
| `bg` | `#080B14` | 背景 |
| `bgDeep` | `#050710` | 更深的背景（片尾等） |
| `panel` | `#101725` | 面板底色 |
| `panelHi` | `#182136` | 面板高亮（终端标题栏等） |
| `line` | `#22304A` | 线与描边 |
| `lineSoft` | `#182238` | 弱线 |
| `text` | `#E9F0FA` | 主文字 |
| `dim` | `#8B99B4` | 次要文字 |
| `faint` | `#5A677F` | 最弱文字 |
| `codeBg` | `#0C1220` | 代码块底色 |
| `termBg` | `#05080F` | 终端窗口底色 |
| `ok` | `#35D07F` | 语义色：通过 |
| `bad` | `#FF6B6B` | 语义色：不通过 |
| `hi` | `#F5B942` | 语义色：高亮 |
| `accents` | 6 色 | 章节主色循环；**必须是非空数组**，章数超出长度时回绕 |

每个键都必须是非空颜色字符串——库内部的绘制默认色直接引用这些键，少一个就会在绘制时崩，崩的地方离配置很远。`accents` 的每个元素同样校验。

取章节主色用 `accentFor(章号)`（1 起，超出回绕）。**不要写 `accents[3]` 这种下标当默认值**——accents 的长度由使用者定，越界就是 `undefined`。

## `fonts` 与 `fontFiles`

默认字体栈（可逐键覆盖）：

| 键 | 默认 | 用途 |
|---|---|---|
| `sans` | `"Noto Sans SC", "Microsoft YaHei", sans-serif` | 正文 |
| `num` | `"Orbitron", "Noto Sans SC", sans-serif` | 数字 |
| `wide` | `"Audiowide", "Orbitron", sans-serif` | 大标题 |
| `mono` | `"Cascadia Mono", "Consolas", monospace` | 代码 |

`fontFiles` 声明要预加载的字体文件（相对项目的 `public/`）：

```js
fontFiles: [['Noto Sans SC', 'fonts/NotoSansSC.ttf', {weight: '100 900'}]],
```

字体没就绪就画，度量会全错（首帧用回退字体），所以 `boot()` 会等全部字体加载完。**字体加载失败是回退不报错**；素材图片失败才是抛错。

## `assets`（素材图片）

两种写法都行：

```js
assets: ['assets/filmstrip.png'],                                  // 名字取文件名（不含扩展名）
assets: [{name: '架构图', src: 'assets/arch.png'}],                 // 显式命名
```

- 文件放项目的 `public/` 下，页面按根路径取（`assets/a.png` → `/assets/a.png`）；
- 名字必须唯一，重复是配置错误（镜头引用它时无法区分是哪一张）；
- 算不出名字（路径以 `/` 结尾之类）直接报错，让你改写成 `{name, src}`。

镜头里用 `picture(ctx, '名字', x, y, w, h, opts)` 摆放；引用没声明的名字当场抛错并列出可用名字。详见 [API 参考](api.md)。

## `tts`：解说词 → 配音

| 键 | 默认 | 说明 |
|---|---|---|
| `engine` | `'edge'` | 目前只有 edge-tts |
| `voice` | `zh-CN-YunxiNeural` | 发音人 |
| `rate` | `'+0%'` | 语速 |
| `gap` | `10` | 句与句之间的空白帧 |
| `paraGap` | `20` | 段末（空行）后多留的空白帧 |
| `chapterGap` | `45` | 章前空白帧 |
| `lead` | `40` | 开头留白帧 |
| `tail` | `90` | 结尾留白帧 |
| `tries` | `8` | 单句合成重试次数（edge-tts 会限流） |
| `pace` | `0.6` | 限速节奏（秒） |

全部键都可以用环境变量覆盖：`TTS_ENGINE` / `VOICE` / `RATE` / `GAP` / `PARA_GAP` / `CHAPTER_GAP` / `LEAD` / `TAIL` / `EDGE_TRIES` / `EDGE_PACE`。

输出三件套：`public/assets/<slug>/audio.wav`、`script/timeline.json`（渲染与自检读它）、`script/timeline.md`（人读的表）。逐句缓存于 `audio/cache/`，改一句只重合成那一句。

## `clips`（视频 / 图片序列素材）

`assets` 只收图片。视频是**另一条路**：一段 5 分钟视频是 9000 帧，不可能全加载进内存。

```js
clips: [
  'assets/broll.mp4',                                          // 抽帧，默认 30fps
  {name: 'screen', src: 'assets/screen.mp4', fps: 30, width: 1280, start: 12, maxSec: 8},
  {name: 'seq', src: 'assets/frames/%04d.png', seq: true, fps: 30},  // 自己抽好的序列
],
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `name` | 文件名（不含扩展名） | 镜头里用它引用；重复会报错 |
| `src` | — | 视频文件；`seq: true` 时是图片序列的路径模式 |
| `seq` | `false` | `true` = `src` 已经是抽好的图片序列，不需要抽帧 |
| `fps` | `30` | 抽帧帧率，**也是运行时「秒 → 源帧号」的换算基准** |
| `width` | 不缩放 | 抽帧宽度（高度按比例）——**按实际显示尺寸抽能省很多磁盘与解码时间** |
| `start` | `0` | 从源的第几秒开始抽 |
| `maxSec` | 不限 | 最多抽多少秒 |

**它怎么不破坏「第 N 帧只是 N 的函数」**：分两层，各守各的规矩——

- **抽帧是 host 的 I/O**（异步、慢、有磁盘代价）：`filmwright clips` 或渲染前自动跑，把帧抽到 `.work/clips/<name>-<哈希>/`。哈希覆盖**源文件指纹 + 全部抽帧参数**，所以同样的源没变就直接复用，改一个参数就重抽——不会拿旧帧冒充新配置。
- **绘制仍是同步纯函数**：`源帧号 = round((n − 镜头起点) / 输出fps × clip.fps)`，只由全局帧 n 决定。取图是一次查表，读一张**boot 时已预解码**的图片。

预解码按**实际用到的区间**做（镜头只用几秒就只解那几秒的帧）；取到没预解码的帧会**抛错**（同图片素材的取舍：宁可报错也不要空白帧）。

## `music`（配乐）

一句话版：`music: 'assets/bgm.mp3'`。完整写法：

```js
music: {
  src: 'assets/bgm.mp3',   // 音乐文件，放项目的 public/ 下（与 assets 同一种取法）
  gain: -14,               // 音乐相对人声的增益 dB（默认 -14：人声为主，音乐垫底）
  duck: 10,                // 闪避强度 dB（默认 10：说话时把音乐压低；0 = 不闪避）
  fadeIn: 1,               // 片头淡入秒数（默认 1）
  fadeOut: 2,              // 片尾淡出秒数（默认 2）
}
```

**自动闪避（ducking）**：人声一响就把音乐压下去，说完再抬回来——由 ffmpeg 的
`sidechaincompress` 完成，以人声作触发信号。不需要人工标时间点，所以**改解说词、
句子移位之后不用重调**（与「时间轴由解说词唯一生成」同一条思路）。

| 字段 | 范围 | 说明 |
|---|---|---|
| `src` | 非空字符串 | 必填 |
| `gain` | −60 … 12 | 音乐整体增益；太大会盖住人声 |
| `duck` | 0 … 40 | 0 = 关掉闪避（纯混音）；越大压得越深 |
| `fadeIn` / `fadeOut` | ≥ 0 | 秒；淡出会自动夹到音乐长度的一半以内 |

音乐比片子长是常态（多余部分被裁掉）；比片子短也不会报错，自然结束。

配置校验会当场拦下写错的字段（`music.gain 要是数字`、`music.duck 不能大于 40`……），
不会静默退回默认值。

## 配置怎么被校验

`normalizeConfig()`（`src/contract/config.js`）负责校验与补默认：

- `size.width` / `size.height` / `fps` 必须是正数；
- `theme.accents` 必须是非空数组，每个元素非空字符串，其余 `theme` 键必须是非空颜色字符串；
- `hud` 每项必须有 `fromS` / `toS` / `label`；
- `assets` 每项要么是路径字符串，要么是 `{name, src}`；名字唯一且非空。

报错都带「收到什么」，从报错信息能直接定位到字段。
