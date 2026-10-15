// 仓库结构的**硬规则与可导航性**——规则写在 `docs/architecture.md` 的「三层结构，依赖只向下」那节，
// 但此前**没有常驻判据**：
//   · 分层方向：审计那次是人工把 162 条相对边**逐条归类**才得出「0 违例」的；
//   · 扩展名：`.js` / `.mjs` 的分布实测零例外，可这条规则**一个字都没写在文档里**，
//     于是「新加一个文件该用什么扩展名」全靠看邻居。
// 第三条是**可导航性**：「没人链接的文档」那种孤儿（第八轮给 verify-links 补的判据）
// 在工具目录里也有对应物 —— 一个没写进索引的探针，后来的人根本不知道它存在。
// 三条都属于「规则写在文档里、没人守」⇒ 这里给它们牙。
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

test('可导航性：`tools/probes/` 下每个探针都要在它自己的 README 里出现', () => {
  // 实测（2026-10-15，补之前）：16 个探针里有 **6 个**从没写进 `probes/README.md` ——
  // 一个没进索引的探针，后来的人根本不知道它存在（同族：第八轮给「没人链接的文档」补的判据）。
  const dir = join(ROOT, 'tools', 'probes');
  const probes = readdirSync(dir).filter((f) => f.endsWith('.mjs'));
  assert.ok(probes.length >= 10, `只扫到 ${probes.length} 个探针 —— 枚举坏了，这条不算通过`);
  const md = readFileSync(join(dir, 'README.md'), 'utf8');
  const unlisted = probes.filter((f) => !md.includes(f));
  assert.deepEqual(unlisted, [],
    '这些探针没写进 tools/probes/README.md（补一行「回答什么问题」）：' + unlisted.join(', '));
});

test('引擎不认识任何片子：`src/` 里不出现示例项目的名字，也不出现 `examples/` 路径', () => {
  // `docs/architecture.md` 的硬规则：「配置、时间轴、镜头全部由 `boot()` 注入；引擎里没有一个
  // 具体片子的名字。」实测（2026-10-15，去掉注释后）**零命中** ⇒ 规则成立，但此前没人守。
  //
  // ⚠️ 名字表**从 `examples/` 目录派生**，不写死；但 `three` 必须排除 —— 它同时是
  //    three.js 这个**库名**、也是镜头类型名（`{type: 'three'}`），拿它当判据必然假阳性。
  const exDir = join(ROOT, 'examples');
  const projNames = readdirSync(exDir, {withFileTypes: true})
    .filter((e) => e.isDirectory()).map((e) => e.name).filter((n) => n !== 'three');
  assert.ok(projNames.length >= 3, `只从 examples/ 派生出 ${projNames.length} 个名字 —— 枚举坏了`);

  const bad = [];
  for (const f of SRC_FILES) {
    const code = stripComments(readFileSync(f, 'utf8'));
    if (/examples[\\/]/.test(code)) bad.push(`${rel(f)}：出现 examples/ 路径（引擎不该知道示例在哪）`);
    for (const n of projNames) {
      // 只认「恰好等于项目名的字符串字面量」——那才是「引擎里写死了一部片子」的形态
      if (new RegExp(`['"\`]${n}['"\`]`).test(code)) bad.push(`${rel(f)}：出现示例项目名 '${n}'`);
    }
  }
  assert.deepEqual(bad, [], '引擎里出现了具体片子的痕迹：\n' + bad.join('\n'));
});
