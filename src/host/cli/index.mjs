// CLI 入口：查命令表 → 装项目 → 调用。
// 命令表在这里集中定义，帮助文本从它生成 —— 加命令不用改两处。
import {resolve} from 'node:path';
import {loadProject} from '../project/load.mjs';
import {assertRuntime} from '../preflight.mjs';
import {parseArgs, str} from './args.mjs';
import {isJson, emitJson, toJsonError} from './output.mjs';
import * as commands from './commands.mjs';

const COMMANDS = [
  ['new', '新建项目骨架    <目录> [--template scene|shots]', 'new'],
  ['schema', '输出 scene 规格的机器可读 schema（类型/字段/上限/错误码）', 'schema'],
  ['mcp', 'MCP 服务器（stdio），把工具链暴露给 agent', 'mcp'],
  ['check', '自检：公开面重名导出、模块路径、时间轴引用、场景规格、全帧绘制、画质', 'check'],
  ['preview', '预览页（拖动时间轴 / 播放 / 改文件热重载）[--no-open] [--seconds N]', 'preview'],
  ['tts', '解说词 → 配音 + 时间轴', 'tts'],
  ['clips', '片段素材抽帧（视频 → 图片序列，内容寻址缓存）', 'clips'],
  ['stills', '出静帧        --frames 1,300  --dir <目录>', 'stills'],
  ['sheet', '抽帧联络表    --from 1 --to 900 --step 150 --out <png>', 'sheet'],
  ['render', '渲染          [--out <mp4>] [--shards N|auto] [--resume] [--incremental] [--proxy 0.5]', 'render'],
  ['mux', '画面配音合流  --video <mp4> [--out <mp4>]', 'mux'],
  ['srt', '导出字幕      [--out <srt>] [--translation <json>]（双语轨）', 'srt'],
  ['all', '一条龙：check → render → mux', 'all'],
];

function usage() {
  const width = Math.max(...COMMANDS.map(([n]) => n.length));
  return [
    'filmwright —— Canvas 逐帧渲染的中文说明片工具链',
    '',
    '用法：filmwright <命令> --project <项目目录> [选项]',
    '',
    '命令：',
    ...COMMANDS.map(([n, desc]) => `  ${n.padEnd(width)}  ${desc}`),
    '',
    '通用选项：',
    '  --project <目录>   项目目录（含 film.config.mjs）',
    '  --browser <路径>   指定浏览器（默认自动找；也可用环境变量 CHROME_BIN）',
    '  --json             机器可读输出：stdout 恰好一个 JSON 文档（给 agent / 脚本用）',
    '',
    '项目形状：',
    '  film.config.mjs        配置（default 导出）',
    '  script/narration.txt   解说词',
    '  script/timeline.json   tts 生成，渲染读它',
    '  shots/index.js         导出 SHOTS',
    '  public/fonts/…         字体',
    '',
  ].join('\n');
}

export async function main(argv) {
  const args = parseArgs(argv);
  const json = isJson(args);
  const name = args._[0];

  // 命令可以返回退出码（number），或 {code, data, warnings, errors}（--json 的料）。
  const finish = (code, data = {}, warnings = [], errors = []) => {
    if (json) emitJson({ok: code === 0, command: name, errors, warnings, data});
    return code;
  };
  const fail = (e) => {
    if (json) {
      emitJson({ok: false, command: name ?? 'unknown', errors: [toJsonError(e)], warnings: []});
      return 1;
    }
    throw e;   // 人模式交回 bin：一句话 + 退出码
  };

  try {
    if (!name || name === 'help' || args.help) {
      if (json) return finish(0, {usage: usage()});
      console.log(usage());
      return 0;
    }
    const entry = COMMANDS.find(([n]) => n === name);
    if (!entry) {
      const e = new Error('filmwright: 不认识的命令 ' + name);
      e.code = 'UNKNOWN_COMMAND';
      e.hint = '可用：' + COMMANDS.map(([n]) => n).join(' / ') + '；完整说明见 filmwright help';
      if (!json) console.log(usage());
      return fail(e);
    }
    // new / schema / mcp 不需要 --project：位置参数或无参命令
    if (entry[2] === 'schema') {
      const r = await commands.schema({args});
      const out = typeof r === 'number' ? {code: r} : (r ?? {code: 0});
      return finish(out.code ?? 0, out.data ?? {}, out.warnings ?? [], out.errors ?? []);
    }
    if (entry[2] === 'mcp') {
      const r = await commands.mcp({args});
      const out = typeof r === 'number' ? {code: r} : (r ?? {code: 0});
      return finish(out.code ?? 0, out.data ?? {}, out.warnings ?? [], out.errors ?? []);
    }
    if (entry[2] === 'new') {
      const target = args._[1];
      if (!target) {
        const e = new Error('filmwright: new 要一个目标目录：filmwright new <目录>');
        e.code = 'MISSING_DIR';
        e.hint = '目录必须不存在或为空；模板可选 --template scene（默认）/ shots';
        throw e;
      }
      const r = await commands.newProject({dir: resolve(target), args});
      const out = typeof r === 'number' ? {code: r} : (r ?? {code: 0});
      return finish(out.code ?? 0, out.data ?? {}, out.warnings ?? [], out.errors ?? []);
    }
    if (!args.project) {
      const e = new Error('filmwright: 缺 --project <项目目录>');
      e.code = 'MISSING_PROJECT';
      e.hint = '项目目录里要有 film.config.mjs；新项目用 filmwright new <目录>';
      return fail(e);
    }

    // 环境不满足就在这里说清楚，别等到深处报 "WebSocket is not defined"
    assertRuntime();

    const projectDir = resolve(str(args, 'project'));
    const opts = {browser: args.browser ? String(args.browser) : undefined};

    // tts 只跟解说词打交道，不要求时间轴已存在
    const proj = await loadProject(projectDir);
    const r = await commands[entry[2]]({projectDir, proj, args, opts});
    const out = typeof r === 'number' ? {code: r} : (r ?? {code: 0});
    return finish(out.code ?? 0, out.data ?? {}, out.warnings ?? [], out.errors ?? []);
  } catch (e) {
    return fail(e);
  }
}
