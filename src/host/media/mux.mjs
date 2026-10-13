// 画面与配音合流。视频与音频由同一份时间轴生成，长度本就一致，
// 用 -t 明确钉住画面时长，避免 -shortest 让较短的音轨截断整片。
import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, statSync} from 'node:fs';
import {dirname} from 'node:path';

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

  const code = await new Promise((res) => {
    const ff = spawn('ffmpeg', args, {stdio: ['ignore', 'ignore', 'inherit']});
    ff.on('close', res);
  });
  if (code !== 0) throw new Error('filmwright: 合流失败（ffmpeg 退出码 ' + code + '）');
  const mb = (statSync(out).size / 1048576).toFixed(1);
  console.log(`${out}  ${mb} MB  ${durationSec.toFixed(2)}s`);
  return out;
}
