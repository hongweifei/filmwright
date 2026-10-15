// 逐字入场（`title.reveal`）验收。
//
//   node tools/verify-reveal.mjs [<仓库根>]
//
// ## 判据
//
// 1. **逐个进场**：第 10 帧 ≠ 第 30 帧 ≠ 第 70 帧（不是整块淡入）
// 2. **不引入不确定性**：同一帧两次渲染**逐字节一致**（每个字的进度只依赖 n）
// 3. **落位后不排坏字**：把「落位后的逐字帧」与「整块画法的同帧」都解成
//    **raw RGB** 逐字节比 —— 这一条是关键，间距/字宽/光晕任一错位都会露出来
// 4. **不写 reveal 就走原路**：与之前逐字节相同（像素回归守着的就是这条）
//
// ⚠️ 第 3 条一开始用 ffmpeg 的 `psnr` 滤镜，它报 `average:inf`，
// 但两个 PNG 的**哈希不同** —— 矛盾。所以改成**解成 raw RGB 直接比字节**，
// 不用一个可能骗人的统计量。（`inf` 也可能是滤镜对同源输入的特殊输出。）
import {execFileSync} from 'node:child_process';
import {cpSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';

// ⚠️ 必须给兜底：CI 里不带参数跑（这条被 verify-invocation.mjs 守着）
const ROOT = (process.argv[2] ?? process.cwd()).replace(/\\/g, '/');
const P = join(ROOT, '.work', 'revealtest');
let bad = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) bad++; };

const shot = (extra, n, tag) => {
  rmSync(P, {recursive: true, force: true});
  cpSync(join(ROOT, 'examples', 'gallery'), P, {recursive: true});
  rmSync(join(P, 'audio'), {recursive: true, force: true});
  rmSync(join(P, 'renders'), {recursive: true, force: true});
  writeFileSync(join(P, 'scene.json'), JSON.stringify({shots: [{at: 1, ...extra}]}, null, 2));
  mkdirSync(join(P, 'out'), {recursive: true});
  execFileSync('node', [join(ROOT, 'bin', 'filmwright.mjs'), 'stills', '--project', P,
    '--frames', String(n), '--dir', join(P, 'out')], {stdio: ['ignore', 'ignore', 'inherit']});
  const png = join(P, 'out', `f${String(n).padStart(5, '0')}.png`);
  return {hash: createHash('sha256').update(readFileSync(png)).digest('hex').slice(0, 12), png};
};

/** 解成 raw RGB 再比 —— 不用统计量，直接比字节。 */
const rawRgb = (png) => execFileSync('ffmpeg',
  ['-v', 'error', '-i', png, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
  {maxBuffer: 64 * 1024 * 1024});

const T = {type: 'title', title: '把内容变成帧', sub: '副标题', kicker: 'KICKER'};
const RV = {stagger: 3, dur: 12, dy: 26};

const f10 = shot({...T, reveal: RV}, 10, 'a');
const f30 = shot({...T, reveal: RV}, 30, 'b');
const f70 = shot({...T, reveal: RV}, 70, 'c');
const f70b = shot({...T, reveal: RV}, 70, 'd');
const plain = shot(T, 70, 'e');

console.log(`  逐字 第10帧 ${f10.hash}  第30帧 ${f30.hash}  第70帧 ${f70.hash}`);
console.log(`  整块 第70帧 ${plain.hash}\n`);
ok(f10.hash !== f30.hash && f30.hash !== f70.hash,
  '第 10 / 30 / 70 帧互不相同 ⇒ 字符是**逐个**进场的，不是整块淡入');
ok(f70.hash === f70b.hash, '同一帧两次渲染**逐字节一致** ⇒ 逐字不引入不确定性');

const a = rawRgb(f70.png), b = rawRgb(plain.png);
const same = a.length === b.length && a.equals(b);
ok(same, same
  ? '落位后的逐字帧与整块画法**逐字节相同**（raw RGB 直接比）⇒ 没有把字排坏'
  : `落位后的逐字帧与整块画法**不同**（${a.length} vs ${b.length} 字节）`
    + ' ⇒ 间距/字宽/光晕有错位，要查');

rmSync(P, {recursive: true, force: true});
console.log(bad === 0 ? '\n✓ 逐字入场全部符合预期' : `\n✗ ${bad} 项失败`);
process.exit(bad ? 1 : 0);
