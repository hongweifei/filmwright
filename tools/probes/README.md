# 测量探针（probes）

这些是**决策用的测量工具**，不是验收工具（验收工具在 `tools/` 根下，`verify-*.mjs`）。

## 为什么留着它们

本仓库的性能与架构结论**全部是测出来的，而且都是机器相关的**
（本机：16 核 / Intel Iris Xe / 32GB）。换个 GPU、换个核数，数字会变，有些结论可能反转。
所以每个结论都配了能重跑的探针 —— **换机器时先跑探针，再决定要不要改架构**。

另外：这些探针在制定过程中**抓到过四次我自己的错误推断**（见 `docs/design/DESIGN-3d.md`），
所以它们的价值不只是"复现数字"，也是"防止再凭推理下结论"。

## 怎么用

```bash
node tools/probes/<名字>.mjs <仓库根>    # 多数探针的第一个参数是仓库根
```

探针会**自己开浏览器会话**，不依赖正在运行的 filmwright 服务。
部分探针需要可选依赖（见下），缺了会**优雅跳过**而不是报错。

## 可用探针

| 探针 | 回答什么问题 | 状态 |
|---|---|---|
| `probe-render.mjs` | 三档（全软件 / 2D软件+GPU / 全硬件）的 **2D 像素哈希、WebGL/WebGPU 可用性、编码支持、成本分解、CDP+POST 往返、三种像素出口** | **活的** —— 每次动 GPU 档位都该重跑 |
| `probe-gpu-pixels.mjs` | 放开 GPU 的**像素差幅度**、**同机确定性**、**并发一致性** | **活的** —— 决定 GPU 下分片是否安全、3D 能否纳入回归 |
| `probe-effects.mjs` | `ctx.filter` vs **GPU shader** 的实际成本；上传/读回开销 | **活的** —— 将来做效果链的基线 |
| `probe-export-paired.mjs` | **同会话交替**对比三种像素出口（JPEG blob / WebCodecs 软 / WebCodecs 硬），含上传 | **活的** —— 实现 WebCodecs 时用它验收 |
| `profile-frame.mjs` | 单帧时间拆成**绘制 / 编码 / 传输 / 落地**四段，并比 PNG/JPEG/WebP | 结论已定（绘制只占 0.6ms） |
| `bench-render.mjs` | 渲染性能**逐项归因**（PNG/JPEG/流式/分片叠加） | 结论已定（5.25×） |
| `probe-2d-gpu.mjs` | 2D 走 GPU 的**配对比值**（A 档 vs C 档，逐轮交替） | 结论已定（无收益，略慢 8%） |
| `probe-encode.mjs` | 硬件编码的**启动成本 vs 稳态**（编码器复用） | 结论已定（启动是假象主因） |
| `probe-gpu-2d.mjs` | 「用 3D 画 2D」拆成**光栅化 vs 合成**两段 | 结论已定；**其 proxy 有缺陷**（见下） |
| `probe-native-canvas.mjs` | 本地 `@napi-rs/canvas` vs 浏览器 Canvas 2D，**同一份绘制代码** | 结论已定（本地慢 21%） |

## 已知的探针缺陷（写下来免得被误导）

**探针本身会引入假象。** 制定过程中踩到过两次，都已修正，但记在这里：

1. **`probe-encode.mjs` 的第一版**：只测 20 帧、每次新建编码器 ⇒
   硬件编码的初始化成本被反复付，得出"硬件比软件慢一倍"的**错误结论**。
   修正方式：**编码器复用 + 多批次**，把启动与稳态分开。
2. **`probe-native-canvas.mjs` 的第一版**：`GlobalFonts.register(path)` 失败（它要 Buffer），
   本地静默用了系统字体，而浏览器用项目字体 ⇒ 得出"本地快 12%"，
   **字体一统一就反转成慢 21%**。

3. **`probe-gpu-2d.mjs` 的 proxy 不公平**（未修正，仅记录）：它拿"贴整张 1024×48 纹理"
   当"文字已缓存"的等价物，而 `fillText` 只写有笔画的像素 ⇒ 高估了缓存路径的成本。
   其中的「GPU 合成比 CPU 合成快」这个结论仍有效。

**共同教训**：对比实验必须先确认**两边跑的是同一个东西**；
任何"中性设置"都可能系统性偏向某一方。

## 可选依赖

| 依赖 | 谁需要 | 装法 |
|---|---|---|
| `three` | `probe-*` 里凡涉及 WebGPU/TSL 的（目前无） | `npm install --no-save three` |
| `@napi-rs/canvas` | `probe-native-canvas.mjs` | `npm install --no-save @napi-rs/canvas` |

⚠️ **`--no-save` 装的东西会被后续 `npm install` 当 extraneous 清掉**（实测踩过）。
要长期用就装成 devDependency，或者每次跑前重装。
**探针在依赖缺失时会优雅跳过**，不会让其他工具变红。
