// 各命令的实现。每个都只做一件事，由 cli/index.mjs 按名字找到并调用。
//
// 约定：命令收到 (ctx) —— {projectDir, proj, args, opts}，返回
//   {code, data, warnings, errors}（退出码 0 成功）。
// data/warnings/errors 只在 --json 时打印（见 cli/output.mjs）；
// 人模式的进度一律走 say()，json 模式自动静默。
import {existsSync, mkdirSync, rmSync, writeFileSync, statSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import {dirname, join, resolve, basename} from 'node:path';
import {requireTimeline} from '../project/load.mjs';
import {renderRange, renderStills, renderSequence} from '../media/renderRange.mjs';
import {muxVideo} from '../media/mux.mjs';
import {spawnTool, ffmpegPath, checkSpawned} from '../media/ffmpegBin.mjs';
import {runChecks} from '../checks/index.mjs';
import {THRESHOLDS as QUALITY_THRESHOLDS} from '../checks/runtime/quality.mjs';
import {preview as previewCmd} from './preview.mjs';
import {scaffoldProject} from '../project/scaffold.mjs';
import {exportSrt, readTranslation} from '../media/srt.mjs';
import {sceneSchema} from '../../contract/scene.js';
import {KIT_ROOT, RUNTIME_ROOT} from '../root.mjs';
import {num, str} from './args.mjs';
import {assertTool} from '../preflight.mjs';
import {makeSay, isJson} from './output.mjs';

const API_FILE = join(RUNTIME_ROOT, 'index.js');

/** 自检。 */
export async function check(ctx) {
  const json = isJson(ctx.args);
  requireTimeline(ctx.proj);   // 没有时间轴就给出「先跑 tts」，而不是深处读 null 崩掉
  // --static-only：只跑读文件的那几道（api / imports / timeline / scene），不启浏览器。
  // 用途：CI 上不想装浏览器时、以及改完镜头想秒级验证引用关系时。
  const staticOnly = ctx.args['static-only'] === true;
  const res = await runChecks(ctx.projectDir, ctx.proj, ctx.opts, {
    apiFile: API_FILE,
    runtimeDir: RUNTIME_ROOT,
    staticOnly,
    // 画质自检要整片采样，比其余几道贵；默认开，用 --no-quality 关掉
    quality: !staticOnly && ctx.args.quality !== false && ctx.args['no-quality'] !== true,
    qualityThresholds: qualityThresholds(ctx.args),
    quiet: json,
  });
  const errors = [];
  const warnings = [];
  for (const r of res.results) {
    // 有结构化错误的道（scene）直接带 code/path/hint；其余把文本问题包一层
    if (r.errors?.length) {
      for (const e of r.errors) errors.push({code: e.code, message: e.message, where: e.path, ...(e.hint ? {hint: e.hint} : {})});
    } else {
      for (const p of r.problems ?? []) errors.push({code: 'CHECK_' + r.name.toUpperCase(), message: p});
    }
    for (const h of [...(r.hints ?? []), ...(r.notes ?? [])]) warnings.push(`${r.name}：${h}`);
  }
  // 人模式的逐道输出由 runChecks 自己打（quiet 只在 json 时开），这里不再重复汇总。
  return {
    code: res.failed ? 1 : 0,
    data: {
      failed: res.failed,
      checks: res.results.map((r) => ({
        name: r.name, ok: r.ok, checked: r.checked,
        problems: r.problems ?? [], hints: r.hints ?? [], notes: r.notes ?? [],
        // 画质那道带上逐镜头读数：判失败时要能看出是哪个指标、离阈值多远
        // （跨平台栅格化差异会让贴阈值的读数翻面，没有数值就无从判断）
        ...(r.stats ? {stats: r.stats, detail: r.detail} : {}),
      })),
    },
    warnings,
    errors,
  };
}

/** 从命令行覆盖画质阈值（--static-frames / --hold-frames / --ink-min / --quality-step）。 */
function qualityThresholds(args) {
  const t = {};
  const map = {
    'static-frames': 'staticFrames',
    'hold-frames': 'holdFrames',
    'ink-min': 'inkMin',
    'quality-step': 'sampleStep',
  };
  for (const [flag, key] of Object.entries(map)) {
    if (args[flag] === undefined) continue;
    const v = Number(args[flag]);
    if (!Number.isFinite(v)) throw new Error(`filmwright: --${flag} 要是数字，收到 ${args[flag]}`);
    t[key] = v;
  }
  return Object.keys(t).length ? {...QUALITY_THRESHOLDS, ...t} : undefined;
}

/** 预览：本地起服务 + 打开预览页（拖动时间轴、播放、改文件热重载）。 */
export async function preview(ctx) {
  return previewCmd(ctx);
}

/**
 * MCP 服务器（stdio）。SDK 是惰性 import：
 * 没装依赖的机器上，其余命令照常跑——核心工具链的零依赖不被 MCP 拖破。
 */
export async function mcp() {
  let startMcp;
  try {
    ({startMcp} = await import('../mcp/server.mjs'));
  } catch (e) {
    if (e && e.code === 'ERR_MODULE_NOT_FOUND') {
      const err = new Error('filmwright: MCP 服务器需要依赖 @modelcontextprotocol/sdk');
      err.code = 'NO_MCP_SDK';
      err.hint = '在本仓库目录跑一次 npm install（其余命令不需要任何 npm 依赖）';
      throw err;
    }
    throw e;
  }
  const code = await startMcp();
  return {code: code ?? 0};
}

/**
 * 输出机器可读的场景规格 schema：类型、字段、容量上限、对齐语法、错误码。
 * agent 不读文档也能发现规格 —— 框架自描述。
 */
export async function schema(ctx) {
  const s = sceneSchema();
  if (isJson(ctx.args)) return {code: 0, data: {schema: s}};
  console.log(`scene 规格 ${s.schema} —— ${Object.keys(s.types).length} 类模板：\n`);
  for (const [name, t] of Object.entries(s.types)) {
    const fields = Object.entries(t.fields)
      .map(([k, f]) => (f.required ? k : k + '?')).join(' / ');
    const max = Object.keys(t.max).length ? '  上限 ' + JSON.stringify(t.max) : '';
    console.log(`  ${name.padEnd(9)} ${t.note}`);
    console.log(`  ${''.padEnd(9)} 字段：${fields}${max}`);
  }
  console.log('\n对齐 at：' + JSON.stringify(s.at, null, 2).replace(/\n/g, '\n  '));
  console.log('\n错误码：' + s.errorCodes.join(' / '));
  console.log('\n机器可读版：filmwright schema --json');
  return {code: 0};
}

/**
 * 导出 SRT 字幕。框架不翻译（AI 在框架外的边界不破）——外部产出译文后
 * 用 --translation 合成双语轨。
 */
export async function srt(ctx) {
  const say = makeSay(ctx.args);
  requireTimeline(ctx.proj);
  const translation = readTranslation(str(ctx.args, 'translation', null));
  const r = exportSrt(ctx.proj, {
    out: ctx.args.out ? resolve(String(ctx.args.out)) : undefined,
    translation,
  });
  say(`${r.out}  ${r.blocks} 块${r.bilingual ? '（双语）' : ''}`);
  return {code: 0, data: r};
}

/** 新建项目骨架。不需要 --project：目标目录就是位置参数。 */
export async function newProject(ctx) {
  const say = makeSay(ctx.args);
  const r = scaffoldProject(ctx.dir, {template: String(ctx.args.template ?? 'scene')});
  say(`已建 ${r.template} 模板项目：${r.dir}`);
  for (const f of r.files) say('  ' + f);
  const steps = [
    `把 ${r.dir}/script/narration.txt 改成你的解说词`,
    r.template === 'scene' ? `改 ${r.dir}/scene.json 配画面（docs/scene.md）` : `写 ${r.dir}/shots/index.js 配画面`,
    'filmwright tts    --project ' + r.dir,
    'filmwright check  --project ' + r.dir + ' --static-only',
    'filmwright all    --project ' + r.dir,
  ];
  say('下一步：');
  for (const s of steps) say('  ' + s);
  return {code: 0, data: {...r, nextSteps: steps}};
}

/** 解说词 → 配音 + 时间轴（交给 python，它管 TTS）。 */
export function tts(ctx) {
  const say = makeSay(ctx.args);
  const json = isJson(ctx.args);
  const py = join(KIT_ROOT, 'src', 'host', 'tts', 'build.py');
  // PYTHONIOENCODING：Windows 上 Python 默认按 CP936 写 stderr，而 Node 按 UTF-8
  // 解码 —— 中文提示会全成乱码（实测「微软侧 TTS 服务不可用」整段变成 ????）。
  // 强制 UTF-8，两边编码才对齐。
  const r = spawnSync('python', [py, '--project', ctx.projectDir], {
    stdio: json ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    env: {...process.env, PYTHONIOENCODING: 'utf-8'},
  });
  if (r.error) {
    const e = new Error('filmwright: 起不了 python —— ' + r.error.message);
    e.code = 'NO_PYTHON';
    e.hint = '装 Python 3 并让 python 在 PATH 里（tts 用 edge-tts）';
    throw e;
  }
  if ((r.status ?? 1) !== 0) {
    // python 已经把可行动的提示打在 stderr 上了（见 build.py 的 _tts_failure_hint）；
    // 别再加一层前缀，免得「filmwright: tts 失败」把它埋掉。
    const tail = String(r.stderr || '').trim().split('\n').slice(-12).join('\n');
    const e = new Error(tail && tail.includes('filmwright:') ? tail : 'filmwright: tts 失败' + (tail ? '：\n' + tail : ''));
    e.code = 'TTS_FAILED';
    throw e;
  }
  const slug = ctx.proj.raw.slug ?? 'film';
  return {
    code: 0,
    data: {
      audio: ctx.proj.paths.audio(slug),
      timeline: ctx.proj.paths.timeline,
      timelineMd: join(ctx.projectDir, 'script', 'timeline.md'),
      cache: join(ctx.projectDir, 'audio', 'cache'),
    },
  };
}

/** 出静帧。 */
export async function stills(ctx) {
  const say = makeSay(ctx.args);
  const frames = str(ctx.args, 'frames').split(',').map((s) => parseInt(s.trim(), 10));
  if (frames.some((n) => !Number.isFinite(n) || n < 1)) {
    const e = new Error('filmwright: --frames 里有非法帧号');
    e.code = 'BAD_FRAMES';
    throw e;
  }
  requireTimeline(ctx.proj);
  const outs = await renderStills(ctx.projectDir, ctx.proj, frames, resolve(str(ctx.args, 'dir')), ctx.opts);
  outs.forEach((o) => say('  ' + o));
  return {code: 0, data: {files: outs}};
}

/** 抽帧联络表。 */
export async function sheet(ctx) {
  const say = makeSay(ctx.args);
  assertTool(ffmpegPath(), '联络表的抽帧拼接要 ffmpeg');
  requireTimeline(ctx.proj);
  const total = ctx.proj.timeline.total_frames;
  const from = num(ctx.args, 'from', 1);
  const to = num(ctx.args, 'to', total);
  const step = num(ctx.args, 'step', 150);
  const cols = num(ctx.args, 'cols', 4);
  const out = resolve(str(ctx.args, 'out', join(ctx.proj.paths.qcDir, 'sheet.png')));
  const tmp = join(ctx.proj.paths.qcDir, '_sheet_tmp');

  const frames = [];
  for (let n = from; n <= to; n += step) frames.push(n);
  rmSync(tmp, {recursive: true, force: true});

  // 必须用连续编号的序列：ffmpeg 的图片序列中间断开就只读第一张
  const made = await renderSequence(ctx.projectDir, ctx.proj, frames, tmp, ctx.opts);
  if (made.length !== frames.length) {
    throw new Error(`filmwright: 只抽到 ${made.length}/${frames.length} 帧`);
  }
  mkdirSync(dirname(out), {recursive: true});
  const rows = Math.ceil(frames.length / cols);
  const scale = Math.max(120, Math.round(1760 / cols));
  const ff = spawnTool(ffmpegPath(), ['-y', '-i', join(tmp, 's%04d.png'), '-vf',
    `scale=${scale}:-1,tile=${cols}x${rows}`, '-frames:v', '1', '-update', '1', out],
    {stdio: ['ignore', 'ignore', 'inherit']});
  const code = await new Promise((res) => ff.on('close', res));
  checkSpawned(ff, '联络表拼接');
  if (code !== 0) throw new Error('filmwright: 拼联络表失败');
  if (!existsSync(out) || statSync(out).size === 0) {
    throw new Error('filmwright: 联络表没写出来');
  }
  say(`${out}  (${frames.length} 帧)`);
  return {code: 0, data: {out, frames: frames.length}};
}

/** 分片数解析：数字，或 auto（按 CPU 核数，留一核给主进程）。 */
function resolveShards(raw, total) {
  if (raw === undefined || raw === null || raw === '' || raw === 'auto') {
    if (raw === undefined || raw === null || raw === '') return 1;   // 默认不分片
    const cores = Math.max(1, (os.cpus?.() ?? []).length - 1);
    return Math.max(1, Math.min(cores, Math.ceil(total / 60)));      // 每片至少 ~60 帧
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    const e = new Error(`filmwright: --shards 要是正整数或 auto，收到 ${raw}`);
    e.code = 'BAD_SHARDS';
    e.hint = 'auto = 按 CPU 核数自动定（每片至少约 60 帧）';
    throw e;
  }
  return Math.floor(n);
}

/** 渲染。 */
export async function render(ctx) {
  const say = makeSay(ctx.args);
  assertTool(ffmpegPath(), '渲染编码要 ffmpeg');
  requireTimeline(ctx.proj);
  const total = ctx.proj.timeline.total_frames;
  const from = num(ctx.args, 'from', 1);
  const to = num(ctx.args, 'to', total);
  const shards = resolveShards(ctx.args.shards, to - from + 1);
  // 中间产物落在 .work/ 下
  const out = resolve(str(ctx.args, 'out',
    join(ctx.proj.paths.workDir, `${ctx.proj.raw.slug ?? 'film'}.mp4`)));
  const crf = str(ctx.args, 'crf', '16');
  // --resume：已渲好的分片直接复用（长片渲到 90% 挂掉时不用从头来）
  const resume = ctx.args.resume === true || ctx.args.resume === 'true';

  const t0 = Date.now();
  let written;
  if (shards <= 1) {
    ({written} = await renderRange(ctx.projectDir, ctx.proj, {
      from, to, out, crf, opts: ctx.opts,
      onProgress: (w, t) => { if (w % 100 === 0 || w === t) say(`  ${w}/${t}`); },
    }));
    say(`${out}  ${written} 帧  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    return {
      code: 0,
      data: {
        out, frames: written, shards, seconds: Math.round((Date.now() - t0) / 1000),
        msPerFrame: +(((Date.now() - t0) / written) || 0).toFixed(1),
      },
    };
  }
  const sh = await renderSharded(ctx, {from, to, shards, out, crf, say, resume});
  written = sh.frames;
  return {
    code: 0,
    data: {
      out, frames: written, shards, seconds: Math.round((Date.now() - t0) / 1000),
      msPerFrame: +(((Date.now() - t0) / written) || 0).toFixed(1),
      parts: sh.parts,      // [{i, from, to, seconds, reused}]
      reused: sh.reused,
    },
  };
}

/** 画面与配音合流。 */
export async function mux(ctx) {
  const say = makeSay(ctx.args);
  assertTool(ffmpegPath(), '合流要 ffmpeg');
  requireTimeline(ctx.proj);
  const slug = ctx.proj.raw.slug ?? 'film';
  const audio = ctx.proj.paths.audio(slug);
  if (!existsSync(audio)) {
    const e = new Error('filmwright: 找不到配音 ' + audio);
    e.code = 'NO_AUDIO';
    e.hint = '先跑 filmwright tts';
    throw e;
  }
  const video = resolve(str(ctx.args, 'video'));
  const out = resolve(str(ctx.args, 'out', join(ctx.projectDir, 'renders', `${slug}.mp4`)));
  const r = await muxVideo(video, audio, out, ctx.proj.timeline.total_frames / (ctx.proj.raw.fps ?? 30));
  say(`${r.out}  ${r.sizeMB} MB  ${r.durationSec.toFixed(2)}s`);
  return {code: 0, data: {out: r.out, sizeMB: r.sizeMB, seconds: r.durationSec}};
}

/** 一条龙：自检 → 渲染 → 合流。 */
export async function all(ctx) {
  const say = makeSay(ctx.args);
  const c = await check(ctx);
  if (c.code !== 0) {
    if (isJson(ctx.args)) {
      return {code: 1, data: {stage: 'check', ...c.data}, errors: c.errors, warnings: c.warnings};
    }
    throw new Error('filmwright: 自检没过，先修再渲');
  }
  const r = await render(ctx);
  const slug = ctx.proj.raw.slug ?? 'film';
  const audio = ctx.proj.paths.audio(slug);
  const video = resolve(str(ctx.args, 'out', join(ctx.proj.paths.workDir, `${slug}.mp4`)));
  if (!existsSync(audio)) {
    say('（没有配音，跳过合流：' + audio + '）');
    say('  无声成片在 ' + video);
    return {code: 0, data: {video, muted: true}, warnings: ['没有配音，跳过合流'], checks: c.data.checks};
  }
  const finalOut = resolve(str(ctx.args, 'final', join(ctx.proj.paths.rendersDir, `${slug}.mp4`)));
  const m = await mux({
    ...ctx,
    args: {...ctx.args, video, out: finalOut},
  });
  return {code: 0, data: {video, final: m.data.out, checks: c.data.checks}};
}

/** 分片并行：每片一个独立浏览器实例，各渲一段，最后 concat 无损拼接。 */
async function renderSharded(ctx, {from, to, shards, out, crf, say, resume = false}) {
  const tmp = join(ctx.proj.paths.workDir, 'parts');
  if (!resume) rmSync(tmp, {recursive: true, force: true});
  mkdirSync(tmp, {recursive: true});

  const total = to - from + 1;
  const per = Math.ceil(total / shards);
  const bounds = [];
  for (let i = 0; i < shards; i++) {
    const a = from + i * per;
    const b = Math.min(to, from + (i + 1) * per - 1);
    if (a <= b) bounds.push([a, b]);
  }
  say(`${total} 帧 -> ${bounds.length} 片，每片约 ${per} 帧${resume ? '（续跑：已有分片直接复用）' : ''}`);

  const t0 = Date.now();
  let reused = 0;
  const results = await Promise.all(bounds.map(async ([a, b], i) => {
    const part = join(tmp, `part_${String(i).padStart(2, '0')}.mp4`);
    // 续跑：分片文件在、且非空，就当它已完成（**不做内容校验** ——
    // 时间轴改过之后旧分片就不再对应，那种情况别加 --resume）
    if (resume && existsSync(part) && statSync(part).size > 0) {
      reused++;
      return {i, a, b, part, ok: true, reused: true, seconds: 0};
    }
    const p0 = Date.now();
    try {
      await renderRange(ctx.projectDir, ctx.proj, {from: a, to: b, out: part, crf, opts: ctx.opts});
      return {i, a, b, part, ok: true, reused: false, seconds: Math.round((Date.now() - p0) / 1000)};
    } catch (e) {
      return {i, a, b, part, ok: false, err: e.message, seconds: Math.round((Date.now() - p0) / 1000)};
    }
  }));

  let failed = 0;
  for (const r of results) {
    say(`  片 ${r.i} 帧 ${r.a}-${r.b}: ${r.ok ? (r.reused ? '复用' : `ok ${r.seconds}s`) : '失败'}`);
    if (!r.ok) { failed++; console.error('    ' + r.err); }
  }
  if (failed) {
    const e = new Error(`filmwright: ${failed} 个分片失败`);
    e.hint = '修好后用 --resume 续跑：已完成的分片会直接复用，不从头渲';
    throw e;
  }

  const listFile = join(tmp, 'list.txt');
  // concat demuxer 的官方建议是**相对 list.txt 的路径**（配 -safe 0）。
  // 绝对路径在 Windows 上也能work（本机探针验过），但相对写法不依赖盘符语义，
  // 更稳；分片与 list.txt 同目录，用 basename 即可。
  writeFileSync(listFile, results.map((r) => `file '${basename(r.part).replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
  mkdirSync(dirname(out), {recursive: true});
  const ff = spawnTool(ffmpegPath(), ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', out],
    {stdio: ['ignore', 'ignore', 'inherit']});
  const code = await new Promise((res) => ff.on('close', res));
  checkSpawned(ff, '分片无损拼接');
  if (code !== 0) throw new Error('filmwright: 拼接失败');
  say(`${out}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  return {
    frames: total,
    reused,
    parts: results.map((r) => ({i: r.i, from: r.a, to: r.b, seconds: r.seconds, reused: !!r.reused})),
  };
}
