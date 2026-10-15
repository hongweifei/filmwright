// 出图命令：静帧与联络表。
import {existsSync, mkdirSync, rmSync, writeFileSync, statSync, readFileSync} from 'node:fs';
import {dirname, join, resolve, basename} from 'node:path';
import {requireTimeline} from '../../project/load.mjs';
import {renderRange, renderStills, renderSequence} from '../../media/renderRange.mjs';
import {spawnTool, ffmpegPath, checkSpawned} from '../../media/ffmpegBin.mjs';
import {num, str} from '../args.mjs';
import {assertTool} from '../../preflight.mjs';
import {makeSay, isJson} from '../output.mjs';


/** 出静帧。 */
export async function stills(ctx) {
  const say = makeSay(ctx.args);
  const frames = str(ctx.args, 'frames').split(',').map((s) => parseInt(s.trim(), 10));
  if (frames.some((n) => !Number.isFinite(n) || n < 1)) {
    const e = new Error('filmwright: --frames 里有非法帧号');
    e.code = 'BAD_FRAMES';
    throw e;
  }
  requireTimeline(ctx.proj);
  const outs = await renderStills(ctx.projectDir, ctx.proj, frames, resolve(str(ctx.args, 'dir')), ctx.opts);
  outs.forEach((o) => say('  ' + o));
  return {code: 0, data: {files: outs}};
}

/** 抽帧联络表。 */
export async function sheet(ctx) {
  const say = makeSay(ctx.args);
  assertTool(ffmpegPath(), '联络表的抽帧拼接要 ffmpeg');
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
  const ff = spawnTool(ffmpegPath(), ['-y', '-i', join(tmp, 's%04d.png'), '-vf',
    `scale=${scale}:-1,tile=${cols}x${rows}`, '-frames:v', '1', '-update', '1', out],
    {stdio: ['ignore', 'ignore', 'inherit']});
  const code = await new Promise((res) => ff.on('close', res));
  checkSpawned(ff, '联络表拼接');
  if (code !== 0) throw new Error('filmwright: 拼联络表失败');
  if (!existsSync(out) || statSync(out).size === 0) {
    throw new Error('filmwright: 联络表没写出来');
  }
  say(`${out}  (${frames.length} 帧)`);
  return {code: 0, data: {out, frames: frames.length}};
}
