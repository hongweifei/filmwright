// 真实配音的验证：示例的时间轴必须是**真配音**（不是合成夹具），
// 且时间轴/音频/画面三者一致。
//
//   node tools/verify-voiceover.mjs [<仓库根>]
//
// ## 为什么需要它
//
// 在此之前，4 个示例里只有 minimal 的时间轴来自真配音，其余三个都是
// `tools/make-timeline-fixture.mjs` 合成的**夹具**（明确标注非配音）。
// 也就是说「解说词 → 配音 → 时间轴 → 画面」这条完整链路**从没被验证过**。
//
// 真配音与夹具的差别是实打实的：实测三个示例的真配音比夹具**长 6–11%**
// （夹具的时长是按字数编的），逐句差异最大 +1.13s。这直接决定镜头节奏与
// 字幕切点 —— 用夹具调好的画面，换成真配音就会错位。
//
// ⚠️ 现在只剩 `examples/minimal` 一个示例（其余四个随声明式入口一起删了），
// 而它的时间轴本来就是**真配音**（`engine=sapi`、无 `_fixture` 标记、成品 `audio.wav`
// 与之时长一致）⇒ 本工具只跑它。这不是把判据放宽：留下的是同样的三条
// （真配音 / 时间轴自洽 / 句 id 引用存在），只是语料从四个收成一个。
import {existsSync, readFileSync, statSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// resolve() 保证 ROOT 是**绝对路径**：下面会用 `pathToFileURL(`${ROOT}/…`)` 或
// `file:///${ROOT}/…` 拼 URL，相对路径会直接抛 ERR_INVALID_FILE_URL_PATH。
const ROOT = resolve(process.argv[2] ?? resolve(HERE, '..')).replace(/\\/g, '/');
const PROJECTS = ['minimal'];

let bad = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) bad++; };

console.log('=== 1) 每个示例的时间轴必须来自真配音 ===');
for (const p of PROJECTS) {
  const dir = join(ROOT, 'examples', p);
  const tlPath = join(dir, 'script', 'timeline.json');
  if (!existsSync(tlPath)) { ok(false, `${p}：缺 timeline.json`); continue; }
  const tl = JSON.parse(readFileSync(tlPath, 'utf8'));
  const isFixture = Boolean(tl._fixture);
  ok(!isFixture, `${p}：时间轴来自真配音（engine=${tl.engine}）` +
    (isFixture ? ` —— 仍是合成夹具：${String(tl._fixture).slice(0, 40)}` : ''));

  // 有配音就得有音频文件，且时长与时间轴一致
  const slug = tl.slug ?? p;
  const wav = join(dir, 'public', 'assets', slug, 'audio.wav');
  if (!existsSync(wav)) {
    ok(false, `${p}：缺配音文件 ${wav.replace(ROOT + '/', '')}`);
    continue;
  }
  ok(statSync(wav).size > 10000, `${p}：配音文件非空（${(statSync(wav).size / 1024).toFixed(0)} KB）`);

  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-show_entries', 'stream=channels,sample_rate', '-of', 'json', wav], {encoding: 'utf8'});
  const info = JSON.parse(probe.stdout);
  const dur = Number(info.format.duration);
  const st = info.streams[0];
  const expect = tl.total_frames / tl.fps;
  ok(Math.abs(dur - expect) < 0.2,
    `${p}：音频 ${dur.toFixed(2)}s 与时间轴 ${expect.toFixed(2)}s 一致（差 ${Math.abs(dur - expect).toFixed(3)}s）`);
  ok(st.channels === 2 && Number(st.sample_rate) === 48000, `${p}：音频 48k 双声道`);

  // 字幕时间来源要如实标注。
  // 注意：**旧版生成的时间轴没有这个字段**（它是后加的）。时间轴是数据契约，
  // 加字段不该让老数据变成「非法」—— 所以缺字段时按「推定」处理并提示重跑，
  // 而不是判失败。真正要守的是「有字段时不能标错」。
  if (tl.subs_timing === undefined) {
    console.log(`  · ${p}：subs_timing 缺失（旧版 TTS 生成的时间轴）—— 重跑 tts 即可补上`);
  } else {
    ok(['word', 'estimated'].includes(tl.subs_timing), `${p}：subs_timing 合法（${tl.subs_timing}）`);
    const engineIsEdge = tl.engine === 'edge';
    ok(engineIsEdge ? tl.subs_timing === 'word' : tl.subs_timing === 'estimated',
      `${p}：subs_timing 与引擎能力一致（${tl.engine} → ${tl.subs_timing}）`);
  }
}

console.log('\n=== 2) 时间轴自洽 ===');
for (const p of PROJECTS) {
  const tlPath = join(ROOT, 'examples', p, 'script', 'timeline.json');
  if (!existsSync(tlPath)) continue;
  const tl = JSON.parse(readFileSync(tlPath, 'utf8'));
  const sents = tl.sentences ?? [];
  const subs = tl.subs ?? [];
  const issues = [];
  if (!sents.length) issues.push('没有句子');
  if (sents.some((s) => !(s.from < s.to))) issues.push('有句子 from >= to');
  if (sents.some((s, i) => i > 0 && sents[i - 1].to >= s.from)) issues.push('句子区间重叠');
  if (subs.some((s, i) => i > 0 && subs[i - 1].to >= s.from)) issues.push('字幕块重叠');
  for (const s of sents) {
    for (const sb of s.subs ?? []) {
      if (!(s.from <= sb.from && sb.to <= s.to)) issues.push(`句 ${s.id} 的字幕块越界`);
    }
  }
  if (subs.length === 0) issues.push('没有字幕块');
  ok(issues.length === 0, `${p}：时间轴自洽（${sents.length} 句 / ${subs.length} 字幕块）` +
    (issues.length ? ' —— ' + issues.slice(0, 3).join('、') : ''));
}

console.log('\n=== 3) 配置（hud 等）引用的句 id 都要存在（改解说词最容易漏的地方）===');
for (const p of PROJECTS) {
  const dir = join(ROOT, 'examples', p);
  const tlPath = join(dir, 'script', 'timeline.json');
  if (!existsSync(tlPath)) {
    console.log(`  ${p}：没有时间轴，跳过`);
    continue;
  }
  const r = spawnSync('node', [join(ROOT, 'bin', 'filmwright.mjs'), 'check',
    '--project', dir, '--static-only', '--json'], {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024});
  let j = null;
  try { j = JSON.parse(r.stdout); } catch { /* 下面统一报 */ }
  const tlCheck = j?.data?.checks?.find((c) => c.name === 'timeline');
  ok(tlCheck?.ok === true, `${p}：配置（hud 等）里的句引用都存在` +
    (tlCheck?.ok ? '' : ' —— ' + JSON.stringify(tlCheck?.problems?.slice(0, 2))));
}

console.log('\n=== 4) 真配音与合成夹具的差异（记录事实，供判断画面是否需要重调）===');
for (const p of PROJECTS) {
  const fixPath = join(ROOT, 'examples', p, 'script', 'timeline.fixture.json');
  const realPath = join(ROOT, 'examples', p, 'script', 'timeline.json');
  if (!existsSync(fixPath)) { console.log(`  ${p}：没有保留夹具，跳过对比`); continue; }
  const f = JSON.parse(readFileSync(fixPath, 'utf8'));
  const r = JSON.parse(readFileSync(realPath, 'utf8'));
  const diff = r.total_frames - f.total_frames;
  const pct = (diff / f.total_frames * 100).toFixed(0);
  console.log(`  ${p}：夹具 ${f.total_frames} 帧 → 真配音 ${r.total_frames} 帧` +
    `（${diff >= 0 ? '+' : ''}${diff}，${pct}%），语速 ${(r.chars / r.speech_sec).toFixed(2)} 字/秒`);
}

console.log(bad === 0 ? '\n✓ 示例的时间轴来自真配音且自洽' : `\n✗ ${bad} 项失败`);
process.exit(bad ? 1 : 0);
