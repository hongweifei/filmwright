#!/usr/bin/env node
// TTS 的正式验证工具（node 侧，与 python 侧的测试互补）。
//
//   node tools/verify-tts.mjs [<仓库根>]
//
// 验的是**命令层与产物的契约**（python 侧单测覆盖引擎内部）：
//   1. voices 命令能报出各引擎可用性，并如实说明「实际会用哪个」
//   2. 在临时项目上真跑一遍 tts，产出三件套
//   3. timeline.json 里如实标注 engine / subs_timing（不能让使用者猜字幕准不准）
//   4. 音频时长与时间轴一致；时间轴自洽（句不重叠、字幕块在句内）
//   5. 逐句缓存：第二次跑不重新合成
//   6. 负面对照：引擎名写错、缺解说词、--json 契约
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, cpSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = (process.argv[2] ?? resolve(HERE, '..')).replace(/\\/g, '/');
const KIT = join(ROOT, 'bin', 'filmwright.mjs');
const PROJ = join(ROOT, '.work', 'tts-verify');

let bad = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) bad++; };

const run = (args, opts = {}) => spawnSync('node', [KIT, ...args], {
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
  env: {...process.env, PYTHONIOENCODING: 'utf-8'},
  ...opts,
});

// ---------- 造一个精简项目 ----------
rmSync(PROJ, {recursive: true, force: true});
mkdirSync(join(PROJ, 'script'), {recursive: true});
cpSync(join(ROOT, 'examples', 'scenecast'), PROJ, {recursive: true});
rmSync(join(PROJ, 'audio'), {recursive: true, force: true});
rmSync(join(PROJ, 'public', 'assets', 'scenecast'), {recursive: true, force: true});
writeFileSync(join(PROJ, 'script', 'narration.txt'),
  '# CHAPTER 1 第一段\n这是第一句话。|它有两个字幕块。\n这是第二句话。\n\n# CHAPTER 2 第二段\n这是第三句话。\n',
  'utf8');
const cfgPath = join(PROJ, 'film.config.mjs');
const cfgOrig = readFileSync(cfgPath, 'utf8');
const setEngine = (v) => writeFileSync(cfgPath,
  cfgOrig.replace("engine: 'edge'", `engine: ${JSON.stringify(v)}`), 'utf8');
setEngine('auto');

console.log('=== 1) voices：报出各引擎可用性 ===');
{
  const r = run(['voices', '--project', PROJ]);
  const out = String(r.stdout || '');
  ok(r.status === 0, `voices 退出码 0（实际 ${r.status}）`);
  ok(out.includes('edge') && out.includes('sapi'), '列出了 edge 与 sapi');
  ok(out.includes('实际会用'), '说明「实际会用哪个引擎」（使用者不必自己推断回退结果）');
  ok(out.includes('词边界'), '说明各引擎有没有词边界（决定字幕能否精确对齐）');
  // --json 契约：stdout 恰好一个 JSON 文档
  const rj = run(['voices', '--project', PROJ, '--json']);
  let j = null;
  try { j = JSON.parse(rj.stdout); } catch (e) { j = null; }
  ok(j !== null, '--json 输出是合法 JSON（stdout 恰好一个文档）');
  if (j) {
    ok(Array.isArray(j.data?.engines) && j.data.engines.length === 3, '报出 3 个引擎');
    ok(j.data.engines.some((e) => e.name === 'sapi' && e.available), 'sapi 标为可用');
    ok(typeof j.data.resolved?.engine === 'string', 'resolved 给出最终会用的引擎');
  }
}

console.log('\n=== 2) tts：真跑一遍（engine: auto，edge 不可用时应自动降级）===');
{
  const r = run(['tts', '--project', PROJ]);
  if (r.status !== 0) {
    console.log('  stdout:', String(r.stdout || '').slice(-600));
    console.log('  stderr:', String(r.stderr || '').slice(-600));
  }
  ok(r.status === 0, `tts 退出码 0（实际 ${r.status}）`);
  const wav = join(PROJ, 'public', 'assets', 'scenecast', 'audio.wav');
  ok(existsSync(wav), '产出 audio.wav');
  ok(existsSync(join(PROJ, 'script', 'timeline.json')), '产出 timeline.json');
  ok(existsSync(join(PROJ, 'script', 'timeline.md')), '产出 timeline.md');
}

console.log('\n=== 3) timeline 如实标注引擎与字幕时间来源 ===');
const tlPath = join(PROJ, 'script', 'timeline.json');
let tl = null;
{
  tl = JSON.parse(readFileSync(tlPath, 'utf8'));
  const e = tl.engine;
  ok(['edge', 'sapi', 'command'].includes(e), `engine 字段是实际用的引擎（${e}）`);
  ok(['word', 'estimated'].includes(tl.subs_timing),
    `subs_timing 如实标注（${tl.subs_timing}）—— 使用者据此知道字幕准不准`);
  // 关键一致性：有词边界的引擎必须标 word，没有的必须标 estimated
  if (e === 'edge') ok(tl.subs_timing === 'word', 'edge 应标 word');
  else ok(tl.subs_timing === 'estimated', `${e} 应标 estimated（它没有词边界）`);
  ok(typeof tl.engine_note === 'string' && tl.engine_note.includes(e),
    `engine_note 说明用的是哪个引擎（${tl.engine_note}）`);
}

console.log('\n=== 4) 音频与时间轴一致、时间轴自洽 ===');
{
  const wav = join(PROJ, 'public', 'assets', 'scenecast', 'audio.wav');
  const p = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=channels,sample_rate,width',
    '-show_entries', 'format=duration', '-of', 'json', wav], {encoding: 'utf8'});
  const info = JSON.parse(p.stdout);
  const st = info.streams[0];
  const dur = Number(info.format.duration);
  ok(st.channels === 2 && Number(st.sample_rate) === 48000, '音频 48k 双声道（与渲染链一致）');
  const expect = tl.total_frames / tl.fps;
  ok(Math.abs(dur - expect) < 0.15, `音频 ${dur.toFixed(2)}s 与时间轴 ${expect.toFixed(2)}s 一致`);

  const sents = tl.sentences ?? [];
  const subs = tl.subs ?? [];
  ok(sents.every((s) => s.from < s.to), '每句 from < to');
  ok(sents.every((s, i) => i === 0 || sents[i - 1].to < s.from), '句与句不重叠');
  ok(subs.every((s, i) => i === 0 || subs[i - 1].to < s.from), '字幕块之间不重叠');
  let inside = true;
  for (const s of sents) {
    for (const sb of s.subs ?? []) {
      if (!(s.from <= sb.from && sb.to <= s.to)) inside = false;
    }
  }
  ok(inside, '每个字幕块都落在所属句区间内');
  ok((tl.chapters ?? []).length === 2, `章节数 2（实际 ${(tl.chapters ?? []).length}）`);
}

console.log('\n=== 5) 逐句缓存：第二次跑不重新合成 ===');
{
  const cache = join(PROJ, 'audio', 'cache');
  const before = readdirSync(cache).sort().map((f) => [f, statSync(join(cache, f)).mtimeMs]);
  const r = run(['tts', '--project', PROJ]);
  ok(r.status === 0, '第二次跑成功');
  const after = readdirSync(cache).sort().map((f) => [f, statSync(join(cache, f)).mtimeMs]);
  ok(JSON.stringify(before.map(([f]) => f)) === JSON.stringify(after.map(([f]) => f)),
    `缓存文件集不变（${before.length} 个）`);
  const same = before.every(([f, t], i) => after[i][0] === f && after[i][1] === t);
  ok(same, '所有缓存文件 mtime 未变 → 确实命中缓存');
}

console.log('\n=== 6) 负面对照 ===');
{
  // 6a 引擎名写错
  setEngine('nope');
  const r1 = run(['tts', '--project', PROJ]);
  ok(r1.status !== 0, '写错的引擎名应失败');
  const msg1 = String(r1.stderr || '') + String(r1.stdout || '');
  ok(msg1.includes('nope') && msg1.includes('可用'), '报错列出可用的引擎名');

  // 6b 缺解说词
  setEngine('auto');
  const narr = join(PROJ, 'script', 'narration.txt');
  const saved = readFileSync(narr);
  rmSync(narr);
  const r2 = run(['tts', '--project', PROJ]);
  ok(r2.status !== 0, '缺解说词应失败');
  ok((String(r2.stderr || '') + String(r2.stdout || '')).includes('narration.txt'),
    '报错指出缺的是哪个文件');
  writeFileSync(narr, saved);

  // 6c 全不可用时的出路（用不存在的引擎 + 只配一个）
  setEngine('command');
  const r3 = run(['tts', '--project', PROJ]);
  ok(r3.status !== 0, 'command 没配命令应失败');
  const msg3 = String(r3.stderr || '') + String(r3.stdout || '');
  ok(msg3.includes('command'), '报错说清是哪个引擎不行、为什么');
  setEngine('auto');
}

console.log('\n=== 7) 换引擎必须让缓存失效（不能拿旧引擎的音频）===');
{
  // 先记录当前 sapi 产出的音频哈希
  const wav = join(PROJ, 'public', 'assets', 'scenecast', 'audio.wav');
  const {createHash} = await import('node:crypto');
  const h1 = createHash('sha256').update(readFileSync(wav)).digest('hex').slice(0, 12);
  // 用 command 引擎（ffmpeg 造静音）跑一遍，产物必须不同
  setEngine('command');
  const cfg = readFileSync(cfgPath, 'utf8').replace(
    "engine: \"command\"",
    "engine: \"command\", command: \"ffmpeg -y -v error -f lavfi -i anullsrc=r=48000:cl=mono -t 0.5 {out}\"");
  writeFileSync(cfgPath, cfg, 'utf8');
  const r = run(['tts', '--project', PROJ]);
  ok(r.status === 0, '用 command 引擎跑成功');
  const h2 = createHash('sha256').update(readFileSync(wav)).digest('hex').slice(0, 12);
  ok(h1 !== h2, `换引擎后产物必须不同（${h1} → ${h2}）—— 缓存键含引擎名`);
  const tl2 = JSON.parse(readFileSync(tlPath, 'utf8'));
  ok(tl2.engine === 'command', `timeline 标注新引擎（${tl2.engine}）`);
  ok(tl2.subs_timing === 'estimated', 'command 无词边界 → estimated');
  setEngine('auto');
}

rmSync(PROJ, {recursive: true, force: true});
console.log(bad === 0 ? '\n✓ TTS 契约全部符合预期' : `\n✗ ${bad} 项失败`);
process.exit(bad ? 1 : 0);
