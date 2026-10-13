// 画面与配音合流。视频与音频由同一份时间轴生成，长度本就一致，
// 用 -t 明确钉住画面时长，避免 -shortest 让较短的音轨截断整片。
import {existsSync, mkdirSync, statSync} from 'node:fs';
import {dirname} from 'node:path';
import {spawnTool, ffmpegPath, checkSpawned} from './ffmpegBin.mjs';

export async function muxVideo(video, audio, out, durationSec) {
  for (const f of [video, audio]) {
    if (!existsSync(f)) throw new Error('filmwright: 找不到输入 ' + f);
  }
  mkdirSync(dirname(out), {recursive: true});
  const args = [
    '-y', '-i', video, '-i', audio,
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-movflags', '+faststart',
  ];
  if (durationSec > 0) args.push('-t', durationSec.toFixed(3));
  args.push(out);

  const ff = spawnTool(ffmpegPath(), args, {stdio: ['ignore', 'ignore', 'inherit']});
  const code = await new Promise((res) => ff.on('close', res));
  checkSpawned(ff, '合流');
  if (code !== 0) throw new Error('filmwright: 合流失败（ffmpeg 退出码 ' + code + '）');
  // 返回统计，打印交给命令层（--json 时命令层要静默，工具不该自己往 stdout 写）
  return {out, sizeMB: +(statSync(out).size / 1048576).toFixed(1), durationSec};
}
