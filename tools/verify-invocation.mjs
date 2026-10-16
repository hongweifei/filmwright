// 守卫「同一个根因换个位置又回来」的两类问题（这两类各让 CI 红过一次以上）。
//
//   node tools/verify-invocation.mjs [<仓库根>] [--no-selftest]
//
// ## 检查一：CI 怎么调这些工具，它们就得怎么活
//
// CI 里很多步骤是**不带参数**跑的（`node tools/verify-clips.mjs`），
// 而工具里若写着 `resolve(process.argv[2])`，`undefined` 会直接抛
// `ERR_INVALID_ARG_TYPE`。**本地我一直带参数跑，所以从没触发** ——
// 这个差异让 CI 红了两次（先 1 个工具，修完又发现另外 3 个）。
//
// 规则：CI 里出现的每个 `tools/*.mjs`，它的 ROOT 定义必须有兜底
// （`??` / `||` / `startsWith('--'` / `fileURLToPath(import.meta.url)` / `process.cwd()`），
// 或者建在**本文件里早先定义**的自身路径别名上（`const SELF = fileURLToPath(import.meta.url)`
// 之后 `resolve(dirname(SELF), '..')`）—— 那同样与 argv 无关，**不该报「没有兜底」**。
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
//
// ## 检查三：下限（空集恒绿不是绿）
//
// 检查一若扫到 0 个 CI 调用、检查二若扫到 0 个 src 文件，两条规则都会**空转还恒绿**。
// 所以 —— `ci.yml` 不存在 / 一个 `tools/*.mjs` 都没扫到 / 一个工具的 ROOT 定义都没读到 /
// `src/` 不存在或没有 `.mjs`·`.js` 文件 —— 一律计失败。
//
// ## 自检：本工具**自己的**负面对照（每次运行都跑，`--no-selftest` 除外）
//
// 上面三条判据本身也可能恒真，所以本文件带自己的负面对照：在**系统临时目录**里现造一个
// 「仓库根」，先造**干净夹具**（要求 0 问题），再每次只植入**一个**缺陷造 mutant
// （空引用 / ROOT 无兜底 / EBUSY 未容忍，外加「自身路径别名」合法与不合法两个方向），
// 要求对应判据**只红它自己那一条**；最后把三条缺陷同时植入，用**子进程跑完整 CLI**，要求退出码非 0 且三类问题都出现在 stdout
// —— 判据落在 CI 真正消费的东西：**退出码**。夹具跑完即删（`finally`），**不碰真实源码**。
// 自检不过 ⇒ 本工具自己退出码非 0（免得负面对照自己变成一条永远绿的检查）。
// `--no-selftest` 只给自检里的子进程用（不带就会递归）。
import {readFileSync, readdirSync, existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {join, relative, resolve, dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const argv = process.argv.slice(2);
const ROOT = resolve(argv[0] && !argv[0].startsWith('--') ? argv[0] : join(HERE, '..'));
const SELFTEST = !argv.includes('--no-selftest');

/**
 * 检查二的已知项（键 `相对路径 readFileSync(路径表达式)`）。加进来必须写理由。
 *
 * ⚠️ 下面 9 处**读的都是用户项目文件**（`shots/index.js` / `timeline.json` / 静态自检
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
]);

const SAFE = /(\?\?|\|\||startsWith\('--'\)|fileURLToPath\(import\.meta\.url\)|process\.cwd\(\))/;

// ROOT 也可能建在本文件早先定义的**自身路径别名**上（`tools/verify-preview.mjs` 现在就是）：
//   const SELF = fileURLToPath(import.meta.url);
//   const ROOT = resolve(dirname(SELF), '..');
// 别名自己 SAFE、且 ROOT 真的引用了它 ⇒ 与 argv 无关（比 `?? process.cwd()` 还稳），
// 旧版只看 ROOT 那一行 ⇒ 对它**误报「没有兜底」**。⚠️ 只豁免「别名被 ROOT 引用」这一种：
// 文件里定义了别名、ROOT 却仍写 `resolve(process.argv[2])` 的，照样红（自检里两组 mutant 各证一个方向）。
const SELF_ALIAS = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*fileURLToPath\(import\.meta\.url\)/m;
const hasFallback = (src, expr) => {
  if (SAFE.test(expr)) return true;
  const alias = src.match(SELF_ALIAS);
  return !!alias && new RegExp(`\\b${alias[1]}\\b`).test(expr);
};

/**
 * 检查一 + 检查三（扫描量下限）：CI 引用的每个工具都得在、且 ROOT 有兜底。
 * 返回 `{tools, inspected, problems}`；`inspected` = 真读到 `const ROOT = ` 的工具数。
 */
function scanCi(root) {
  const ciPath = join(root, '.github', 'workflows', 'ci.yml');
  if (!existsSync(ciPath)) {
    return {tools: [], inspected: 0, problems: [
      'CI 工作流文件不存在（.github/workflows/ci.yml）—— 扫不到调用时这条检查恒绿',
    ]};
  }
  const ci = readFileSync(ciPath, 'utf8');
  const tools = [...new Set([...ci.matchAll(/node\s+tools\/([\w.-]+\.mjs)/g)].map((m) => m[1]))];
  const problems = [];
  if (!tools.length) {
    problems.push('CI 里一个 node tools/*.mjs 都没扫到 —— 空集上的「调用安全」不是安全');
  }
  let inspected = 0;
  for (const name of tools) {
    const p = join(root, 'tools', name);
    if (!existsSync(p)) { problems.push(`CI 里引用了不存在的工具：tools/${name}`); continue; }
    const src = readFileSync(p, 'utf8');
    const m = src.match(/^const ROOT = ([^\n]+)/m);
    if (!m) continue;                       // 不用 ROOT 的工具（如 run-python-tests）不适用
    inspected++;
    if (!hasFallback(src, m[1])) {
      problems.push(`tools/${name} 的 ROOT 没有兜底 —— CI 不带参数跑会抛 `
        + `ERR_INVALID_ARG_TYPE：${m[1].trim()}`);
    }
  }
  if (tools.length && inspected === 0) {
    problems.push(`CI 引用了 ${tools.length} 个工具，却一个 ROOT 定义都没读到 —— `
      + '规则退化成空转（`const ROOT = ` 这个写法变了吗？）');
  }
  return {tools, inspected, problems};
}

/**
 * 检查二 + 检查三（扫描量下限）：`existsSync(X)` 之后紧跟 `readFileSync(X)`、且近处不容忍 EBUSY。
 * 返回 `{files, found, newOnes, stale, problems}`。
 */
function scanReads(root, known) {
  const srcDir = join(root, 'src');
  if (!existsSync(srcDir)) {
    return {files: 0, found: new Set(), newOnes: [], stale: [], problems: [
      'src/ 目录不存在 —— 扫不到文件时「没有新增」当然成立',
    ]};
  }
  const srcFiles = [];
  const walk = (d) => {
    for (const e of readdirSync(d, {withFileTypes: true})) {
      const q = join(d, e.name);
      if (e.isDirectory()) { if (!['node_modules', '.git', '.work'].includes(e.name)) walk(q); }
      else if (/\.(mjs|js)$/.test(e.name)) srcFiles.push(q);
    }
  };
  walk(srcDir);
  const problems = [];
  if (!srcFiles.length) {
    problems.push('src/ 下没扫到任何 .mjs / .js 文件 —— 空集上的「没有新增」不是没有新增');
  }

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
        found.add(`${relative(root, f).replace(/\\/g, '/')} readFileSync(${key})`);
        break;
      }
    });
  }

  return {
    files: srcFiles.length,
    found,
    newOnes: [...found].filter((k) => !known.has(k)),
    stale: [...known.keys()].filter((k) => !found.has(k)),
    problems,
  };
}

// ── 自检：夹具 ────────────────────────────────────────────────────────────────
// 夹具里的 `tools/*.mjs` 与 `src/*.mjs` **只被正则读取、从不执行**，所以不必真能跑通。
const FIX_CI = [
  'name: fixture',
  'on: [push]',
  'jobs:',
  '  fixture:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - run: node tools/fixture-alpha.mjs',
  '      - run: node tools/fixture-beta.mjs',
].join('\n');
const FIX_TOOL_OK = 'const ROOT = resolve(process.argv[2] ?? process.cwd());\nexport const root = ROOT;\n';
const FIX_TOOL_NOFALLBACK = 'const ROOT = resolve(process.argv[2]);\nexport const root = ROOT;\n';
const FIX_TOOL_SELFALIAS = 'const SELF = fileURLToPath(import.meta.url);\n'
  + "const ROOT = resolve(dirname(SELF), '..');\nexport const root = ROOT;\n";
const FIX_TOOL_SELFALIAS_ARGV = 'const SELF = fileURLToPath(import.meta.url);\n'
  + 'const ROOT = resolve(process.argv[2]);\nexport const root = ROOT;\n';
const FIX_READ_OK = [
  "import {existsSync, readFileSync} from 'node:fs';",
  '',
  'export function load(projFile) {',
  '  if (!existsSync(projFile)) return null;',
  '  try {',
  "    return readFileSync(projFile, 'utf8');",
  '  } catch (e) {',
  "    if (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES') return null;",
  '    throw e;',
  '  }',
  '}',
  '',
].join('\n');
const FIX_READ_RAW = [
  "import {existsSync, readFileSync} from 'node:fs';",
  '',
  'export function load(projFile) {',
  '  if (!existsSync(projFile)) return null;',
  "  return readFileSync(projFile, 'utf8');",
  '}',
  '',
].join('\n');

/**
 * 按缺陷造夹具；`opts` 缺省即干净夹具。
 *   ghost：多引用一个不存在的工具
 *   beta：'ok' | 'nofallback'（ROOT 直接用 argv[2]）| 'selfalias'（自身路径别名，合法）| 'selfalias-argv'（有别名但仍用 argv[2]）
 *   read：'ok' | 'raw'（readFileSync 不容忍 EBUSY）
 */
function writeFixture(dir, opts = {}) {
  const {ghost = false, beta = 'ok', read = 'ok'} = opts;
  const betaSrc = {
    ok: FIX_TOOL_OK,
    nofallback: FIX_TOOL_NOFALLBACK,
    selfalias: FIX_TOOL_SELFALIAS,
    'selfalias-argv': FIX_TOOL_SELFALIAS_ARGV,
  }[beta];
  mkdirSync(join(dir, '.github', 'workflows'), {recursive: true});
  mkdirSync(join(dir, 'tools'), {recursive: true});
  mkdirSync(join(dir, 'src', 'fixture'), {recursive: true});
  writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'),
    FIX_CI + (ghost ? '\n      - run: node tools/fixture-ghost.mjs' : '') + '\n');
  writeFileSync(join(dir, 'tools', 'fixture-alpha.mjs'), FIX_TOOL_OK);
  writeFileSync(join(dir, 'tools', 'fixture-beta.mjs'), betaSrc);
  writeFileSync(join(dir, 'src', 'fixture', 'load.mjs'), read === 'raw' ? FIX_READ_RAW : FIX_READ_OK);
}

/**
 * 负面对照本体：夹具在系统临时目录里现造、跑完即删，**绝不碰真实源码**。
 * 返回 `{lines, fails}`；任何一条不成立都算本工具失败。
 */
function selfTest() {
  const lines = [];
  let fails = 0;
  const t = (ok, msg) => { lines.push((ok ? '  ✓ ' : '  ✗ ') + msg); if (!ok) fails++; };
  const tmp = mkdtempSync(join(tmpdir(), 'fw-invocation-selftest-'));
  try {
    // ① 干净夹具：判据必须全绿（否则是误报）
    const clean = join(tmp, 'clean');
    writeFixture(clean);
    const c1 = scanCi(clean), c2 = scanReads(clean, new Map());
    t(c1.problems.length === 0 && c2.problems.length === 0,
      `干净夹具：0 处问题（扫到 ${c1.tools.length} 个 CI 调用 / ${c1.inspected} 个 ROOT / ${c2.files} 个 src 文件）`);
    t(c2.newOnes.length === 0, '干净夹具：「存在就直读」0 处新增');

    // ② mutant：每次只植入一个缺陷 ⇒ 对应的判据只红它自己那一条
    const ghost = join(tmp, 'ghost');
    writeFixture(ghost, {ghost: true});
    const g1 = scanCi(ghost), g2 = scanReads(ghost, new Map());
    t(g1.problems.length === 1 && g1.problems[0].includes('tools/fixture-ghost.mjs'),
      `缺陷·空引用：检出「${g1.problems[0] ?? '（没检出！）'}」`);
    t(g2.newOnes.length === 0, '缺陷·空引用：没有牵连检查二');

    const nofall = join(tmp, 'nofallback');
    writeFixture(nofall, {beta: 'nofallback'});
    const n1 = scanCi(nofall);
    t(n1.problems.length === 1 && n1.problems[0].includes('没有兜底'),
      `缺陷·ROOT 无兜底：检出「${(n1.problems[0] ?? '（没检出！）').split('\n')[0]}」`);
    t(!n1.problems.some((p) => p.includes('不存在')), '缺陷·ROOT 无兜底：没有误报空引用');

    // ②′ 自身路径别名两个方向：合法的那种必须**不报**；有别名却仍用 argv[2] 的必须**报**
    const aliasOk = join(tmp, 'selfalias-ok');
    writeFixture(aliasOk, {beta: 'selfalias'});
    const a1 = scanCi(aliasOk);
    t(a1.problems.length === 0,
      `别名·合法（ROOT = resolve(dirname(SELF), '..')）：不报「没有兜底」（实际 ${a1.problems.length} 处）`);

    const aliasBad = join(tmp, 'selfalias-argv');
    writeFixture(aliasBad, {beta: 'selfalias-argv'});
    const a2 = scanCi(aliasBad);
    t(a2.problems.length === 1 && a2.problems[0].includes('没有兜底'),
      '别名·有别名却仍用 argv[2]：照样报「没有兜底」（别名不是免死金牌）');

    const raw = join(tmp, 'rawread');
    writeFixture(raw, {read: 'raw'});
    const r1 = scanCi(raw), r2 = scanReads(raw, new Map());
    t(r1.problems.length === 0, '缺陷·EBUSY 未容忍：检查一仍全绿（这个缺陷只属于检查二）');
    t(r2.newOnes.length === 1 && r2.newOnes[0].startsWith('src/fixture/load.mjs ')
      && r2.newOnes[0].endsWith('readFileSync(projFile)'),
      `缺陷·EBUSY 未容忍：检出「${r2.newOnes[0] ?? '（没检出！）'}」`);

    // ③ 端到端：子进程跑**完整 CLI**，判据落在 CI 真正消费的东西 —— 退出码
    const all = join(tmp, 'all');
    writeFixture(all, {ghost: true, beta: 'nofallback', read: 'raw'});
    const run = spawnSync(process.execPath, [SELF, all, '--no-selftest'], {encoding: 'utf8'});
    const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    t(run.status === 1, `端到端：三条缺陷的夹具退出码 ${run.status}（要求 1）`
      + (run.error ? `；spawn 失败：${run.error.message}` : ''));
    for (const [what, needle] of [
      ['空引用', 'tools/fixture-ghost.mjs'],
      ['ROOT 无兜底', '的 ROOT 没有兜底'],
      ['EBUSY 未容忍', 'readFileSync(projFile)'],
    ]) {
      t(out.includes(needle), `端到端：stdout 里报出了「${what}」`);
    }

    // ④ 干净夹具同样走一次完整 CLI：**不得误报**。
    //    ⚠️ 它必然非 0（除非 KNOWN 空了）—— 棘轮名单是**本仓库专属**的，
    //    临时夹具里那几条当然全都「已不再是问题」；这里只断言「红的原因是棘轮，不是误报」。
    const runClean = spawnSync(process.execPath, [SELF, clean, '--no-selftest'], {encoding: 'utf8'});
    const outClean = `${runClean.stdout ?? ''}${runClean.stderr ?? ''}`;
    const wantClean = KNOWN.size ? 1 : 0;
    t(runClean.status === wantClean,
      `端到端：干净夹具退出码 ${runClean.status}（棘轮名单 ${KNOWN.size} 条在临时夹具里必然全 stale ⇒ 期望 ${wantClean}）`);
    t(!outClean.includes('调用安全有问题') && !outClean.includes('**新的**'),
      '端到端：干净夹具没有被误报「调用不安全」或「新出现的存在就直读」');
  } finally {
    rmSync(tmp, {recursive: true, force: true});   // 自包含：临时物跑完即删
  }
  return {lines, fails};
}

// ── 主流程 ────────────────────────────────────────────────────────────────────
const one = scanCi(ROOT);
const two = scanReads(ROOT, KNOWN);

console.log(`检查一：CI 里引用 ${one.tools.length} 个工具（其中 ${one.inspected} 个读到 ROOT 定义）`);
console.log(`检查二：src/ 里 ${two.files} 个文件，命中 ${two.found.size} 处（名单里 ${KNOWN.size} 处）`);
let bad = 0;
if (one.problems.length) {
  bad += one.problems.length;
  console.log(`\n✗ ${one.problems.length} 处调用安全有问题：`);
  for (const p of one.problems) console.log('   ' + p);
}
if (two.problems.length) {
  bad += two.problems.length;
  console.log(`\n✗ ${two.problems.length} 处扫描量下限不满足（空集恒绿）：`);
  for (const p of two.problems) console.log('   ' + p);
}
if (two.newOnes.length) {
  bad += two.newOnes.length;
  console.log(`\n✗ ${two.newOnes.length} 处**新的**"存在就直读"（要么容忍 EBUSY，要么写进 KNOWN 并说明）：`);
  for (const k of two.newOnes) console.log('   ' + k);
}
if (two.stale.length) {
  bad += two.stale.length;
  console.log(`\n✗ ${two.stale.length} 个名单条目已不再是问题（请从 KNOWN 去掉）：`);
  for (const k of two.stale) console.log('   ' + k);
}

if (SELFTEST) {
  console.log('\n自检（本工具**自己的**负面对照：夹具在系统临时目录现造，跑完即删）');
  let st;
  try { st = selfTest(); }
  catch (e) { st = {lines: [`  ✗ 自检抛错：${e.message}`], fails: 1}; }
  for (const l of st.lines) console.log(l);
  bad += st.fails;
  if (st.fails) console.log(`  ✗ 自检 ${st.fails} 条不成立 —— 上面那些判据的区分力不成立`);
}

if (!bad) console.log(`\n✓ CI 调用方式安全；"存在就直读"没有新增${SELFTEST ? '；自检全绿' : ''}`);
process.exit(bad ? 1 : 0);
