// filmwright 的 MCP 服务器：把整条工具链暴露给 agent。
//
// 设计上的三条纪律：
//   1. 工具直接调用命令层的 {code, data, errors, warnings}（json 模式，不打印）——
//      与 `--json` 同一份形状，agent 学一次到处通用；
//   2. stdout 只属于 JSON-RPC：任何人类可读的日志走 stderr；
//   3. 失败不是异常：isError + 结构化 errors（code/where/hint），
//      模型读完能直接改。报错是给模型读的 prompt。
import {resolve, join} from 'node:path';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
import {readFileSync} from 'node:fs';
import * as commands from '../cli/commands.mjs';
import {loadProject} from '../project/load.mjs';
import {renderStills} from '../media/renderRange.mjs';

const json = (v) => JSON.stringify(v, null, 2);
const result = (payload) => ({content: [{type: 'text', text: json(payload)}]});
const fail = (payload) => ({...result(payload), isError: true});

// 回图的量：默认 4 张、上限 8 张。再多会把一次工具调用的载荷撑爆，
// 而模型看 4 张足够判断构图 —— 其余给路径，让它按需再看。
const DEFAULT_IMAGES = 4;
const MAX_IMAGES = 8;
const imageCap = (n) => Math.min(Math.max(1, Number(n) || DEFAULT_IMAGES), MAX_IMAGES);

/** 文本 JSON + PNG 内联（MCP image content）。超出时把说明并回 payload.note。 */
function withImages(payload, files, want) {
  const cap = imageCap(want);
  const taken = files.slice(0, cap);
  const content = [{type: 'text', text: json(files.length > taken.length
    ? {...payload, note: `图片内联了前 ${taken.length}/${files.length} 张（max_images 可调，上限 ${MAX_IMAGES}）；全部路径在 data.files`}
    : payload)}];
  for (const f of taken) {
    content.push({type: 'image', data: readFileSync(f).toString('base64'), mimeType: 'image/png'});
  }
  return {content, isError: payload.ok === false};
}

/** 跑一个既有命令（json 模式），把 {code,data,errors,warnings} 原样带回。 */
async function run(name, project, extraArgs = {}, opts = {}) {
  const dir = resolve(project);
  try {
    const proj = await loadProject(dir);
    const r = await commands[name]({projectDir: dir, proj, args: {json: true, ...extraArgs}, opts});
    const out = typeof r === 'number' ? {code: r} : (r ?? {code: 0});
    const code = out.code ?? 0;
    const payload = {ok: code === 0, command: name, errors: out.errors ?? [], warnings: out.warnings ?? [], data: out.data ?? {}};
    return code === 0 ? result(payload) : fail(payload);
  } catch (e) {
    return fail({ok: false, command: name, errors: [{code: e.code ?? 'ERROR', message: e.message, ...(e.hint ? {hint: e.hint} : {})}]});
  }
}

export function buildServer() {
  const server = new McpServer({name: 'filmwright', version: '0.1.0'});
  const projectArg = z.string().describe('项目目录（含 film.config.mjs）');

  server.registerTool('filmwright_new', {
    title: '新建项目骨架',
    description: '建一个能直接跑通的最小项目（手写镜头模板）。目录非空会拒绝，从不覆盖已有文件。',
    inputSchema: {dir: z.string().describe('目标目录'), template: z.enum(['shots']).optional()},
  }, async ({dir, template}) => {
    try {
      const r = await commands.newProject({dir: resolve(dir), args: {json: true, ...(template ? {template} : {})}});
      return result({ok: true, command: 'new', data: r.data});
    } catch (e) {
      return fail({ok: false, command: 'new', errors: [{code: e.code ?? 'ERROR', message: e.message, ...(e.hint ? {hint: e.hint} : {})}]});
    }
  });

  server.registerTool('filmwright_timeline', {
    title: '读时间轴',
    description: '返回 timeline.json 的句 id、起止帧与字幕块数 —— 写镜头之前先看这个。',
    inputSchema: {project: projectArg},
  }, async ({project}) => {
    try {
      const proj = await loadProject(resolve(project));
      if (!proj.timeline) {
        return fail({ok: false, command: 'timeline', errors: [{code: 'NO_TIMELINE', message: '还没有 timeline.json', hint: '先跑 filmwright_tts'}]});
      }
      const tl = proj.timeline;
      const blocksOf = (s) => (tl.subs ?? []).filter((b) => b.from >= s.from && b.to <= s.to).length;
      return result({
        ok: true, command: 'timeline',
        data: {
          fps: tl.fps, total_frames: tl.total_frames,
          chapters: tl.chapters ?? [],
          sentences: (tl.sentences ?? []).map((s) => ({id: s.id, chapter: s.chapter, from: s.from, to: s.to, blocks: blocksOf(s), text: s.text})),
        },
      });
    } catch (e) {
      return fail({ok: false, command: 'timeline', errors: [{code: e.code ?? 'ERROR', message: e.message}]});
    }
  });

  server.registerTool('filmwright_tts', {
    title: '解说词 → 配音 + 时间轴',
    description: '读 script/narration.txt 生成 audio.wav 与 timeline.json（逐句缓存，改一句只重合成一句）。需要 Python 3 + edge-tts。',
    inputSchema: {project: projectArg},
  }, async ({project}) => run('tts', project));

  server.registerTool('filmwright_check', {
    title: '九道自检',
    description: 'static_only=true 时七道不启浏览器（秒级）；完整自检含逐帧绘制与画质。errors 带 code/where。',
    inputSchema: {project: projectArg, static_only: z.boolean().optional()},
  }, async ({project, static_only}) =>
    run('check', project, static_only ? {'static-only': true} : {}));

  server.registerTool('filmwright_stills', {
    title: '出静帧（带回图片）',
    description: '渲指定帧为 PNG，并把图片本身作为 MCP image content 返回 —— 多模态模型直接看自己做的画面。默认内联 4 张（max_images 可到 8），其余给路径。',
    inputSchema: {
      project: projectArg,
      frames: z.array(z.number().int().min(1)).min(1).describe('帧号数组'),
      dir: z.string().describe('输出目录（建议项目 .work/ 下）'),
      max_images: z.number().int().min(1).optional().describe('内联图片张数，默认 4，上限 8'),
    },
  }, async ({project, frames, dir, max_images}) => {
    const r = await run('stills', project, {frames: frames.join(','), dir});
    const payload = JSON.parse(r.content[0].text);
    if (!payload.ok) return r;
    return withImages(payload, payload.data.files ?? [], max_images);
  });

  /**
   * 一轮完整的「改 → 验 → 看」：静态自检 + 回图。
   * agent 每改一轮镜头调一次，不用自己拼两步、也不用猜该看哪一帧。
   */
  server.registerTool('filmwright_review', {
    title: '一轮自检 + 目视（推荐回路）',
    description: '一次调用完成：静态自检 → 回图（全片均匀采样 4 张代表帧并内联）。改完 shots/index.js 就调它。',
    inputSchema: {
      project: projectArg,
      max_images: z.number().int().min(1).optional().describe('内联图片张数，默认 4，上限 8'),
    },
  }, async ({project, max_images}) => {
    try {
      const dir = resolve(project);
      const proj = await loadProject(dir);
      const errors = [];
      const warnings = [];
      // 1) 静态自检（不启浏览器那七道）
      const c = await commands.check({projectDir: dir, proj, args: {json: true, 'static-only': true}, opts: {}});
      for (const e of c.errors ?? []) errors.push({...e, stage: 'check'});
      warnings.push(...(c.warnings ?? []));
      if ((c.code ?? 0) !== 0) {
        return fail({ok: false, command: 'review', errors, warnings, data: {stage: 'check', note: '静态自检没过，这一步没渲染'}});
      }
      // 2) 代表帧：**全片均匀采样**。
      //
      // 为什么不是「按镜头取末拍落位之后」：镜头是手写代码，host 侧不求值
      // `shots/index.js` 就不知道每个镜头的区间与节拍。所以这里一律均匀采样 ——
      // 这一步是「渲染前先看几张图」，要精确看某个镜头就用 filmwright_stills
      // 自己给 frames（那才是按镜头取帧的入口）。
      const total = proj.timeline?.total_frames ?? 0;
      const n = 4;
      const marks = Array.from({length: n}, (_, i) =>
        ({label: `sample${i + 1}`, frame: Math.max(1, Math.round(total * (i + 0.6) / n))}));
      warnings.push('代表帧是全片均匀采样 4 张；要精确看某个镜头，用 filmwright_stills 自己给帧号');
      const picked = marks.slice(0, imageCap(max_images));
      const outDir = join(dir, '.work', 'review');
      const files = await renderStills(dir, proj, picked.map((m) => m.frame), outDir, {});
      const payload = {
        ok: errors.length === 0, command: 'review', errors, warnings,
        data: {
          shots: marks.length,
          frames: picked.map((m, i) => ({label: m.label, frame: m.frame, file: files[i]})),
          note: '图片按 frames 顺序内联在下面的 image content 里',
        },
      };
      return withImages(payload, files, max_images);
    } catch (e) {
      return fail({ok: false, command: 'review', errors: [{code: e.code ?? 'ERROR', message: e.message, ...(e.hint ? {hint: e.hint} : {})}]});
    }
  });

  server.registerTool('filmwright_srt', {
    title: '导出字幕（SRT）',
    description: '从 timeline.json 的 subs 导出 SRT。字幕已烧进画面，这份是给 B 站/YouTube 投稿用的外挂字幕；译文由框架外产出后合成双语轨。',
    inputSchema: {project: projectArg, out: z.string().optional().describe('输出路径（默认 script/<slug>.srt）')},
  }, async ({project, out}) => run('srt', project, out ? {out} : {}));

  server.registerTool('filmwright_render', {
    title: '渲染（无声视频）',
    description: '逐帧渲染成 mp4；shards 分片并行。返回产物路径、帧数与耗时。',
    inputSchema: {project: projectArg, shards: z.number().int().min(1).optional(), from: z.number().int().min(1).optional(), to: z.number().int().min(1).optional()},
  }, async ({project, shards, from, to}) => {
    const a = {};
    if (shards !== undefined) a.shards = String(shards);
    if (from !== undefined) a.from = String(from);
    if (to !== undefined) a.to = String(to);
    return run('render', project, a);
  });

  server.registerTool('filmwright_all', {
    title: '一条龙：check → render → mux',
    description: '自检不过直接停（errors 带回可行动的错）；没有配音时 ok=true 且 data.muted=true。',
    inputSchema: {project: projectArg, shards: z.number().int().min(1).optional()},
  }, async ({project, shards}) =>
    run('all', project, shards !== undefined ? {shards: String(shards)} : {}));

  return server;
}

/** 起 stdio 服务器，一直跑到客户端断开。日志走 stderr（stdout 属于 JSON-RPC）。 */
export async function startMcp() {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
  console.error('filmwright MCP 服务器就绪（stdio）。Ctrl+C 结束。');
  return new Promise((res) => {
    process.on('SIGINT', () => res(0));
    process.on('SIGTERM', () => res(0));
    // 客户端关掉管道就算结束
    process.stdin.on('end', () => res(0));
    process.stdin.on('close', () => res(0));
  });
}
