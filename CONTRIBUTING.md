# 参与贡献

欢迎。这份指南讲三件事：怎么把环境跑起来、改动要过哪些验证、提交怎么写。

## 环境准备

见[入门文档](docs/getting-started.md)：Node ≥ 22、Chrome/Chromium/Edge、ffmpeg；跑 `tts` 相关再加 Python 3 + `edge-tts` + `numpy`。clone 后先跑一遍示例，确认基线是绿的：

```bash
npm test
node bin/filmwright.mjs check --project examples/minimal --static-only
```

## 改动要过哪些验证

| 改了什么 | 必须跑 |
|---|---|
| 任何代码 | `npm test` |
| 镜头 / 引擎绘制 | `node bin/filmwright.mjs check --project examples/minimal`（全量，要浏览器） |
| 纯结构重构（搬文件、拆模块、改依赖方向） | 先 `node tools/regression.mjs capture`，改完 `verify` **逐字节全同**才叫重构 |
| 新增的检查 / 守卫 | 附**负面对照**：喂它坏的，证明它会红（一个永远绿的检查不是检查） |
| README / 快速开始 | `node tools/verify-readme.mjs`（照文档真跑一遍） |
| 预览页 | `node tools/verify-preview.mjs` |
| 素材系统 | `node tools/verify-assets.mjs` |

像素回归的基准（`examples/minimal/regression-baseline.json`）跟着仓库走。改动**故意**改变了画面时，重新 `capture`，并在提交消息里写明「有意改变画面」。

## 代码结构规则

分层与硬规则见[架构文档](docs/architecture.md)，一句话版：

- `contract` 不 import `runtime` / `host`；`runtime` 不 import `host`；镜头只 import `'filmwright'` 公开面；
- 引擎不认识任何具体片子；配置、时间轴、镜头全部注入；
- 产物只落在 `.work/`（可删）与 `renders/`（成片）；工具在 `tools/` 跟仓库走；
- 写错的配置要**当场报错并指出字段**，不静默退回默认值。

## 提交规范

- **提交消息用中文**，一行主题（祈使句，不加句号），空一行后写说明：改了什么、为什么、验证过什么。故意改画面的改动必须在消息里声明；
- 提交前确认没有把机器特定内容带进仓库：绝对路径、本机安装位置、以本机环境命名的目录；
- 分支 `main`，行尾 LF（仓库有 `.gitattributes`，clone 后无需设置）；
- **版本号由维护者定**，贡献改动不升版本。

## 报告问题

用 [issue 模板](.github/ISSUE_TEMPLATE/)。报渲染类问题请附：`node --version`、浏览器与版本、`ffmpeg -version` 首行、完整命令与输出。涉及画面的，附 `stills` 静帧或 `sheet` 联络表截图。
