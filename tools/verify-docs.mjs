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
import {join, relative} from 'node:path';

const ROOT = (process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : process.cwd())
  .replace(/\\/g, '/');
const FIX = process.argv.includes('--fix');

// ---------- 从实现里取事实（唯一真相源）----------
function facts() {
  const scene = readFileSync(join(ROOT, 'src/contract/scene.js'), 'utf8');
  const typesBlock = scene.match(/export const SHOT_TYPES = \[([\s\S]*?)\];/)[1];
  const templateCount = (typesBlock.match(/'/g) || []).length / 2;

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

  return {templateCount, checkCount, staticCheckCount, commands, mcpToolCount, blendModes, transitions, hasClips};
}

const F = facts();
const CN = {七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12};
const cnNum = (n) => Object.entries(CN).find(([, v]) => v === n)?.[0] ?? String(n);

// ---------- 扫文档 ----------
const DOC_FILES = [];
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

for (const file of DOC_FILES) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  let text = readFileSync(file, 'utf8');
  const orig = text;
  const lines = text.split('\n');

  lines.forEach((line, i) => {
    // 引述历史的行（CHANGELOG 的修复记录等）跳过：那些是被引述的旧说法，
    // 不是当前断言。判定用「同一行里有修正类动词」这个近似 ——
    // 宁可漏报几行，也不要让记录修复的文字永远报红。
    if (QUOTING_CONTEXT.test(line)) return;
    // 数字类：可自动修
    for (const rule of fixes) {
      for (const m of line.matchAll(rule.re)) {
        const got = Number(CN[m[rule.numIdx]] ?? m[rule.numIdx]);
        if (got === rule.want) continue;
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
process.exit(problems.length ? 1 : 0);
