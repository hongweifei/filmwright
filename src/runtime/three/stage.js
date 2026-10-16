// 3D 图层（用现成的 three，不自己封一套 GL）。
//
// ## 为什么是"顶层 await + 同步 render"这个形状
//
// 渲染页的契约是 `draw(ctx, n)` —— **同步**。而 three 的模块加载与渲染器
// `init()` 都是异步的。所以：
//
//   1. `loadThree()` 与 `create3D()` 都是 async，在**镜头模块顶层 await** 一次；
//   2. 之后每帧的 `render(ctx, n)` 是同步的。
//
// 顶层 await 还有两个好处：
//   · **不用 3D 就完全不加载 three**（2.2MB）—— 只有真 import 才拉；
//   · 不需要引擎去猜"这个项目用不用 3D"，也就不需要额外的声明字段。
//
// ```js
// import {loadThree, create3D} from 'filmwright';
// const T = await loadThree();
// const cube = await create3D(T, (T, {scene, camera, n}) => {
//   // ⚠️ 每帧都**完整**写一遍动画属性（见下方"retained-mode 陷阱"）
//   if (!scene.userData.m) { ...建一次... }
//   scene.userData.m.rotation.y = n * 0.02;
// });
// export const SHOTS = [{start: 1, draw(ctx, n) { cube.render(ctx, n); }}];
// ```
//
// ## 两个必须守住的点
//
// **retained-mode 陷阱**：three 是"保留模式"的场景图 —— 场景一旦建好就一直在。
// 所以每帧必须把**所有会动的属性按 n 完整写一遍**。只写一次、或按"距上一帧过了多久"
// 去累加，都会让第 N 帧依赖历史，直接破坏"第 N 帧只是 N 的函数"这个核心不变量
// （分片渲染、跳帧、增量复用全都会崩）。这里的 API 刻意**每帧都调 build**，
// 就是为了让这件事变成默认动作、而不是靠人记得。
//
// **读 `renderer.domElement`**：拿像素一定要用渲染器自己的画布。探针里我踩过
// 一次"自己建了画布却没交给 renderer，于是 drawImage 读到一张空画布"，
// 现象是全黑 —— 很容易误判成"无头下渲不出来"。
//
// ## 已知限制（如实记下）
//
// `render()` 是**同步**提交。WebGL 后端下这是对的（实测正确出图）；
// 但 WebGPU 后端的渲染是异步的，同步 `render()` 之后立刻取像素可能拿到上一帧。
// 本机无头环境实测**实际用的就是 WebGL 后端**（即使 `navigator.gpu` 为 true），
// 所以这条路是可用的；真要跑 WebGPU 后端需要改成 await 形状的 API。

/** 载入 three。没装时给一条**可行动**的报错，而不是让页面崩在模块解析上。 */
export async function loadThree() {
  try {
    return await import('three/webgpu');
  } catch (e) {
    const err = new Error('filmwright: 加载 three 失败 —— 3D 图层需要它');
    err.code = 'NEEDS_THREE';
    err.hint = '装一下：npm i three（它是**可选**依赖，不装不影响其它功能）；' +
      '原因：' + String((e && e.message) || e).slice(0, 200);
    throw err;
  }
}

/**
 * 建一个 3D 图层。
 *
 * @param {object} T     `await loadThree()` 的结果
 * @param {(T: object, ctx: object) => void} build
 *        每帧调用一次；`ctx` 是 `{scene, camera, n, width, height, renderer}`。
 *        **必须把动画属性按 n 完整写一遍**（见文件头的 retained-mode 说明）。
 * @param {object} [opts] fov / near / far / antialias
 */
export async function create3D(T, build, opts = {}) {
  const canvas = document.createElement('canvas');
  const renderer = new T.WebGPURenderer({
    canvas,
    antialias: opts.antialias ?? true,
    alpha: true,                 // 透明背景 ⇒ 能叠在引擎已画的画面上
    preserveDrawingBuffer: true, // 取了保险；实测这条不是必须（见探针 2×2），但代价很小
  });
  await renderer.init();
  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(opts.fov ?? 50, 16 / 9, opts.near ?? 0.1, opts.far ?? 1000);
  camera.position.set(0, 0, opts.distance ?? 5);

  let sized = false;
  let w = 0;
  let h = 0;
  return {
    T, scene, camera, renderer,
    /** 同步渲染并把结果贴到 `ctx` 上。 */
    render(ctx, n) {
      if (!sized) {
        w = ctx.canvas.width;
        h = ctx.canvas.height;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        sized = true;
      }
      build(T, {scene, camera, n, width: w, height: h, renderer});
      renderer.render(scene, camera);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(renderer.domElement, 0, 0);
      ctx.restore();
    },
  };
}
