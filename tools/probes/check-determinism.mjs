// **快速**确定性检查：同一个效果、同一帧、两次渲染，比哈希。
//
//   node tools/probes/check-determinism.mjs [<仓库根>] [预设名|all]
//
// ## 为什么需要它（而不是只用 verify-effects）
//
// `verify-effects` 里已经有"每个效果都必须同一帧两次渲染逐字节一致"那一节，
// 但它**跑一次约 10 分钟**（要跑完前面六节）。排查 `displace` 这类问题时，
// 每改一版着色器就要等 10 分钟 —— **迭代太慢**。
//
// 这个工具只做那一件事：**约 1 分钟**跑完所有效果。判据与 verify-effects 完全一致，
// 所以它定位到的问题可以直接用 verify-effects 复核。
//
// ## 它怎么帮 `displace` 排查（上一轮写下的下一步）
//
// 拿掉噪声、换成一个**常量位移**先确认稳定，再逐块加回 `h()` → `vn()` → 双 `vn` 调用，
// **看哪一块开始不稳定**。每加一块跑一次这个工具（1 分钟），而不是 10 分钟。
//
// ## 两个已经被它排除的猜测（有证据，不是推断）
//
//   · `grain` 用 `fract(sin(dot(...)) * 43758.5453)` 这种 hash ⇒ 一致，**hash 没问题**；
//   · `distort` 会偏移纹理采样坐标 ⇒ 一致，**偏移采样也没问题**。
import {execFileSync} from 'node:child_process';
import {cpSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const ROOT = resolve(argv[0] && !argv[0].startsWith('--') ? argv[0] : join(HERE, '..', '..'));
const WHICH = argv.find((a) => !a.startsWith('--') && !a.includes('/') && !a.includes('\\')
  && !/^[A-Za-z]:/.test(a)) ?? 'all';

/** 每个效果一份"能真正生效"的参数（`amount=0` 会直通，测不到东西）。 */
const PRESETS = {
  blur: {radius: 12}, glow: {intensity: 0.6, threshold: 0.6}, color: {saturation: 0.6},
  vignette: {amount: 0.5}, chromatic: {amount: 0.5}, grain: {amount: 0.35},
  pixelate: {size: 10}, radialBlur: {amount: 0.3}, distort: {amount: 0.5},
  grade: {look: 'noir', amount: 1},
  displace: {amount: 0.8, frequency: 8},
};

const P = join(ROOT, '.work', 'detprobe');
const FRAME = 100;

// ⚠️ `frame` 参数**必须真的用上** —— 第一版忘了传它，于是"不同帧"的比较
// 实际比的是同一帧（那种"测试恒真"的 bug 只有对着代码看才发现）。
const renderOnce = (fx, frame = FRAME) => {
  rmSync(P, {recursive: true, force: true});
  cpSync(join(ROOT, 'examples', 'gallery'), P, {recursive: true});
  rmSync(join(P, 'audio'), {recursive: true, force: true});
  rmSync(join(P, 'renders'), {recursive: true, force: true});
  // ⚠️ **不要删 public/**：gallery 声明了 assets，删了会"素材加载失败"、页面起不来。
  // ⚠️ `effects: []` **不是合法输入**（校验要求非空数组）。基线用例要**不写这个字段**。
  const shot = {type: 'bullets', at: 1, heading: '确定性',
    items: [{t: '一', d: 'a'}, {t: '二', d: 'b'}, {t: '三', d: 'c'}]};
  if (fx.length) shot.effects = fx;
  writeFileSync(join(P, 'scene.json'), JSON.stringify({shots: [shot]}, null, 2));
  mkdirSync(join(P, 'out'), {recursive: true});
  execFileSync('node', [join(ROOT, 'bin', 'filmwright.mjs'), 'stills', '--project', P,
    '--frames', String(frame), '--dir', join(P, 'out')], {stdio: ['ignore', 'ignore', 'inherit']});
  return createHash('sha256')
    .update(readFileSync(join(P, 'out', `f${String(frame).padStart(5, '0')}.png`)))
    .digest('hex').slice(0, 12);
};

const names = WHICH === 'all' ? Object.keys(PRESETS) : [WHICH];
console.log(`快速确定性检查（同一帧 ${FRAME} 渲染两次，比哈希）\n`);
let bad = 0;
for (const n of names) {
  if (!PRESETS[n]) { console.log(`  ✗ 未知效果：${n}（可用 ${Object.keys(PRESETS).join(' / ')}）`); bad++; continue; }
  const fx = [{type: n, ...PRESETS[n]}];
  const a = renderOnce(fx);
  const b = renderOnce(fx);
  const same = a === b;
  if (!same) bad++;
  console.log(`  ${same ? '✓' : '✗'} ${n.padEnd(11)} ${a} / ${b}${same ? '' : '  ← **不一致：违反"第 N 帧只是 N 的函数"**'}`);
}
rmSync(P, {recursive: true, force: true});

// ── 附带的**行为**判据：`displace` 的参数真的生效吗 ──
// 只用站得住的判据。原本想写"frequency 大 ⇒ 高频含量上升"，
// 但实测**不成立**（位移类效果对边缘能量的影响不稳定），
// 改成"不同 frequency 输出不同"—— 能证伪、也不会假阳性。
// ⚠️ 这一节本该放进 `tools/verify-effects.mjs`（那里是守门工具的家），
// 但写它的时候**机器负载过高**（`渲染页 130.7s 内没就绪`），那个工具跑一次约 10 分钟、
// 当时跑不完 —— **不提交没跑过的验证代码**，所以先放在这个跑得动的探针里（约 1 分钟）。
// 等机器空闲时应把它挪进 verify-effects。
console.log('\n行为判据（displace）：');
const hashes = {};
const get = (fx, n) => { const k = JSON.stringify([fx, n]); hashes[k] ??= renderOnce(fx, n); return hashes[k]; };
const base = renderOnce([], FRAME);
const h8 = get([{type: 'displace', amount: 0.8, frequency: 8}], 100);
const checks = [
  ['displace 改变了画面', h8 !== base],
  ['displace amount=0 与不写 effects 逐位相同（直通）', get([{type: 'displace', amount: 0}], 100) === base],
  ['frequency 真的在起作用（30 ≠ 8）', get([{type: 'displace', amount: 0.8, frequency: 30}], 100) !== h8],
  ['displace 与 distort 同参数下输出不同（不是同一个效果）',
    get([{type: 'distort', amount: 0.8, frequency: 8}], 100) !== h8],
];
const ph = [{frame: 1, v: 0}, {frame: 40, v: 150, ease: 'linear'}];
const p1 = get([{type: 'displace', amount: 0.8, phase: ph}], 100);
checks.push(['phase 关键帧让不同帧不同（热浪在流动）',
  p1 !== get([{type: 'displace', amount: 0.8, phase: ph}], 130)]);
checks.push(['带 phase 轨道时同一帧仍逐字节一致',
  p1 === get([{type: 'displace', amount: 0.8, phase: ph}], 100)]);
for (const [name, okc] of checks) {
  if (!okc) bad++;
  console.log(`  ${okc ? '✓' : '✗'} ${name}`);
}

rmSync(P, {recursive: true, force: true});
console.log(bad === 0 ? '\n✓ 全部逐字节一致，且 displace 的行为判据全过' : `\n✗ ${bad} 项失败`);
process.exit(bad ? 1 : 0);
