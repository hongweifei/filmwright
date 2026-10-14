// 增量重渲的**安全性验证**：复用的段必须与重新渲染的结果产生**相同的帧数据**。
//
//   node tools/verify-incremental.mjs [<仓库根>]
//
// ## 为什么比对帧数据、不比对 mp4 哈希
//
// 实测：同一区间、同样参数、**只换输出路径**，两次 mp4 的 sha256 就不同
// （ffmpeg 的 mp4 muxer 会写入与运行相关的元数据，如 creation_time/moov 布局）。
// 所以「mp4 字节相同」既不是复用正确性的必要条件，也不是充分条件 ——
// 用它做判据会得出「同一份内容被判为不同」的假失败（我第一版就栽在这）。
// **正确的判据是解码后的帧数据**：把产物抽成 PNG 再哈希，那才是观众看到的画面。
//
// ## 为什么这条验证最重要
//
// 增量复用的前提是「输入指纹相同 ⇒ 画面相同」。那是**推断**，必须用证据证实：
// 一旦漏掉某个影响画面的输入，就会静默复用旧画面，比崩溃更难发现。
import {existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// resolve() 保证 ROOT 是**绝对路径**：下面会用 `pathToFileURL(`${ROOT}/…`)` 或
// `file:///${ROOT}/…` 拼 URL，相对路径会直接抛 ERR_INVALID_FILE_URL_PATH。
const ROOT = resolve(process.argv[2] ?? resolve(HERE, '..')).replace(/\\/g, '/');
const P = `${ROOT}/examples/minimal`;
const WORK = `${P}/.work`;
const KIT = `${ROOT}/bin/filmwright.mjs`;

/** 产物的**帧数据**指纹：抽若干帧成 PNG 再哈希（不是 mp4 字节）。 */
function frameFingerprint(mp4, frames) {
  const h = createHash('sha256');
  for (const n of frames) {
    const png = join(WORK, `vf-${n}.png`);
    rmSync(png, {force: true});
    spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', mp4,
      '-vf', `select=eq(n\\,${n - 1})`, '-frames:v', '1', png], {encoding: 'utf8', stdio: 'ignore'});
    if (!existsSync(png)) return 'NO_FRAME_' + n;
    h.update(readFileSync(png));
    rmSync(png, {force: true});
  }
  return h.digest('hex').slice(0, 16);
}

// 探针帧必须落在**被改动内容出现的区间**里，否则「改了文件但指纹没变」
// 会是假失败。实测：改 S01 的文案后，帧 106/110/115/120/130 全部变化，
// 而 1/15/30/45/60 一帧都不变（那些帧在 S01 之前）—— 我为此白查了两轮。
const PROBE_FRAMES = [1, 106, 110, 115, 120, 130, 200, 250];

/**
 * 渲染的区间。**必须覆盖被改动的内容所在的帧**，否则「改了文件但画面没变」
 * 会误判成产品 bug —— 我第一版用 1..60，而被改的文案属于 S01（从第 105 帧起），
 * 于是「画面确实变了」这条一直是假失败。
 * minimal 的 S01 从 105 帧开始，所以区间取到 260。
 */
const RANGE = {from: 1, to: 260};

/** 跑一次渲染，返回 {data, ff}（ff = 帧数据指纹）。 */
const render = (extraArgs = []) => {
  const out = join(WORK, 'inc-test.mp4');
  rmSync(out, {force: true});
  const r = spawnSync('node', [KIT, 'render', '--project', P, '--from', String(RANGE.from), '--to', String(RANGE.to),
    '--out', out, '--incremental', '--json', ...extraArgs],
    {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024});
  if (r.status !== 0) {
    console.log('渲染失败:', String(r.stderr).slice(-400));
    return null;
  }
  let data = null;
  try { data = JSON.parse(r.stdout).data; } catch { return null; }
  return {data, ff: frameFingerprint(out, PROBE_FRAMES)};
};

let bad = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) bad++; };

rmSync(join(WORK, 'segments'), {recursive: true, force: true});

console.log('=== 1) 第一次（全渲）===');
const r1 = render();
ok(r1 && r1.data.renderedSegments >= 1 && r1.data.reusedSegments === 0,
  `应全部重渲（rendered=${r1?.data.renderedSegments}, reused=${r1?.data.reusedSegments}）`);
console.log('  帧数据指纹', r1?.ff);

console.log('\n=== 2) 第二次（输入没变）：应全部复用，且**帧数据**完全相同 ===');
const r2 = render();
ok(r2 && r2.data.reusedSegments === r1.data.segments && r2.data.renderedSegments === 0,
  `应全部复用（reused=${r2?.data.reusedSegments}, rendered=${r2?.data.renderedSegments}）`);
ok(r1.ff === r2.ff, `复用产物与重渲产物帧数据相同（${r1.ff} vs ${r2.ff}）`);

console.log('\n=== 3) 改一个影响画面的文件 → 必须重渲且画面变化 ===');
// 注意：examples/minimal 是**手写镜头**项目，没有 scene.json；
// 影响它画面的是 shots/index.js。别假设项目形状（我第一版假设错了）。
const shotsFile = `${P}/shots/index.js`;
const shotsOrig = readFileSync(shotsFile);
let h3ff = null;
{
  const src = shotsOrig.toString('utf8');
  const mutated = src.replace('每一帧 = 一个纯函数', '每一帧 = 一个纯函数（改）');
  if (mutated === src) { console.log('✗ 没找到要改的文案，验证脚本失效'); bad++; }
  else {
    writeFileSync(shotsFile, mutated, 'utf8');
    const r3 = render();
    ok(r3 && r3.data.renderedSegments >= 1, `改了 shots → 必须重渲（rendered=${r3?.data.renderedSegments}）`);
    ok(r3.ff !== r1.ff, `画面确实变了（${r3?.ff} ≠ ${r1.ff}）`);
    h3ff = r3?.ff;

    console.log('\n=== 4) 改回原样 → 帧数据应回到第一次的值 ===');
    writeFileSync(shotsFile, shotsOrig, 'utf8');
    const restored = readFileSync(shotsFile).equals(shotsOrig);
    ok(restored, 'shots/index.js 已字节级还原');
    const r4 = render();
    ok(r4.ff === r1.ff, `改回原样后帧数据回到 r1（${r4?.ff} vs ${r1.ff}）` +
      (h3ff ? `；且不同于改动版 ${h3ff}` : ''));
  }
}

console.log('\n=== 5) 负面对照：改引擎源码（模拟升引擎）必须重渲 ===');
{
  const engFile = `${ROOT}/src/runtime/motion/ease.js`;
  const orig = readFileSync(engFile);
  writeFileSync(engFile, orig.toString('utf8') + '\n// 增量验证：注入一行（不改行为）\n', 'utf8');
  try {
    const r5 = render();
    ok(r5 && r5.data.renderedSegments >= 1, `引擎源码变了 → 必须重渲（rendered=${r5?.data.renderedSegments}）`);
    // 注入的是注释，画面不该变 —— 这正是「同一内容不同输入指纹」的正确行为：
    // 多渲了一次（安全方向），但结果一致。
    ok(r5.ff === r1.ff, `注入注释不改画面（${r5?.ff}）`);
  } finally {
    writeFileSync(engFile, orig);
  }
  ok(readFileSync(engFile).equals(orig), '引擎文件已字节级还原');
}

console.log('\n=== 6) 代理渲染：分辨率减半 ===');
{
  const proxyOut = join(WORK, 'inc-proxy.mp4');
  spawnSync('node', [KIT, 'render', '--project', P, '--from', '1', '--to', '30', '--proxy', '0.5',
    '--out', proxyOut], {encoding: 'utf8', stdio: 'ignore'});
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', proxyOut],
    {encoding: 'utf8'});
  const [w, h] = String(r.stdout).trim().split(',').map(Number);
  ok(w === 640 && h === 360, `--proxy 0.5 → 640×360（实际 ${w}×${h}）`);
  ok(existsSync(proxyOut) && statSync(proxyOut).size > 0, '代理产物非空');
  rmSync(proxyOut, {force: true});
}

rmSync(join(WORK, 'segments'), {recursive: true, force: true});
rmSync(join(WORK, 'inc-test.mp4'), {force: true});
console.log(bad === 0 ? '\n✓ 增量重渲与代理渲染全部符合预期' : `\n✗ ${bad} 项失败`);
process.exit(bad ? 1 : 0);

