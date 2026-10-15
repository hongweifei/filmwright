# 3D 图层（现成的 three，**可选**依赖）

> 从[场景规格](scene.md)里拆出来的一节（在原文件里占 129 行）。
> 声明式与命令式两种写法都在这里，规格的其余部分见[场景规格](scene.md)。

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

- **示例片有意不用 3D**（`examples/*` 里 `three` 用法为 0）—— 这是个**判断**不是遗漏：
  · **成本**：带 3D 的帧实测比不带贵 **+18～26 ms/帧（1.28～1.36×）**，
    而示例片同时是 CI 的渲染夹具，慢下来每次 CI 都要付；
  · **定位**：示例片的职责是演示**声明式模板工作流**；3D 有自己的文档
    （本节）、自己的验收工具（`verify-three`）与自己的错误码，不缺展示；
  · 「依赖」**不是**理由 —— 示例不随包发布（`files` 不含 `examples`），
    克隆后 `npm i` 会装上 three。
  **更好的做法是单开一个 `examples/three/`**：主示例保持快、轻，
  3D 有一个真能跑的最小演示。那需要新建 config + scene + 时间轴夹具，是独立的一步。
- **WebGPU 后端**：本机无头环境实测**实际用的是 WebGL 后端**（即使 `navigator.gpu`
  为 `true`）。`render()` 是同步提交，WebGL 下正确；WebGPU 的渲染是异步的，
  要真跑 WebGPU 需要改成 await 形状的 API。
- **3D 的后处理**：判断是**不做** —— 泛光/暗角/调色在**帧级效果链**里已经有了
  （`glow` / `vignette` / `color` / `grade`），在 3D 层里再叠一套会重复，
  也会让确定性更难守。

