// 渲染管线：单段 / 分片 / 增量复用 / 封装 / 一键 all。
import {existsSync, mkdirSync, rmSync, writeFileSync, statSync, readFileSync} from 'node:fs';
import {dirname, join, resolve, basename} from 'node:path';
import {requireTimeline} from '../project/load.mjs';
import {renderRange, renderStills, renderSequence} from '../media/renderRange.mjs';
import {muxVideo} from '../media/mux.mjs';
import {muxWithMusic} from '../media/mix.mjs';
import {spawnTool, ffmpegPath, checkSpawned} from '../media/ffmpegBin.mjs';
// ⚠️ 这一行是**跨行** import：拆 `commands.mjs` 时「按行过滤 import」把它整条丢了，
// 于是 `--incremental` 一跑到 `segmentDir(workDir)` 就 `segmentDir is not defined`。
// 现在由 `checkNames`（checks/static）钉住 —— 见那里的说明。
import {
  segmentDir, segmentKey, planSegments, findCached, recordSegment, pruneSegments,
  engineFingerprint, globalFingerprint,
  manualShotsFingerprint, combineGlobal,
} from '../media/incremental.mjs';
import {normalizeConfig} from '../../contract/config.js';
import {KIT_ROOT, RUNTIME_ROOT} from '../root.mjs';
import {num, str} from './args.mjs';
import {assertTool} from '../preflight.mjs';
import {makeSay, isJson} from './output.mjs';
import {check} from './commands/project.mjs';
import {resolveShards, frameFormatOf, transportOf, presetOf} from './sharding.mjs';


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
        // 归因粒度：镜头是手写代码，主机侧无法按帧归因，只能整文件
        attribution: 'whole-file',
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
  const frameFormat = frameFormatOf(ctx);
  const preset = presetOf(ctx);
  const transport = transportOf(ctx);
  if (!proxy || proxy === 1) {
    return renderRange(ctx.projectDir, ctx.proj, {
      from, to, out, crf, opts: ctx.opts, frameFormat, preset, transport,
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
    from, to, out, crf, opts: ctx.opts, frameFormat, preset, transport,
    onProgress: (w, t) => { if (w % 100 === 0 || w === t) say(`  ${w}/${t}`); },
  });
}

/**
 * 增量重渲：切成段 → 按内容哈希复用 → 只渲变化了的段 → 拼接。
 *
 * 安全性的根据：引擎是确定性的（第 N 帧只依赖 N），所以「输入指纹 + 段区间」
 * 相同就一定能复用。
 *
 * ## 指纹只有一层：全局
 *
 * 配置、时间轴、字体与素材文件、clips 声明、引擎源码 —— 影响每一段，都进全局指纹。
 * 镜头也只有一种写法：手写的 `shots/index.js`。它的 `start` 是代码算出来的
 * （可能调 `cutBefore()` 这类查询），主机侧无法在不求值该模块的情况下按帧归因，
 * 所以**整个镜头文件算全局**（`manualShotsFingerprint`）：改一行就让所有段失效。
 * 保守但正确 —— 宁可多渲，不可复用旧画面。
 */
async function renderIncremental(ctx, {from, to, out, crf, say, segFrames, width, height, fps, proxy, shards}) {
  const workDir = ctx.proj.paths.workDir;
  const dir = segmentDir(workDir);
  mkdirSync(dir, {recursive: true});

  const engine = engineFingerprint(RUNTIME_ROOT);
  const global = globalFingerprint(ctx.proj, ctx.projectDir);
  // 手写镜头项目：整个镜头文件算全局（无法按帧归因）—— 见 incremental.mjs 与上面的说明。
  const globalWithShots = combineGlobal(global, manualShotsFingerprint(ctx.proj.paths.shots));

  const outW = proxy ? Math.max(2, Math.round(width * proxy)) : width;
  const outH = proxy ? Math.max(2, Math.round(height * proxy)) : height;

  const segs = planSegments(to - from + 1, segFrames, from, to);
  const liveKeys = new Set();
  // 镜头归因哈希：主机侧无法按段归因，所有段共用同一个空指纹
  // （`'none'` 是原先「没有任何逐段镜头依赖」时的取值；沿用它可以避免让既有段缓存
  // 无谓地整批失效 —— 镜头文件本身的指纹已经在 globalWithShots 里了）。
  const shotsHash = 'none';
  const jobs = segs.map((s) => {
    const key = segmentKey({
      engine, global: globalWithShots, shotsHash,
      from: s.from, to: s.to, width: outW, height: outH, fps, crf,
    });
    liveKeys.add(key);
    const hit = findCached(dir, s.index, key);
    return {...s, key, hit};
  });

  const reused = jobs.filter((j) => j.hit).length;
  const todo = jobs.filter((j) => !j.hit);
  say(`增量：${segs.length} 段（每段 ${segFrames} 帧），复用 ${reused}，需渲 ${todo.length}` +
    (proxy ? `（代理 ${outW}×${outH}）` : '') +
    '（手写镜头：镜头文件变化会让所有段失效）');

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
    say(`  段 ${j.index}（${j.from}-${j.to}）渲染完成 ${((Date.now() - p0) / 1000).toFixed(0)}s`);
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
  const slug = ctx.proj.raw.slug ?? 'film';
  const audio = ctx.proj.paths.audio(slug);
  const hasAudio = existsSync(audio);
  const finalOut = resolve(str(ctx.args, 'final', join(ctx.proj.paths.rendersDir, `${slug}.mp4`)));
  // ⚠️ **没有配音时也要落到 `renders/<slug>.mp4`**（README 承诺的就是这个位置）。
  // 原来无论有没有配音都把成片渲到 `.work/`，只有"有配音"那条路才会 mux 到 `renders/` ——
  // 于是**全新 clone 照 README 跑 `all`，成片不在文档说的位置**（CI 的 verify-readme 抓到）。
  // 有配音时 `.work/` 才是对的：那是交给 mux 的**中间产物**。
  const video = resolve(str(ctx.args, 'out',
    hasAudio ? join(ctx.proj.paths.workDir, `${slug}.mp4`) : finalOut));
  const r = await render({...ctx, args: {...ctx.args, out: video}});
  if (!hasAudio) {
    say('（没有配音，跳过合流：' + audio + '）');
    say('  无声成片在 ' + video);
    return {code: 0, data: {video, muted: true}, warnings: ['没有配音，跳过合流'], checks: c.data.checks};
  }
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

