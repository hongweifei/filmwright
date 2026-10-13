// 验证「换分辨率」与「换浏览器」两个可复用性主张。
// 用法: node qc/verify-reuse.mjs
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync} from 'node:fs';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadProject} from '../src/host/project/load.mjs';
import {renderStills} from '../src/host/media/renderRange.mjs';
import {install as setConfig} from '../src/contract/config.js';
import {ffprobePath} from '../src/host/media/ffmpegBin.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROJ = join(ROOT, 'examples', 'minimal');

// --- 1. 换分辨率：把配置改成 1920×1080，看镜头在别的尺寸下会不会画糊/溢出 ---
const proj = await loadProject(PROJ);
const big = {...proj.raw, size: {width: 1920, height: 1080}};
const bigProj = {paths: proj.paths, raw: big, timeline: proj.timeline};
mkdirSync(join(ROOT, '.work', 'qc', 'reuse'), {recursive: true});
const bigOut = join(ROOT, '.work', 'qc', 'reuse', 'big');
rmSync(bigOut, {recursive: true, force: true});
const made = await renderStills(PROJ, bigProj, [30, 250, 700, 1150], bigOut);
console.log('1920×1080 静帧：');
for (const f of made) {
  const sz = execFileSync(ffprobePath(),
    ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', f], {encoding: 'utf8'}).trim();
  console.log(`  ${f.split(/[\\/]/).pop()}  ${sz}`);
}

// --- 2. 换浏览器：同一个帧，两个浏览器是否逐像素一致 ---
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
if (!existsSync(EDGE)) {
  console.log('换浏览器验证：跳过（找不到 Edge）');
} else {
  const a = join(ROOT, '.work', 'qc', 'reuse', 'edge');
  const b = join(ROOT, '.work', 'qc', 'reuse', 'chrome');
  rmSync(a, {recursive: true, force: true});
  rmSync(b, {recursive: true, force: true});
  await renderStills(PROJ, proj, [250], a, {browser: EDGE});
  await renderStills(PROJ, proj, [250], b, {});
  const fa = readdirSync(a)[0], fb = readdirSync(b)[0];
  const A = readFileSync(join(a, fa));
  const B = readFileSync(join(b, fb));
  console.log(`换浏览器：Edge 与 Chrome 的同一帧 ${A.equals(B) ? '字节完全相同' : '不同（' + A.length + ' vs ' + B.length + ' 字节）'}`);
  console.log(`  Edge:   ${join(a, fa)}`);
  console.log(`  默认:   ${join(b, fb)}`);
}
