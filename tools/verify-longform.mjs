// 长片验证：长片长度的渲染还守得住哪几件事。
//
//   node tools/verify-longform.mjs [<仓库根>] [--frames 18000] [--no-big] [--rounds 2]
//
// ## 为什么需要它
//
// 现有最长的示例是 77 秒（2319 帧）。**10 分钟量级从没验证过**：
//   - 单浏览器实例跑几千帧会不会退化（越跑越慢）
//   - 分片并行在长片里是什么表现
//   - 内存会不会涨
//
// ## 什么在这里判、什么只报数
//
//   - **判**：§1 单实例长跑是否退化 —— 同一次运行内**配对**的比值（等长的头段 vs 尾段，
//     交替正反序取中位数）；§3（不带 `--no-big` 时）大规模渲染能否跑完、帧数与产物是否对得上。
//   - **只报数不判定**：§2 的分片加速比、§3 的内存。这两者由**机器**决定（核数 / 可用内存），
//     不是产品正确性 —— 实测同一台机器上内存紧张时 4 片比 1 片慢近一倍。拿它当硬判据，
//     只会让这个工具在别人机器上无故变红。
//   - **已删**（与别处重复、或根本不该判）：增量段缓存规模（`verify-incremental`
//     与 `verify-attribution` 已覆盖）、全分辨率单帧 `< 400ms` 的绝对阈值（与规模无关的
//     机器性能）、以及两处"按实测外推全片耗时"的打印（**外推不是测量**）。
//
// ⚠️ CI 里跑的是 `--frames 1200 --no-big`：§3 整段被跳过 ⇒ **自动跑时唯一的判据是 §1**。
//
// ## 时间预算（第一版栽过的坑）
//
// 第一版这里跑了 **8 轮全片渲染**，40 分钟没跑完就被中止。教训：
// 验证吞吐量的测试自己不能是吞吐瓶颈。所以：
//   - 对比一律用 **代理渲染**（`--proxy`，正是为快速迭代做的）
//   - 真正的大规模渲染只跑**一次**（默认 18000 帧 @ 代理），证明规模上跑得完
import {existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, cpSync} from 'node:fs';
import {spawn, spawnSync} from 'node:child_process';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const ROOT = resolve(argv[0] && !argv[0].startsWith('--') ? argv[0] : resolve(HERE, '..')).replace(/\\/g, '/');
const BIG_FRAMES = Number(argOf('frames', 18000));   // 10 分钟 @30fps
const NO_BIG = argv.includes('--no-big');
const ROUNDS = Math.max(1, Number(argOf('rounds', 2)));   // 配对比较的轮数；>= 2 才有交替正反序
const KIT = join(ROOT, 'bin', 'filmwright.mjs');
const PROJ = join(ROOT, '.work', 'longform');

let bad = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) bad++; };
const say = (m) => console.log(m);
const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

// ---------- 造长片项目 ----------
rmSync(PROJ, {recursive: true, force: true});
mkdirSync(PROJ, {recursive: true});
cpSync(join(ROOT, 'examples', 'scenecast'), PROJ, {recursive: true});
rmSync(join(PROJ, 'audio'), {recursive: true, force: true});
rmSync(join(PROJ, 'renders'), {recursive: true, force: true});
rmSync(join(PROJ, 'public', 'assets', 'scenecast'), {recursive: true, force: true});
rmSync(join(PROJ, 'scene.json'), {force: true});
mkdirSync(join(PROJ, 'shots'), {recursive: true});
// 长片测试用的最简镜头：只画标题与帧号，渲染成本低且确定。
// 导入名要照公开面写（theme as C、view）—— 写成 C / W 会在浏览器里报
// "does not provide an export named ..."（我连错两次）。
writeFileSync(join(PROJ, 'shots', 'index.js'),
  `import {view, theme as C, text, applyDesignScale} from 'filmwright';
export const SHOTS = [
  {start: 1, draw(ctx, n) {
    ctx.save(); applyDesignScale(ctx);
    text(ctx, '长片渲染测试', view.W / 2, 300, {size: 48, weight: 900, color: C.text, align: 'center', baseline: 'middle'});
    text(ctx, '第 ' + n + ' 帧', view.W / 2, 380, {size: 22, family: 'monospace', color: C.faint, align: 'center', baseline: 'middle'});
    ctx.restore();
  }},
];
`, 'utf8');

// 解说词长度按目标帧数反推：夹具每句约 215 帧（实测 scenecast 的密度）
const fps = 30;
const framesPerSent = 215;
const need = Math.max(4, Math.ceil(BIG_FRAMES / framesPerSent));
const lines = [];
for (let i = 1; i <= need; i++) {
  if ((i - 1) % 20 === 0) lines.push(`# CHAPTER ${Math.floor((i - 1) / 20) + 1} 第${Math.floor((i - 1) / 20) + 1}章`);
  lines.push(`这是第 ${i} 句解说词，用来撑起长片测试的时长。|它是第二段字幕。`);
}
writeFileSync(join(PROJ, 'script', 'narration.txt'), lines.join('\n') + '\n', 'utf8');
const mk = spawnSync('node', [join(ROOT, 'tools', 'make-timeline-fixture.mjs'), '--project', PROJ],
  {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024});
if (mk.status !== 0) { console.log('夹具时间轴生成失败:', String(mk.stderr).slice(-300)); process.exit(1); }
const tl = JSON.parse(readFileSync(join(PROJ, 'script', 'timeline.json'), 'utf8'));
const TOTAL = tl.total_frames;
say(`长片项目：${TOTAL} 帧 = ${(TOTAL / fps / 60).toFixed(1)} 分钟，${tl.sentences.length} 句，${tl.chapters.length} 章\n`);

/** 跑一次渲染，返回 {ok, secs, data}。 */
function render(args, label) {
  const t0 = Date.now();
  const r = spawnSync('node', [KIT, 'render', '--project', PROJ, ...args, '--json'], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const secs = (Date.now() - t0) / 1000;
  if (r.status !== 0) {
    say(`  ✗ ${label} 失败（${secs.toFixed(1)}s）：${String(r.stderr || r.stdout).slice(-300)}`);
    return {ok: false, secs};
  }
  let data = null;
  try { data = JSON.parse(r.stdout).data; } catch { /* 非 json */ }
  return {ok: true, secs, data};
}

/** 与本次渲染相关的进程的常驻内存之和（MB）。取不到返回 null —— **不用 0 冒充测量值**。 */
const MEM_MATCH = 'filmwright';   // 渲染子进程（bin/filmwright.mjs）与浏览器实例（user-data-dir 前缀）都带它
function liveMb() {
  if (process.platform === 'win32') {
    const ps = `
$sum = 0; $hit = 0
Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe' OR Name='node.exe'" |
  Where-Object { $_.ProcessId -ne ${process.pid} -and $_.CommandLine -match '${MEM_MATCH}' } |
  ForEach-Object { $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; if ($p) { $sum += $p.WorkingSet64; $hit++ } }
if ($hit -gt 0) { [math]::Round($sum / 1MB, 0) }
`;
    const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], {encoding: 'utf8'});
    const m = r.status === 0 && r.stdout ? String(r.stdout).match(/\d+/) : null;
    return m ? Number(m[0]) : null;
  }
  // Linux / macOS：`ps -eo rss,pid,args`（RSS 单位 KB；表头那行首列不是数字，会自然跳过）。
  const r = spawnSync('ps', ['-eo', 'rss,pid,args'], {encoding: 'utf8'});
  if (r.status !== 0 || !r.stdout) return null;
  let kb = 0, hit = 0;
  for (const line of r.stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m || Number(m[2]) === process.pid) continue;   // 跳过本工具自己
    if (m[3].includes(MEM_MATCH)) { kb += Number(m[1]); hit++; }
  }
  return hit ? Math.round(kb / 1024) : null;
}

// ---------- 1) 单实例长跑会不会退化（判据）----------
// 量法是**同一次运行内的配对比值**，做法照 tools/probes/bench-steady.mjs：
//   a) 区间显式：只比写明的头段与尾段（**脱离区间的 ms/帧没有意义**）；
//   b) 配对：两段在同一个工具进程里跑，不跨运行比（跨时间的绝对数字不可比）；
//   c) 交替正反序：第 1 轮头段先跑、第 2 轮尾段先跑，取中位数 —— 抵消热缓存与负载漂移的顺序效应。
// 两段**等长**，一次性的启动开销在比值里对消（不需要差分法扣启动）。
// 夹具是同一句模板铺满全片的均匀内容 ⇒ 比值 > 1 只能来自"越跑越慢"，不是镜头差异。
say('=== 1) 单实例长跑是否退化：等长的头段 vs 尾段（代理渲染）===');
{
  const seg = Math.min(1500, Math.floor(TOTAL / 4));
  const head = ['头段', 1, seg];
  const tail = ['尾段', TOTAL - seg + 1, TOTAL];
  say(`  头段 ${head[1]}–${head[2]} vs 尾段 ${tail[1]}–${tail[2]}（各 ${seg} 帧，${ROUNDS} 轮交替正反序）`);
  const runs = {头段: [], 尾段: []};
  for (let i = 0; i < ROUNDS; i++) {
    const pair = i % 2 === 0 ? [head, tail] : [tail, head];   // 奇数轮把顺序反过来
    for (const [label, from, to] of pair) {
      const r = render(['--from', String(from), '--to', String(to), '--shards', '1',
        '--proxy', '0.5',
        '--out', join(PROJ, '.work', `p${i}-${label === '头段' ? 'head' : 'tail'}.mp4`)],
      `${label}（第 ${i + 1} 轮）`);
      if (r.ok) runs[label].push(r.secs * 1000 / seg);
      else ok(false, `${label}（第 ${i + 1} 轮）渲染成功`);
    }
  }
  if (runs.头段.length && runs.尾段.length) {
    const a = med(runs.头段), b = med(runs.尾段);
    say(`  每帧：头段 ${a.toFixed(1)}ms，尾段 ${b.toFixed(1)}ms → 尾/头 = ${(b / a).toFixed(2)}`);
    ok(b / a < 1.35, `长片后段没有明显退化（尾/头 ${(b / a).toFixed(2)} < 1.35，同一次运行内配对）`);
  } else {
    ok(false, '头段与尾段都渲成功（缺一侧就无法配对）');
  }
}

// ---------- 2) 分片加速比（只报数，不判定）----------
say('\n=== 2) 分片加速比：同一区间 1 片 vs 4 片（同一次运行内，先 1 片后 4 片）===');
say('  【只报数不判定】分片有没有收益由机器的核数与可用内存决定，不是产品正确性 ——');
say('  实测同一台机器上内存紧张时 4 片比 1 片慢近一倍（每片一个浏览器实例，约 500MB）。');
say('  这里只有"渲染本身失败"计为失败（那是能不能跑的问题，不是快慢的问题）。');
{
  const from = 1, to = Math.min(1600, TOTAL);
  const n = to - from + 1;
  const secs = {};
  for (const shards of [1, 4]) {
    const r = render(['--from', String(from), '--to', String(to), '--shards', String(shards),
      '--proxy', '0.5', '--out', join(PROJ, '.work', `shards${shards}.mp4`)], `shards=${shards}`);
    if (!r.ok) { ok(false, `shards=${shards} 渲染成功`); continue; }
    secs[shards] = r.secs;
    say(`  shards=${shards}：${r.secs.toFixed(1)}s（区间 ${from}–${to}，${(r.secs * 1000 / n).toFixed(1)}ms/帧，含启动）`);
  }
  if (secs[1] && secs[4]) {
    say(`  → 4 片 / 1 片 = ${(secs[1] / secs[4]).toFixed(2)}×（理想 4×；> 1 才说明这台机器上分片有收益）`);
  }
}

// ---------- 3) 规模验证：真跑一次大规模 ----------
say(`\n=== 3) 规模验证：一次渲完 ${BIG_FRAMES} 帧（代理 + 4 片）===`);
if (NO_BIG) {
  say('  （--no-big：跳过大规模渲染，内存也不采样）');
} else {
  const t0 = Date.now();
  const child = spawn('node', [KIT, 'render', '--project', PROJ, '--from', '1', '--to', String(TOTAL),
    '--shards', '4', '--proxy', '0.5', '--out', join(PROJ, '.work', 'big.mp4'), '--json'],
  {stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  // 内存必须在**渲染进行中**采样：进程一退出就什么都量不到了。
  // （旧版是在渲染结束之后调的，那个数字没有意义。）
  // 采样间隔不能太小：Windows 上一次进程查询要起一个 PowerShell（实测约 0.6–1s），
  // 采得太密会跟渲染抢 CPU，把 §3 的耗时也一起弄虚。峰值是慢变量，2s 一次足够。
  const SAMPLE_MS = 2000;
  const peak = {mb: null, n: 0};
  const timer = setInterval(() => {
    const mb = liveMb();
    if (mb === null) return;
    peak.n++;
    if (peak.mb === null || mb > peak.mb) peak.mb = mb;
  }, SAMPLE_MS);
  const status = await new Promise((done) => child.on('close', (code) => done(code)));
  clearInterval(timer);
  const secs = (Date.now() - t0) / 1000;

  if (status !== 0) {
    ok(false, `大规模渲染完成（失败：${String(stderr || stdout).slice(-200)}）`);
  } else {
    let data = null;
    try { data = JSON.parse(stdout).data; } catch { /* 非 json：下面的断言会失败 */ }
    const out = join(PROJ, '.work', 'big.mp4');
    const size = existsSync(out) ? statSync(out).size : 0;
    say(`  ${TOTAL} 帧用 ${secs.toFixed(0)}s（${(secs * 1000 / TOTAL).toFixed(1)}ms/帧），产物 ${(size / 1024 / 1024).toFixed(1)} MB`);
    ok(data?.frames === TOTAL, `帧数正确（${data?.frames}/${TOTAL}）`);
    ok(size > 100000, '产物非空');
  }
  say(peak.mb === null
    ? `  【内存未采样（跳过）】${process.platform} 上取不到匹配进程的 RSS —— 不拿 0 冒充测量值`
    : `  内存峰值 ${peak.mb} MB（渲染进行中采样 ${peak.n} 次，匹配进程 RSS 之和）`);
}

rmSync(PROJ, {recursive: true, force: true});
say(bad === 0 ? '\n✓ 长片渲染全部符合预期' : `\n✗ ${bad} 项失败`);
process.exit(bad ? 1 : 0);
