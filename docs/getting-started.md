# 入门：装好并跑通示例

## 环境要求

| 需要 | 版本/说明 | 用在哪 |
|---|---|---|
| Node.js | **≥ 22**（驱动浏览器要用全局 `WebSocket`，Node 20 上没有——实测过） | 全部 JS 工具 |
| Chrome / Chromium / Edge | 任何近版本；自动查找，或用 `--browser` / `CHROME_BIN` 指定 | 逐帧渲染 |
| ffmpeg + ffprobe | 在 `PATH` 里，或用 `FFMPEG_BIN` / `FFPROBE_BIN` 指定路径 | 编码、合流、抽帧、联络表 |
| Python 3 + `edge-tts` + `numpy` | `pip install edge-tts numpy` | 只有 `tts` 命令要 |

渲染层零 npm 依赖，不需要打包器。`filmwright mcp`（MCP 服务器）是唯一需要 `npm install` 的子命令——不装它，其余命令照常跑。环境不满足时启动即报清楚缺什么，而不是在深处报看不懂的错。

> 只在 Windows 上实测过。管线本身是跨平台的（浏览器查找列表含 macOS / Linux 路径），其他平台见 [LIMITATIONS](../LIMITATIONS.md)。

## 跑通示例片

```bash
git clone <本仓库> filmwright && cd filmwright
pip install edge-tts numpy          # 要配音时才需要

node bin/filmwright.mjs tts    --project examples/minimal   # 解说词 -> 配音 + 时间轴
node bin/filmwright.mjs check  --project examples/minimal   # 十道自检
node bin/filmwright.mjs all    --project examples/minimal --shards 3
# -> examples/minimal/renders/minimal.mp4
```

`all` = 自检 → 分片渲染 → 合流。自检没过会直接停，不会把一个已知有问题的片子渲出来。

想看画面细节时出静帧：

```bash
node bin/filmwright.mjs stills --project examples/minimal --frames 40,470,1150 --dir examples/minimal/.work/stills
```

## 预览（改镜头时的主力回路）

```bash
node bin/filmwright.mjs preview --project examples/minimal
# -> http://127.0.0.1:<端口>/preview  并自动打开浏览器
```

拖动滑杆或 `←` `→` 逐帧，空格播放，右侧镜头列表点击跳转；**改 `shots/` 或 `film.config.mjs` 保存后页面自动重载**。渲染一帧要秒级，判断「入场节奏对不对」要连看好几帧——预览页把这条回路变成即时反馈。详见[命令参考](cli.md#preview)。

## 改成你自己的片子

```bash
node bin/filmwright.mjs new my-film          # 骨架：config + narration + scene.json
node bin/filmwright.mjs tts --project my-film
node bin/filmwright.mjs all --project my-film
```

然后跟着[教程](tutorial.md)改内容：写解说词、改 `scene.json` 配画面（AI/模板路线），或写 `shots/index.js`（手写镜头的逃生舱）。二十分钟能出第一条片子。

## 下一步读什么

| 文档 | 内容 |
|---|---|
| [教程](tutorial.md) | 从零做一个片子的完整流程 |
| [场景规格](scene.md) | `scene.json`：AI/模板路线的入口 |
| [效果链](effects.md) | `effects` 的 11 个效果与 GPU 档位取舍 |
| [3D 图层](three.md) | 声明式 / 命令式两种写法 |
| [AI / agent 接入](ai.md) | MCP、`--json` 契约、agent 工作回路 |
| [配置参考](config.md) | `film.config.mjs` 全部字段 |
| [API 参考](api.md) | 镜头里能 import 的一切 |
| [命令参考](cli.md) | 八个命令的全部选项与产物落点 |
| [LIMITATIONS](../LIMITATIONS.md) | 明确不做什么，先读少踩坑 |
