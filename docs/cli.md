# 命令行参考

```bash
node bin/filmwright.mjs <命令> --project <项目目录> [选项]
```

全局安装（`npm link`）后也可直接用 `filmwright <命令> …`。

## 通用选项

| 选项 | 说明 |
|---|---|
| `--project <目录>` | 项目目录（内含 `film.config.mjs`），**必填**，所有命令都要 |
| `--browser <路径>` | 浏览器可执行文件；也可用环境变量 `CHROME_BIN` |

环境不满足时（Node 版本、WebSocket、浏览器）启动即报清楚缺什么（`src/host/preflight.mjs`），不会等到深处报 `WebSocket is not defined`；`render` / `mux` / `sheet` 在干活前先查 ffmpeg，缺了当场报，不会渲到一半崩在 spawn 上。

外部工具的位置可用环境变量指定：

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `CHROME_BIN` | 自动查找 | 浏览器可执行文件 |
| `FFMPEG_BIN` | `ffmpeg` | ffmpeg 可执行文件路径 |
| `FFPROBE_BIN` | `ffprobe` | ffprobe 可执行文件路径 |
| `FILMWRIGHT_NO_OPEN` | — | 设了就等价于 `preview --no-open` |

## `--json`：给 agent 的输出

除 `preview` 外的命令都接受 `--json`：stdout **恰好一个 JSON 文档**（人类进度全部静默；ffmpeg/Chrome 的日志走 stderr，不污染 stdout），退出码与 `ok` 一致。

```json
{
  "ok": false,
  "command": "check",
  "errors": [
    {"code": "SCENE_UNKNOWN_TYPE", "message": "不认识的镜头类型 \"pie\"",
     "where": "shots[1].type", "hint": "v0 可用：title / bullets / …"}
  ],
  "warnings": ["assets：素材「x」声明了但镜头里没人用"],
  "data": {"failed": 1, "checks": [{"name": "scene", "ok": false, "checked": 8, "problems": ["…"]}]}
}
```

要点：

- **每条错误带 `code` 与 `where`**（`scene` 的校验错误直接给 `shots[i].field` 路径）——错误信息是给模型读的 prompt，读完能直接改；
- `data` 按命令给产物路径与统计：`render` 给 `{out, frames, seconds, shards}`，`stills` 给 `{files}`，`all` 给 `{video, final, checks}`，`tts` 给 `{audio, timeline, …}`；
- 没配音时 `all` 返回 `ok: true` 且 `data.muted: true`（跳过合流不是失败，但要让调用方知道）。

## 命令一览

| 命令 | 作用 |
|---|---|
| `new` | 新建项目骨架（scene / shots 两种模板） |
| `schema` | 输出 scene 规格的机器可读 schema（16 类模板、字段、上限、错误码） |
| `mcp` | MCP 服务器（stdio），把工具链暴露给 agent |
| `check` | 十道自检（[质检文档](qc.md)） |
| `preview` | 预览页：拖动 / 播放 / 热重载 |
| `tts` | 解说词 → 配音 + 时间轴（引擎可换、可回退） |
| `voices` | 列出 TTS 引擎可用性与音色（做片子前先探路） |
| `stills` | 出指定帧的静帧 |
| `sheet` | 抽帧联络表（人工 QC 用） |
| `render` | 逐帧渲染成无声视频 |
| `mux` | 画面与配音合流 |
| `srt` | 导出外挂字幕（SRT），可合成双语轨 |
| `all` | 一条龙：check → render → mux |

## `new`

```bash
filmwright new <目录> [--template scene|shots]
```

建一个能直接跑通的最小项目：`film.config.mjs`、`script/narration.txt`、`scene.json`（默认模板）、`.gitignore`、`public/` 占位说明；`--template shots` 改产手写镜头骨架。目标目录**已存在且非空会直接拒绝**（`DIR_NOT_EMPTY`），脚手架从不覆盖已有文件。`slug` 取目录名并净化。

## `mcp`

```bash
npm install          # 只有 MCP 需要依赖；其余命令零依赖
filmwright mcp       # stdio 服务器，日志走 stderr，Ctrl+C 结束
```

把整条工具链作为 MCP 工具暴露给 agent（new / timeline / scene_validate / tts / check / stills / render / all），返回值与 `--json` 同形状。客户端配置与推荐的 agent 工作回路见 [AI / agent 接入指南](ai.md)。

## `schema`

```bash
filmwright schema          # 人读：16 类模板的用途、字段、上限、对齐语法、错误码
filmwright schema --json   # 机读：同一份数据的 JSON（agent 写 scene 前先拿它）
```

不需要 `--project`——schema 是框架自己的说明书，与具体片子无关。MCP 客户端用 `filmwright_schema` 工具拿同一份数据。

## `check`

```bash
filmwright check --project <项目目录> [--static-only] [--no-quality]
                 [--static-frames N] [--hold-frames N] [--ink-min N] [--quality-step N]
```

- `--static-only`：只跑读文件的前八道，不启浏览器，秒级。CI 与改完镜头的快速验证用。
- `--no-quality`：跑逐帧自检但跳过画质统计。
- 四个数值参数覆盖画质阈值（默认按 1280×720 的 32×18 网格校准）。含义见 [LIMITATIONS](../LIMITATIONS.md)。

## `preview`

```bash
filmwright preview --project <项目目录> [--no-open] [--seconds N]
```

- 起 `http://127.0.0.1:<端口>/preview` 并自动打开系统浏览器；`Ctrl+C` 结束。
- `--no-open` 不自动开浏览器（无头环境 / 自动化用）；环境变量 `FILMWRIGHT_NO_OPEN` 等效。
- `--seconds N` 跑够 N 秒自动退出（自动化测试用）。

页面上：**拖动**底部滑杆或按 `←` `→` 逐帧（按住 `Shift` 走 30 帧）、`Home` / `End` 跳首尾、**空格**播放/暂停（按真实时间推进，速度与成片一致）；右侧镜头列表点一下跳到该镜头首帧；右侧信息面板显示总帧数 / 时长 / 章节 / 镜头。

热重载只盯三处：`shots/`、`film.config.mjs`、`script/timeline.json`——不盯整个项目目录，否则 `.work/` 里的渲染产物会自己触发自己。预览页与渲染页共用同一套运行时，**预览看到的和渲出来的是同一份代码**。

## `voices`

```bash
filmwright voices --project <项目目录> [--json]
```

**做片子之前先探路**：实测各 TTS 引擎现在能不能用、列出可用音色、并说明最终会用哪一个（含回退结果）。

为什么需要它：TTS 是联网服务、会整段不可用（实测 edge 合成 403，而 `list_voices` 端点正常——微软侧故障）。先问一句「现在能用什么」，比合成到一半才发现引擎挂了要好。输出里还会说明各引擎**有没有词边界**（决定字幕能否精确对齐）以及当前会不会降级到离线引擎。

## `tts`

```bash
filmwright tts --project <项目目录>
```

读 `script/narration.txt` 生成配音与时间轴。引擎由 `film.config.mjs` 的 `tts.engine` 定，**支持回退链**（`'auto'` = edge → sapi → command）；逐句缓存，改一句只重合成一句。失败时按原因给出路：服务不可用会明确说「换引擎或等」，并提示离线后备怎么开。

详见 [配置参考的 tts 段](config.md#tts解说词--配音)。

```bash
filmwright tts --project <项目目录>
```

读 `script/narration.txt`，调 Python 跑 edge-tts，产出：

- `public/assets/<slug>/audio.wav`——配音；
- `script/timeline.json`——时间轴（渲染与自检读它，**时间轴的唯一来源**）；
- `script/timeline.md`——人读的时间轴表；
- `audio/cache/`——逐句缓存（内容寻址），改一句只重合成那一句。

需要 Python 3 + `edge-tts` + `numpy`（`pip install edge-tts numpy`）。引擎/发音人/节奏等配置见[配置参考](config.md)的 `tts` 段。端点会限流，库内已做限速 + 超时 + 退避重试。

## `stills`

```bash
filmwright stills --project <项目目录> --frames 40,200,500 --dir <目录>
```

出指定帧的 PNG 静帧。`--frames` 逗号分隔帧号，`--dir` 必填（建议给 `.work/` 下的路径）。判断「这一帧为什么长这样」时最直接。

## `sheet`

```bash
filmwright sheet --project <项目目录> [--from 1] [--to <总帧>] [--step 150] [--cols 4] [--out <png>]
```

按步长抽帧拼成联络表，默认写到 `.work/qc/sheet.png`。文案错字、数字错、遮挡这类「画质自检看不懂内容」的问题，靠人看联络表抓。

## `clips`

```bash
filmwright clips --project <项目目录> [--cache-dir <目录>]
```

把配置里声明的视频类片段抽成图片序列（`ffmpeg`），落在 `.work/clips/<name>-<哈希>/`。**内容寻址**：源文件或抽帧参数（fps/width/start/maxSec）没变就命中缓存、不重抽；改一个参数就是新的键。

`render` 与 `preview` 会**自动**在开会话前跑这一步（抽帧必须在开画前完成，因为页面里的绘制是同步的）。单独跑它是为了：长视频先抽好省得每次等、或只想确认抽帧结果。

## `render`

```bash
filmwright render --project <项目目录> [--shards N|auto] [--resume] [--from N] [--to M] [--out x.mp4] [--crf 16]
```

- 默认渲整条时间轴，输出 `.work/<slug>.mp4`。
- `--shards N` 分片并行：每片一个独立浏览器实例，各渲一段，最后 ffmpeg concat 无损拼接。片数开太多会吃内存（每实例约几百 MB），超过 CPU 核数收益递减。
- **`--shards auto`**：按 CPU 核数自动定（留一核给主进程，每片至少约 60 帧）。
- **`--resume`**：复用 `.work/parts/` 里已完成的分片，不从头渲 —— 长片渲到一半挂掉时用。**注意**：它只判文件存在且非空，**不校验内容**；改过时间轴或镜头之后旧分片已不对应，那种情况别加 `--resume`。
- **分片失败自动重试一次**：长片最常见的失败是浏览器抖动（无头实例偶发退出），不是内容问题。重试成功会在输出里标「（重试后成功）」，`--json` 的 `retried` 与 `parts[].attempts` 如实记录；两次都失败仍然报错（不掩盖），并提示用 `--resume` 续跑。
- `--from` / `--to` 只渲一个区间（调试某一段时用）。
- `--crf` 传给 ffmpeg 的质量参数，默认 16。
- `--json` 里带性能读数：`seconds` / `msPerFrame` / `parts[{i,from,to,seconds,reused}]` / `reused` —— 换机器、换浏览器后可以直接对比。

实测参考：1280×720 约 81 ms/帧（单实例，Chrome-for-Testing，本机）。

## `render`

```bash
filmwright render --project <目录> [--out x.mp4] [--shards N|auto] [--from N --to M]
                  [--resume] [--incremental] [--proxy 0.5] [--seg-frames 300]
                  [--frame-format jpeg|png] [--preset medium]
```

| 开关 | 作用 |
|---|---|
| `--shards N` | 分片并行（`auto` 按 CPU 数）；每片一个浏览器实例，崩了自动重试一次 |
| `--resume` | **同一次渲染**被中断后续跑：已渲好的分片直接复用 |
| `--incremental` | **跨次**复用：按内容哈希切段，只重渲变化了的段。scene 项目按镜头归因——改一个镜头只重渲覆盖它的那几段 |
| `--proxy 0.5` | 代理渲染：半分辨率（或任意 0–1 比例）快速预览。**只改输出尺寸，不改绘制逻辑**，构图与成片一致 |
| `--seg-frames N` | `--incremental` 的段长（默认 300 帧 ≈ 10 秒） |
| `--frame-format <fmt>` | 中间帧格式：`jpeg`（默认）/ `jpeg:92` / `png`。**jpeg 快约 3.75×**（实测 48.4 vs 181.3 ms/帧），代价是产物约大 24%；要逐像素比对时用 `png` |
| `--preset <p>` | x264 编码预设（默认 `medium`）。越慢压得越小；渲染瓶颈通常不在这里 |

**性能**：瓶颈是**取像素与搬运**，不是绘制。实测（1280×720）绘制只占 0.6ms，
而 PNG 编码 50.1ms、载荷 1243KB/帧。所以中间帧默认改用 JPEG（载荷降到 87KB），
并把每帧的**两次 CDP 往返合并成一次**：

| 配置 | ms/帧 | 相对最初 |
|---|---|---|
| 最初（PNG + 每帧两次往返） | 217.3 | 1.0× |
| 合并往返 + JPEG 中间帧 | 66.3 | **3.3×** |
| 再加 4 片并行 | 30.5 | **7.1×** |

画质代价：与 PNG 路线的成片 PSNR **48.45 dB**（>45dB 属视觉透明）。
分片现在确实有效（4 片 2.17×）—— 之前「分片更慢」的根因正是 PNG 的 1.2MB/帧载荷
把 node 主线程堵住了，详见 [LIMITATIONS 第 6 节](../LIMITATIONS.md)。

`--incremental` 的键分**两层**，这样才能「改一处只重渲一小段」：

| 层 | 覆盖什么 | 失效范围 |
|---|---|---|
| **全局** | 引擎源码、`film.config.mjs`、时间轴、字体与素材**文件内容**、`clips` 声明、输出参数 | 改了就**所有段**都失效 |
| **局部** | 与该段区间**重叠的 `scene.json` 镜头**，以及它引用的 `comps`（含嵌套引用） | 只让覆盖它的那几段失效 |

所以改一个镜头的文案，只有压住它的那一两段重渲，其余段照旧复用。段缓存落在 `.work/segments/`，完成后会清掉不再匹配的旧段。`--json` 里的 `attribution` 会说明粒度：

- `per-shot`（scene 项目）：按镜头归因，如上表；
- `whole-file`（手写 `shots/index.js` 项目）：镜头文件无法按帧归因，**整个文件算全局** —— 改一行就会全渲（保守但正确）。

迭代复杂镜头时的推荐组合：`--incremental --proxy 0.5`（先半分辨率快速看节奏，满意后再全分辨率出片）。

## `mux`

```bash
filmwright mux --project <项目目录> --video <视频> [--out y.mp4]
```

画面与配音合流，默认输出 `renders/<slug>.mp4`。`--video` 必填（通常传 `render` 的产物）；找不到 `public/assets/<slug>/audio.wav` 会提示先跑 `tts`。

**配置里声明了 `music` 就自动混配乐**（带自动闪避：说话时压低音乐），否则保持「只混人声」。`--json` 里会回报 `music: {src, gain, duck}`。配乐文件找不到会报 `NO_MUSIC_FILE` 并指出它期望的路径。

## `srt`

```bash
filmwright srt --project my-film                        # -> script/<slug>.srt
filmwright srt --project my-film --translation tr.json  # 双语轨
```

字幕**已经烧进画面**，这份 SRT 是给 B 站 / YouTube 投稿用的外挂字幕。时间戳按 `fps` 从帧号换算；块与块之间的空隙**用下一块的开始补齐**，避免字幕在空隙里闪断。

**框架不翻译**（AI 在框架外的边界不破）：译文由外部产出后传进来，两种格式都认——

```json
[{"from": 106, "to": 197, "text": "Translated line"}]   // 按 from 帧对齐
{"1": "Translated line", "2": "…"}                      // 按字幕块序号对齐（1 起）
```

两种都允许缺项：没给译文的块只出原文，**不编内容**。

## `all`

```bash
filmwright all --project <项目目录> [--shards N] [--out x.mp4] [--final y.mp4]
```

一条龙：自检没过直接停（`自检没过，先修再渲`），渲完自动合流到 `renders/<slug>.mp4`（`--final` 可改）。没有配音时跳过合流并说明落点。

## 产物落在哪

只有两类目录，别混：

| 目录 | 内容 | 能删吗 |
|---|---|---|
| **`.work/`** | 原始视频、分片、联络表、静帧、像素基准 | **能**，重跑就有 |
| **`renders/`** | 成片（`mux` / `all` 的产出） | 留着 |

| 命令 | 默认落点 |
|---|---|
| `render` | `.work/<slug>.mp4`，分片在 `.work/parts/` |
| `mux` / `all` | `renders/<slug>.mp4` |
| `sheet` | `.work/qc/sheet.png`，临时帧在 `.work/qc/_sheet_tmp/` |
| `stills` | `--dir` 指定的目录（建议 `.work/` 下） |
| `tts` | `public/assets/<slug>/audio.wav` + `audio/cache/` |
