# 场景规格参考（`scene.json`）

**这是 AI 自动化的入口。** 项目里放一份 `scene.json`，声明「每句解说词配什么画面」，引擎的模板镜头负责其余一切——入场错峰、停留呼吸、章节配色、设计缩放。AI 生成的是**可校验的数据**，不是难保证质量的绘制代码；手写镜头（`shots/index.js`）仍然保留，两条路可以混用。

可运行的完整例子见 `examples/scenecast`——**整个项目没有 `shots/` 目录**，画面全部来自这一份规格。

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

## 模板一览（v0 共 7 类）

元素进场跟着对齐句的字幕块错峰；块不够用时从最后一块按 18 帧铺。

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

## 校验与错误码

`filmwright check` 的 `scene` 一道（不启浏览器）跑校验；boot 在浏览器里查的是**同一份实现**（`src/contract/scene.js`）。每条错误带 `code / path / message / hint`——错误信息是给模型读的，读完能直接改。

| code | 含义 |
|---|---|
| `SCENE_UNKNOWN_TYPE` | 类型不认识（hint 列出全部可用） |
| `SCENE_UNKNOWN_FIELD` | 未知字段（拼错当场响） |
| `SCENE_MISSING_FIELD` / `SCENE_MISSING_AT` | 缺必填字段 / 缺 `at` |
| `SCENE_BAD_FIELD` | 字段类型/形状/取值不对 |
| `SCENE_NO_SENTENCE` / `SCENE_NO_BLOCK` | 对齐到不存在的句 / 块（说共几块） |
| `SCENE_NO_ASSET` | `image.asset` 没在配置里声明（列出已声明的） |
| `SCENE_FIRST_NOT_1` | 第一个镜头不从第 1 帧起 |
| `SCENE_NOT_INCREASING` | 解析后起始帧不严格递增（指出是哪两个） |
| `SCENE_SCHEMA` / `SCENE_NOT_OBJECT` / `SCENE_NO_SHOTS` | 顶层结构问题 |

## 与手写镜头混用

一份项目可以同时有 `scene.json` 和 `shots/index.js`：两边的镜头合并后按 `start` 串接，起始帧撞车会被镜头覆盖自检直接报出来。典型用法——主体走规格，个别需要复杂动画的镜头手写。

## 质量下限从哪来

模板把示例片验证过的节奏纪律内建了：入场用 `inv + easeOut3`、落位后保持呼吸/脉冲（幅度按画质自检的静止阈值口径给足）、配色只取章节 `accent`、坐标一律设计基准。也就是说 **AI 写规格写不出「静止 3 秒」和「挤在左边」**——这些下限由引擎兜住，剩下的内容对错交给九道自检与联络表。
