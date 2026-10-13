// 渲染：静帧 / 一段 mp4 / PNG 序列。一个浏览器实例负责一段连续帧。
import {mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {dirname, join, relative} from 'node:path';
import {serveProject} from '../project/server.mjs';
import {openSession} from '../browser/session.mjs';
import {spawnTool, ffmpegPath, checkSpawned} from './ffmpegBin.mjs';

/** 起服务 + 开会话；调用方负责 close()。 */
export async function openProjectSession(projectDir, proj, opts = {}) {
  const cfgSize = proj.raw.size ?? {width: 1280, height: 720};
  const shotsRel = relative(projectDir, proj.paths.shots).replace(/\\/g, '/');
  // serveProject 返回 Promise，要 await —— 否则拿到的是 Promise 不是 server
  const server = await serveProject(projectDir, {
    raw: proj.raw,
    timeline: proj.timeline,
    shotsRel,
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
export async function renderRange(projectDir, proj, {from, to, out, crf = '16', pngDir = null, onProgress, opts = {}}) {
  if (!(to >= from)) throw new Error(`filmwright: 帧区间非法 ${from}–${to}`);
  return withSession(projectDir, proj, opts, async (sess) => {
    if (out) mkdirSync(dirname(out), {recursive: true});
    if (pngDir) {
      rmSync(pngDir, {recursive: true, force: true});
      mkdirSync(pngDir, {recursive: true});
    }
    let ff = null;
    if (!pngDir) {
      ff = spawnTool(ffmpegPath(), ['-y', '-f', 'image2pipe', '-framerate', String(proj.raw.fps ?? 30), '-i', '-',
        '-c:v', 'libx264', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-crf', String(crf), out],
        {stdio: ['pipe', 'ignore', 'inherit']});
    }
    const total = to - from + 1;
    let written = 0;
    for (let n = from; n <= to; n++) {
      const png = await sess.frame(n);
      if (pngDir) writeFileSync(join(pngDir, `f${String(n).padStart(5, '0')}.png`), png);
      else if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once('drain', r));
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

/** 出若干静帧（文件名带真实帧号，便于人读）。 */
export async function renderStills(projectDir, proj, frames, dir, opts = {}) {
  return withSession(projectDir, proj, opts, async (sess) => {
    mkdirSync(dir, {recursive: true});
    const outs = [];
    for (const n of frames) {
      const png = await sess.frame(n);
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
      const png = await sess.frame(frames[i]);
      const out = join(dir, `s${String(i + 1).padStart(4, '0')}.png`);
      writeFileSync(out, png);
      outs.push(out);
    }
    if (outs.length === 0) throw new Error('filmwright: 联络表没抽到任何帧');
    return outs;
  });
}
