// 逐个 fetch 渲染页要用到的模块，看哪些 404 —— 模块加载失败时页面是静默的。
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {serveProject} from '../src/host/project/server.mjs';
import {loadProject} from '../src/host/project/load.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROJ = join(ROOT, 'examples', 'minimal');
const proj = await loadProject(PROJ);
const server = await serveProject(PROJ, {
  raw: proj.raw, timeline: proj.timeline, shotsRel: 'shots/index.js',
});
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const paths = [
  '/',
  '/__filmwright/project.js',
  '/kit/index.js',
  '/kit/contract/config.js',
  '/kit/contract/viewport.js',
  '/kit/contract/timeline.js',
  '/kit/runtime/stage/index.js',
  '/kit/runtime/stage/drawFrame.js',
  '/kit/runtime/stage/shots.js',
  '/kit/runtime/checks/analysis.js',
  '/kit/runtime/chrome/backdrop.js',
  '/kit/runtime/chrome/hud.js',
  '/kit/runtime/chrome/chapterCard.js',
  '/kit/runtime/chrome/subtitle.js',
  '/kit/runtime/chrome/progress.js',
  '/kit/runtime/chrome/ending.js',
  '/kit/runtime/draw/primitives.js',
  '/kit/runtime/draw/widgets.js',
  '/kit/runtime/draw/color.js',
  '/kit/runtime/motion/ease.js',
  '/kit/runtime/layout/design.js',
  '/proj/shots/index.js',
  '/fonts/NotoSansSC.ttf',
];

let bad = 0;
for (const p of paths) {
  const r = await fetch(base + p);
  const flag = r.status === 200 ? 'ok  ' : 'FAIL';
  if (r.status !== 200) bad++;
  console.log(`${flag} ${String(r.status).padEnd(4)} ${p}`);
}
console.log(bad === 0 ? '\n所有模块都能取到' : `\n${bad} 个取不到`);
server.close();
process.exit(bad ? 1 : 0);
