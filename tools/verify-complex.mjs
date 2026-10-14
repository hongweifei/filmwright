// 四项复杂制作能力**同时使用**的端到端验收。
//
//   node tools/verify-complex.mjs [<仓库根>]
//
// 单测各测各的，四者协作才是真考验。这个夹具把四条路径串起来：
//   ① 图层合成：镜头 / 子镜头带 transform（位移 + 旋转 + alpha + blend）
//   ② 嵌套合成：comps 定义子合成，comp 实例循环播放，且在子合成里再用 transform
//   ③ 素材管线：clip 模板按源帧取图，并与 ①② 的变换叠加
//   ④ 增量重渲 + 代理：先代理半分辨率快速出预览，再全分辨率出片；
//      第二次跑必须全部复用（帧数据一致）
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {dirname, resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = (process.argv[2] ?? resolve(HERE, '..')).replace(/\\/g, '/');
const KIT = `${ROOT}/bin/filmwright.mjs`;
const P = `${ROOT}/.work/complex-proj`;

let bad = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) bad++; };

// ---------- 建夹具项目 ----------
rmSync(P, {recursive: true, force: true});
mkdirSync(join(P, 'public', 'assets', 'fonts'), {recursive: true});
mkdirSync(join(P, 'script'), {recursive: true});
mkdirSync(join(P, 'shots'), {recursive: true});

// 抄示例的字体（渲染要字体）
const srcEx = `${ROOT}/examples/scenecast`;
const cfgSrc = readFileSync(`${srcEx}/film.config.mjs`, 'utf8');
for (const f of cfgSrc.match(/fonts\/[^'"]+/g) ?? []) {
  spawnSync('cmd', ['/c', 'copy', join(srcEx, 'public', f).replace(/\//g, '\\'),
    join(P, 'public', f).replace(/\//g, '\\')], {stdio: 'ignore'});
}

// 造一段视频（③ 的输入）
spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi',
  '-i', 'testsrc2=size=320x180:rate=30:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
  join(P, 'public', 'assets', 'broll.mp4')], {stdio: 'ignore'});

// theme 给全（缺键会让内建件崩）
const theme = `{
    bg: '#080B14', bgDeep: '#050710', panel: '#101725', panelHi: '#182136',
    line: '#22304A', lineSoft: '#182238', text: '#E9F0FA', dim: '#8B99B4',
    faint: '#5A677F', codeBg: '#0C1220', termBg: '#05080F',
    ok: '#35D07F', bad: '#FF6B6B', hi: '#F5B942',
    accents: ['#3FA7FF', '#35D07F', '#F5B942'],
  }`;
writeFileSync(join(P, 'film.config.mjs'), `export default {
  slug: 'complex', size: {width: 1280, height: 720}, fps: 30,
  theme: ${theme},
  clips: [{name: 'broll', src: 'assets/broll.mp4', fps: 30, width: 320}],
};\n`, 'utf8');

writeFileSync(join(P, 'script', 'timeline.json'), JSON.stringify({
  fps: 30, total_frames: 200,
  sentences: [
    {id: 'S01', chapter: 1, from: 20, to: 90, text: '图层与嵌套'},
    {id: 'S02', chapter: 1, from: 100, to: 180, text: '素材与增量'},
  ],
  subs: [
    {from: 20, to: 55, text: '图层与'},
    {from: 55, to: 90, text: '嵌套'},
    {from: 100, to: 140, text: '素材与'},
    {from: 140, to: 180, text: '增量'},
  ],
}, null, 1), 'utf8');

// scene：四种能力全用上
writeFileSync(join(P, 'scene.json'), JSON.stringify({
  comps: {
    // ② 子合成：内部再带 ① 的 transform（嵌套 + 变换叠加）
    badge: {
      frames: 40,
      shots: [
        {type: 'stat', at: 1, value: 81, label: 'ms', transform: {x: 0, rotate: -6, alpha: 0.9}},
        {type: 'chips', at: 21, items: ['嵌套', '循环'], transform: {y: 30, blend: 'screen'}},
      ],
    },
  },
  shots: [
    // ① 图层合成：位移 + 旋转 + 组透明度 + 混合模式
    {type: 'title', at: 1, title: '复杂制作验收',
     transform: {y: -20, scale: 0.95, rotate: 2, alpha: 0.95, blend: 'screen'}},
    // ② 嵌套合成：循环实例（周期 40，实例 90 帧）
    {type: 'comp', at: 'S01', comp: 'badge', loop: true, frames: 70,
     transform: {x: 40, alpha: 0.9}},
    // ③ 素材管线 + ① 变换
    {type: 'clip', at: 'S02', clip: 'broll', heading: '素材管线',
     fit: 'cover', transform: {rotate: -2, alpha: 0.95}},
  ],
}, null, 1), 'utf8');

console.log('夹具项目:', P);

// ---------- 静态自检（能拦住配置/规格错误）----------
console.log('\n=== 1) 静态自检：四能力混合的规格合法 ===');
{
  const r = spawnSync('node', [KIT, 'check', '--project', P, '--static-only', '--json'],
    {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024});
  let j = null; try { j = JSON.parse(r.stdout); } catch {}
  ok(j?.ok === true, `静态自检应通过（${j?.errors?.length ?? '?'} 个错误）` +
    (j?.ok ? '' : '：' + JSON.stringify(j?.errors ?? String(r.stderr).slice(-200))));
}

// ---------- ③ 抽帧 ----------
console.log('\n=== 2) 素材管线：抽帧 + 内容寻址缓存 ===');
{
  const r1 = spawnSync('node', [KIT, 'clips', '--project', P, '--json'], {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024});
  const j1 = JSON.parse(r1.stdout);
  ok(j1.ok && j1.data.extracted === 1 && j1.data.clips.broll.frames === 90,
    `首次应抽 90 帧（extracted=${j1.data?.extracted}, frames=${j1.data?.clips?.broll?.frames}）`);
  const r2 = spawnSync('node', [KIT, 'clips', '--project', P, '--json'], {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024});
  const j2 = JSON.parse(r2.stdout);
  ok(j2.data.cached === 1, `第二次应命中缓存（cached=${j2.data?.cached}）`);
}

// ---------- ④ 代理渲染（快速预览）----------
console.log('\n=== 3) 代理渲染：半分辨率 ===');
const proxyOut = join(P, '.work', 'proxy.mp4');
{
  const t0 = Date.now();
  const r = spawnSync('node', [KIT, 'render', '--project', P, '--from', '1', '--to', '200',
    '--proxy', '0.5', '--out', proxyOut], {encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe']});
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  ok(r.status === 0 && existsSync(proxyOut), `代理渲染成功（${secs}s）`);
  const p = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', proxyOut],
    {encoding: 'utf8'});
  ok(String(p.stdout).trim().startsWith('640,360'), `代理分辨率 640×360（实际 ${String(p.stdout).trim()}）`);
}

// ---------- ④ 增量重渲（全分辨率）----------
console.log('\n=== 4) 增量重渲：首次全渲 → 二次全复用 ===');
const fullOut = join(P, '.work', 'full.mp4');
const inc = (extra = []) => {
  const r = spawnSync('node', [KIT, 'render', '--project', P, '--from', '1', '--to', '200',
    '--out', fullOut, '--incremental', '--json', ...extra], {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024});
  let d = null; try { d = JSON.parse(r.stdout).data; } catch {}
  return {status: r.status, data: d, err: String(r.stderr).slice(-300)};
};
{
  const r1 = inc();
  ok(r1.status === 0 && r1.data.renderedSegments >= 1,
    `首次全渲（segments=${r1.data?.segments}, rendered=${r1.data?.renderedSegments}, reused=${r1.data?.reusedSegments}）` +
    (r1.status === 0 ? '' : '：' + r1.err));
  const r2 = inc();
  ok(r2.data?.reusedSegments === r1.data?.segments && r2.data?.renderedSegments === 0,
    `二次应全部复用（reused=${r2.data?.reusedSegments}/${r2.data?.segments}）`);

  // 帧数据一致性（复用产物 vs 全新重渲）
  const ff = (mp4) => {
    const dir = join(P, '.work', `ff-${Date.now()}`);
    mkdirSync(dir, {recursive: true});
    spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', mp4, join(dir, 'f%04d.png')], {stdio: 'ignore'});
    const h = createHash('sha256');
    for (const f of readdirSync(dir).sort()) h.update(readFileSync(join(dir, f)));
    rmSync(dir, {recursive: true, force: true});
    return h.digest('hex').slice(0, 16);
  };
  const reuseHash = ff(fullOut);
  // 删掉段缓存强制全新重渲
  rmSync(join(P, '.work', 'segments'), {recursive: true, force: true});
  rmSync(fullOut, {force: true});
  const r3 = inc();
  ok(r3.data?.renderedSegments >= 1, '清掉缓存后应重渲');
  const freshHash = ff(fullOut);
  ok(reuseHash === freshHash, `复用产物与全新重渲逐帧一致（${reuseHash} vs ${freshHash}）`);
}

// ---------- ① ② 真的改变了画面 ----------
console.log('\n=== 5) 图层合成与嵌套合成确实作用于画面 ===');
{
  const stillsOf = (mutate, tag) => {
    const scenePath = join(P, 'scene.json');
    const orig = readFileSync(scenePath, 'utf8');
    const s = JSON.parse(orig);
    mutate(s);
    writeFileSync(scenePath, JSON.stringify(s, null, 1), 'utf8');
    const dir = join(P, '.work', `st-${tag}`);
    // 探针帧必须落在**被改动能力所在镜头的区间**里：
    //   title 在第 1–19 帧、comp 实例在 20–89、clip 在 100 帧之后
    // 早先只用 120/150/180，全落在 clip 区间 —— 于是「嵌套合成改变了画面」是假失败。
    spawnSync('node', [KIT, 'stills', '--project', P, '--frames', '5,25,45,60,80,120,180', '--dir', dir],
      {encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe']});
    writeFileSync(scenePath, orig, 'utf8');
    return readdirSync(dir).sort().map((f) => createHash('sha256').update(readFileSync(join(dir, f))).digest('hex').slice(0, 10));
  };

  const base = stillsOf(() => {}, 'base');
  const noTransform = stillsOf((s) => { for (const sh of s.shots) delete sh.transform; }, 'notf');
  ok(base.length === 7, `取了 7 帧（实际 ${base.length}）`);
  ok(JSON.stringify(base) !== JSON.stringify(noTransform), '① 图层变换改变了画面');

  // ② 只把 comp 镜头换掉，看 20–89 区间是否变化
  const noComp = stillsOf((s) => { s.shots[1] = {type: 'title', at: 'S01', title: '替代'}; }, 'nocomp');
  const compFrames = [1, 2, 3, 4];   // 帧 5,25,45,60（索引 0..3）落在 comp 区间
  const changedInComp = compFrames.some((i) => base[i] !== noComp[i]);
  ok(changedInComp, '② 嵌套合成改变了画面（comp 区间内）');

  // ③ 只把 clip 镜头换掉，看 120/180 是否变化
  const noClip = stillsOf((s) => { s.shots[2] = {type: 'title', at: 'S02', title: '替代'}; }, 'noclip');
  const clipFrames = [5, 6];         // 帧 120,180
  const changedInClip = clipFrames.some((i) => base[i] !== noClip[i]);
  ok(changedInClip, '③ 素材片段改变了画面（clip 区间内）');
}

console.log(bad === 0 ? '\n✓ 四项能力协作验收全部通过' : `\n✗ ${bad} 项失败`);
console.log('（夹具与产物在', P, '，可人工查看；脚本结束时会清理）');
rmSync(P, {recursive: true, force: true});
process.exit(bad ? 1 : 0);
