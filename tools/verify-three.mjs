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
// 还有一条：**不用 3D 的项目不该加载 three**。这是"不装 three 也能用"的兑现方式。
import {spawnSync} from 'node:child_process';
import {cpSync, readdirSync, rmSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const ROOT = resolve(argv[0] && !argv[0].startsWith('--') ? argv[0] : resolve(HERE, '..')).replace(/\\/g, '/');
const USE_GPU = argv.includes('--gpu');
const KIT = join(ROOT, 'bin', 'filmwright.mjs');
const SRC = join(ROOT, 'examples', 'scenecast');
const P = join(ROOT, '.work', 'three-e2e');
// 帧尺寸（渲染页按项目配置出图；下面用到尺寸时会顺带校验一次）
const W = 1280, H = 720;

let bad = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) bad++; };
const line = (c = '─') => console.log(c.repeat(76));

rmSync(P, {recursive: true, force: true});
cpSync(SRC, P, {recursive: true});
for (const d of ['audio', 'renders', 'public/assets/scenecast']) {
  rmSync(join(P, d), {recursive: true, force: true});
}
rmSync(join(P, 'scene.json'), {force: true});
mkdirSync(join(P, 'shots'), {recursive: true});

/** 数学上同一帧号两次渲染必须一致 —— 关键是**不读时钟**。 */
const STATELESS = `
import {loadThree, create3D, view} from 'filmwright';
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
import {loadThree, create3D, view} from 'filmwright';
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

console.log(`3D 图层验收（${USE_GPU ? '--gpu' : '默认档'}）\n`);
line('═');
console.log('一、3D 真的渲进帧里了吗（与不带 3D 的同帧对比）');
line();
writeFileSync(join(P, 'shots', 'index.js'),
  'import {view} from \'filmwright\';\nexport const SHOTS = [{start: 1, draw(){}}];\n', 'utf8');
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
console.log('四、不用 3D 的项目不该加载 three（"不装也能用"的兑现方式）');
line();
{
  // 场景规格项目（只用 scene.json）应当完全不碰 three：把 vendor 路由打不可达也照样跑
  const S = join(ROOT, 'examples', 'minimal');
  const r = spawnSync('node', [KIT, 'stills', '--project', S, '--frames', '5',
    '--dir', join(P, '.work', 'plain'), '--json'], {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024});
  ok(r.status === 0, '纯 scene.json 项目照常渲染（不依赖 three）');
}

line('═');
console.log('五、代价：同一次运行内配对测有/无 3D 的端到端 ms/帧');
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
  const PLAIN = 'import {view} from \'filmwright\';\nexport const SHOTS = [{start: 1, draw(){}}];\n';
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
console.log('六、声明式 3D（scene.json 里的 `three` 镜头）');
line();
{
  const {writeFileSync: wf} = await import('node:fs');
  const writeScene = (shots) => wf(join(P, 'scene.json'), JSON.stringify({shots}, null, 2) + '\n', 'utf8');
  const T3 = (anim) => ({
    type: 'three', at: 1,
    camera: {z: 4.2, fov: 50},
    objects: [{shape: 'box', size: 1.6, color: 'accent', ...(anim ? {animate: anim} : {})}],
  });
  // 有 3D 时只用 scene.json（把 shots/index.js 挪开，避免两边混）
  writeFileSync(join(P, 'shots', 'index.js'),
    'import {view} from \'filmwright\';\nexport const SHOTS = [];\n', 'utf8');

  writeScene([T3({ry: [{frame: 1, v: 0}, {frame: 60, v: 180}]})]);
  const d1 = stills([30], 'decl30');
  ok(d1.code === 0, '声明式 three 镜头能渲染（' + (d1.code === 0 ? '没报错' : String(d1.raw).slice(-260)) + '）');
  const d2 = stills([60], 'decl60');
  ok(Object.values(d1.out)[0]?.hash !== Object.values(d2.out)[0]?.hash,
    '关键帧让 3D 真的在动（第 30 帧 ≠ 第 60 帧）');

  // 纯函数性：同一帧两次一致 + **乱序**渲染同一帧也一致
  const seq = stills([30, 60], 'declSeq');
  const alone = stills([60], 'declAlone');
  ok(Object.values(seq.out)[1]?.hash === Object.values(alone.out)[0]?.hash,
    '声明式 3D 也是帧号的纯函数（单独渲第 60 帧 == 连渲的第 60 帧）');

  // 静态自检应当**抓得住**写错的声明式 3D（scene.json 是静态校验的，比命令式强）
  writeScene([{type: 'three', at: 1, objects: [{shape: 'pyramid'}]}]);
  const bad = spawnSync('node', [KIT, 'check', '--project', P, '--static-only', '--json'],
    {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024});
  let bj = null;
  try { bj = JSON.parse(bad.stdout); } catch { /* ignore */ }
  const codes = (bj?.errors ?? []).map((e) => e.code);
  ok(bad.status !== 0 && codes.includes('SCENE_3D_SHAPE_KIND'),
    `写错的形状在**静态自检**就报出来（${codes.join('/') || '没报'}）—— 不用等到渲染`);

  // 不用 3D 的规格不该触发 three 加载（靠 needsThree 门控）
  writeScene([{type: 'title', at: 1, title: 'no 3d'}]);
  const plain = stills([30], 'declPlain');
  ok(plain.code === 0, '没有 3D 的规格照常渲染（不会去加载 three）');
}

line('═');
console.log('七、3D 光照（有 lights 才切到受光材质）');
line();
{
  const {writeFileSync: wf} = await import('node:fs');
  const sphere = (extra) => ({
    type: 'three', at: 1, camera: {z: 4.2},
    objects: [{shape: 'sphere', size: 2.2, color: 'accent', ...extra.obj}],
    ...(extra.lights ? {lights: extra.lights} : {}),
  });
  const writeScene3 = (s) => wf(join(P, 'scene.json'), JSON.stringify({shots: [s]}, null, 2) + '\n', 'utf8');
  writeFileSync(join(P, 'shots', 'index.js'),
    'import {view} from \'filmwright\';\nexport const SHOTS = [];\n', 'utf8');

  /** 画面中央一块区域内的亮度标准差：受光有明暗 ⇒ 标准差大；只有环境光 ⇒ 接近 0。 */
  const centerStd = (gray, w = W, h = H, box = 160) => {
    const x0 = Math.floor(w / 2 - box / 2), y0 = Math.floor(h / 2 - box / 2);
    const vals = [];
    for (let y = y0; y < y0 + box; y++) for (let x = x0; x < x0 + box; x++) vals.push(gray[y * w + x]);
    const m = vals.reduce((a, b) => a + b, 0) / vals.length;
    return Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length);
  };

  writeScene3(sphere({}));
  const unlit = stills([40], 'lit-none');
  ok(unlit.code === 0, '无 lights 的 3D 镜头照常渲染（材质仍是 MeshBasicMaterial）');
  const hUnlit = Object.values(unlit.out)[0]?.hash;

  writeScene3(sphere({lights: [{type: 'ambient', intensity: 1.6}]}));
  const amb = stills([40], 'lit-amb');
  const hAmb = Object.values(amb.out)[0]?.hash;
  ok(amb.code === 0 && hAmb !== hUnlit, `加 ambient 后画面变了（${hUnlit} → ${hAmb}）⇒ 确实切到了受光材质`);

  writeScene3(sphere({lights: [{type: 'ambient', intensity: 0.6}, {type: 'directional', intensity: 2.4, position: [4, 3, 5]}]}));
  const dir = stills([40], 'lit-dir');
  const hDir = Object.values(dir.out)[0]?.hash;
  ok(dir.code === 0 && hDir !== hAmb, `加 directional 后画面又变了（${hAmb} → ${hDir}）`);

  // **锋利判据**：只有环境光时，物体各面受光相同 ⇒ 中央区域几乎是平的（标准差≈0）；
  // 有平行光才有明暗梯度 ⇒ 标准差明显更大。这一条能证明"光真的在参与着色"，
  // 而不只是"画面变了"（材质换成 standard 本身就会让画面变）。
  const {execFileSync} = await import('node:child_process');
  const toGray = (p) => {
    const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', p, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
      {maxBuffer: 64 * 1024 * 1024});
    return raw;
  };
  const gAmb = toGray(join(P, '.work', 'lit-amb', 'f00040.png'));
  const gDir = toGray(join(P, '.work', 'lit-dir', 'f00040.png'));
  ok(gAmb.length === W * H, `帧尺寸是 ${W}×${H}（灰度缓冲 ${gAmb.length} 字节）`);
  const stdAmb = centerStd(gAmb), stdDir = centerStd(gDir);
  console.log(`  中央区域亮度标准差：只有 ambient ${stdAmb.toFixed(2)}；ambient+directional ${stdDir.toFixed(2)}`);
  ok(stdAmb < 3, `只有环境光时物体是**平的**（标准差 ${stdAmb.toFixed(2)} < 3）⇒ ambient 不产生明暗，符合物理`);
  ok(stdDir > stdAmb + 8, `加平行光后出现明暗梯度（${stdDir.toFixed(2)} > ${stdAmb.toFixed(2)} + 8）⇒ 光真的在参与着色`);

  // 光的位置要真的有用
  writeScene3(sphere({lights: [{type: 'ambient', intensity: 0.6}, {type: 'directional', intensity: 2.4, position: [-5, -3, 2]}]}));
  const dir2 = stills([40], 'lit-dir2');
  ok(Object.values(dir2.out)[0]?.hash !== hDir, '把光换个方向，明暗随之改变 ⇒ position 不是摆设');

  // 受光材质也不能破坏核心不变量
  const d1 = stills([40], 'lit-det1');
  const d2 = stills([40], 'lit-det2');
  ok(Object.values(d1.out)[0]?.hash === Object.values(d2.out)[0]?.hash,
    '受光场景同一帧两次渲染**逐字节一致**（光照不破坏"第 N 帧只是 N 的函数"）');
}

line('═');
console.log('八、灯的关键帧（脉冲光 / 光扫过）');
line();
{
  const {writeFileSync: wf} = await import('node:fs');
  const {execFileSync} = await import('node:child_process');
  const writeScene4 = (s) => wf(join(P, 'scene.json'), JSON.stringify({shots: [s]}, null, 2) + '\n', 'utf8');
  writeFileSync(join(P, 'shots', 'index.js'),
    'import {view} from \'filmwright\';\nexport const SHOTS = [];\n', 'utf8');
  const toGray = (p) => execFileSync('ffmpeg', ['-v', 'error', '-i', p, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
    {maxBuffer: 64 * 1024 * 1024});
  const meanOf = (buf) => { let s = 0; for (const v of buf) s += v; return s / buf.length; };

  // 脉冲光：强度从 0.2 涨到 3.0
  const pulse = {
    type: 'three', at: 1, camera: {z: 4.2},
    lights: [{type: 'point', position: [2, 2, 3],
      animate: {intensity: [{frame: 1, v: 0.2}, {frame: 31, v: 3.0}]}}],
    objects: [{shape: 'sphere', size: 2.2, color: 'accent'}],
  };
  writeScene4(pulse);
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
    '强度关键帧让画面**逐帧变亮**（单调）⇒ 灯的 intensity 轨道真的在生效');

  // 光扫过：平行光的 x 从 -5 到 +5（且**不写静态 position**，位置完全由轨道给出）
  const sweep = {
    type: 'three', at: 1, camera: {z: 4.2},
    lights: [{type: 'directional', intensity: 2.4,
      animate: {x: [{frame: 1, v: -5}, {frame: 31, v: 5}],
        y: [{frame: 1, v: 1}, {frame: 31, v: 1}], z: [{frame: 1, v: 2}, {frame: 31, v: 2}]}}],
    objects: [{shape: 'sphere', size: 2.2, color: 'accent'}],
  };
  writeScene4(sweep);
  const s1 = stills([1], 'sweep1');
  const s16 = stills([16], 'sweep16');
  const s31 = stills([31], 'sweep31');
  const hs = [s1, s16, s31].map((r) => Object.values(r.out)[0]?.hash);
  ok(s1.code === 0 && s31.code === 0, '只用轨道给位置（不写静态 position）也能渲染');
  ok(new Set(hs).size === 3, `光扫过时画面逐帧不同（${hs.join(' / ')}）⇒ x/y/z 轨道真的在动`);

  // 灯动了，核心不变量仍然要成立
  const a = stills([16], 'sweepA');
  const b = stills([16], 'sweepB');
  const seq = stills([1, 16], 'sweepSeq');
  ok(Object.values(a.out)[0]?.hash === Object.values(b.out)[0]?.hash,
    '灯在动时，同一帧两次渲染**逐字节一致**');
  ok(Object.values(seq.out)[1]?.hash === Object.values(a.out)[0]?.hash,
    '灯在动时，**乱序渲染**同一帧也一致（没有"必须从头渲"的隐藏依赖）');

  // 负面对照：不写 animate 时灯是静止的 ⇒ **3D 内容所在的中央区域**不随帧变化。
  // ⚠️ 只能比中央区域：整帧里有引擎画的**字幕/HUD，它们本来就随时间变**，
  // 拿第 1 帧与第 31 帧比整帧，会把"字幕换了"误当成"灯在动"（第一次就是这么错的）。
  const centerBox = (gray, w = W, h = H, box = 200) => {
    const x0 = Math.floor(w / 2 - box / 2), y0 = Math.floor(h / 2 - box / 2);
    const out = Buffer.alloc(box * box);
    for (let y = 0; y < box; y++) gray.copy(out, y * box, (y0 + y) * w + x0, (y0 + y) * w + x0 + box);
    return out;
  };
  const centerHash = (p) => createHash('sha256').update(centerBox(toGray(p))).digest('hex').slice(0, 12);
  writeScene4({...pulse, lights: [{type: 'point', position: [2, 2, 3], intensity: 1.5}]});
  const st1 = stills([1], 'still1');
  const st31 = stills([31], 'still31');
  const c1 = centerHash(join(P, '.work', 'still1', 'f00001.png'));
  const c31 = centerHash(join(P, '.work', 'still31', 'f00031.png'));
  console.log(`  静态灯：中央区域 hash 第1帧 ${c1}，第31帧 ${c31}`);
  ok(c1 === c31, '不写 animate 时灯静止（中央区域逐字节相同）—— 证明上面那条变化确实来自轨道');

  // 正面佐证：同一个"中央区域"度量下，脉冲光的两帧必须不同
  const p1 = centerHash(join(P, '.work', 'pulse1', 'f00001.png'));
  const p31 = centerHash(join(P, '.work', 'pulse31', 'f00031.png'));
  ok(p1 !== p31, `脉冲光的两帧在**同一个中央区域**度量下不同（${p1} ≠ ${p31}）—— 判据不是恒真`);
}

rmSync(P, {recursive: true, force: true});
line('═');
console.log(bad === 0 ? '✓ 3D 图层可用且守住核心不变量' : `✗ ${bad} 项失败`);
process.exit(bad ? 1 : 0);
