# 场景规格参考（`scene.json`）

**这是 AI 自动化的入口。** 项目里放一份 `scene.json`，声明「每句解说词配什么画面」，引擎的模板镜头负责其余一切——入场错峰、停留呼吸、章节配色、设计缩放。AI 生成的是**可校验的数据**，不是难保证质量的绘制代码；手写镜头（`shots/index.js`）仍然保留，两条路可以混用。

可运行的完整例子有两个：`examples/scenecast`（46 秒解说片，验证规格能撑起一整条片子）与 `examples/gallery`（**13 类模板各一镜的画廊**，验证每类模板本身）。两个项目都**没有 `shots/` 目录**，画面全部来自这一份声明。

## 形状

```json
{
  "$schema": "filmwright/scene-v0",
  "shots": [
    {"type": "title", "at": 1, "title": "filmwright", "sub": "AI 自动化视频制作"},
    {"type": "bullets", "at": "S01", "heading": "每一帧 = 一个函数",
     "items": [{"t": "输入帧号，输出画面", "d": "不读上一帧"}]}
  ]
}
```

- `shots` 按播放顺序排列，每项**只声明起点 `at`**——区间由引擎串接（与镜头契约同一条纪律，漏覆盖会直接报错）；
- 第一个镜头必须从第 1 帧开始（通常是一个 `at: 1` 的 `title`）；
- 顶层与每项的未知字段都会**当场报错**，不静默忽略。

## 对齐语法 `at`

| 写法 | 落在哪 |
|---|---|
| `12` | 第 12 帧 |
| `"S05"` | 该句开口前的静音里（提前 8 帧，同 `cutBefore('S05')`） |
| `{"s": "S05", "lead": 12}` | 同上，提前 12 帧 |
| `{"s": "S05", "block": 2}` | 该句第 2 个字幕块起点前 8 帧 |
| `{"s": "S05", "block": 2, "offset": -4}` | 锚点再提前 4 帧 |

句 id 与字幕块来自 `script/timeline.json`（`filmwright tts` 生成，人读版在 `script/timeline.md`）。**改解说词不用改规格**：句 id 稳定，帧号自动跟着变。

## 模板一览（共 13 类）

元素进场跟着对齐句的字幕块错峰；块不够用时从最后一块按 18 帧铺。**每类都有容量上限**（版面算出来的，超了会挤/溢出）——`filmwright schema` 能输出这份表，不用背。

### 机器可读 schema（给 agent 的发现机制）

```bash
filmwright schema            # 人读：类型、用途、字段、上限、错误码
filmwright schema --json     # 机读：同一份数据的 JSON
```

MCP 客户端直接调 `filmwright_schema` 工具——**写 scene 之前先拿 schema**，不必先读文档。

### 文字类

### `title` 片头
| 字段 | 必填 | 说明 |
|---|---|---|
| `title` | ✔ | 大标题（超宽自动缩字号） |
| `kicker` / `sub` / `en` | — | 眉题（等宽小字）/ 副题（章节主色）/ 英文行 |

### `bullets` 要点列表
| 字段 | 必填 | 说明 |
|---|---|---|
| `items` | ✔ | `[{t, d?}]`，`t` 主文案、`d` 右侧说明 |
| `heading` | — | 顶部标题 |

### `stat` 大数字
`value`（数字，必填）、`label`（必填）、`unit?`、`label2?`（等宽小字）。滚动计数从 0 数到位。

### `flow` 流程盒
`boxes: [{label, sub?}]`（至少 2 项，必填）、`heading?`。落位后高亮沿流程循环走。

### `code` 代码块
`lines: [字符串 | {text, mark?}]`（必填），`mark` ∈ `add / hl / err / ok`；`heading?`。逐行揭示，宽度按全量行定死（不跳版），光标常闪。

### `image` 图片素材
`asset`（必填，须已在配置 `assets` 声明——引用没声明的名字，静态自检就报）、`heading?`、`note?`。

### `compare` 两栏对比
`left / right: {title, items: [字符串]}`（都必填）、`heading?`。中间 `VS` 持续脉冲。

### `steps` 编号步骤
`steps: [{t, d?}]`（必填，≤6）、`heading?`。序号圆点 + 连接线跟着步骤生长；当前步骤循环点亮。

### `table` 表格
`columns: [字符串]`（2–4 列）、`rows: [[字符串]]`（≤8 行，每行单元格数必须等于列数，否则报 `SCENE_TABLE_WIDTH`）、`heading?`。表头强调色、斑马纹、行扫描高亮。

### `quote` 引言
`text`（必填）、`who?`、`from?`。居中大字自动折行（最多 4 行），引号光晕脉动。长文案请拆成多个 `bullets`，别堆进一句 `quote`。

### `terminal` 终端窗口
`lines: [字符串 | {text, color?}]`（必填，≤10）、`title?`（窗口标题）、`heading?`。高度按全量行定死，逐行揭示不跳窗，光标常闪在最新行。

### `chips` 关键词胶囊
`items: [字符串 | {label}]`（必填，≤12）、`heading?`。自动折行，整块轻呼吸。

### `bars` 条形图
`items: [{v, label, unit?}]`（必填，2–6 根）、`unit?`（全局单位，条目没写时用）、`heading?`。数值滚动生长，落位后循环描一根柱子的边。适合性能/占比对比。

## 容量上限

超了报 `SCENE_TOO_MANY`（hint 会建议拆成多个镜头，每个 `at` 对齐一句）：

| 类型 | 上限 |
|---|---|
| bullets.items / steps.steps | 6 |
| flow.boxes | 5 |
| code.lines / terminal.lines | 10 |
| table | 4 列 × 8 行 |
| chips.items | 12 |
| bars.items | 6 |
| compare.left/right.items | 各 5 |

## 转场（`transition`）

任何镜头都可以声明转场（**所有类型通用**，不是某个模板的字段）：

```json
{"type": "flow", "at": "S02", "transition": {"type": "crossfade", "frames": 14}, "boxes": [...]}
{"type": "bullets", "at": "S05", "transition": 10, "items": [...]}
```

| 写法 | 效果 |
|---|---|
| `12` | 等价于 `{type: "crossfade", frames: 12}` |
| `{"type": "crossfade", "frames": N}` | 前一个镜头淡出 + 当前镜头淡入（**两个镜头同时可见并交叠**） |
| `{"type": "fade", "frames": N}` | 当前镜头从背景色淡入（不画前一个镜头） |

要点：

- 转场发生在**当前镜头的前 N 帧**（`start` 起）；
- **第一个镜头不能用 `crossfade`**（前面没有镜头可混合）——校验会报 `SCENE_BAD_TRANSITION`，用 `fade`；
- N 会被镜头自身长度夹住，不会溢出到下一个镜头；
- **不破坏「第 N 帧只是 N 的函数」**：两个镜头的 `draw` 都只依赖 N，混合系数也只是 N 的函数——所以分片并行、任意跳帧、全量自检（`check`）全都不受影响。这也是为什么转场在**引擎内**做，而不是用 ffmpeg 的 `xfade`（那会把帧变成「需要前一帧」的序列，跳帧就废了）。

手写镜头同样支持：`{start, transition: {type: 'crossfade', frames: 12}, draw}`。

## 图层变换与混合模式（`transform`）

任何镜头都可以声明 `transform`（同样是通用字段）：

```json
{"type": "stat", "at": "S03", "value": 81, "label": "ms",
 "transform": {"x": 200, "y": -40, "scale": 1.2, "rotate": 8, "alpha": 0.85,
               "blend": "screen", "origin": [640, 360]}}
```

| 字段 | 说明 |
|---|---|
| `x` / `y` | **设计坐标**位移（1280×720 那套），不管输出多少分辨率 |
| `scale` | 缩放，必须 > 0 |
| `rotate` | 旋转角度（度），正值顺时针 |
| `alpha` | 图层不透明度 0–1，与转场的淡入**相乘**（两者独立） |
| `blend` | 混合模式：`multiply` / `screen` / `overlay` / `darken` / `lighten` / `color-dodge` / `color-burn` / `hard-light` / `soft-light` / `difference` / `exclusion` / `hue` / `saturation` / `color` / `luminosity` |
| `origin` | 旋转与缩放的中心 `[x, y]`（设计坐标），默认画布中心 |

两个实现细节值得知道（都是踩过才这么写的）：

- **`alpha` 走离屏缓冲**：`ctx.globalAlpha` 是逐绘制操作生效的，一个图层里画两个重叠矩形、alpha=0.5 时重叠处会被混合两次——那不是「整组半透明」而是视觉 bug。所以组透明度先画进缓冲再整体合成。
- **不声明 `transform`（或声明了但都是默认值）时走快路径**：直接在主画布上画，不建缓冲。**所以没用到这个特性的项目输出逐字节不变**——像素回归基线就是靠这条守住的（[verify-composite.mjs](../tools/verify-composite.mjs) 里有「无副作用 transform 与基线逐字节相同」的断言）。

## 校验与错误码

`filmwright check` 的 `scene` 一道（不启浏览器）跑校验；boot 在浏览器里查的是**同一份实现**（`src/contract/scene.js`）。每条错误带 `code / path / message / hint`——错误信息是给模型读的，读完能直接改。

| code | 含义 |
|---|---|
| `SCENE_UNKNOWN_TYPE` | 类型不认识（hint 列出全部 13 类） |
| `SCENE_UNKNOWN_FIELD` | 未知字段（拼错当场响） |
| `SCENE_MISSING_FIELD` / `SCENE_MISSING_AT` | 缺必填字段 / 缺 `at` |
| `SCENE_BAD_FIELD` / `SCENE_BAD_SHOT` | 字段类型/形状/取值不对 / 镜头不是对象 |
| `SCENE_TOO_MANY` | 超出容量上限（见上表） |
| `SCENE_TABLE_WIDTH` | 表格某行的单元格数与表头不符 |
| `SCENE_BAD_TRANSITION` | 转场形状不对，或第一个镜头用了 crossfade |
| `SCENE_BAD_TRANSFORM` | 图层变换形状不对（scale ≤ 0、alpha 越界、origin 不是两元数组……） |
| `SCENE_NO_SENTENCE` / `SCENE_NO_BLOCK` | 对齐到不存在的句 / 块（说共几块） |
| `SCENE_NO_ASSET` | `image.asset` 没在配置里声明（列出已声明的） |
| `SCENE_FIRST_NOT_1` | 第一个镜头不从第 1 帧起 |
| `SCENE_NOT_INCREASING` | 解析后起始帧不严格递增（指出是哪两个） |
| `SCENE_SCHEMA` / `SCENE_NOT_OBJECT` / `SCENE_NO_SHOTS` | 顶层结构问题 |

## 与手写镜头混用

一份项目可以同时有 `scene.json` 和 `shots/index.js`：两边的镜头合并后按 `start` 串接，起始帧撞车会被镜头覆盖自检直接报出来。典型用法——主体走规格，个别需要复杂动画的镜头手写。

## 质量下限从哪来

模板把示例片验证过的节奏纪律内建了：入场用 `inv + easeOut3`、落位后保持呼吸/脉冲（幅度按画质自检的静止阈值口径给足）、配色只取章节 `accent`、坐标一律设计基准。也就是说 **AI 写规格写不出「静止 3 秒」和「挤在左边」**——这些下限由引擎兜住，剩下的内容对错交给九道自检与联络表。
