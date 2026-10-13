// 各命令的实现。每个都只做一件事，由 cli/index.mjs 按名字找到并调用。
//
// 约定：命令收到 (ctx) —— {projectDir, proj, args, opts}，返回退出码（0 成功）。
import {existsSync, mkdirSync, rmSync, writeFileSync, statSync} from 'node:fs';
import {spawn, spawnSync} from 'node:child_process';
import {dirname, join, resolve} from 'node:path';
import {requireTimeline} from '../project/load.mjs';
import {renderRange, renderStills, renderSequence} from '../media/renderRange.mjs';
import {muxVideo} from '../media/mux.mjs';
import {runChecks} from '../checks/index.mjs';
import {THRESHOLDS as QUALITY_THRESHOLDS} from '../checks/runtime/quality.mjs';
import {preview as previewCmd} from './preview.mjs';
import {KIT_ROOT, RUNTIME_ROOT} from '../root.mjs';
import {num, str} from './args.mjs';

const API_FILE = join(RUNTIME_ROOT, 'index.js');

/** 自检。 */
export async function check(ctx) {
  // --static-only：只跑读文件的那几道（api / imports / timeline），不启浏览器。
  // 用途：CI 上不想装浏览器时、以及改完镜头想秒级验证引用关系时。
  const staticOnly = ctx.args['static-only'] === true;
  const res = await runChecks(ctx.projectDir, ctx.proj, ctx.opts, {
    apiFile: API_FILE,
    runtimeDir: RUNTIME_ROOT,
    staticOnly,
    // 画质自检要整片采样，比其余几道贵；默认开，用 --no-quality 关掉
    quality: !staticOnly && ctx.args.quality !== false && ctx.args['no-quality'] !== true,
    qualityThresholds: qualityThresholds(ctx.args),
  });
  return res.failed ? 1 : 0;
}

/** 从命令行覆盖画质阈值（--static-frames / --hold-frames / --ink-min / --quality-step）。 */
function qualityThresholds(args) {
  const t = {};
  const map = {
    'static-frames': 'staticFrames',
    'hold-frames': 'holdFrames',
    'ink-min': 'inkMin',
    'quality-step': 'sampleStep',
  };
  for (const [flag, key] of Object.entries(map)) {
    if (args[flag] === undefined) continue;
    const v = Number(args[flag]);
    if (!Number.isFinite(v)) throw new Error(`filmwright: --${flag} 要是数字，收到 ${args[flag]}`);
    t[key] = v;
  }
  return Object.keys(t).length ? {...QUALITY_THRESHOLDS, ...t} : undefined;
}

/** 预览：本地起服务 + 打开预览页（拖动时间轴、播放、改文件热重载）。 */
export async function preview(ctx) {
  return previewCmd(ctx);
}

/** 解说词 → 配音 + 时间轴（交给 python，它管 TTS）。 */
export function tts(ctx) {  const py = join(KIT_ROOT, 'src', 'host', 'tts', 'build.py');
  const r = spawnSync('python', [py, '--project', ctx.projectDir], {stdio: 'inherit'});
  if (r.error) throw new Error('filmwright: 起不了 python —— ' + r.error.message);
  return r.status ?? 1;
}

/** 出静帧。 */
export async function stills(ctx) {
  const frames = str(ctx.args, 'frames').split(',').map((s) => parseInt(s.trim(), 10));
  if (frames.some((n) => !Number.isFinite(n) || n < 1)) {
    throw new Error('filmwright: --frames 里有非法帧号');
  }
  requireTimeline(ctx.proj);
  const outs = await renderStills(ctx.projectDir, ctx.proj, frames, resolve(str(ctx.args, 'dir')), ctx.opts);
  outs.forEach((o) => console.log('  ' + o));
  return 0;
}

/** 抽帧联络表。 */
export async function sheet(ctx) {
  requireTimeline(ctx.proj);
  const total = ctx.proj.timeline.total_frames;
  const from = num(ctx.args, 'from', 1);
  const to = num(ctx.args, 'to', total);
  const step = num(ctx.args, 'step', 150);
  const cols = num(ctx.args, 'cols', 4);
  const out = resolve(str(ctx.args, 'out', join(ctx.proj.paths.qcDir, 'sheet.png')));
  const tmp = join(ctx.proj.paths.qcDir, '_sheet_tmp');

  const frames = [];
  for (let n = from; n <= to; n += step) frames.push(n);
  rmSync(tmp, {recursive: true, force: true});

  // 必须用连续编号的序列：ffmpeg 的图片序列中间断开就只读第一张
  const made = await renderSequence(ctx.projectDir, ctx.proj, frames, tmp, ctx.opts);
  if (made.length !== frames.length) {
    throw new Error(`filmwright: 只抽到 ${made.length}/${frames.length} 帧`);
  }
  mkdirSync(dirname(out), {recursive: true});
  const rows = Math.ceil(frames.length / cols);
  const scale = Math.max(120, Math.round(1760 / cols));
  const code = await new Promise((res) => {
    const ff = spawn('ffmpeg', ['-y', '-i', join(tmp, 's%04d.png'), '-vf',
      `scale=${scale}:-1,tile=${cols}x${rows}`, '-frames:v', '1', '-update', '1', out],
      {stdio: ['ignore', 'ignore', 'inherit']});
    ff.on('close', res);
  });
  if (code !== 0) throw new Error('filmwright: 拼联络表失败');
  if (!existsSync(out) || statSync(out).size === 0) {
    throw new Error('filmwright: 联络表没写出来');
  }
  console.log(`${out}  (${frames.length} 帧)`);
  return 0;
}

/** 渲染。 */
export async function render(ctx) {
  requireTimeline(ctx.proj);
  const total = ctx.proj.timeline.total_frames;
  const from = num(ctx.args, 'from', 1);
  const to = num(ctx.args, 'to', total);
  const shards = num(ctx.args, 'shards', 1);
  // 中间产物落在 .work/ 下
  const out = resolve(str(ctx.args, 'out',
    join(ctx.proj.paths.workDir, `${ctx.proj.raw.slug ?? 'film'}.mp4`)));
  const crf = str(ctx.args, 'crf', '16');

  if (shards <= 1) {
    const t0 = Date.now();
    const {written} = await renderRange(ctx.projectDir, ctx.proj, {
      from, to, out, crf, opts: ctx.opts,
      onProgress: (w, t) => { if (w % 100 === 0 || w === t) console.log(`  ${w}/${t}`); },
    });
    console.log(`${out}  ${written} 帧  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  } else {
    await renderSharded(ctx, {from, to, shards, out, crf});
  }
  return 0;
}

/** 画面与配音合流。 */
export async function mux(ctx) {
  requireTimeline(ctx.proj);
  const slug = ctx.proj.raw.slug ?? 'film';
  const audio = ctx.proj.paths.audio(slug);
  if (!existsSync(audio)) throw new Error('filmwright: 找不到配音 ' + audio + '（先跑 filmwright tts）');
  const video = resolve(str(ctx.args, 'video'));
  const out = resolve(str(ctx.args, 'out', join(ctx.projectDir, 'renders', `${slug}.mp4`)));
  await muxVideo(video, audio, out, ctx.proj.timeline.total_frames / (ctx.proj.raw.fps ?? 30));
  return 0;
}

/** 一条龙：自检 → 渲染 → 合流。 */
export async function all(ctx) {
  const failed = await check(ctx);
  if (failed) throw new Error('filmwright: 自检没过，先修再渲');
  await render(ctx);
  const slug = ctx.proj.raw.slug ?? 'film';
  const audio = ctx.proj.paths.audio(slug);
  const video = resolve(str(ctx.args, 'out', join(ctx.proj.paths.workDir, `${slug}.mp4`)));
  if (!existsSync(audio)) {
    console.log('（没有配音，跳过合流：' + audio + '）');
    console.log('  无声成片在 ' + video);
    return 0;
  }
  const finalOut = resolve(str(ctx.args, 'final', join(ctx.proj.paths.rendersDir, `${slug}.mp4`)));
  await muxVideo(video, audio, finalOut, ctx.proj.timeline.total_frames / (ctx.proj.raw.fps ?? 30));
  return 0;
}

/** 分片并行：每片一个独立浏览器实例，各渲一段，最后 concat 无损拼接。 */
async function renderSharded(ctx, {from, to, shards, out, crf}) {
  const tmp = join(ctx.proj.paths.workDir, 'parts');
  rmSync(tmp, {recursive: true, force: true});
  mkdirSync(tmp, {recursive: true});

  const total = to - from + 1;
  const per = Math.ceil(total / shards);
  const bounds = [];
  for (let i = 0; i < shards; i++) {
    const a = from + i * per;
    const b = Math.min(to, from + (i + 1) * per - 1);
    if (a <= b) bounds.push([a, b]);
  }
  console.log(`${total} 帧 -> ${bounds.length} 片，每片约 ${per} 帧`);

  const t0 = Date.now();
  const results = await Promise.all(bounds.map(async ([a, b], i) => {
    const part = join(tmp, `part_${String(i).padStart(2, '0')}.mp4`);
    try {
      await renderRange(ctx.projectDir, ctx.proj, {from: a, to: b, out: part, crf, opts: ctx.opts});
      return {i, a, b, part, ok: true};
    } catch (e) {
      return {i, a, b, part, ok: false, err: e.message};
    }
  }));

  let failed = 0;
  for (const r of results) {
    console.log(`  片 ${r.i} 帧 ${r.a}-${r.b}: ${r.ok ? 'ok' : '失败'}`);
    if (!r.ok) { failed++; console.error('    ' + r.err); }
  }
  if (failed) throw new Error(`filmwright: ${failed} 个分片失败`);

  const listFile = join(tmp, 'list.txt');
  writeFileSync(listFile, results.map((r) => `file '${r.part.replace(/\\/g, '/')}'`).join('\n'), 'utf8');
  mkdirSync(dirname(out), {recursive: true});
  const code = await new Promise((res) => {
    const ff = spawn('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', out],
      {stdio: ['ignore', 'ignore', 'inherit']});
    ff.on('close', res);
  });
  if (code !== 0) throw new Error('filmwright: 拼接失败');
  console.log(`${out}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
