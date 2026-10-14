// 素材管线的端到端验证（host 侧，真跑 ffmpeg）：
//   1. 造一段视频（每帧颜色不同，便于验证「取到了哪一帧」）
//   2. prepareClip 抽帧 → 生成序列 + .done 标记
//   3. 再跑一次 → 应命中缓存（不重抽）
//   4. 改参数 → 键变化 → 重抽（不会拿旧帧冒充新配置）
//   5. 断点安全：模拟抽帧中断（.tmp 残留）不影响下次
//   6. 源文件不存在 / start 超过时长 → 报错且不留残缺缓存
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, statSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {join, resolve} from 'node:path';

// resolve() 保证 ROOT 是**绝对路径**：下面要用它拼 file:// URL 或 pathToFileURL，
// 相对路径会抛 ERR_INVALID_FILE_URL_PATH（CI 步骤里传 `.` 时踩到过）。
// ⚠️ 必须给兜底：CI 里这个工具是**不带参数**跑的（`node tools/verify-X.mjs`），
// 而 `resolve(undefined)` 会抛 ERR_INVALID_ARG_TYPE（CI 实测红过）。
const ROOT = resolve(process.argv[2] ?? process.cwd()).replace(/\\/g, '/');
const imp = (rel) => import(pathToFileURL(`${ROOT}/${rel}`).href);
const {prepareClips, prepareClip, clipKey, countFrames, isPrepared} = await imp('src/host/media/clips.mjs');

const PROJ = `${ROOT}/.work/clip-proj`;
rmSync(PROJ, {recursive: true, force: true});
mkdirSync(join(PROJ, 'public', 'assets'), {recursive: true});

// 造视频：3 秒、30fps、每帧不同颜色（用 testsrc2 有运动，便于肉眼确认）
const vid = join(PROJ, 'public', 'assets', 'broll.mp4');
let r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi',
  '-i', 'testsrc2=size=320x180:rate=30:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', vid],
  {encoding: 'utf8'});
if (r.status !== 0) { console.log('造视频失败:', r.stderr.slice(-200)); process.exit(1); }
console.log('造好视频:', (statSync(vid).size / 1024).toFixed(0), 'KB（3s @30fps）\n');

let bad = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) bad++; };

console.log('=== 1) 抽帧 ===');
const clip = {name: 'broll', src: '/assets/broll.mp4', seq: false, fps: 30, width: 320, start: 0, maxSec: 0};
const c1 = await prepareClip(PROJ, clip, join(PROJ, '.work', 'clips'));
console.log(`  目录 ${c1.dir.split('/').pop()} | ${c1.frames} 帧 | cached=${c1.cached}`);
ok(c1.frames === 90, `应抽到 90 帧（3s × 30fps），实际 ${c1.frames}`);
ok(!c1.cached, '首次应是新抽（cached=false）');
ok(existsSync(join(c1.dir, '.done')), '应有 .done 完成标记');

console.log('\n=== 2) 再跑一次：命中缓存 ===');
const c2 = await prepareClip(PROJ, clip, join(PROJ, '.work', 'clips'));
ok(c2.cached === true, '第二次应命中缓存'); 
ok(c2.dir === c1.dir, '缓存目录应相同（同一个键）');
ok(c2.frames === c1.frames, '帧数一致');

console.log('\n=== 3) 改参数 → 键变化 → 重抽（不拿旧帧冒充）===');
const c3 = await prepareClip(PROJ, {...clip, width: 160}, join(PROJ, '.work', 'clips'));
ok(c3.dir !== c1.dir, 'width 变了 → 不同缓存目录');
ok(!c3.cached, '应重新抽帧');
ok(c3.frames === 90, '帧数仍应为 90');

console.log('\n=== 4) maxSec 限长：只抽需要的秒数 ===');
const c4 = await prepareClip(PROJ, {...clip, maxSec: 1}, join(PROJ, '.work', 'clips'));
ok(c4.frames >= 28 && c4.frames <= 31, `限制 1 秒应抽约 30 帧，实际 ${c4.frames}`);

console.log('\n=== 5) 断点安全：残留 .tmp 不影响下次抽帧 ===');
const key = clipKey({...clip, fps: 25}, statSync(vid));
const tmpLeft = join(PROJ, '.work', 'clips', key + '.tmp');
mkdirSync(tmpLeft, {recursive: true});
writeFileSync(join(tmpLeft, 'f00001.png'), 'partial');
const c5 = await prepareClip(PROJ, {...clip, fps: 25}, join(PROJ, '.work', 'clips'));
ok(c5.frames === 75, `25fps 应抽 75 帧，实际 ${c5.frames}`);
ok(!existsSync(tmpLeft), '残留的 .tmp 应被清掉');
ok(!existsSync(join(c5.dir, 'f00001.png')) || statSync(join(c5.dir, 'f00001.png')).size > 100,
  '新抽的帧应是真 PNG（不是残留的 5 字节假文件）');

console.log('\n=== 6) 负面对照：源文件不存在 ===');
let threw = null;
try { await prepareClip(PROJ, {...clip, src: '/assets/nope.mp4', name: 'nope'}, join(PROJ, '.work', 'clips')); }
catch (e) { threw = e; }
ok(threw && threw.code === 'NO_CLIP_FILE', '应报 NO_CLIP_FILE：' + (threw?.message ?? '').slice(0, 60));

console.log('\n=== 7) 负面对照：start 超过视频时长，且不留残缺缓存 ===');
const before = readdirSync(join(PROJ, '.work', 'clips')).length;
let threw2 = null;
try {
  await prepareClip(PROJ, {...clip, name: 'late', src: '/assets/broll.mp4', start: 99}, join(PROJ, '.work', 'clips'));
} catch (e) { threw2 = e; }
const after = readdirSync(join(PROJ, '.work', 'clips')).length;
ok(threw2 && threw2.code === 'CLIP_EXTRACT_FAILED', '应报 CLIP_EXTRACT_FAILED');
ok(threw2.message.includes('99s') || threw2.message.includes('超过时长'), '错误信息应点出 start 超过时长：' + threw2.message.slice(0, 100));
ok(after === before, `失败的抽帧不该留下目录（前 ${before} 个 → 后 ${after} 个）`);

console.log('\n=== 8) prepareClips：批量 + 统计 ===');
const many = await prepareClips(PROJ, [
  {...clip},
  {...clip, name: 'b2', fps: 10},
], {cacheRoot: join(PROJ, '.work', 'clips2')});
ok(Object.keys(many.clips).length === 2, '两个片段都应就绪');
ok(many.extracted === 2 && many.cached === 0, `首次应抽 2 个（extracted=${many.extracted}, cached=${many.cached}）`);
ok(many.clips.b2.frames === 30, `10fps 抽 3 秒应 30 帧，实际 ${many.clips.b2.frames}`);
const many2 = await prepareClips(PROJ, [{...clip}], {cacheRoot: join(PROJ, '.work', 'clips2')});
ok(many2.cached === 1, '第二次应命中缓存');

rmSync(PROJ, {recursive: true, force: true});
console.log(bad === 0 ? '\n✓ 素材管线端到端全部符合预期' : `\n✗ ${bad} 项失败`);
process.exit(bad ? 1 : 0);
