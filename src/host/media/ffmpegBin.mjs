// ffmpeg / ffprobe 的唯一定位点与 spawn 出口。
//
// 为什么收拢到一个文件：ffmpeg 的 spawn 原先散在三处（renderRange / mux / sheet），
// 谁都没挂 'error' 监听 —— ffmpeg 缺失时进程以 unhandled 'error' event 崩掉，
// 只见 ENOENT 堆栈，看不出「该装什么」。spawnTool 把 spawn 失败记下来并补发一个
// 'close'，让等待方退出来；checkSpawned 把它转成可读的报错。
//
// 路径可用环境变量指定：FFMPEG_BIN / FFPROBE_BIN。
import {spawn} from 'node:child_process';

export const ffmpegPath = () => process.env.FFMPEG_BIN || 'ffmpeg';
export const ffprobePath = () => process.env.FFPROBE_BIN || 'ffprobe';

/** spawn 外部命令；spawn 失败（ENOENT 等）记在 __spawnError 并补发 'close'。 */
export function spawnTool(cmd, args, opts = {}) {
  const p = spawn(cmd, args, opts);
  p.once('error', (e) => {
    p.__spawnError = e;
    p.emit('close', -1, null);
  });
  return p;
}

/** 起进程失败就抛可读的错（说清缺什么、怎么装）；正常退出码交给调用方判。 */
export function checkSpawned(p, what) {
  const e = p.__spawnError;
  if (!e) return;
  if (e.code === 'ENOENT') {
    throw new Error(
      `filmwright: 找不到 ${p.spawnfile} —— ${what}。\n` +
      '  装上它（如 sudo apt-get install ffmpeg），或用环境变量 FFMPEG_BIN / FFPROBE_BIN 指定可执行文件路径。');
  }
  throw new Error(`filmwright: 起不了 ${p.spawnfile}：${e.message}`);
}
