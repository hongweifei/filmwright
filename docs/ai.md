# AI / agent 接入指南

filmwright 为 AI 自动化设计的三条底座性质，先说清楚，因为它们决定了你应该怎么用：

1. **确定性**：第 N 帧只是 N 的函数。模型生成的东西可以被逐帧重放、抽查、全量自检——错了能定位到帧。
2. **质量下限在引擎侧**：字幕、章节卡、HUD、进度条、片尾、转场、合流都由引擎画；绘制原语与组合件自带专业观感（入场、呼吸、配色、缩放），九道自检 + 画质检查把「不崩但不好看」也拦下来。
3. **错误是给模型读的 prompt**：所有命令支持 `--json`，错误带 `code` / `message` / `hint`（有的还带 `where`，形如 `文件:行号`）；改错了，返回值直接告诉你改哪个文件的哪个字段。

## 两条接入路径

### A. CLI + `--json`（任何能跑 shell 的 agent）

```bash
filmwright check --project my-film --static-only --json
```

stdout 恰好一个 JSON 文档（人类进度静默；ffmpeg/Chrome 日志走 stderr）：

```json
{"ok": false, "command": "render",
 "errors": [{"code": "SCENE_FX_TYPE", "message": "镜头 effects 形状不对（start=1）：不认识的效果 \"sparkle\"", "hint": "可用：blur / glow / color / …"}],
 "warnings": [], "data": {"failed": 1, "checks": []}}
```

退出码与 `ok` 一致。形状与字段说明见[命令参考](cli.md#--json给-agent-的输出)。

### B. MCP 服务器（支持工具调用的 agent）

```bash
cd <本仓库路径> && npm install     # 只有 MCP 需要依赖；其余命令零依赖
filmwright mcp                     # stdio 服务器
```

客户端配置（Claude Code / Claude Desktop 一类）：

```json
{
  "mcpServers": {
    "filmwright": {
      "command": "node",
      "args": ["<本仓库路径>/bin/filmwright.mjs", "mcp"]
    }
  }
}
```

工具一览（返回值与 `--json` 同形状）：

| 工具 | 用途 |
|---|---|
| `filmwright_new` | 建项目骨架（`shots` 一种模板） |
| `filmwright_timeline` | 读句 id / 帧区间 / 字幕块数——写镜头之前看这个 |
| `filmwright_tts` | 解说词 → 配音 + 时间轴 |
| `filmwright_check` | 九道自检（`static_only: true` 时前七道不启浏览器，秒级） |
| `filmwright_stills` | 出静帧，**并把 PNG 直接回给模型**（默认 4 张，`max_images` 可到 8）——多模态自查的关键 |
| `filmwright_review` | **一轮「改 → 验 → 看」**：静态自检（不启浏览器那七道）+ 全片均匀采样 4 张代表帧回图。改完 `shots/index.js` 就调它 |
| `filmwright_srt` | 导出外挂字幕（SRT），可合双语轨 |
| `filmwright_render` | 渲染无声视频 |
| `filmwright_all` | check → render → mux 一条龙 |

## 推荐的 agent 工作回路

```
filmwright_new（骨架带一个能跑的 shots/index.js）→ 写 narration.txt → filmwright_tts
  → filmwright_timeline（拿准句 id 与块数）→ 写 shots/index.js（用 S()/BLK() 对齐帧号）
  → filmwright_check（static_only=true，秒级）
  → filmwright_review（静态自检 + 代表帧回图，直接看图改）
  → 满意后 filmwright_all
```

`filmwright_review` 就是这条回路的封装：先跑静态自检（**有错就不渲染**，把可行动的错直接交回来），
再按全片均匀采样取 4 张代表帧把 PNG 内联回图（要看某个具体镜头就用 `filmwright_stills` 自己给帧号）。
一轮调用 = 一次自我修正，不用自己拼三步、也不用猜该看哪一帧。

两条纪律：

- **先静态、再全量**：`check --static-only` 秒级、不启浏览器，把引用错（句 id、素材名、模块路径、
  主题键）在这一层磨平；`check` 是整片级验证（逐帧 + 画质），贵一档。
- **用静帧做视觉自查**：`stills` 出关键帧（每个镜头的首帧与落位帧），看图确认构图与文字没溢出——
  自检查得出静止与空白，查不出文案错字和审美。

## 写 `shots/index.js` 的要点

完整契约与可选字段见 [API 参考](api.md)。给模型的最小约束：

- 镜头是 `{start, draw(ctx, n, t, accent)}` 对象，导出 `export const SHOTS = [...]`；
- **只声明 `start`**（第一个镜头必须是 1），区间由引擎串接；`draw` 必须是**普通函数**（要读 `this.from`）；
- **帧号一律用 `S('S05')` / `BLK('S05', 2)` / `cutBefore('S05')` 查**，不要写硬编码帧号——改解说词后帧号会变；
- **坐标按设计基准 1280×720 写**，镜头入口套 `applyDesignScale(ctx)`；输出 1080p 也等比放大；
- 只能 `import ... from 'filmwright'`（公开面），**不许相对路径 import 引擎内部**——那会让镜头和内部结构耦合，改个目录名就静默 404（`imports` 这道静态自检会拦）；
- 内容停住时给一点持续动作（呼吸、光标闪烁），幅度要给够——否则画质自检会报「静止过久」；
- 可选字段（`transform` / `animate` / `effects` / `mask` / `transition` / `beats`）与镜头同级；
  ⚠️ 它们在**浏览器装配期**校验，`--static-only` 抓不到，写到这些字段时要用 `render` / `preview` 跑一次。

## 别把画面写死

引擎已经把「整片级」的东西内建了：字幕（**可双语**）、章节卡、HUD、进度条、片尾、转场、
分片渲染、合流。镜头里只画**内容**——文字、图表、代码演示、素材摆放。
`effects`（11 个具名效果的链）与 `animate`（关键帧）用来加动效；要精确控制坐标与字号时，
原语的选项（`size` / `align` / `maxW` / `fit`）足够，不必自己算像素。

**一条纪律**：能用引擎内建件表达的，不要自己重画一遍。自己画的东西没有质量下限，
只有自检兜着（它查得出「静止」「空白」，查不出好看难看）。

## 错误码速查

| code | 出处 | 下一步 |
|---|---|---|
| `NO_PROJECT_DIR` / `NO_CONFIG` / `NO_CONFIG_DEFAULT` | 项目装配 | `filmwright_new` 或补 `film.config.mjs` |
| `NO_TIMELINE` | check/render 前 | 跑 `filmwright_tts` |
| `SCENE_ANIM_*` / `SCENE_FX_*` / `SCENE_MASK_*` | 镜头字段校验（装配期） | 按 `hint` 改：关键帧锚点/取值、效果名与参数范围、遮罩形状与取值 |
| `ERROR`（无专属码） | `S()` / `BLK()` 引用了不存在的句 id / 字幕块（运行期抛出） | 先看 `script/timeline.md` 核对 id 与块数 |
| `CHECK_<道名>` | 自检各道（timeline / assets / clips / themeKeys / frames / quality…） | 看 `message` 里的文件:行号 |
| `TTS_FAILED` / `NO_PYTHON` | tts | 装 Python + edge-tts；端点限流会退避重试 |
| `DIR_NOT_EMPTY` / `BAD_TEMPLATE` / `MISSING_DIR` | new | 换目录 / 用 `shots` 模板（唯一一种） |
| `NO_MCP_SDK` | mcp | 仓库目录 `npm install` |
| `MISSING_PROJECT` / `UNKNOWN_COMMAND` | CLI | 补 `--project` / 看 `filmwright help` |
