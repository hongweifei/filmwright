# 变更日志

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；
版本号由维护者手动写入本文件，不自动生成。

## [未发布]

### 新增

- **场景规格 `scene.json`（AI 自动化的入口）**：声明式镜头，v0 含 7 类模板（title / bullets / stat / flow / code / image / compare）。AI 只填内容与节拍（`at` 支持帧号、句 id、`{s, block, lead, offset}`），入场错峰、停留呼吸、章节配色、设计缩放由模板内建。手写 `shots/index.js` 保留为逃生舱，两者可混用。校验与 boot 共用一份实现（`src/contract/scene.js`），错误带 code/path/hint；静态自检加第 9 道 `scene`（`--static-only` 七道不启浏览器）。示例 `examples/scenecast` 整个项目没有 `shots/`，画面全部来自规格（其 `timeline.json` 是合成夹具；跑 `tts` 会生成真实配音）。
- 文档：docs/scene.md 场景规格参考。

### 修复

- 渲染会话以无头模式（`--headless=new`）启动浏览器。此前注释写的是无头、参数里却从未传过这个旗标，在有显示器的机器上碰巧能跑；CI 的 Ubuntu 没有 X server，浏览器直接退出（`Missing X server or $DISPLAY`）。本机已验证无头渲染与既有像素基准逐字节一致（6/6 帧），基准无需重抓。
- `tools/verify-assets.mjs`、`tools/verify-preview.mjs` 改为走 `openSession`：此前各自复制了一份浏览器启动逻辑，既漏掉 headless，又在浏览器提前退出时一直空等 30 秒，最后报出 `Failed to parse URL from http://127.0.0.1:null/json/list` —— 一个掩盖真实原因的错。现在启动失败当场报出浏览器 stderr。`tools/boot-error.mjs` 是抓 boot 失败的诊断工具，保留自己的事件流，同样补了无头与快速失败。
- ffmpeg / ffprobe 的定位与 spawn 收拢到 `src/host/media/ffmpegBin.mjs`：此前三处 spawn 都没挂 `error` 监听，ffmpeg 缺失时以 unhandled `error` event 崩掉，只见 `spawn ffmpeg ENOENT` 堆栈。现在 `render` / `mux` / `sheet` 在干活**前**先用 `which` 断言，缺了当场报「装什么、怎么指定」；spawn 层再兜底。路径可用 `FFMPEG_BIN` / `FFPROBE_BIN` 指定。CI 的「确认环境」一步同时修了一个假检查：`ffmpeg -version | head -1` 在 ffmpeg 缺失时也绿（管道退出码取的是 `head` 的 0），现改为 `command -v` 硬断言并显式安装 ffmpeg。

### 变更

- CI 的渲染 job 用「同一次运行内 capture → verify」自证渲染确定性，取代跨 OS 的基准比对：逐字节像素基准是本机夹具，字体栅格化随操作系统与浏览器版本变，跨 OS 比对必然红。对提交基准的 verify 保留为本机纪律（见 docs/qc.md）。

## [0.1.0] - 2026-10-13

首个公开版本。

### 新增

- **逐帧渲染管线**：Canvas 2D 上绘制、Chrome + CDP 逐帧截图、ffmpeg 编码；分片并行渲染（每片独立浏览器实例）与无损拼接。
- **解说词驱动的时间轴**：`tts` 命令（edge-tts）生成配音与 `timeline.json`，逐句内容寻址缓存；字幕、章节卡、HUD、进度条、片尾按句 id 区间自动装配。
- **镜头契约**：只声明 `start`，区间由引擎串接并做覆盖自检；`S()` / `BLK()` / `cutBefore()` 等时间轴查询让动画起点不写硬编码帧号。
- **绘制原语与组合件**：文本、面板、代码块、终端窗口、条形图、格子矩阵、流程盒、标签胶囊、图片摆放（contain / cover / 圆角 / 发光）等。
- **确定性渲染**：钉死 `--force-color-profile=srgb`，实测跨浏览器逐像素一致；随机全部来自确定性哈希。
- **预览页**：拖动 / 逐帧 / 播放 / 镜头跳转，`shots/` 与配置保存后 SSE 热重载。
- **八道自检**（`check`）：公开面导出、模块路径、时间轴引用、素材、主题配色键、全帧绘制、画质（静止过久 / 空白帧），`--static-only` 秒级跑六道；渲染页把错误画进画面防误判。
- **质量网**：72 个单元测试（重点错误路径与边界）；画质自检与静态检查带负面对照；像素回归守卫（`tools/regression.mjs`）；验证夹具（`tools/verify-*.mjs`）覆盖 README 快速开始、预览页、素材、换分辨率与换浏览器。
- **CI**：GitHub Actions 分「静态 / 渲染」两个 job。
- 文档：入门、教程、配置 / API / 命令参考、架构、质量保障、FAQ、LIMITATIONS。

[0.1.0]: https://github.com/hongweifei/filmwright/releases/tag/v0.1.0
