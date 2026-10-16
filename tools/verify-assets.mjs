// 素材支持的验证：真开浏览器，确认图片**真的画出来了**，且引错名字会明确报错，
// 以及**首遍渲染与再渲逐像素相同**（图片第一次被画出来那一帧最不稳，见 2b 段的注释）。
//
// 为什么不能只靠 `check` 通过：`picture()` 即使什么都不画，check 也不会红 ——
// 空的 canvas 不抛错。这里要的是"画出来了"的正面证据 + "引错名字会报"的负面证据。
//
// 浏览器会话走 src/host/browser/session.mjs 的 openSession（无头、启动失败快速报），
// 工具里不再各写一份启动逻辑 —— 那份拷贝曾漏掉 headless，CI 无显示器直接挂。
//
// ## 它自己的负面对照（`--negative`）
//
// `--negative` 在**临时副本仓库根**里把 `assets.js` 的 `await im.decode()` 去掉（真仓库一个字节都不动），
// 重跑本工具一遍，要求它**真红、且红在"第 469 帧渲两遍逐像素相同"这条判据上**。
// 没有它，2b 那几条判据就是"永远绿的检查"：修好之后它们当然绿，但没人证明它们量得到那个缺陷。
//
//   node tools/verify-assets.mjs            # 正常验收（CI 跑的就是这条）
//   node tools/verify-assets.mjs --negative # 负面对照（CI 不跑：成本同量级）
//
//   node tools/verify-assets.mjs [<仓库根>]
import {spawnSync} from 'node:child_process';
import {cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join, resolve, dirname, relative} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {serveProject} from '../src/host/project/server.mjs';
import {loadProject} from '../src/host/project/load.mjs';
import {openSession} from '../src/host/browser/session.mjs';
import {checkAssets} from '../src/host/checks/static/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);
// 位置参数（临时副本仓库根）要**滤掉选项**，否则 `--negative` 会被当成路径。
const ARGS = process.argv.slice(2);
const NEGATIVE = ARGS.includes('--negative');
const ROOT = resolve(ARGS.find((a) => !a.startsWith('--')) ?? join(HERE, '..'));
const PROJ = join(ROOT, 'examples', 'minimal');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let bad = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) bad++;
};

// 负面对照走另一条路：不在真仓库里跑，见文件末尾 runNegativeControl。
if (NEGATIVE) process.exit(runNegativeControl());

// ---------- 1. 静态：引用了没声明的素材要报（负面对照）----------
{
  const proj = await loadProject(PROJ);
  const good = checkAssets(PROJ, proj.raw);
  ok(good.ok, `静态检查：示例的素材声明没问题（查了 ${good.checked} 处）`);

  // 临时把一个不存在的素材塞进配置 —— 检查必须报「找不到文件」
  const badCfg = {...proj.raw, assets: [...proj.raw.assets, 'assets/nope.png']};
  const r1 = checkAssets(PROJ, badCfg);
  ok(!r1.ok && r1.problems.some((p) => p.includes('nope.png')),
    '负面对照：声明了但文件不存在 → 报出来');

  // 名字重复必须报
  let dupErr = null;
  try {
    const {normalizeConfig} = await import('../src/contract/config.js');
    normalizeConfig({...proj.raw, assets: ['assets/filmstrip.png', 'assets/filmstrip.png']});
  } catch (e) { dupErr = e.message; }
  ok(dupErr && dupErr.includes('重复'), '负面对照：素材名重复 → 配置期就报错');
}

// ---------- 2. 运行时：真开浏览器 ----------
const proj = await loadProject(PROJ);
const server = await serveProject(PROJ, {
  raw: proj.raw, timeline: proj.timeline, shotsRel: 'shots/index.js', watch: false,
});
const base = `http://127.0.0.1:${server.address().port}`;

const r = await fetch(base + '/assets/filmstrip.png');
ok(r.status === 200, `素材能取到：GET /assets/filmstrip.png → ${r.status}`);

let session = null;
try {
  session = await openSession(base + '/', {width: 1280, height: 720});
} catch (e) {
  ok(false, '渲染页装载就绪');
  console.log('  ' + e.message);
  server.closeProject();
  process.exit(1);
}
const evalJs = session.evaluate;

ok(true, '渲染页装载就绪');

// 素材确实加载进了注册表，且原始尺寸对
const names = await evalJs('JSON.stringify(window.__assets.names())');
ok(names && names.includes('filmstrip'), `素材已加载：${names}`);
const size = await evalJs('JSON.stringify(window.__assets.size("filmstrip"))');
ok(size === '{"w":640,"h":160}', `原始尺寸读对了：${size}`);

// ---------- 2b. 素材路径的**首遍渲染必须与再渲逐像素相同** ----------
//
// 为什么要有这一段：`assets.js` 原来只等 `im.onload`、没等 `decode()` —— `onload` 不保证位图解码完成，
// 于是**一个会话里第一次**把带 `shadowBlur` 的图片画出去时，Chrome 会走"边解码边缩放"那条路，
// 和之后走缓存位图的路在重采样上差一点点。实测（examples/minimal）：第 469 帧（图片淡入的第一帧，
// 带 glow）首遍与再渲差 40665 个通道、最大差 9；第 472 帧差 37516、最大 20；490/800 帧则稳定。
// 这直接违反核心不变量「第 N 帧只是 N 的函数」—— 同一帧同一进程里两次渲染居然不一致。
//
// ⚠️ 顺序是判据的一部分：必须在这之前**没有画过任何带图片的帧**，否则图片早就解码完了，缺陷量不出来。
// 所以这一段排在下面 `probe()` 那几帧之前，且第一帧就取"图片第一次真的被画出来"的那一帧。
// ⚠️ `box` 在这个位置还没定义（它在下面量"图片出现前后"时才求），所以这里自己算一遍同一个表达式。
const firstPicture = await evalJs(
  `Math.max(1, window.__filmwright.BLK('S03', 2) - 6) + 1`);   // 夹具里 `c > 0.01` 的第一帧
const det = JSON.parse(await evalJs(`(() => {
  const c = document.getElementById('c');
  const g = c.getContext('2d');
  const snap = () => g.getImageData(0, 0, c.width, c.height).data;
  const out = [];
  for (const frame of ${JSON.stringify([firstPicture, firstPicture + 3, 900])}) {
    window.__renderFrame(frame);
    const a = snap();
    window.__renderFrame(frame);
    const b = snap();
    let diff = 0, max = 0;
    for (let i = 0; i < a.length; i++) {
      const d = Math.abs(a[i] - b[i]);
      if (d) { diff++; if (d > max) max = d; }
    }
    out.push({frame, diff, max});
  }
  return JSON.stringify(out);
})()`));
for (const row of det) {
  ok(row.diff === 0, `第 ${row.frame} 帧渲两遍逐像素相同` +
    (row.diff ? `（差 ${row.diff} 个通道，最大差 ${row.max}）` : ''));
}

// **负面证据**：引用没声明的名字要抛出，且信息里列出可用名字
const err = await evalJs(`(() => { try { window.__assets.get('nope'); return null; } catch (e) { return e.message; } })()`);
ok(err && err.includes('nope') && err.includes('filmstrip'),
  '负面对照：img(\'nope\') 抛错并列出可用名字');
ok(err && err.includes('已声明的素材'), '  错误信息说明了已声明哪些');

// **正面证据**：picture 出现之前 / 之后，那一块区域的像素确实变了
const box = await evalJs(`(() => {
  const n0 = Math.max(1, window.__filmwright.BLK('S03', 2) - 6);
  return n0;
})()`);
const probe = (frame) => evalJs(`(() => {
  window.__renderFrame(${frame});
  const c = document.getElementById('c');
  const g = c.getContext('2d');
  const d = g.getImageData(320, 492, 640, 96).data;
  // 统计"较亮"的像素占比与不同颜色数：图片里有明显亮色，空背景没有
  let lit = 0, uniq = new Set();
  for (let i = 0; i < d.length; i += 4) {
    const s = d[i] + d[i+1] + d[i+2];
    if (s > 240) lit++;
    uniq.add((d[i] >> 4) + ',' + (d[i+1] >> 4) + ',' + (d[i+2] >> 4));
  }
  return {lit, colors: uniq.size};
})()`);

const before = await probe(Math.max(1, box - 40));
const after = await probe(box + 30);
ok(after.colors > before.colors + 3,
  `画面里多了图片的颜色：出现前 ${before.colors} 种 → 出现后 ${after.colors} 种`);
ok(after.lit > before.lit,
  `出现的区域亮度上升（图片带亮色）：${before.lit} → ${after.lit}`);

await session.close();
server.closeProject();
await sleep(400);

console.log(bad === 0 ? '\n素材支持验证全部通过。' : `\n${bad} 项失败。`);
process.exit(bad ? 1 : 0);

// ═════════════════════════════════════════════════════════════════════════════
// 本工具自己的负面对照（`--negative`）。见文件头。
//
// 只改**临时副本仓库根**里的源码，真仓库一个字节都不动；跑完（含被 Ctrl-C）即清理。
// ═════════════════════════════════════════════════════════════════════════════
function runNegativeControl() {
  const tmp = mkdtempSync(join(tmpdir(), 'fw-assets-neg-'));
  const wipe = () => { try { rmSync(tmp, {recursive: true, force: true}); } catch { /* 尽力而为 */ } };
  // ⚠️ 光靠 try/finally 挡不住"被 kill"：Node 收到 SIGINT/SIGTERM 默认直接终止、**不走 finally**。
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.on(sig, () => { wipe(); process.exit(code); });
  }
  let bad2 = 0;
  const say = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) bad2++; };

  console.log('负面对照：在**临时副本仓库根**里去掉 `await im.decode()`，要求本工具真红（真源码不动）');
  console.log(`  临时仓库根：${tmp}（跑完即删）`);
  try {
    const skipTop = new Set(['audio', 'renders', '.work']);
    cpSync(join(ROOT, 'bin'), join(tmp, 'bin'), {recursive: true});
    cpSync(join(ROOT, 'src'), join(tmp, 'src'), {recursive: true});
    cpSync(join(ROOT, 'package.json'), join(tmp, 'package.json'));
    cpSync(join(ROOT, 'fonts'), join(tmp, 'fonts'), {recursive: true});
    cpSync(PROJ, join(tmp, 'examples', 'minimal'), {
      recursive: true,
      filter: (s) => {
        const rel = relative(PROJ, s).replace(/\\/g, '/');
        if (!rel) return true;
        if (skipTop.has(rel.split('/')[0])) return false;
        return rel !== 'public/assets/minimal';
      },
    });
    mkdirSync(join(tmp, 'tools'), {recursive: true});
    cpSync(SELF, join(tmp, 'tools', 'verify-assets.mjs'));

    const path = join(tmp, 'src', 'runtime', 'assets.js');
    const before = readFileSync(path, 'utf8');
    const anchor = '  await im.decode();';
    if (!before.includes(anchor)) {
      // 锚点漂移时**判失败**，不是判通过 —— 否则这条对照会在没人发现的情况下空转。
      say(false, `注入点没找到（${anchor}）⇒ **对照失效**（不是通过）：assets.js 改过就得修这条对照`);
    } else {
      writeFileSync(path, before.replace(anchor, '  // await im.decode();  ← 负面对照：故意去掉'), 'utf8');
      const t0 = Date.now();
      const r = spawnSync(process.execPath, [join(tmp, 'tools', 'verify-assets.mjs'), tmp], {
        encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: tmp,
        // 只放宽"等渲染页就绪"的耐心，一条判据都不读这个变量（机器忙时的已知抖动）。
        env: {...process.env, FILMWRIGHT_BOOT_TRIES: process.env.FILMWRIGHT_BOOT_TRIES || '3600'},
      });
      const out = String(r.stdout || '') + String(r.stderr || '');
      writeFileSync(path, before, 'utf8');                       // 立刻还原
      const fails = out.split('\n').filter((l) => l.startsWith('✗'));
      console.log(`\n  ── 去掉 decode()：退出码 ${r.status}，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，` +
        `结尾「${out.trimEnd().split('\n').slice(-1)[0] ?? ''}」`);
      for (const l of fails) console.log(`  | ${l}`);
      say(r.status !== 0, `去掉 decode() 的引擎让本工具**退出码非 0**（实测 ${r.status}）`);
      const hit = /✗ 第 \d+ 帧渲两遍逐像素相同/.test(out);
      say(hit, '红在**首遍/再渲不一致**那条判据上（那才是这个缺陷的判据）');
      // ⚠️ 结尾那行是 `N 项失败。`（本工具不带 `✗` 前缀），别照抄别的工具的 `/✗ \d+ 项失败/`。
      const finished = /(素材支持验证全部通过。|\d+ 项失败。)/.test(out);
      say(finished, '跑完了**全程**（结尾有"✗ N 项失败"）—— 不是启动/渲染崩掉所以红');
      if (!finished) {
        // 崩掉时**别只印最后 10 行**：真因通常在前面（被注入缺陷的渲染进程的 stderr 是继承下来的）。
        const lines = out.trimEnd().split('\n');
        console.log(`  | （输出共 ${lines.length} 行，下面给前 40 行 + 后 10 行）`);
        for (const l of lines.slice(0, 40)) console.log(`  | ${l}`);
        if (lines.length > 50) console.log('  | …');
        for (const l of lines.slice(-10)) console.log(`  | ${l}`);
      }
    }

    console.log(bad2 === 0
      ? '\n  ⇒ 负面对照成立：去掉 decode() 时本工具会红，且红在首遍/再渲不一致那条判据上。'
      : '\n  ⇒ **负面对照不成立**：要么这条对照失效，要么判据漏了这种缺陷 —— 别当它通过。');
  } finally {
    wipe();
    console.log('  （已清理临时仓库根）');
  }
  return bad2 ? 1 : 0;
}
