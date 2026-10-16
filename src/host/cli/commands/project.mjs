// 项目级命令：自检 / 预览 / MCP / 字幕 / 片段 / 新建项目。
import {dirname, join, resolve, basename} from 'node:path';
import {requireTimeline} from '../../project/load.mjs';
import {spawnTool, ffmpegPath, checkSpawned} from '../../media/ffmpegBin.mjs';
import {runChecks} from '../../checks/index.mjs';
import {THRESHOLDS as QUALITY_THRESHOLDS} from '../../checks/browser/quality.mjs';
import {preview as previewCmd} from '../preview.mjs';
import {scaffoldProject} from '../../project/scaffold.mjs';
import {exportSrt, readTranslation} from '../../media/srt.mjs';
import {prepareClips} from '../../media/clips.mjs';
import {normalizeConfig} from '../../../contract/config.js';
import {KIT_ROOT, RUNTIME_ROOT} from '../../root.mjs';
import {num, str} from '../args.mjs';
import {assertTool} from '../../preflight.mjs';
import {makeSay, isJson} from '../output.mjs';

const API_FILE = join(RUNTIME_ROOT, 'index.js');

/** 自检。 */
export async function check(ctx) {
  const json = isJson(ctx.args);
  requireTimeline(ctx.proj);   // 没有时间轴就给出「先跑 tts」，而不是深处读 null 崩掉
  // --static-only：只跑读文件的那几道（api / imports / timeline / assets / clips / themeKeys），
  // 不启浏览器。用途：CI 上不想装浏览器时、以及改完镜头想秒级验证引用关系时。
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
    // 有结构化错误的道直接带 code/where/hint；其余把文本问题包一层
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
    ({startMcp} = await import('../../mcp/server.mjs'));
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
  const r = scaffoldProject(ctx.dir, {template: String(ctx.args.template ?? 'shots')});
  say(`已建 ${r.template} 模板项目：${r.dir}`);
  for (const f of r.files) say('  ' + f);
  const steps = [
    `把 ${r.dir}/script/narration.txt 改成你的解说词`,
    `写 ${r.dir}/shots/index.js 配画面（SHOTS 数组就是全部镜头）`,
    'filmwright tts    --project ' + r.dir,
    'filmwright check  --project ' + r.dir + ' --static-only',
    'filmwright all    --project ' + r.dir,
  ];
  say('下一步：');
  for (const s of steps) say('  ' + s);
  return {code: 0, data: {...r, nextSteps: steps}};
}
