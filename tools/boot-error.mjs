// 把页面 boot 的真实错误抓出来。此前 debug-page 报 state:{} 是因为
// 我用 CDP evaluate 取的对象里有 undefined，序列化后看起来是空的。
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {mkdtempSync, readFileSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {serveProject} from '../src/host/project/server.mjs';
import {findBrowser} from '../src/host/browser/find.mjs';
import {loadProject} from '../src/host/project/load.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROJ = join(ROOT, 'examples', 'minimal');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const proj = await loadProject(PROJ);
const server = await serveProject(PROJ, {
  raw: proj.raw, timeline: proj.timeline, shotsRel: 'shots/index.js',
});
const url = `http://127.0.0.1:${server.address().port}/`;

const profile = mkdtempSync(join(tmpdir(), 'dbg2-'));
const chrome = spawn(findBrowser(), ['--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--headless=new', '--window-size=1280,720', '--disable-gpu', '--no-first-run',
  '--force-color-profile=srgb', 'about:blank'], {stdio: ['ignore', 'pipe', 'pipe']});
let chromeErr = '';
chrome.stderr.on('data', (d) => (chromeErr += d.toString().slice(0, 2000)));
chrome.on('error', (e) => (chromeErr += ' spawn error: ' + e.message));

const portFile = join(profile, 'DevToolsActivePort');
let devPort = null;
for (let i = 0; i < 300; i++) {
  if (existsSync(portFile)) { devPort = readFileSync(portFile, 'utf8').split('\n')[0].trim(); break; }
  if (chrome.exitCode !== null) {
    console.error('浏览器提前退出：' + chromeErr);
    process.exit(1);
  }
  await sleep(100);
}
if (!devPort) {
  console.error('等不到 DevToolsActivePort；stderr=' + chromeErr);
  process.exit(1);
}
const list = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json();
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));

let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    console.log('[EXCEPTION]', d.exception?.description || d.text);
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    console.log('[console.error]', m.params.args.map((a) => a.value ?? a.description).join(' '));
  }
};
const send = (method, params = {}) => new Promise((res) => {
  const myId = ++id; pending.set(myId, res);
  ws.send(JSON.stringify({id: myId, method, params}));
});
await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', {url});
await sleep(6000);

// 分别取三个值，避免对象序列化把 undefined 吞掉
for (const expr of ['String(window.__ready)', 'JSON.stringify(window.__info || null)',
                    'String(window.__bootError || "none")']) {
  const r = await send('Runtime.evaluate', {expression: expr, returnByValue: true});
  console.log('  ' + expr + ' => ' + JSON.stringify(r.result?.result?.value));
}
ws.close(); chrome.kill(); server.close();
try { rmSync(profile, {recursive: true, force: true}); } catch {}
process.exit(0);
