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

## 画面只有一个来源：`shots/index.js`

项目里**没有声明式规格文件**。一个镜头就是 `{start, draw}` 对象：`start` 说从哪一帧接管画面
（区间由引擎串接），`draw(ctx, n)` 里调绘制原语把这一帧画出来。

```js
// shots/index.js —— 只声明 start；draw 只依赖 n（不读上一帧、不读时钟）
import {text, panel, cutBefore, S, BLK, inv, easeOut3, hexA,
        theme as C, fonts as F, applyDesignScale} from 'filmwright';

const TITLE = {
  start: 1,
  draw(ctx, n) {
    const a = easeOut3(inv(n, 8, 40));
    ctx.save(); ctx.globalAlpha = a; applyDesignScale(ctx);
    text(ctx, '我的片子', 640, 300, {size: 96, family: F.wide, weight: 700,
      color: C.text, align: 'center', baseline: 'middle',
      glow: hexA(C.accents[0], 0.8), glowBlur: 36});
    ctx.restore();
  },
};

const BODY = {
  start: cutBefore('S01'),                       // 掐在 S01 开口前的静音里
  draw(ctx, n) {
    // 帧号从 S() / BLK() 查，不写硬编码；面板随第一个字幕块落位
    const a = easeOut3(inv(n, S('S01').from - 6, BLK('S01', 1) + 16));
    if (a > 0.01) {
      ctx.save(); ctx.globalAlpha = a; applyDesignScale(ctx);
      panel(ctx, 240, 220, 800, 150, {r: 16, stroke: C.accents[0], lw: 2.4});
      text(ctx, '每一帧 = 一个纯函数', 640, 295, {size: 36,
        align: 'center', baseline: 'middle'});
      ctx.restore();
    }
  },
};

export const SHOTS = [TITLE, BODY];
```

三条硬规则（细节见 [API 参考](api.md)）：

- **只声明 `start`**，不要写 `to`——区间由引擎串接，漏一段直接报错，不会静默画空帧；
- **帧号从 `S()` / `BLK()` / `cutBefore()` 查**，不要写硬编码帧号——改解说词后帧号会自动平移；
- **坐标按设计基准 1280×720 写**，镜头入口套 `applyDesignScale(ctx)`；`draw` 必须是普通函数
  （它要读 `this.from`）。

## 跑通示例片

```bash
git clone <本仓库> filmwright && cd filmwright
pip install edge-tts numpy          # 要配音时才需要

node bin/filmwright.mjs tts    --project examples/minimal                 # 解说词 -> 配音 + 时间轴
node bin/filmwright.mjs check  --project examples/minimal --static-only   # 秒级：引用关系（不启浏览器）
node bin/filmwright.mjs render --project examples/minimal --shards 3      # -> examples/minimal/.work/minimal.mp4
node bin/filmwright.mjs all    --project examples/minimal --shards 3      # -> examples/minimal/renders/minimal.mp4
```

`check --static-only` 是改完镜头后的秒级回路；`render` 只出无声画面；`all` = 自检 → 分片渲染 → 合流
（自检没过会直接停，不会把一个已知有问题的片子渲出来）。**没装配音也能出片**：`all` 会跳过合流，
把无声成片放在同一个位置 `renders/<slug>.mp4`。

⚠️ 镜头对象的字段（`transform` / `animate` / `effects` / `mask` / `transition` / `beats`）是在
**浏览器装配期**校验的，`--static-only` 抓不到——写错这几个字段要跑到 `render` 或预览才报。

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
node bin/filmwright.mjs new my-film                    # 骨架：config + narration + shots/index.js
node bin/filmwright.mjs tts   --project my-film
node bin/filmwright.mjs check --project my-film --static-only
node bin/filmwright.mjs all   --project my-film
```

然后跟着[教程](tutorial.md)改内容：写解说词、在 `shots/index.js` 里加镜头。二十分钟能出第一条片子。

## 下一步读什么

| 文档 | 内容 |
|---|---|
| [教程](tutorial.md) | 从零做一个片子的完整流程 |
| [效果链](effects.md) | `effects` 的 11 个效果与 GPU 档位取舍 |
| [3D 图层](three.md) | 命令式 3D：`loadThree()` + `create3D()`、retained-mode 陷阱 |
| [AI / agent 接入](ai.md) | MCP、`--json` 契约、agent 工作回路 |
| [配置参考](config.md) | `film.config.mjs` 全部字段 |
| [API 参考](api.md) | 镜头里能 import 的一切、镜头对象的可选字段 |
| [命令参考](cli.md) | 全部命令与选项、产物落点 |
| [LIMITATIONS](../LIMITATIONS.md) | 明确不做什么，先读少踩坑 |
