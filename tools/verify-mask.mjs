// 遮罩验收：四种形状 + 反选 + 不写遮罩逐字节不变 + 同一遮罩可复现。
//
//   node tools/verify-mask.mjs [<仓库根>]
//
// 夹具是**手写镜头**（`examples/minimal` 拷出来的临时项目 + `shots/index.js` 里 `mask:` 字段），
// 不再有任何 scene.json —— 声明式那层已删，遮罩现在只有一条入口：镜头自己声明。
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
import {dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// ⚠️ 必须给兜底：CI 里这个工具是**不带参数**跑的（`node tools/verify-mask.mjs`），
// 而 `resolve(undefined)` / `undefined.replace` 会抛。
// （这条被 `verify-invocation.mjs` 当场抓到 —— 它进 CI 的那一刻就报了。）
const ROOT = (process.argv[2] ?? join(HERE, '..')).replace(/\\/g, '/');
const P = join(ROOT, '.work', 'masktest');
const SRC = join(ROOT, 'examples', 'minimal');
let bad = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) bad++; };

// 夹具是跨整幅的手写镜头：上下左右都有内容，遮罩边界才量得出来。
// （模板一旦只画在中间，四种形状都盖得住内容 ⇒ 输出全同）
const shotJs = (mask) => `import {theme as C, view, applyDesignScale} from 'filmwright';
export const SHOTS = [
  {start: 1${mask ? `, mask: ${JSON.stringify(mask)}` : ''},
   draw(ctx) {
     ctx.save(); applyDesignScale(ctx);
     ctx.fillStyle = C.bgDeep;
     ctx.fillRect(0, 0, view.W, view.H);
     // 横向条纹铺满整幅 + 竖排文字，左半/右半/上边/下边都有高对比内容
     for (let i = 0; i < 10; i++) {
       ctx.fillStyle = i % 2 ? C.panel : C.panelHi;
       ctx.fillRect(0, (i * view.H) / 10, view.W, view.H / 20);
     }
     ctx.fillStyle = C.text;
     ctx.font = '700 64px sans-serif';
     for (let i = 0; i < 6; i++) ctx.fillText('MASK' + i, 40 + i * 190, 110 + i * 92);
     ctx.restore();
   }},
];
`;

const still = (mask) => {
  rmSync(P, {recursive: true, force: true});
  cpSync(SRC, P, {
    recursive: true,
    filter: (s) => {
      const rel = relative(SRC, s).replace(/\\/g, '/');
      if (!rel) return true;
      // 配音缓存 / 历史产物 / 10MB 成品配音：遮罩验收用不上，拷了只会变慢
      if (['audio', 'renders', '.work'].includes(rel.split('/')[0])) return false;
      return rel !== 'public/assets/minimal';
    },
  });
  mkdirSync(join(P, 'shots'), {recursive: true});
  writeFileSync(join(P, 'shots', 'index.js'), shotJs(mask), 'utf8');
  mkdirSync(join(P, 'out'), {recursive: true});
  execFileSync('node', [join(ROOT, 'bin', 'filmwright.mjs'), 'stills', '--project', P,
    '--frames', '60', '--dir', join(P, 'out')], {stdio: ['ignore', 'ignore', 'inherit']});
  const png = join(P, 'out', 'f00060.png');
  return {hash: createHash('sha256').update(readFileSync(png)).digest('hex').slice(0, 12), png};
};

// 四种形状都只裁**左半**，但切法不同 ⇒ 输出应当互不相同
const base = still(null);
const rect = still({shape: 'rect', x: 0, y: 0, w: 0.4, h: 1});
const ell = still({shape: 'ellipse', x: 0, y: 0.05, w: 0.55, h: 0.9});
const rnd = still({shape: 'rounded', x: 0, y: 0.05, w: 0.55, h: 0.9, r: 0.45});
const poly = still({shape: 'polygon', points: [[0, 0], [0.55, 0.5], [0, 1]]});
const inv = still({shape: 'rect', x: 0.25, y: 0.25, w: 0.5, h: 0.5, invert: true});

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
const rect2 = still({shape: 'rect', x: 0, y: 0, w: 0.4, h: 1});
console.log(`  同一规格两次：${rect.hash} / ${rect2.hash}`);
ok(rect.hash === rect2.hash, '同一遮罩两次渲染**逐字节一致**');

rmSync(P, {recursive: true, force: true});
console.log(bad === 0 ? '\n✓ 遮罩端到端全部符合预期' : `\n✗ ${bad} 项失败`);
process.exit(bad ? 1 : 0);
