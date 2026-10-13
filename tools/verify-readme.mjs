// 按 README 的快速开始走一遍（除了 clone/pip），确认文档没写错。
// 用法: node qc/tools/verify-readme.mjs
import {execFileSync} from 'node:child_process';
import {existsSync, statSync} from 'node:fs';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// 本文件在 <root>/tools/，所以根要往上两层
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROJ = join(ROOT, 'examples', 'minimal');

const steps = [
  ['check', ['check', '--project', PROJ]],
  ['all', ['all', '--project', PROJ, '--shards', '3']],
];

for (const [name, args] of steps) {
  process.stdout.write(`README 步骤 ${name} … `);
  try {
    execFileSync('node', [join(ROOT, 'bin', 'filmwright.mjs'), ...args], {stdio: 'pipe'});
    console.log('ok');
  } catch (e) {
    console.log('失败');
    console.log(String(e.stdout || '').slice(-2000));
    console.log(String(e.stderr || '').slice(-2000));
    process.exit(1);
  }
}

const out = join(PROJ, 'renders', 'minimal.mp4');
if (!existsSync(out)) {
  console.log('✗ README 说会产出 ' + out + '，但它不在');
  process.exit(1);
}
console.log(`\n产出 ${out}  ${(statSync(out).size / 1048576).toFixed(1)} MB`);
