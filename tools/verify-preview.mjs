// 预览页的端到端验证：真开浏览器，验证拖动、播放、热重载都真的生效。
//
// 为什么必须真开浏览器：预览页的价值就是「人能看到」。
// 只测 CLI 起没起来，等于没测。
//
//   node tools/verify-preview.mjs
//
// 浏览器会话走 src/host/browser/session.mjs 的 openSession（无头、快速失败）；
// 预览页有自己的就绪信号，用 readyExpr 覆盖。
import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {serveProject} from '../src/host/project/server.mjs';
import {loadProject} from '../src/host/project/load.mjs';
import {openSession} from '../src/host/browser/session.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROJ = join(ROOT, 'examples', 'minimal');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let bad = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) bad++;
};

const proj = await loadProject(PROJ);
const server = await serveProject(PROJ, {
  raw: proj.raw, timeline: proj.timeline, shotsRel: 'shots/index.js', watch: true,
});
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

// ---------- 1. 预览页与它依赖的模块都能取到 ----------
for (const p of ['/preview', '/kit/runtime/stage/index.js', '/proj/shots/index.js', '/__filmwright/project.js']) {
  const r = await fetch(base + p);
  ok(r.status === 200, `GET ${p} → ${r.status}`);
}

// ---------- 2. 真开浏览器操作 ----------
// openSession 在这里就保证了就绪：失败（含超时）会抛错并退出，后面不用再判。
let session = null;
try {
  session = await openSession(base + '/preview', {width: 1400, height: 900}, {
    readyExpr: 'window.__preview && window.__preview.ready === true',
  });
} catch (e) {
  ok(false, '预览页装载就绪（window.__preview.ready）');
  console.log('  ' + e.message);
  server.closeProject();
  process.exit(1);
}
const evalJs = session.evaluate;
ok(true, '预览页装载就绪（window.__preview.ready）');

// ---------- 3. 拖动时间轴 ----------
await evalJs('window.__preview.paint(700)');
await sleep(200);
const f1 = await evalJs('window.__preview.frame');
ok(f1 === 700, `paint(700) 后当前帧 = ${f1}`);

// 边界：不能超出总帧数
await evalJs('window.__preview.paint(99999)');
const f2 = await evalJs('window.__preview.frame');
const totalFrames = proj.timeline.total_frames;
ok(f2 === totalFrames, `paint(99999) 被夹到末帧 ${f2}（总 ${totalFrames}）`);
await evalJs('window.__preview.paint(-5)');
ok(await evalJs('window.__preview.frame') === 1, 'paint(-5) 被夹到第 1 帧');

// 滑杆与读数跟着走
const slider = await evalJs('document.getElementById("scrub").value');
ok(Number(slider) === 1, `滑杆同步到 ${slider}`);

// ---------- 4. 播放 ----------
await evalJs('window.__preview.paint(1)');
await evalJs('window.__preview.toggle()');
ok(await evalJs('window.__preview.playing') === true, '播放已开始');
await sleep(700);
const during = await evalJs('window.__preview.frame');
ok(during > 1, `播放 0.7 秒后推进到第 ${during} 帧`);
await evalJs('window.__preview.toggle()');
ok(await evalJs('window.__preview.playing') === false, '播放已停止');

// ---------- 5. 画面真的画出来了（不是空白 canvas） ----------
await evalJs('window.__preview.paint(700)');
await sleep(200);
const ink = await evalJs(`(() => {
  const c = document.getElementById('c');
  const g = c.getContext('2d');
  const d = g.getImageData(60, 110, c.width - 120, c.height - 230).data;
  let lit = 0;
  for (let i = 0; i < d.length; i += 40) if (d[i] + d[i+1] + d[i+2] > 90) lit++;
  return lit;
})()`);
ok(ink > 20, `画面有内容（内容区亮点采样 ${ink}）`);

// ---------- 6. 热重载：改文件应触发 SSE ----------
// 步骤要清楚：① 页面里开始订阅 ② 等订阅建立 ③ 从 Node 侧碰文件 ④ 看页面是否收到。
// 注意：必须等订阅**真的建立**再碰文件，否则写文件发生在订阅之前，什么都收不到
// （这个坑踩过：探针写在前面，页面一直报没收到）。
const shotsFile = join(PROJ, 'shots', 'index.js');
const orig = readFileSync(shotsFile, 'utf8');

await evalJs(`window.__reloadSeen = false;
  window.__es = new EventSource('/__filmwright/watch');
  window.__es.onopen = () => { window.__esOpen = true; };
  window.__es.onmessage = (ev) => {
    try { if (JSON.parse(ev.data).reload) window.__reloadSeen = true; } catch {}
  };`);

// 等 onopen（最多 10 秒）——不能只 sleep 一个固定值。
// 给 10 秒而不是 5 秒，是给「机器同时在跑别的浏览器任务」留余量：
// 实测负载高时 5 秒会偶发超时（同一份代码连跑三次都过，但那次挂了）。
let opened = false;
for (let i = 0; i < 100; i++) {
  opened = await evalJs('window.__esOpen === true');
  if (opened) break;
  await sleep(100);
}
ok(opened, 'SSE 通道在页面里已建立（onopen）');

writeFileSync(shotsFile, orig + '\n// 热重载探针\n', 'utf8');
// 等收到 reload（最多 10 秒，同上）
let reloadSeen = false;
for (let i = 0; i < 100; i++) {
  reloadSeen = await evalJs('window.__reloadSeen === true');
  if (reloadSeen) break;
  await sleep(100);
}
writeFileSync(shotsFile, orig, 'utf8'); // 立刻还原

ok(reloadSeen, '改镜头文件后预览页收到 reload（热重载生效）');
ok(readFileSync(shotsFile, 'utf8') === orig, '探针文件已还原（没留下痕迹）');

await session.close();
server.closeProject();
await sleep(400);

console.log(bad === 0 ? '\n预览页验证全部通过。' : `\n${bad} 项失败。`);
process.exit(bad ? 1 : 0);
