# 变更日志

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；
版本号由维护者手动写入本文件，不自动生成。

## [未发布]

### 新增

- **`filmwright srt`：外挂字幕导出**。从 `timeline.json` 的 `subs` 出 SRT（字幕本就烧进画面，这份给 B 站/YouTube 投稿用）；块间空隙用下一块开始补齐，避免闪断；`--translation` 合双语轨，译文由框架外产出（框架不翻译，边界不破），两种格式（按 `from` 帧对齐的数组 / 按块序号的映射）都认，缺项只出原文不编内容。MCP 加 `filmwright_srt` 工具。

- **MCP 回图 + `filmwright_review`**：`filmwright_stills` 把 PNG 作为 MCP image content 直接回给多模态模型（默认内联 4 张、`max_images` 可到 8，其余给路径）；新增 `filmwright_review` 一轮完成「改 → 验 → 看」——scene 校验（规格有错就不渲染，直接交回可行动的错）→ 七道静态自检 → 各镜头代表帧（区间 60% 处）回图。此前 agent 只能拿到图片路径，看不到自己做的画面。
- **节拍信号（`beats`）解开画质自检的死结**：scene 模板在编译期产出节拍表（与 draw 用同一个 `staggerFrames`，不漂），手写镜头可选声明。**声明了节拍的镜头，末拍稳定期从读数升级为硬判据**——停留不足 `--hold-frames`（默认 30）或节拍排到镜头结束之后都判失败；没声明的维持「只报告」（像素推断分不清入场/离场）。模板还会**主动压节拍**为末拍预留停留时间，避免内容多的镜头被自己挤掉。LIMITATIONS 里那条「要做成硬判据得先有节拍信号」就此解除。

### 修复

- `examples/scenecast` 的 code 镜头被新判据抓出真缺陷（末拍后只停留 16 帧）——根因是模板在「元素多于字幕块」时按固定 +18 帧往后铺，把末拍推到句尾。已改为按可用区间等比压缩并预留停留期。

- **模板镜头扩到 13 类**：`steps`（编号步骤 + 生长连接线 + 当前步点亮）、`table`（表头 + 斑马纹 + 行扫描）、`quote`（居中大字折行 + 引号脉动）、`terminal`（终端窗口逐行输出 + 光标）、`chips`（关键词胶囊自动折行）、`bars`（条形图 + 循环描边）。每类内建入场错峰与落位后的持续动作——验收件 `examples/gallery`（13 镜各一，纯规格）九道自检全过、画质零违规。
- **容量上限进校验**：bullets/steps ≤6、flow ≤5、code/terminal ≤10、table 4 列 × 8 行、chips ≤12、bars ≤6、compare 各 ≤5，超了报 `SCENE_TOO_MANY`（hint 教拆镜头）。AI 该被校验告知边界，而不是靠肉眼发现溢出。
- **`filmwright schema`**：机器可读的规格说明书（13 类模板 / 字段 / 上限 / 对齐语法 / 错误码），`--json` 输出；MCP 加 `filmwright_schema` 工具——agent 写 scene 前先拿 schema，不必先读文档。
- **CI 平台矩阵**：静态 job 跑 ubuntu / macOS / windows 三个 OS（核心零依赖，这是跨平台最真的证据）；渲染 job 跑 ubuntu + windows（Edge + 无头）；环境确认改用 `findBrowser()` 真断言 + `set -o pipefail`，杜绝假绿。macOS 渲染暂不进矩阵——没有本地实测证据，不猜。
- **`tools/make-timeline-fixture.mjs`**：edge-tts 端点不可达时，按同一套解析规则合成 `timeline.json` 夹具（明确标注非配音；真实项目跑 `tts` 覆盖）。
- `verify-readme` 扩面：除 minimal 快速开始外，覆盖两个纯 scene 示例的静态自检、`schema --json`（13 类齐）、`new` 冒烟（含「新项目 check 必须报 `NO_TIMELINE` 而不是崩」的错误契约）。

- **场景规格 `scene.json`（AI 自动化的入口）**：声明式镜头，v0 含 7 类模板（title / bullets / stat / flow / code / image / compare）。AI 只填内容与节拍（`at` 支持帧号、句 id、`{s, block, lead, offset}`），入场错峰、停留呼吸、章节配色、设计缩放由模板内建。手写 `shots/index.js` 保留为逃生舱，两者可混用。校验与 boot 共用一份实现（`src/contract/scene.js`），错误带 code/path/hint；静态自检加第 9 道 `scene`（`--static-only` 七道不启浏览器）。示例 `examples/scenecast` 整个项目没有 `shots/`，画面全部来自规格（其 `timeline.json` 是合成夹具；跑 `tts` 会生成真实配音）。
- **`--json` 机器可读输出**（除 `preview` 外全部命令）：stdout 恰好一个 JSON 文档 `{ok, command, errors[{code,message,where,hint}], warnings, data}`，退出码与 `ok` 一致；错误带结构化 `code` 与 `where` 路径，给 agent 直接消费（见 docs/cli.md）。
- **`filmwright new <目录>`**：项目脚手架，`--template scene`（默认）/ `shots` 两种骨架；目录非空直接拒绝（`DIR_NOT_EMPTY`），从不覆盖已有文件。
- **`filmwright mcp`：MCP 服务器（stdio）**，把工具链暴露给 agent——`filmwright_new / timeline / scene_validate / tts / check / stills / render / all` 八个工具，返回值与 `--json` 同形状。唯一需要 npm 依赖的子命令（`@modelcontextprotocol/sdk` + `zod`），且 SDK 惰性加载：没装依赖时其余命令照常跑，`mcp` 报 `NO_MCP_SDK` 并给出安装提示。`tests/mcp.test.mjs` 走真实 JSON-RPC 握手端到端验证（没装 SDK 时优雅跳过）。
- 文档：docs/ai.md（agent 接入指南：MCP 配置、推荐回路、错误码速查）。
- 文档：docs/scene.md 场景规格参考。

### 修复

- `check` 在项目还没有时间轴时，不再深处崩在 `Cannot read properties of null`，而是报 `NO_TIMELINE` 并提示先跑 `tts`。
- `runChecks` 的 `quiet` 泄漏：失败明细的打印在 quiet 守卫之外，`--json` 时人类文本混在 JSON 前面，stdout 不再是单个文档。

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
