# 3D 图层（现成的 three，**可选**依赖）

3D 用现成的 [three](https://threejs.org/)，不自己封一套 GL。**只有一条路**：
在 `shots/index.js` 里 `await loadThree()`，用 `create3D()` 建一个场景，每帧同步渲染。

## 命令式：`shots/index.js` 里自由发挥

因为**渲染页的 `draw` 是同步的**，而 three 的加载与渲染器初始化是异步的，所以形状是
「**模块顶层 await 一次，之后每帧同步渲**」：

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

三个 API：

| 导出 | 说明 |
|---|---|
| `await loadThree()` | 动态加载 three（`import('three/webgpu')`），返回 three 命名空间。**只有真调它才拉那 2.2MB**；没装 three 会给出「`npm i three`」这条可行动的错 |
| `await create3D(T, build, opts)` | 建一个 3D 图层实例（自己的渲染器 + 场景 + 相机）。`opts`：`fov` / `near` / `far` / `antialias` |
| `build(T, {scene, camera, n, width, height, renderer})` | **每帧调一次**。动画属性在这里按 `n` 完整写一遍 |

实例上的 `render(ctx, n)` 是**同步**的：调 `build` → 渲染 → 把结果贴到 `ctx` 上（透明背景，
所以能叠在引擎已画的画面上）。第一次调用时按 `ctx.canvas` 的实际尺寸定渲染器大小。

顶层 await 带来两个性质，都是有意要的：

- **不用 3D 就完全不加载 three**（2.2MB）—— 只有真去 import 才拉，引擎不需要猜也
  不需要额外的声明字段；
- 3D 图层可以和 `effects` / `transform` / `animate` 一起挂（它们作用在**画完之后**的帧上）。

## ⚠️ retained-mode 陷阱：每帧都要完整写一遍

three 是**保留模式**的场景图 —— 场景一旦建好就一直在。所以：

- 只写一次、或按「距上一帧过了多久」**累加**，都会让第 N 帧依赖历史；
- 那会直接破坏「第 N 帧只是 N 的函数」，**分片渲染、跳帧、增量复用全都会崩**。

`create3D` 刻意**每帧都调 `build`**，就是让「完整写一遍」成为默认动作、而不是靠人记得。

实测这条判据**有区分力**（`tools/verify-three.mjs` 里有负面对照）：故意写成累加的那版，
**同顺序连渲两遍仍然逐字节一致** —— 所以「跑两遍比一比」**不足以**证明纯函数性，
必须**乱序渲染同一帧**才抓得住。

## 两个必须守住的点

- **每帧的 `build` 里要把所有会动的属性写全**（见上）。静态的部分（几何、材质）建一次就好，
  `scene.userData` 是常用的存放处。
- **取像素一定用渲染器自己的画布**（`renderer.domElement`）。曾经踩过一次「自己建了画布
  却没交给 renderer，于是 `drawImage` 读到一张空画布」—— 现象是全黑，很容易误判成
  「无头下渲不出来」。

## 性能（实测，同一次运行内配对）

| 档位 | 不带 3D | 带 3D | 代价 |
|---|---|---|---|
| 默认（软件 WebGL） | 70.3 ms/帧 | 95.9 ms/帧 | **+25.6 ms（1.36×）** |

首次加载 three 约 50 ms，摊到长片可忽略。

## 还没做的

- **唯一示例不用 3D**（`examples/minimal` 里 three 用法为 0）—— 这是个**判断**不是遗漏：
  · **成本**：带 3D 的帧实测比不带贵 **+18～26 ms/帧（1.28～1.36×）**，
    而示例同时是 CI 的渲染夹具，慢下来每次 CI 都要付；
  · **定位**：3D 有自己的文档（本节）与自己的验收工具（`verify-three`），不缺展示；
  · 「依赖」**不是**理由 —— 示例不随包发布，克隆后 `npm i` 会装上 three。
- **WebGPU 后端**：本机无头环境实测**实际用的是 WebGL 后端**（即使 `navigator.gpu`
  为 `true`）。`render()` 是同步提交，WebGL 下正确；WebGPU 的渲染是异步的，
  要真跑 WebGPU 需要改成 await 形状的 API。
- **3D 的后处理**：判断是**不做** —— 泛光/暗角/调色在**帧级效果链**里已经有了
  （`glow` / `vignette` / `color` / `grade`），在 3D 层里再叠一套会重复，
  也会让确定性更难守。
