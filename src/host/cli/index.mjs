// CLI 入口：查命令表 → 装项目 → 调用。
// 命令表在这里集中定义，帮助文本从它生成 —— 加命令不用改两处。
import {resolve} from 'node:path';
import {loadProject} from '../project/load.mjs';
import {assertRuntime} from '../preflight.mjs';
import {parseArgs, str} from './args.mjs';
import * as commands from './commands.mjs';

const COMMANDS = [
  ['check', '自检：公开面重名导出、模块路径、时间轴引用、场景规格、全帧绘制、画质', 'check'],
  ['preview', '预览页（拖动时间轴 / 播放 / 改文件热重载）[--no-open] [--seconds N]', 'preview'],
  ['tts', '解说词 → 配音 + 时间轴', 'tts'],
  ['stills', '出静帧        --frames 1,300  --dir <目录>', 'stills'],
  ['sheet', '抽帧联络表    --from 1 --to 900 --step 150 --out <png>', 'sheet'],
  ['render', '渲染          [--out <mp4>] [--shards 5] [--from N --to M]', 'render'],
  ['mux', '画面配音合流  --video <mp4> [--out <mp4>]', 'mux'],
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
  const name = args._[0];

  if (!name || name === 'help' || args.help) {
    console.log(usage());
    return 0;
  }
  const entry = COMMANDS.find(([n]) => n === name);
  if (!entry) {
    console.error(`filmwright: 不认识的命令 ${name}\n`);
    console.log(usage());
    return 2;
  }
  if (!args.project) throw new Error('filmwright: 缺 --project <项目目录>\n\n' + usage());

  // 环境不满足就在这里说清楚，别等到深处报 "WebSocket is not defined"
  assertRuntime();

  const projectDir = resolve(str(args, 'project'));
  const opts = {browser: args.browser ? String(args.browser) : undefined};

  // tts 只跟解说词打交道，不要求时间轴已存在
  const proj = await loadProject(projectDir);
  return commands[entry[2]]({projectDir, proj, args, opts});
}
