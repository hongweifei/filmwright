// 各命令的实现。每个都只做一件事，由 cli/index.mjs 按名字找到并调用。
//
// 约定：命令收到 (ctx) —— {projectDir, proj, args, opts}，返回
//   {code, data, warnings, errors}（退出码 0 成功）。
// data/warnings/errors 只在 --json 时打印（见 cli/output.mjs）；
// 人模式的进度一律走 say()，json 模式自动静默。
import {existsSync, mkdirSync, rmSync, writeFileSync, statSync, readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import os from 'node:os';
import {dirname, join, resolve, basename} from 'node:path';
import {requireTimeline} from '../project/load.mjs';
import {renderRange, renderStills, renderSequence} from '../media/renderRange.mjs';
import {muxVideo} from '../media/mux.mjs';
import {muxWithMusic} from '../media/mix.mjs';
import {spawnTool, ffmpegPath, checkSpawned} from '../media/ffmpegBin.mjs';
import {runChecks} from '../checks/index.mjs';
import {THRESHOLDS as QUALITY_THRESHOLDS} from '../checks/runtime/quality.mjs';
import {preview as previewCmd} from './preview.mjs';
import {scaffoldProject} from '../project/scaffold.mjs';
import {exportSrt, readTranslation} from '../media/srt.mjs';
import {prepareClips} from '../media/clips.mjs';
import {
  segmentDir, segmentKey, planSegments, findCached, recordSegment, pruneSegments,
  engineFingerprint, globalFingerprint, collectShotDeps, mergeDeps,
  manualShotsFingerprint, combineGlobal,
} from '../media/incremental.mjs';
import {sceneSchema, resolveAt} from '../../contract/scene.js';
import {normalizeConfig} from '../../contract/config.js';
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

/**
 * 片段素材抽帧（`filmwright clips`）。
 *
 * 抽帧是 host 的 I/O：慢、有磁盘代价，所以**独立成命令**，也可以在渲染前自动跑。
 * 内容寻址缓存：源文件或参数没变就直接复用，不重抽。
 */
export async function clips(ctx) {
  const say = makeSay(ctx.args);
  const list = normalizeConfig(ctx.proj.raw).clips ?? [];
  if (list.length === 0) {
    say('配置里没有声明 clips（片段素材）—— 什么也不用做');
    return {code: 0, data: {clips: {}, extracted: 0, cached: 0, totalFrames: 0}};
  }
  assertTool(ffmpegPath(), '片段抽帧要 ffmpeg');
  const cacheRoot = ctx.args['cache-dir']
    ? resolve(String(ctx.args['cache-dir']))
    : join(ctx.proj.paths.workDir, 'clips');
  const t0 = Date.now();
  const r = await prepareClips(ctx.projectDir, list, {cacheRoot});
  for (const [name, c] of Object.entries(r.clips)) {
    say(`  ${name}: ${c.frames} 帧 @${c.fps}fps${c.cached ? '（缓存命中）' : '（新抽）'}`);
  }
  say(`共 ${Object.keys(r.clips).length} 个片段，新抽 ${r.extracted} / 命中 ${r.cached}，` +
    `${r.totalFrames} 帧，${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return {
    code: 0,
    data: {
      clips: r.clips, extracted: r.extracted, cached: r.cached,
      totalFrames: r.totalFrames, cacheRoot: r.cacheRoot,
      seconds: +((Date.now() - t0) / 1000).toFixed(1),
    },
  };
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

/**
 * 列出可用音色，并**实测各引擎是否可用**（`filmwright voices`）。
 *
 * 为什么需要这条命令：TTS 是联网服务，会整段不可用（实测 edge 合成 403
 * 而 list_voices 正常）。做片子前先跑一下，就能知道该用哪个引擎、
 * 有哪些音色可选 —— 而不是合成到一半才发现引擎挂了。
 */
export async function voices(ctx) {
  const say = makeSay(ctx.args);
  const script = join(RUNTIME_ROOT, 'host', 'tts', 'list_voices.py');
  const r = spawnSync('python', [script, '--project', ctx.projectDir, ...(isJson(ctx.args) ? ['--json'] : [])], {
    encoding: 'utf8',
    env: {...process.env, PYTHONIOENCODING: 'utf-8'},
  });
  if (r.error) {
    const e = new Error('filmwright: 起不了 python —— ' + r.error.message);
    e.code = 'NO_PYTHON';
    e.hint = '装 Python 3 并让 python 在 PATH 里';
    throw e;
  }
  const out = String(r.stdout || '');
  const errOut = String(r.stderr || '').trim();
  if (isJson(ctx.args)) {
    // --json：把子进程的 JSON 原样透出（保持「stdout 恰好一个 JSON」的契约）
    const line = out.trim().split('\n').filter((l) => l.trim().startsWith('{')).pop();
    if (!line) {
      const e = new Error('filmwright: voices 没有产出 JSON' + (errOut ? '：\n' + errOut : ''));
      e.code = 'VOICES_FAILED';
      throw e;
    }
    return {code: 0, data: JSON.parse(line)};
  }
  if (r.status !== 0) {
    const e = new Error(errOut || out.trim() || 'filmwright: voices 失败');
    e.code = 'VOICES_FAILED';
    throw e;
  }
  say(out.trimEnd());
  return {code: 0, data: {}};
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

/**
 * 分片数解析：数字，或 auto。
 *
 * ## auto 为什么不能只看 CPU 核数
 *
 * 每个分片是**一个独立浏览器实例**，实测各占数百 MB。只看核数的话，
 * 16 核的机器会一次开 15 个实例 —— 内存不够就换页，结果**比分片前更慢**。
 * 实测（16 核 / 剩 5GB 的笔记本）：单片 96s、2 片 181s、4 片 133s。
 * 所以这里同时受三个上限约束，取最小值：
 *   - CPU 核数（留一核给主进程）
 *   - 可用内存（每片预留 PER_SHARD_MB，并给系统留 SYSTEM_MB）
 *   - 帧数（每片至少 ~60 帧，否则启动开销盖过收益）
 *
 * 导出为纯函数（接受 {cores, freeBytes}）以便单测 —— 判据不能只在真机上验。
 */
export const PER_SHARD_MB = 500;    // 一个浏览器实例的经验预留量
export const SYSTEM_MB = 1500;      // 留给系统 + node 主进程的量

export function resolveShards(raw, total, {cores, freeBytes} = {}) {
  const nCores = cores ?? Math.max(1, (os.cpus?.() ?? []).length);
  const free = freeBytes ?? os.freemem?.() ?? 0;
  const byCpu = Math.max(1, nCores - 1);
  const byMem = Math.max(1, Math.floor((free / 1048576 - SYSTEM_MB) / PER_SHARD_MB));
  const byFrames = Math.max(1, Math.ceil(total / 60));
  const cap = Math.max(1, Math.min(byCpu, byMem, byFrames));

  if (raw === undefined || raw === null || raw === '') return 1;   // 默认不分片
  if (raw === 'auto') return cap;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    const e = new Error(`filmwright: --shards 要是正整数或 auto，收到 ${raw}`);
    e.code = 'BAD_SHARDS';
    e.hint = 'auto = 按 CPU 核数与可用内存自动定（每片至少约 60 帧）';
    throw e;
  }
  const want = Math.floor(n);
  // 显式指定的片数**照办**（用户可能知道自己在做什么），但如果明显超出内存，
  // 在 stderr 上提醒一句 —— 静默变慢比报错更难查。
  if (want > byMem) {
    process.stderr.write(`filmwright: 注意：--shards ${want} 超出可用内存能支撑的量` +
      `（约 ${byMem} 片；每片约需 ${PER_SHARD_MB}MB，当前可用 ${(free / 1048576).toFixed(0)}MB）` +
      '—— 可能因换页而更慢。用 --shards auto 或减小片数。\n');
  }
  return want;
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
  // --incremental：按内容哈希**跨次**复用已渲的段（改一两个镜头时不用重渲整片）
  const incremental = ctx.args.incremental === true || ctx.args.incremental === 'true';
  // --proxy [scale]：代理渲染——半（或更低）分辨率快速预览。默认 0.5
  const proxyArg = ctx.args.proxy;
  const proxy = proxyArg === undefined ? null : (proxyArg === true ? 0.5 : Number(proxyArg));
  if (proxy !== null && (!Number.isFinite(proxy) || proxy <= 0 || proxy > 1)) {
    const e = new Error(`filmwright: --proxy 要是 0–1 之间的比例，收到 ${proxyArg}`);
    e.code = 'BAD_PROXY';
    e.hint = '例：--proxy 0.5 出一半分辨率的预览';
    throw e;
  }

  const t0 = Date.now();
  const size = ctx.proj.raw.size ?? {width: 1280, height: 720};
  const fps = ctx.proj.raw.fps ?? 30;
  const opt = {
    from, to, out, crf, opts: ctx.opts,
    onProgress: (w, t) => { if (w % 100 === 0 || w === t) say(`  ${w}/${t}`); },
  };

  if (incremental) {
    const segFrames = ctx.args['seg-frames'] ? num(ctx.args, 'seg-frames') : 300;
    const r = await renderIncremental(ctx, {
      from, to, out, crf, say, segFrames,
      width: size.width, height: size.height, fps,
      proxy, shards,
    });
    return {
      code: 0,
      data: {
        out, frames: to - from + 1, seconds: Math.round((Date.now() - t0) / 1000),
        incremental: true, segments: r.segments,
        reusedSegments: r.reused, renderedSegments: r.rendered,
        proxy: proxy ?? null,
        // 归因粒度：scene 项目能按镜头归因，手写镜头项目只能整文件
        attribution: ctx.proj.scene ? 'per-shot' : 'whole-file',
      },
    };
  }

  if (shards <= 1) {
    const r = await renderOneRange(ctx, {out, crf, say, from, to, proxy});
    say(`${out}  ${r.written} 帧  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    return {
      code: 0,
      data: {
        out, frames: r.written, shards, seconds: Math.round((Date.now() - t0) / 1000),
        msPerFrame: +(((Date.now() - t0) / r.written) || 0).toFixed(1),
        proxy: proxy ?? null,
      },
    };
  }
  const sh = await renderSharded(ctx, {from, to, shards, out, crf, say, resume});
  return {
    code: 0,
    data: {
      out, frames: sh.frames, shards, seconds: Math.round((Date.now() - t0) / 1000),
      msPerFrame: +(((Date.now() - t0) / sh.frames) || 0).toFixed(1),
      parts: sh.parts,      // [{i, from, to, seconds, reused, attempts}]
      reused: sh.reused,
      retried: sh.retried,  // 有分片首次失败、重试后成功的个数
    },
  };
}

/**
 * 单段渲染（可选代理分辨率）。
 *
 * 代理渲染只是把输出尺寸按比例缩小 —— **不改绘制逻辑**，所以画面构图与成片
 * 一致（都是同一套设计坐标缩放），只是像素少。用途是快速看节奏与版式。
 */
async function renderOneRange(ctx, {out, crf, say, from, to, proxy}) {
  if (!proxy || proxy === 1) {
    return renderRange(ctx.projectDir, ctx.proj, {
      from, to, out, crf, opts: ctx.opts,
      onProgress: (w, t) => { if (w % 100 === 0 || w === t) say(`  ${w}/${t}`); },
    });
  }
  const size = ctx.proj.raw.size ?? {width: 1280, height: 720};
  const small = {
    ...ctx.proj.raw,
    size: {width: Math.max(2, Math.round(size.width * proxy)), height: Math.max(2, Math.round(size.height * proxy))},
  };
  const smallProj = {...ctx.proj, raw: small};
  return renderRange(ctx.projectDir, smallProj, {
    from, to, out, crf, opts: ctx.opts,
    onProgress: (w, t) => { if (w % 100 === 0 || w === t) say(`  ${w}/${t}`); },
  });
}

/**
 * 增量重渲：切成段 → 按内容哈希复用 → 只渲变化了的段 → 拼接。
 *
 * 安全性的根据：引擎是确定性的（第 N 帧只依赖 N），所以「输入指纹 + 段区间」
 * 相同就一定能复用。
 *
 * ## 指纹为什么分两层（这是「改一个镜头只重渲几段」能成立的关键）
 *
 *   - **全局**：配置、时间轴、字体与素材文件、clips 声明、引擎源码 —— 影响每一段
 *   - **局部**：与该段区间重叠的 scene 镜头（以及它引用的 comps）
 *
 * 如果只用一份全局指纹（把整份 scene.json 也算进去），改任何一个镜头都会让
 * **所有段**失效 —— 那就等于每次都全渲，增量重渲毫无意义。
 * 手写镜头项目（shots/index.js）无法按镜头归因，整个文件算全局（保守但正确）。
 */
async function renderIncremental(ctx, {from, to, out, crf, say, segFrames, width, height, fps, proxy, shards}) {
  const workDir = ctx.proj.paths.workDir;
  const dir = segmentDir(workDir);
  mkdirSync(dir, {recursive: true});

  const engine = engineFingerprint(RUNTIME_ROOT);
  const global = globalFingerprint(ctx.proj, ctx.projectDir);
  // 手写镜头项目：整个镜头文件算全局（无法按帧归因）—— 见 incremental.mjs 的注释。
  // 有 scene 时按 scene 归因（scene 与手写镜头混用的项目里，scene 覆盖的帧
  // 能精确归因，手写那部分无法 —— 这里选保守：只要有手写文件就把它算全局）。
  const globalWithShots = combineGlobal(global, manualShotsFingerprint(ctx.proj.paths.shots));

  const outW = proxy ? Math.max(2, Math.round(width * proxy)) : width;
  const outH = proxy ? Math.max(2, Math.round(height * proxy)) : height;

  const segs = planSegments(to - from + 1, segFrames, from, to);
  const liveKeys = new Set();
  // 每个段收集「与它重叠的镜头依赖」，据此算键
  const sceneForRanges = sceneWithNumericAt(ctx.proj);
  const jobs = segs.map((s) => {
    const deps = collectShotDeps(sceneForRanges, s);
    const shotsHash = mergeDeps(deps);
    const key = segmentKey({
      engine, global: globalWithShots, shotsHash,
      from: s.from, to: s.to, width: outW, height: outH, fps, crf,
    });
    liveKeys.add(key);
    const hit = findCached(dir, s.index, key);
    return {...s, key, hit, shotCount: deps.length};
  });

  const reused = jobs.filter((j) => j.hit).length;
  const todo = jobs.filter((j) => !j.hit);
  say(`增量：${segs.length} 段（每段 ${segFrames} 帧），复用 ${reused}，需渲 ${todo.length}` +
    (proxy ? `（代理 ${outW}×${outH}）` : '') +
    (ctx.proj.scene ? '' : '（手写镜头项目：镜头文件变化会让所有段失效）'));

  // 需要渲的段：逐段渲（每段内部仍可按 shards 分片）
  for (const j of todo) {
    const part = join(dir, `seg${String(j.index).padStart(4, '0')}-${j.key}.mp4`);
    const p0 = Date.now();
    await renderOneRange(ctx, {out: part, crf, say: () => {}, from: j.from, to: j.to, proxy});
    if (!existsSync(part) || statSync(part).size === 0) {
      throw new Error(`filmwright: 增量渲染的第 ${j.index} 段没产出文件`);
    }
    recordSegment(dir, j.index, j.key, {
      from: j.from, to: j.to, frames: j.to - j.from + 1, bytes: statSync(part).size,
    });
    say(`  段 ${j.index}（${j.from}-${j.to}，覆盖 ${j.shotCount} 个镜头）渲染完成 ${((Date.now() - p0) / 1000).toFixed(0)}s`);
  }

  // 拼接：按段顺序 concat
  const listFile = join(dir, 'segments.txt');
  const parts = jobs.map((j) => j.hit ? j.hit.part : join(dir, `seg${String(j.index).padStart(4, '0')}-${j.key}.mp4`));
  mkdirSync(dirname(out), {recursive: true});
  writeFileSync(listFile, parts.map((p) => `file '${basename(p).replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
  const ff = spawnTool(ffmpegPath(), ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', out],
    {stdio: ['ignore', 'ignore', 'inherit']});
  const code = await new Promise((res) => ff.on('close', res));
  checkSpawned(ff, '增量拼接');
  if (code !== 0) throw new Error('filmwright: 增量拼接失败');

  const pruned = pruneSegments(dir, liveKeys);
  if (pruned) say(`  清理旧段 ${pruned} 个文件`);

  return {segments: segs.length, reused, rendered: todo.length, pruned};
}

/**
 * 把 scene 里非数字的 `at`（句 id / 对象）解析成帧号，好让 host 侧能算镜头区间。
 *
 * 只用于**归因**（决定哪些镜头影响哪些段），不参与绘制 ——
 * 绘制时的 at 解析仍在浏览器里由同一份 `resolveAt` 完成，两者不会漂。
 * 实在解析不出来的镜头，其区间视为未知 → 保守地让**所有段**都收它的指纹。
 */
function sceneWithNumericAt(proj) {
  if (!proj.scene) return null;
  const tl = proj.timeline;
  const shots = proj.scene.shots.map((s) => {
    let at = s.at;
    if (typeof at !== 'number') {
      try {
        const n = resolveAt(at, tl);
        if (Number.isInteger(n) && n >= 1) at = n;
      } catch {
        return s;             // 解析不了：保持原样，由 collectShotDeps 走保守路径
      }
    }
    return {...s, at};
  });
  return {...proj.scene, shots};
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
    // 说清「为什么会缺」：配音是产物、不入库（时间轴入库，所以 check 与渲染
    // 在没有音频时也能跑）。clone 下来第一次合流必然遇到这条。
    e.hint = '配音是产物、不随仓库分发。跑 filmwright tts --project ' + ctx.projectDir
      + ' 生成（没有 edge-tts 时 tts.engine 设为 \'auto\' 会自动降级到离线引擎）';
    throw e;
  }
  const video = resolve(str(ctx.args, 'video'));
  const out = resolve(str(ctx.args, 'out', join(ctx.projectDir, 'renders', `${slug}.mp4`)));
  const dur = ctx.proj.timeline.total_frames / (ctx.proj.raw.fps ?? 30);

  // 配乐：配置里有 music 就混（带自动闪避），否则保持「只混人声」的老行为
  const musicCfg = ctx.proj.raw?.music ? normalizeConfig(ctx.proj.raw).music : null;
  if (musicCfg) {
    const musicFile = join(ctx.projectDir, 'public', musicCfg.src.replace(/^\//, ''));
    if (!existsSync(musicFile)) {
      const e = new Error('filmwright: 找不到配乐 ' + musicFile);
      e.code = 'NO_MUSIC_FILE';
      e.hint = `music.src 是 ${musicCfg.src}，对应项目里的 public/${musicCfg.src.replace(/^\//, '')}`;
      throw e;
    }
    const r = await muxWithMusic(video, audio, musicFile, out, musicCfg, dur);
    say(`${r.out}  ${r.sizeMB} MB  ${r.durationSec.toFixed(2)}s（配乐 gain ${musicCfg.gain}dB，闪避 ${musicCfg.duck}dB）`);
    return {
      code: 0,
      data: {
        out: r.out, sizeMB: r.sizeMB, seconds: r.durationSec,
        music: {src: musicCfg.src, gain: musicCfg.gain, duck: musicCfg.duck},
      },
    };
  }

  const r = await muxVideo(video, audio, out, dur);
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

/**
 * 分片并行：每片一个独立浏览器实例，各渲一段，最后 concat 无损拼接。
 *
 * `deps.render` / `deps.concat` 可注入（默认 renderRange / ffmpeg）——
 * 为了能**直接单测重试语义**：用「首次抛错、之后成功」的假渲染函数验证
 * 「重试救回 + 如实记录」，不必伪造 ffmpeg 可执行文件（Windows 上那条路很脏）。
 */
export async function renderSharded(ctx, {from, to, shards, out, crf, say, resume = false, deps = {}}) {
  const render = deps.render ?? renderRange;
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
  let retried = 0;
  const results = await Promise.all(bounds.map(async ([a, b], i) => {
    const part = join(tmp, `part_${String(i).padStart(2, '0')}.mp4`);
    // 续跑：分片文件在、且非空，就当它已完成（**不做内容校验** ——
    // 时间轴改过之后旧分片就不再对应，那种情况别加 --resume）
    if (resume && existsSync(part) && statSync(part).size > 0) {
      reused++;
      return {i, a, b, part, ok: true, reused: true, seconds: 0, attempts: 1};
    }
    const p0 = Date.now();
    // **分片失败自动重试一次**：长片里最常见的失败是浏览器抖动（无头实例偶发退出），
    // 不是内容问题 —— 重试一次能把「渲到 90% 全废」变成「多花一片的时间」。
    // 只重试一次且如实记录，不掩盖真错（两次都失败仍然报出来）。
    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await render(ctx.projectDir, ctx.proj, {from: a, to: b, out: part, crf, opts: ctx.opts});
        return {i, a, b, part, ok: true, reused: false, seconds: Math.round((Date.now() - p0) / 1000), attempts: attempt};
      } catch (e) {
        lastErr = e;
        if (attempt === 1) retried++;
      }
    }
    return {i, a, b, part, ok: false, err: lastErr?.message, seconds: Math.round((Date.now() - p0) / 1000), attempts: 2};
  }));

  let failed = 0;
  for (const r of results) {
    const how = r.ok ? (r.reused ? '复用' : `ok ${r.seconds}s${r.attempts > 1 ? '（重试后成功）' : ''}`) : '失败';
    say(`  片 ${r.i} 帧 ${r.a}-${r.b}: ${how}`);
    if (!r.ok) { failed++; console.error('    ' + r.err); }
  }
  if (failed) {
    const e = new Error(`filmwright: ${failed} 个分片失败（已各自重试 1 次）`);
    e.hint = '修好后用 --resume 续跑：已完成的分片会直接复用，不从头渲';
    throw e;
  }

  const listFile = join(tmp, 'list.txt');
  // concat demuxer 的官方建议是**相对 list.txt 的路径**（配 -safe 0）。
  // 绝对路径在 Windows 上也能work（本机探针验过），但相对写法不依赖盘符语义，
  // 更稳；分片与 list.txt 同目录，用 basename 即可。
  writeFileSync(listFile, results.map((r) => `file '${basename(r.part).replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
  mkdirSync(dirname(out), {recursive: true});
  if (deps.concat) {
    await deps.concat({listFile, out, parts: results.map((r) => r.part)});
  } else {
    const ff = spawnTool(ffmpegPath(), ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', out],
      {stdio: ['ignore', 'ignore', 'inherit']});
    const code = await new Promise((res) => ff.on('close', res));
    checkSpawned(ff, '分片无损拼接');
    if (code !== 0) throw new Error('filmwright: 拼接失败');
  }
  say(`${out}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  return {
    frames: total,
    reused,
    retried,
    parts: results.map((r) => ({i: r.i, from: r.a, to: r.b, seconds: r.seconds, reused: !!r.reused, attempts: r.attempts})),
  };
}
