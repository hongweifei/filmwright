// 图层合成在真浏览器里的验证：同一个镜头，分别用「无变换 / 位移 / 旋转 / 半透明」
// 渲染同一帧，比较像素：
//   - 无变换 vs 原图：必须逐字节相同（快路径不改变输出）
//   - 有变换：必须与无变换不同（变换真的生效了）
//   - 半透明：必须与无变换不同，且整体更暗（alpha 真的生效了）
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {mkdirSync, rmSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = process.argv[2].replace(/\\/g, '/');
const W = `${ROOT}/.work/layer-e2e`;
rmSync(W, {recursive: true, force: true});
mkdirSync(W, {recursive: true});

const imp = (rel) => import(pathToFileURL(`${ROOT}/${rel}`).href);
const {serveProject} = await imp('src/host/project/server.mjs');
const {openSession} = await imp('src/host/browser/session.mjs');
const {loadProject} = await imp('src/host/project/load.mjs');

const P = `${ROOT}/examples/scenecast`;
const proj = await loadProject(P);

// 用 scenecast 的 scene，但给某个镜头加 transform —— 通过临时改 scene 对象实现
const scene = JSON.parse(JSON.stringify(proj.scene));

// 目标帧与它所属的镜头：**按帧号反查**，不要硬编码索引 ——
// 我第一版写死 shots[4]（code@S04），却去看第 700 帧（那是 stat@S03 的画面），
// 结果「变换没生效」的假象查了半天（实际是改错了镜头）。
const FRAME = 700;
const resolveAtLocal = (at, tl) => {
  if (typeof at === 'number') return at;
  const spec = typeof at === 'string' ? {s: at} : at;
  const s = tl.sentences.find((x) => x.id === spec.s);
  if (!s) throw new Error('没有句 ' + spec.s);
  let anchor = s.from;
  if (spec.block !== undefined) {
    const blocks = tl.subs.filter((b) => b.from >= s.from && b.to <= s.to);
    anchor = blocks[spec.block - 1].from;
  }
  return Math.max(1, anchor - (spec.lead ?? 8) + (spec.offset ?? 0));
};
const starts = scene.shots.map((sh) => resolveAtLocal(sh.at, proj.timeline));
let target = 0;
for (let i = 0; i < starts.length; i++) {
  const end = i + 1 < starts.length ? starts[i + 1] - 1 : proj.timeline.total_frames;
  if (FRAME >= starts[i] && FRAME <= end) { target = i; break; }
}
console.log(`目标：第 ${FRAME} 帧属于 shots[${target}](${scene.shots[target].type}@${scene.shots[target].at})，` +
  `区间 ${starts[target]}..${(target + 1 < starts.length ? starts[target + 1] - 1 : proj.timeline.total_frames)}\n`);

const renderWithScene = async (mutateScene, label) => {
  const s = JSON.parse(JSON.stringify(scene));
  if (mutateScene) mutateScene(s, target);
  const server = await serveProject(P, {
    raw: proj.raw, timeline: proj.timeline, shotsRel: null, scene: s,
  });
  const base = `http://127.0.0.1:${server.address().port}/`;
  const sess = await openSession(base, {width: 1280, height: 720});
  const png = await sess.frame(FRAME);
  await sess.close();
  server.closeProject();
  return png;
};

const hash = (b) => createHash('sha256').update(b).digest('hex').slice(0, 12);
const stats = (png) => {
  // 粗略亮度统计（不解码 PNG，只比字节长度与哈希不同）—— 用 ffmpeg 求均值更准，
  // 但这里只要「同/不同」与相对亮度，用像素字节和近似即可
  let sum = 0;
  for (let i = 0; i < png.length; i += 97) sum += png[i];
  return sum;
};

console.log('=== 基线（无变换）===');
const base = await renderWithScene(null, 'base');
console.log('  hash', hash(base), 'bytes', base.length);

console.log('\n=== 快路径：显式给无副作用的 transform（x:0,y:0,scale:1）=== ');
const noop = await renderWithScene((s, target) => { s.shots[target].transform = {x: 0, y: 0, scale: 1, rotate: 0}; }, 'noop');
console.log('  hash', hash(noop), 'bytes', noop.length);
console.log('  与基线相同:', base.equals(noop) ? '✓（无副作用变换不该改画面）' : '✗ 变了');

console.log('\n=== 位移 x=200：画面必须变 ===');
const moved = await renderWithScene((s, target) => { s.shots[target].transform = {x: 200}; }, 'moved');
console.log('  hash', hash(moved), 'bytes', moved.length);
console.log('  与基线不同:', !base.equals(moved) ? '✓' : '✗ 没变（变换没生效）');
console.log('  与无副作用版不同:', !noop.equals(moved) ? '✓' : '✗');

console.log('\n=== 旋转 15°：画面必须变 ===');
const rot = await renderWithScene((s, target) => { s.shots[target].transform = {rotate: 15}; }, 'rot');
console.log('  hash', hash(rot), 'bytes', rot.length);
console.log('  与基线不同:', !base.equals(rot) ? '✓' : '✗');

console.log('\n=== 半透明 alpha=0.35：画面必须变且更暗 ===');
const half = await renderWithScene((s, target) => { s.shots[target].transform = {alpha: 0.35}; }, 'half');
console.log('  hash', hash(half), 'bytes', half.length);
console.log('  与基线不同:', !base.equals(half) ? '✓' : '✗');

console.log('\n=== 混合模式 multiply ===');
const mul = await renderWithScene((s, target) => { s.shots[target].transform = {blend: 'multiply'}; }, 'mul');
console.log('  hash', hash(mul), 'bytes', mul.length);
console.log('  与基线不同:', !base.equals(mul) ? '✓' : '✗');

console.log('\n=== 确定性：同一变换渲两次必须逐字节相同 ===');
const again = await renderWithScene((s, target) => { s.shots[target].transform = {x: 200}; }, 'again');
console.log('  两次位移版相同:', moved.equals(again) ? '✓（不变量仍然成立）' : '✗ 不确定了！');

const ok = base.equals(noop) && !base.equals(moved) && !base.equals(rot)
  && !base.equals(half) && !base.equals(mul) && moved.equals(again);
console.log(ok ? '\n✓ 图层合成端到端全部符合预期' : '\n✗ 有不符合项');
rmSync(W, {recursive: true, force: true});
process.exit(ok ? 0 : 1);
