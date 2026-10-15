// 文档一致性：把「实现里的真实数字」与「文档里的说法」对齐。
//
//   node tools/verify-docs.mjs            # 检查（CI 用，不一致就失败）
//   node tools/verify-docs.mjs --fix      # 自动修正数字类说法
//
// 每次检查都会**顺带跑一遍本工具自己的负面对照**：在系统临时目录里搭一个最小仓库根，
// 先证明「数字全对」能过，再把一个数字故意写错、要求它红（详见文件末尾那一节）。
// 子进程用 `FW_VERIFY_DOCS_NO_NEG=1` 关掉这一层 —— 否则会自己调自己，无限递归。
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
import {readFileSync, readdirSync, writeFileSync, existsSync,
  mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {dirname, join, relative, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

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

  // 混合模式名单的**单一来源在 contract**（`layer.js` 只是再导出），所以从这里数。
  // 找不到就**明确报错**：原来的 `[1]` 会抛 `TypeError: Cannot read properties of null` ——
  // 那种红读不出「名单被搬走了，判据要跟着改」，只会让人以为是工具坏了。
  const bm = scene.match(/export const BLEND_MODES = \[([\s\S]*?)\]/);
  if (!bm) {
    throw new Error('verify-docs: src/contract/scene.js 里找不到 `export const BLEND_MODES = [...]`'
      + '（名单被改名或搬走了，这条判据要跟着改）');
  }
  const blendModes = (bm[1].match(/'/g) || []).length / 2;

  // 转场类型从**单一来源**读（`contract/scene.js` 的 `TRANSITION_TYPES`，`shots.js` 也 import 它）。
  // 原来是在 shots.js 里 `normalizeTransition` 之后 700 字符的窗口里正则捞：那个窗口只捞得到
  // 3 种（crossfade / slide / wipe，都是函数体里的字面量），而真实名单有 5 种 ⇒ 打印出来的
  // 「事实」本身就是错的。因为没有规则拿它比对，错了很久也没人发现 —— 顺手修掉。
  const transitions = (scene.match(/export const TRANSITION_TYPES = \[([^\]]*)\]/)?.[1] ?? '')
    .split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);

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

  // 验收工具数与已接入数：README 里「N 个验收工具……其中 M 个在 CI 里自动跑」
  // 这两个数字**刚漂过一次**（README 还写着 22/20 而实际已 26/24）—— 所以也纳入守卫。
  const toolFiles = readdirSync(join(ROOT, 'tools')).filter((f) => /^verify-.*\.mjs$/.test(f));
  const ciSrc = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const wiredToolCount = toolFiles.filter((f) => ciSrc.includes(f)).length;

  return {templateCount, checkCount, staticCheckCount, commands, mcpToolCount, blendModes,
    transitions, hasClips, testCount, effectCount,
    toolCount: toolFiles.length, wiredToolCount};
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
  {re: /(\d+)(\s*个验收工具)/g, numIdx: 1, want: F.toolCount,
   make: (m) => `${F.toolCount}${m[2]}`, label: '验收工具数'},
  {re: /(\d+)(\s*个在 CI 里自动跑)/g, numIdx: 1, want: F.wiredToolCount,
   make: (m) => `${F.wiredToolCount}${m[2]}`, label: '自动跑的验收工具数'},
  // ⚠️ 同一件事的**第二种写法**：`工具接入 N/M`（N=接入数、M=总数）。
  // 实测踩到：CHANGELOG 里写着「工具接入 20/22」而实际已是 22/24 ——
  // 上面两条规则匹配的是「N 个验收工具」/「N 个在 CI 里自动跑」，
  // **这种斜杠写法一条都匹配不上**，于是守卫静默放过。
  // 判据取**第一个数**（接入数）比 `wiredToolCount`，改写时把两个数一起归一。
  {re: /工具接入\s*(\d+)\s*\/\s*(\d+)/g, numIdx: 1, want: F.wiredToolCount,
   make: () => `工具接入 ${F.wiredToolCount}/${F.toolCount}`, label: '工具接入数（N/M）'},
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

// ---------- 扫描量下限（空集上的「一致」不是一致）----------
// `git ls-files` **成功但返回空**（索引里一个 .md 都没有）时 `tracked` 是**空数组**，
// 而空数组是 truthy ⇒ DOC_FILES 为空 ⇒ 上面那批数字与事实性判据**一条都不会跑**，
// 工具照样打印「✓ 文档数字与事实性说法都与实现一致」并 EXIT=0。
// 实测（仓库里 0 个被跟踪的 .md、磁盘上有 2 个 .md）：旧版绿，判据全空转。
// 所以加一条下限：扫不到文档就算失败 —— 免得它空转还恒绿。
if (!DOC_FILES.length) {
  problems.push({kind: 'scan', doc: '（文档枚举）', line: '—', text: '扫描到 0 个文档文件',
    why: '一个 .md 都没扫到 —— 要么 git 索引里没有 .md，要么 ROOT 给错了；空集不能算「一致」'});
}

/**
 * 匹配到的数字是否**在引号里**（引述旧值，不是当前断言）。
 *
 * ⚠️ **检测与修正两条路径必须共用这一个判断** —— 第一版我只在"检测"里加了引号豁免，
 * "修正"路径没加，于是 `--fix` **照样把引述改坏**（同一个 bug 犯了两次，实测踩到）。
 * 现在两边都调这个函数，不会再分叉。
 */
const isQuoted = (line, index, len) => {
  const before = line.slice(Math.max(0, index - 1), index);
  const after = line.slice(index + len, index + len + 1);
  return /[「“『"]/.test(before) || /[」”』"]/.test(after);
};

/**
 * 整行是否应当跳过（**检测与修正两条路径共用**）。
 *
 * 两条理由：
 *   1. CHANGELOG 的**已发布区**是历史 —— 那里写「72 个单元测试」是当时的事实，
 *      跟着实现改等于篡改历史；
 *   2. 行里有**引述类动词**（修正/修复/原来/而实际…）—— 那是被引述的旧说法。
 */
const shouldSkip = (rel, line, i) => {
  const releasedFrom = RELEASED_FROM.get(rel);
  if (releasedFrom !== undefined && i >= releasedFrom) return true;
  return QUOTING_CONTEXT.test(line);
};

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
  const text = readFileSync(file, 'utf8');
  const orig = text;
  const lines = text.split('\n');

  lines.forEach((line, i) => {
    // 跳过判断与修正路径**共用**（见 shouldSkip 的说明）
    if (shouldSkip(rel, line, i)) return;
    // 数字类：可自动修
    for (const rule of fixes) {
      for (const m of line.matchAll(rule.re)) {
        // ⚠️ **引号里的数字不能改** —— 那是在**引述旧值**，不是当前断言。
        // 实测踩到：CHANGELOG 里写着「写着「九道自检」（实际十道）」，
        // 自动修正把引号里那个也改成"十道"，变成"写着「十道自检」（实际十道）」——
        // **把一句正确的话改成了错的**。只豁免"引述类动词"不够（那行没有触发词）。
        const quoted = isQuoted(line, m.index, m[0].length);
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
    // ⚠️ **必须与检测路径用同一套跳过判断**。第一版只把"引号豁免"与"已发布区豁免"
    // 加在检测路径，修正路径没有 —— 于是 `--fix` **照样篡改历史**（同一个结构问题犯了两次）。
    // 现在两边都调 `shouldSkip`，不会再分叉。
    const out = lines.map((line, i) => {
      if (shouldSkip(rel, line, i)) return line;
      let l = line;
      for (const rule of fixes) {
        // 用 replace 的回调做「只在值不对时替换」，避免把正确数字也重写
        l = l.replace(rule.re, (m0, ...args) => {
          const m = [m0, ...args];
          // replace 回调的最后两个参数是 offset 与整个字符串（`rule.re` 没有命名组）
          const offset = args[args.length - 2];
          const whole = args[args.length - 1];
          // ⚠️ 引号里的**不改**（引述旧值）—— 与检测路径同一个判断
          if (typeof offset === 'number' && isQuoted(whole, offset, m0.length)) return m0;
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

// ---------- 本工具自己的负面对照 ----------
// 纪律：**一个永远绿的检查不是检查**。上面那套判据（数字核对、事实性说法、工具表计数）
// 万一变成恒真 —— 文档枚举取到空集、规则被整段跳过 —— 整份工具照样 EXIT=0，CI 一路绿着放行。
// 所以每次运行都**自己造缺陷、要求自己红**（三个夹具、三次子进程，别为了省事把这条删了）：
//
//   ① 夹具的数字与实现一致 + 一行「引号里引述的旧值」 ⇒ 要求 EXIT=0
//      （两个方向都算断言：既证明夹具不是恒红，也证明引号豁免没坏成误报）
//   ② 数字 / 工具表自动跑数 / 事实性说法 **各弄坏一处**  ⇒ 要求 EXIT=1，且三类问题都得报出来
//   ③ 文档一个都没进 git 索引（空集）                  ⇒ 要求 EXIT=1（配上文那条扫描量下限）
//
// ⚠️ 全程**不读也不写真源码**：夹具搭在 os.tmpdir() 下，跑完整个删掉。
// 本仓库为「拿真源码做对照」吃过大亏（改到一半被杀就留下脏状态），所以宁可多写几十行。
const NEG_ENV = 'FW_VERIFY_DOCS_NO_NEG';
const SELF_PATH = fileURLToPath(import.meta.url);

/**
 * 夹具的「实现」与「文档」由同一批数组生成 —— 数字只写一遍，
 * 免得夹具自己先对不上（那样对照就成了恒红，一样没有区分力）。
 *
 * 文件路径不能随便挑：`facts()` 读的是**硬编码路径**，缺一个就会抛。
 * 所以这里等于把「这个工具依赖哪些实现文件」也钉住了 —— 路径一改，负面对照当场红。
 */
function fixtureFiles() {
  const types = ['alpha', 'beta', 'gamma'];
  const containers = ['gamma'];
  const staticChecks = ['compile', 'lint'];
  const browserChecks = ['render'];
  const testNames = ['t1', 't2'];
  const effects = ['blur', 'glow'];
  const tools = ['verify-alpha.mjs', 'verify-beta.mjs'];
  const wired = ['verify-alpha.mjs'];
  const templates = types.length - containers.length;   // 容器不算模板（与 facts() 同口径）
  const q = (xs) => xs.map((x) => `'${x}'`).join(', ');

  const files = {
    // ── facts() 会读的实现文件 ──
    'src/contract/scene.js': `export const SHOT_TYPES = [${q(types)}];\n`
      + `export const CONTAINER_TYPES = [${q(containers)}];\n`
      + `export const BLEND_MODES = ['normal', 'multiply'];\n`,
    'src/host/checks/index.mjs': `export async function runChecks({staticOnly} = {}) {\n`
      + `  const results = [];\n`
      + staticChecks.map((n) => `  results.push('${n}');\n`).join('')
      + `  if (!staticOnly) {\n`
      + browserChecks.map((n) => `    results.push(await check${n[0].toUpperCase()}${n.slice(1)}());\n`).join('')
      + `  }\n  return results;\n}\n`,
    'src/host/cli/index.mjs': `const COMMANDS = [['render', '渲染'], ['check', '自检']];\n`,
    'src/host/mcp/server.mjs': `server.registerTool('a', {}, () => {});\n`
      + `server.registerTool('b', {}, () => {});\n`,
    // 混合模式的名单在 contract（这里只是再导出）—— 夹具照实镜像这个安排
    'src/runtime/composite/layer.js': `export {BLEND_MODES} from '../../contract/scene.js';\n`,
    'src/runtime/stage/shots.js': `export function normalizeTransition(t) {\n`
      + `  if (t === 'fade') return 'crossfade';\n  return t || 'crossfade';\n}\n`,
    'src/host/media/clips.mjs': `export const CLIPS = true;\n`,   // 有了它，② 那句否定才过期
    'src/runtime/clips.js': `export const CLIPS = true;\n`,
    'src/contract/effects.js': `export const EFFECT_TYPES = [${q(effects)}];\n`,
    'tests/fixture.test.mjs': testNames.map((n) => `test('${n}', () => {});\n`).join(''),
    'tools/verify-alpha.mjs': `// 夹具占位\n`,
    'tools/verify-beta.mjs': `// 夹具占位\n`,
    '.github/workflows/ci.yml': `jobs:\n  static:\n    steps:\n`
      + wired.map((f) => `      - run: node tools/${f}\n`).join(''),
    // ── 被判的文档 ──
    'README.md': `# 夹具仓库\n\n`
      + `这是自检夹具：${templates} 类模板、${staticChecks.length + browserChecks.length} 道自检`
      + `（前 ${staticChecks.length} 道不启浏览器）。\n`
      + `共 ${testNames.length} 个单元测试、${effects.length} 个效果、${tools.length} 个验收工具，`
      + `其中 ${wired.length} 个在 CI 里自动跑。\n`
      // 引号里的旧值：**引述**，不是当前断言 ⇒ 一条都不许报（豁免坏了这里就会红）
      + `旧说法：「${templates + 7} 类模板」。\n`,
    'docs/qc.md': `# 夹具\n\n| 守卫 | 说明 |\n| --- | --- |\n`
      + wired.map((f) => `| \`${f}\` | 夹具守卫 |\n`).join('')
      + `\n**${tools.length} 个验收工具里 ${wired.length} 个自动跑。**\n`,
  };
  return {files, spec: {templates, effects, wired},
    docCount: Object.keys(files).filter((p) => p.endsWith('.md')).length};
}

/**
 * 把夹具写到 dir。始终 `git init` 并**加一个非 .md 进索引**（这样 `git add` 不会因
 * 无参数报错）；`trackDocs=false` 时**不加那两个 .md** —— 专门造「仓库里 0 个被跟踪的
 * 文档、磁盘上却有」的空集。返回 git 是否可用（空集那条对照依赖它）。
 */
function writeFixture(dir, trackDocs) {
  for (const [p, src] of Object.entries(fixtureFiles().files)) {
    const full = join(dir, p);
    mkdirSync(dirname(full), {recursive: true});
    writeFileSync(full, src, 'utf8');
  }
  try {
    execFileSync('git', ['init', '-q'], {cwd: dir, stdio: 'ignore'});
    execFileSync('git', ['add', '--', 'src/contract/scene.js'], {cwd: dir, stdio: 'ignore'});
    if (trackDocs) execFileSync('git', ['add', '--', 'README.md', 'docs/qc.md'], {cwd: dir, stdio: 'ignore'});
    return true;
  } catch { return false; }   // 没有 git：工具会回退到扫磁盘，只是「空集」那条做不了
}

/** 用**同一份工具**在临时根上跑一遍（子进程关掉负面对照，否则递归）。 */
function runToolOn(root) {
  try {
    return {code: 0, out: execFileSync(process.execPath, [SELF_PATH, root], {
      encoding: 'utf8', env: {...process.env, [NEG_ENV]: '1'}, stdio: ['ignore', 'pipe', 'pipe']})};
  } catch (e) {
    return {code: Number.isInteger(e.status) ? e.status : -1,
      out: `${e.stdout ?? ''}${e.stderr ?? ''}`};
  }
}

// ⚠️ 锚点没命中要**当场抛**：静默的 no-op 替换会让对照假绿（本次写这条时就踩过一次 ——
// `spec.effects` 拿的是数组而不是个数，`2 个效果` 根本没匹配上，缺陷压根没注入进去，
// 是 ② 这条对照红出来才发现的）。
const patchFile = (p, from, to) => {
  const src = readFileSync(p, 'utf8');
  if (!src.includes(from)) throw new Error(`对照锚点没命中：「${from}」（${p}）`);
  writeFileSync(p, src.replace(from, to), 'utf8');
};
const appendFile = (p, extra) => writeFileSync(p, readFileSync(p, 'utf8') + extra, 'utf8');

/** 跑全部对照；① 期望的「过」也算一条断言 —— 恒红的对照和恒绿的一样没用。 */
function runNegativeControl() {
  const results = [];
  const failures = [];
  if (process.env[NEG_ENV] === '1') return {results, failures, skipped: true};
  const {spec, docCount} = fixtureFiles();
  const cases = [
    {name: '① 夹具数字全对 + 引号引述的旧值', want: 0, hits: [`扫描了 ${docCount} 个文档文件`]},
    {name: '② 数字 / 工具表 / 事实性说法 各弄坏一处', want: 1,
     hits: ['个效果', `个工具里 ${spec.wired.length + 8} 个自动跑`, '事实性说法'],
     mutate: (d) => {
       patchFile(join(d, 'README.md'), `${spec.effects.length} 个效果`,
         `${spec.effects.length + 7} 个效果`);
       patchFile(join(d, 'docs/qc.md'), `里 ${spec.wired.length} 个自动跑`,
         `里 ${spec.wired.length + 8} 个自动跑`);
       appendFile(join(d, 'README.md'), '\n本项目视频没有内建支持。\n');
     }},
    {name: '③ 文档没进 git 索引（空集）', want: 1, hits: ['0 个文档文件'], track: false, needsGit: true},
  ];
  const dirs = [];
  try {
    for (const c of cases) {
      let dir;
      try {
        dir = mkdtempSync(join(tmpdir(), 'fw-verify-docs-neg-'));
        dirs.push(dir);
        const gitOk = writeFixture(dir, c.track !== false);
        if (c.needsGit && !gitOk) { results.push({name: c.name, skipped: '本机没有 git'}); continue; }
        if (c.mutate) c.mutate(dir);
        const {code, out} = runToolOn(dir);
        const missing = (c.hits ?? []).filter((h) => !out.includes(h));
        const ok = code === c.want && !missing.length;
        results.push({name: c.name, code, want: c.want, hits: c.hits, ok});
        if (!ok) failures.push({name: c.name, out,
          why: `期望 EXIT=${c.want}${c.hits?.length ? ` 且输出含 ${c.hits.map((h) => `「${h}」`).join('、')}` : ''}，`
            + `实得 EXIT=${code}${missing.length ? `（缺 ${missing.map((h) => `「${h}」`).join('、')}）` : ''}`});
      } catch (e) {
        results.push({name: c.name, code: -1, want: c.want, ok: false});
        failures.push({name: c.name, why: `夹具没搭起来：${e.message}`});
      }
    }
  } finally {
    for (const d of dirs) {
      try { rmSync(d, {recursive: true, force: true}); } catch { /* 删不掉也别掩盖结论 */ }
    }
  }
  return {results, failures, skipped: false};
}

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
const scans = problems.filter((p) => p.kind === 'scan');
if (numbers.length) {
  console.log(`\n✗ ${numbers.length} 处数字与实现不一致（可跑 --fix 自动修）：`);
  for (const p of numbers) console.log(`   ${p.doc}:${p.line}  ${p.why}\n      > ${p.text}`);
}
if (claims.length) {
  console.log(`\n✗ ${claims.length} 处事实性说法已过时（需人工改写，工具不代改）：`);
  for (const p of claims) console.log(`   ${p.doc}:${p.line}  ${p.why}\n      > ${p.text}`);
}
if (scans.length) {
  console.log(`\n✗ ${scans.length} 处枚举下限问题（**空集上的「一致」不是一致**）：`);
  for (const p of scans) console.log(`   ${p.doc}:${p.line}  ${p.why}\n      > ${p.text}`);
}
if (!problems.length) console.log('\n✓ 文档数字与事实性说法都与实现一致');

// 负面对照：每次运行都跑（子进程用 NEG_ENV 关掉，不递归）。
// ① 期望的是「过」—— 恒红的对照和恒绿的一样没有区分力，所以两个方向都算断言。
const SELF_TEST = runNegativeControl();
console.log('\n负面对照（临时仓库根里**故意弄坏**，要求它红；跑完即删）：');
for (const r of SELF_TEST.results) {
  if (r.skipped) { console.log(`   – ${r.name}：跳过（${r.skipped}）`); continue; }
  console.log(`   ${r.ok ? '✓' : '✗'} ${r.name} → EXIT=${r.code}`
    + (r.ok ? (r.hits?.length ? `（命中 ${r.hits.length} 处预期文案）` : '（如预期）')
      : `，期望 EXIT=${r.want}`));
}
if (SELF_TEST.skipped) console.log(`   （整层已跳过：${NEG_ENV}=1）`);
if (SELF_TEST.failures.length) {
  console.log(`\n✗ ${SELF_TEST.failures.length} 条负面对照没按预期 —— 上面那套判据已经不能证伪：`);
  for (const f of SELF_TEST.failures) {
    console.log(`   ${f.name}：${f.why}`);
    if (f.out) console.log(`      子进程输出末尾：\n      ${String(f.out).trim().split('\n').slice(-8).join('\n      ')}`);
  }
}

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
process.exit(problems.length || SELF_TEST.failures.length ? 1 : 0);
