// 声明式 3D 的运行期：把 `{"type":"three", …}` 规格变成一份可逐帧同步渲染的场景。
//
// ## 两个关键设计
//
// **1. 渲染器全局共享，场景按镜头各自一份。**
// 每个 3D 镜头都新建一个 WebGL 上下文是灾难（上下文数量有限、且每个都要占显存）。
// 所以渲染器只有一份（懒建、按帧尺寸 setSize），场景/相机按镜头各一份。
//
// **2. 几何与材质只建一次，动画属性每帧完整写一遍。**
// three 是保留模式的场景图：几何/材质建一次是对的（那是开销大头），
// 但**会动的属性必须每帧按 n 完整写一遍** —— 只写一次或按"距上一帧多久"累加，
// 都会让第 N 帧依赖历史，破坏"第 N 帧只是 N 的函数"（分片/跳帧/增量复用全崩）。
// 这里的写法是：编译期把轨道归一成"帧号 → 值"的纯函数，求值期只做算术。
import {getRenderer, getThree} from './stage.js';
import {kf} from '../motion/ease.js';
import {compileAnimate} from '../scene/animate.js';
import {theme} from '../../contract/config.js';

// 渲染器由 stage.js 全局共享（boot 时建好并 init）—— 这里只记录"上一次用的尺寸"，
// 尺寸变了才 setSize。一个进程只该有一个 WebGL 上下文。
let RENDER_W = 0;
let RENDER_H = 0;

/** 每个镜头一份的场景（WeakMap：镜头对象回收时自动释放）。 */
const CACHE = new WeakMap();

function resolveColor(c, theme) {
  if (typeof c === 'string' && c.startsWith('#')) return c;
  if (typeof c === 'string' && theme && theme[c]) return theme[c];
  return (theme && theme.text) || '#e8eefc';
}

function geometryFor(T, shape, size) {
  switch (shape) {
    case 'sphere': return new T.SphereGeometry(size * 0.5, 24, 16);
    case 'torus': return new T.TorusGeometry(size * 0.5, size * 0.18, 16, 32);
    case 'plane': return new T.PlaneGeometry(size, size);
    case 'icosahedron': return new T.IcosahedronGeometry(size * 0.5, 0);
    default: return new T.BoxGeometry(size, size, size);
  }
}

const RAD = Math.PI / 180;

/**
 * 编译一个 3D 镜头（几何/材质/轨道都在这里建好，只做一次）。
 *
 * 轨道用 `compileAnimate` —— 与 `animate` 是**同一套**编译（beat 锚点解析、
 * 缓动名 → 函数），所以规则不复制第二份。
 */
function compile(shot, theme) {
  const T = getThree();
  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(50, 16 / 9, 0.1, 1000);
  const cam = shot.camera ?? {};
  camera.position.set(cam.x ?? 0, cam.y ?? 0, cam.z ?? 4.2);
  if (typeof cam.fov === 'number') camera.fov = cam.fov;
  camera.lookAt(...(cam.lookAt ?? [0, 0, 0]));
  camera.updateProjectionMatrix();

  const node = {beats: shot.beats ?? [], from: this.from};
  const objects = (shot.objects ?? []).map((o) => {
    const size = o.size ?? 1;
    const mat = new T.MeshBasicMaterial({
      color: resolveColor(o.color, theme),
      wireframe: !!o.wireframe,
      transparent: o.opacity !== undefined && o.opacity < 1,
      opacity: o.opacity ?? 1,
    });
    const mesh = new T.Mesh(geometryFor(T, o.shape, size), mat);
    scene.add(mesh);
    const tracks = o.animate ? compileAnimate(o.animate, node) : null;
    // 静态值：没写就用中性值（位置 0、旋转 0、缩放 1）
    const st = {
      x: o.position?.x ?? 0, y: o.position?.y ?? 0, z: o.position?.z ?? 0,
      rx: o.rotate?.x ?? 0, ry: o.rotate?.y ?? 0, rz: o.rotate?.z ?? 0,
      scale: 1,
    };
    return {mesh, tracks, st};
  });
  return {scene, camera, objects};
}

/** 渲染一帧（同步），结果贴到 `ctx` 上。 */
function render(ctx, n, shot, theme) {
  let st = CACHE.get(shot);
  if (!st) {
    st = compile.call(this, shot, theme);
    CACHE.set(shot, st);
  }
  // ⚠️ 渲染器在 `ensureThree()`（boot、async）里就建好并 init 完了 —— 这里只同步取。
  // 曾经在这里 `new WebGPURenderer()` 后直接 render()：init 没完成就 render 会抛错，
  // 而且**是否抛错取决于竞态**，表现为"同一帧两次渲染不同"的间歇故障。
  const renderer = getRenderer();
  // 尺寸跟随帧画布（换分辨率时自动跟上）
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  if (w !== RENDER_W || h !== RENDER_H) {
    RENDER_W = w; RENDER_H = h;
    renderer.setSize(w, h, false);
    st.camera.aspect = w / h;
    st.camera.updateProjectionMatrix();
  }
  // ⚠️ 每帧**完整**写一遍会动的属性（不累加、不读时钟）
  for (const o of st.objects) {
    const v = (k) => (o.tracks && o.tracks[k] ? kf(n, o.tracks[k]) : o.st[k]);
    o.mesh.position.set(v('x'), v('y'), v('z'));
    o.mesh.rotation.set(v('rx') * RAD, v('ry') * RAD, v('rz') * RAD);
    const s = v('scale');
    o.mesh.scale.set(s, s, s);
  }
  renderer.render(st.scene, st.camera);
  // 读 renderer 自己的画布（踩过：读别的画布会拿到一张从没画过的空图）
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(renderer.domElement, 0, 0);
  ctx.restore();
}

/** 模板实现：契约与其它模板一致（draw(ctx, n, shot, accent)，this 绑定镜头区间）。 */
export const threeT = {
  draw(ctx, n, shot) {
    render.call(this, ctx, n, shot, theme);
  },
};

/** 测试用：清掉尺寸记录（渲染器归 stage.js 管，这里只管自己这份）。 */
export function reset3D() {
  RENDER_W = 0;
  RENDER_H = 0;
}
