// 守卫「同一个根因换个位置又回来」的两类问题（这两类各让 CI 红过一次以上）。
//
//   node tools/verify-invocation.mjs [<仓库根>]
//
// ## 检查一：CI 怎么调这些工具，它们就得怎么活
//
// CI 里很多步骤是**不带参数**跑的（`node tools/verify-clips.mjs`），
// 而工具里若写着 `resolve(process.argv[2])`，`undefined` 会直接抛
// `ERR_INVALID_ARG_TYPE`。**本地我一直带参数跑，所以从没触发** ——
// 这个差异让 CI 红了两次（先 1 个工具，修完又发现另外 3 个）。
//
// 规则：CI 里出现的每个 `tools/*.mjs`，它的 ROOT 定义必须有兜底
// （`??` / `||` / `startsWith('--')` / `fileURLToPath(import.meta.url)` / `process.cwd()`）。
//
// ## 检查二：`existsSync` 为真 ≠ 能读
//
// Windows 上另一个进程（Chrome）可能**正持有句柄**：文件存在、`readFileSync` 却抛
// `EBUSY`。把它当失败抛出去，整个会话就挂了 —— 其实只是"还没就绪"。
// 实测在 `DevToolsActivePort` 上红过，而**同一类 EBUSY 在 `close()` 里早就处理过**
// （修在了"遇到的那一处"，没修在"这一类"）。
//
// 规则：`existsSync(X)` 之后紧跟 `readFileSync(X)` 的地方，读要么包在 try/catch 里
// 且容忍 EBUSY，要么显式记进下面的 KNOWN（写理由）。**棘轮**：新出现就红。
import {readFileSync, readdirSync, existsSync} from 'node:fs';
import {join, relative, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const ROOT = resolve(argv[0] && !argv[0].startsWith('--') ? argv[0] : join(HERE, '..'));

/**
 * 检查二的已知项（键 `相对路径 readFileSync(路径表达式)`）。加进来必须写理由。
 *
 * ⚠️ 下面 10 处**读的都是用户项目文件**（`scene.json` / `timeline.json` / 静态自检
 * 扫的源码）—— 那些文件**不会被别的进程同时写**，所以 EBUSY 实际上不会发生。
 * 真正有风险的是**由子进程写、我们随后读**的文件（如 Chrome 的 `DevToolsActivePort`、
 * 临时 profile），那一类必须容忍 EBUSY（已在 `session.mjs` 里做）。
 * 这个名单的作用是：**新出现**的"存在就直读"必须被审一遍，判断它属于哪一类。
 */
const KNOWN = new Map([
  ['src/host/checks/static/index.mjs readFileSync(apiFile)', '用户项目源码，非跨进程写'],
  ['src/host/checks/static/index.mjs readFileSync(shotsDir)', '用户项目目录，非跨进程写'],
  ['src/host/checks/static/index.mjs readFileSync(d)', '用户项目目录，非跨进程写'],
  ['src/host/checks/static/index.mjs readFileSync(p)', '用户项目文件，非跨进程写'],
  ['src/host/media/incremental.mjs readFileSync(d)', '本地增量缓存，同进程写'],
  ['src/host/media/incremental.mjs readFileSync(shotsPath)', '用户项目文件，非跨进程写'],
  ['src/host/media/incremental.mjs readFileSync(meta)', '本地增量缓存，同进程写'],
  ['src/host/media/srt.mjs readFileSync(path)', '用户项目时间轴，非跨进程写'],
  ['src/host/project/load.mjs readFileSync(p.timeline)', '用户项目文件，非跨进程写'],
  ['src/host/project/load.mjs readFileSync(p.scene)', '用户项目文件，非跨进程写'],
]);

const problems = [];

// ── 检查一 ──
const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
const ciTools = [...new Set([...ci.matchAll(/node\s+tools\/([\w.-]+\.mjs)/g)].map((m) => m[1]))];
const SAFE = /(\?\?|\|\||startsWith\('--'\)|fileURLToPath\(import\.meta\.url\)|process\.cwd\(\))/;
for (const name of ciTools) {
  const p = join(ROOT, 'tools', name);
  if (!existsSync(p)) { problems.push(`CI 里引用了不存在的工具：tools/${name}`); continue; }
  const src = readFileSync(p, 'utf8');
  const m = src.match(/^const ROOT = ([^\n]+)/m);
  if (!m) continue;                       // 不用 ROOT 的工具（如 run-python-tests）不适用
  if (!SAFE.test(m[1])) {
    problems.push(`tools/${name} 的 ROOT 没有兜底 —— CI 不带参数跑会抛 `
      + `ERR_INVALID_ARG_TYPE：${m[1].trim()}`);
  }
}

// ── 检查二（棘轮）──
const srcFiles = [];
const walk = (d) => {
  for (const e of readdirSync(d, {withFileTypes: true})) {
    const q = join(d, e.name);
    if (e.isDirectory()) { if (!['node_modules', '.git', '.work'].includes(e.name)) walk(q); }
    else if (/\.(mjs|js)$/.test(e.name)) srcFiles.push(q);
  }
};
walk(join(ROOT, 'src'));

const found = new Set();
for (const f of srcFiles) {
  const lines = readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const ex = line.match(/existsSync\(([^)]+)\)/);
    if (!ex) return;
    const key = ex[1].trim();
    // 往后看 12 行：同一个键的 readFileSync，且没有被 try/catch 容忍 EBUSY
    for (let j = i + 1; j < Math.min(lines.length, i + 13); j++) {
      if (!lines[j].includes('readFileSync') || !lines[j].includes(key)) continue;
      const near = lines.slice(Math.max(0, i - 4), Math.min(lines.length, j + 14)).join('\n');
      if (/EBUSY/.test(near)) break;      // 已容忍，放过
      found.add(`${relative(ROOT, f).replace(/\\/g, '/')} readFileSync(${key})`);
      break;
    }
  });
}

const newOnes = [...found].filter((k) => !KNOWN.has(k));
const stale = [...KNOWN.keys()].filter((k) => !found.has(k));

// ── 报告 ──
console.log(`检查一：CI 里引用 ${ciTools.length} 个工具`);
console.log(`检查二：src/ 里 ${srcFiles.length} 个文件，命中 ${found.size} 处（名单里 ${KNOWN.size} 处）`);
let bad = 0;
if (problems.length) {
  bad += problems.length;
  console.log(`\n✗ ${problems.length} 处调用安全有问题：`);
  for (const p of problems) console.log('   ' + p);
}
if (newOnes.length) {
  bad += newOnes.length;
  console.log(`\n✗ ${newOnes.length} 处**新的**"存在就直读"（要么容忍 EBUSY，要么写进 KNOWN 并说明）：`);
  for (const k of newOnes) console.log('   ' + k);
}
if (stale.length) {
  bad += stale.length;
  console.log(`\n✗ ${stale.length} 个名单条目已不再是问题（请从 KNOWN 去掉）：`);
  for (const k of stale) console.log('   ' + k);
}
if (!bad) console.log('\n✓ CI 调用方式安全；"存在就直读"没有新增');
process.exit(bad ? 1 : 0);
