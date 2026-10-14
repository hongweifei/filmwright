// 探针：three 能不能在**无头渲染页**里不用打包器加载并真的渲染出来？
//
// 这是动 3D 之前必须回答的三件事（不猜）：
//   1. 页面里 `import('three/webgpu')` 能不能成功（importmap 指向 /vendor/three/…）；
//   2. 无头下哪个后端真的可用：WebGPU 原生？WebGLBackend？
//   3. 同一帧号两次渲染是否一致、不同帧号是否不同（"第 N 帧只是 N 的函数"的前提）。
//
// ## 已经踩过的坑与**被实验纠正过的误判**（都记在这里，免得重犯）
//
//   · 探针第一版直接 `serveProject(dir)` **漏了 mounts**，页面拿不到项目数据、
//     boot 一直等，表现为"130s 内没就绪" —— 是探针的错，不是引擎的错。
//     用 `withSession` 就不会漏。
//   · 第一版拿到**全黑**，我当时判断是"跨任务导致绘制缓冲被清空，要
//     preserveDrawingBuffer" —— **那个判断是错的**。真因是：我建了一个画布 `cv`
//     却没把它交给 renderer（renderer 自建了自己的画布），于是 `drawImage(cv)`
//     读的是一张**从没画过**的空画布。
//     下面的 2×2 受控实验（自建/传入画布 × 保留/不保留缓冲）四种组合输出**完全相同**，
//     证明 `preserveDrawingBuffer` 不是约束。**唯一的约束是：读 `renderer.domElement`。**
//     教训：拿到全黑先怀疑"读错了对象"，再怀疑生命周期。
//
// 用法：node tools/probes/probe-three.mjs [<仓库根>] [--gpu]
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {withSession} from '../../src/host/media/renderRange.mjs';
import {loadProject} from '../../src/host/project/load.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const ROOT = (argv[0] && !argv[0].startsWith('--') ? argv[0] : resolve(HERE, '..', '..')).replace(/\\/g, '/');
const USE_GPU = argv.includes('--gpu');
const PROJECT = join(ROOT, 'examples', 'minimal');
const line = (c = '─') => console.log(c.repeat(78));

console.log(`three 可行性探针（${USE_GPU ? '--gpu' : '默认档'}）\n`);
line('═');

const proj = await loadProject(PROJECT);
await withSession(PROJECT, proj, {gpu: USE_GPU}, async (sess, url) => {
  console.log(`渲染页：${url}`);

  // ── 1. 模块能不能加载 ────────────────────────────────────────────────
  const load = await sess.evaluate(`(async () => {
    try {
      const t0 = performance.now();
      const THREE = await import('three/webgpu');
      return {ok: true, ms: performance.now() - t0, keys: Object.keys(THREE).length,
              hasRenderer: typeof THREE.WebGPURenderer === 'function',
              gpu: !!navigator.gpu,
              ua: navigator.userAgent.replace(/.*\\(/, '').replace(/\\)$/, '')};
    } catch (e) { return {ok: false, err: String(e && e.message || e)}; }
  })()`);
  if (!load.ok) { console.log('✗ three 加载失败：' + load.err); return; }
  console.log(`✓ three/webgpu 加载成功（${load.ms.toFixed(0)} ms，${load.keys} 个导出，navigator.gpu=${load.gpu}）`);
  console.log(`  浏览器：${load.ua}`);

  // ── 2. 哪个后端真能渲染出像素 ────────────────────────────────────────
  const render = await sess.evaluate(`(async () => {
    const THREE = await import('three/webgpu');
    const out = [];
    // 2×2 受控实验：「自己建的画布 vs 传进去的画布」×「保留缓冲 vs 不保留」。
    //
    // 为什么要做这个：探针第一版拿到的是**全黑**，我当时判断是
    // preserveDrawingBuffer 的问题 —— **那个判断是错的**。
    // 真因是我建了一个 \`cv\` 却没把它交给 renderer（renderer 自建了自己的画布），
    // 于是 \`drawImage(cv)\` 读的是一张**从没画过**的空画布。
    // 所以这里把两个因素分开测，确定哪个才是真的约束。
    const variants = [
      ['自建画布 + 保留缓冲', {preserveDrawingBuffer: true}, false],
      ['自建画布 + 不保留', {}, false],
      ['传入画布 + 保留缓冲', {preserveDrawingBuffer: true}, true],
      ['传入画布 + 不保留', {}, true],
    ];
    for (const [name, opts, passCanvas] of variants) {
      const cv = document.createElement('canvas');
      cv.width = 320; cv.height = 180;
      try {
        const r = new THREE.WebGPURenderer({...opts, antialias: false, forceWebGL: true,
          ...(passCanvas ? {canvas: cv} : {})});
        await r.init();
        r.setSize(320, 180, false);
        const target = r.domElement;          // **永远用 renderer 自己的画布**，别用外面那个
        const scene = new THREE.Scene();
        const cam = new THREE.PerspectiveCamera(50, 320 / 180, 0.1, 100);
        cam.position.set(0, 0, 3);
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1),
          new THREE.MeshBasicMaterial({color: 0x4f9dff}));
        mesh.rotation.set(0.6, 0.8, 0);
        scene.add(mesh);
        r.setClearColor(0x101820, 1);
        await r.renderAsync(scene, cam);
        const c2 = document.createElement('canvas');
        c2.width = 320; c2.height = 180;
        c2.getContext('2d').drawImage(target, 0, 0);
        const px = c2.getContext('2d').getImageData(0, 0, 320, 180).data;
        let sum = 0;
        for (let i = 0; i < px.length; i += 4) sum += px[i] + px[i+1] + px[i+2];
        const ci = (90 * 320 + 160) * 4;
        const b = r.backend || {};
        out.push({name, ok: true, mean: sum / (px.length / 4 * 3),
          sample: [px[ci], px[ci+1], px[ci+2], px[ci+3]],
          sameCanvas: target === cv,
          backend: b.isWebGPUBackend ? 'WebGPU' : (b.isWebGLBackend ? 'WebGL' : (b.constructor?.name ?? '?'))});
      } catch (e) {
        out.push({name, ok: false, err: String(e && e.message || e).slice(0, 200)});
      }
    }
    return out;
  })()`);
  console.log('  2×2 实验（都读 renderer.domElement）：');
  for (const r of render) {
    if (r.ok) console.log(`    ${r.name.padEnd(20)} 平均通道 ${r.mean.toFixed(1).padStart(6)}` +
      `  中心 rgba(${r.sample.join(',')})  传入的画布被采用=${r.sameCanvas}`);
    else console.log(`    ${r.name.padEnd(20)} ✗ ${r.err}`);
  }

  // ── 3. 确定性：同一帧号两次一致、不同帧号不同 ────────────────────────
  const det2 = await sess.evaluate(`(async () => {
    const THREE = await import('three/webgpu');
    const cv = document.createElement('canvas');
    cv.width = 320; cv.height = 180;
    const r = new THREE.WebGPURenderer({antialias: false, forceWebGL: true,
      preserveDrawingBuffer: true, canvas: cv});
    await r.init(); r.setSize(320, 180, false);
    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 100);
    cam.position.set(0, 0, 3);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({color: 0x4f9dff}));
    scene.add(mesh);
    r.setClearColor(0x101820, 1);
    const c2 = document.createElement('canvas'); c2.width = 320; c2.height = 180;
    const cx = c2.getContext('2d');
    const grab = async (n) => {
      // 关键：动画完全写成 n 的函数（**不读时钟**）
      mesh.rotation.set(0.6, n * 0.05, 0);
      await r.renderAsync(scene, cam);
      cx.drawImage(cv, 0, 0);
      const d = cx.getImageData(0, 0, 320, 180).data;
      let h = 0;
      for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i] + d[i+1] * 3 + d[i+2] * 7) | 0;
      return h;
    };
    const a1 = await grab(10), b = await grab(20), a2 = await grab(10);
    return {same: a1 === a2, differs: a1 !== b, h10: a1, h20: b};
  })()`);
  console.log(`\n  同一帧号两次渲染 ${det2.same ? '✓ 一致' : '✗ 不一致'}   不同帧号 ${det2.differs ? '✓ 画面不同' : '✗ 画面相同'}`);
  console.log(`  （h(10)=${det2.h10} h(20)=${det2.h20}）`);
  console.log(det2.same && det2.differs
    ? '\n⇒ 3D 可行：加载通、能渲染出像素、且是帧号的纯函数'
    : '\n⇒ 有问题，需要先查清楚');
});
line('═');
