// 增量重渲的**安全性验证**：只保留本工具独有的三条判据。
//
//   node tools/verify-incremental.mjs [<仓库根>]
//
// ## 三条判据（别的地方守不了）
//
//   (a) 引擎源码变更必须让段缓存**全部**失效 —— 全仓只有这一处动 `src/runtime/motion/ease.js`，
//       只有这里能证明「升了引擎不会拿旧引擎渲的画面」。
//   (b) 改一个影响画面的文件 → 帧数据确实变了 → 改回原样 → 帧数据**精确回到基线**（区间内逐帧）。
//   (c) 复用产物与全量重渲的帧数据**逐位相同**。
//
// ## 已经从本文件删掉的（别再加回来）
//
//   · 「首跑全渲 / 二跑全复用」的计数断言 —— 与 `verify-attribution`（A/B 步）和
//     `verify-complex`（④）逐条重复，那两处已守；
//   · 「`--proxy 0.5` → 640×360」—— 与 `verify-complex` ③ 逐字重复。
//   它们各自都要在这里再跑一遍同样的渲染，只增加墙钟、不增加覆盖面（见 docs/qc.md）。
//
// ## 为什么比对**帧数据**、不比对 mp4 哈希
//
// 实测：同一区间、同样参数、**只换输出路径**，两次 mp4 的 sha256 就不同
// （ffmpeg 的 mp4 muxer 会写入与运行相关的元数据，如 creation_time/moov 布局）。
// 所以「mp4 字节相同」既不是复用正确性的必要条件，也不是充分条件 ——
// 用它做判据会得出「同一份内容被判为不同」的假失败（我第一版就栽在这）。
// **正确的判据是解码后的帧数据**：那才是观众看到的画面。
//
// ## 判据口径（两条硬规矩）
//
//   · 指纹覆盖渲染区间的**每一帧**，不抽样。旧版只采 8 帧（约 3%），而那 8 个帧号是
//     写死的实现常量 —— 既弱又脆。现在整段解码后逐帧哈希。
//   · 渲染区间从**夹具自己的数据**算（第 1 句的结束帧），不写死帧号：被改的文案属于 S01，
//     区间不覆盖它的话「改了文件但画面没变」会成为假失败。
//
// ## 为什么要动真源码，以及怎么保证不留痕
//
// 手写镜头项目只能靠改 `shots/index.js` 来改画面，升引擎那条要改 `src/runtime/motion/ease.js`。
// 两处都在 `withEdited()` 里跑：抛错走 finally，**Ctrl-C / CI 取消走信号钩子**
// （Node 收到 SIGINT/SIGTERM 默认直接终止，**不会**执行 finally，只写 try/finally 挡不住「中途被杀」）。
import {createHash} from 'node:crypto';
import {readFileSync, rmSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// resolve() 保证 ROOT 是**绝对路径**：下面会用 `${ROOT}/…` 拼路径，相对路径会挂。
const ROOT = resolve(process.argv[2] ?? resolve(HERE, '..')).replace(/\\/g, '/');
const P = `${ROOT}/examples/minimal`;
const WORK = `${P}/.work`;
const KIT = `${ROOT}/bin/filmwright.mjs`;
const SEGMENTS = join(WORK, 'segments');
const OUT = join(WORK, 'inc-test.mp4');

// 渲染区间到第 1 句结束为止 —— 从夹具的时间轴算，不写死帧号。
const S01 = JSON.parse(readFileSync(`${P}/script/timeline.json`, 'utf8')).sentences
  .find((s) => s.id === 'S01');
if (!S01) {
  console.log('✗ 夹具里找不到 S01，本验证的前提不成立');
  process.exit(1);
}
const FROM = 1;
const TO = S01.to;

/**
 * 产物的**帧数据**指纹：整段解码后的原始像素逐帧哈希（不是 mp4 字节，也不是抽样帧）。
 *
 * 用 ffmpeg 的 `framemd5`：它哈希的是**解码后的像素**，一次解码到底，比逐帧 select 抽 PNG
 * 更快也更全。返回 `null` 表示取不到 —— 取不到要比出「相同」更该被当成失败。
 */
function frameFingerprint(mp4) {
  const r = spawnSync('ffmpeg',
    ['-v', 'error', '-i', mp4, '-map', '0:v:0', '-f', 'framemd5', '-'],
    {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
  if (r.status !== 0) return null;
  const sums = String(r.stdout).split('\n')
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => l.trim().split(',').pop().trim());   // 只取每帧的像素哈希，丢掉时间戳/尺寸
  if (!sums.length) return null;
  return {frames: sums.length, hash: createHash('sha256').update(sums.join('\n')).digest('hex').slice(0, 16)};
}

// 指纹必须**两边都取到了**才谈相等/不等：`null === null` 会让判据假绿。
const sameFp = (a, b) => Boolean(a) && Boolean(b) && a.frames === b.frames && a.hash === b.hash;
const differFp = (a, b) => Boolean(a) && Boolean(b) && !sameFp(a, b);
const showFp = (fp) => (fp ? `${fp.frames} 帧/${fp.hash}` : '取不到');

/** 跑一次增量渲染，返回 `{data, fp}`（fp = 该产物整段的帧数据指纹）。 */
const render = () => {
  rmSync(OUT, {force: true});
  const r = spawnSync('node', [KIT, 'render', '--project', P, '--from', String(FROM), '--to', String(TO),
    '--out', OUT, '--incremental', '--json'],
    {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024});
  if (r.status !== 0) {
    console.log('渲染失败:', String(r.stderr).slice(-400));
    return null;
  }
  let data = null;
  try { data = JSON.parse(r.stdout).data; } catch { return null; }
  return {data, fp: frameFingerprint(OUT)};
};

/** 此刻处于「临时改动」状态、需要还原的真文件（信号钩子里要用）。 */
const pendingRestore = new Set();
const restoreAll = () => { for (const f of [...pendingRestore]) f(); };
// Node 收到 SIGINT/SIGTERM 默认直接终止，走不到 finally —— 这两个钩子才是「中途被杀」的兜底。
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.on(sig, () => { restoreAll(); process.exit(code); });
}

/**
 * 临时把 file 改成 text 跑 body，**任何退出路径**都还原：
 * 抛错走 finally，Ctrl-C / CI 取消走上面的信号钩子。
 */
function withEdited(file, text, body) {
  const orig = readFileSync(file);
  const restore = () => {
    try { if (!readFileSync(file).equals(orig)) writeFileSync(file, orig); } catch {}
  };
  pendingRestore.add(restore);
  try {
    writeFileSync(file, text, 'utf8');
    return body();
  } finally {
    restore();
    pendingRestore.delete(restore);
  }
}

let bad = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) bad++; };

rmSync(SEGMENTS, {recursive: true, force: true});

console.log(`=== 1) 基线：段缓存已清空，全量重渲 ${FROM}-${TO} 帧 ===`);
const base = render();
ok(base !== null && base.fp !== null, `基线渲染成功并取到帧数据（${showFp(base?.fp)}，` +
  `segments=${base?.data?.segments}）`);

console.log('\n=== 2) (c) 复用产物 vs 全量重渲：帧数据必须逐位相同 ===');
// 基线的段缓存是刚清空后重建的，所以这一步「同输入 ⇒ 命中原键」。
const reused = render();
ok(sameFp(base?.fp, reused?.fp),
  `复用产物与全量重渲逐位相同（${showFp(reused?.fp)} vs ${showFp(base?.fp)}）`);
// ⚠️ 上面那条只证明「复用没有改变结果」—— 若复用彻底失效、每段都重渲一遍，它**照样绿**。
// 原来这条计数断言（第二跑必须一段都不重渲）挂在 `verify-attribution` 的 B 步上，
// 而那个工具随声明式一起删了 ⇒ 覆盖必须回到这里，否则"复用"就只剩半条判据。
ok(Boolean(reused?.data) && reused.data.reusedSegments === reused.data.segments && reused.data.renderedSegments === 0,
  `第二次同输入渲染**全部命中缓存**（reused=${reused?.data?.reusedSegments}/${reused?.data?.segments}, ` +
  `rendered=${reused?.data?.renderedSegments}）—— 复用真的在发生，不是每段重渲`);

console.log('\n=== 3) (b) 改文件 → 画面变 → 改回原样 → 精确回到基线 ===');
// 注意：examples/minimal 是**手写镜头**项目，没有 scene.json；
// 影响它画面的是 shots/index.js。别假设项目形状（我第一版假设错了）。
const shotsFile = `${P}/shots/index.js`;
const shotsOrig = readFileSync(shotsFile);
{
  const src = shotsOrig.toString('utf8');
  const mutated = src.replace('每一帧 = 一个纯函数', '每一帧 = 一个纯函数（改）');
  if (mutated === src) {
    console.log('✗ 没找到要改的文案，本验证的前提不成立');
    bad++;
  } else {
    withEdited(shotsFile, mutated, () => {
      const changed = render();
      // 这一条是 (b) 的**前提**：改动若没让帧数据变，「改回原样回到基线」就是空转。
      ok(differFp(changed?.fp, base?.fp), `改了 shots → 帧数据确实变了（${showFp(changed?.fp)}）`);

      // 改回原样（字节级）后再渲一次：区间内**每一帧**都要回到基线。
      writeFileSync(shotsFile, shotsOrig, 'utf8');
      ok(readFileSync(shotsFile).equals(shotsOrig), 'shots/index.js 已字节级还原');
      const restored = render();
      ok(sameFp(restored?.fp, base?.fp),
        `改回原样后帧数据精确回到基线（${showFp(restored?.fp)} vs ${showFp(base?.fp)}）`);
    });
  }
}

console.log('\n=== 4) (a) 引擎源码变更 → 所有段缓存必须失效 ===');
// 注入的是注释，画面不该变 —— 这正是「同一内容、不同输入指纹」的正确行为：
// 多渲一次（安全方向），但结果逐位一致。
{
  const engFile = `${ROOT}/src/runtime/motion/ease.js`;
  const orig = readFileSync(engFile);
  let r = null;
  withEdited(engFile, orig.toString('utf8') + '\n// 增量验证：注入一行注释（不改行为）\n',
    () => { r = render(); });
  const d = r?.data;
  // 引擎指纹进的是**每个**段键，所以不是「至少渲一段」而是「一段都不许复用」。
  ok(Boolean(d) && d.renderedSegments === d.segments && d.reusedSegments === 0,
    `引擎源码变了 → 所有段必须失效重渲（rendered=${d?.renderedSegments}/${d?.segments}, reused=${d?.reusedSegments}）`);
  ok(sameFp(r?.fp, base?.fp), `注入注释不改画面（${showFp(r?.fp)} vs ${showFp(base?.fp)}）`);
  ok(readFileSync(engFile).equals(orig), '引擎文件已字节级还原');
}

rmSync(SEGMENTS, {recursive: true, force: true});
rmSync(OUT, {force: true});
console.log(bad === 0 ? '\n✓ 增量重渲安全性三条判据全部符合预期' : `\n✗ ${bad} 项失败`);
process.exit(bad ? 1 : 0);
