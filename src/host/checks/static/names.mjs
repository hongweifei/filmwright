// 「用了没绑定的名字」的静态检查：`X is not defined` 这一族，读文件就能报。
//
//   checkNames(dir) —— 扫 dir 下所有 .js / .mjs
//
// ## 为什么需要这一道（实测代价）
//
// 拆 `commands.mjs` 时，一条**跨行** import（12 个名字，来自 `media/incremental.mjs`）
// 被「按行过滤 import」整条丢掉 —— 于是 `render --incremental` 一进门就
// `segmentDir is not defined`。而当时：
//
//   · `npm test` 全绿 —— 没有单测走 `--incremental`；
//   · `verify-readme`（真跑 `all`）全绿 —— `all` 不走 `--incremental`；
//   · 只有 CI 上两个慢守卫会红（`verify-incremental` 39s / `verify-attribution` 177s），
//     而那两个作业**红了十几个提交没人看见**（本机没有 runner，谁都没跑）。
//
// ⇒ 这一族必须在**几秒内、在 `npm test` 里**就报出来，不能只靠真跑。
// 同族的上一例是 `os is not defined`（丢掉 `import os from 'node:os'`），
// 那次是 `verify-readme` 抓到的 —— 两次都是「漏绑定」，两次都要等真跑。
//
// ## 为什么它**不**进 `runChecks`（别顺手接进去）
//
// 它是**库内部的结构不变量**（扫的是 `src/` 自己），与 `tests/structure.test.mjs` 那几条
// （分层方向、扩展名规则、引擎不认识任何片子）同族，所以常驻守卫放在 `npm test`。
// 而 `filmwright check` 的「N 道自检」是**给用户看的**（针对一部片子跑），
// 且那个数字在文档、README 与 `examples/promo` 的**解说词/字幕/画面文字**里都有 ——
// 接进去会让 `examples/promo` 的旁白变成过期说法，而改旁白要重新合成 TTS、
// 重建时间轴与音频缓存（上一次从「九道」改到「十道」就是这么一轮）。
// 那是另一件事，别让它跟着一条静态检查一起发生。
//
// ## 判据：不是「名字表」，是「一次绑定都没见到」
//
// 一个名字只要**被绑定过**（import / 声明 / 函数参数 / 解构），它必然在文件里以
// **非调用**的形式出现至少一次（`import {x}`、`const x =`、`function f(x)`、`{x}`）。
// 反过来：**全文件只以 `x(` 的形式出现**、又不是成员调用 `.x(`、又不是方法定义的名字，
// 就是没有任何绑定。所以判的是「绑定一次都没见到」，不是「哪些名字允许」。
//
// 仅有的两个例外是**语言与宿主本来就给的**名字：关键字（`if` / `new` / `typeof`…）与
// 宿主全局（`Object` / `process` / `performance` / WebCodecs…）。见 `KEYWORDS` 与
// `HOST_GLOBALS` —— 往后者里加名字的含义只能是「**运行环境**本来就有它」，
// 不能是「这条报错很烦」。
//
// ## 为什么不用正则扫
//
// 注释里的 `foo(`、字符串里的 `foo(`、正则 `/(/` 都不是调用，而模板
// `` `${f(x)}` `` 里的是。所以先 `lex()` 把注释/字符串/正则换成空白（**保留换行**，
// 行号要对得上），再做词法级的判断。`stripComments()` 那种纯替换在这里不够用：
// 它不认字符串，`'它里面有个 /* '` 会把后面整段当成注释。
import {readFileSync, existsSync, readdirSync, statSync} from 'node:fs';
import {join, relative} from 'node:path';

/** 语言关键字：它们后面跟 `(` 是语法，不是调用。 */
const KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue',
  'return', 'throw', 'try', 'catch', 'finally', 'new', 'delete', 'typeof', 'instanceof',
  'in', 'of', 'void', 'yield', 'await', 'async', 'function', 'class', 'extends', 'super',
  'this', 'import', 'export', 'const', 'let', 'var', 'static', 'get', 'set', 'from', 'as',
  'with', 'debugger',
]);

/**
 * 宿主本来就有的名字（Node 侧 + 浏览器侧 + WebCodecs）。
 *
 * 浏览器那批不是多余的：`tools/probes/*.mjs` 里有一大段代码是 `.toString()` 之后
 * **送进页面里跑**的（`new VideoFrame(c)`、`VideoEncoder`），在 Node 里根本不求值。
 */
const HOST_GLOBALS = new Set([
  // 语言内置
  'globalThis', 'Object', 'Function', 'Boolean', 'Symbol', 'Error', 'EvalError', 'RangeError',
  'ReferenceError', 'SyntaxError', 'TypeError', 'URIError', 'AggregateError', 'Array', 'Number',
  'BigInt', 'String', 'RegExp', 'Date', 'Math', 'JSON', 'Intl', 'Promise', 'Proxy', 'Reflect',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'FinalizationRegistry', 'ArrayBuffer',
  'SharedArrayBuffer', 'DataView', 'Atomics', 'Float32Array', 'Float64Array', 'Int8Array',
  'Int16Array', 'Int32Array', 'Uint8Array', 'Uint8ClampedArray', 'Uint16Array', 'Uint32Array',
  'BigInt64Array', 'BigUint64Array',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'decodeURI', 'decodeURIComponent', 'encodeURI',
  'encodeURIComponent', 'escape', 'unescape', 'eval', 'structuredClone', 'queueMicrotask',
  // Node
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate',
  'console', 'process', 'Buffer', 'require', 'module', 'exports', '__dirname', '__filename',
  'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'AbortController', 'AbortSignal',
  'Blob', 'File', 'FormData', 'Headers', 'Request', 'Response', 'WebSocket', 'fetch', 'crypto',
  'performance', 'atob', 'btoa',
  // 浏览器 / 渲染页
  'navigator', 'location', 'history', 'localStorage', 'sessionStorage', 'document', 'window',
  'self', 'top', 'parent', 'frames', 'requestAnimationFrame', 'cancelAnimationFrame', 'Image',
  'OffscreenCanvas', 'createImageBitmap', 'ImageData', 'Path2D', 'DOMMatrix', 'DOMPoint',
  'getComputedStyle', 'matchMedia', 'alert', 'confirm', 'prompt', 'postMessage',
  'addEventListener', 'removeEventListener', 'dispatchEvent', 'FontFace', 'ResizeObserver',
  'IntersectionObserver', 'MutationObserver', 'CustomEvent', 'CSS',
  'ReadableStream', 'WritableStream', 'TransformStream', 'CompressionStream', 'DecompressionStream',
  // WebCodecs（只在页面里跑）
  'VideoFrame', 'VideoEncoder', 'VideoDecoder', 'AudioData', 'AudioEncoder', 'AudioDecoder',
  'EncodedVideoChunk', 'EncodedAudioChunk', 'ImageBitmap',
]);

/**
 * 把注释 / 字符串 / 正则 / 模板正文换成空白，**保留换行**（行号要对得上）。
 *
 * 模板是唯一「正文与代码混在一起」的语法，所以用一个栈：
 *   · 栈顶是 `'tpl'`  ⇒ 正在模板正文里，读 `` ` `` 或 `${` 为止；
 *   · 栈顶是数字      ⇒ 正在 `${…}` 里的代码里，数字是花括号深度；
 *   · 栈空            ⇒ 普通代码。
 */
function lex(src) {
  const out = [];
  const n = src.length;
  const stack = [];
  let i = 0;
  let last = '';      // 最近一个有意义的代码字符 —— 判 `/` 是正则还是除号
  let lastWord = '';  // 最近一个有意义的词 —— 判 `return /re/`
  const emitCode = (s) => {
    out.push(s);
    for (const ch of s) if (!/\s/.test(ch)) last = ch;
  };
  const blank = (s) => out.push(s.replace(/[^\n]/g, ' '));
  const regexOk = () => last === '' || '(,=:[!&|?{};+-*%^~<>\n'.includes(last)
    || ['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'do', 'else',
      'yield', 'await', 'instanceof'].includes(lastWord);

  while (i < n) {
    const top = stack.length ? stack[stack.length - 1] : null;

    // ---- 模板正文：直到 `` ` `` 或 `${` ----
    if (top === 'tpl') {
      let j = i;
      let text = '';
      while (j < n) {
        const d = src[j];
        if (d === '\\') { text += '  '; j += 2; continue; }
        if (d === '`' || (d === '$' && src[j + 1] === '{')) break;
        text += d === '\n' ? '\n' : ' ';
        j++;
      }
      blank(text);
      if (j >= n) { i = j; break; }
      if (src[j] === '`') { stack.pop(); emitCode('`'); i = j + 1; continue; }
      stack.push(0);
      emitCode('${');
      i = j + 2;
      continue;
    }

    // ---- 代码态 ----
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      const e = src.indexOf('\n', i);
      const end = e === -1 ? n : e;
      blank(src.slice(i, end));
      i = end;
      continue;
    }
    if (c === '/' && c2 === '*') {
      const e = src.indexOf('*/', i + 2);
      const end = e === -1 ? n : e + 2;
      blank(src.slice(i, end));
      i = end;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c || src[j] === '\n') { j++; break; }
        j++;
      }
      blank(src.slice(i, j));
      i = j;
      continue;
    }
    if (c === '`') { stack.push('tpl'); emitCode('`'); i++; continue; }
    if (c === '/' && regexOk()) {
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '\n') break;
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { j++; break; }
        j++;
      }
      while (j < n && /[a-z]/.test(src[j])) j++;   // 标志位
      blank(src.slice(i, j));
      i = j;
      continue;
    }
    if (c === '{' || c === '}') {
      if (top !== null) {
        if (c === '}' && top === 0) { stack.pop(); emitCode('}'); i++; continue; }
        stack[stack.length - 1] = top + (c === '{' ? 1 : -1);
      }
      emitCode(c);
      lastWord = '';
      i++;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && /[\w$]/.test(src[j])) j++;
      emitCode(src.slice(i, j));
      lastWord = src.slice(i, j);
      i = j;
      continue;
    }
    emitCode(c);
    if (!/[\w$]/.test(c)) lastWord = '';
    i++;
  }
  return out.join('');
}

/** 一行行的位置查询（只用来报行号）。 */
function lineIndex(code) {
  const starts = [0];
  for (let i = 0; i < code.length; i++) if (code[i] === '\n') starts.push(i + 1);
  return (pos) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** 一个文件里：只在调用位置出现的名字（`calls`）与在别处出现过的名字（`others`）。 */
function scan(code) {
  const toks = [];
  const re = /[A-Za-z_$][\w$]*|[^\s]/g;
  let m;
  while ((m = re.exec(code))) toks.push({id: /^[A-Za-z_$]/.test(m[0]), v: m[0], at: m.index});
  const lineOf = lineIndex(code);

  const calls = new Map();
  const others = new Set();
  // 定义位置的前一个 token：`{`/`,`/`;`/`}` 之后、或 `function` 之类的关键字之后，
  // 名字后面跟着 `(…) {` 就是**定义**而不是调用（对象字面量的方法、类的方法）。
  const DEF_BEFORE = new Set(['{', ',', ';', '}', 'function', 'class', 'async', 'get', 'set', 'static', '*']);

  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (!t.id) continue;
    const p = k > 0 ? toks[k - 1] : null;
    const nx = k + 1 < toks.length ? toks[k + 1] : null;
    if (!nx || nx.v !== '(') { others.add(t.v); continue; }          // 不是调用形状
    if (p && (p.v === '.' || p.v === '?.')) { others.add(t.v); continue; }   // 成员调用
    if (KEYWORDS.has(t.v)) { others.add(t.v); continue; }
    if (!p || DEF_BEFORE.has(p.v)) {
      let depth = 0;
      let end = -1;
      for (let j = k + 1; j < toks.length; j++) {
        if (toks[j].v === '(') depth++;
        else if (toks[j].v === ')') { depth--; if (depth === 0) { end = j; break; } }
      }
      if (end >= 0 && end + 1 < toks.length && toks[end + 1].v === '{') {
        others.add(t.v);                                             // 方法 / 函数定义
        continue;
      }
    }
    if (!calls.has(t.v)) calls.set(t.v, []);
    calls.get(t.v).push(lineOf(t.at));
  }
  return {calls, others};
}

/**
 * 扫 `dir` 下所有 `.js` / `.mjs`，报出「只在调用位置出现、又没有绑定」的名字。
 *
 * @param {string} dir 要扫的目录
 * @param {string} [label] 报错里显示的基准路径
 */
export function checkNames(dir, label = dir) {
  if (!existsSync(dir)) return {name: 'names', ok: true, checked: 0, problems: []};
  const files = [];
  (function walk(d) {
    for (const e of readdirSync(d)) {
      if (e === 'node_modules' || e.startsWith('.')) continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(js|mjs)$/.test(e)) files.push(p);
    }
  })(dir);

  const bad = [];
  let checked = 0;
  for (const f of files) {
    const {calls, others} = scan(lex(readFileSync(f, 'utf8')));
    checked += calls.size;
    for (const [name, lines] of calls) {
      if (others.has(name) || HOST_GLOBALS.has(name)) continue;
      bad.push(`${relative(label, f)}:${lines[0]}: ${name} 没有绑定（全文件只在调用位置出现）`
        + ' —— 漏了 import 还是漏了声明？');
    }
  }
  // 空集上的干净不算干净：扫到的名字太少说明检查自己失效了
  if (checked === 0 && files.length > 0) {
    bad.push(`${files.length} 个文件里一个被调用的名字都没读到 —— 检查脚本可能失效了`);
  }
  return {name: 'names', ok: bad.length === 0, checked, problems: bad};
}
