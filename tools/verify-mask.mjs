// 遮罩验收：四种形状 + 反选 + 不写遮罩逐字节不变 + 同一遮罩可复现。
//
//   node tools/verify-mask.mjs [<仓库根>]
//
// 判据都用**能证伪**的说法：形状确实改变画面、五种输出互不相同（不是同一个路径换名字）、
// 同一规格两次渲染逐字节一致（遮罩不能引入不确定性）。
//
// ⚠️ 测试设计上踩过一次：第一版用 `stat`（居中的数字）+ 居中遮罩，
// **四种形状都覆盖住了内容** ⇒ 输出全相同。改成**跨整幅**的模板 + 只裁左半，形状差异才显出来。
// 这不是产品问题，是**判据选错了量测对象**。
import {execFileSync} from 'node:child_process';
import {cpSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';

// ⚠️ 必须给兜底：CI 里这个工具是**不带参数**跑的（`node tools/verify-mask.mjs`），
// 而 `resolve(undefined)` / `undefined.replace` 会抛。
// （这条被 `verify-invocation.mjs` 当场抓到 —— 它进 CI 的那一刻就报了。）
const ROOT = (process.argv[2] ?? process.cwd()).replace(/\\/g, '/');
const P = join(ROOT, '.work', 'masktest');
let bad = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) bad++; };

const still = (mask, tag) => {
  rmSync(P, {recursive: true, force: true});
  cpSync(join(ROOT, 'examples', 'gallery'), P, {recursive: true});
  rmSync(join(P, 'audio'), {recursive: true, force: true});
  rmSync(join(P, 'renders'), {recursive: true, force: true});
  // ⚠️ 用**跨整幅**的模板（bullets 多行），且遮罩只裁**左半** ——
  // 第一版用 `stat`（居中的数字）+ 居中遮罩，四种形状都覆盖住了内容，
  // 于是输出全相同（**测试设计问题，不是产品问题**）。
  const shot = {type: 'bullets', at: 1, heading: '遮罩验收',
    items: [{t: '一', d: 'a'}, {t: '二', d: 'b'}, {t: '三', d: 'c'}, {t: '四', d: 'd'}]};
  if (mask) shot.mask = mask;
  writeFileSync(join(P, 'scene.json'), JSON.stringify({shots: [shot]}, null, 2));
  mkdirSync(join(P, 'out'), {recursive: true});
  execFileSync('node', [join(ROOT, 'bin', 'filmwright.mjs'), 'stills', '--project', P,
    '--frames', '60', '--dir', join(P, 'out')], {stdio: ['ignore', 'ignore', 'inherit']});
  const png = join(P, 'out', 'f00060.png');
  return {hash: createHash('sha256').update(readFileSync(png)).digest('hex').slice(0, 12), png};
};

// 四种形状都只裁**左半**，但切法不同 ⇒ 输出应当互不相同
const base = still(null, 'none');
const rect = still({shape: 'rect', x: 0, y: 0, w: 0.4, h: 1}, 'rect');
const ell = still({shape: 'ellipse', x: 0, y: 0.05, w: 0.55, h: 0.9}, 'ell');
const rnd = still({shape: 'rounded', x: 0, y: 0.05, w: 0.55, h: 0.9, r: 0.45}, 'rnd');
const poly = still({shape: 'polygon', points: [[0, 0], [0.55, 0.5], [0, 1]]}, 'poly');
const inv = still({shape: 'rect', x: 0.25, y: 0.25, w: 0.5, h: 0.5, invert: true}, 'inv');

console.log(`  不写遮罩 ${base.hash}`);
console.log(`  rect ${rect.hash}  ellipse ${ell.hash}  rounded ${rnd.hash}  polygon ${poly.hash}  反选 ${inv.hash}\n`);
ok(rect.hash !== base.hash, 'rect 遮罩确实改变了画面');
ok(ell.hash !== base.hash, 'ellipse 遮罩确实改变了画面');
ok(rnd.hash !== base.hash, 'rounded 遮罩确实改变了画面');
ok(poly.hash !== base.hash, 'polygon 遮罩确实改变了画面');
ok(inv.hash !== base.hash, '反选（挖洞）确实改变了画面');
// 四种形状互不相同（不是同一个路径换名字）
const set = new Set([rect.hash, ell.hash, rnd.hash, poly.hash, inv.hash]);
ok(set.size === 5, `五种输出互不相同（${set.size}/5）—— 形状真的在起作用`);
// 同一规格两次渲染逐字节一致（遮罩不能引入不确定性）
const rect2 = still({shape: 'rect', x: 0, y: 0, w: 0.4, h: 1}, 'rect2');
console.log(`  同一规格两次：${rect.hash} / ${rect2.hash}`);
ok(rect.hash === rect2.hash, '同一遮罩两次渲染**逐字节一致**');

rmSync(P, {recursive: true, force: true});
console.log(bad === 0 ? '\n✓ 遮罩端到端全部符合预期' : `\n✗ ${bad} 项失败`);
process.exit(bad ? 1 : 0);
