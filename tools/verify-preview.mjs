// 预览页的端到端验证：真开浏览器，验证拖动、播放、热重载都真的生效。
//
// 为什么必须真开浏览器：预览页的价值就是「人能看到」。
// 只测 CLI 起没起来，等于没测。
//
//   node tools/verify-preview.mjs
//
// 浏览器会话走 src/host/browser/session.mjs 的 openSession（无头、快速失败）；
// 预览页有自己的就绪信号，用 readyExpr 覆盖。
//
// 第 7 段是**它自己的负面对照**：在临时目录里造一个坏项目（镜头占满整条时间轴，
// 但一帧都不画），把本文件当子进程再跑一遍，要求它变红。真项目全程只读。
//   FILMWRIGHT_PREVIEW_PROJECT     覆盖项目目录（负面对照用）
//   FILMWRIGHT_PREVIEW_NEG_CHILD=1 子进程标记，避免对照递归
import {existsSync, mkdirSync, mkdtempSync, cpSync, rmSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {serveProject} from '../src/host/project/server.mjs';
import {loadProject} from '../src/host/project/load.mjs';
import {openSession} from '../src/host/browser/session.mjs';

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), '..');
// 默认是真项目；负面对照用环境变量把它指到临时项目上。
const PROJ = resolve(process.env.FILMWRIGHT_PREVIEW_PROJECT ?? join(ROOT, 'examples', 'minimal'));
// 子进程（负面对照里那次被测运行）不再造对照，否则无限递归。
const NEG_CHILD = process.env.FILMWRIGHT_PREVIEW_NEG_CHILD === '1';
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
// openSession 在这里等就绪：失败（含超时）会抛错并退出。
// 就绪本身仍然单独判一次（见下），不靠「已经等到了」来代替判据。
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
// 就绪这条**不能写成 ok(true, …)**：恒真断言等于没有判据。
// openSession 的 readyExpr 已经等到了就绪，这里独立读一次页面状态，
// 并顺带守「画布尺寸 = 项目配置」——尺寸对了，后面按画布坐标采样才有意义。
const shown = await evalJs(`({
  ready: window.__preview.ready,
  w: document.getElementById('c').width,
  h: document.getElementById('c').height,
})`);
const want = proj.raw.size ?? {};
ok(shown.ready === true && shown.w === want.width && shown.h === want.height,
  `预览页装载就绪，画布 ${shown.w}×${shown.h}（项目配置 ${want.width}×${want.height}，ready=${shown.ready}）`);

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

// ---------- 7. 负面对照：造一个真坏掉的项目，要求本工具失败 ----------
// 「画面有内容」这条判据不是恒真的证据：把「镜头占满时间轴但一帧都不画」喂进去，
// 必须红在那一条上，而且它**量到的亮点**要真的低于真项目（方向，不是「画面变了」）。
// 项目写在系统临时目录里，跑完删掉；真项目一个字节都不动。
async function negativeControl() {
  const tmp = mkdtempSync(join(tmpdir(), 'fw-preview-neg-'));
  let proc = null;
  try {
    // 只复制造装必需的三样：配置、时间轴、配置里声明的素材（路径从 raw.assets 读，不写死）。
    // 字体故意不复制：NotoSansSC 有 17MB，而 boot 里字体加载失败是非致命的（记成 :FAILED）。
    cpSync(join(PROJ, 'film.config.mjs'), join(tmp, 'film.config.mjs'));
    mkdirSync(join(tmp, 'script'), {recursive: true});
    cpSync(join(PROJ, 'script', 'timeline.json'), join(tmp, 'script', 'timeline.json'));
    const rels = (proj.raw.assets ?? []).map((a) => (typeof a === 'string' ? a : a && a.src)).filter(Boolean);
    for (const rel of rels) {
      const src = join(PROJ, 'public', rel);
      if (!existsSync(src)) continue;
      mkdirSync(dirname(join(tmp, 'public', rel)), {recursive: true});
      cpSync(src, join(tmp, 'public', rel));
    }
    // 缺陷：镜头占住整条时间轴，draw 却什么都不做 ⇒ 预览内容区应当是空的。
    mkdirSync(join(tmp, 'shots'), {recursive: true});
    writeFileSync(
      join(tmp, 'shots', 'index.js'),
      '// 负面对照用的坏镜头：占住时间轴，但一帧都不画。\n'
      + 'export const SHOTS = [{start: 1, draw() {}}];\n',
      'utf8',
    );

    proc = spawnSync(process.execPath, [SELF], {
      env: {...process.env, FILMWRIGHT_PREVIEW_PROJECT: tmp, FILMWRIGHT_PREVIEW_NEG_CHILD: '1'},
      encoding: 'utf8',
      timeout: 300000,
    });
  } finally {
    rmSync(tmp, {recursive: true, force: true});
  }

  const out = `${proc?.stdout ?? ''}${proc?.stderr ?? ''}`;
  const failLines = out.split('\n').filter((l) => l.startsWith('✗'));
  const finished = /预览页验证全部通过。|\d+ 项失败。/.test(out);   // 跑到收尾 = 没在启动阶段就崩
  // 区分「判据红了」和「子进程自己崩了」：只有前者算对照成立。
  const wentRed = proc !== null && proc.status !== 0 && !proc.error;
  const statusText = proc === null
    ? '子进程没起来'
    : (proc.error ? `运行出错：${proc.error.message}` : `退出码 ${proc.status}`);
  // 红的必须是「画面有内容」那条，且它**量到的数**要真比真项目低 —— 量方向，不是「红了就行」。
  const inkLine = failLines.find((l) => /画面有内容/.test(l));
  const inkChild = Number((inkLine ?? '').match(/亮点采样 (\d+)/)?.[1] ?? NaN);
  const otherFails = failLines.filter((l) => l !== inkLine);
  const controlOk = wentRed && finished && Number.isFinite(inkChild) && inkChild < ink;

  ok(wentRed, `负面对照：镜头一帧不画的坏项目让本工具失败（${statusText}）`);
  ok(finished && Number.isFinite(inkChild) && inkChild < ink,
    `负面对照：红点在「画面有内容」（子进程那行：${inkLine ?? '没有 ✗ 行'}），亮点 ${inkChild} < 真项目的 ${ink}`);
  // 子进程另外红了几条（例如负载高时热重载超时）不算对照失败 —— 对照要证的是这条判据有牙，
  // 不是「环境必须一次不错」；但要说出来，别让额外的红静默溜掉。
  if (otherFails.length) {
    console.log(`  · 提示：子进程另有 ${otherFails.length} 条判据红了（不影响本对照结论，但值得看一眼）：${otherFails.join(' / ')}`);
  }
  if (!controlOk) {
    console.log('  —— 子进程输出（负面对照没按预期红）——');
    for (const line of out.split('\n')) console.log('    ' + line);
  }
  ok(!existsSync(tmp), '负面对照的临时项目已清理（没留下残留）');
}

if (!NEG_CHILD) await negativeControl();

console.log(bad === 0 ? '\n预览页验证全部通过。' : `\n${bad} 项失败。`);
process.exit(bad ? 1 : 0);
