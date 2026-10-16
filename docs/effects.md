# 效果链（`effects`）

效果链是**镜头对象的一个字段**，与 `transform` / `animate` / `mask` 同级；项目里没有声明式规格文件：

```js
const BODY = {
  start: cutBefore('S03'),
  effects: [
    {type: 'color', saturation: 1.15, temperature: 0.1},
    {type: 'glow', intensity: 0.6, threshold: 0.6},
    {type: 'vignette', amount: 0.35},
  ],
  draw(ctx, n) { /* 这一镜画什么 */ },
};
```

数组**顺序即应用顺序**。效果只作用于**这一个镜头自己画的内容**（引擎已画的背景不受影响）。

**参数可以是关键帧轨道**（让模糊渐入、辉光脉冲）：

```js
effects: [{type: 'blur', radius: [{beat: 1, v: 0}, {beat: 2, v: 16, ease: 'out3'}]}]
```

时间基、缓动词汇、以及所有的校验规则**与 `animate` 完全同一套** ——
`beat` / `frame` 都是 1 起序数，缓动是那 7 个，混用时间基/键序不递增都会报错。
`beat` 锚点跟着解说词走（改词后自动保持对齐），前提是这个镜头声明了 `beats`。

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
| `displace` | `amount` 0–1、`frequency` 1–40（默认 8）、`phase` −180–180°（默认 0） | **程序化值噪声**置换（热浪/水汽/有机抖动）。与 `distort` 的区别：`distort` 是**正弦**（规则，像水波/玻璃），这里是**值噪声**（不规则，像热浪）。`phase` 走关键帧 ⇒ 热浪流动 |

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

- **效果链 12 个效果都做完了**：11 个具名效果（`blur` `glow` `color` `vignette` `chromatic` `grain`
  `pixelate` `radialBlur` `distort` `grade` `displace`）+ 一个受约束的逃生舱 `custom`
  （见下）。`displace` 是程序化噪声置换（不是跨层纹理），详见下面「`displace` 怎么做」。
  ⚠️ **新增效果要动三处**：契约（`EFFECT_TYPES`/`EFFECT_SPECS`）、`SIMPLE_PASSES`、
  **以及 `GpuStage` 的 `this.progs` 注册表**。**漏掉第三处不会报错** ——
  pass 会拿到 `undefined` 程序，产出**不稳定**画面，看起来完全像"着色器数学有问题"。
  实测在这上面绕过一大圈（排查记录见下），现在有 `tests/effects.test.mjs` 里
  一条不变量测试守着（`SIMPLE_PASSES` 里每个 prog 都要在注册表里有对应项）。
- **逃生舱 `custom`**：词汇表盖不住的效果，你自己写一段 **GLSL ES 1.0 片段着色器**。
  它是**受约束的**（单趟、一张输入纹理、uniform 只能是标量数值、源码与 uniform 都有上限），
  详见下一节。
- **效果只作用于镜头（或图层）整体**，不能只作用于镜头内部某个元素。
  要那种效果就在镜头里分层画，或者把那部分内容单独画到一个离屏画布上再处理。

### 逃生舱：`customPass(src, uniforms)`

具名效果是**有界词汇表**，盖不住的时候用 `customPass` 交一段自己的片段着色器：

```js
import {customPass} from 'filmwright';

export const SHOTS = [{
  start: 1, end: 90,
  effects: [customPass(`
    uniform float scan;            // 你自己的 uniform（标量）
    void main(){
      vec4 c = texture2D(t, uv);   // t 是输入纹理，uv 是 0–1 坐标
      float line = step(0.5, fract(uv.y / texelY / 4.0));
      gl_FragColor = vec4(c.rgb * mix(1.0, line, scan), c.a);
    }
  `, {scan: 0.35})],
  draw(ctx, n, t) { /* … */ },
}];
```

- **引擎补在源码前面的那一段**（你不用写）：`precision mediump float;` `varying vec2 uv;`
  `uniform sampler2D t;` `uniform float texelX, texelY, frame;`。
  `texelX`/`texelY` 是一个像素的 uv 步长（采样邻域要用它）；
  **`frame` 是唯一的时间来源** —— GLSL ES 1.0 拿不到时钟，所以"同一帧永远同一张"
  是**结构上**成立的，不靠你守纪律。
- **你自己的 uniform**：`{名字: 数值}`，或 `{名字: [{frame: 1, v: 0}, {frame: 60, v: 1}]}`
  这样的**关键帧轨道**（与别的效果同一套规则）。名字不能撞上面那几个保留名。
- **边界**（都在 boot 期校验，报 `SCENE_FX_CUSTOM`）：`src` 必须是含 `void main` 的字符串
  且不超过 4000 字符；`uniforms` 最多 16 个（GLSL ES 1.0 保证的最小 uniform 数量），
  名字要合法、值必须是有限数。校验不过时 `--json` 的 `errors` 里会给出 `path` 与提示。
- **它没有直通条件**：引擎读不懂你的着色器在什么取值下"等于没做"，所以用了 `custom`
  就一定每帧多跑一趟 GPU（别的效果在直通值上会被当帧短路）。
- **写错了不会被静默吞掉**：编译/链接不过时，那一帧画成**报错帧**（整帧深红底 + 错误
  与调用栈），错误同时记进 `__lastError` —— `filmwright check` 的逐帧检查会把它报成
  **失败**，文案里带 GL 的日志。⚠️ `stills` / `render` **不会**因此退出非 0：页面侧的
  设计是"出错也要出图（画面留证据）"，对所有镜头绘制异常一视同仁。所以写完自定义效果
  **请跑一遍 `check`**（实测：镜头里 `throw new Error('boom')` 同样是 `stills` 退出 0）。
- **`custom` 盖不住什么**：多趟后处理、需要额外纹理或上一帧反馈的效果、顶点级变形、
  遮罩羽化 —— 这几样现在没有口子（见[已知限制](../LIMITATIONS.md) 第 13 节）。
  一个效果如果反复要用，**做成具名效果**才是正路。

### `displace` 怎么做（设计决定 + 实施清单）

**原计划**是"用另一层当置换图"（跨层取纹理）。**改成程序化噪声置换**，理由：

· 跨层取纹理要求效果链**打破"只吃一个画布"这个前提**（现在 `applyEffects` 只拿到一张
  合成好的画布）。为它改架构，收益不成比例 —— 而且会让"效果只依赖 (参数, 帧号)"
  这条好性质变复杂（要引入"哪一层"的引用与顺序依赖）。
· 程序化噪声置换**已经能覆盖真实用途**：热浪/水汽/有机抖动。
  它与已有的 `distort` **不重复** —— `distort` 是**正弦**（规则、像水波/玻璃），
  `displace` 是**值噪声**（不规则、像热浪）。

**实施清单**（照这个做）：

1. `contract/effects.js`：`EFFECT_TYPES` 加 `displace`；`EFFECT_SPECS.displace`：
   · `amount` 0–1（必填）—— 最大位移，按画面短边比例
   · `frequency` 1–40（默认 8）—— 噪声尺度：越大块越碎（**契约里的真名**，
     `distort` 用的也是这个 uniform 名；早期草稿里曾写作 `scale`）
   · `phase` −180–180°（默认 0）—— 噪声相位，**可写关键帧**（这样流动仍是 N 的函数）
   · `noopWhen: [{amount: 0}]`
2. `runtime/fx/shaders.js`：加 `FS_DISPLACE`（片元着色器）+ `SIMPLE_PASSES.displace` 一行
   （**表在 shaders.js、程序注册表在 stage.js** —— `fx/gpu.js` 只是门面，加完要两边都对上）。
   噪声用 hash 值噪声（不是纹理），保证与纹理无关、可复现
3. 验收（`tools/verify-effects.mjs` 加一节）：`amount=0` 直通；同一帧两次渲染**逐字节一致**；
   `phase` 关键帧 ⇒ 两帧不同；不同 `frequency` ⇒ 输出不同（**不是**「频率大 ⇒ 高频更多」，
   那条方向性**实测不成立**，别写成判据）
4. 文档：效果表加一行；`EFFECT_TYPES` / `EFFECT_SPECS` 是**唯一来源**，校验与执行都从它读

#### ⚠️ 第一次实现**失败并已回退** —— 它违反了核心不变量

照上面的清单做过一版（噪声用值噪声 + hash），**`verify-effects` 报 3 项失败**，
其中两条是硬伤：

    ✗ 同一帧两次渲染**逐字节一致**（噪声是纯函数）
    ✗ 带 phase 轨道时同一帧仍然逐字节一致

也就是说：**同一个帧号两次渲染，像素不同** —— 直接违反「第 N 帧只是 N 的函数」。
一个这样的效果进仓库，会把分片渲染、增量重渲、跳帧自检全部变成不可信。

**先怀疑 hash**：第一版用的是最常见的 `fract(sin(x) * 43758.5453)`，
它依赖大参数的 `sin`，mediump 下精度实现相关、跨程序编译不稳定。
换成**不含 sin 的 hash**（Hoskins 的 fract-dot 版）**之后仍然不一致** ——
所以 **hash 不是（唯一）原因**，真正的根因**尚未查清**。

⇒ **已把这一版全部回退**（不发布违反不变量的效果）。**回退后 362 条测试与像素回归全过。**

**排查进展（每一步都是实验，不是推断）**

| 实验 | 结果 | 结论 |
|---|---|---|
| 把 hash 从 `fract(sin(...))` 换成不含 sin 的版本 | 仍不一致 | **hash 不是原因** |
| 对照：`grain`（用那个 sin-hash）两次渲染 | 一致 | **hash 类数学没问题** |
| 对照：`distort`（偏移纹理采样）两次渲染 | 一致 | **偏移采样没问题** |
| **把这段噪声数学原样塞进 `distort` 的着色器体** | **一致**（`2cc7af199e5e` 两次） | **噪声数学也没问题** |

⇒ 四个都排除了。**问题不在数学，在"接线"** —— 即新效果类型 / 新 `SIMPLE_PASSES` 表项 /
uniform 名（我用了 `scale`，`distort` 用 `frequency`）这几处之一。

**下一步（很具体，一次实验就能再砍一半）**：

把 `displace` 重新加上，但**完全复用 `distort` 的接线** ——
沿用 `distort` 的 uniform 名（`amount`/`frequency`/`phase`）与 pass 表项，
只把着色器体换成噪声版（**这一版已验证是稳定的**）。

· 若**稳定** ⇒ 元凶是 `scale` 这个 uniform 名（或新 pass 表项）；
· 若**不稳定** ⇒ 元凶是"新增效果类型/新 pass"这条路径本身。

判据用 `tools/probes/check-determinism.mjs`（**3.5 秒一轮**，
它已把 `displace` 的位置预留在 `PRESETS` 里）。

#### 一条**主动放弃**的判据（写下来免得后人再想）

原计划里有一条「噪声的不规则性应当比 `distort` 的正弦更强」。
**放弃了**：值噪声用 smoothstep 插值后**同样是平滑的**，在相近特征尺度下
梯度分布并不更宽 —— **我无法为它给出可靠阈值**。
**写不出可靠阈值的判据不如不写**（否则会变成"看起来在验、其实恒真"）。
替代判据是：`displace ≠ distort`（同样 amount 下输出不同）+ 不同 `frequency` 输出不同 ——
**不是**「频率越大高频越多」（那条方向性实测不成立，`tools/verify-effects.mjs` 里只用能证伪的
「不同 `frequency` ⇒ 不同输出」）。

