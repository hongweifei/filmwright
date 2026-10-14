// 片段素材的**抽帧**（host 侧 I/O）与**内容寻址缓存**。
//
// 分工（这是素材管线能既支持视频、又不破坏「第 N 帧是 N 的纯函数」的关键）：
//   - 这里（host）：异步、慢、有磁盘代价 —— 用 ffmpeg 把视频抽成图片序列；
//   - runtime/clips.js：同步、纯函数 —— 按「源帧号」取一张已就绪的图。
//
// 抽帧参数与源文件一起决定缓存键（内容寻址）：同样的源 + 同样的参数只抽一次。
// 改了 fps/width/start/maxSec 就是不同的键 —— 不会拿旧帧冒充新配置。
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnTool, ffmpegPath, ffprobePath, checkSpawned} from './ffmpegBin.mjs';

/** 缓存目录名：<name>-<8位哈希>，哈希覆盖源文件指纹 + 抽帧参数。 */
export function clipKey(clip, srcStat) {
  const h = createHash('sha1');
  h.update(clip.src);
  h.update(`|${srcStat.size}|${Math.round(srcStat.mtimeMs)}`);
  h.update(`|fps=${clip.fps}|w=${clip.width}|start=${clip.start}|maxSec=${clip.maxSec}`);
  return `${clip.name}-${h.digest('hex').slice(0, 8)}`;
}

/** 缓存就绪判定：目录在、有帧、且带完成标记（避免把抽到一半的当成完整的）。 */
export function isPrepared(dir) {
  if (!existsSync(dir)) return false;
  if (!existsSync(join(dir, '.done'))) return false;
  try {
    return readdirSync(dir).some((f) => /^f\d+\.png$/.test(f));
  } catch {
    return false;
  }
}

/** 数一数已抽了多少帧（给 runtime 用来夹住源帧号上界）。 */
export function countFrames(dir) {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => /^f\d+\.png$/.test(f)).length;
}

/** 读视频信息（时长），失败返回 null（大小无所谓，只用来决定要不要 warn）。 */
function probeDuration(file) {
  const r = spawnTool(ffprobePath(), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
    {stdio: ['ignore', 'pipe', 'ignore']});
  return new Promise((res) => {
    let out = '';
    if (r.stdout) r.stdout.on('data', (d) => (out += d));
    r.on('close', () => {
      const v = Number(String(out).trim());
      res(Number.isFinite(v) && v > 0 ? v : null);
    });
  });
}

/**
 * 准备一个片段的帧序列。已缓存就直接返回（**内容寻址**：源或参数变了键就变）。
 *
 * @param {string} projectDir
 * @param {object} clip 归一化后的 clip 声明（见 contract/config.js 的 normClips）
 * @param {string} cacheRoot 缓存根目录（通常是 <project>/.work/clips）
 * @returns {Promise<{dir:string, frames:number, cached:boolean, seconds:number}>}
 */
export async function prepareClip(projectDir, clip, cacheRoot) {
  const publicRoot = join(projectDir, 'public');
  const local = clip.src.replace(/^\//, '');

  // seq：src 已经是图片序列（用户自己抽好的），只数一数、不做 I/O
  if (clip.seq) {
    const dir = join(publicRoot, local.replace(/\/[^/]*%0?\d*d[^/]*$/, ''));
    const n = countFrames(dir);
    if (n === 0) {
      throw new Error(`filmwright: 片段「${clip.name}」声明为 seq，但在 ${dir} 下没找到 fNNNN.png 序列`);
    }
    return {dir, frames: n, cached: true, seconds: n / clip.fps};
  }

  const srcFile = join(publicRoot, local);
  if (!existsSync(srcFile)) {
    const e = new Error('filmwright: 找不到片段源文件 ' + srcFile);
    e.code = 'NO_CLIP_FILE';
    e.hint = `clips 里的 ${clip.src} 对应项目里的 public/${local}`;
    throw e;
  }
  const st = statSync(srcFile);
  const key = clipKey(clip, st);
  const dir = join(cacheRoot, key);

  if (isPrepared(dir)) {
    const n = countFrames(dir);
    return {dir, frames: n, cached: true, seconds: n / clip.fps};
  }

  // 抽帧。先写临时目录、完成后原子改名 —— 抽到一半被中断时不会留下
  // 「看起来完整」的缓存（下次还会重抽，而不是拿到残缺序列）。
  const tmp = dir + '.tmp';
  rmSync(tmp, {recursive: true, force: true});
  mkdirSync(tmp, {recursive: true});

  const dur = await probeDuration(srcFile);
  const args = ['-y'];
  if (clip.start > 0) args.push('-ss', String(clip.start));
  args.push('-i', srcFile);
  if (clip.maxSec > 0) args.push('-t', String(clip.maxSec));
  args.push('-vf', clip.width > 0 ? `fps=${clip.fps},scale=${clip.width}:-2` : `fps=${clip.fps}`);
  args.push('-q:v', '2', join(tmp, 'f%05d.png'));

  const ff = spawnTool(ffmpegPath(), args, {stdio: ['ignore', 'ignore', 'pipe']});
  let err = '';
  if (ff.stderr) ff.stderr.on('data', (d) => (err += d));
  const code = await new Promise((res) => ff.on('close', res));
  checkSpawned(ff, '片段抽帧');

  const frames = countFrames(tmp);
  if (code !== 0 || frames === 0) {
    // 抽失败：说清是哪个文件、什么参数；别把半个目录留在缓存里
    const hint = dur !== null && clip.start >= dur
      ? `（源只有 ${dur.toFixed(2)}s，而 start=${clip.start}s —— 起点已经超过时长）`
      : '';
    rmSync(tmp, {recursive: true, force: true});
    const e = new Error(`filmwright: 片段「${clip.name}」抽帧失败${hint}` +
      (code !== 0 ? `（ffmpeg 退出码 ${code}）` : '（一帧都没抽到）') +
      '\n  ' + String(err).trim().split('\n').slice(-2).join('\n  '));
    e.code = 'CLIP_EXTRACT_FAILED';
    throw e;
  }

  // 完成标记 + 原子改名
  writeFileSync(join(tmp, '.done'), JSON.stringify({...clip, frames, at: new Date().toISOString()}), 'utf8');
  rmSync(dir, {recursive: true, force: true});
  renameSync(tmp, dir);
  return {dir, frames, cached: false, seconds: frames / clip.fps};
}

/**
 * 准备全部片段；把结果整理成运行时需要的映射。
 * @returns {Promise<{clips: object, extracted: number, cached: number, totalFrames: number}>}
 */
export async function prepareClips(projectDir, clips, opts = {}) {
  const cacheRoot = opts.cacheRoot ?? join(projectDir, '.work', 'clips');
  mkdirSync(cacheRoot, {recursive: true});
  const out = {};
  let extracted = 0, cached = 0, totalFrames = 0;
  for (const clip of clips) {
    const r = await prepareClip(projectDir, clip, cacheRoot);
    out[clip.name] = {
      dir: r.dir.replace(/\\/g, '/'),
      frames: r.frames,
      fps: clip.fps,
      src: clip.src,
      cached: r.cached,
    };
    totalFrames += r.frames;
    if (r.cached) cached++; else extracted++;
  }
  return {clips: out, extracted, cached, totalFrames, cacheRoot};
}

/** 清理不再需要的缓存（保留当前在用的键；其余删掉）。 */
export function pruneCache(cacheRoot, keepKeys) {
  if (!existsSync(cacheRoot)) return 0;
  let removed = 0;
  for (const e of readdirSync(cacheRoot)) {
    if (keepKeys.has(e) || e.endsWith('.tmp')) continue;
    rmSync(join(cacheRoot, e), {recursive: true, force: true});
    removed++;
  }
  return removed;
}
