# filmwright

[![CI](https://github.com/hongweifei/filmwright/actions/workflows/ci.yml/badge.svg)](https://github.com/hongweifei/filmwright/actions/workflows/ci.yml)

**一个视频引擎。** 你写**镜头代码**（哪一帧画什么）与**解说词**，它给你**帧**，
再把帧交给 ffmpeg 变成成片。

核心是一条工程约定：**第 N 帧只是 N 的函数** ——
不读上一帧、不累积状态、不读时钟。这一条让整条管线**可复现、可验证、可并行**，
也是它敢叫"引擎"而不是"生成器"的原因。

**运行时零依赖**：浏览器里的渲染层不 import 任何 npm 包；宿主工具链除 MCP 服务外零依赖。
只要有 Node 22+、一个 Chrome/Chromium/Edge、以及 ffmpeg，就能把一份解说词变成一条成片。

![示例片第 470 帧](docs/images/example-frame.png)

*`examples/minimal` 第 470 帧：HUD、章节主色、字幕与画面都由引擎内建件与镜头协同画出。*

![标题帧](docs/images/promo-title.png)

*一张引擎画出的标题帧：标题文字、章节主色、光晕与 HUD 都由原语与引擎内建件完成。*

## 引擎与"生成器"的区别

| | 生成器 | **这个引擎** |
|---|---|---|
| 同一输入两次出片 | 通常不同 | **同一帧逐字节相同**（跨机器、跨浏览器、跨分片） |
| 出片前能不能验 | 只能看成品 | **九道自检 + 一整批验收工具**，其中前七道不启浏览器、秒级 |
| 能不能只渲一段 | 得从头 | **任意帧可单独渲染**（所以能跳帧、能分片、能增量复用） |
| 卡在哪一帧 | 只能重跑 | **`--frame-transport cdp` 逐帧取回**，卡在哪立刻看得见 |
| 出错时 | 画面崩了才知道 | **错误画进画面**（渲染页把异常画成红字，防"看起来正常其实是坏的"） |

## 核心约定：第 N 帧只是 N 的函数

不读上一帧、不累积状态。这一条买来四件事：

| 买到什么 | 为什么 |
|---|---|
| **可全量自检** | 不截图、只跑绘制，几秒把几千帧全过一遍查抛错 |
| **可跳帧** | 任意帧随时出静帧，QC 才可能做 |
| **可增量重渲** | 输入指纹相同 ⇒ 画面相同，所以复用是安全的（有专门的验收工具证明这一点） |
| **可并行渲染** | 每片区间独立，可以同时开几个浏览器实例 |

⚠️ **但"可并行"不等于"更快"**：分片把编码这份 **CPU 密集**的工作摊到多个进程上，
而机器总吞吐固定。实测 4 片只拿到 **2.0×**（不是理想的 4×），根因是**页面侧 CPU 竞争**
（不是主机侧、也不是 ffmpeg —— 这一条做过实验，见 [LIMITATIONS](LIMITATIONS.md) 第 6 节）。
**先在你自己的机器上量一遍再决定开几片。**

时间轴由**解说词唯一生成**：改一句词，重新合成那一句（逐句缓存），帧号自动跟着变，镜头不用改帧号。

## 你写什么、引擎给你什么

你只写两样：**配置**（`film.config.mjs`）与**镜头代码**（`shots/index.js`）。
一个镜头就是 `{start, draw(ctx, n)}` —— 只声明从哪一帧接管画面，区间由引擎串接：

```js
import {text, panel, cutBefore, BLK, inv, easeOut3, hexA,
        theme as C, fonts as F, applyDesignScale} from 'filmwright';

export const SHOTS = [{
  start: cutBefore('S01'),
  draw(ctx, n) {
    const a = easeOut3(inv(n, BLK('S01', 1) - 4, BLK('S01', 1) + 16));
    if (a <= 0.01) return;
    ctx.save(); ctx.globalAlpha = a; applyDesignScale(ctx);
    panel(ctx, 240, 220, 800, 150, {r: 16, stroke: C.accents[0], lw: 2.4});
    text(ctx, '每一帧 = 一个纯函数', 640, 295, {size: 36, family: F.wide,
      color: C.text, align: 'center', baseline: 'middle', glow: hexA(C.accents[0], 0.6)});
    ctx.restore();
  },
}];
```

引擎给你：字幕（**可双语**）、章节卡、HUD、进度条、片尾、**镜头转场**
（crossfade / fade / slide / wipe / zoom）、**配乐混音**（自动闪避）、
**图层合成**（位移/缩放/旋转/组透明度/16 种混合模式）、**关键帧**、**效果链**、**遮罩**、
**3D 图层**、**片段素材**（视频/图片序列按源帧取图）、分片渲染、
**增量重渲与代理预览**、逐帧自检与画质自检、像素回归守卫、
可拖动可热重载的预览页。

## 能力面

下面这些都已在内，且**都没有破坏那条核心约定**（每一栏都写清"为什么它仍然只是 N 的函数"）：

| 能力 | 怎么写 | 为什么不破坏「第 N 帧只是 N 的函数」 |
|---|---|---|
| **绘制原语与组合件** | `text` / `panel` / `rule` / `bars` / `picture` / `wrap`…；`bigStat` / `chips` / `code` / `counter` / `flow` / `matrix` / `section` | 原语是纯绘制函数，输入除 `ctx` 只有参数与帧号 |
| **关键帧动画** | 镜头字段 `animate`（`beat` 或 `frame` 锚点 + 7 种缓动） | 编译期解析成「帧号 → 值」的纯函数；没写 `animate` 走快路径、**输出逐字节不变** |
| **效果链** | 镜头字段 `effects`（**11 个**具名效果：模糊/辉光/调色/暗角/色差/颗粒/马赛克/径向模糊/扭曲/调色预设/噪声置换），参数可写关键帧 | 效果只依赖 `(参数, 帧号)`；**直通值当帧短路、根本不进 GPU** ⇒ 没用到效果的项目逐字节不变 |
| **图层合成** | 镜头字段 `transform`（位移/缩放/旋转/`alpha`/`blend`/`origin`）与 `mask`（四形状 + 反选） | 变换量与裁剪路径只是 N 的函数；组透明度走离屏缓冲，默认参数走快路径 |
| **遮罩** | `mask`：`rect` / `rounded` / `ellipse` / `polygon`（归一化设计坐标 0–1）+ `invert` | 裁剪路径只依赖参数；坐标归一化 ⇒ 换分辨率不用改数字 |
| **转场** | 镜头字段 `transition`（5 种 + 方向） | 两个镜头的 `draw` 都只依赖 N，混合系数也是 N 的函数 —— 所以没用 ffmpeg 的 `xfade`（那会让帧依赖前一帧） |
| **嵌套合成** | `bindLocalShots` / `localFrame` / `drawCompInstance` 那组公开面自己组装子合成 | 全局帧 → 本地帧是纯换算，递归链上每一层都只依赖收到的帧号 |
| **片段素材** | 配置 `clips` 声明视频/图片序列，镜头里 `clipFrame(name, n)` 取图 | 抽帧是 host 的 I/O（内容寻址缓存），绘制只按 `源帧号 = f(N)` 查一张已预解码的图 |
| **3D 图层** | 镜头模块顶层 `await loadThree()`，`create3D(T, build)` 每帧同步渲 | 每帧把会动的属性**完整写一遍**（不累加、不读时钟）—— 这是 three 保留模式场景图最容易踩的坑，有专门的负面对照钉住它 |
| **增量重渲** | `render --incremental --proxy 0.5` | 输入指纹相同 ⇒ 画面相同，所以可以安全复用（有专门的验收工具证明这一点） |
| **overlay 内建件** | 背板 / 章节卡 / HUD / 进度条 / 字幕 / 片尾（`drawFrame` 每帧调） | 全部按 `view` 比例与帧号计算，与分辨率无关 |

**效果链与遮罩以"有界词汇表"为主**：具名效果 + 有界参数，遮罩四形状。
效果多了一条**受约束的逃生舱** —— `customPass(src, uniforms)` 交一段自己的
GLSL ES 1.0 片段着色器（单趟、一张输入纹理、uniform 只能是标量数值）；
遮罩那条路仍然**没有**逃生舱。为什么这样定、以及它带来的代价，
见 [LIMITATIONS 第 13 节](LIMITATIONS.md)。
能用词汇表表达的，不要自己重画一遍 —— 自己画的东西引擎不背书。

## 快速开始

需要 Node ≥ 22、Chrome/Chromium/Edge、ffmpeg；要配音再加 Python 3 + `edge-tts` + `numpy`。

```bash
git clone https://github.com/hongweifei/filmwright filmwright && cd filmwright
pip install edge-tts numpy          # 要配音时

node bin/filmwright.mjs voices --project examples/minimal                 # 先看有哪些 TTS 可用
node bin/filmwright.mjs tts    --project examples/minimal                 # 解说词 -> 配音 + 时间轴
node bin/filmwright.mjs check  --project examples/minimal --static-only   # 秒级：引用关系（不启浏览器）
node bin/filmwright.mjs render --project examples/minimal --shards 3      # -> .work/minimal.mp4（无声）
node bin/filmwright.mjs all    --project examples/minimal --shards 3      # -> renders/minimal.mp4
```

**没装 TTS 也能出片**：`all` 会跳过合流，把**无声成片**直接放到
`renders/<slug>.mp4` —— 也就是上面那个位置，不因有没有配音而变。

**配音不会因为一个服务挂了就做不了**：`tts.engine` 支持回退链（`'auto'` = edge → http → sapi → command）。
edge 音质最好但会整段不可用（实测 403），这时自动降级到 Windows 自带的离线引擎——
代价是音质一般、字幕切换点按字数估算（时间轴会如实标 `subs_timing`）。
也可以用 `tts.engine: 'http'` 接自己的云 TTS，或 `'command'` 接任意本地命令。

改镜头时的主力回路是预览页（拖动 / 播放 / 改文件热重载）：

```bash
node bin/filmwright.mjs preview --project examples/minimal
```

从空目录开始做一个新片子：

```bash
node bin/filmwright.mjs new my-film
# 改 script/narration.txt，写 shots/index.js
node bin/filmwright.mjs tts   --project my-film
node bin/filmwright.mjs all   --project my-film
```

## 命令

| 命令 | 作用 |
|---|---|
| `new` | 新建项目骨架（`shots` 一种模板），目录非空直接拒绝 |
| `mcp` | MCP 服务器（stdio），把整条工具链暴露给 agent |
| `check` | 九道自检：导出、模块路径、时间轴引用、素材、片段、主题键、全帧绘制、画质（明细见[质量保障](docs/qc.md)） |
| `preview` | 预览页：拖动时间轴 / 播放 / 热重载（SSE 推送，不是轮询） |
| `tts` | 解说词 → `audio.wav` + `timeline.json`（逐句缓存） |
| `voices` | 列出 TTS 引擎可用性与音色（做片子前先探路） |
| `clips` | 片段素材抽帧（视频 → 图片序列，内容寻址缓存） |
| `stills` | `--frames 40,470` 出静帧 |
| `sheet` | 抽帧联络表（人工 QC） |
| `render` | `[--shards N]` 逐帧渲染；`[--frame-format h264]` 走 WebCodecs 在页面里直接编 H.264（省掉"编 JPEG + ffmpeg 再编一遍"，端到端 **1.34×**） |
| `mux` | 画面与配音合流 |
| `srt` | 导出外挂字幕（SRT），可合成双语轨 |
| `all` | 一条龙：check → render → mux |

全部选项与产物落点见[命令参考](docs/cli.md)。

## 示例

`examples/minimal` 是**唯一示例**，也是像素回归的基线：一个手写的 4 镜头项目
（片头、纯函数示意、分片并行、拿到什么），用的全是公开面。

```bash
node bin/filmwright.mjs check --project examples/minimal --static-only   # 秒级，不启浏览器
node bin/filmwright.mjs stills --project examples/minimal --frames 470   # 出一帧看看
```

## 一个项目的形状

```
my-film/
  film.config.mjs        配置（default 导出）
  script/narration.txt   解说词
  script/timeline.json   tts 生成，渲染读它
  shots/index.js         镜头（导出 SHOTS）—— 画面的唯一来源
  public/fonts/…         字体（可选：库自带一份默认，放这里即覆盖）
  public/assets/…        素材与配音

  .work/                 中间产物，可随时删（重跑就有）
  renders/               成片，要留
```

## 质量网

| 层 | 是什么 | 什么时候跑 |
|---|---|---|
| `npm test` | 单元测试（纯函数、零依赖）+ 结构守卫 | 秒级 |
| `filmwright check` | **九道自检**，`--static-only` 时**前七道**不启浏览器；画质自检**带负面对照**（故意做坏，证明真的会报） | 秒级 / 一次渲染 |
| `tools/regression.mjs` | **像素回归**：纯结构改动必须逐字节复现基准，改一个像素都不算重构 | 一次渲染 |
| `tools/verify-*.mjs` | 真浏览器 / ffmpeg / 文档一致性 / 发布物的验收工具，绝大多数在 CI 自动跑（**逐个状态见 [tools/README](tools/README.md)**） | 约 5 分钟量级（四个作业真并行，墙钟＝最慢那个作业） |

细节见[质量保障](docs/qc.md)。CI 分**四个**作业：**static**（ubuntu / macOS / windows 三条）跑单元测试、
静态自检与文档一致性守卫；**browser**（ubuntu / windows）跑渲染类验收与端到端出片；
**browser-slow** 只放串行耗时最大的长片验证（`verify-longform`）；
**browser-doc** 只放 `verify-readme`（按 README 的路径真跑一遍）。
拆开是为了**真并行**：那批工具串行要十几分钟，而 GitHub 给每个 job 独立 runner，
墙钟就变成「最慢那个作业」。⚠️ **在非瓶颈作业里做优化对墙钟没有用** —— 拆完第一刀之后瓶颈就换人了；
**也别把慢工具加回 `browser`**（加了就是重复跑）。

**每个新能力都要带一条有区分力的判据与一个负面对照** —— 这是本仓库的硬纪律，
不是"有空再加"。几条现成的例子：

- 效果链：`amount=0` 与不写 `effects` **逐位相同**（证明短路真的生效）
- 遮罩：四种形状 + 反选输出**互不相同**（证明不是同一个路径换名字）
- 图层合成：每个字段的改动**互不相同**，关掉一个能力只影响它该影响的区间
- 3D：故意写成"累加"的版本，**同顺序连渲两遍仍然一致**，只有**乱序渲染同一帧**才抓得住

## 文档

| 文档 | 给谁看 |
|---|---|
| [入门](docs/getting-started.md) | 装环境、跑通示例、写第一个镜头 |
| [教程](docs/tutorial.md) | 从零做一个片子的完整流程 |
| [API 参考](docs/api.md) | 镜头里能 import 的一切、镜头对象的可选字段 |
| [效果链](docs/effects.md) | `effects`：11 个具名效果 + `custom` 逃生舱、`--gpu` 档位的取舍、`displace` 的实施清单 |
| [3D 图层](docs/three.md) | `loadThree()` / `create3D()`、retained-mode 陷阱、性能实测 |
| [AI / agent 接入](docs/ai.md) | MCP 服务器、`--json` 契约、推荐工作回路、错误码速查 |
| [配置参考](docs/config.md) | `film.config.mjs` 全部字段与校验规则 |
| [命令参考](docs/cli.md) | 全部命令与选项、产物落点 |
| [架构](docs/architecture.md) | 三层结构、核心不变量、设计决策 |
| [质量保障](docs/qc.md) | 自检、像素回归、验收工具 |
| [FAQ](docs/faq.md) | 报错与「为什么」类问题 |
| [LIMITATIONS](LIMITATIONS.md) | **明确不做什么、以及做不到什么** —— 用之前先读 |
| [CHANGELOG](CHANGELOG.md) | 版本历史（未发布区记着每次改动与它的验证） |

## 状态与参与

- 版本 **0.x**：核心管线完整、示例可复现，但**只在 Windows 上实测过**，
  且 CI 的三条 runner 里 windows 那条偶发浏览器启动超时。API 还在 0.x 语义下演进。
- 能力面：绘制原语与组合件、效果链（11 个具名 + `custom` 逃生舱）、关键帧、图层合成、遮罩、转场、嵌套合成、
  片段素材、3D（命令式）、overlay 内建件、增量重渲 —— 见上面的「能力面」。
- **已知边界**：720p30 的 10× realtime **未达成**（瓶颈是 CPU 编码吞吐，
  分片次线性；本机无硬件编码器）；效果以**有界词汇表**为主（另有受约束的 `custom` 逃生舱），
  遮罩**没有**逃生舱。完整实测见 [LIMITATIONS](LIMITATIONS.md)。
- 明确不做的（直接用 `video` 元素、富文本排版引擎、主题包机制……）与原因见 [LIMITATIONS](LIMITATIONS.md)。
  注意**外挂字幕不在其中** —— `filmwright srt` 可以导出（成片里字幕仍是烧进画面的，那是刻意的）。
- 欢迎报告问题与贡献：见 [CONTRIBUTING](CONTRIBUTING.md)（含提交规范与验证纪律）。
  参与本项目请遵守[行为准则](CODE_OF_CONDUCT.md)；安全相关问题走[安全策略](SECURITY.md)
  （**别开公开 issue**）。

## 许可

MIT，见 [LICENSE](LICENSE)。库自带的四款字体（[`fonts/`](fonts)）按各自许可分发（SIL OFL 1.1），见 [fonts/LICENSE.md](fonts/LICENSE.md)。
