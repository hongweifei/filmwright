// 配乐混音：人声 + 音乐，带**自动闪避**（说话时把音乐压低）。
//
// 为什么用 sidechaincompress 而不是逐段调音量：
//   - 自动闪避是「人声一响就压音乐」，不需要人工标时间点
//   - 时间轴改了（句子移位）也不用重调 —— 与「解说词唯一生成时间轴」一致
//
// 滤镜链（ffmpeg）：
//   人声 ──┬──────────────────────────────→ amix ──→ 输出
//          └─(split)─→ sidechaincompress ←── 音乐(音量/gain + 淡入淡出)
//
// 三个坑：
//   1. sidechaincompress 的**第一路是被压的**（音乐）、第二路是触发（人声），
//      写反了会变成「音乐压人声」；
//   2. amix 默认会把每路音量除以路数（normalize=1），人声会莫名变小 ——
//      要 normalize=0 才保持原始电平；
//   3. 淡入淡出要用音乐的实际时长算，不能用「人声时长」（两者常不等长）。
import {existsSync, mkdirSync, statSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {spawnTool, ffmpegPath, ffprobePath, checkSpawned} from './ffmpegBin.mjs';

/** 读媒体时长（秒）；读不到返回 null。 */
export function probeDuration(file) {
  const r = spawnTool(ffprobePath(), [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file,
  ], {stdio: ['ignore', 'pipe', 'ignore']});
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
 * 构造混音滤镜链（纯函数，便于单测）。
 * @param {object} o
 * @param {number} o.voiceDur 人声时长（秒）
 * @param {number|null} o.musicDur 音乐时长（秒）
 * @param {number} o.gain 音乐增益 dB
 * @param {number} o.duck 闪避强度 dB（0 = 关掉 sidechain）
 * @param {number} o.fadeIn @param {number} o.fadeOut
 * @returns {string} -filter_complex 的值
 */
export function buildMixFilter({voiceDur, musicDur, gain = -14, duck = 10, fadeIn = 1, fadeOut = 2}) {
  if (!(voiceDur > 0)) throw new Error('filmwright: 人声时长必须是正数，收到 ' + voiceDur);
  const dur = musicDur && musicDur > 0 ? musicDur : voiceDur;
  // 淡出不能超过音乐长度的一半（否则整段都在淡出）
  const out = Math.max(0, Math.min(fadeOut, dur / 2));
  const chain = [];
  chain.push(`[1:a]volume=${gain}dB${fadeIn > 0 ? `,afade=t=in:st=0:d=${fadeIn}` : ''}` +
    `${out > 0 ? `,afade=t=out:st=${Math.max(0, dur - out).toFixed(3)}:d=${out.toFixed(3)}` : ''}[bg]`);
  if (duck > 0) {
    // 音乐（bg）被压，人声（0:a）当 sidechain 触发。
    //
    // 参数语义（**照 ffmpeg 文档核对过**，别凭直觉写）：
    //   ratio   1–20，压缩比 —— 越大压得越狠
    //   makeup  1–64，补偿增益 —— **不能小于 1**（写成 0.25 是非法值）
    //   mix     0–1，压缩后与原信号的混合比 —— 这才是「闪避强度」的线性旋钮
    //   threshold 0.0009–1，触发阈值 —— 越小越容易被触发
    //
    // 曾经的错法：在 sidechain 之后再加一层无条件 `volume=-Nd`，结果音乐在
    // 人声停下后仍被永久压低（实测纯音乐段比 duck=0 低 4dB，即闪避不释放）。
    // 闪避**必须**只由压缩器本身完成。
    const ratio = Math.min(20, 2 + duck * 1.2);            // duck 10 → 14
    const mix = Math.min(1, 0.35 + duck / 25);             // duck 10 → 0.75
    chain.push(`[0:a]asplit=2[voice][sc]`);
    chain.push(`[bg][sc]sidechaincompress=threshold=0.02:ratio=${ratio.toFixed(2)}:attack=15:release=350:makeup=1:mix=${mix.toFixed(3)}[bg2]`);
    chain.push(`[voice][bg2]amix=inputs=2:duration=first:normalize=0[out]`);
  } else {
    chain.push(`[0:a][bg]amix=inputs=2:duration=first:normalize=0[out]`);
  }
  return chain.join(';');
}

/**
 * 人声 + 配乐 → 输出（带自动闪避）。
 * @param {string} video 已渲好的无声视频
 * @param {string} voice 人声
 * @param {string} music 音乐文件
 * @param {string} out 输出
 * @param {object} musicCfg config 的 music 段（{src, gain, duck, fadeIn, fadeOut}）
 * @param {number} durationSec 成片时长
 */
export async function muxWithMusic(video, voice, music, out, musicCfg, durationSec) {
  for (const f of [video, voice, music]) {
    if (!existsSync(f)) {
      const e = new Error('filmwright: 找不到输入 ' + f);
      e.code = 'NO_INPUT';
      throw e;
    }
  }
  const voiceDur = durationSec > 0 ? durationSec : (await probeDuration(voice)) ?? 0;
  const musicDur = await probeDuration(music);
  const filter = buildMixFilter({
    voiceDur, musicDur,
    gain: musicCfg.gain, duck: musicCfg.duck,
    fadeIn: musicCfg.fadeIn, fadeOut: musicCfg.fadeOut,
  });

  mkdirSync(dirname(out), {recursive: true});
  const args = [
    '-y', '-i', voice, '-i', music, '-i', video,
    '-filter_complex', filter,
    '-map', '2:v', '-map', '[out]',
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-movflags', '+faststart',
    // 音乐比片子长是常态（循环/裁剪由 -t 兜住）；短了就自然结束
    '-t', voiceDur.toFixed(3),
    out,
  ];
  const ff = spawnTool(ffmpegPath(), args, {stdio: ['ignore', 'ignore', 'inherit']});
  const code = await new Promise((res) => ff.on('close', res));
  checkSpawned(ff, '配乐混音');
  if (code !== 0) {
    const e = new Error('filmwright: 配乐混音失败（ffmpeg 退出码 ' + code + '）');
    e.hint = '检查 music.src 是不是有效音频；详见上面 ffmpeg 的输出';
    throw e;
  }
  return {
    out,
    sizeMB: +(statSync(out).size / 1048576).toFixed(1),
    durationSec: voiceDur,
    filter,
  };
}
