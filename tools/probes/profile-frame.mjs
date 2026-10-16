// 渲染性能剖析：把每帧的时间拆成四段，找真正的瓶颈。
//
//   node tools/probes/profile-frame.mjs [<仓库根>] [帧数]
//
// 四段：
//   1) 绘制      —— 页面里 drawFrame 的耗时（能直接量）
//   2) 取像素+编码 —— canvas.toDataURL 的耗时（页面里量，PNG 与 JPEG 各测一次）
//   3) 传输      —— CDP 把 base64 传回 node 并 JSON 解析（用总时间减掉页面内的部分）
//   4) 落地      —— node 解码 base64 并写进 ffmpeg stdin（可单独量）
//
// 为什么要拆：不拆就只能猜。之前「分片更慢」的猜测方向是内存，但真正的大头
// 很可能是**每帧近 1MB 的 PNG base64 在单线程上来回搬**（实测 1280×720 的
// PNG 约 940KB → base64 约 1.25MB/帧）。拆开量才知道该先动哪一段。
import {mkdirSync, rmSync} from 'node:fs';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {dirname, join, resolve} from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const ROOT = (argv[0] && !argv[0].startsWith('--') ? argv[0] : resolve(HERE, '..', '..')).replace(/\\/g, '/');
const N = Number(argv[1] ?? 40);

const imp = (rel) => import(pathToFileURL(`${ROOT}/${rel}`).href);
const {serveProject} = await imp('src/host/project/server.mjs');
const {openSession} = await imp('src/host/browser/session.mjs');
const {loadProject} = await imp('src/host/project/load.mjs');

const P = `${ROOT}/examples/minimal`;
const proj = await loadProject(P);
const server = await serveProject(P, {raw: proj.raw, timeline: proj.timeline, shotsRel: 'shots/index.js', watch: false});
const base = `http://127.0.0.1:${server.address().port}/`;
const sess = await openSession(base, {width: 1280, height: 720});

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const fmt = (v) => v.toFixed(2).padStart(8);

/** 在页面里量「绘制」与「取像素+编码」，PNG / JPEG 各一次。 */
async function measureInPage(frames, mime, quality) {
  const expr = `(async () => {
    const canvas = document.querySelector('canvas');
    const out = [];
    for (const n of ${JSON.stringify(frames)}) {
      const t0 = performance.now();
      window.__renderFrame(n);
      const t1 = performance.now();
      const url = ${quality === undefined
        ? `canvas.toDataURL(${JSON.stringify(mime)})`
        : `canvas.toDataURL(${JSON.stringify(mime)}, ${quality})`};
      const t2 = performance.now();
      out.push({n, draw: t1 - t0, encode: t2 - t1, bytes: url.length});
    }
    return JSON.stringify(out);
  })()`;
  const r = await sess.evaluate(expr);
  return JSON.parse(r);
}

const frames = Array.from({length: N}, (_, i) => 100 + i * 13);

console.log(`剖析 ${N} 帧（${P}）\n`);

// ---------- 逐格式量「页面内」耗时 + 载荷大小 ----------
const formats = [
  {label: 'PNG（当前渲染路径）', mime: 'image/png', q: undefined},
  {label: 'JPEG q=0.92', mime: 'image/jpeg', q: 0.92},
  {label: 'JPEG q=0.8', mime: 'image/jpeg', q: 0.8},
  {label: 'WebP q=0.9', mime: 'image/webp', q: 0.9},
];

const results = {};
for (const f of formats) {
  let data;
  try {
    data = await measureInPage(frames, f.mime, f.q);
  } catch (e) {
    console.log(`${f.label}: 不支持（${String(e.message).slice(0, 60)}）`);
    continue;
  }
  const draw = median(data.map((d) => d.draw));
  const enc = median(data.map((d) => d.encode));
  const bytes = median(data.map((d) => d.bytes));
  results[f.label] = {draw, enc, bytes};
  console.log(`=== ${f.label} ===`);
  console.log(`  绘制      ${fmt(draw)} ms/帧`);
  console.log(`  编码      ${fmt(enc)} ms/帧`);
  console.log(`  载荷      ${fmt(bytes / 1024)} KB/帧（base64 后的字符串长度）`);
  console.log(`  页面内小计 ${fmt(draw + enc)} ms/帧`);
}

// ---------- 传输 + 落地：整条 CDP 往返 vs 只取像素 ----------
console.log('\n=== CDP 往返（含传输与 JSON 解析）vs 页面内耗时 ===');
for (const f of formats.filter((x) => results[x.label])) {
  const t0 = Date.now();
  await sess.evaluate(`(() => {
    const c = document.querySelector('canvas');
    let s = 0;
    for (const n of ${JSON.stringify(frames)}) { window.__renderFrame(n); s += c.toDataURL(${JSON.stringify(f.mime)}${f.q === undefined ? '' : ', ' + f.q}).length; }
    return s;
  })()`);
  const total = (Date.now() - t0) / frames.length;
  const inPage = results[f.label].draw + results[f.label].enc;
  console.log(`  ${f.label.padEnd(22)} 总 ${fmt(total)} ms/帧，页面内 ${fmt(inPage)}，` +
    `传输+解析 ${fmt(total - inPage)} ms/帧`);
}

// ---------- 落地：base64 解码 + 写 ffmpeg stdin ----------
console.log('\n=== 落地（node 侧解码 base64 并写 ffmpeg）===');
{
  const {spawnTool, ffmpegPath} = await imp('src/host/media/ffmpegBin.mjs');
  const out = join(ROOT, '.work', 'profile-out.mp4');
  mkdirSync(join(ROOT, '.work'), {recursive: true});
  const ff = spawnTool(ffmpegPath(), ['-y', '-v', 'error', '-f', 'image2pipe', '-framerate', '30',
    '-i', '-', '-c:v', 'libx264', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-crf', '16', out],
    {stdio: ['pipe', 'ignore', 'inherit']});
  // 载荷必须是**真的 PNG**。这里原来写的是 `Buffer.alloc(..., 200)` 随机字节，
  // ffmpeg 从 `-f image2pipe` 里认不出任何流，报「Output file does not contain any stream」
  // 直接退出；node 这边继续往已关闭的管道写，又抛一个未处理的 EPIPE —— 探针崩在最后一节。
  // （本轮把 16 个探针真跑一遍才暴露：它前面那一节早就因为夹具过期崩了，这一节根本没跑到。）
  const b64 = await sess.evaluate("document.querySelector('canvas').toDataURL('image/png').split(',')[1]");
  const big = Buffer.from(b64, 'base64');
  // ffmpeg 若提前退出，写管道会 EPIPE；那不该把探针崩掉（下面 close 里能看到退出）。
  ff.stdin.on('error', () => {});
  const t0 = Date.now();
  for (let i = 0; i < frames.length; i++) {
    if (!ff.stdin.write(big)) await new Promise((r) => ff.stdin.once('drain', r));
  }
  const writeMs = (Date.now() - t0) / frames.length;
  ff.stdin.end();
  await new Promise((r) => ff.on('close', r));
  console.log(`  写入 ${fmt(writeMs)} ms/帧（${(big.length / 1024).toFixed(0)} KB/帧 真 PNG，同一帧重复喂）`);
  console.log('  （ffmpeg 的 h264 编码是并行流水，这里量的是 node 把数据喂进去的成本）');
}

await sess.close();
server.close();

// ---------- 结论 ----------
console.log('\n=== 结论 ===');
const png = results['PNG（当前渲染路径）'];
const jpg = results['JPEG q=0.92'];
if (png && jpg) {
  console.log(`  编码：PNG ${png.enc.toFixed(1)}ms → JPEG ${jpg.enc.toFixed(1)}ms（快 ${(png.enc / jpg.enc).toFixed(1)}×）`);
  console.log(`  载荷：${(png.bytes / 1024).toFixed(0)}KB → ${(jpg.bytes / 1024).toFixed(0)}KB（小 ${(png.bytes / jpg.bytes).toFixed(1)}×）`);
  console.log('  → 若「传输+解析」与载荷成正比，换成 JPEG 能同时省下编码与传输两段。');
}
rmSync(join(ROOT, '.work', 'profile-out.mp4'), {force: true});
