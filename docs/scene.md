# 场景规格参考（`scene.json`）

**这是 AI 自动化的入口。** 项目里放一份 `scene.json`，声明「每句解说词配什么画面」，引擎的模板镜头负责其余一切——入场错峰、停留呼吸、章节配色、设计缩放。AI 生成的是**可校验的数据**，不是难保证质量的绘制代码；手写镜头（`shots/index.js`）仍然保留，两条路可以混用。

可运行的完整例子有两个：`examples/scenecast`（46 秒解说片，验证规格能撑起一整条片子）与 `examples/gallery`（**模板画廊**），两个项目都**没有 `shots/` 目录**，画面全部来自这一份声明。

画廊目前覆盖 **13 类**：`title` / `bullets` / `steps` / `table` / `quote` / `stat` / `flow` / `code` / `terminal` / `chips` / `bars` / `image` / `compare`。
未进画廊的三类各有原因：`line`（新加，待补）、`comp`（需要先定义 `comps`，单镜展示不出「复用」这件事）、`clip`（需要视频素材，仓库不带二进制素材）。
**全部 16 类的最小合法实例都有单元测试覆盖**（`tests/scene.test.mjs`），所以「没进画廊」不等于「没验证」。

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

## 模板一览（17 类模板 + 1 个容器 `layers`）

> 写成「17 类模板」是刻意的：`tools/verify-docs.mjs` 会用这个句式核数字，
> 而**容器不算模板**（它没有自己的内容，是把别的东西组合起来）。
> 早先这里写「共 13 类」，那是个检查器抓不到的过时说法 —— 现在改成它能核的句式。

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

### `clip` 视频/图片序列片段
`clip`（必填，须在配置 `clips` 里声明——引用没声明的名字，静态自检就报）、`heading?`、`note?`、`fit?`（`contain`/`cover`/`stretch`）。**按源帧号同步取图**，随时间播放；抽帧那步由宿主完成（`filmwright clips` 或渲染时自动），所以跳帧、分片、全量自检都不受影响。

## 关键帧动画（`animate`）

任何镜头都可以声明 `animate`（通用字段，与 `transform` 同级）：

```json
{"type": "stat", "at": "S03", "value": 81, "label": "ms",
 "animate": {
   "y":     [{"beat": 1, "v": -80}, {"beat": 2, "v": 0, "ease": "out4"}],
   "alpha": [{"frame": 1, "v": 0.2}, {"frame": 20, "v": 1}]
 }}
```

- **可动画属性**：`x` / `y` / `scale` / `rotate` / `alpha` —— 与 `transform` 字段一一对应
- 每个关键帧：`{v, beat|frame, ease?}`；`v` 是**要到达的值**
- **`beat` 与 `frame` 都是 1 起序数**（和 `at` 一致）：`beat: 1` 是第一拍，`frame: 1` 是该节点的第一帧
- **一个属性内不能混用两种时间基**（两者序数不可比，混用几乎必然是写错）

### 该用 `beat` 还是 `frame`

**优先 `beat`**：节拍表是模板编译期算出来的、**已经跟着解说词走**。
所以改解说词、句子位移或长度变化之后，挂在节拍上的动画**自动保持对齐**；
挂绝对帧号（`frame`）的动画只跟"节点内第几帧"，解说词一改就可能错位。

`frame` 留作逃生舱：当动画只跟镜头内部结构有关（比如"开场 10 帧内淡入"），它更直接。

### 缓动词汇（有界，共 7 个）

`linear` / `out3` / `out4` / `in3` / `inout3` / `back` / `step`。不写即 `linear`。

| 场景 | 用哪个 |
|---|---|
| 元素入场落位 | `out3`（最通用的专业感） |
| 要"稳稳停住"（大元素、慢动作） | `out4` |
| 元素离场 | `in3`（加速离开，不拖沓） |
| 一镜内大幅位移（跨屏） | `inout3`（起步加速、收尾减速） |
| 有弹性的强调（小徽标、数字） | `back`（轻微过冲）——**大元素别用**，会显廉价 |
| 状态切换、硬切 | `step` |
| 持续位移（背景漂移、循环） | `linear`（匀速才看得出是循环） |

**刻意不做自定义贝塞尔**：贝塞尔是 4 个数字，AI 无法推理，产出会变成"随手填的参数"，
也无法静态判断好坏 —— 观感的差异主要来自**时机与层次**，不来自曲线的精细形状。

### 三条语义（都有测试钉住）

- **夹紧不外推**：首键之前保持首值、末键之后保持末值。外推（"y 从 40 到 0 继续往负走"）
  是"元素无声飞出画面"的主要来源，且很难查。
- **缓动作用在进度上，不作用在值差上**：保证关键帧处的值**精确落位**，不因缓动有微小偏差。
- **同一属性不能同时写在 `transform` 与 `animate` 里**（报 `SCENE_ANIM_CONFLICT`）：
  静默取一边会让"动画没生效"变成难查的问题，所以直接拦住。

没写 `animate` 的镜头走快路径（不分配、不合并），**输出逐字节不变**。

## 效果链（`effects`）

任何镜头（以及 `layers` 里的每一层）都能声明 `effects` —— 与 `transform` / `animate` 同级：

```json
{"type": "stat", "at": "S03", "value": 81, "label": "ms",
 "effects": [{"type": "blur", "radius": 12}]}
```

数组**顺序即应用顺序**。效果只作用于**这一个镜头自己画的内容**（引擎已画的背景不受影响）。

**参数可以是关键帧轨道**（让模糊渐入、辉光脉冲）：

```json
{"type": "stat", "at": "S03", "value": 81, "label": "ms",
 "effects": [{"type": "blur", "radius": [{"beat": 1, "v": 0}, {"beat": 2, "v": 16, "ease": "out3"}]}]}
```

时间基、缓动词汇、以及所有的校验规则**与 `animate` 完全同一套** ——
`beat` / `frame` 都是 1 起序数，缓动是那 7 个，混用时间基/键序不递增都会报错。
`beat` 锚点同样跟着解说词走（改词后自动保持对齐）。

### 目前支持的效果

| 效果 | 参数 | 说明 |
|---|---|---|
| `blur` | `radius` 0–400（像素） | 高斯模糊。**`radius: 0` 是直通**，不产生额外趟。参数可写关键帧轨道。大半径走**金字塔** |
| `glow` | `radius` 0–200（默认 16）、`intensity` 0–3（默认 0.8）、`threshold` 0–1（默认 0.7） | 辉光/泛光：把比阈值亮的部分抽出来模糊，再加性叠回原图。**不给参数就是一次默认辉光** |
| `color` | `exposure` −4–4 EV、`brightness` 0–4、`contrast` 0–4、`saturation` 0–4、`hue` −180–180°、`temperature` −1–1 | 调色。顺序：曝光 → 亮度 → 对比 → 饱和 → 色相 → 色温。参数都可省，但**至少得给一个**（全用缺省值等于什么都没做） |
| `vignette` | `amount` 0–1、`radius` 0.2–2（默认 1）、`softness` 0.01–1（默认 0.5） | 暗角：以中心为原点径向压暗 |
| `chromatic` | `amount` 0–30（像素）、`angle` −180–180°（默认 0） | 色差：红/蓝分离，**越靠边分得越开**（中心干净才像真镜头） |
| `grain` | `amount` 0–1、`size` 1–8（默认 1） | 胶片颗粒。噪点是 **(像素, 帧号) 的纯函数**——同一帧永远同一张，不同帧不同 |
| `pixelate` | `size` 1–64（像素） | 马赛克。`size: 1` 是直通 |
| `radialBlur` | `amount` 0–0.5、`centerX`/`centerY` 0–1（默认 0.5） | 径向/缩放模糊：沿"从中心往外"拖尾（固定 8 采样点） |
| `distort` | `amount` 0–1、`frequency` 1–20（默认 4）、`phase` −180–180°（默认 0） | 波状扭曲（水波/玻璃感） |
| `grade` | `look`：`teal-orange` / `filmic` / `noir` / `warm` / `cool`；`amount` 0–1 | 调色预设。**`amount` 在"原样"与该预设之间插值**（0=直通）。编译期展开成一个 `color` 步骤，所以不额外开销 |

`grade` 是 `color` 的**预设层**：想快速出"电影感"就用它，要精确控制就用 `color`。
`amount` 是**连续插值**不是开关——实测去色程度随它单调变化（通道差 27.65 → 21.70 → 14.17）。

```json
"effects": [
  {"type": "color", "saturation": 1.15, "temperature": 0.1},
  {"type": "glow", "intensity": 0.6, "threshold": 0.6},
  {"type": "vignette", "amount": 0.35}
]
```

**参数缺省值是"合理的默认效果"，不是直通值**（所以 `{"type": "glow"}` 会给一份像样的辉光）。
而**直通条件**（`blur.radius=0`、`glow.intensity=0`、`vignette.amount=0`、`color` 全恒等）
决定"这一帧要不要进 GPU"——命中就不进，所以那些帧的输出与不写效果**逐位相同**。

`radius` 上限 **400**：小核的抽头间距必须 ≤2px 才不会变成稀疏采样（否则出振铃 ——
实测过"半径越大反而越锐"），而迭代法的趟数是 O(σ²)，半径一大趟数就爆炸。
所以**大半径走金字塔**：降采样 → 在低分辨率上用小核 → 升采样。
同样的像素间距在低分辨率上对应更大的实际半径，趟数只取决于**降采样后**的半径。

上限 400 不再是"实现撑不住"的边界，而是**产品边界**（400px 在 720p 上几乎等于整幅糊掉）。

### 性能：**效果链要用 `--gpu` 才划算**（实测）

同一次运行内配对测量（720p，`tools/verify-effects.mjs` 可复现）：

| 档位 | 不写 effects | `blur radius=12` | 代价 |
|---|---|---|---|
| 默认（`--disable-gpu`，WebGL 走软件光栅化） | 51.1 ms/帧 | 99.8 ms/帧 | **+48.6 ms（1.95×）** |
| `--gpu`（真 GPU） | 53.0 ms/帧 | 59.0 ms/帧 | **+6.0 ms（1.11×）** |

差 **8 倍**。原因是默认档下连 WebGL 都退化到软件渲染
（渲染器字符串是 "Microsoft Basic Render Driver"），模糊的多趟全落在 CPU 上。

所以：**要用效果链，就配 `--gpu`**。代价是 2D 像素会变、像素基线不再跨机器成立
（见 [LIMITATIONS](../LIMITATIONS.md)）。

### 三条保证

- **不写 `effects`、或全在直通值上**（`radius: 0` / `intensity: 0` / `amount: 0` / 全恒等调色）
  ⇒ 走原路，**输出逐字节不变**（像素回归基线就是靠这条守住的）。**逐帧判定**：
  `radius` 从 0 渐入时，起点那一帧本身就是直通的，那一帧不进 GPU ——
  所以渐入的起点与不写效果**逐位相同**。
- **纯函数**：效果只依赖 `(参数, 帧号)`，不做"上一帧结果"这类反馈
  ⇒ 分片、跳帧、全量自检都不受影响
- **没有 WebGL 时如实报错**，不静默跳过（静默跳过会让人以为效果生效了）

⚠️ **效果生效的帧会经过一次 GPU 往返**（上传 → 离屏 → 取回），实测平均差 **0.03 级**、
最大 **2 级**（8bit 量化的必然结果）。所以"有效果的帧"不保证与不写效果**逐位**相同 ——
逐位相同只在"直通条件命中的帧"（根本不进 GPU）成立。

### 还没做的（都是有意留的，别当成 bug）

- **还剩 1 个效果**（`displace` 跨层置换）—— 它要用另一层当置换图，需要跨层取纹理，
  是**架构性**改动（现在效果链只吃一个画布），所以留到最后。
- **自定义着色器**：命令式入口（`shots/index.js`）将来可以写，但引擎不背书、不进 schema。
- **效果只作用于镜头（或图层）整体**，不能只作用于模板内部的某个元素。
  要那种效果就把它拆成独立的一层（`layers` 容器的每层都能挂自己的 `effects`）。

## 3D 图层（现成的 three，**可选**依赖）

3D 用现成的 [three](https://threejs.org/)，不自己封一套 GL。**两条路都能走**：

### 声明式：`scene.json` 里的 `three` 镜头

形状与相机是**有界词汇表**（与效果链同一原则）：形状是枚举、数值有范围、
**动画只走关键帧轨道**（与 `animate` 同一套时间基，`beat`/`frame` 锚点都能用）。

```json
{"type": "three", "at": "S03",
 "camera": {"z": 4.2, "fov": 50, "lookAt": [0, 0, 0]},
 "objects": [
   {"shape": "box", "size": 1.6, "color": "accent",
    "animate": {"ry": [{"beat": 1, "v": 0}, {"beat": 3, "v": 360, "ease": "out3"}]}},
   {"shape": "torus", "size": 1.0, "color": "#4f9dff", "wireframe": true, "opacity": 0.6,
    "position": {"x": 1.6, "y": 0.2, "z": 0},
    "animate": {"rz": [{"frame": 1, "v": 0}, {"frame": 90, "v": 180}]}}
 ]}
```

| 字段 | 可用值 |
|---|---|
| `shape` | `box` / `sphere` / `torus` / `plane` / `icosahedron` |
| `size` | 0–20（世界单位） |
| `color` | 主题色名（`accent` / `text` / `muted` / …）或 `#rrggbb` |
| `wireframe` / `opacity` | `true/false`；0–1 |
| `position` / `rotate` | `{x,y,z}`（rotate 是**角度制**） |
| `animate` | 属性：`x` `y` `z` `rx` `ry` `rz` `scale`；值是关键帧轨道 |
| `material` | `basic`（不受光/平涂）或 `standard`（受光）。默认：**有 `lights` 时 standard，否则 basic** |
| `camera` | `x` `y` `z` `fov`（1–179）`lookAt`（`[x,y,z]`） |
| `lights` | 最多 6 盏。`ambient`（铺底，不产生明暗）/ `directional`（像太阳）/ `point`（像灯泡，随距离衰减）；各有 `color` `intensity` 0–20，后两种还要 `position`（`[x,y,z]`） |
| `lights[].animate` | 属性：`intensity`（脉冲/呼吸）、`x` `y` `z`（光扫过）。**颜色不能动**（配色只取章节 accent 是条纪律），`ambient` 只能动 `intensity`（它没有方向）。用 x/y/z 轨道时可以**不写静态 `position`** |
| 上限 | 一个镜头最多 **24** 个对象（每个是一次 draw call） |

**打光是显式动作**：不写 `lights` 就用无光照材质，画面与加光照之前**逐位相同**；
写了才切到受光材质（PBR，`roughness 0.55 / metalness 0.15`）。

```json
{"type": "three", "at": "S04",
 "camera": {"z": 4.2},
 "lights": [
   {"type": "ambient", "intensity": 0.6},
   {"type": "directional", "intensity": 2.4, "position": [4, 3, 5]},
   {"type": "point", "color": "#ffd9a0",
    "animate": {"intensity": [{"beat": 1, "v": 0.3}, {"beat": 2, "v": 2.6, "ease": "out3"}]}}
 ],
 "objects": [{"shape": "sphere", "size": 2.2, "color": "accent"}]}
```

实测判据（`tools/verify-three.mjs`）：**只有环境光时物体是"平"的**（中央亮度标准差 **0.00**），
加上平行光才出现明暗梯度（**20.29**）—— 这一条证明光真的在参与着色，
而不只是"材质换了所以画面变了"。**脉冲光**的强度轨道让画面逐帧变亮
（10.2 → 12.5 → 13.8 → 14.8，单调）；受光场景同一帧两次渲染仍**逐字节一致**。

**写错在静态自检就报**（`scene.json` 是静态校验的）：不认识的形状、越界数值、
不认识的动画属性都会带可用值报出来。`filmwright schema` 里能查到这份词汇表。

### 命令式：`shots/index.js` 里自由发挥

要词汇表覆盖不了的（自定义几何、材质、光照、后处理），走命令式：

3D 用现成的 [three](https://threejs.org/)，不自己封一套 GL。因为**渲染页的 `draw` 是同步的**，
而 three 的加载与渲染器初始化是异步的，所以形状是「**模块顶层 await 一次，之后每帧同步渲**」：

```js
import {loadThree, create3D} from 'filmwright';

const T = await loadThree();                 // 只有这个文件 import 了才加载 three
const cube = await create3D(T, (T, {scene, camera, n}) => {
  if (!scene.userData.m) {                   // 场景只建一次
    const m = new T.Mesh(new T.BoxGeometry(1.6, 1.6, 1.6),
      new T.MeshBasicMaterial({color: 0x4f9dff}));
    scene.add(m); scene.userData.m = m;
    camera.position.set(0, 0, 4.2);
  }
  // ⚠️ 每帧**完整**按 n 写一遍会动的属性
  const m = scene.userData.m;
  m.rotation.set(0.4 + n * 0.01, n * 0.03, 0);
});

export const SHOTS = [{start: 1, draw(ctx, n) { cube.render(ctx, n); }}];
```

顶层 await 带来两个性质，都是有意要的：

- **不用 3D 就完全不加载 three**（2.2MB）—— 只有真去 import 才拉，引擎不需要猜也
  不需要额外的声明字段；
- 3D 图层可以和 `effects` / `transform` / `animate` 一起挂（它们作用在**画完之后**的帧上）。

### ⚠️ retained-mode 陷阱：每帧都要完整写一遍

three 是**保留模式**的场景图 —— 场景一旦建好就一直在。所以：

- 只写一次、或按「距上一帧过了多久」**累加**，都会让第 N 帧依赖历史；
- 那会直接破坏「第 N 帧只是 N 的函数」，**分片渲染、跳帧、增量复用全都会崩**。

`create3D` 刻意**每帧都调 `build`**，就是让「完整写一遍」成为默认动作、而不是靠人记得。

实测这条判据**有区分力**（`tools/verify-three.mjs` 里有负面对照）：故意写成累加的那版，
**同顺序连渲两遍仍然逐字节一致** —— 所以「跑两遍比一比」**不足以**证明纯函数性，
必须**乱序渲染同一帧**才抓得住。

### 性能（实测，同一次运行内配对）

| 档位 | 不带 3D | 带 3D | 代价 |
|---|---|---|---|
| 默认（软件 WebGL） | 70.3 ms/帧 | 95.9 ms/帧 | **+25.6 ms（1.36×）** |

首次加载 three 约 50 ms，摊到长片可忽略。

### 还没做的

- **声明式 3D 图层**（在 `scene.json` 里描述 3D）—— 现在只有命令式入口。
  需要先定一套"3D 场景的词汇表"（形状/相机/光照/动画），那是独立的一步。
- **WebGPU 后端**：本机无头环境实测**实际用的是 WebGL 后端**（即使 `navigator.gpu`
  为 `true`）。`render()` 是同步提交，WebGL 下正确；WebGPU 的渲染是异步的，
  要真跑 WebGPU 需要改成 await 形状的 API。

## 并发多层（`layers` 容器）

需要"同一个镜头区间里同时有几样东西"时，用容器：

```json
{"type": "layers", "at": "S05",
 "layers": [
   {"content": {"type": "image", "asset": "bg"}, "z": 0},
   {"content": {"type": "stat", "value": 81, "label": "ms"}, "z": 1, "from": 30, "to": 120},
   {"content": {"type": "title", "title": "尾声"}, "z": 2, "from": 130, "animate": {"alpha": [{"frame": 1, "v": 0}, {"frame": 20, "v": 1}]}}
 ]}
```

| 层字段 | 说明 |
|---|---|
| `content` | 一次**模板调用**（`{"type": "bullets", …}`）。**不能带 `at`** —— 层的位置由层自己的 `from`/`to` 决定 |
| `z` | 层序：**数值大的画在上面**；不写则按声明顺序（后面的在上） |
| `from` / `to` | 层自己的时间窗，是**相对本镜头起点**的偏移（1 起）。窗口外的帧不画它，也不报错 |
| `transform` / `animate` | 每层独立的变换与关键帧，与镜头**同一套机制** |

- 层数上限 **8**（每层都是一次完整绘制，太多会拖垮帧时间）
- `layers` 是**容器不是模板**：它没有自己的内容。`filmwright schema` 会把它标成【容器】
- v1 **不允许层里再放 `layers`**（避免无界嵌套）

没写 `layers` 的镜头完全不受影响 —— 快路径与像素基线照旧。

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

### 手写镜头与声明式**同能力**

声明式镜头能声明的通用字段，手写镜头**都能用**（用 `start` 代替 `at`）：

```js
import {view, theme as C, text, applyDesignScale} from 'filmwright';
export const SHOTS = [
  {start: 1,
   beats: [20, 50],                                  // 声明节拍 ⇒ beat 锚点才可用
   transform: {x: 12, alpha: 0.95},
   animate: {y: [{beat: 1, v: 0}, {beat: 2, v: 20}]},
   effects: [{type: 'glow', intensity: 0.5}],        // 效果链同样能用（含关键帧参数）
   transition: {type: 'fade', frames: 10},
   draw(ctx, n) { /* 任意 Canvas 2D 绘制 */ }},
];
```

**校验也是同一套**（`tools/verify-imperative.mjs` 钉住这条）。这一点值得强调，因为手写镜头不走 `scene.json` 的校验路径，规则容易悄悄缺掉——实测抓到过两个难查的失败：

- **不认识的效果名**（`{type: 'sparkle'}`）→ 曾经**静默失效**：不报错，画面与不写效果一模一样；
- **越界参数**（`blur radius=999`）→ 曾经不报错**而且真的生效**，绕过了契约上限，渲染出带振铃的画面。

两条现在都会**当场报错**，并带结构化错误码与出路提示。

⚠️ **一个已知限制**：这些校验跑在**浏览器 boot** 时，所以 `check --static-only`（Node 侧、不开浏览器）**抓不到**，要跑到渲染或预览才报。这与「自检越早越好」的方向相反，是有意如实记下的现状。

## 质量下限从哪来

模板把示例片验证过的节奏纪律内建了：入场用 `inv + easeOut3`、落位后保持呼吸/脉冲（幅度按画质自检的静止阈值口径给足）、配色只取章节 `accent`、坐标一律设计基准。也就是说 **AI 写规格写不出「静止 3 秒」和「挤在左边」**——这些下限由引擎兜住，剩下的内容对错交给十道自检与联络表。
