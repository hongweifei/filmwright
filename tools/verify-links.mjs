// 文档内部链接守卫：所有 `](相对路径)` 都要指向**存在的文件**。
//
//   node tools/verify-links.mjs [<仓库根>]
//
// 为什么需要：文档里的相对链接是**最容易悄悄腐烂**的东西之一 ——
// 文件改名/移动之后，链接不会报错，只会 404。而这一类没有任何现有检查覆盖
// （`verify-docs` 核数字与事实性说法，核不到链接）。
//
// 加上这个工具时实测：入库的 .md **全部链接有效**。
// 现在没有坏链不代表以后没有 —— 它的价值是**以后改文件名时会立刻红**。
//
// 它自己带两条「必须会红」的守卫：
//   ① 下限：扫到 0 个 .md 或 0 条内部链接即失败 —— 空集上的「全部有效」不是有效；
//   ② 内建负面对照：在**临时仓库根**里真放一条坏链，要求它退出码 1 并指出
//      「哪份文档、第几行、哪条链接」；把缺陷改回去必须重新变绿（证明红是缺陷造成的）。
//      ⚠️ 只在系统临时目录里造缺陷，**从不改真源码**，跑完自己删干净。
//      ⚠️ 子进程会再次执行本文件 ⇒ 用 FW_VERIFY_LINKS_NESTED 挡住递归。
import {existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {execFileSync, spawnSync} from 'node:child_process';
import {dirname, join, relative, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const argv = process.argv.slice(2);
const ROOT = resolve(argv[0] && !argv[0].startsWith('--') ? argv[0] : join(HERE, '..'));

// ⚠️ 只扫**入库的** .md（与 verify-docs 一致）：本机未入库的草稿不该影响结论。
const tracked = (() => {
  try {
    return execFileSync('git', ['ls-files', '*.md'], {cwd: ROOT, encoding: 'utf8'})
      .split('\n').map((s) => s.trim()).filter(Boolean).map((p) => join(ROOT, p));
  } catch { return null; }
})();
const docs = tracked ?? (() => {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, {withFileTypes: true})) {
      const q = join(d, e.name);
      if (e.isDirectory()) { if (!['node_modules', '.git', '.work'].includes(e.name)) walk(q); }
      else if (e.name.endsWith('.md')) out.push(q);
    }
  };
  walk(ROOT);
  return out;
})();

const bad = [];
/** 所有被链接指到的**绝对路径** —— 反方向判据（「文档资产有没有人引用」）要用。 */
const referenced = new Set();
let total = 0;
for (const d of docs) {
  const text = readFileSync(d, 'utf8');
  // ⚠️ **反引号里的「链接写法」不是链接**：文档会写「所有 `](相对路径)` 都要指向存在的文件」
  // 来描述这条规则本身。实测踩过：`tools/README.md` 这么写之后，本工具报
  // 「tools/README.md:71 → 相对路径 不存在」—— 守卫把自己的说明书当成了被守卫的东西。
  // 用**等长空白**替换行内代码段：字符串长度不变 ⇒ 下面按 `m.index` 算的行号仍然对。
  const scanned = text.replace(/`[^`\n]*`/g, (s) => ' '.repeat(s.length));
  for (const m of scanned.matchAll(/\]\(([^)\s]+)\)/g)) {
    const href = m[1];
    if (/^(https?:|mailto:|#)/.test(href)) continue;   // 外链与页内锚点不管
    const clean = href.split('#')[0];
    if (!clean) continue;
    total++;
    // `%20` 这类转义要解回文件名再查；解不开（`%zz` 之类）就按原样查 ——
    // 否则整轮会以 URIError 崩掉，报不出「哪份文档、哪一行、哪条链接」。
    let target = clean;
    try { target = decodeURIComponent(clean); } catch { /* 保持原样 */ }
    const abs = resolve(dirname(d), target);
    referenced.add(abs);
    if (!existsSync(abs)) {
      bad.push({doc: relative(ROOT, d).replace(/\\/g, '/'), href,
        line: text.slice(0, m.index).split('\n').length});
    }
  }
}
console.log(`扫了 ${docs.length} 个 .md，${total} 条内部链接`);
if (!bad.length) console.log(total ? '✓ 全部指向存在的文件' : '（一条链接都没扫到，这一轮算不上通过）');
else {
  console.log(`\n✗ ${bad.length} 条链接指向不存在的文件（改文件名时最容易漏）：`);
  for (const b of bad) console.log(`   ${b.doc}:${b.line}  → ${b.href}`);
}

// ── 反方向：`docs/` 下的**非文档文件**必须被某份文档引用 ────────────────────────
// 上面那条只查「链接指向的文件在不在」，查不出「文件没人指向」—— 反方向得单独查。
// 起因（实测）：`docs/images/promo-flow.png` 与 `promo-steps.png`（共 920 kB）全仓零引用，
// 还跟着 `files` 里的 `docs` 一起发到 npm；而**当时这一类没有任何守卫**，
// 是人工 `git grep` 才发现的。删掉之后补上这条，免得再攒。
const docsDir = join(ROOT, 'docs');
const docAssets = [];
if (existsSync(docsDir)) {
  (function walk(d) {
    for (const e of readdirSync(d, {withFileTypes: true})) {
      const q = join(d, e.name);
      if (e.isDirectory()) walk(q);
      else if (!e.name.endsWith('.md')) docAssets.push(q);
    }
  })(docsDir);
}
const orphans = docAssets.filter((p) => !referenced.has(p));
if (orphans.length) {
  console.log(`\n✗ ${orphans.length} 个文档资产没人引用（还会跟着 files 里的 docs 一起发到 npm）：`);
  for (const p of orphans) console.log('   ' + relative(ROOT, p).replace(/\\/g, '/'));
  console.log('   ⇒ 要么在某份文档里引用它，要么删掉（历史里还找得到）。');
}

// ── 下限断言：空集上不许说自己「全部有效」──────────────────────────────────
// 枚举一旦坏掉（拿不到 git、路径写错、根指错），上面那段一条链接都扫不到，
// 却照样印「✓ 全部指向存在的文件」并退出 0 —— 那是个永远绿的检查。
const NO_DOCS = '一个 .md 都没扫到';
const NO_LINKS = '一条内部链接都没扫到';
let vacuous = false;
if (!docs.length) {
  vacuous = true;
  console.log(`\n✗ ${NO_DOCS} —— 枚举坏了？空集上的「全部有效」不是有效。`);
} else if (!total) {
  vacuous = true;
  console.log(`\n✗ ${NO_LINKS} —— 同上，别让它空转还恒绿。`);
}

// ── 内建负面对照：在**临时仓库根**里真造缺陷，要求本工具红 ────────────────────
//   ① 夹具链接全有效 ⇒ 必须绿（并报出与夹具声明相符的扫描量）
//   ② 把一条链指向不存在的文件 ⇒ 必须红，且红得**具体**：哪份文档、第几行、哪条链接
//   ③ 把缺陷改回去 ⇒ 必须重新绿 —— 证明 ② 的红是那条缺陷造成的，不是别的东西
//   ④ 一个 .md 都没有的根 ⇒ 必须红（这是上面那条下限断言的对照）
//   ⑤ 解不开的 `%` 转义 ⇒ 必须报出这条链接，而不是抛 URIError 崩掉
// 全程只碰 os.tmpdir() 下的临时根，**从不改真源码**，跑完在 finally 里删干净。
// 代价：本机实测这一段约 2.2s（5 次子进程 + 临时仓库里的 git 调用），正常扫描本身 0.24s。
//     ⚠️ try/finally 挡不住 SIGINT/SIGTERM（见 verify-incremental 的教训）；
//     真要中途被杀，残留只在系统临时目录里，无害。
let selfFailed = 0;
const ok = (cond, label) => {
  console.log(`${cond ? '✓' : '✗'} ${label}`);
  if (!cond) selfFailed++;
};

if (process.env.FW_VERIFY_LINKS_NESTED === '1') {
  console.log('\n（子进程：跳过内建负面对照，由父进程统一判定）');
} else {
  console.log('\n=== 内建负面对照：临时根里真放坏链，要求它红 ===');
  let base = null;
  const logs = [];
  try {
    base = mkdtempSync(join(tmpdir(), 'fw-verify-links-'));
    const repo = join(base, 'repo');
    const empty = join(base, 'empty');
    mkdirSync(repo, {recursive: true});
    mkdirSync(empty, {recursive: true});

    // 夹具：`internal` 是**这份夹具自己声明的**内部链接条数（外链与页内锚点不算）。
    // 期望值从这份声明算，不从实现反推 —— 免得不小心把实现的漏算当成正确答案。
    const FIXTURE = {
      'README.md': {internal: 1, text: '# 夹具根\n\n[目标文件](target.md)\n'},
      'target.md': {internal: 0, text: '# 目标文件\n'},
      'docs/guide.md': {
        // 4 条内部链接：../target.md、child.md、../data/thing.json、a%20b.md
        // （另有外链 https://example.com/x.md 与页内锚点 #小节 各 1 条，按设计不算）
        // ⚠️ 末行是**反引号包起来**的「链接写法示例」—— 行内代码不是链接。
        // 计数仍写 4：实现若把它算进去，下面「扫描量」的断言当场红。
        internal: 4,
        text: ['# 指南',
          '[根上的目标](../target.md)',
          '[同目录](child.md)',
          '[非 md 目标](../data/thing.json)',
          '[转义空格](a%20b.md)',
          '[外链](https://example.com/x.md)',
          '[页内锚点](#小节)',
          '行内代码里的写法示例不算链接：`](相对路径)`',
          ''].join('\n'),
      },
      'docs/child.md': {internal: 0, text: '# 子页\n'},
      'docs/a b.md': {internal: 0, text: '# 文件名里有空格（由 a%20b.md 指过来）\n'},
      'data/thing.json': {internal: 0, text: '{"ok":true}\n'},   // 目标可以不是 .md
    };
    const expectDocs = Object.keys(FIXTURE).filter((p) => p.endsWith('.md')).length;
    const expectLinks = Object.values(FIXTURE).reduce((n, f) => n + f.internal, 0);
    const GUIDE = FIXTURE['docs/guide.md'].text;

    for (const [p, f] of Object.entries(FIXTURE)) {
      const abs = join(repo, p);
      mkdirSync(dirname(abs), {recursive: true});
      writeFileSync(abs, f.text);
    }

    // 让临时根成为**它自己的**仓库（CI 用的就是 git 那条枚举路径）；列不出夹具就删掉
    // .git 退回「遍历」路径。没有 git 时两条路都仍是遍历 ⇒ 结论一样是确定的。
    const git = (args, d) => {
      try {
        return execFileSync('git', args, {cwd: d, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});
      } catch { return null; }
    };
    const isolate = (d, minMd) => {
      git(['init', '-q'], d);
      const added = git(['add', '-A'], d);
      const listed = added === null ? null : git(['ls-files', '*.md'], d);
      // git 那条路的结果对不上（add 失败 / 列不出夹具）就删掉 .git，退回遍历路径。
      if (listed === null || listed.split('\n').filter(Boolean).length < minMd) {
        rmSync(join(d, '.git'), {recursive: true, force: true});
      }
    };
    isolate(repo, expectDocs);
    isolate(empty, 0);

    const env = {...process.env, FW_VERIFY_LINKS_NESTED: '1', GIT_CEILING_DIRECTORIES: base};
    for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[k];
    const rc = (r) => (r.error ? `spawn 失败（${r.error.message}）` : `退出码 ${r.status}`);
    const runTool = (root, tag) => {
      const r = spawnSync(process.execPath, [SELF, root], {encoding: 'utf8', env});
      logs.push(`[${tag}] ${rc(r)}\n${r.stdout ?? ''}${r.stderr ?? ''}`);
      return r;
    };
    const summary = (out) => {
      const m = (out ?? '').match(/扫了 (\d+) 个 \.md，(\d+) 条内部链接/);
      return m ? {docs: Number(m[1]), links: Number(m[2])} : null;
    };
    const badCount = (out) => {
      const m = (out ?? '').match(/✗ (\d+) 条链接指向不存在的文件/);
      return m ? Number(m[1]) : null;
    };

    // ① 正例：夹具里每条链接都指向存在的文件
    let r = runTool(repo, '①');
    let s = summary(r.stdout);
    ok(r.status === 0, `① 夹具链接全有效 ⇒ 退出码 0（实际 ${rc(r)}）`);
    ok(s !== null && s.docs === expectDocs && s.links === expectLinks,
      `① 扫描量与夹具声明相符：${expectDocs} 个 .md / ${expectLinks} 条内部链接` +
      `（实际 ${s ? `${s.docs} / ${s.links}` : '解析不出摘要'}）`);

    // ② 负面对照：第 3 行的 child.md 改成不存在的文件
    const guideFile = join(repo, 'docs/guide.md');
    writeFileSync(guideFile, GUIDE.replace('[同目录](child.md)', '[同目录](missing-child.md)'));
    r = runTool(repo, '②');
    s = summary(r.stdout);
    ok(r.status === 1, `② 把一条链指向不存在的文件 ⇒ 退出码 1（实际 ${rc(r)}）`);
    ok(badCount(r.stdout) === 1, `② 只报这 1 条坏链（实际 ${badCount(r.stdout) ?? '一条都没报'} 条）`);
    ok((r.stdout ?? '').includes('docs/guide.md:3') && (r.stdout ?? '').includes('missing-child.md'),
      '② 红得具体：报出 docs/guide.md:3 → missing-child.md');
    ok(s !== null && s.links === expectLinks,
      `② 坏链不该让扫描量缩水（仍应是 ${expectLinks} 条）`);

    // ③ 把缺陷改回去：必须重新绿
    writeFileSync(guideFile, GUIDE);
    r = runTool(repo, '③');
    ok(r.status === 0, `③ 缺陷改回去 ⇒ 重新绿（实际 ${rc(r)}）—— 证明 ② 的红是那条缺陷造成的`);

    // ④ 下限断言的对照：一个 .md 都没有的根
    r = runTool(empty, '④');
    ok(r.status === 1 && (r.stdout ?? '').includes(NO_DOCS),
      `④ 扫到 0 个 .md 的根 ⇒ 必须红，不许印「全部有效」（实际 ${rc(r)}）`);

    // ⑤ 解不开的转义：必须报出这条链接，不许抛 URIError
    writeFileSync(guideFile, `${GUIDE}[坏转义](bad%zz.md)\n`);
    r = runTool(repo, '⑤');
    s = summary(r.stdout);
    const out5 = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    ok(r.status === 1 && out5.includes('bad%zz.md') && out5.includes('docs/guide.md')
      && !out5.includes('URIError'),
    `⑤ 解不开的 % 转义 ⇒ 报出这条链接、不许崩 URIError（实际 ${rc(r)}）`);
    ok(s !== null && s.links === expectLinks + 1,
      `⑤ 这条坏链仍该被计入扫描量（${expectLinks} + 1 条）`);

    // ⑥ 反方向：`docs/` 下的资产**没人引用** ⇒ 必须红（这一条原先没有守卫）
    writeFileSync(guideFile, GUIDE);            // 先把 ⑤ 的坏转义还原
    const orphan = join(repo, 'docs/images/orphan.png');
    mkdirSync(dirname(orphan), {recursive: true});
    writeFileSync(orphan, 'not really a png\n');
    r = runTool(repo, '⑥');
    ok(r.status === 1 && (r.stdout ?? '').includes('docs/images/orphan.png'),
      `⑥ docs/ 下的资产没人引用 ⇒ 退出码 1 并点名它（实际 ${rc(r)}）`);
    rmSync(join(repo, 'docs/images'), {recursive: true, force: true});
    r = runTool(repo, '⑥b');
    ok(r.status === 0,
      `⑥ 把它删掉 ⇒ 重新绿（实际 ${rc(r)}）—— 证明上面那条红是它造成的`);

    if (selfFailed) {
      console.log('\n—— 子进程原始输出（便于定位）——');
      for (const l of logs) console.log(l.split('\n').map((x) => `   ${x}`).join('\n'));
    }
    console.log(selfFailed === 0
      ? '负面对照全部符合预期（正例绿 / 坏链红且报出位置 / 改回去回绿 / 空根红 / 坏转义报出 / 孤儿资产红）。'
      : `\n✗ ${selfFailed} 条负面对照不符合预期。`);
  } catch (e) {
    ok(false, `负面对照自己出错（不许静默跳过）：${e && e.message}`);
  } finally {
    if (base) rmSync(base, {recursive: true, force: true});
  }
}

// 用 exitCode 而不是 process.exit()：管道里的 stdout 是异步刷的，硬退出会截断输出。
process.exitCode = (bad.length || orphans.length || vacuous || selfFailed) ? 1 : 0;
