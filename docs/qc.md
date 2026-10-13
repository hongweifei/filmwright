# 质量保障

这个库的三层质量网，各自证明不同的事：

| 层 | 证明什么 | 速度 |
|---|---|---|
| 单元测试（`npm test`） | 某个函数算得对，重点是错误路径与边界 | 0.4 秒左右 |
| 自检（`filmwright check`） | 整片渲染不崩、引用关系成立、画质在阈值内 | 静态秒级 / 全量要真画 |
| 像素回归（`tools/regression.mjs`） | 结构改动没有改掉任何一个像素 | 真渲若干帧 |

## 八道自检

`filmwright check --project <项目目录>` 依次跑八道，前三层不启浏览器：

| 检查 | 抓的问题 | 要浏览器吗 |
|---|---|---|
| `api` | `index.js` 重名导出（只在浏览器求值时报 `Duplicate export of 'S'`） | 不要 |
| `imports`（shots） | 镜头文件相对路径写错（页面**静默**不 ready，只有抓 console 才看得到） | 不要 |
| `timeline` | 引用不存在的句 id / 字幕块号（只在渲到那一帧时才在画面上报错） | 不要 |
| `assets` | 用了没声明的素材名；或声明了但 `public/` 下没有那个文件 | 不要 |
| `imports`（runtime） | 引擎自身模块的相对路径 | 不要 |
| `themeKeys` | 运行时代码引用了 `theme` 里不存在的配色键 | 不要 |
| `frames` | 每帧绘制抛错（抓「只在某一帧才炸」） | **要** |
| `quality` | 静止过久、空白帧（见下） | **要** |

加 `--static-only` 只跑前六道，不启浏览器——CI 与改完镜头后的快速验证用。

### `themeKeys` 这道为什么值钱

库内部大量把 `theme` 的键当**默认参数值**用（`{color = C.blue}` 这种）。键名写错或漏定义时**不报错**，默认值变成 `undefined`，一直传到绘制才崩——崩的地方离原因很远。

这不是假想：把一部 7465 帧的真实片子迁过来时，`matrix()` 没传颜色就撞上了 `C.green` / `C.red` 不存在，报的是 `hexA` 里的 `Cannot read properties of undefined (reading 'replace')`。46 秒的示例恰好每次都显式传色，所以一直没暴露。

两边现在都堵上了：`theme` 的键为空或 `undefined` 会在**配置期**报错并指出是哪个键；运行时代码引用了不存在的键会被 `themeKeys` 静态查出。

### 画质自检（`quality`）

抓「不崩但不好看」的问题：

- **静止过久**——内容区连续静止超过 3 秒（观众会觉得卡住）；
- **空白帧**——内容区几乎没有与主色调不同的像素（等于没画东西）；
- **末拍稳定期**——最后一拍元素落位后到镜头结束有多久。这条**只报告、不判失败**：像素 diff 分不清一次变化是「入场」还是「离场」，而这恰恰要求区分。三种读法都试过、都不对（量末尾静止 → 有呼吸动效的镜头永远读 0；把末尾几拍算落位 → 离场被当末拍；连续几拍算离场 → 被片尾压黑切断）。要做成硬判据，得先有能区分入场/离场的信号（例如镜头自己声明节拍）。

判据细节（为什么「静止」是累积口径、阈值按什么校准）见 [LIMITATIONS](../LIMITATIONS.md)。

阈值可用参数覆盖：`--static-frames` / `--hold-frames` / `--ink-min` / `--quality-step`。

### 渲染页把错误画进画面

渲染页在抛错时**把错误画进画面**并记进 `window.__lastError`，所以 QC 不会把一张出错的帧误当成正常帧。模块加载失败是**完全静默**的，专门有 `tools/boot-error.mjs` 取 `window.__bootError`。

## 负面对照：证明检查真的会报

**一个永远绿的检查不是检查。** 每道自检都要证明「喂它坏的，它真的会红」：

```bash
node tools/quality-negative.mjs
```

它用构造数据喂给纯函数，故意做出「静止 150 帧」「墨迹 0.01%」，确认都会被报出来。单元测试里静态检查的用例同样是「故意写一个不存在的键，确认它会报」。

## 像素回归：结构改动的守卫

纯结构调整**不该改一个像素**。改结构之前后的标准动作：

```bash
node tools/regression.mjs capture --project examples/minimal   # 改之前
# ... 搬文件 / 拆模块 / 改依赖方向 ...
node tools/regression.mjs verify  --project examples/minimal   # 改之后，必须全同
```

逐字节相同才说明真的只是搬家；有一帧不同，说明行为被改了——要么是故意的（重新 `capture`，并在提交消息里写明），要么是 bug。像素回归的基准文件（`examples/minimal/regression-baseline.json`）**跟着仓库走**，别人 clone 下来就能 verify。但基准是**本机夹具**：字体栅格化随操作系统与浏览器版本变，verify 要在抓基准的同一类环境跑，跨 OS 逐字节比对必然红——所以 CI 上不比基准，改做「同一次运行内 capture → verify」的自证（见下）。

## 验证夹具在 `tools/`

`tools/` 是**要跟着仓库走的**验证夹具，不是产物：

| 工具 | 干什么 |
|---|---|
| `regression.mjs` | 像素回归守卫：`capture` 抓基准，`verify` 重渲比对，逐字节相同才算过 |
| `verify-readme.mjs` | 照 README 的快速开始跑一遍（文档与代码脱节时它会红） |
| `verify-preview.mjs` | 真开浏览器验证预览页：拖动、边界、播放、画面有内容、热重载 |
| `verify-assets.mjs` | 真开浏览器验证素材：加载就绪、原始尺寸、**真画出来了**、引错名字要报 |
| `verify-reuse.mjs` | 验换分辨率（1080p）与换浏览器（两个浏览器渲同一帧要字节相同） |
| `quality-negative.mjs` | 负面对照：故意做坏，证明画质检查真的会报 |
| `make-sample-asset.py` | 生成示例用的素材图（纯几何，不含文字——夹具不能依赖字体） |
| `compare-original.py` | 迁移验收：迁移后的渲染 vs 原片 mp4 同一帧，算 PSNR |
| `compare-three-way.py` | 三方对比：原引擎 / 迁移后 / 原片。**先确认原片没过期**，否则拿它当基线是错的 |
| `compare-timelines.mjs` | 比对两份时间轴（原引擎的 `.js` 与 filmwright 的 `.json`），不同步表现为「动画中的元素差一点」 |
| `diff-regions.py` `diff-hotspots.py` | 差异定位：按功能区 / 16×9 分块算平均差，指出差异集中在哪 |
| `diff-nature.py` | 判断差异性质：抗锯齿/亚像素位移（模糊后消失）还是真的内容不同 |
| `diff-channels.py` `diff-probe.py` `ascii-region.py` | 逐通道 / 单点探针 / 字符画区域，人工细看用 |
| `check-modules.mjs` | 逐个 fetch 渲染页要用的模块，看谁 404 |
| `boot-error.mjs` | 取 `window.__bootError`——页面模块加载失败是完全静默的 |
| `verify-commit.py` `audit-commit.py` | 提交消息与提交内容的核对 |

## CI 怎么跑

`.github/workflows/ci.yml` 分两个 job，失败信息指向明确：

- **static**——单元测试 + 静态自检（不启浏览器）。挂掉基本就是代码错了（引用、导出、纯函数行为）。
- **browser**——无头 Chrome + ffmpeg：逐帧 + 画质自检、**渲染确定性自证**（同一次运行内 capture → verify，两轮渲染逐字节相同）、负面对照、素材与预览页验证、端到端出片并检查产物非空。挂掉更可能是渲染行为变了。

两个 job 分开，是为了从失败一眼看出是哪一类问题。渲染全程无头（`--headless=new`）：CI 与服务器上没有显示器，有头模式直接退出；无头与有头同一条渲染路径，基准验证过逐字节一致。
