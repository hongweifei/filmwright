// 验收：3D 图层（现成的 three）—— 到底能不能用、对不对、代价多大。
//
//   node tools/verify-three.mjs [<仓库根>] [--gpu]
//
// ## 判据为什么这样设计
//
// 3D 和 2D 的不变量是同一条：**第 N 帧只是 N 的函数**。所以最要紧的判据不是
// "看起来有 3D"，而是：
//   · 同一帧号渲染两次 **逐字节一致**（这是分片、跳帧、增量复用的前提）
//   · 不同帧号**画面确实不同**（否则"渲出来了"可能只是一张静态图）
//   · 3D 内容**确实叠进了帧里**（与不带 3D 的同帧对比，画面有变化）
//
// 再加一条负面对照：**故意写成有状态的**（按"距上一帧多久"累加）必须被抓出来 ——
// 否则前面那条一致性判据可能只是碰巧成立。
//
// 夹具全部是**手写镜头**：`shots/index.js` 顶层 `const T = await loadThree()` +
// `create3D(T, build)`，灯与动画都在 build 里按 n 完整写一遍。声明式那层（`{"type":"three"}`、
// 按 scene 自动切受光材质、`needsThree` 门控）已随之删除 —— 顺带也就没有
// "不用 3D 的项目不该加载 three" 这条判据了：现在**不 import 就不加载**，由语言本身保证。
import {spawnSync} from 'node:child_process';
import {cpSync, readdirSync, rmSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const ROOT = resolve(argv[0] && !argv[0].startsWith('--') ? argv[0] : resolve(HERE, '..')).replace(/\\/g, '/');
const USE_GPU = argv.includes('--gpu');
const KIT = join(ROOT, 'bin', 'filmwright.mjs');
const SRC = join(ROOT, 'examples', 'minimal');
const P = join(ROOT, '.work', 'three-e2e');
// 帧尺寸（渲染页按项目配置出图；下面用到尺寸时会顺带校验一次）
const W = 1280, H = 720;

let bad = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) bad++; };
const line = (c = '─') => console.log(c.repeat(76));

rmSync(P, {recursive: true, force: true});
cpSync(SRC, P, {
  recursive: true,
  filter: (s) => {
    const rel = relative(SRC, s).replace(/\\/g, '/');
    if (!rel) return true;
    // 配音缓存 / 历史产物 / 10MB 成品配音：3D 验收用不上
    if (['audio', 'renders', '.work'].includes(rel.split('/')[0])) return false;
    return rel !== 'public/assets/minimal';
  },
});
mkdirSync(join(P, 'shots'), {recursive: true});

/** 数学上同一帧号两次渲染必须一致 —— 关键是**不读时钟**。 */
const STATELESS = `
import {loadThree, create3D} from 'filmwright';
const T = await loadThree();
const cube = await create3D(T, (T, {scene, camera, n}) => {
  if (!scene.userData.mesh) {
    const m = new T.Mesh(new T.BoxGeometry(1.6, 1.6, 1.6),
      new T.MeshBasicMaterial({color: 0x4f9dff, wireframe: false}));
    scene.add(m);
    scene.userData.mesh = m;
    camera.position.set(0, 0, 4.2);
  }
  // 每帧**完整**按 n 写一遍（不累加、不读时钟）
  const m = scene.userData.mesh;
  m.rotation.set(0.4 + n * 0.01, n * 0.03, 0);
  m.position.set(Math.sin(n * 0.02) * 0.6, 0, 0);
});
export const SHOTS = [
  {start: 1, draw(ctx, n) { cube.render(ctx, n); }},
];
`;

/** 负面对照：按"距上一帧多久"累加 —— 有状态，必须被抓出来。 */
const STATEFUL = `
import {loadThree, create3D} from 'filmwright';
const T = await loadThree();
let last = null;
const cube = await create3D(T, (T, {scene, camera, n}) => {
  if (!scene.userData.mesh) {
    const m = new T.Mesh(new T.BoxGeometry(1.6, 1.6, 1.6),
      new T.MeshBasicMaterial({color: 0x4f9dff}));
    scene.add(m); scene.userData.mesh = m;
    camera.position.set(0, 0, 4.2);
  }
  // ⚠️ 故意写成有状态的：角度取决于"距上一帧多久/隔了几帧"
  const dt = last === null ? 1 : (n - last);
  last = n;
  scene.userData.mesh.rotation.y += 0.08 * dt;
});
export const SHOTS = [
  {start: 1, draw(ctx, n) { cube.render(ctx, n); }},
];
`;

/**
 * 受光球夹具：环境光 / 平行光 / 点光各一盏，**每帧按 n 完整写一遍**。
 * `perFrame` 是嵌进 build 里的那几行（决定这一格用哪盏灯、强度多少）。
 * ⚠️ 球必须够大，把中央 160×160 的取样框整个盖住 —— 否则量到的是引擎背景。
 */
function sphereShots(perFrame) {
  return `import {loadThree, create3D} from 'filmwright';
const T = await loadThree();
const sphere = await create3D(T, (T, {scene, camera, n}) => {
  if (!scene.userData.mesh) {
    const m = new T.Mesh(new T.SphereGeometry(1.1, 24, 16),
      new T.MeshStandardMaterial({color: 0x4f9dff, roughness: 0.55, metalness: 0.15}));
    scene.add(m);
    scene.userData.mesh = m;
    camera.position.set(0, 0, 4.2);
    const amb = new T.AmbientLight(0xffffff, 1);
    const dir = new T.DirectionalLight(0xffffff, 1);
    const point = new T.PointLight(0xffffff, 1);
    point.position.set(2, 2, 3);
    scene.add(amb); scene.add(dir); scene.add(point);
    scene.userData.lights = {amb, dir, point};
  }
  const L = scene.userData.lights;
  ${perFrame}
});
export const SHOTS = [
  {start: 1, draw(ctx, n) { sphere.render(ctx, n); }},
];
`;
}

function writeShots(src) {
  writeFileSync(join(P, 'shots', 'index.js'), src, 'utf8');
}

function stills(frames, tag) {
  const dir = join(P, '.work', tag);
  rmSync(dir, {recursive: true, force: true});
  const r = spawnSync('node', [KIT, 'stills', '--project', P, '--frames', frames.join(','),
    '--dir', dir, '--json', ...(USE_GPU ? ['--gpu'] : [])],
    {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* 非 json */ }
  const out = {};
  try {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.png')).sort()) {
      const b = readFileSync(join(dir, f));
      out[f] = {hash: createHash('sha256').update(b).digest('hex').slice(0, 12), bytes: b.length};
    }
  } catch { /* 没产出 */ }
  return {code: r.status, json, out, raw: String(r.stdout) + String(r.stderr)};
}

/** 画面中央一块区域内的亮度标准差：受光有明暗 ⇒ 标准差大；只有环境光 ⇒ 接近 0。 */
const centerStd = (gray, w = W, h = H, box = 160) => {
  const x0 = Math.floor(w / 2 - box / 2), y0 = Math.floor(h / 2 - box / 2);
  const vals = [];
  for (let y = y0; y < y0 + box; y++) for (let x = x0; x < x0 + box; x++) vals.push(gray[y * w + x]);
  const m = vals.reduce((a, b) => a + b, 0) / vals.length;
  return Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length);
};

const {execFileSync} = await import('node:child_process');
const toGray = (p) => execFileSync('ffmpeg', ['-v', 'error', '-i', p, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
  {maxBuffer: 64 * 1024 * 1024});
const meanOf = (buf) => { let s = 0; for (const v of buf) s += v; return s / buf.length; };
/** 只取中央区域（整帧里有引擎画的时间性 HUD/字幕，比整个中央才是公平的）。 */
const centerBox = (gray, w = W, h = H, box = 200) => {
  const x0 = Math.floor(w / 2 - box / 2), y0 = Math.floor(h / 2 - box / 2);
  const out = Buffer.alloc(box * box);
  for (let y = 0; y < box; y++) gray.copy(out, y * box, (y0 + y) * w + x0, (y0 + y) * w + x0 + box);
  return out;
};
const centerHash = (p) => createHash('sha256').update(centerBox(toGray(p))).digest('hex').slice(0, 12);

console.log(`3D 图层验收（${USE_GPU ? '--gpu' : '默认档'}）\n`);
line('═');
console.log('一、3D 真的渲进帧里了吗（与不带 3D 的同帧对比）');
line();
writeFileSync(join(P, 'shots', 'index.js'),
  'export const SHOTS = [{start: 1, draw(){}}];\n', 'utf8');
const flat = stills([40], 'flat');
ok(flat.code === 0 && Object.keys(flat.out).length === 1, '不带 3D 的基线帧能渲染');
writeShots(STATELESS);
const with3d = stills([40], '3d');
ok(with3d.code === 0, '带 3D 的镜头能渲染（' + (with3d.code === 0 ? '没报错' : String(with3d.raw).slice(-300)) + '）');
const f0 = Object.values(flat.out)[0]?.hash;
const f1 = Object.values(with3d.out)[0]?.hash;
ok(f0 && f1 && f0 !== f1, `3D 内容**确实叠进了帧里**（${f0} → ${f1}）`);

line('═');
console.log('二、核心不变量：第 N 帧只是 N 的函数');
line();
// 同一区间渲两遍：逐字节一致
const runA = stills([30, 60], 'detA');
const runB = stills([30, 60], 'detB');
const ha = Object.values(runA.out).map((x) => x.hash).join(',');
const hb = Object.values(runB.out).map((x) => x.hash).join(',');
console.log(`  第一遍：${ha}`);
console.log(`  第二遍：${hb}`);
ok(ha === hb && ha.length > 0, '两次渲染**逐字节一致**（分片/跳帧/增量复用的前提）');

// 单独渲一帧 vs 连着渲多帧里的同一帧：必须一致（"跳帧"能力）
const alone = stills([60], 'alone');
const hAlone = Object.values(alone.out)[0]?.hash;
const hInSeq = Object.values(runA.out)[1]?.hash;
ok(hAlone === hInSeq, `跳帧渲染与连渲的同一帧一致（${hAlone}）—— 没有"必须从第 1 帧开始"的隐藏依赖`);

line('═');
console.log('三、负面对照：故意写成有状态的，必须被抓出来');
line();
writeShots(STATEFUL);
const seq1 = stills([30, 60], 'st1');
const seq1b = stills([30, 60], 'st1b');
const alone1 = stills([60], 'st-alone');
console.log(`  有状态版，连渲 30,60：${Object.values(seq1.out).map((x) => x.hash).join(', ')}`);
console.log(`  有状态版，单独渲 60  ：${Object.values(alone1.out)[0]?.hash}`);
// 有状态版，连渲 30,60：两遍**相同**（同顺序渲染是可复现的）
// 但**单独渲第 60 帧**就不同了 —— 差别正是"第 N 帧是否只是 N 的函数"。
const orderReproducible = JSON.stringify(Object.values(seq1.out)) === JSON.stringify(Object.values(seq1b.out));
const frameIndep = Object.values(alone1.out)[0]?.hash === Object.values(seq1.out)[1]?.hash;
console.log(`  两遍同顺序是否一致：${orderReproducible ? '一致' : '不一致'}`);
ok(orderReproducible,
  '有状态版在**同顺序**两遍渲染下仍然一致 —— 说明"跑两遍比一比"**不足以**证明纯函数性');
ok(!frameIndep,
  '但它**单独渲第 60 帧**就不同了 ⇒ 被抓出来（判据有区分力）' +
  `（连渲 ${Object.values(seq1.out)[1]?.hash} ≠ 单渲 ${Object.values(alone1.out)[0]?.hash}）`);

line('═');
console.log('四、代价：同一次运行内配对测有/无 3D 的端到端 ms/帧');
line();
{
  const N = 40;
  const bench = (src, tag) => {
    writeShots(src);
    const out = join(P, '.work', 'b-' + tag + '.mp4');
    rmSync(out, {force: true});
    const t0 = Date.now();
    const r = spawnSync('node', [KIT, 'render', '--project', P, '--from', '20',
      '--to', String(20 + N - 1), '--shards', '1', '--out', out, ...(USE_GPU ? ['--gpu'] : [])],
      {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
    const secs = (Date.now() - t0) / 1000;
    if (r.status !== 0) { console.log(`  渲染失败(${tag})：` + String(r.stderr || r.stdout).slice(-300)); return null; }
    return secs * 1000 / N;
  };
  const PLAIN = 'export const SHOTS = [{start: 1, draw(){}}];\n';
  const t0 = bench(PLAIN, 'plain');
  const t3 = bench(STATELESS, 'three');
  if (t0 && t3) {
    console.log(`  不带 3D : ${t0.toFixed(1)} ms/帧`);
    console.log(`  带 3D   : ${t3.toFixed(1)} ms/帧`);
    console.log(`  ⇒ 代价 +${(t3 - t0).toFixed(1)} ms/帧（${(t3 / t0).toFixed(2)}×）`);
    ok(true, '两档都渲染成功（数字是**实测**；首帧的 three 加载约 50ms，摊到长片可忽略）');
  } else {
    ok(false, '性能测量渲染成功');
  }
}

line('═');
console.log('五、3D 光照（光真的在参与着色，不只是"画面变了"）');
line();
{
  // 只有环境光 ⇒ 球各面受光相同 ⇒ 中央区域几乎是平的；加平行光才有明暗梯度。
  writeShots(sphereShots('L.amb.intensity = 1.6; L.dir.intensity = 0; L.point.intensity = 0;'));
  const amb = stills([40], 'lit-amb');
  const hAmb = Object.values(amb.out)[0]?.hash;
  ok(amb.code === 0, '只有环境光的 3D 镜头能渲染');

  writeShots(sphereShots(
    'L.amb.intensity = 0.6; L.dir.intensity = 2.4; L.point.intensity = 0; ' +
    'L.dir.position.set(4, 3, 5);'));
  const dir = stills([40], 'lit-dir');
  const hDir = Object.values(dir.out)[0]?.hash;
  ok(dir.code === 0 && hDir !== hAmb, `加平行光后画面变了（${hAmb} → ${hDir}）`);

  const gAmb = toGray(join(P, '.work', 'lit-amb', 'f00040.png'));
  const gDir = toGray(join(P, '.work', 'lit-dir', 'f00040.png'));
  ok(gAmb.length === W * H, `帧尺寸是 ${W}×${H}（灰度缓冲 ${gAmb.length} 字节）`);
  const stdAmb = centerStd(gAmb), stdDir = centerStd(gDir);
  console.log(`  中央区域亮度标准差：只有 ambient ${stdAmb.toFixed(2)}；ambient+directional ${stdDir.toFixed(2)}`);
  ok(stdAmb < 3, `只有环境光时物体是**平的**（标准差 ${stdAmb.toFixed(2)} < 3）⇒ ambient 不产生明暗，符合物理`);
  ok(stdDir > stdAmb + 8, `加平行光后出现明暗梯度（${stdDir.toFixed(2)} > ${stdAmb.toFixed(2)} + 8）⇒ 光真的在参与着色`);

  // 光的位置要真的有用
  writeShots(sphereShots(
    'L.amb.intensity = 0.6; L.dir.intensity = 2.4; L.point.intensity = 0; ' +
    'L.dir.position.set(-5, -3, 2);'));
  const dir2 = stills([40], 'lit-dir2');
  ok(Object.values(dir2.out)[0]?.hash !== hDir, '把光换个方向，明暗随之改变 ⇒ position 不是摆设');

  // 受光材质也不能破坏核心不变量
  const d1 = stills([40], 'lit-det1');
  const d2 = stills([40], 'lit-det2');
  ok(Object.values(d1.out)[0]?.hash === Object.values(d2.out)[0]?.hash,
    '受光场景同一帧两次渲染**逐字节一致**（光照不破坏"第 N 帧只是 N 的函数"）');
}

line('═');
console.log('六、逐帧写灯（脉冲光 / 光扫过）—— 手写镜头里的灯同样是帧号的纯函数');
line();
{
  // 脉冲光：点光强度从 0.2 涨到 3.0（n=1 → n=31）
  writeShots(sphereShots(
    'L.amb.intensity = 0; L.dir.intensity = 0; ' +
    'L.point.intensity = 0.2 + ((n - 1) * 2.8) / 30;'));
  const frames = [1, 11, 21, 31];
  const means = [];
  for (const f of frames) {
    const r = stills([f], 'pulse' + f);
    if (r.code !== 0) { ok(false, `脉冲光第 ${f} 帧渲染失败`); break; }
    const g = toGray(join(P, '.work', 'pulse' + f, `f${String(f).padStart(5, '0')}.png`));
    means.push(meanOf(g));
  }
  console.log(`  脉冲光平均亮度：${frames.map((f, i) => `第${f}帧 ${(means[i] ?? 0).toFixed(1)}`).join('  ')}`);
  ok(means.length === 4 && means.every((m, i) => i === 0 || m > means[i - 1]),
    '强度按 n 写出来后画面**逐帧变亮**（单调）⇒ 逐帧写的灯真的进了画面');

  // 光扫过：平行光的 x 从 -5 到 +5（位置完全按 n 给）
  writeShots(sphereShots(
    'L.amb.intensity = 0; L.point.intensity = 0; L.dir.intensity = 2.4; ' +
    'L.dir.position.set(-5 + ((n - 1) * 10) / 30, 1, 2);'));
  const s1 = stills([1], 'sweep1');
  const s16 = stills([16], 'sweep16');
  const s31 = stills([31], 'sweep31');
  const hs = [s1, s16, s31].map((r) => Object.values(r.out)[0]?.hash);
  ok(s1.code === 0 && s31.code === 0, '光的位置按 n 写出来也能渲染');
  ok(new Set(hs).size === 3, `光扫过时画面逐帧不同（${hs.join(' / ')}）⇒ 位置真的在动`);

  // 灯动了，核心不变量仍然要成立
  const a = stills([16], 'sweepA');
  const b = stills([16], 'sweepB');
  const seq = stills([1, 16], 'sweepSeq');
  ok(Object.values(a.out)[0]?.hash === Object.values(b.out)[0]?.hash,
    '灯在动时，同一帧两次渲染**逐字节一致**');
  ok(Object.values(seq.out)[1]?.hash === Object.values(a.out)[0]?.hash,
    '灯在动时，**乱序渲染**同一帧也一致（没有"必须从头渲"的隐藏依赖）');

  // 负面对照：强度写成常数时灯是静止的 ⇒ **3D 内容所在的中央区域**不随帧变化。
  // ⚠️ 只能比中央区域：整帧里有引擎画的**字幕/HUD，它们本来就随时间变**，
  // 拿第 1 帧与第 31 帧比整帧，会把"字幕换了"误当成"灯在动"（第一次就是这么错的）。
  writeShots(sphereShots(
    'L.amb.intensity = 0; L.dir.intensity = 0; L.point.intensity = 1.5;'));
  const st1 = stills([1], 'still1');
  const st31 = stills([31], 'still31');
  const c1 = centerHash(join(P, '.work', 'still1', 'f00001.png'));
  const c31 = centerHash(join(P, '.work', 'still31', 'f00031.png'));
  console.log(`  静态灯：中央区域 hash 第1帧 ${c1}，第31帧 ${c31}`);
  ok(c1 === c31, '强度写成常数时灯静止（中央区域逐字节相同）—— 证明上面那条变化确实来自逐帧写入');

  // 正面佐证：同一个"中央区域"度量下，脉冲光的两帧必须不同
  const p1 = centerHash(join(P, '.work', 'pulse1', 'f00001.png'));
  const p31 = centerHash(join(P, '.work', 'pulse31', 'f00031.png'));
  ok(p1 !== p31, `脉冲光的两帧在**同一个中央区域**度量下不同（${p1} ≠ ${p31}）—— 判据不是恒真`);
}

rmSync(P, {recursive: true, force: true});
line('═');
console.log(bad === 0 ? '✓ 3D 图层可用且守住核心不变量' : `✗ ${bad} 项失败`);
process.exit(bad ? 1 : 0);
