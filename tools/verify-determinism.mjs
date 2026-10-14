// 捕获确定性的**回归验证**：多轮渲染同一区间，全部帧必须逐字节一致。
//
//   node tools/verify-determinism.mjs [<仓库根>] [轮数]
//
// ## 为什么需要这个工具
//
// 曾经有一个真 bug：绘制是纯函数且确定，但取像素走 `Page.captureScreenshot`，
// 而截图取的是**合成器已呈现的那一帧**（异步），于是偶尔取到上一帧。
// 实测 8 轮 × 60 帧里，3 帧出现过「7 次一致 + 1 次孤例」。
//
// 危害被有损编码放大：60 帧里 1 帧不同，编出的 mp4 可能 45/60 帧都不同
// （GOP 与码率控制连锁），像素回归与增量重渲的判据全部失效。
//
// 修法：改成从 **canvas 后备存储**直接读（绘制是同步的，读它没有竞态）。
// 实测：画布直读 0/60 不稳定，截图 3/60 不稳定；且两者**像素完全相同**
// （只是 PNG 编码不同：画布直读体积大，但像素哈希一致）。
//
// 这个工具就是钉住这个性质：**多轮渲染必须完全一致**。
import {createHash} from 'node:crypto';
import {readFileSync, readdirSync, rmSync, mkdirSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {dirname, resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = (process.argv[2] ?? resolve(HERE, '..')).replace(/\\/g, '/');
const ROUNDS = Number(process.argv[3] ?? 6);
const FROM = 1, TO = 60;

const imp = (rel) => import(pathToFileURL(`${ROOT}/${rel}`).href);
const {loadProject} = await imp('src/host/project/load.mjs');
const {renderRange} = await imp('src/host/media/renderRange.mjs');

const P = `${ROOT}/examples/minimal`;
const W = `${ROOT}/.work/determinism`;
rmSync(W, {recursive: true, force: true});
mkdirSync(W, {recursive: true});
const proj = await loadProject(P);

/** 捕获一轮，返回 {帧号: 字节哈希}。走的是产品自己的渲染路径（sess.frame）。 */
const grab = async (round) => {
  const dir = join(W, `r${round}`);
  await renderRange(P, proj, {from: FROM, to: TO, out: null, pngDir: dir});
  const out = {};
  for (const f of readdirSync(dir)) {
    out[Number(f.match(/\d+/)[0])] = createHash('sha256').update(readFileSync(join(dir, f))).digest('hex').slice(0, 12);
  }
  return out;
};

console.log(`=== 捕获 ${FROM}..${TO}，共 ${ROUNDS} 轮 ===`);
const runs = [];
for (let i = 1; i <= ROUNDS; i++) {
  const t0 = Date.now();
  runs.push(await grab(i));
  process.stdout.write(`  第 ${i} 轮  ${Object.keys(runs[i - 1]).length} 帧  ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
}

const frames = Object.keys(runs[0]);
const unstable = [];
for (const n of frames) {
  const vals = new Set(runs.map((r) => r[n]));
  if (vals.size > 1) unstable.push({n, vals: [...vals]});
}

console.log(`\n不稳定帧：${unstable.length} / ${frames.length}`);
for (const u of unstable) {
  const counts = {};
  for (const r of runs) counts[r[u.n]] = (counts[r[u.n]] ?? 0) + 1;
  console.log(`  帧 ${u.n}: ${JSON.stringify(counts)}`);
}

rmSync(W, {recursive: true, force: true});
const ok = unstable.length === 0;
console.log(ok
  ? `\n✓ ${ROUNDS} 轮 × ${frames.length} 帧全部逐字节一致（捕获无竞态）`
  : `\n✗ 仍有 ${unstable.length} 帧不稳定 —— 捕获竞态回来了`);
process.exit(ok ? 0 : 1);
