// filmwright 的 MCP 服务器：把整条工具链暴露给 agent。
//
// 设计上的三条纪律：
//   1. 工具直接调用命令层的 {code, data, errors, warnings}（json 模式，不打印）——
//      与 `--json` 同一份形状，agent 学一次到处通用；
//   2. stdout 只属于 JSON-RPC：任何人类可读的日志走 stderr；
//   3. 失败不是异常：isError + 结构化 errors（code/where/hint），
//      模型读完能直接改。报错是给模型读的 prompt。
import {resolve} from 'node:path';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
import {readFileSync} from 'node:fs';
import * as commands from '../cli/commands.mjs';
import {loadProject} from '../project/load.mjs';
import {sceneSchema, validateScene} from '../../contract/scene.js';
import {normalizeConfig} from '../../contract/config.js';

const json = (v) => JSON.stringify(v, null, 2);
const result = (payload) => ({content: [{type: 'text', text: json(payload)}]});
const fail = (payload) => ({...result(payload), isError: true});

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
    description: '建一个能直接跑通的最小项目（scene 或 shots 模板）。目录非空会拒绝，从不覆盖已有文件。',
    inputSchema: {dir: z.string().describe('目标目录'), template: z.enum(['scene', 'shots']).optional()},
  }, async ({dir, template}) => {
    try {
      const r = await commands.newProject({dir: resolve(dir), args: {json: true, ...(template ? {template} : {})}});
      return result({ok: true, command: 'new', data: r.data});
    } catch (e) {
      return fail({ok: false, command: 'new', errors: [{code: e.code ?? 'ERROR', message: e.message, ...(e.hint ? {hint: e.hint} : {})}]});
    }
  });

  server.registerTool('filmwright_schema', {
    title: '读场景规格 schema',
    description: '机器可读的 scene.json 规格：全部类型与用途、每类字段与容量上限、at 对齐语法、错误码表。**写 scene 之前先调这个**。',
    inputSchema: {},
  }, async () => result({ok: true, command: 'schema', data: {schema: sceneSchema()}}));

  server.registerTool('filmwright_timeline', {
    title: '读时间轴',
    description: '返回 timeline.json 的句 id、起止帧与字幕块数 —— 写 scene.json 的 at 之前先看这个。',
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

  server.registerTool('filmwright_scene_validate', {
    title: '校验场景规格（不启浏览器）',
    description: '只查 scene.json：类型、字段、at 对齐、顺序。秒级返回结构化错误（code/where/hint），改规格的快速回路。',
    inputSchema: {project: projectArg},
  }, async ({project}) => {
    try {
      const dir = resolve(project);
      const proj = await loadProject(dir);
      if (!proj.scene) {
        return fail({ok: false, command: 'scene_validate', errors: [{code: 'NO_SCENE', message: '项目里没有 scene.json', hint: '用 filmwright_new 建 scene 模板，或手写一份'}]});
      }
      let assetNames = null;
      try { assetNames = normalizeConfig(proj.raw).assets.map((a) => a.name); } catch { /* assets 问题由 check 报 */ }
      const r = validateScene(proj.scene, {timeline: proj.timeline ?? {sentences: []}, assetNames});
      return r.ok ? result({ok: true, command: 'scene_validate', data: {shots: proj.scene.shots.length}})
        : fail({ok: false, command: 'scene_validate', errors: r.errors});
    } catch (e) {
      return fail({ok: false, command: 'scene_validate', errors: [{code: e.code ?? 'ERROR', message: e.message}]});
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
    title: '出静帧',
    description: '渲指定帧为 PNG 并返回路径 —— 用它目视检查画面，形成「改规格 → 看帧」的闭环。',
    inputSchema: {
      project: projectArg,
      frames: z.array(z.number().int().min(1)).min(1).describe('帧号数组'),
      dir: z.string().describe('输出目录（建议项目 .work/ 下）'),
    },
  }, async ({project, frames, dir}) => run('stills', project, {frames: frames.join(','), dir}));

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
