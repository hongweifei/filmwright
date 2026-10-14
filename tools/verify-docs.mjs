// 文档一致性：把「实现里的真实数字」与「文档里的说法」对齐。
//
//   node tools/verify-docs.mjs            # 检查（CI 用，不一致就失败）
//   node tools/verify-docs.mjs --fix      # 自动修正数字类说法
//
// ## 为什么需要这个工具
//
// 实测发现 **26 处脱节**：文档说「视频没有内建支持」而 clips 早已实现、
// 说「13 类模板」而实际 15 类、自检道数在七/八/九之间混用（实际 10 道）。
// 对一个开源项目，**文档说谎比功能缺失更伤** —— 使用者按文档做会踩空，
// 而且没人会去核对每个数字。
//
// 所以数字不写死：这个工具从**实现里读事实**，再扫文档里的说法。
// 数字变了而文档没跟上，CI 就会红。
import {readFileSync, readdirSync, writeFileSync, existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join, relative, resolve} from 'node:path';

// resolve() 保证 ROOT 是绝对路径（与其它验收工具一致；相对路径在这里能工作，
// 但统一成绝对路径少一类隐患）。
const ROOT = resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : process.cwd())
  .replace(/\\/g, '/');
const FIX = process.argv.includes('--fix');

// ---------- 从实现里取事实（唯一真相源）----------
function facts() {
  const scene = readFileSync(join(ROOT, 'src/contract/scene.js'), 'utf8');
  const typesBlock = scene.match(/export const SHOT_TYPES = \[([\s\S]*?)\];/)[1];
  // 「N 类模板」必须只数**模板**，不能数容器。
  // SHOT_TYPES 里除了模板还有容器（如 layers —— 它没有自己的内容与 TEMPLATES 条目，
  // 是把别的东西组合起来）。容器在 contract 里用 CONTAINER_TYPES 显式列出。
  // 早先这里直接数 SHOT_TYPES，加了容器之后会把「16 类模板」误判成过期。
  const ctrBlock = scene.match(/export const CONTAINER_TYPES = \[([\s\S]*?)\];/);
  const containerCount = ctrBlock ? (ctrBlock[1].match(/'/g) || []).length / 2 : 0;
  const templateCount = (typesBlock.match(/'/g) || []).length / 2 - containerCount;

  // 自检道数：数 runChecks 里的 results.push。静态那批与浏览器那批分开数，
  // 因为文档里两种说法都有（「N 道自检」指全部，「前 M 道」指静态）。
  const checks = readFileSync(join(ROOT, 'src/host/checks/index.mjs'), 'utf8');
  const beforeStaticOnly = checks.split('if (!staticOnly)')[0];
  const staticCheckCount = (beforeStaticOnly.match(/results\.push\(/g) || []).length;
  const browserChecks = (checks.match(/results\.push\(await check/g) || []).length;
  const checkCount = staticCheckCount + browserChecks;

  const cli = readFileSync(join(ROOT, 'src/host/cli/index.mjs'), 'utf8');
  const commands = [...cli.matchAll(/\['([a-z]+)',\s*'/g)].map((m) => m[1]);

  const mcp = readFileSync(join(ROOT, 'src/host/mcp/server.mjs'), 'utf8');
  const mcpToolCount = (mcp.match(/registerTool\(/g) || []).length;

  const layer = readFileSync(join(ROOT, 'src/runtime/composite/layer.js'), 'utf8');
  const blendModes = (layer.match(/BLEND_MODES = \[([\s\S]*?)\]/)[1].match(/'/g) || []).length / 2;

  const shots = readFileSync(join(ROOT, 'src/runtime/stage/shots.js'), 'utf8');
  const tr = shots.match(/export function normalizeTransition[\s\S]{0,700}/)?.[0] ?? '';
  const transitions = [...new Set([...tr.matchAll(/'(crossfade|fade|slide|wipe|zoom)'/g)].map((m) => m[1]))];

  const hasClips = existsSync(join(ROOT, 'src/host/media/clips.mjs'))
    && existsSync(join(ROOT, 'src/runtime/clips.js'));

  // 单元测试条数：数 `tests/*.test.mjs` 里的 `^test(`。**实测与 `npm test` 报的
  // pass 数完全一致**（365 = 365），所以不必在检查器里跑一遍测试 —— 那是几十秒的开销。
  const testDir = join(ROOT, 'tests');
  const testCount = readdirSync(testDir)
    .filter((f) => /\.test\.mjs$/.test(f))
    .reduce((a, f) => a + (readFileSync(join(testDir, f), 'utf8').match(/^test\(/gm) || []).length, 0);

  // 效果数：从契约的 `EFFECT_TYPES` 读（文档里「N 个效果」会与它比）。
  const fxSrc = readFileSync(join(ROOT, 'src/contract/effects.js'), 'utf8');
  const effectCount = (fxSrc.match(/export const EFFECT_TYPES = \[([\s\S]*?)\]/)[1].match(/'/g) || []).length / 2;

  return {templateCount, checkCount, staticCheckCount, commands, mcpToolCount, blendModes,
    transitions, hasClips, testCount, effectCount};
}

const F = facts();
const CN = {七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12};
const cnNum = (n) => Object.entries(CN).find(([, v]) => v === n)?.[0] ?? String(n);

// ---------- 扫文档 ----------
// ⚠️ 只扫**入库的**文档（用 git ls-files）。原来扫磁盘上的所有 .md，
// 于是本机未入库的草稿（如 `docs/design/`）也被算进来 ——
// 那会让检查结果**依赖本机状态**（CI 干净检出里没有那些文件，数字就对不上），
// 也会让「否定式断言清单」的条数在两处不一致。
// 取不到 git 时回退到扫磁盘（宁可多扫，也不能不扫）。
const DOC_FILES = [];
const tracked = (() => {
  try {
    const out = execFileSync('git', ['ls-files', '*.md'], {cwd: ROOT, encoding: 'utf8'});
    return out.split('\n').map((s) => s.trim()).filter(Boolean).map((p) => join(ROOT, p));
  } catch { return null; }
})();
if (tracked) {
  DOC_FILES.push(...tracked);
} else {
  const walk = (dir) => {
    for (const e of readdirSync(dir, {withFileTypes: true})) {
      if (e.isDirectory()) {
        if (['node_modules', '.git', '.work', 'renders', '__pycache__', 'examples'].includes(e.name)) continue;
        walk(join(dir, e.name));
        continue;
      }
      if (e.name.endsWith('.md')) DOC_FILES.push(join(dir, e.name));
    }
  };
  walk(ROOT);
}

/**
 * 修正规则：每条给出「怎么从错误写法改成正确写法」。
 *
 * 只自动改**数字类**说法（模板数、自检道数）—— 这类有唯一正确答案。
 * 事实性说法（如「视频没有内建支持」）不自动改：那需要重写整段，
 * 让工具猜句子会改出更糟的东西。这类只报出来，由人处理。
 */
const fixes = [
  // 注意：每条规则要说明「哪一组是数字」。用 idx 显式指出来，别靠 m[1] 猜 ——
  // 「前七道」这条里 m[1] 是「前」，靠 m[1] 取数字会得到 NaN 而静默不改
  // （实测：自动修正跑了却漏掉这三处）。
  {re: /(\d+)(\s*)类模板/g, numIdx: 1, want: F.templateCount,
   make: (m) => `${F.templateCount}${m[2]}类模板`, label: '类模板数'},
  {re: /([七八九十])(道自检)/g, numIdx: 1, want: F.checkCount,
   make: (m) => `${cnNum(F.checkCount)}${m[2]}`, label: '自检道数'},
  {re: /(\d+)(道自检)/g, numIdx: 1, want: F.checkCount,
   make: (m) => `${F.checkCount}${m[2]}`, label: '自检道数'},
  {re: /(前)([七八九十])(道)/g, numIdx: 2, want: F.staticCheckCount,
   make: (m) => `${m[1]}${cnNum(F.staticCheckCount)}${m[3]}`, label: '静态自检道数'},
  {re: /(前)(\d+)(道)/g, numIdx: 2, want: F.staticCheckCount,
   make: (m) => `${m[1]}${F.staticCheckCount}${m[3]}`, label: '静态自检道数'},

  // ── 下面两条是这一轮补的：**自然语言里的数字**（此前完全没有守卫）──
  // 这几轮修过的过期数字里至少一半属于这一类（72 个单元测试 / 七道 / 10 个效果 /
  // 九道自检），每次都是**碰巧扫到**。加上之后，漂了就自动红。
  {re: /(\d+)(\s*个单元测试)/g, numIdx: 1, want: F.testCount,
   make: (m) => `${F.testCount}${m[2]}`, label: '单元测试数'},
  {re: /(\d+)(\s*个效果)/g, numIdx: 1, want: F.effectCount,
   make: (m) => `${F.effectCount}${m[2]}`, label: '效果数'},
];

/**
 * 语境豁免：有些行**引述的是历史**而不是断言当前状态。
 *
 * 典型是 CHANGELOG：「修正 26 处脱节：文档说『13 类模板』而实际 15 类」——
 * 这里的「13 类模板」是被引述的错误，不是当前断言。
 * 不豁免的话，记录修复本身的文字会永远让检查变红（实测踩到）。
 */
const QUOTING_CONTEXT = /修正|修复|曾|此前|原来|以前|脱节|不一致|而实际|改为|由.*改成/;

// 事实性说法：只报不改
const FACT_CLAIMS = [
  {re: /视频没有内建支持|不支持视频|视频要自己先抽帧|素材只支持图片/,
   ok: () => !F.hasClips, why: 'clips（视频/图片序列）已实现'},
];

const problems = [];
let fixedCount = 0;

// CHANGELOG 的**已发布区**是历史：那里写着"72 个单元测试"是**当时的事实**，
// 跟着实现改等于篡改历史。所以只检查 `[未发布]` 那一节（及其上方）。
// 判定：找到第一个不是 `[未发布]` 的版本标题行，从那里开始跳过。
const RELEASED_FROM = new Map();
{
  const cl = join(ROOT, 'CHANGELOG.md');
  if (existsSync(cl)) {
    const ls = readFileSync(cl, 'utf8').split('\n');
    const idx = ls.findIndex((l) => /^##\s*\[(?!未发布)/.test(l));
    if (idx >= 0) RELEASED_FROM.set(relative(ROOT, cl).replace(/\\/g, '/'), idx);
  }
}

for (const file of DOC_FILES) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  let text = readFileSync(file, 'utf8');
  const orig = text;
  const lines = text.split('\n');

  lines.forEach((line, i) => {
    // CHANGELOG 的已发布区是**历史**，整段跳过（见上面 RELEASED_FROM 的说明）。
    if (RELEASED_FROM.get(rel) !== undefined && i >= RELEASED_FROM.get(rel)) return;
    // 引述历史的行（CHANGELOG 的修复记录等）跳过：那些是被引述的旧说法，
    // 不是当前断言。判定用「同一行里有修正类动词」这个近似 ——
    // 宁可漏报几行，也不要让记录修复的文字永远报红。
    if (QUOTING_CONTEXT.test(line)) return;
    // 数字类：可自动修
    for (const rule of fixes) {
      for (const m of line.matchAll(rule.re)) {
        // ⚠️ **引号里的数字不能改** —— 那是在**引述旧值**，不是当前断言。
        // 实测踩到：CHANGELOG 里写着「写着「九道自检」（实际十道）」，
        // 自动修正把引号里那个也改成"十道"，变成"写着「十道自检」（实际十道）」——
        // **把一句正确的话改成了错的**。只豁免"引述类动词"不够（那行没有触发词）。
        const before = line.slice(Math.max(0, m.index - 1), m.index);
        const after = line.slice(m.index + m[0].length, m.index + m[0].length + 1);
        const quoted = /[「“『"]/.test(before) || /[」”』"]/.test(after);
        const got = Number(CN[m[rule.numIdx]] ?? m[rule.numIdx]);
        if (quoted || got === rule.want) continue;
        problems.push({
          doc: rel, line: i + 1, kind: 'number', label: rule.label,
          why: `说 ${m[0]}，实际 ${rule.want}`,
          text: line.trim().slice(0, 110),
        });
      }
    }
    // 事实类：只报
    for (const rule of FACT_CLAIMS) {
      if (rule.re.test(line) && !rule.ok()) {
        problems.push({
          doc: rel, line: i + 1, kind: 'claim', label: '事实性说法',
          why: rule.why, text: line.trim().slice(0, 110),
        });
      }
    }
  });

  if (FIX) {
    // 逐行替换（保留缩进与其它内容）
    const out = lines.map((line) => {
      // 引述历史的行不改（同上面的跳过理由）
      if (QUOTING_CONTEXT.test(line)) return line;
      let l = line;
      for (const rule of fixes) {
        // 用 replace 的回调做「只在值不对时替换」，避免把正确数字也重写
        l = l.replace(rule.re, (m0, ...args) => {
          const m = [m0, ...args];
          const got = Number(CN[m[rule.numIdx]] ?? m[rule.numIdx]);
          if (!Number.isFinite(got) || got === rule.want) return m0;
          return rule.make(m);
        });
      }
      return l;
    }).join('\n');
    if (out !== orig) {
      writeFileSync(file, out, 'utf8');
      fixedCount++;
    }
    text = out;
  }
}

// ---------- 验收工具表：自己核，别让它漂 ----------
// docs/qc.md 里那张「哪些验收工具会自动跑」的表是**"哪些守卫真的在跑"的唯一说明**，
// 但它不在上面那几类句式里，所以能悄悄漂（实测漂过：新接进 CI 的工具没进表、
// 计数还停在旧数字）。这里直接拿**实现**核它：工具数来自 tools/ 目录，
// 接入数来自 ci.yml 里出现的文件名。
{
  const toolsDir = join(ROOT, 'tools');
  const toolFiles = readdirSync(toolsDir).filter((f) => /^verify-.*\.mjs$/.test(f));
  const ciText = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const wired = toolFiles.filter((f) => ciText.includes(f));
  const qc = readFileSync(join(ROOT, 'docs', 'qc.md'), 'utf8');
  const m = qc.match(/\*\*(\d+) 个验收工具里 (\d+) 个自动跑/);
  if (!m) {
    problems.push({kind: 'claim', doc: 'docs/qc.md', line: '—', text: '（那句断言不见了）',
      why: '找不到「N 个验收工具里 M 个自动跑」—— 那张表是守卫的唯一说明，不能没有'});
  } else if (Number(m[1]) !== toolFiles.length || Number(m[2]) !== wired.length) {
    problems.push({kind: 'number', doc: 'docs/qc.md', line: '—', text: m[0],
      why: `说 ${m[1]} 个工具里 ${m[2]} 个自动跑，实际 ${toolFiles.length} 个里 ${wired.length} 个`});
  }
  // 接进 CI 的工具必须出现在表里（防漏写）。
  // 按**去掉 .mjs 的名字**匹配：表里两种写法都有（`verify-docs` 与 `verify-effects.mjs`），
  // 拿完整文件名去比会把 `verify-docs` 误报成"没写"。
  for (const f of wired) {
    if (!qc.includes(f.replace(/\.mjs$/, ''))) {
      problems.push({kind: 'claim', doc: 'docs/qc.md', line: '—', text: f,
        why: `${f} 已接进 CI，但那张表里没写它`});
    }
  }
}

// ---------- 否定式断言清单（只列出，不判对错）----------
// 为什么单列这一类：**它们最容易过期**。一条「没有 X / 不支持 X」描述的是一个**否定**，
// 而否定一旦被实现推翻，**没有任何检查会提醒** —— 上面那些数字与事实性说法都核不到
// "这件事其实已经做了"。
//
// 实测：连着两轮随手一扫就找到 5 处过期的否定断言（声明式 3D「只有命令式」、
// 「没有 GPU 加速路径」、base64「先不做」、「81 ms/帧」、「要 SRT 自己导出」）。
//
// ⚠️ 这里**不判对错**：多数否定是**有意的设计声明**（`architecture.md` 的「刻意不做的事」、
// dogfood 的「模板不够用清单」），不该改。自动判"某条否定是否已实现"不现实，
// 但**列出清单是可自动化的** —— 而这正是原来缺的：没人知道一共有多少条。
const NEG = /不支持|没有|还没|尚未|不做|不能|无法|不会/;
const negLines = [];
for (const f of DOC_FILES) {
  const lines = readFileSync(f, 'utf8').split('\n');
  lines.forEach((l, i) => {
    // 跳过纯标题与表格分隔行；保留有实际断言的句子
    if (l.trim().length < 12) return;
    if (/^\s*\|?\s*-{3,}/.test(l)) return;
    if (NEG.test(l)) negLines.push({doc: relative(ROOT, f).replace(/\\/g, '/'), line: i + 1, text: l.trim()});
  });
}
const negByDoc = {};
for (const n of negLines) negByDoc[n.doc] = (negByDoc[n.doc] || 0) + 1;

// ---------- 报告 ----------
console.log('实现事实（唯一真相源）：');
console.log(`  模板 ${F.templateCount} 类 | 自检 ${F.checkCount} 道（静态 ${F.staticCheckCount}） | 命令 ${F.commands.length} 个`);
console.log(`  MCP 工具 ${F.mcpToolCount} 个 | 混合模式 ${F.blendModes} 种 | 转场 ${JSON.stringify(F.transitions)} | clips=${F.hasClips}`);
console.log(`\n扫描了 ${DOC_FILES.length} 个文档文件`);

if (FIX) {
  console.log(`已修正 ${fixedCount} 个文件`);
  process.exit(0);
}

const numbers = problems.filter((p) => p.kind === 'number');
const claims = problems.filter((p) => p.kind === 'claim');
if (numbers.length) {
  console.log(`\n✗ ${numbers.length} 处数字与实现不一致（可跑 --fix 自动修）：`);
  for (const p of numbers) console.log(`   ${p.doc}:${p.line}  ${p.why}\n      > ${p.text}`);
}
if (claims.length) {
  console.log(`\n✗ ${claims.length} 处事实性说法已过时（需人工改写，工具不代改）：`);
  for (const p of claims) console.log(`   ${p.doc}:${p.line}  ${p.why}\n      > ${p.text}`);
}
if (!problems.length) console.log('\n✓ 文档数字与事实性说法都与实现一致');

// 否定式断言清单：**只列出、不判对错**（多数是有意的设计声明）。
// 目的是让"一共有多少条这样的断言"可见 —— 原来没人知道，也就没人定期过一遍。
// 用法：`--list-negative` 打印全部；默认只报数量。
const byDoc = Object.entries(negByDoc).sort((a, b) => b[1] - a[1]);
console.log(`\n否定式断言（不支持/没有/还没/不做…）：${negLines.length} 条，分布在 ${byDoc.length} 个文件`);
console.log('   （只扫**入库的** .md —— 未入库的本地草稿不算，所以本机与 CI 的数字一致）');
if (process.argv.includes('--list-negative')) {
  for (const n of negLines) console.log(`   ${n.doc}:${n.line}  ${n.text.slice(0, 90)}`);
} else {
  console.log('   ' + byDoc.map(([d, n]) => `${d} ${n}`).join(' | '));
  console.log('   ⚠️ 这些**多数是有意的设计声明**（不该改），但否定一旦被实现推翻就没人提醒 ——');
  console.log('      加功能后请过一遍：node tools/verify-docs.mjs --list-negative');
}
process.exit(problems.length ? 1 : 0);
