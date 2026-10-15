// 死导出守卫（棘轮）：**新出现**"导出但没人用"的符号就失败。
//
//   node tools/dead-exports.mjs [<仓库根>]
//
// ## 为什么用棘轮而不是"全清掉"
//
// 盘点发现 `src/` 有 376 个导出、其中 3 个**在任何地方都没被引用**。
// 但"没人用"不等于"该删" —— 有些是**有意的公开 API**（给使用者的入口）。
// 所以不做一刀切，而是**把当前状态记录下来**，之后：
//
//   · 出现**新的**死导出 ⇒ 失败（要么用起来，要么删掉，要么显式加进下面的名单）；
//   · 名单里的某个**已被清理** ⇒ 也失败（提醒把它从名单里去掉，别留陈旧记录）。
//
// 这样这份名单不会腐烂，也不会挡着有意的公开 API。
//
// ## 名单里的三个是什么（盘点时逐个看过）
//
//   · `pruneCache` / `projectFingerprint`：早期设计的遗留 ——
//     现在用的是更新版的 `pruneSegments` / `globalFingerprint`（都在用）；
//   · ~~`reset3D`~~：**已从名单去掉**（2026-10-15）—— 它当时"没人用"，
//     但它是**有意公开的 API**；公开面扩到覆盖 3D 词汇后它真的上了公开面，
//     于是棘轮当场报"这个名单条目已经不再是死导出"（正是它该干的事）。
import {readdirSync, readFileSync} from 'node:fs';
import {join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {dirname} from 'node:path';

/** 已知的死导出（键是"相对路径 符号名"）。加进来必须写理由。 */
const KNOWN = new Map([
  ['src/host/media/clips.mjs pruneCache', '早期设计遗留；现在用 pruneSegments（在用）'],
  ['src/host/media/incremental.mjs projectFingerprint', '早期设计遗留；现在用 globalFingerprint（在用）'],
]);

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const ROOT = resolve(argv[0] && !argv[0].startsWith('--') ? argv[0] : resolve(HERE, '..'));

const listFiles = (root, filter, skip) => {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, {withFileTypes: true})) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (!skip.includes(e.name)) walk(p); }
      else if (filter(e.name)) out.push(p);
    }
  };
  walk(root);
  return out;
};
const SKIP = ['node_modules', '.git', '.work', 'renders', 'audio', '__pycache__'];
const srcFiles = listFiles(join(ROOT, 'src'), (n) => /\.(js|mjs)$/.test(n), SKIP);
const allFiles = listFiles(ROOT, (n) => /\.(js|mjs|html|json)$/.test(n), SKIP);

const exportsByFile = new Map();
for (const f of srcFiles) {
  const src = readFileSync(f, 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s*\{([^}]+)\}/gm)) {
    for (const part of m[1].split(',')) {
      const t = part.trim().split(/\s+as\s+/).pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t);
    }
  }
  if (names.size) exportsByFile.set(f, names);
}

// ⚠️ **必须排除本文件自己**：下面的 KNOWN 名单里写着那些符号名，
// 若把自己算进"引用"，名单本身就会让它们看起来"有人用" —— 自引用 bug，实测踩到过。
const SELF = fileURLToPath(import.meta.url);

// ⚠️ **先去掉注释再数引用**：注释里提一次符号名**不该**算「有人用」。
// 实测漏过一次：`runtime/qc/analysis.js` 导出的 `STATIC_THR` 没有任何代码读它，
// 但同一文件顶部的注释里写了一次它的名字 ⇒ 计数把它当成「有人用」⇒ 棘轮放行，
// 那个常量就一直在源码里躺着（真正生效的阈值在 host 侧的 THRESHOLDS 里）。
// 粗糙但够用：`[^:]` 那一段是防 `http://` 被当成注释开头。
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const texts = new Map(allFiles.filter((p) => p !== SELF)
  .map((p) => [p, stripComments(readFileSync(p, 'utf8'))]));
const dead = [];
for (const [f, names] of exportsByFile) {
  const key0 = relative(ROOT, f).replace(/\\/g, '/');
  for (const n of names) {
    let uses = 0;
    for (const [p, t] of texts) {
      const hits = (t.match(new RegExp(`\\b${n.replace(/\$/g, '\\$')}\\b`, 'g')) || []).length;
      uses += p === f ? Math.max(0, hits - 1) : hits;
    }
    if (uses === 0) dead.push(`${key0} ${n}`);
  }
}

const total = [...exportsByFile.values()].reduce((a, s) => a + s.size, 0);
const isNew = dead.filter((d) => !KNOWN.has(d));
const stale = [...KNOWN.keys()].filter((k) => !dead.includes(k));

console.log(`src/ 下 ${srcFiles.length} 个文件，导出 ${total} 个符号；死导出 ${dead.length} 个（名单里 ${KNOWN.size} 个）`);
let bad = 0;
if (isNew.length) {
  bad += isNew.length;
  console.log(`\n✗ ${isNew.length} 个**新的**死导出（要么用起来、要么删、要么显式加进 KNOWN 并写理由）：`);
  for (const d of isNew) console.log(`   ${d}`);
}
if (stale.length) {
  bad += stale.length;
  console.log(`\n✗ ${stale.length} 个名单条目**已经不再是死导出**（清理过了，请从 KNOWN 里去掉）：`);
  for (const k of stale) console.log(`   ${k}`);
}
if (!bad) console.log('✓ 没有新的死导出，名单也没有陈旧条目');
console.log('\n（"没人用"不等于"该删" —— 有意的公开 API 应显式加进 KNOWN 并写明理由。）');
process.exit(bad ? 1 : 0);
