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
| `check` | 九道自检（[质检文档](qc.md)） |
| `preview` | 预览页：拖动 / 播放 / 热重载 |
| `tts` | 解说词 → 配音 + 时间轴 |
| `stills` | 出指定帧的静帧 |
| `sheet` | 抽帧联络表（人工 QC 用） |
| `render` | 逐帧渲染成无声视频 |
| `mux` | 画面与配音合流 |
| `all` | 一条龙：check → render → mux |

## `check`

```bash
filmwright check --project <项目目录> [--static-only] [--no-quality]
                 [--static-frames N] [--hold-frames N] [--ink-min N] [--quality-step N]
```

- `--static-only`：只跑读文件的前六道，不启浏览器，秒级。CI 与改完镜头的快速验证用。
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

## `tts`

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

## `render`

```bash
filmwright render --project <项目目录> [--shards N] [--from N] [--to M] [--out x.mp4] [--crf 16]
```

- 默认渲整条时间轴，输出 `.work/<slug>.mp4`。
- `--shards N` 分片并行：每片一个独立浏览器实例，各渲一段，最后 ffmpeg concat 无损拼接。片数开太多会吃内存（每实例约几百 MB），超过 CPU 核数收益递减。
- `--from` / `--to` 只渲一个区间（调试某一段时用）。
- `--crf` 传给 ffmpeg 的质量参数，默认 16。

实测参考：1280×720 约 81 ms/帧（单实例，Chrome-for-Testing）。

## `mux`

```bash
filmwright mux --project <项目目录> --video <视频> [--out y.mp4]
```

画面与配音合流，默认输出 `renders/<slug>.mp4`。`--video` 必填（通常传 `render` 的产物）；找不到 `public/assets/<slug>/audio.wav` 会提示先跑 `tts`。

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
