// TTS 相关命令：合成配音（交给 python 做）与列出可用音色。
import {spawnSync} from 'node:child_process';
import {dirname, join, resolve, basename} from 'node:path';
import {KIT_ROOT, RUNTIME_ROOT} from '../../root.mjs';
import {makeSay, isJson} from '../output.mjs';


/** 解说词 → 配音 + 时间轴（交给 python，它管 TTS）。 */
export function tts(ctx) {
  const say = makeSay(ctx.args);
  const json = isJson(ctx.args);
  const py = join(KIT_ROOT, 'src', 'host', 'tts', 'build.py');
  // PYTHONIOENCODING：Windows 上 Python 默认按 CP936 写 stderr，而 Node 按 UTF-8
  // 解码 —— 中文提示会全成乱码（实测「微软侧 TTS 服务不可用」整段变成 ????）。
  // 强制 UTF-8，两边编码才对齐。
  // PYTHONDONTWRITEBYTECODE：Python 会在**源码目录**旁边写 `__pycache__/*.pyc`，
  // 而 `files: ["src"]` 是目录白名单 —— 本机跑过一次 tts，字节码就跟着发布物走
  // （实测 `npm pack` 里多出 39.7kB 的 `cpython-314` 字节码）。**别让它写**，
  // 光靠 `!src/**/__pycache__` 是事后过滤，这里是断根。
  const r = spawnSync('python', [py, '--project', ctx.projectDir], {
    stdio: json ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    env: {...process.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1'},
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
    env: {...process.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1'},
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
