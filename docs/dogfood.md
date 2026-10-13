# 狗粮记录：做 filmwright 自己的介绍片

`examples/promo` 是 filmwright 自己的介绍片：**全程 `scene.json` 驱动、零镜头代码**，11 个镜头覆盖 9 类模板。做它的过程就是一次真实压力测试——用的工具链是自己的（`tts` → `schema` → MCP `review` → `check`），暴露的问题当场修掉并固化成测试。

这份记录的价值不在「我们做了一条片子」，而在**真做片子时模板缺什么**——凭空想需求不如做一遍。

## 制作回路

```
filmwright new            → 骨架（scene 模板）
写 narration.txt          → 10 句、4 章
make-timeline-fixture.mjs → 合成时间轴（edge-tts 端点不可达时；真实项目跑 tts）
filmwright schema         → 拿 13 类模板与容量上限
写 scene.json             → 11 个镜头，9 类模板
tools/dogfood-review.mjs  → 走 MCP filmwright_review：校验 + 静态自检 + 代表帧回图
filmwright check          → 九道全过（2141 帧）
```

`tools/dogfood-review.mjs` 把 MCP 的 `filmwright_review` 回图落盘，是这条回路的可复现版本。

## 暴露的问题（都已修 + 固化）

| # | 现象 | 根因 | 修法与守卫 |
|---|---|---|---|
| 1 | 片头帧整屏红字：`不存在的句 id S11` | `drawHud` 每帧都 `S(fromS)`，而 `timeline` 静态自检**只扫 `shots/`**，扫不到配置的 `hud` | 自检补查 `hud` 的 `fromS`/`toS`；hud 写错是「整片每一帧都错」，必须静态拦 |
| 2 | `quality` 判 SH07 失败：节拍排到镜头末之后 12 帧 | chips / bars / quote 的动画终点按固定时长算，元素多、句子短时越界 | 统一走 `beatEnd()` 夹进「镜头末 − 停留预留」；加**结构守卫测试**断言任何模板的节拍都落在镜头窗口内（已做负面对照：去掉夹取立刻变红） |
| 3 | review 回图里 compare 只有左栏 | 代表帧按区间 60% 取，而元素错峰进场，60% 处末拍还没落位（右栏 228 帧进场，60% 落在 227 帧） | 代表帧改为按**末拍落位后 8 帧**取——节拍表本来就在，用它取帧才是内容齐全的帧 |

三条都不是「模板类型不够」，而是**边界与信号没接好**。这本身是个结论：13 类模板覆盖这类介绍片够用，缺的是把已有的节拍信息用到每一处。

## 「模板不够用」清单（做这条片子时想要、但没有的）

按「想要的强度」排序，供后续决定做不做：

1. **段落级排版**（`text-block`）：一段 3–5 行的正文，带小标题。现在只能用 `bullets` 凑，或 `quote`（但它只适合一句）。
   *替代*：`bullets` 的 `d` 字段写长一点；或拆成多镜。
2. **对比数值**（`stat-compare`）：两个数字并排比较（改前 / 改后）。现在得用 `bars` 或两个 `stat` 镜头。
   *替代*：`compare` 的 items 里写数字。
3. **时间线**（`timeline`）：横向时间轴 + 若干节点。做「演进史」类内容会需要。
   *替代*：`steps` 横过来不行，只能 `flow` 凑。
4. **图标位**（`icon`）：小图标 + 一行字。现在没有图标体系（也不打算引字体图标）。
   *替代*：`chips`。

结论：**先不做**。1 和 2 有替代路径；3 只在特定题材需要；4 要引资源体系，与「零运行时依赖」冲突。等第二条真片子再遇到同样需求时再说——那时就是真需求，不是想象。

## 复查这条片子的方法

```bash
node bin/filmwright.mjs check --project examples/promo            # 九道自检
node tools/dogfood-review.mjs . examples/promo 8                  # MCP 回路 + 回图落盘
node bin/filmwright.mjs stills --project examples/promo --frames 67,254,437 --dir .work/promo
```
