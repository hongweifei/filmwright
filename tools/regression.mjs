// 像素回归守卫：抓一组帧的哈希，之后重渲必须逐字节相同。
//
// 用途：**结构调整不该改画面**。重构（搬文件、拆模块、改依赖方向）之后跑一次，
// 全同才说明真的只是搬家；有一帧不同就说明行为被改了。
//
//   node tools/regression.mjs capture --project examples/minimal
//   node tools/regression.mjs verify  --project examples/minimal
//
// 基准存在 <项目>/regression-baseline.json —— **要提交**（它是夹具，几 KB，
// 别人 clone 下来才能做回归）。渲出的帧在 <项目>/.work/ 下，那是产物，不提交。
// 早先把基准放在 .work/ 里一起忽略了，结果谁 clone 都跑不了 verify。
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KIT = join(ROOT, 'bin', 'filmwright.mjs');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  // 给了 `--baseline` 但值为空：**报错**而不是回落到默认。
  // 静默回落会在 CI 上悄悄覆盖入库的本机夹具（实测：windows 的 Git Bash 里
  // $RUNNER_TEMP 可能展开为空，于是 --baseline 变成空值）。
  if (!v || v.startsWith('--')) {
    console.error(`✗ --${name} 需要一个值（收到 ${JSON.stringify(v ?? '')}）`);
    process.exit(2);
  }
  return v;
}

const cmd = process.argv[2];
const projectDir = resolve(arg('project', join(ROOT, 'examples', 'minimal')));
// 默认取几个能覆盖不同层（片头 / 章节卡 / 主体 / 素材 / 配置驱动件 / 片尾）的帧。
//
// f470 是**专门留给素材**的：胶片条从 f412 起才可见，而原来那五帧都不在
// 412–559 里 —— 也就是说新加的 picture() 渲染**没有被回归守卫覆盖到**。
// 加一帧进这个范围，素材绘制的改动才会让 verify 红。
const frames = String(arg('frames', '30,250,470,600,700,1150'))
  .split(',').map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite);

if (!['capture', 'verify'].includes(cmd)) {
  console.error('用法：node tools/regression.mjs <capture|verify> [--project <目录>] [--frames 30,250,...] [--baseline <路径>]');
  process.exit(2);
}

const workDir = join(projectDir, '.work', 'qc');
// 基准放项目根、不进 .work：它是夹具（要提交），不是产物。
// `--baseline <路径>` 可指定别处 —— CI 的「同运行内 capture → verify」用它写临时
// 文件，**不覆盖入库的夹具**（那份是本机夹具，跨 OS 不可比，覆盖它只会制造脏工作区）。
const baseFile = arg('baseline', join(projectDir, 'regression-baseline.json'));
const outDir = join(workDir, 'regression');

mkdirSync(workDir, {recursive: true});
rmSync(outDir, {recursive: true, force: true});

// 渲染失败时**把子进程的输出原样带出来**。
// 用 execFileSync 的默认行为（stdio: 'pipe' 且不打印）会把真因吞掉，
// 只抛一句 "Command failed" —— CI 日志里什么都看不到（实测踩过：
// 「渲染确定性」步骤 5 秒失败，日志里没有任何线索）。
try {
  execFileSync('node', [KIT, 'stills', '--project', projectDir,
    '--frames', frames.join(','), '--dir', outDir], {stdio: 'pipe'});
} catch (e) {
  console.error('✗ 渲染静帧失败（stills 的输出如下）');
  console.error('--- stdout ---\n' + String(e.stdout || '').slice(-3000));
  console.error('--- stderr ---\n' + String(e.stderr || '').slice(-3000));
  process.exit(1);
}

const digest = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const shot = (n) => join(outDir, `f${String(n).padStart(5, '0')}.png`);

if (cmd === 'capture') {
  const data = {};
  for (const n of frames) {
    const p = shot(n);
    if (!existsSync(p)) throw new Error('渲染缺帧：' + p);
    data[n] = digest(p);
  }
  writeFileSync(baseFile, JSON.stringify(data, null, 1), 'utf8');
  console.log(`已存基准（${frames.length} 帧）-> ${baseFile}`);
  for (const n of frames) console.log(`  f${n}  ${data[n].slice(0, 16)}`);
  process.exit(0);
}

if (!existsSync(baseFile)) {
  console.error(`没有基准：${baseFile}\n先跑一次：node tools/regression.mjs capture --project <目录>`);
  process.exit(1);
}
const base = JSON.parse(readFileSync(baseFile, 'utf8'));
const differs = [];
let same = 0;
for (const n of frames) {
  const want = base[n];
  if (!want) { console.log(`  f${n}  基准里没有这一帧，跳过`); continue; }
  const got = digest(shot(n));
  if (got === want) { same++; console.log(`  f${n}  相同  ${got.slice(0, 16)}`); }
  else differs.push([n, got.slice(0, 16), want.slice(0, 16)]);
}

if (differs.length) {
  console.log(`\n✗ ${differs.length}/${frames.length} 帧与基准不同：`);
  for (const [n, got, want] of differs) console.log(`    f${n}  现在 ${got}  基准 ${want}`);
  console.log('\n纯结构调整不该改画面 —— 这些差异要么是故意的（那就重新 capture），要么是 bug。');
  process.exit(1);
}
console.log(`\n✓ ${same} 帧全部与基准逐字节相同`);
