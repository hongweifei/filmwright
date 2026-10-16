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
// ## 它自己的负面对照（`--negative`）
//
// 上面那些判据自己也要能被证伪，否则就是"永远绿的检查"。`--negative` 在**临时副本仓库根**里
// 注入两种缺陷（真仓库一个字节都不动），各重跑本工具一遍，要求它**真红、且红在该红的那条判据上**：
//   ① 镜头声明了 mask 但合成时不带过去（`drawFrame.js`）⇒ 五条"遮罩改变了画面"与"五种互不相同"该红；
//   ② `invert` 不再生效（`layer.js` 的 even-odd 那一步）⇒ 只该红"反选与同规格不反选不同"那一条。
// 第 ② 种是**只杀一条**的窄对照 —— 它才证明反选那条判据不是被别的判据顺带守住的。
//
//   node tools/verify-mask.mjs --negative
//
// CI 不跑它（CI 是无参调用）：它要让本工具完整跑两遍，成本同量级。对照成立 ⇒ 退出码 0；
// **对照失效**或判据漏了这种缺陷 ⇒ 退出码 1。
//
// ⚠️ 测试设计上踩过一次：第一版用 `stat`（居中的数字）+ 居中遮罩，
// **四种形状都覆盖住了内容** ⇒ 输出全相同。改成**跨整幅**的模板 + 只裁左半，形状差异才显出来。
// 这不是产品问题，是**判据选错了量测对象**。
import {execFileSync, spawnSync} from 'node:child_process';
import {cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);

// ⚠️ 必须给兜底：CI 里这个工具是**不带参数**跑的（`node tools/verify-mask.mjs`），
// 而 `resolve(undefined)` / `undefined.replace` 会抛。
// （这条被 `verify-invocation.mjs` 当场抓到 —— 它进 CI 的那一刻就报了。）
// ⚠️ 位置参数要**滤掉选项**：`--negative` 也曾被当成仓库根 ⇒ `cpSync('…/--negative/bin')` ENOENT。
const ARGS = process.argv.slice(2);
const NEGATIVE = ARGS.includes('--negative');
const ROOT = (ARGS.find((a) => !a.startsWith('--')) ?? join(HERE, '..')).replace(/\\/g, '/');
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

// ── 负面对照（`--negative`）走的是另一条路：不在真仓库里跑，见文件末尾 runNegativeControl ──
if (NEGATIVE) process.exit(runNegativeControl());

// 四种形状都只裁**左半**，但切法不同 ⇒ 输出应当互不相同
const base = still(null);
const rect = still({shape: 'rect', x: 0, y: 0, w: 0.4, h: 1});
const ell = still({shape: 'ellipse', x: 0, y: 0.05, w: 0.55, h: 0.9});
const rnd = still({shape: 'rounded', x: 0, y: 0.05, w: 0.55, h: 0.9, r: 0.45});
const poly = still({shape: 'polygon', points: [[0, 0], [0.55, 0.5], [0, 1]]});
const inv = still({shape: 'rect', x: 0.25, y: 0.25, w: 0.5, h: 0.5, invert: true});
// 反选必须有**自己的**对照：只断言「与不写遮罩不同」是不够的 —— `invert` 被忽略时
// 就变成"裁中间那块"，照样与不写遮罩不同，那条判据会继续绿。所以再渲一张
// **同规格但不反选**的，两者必须不同（挖洞真的是挖洞）。
const invNo = still({shape: 'rect', x: 0.25, y: 0.25, w: 0.5, h: 0.5});

console.log(`  不写遮罩 ${base.hash}`);
console.log(`  rect ${rect.hash}  ellipse ${ell.hash}  rounded ${rnd.hash}  polygon ${poly.hash}  反选 ${inv.hash} / 同规格不反选 ${invNo.hash}\n`);
ok(rect.hash !== base.hash, 'rect 遮罩确实改变了画面');
ok(ell.hash !== base.hash, 'ellipse 遮罩确实改变了画面');
ok(rnd.hash !== base.hash, 'rounded 遮罩确实改变了画面');
ok(poly.hash !== base.hash, 'polygon 遮罩确实改变了画面');
ok(inv.hash !== base.hash, '反选（挖洞）确实改变了画面');
ok(inv.hash !== invNo.hash, '反选与**同规格不反选**不同（挖洞真的是挖洞，不是换了个裁剪区）');
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

// ═════════════════════════════════════════════════════════════════════════════
// 本工具自己的负面对照（`--negative`）。见文件头。
//
// 只改**临时副本仓库根**里的源码，真仓库一个字节都不动；跑完（含被 Ctrl-C）即清理。
// 每次注入之后**立刻还原**，否则第二种缺陷会叠在第一种上，"只红一条"就量不出来了。
// ═════════════════════════════════════════════════════════════════════════════
function runNegativeControl() {
  const tmp = mkdtempSync(join(tmpdir(), 'fw-mask-neg-'));
  const wipe = () => { try { rmSync(tmp, {recursive: true, force: true}); } catch { /* 尽力而为 */ } };
  // ⚠️ 光靠 try/finally 挡不住"被 kill"：Node 收到 SIGINT/SIGTERM 默认直接终止、**不走 finally**。
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.on(sig, () => { wipe(); process.exit(code); });
  }
  let bad2 = 0;
  const say = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) bad2++; };

  console.log('负面对照：在**临时副本仓库根**里注入缺陷，要求本工具真红（真源码不动）');
  console.log(`  临时仓库根：${tmp}（跑完即删）`);
  try {
    const skipTop = new Set(['audio', 'renders', '.work']);
    cpSync(join(ROOT, 'bin'), join(tmp, 'bin'), {recursive: true});
    cpSync(join(ROOT, 'src'), join(tmp, 'src'), {recursive: true});
    cpSync(join(ROOT, 'package.json'), join(tmp, 'package.json'));
    // 临时仓库根就是新的「库根」⇒ 库自带的那份字体也要跟过去（见 `/fonts/` 的兜底）。
    cpSync(join(ROOT, 'fonts'), join(tmp, 'fonts'), {recursive: true});
    cpSync(SRC, join(tmp, 'examples', 'minimal'), {
      recursive: true,
      filter: (s) => {
        const rel = relative(SRC, s).replace(/\\/g, '/');
        if (!rel) return true;
        if (skipTop.has(rel.split('/')[0])) return false;
        return rel !== 'public/assets/minimal';
      },
    });
    mkdirSync(join(tmp, 'tools'), {recursive: true});
    cpSync(SELF, join(tmp, 'tools', 'verify-mask.mjs'));

    /** 注入一处缺陷 → 在副本上重跑本工具 → 断言它红在该红的那几条判据上。 */
    const inject = (rel, anchor, replacement, label, expects) => {
      const path = join(tmp, ...rel);
      const before = readFileSync(path, 'utf8');
      if (!before.includes(anchor)) {
        // 锚点漂移时**判失败**，不是判通过 —— 否则这条对照会在没人发现的情况下空转。
        say(false, `${label}：注入点没找到（${anchor}）⇒ **对照失效**（不是通过）：实现改过就得修这条对照`);
        return;
      }
      writeFileSync(path, before.replace(anchor, replacement), 'utf8');
      const t0 = Date.now();
      const r = spawnSync(process.execPath, [join(tmp, 'tools', 'verify-mask.mjs'), tmp], {
        encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: tmp,
        // 只放宽"等渲染页就绪"的耐心，一条判据都不读这个变量（机器忙时的已知抖动）。
        env: {...process.env, FILMWRIGHT_BOOT_TRIES: process.env.FILMWRIGHT_BOOT_TRIES || '3600'},
      });
      const out = String(r.stdout || '') + String(r.stderr || '');
      writeFileSync(path, before, 'utf8');                       // 立刻还原
      const fails = out.split('\n').filter((l) => l.startsWith('✗'));
      console.log(`\n  ── ${label}：退出码 ${r.status}，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，` +
        `结尾「${out.trimEnd().split('\n').slice(-1)[0] ?? ''}」`);
      for (const l of fails) console.log(`  | ${l}`);
      say(r.status !== 0, `${label}：带缺陷的引擎让本工具**退出码非 0**（实测 ${r.status}）`);
      const missed = expects.filter((e) => !out.includes(e));
      say(missed.length === 0, `${label}：红在**预期的那组判据**上（命中 ${expects.length - missed.length}/${expects.length}` +
        `${missed.length ? `，漏了：${missed.join(' ／ ')}` : ''}）`);
      const finished = /✗ \d+ 项失败/.test(out);
      say(finished, `${label}：跑完了**全程**（结尾有"✗ N 项失败"）—— 不是启动/渲染崩掉所以红`);
      if (!finished) {
        // 崩掉时**别只印最后 10 行**：真因通常在前面（被注入缺陷的渲染进程的 stderr 是继承下来的）。
        const lines = out.trimEnd().split('\n');
        console.log(`  | （输出共 ${lines.length} 行，下面给前 40 行 + 后 10 行）`);
        for (const l of lines.slice(0, 40)) console.log(`  | ${l}`);
        if (lines.length > 50) console.log('  | …');
        for (const l of lines.slice(-10)) console.log(`  | ${l}`);
      }
    };

    // ① 镜头声明了 mask，但合成时不带过去 ⇒ 遮罩完全不生效。
    // 五条"改变了画面"应当**全部**红（每个带遮罩的渲染都退化成不带遮罩）。
    inject(['src', 'runtime', 'stage', 'drawFrame.js'],
      '    mask: shot.mask ?? null,', '    mask: null,',
      '遮罩不生效', [
        '✗ rect 遮罩确实改变了画面',
        '✗ ellipse 遮罩确实改变了画面',
        '✗ rounded 遮罩确实改变了画面',
        '✗ polygon 遮罩确实改变了画面',
        '✗ 反选（挖洞）确实改变了画面',
        '✗ 五种输出互不相同',
      ]);

    // ② 只有 `invert` 不再生效 ⇒ **只该**红反选那一条。
    // 这是窄对照：它才证明反选那条判据不是被别的判据顺带守住的。
    inject(['src', 'runtime', 'composite', 'layer.js'],
      'if (m.invert) ctx.rect(0, 0, W, H);', 'if (false) ctx.rect(0, 0, W, H);',
      '反选不生效', ['✗ 反选与**同规格不反选**不同']);

    console.log(bad2 === 0
      ? '\n  ⇒ 负面对照成立：确有缺陷时本工具会红，且红在该红的那条判据上。'
      : '\n  ⇒ **负面对照不成立**：要么这条对照失效，要么判据漏了这种缺陷 —— 别当它通过。');
  } finally {
    wipe();
    console.log('  （已清理临时仓库根）');
  }
  return bad2 ? 1 : 0;
}
