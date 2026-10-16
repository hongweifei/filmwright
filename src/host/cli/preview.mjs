// 预览命令：起一个本地服务，打开预览页。
//
// 与渲染的区别：渲染是 headless、逐帧截图、写完就退；
// 预览是**给人看的**，要有界面、要能拖动、改了文件要立刻看到。
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {relative} from 'node:path';
import {serveProject} from '../project/server.mjs';
import {requireTimeline, shotsRelOrNull} from '../project/load.mjs';
import {findBrowser} from '../browser/find.mjs';
import {num} from './args.mjs';

/** 用系统默认浏览器打开一个 URL（不阻塞）。 */
function openInBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  try {
    spawn(cmd[0], cmd[1], {stdio: 'ignore', detached: true}).unref();
  } catch {
    // 打不开就算了 —— 下面会把地址打出来让人自己点
  }
}

export async function preview(ctx) {
  requireTimeline(ctx.proj);
  const shotsRel = shotsRelOrNull(ctx.proj);
  const server = await serveProject(ctx.projectDir, {
    raw: ctx.proj.raw,
    timeline: ctx.proj.timeline,
    shotsRel,
    watch: true,          // 预览才需要热重载；渲染不需要（会拖慢且无意义）
  });
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/preview`;

  console.log(`filmwright 预览：${url}`);
  const watched = [shotsRel ? shotsRel + '/' : null, 'film.config.mjs']
    .filter(Boolean).join('、');
  console.log(`  改 ${watched} 后保存，页面会自动重载。`);
  console.log('  按 Ctrl+C 结束。');

  // --no-open：在无头环境/自动化测试里用，不要真去开浏览器
  if (ctx.args['no-open'] !== true && !process.env.FILMWRIGHT_NO_OPEN) {
    openInBrowser(url);
  }

  // --seconds N：跑够 N 秒就退出（自动化测试用；默认一直跑）
  if (ctx.args.seconds !== undefined) {
    const secs = num(ctx.args, 'seconds');
    await new Promise((r) => setTimeout(r, secs * 1000));
    server.closeProject();
    return 0;
  }

  // 一直跑到 Ctrl+C
  await new Promise((resolve) => {
    const bye = () => { server.closeProject(); resolve(); };
    process.on('SIGINT', bye);
    process.on('SIGTERM', bye);
  });
  return 0;
}
