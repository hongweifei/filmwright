// 启动前置检查：环境不满足时**明确说缺什么**，而不是等到深处报
// "WebSocket is not defined" 那种看不出所以然的错。
//
// 实测（本机 nvm 切版本跑过）：
//   Node 20.19.5  全局 WebSocket = undefined   ← 驱动不了 CDP
//   Node 22.22.1  WebSocket = function
//   Node 24.15.0  WebSocket = function
// 所以 package.json 的 engines 写 ">=22"，与 CDP 那一步的真实需求一致。
import {spawnSync} from 'node:child_process';

export const REQUIRED_NODE_MAJOR = 22;

/** 检查运行时能力。返回问题列表（空 = 没问题）。 */
export function checkRuntime() {
  const problems = [];
  const major = Number(process.versions.node.split('.')[0]);

  if (major < REQUIRED_NODE_MAJOR) {
    problems.push(
      `Node ${process.versions.node} 太旧：驱动浏览器要用全局 WebSocket，` +
      `它从 Node ${REQUIRED_NODE_MAJOR} 才有（实测 20 上是 undefined）。` +
      `请升级到 Node ${REQUIRED_NODE_MAJOR}+。`
    );
  }
  // 逐项再确认一遍，因为「版本够」不等于「这个能力在」（例如某些裁剪构建）
  for (const [name, ok, why] of [
    ['WebSocket', typeof WebSocket === 'function', '驱动浏览器（CDP）要用它'],
    ['fetch', typeof fetch === 'function', '读 DevTools 的 /json/list 要用它'],
  ]) {
    if (!ok) problems.push(`运行时没有 ${name} —— ${why}。`);
  }
  return problems;
}

/** 有问题就抛，信息里带上怎么修。 */
export function assertRuntime() {
  const problems = checkRuntime();
  if (problems.length === 0) return;
  throw new Error(
    'filmwright: 运行环境不满足\n' +
    problems.map((p) => '  - ' + p).join('\n') +
    `\n  当前 Node：${process.version}`
  );
}

/** 外部命令是否可用（ffmpeg / python 这类）。 */
export function which(cmd) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(probe, [cmd], {encoding: 'utf8'});
  return r.status === 0 && String(r.stdout || '').trim().length > 0;
}
