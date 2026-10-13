// 素材支持的验证：真开浏览器，确认图片**真的画出来了**，且引错名字会明确报错。
//
// 为什么不能只靠 `check` 通过：`picture()` 即使什么都不画，check 也不会红 ——
// 空的 canvas 不抛错。这里要的是"画出来了"的正面证据 + "引错名字会报"的负面证据。
//
//   node tools/verify-assets.mjs
import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {serveProject} from '../src/host/project/server.mjs';
import {loadProject} from '../src/host/project/load.mjs';
import {findBrowser} from '../src/host/browser/find.mjs';
import {checkAssets} from '../src/host/checks/static/index.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROJ = join(ROOT, 'examples', 'minimal');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let bad = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) bad++;
};

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

const profile = mkdtempSync(join(tmpdir(), 'assets-'));
const chrome = spawn(findBrowser(), ['--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--window-size=1280,720', '--disable-gpu', '--no-first-run',
  '--force-color-profile=srgb', 'about:blank'], {stdio: ['ignore', 'pipe', 'pipe']});
const portFile = join(profile, 'DevToolsActivePort');
let devPort = null;
for (let i = 0; i < 300; i++) {
  if (existsSync(portFile)) { devPort = readFileSync(portFile, 'utf8').split('\n')[0].trim(); break; }
  await sleep(100);
}
const list = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((res) => (ws.onopen = res));
let id = 0; const pending = new Map();
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({id: i, method, params})); });
const evalJs = async (expr) => {
  const rr = await send('Runtime.evaluate', {expression: expr, returnByValue: true, awaitPromise: true});
  return rr.result?.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', {url: base + '/'});
let ready = false;
for (let i = 0; i < 200; i++) {
  ready = await evalJs('window.__ready === true');
  if (ready) break;
  await sleep(100);
}
ok(ready, '渲染页装载就绪');
if (!ready) {
  const be = await evalJs('window.__bootError');
  console.log('  boot 错误：' + be);
}

if (ready) {
  // 素材确实加载进了注册表，且原始尺寸对
  const names = await evalJs('JSON.stringify(window.__assets.names())');
  ok(names && names.includes('filmstrip'), `素材已加载：${names}`);
  const size = await evalJs('JSON.stringify(window.__assets.size("filmstrip"))');
  ok(size === '{"w":640,"h":160}', `原始尺寸读对了：${size}`);

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
}

ws.close(); chrome.kill(); server.closeProject();
await sleep(400);
try { rmSync(profile, {recursive: true, force: true}); } catch {}

console.log(bad === 0 ? '\n素材支持验证全部通过。' : `\n${bad} 项失败。`);
process.exit(bad ? 1 : 0);
