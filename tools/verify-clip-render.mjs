// 片段素材的**浏览器端到端验证**：真抽帧 → 真服务 → 真在页面里取帧画出来。
//
// 验证四件事：
//   1. 帧能被取到并画出（画面里有内容，且随帧号变化 —— 视频真的在播）
//   2. **确定性**：同一帧取两次，整帧逐字节相同
//   3. 源帧映射正确：全局帧 n 取到的源帧 = sourceIndex(n) 那一张
//   4. 负面对照：引用未声明的片段名要抛错（不是画空白）
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {mkdirSync, rmSync, writeFileSync, readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join, resolve} from 'node:path';

// resolve() 保证 ROOT 是**绝对路径**：下面要用它拼 file:// URL 或 pathToFileURL，
// 相对路径会抛 ERR_INVALID_FILE_URL_PATH（CI 步骤里传 `.` 时踩到过）。
// ⚠️ 必须给兜底：CI 里这个工具是**不带参数**跑的（`node tools/verify-X.mjs`），
// 而 `resolve(undefined)` 会抛 ERR_INVALID_ARG_TYPE（CI 实测红过）。
const ROOT = resolve(process.argv[2] ?? process.cwd()).replace(/\\/g, '/');
const imp = (rel) => import(pathToFileURL(`${ROOT}/${rel}`).href);
const {serveProject} = await imp('src/host/project/server.mjs');
const {openSession} = await imp('src/host/browser/session.mjs');
const {loadProject} = await imp('src/host/project/load.mjs');
const {prepareClips} = await imp('src/host/media/clips.mjs');

const PROJ = `${ROOT}/.work/clip-e2e-proj`;
rmSync(PROJ, {recursive: true, force: true});
mkdirSync(join(PROJ, 'public', 'assets', 'fonts'), {recursive: true});
mkdirSync(join(PROJ, 'script'), {recursive: true});

// 复用示例的字体（片段渲染也要字体）
const src = `${ROOT}/examples/scenecast`;
for (const f of readFileSync(`${src}/film.config.mjs`, 'utf8').match(/fonts\/[^'"]+/g) ?? []) {
  spawnSync('cmd', ['/c', 'copy', join(src, 'public', f).replace(/\//g, '\\'),
    join(PROJ, 'public', f).replace(/\//g, '\\')], {stdio: 'ignore'});
}

// 造一段「每帧颜色不同」的视频：用 testsrc2（有运动与色块）
const vid = join(PROJ, 'public', 'assets', 'broll.mp4');
let r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi',
  '-i', 'testsrc2=size=320x180:rate=30:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', vid], {encoding: 'utf8'});
if (r.status !== 0) { console.log('造视频失败:', r.stderr.slice(-200)); process.exit(1); }

// 最小项目：配置 + 时间轴 + scene（一个 clip 镜头 + 一个 title 打头）
// theme 要给全（引擎内建件 backdrop/HUD 等要读每一个键）——只给 accents
// 会让 backdrop 拿到 undefined 而整帧报错。这里直接抄示例的 theme，
// 免得夹具自己变成「配置不全」的坑。
writeFileSync(join(PROJ, 'film.config.mjs'), `export default {
  slug: 'clipdemo', size: {width: 1280, height: 720}, fps: 30,
  theme: {
    bg: '#080B14', bgDeep: '#050710', panel: '#101725', panelHi: '#182136',
    line: '#22304A', lineSoft: '#182238', text: '#E9F0FA', dim: '#8B99B4',
    faint: '#5A677F', codeBg: '#0C1220', termBg: '#05080F',
    ok: '#35D07F', bad: '#FF6B6B', hi: '#F5B942',
    accents: ['#3FA7FF'],
  },
  clips: [{name: 'broll', src: 'assets/broll.mp4', fps: 30, width: 320}],
};\n`, 'utf8');
writeFileSync(join(PROJ, 'script', 'timeline.json'), JSON.stringify({
  fps: 30, total_frames: 120,
  sentences: [{id: 'S01', chapter: 1, from: 20, to: 100, text: 'x'}],
  subs: [{from: 20, to: 100, text: 'x'}],
}, null, 1), 'utf8');
writeFileSync(join(PROJ, 'scene.json'), JSON.stringify({
  shots: [
    {type: 'title', at: 1, title: 'clip demo'},
    {type: 'clip', at: 20, clip: 'broll', heading: '片段素材'},
  ],
}, null, 1), 'utf8');

// 抽帧（host 侧）
const proj = await loadProject(PROJ);
const prepped = await prepareClips(PROJ, [{name: 'broll', src: '/assets/broll.mp4', seq: false, fps: 30, width: 320, start: 0, maxSec: 0}],
  {cacheRoot: join(PROJ, '.work', 'clips')});
console.log('抽帧:', JSON.stringify(prepped.clips.broll));

const server = await serveProject(PROJ, {
  raw: proj.raw, timeline: proj.timeline, shotsRel: null, scene: proj.scene, clips: prepped.clips,
});
const base = `http://127.0.0.1:${server.address().port}/`;
const sess = await openSession(base, {width: 1280, height: 720});

const hash = (b) => createHash('sha256').update(b).digest('hex').slice(0, 12);
const save = (b, n) => { const f = join(PROJ, `out${n}.png`); writeFileSync(f, b); return f; };

let bad = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) bad++; };

console.log('\n=== 1) 片段帧能取到并画出（随帧号变化 = 真的在播）===');
const f30 = await sess.frame(30);
const f60 = await sess.frame(60);
const f90 = await sess.frame(90);
console.log('  f30', hash(f30), '| f60', hash(f60), '| f90', hash(f90));
ok(!f30.equals(f60), 'f30 与 f60 不同（片段在播放，不是静止图）');
ok(!f60.equals(f90), 'f60 与 f90 不同');

console.log('\n=== 2) 确定性：同一帧取两次逐字节相同（不变量未破）===');
const a = await sess.frame(45);
const b = await sess.frame(45);
ok(a.equals(b), '同一全局帧两次渲染逐字节相同');

console.log('\n=== 3) 源帧映射：页面内直接查 clipFrame 与 sourceIndex ===');
const probe = await sess.evaluate(`(async () => {
  const clips = await import('/kit/runtime/clips.js');
  const out = [];
  for (const n of [20, 21, 50, 100, 200]) {
    const idx = clips.sourceIndex(n, {frames: 60, fps: 30}, 30, 20);
    const im = (() => { try { return clips.clipFrame('broll', n, {from: 20, fps: 30}); } catch (e) { return 'ERR:' + e.message.slice(0, 40); } })();
    out.push({n, idx, ok: typeof im !== 'string', src: typeof im === 'string' ? im : im.src.split('/').pop()});
  }
  return JSON.stringify(out);
})()`);
const rows = JSON.parse(probe);
console.log('  全局帧 → 源帧下标 / 文件名：');
for (const r of rows) console.log(`    n=${String(r.n).padStart(3)} → idx ${String(r.idx).padStart(2)} ${r.ok ? '✓' : '✗'} ${r.src}`);
ok(rows.every((r) => r.ok), '所有帧都能同步取到（已预解码）');
ok(rows.find((r) => r.n === 20).idx === 0, 'n=20（镜头首帧）→ 源第 1 帧');
ok(rows.find((r) => r.n === 50).idx === 30, 'n=50（1 秒后）→ 源第 31 帧');
ok(rows.find((r) => r.n === 200).idx === 59, 'n=200（超出片段）→ 夹到最后一帧（60 帧的片段）');

console.log('\n=== 4) 负面对照：引用未声明的片段要抛错 ===');
const neg = await sess.evaluate(`(async () => {
  const clips = await import('/kit/runtime/clips.js');
  try { clips.clipFrame('nope', 30); return 'NO_ERROR'; }
  catch (e) { return e.message.slice(0, 120); }
})()`);
console.log('  ', neg);
ok(neg.includes('没有名为') && neg.includes('broll'), '报错并列出已声明的片段');

await sess.close();
server.closeProject();
console.log(bad === 0 ? '\n✓ 片段素材端到端全部符合预期' : `\n✗ ${bad} 项失败`);
console.log('（渲染出的帧在', PROJ, '，可人工查看）');
process.exit(bad ? 1 : 0);
