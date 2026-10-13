// 浏览器定位：不绑定任何具体项目或包管理器缓存。
//
// 早先版本把路径写死成另一个项目的 node_modules 里的缓存位置，那是跨项目硬依赖：
// 换个目录、换台机器就找不到。现在按序找：环境变量 → 常见安装位置 → PATH，
// 找不到就明确报错并给出怎么指定。
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';

const CANDIDATES_WIN = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

const CANDIDATES_NIX = [
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

const NAMES = ['google-chrome', 'chromium', 'chromium-browser', 'chrome', 'msedge'];

/**
 * 返回可用的浏览器可执行文件路径。
 * 环境变量 CHROME_BIN 优先（测试要用不同的浏览器时靠它）。
 */
export function findBrowser(explicit) {
  const env = explicit || process.env.CHROME_BIN;
  if (env) {
    if (!existsSync(env)) throw new Error(`filmwright: CHROME_BIN 指向的文件不存在：${env}`);
    return env;
  }
  const list = process.platform === 'win32' ? CANDIDATES_WIN : CANDIDATES_NIX;
  for (const p of list) if (existsSync(p)) return p;

  // 退到 PATH
  for (const n of NAMES) {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const r = spawnSync(cmd, [n], {encoding: 'utf8'});
    if (r.status === 0 && r.stdout.trim()) {
      return r.stdout.trim().split(/\r?\n/)[0].trim();
    }
  }
  throw new Error(
    'filmwright: 找不到浏览器。装一个 Chrome/Chromium/Edge，或用 CHROME_BIN 指定路径。\n' +
    '  例：CHROME_BIN=/usr/bin/chromium filmwright render\n' +
    '  注意：不要指向正在使用的浏览器实例 —— filmwright 会用自己的临时 profile 启动新进程。'
  );
}
