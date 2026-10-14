// 验收：效果链（最小闭环 blur）真的生效、方向正确、代价可量。
//
//   node tools/verify-effects.mjs [<仓库根>] [--gpu]
//
// ## 判据为什么这样设计
//
// "画面变了"不足以证明模糊生效 —— 任何 bug 都能让画面变。所以这里量
// **边缘能量**（相邻像素差的和）：模糊必然让它下降，半径越大降得越多。
// 这是个**方向明确、可量化**的判据，能真正抓住"效果没接上"或"接反了"。
//
// 另外三条：
//   · radius=0 必须**逐位等于**不写 effects（短路保证）
//   · 加了 radius>0 的帧必须与不写 effects 不同（否则效果没上）
//   · 性能：同一次运行内配对测有/无效果的 ms/帧（跨运行比会受负载漂移污染）
import {spawnSync} from 'node:child_process';
import {cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';

const ROOT = (process.argv[2] || process.cwd()).replace(/\\/g, '/');
const USE_GPU = process.argv.includes('--gpu');
const KIT = join(ROOT, 'bin', 'filmwright.mjs');
const SRC = join(ROOT, 'examples', 'scenecast');
const P = join(ROOT, '.work', 'fx-e2e');

let bad = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) bad++; };
const line = (c = '─') => console.log(c.repeat(76));

rmSync(P, {recursive: true, force: true});
cpSync(SRC, P, {recursive: true});
for (const d of ['audio', 'renders', 'public/assets/scenecast']) {
  rmSync(join(P, d), {recursive: true, force: true});
}

/** 给 scene.json 的第一个非 title 镜头挂上 effects（null = 不写）。 */
function setEffects(effects) {
  const sc = JSON.parse(readFileSync(join(SRC, 'scene.json'), 'utf8'));
  const t = sc.shots.find((s) => s.type !== 'title') || sc.shots[0];
  // 固定到具体帧：用第 100 帧（第一个镜头区间内）
  const clone = JSON.parse(JSON.stringify(sc));
  const c = clone.shots.find((s) => s.type !== 'title') || clone.shots[0];
  if (effects) c.effects = effects; else delete c.effects;
  // 只留这一个镜头，避免别的镜头干扰对比（at:1 覆盖全片）
  writeFileSync(join(P, 'scene.json'),
    JSON.stringify({shots: [{...c, at: 1}]}, null, 2) + '\n', 'utf8');
  return t;
}

const run = (args) => spawnSync('node', [KIT, ...args], {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});

/** 渲一帧静帧，返回 {hash, gray}（gray 用 ffmpeg 解成 8bit 灰度原始字节）。 */
function still(effects, frame, tag) {
  setEffects(effects);
  const dir = join(P, '.work', 's-' + tag);
  rmSync(dir, {recursive: true, force: true});
  const r = run(['stills', '--project', P, '--frames', String(frame), '--dir', dir]);
  if (r.status !== 0) { console.log(`渲染失败(${tag})：` + String(r.stderr || r.stdout).slice(-400)); process.exit(1); }
  const f = readdirSync(dir).find((x) => x.endsWith('.png'));
  const p = join(dir, f);
  const bytes = readFileSync(p);
  const g = spawnSync('ffmpeg', ['-v', 'error', '-i', p, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
    {maxBuffer: 64 * 1024 * 1024});
  if (g.status !== 0) { console.log('ffmpeg 解码失败'); process.exit(1); }
  return {hash: createHash('sha256').update(bytes).digest('hex').slice(0, 12), gray: g.stdout};
}

/** 边缘能量：相邻像素灰度差的和（模糊会让它下降）。 */
function edgeEnergy(gray) {
  let s = 0;
  for (let i = 1; i < gray.length; i++) s += Math.abs(gray[i] - gray[i - 1]);
  return s / gray.length;
}

console.log(`效果链验收：blur 最小闭环（${USE_GPU ? '--gpu 放开 GPU' : '默认档（软件 WebGL）'}）\n`);
line('═');
console.log('一、radius=0 必须**逐位等于**不写 effects（短路保证）');
line();
const none = still(null, 100, 'none');
const r0 = still([{type: 'blur', radius: 0}], 100, 'r0');
console.log(`  不写 effects : ${none.hash}`);
console.log(`  radius=0     : ${r0.hash}`);
ok(none.hash === r0.hash, 'radius=0 与不写 effects **逐位相同**（效果被短路，没产生额外趟）');

line('═');
console.log('二、模糊必须真的生效，且**半径越大越模糊**（量边缘能量）');
line();
const radii = [2, 8, 20, 34];
const samples = [];
for (const rad of radii) {
  const s = still([{type: 'blur', radius: rad}], 100, 'r' + rad);
  samples.push({rad, ...s, e: edgeEnergy(s.gray)});
}
const eNone = edgeEnergy(none.gray);
console.log(`  不写 effects : 边缘能量 ${eNone.toFixed(3)}  hash ${none.hash}`);
for (const s of samples) {
  console.log(`  radius=${String(s.rad).padStart(2)}     : 边缘能量 ${s.e.toFixed(3)}  hash ${s.hash}` +
    `   ${s.hash === none.hash ? '（与不写 effects 相同 ← 可疑）' : ''}`);
}
ok(samples.every((s) => s.hash !== none.hash), 'radius>0 的画面都与不写 effects **不同**（效果确实上了）');
ok(samples.every((s) => s.e < eNone), '半径>0 的边缘能量都**低于**不写 effects（确实变模糊了）');
let mono = true;
for (let i = 1; i < samples.length; i++) {
  if (!(samples[i].e < samples[i - 1].e)) mono = false;
}
ok(mono, `边缘能量随半径**单调下降**（${samples.map((s) => s.e.toFixed(1)).join(' → ')}）—— 方向正确`);

line('═');
console.log('四、关键帧参数：模糊**渐入**（radius 从 0 长到 24）');
line();
const kfFx = [{type: 'blur', radius: [{frame: 1, v: 0}, {frame: 60, v: 24}]}];
// 基准要在**同一帧**上取：上面那个 none 是第 100 帧的画面，拿来跟第 1 帧比是错的
// （不同帧的内容本来就不一样，画面不同不能说明短路有没有生效）。
const none1 = still(null, 1, 'none1');
const kf1 = still(kfFx, 1, 'kf1');
console.log(`  第  1 帧 不写 effects hash ${none1.hash}`);
console.log(`  第  1 帧 轨道起点   hash ${kf1.hash}   （radius=0）`);
ok(kf1.hash === none1.hash,
  '起点（radius=0）与不写 effects **逐位相同** —— 逐帧短路生效，起点不吃一趟 GPU');

const eNone1 = edgeEnergy(none1.gray);
const kfSamples = [];
for (const fr of [15, 30, 45, 60]) {
  // **同帧配对**：模糊有没有生效，只能拿"这一帧有效果"与"这一帧没效果"比。
  // 跨帧比是错的 —— 镜头的要点在错峰入场，不同帧的内容本来就不一样，
  // 画面差异里混着内容差异（第一版就是这么错判的）。
  const withFx = still(kfFx, fr, 'kf' + fr);
  const base = still(null, fr, 'base' + fr);
  const e = edgeEnergy(withFx.gray), be = edgeEnergy(base.gray);
  kfSamples.push({fr, e, baseE: be, hash: withFx.hash});
  console.log(`  第 ${String(fr).padStart(2)} 帧 有模糊 ${e.toFixed(3)}  无效果 ${be.toFixed(3)}   hash ${withFx.hash}`);
}
ok(kfSamples.every((s) => s.e < s.baseE), '每一帧都比**同帧**的不写 effects 更模糊');
let monoT = true;
for (let i = 1; i < kfSamples.length; i++) {
  if (!(kfSamples[i].e < kfSamples[i - 1].e)) monoT = false;
}
ok(monoT, `边缘能量随时间**单调下降**（${kfSamples.map((s) => s.e.toFixed(2)).join(' → ')}）—— 确实在渐入`);

// 最锋利的一条：关键帧的**终点**应当与等值静态参数逐位相同 ——
// 它同时证明了「插值端点精确」与「轨道求值没错位」两件事。
const static24 = still([{type: 'blur', radius: 24}], 60, 'st24');
ok(static24.hash === kfSamples[kfSamples.length - 1].hash,
  '第 60 帧（轨道终点 v=24）与静态 radius=24 **逐位相同**（端点精确、没错位）');

line('═');
console.log('五、代价：同一次运行内配对测有/无效果的端到端 ms/帧');
line();
const N = 60;
function bench(effects, tag) {
  setEffects(effects);
  const out = join(P, '.work', 'b-' + tag + '.mp4');
  rmSync(out, {force: true});
  const t0 = Date.now();
  const args = ['render', '--project', P, '--from', '40', '--to', String(40 + N - 1), '--shards', '1', '--out', out];
  if (USE_GPU) args.push('--gpu');
  const r = run(args);
  const secs = (Date.now() - t0) / 1000;
  if (r.status !== 0) { console.log(`渲染失败(${tag})：` + String(r.stderr || r.stdout).slice(-300)); return null; }
  return secs * 1000 / N;
}
const tNo = bench(null, 'no');
const tBlur = bench([{type: 'blur', radius: 12}], 'blur');
if (tNo && tBlur) {
  console.log(`  不写 effects : ${tNo.toFixed(1)} ms/帧`);
  console.log(`  blur radius=12: ${tBlur.toFixed(1)} ms/帧`);
  console.log(`  ⇒ 代价 +${(tBlur - tNo).toFixed(1)} ms/帧（${(tBlur / tNo).toFixed(2)}×）`);
  ok(true, '两档都渲染成功（数字见上，这是**实测**不是外推）');
} else {
  ok(false, '性能测量渲染成功');
}

rmSync(P, {recursive: true, force: true});
line('═');
console.log(bad === 0 ? '✓ 效果链最小闭环验收通过' : `✗ ${bad} 项失败`);
process.exit(bad ? 1 : 0);
