// 渲染：静帧 / 一段 mp4 / PNG 序列。一个浏览器实例负责一段连续帧。
import {mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {serveProject} from '../project/server.mjs';
import {shotsRelOrNull} from '../project/load.mjs';
import {openSession} from '../browser/session.mjs';
import {spawnTool, ffmpegPath, checkSpawned} from './ffmpegBin.mjs';
import {prepareClips} from './clips.mjs';
import {normalizeConfig} from '../../contract/config.js';

/** 起服务 + 开会话；调用方负责 close()。 */
export async function openProjectSession(projectDir, proj, opts = {}) {
  const cfgSize = proj.raw.size ?? {width: 1280, height: 720};
  // 片段素材：抽帧是 host 的 I/O，必须在开会话**之前**做完 ——
  // 页面里的绘制是同步的，帧没抽好就只能画空白。
  // 内容寻址缓存保证同一份源+参数只抽一次，所以每次都调也不亏。
  const clipList = normalizeConfig(proj.raw).clips ?? [];
  let clips = null;
  if (clipList.length) {
    const r = await prepareClips(projectDir, clipList, {
      cacheRoot: join(proj.paths.workDir, 'clips'),
    });
    clips = r.clips;
  }
  // serveProject 返回 Promise，要 await —— 否则拿到的是 Promise 不是 server
  const server = await serveProject(projectDir, {
    raw: proj.raw,
    timeline: proj.timeline,
    shotsRel: shotsRelOrNull(proj),
    scene: proj.scene ?? null,
    clips,
  });
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/`;
  const sess = await openSession(url, cfgSize, opts);
  return {sess, server, url, port};
}

export async function withSession(projectDir, proj, opts, fn) {
  const {sess, server, url} = await openProjectSession(projectDir, proj, opts);
  try {
    return await fn(sess, url);
  } finally {
    await sess.close();
    server.close();
  }
}

/** 渲染一段帧到 mp4（或 PNG 序列）。 */
export async function renderRange(projectDir, proj, {from, to, out, crf = '16', pngDir = null, pngDirFormat = 'png', frameFormat, preset = 'medium', onProgress, opts = {}}) {
  if (!(to >= from)) throw new Error(`filmwright: 帧区间非法 ${from}–${to}`);
  return withSession(projectDir, proj, opts, async (sess) => {
    if (out) mkdirSync(dirname(out), {recursive: true});
    if (pngDir) {
      rmSync(pngDir, {recursive: true, force: true});
      mkdirSync(pngDir, {recursive: true});
    }
    // 渲染成视频时中间帧走 JPEG（见 session.mjs 里 frameFormatExpr 的实测表：
    // 编码 50→29ms、载荷 1243→87KB，而终点是 h264 有损编码，看不出差别）；
    // 落成 PNG 序列（pngDir）时必须用 PNG —— 那类产物是给人看/给工具比对的，
    // 有损压缩会让像素回归失去意义。
    const fmt = pngDir ? pngDirFormat : (frameFormat ?? 'jpeg');
    let ff = null;
    if (!pngDir) {
      ff = spawnTool(ffmpegPath(), ['-y', '-f', 'image2pipe', '-framerate', String(proj.raw.fps ?? 30), '-i', '-',
        '-c:v', 'libx264', '-preset', preset, '-pix_fmt', 'yuv420p', '-crf', String(crf), out],
        {stdio: ['pipe', 'ignore', 'inherit']});
    }
    const total = to - from + 1;
    let written = 0;
    for (let n = from; n <= to; n++) {
      const buf = await sess.frame(n, {frameFormat: fmt});
      if (pngDir) writeFileSync(join(pngDir, `f${String(n).padStart(5, '0')}.png`), buf);
      else if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
      written++;
      if (onProgress) onProgress(written, total);
    }
    if (ff) {
      ff.stdin.end();
      const code = await new Promise((r) => ff.on('close', r));
      checkSpawned(ff, '渲染编码');
      if (code !== 0) throw new Error('filmwright: ffmpeg 退出码 ' + code);
    }
    const err = sess.lastError();
    if (err) throw new Error('filmwright: 渲染期间页面抛错：' + err);
    return {written, out};
  });
}

/** 出若干静帧（文件名带真实帧号，便于人读）。**用 PNG**（无损，便于逐像素比对）。 */
export async function renderStills(projectDir, proj, frames, dir, opts = {}) {
  return withSession(projectDir, proj, opts, async (sess) => {
    mkdirSync(dir, {recursive: true});
    const outs = [];
    for (const n of frames) {
      const png = await sess.frame(n, {frameFormat: 'png'});
      const out = join(dir, `f${String(n).padStart(5, '0')}.png`);
      writeFileSync(out, png);
      outs.push(out);
    }
    return outs;
  });
}

/**
 * 出连续编号的静帧（f00001.png 起，步长 1）。
 * 联络表要用 ffmpeg 的图片序列，必须连续编号 —— 按真实帧号命名会让序列中间断开，
 * ffmpeg 只读到第一张就停，拼出来的表只有一格（静默假成功，这个坑踩过）。
 */
export async function renderSequence(projectDir, proj, frames, dir, opts = {}) {
  return withSession(projectDir, proj, opts, async (sess) => {
    mkdirSync(dir, {recursive: true});
    const outs = [];
    for (let i = 0; i < frames.length; i++) {
      // 联络表用 PNG：它是给人看/存档的，不该有损
      const png = await sess.frame(frames[i], {frameFormat: 'png'});
      const out = join(dir, `s${String(i + 1).padStart(4, '0')}.png`);
      writeFileSync(out, png);
      outs.push(out);
    }
    if (outs.length === 0) throw new Error('filmwright: 联络表没抽到任何帧');
    return outs;
  });
}
