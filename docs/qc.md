# 质量保障

这个库的三层质量网，各自证明不同的事：

| 层 | 证明什么 | 速度 |
|---|---|---|
| 单元测试（`npm test`） | 某个函数算得对，重点是错误路径与边界 | 0.4 秒左右 |
| 自检（`filmwright check`） | 整片渲染不崩、引用关系成立、画质在阈值内 | 静态秒级 / 全量要真画 |
| 像素回归（`tools/regression.mjs`） | 结构改动没有改掉任何一个像素 | 真渲若干帧 |

## 十道自检

`filmwright check --project <项目目录>` 依次跑九道，前八道不启浏览器：

| 检查 | 抓的问题 | 要浏览器吗 |
|---|---|---|
| `api` | `index.js` 重名导出（只在浏览器求值时报 `Duplicate export of 'S'`） | 不要 |
| `imports`（shots） | 镜头文件相对路径写错（页面**静默**不 ready，只有抓 console 才看得到） | 不要 |
| `timeline` | 引用不存在的句 id / 字幕块号（只在渲到那一帧时才在画面上报错）。**含 `film.config.mjs` 的 `hud`**——`drawHud` 每帧都查句 id，写错会让整片每一帧都抛错 | 不要 |
| `scene` | scene.json 规格不合法（未知类型、缺字段、对齐到不存在的句/块、顺序不递增……每条带 code/path/hint） | 不要 |
| `assets` | 用了没声明的素材名；或声明了但 `public/` 下没有那个文件 | 不要 |
| `imports`（runtime） | 引擎自身模块的相对路径 | 不要 |
| `themeKeys` | 运行时代码引用了 `theme` 里不存在的配色键 | 不要 |
| `frames` | 每帧绘制抛错（抓「只在某一帧才炸」） | **要** |
| `quality` | 静止过久、空白帧（见下） | **要** |

加 `--static-only` 只跑前八道，不启浏览器——CI 与改完镜头后的快速验证用。

### `themeKeys` 这道为什么值钱

库内部大量把 `theme` 的键当**默认参数值**用（`{color = C.blue}` 这种）。键名写错或漏定义时**不报错**，默认值变成 `undefined`，一直传到绘制才崩——崩的地方离原因很远。

这不是假想：把一部 7465 帧的真实片子迁过来时，`matrix()` 没传颜色就撞上了 `C.green` / `C.red` 不存在，报的是 `hexA` 里的 `Cannot read properties of undefined (reading 'replace')`。46 秒的示例恰好每次都显式传色，所以一直没暴露。

两边现在都堵上了：`theme` 的键为空或 `undefined` 会在**配置期**报错并指出是哪个键；运行时代码引用了不存在的键会被 `themeKeys` 静态查出。

### 画质自检（`quality`）

抓「不崩但不好看」的问题：

- **静止过久**——内容区连续静止超过 3 秒（观众会觉得卡住）；
- **空白帧**——内容区几乎没有与主色调不同的像素（等于没画东西）；
- **末拍稳定期**——最后一拍元素落位后到镜头结束有多久。**声明了节拍的镜头判失败**
  （`beats`：scene 模板自动带、手写镜头可选声明），停留不足 `--hold-frames` 或节拍
  排到镜头结束之后都报错；**没声明节拍的只报告**——像素 diff 分不清一次变化是
  「入场」还是「离场」，而这恰恰要求区分，拿不准的事不硬给结论。

声明节拍是把这条从读数变成判据的关键：模板知道自己的节拍表（`staggerFrames` 就是），
所以它不再需要从像素里猜。模板还会主动为末拍预留停留时间，避免内容多的镜头被自己挤掉。

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

两个 `verify-*` 夹具的浏览器会话统一走 `src/host/browser/session.mjs` 的 `openSession`（无头启动、启动失败当场报，不静默等到超时）。**工具里不要再各写一份启动逻辑**——那份拷贝漏掉过 `--headless`，CI 无显示器时挂在一个与真实原因无关的报错上。
| `verify-reuse.mjs` | 验换分辨率（1080p）与换浏览器（两个浏览器渲同一帧要字节相同） |
| `verify-mix.mjs` | **验配乐混音**：真跑 ffmpeg，只测音乐那一路，证明「人声在场时被压低、人声停下后恢复、duck 越大压得越深」，并验产物带双流与缺文件报错 |
| `verify-determinism.mjs` | **验捕获确定性**：多轮渲染同一区间，全部帧必须逐字节一致。钉住「取像素不能有竞态」——曾经用 `Page.captureScreenshot` 时有 3/60 帧偶发取到上一帧 |
| `verify-incremental.mjs` | **验增量重渲的安全性**：复用出来的段必须与重渲产生**相同帧数据**；改文件必重渲、改回精确复原、改引擎也必重渲；并验代理分辨率 |
| `verify-comp.mjs` | **验嵌套合成**：用页面内探针观测本地帧换算（不靠像素比对——整帧含随全局时间漂移的背景/HUD） |
| `verify-clips.mjs` | 验素材管线 host 侧：抽帧帧数、内容寻址缓存命中、改参数重抽、断点安全、源文件缺失与 start 超时长 |
| `verify-clip-render.mjs` | 验片段在浏览器里真的取到并画出：帧随 n 变化、同一帧两次相同、源帧映射、未声明片段名报错 |
| `verify-complex.mjs` | **四项复杂制作能力的协作验收**：同一个夹具项目里同时用图层变换、嵌套循环、素材片段、增量重渲与代理，验规格合法、抽帧缓存、代理分辨率、复用与全新重渲逐帧一致、以及三种能力各自确实改变画面 |
| `verify-tts.mjs` | 验 TTS 契约：`voices` 报出引擎可用性与回退结果、真跑一遍产出三件套、timeline 如实标注引擎与 `subs_timing`、音频与时间轴一致、逐句缓存命中、换引擎必须让缓存失效 |
| `verify-tts-e2e.py` | 验 TTS 端到端（真合成）：引擎回退链生效、产物与时间轴自洽、缓存命中、三处负面对照 |
| `verify-encoding.mjs` | 全仓文本必须是合法 UTF-8 且无 BOM —— 抓肉眼看不见的问题（曾把 `.gitignore` 写成 GBK） |
| `tools/probes/profile-frame.mjs` | **逐帧剖析**：把单帧时间拆成绘制 / 编码 / 传输 / 落地四段，并对比 PNG / JPEG / WebP 的编码耗时与载荷 —— 性能优化前先用它定位瓶颈（结论：绘制只占 0.6ms，瓶颈在编码与搬运） |
| `verify-voiceover.mjs` | 验示例的时间轴来自**真配音**（不是合成夹具）、音频与时间轴一致、`subs_timing` 与引擎能力一致 |
| `verify-longform.mjs` | 在 10 分钟量级上量单实例退化、分片加速比、增量段缓存规模、全分辨率吞吐 |
| `verify-attribution.mjs` | 验增量重渲按段归因：改一个镜头只重渲覆盖它的段，改全局输入则全失效 |
| `verify-effects.mjs` | 验效果链：**GPU 往返保真**（含"整帧上下翻转"这类**只有看图才发现**的 bug —— 它绕过了模糊单调、端点一致等全部判据）、每个效果的量化判据（模糊单调、辉光变亮、调色去色、暗角径向）、直通帧与不写效果逐位相同 |
| `verify-imperative.mjs` | 验**手写镜头与声明式同能力**：通用字段都能用、写错当场报（含结构化错误码与出路）、节拍锚点的运行期校验同样生效。实测靠它抓到"不认识的效果名**静默失效**"与"越界参数绕过上限真的生效" |
| `verify-three.mjs` | 验 3D 图层（three）：3D 内容确实叠进帧里、**同一帧号两次渲染逐字节一致**、**跳帧渲染与连渲一致**、不用 3D 的项目不加载 three；并带一条**有区分力的负面对照**（故意写成有状态的必须被抓出来）与配对的性能实测 |
| `quality-negative.mjs` | 负面对照：故意做坏，证明画质检查真的会报 |
| `make-sample-asset.py` | 生成示例用的素材图（纯几何，不含文字——夹具不能依赖字体） |
| `make-timeline-fixture.mjs` | 合成 `timeline.json` 夹具：edge-tts 端点不可达时让纯规格示例仍能跑 check 与渲染验收（明确标注非配音，跑 `tts` 会覆盖） |
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

`.github/workflows/ci.yml` 分两个 job × 平台矩阵：

- **static**——`ubuntu` / `macOS` / `windows` 三个 OS 都跑：单元测试 + 静态自检（不启浏览器）。核心零依赖，这是「跨平台」最便宜也最真的证据。MCP 的**协议层**测试（握手、tools/list、只读工具）在这里跑。
- **browser**——`ubuntu` / `windows`：无头浏览器 + ffmpeg。逐帧 + 画质自检、MCP 的**重浏览器**测试（`FILMWRIGHT_TEST_BROWSER=1` 才跑 stills/review 回图）、渲染确定性自证（同运行内 capture → verify）、负面对照、素材与预览页验证、端到端出片并验帧数。macOS 渲染不进矩阵——没有本地实测证据，不猜。

几个踩出来的 CI 约束（都写进了注释，别重犯）：

| 约束 | 为什么 |
|---|---|
| 诊断步骤必须放 **job 末尾** | `if: failure()` 只对它**之前**已失败的步骤生效；放中间会永远 skipped |
| 失败现场写 **step summary + artifact** | 公开仓库未登录时，job 日志正文、artifact 下载、失败步骤里的 `::error::` annotation **都拿不到** |
| 别用 `ls \| head -1` 取产物 | Git Bash 的 `ls` 是多列输出，会截出文件名片段；用 node 取 |
| 别依赖 `$RUNNER_TEMP` | windows 的 Git Bash 下可能展开为空，`--baseline` 会静默回落到入库夹具 |
| 重浏览器测试与协议层分开 | 前者要真渲染（慢、依赖浏览器），后者毫秒级；混在一起慢机器上必脆 |
| `--shards auto` 而非硬写片数 | windows runner 只有 2 核，硬写 2 片等于超订资源 |
| 效果链验收**不加 `--gpu`** | CI runner 拿不到可靠 GPU；而默认档（软件 WebGL）正是要守住确定性的那一档，效果在这档下也必须正确 |

### 哪些验收工具会自动跑、哪些要手动跑

**不跑的守卫等于没有守卫**，所以这张表要如实：

| 状态 | 工具 |
|---|---|
| **CI 自动跑** | `verify-encoding`、`verify-docs`（static job）；`quality-negative`、`verify-assets`、`verify-effects`、`verify-imperative`、`verify-preview`（browser job） |
| **手动跑（需真实环境/较慢）** | `verify-determinism`、`verify-incremental`、`verify-composite`、`verify-comp`、`verify-clips`、`verify-clip-render`、`verify-mix`、`verify-reuse`、`verify-attribution`、`verify-complex`、`verify-voiceover`、`verify-three` |
| **手动跑（慢或依赖外部）** | `verify-longform`（10 分钟量级，约数分钟）、`verify-tts` / `verify-tts-e2e.py`（真合成，联网且端点可能不可用）、`verify-readme` |

这是一个**已知缺口**：20 个验收工具里只有 7 个进了 CI。改核心路径（尤其是渲染、增量、合成）之后，**手动的那些要自己记得跑**——
比如 `verify-incremental` 守的是"复用段与重渲必须逐帧一致"，它不跑就没人在守。
把更多工具接进 CI 需要先按耗时分类（有的要几分钟），那是一件独立的事。

`verify-three` 之所以暂时手动：它要装 `three`（可选依赖）并跑十几次渲染，
耗时明显高于已接入的两个。改 `src/runtime/three/` 或 importmap / vendor 路由之后**必须手动跑它**。

**关于 flaky 的判定纪律**：同一步骤「一次过、一次挂」时必须复跑定性，不能算修好。本次排查中 windows 渲染 job 的失败点曾逐次迁移（端到端出片 → 逐帧+画质 → MCP 测试 → 渲染确定性 → …），**每次的根因都不同且都定位到了**：定时器泄漏（测试进程挂 302 秒）、夹具被 CI 覆盖、`$RUNNER_TEMP` 展开为空、浏览器断开无处理、分片失败无重试。修完后 CI 全绿。
