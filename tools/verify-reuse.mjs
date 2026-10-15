// 验收「换分辨率」与「换浏览器」两条可复用性主张。
//
//   node tools/verify-reuse.mjs
//
// 这一版的核心是**补上真断言**：早先的版本把 `A.equals(B)` 算出来只拼进日志，
// 全程 console.log、没有比较、没有 process.exit —— 任何输入都过，等于没有守卫。
// 现在三条判据都进退出码：
//
//   ① 换分辨率：产物**自身**的宽高必须等于配置里的分辨率
//      （期望值由 normalizeConfig 从配置算出，不写死 1920×1080）
//   ② 换浏览器：同一帧在两个**不同**浏览器里出的 PNG 必须逐字节相同；
//      找不到第二个浏览器就**显式跳过且不计通过**（打印原因，并说清怎么让它跑起来）
//   ③ 负面对照：把期望换成一个**不存在的分辨率**，①的判据必须当场报错
//      —— 一个永远绿的检查不是检查
import {execFileSync} from 'node:child_process';
import {mkdirSync, readFileSync, rmSync} from 'node:fs';
import {basename, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadProject} from '../src/host/project/load.mjs';
import {renderStills} from '../src/host/media/renderRange.mjs';
import {normalizeConfig} from '../src/contract/config.js';
import {ffmpegPath, ffprobePath} from '../src/host/media/ffmpegBin.mjs';
import {findBrowser} from '../src/host/browser/find.mjs';

// 根从脚本自身位置推：仓库里不许出现机器路径（CI 不带参数跑，也不靠 argv 兜底）。
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROJ = join(ROOT, 'examples', 'minimal');
const OUT = join(ROOT, '.work', 'qc', 'reuse');

let bad = 0;
let skipped = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) bad++; };
const skip = (m) => { console.log(`○ 跳过（不计通过）：${m}`); skipped++; };
const line = (c = '─') => console.log(c.repeat(76));

/**
 * 读产物自身的宽高。
 *
 * ffprobe 的 csv 输出**随版本变**（实测有的版本给 "1596," 这种带尾随逗号的写法），
 * 所以这里**提取**两个整数，不做整体 `Number()`；原文一并带回日志，出问题一眼可见。
 */
function probeSize(file) {
  const raw = execFileSync(ffprobePath(),
    ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file],
    {encoding: 'utf8'}).trim();
  const m = /(\d+)\D+(\d+)/.exec(raw);
  if (!m) throw new Error(`ffprobe 读不出分辨率（原文 ${JSON.stringify(raw)}）：${file}`);
  return {file, raw, width: Number(m[1]), height: Number(m[2])};
}

/** 判据本体：返回与期望不符的产物。空数组 = 全对。 */
const sizeMismatch = (probed, want) =>
  probed.filter((p) => p.width !== want.width || p.height !== want.height);

/** 两个浏览器同一帧字节不同时，再往下解一层：画面真的不同，还是只是 PNG 编码不同。 */
function pixelNote(a, b) {
  try {
    const rgb = (f) => execFileSync(ffmpegPath(),
      ['-v', 'error', '-i', f, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
      {maxBuffer: 1 << 28});
    const x = rgb(a);
    const y = rgb(b);
    if (x.length !== y.length) return `（解码后长度也不等：${x.length} vs ${y.length}）`;
    let n = 0;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) n++;
    return n === 0
      ? '（解码后逐像素相同 ⇒ 差的只是 PNG 编码，不是画面）'
      : `（解码后也差 ${n}/${x.length} 字节 ⇒ 画面本身就不同）`;
  } catch (e) {
    return `（像素级诊断没跑成：${String(e?.message ?? e).split('\n')[0]}）`;
  }
}

line('═');
console.log('可复用性验收：换分辨率 / 换浏览器\n');

const proj = await loadProject(PROJ);
const total = proj.timeline?.total_frames;
if (!(total > 0)) {
  ok(false, `时间轴里没有帧数（total_frames=${JSON.stringify(total)}）—— 采样帧只从数据算，不写死帧号`);
  process.exit(1);
}
// 采样帧按时间轴长度取若干分位，**不写死帧号**：夹具的长度变了就跟着变，不至于变成假警报。
const frames = [...new Set([0.02, 0.16, 0.44, 0.72]
  .map((t) => Math.min(total, Math.max(1, Math.round(total * t)))))];
mkdirSync(OUT, {recursive: true});

// ── ① 换分辨率 ──────────────────────────────────────────────────────────────
const BIG = {width: 1920, height: 1080};
const bigProj = {...proj, raw: {...proj.raw, size: {...BIG}}};
const wantBig = normalizeConfig(bigProj.raw).size;   // 期望值从**实现归一化后的配置**读
const wantOwn = normalizeConfig(proj.raw).size;
const bigDir = join(OUT, 'big');
rmSync(bigDir, {recursive: true, force: true});
const bigFiles = await renderStills(PROJ, bigProj, frames, bigDir);
console.log(`① 换分辨率：${wantOwn.width}×${wantOwn.height} → ${wantBig.width}×${wantBig.height}，采样帧 ${frames.join(' / ')}\n`);

ok(bigFiles.length === frames.length && bigFiles.length > 0,
  `渲染出 ${bigFiles.length}/${frames.length} 张静帧（空集不算通过）`);
// 这条防的是「判据在本夹具上恒真」：夹具若本来就是目标分辨率，换不换都看不出来。
ok(wantBig.width !== wantOwn.width || wantBig.height !== wantOwn.height,
  `新分辨率确实不同于项目原分辨率（${wantOwn.width}×${wantOwn.height}）—— 否则这条判据恒真`);

const probedBig = bigFiles.map(probeSize);
for (const p of probedBig) {
  console.log(`    ${basename(p.file)}  ffprobe=${JSON.stringify(p.raw)} → ${p.width}×${p.height}`);
}
const missed = sizeMismatch(probedBig, wantBig);
ok(missed.length === 0,
  `产物分辨率 == 配置分辨率 ${wantBig.width}×${wantBig.height}（${probedBig.length - missed.length}/${probedBig.length} 张相符）`);
for (const p of missed) console.log(`    ✗ ${basename(p.file)} 实际是 ${p.width}×${p.height}，不是配置里的分辨率`);

// ── ①的负面对照：故意喂错的期望，判据必须全部报错 ────────────────────────────
// 期望值从产物算出来（而不是写死某个数字）。**两个方向各来一次**（只错宽 / 只错高），
// 这样「只比了一个维度」的假判据也会被抓出来；只要它还报「全对」，上面那条就是恒绿的。
for (const c of [
  {label: '只错宽', want: {width: wantBig.width + 1, height: wantBig.height}},
  {label: '只错高', want: {width: wantBig.width, height: wantBig.height + 1}},
]) {
  const negHit = sizeMismatch(probedBig, c.want);
  ok(negHit.length === probedBig.length && probedBig.length > 0,
    `负面对照（${c.label}）：期望 ${c.want.width}×${c.want.height}，而产物是 ${wantBig.width}×${wantBig.height}`
    + ` —— 判据必须全部报错（报了 ${negHit.length}/${probedBig.length}）`);
}

// ── ② 换浏览器 ──────────────────────────────────────────────────────────────
// 浏览器一律走 find.mjs 定位（它自己优先读 CHROME_BIN，源码注释写着「测试要用不同的
// 浏览器时靠它」）。工具里**不写任何机器路径** —— 早先那版写死了 Edge 的安装路径，
// 换台机器就是静默跳过，谁也不知道这条轴没在跑。
const locate = (label, explicit) => {
  try { return {label, path: findBrowser(explicit)}; }
  catch (e) { return {label, err: String(e?.message ?? e).split('\n')[0]}; }
};
/** 摘掉 CHROME_BIN 之后再问 find.mjs 一次，拿到的是「系统默认」那个。 */
function withoutChromeBin(fn) {
  const saved = process.env.CHROME_BIN;
  delete process.env.CHROME_BIN;
  try { return fn(); } finally { if (saved !== undefined) process.env.CHROME_BIN = saved; }
}
const sys = withoutChromeBin(() => locate('系统默认'));
const envB = process.env.CHROME_BIN
  ? locate('CHROME_BIN', process.env.CHROME_BIN)
  : {label: 'CHROME_BIN', err: '没设置'};
const pair = [];
for (const c of [sys, envB]) if (c.path && !pair.some((p) => p.path === c.path)) pair.push(c);

console.log('\n② 换浏览器（同帧 PNG 必须逐字节相同）');
console.log(`    系统默认（find.mjs 自动检测）：${sys.path ?? sys.err}`);
console.log(`    CHROME_BIN：${envB.path ?? envB.err}`);
if (pair.length < 2) {
  skip('这条轴要两个**不同**的浏览器可执行文件；只找到 '
    + `${pair.length} 个` + (pair.length ? `（${pair.map((p) => p.label + '=' + p.path).join('，')}）` : '')
    + '。定位走 src/host/browser/find.mjs（CHROME_BIN 优先），工具里没有机器路径可退；'
    + '要跑这条轴，用 CHROME_BIN 指向另一个浏览器再跑一次（如系统装的是 Edge，就指一个 Chrome）。');
} else {
  const [A, B] = pair;
  console.log(`    A ${A.label} → ${A.path}`);
  console.log(`    B ${B.label} → ${B.path}\n`);
  const dirA = join(OUT, 'browser-a');
  const dirB = join(OUT, 'browser-b');
  rmSync(dirA, {recursive: true, force: true});
  rmSync(dirB, {recursive: true, force: true});
  const filesA = await renderStills(PROJ, proj, frames, dirA, {browser: A.path});
  const filesB = await renderStills(PROJ, proj, frames, dirB, {browser: B.path});
  ok(filesA.length === filesB.length && filesA.length > 0,
    `两边各出了 ${filesA.length}/${filesB.length} 张同帧 PNG（空集不算通过）`);
  let diff = 0;
  for (let i = 0; i < Math.min(filesA.length, filesB.length); i++) {
    const x = readFileSync(filesA[i]);
    const y = readFileSync(filesB[i]);
    if (x.equals(y)) { console.log(`    ✓ ${basename(filesA[i])} 逐字节相同（${x.length} 字节）`); continue; }
    diff++;
    console.log(`    ✗ ${basename(filesA[i])} 不同（${x.length} vs ${y.length} 字节）${pixelNote(filesA[i], filesB[i])}`);
  }
  ok(diff === 0 && filesA.length > 0,
    `换浏览器：${filesA.length - diff}/${filesA.length} 帧逐字节相同`);
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
line('═');
if (bad === 0) {
  console.log(skipped
    ? `✓ 已跑的判据全过（${skipped} 项**跳过、未计通过**）`
    : '✓ 换分辨率与换浏览器两条主张都成立');
} else {
  console.log(`✗ ${bad} 项失败`);
}
process.exit(bad ? 1 : 0);
