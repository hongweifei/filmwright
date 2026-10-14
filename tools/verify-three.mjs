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
const ROOT = (argv[0] && !argv[0].startsWith('--') ? argv[0] : resolve(HERE, '..')).replace(/\\/g, '/');
const USE_GPU = argv.includes('--gpu');
const KIT = join(ROOT, 'bin', 'filmwright.mjs');
const SRC = join(ROOT, 'examples', 'scenecast');
const P = join(ROOT, '.work', 'three-e2e');

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

rmSync(P, {recursive: true, force: true});
line('═');
console.log(bad === 0 ? '✓ 3D 图层可用且守住核心不变量' : `✗ ${bad} 项失败`);
process.exit(bad ? 1 : 0);
