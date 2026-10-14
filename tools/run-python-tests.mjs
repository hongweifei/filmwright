#!/usr/bin/env node
// 跑 python 侧的测试（TTS 引擎层在 python 里，node --test 覆盖不到）。
//
// 两条原则：
//   1. **python 或 numpy 缺失时优雅跳过**（打印跳过原因、退出码 0）——
//      核心渲染链是零依赖的，不该因为没装 python 就让 `npm test` 变红。
//      这与 mcp.test.mjs「没装 SDK 就跳过」同一个取舍。
//   2. 但**装了就必须真跑**：不能因为「反正可能没有 python」就静默跳过，
//      那会让 python 侧长期无人测（比不写测试更糟）。
import {spawnSync} from 'node:child_process';
import {existsSync, readdirSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const TESTS = join(ROOT, 'tests');

const pyTests = existsSync(TESTS)
  ? readdirSync(TESTS).filter((f) => /^tts-.*\.py$/.test(f)).sort()
  : [];
if (pyTests.length === 0) {
  console.log('（没有 python 侧测试，跳过）');
  process.exit(0);
}

// 先探 python 与 numpy 是否可用
const probe = spawnSync('python', ['-c', 'import numpy'], {encoding: 'utf8'});
if (probe.error || probe.status !== 0) {
  const why = probe.error ? probe.error.message : String(probe.stderr || '').trim().split('\n').pop();
  console.log(`（跳过 python 侧测试：${pyTests.length} 个文件）`);
  console.log(`  原因：${why}`);
  console.log('  装了 Python 3 + numpy 就会自动跑（见 README 的「快速开始」）');
  process.exit(0);
}

let failed = 0;
for (const f of pyTests) {
  console.log(`\n--- tests/${f} ---`);
  const r = spawnSync('python', [join(TESTS, f)], {
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
