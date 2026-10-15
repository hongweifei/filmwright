// 发布物守卫：npm 包里不许混进**本机的东西**，也不许漏掉**该发的源码**。
//
//   node tools/verify-package.mjs           # CI 方式：先自检规则有牙，再查真实打包清单
//   node tools/verify-package.mjs --list    # 只打印真实清单（排查用）
//
// ## 为什么需要它（两个真实事故，都在本机、而 `git status` 全干净）
//
//   ① `src/host/tts/__pycache__/engines.cpython-314.pyc` 被打进包里。
//      跑过一次 Python 就会留下它，而 `files: ["src"]` 是**目录白名单**，它正好在白名单里。
//   ② 本地未跟踪的设计草稿被打进包里（`files: ["docs"]` 同理）。
//
//   共同点：**「未跟踪」不等于「不会发布」**。git 忽略它，npm 照收 ——
//   `.gitignore` 对 `files` 白名单**无效**（实测：`.gitignore` 覆盖了那个 `.pyc`，包里照样有）。
//
// ## 判据：不问 git「你忽略了什么」，而是问 **「发布物 ⊆ 仓库里跟踪的文件」**
//
//   这条不变式比逐条拉黑名单强：黑名单只挡今天想到的那几种，而
//   **任何**「仓库里没有、本机却有」的东西都不该出现在发布物里 —— 不用列举。
//   反方向也查：`files` 覆盖到的跟踪文件**一个都不许漏**（防 `!` 否定写宽了把真源码排掉）。
//
// ## 为什么要自检（一个永远绿的检查不是检查）
//
//   上面两类事故**只在本机出现**：CI 是干净检出，命中集永远是空集 ——
//   于是这条守卫在 CI 上永远是绿的，**包括规则被改坏的时候**。
//   所以每次运行都先拿**合成清单**喂同一口锅：必须能判出坏清单，也必须能判出
//   「空清单不算干净」（空集上的干净不算干净）。规则没牙，当场红。
import {execFileSync, execSync} from 'node:child_process';
import {existsSync, readdirSync, readFileSync, rmSync, statSync} from 'node:fs';
import {join, relative, resolve, sep, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 已知的「本机产物」及其来路。**只用于把报错写清楚** ——
 * 判定本身靠「发布物 ⊆ 跟踪文件」，不靠这张表。
 */
const KNOWN_JUNK = [
  [/__pycache__|\.pyc$/, 'Python 字节码缓存：本机跑过一次 tts 就有'],
  [/^docs\/design\//, '本地设计草稿：本机有、干净检出没有'],
  [/(^|\/)\.work\//, '渲染中间产物：可随时删'],
  [/(^|\/)renders\//, '成片'],
  [/(^|\/)audio\/cache\//, 'TTS 内容寻址缓存'],
  [/(^|\/)node_modules\//, '依赖：由 package.json 声明'],
  [/\.log$/, '日志'],
  [/\.DS_Store$/, 'macOS 目录元数据'],
  [/\.tgz$/, '打包产物自身'],
];

/**
 * **开发期专用**的目录：它们跟着仓库走，但**永远不该进发布物**。
 * 与 `KNOWN_JUNK` 的区别：那些是「本机产物」（靠「未跟踪」就能识别出来），
 * 这些是**已被 git 跟踪的正经文件** —— 只有 `files` 白名单把它们排除掉才不会进包。
 * 所以得单独钉一条：谁往 `files` 里加了 `tools`，这里当场红。
 */
const NEVER_SHIP = [
  [/^tools\//, '开发工具：跟仓库走，不进发布物'],
  [/^tests\//, '测试：跟仓库走，不进发布物'],
  [/^examples\//, '示例项目：跟仓库走，不进发布物'],
  [/^\.github\//, 'CI 配置：跟仓库走，不进发布物'],
];
const neverShipReason = (f) => NEVER_SHIP.find(([re]) => re.test(f))?.[1];

const reasonFor = (f) => KNOWN_JUNK.find(([re]) => re.test(f))?.[1]
  ?? neverShipReason(f)
  ?? '仓库里没有这个文件（未跟踪）';

/** 判定一份打包清单。**纯函数** —— 自检与真跑吃同一口锅，才不会两套逻辑。 */
function judge(packFiles, required, tracked) {
  const trackedSet = new Set(tracked);
  const packSet = new Set(packFiles);
  // ① 发布物里有仓库不认识的东西 ⇒ 违禁（含本机草稿、字节码、任何未跟踪文件）；
  // ② 开发期专用目录**无论跟踪与否**都不许进包。
  const forbidden = packFiles.filter((f) => !trackedSet.has(f) || neverShipReason(f));
  // files 覆盖到的跟踪文件没进包 ⇒ 漏发（`!` 否定写宽了）
  const missing = required.filter((r) => trackedSet.has(r) && !packSet.has(r));
  return {forbidden, missing};
}

/** 规则自检：拿合成清单证明「会红」，并证明「空清单不算干净」。 */
function selfTest() {
  // `tools/verify-docs.mjs` 故意放进 tracked：这样下面那条只可能因为 NEVER_SHIP 而红，
  // 而不是「未跟踪」那条规则顺手抓到的。
  const tracked = ['src/index.js', 'docs/scene.md', 'tools/verify-docs.mjs'];
  const req = ['src/index.js', 'docs/scene.md'];
  const cases = [
    ['干净清单', ['src/index.js', 'docs/scene.md'], {forbidden: 0, missing: 0}],
    ['混进 Python 字节码', ['src/index.js', 'docs/scene.md', 'src/host/tts/__pycache__/x.pyc'], {forbidden: 1, missing: 0}],
    ['混进未跟踪的本地草稿', ['src/index.js', 'docs/scene.md', 'docs/design/TODO.md'], {forbidden: 1, missing: 0}],
    ['混进任意未跟踪文件（黑名单没列举过）', ['src/index.js', 'docs/scene.md', 'docs/scratch.txt'], {forbidden: 1, missing: 0}],
    ['混进**已跟踪**的开发工具目录', ['src/index.js', 'docs/scene.md', 'tools/verify-docs.mjs'], {forbidden: 1, missing: 0}],
    ['漏掉源码', ['docs/scene.md'], {forbidden: 0, missing: 1}],
    ['空清单', [], {forbidden: 0, missing: 2}],
  ];
  const bad = [];
  for (const [name, files, want] of cases) {
    const got = judge(files, req, tracked);
    const ok = got.forbidden.length === want.forbidden && got.missing.length === want.missing;
    console.log(`   ${ok ? '✓' : '✗'} ${name}：违禁 ${got.forbidden.length} / 缺失 ${got.missing.length}（期望 ${want.forbidden} / ${want.missing}）`);
    if (!ok) bad.push(name);
  }
  return bad;
}

/** 问 npm 要真实清单。输出重定向到临时文件而不是走管道 —— 沙箱下捕获管道会 EPERM。 */
function packList() {
  const tmp = join(tmpdir(), `filmwright-pack-${process.pid}.json`);
  try {
    execSync(`npm pack --dry-run --json > "${tmp}"`, {cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit']});
    const j = JSON.parse(readFileSync(tmp, 'utf8'));
    // npm 各版本形状不一：老版是数组，新版是按包名键的对象
    const entry = Array.isArray(j) ? j[0] : Object.values(j)[0];
    if (!entry || !Array.isArray(entry.files)) {
      throw new Error('npm pack --json 的输出形状不认识（npm 版本变了？）');
    }
    return entry.files.map((f) => f.path.replace(/\\/g, '/'));
  } finally {
    rmSync(tmp, {force: true});
  }
}

/** 仓库里跟踪的文件。判据的另一半 —— 取不到就必须失败，不能让守卫静默放行。 */
function trackedList() {
  const out = execFileSync('git', ['ls-files'], {cwd: ROOT, encoding: 'utf8'});
  return out.split('\n').map((s) => s.trim()).filter(Boolean).map((p) => p.replace(/\\/g, '/'));
}

/** `files` 字段里每个非否定条目，在磁盘上实际有什么（这就是「该进包的」）。 */
function requiredOnDisk(filesField) {
  const out = [];
  const walk = (abs) => {
    for (const e of readdirSync(abs, {withFileTypes: true})) {
      const p = join(abs, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(ROOT, p).split(sep).join('/'));
    }
  };
  for (const entry of filesField) {
    if (entry.startsWith('!')) continue;
    const abs = join(ROOT, entry);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isDirectory()) walk(abs);
    else out.push(entry);
  }
  return out.sort();
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const filesField = Array.isArray(pkg.files) ? pkg.files : [];

console.log('规则自检（合成清单；证明规则有牙，且空清单不算干净）：');
const noTeeth = selfTest();
if (noTeeth.length) {
  console.log(`\n✗ 规则自检未通过：${noTeeth.join('、')} —— 守卫本身坏了，先修它。`);
  process.exit(1);
}

const files = packList();
const tracked = trackedList();
if (process.argv.includes('--list')) {
  console.log(`\n打包清单（${files.length} 个）：`);
  for (const f of files) console.log('   ' + f);
}

const required = requiredOnDisk(filesField);
const {forbidden, missing} = judge(files, required, tracked);

console.log(`\n真实打包清单：${files.length} 个文件；仓库跟踪 ${tracked.length} 个；` +
  `按 package.json 的 files 该有 ${required.length} 个。`);

let bad = 0;
if (!files.length) {
  console.log('✗ 打包清单是空的 —— 空集上的干净不算干净。');
  bad++;
}
if (!tracked.length) {
  console.log('✗ 读不到跟踪文件列表 —— 判据的一半没了，不能算过。');
  bad++;
}
if (forbidden.length) {
  bad += forbidden.length;
  console.log(`\n✗ ${forbidden.length} 个不该进发布物的文件：`);
  for (const f of forbidden) console.log(`   ${f}\n       ${reasonFor(f)}`);
  console.log('   ⇒ 两种来路：**本机产物**（未跟踪）用 `!` 否定条目排除 —— 别指望 .gitignore，');
  console.log('      `files` 是白名单会压过它（实测：被 .gitignore 覆盖的 .pyc 照样进包）；');
  console.log('      **开发期专用目录**（tools / tests / examples / .github）则说明有人往 files 里加了它。');
}
if (missing.length) {
  bad += missing.length;
  console.log(`\n✗ ${missing.length} 个该发的跟踪文件没进包：`);
  for (const f of missing.slice(0, 20)) console.log('   ' + f);
  if (missing.length > 20) console.log(`   …… 还有 ${missing.length - 20} 个`);
  console.log('   ⇒ 多半是 files 里的否定写宽了，把真源码也排除了。');
}
if (!bad) console.log('✓ 发布物干净：只有仓库跟踪的文件，该发的跟踪文件都在');
process.exit(bad ? 1 : 0);
