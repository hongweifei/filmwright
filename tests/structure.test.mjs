// 仓库结构的**硬规则**——都写在 `docs/architecture.md` 的「三层结构，依赖只向下」那节，
// 但此前**没有常驻判据**：
//   · 分层方向：审计那次是人工把 162 条相对边**逐条归类**才得出「0 违例」的；
//   · 扩展名：`.js` / `.mjs` 的分布实测零例外，可这条规则**一个字都没写在文档里**，
//     于是「新加一个文件该用什么扩展名」全靠看邻居。
// 两条都属于「规则写在文档里、没人守」⇒ 这里给它们牙。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const walk = (d) => readdirSync(d, {withFileTypes: true})
  .flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const rel = (p) => relative(ROOT, p).replace(/\\/g, '/');

/**
 * 去掉注释再找说明符 —— **注释里写一次 `import … from '../runtime/x.js'` 不算真的 import**。
 * 这条「守卫的说明书不是被守卫的东西」在本仓库已出现三次（verify-links / checkImports / dead-exports）。
 * `(^|[^:])` 是为了不把 `https://` 里的 `//` 当成行注释。
 */
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/** 一个文件里的全部**模块说明符**。三种写法都要认（静态 / 副作用 / **动态**）。 */
const specifiers = (src) => {
  const re = /(?:^|\n)\s*(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
  return [...src.matchAll(re)].map((m) => m[1] ?? m[2] ?? m[3]).filter(Boolean);
};

/** `src/` 下每个源文件属于哪一层（`src/index.js` 是入口，不属于三层中的任何一层）。 */
const layerOf = (p) => {
  const r = rel(p);
  if (r.startsWith('src/contract/')) return 'contract';
  if (r.startsWith('src/runtime/')) return 'runtime';
  if (r.startsWith('src/host/')) return 'host';
  return 'entry';
};

const SRC_FILES = walk(join(ROOT, 'src')).filter((f) => /\.(js|mjs)$/.test(f));

test('分层方向：`contract` 不 import runtime/host，`runtime` 不 import host', () => {
  // 下限：扫不到文件 / 解析不到边，这条判据就什么都不守（「空集上的干净不算干净」）
  assert.ok(SRC_FILES.length > 50, `只扫到 ${SRC_FILES.length} 个源文件 —— 枚举坏了`);

  const bad = [];
  let edges = 0;
  for (const f of SRC_FILES) {
    const from = layerOf(f);
    for (const spec of specifiers(stripComments(readFileSync(f, 'utf8')))) {
      if (!spec.startsWith('.')) continue;          // 裸导入（'filmwright'）交给 import map
      const to = layerOf(resolve(dirname(f), spec));
      edges++;
      if (from === 'contract' && to !== 'contract') {
        bad.push(`${rel(f)} → ${spec}：contract 只许 import contract（依赖只向下）`);
      }
      if (from === 'runtime' && to === 'host') {
        bad.push(`${rel(f)} → ${spec}：runtime 不许 import host（依赖只向下）`);
      }
    }
  }
  assert.ok(edges > 100, `只解析到 ${edges} 条相对边 —— 解析写错了`);
  assert.deepEqual(bad, [], '分层违例：\n' + bad.join('\n'));
});

test('扩展名编码「在哪跑」：contract/runtime 是 `.js`（进浏览器），host 是 `.mjs`（只在 Node）', () => {
  // 实测（2026-10-15）：contract 14 个 / runtime 35 个 / index.js 1 个都是 `.js`，
  // host 30 个全是 `.mjs`，**零例外**。这条规则此前没写进任何文档 ⇒ 一并写进 architecture.md。
  assert.ok(SRC_FILES.length > 50, `只扫到 ${SRC_FILES.length} 个源文件 —— 枚举坏了`);

  const bad = [];
  for (const f of SRC_FILES) {
    const r = rel(f);
    const layer = layerOf(f);
    if (layer === 'contract' || layer === 'runtime') {
      if (!r.endsWith('.js')) bad.push(`${r}：浏览器侧必须是 .js（它是 .mjs，会被当成只在 Node 里跑）`);
    }
    if (layer === 'host') {
      if (!r.endsWith('.mjs')) bad.push(`${r}：Node 侧必须是 .mjs（它是 .js，会被误当成浏览器侧源码）`);
    }
    if (layer === 'entry' && r !== 'src/index.js') bad.push(`${r}：src/ 根下只允许 index.js`);
  }
  assert.deepEqual(bad, [], '扩展名不符合「在哪跑」的规则：\n' + bad.join('\n'));
});
