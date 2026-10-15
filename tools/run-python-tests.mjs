#!/usr/bin/env node
// 跑 python 侧的测试（TTS 引擎层在 python 里，`node --test` 覆盖不到）。
//
// 三条原则：
//   1. **python 或 numpy 缺失时优雅跳过**（打印跳过原因、退出码 0）——
//      核心渲染链是零依赖的，不该因为没装 python 就让 `npm test` 变红。
//      这与 mcp.test.mjs「没装 SDK 就跳过」同一个取舍。
//   2. 但**装了就必须真跑**：不能因为「反正可能没有 python」就静默跳过，
//      那会让 python 侧长期无人测（比不写测试更糟）。
//   3. **环境齐备却一个测试都没扫到 ⇒ 失败**。原来这里是「扫到 0 个就打印跳过、退出码 0」，
//      于是「改个文件名前缀」或「把文件挪进子目录」都会让 python 侧**静默不再被测** ——
//      不报错、不提示，`npm test` 照绿。空集上的绿不是绿（同一族在 `verify-links` /
//      `verify-docs` / `verify-encoding` 等处都各踩过一次，这是最后一处没补下限的）。
import {spawnSync} from 'node:child_process';
import {existsSync, readdirSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const TESTS = join(ROOT, 'tests');

/**
 * 找 python 侧测试：**递归**，认 `tts-*.py` 与 `test_*.py` 两种命名。
 * 递归是必须的 —— 原来只扫 `tests/` 顶层，文件挪进子目录就永远不跑。
 */
const findPyTests = (dir) => {
  const out = [];
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (/^(tts-.*|test_.*)\.py$/.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out;
};

// 先探 python 与 numpy —— **顺序是判据的一部分**：「环境齐备却扫到 0 个」要在这之后才能判。
const probe = spawnSync('python', ['-c', 'import numpy'], {encoding: 'utf8'});
const pythonReady = !probe.error && probe.status === 0;

const pyTests = findPyTests(TESTS);
if (!pythonReady) {
  const why = probe.error ? probe.error.message : String(probe.stderr || '').trim().split('\n').pop();
  console.log(`（跳过 python 侧测试：扫到 ${pyTests.length} 个文件）`);
  console.log(`  原因：${why}`);
  console.log('  装了 Python 3 + numpy 就会自动跑（见 README 的「快速开始」）');
  process.exit(0);
}
if (pyTests.length === 0) {
  console.error('✗ python 与 numpy 都可用，却在 tests/ 下一个 python 测试都没扫到。');
  console.error('  这个仓库有 python 侧测试（TTS 引擎层）—— 扫到 0 个说明**发现规则坏了**：');
  console.error('  认的命名是 `tts-*.py` 与 `test_*.py`（递归）。改名或搬家之后请同步这条规则。');
  process.exit(1);
}

let failed = 0;
for (const f of pyTests) {
  console.log(`\n--- ${relative(ROOT, f).replace(/\\/g, '/')} ---`);
  const r = spawnSync('python', [f], {
    stdio: 'inherit',
    env: {...process.env, PYTHONIOENCODING: 'utf-8'},
  });
  if ((r.status ?? 1) !== 0) failed++;
}

if (failed) {
  console.error(`\n✗ python 侧测试有 ${failed} 个文件失败`);
  process.exit(1);
}
console.log(`\n✓ python 侧测试全部通过（${pyTests.length} 个文件）`);
