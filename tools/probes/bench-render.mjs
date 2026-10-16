// 性能总表：把三处优化的收益逐项量出来（同一台机器、同一区间、各跑一次）。
//
// 逐项分离是为了给文档提供可信数字，而不是把总收益归给某一个改动。
import {spawnSync} from 'node:child_process';
import {existsSync, rmSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// 仓库根可省（和其它探针一致）：原先直接取 `process.argv[2]`，**不带参数跑必崩**
// （`Cannot read properties of undefined`）—— 和那 9 个兜底写错的探针是同一类问题，
// 只是这个连兜底都没有。
const ROOT = (process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')).replace(/\\/g, '/');
const KIT = join(ROOT, 'bin', 'filmwright.mjs');
const P = join(ROOT, 'examples', 'minimal');
const N = 300;

const run = (args) => {
  const out = join(P, '.work', 'bench.mp4');
  rmSync(out, {force: true});
  const t0 = Date.now();
  const r = spawnSync('node', [KIT, 'render', '--project', P, '--from', '1', '--to', String(N),
    '--out', out, ...args], {encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 32 * 1024 * 1024});
  const secs = (Date.now() - t0) / 1000;
  return {ok: r.status === 0 && existsSync(out), ms: secs * 1000 / N, secs};
};

console.log(`基准：minimal 前 ${N} 帧，1280×720，各跑一次（机器负载会影响绝对值，看相对量）\n`);
console.log('配置                                              ms/帧    相对');
console.log('─'.repeat(72));

const rows = [
  ['PNG 中间帧 + 逐帧 CDP 取回（最初）', ['--shards', '1', '--frame-format', 'png', '--frame-transport', 'cdp']],
  ['JPEG 中间帧 + 逐帧 CDP 取回', ['--shards', '1', '--frame-format', 'jpeg', '--frame-transport', 'cdp']],
  ['JPEG + 二进制流式上传（1 片）', ['--shards', '1']],
  ['JPEG + 二进制流式上传（4 片）', ['--shards', '4']],
];

let base = null;
const results = [];
for (const [label, args] of rows) {
  const r = run(args);
  if (!r.ok) { console.log(`${label.padEnd(46)} 失败`); continue; }
  if (base === null) base = r.ms;
  results.push({label, ms: r.ms});
  console.log(`${label.padEnd(46)} ${r.ms.toFixed(1).padStart(7)}  ${(base / r.ms).toFixed(2)}×`);
}

console.log('─'.repeat(72));
if (results.length) {
  const first = results[0].ms;
  const last = results[results.length - 1].ms;
  console.log(`\n总提升：${(first / last).toFixed(1)}×（${first.toFixed(1)} → ${last.toFixed(1)} ms/帧）`);
  console.log('注：最初那行是 PNG + 每帧两次 CDP 往返 + base64，现在是 JPEG + 一次调用 + 二进制。');
  console.log('    三者叠加；单独换 JPEG 约 3.75×（见 CHANGELOG 的 A/B）。');
}
rmSync(join(P, '.work', 'bench.mp4'), {force: true});
