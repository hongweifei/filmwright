// 文档内部链接守卫：所有 `](相对路径)` 都要指向**存在的文件**。
//
//   node tools/verify-links.mjs [<仓库根>]
//
// 为什么需要：文档里的相对链接是**最容易悄悄腐烂**的东西之一 ——
// 文件改名/移动之后，链接不会报错，只会 404。而这一类没有任何现有检查覆盖
// （`verify-docs` 核数字与事实性说法，核不到链接）。
//
// 实测（加上这个工具时）：35 个 .md、74 条内部链接，**全部有效**。
// 现在没有坏链不代表以后没有 —— 它的价值是**以后改文件名时会立刻红**。
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
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
let total = 0;
for (const d of docs) {
  const text = readFileSync(d, 'utf8');
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const href = m[1];
    if (/^(https?:|mailto:|#)/.test(href)) continue;   // 外链与页内锚点不管
    const clean = href.split('#')[0];
    if (!clean) continue;
    total++;
    if (!existsSync(resolve(dirname(d), decodeURIComponent(clean)))) {
      bad.push({doc: relative(ROOT, d).replace(/\\/g, '/'), href,
        line: text.slice(0, m.index).split('\n').length});
    }
  }
}
console.log(`扫了 ${docs.length} 个 .md，${total} 条内部链接`);
if (!bad.length) console.log('✓ 全部指向存在的文件');
else {
  console.log(`\n✗ ${bad.length} 条链接指向不存在的文件（改文件名时最容易漏）：`);
  for (const b of bad) console.log(`   ${b.doc}:${b.line}  → ${b.href}`);
}
process.exit(bad.length ? 1 : 0);
