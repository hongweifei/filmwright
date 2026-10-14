# AI / agent 接入指南

filmwright 为 AI 自动化设计的三条底座性质，先说清楚，因为它们决定了你应该怎么用：

1. **确定性**：第 N 帧只是 N 的函数。模型生成的东西可以被逐帧重放、抽查、全量自检——错了能定位到帧。
2. **质量下限在引擎侧**：模板镜头内建了入场节奏、呼吸动效、配色与缩放；十道自检 + 画质检查把「不崩但不好看」也拦下来。模型不需要懂动画，只需要填对内容。
3. **错误是给模型读的 prompt**：所有命令支持 `--json`，错误带 `code / where / hint`；改错了，返回值直接告诉你改哪个文件的哪个字段。

## 两条接入路径

### A. CLI + `--json`（任何能跑 shell 的 agent）

```bash
filmwright check --project my-film --static-only --json
```

stdout 恰好一个 JSON 文档（人类进度静默；ffmpeg/Chrome 日志走 stderr）：

```json
{"ok": false, "command": "check",
 "errors": [{"code": "SCENE_UNKNOWN_TYPE", "message": "…", "where": "shots[1].type", "hint": "v0 可用：…"}],
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

工具一览（返回值与 `--json` 同形状，共 11 个）：

| 工具 | 用途 |
|---|---|
| `filmwright_new` | 建项目骨架（scene / shots 模板） |
| `filmwright_schema` | **写 scene 前先拿它**：16 类模板、字段、容量上限、错误码 |
| `filmwright_timeline` | 读句 id / 帧区间 / 字幕块数——写 `at` 之前看这个 |
| `filmwright_scene_validate` | 只查 scene.json，秒级，不启浏览器 |
| `filmwright_tts` | 解说词 → 配音 + 时间轴 |
| `filmwright_check` | 十道自检（`static_only` 可选） |
| `filmwright_stills` | 出静帧，**并把 PNG 直接回给模型**（默认 4 张，`max_images` 可到 8）——多模态自查的关键 |
| `filmwright_review` | **一轮「改 → 验 → 看」**：scene 校验 + 静态自检 + 各镜头代表帧（末拍落位后）回图。改完 scene.json 就调它 |
| `filmwright_srt` | 导出外挂字幕（SRT），可合双语轨 |
| `filmwright_render` | 渲染无声视频 |
| `filmwright_all` | check → render → mux 一条龙 |

## 推荐的 agent 工作回路

```
filmwright_schema（拿 16 类模板与上限）→ filmwright_new → 写 narration.txt → filmwright_tts
  → filmwright_timeline（拿准句 id 与块数）→ 写 scene.json
  → filmwright_review（一轮搞定：校验 + 静态自检 + 代表帧回图，直接看图改）
  → 满意后 filmwright_all
```

`filmwright_review` 就是这条回路的封装：它先校验规格（**规格有错就不渲染**，把可行动的错
直接交回来），再跑七道静态自检，然后按镜头取代表帧（区间 60% 处，元素都落位了）把 PNG
内联回图。一轮调用 = 一次自我修正，不用自己拼三步、也不用猜该看哪一帧。

两条纪律：

- **先 validate 再 check**：`scene_validate` 秒级、不启浏览器，把规格错误在这一层磨平；`check` 是整片级验证，贵一档。
- **用静帧做视觉自查**：`stills` 出关键帧（每个镜头的首帧与落位帧），看图确认构图与文字没溢出——自检查得出静止与空白，查不出文案错字和审美。

## 写 scene.json 的要点

完整字段表在[场景规格](scene.md)；机器可读版用 `filmwright_schema` 拿。给模型的最小约束：

- 只填**内容**（文本、数字、条目、句 id 对齐），不要试图控制坐标、字号、颜色——模板负责，自定义画面请走逃生舱；
- **容量上限是校验的一部分**（bullets/steps ≤6、table 4×8、chips ≤12、code/terminal ≤10、bars ≤6）——超了 `SCENE_TOO_MANY` 当场报，hint 会教你拆成多个镜头；
- `at` 用句 id（`"S05"`）或 `{s, block}`，**永远不要写硬编码帧号**——改解说词后帧号会变；
- `shots` 按播放顺序排，第一个必须是 `{"type": "title", "at": 1}`；
- 每个镜头的内容量：bullets 建议 2–4 条、每条 `t` ≤ 16 字——超了模板会缩字号，画面会挤。

## 逃生舱：手写镜头

模板覆盖不了（复杂图表、代码演示动画、非等比版式）时，项目里加 `shots/index.js` 导出 `SHOTS`，与 scene 混用（引擎按 `start` 串接，撞车会报错）。契约与 API 见 [API 参考](api.md)——三条硬规则：只声明 `start`；`draw` 是普通函数（要读 `this.from`）；坐标按设计基准 1280×720 写并套 `applyDesignScale`。

让模型写镜头代码前想清楚：**规格 + 模板的质量下限是引擎保证的，镜头代码的质量下限只有自检保证的。** 能用 `type` 解决的，不要生成代码。

## 错误码速查

| code | 出处 | 下一步 |
|---|---|---|
| `NO_PROJECT_DIR` / `NO_CONFIG` / `NO_CONFIG_DEFAULT` | 项目装配 | `filmwright_new` 或补 `film.config.mjs` |
| `NO_TIMELINE` | check/render 前 | 跑 `filmwright_tts` |
| `SCENE_*`（UNKNOWN_TYPE / UNKNOWN_FIELD / NO_SENTENCE / NO_BLOCK / NO_ASSET / FIRST_NOT_1 / NOT_INCREASING…） | scene 校验 | 按 `where` 指向的字段改 |
| `CHECK_<name>` | 自检各道（timeline / themeKeys / frames / quality…） | 看 `message` 里的文件:行号 |
| `TTS_FAILED` / `NO_PYTHON` | tts | 装 Python + edge-tts；端点限流会退避重试 |
| `DIR_NOT_EMPTY` / `BAD_TEMPLATE` / `MISSING_DIR` | new | 换目录 / 选 scene 或 shots |
| `NO_MCP_SDK` | mcp | 仓库目录 `npm install` |
| `MISSING_PROJECT` / `UNKNOWN_COMMAND` | CLI | 补 `--project` / 看 `filmwright help` |
