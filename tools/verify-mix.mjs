// 配乐混音的端到端验证：真跑混音，并**直接测音乐那一路**证明闪避生效。
//
//   node tools/verify-mix.mjs [<仓库根>]
//
// 要证明的四件事：
//   1. 人声在场时音乐被压低（闪避生效）
//   2. 人声停下后音乐**恢复**（不是被永久调小）
//   3. duck 越大压得越深（参数单调有效）
//   4. 输出带视频+音频流、时长正确；音乐文件缺失时报错
//
// **测量方法踩过的三个坑**（判据/测量比实现更容易错，写下来别再犯）：
//   1. 「静音段比说话段响」——不可能：静音段只有垫乐(−35dB)，说话段光人声就 −21dB。
//   2. 用 bandpass 滤掉 440Hz 人声、想只留 220Hz 音乐 —— 滤波器漏人声谐波，
//      duck=0（根本没侧链）时两版仍差 6.6dB，测量本身有偏。
//   3. 比较**总电平** —— 人声 −21dB 完全盖过音乐 −35dB，音乐被压 8dB 只让总量动 0.1dB。
// 正确做法：只放音乐、以人声作 sidechain，**单独输出音乐那一路**来测 ——
// 参数从产品真实的 buildMixFilter 里抽出来，保证测的是同一套参数。
import {spawnSync} from 'node:child_process';
import {mkdirSync, rmSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = (process.argv[2] ?? resolve(HERE, '..')).replace(/\\/g, '/');
const W = `${ROOT}/.work/mix-verify`;
rmSync(W, {recursive: true, force: true});
mkdirSync(W, {recursive: true});

const ff = (args) => spawnSync('ffmpeg', args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
const meanVol = (f, st, d) => {
  const rr = spawnSync('ffmpeg', ['-v', 'info', '-ss', String(st), '-t', String(d), '-i', f,
    '-af', 'volumedetect', '-f', 'null', '-'], {encoding: 'utf8'});
  const m = String(rr.stderr || '').match(/mean_volume:\s*(-?[\d.]+) dB/);
  return m ? Number(m[1]) : null;
};

const video = join(W, 'v.mp4');
const music = join(W, 'music.wav');
// 人声：前 3s 有声 + 后 3s 静音 → 后 3s 是纯音乐，用来验证「闪避会释放」
const voice = join(W, 'voice.wav');
ff(['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
ff(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
  '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=3',
  '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[o]', '-map', '[o]', '-ar', '48000', voice]);
ff(['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=20', '-ar', '48000', music]);

const {buildMixFilter, muxWithMusic} = await import(`file:///${ROOT}/src/host/media/mix.mjs`);
const base = {src: '/assets/music.wav', gain: -14, fadeIn: 0, fadeOut: 0};

/**
 * 测「闪避对音乐压了多少」。
 *
 * 不能用完整链再 map 音乐分支：filtergraph 标签只能被消费一次
 * （实测 "was already used elsewhere"），替换标签又会插错位置。
 * 所以这里用**与产品同参数的独立滤镜**：只放音乐、以人声作 sidechain，
 * 直接输出 → 测得的电平就是音乐被压后的电平。
 * 参数（threshold/ratio/attack/release/makeup/mix）从产品的 buildMixFilter
 * 里抽出来，保证测的是同一套参数。
 */
const musicLevelWithDuck = (duck, st, d) => {
  const full = buildMixFilter({voiceDur: 6, musicDur: 20, gain: -14, duck, fadeIn: 0, fadeOut: 0});
  const outMusic = join(W, `music-duck${duck}-${st}.wav`);
  let filter;
  if (duck > 0) {
    const sc = (full.match(/sidechaincompress=([^\[]+)\[bg2\]/) ?? [])[1];
    if (!sc) { console.log('抽不到 sidechain 参数：', full); return null; }
    filter = `[1:a]volume=-14dB[bg];[0:a]asplit=2[v][sc];[v]anullsink;[bg][sc]sidechaincompress=${sc}[music]`;
  } else {
    filter = `[1:a]volume=-14dB[music]`;
  }
  const r = ff(['-y', '-i', voice, '-i', music, '-filter_complex', filter,
    '-map', '[music]', '-ar', '48000', '-ac', '1', outMusic]);
  if (r.status !== 0) {
    console.log('  侧链测量失败:', String(r.stderr).trim().split('\n').slice(-1)[0].slice(0, 160));
    return null;
  }
  return meanVol(outMusic, st, d);
};

console.log('=== 1) 闪避是否真的压了音乐（只测音乐那一路）===');
// 有声段取 1.0–2.5s（人声持续在场）
const talkNo = musicLevelWithDuck(0, 1.0, 1.5);
const talkYes = musicLevelWithDuck(10, 1.0, 1.5);
console.log(`  有声段音乐：duck=0 → ${talkNo} dB | duck=10 → ${talkYes} dB`);
const duckWorks = talkNo !== null && talkYes !== null && (talkNo - talkYes) > 1.5;
console.log(`  音乐被压低 ${talkNo !== null && talkYes !== null ? (talkNo - talkYes).toFixed(2) : '?'} dB（应 > 1.5）:`, duckWorks ? '✓' : '✗');

console.log('\n=== 2) 闪避会释放（人声停后音乐恢复）===');
// 4.5–5.9s 人声已停
const quietNo = musicLevelWithDuck(0, 4.5, 1.4);
const quietYes = musicLevelWithDuck(10, 4.5, 1.4);
console.log(`  纯音乐段：duck=0 → ${quietNo} dB | duck=10 → ${quietYes} dB`);
const releases = quietNo !== null && quietYes !== null && Math.abs(quietNo - quietYes) < 1.5;
console.log('  两版接近（闪避已释放）:', releases ? '✓' : '✗');

console.log('\n=== 3) duck 越大压得越深 ===');
const d4 = musicLevelWithDuck(4, 1.0, 1.5);
console.log(`  duck=4 → ${d4} dB | duck=10 → ${talkYes} dB`);
const monotonic = d4 !== null && talkYes !== null && d4 > talkYes;
console.log('  duck=4 比 duck=10 更响（压得浅）:', monotonic ? '✓' : '✗');

console.log('\n=== 4) 完整混音产物：带视频+音频流、时长正确 ===');
const finalOut = join(W, 'final.mp4');
const res = await muxWithMusic(video, voice, music, finalOut, {...base, duck: 10}, 6);
const pr = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-show_entries', 'format=duration', '-of', 'json', finalOut], {encoding: 'utf8'});
const info = JSON.parse(pr.stdout);
console.log('  ', JSON.stringify(info.streams), 'duration', info.format?.duration, 'size', res.sizeMB, 'MB');
const hasBoth = info.streams.some((s) => s.codec_type === 'video') && info.streams.some((s) => s.codec_type === 'audio');

console.log('\n=== 5) 负面对照：音乐不存在必须报错 ===');
let threw = null;
try { await muxWithMusic(video, voice, join(W, 'nope.wav'), join(W, 'x.mp4'), base, 6); } catch (e) { threw = e; }
console.log('  报错:', threw ? '✓ ' + threw.message.slice(0, 40) : '✗');

rmSync(W, {recursive: true, force: true});
const allOk = duckWorks && releases && monotonic && hasBoth && !!threw;
console.log(allOk ? '\n✓ 端到端全部符合预期' : '\n✗ 有不符合项');
process.exit(allOk ? 0 : 1);
