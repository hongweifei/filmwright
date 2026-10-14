// 稳态性能基准：**把测法固定下来**，避免重复犯同一类错误。
//
//   node tools/probes/bench-steady.mjs [<仓库根>] [起始帧] [长度] [--shards N] [--gpu]
//
// ## 为什么要专门做一个"方法固定"的工具
//
// 在这条性能线上我已经错了**三次**，共同点都是**用了不具代表性的测量**：
//
//   1. 把 `flush()/N`（**吞吐**）当成每帧成本（**延迟**）→ 高估收益 7.5×（实际 1.34×）
//   2. 拿 360 帧的分片对比当稳态 → 得出"2 片最好"的错结论（实际 4 片更好）
//   3. 直到重测才发现 #2
//
// 还发现：**同一台机器上，不同镜头的每帧成本差 2.1×**
// （帧 1–360 约 19.3ms/帧，帧 361–1600 约 40.8ms/帧）。
// ⇒ **脱离区间的 ms/帧没有意义。**
//
// ## 这个工具强制做到的四件事
//
//   1. **区间显式写出**（起始帧 + 长度），不写就没法比 —— 输出里一定带上它；
//   2. **差分法扣启动**：渲 len 与 2len 两段，边际成本 = (T2 − T1) / len。
//      启动是一次性的（约 1.7s），摊到短区间上会把数字算得虚高；
//   3. **同一次运行内配对**：要比两种配置，就在同一进程里交替跑，不跨运行比；
//   4. **重复次数 + 交替正反序**：默认 2 轮取中位数；奇数轮把长短段反过来跑，
//      抵消"长段享受热缓存"的顺序效应（不这么做会把启动开销估到 3 倍虚高，实测踩到）；
//   5. **只跟同一轮里的其它数字比**：机器负载与热状态会随时间变 ——
//      实测同一个 300 帧区间，几轮前 19.3ms/帧、几轮后 74ms/帧（差 3.8×）。
//      **跨时间的绝对数字不可比**，要比配置就必须在同一次运行里交替跑。
import {spawnSync} from 'node:child_process';
import {rmSync, statSync} from 'node:fs';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith('--'));
const ROOT = resolve(positional[0] && !/^\d+$/.test(positional[0]) ? positional[0] : join(HERE, '..', '..'));
const FROM = Number(positional.find((a) => /^\d+$/.test(a)) ?? 1);
const LEN = Number(positional.filter((a) => /^\d+$/.test(a))[1] ?? 400);
const flag = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? (argv[i + 1] ?? true) : d;
};
const SHARDS = Number(flag('--shards', 1));
const PROJECT = flag('--project', join(ROOT, 'examples', 'scenecast'));
const WORK = join(ROOT, '.work', 'bench');

function run(from, to) {
  const out = join(WORK, `f${from}-${to}.mp4`);
  rmSync(out, {force: true});
  const args = ['render', '--project', PROJECT, '--from', String(from), '--to', String(to),
    '--shards', String(SHARDS), '--out', out];
  if (argv.includes('--gpu')) args.push('--gpu');
  const fmt = flag('--frame-format', null);
  if (fmt) args.push('--frame-format', String(fmt));
  const t0 = Date.now();
  const r = spawnSync('node', [join(ROOT, 'bin', 'filmwright.mjs'), ...args],
    {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
  const secs = (Date.now() - t0) / 1000;
  if (r.status !== 0) {
    console.error(`  渲染 ${from}–${to} 失败：`, String(r.stderr).slice(-400));
    process.exit(1);
  }
  return {secs, bytes: statSync(out).size};
}

const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
console.log('稳态基准（差分法扣启动）\n');
console.log(`  项目 ${PROJECT.replace(ROOT, '.').replace(/\\/g, '/')}`);
console.log(`  区间 ${FROM}–${FROM + LEN - 1}（长度 ${LEN}）与 ${FROM}–${FROM + 2 * LEN - 1}（长度 ${2 * LEN}）`);
console.log(`  分片 ${SHARDS}${argv.includes('--gpu') ? '  --gpu' : ''}${flag('--frame-format', null) ? '  --frame-format ' + flag('--frame-format', null) : ''}\n`);

const t1s = [], t2s = [];
const ROUNDS = Number(flag('--rounds', 2));
// ⚠️ **交替正反序**：先跑短段再跑长段，长段会享受热缓存（磁盘/JIT/CPU 升频），
// 于是把"启动开销"估得虚高（实测估出 4999ms，而单独量是约 1700ms）。
// 奇数轮反过来跑，让顺序效应在取中位数时被抵消。
for (let i = 0; i < ROUNDS; i++) {
  if (i % 2 === 0) {
    t1s.push(run(FROM, FROM + LEN - 1).secs);
    t2s.push(run(FROM, FROM + 2 * LEN - 1).secs);
  } else {
    t2s.push(run(FROM, FROM + 2 * LEN - 1).secs);
    t1s.push(run(FROM, FROM + LEN - 1).secs);
  }
}
const t1 = med(t1s), t2 = med(t2s);
const marginal = ((t2 - t1) / LEN) * 1000;
const startup = t1 * 1000 - marginal * LEN;

console.log(`  短段 ${t1.toFixed(2)}s（${(t1 * 1000 / LEN).toFixed(1)} ms/帧，**含启动**）`);
console.log(`  长段 ${t2.toFixed(2)}s（${(t2 * 1000 / (2 * LEN)).toFixed(1)} ms/帧，**含启动**）`);
console.log(`\n  ⇒ **稳态 ${marginal.toFixed(1)} ms/帧**（区间 ${FROM}–${FROM + LEN - 1}，分片 ${SHARDS}）`);
console.log(`  ⇒ 启动开销约 ${startup.toFixed(0)} ms（一次性）`);
console.log(`  ⇒ ${(1000 / 30 / marginal).toFixed(2)}× realtime（按 30fps 折算）`);
console.log(`\n  ⚠️ 报数字时必须带上"区间"：同机不同镜头可差 2 倍以上。`);
rmSync(WORK, {recursive: true, force: true});
