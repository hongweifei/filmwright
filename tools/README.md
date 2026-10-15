# `tools/` 顶层工具索引

`tools/` 是这个仓库的**验证与开发工具箱**：跟着仓库走，但**不进 npm 包** —— `package.json` 的
`files` 白名单里没有它，而且 `verify-package.mjs` 有一条**独立**的规则盯着这件事（开发期专用的
目录**无论跟踪与否**都不许进包：`tools` / `tests` / `examples` / `.github` 四个）。顶层此前没有
索引 —— 只有 `docs/qc.md` 里一张把验收工具、探针、迁移脚本混在一起的表。本文件按**文件**逐个补上两件事：
**它自己声明的用途**（取自文件头部注释，不凭文件名猜）与**今天谁在调它**。

里面的东西按**分工**分三类：

| 类别 | 是什么 | 在哪些文件里 | 判据 |
|---|---|---|---|
| 守门用 | 常驻守卫：有判据，会红会绿 | `verify-*.mjs`，以及 `dead-exports.mjs`、`quality-negative.mjs`、`regression.mjs` | 判据必须能**证伪**（量方向 / 单调性 / 逐位一致 / 数量下限），并且自带负面对照 |
| 测量用 | 探针：只报数，不改判定 | `probes/` 下 | 没有判据，**不参与红绿** |
| 开发辅助 | 页面诊断器、夹具生成器、迁移期一次性脚本 | 顶层其余文件 | 人工按需跑 |

**验收工具与探针的分界**：守门工具**有判据**（跑完给结论，能红能绿），探针**只报数**
（跑完给人看，退出码不表达对错）。同一个判据的快慢两版会分别放在两边 —— 例如效果链的确定性判据，
守门版在 `verify-effects.mjs`，探针版在 `probes/check-determinism.mjs`，判据一致而耗时差一个量级。
**分工别混**：探针的读数不该拿来当验收结论。

## 约定

- **怎么调用**：`node tools/<名字>.mjs [<仓库根>]`（`.py` 用 `python tools/<名字>.py …`）。
  **不带参数时 ROOT 必须是仓库根。**
- **CI 里一律不带参数跑**（例如 `node tools/verify-clips.mjs`），所以每个工具的 ROOT 都要有兜底：
  `??` / `||` / `process.cwd()`，或者从 `fileURLToPath(import.meta.url)` 往上走。
  写成 `resolve(process.argv[2])` 会当场抛 `ERR_INVALID_ARG_TYPE`。这条有常驻守卫：`verify-invocation.mjs`。
  另一面：**不要给 CI 里的命令加 `.` 参数** —— 有的工具拿 ROOT 拼 `pathToFileURL`，
  相对路径会抛 `ERR_INVALID_FILE_URL_PATH`。
- **新的守卫必须自带负面对照**：在 `os.tmpdir()` 下搭一个最小仓库根，故意注入缺陷，
  要求它**确实红**、而且只红对应的那一条；把缺陷改回去必须重新变绿。
  「一个永远绿的检查不是检查」是这个仓库反复写进代码注释的口径。
- **同时要有「扫到 0 个即失败」的下限**：空集上的「全部有效」不是有效（`verify-links.mjs`、
  `verify-docs.mjs` 都有这一条）。
- **别硬编码会漂的数字**：期望值从实现里读、或从数据算出来（例如类型清单直接从契约 import），
  否则守卫会静默变成假警报。
- **临时夹具放 `os.tmpdir()`、跑完即删**（`mkdtempSync` + `try/finally` 里的 `rmSync`），
  真项目与真源码全程只读。

## 全部 47 个顶层文件

状态口径如下（**逐条实测得出**，不是按文件名归类 —— 这个仓库的文件名骗过人，见「已知问题」）：

- **CI 自动跑**：文件名出现在 `.github/workflows/ci.yml` 里。
- **npm 脚本**：出现在 `package.json` 的 `scripts` 里，但没有接进 CI。
- **仅文档提及**：只在 `docs/*.md`、`README.md`、`CHANGELOG.md` 等文档里被写到，没有任何自动调用。
- **零引用**：全仓检索只有它自己的用法注释提到自己。
- **由其它工具调用**：本文件新增的第五类，顶层里唯一的「工具调工具」。

### CI 自动跑（26 个）

| 文件 | 干什么（取自它自己的头部注释） | 状态 |
|---|---|---|
| `dead-exports.mjs` | 死导出守卫（棘轮）：**新出现**「导出但没人用」的符号就失败 | CI 自动跑（`static`） |
| `quality-negative.mjs` | 负面对照：故意做坏，确认画质自检真的会报 | CI 自动跑（`browser`） |
| `regression.mjs` | 像素回归守卫：抓一组帧的像素哈希，之后重渲必须画面相同 | CI 自动跑（`browser` 两次）+ npm 脚本 |
| `verify-assets.mjs` | 素材支持的验证：真开浏览器，确认图片**真的画出来了**，且引错名字会明确报错 | CI 自动跑（`browser`）+ npm 脚本 |
| `verify-attribution.mjs` | 按段归因的端到端验证：改一个镜头只重渲**覆盖它的那段** | CI 自动跑（`browser-slow`） |
| `verify-clip-render.mjs` | 片段素材的**浏览器端到端验证**：真抽帧 → 真服务 → 真在页面里取帧画出来 | CI 自动跑（`browser`） |
| `verify-clips.mjs` | 素材管线的端到端验证（host 侧，真跑 ffmpeg） | CI 自动跑（`browser`） |
| `verify-composite.mjs` | 图层合成与嵌套合成的端到端验收（真浏览器 + 真像素） | CI 自动跑（`browser`） |
| `verify-determinism.mjs` | 捕获确定性的**回归验证**：多轮渲染同一区间，全部帧必须逐字节一致 | CI 自动跑（`browser`） |
| `verify-docs.mjs` | 文档一致性：把「实现里的真实数字」与「文档里的说法」对齐 | CI 自动跑（`static`） |
| `verify-effects.mjs` | 效果链（最小闭环 blur）真的生效、方向正确、代价可量 | CI 自动跑（`browser`） |
| `verify-encoding.mjs` | 全仓扫描：有没有文件不是合法 UTF-8（含 BOM、非法字节），或换行风格不统一 | CI 自动跑（`static`）+ npm 脚本 |
| `verify-h264.mjs` | 页面侧 H.264 编码器（WebCodecs）的验收：真正是一段有效视频、帧数一致、背压生效 | CI 自动跑（`browser`） |
| `verify-imperative.mjs` | 命令式入口（`shots/index.js`）与声明式（`scene.json`）**同能力** | CI 自动跑（`browser`） |
| `verify-incremental.mjs` | 增量重渲的**安全性验证**：只保留本工具独有的三条判据 | CI 自动跑（`browser`） |
| `verify-invocation.mjs` | 守卫「同一个根因换个位置又回来」的两类问题 | CI 自动跑（`static`） |
| `verify-links.mjs` | 文档内部链接守卫：所有 `](相对路径)` 都要指向**存在的文件** | CI 自动跑（`static`） |
| `verify-longform.mjs` | 长片验证：长片长度的渲染还守得住哪几件事 | CI 自动跑（`browser-slow`） |
| `verify-mask.mjs` | 遮罩验收：四种形状 + 反选 + 不写遮罩逐字节不变 + 同一遮罩可复现 | CI 自动跑（`browser`） |
| `verify-mix.mjs` | 配乐混音的端到端验证：真跑混音，并**直接测音乐那一路**证明闪避生效 | CI 自动跑（`browser`） |
| `verify-package.mjs` | 发布物守卫：npm 包里不许混进**本机的东西**，也不许漏掉该发的源码 | CI 自动跑（`static`） |
| `verify-preview.mjs` | 预览页的端到端验证：真开浏览器，验证拖动、播放、热重载都真的生效 | CI 自动跑（`browser`）+ npm 脚本 |
| `verify-readme.mjs` | 照 README / 入门文档的路径走一遍，确认文档没写错 | CI 自动跑（`browser-doc`）+ npm 脚本 |
| `verify-reuse.mjs` | 验收「换分辨率」与「换浏览器」两条可复用性主张 | CI 自动跑（`browser`）+ npm 脚本 |
| `verify-reveal.mjs` | 逐字入场（`title.reveal`）验收 | CI 自动跑（`browser`） |
| `verify-three.mjs` | 3D 图层（现成的 three）：到底能不能用、对不对、代价多大 | CI 自动跑（`browser`） |

### npm 脚本、但不在 CI（2 个）

| 文件 | 干什么（取自它自己的头部注释） | 状态 |
|---|---|---|
| `run-python-tests.mjs` | 跑 python 侧的测试（TTS 引擎层在 python 里，`node --test` 覆盖不到） | npm 脚本（`test:py`，挂在 `npm test` 链上） |
| `verify-tts.mjs` | TTS 的正式验证工具（node 侧，与 python 侧的测试互补） | npm 脚本（`verify:tts`） |

这两个没进 CI 的原因是**外部条件**：`verify-tts` 要真合成（联网），另一个要 python。
`run-python-tests.mjs` 在没装 python / numpy 时**优雅跳过并返回 0**，所以它跟着 `npm test` 走不会让 CI 变红。

### 仅文档提及（15 个）

| 文件 | 干什么（取自它自己的头部注释） | 状态 |
|---|---|---|
| `ascii-region.py` | 把一块区域渲染成 ASCII 亮度图，用来「看」差异（无图形界面时也能比对） | 仅文档提及（`docs/qc.md`） |
| `audit-commit.py` | 提交前审计：机器专属路径泄漏 / 体积 / 该忽略的是否真被忽略 / 最近一次提交的消息编码 | 仅文档提及（`docs/qc.md`） |
| `boot-error.mjs` | 把页面 boot 的真实错误抓出来（`window.__bootError`） | 仅文档提及（`docs/faq.md`、`docs/qc.md`） |
| `check-modules.mjs` | 逐个 fetch 渲染页要用到的模块，看哪些 404 —— 模块加载失败时页面是静默的 | 仅文档提及（`docs/qc.md`） |
| `compare-original.py` | 迁移验收：迁移后渲染的帧 vs 原片 mp4 的同一帧，算 PSNR | 仅文档提及（`docs/qc.md`） |
| `compare-three-way.py` | 三方对比：原引擎渲染 / 迁移后渲染 / 原片 mp4 | 仅文档提及（`docs/qc.md`） |
| `compare-timelines.mjs` | 比对原片项目里的两份时间轴：`src/timeline.js`（原引擎读）与 `script/timeline.json`（迁移后读） | 仅文档提及（`docs/qc.md`） |
| `diff-channels.py` | 看差异的「颜色构成」：分区算 R/G/B 三通道的带符号平均差 | 仅文档提及（`docs/qc.md`） |
| `diff-hotspots.py` | 差异热点定位：把画面切成 16×9 块，按平均差排序，指出差异集中在哪 | 仅文档提及（`docs/qc.md`） |
| `diff-nature.py` | 判断差异的性质：抗锯齿 / 亚像素位移，还是真的内容不同 | 仅文档提及（`docs/qc.md`） |
| `diff-probe.py` | 在给定的小矩形上比差异，用来区分「平坦填充区」与「文字区」 | 仅文档提及（`docs/qc.md`） |
| `diff-regions.py` | 定位差异区域：把画面按功能区切开，算每块的平均绝对差 | 仅文档提及（`docs/qc.md`） |
| `dogfood-review.mjs` | 用 MCP 的 review 工具迭代 promo（狗粮：制作者就是工具链本身） | 仅文档提及（`docs/dogfood.md`、`CHANGELOG.md`） |
| `make-sample-asset.py` | 生成示例用的素材图：一条胶片（5 格） | 仅文档提及（`docs/qc.md`） |
| `verify-voiceover.mjs` | 真实配音的验证：示例的时间轴必须是**真配音**（不是合成夹具），且时间轴 / 音频 / 画面三者一致 | 仅文档提及（`CHANGELOG.md`、`docs/qc.md`） |

这一组里能看出两条清楚的线索：

- `diff-*` / `compare-*` / `ascii-region.py` / `make-sample-asset.py` / `audit-commit.py`
  是**迁移期与排查期**的一次性脚本：当年的对手是「原引擎的渲染与原片 mp4」。
  迁移结案后它们不再有常驻用途，但结论性文档还引用它们。
- `check-modules.mjs` 与 `boot-error.mjs` 是**一对页面诊断器**：模块加载失败时页面完全静默，
  一个查「谁 404」，一个取 `window.__bootError`。

### 零引用（3 个）

判定口径：全仓检索命中数极少，**且全部落在它自己的用法注释行内**。

| 文件 | 干什么（取自它自己的头部注释） | 状态 |
|---|---|---|
| `ci-annotations.mjs` | 读某次 CI run 的失败 annotation（需要网络） | 零引用 |
| `ci-artifact.mjs` | 下载某次 run 的 `ci-failure` artifact（未登录也能下载公开仓库的 artifact） | 零引用 |
| `compare-primitives.py` | 逐个比对原引擎与 filmwright 的绘制原语，找出行为差异 | 零引用 |

### 由其它工具调用（1 个）

| 文件 | 干什么（取自它自己的头部注释） | 状态 |
|---|---|---|
| `make-timeline-fixture.mjs` | 合成时间轴夹具：读 `script/narration.txt`，按与 tts 相同的解析规则产出 `timeline.json` | 由 `verify-longform.mjs` spawn，随 `browser-slow` 作业间接跑；同时也是三个示例入库夹具的来源 |

它是顶层里**唯一**被另一个工具直接调用的文件（`verify-longform.mjs` 里
`spawnSync('node', [join(ROOT,'tools','make-timeline-fixture.mjs'), …])`），
所以它的状态既不是「仅文档提及」也不是「零引用」—— 单独列一类，免得被误当成死文件删掉。

## 已知问题

以下都是只读审计的实测结论。**本文件只写结论与处置建议，没有改动任何工具**
（`tools/README.md` 是这次唯一新增的文件）。

### 1. 命名不一致（会让人找错工具）

- `verify-clips.mjs` 与 `verify-clip-render.mjs`：同一个能力拆成两个工具（前者 host 侧抽帧 / 缓存，
  后者浏览器侧真取到并画出），名字单复数还不一致。
- `dead-exports.mjs`、`quality-negative.mjs`、`regression.mjs`：都是常驻守门工具，
  却没有 `verify-` 前缀 —— 只看文件名分不出它们和一次性脚本的区别。
- `check-modules.mjs` 与 `boot-error.mjs`：同一类页面诊断器，一个 `check-` 一个 `boot-`。

**建议**：短期用本文件补齐说明即可；真要改名，得先知道代价 —— `verify-docs.mjs` 按
`/^verify-.*\.mjs$/` 数工具数、`verify-invocation.mjs` 按 `node tools/<名字>.mjs` 的正则扫 CI，
改名会连带改 CI、`package.json`、文档与这两处守卫自己的扫描代码。**改名要单独一轮，不要顺手做。**

### 2. 名字互为倒装的一对（最危险）

`probes/probe-2d-gpu.mjs` 与 `probes/probe-gpu-2d.mjs` —— 名字互为倒装，内容是**两个不同实验**：

- `probe-2d-gpu.mjs`：2D 走 GPU 的**配对比值**（A 档 vs C 档逐轮交替）。
- `probe-gpu-2d.mjs`：「用 3D 画 2D」拆成**光栅化 vs 合成**两段。

**建议**：改成能自解释的名字（例如「2D 是否该走 GPU」与「把 2D 画在 3D 里」各取一个不复用的词），
并同步改 `probes/README.md` 与 `docs/qc.md` 里的表 —— 它与第 1 条一样属于「改名要单独一轮」。

### 3. 零引用文件

顶层 3 个（见上表），另加 `probes/probe-three.mjs`（**在 `probes/` 下，不在本表内**），共 4 个。

**建议**：

- `ci-artifact.mjs` / `ci-annotations.mjs` 是「未登录时取回失败现场」的调试工具（CI 的失败现场
  走 step summary + artifact + annotation 三条通道）。若还要保留，就写进 `docs/qc.md` 的表；
  若不再用，直接删 —— 它们现在既没被调用，也没被说明。
- `compare-primitives.py` 是迁移期的一次性比对脚本，迁移结案后没有常驻用途。
- `probes/probe-three.mjs` 的结论已在 `probes/README.md` 里标为「结论已定」，
  但它没有被列进那张探针表（表里只有 10 个，探针实际有 16 个）。

⚠️ 顺带发现：未入库草稿 `docs/design/DESIGN-3d.md` 里引用的是 `tools/probes/probe-3d.mjs`，
**该文件不存在**（真名是 `probe-three.mjs`）。没有任何守卫抓到它，因为
`verify-links.mjs` 只扫**入库的** `.md`，而未入库的本地草稿不在它的扫描面里 ——
这正是「先删文件、后清引用」两段收口的典型残留。

### 4. `run-python-tests.mjs` 的扫描盲区（**本轮已修**）

它原来用 `readdirSync(TESTS).filter(/^tts-.*\.py$/)` 找 Python 测试，三重脆弱：

- **只扫 `tests/` 顶层、不递归**：放进子目录就永远不跑。
- **只认 `tts-` 前缀**：改名成 `test_*.py` 或换任何前缀 ⇒ **静默不跑**（不报错、不提示）。
- **没有「扫到 0 个即失败」的下限**：跳过只在「一个都没扫到」时打印原因，而那时退出码仍是 0；
  装了 python 却一个测试也没跑起来，与「全部通过」长得一模一样。

**处置**：改成**递归**收集、同时认 `tts-*.py` 与 `test_*.py`；并把判据顺序调过来 ——
**先探 python / numpy**，再判「环境齐备却扫到 0 个」⇒ 失败。没装 python 的机器仍然优雅跳过
（退出码 0，那是刻意的取舍：核心渲染链零依赖，不该因为没装 python 就让 `npm test` 变红）。

对照（在临时根里做，不碰真 `tests/`）：
空 `tests/` + python 可用 ⇒ **退出码 1**；`tests/sub/test_dummy.py` ⇒ **退出码 0 且报「1 个文件」**
（证明递归与 `test_` 前缀都生效）；`PATH` 里藏掉 python ⇒ **退出码 0**（跳过那条没被破坏）。

### 5. 顺带发现：CI 注释里的工具计数已经过期（**本轮已修**）

`.github/workflows/ci.yml` 的 `browser` 作业里曾有一条注释给出「验收工具总数 / 自动跑数」的旧计数，
比实测各少 2 —— 而它自己还写着「这个计数由 `verify-docs` 核」。**那句话是假的**：
`verify-docs.mjs` 只核**入库文档**里的数字（`README.md` 与 `docs/qc.md`，两处都已经是正确值），
**不核 CI 注释**，所以这条漂移不会让任何东西变红。

**处置**：那条注释已改成**不复述数字**，只指向 `docs/qc.md` 的那张表。
口径：**在不受守卫管的注释里抄一份数字，必然腐烂** —— 要么让守卫管到它，要么别写。
本文件同样只在能从 `tools/` 目录与 `ci.yml` 当场数出来的地方写数字。

## 探针

`probes/` 下的工具与顶层是两套分工：**只报数、不改判定**，约定（含每个探针回答什么问题、
哪些结论已定、以及探针自身的已知缺陷）写在 [probes/README.md](probes/README.md)。

换机器、换 GPU、换浏览器版本之前，先跑探针再决定要不要改架构 —— 这里的性能结论都是**机器相关**的。
