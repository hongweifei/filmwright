// 静态检查的单元测试。
// 这些检查的价值在于「跑起来才发现」的错能在几秒内报出来 ——
// 所以也要证明它们**真的会报**，而不是永远绿。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkThemeKeys, checkPublicApi, checkImports, checkNames} from '../src/host/checks/static/index.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 造一个临时「库目录」，里面放 runtime/xxx.js。 */
function withRuntime(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'fk-static-'));
  try {
    mkdirSync(join(dir, 'runtime', 'draw'), {recursive: true});
    for (const [rel, body] of Object.entries(files)) {
      writeFileSync(join(dir, 'runtime', rel), body, 'utf8');
    }
    return fn(dir);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}

test('themeKeys：引用了 theme 里存在的键 → 通过', () => {
  withRuntime({
    'draw/a.js': "import {theme as C} from '../../contract/config.js';\n" +
      'export const x = {color: C.text, line: C.line};\n',
  }, (dir) => {
    const r = checkThemeKeys(dir);
    assert.equal(r.ok, true, r.problems.join('\n'));
    assert.ok(r.checked >= 2);
  });
});

test('themeKeys：引用了不存在的键 → 报出文件与行号', () => {
  // 这就是迁真实片子时踩到的那个：C.green 在 theme 里不存在，
  // 默认值变 undefined，一直传到 hexA 才崩
  withRuntime({
    'draw/a.js': "import {theme as C} from '../../contract/config.js';\n" +
      'export function m(o = {}) { const {okColor = C.green} = o; return okColor; }\n',
  }, (dir) => {
    const r = checkThemeKeys(dir);
    assert.equal(r.ok, false, '应当报错');
    assert.ok(r.problems.some((p) => p.includes('green')), '要指出是 green');
    assert.ok(r.problems.some((p) => p.includes(':2')), '要给出行号');
  });
});

test('themeKeys：注释里提到键名不算引用', () => {
  withRuntime({
    'draw/a.js': "import {theme as C} from '../../contract/config.js';\n" +
      '// 这里举例说明：以前写 C.green，现在写 C.ok\n' +
      'export const x = C.ok;\n',
  }, (dir) => {
    const r = checkThemeKeys(dir);
    assert.equal(r.ok, true, '注释里的举例不该算引用：' + r.problems.join('\n'));
  });
});

test('themeKeys：真库当前是干净的（引用都合法）', () => {
  // 注意收的是 src 目录（检查内部再拼 runtime/），与 checkImports 同一口径
  const r = checkThemeKeys(join(ROOT, 'src'));
  assert.equal(r.ok, true, '库自己必须过这道检查：\n' + r.problems.join('\n'));
  assert.ok(r.checked > 20, `引用数看起来太少（${r.checked}），检查可能没扫到文件`);
});

test('api：重名导出要报', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fk-api-'));
  try {
    const f = join(dir, 'index.js');
    writeFileSync(f, "export {S} from './a.js';\nexport {S as T, S} from './b.js';\n", 'utf8');
    const r = checkPublicApi(f);
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes('S')));
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

// ---- checkImports：相对路径存在 + 镜头不许把 import 伸出项目目录 ----

/** 造一个临时项目：`<dir>/proj/shots/*.js`，外加一个「库」目录供伸出去。 */
function withProject(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'fk-imports-'));
  try {
    mkdirSync(join(dir, 'proj', 'shots'), {recursive: true});
    mkdirSync(join(dir, 'src', 'runtime'), {recursive: true});
    writeFileSync(join(dir, 'src', 'runtime', 'primitives.js'), 'export const text = 1;\n', 'utf8');
    for (const [rel, body] of Object.entries(files)) {
      const p = join(dir, 'proj', 'shots', rel);
      mkdirSync(dirname(p), {recursive: true});
      writeFileSync(p, body, 'utf8');
    }
    return fn(join(dir, 'proj'));
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}

test('imports：镜头目录**内部**的相对导入允许（自己旁边的 helpers）', () => {
  // 反向保险：没有这一条，「一律拒绝相对导入」也能让下面那条恒绿
  withProject({
    'index.js': "import {helper} from './helpers.js';\nexport const SHOTS = [helper];\n",
    'helpers.js': 'export const helper = 1;\n',
  }, (proj) => {
    const r = checkImports(join(proj, 'shots'), proj, {insideOnly: proj});
    assert.equal(r.ok, true, '同目录的 helpers 应当允许：' + r.problems.join('\n'));
  });
});

test('imports：镜头把 import 伸到项目之外 → 报（「只 import filmwright」原先没人守）', () => {
  // 常驻判据。原先：裸导入被 `continue` 跳过、相对路径只判「存在」⇒
  // 只要路径在，`import {...} from '../../src/runtime/primitives.js'` 就是 PASS
  withProject({
    'index.js': "import {text} from '../../src/runtime/primitives.js';\nexport const SHOTS = [text];\n",
  }, (proj) => {
    const r = checkImports(join(proj, 'shots'), proj, {insideOnly: proj});
    assert.equal(r.ok, false, '伸出项目目录必须报');
    assert.ok(r.problems.some((p) => p.includes('项目目录之外')),
      '要说清是「伸出去」而不是「文件不存在」：' + r.problems.join('\n'));
  });
});

test('imports：**动态** `import(…)` 的相对路径也要查（原先漏了这条）', () => {
  // 实测漏过一个真 bug：拆 `commands.mjs` 时 `mcp()` 里的 `await import('../mcp/server.mjs')`
  // 没跟着降层，而它的 catch 把 `ERR_MODULE_NOT_FOUND` 报成「MCP 服务器需要依赖 sdk」
  // （依赖其实装着）—— 静态 import 全对，只有动态那条断了。
  // 坏的方向：
  withProject({'index.js': "export const f = () => import('./nope.js');\n"}, (proj) => {
    const r = checkImports(join(proj, 'shots'), proj, {insideOnly: proj});
    assert.equal(r.ok, false, '动态 import 指向不存在的文件必须报');
    assert.ok(r.problems.some((p) => p.includes('nope.js')), r.problems.join('\n'));
  });
  // 好的方向（反向保险：没有它，「一律报错」也能让上面那条恒绿）
  withProject({
    'index.js': "export const f = () => import('./helpers.js');\n",
    'helpers.js': 'export const x = 1;\n',
  }, (proj) => {
    const r = checkImports(join(proj, 'shots'), proj, {insideOnly: proj});
    assert.equal(r.ok, true, '指向存在文件的动态 import 不该被误报：' + r.problems.join('\n'));
  });
});

test('imports：不传 insideOnly 时不判内外（runtime 源码自己就要用相对导入）', () => {
  withProject({
    'index.js': "import {text} from '../../src/runtime/primitives.js';\nexport const SHOTS = [text];\n",
  }, (proj) => {
    const r = checkImports(join(proj, 'shots'), proj);
    assert.equal(r.ok, true, '不传 insideOnly 时只判存在（这个路径存在）：' + r.problems.join('\n'));
  });
});

test('imports：**注释里**的 import 例子不算（守卫别把自己的说明书当代码）', () => {
  // 实测踩过：`checkImports` 自己的文档里写了一句相对路径示例，于是它把自己文档里的
  // 例子当成真 import ⇒ 五个示例项目全部变红，而它们一个字都没改。
  withProject({
    'index.js': '// 举例：以前这样写 import {text} from "../../src/runtime/primitives.js";\n'
      + "import {helper} from './helpers.js';\nexport const SHOTS = [helper];\n",
    'helpers.js': 'export const helper = 1;\n',
  }, (proj) => {
    const r = checkImports(join(proj, 'shots'), proj, {insideOnly: proj});
    assert.equal(r.ok, true, '注释里的例子不该被当成真 import：' + r.problems.join('\n'));
  });
});

// ---- checkNames：`X is not defined` 这一族（漏 import / 漏声明）----

test('names：只在调用位置出现的名字 → 报出文件与行号', () => {
  // 真凶原型：拆文件时一条 import 整条丢掉 ⇒ `segmentDir(workDir)` 到真跑才抛
  withRuntime({'a.js': 'export function f() {\n  return segmentDir(1);\n}\n'}, (dir) => {
    const r = checkNames(dir);
    assert.equal(r.ok, false, '应当报错');
    assert.ok(r.problems.some((p) => p.includes('segmentDir')), '要指出是哪个名字：' + r.problems.join('\n'));
    assert.ok(r.problems.some((p) => p.includes(':2')), '要给出行号（第 2 行）：' + r.problems.join('\n'));
  });
});

test('names：同一个名字只要有绑定就不报（反向保险）', () => {
  // 没有这一条，「一律报错」也能让上面那条恒绿
  withRuntime({
    'a.js': "import {segmentDir} from './b.js';\nexport const d = segmentDir(1);\n",
    'b.js': 'export const segmentDir = (x) => x;\n',
  }, (dir) => {
    const r = checkNames(dir);
    assert.equal(r.ok, true, '有 import 就该绿：' + r.problems.join('\n'));
    assert.ok(r.checked >= 1, `扫到的名字太少（${r.checked}）`);
  });
});

test('names：函数参数 / 解构 / 声明也算绑定（别把参数当漏绑定）', () => {
  // 这三个名字都**只在调用位置**被用，但都在别处以绑定形式出现过一次
  withRuntime({
    'a.js': 'export const f = ({say}) => say("x");\n'
      + 'export const g = (cb) => cb(1);\n'
      + 'export function h() { return local(1); }\n'
      + 'const local = (x) => x;\n',
  }, (dir) => {
    const r = checkNames(dir);
    assert.equal(r.ok, true, '参数与声明都是绑定：' + r.problems.join('\n'));
  });
});

test('names：注释 / 字符串 / 正则里的 `名字(` 不算调用', () => {
  // 守卫的说明书不是被守卫的东西：注释里举例写一次 `foo(` 不该让仓库变红
  withRuntime({
    'a.js': '// 举例：以前写 foo(1)\nconst s = "bar(2)";\nconst re = /baz\\(/;\n'
      + 'export const t = [s, re];\n'
      // 另加一个**真调用**：夹具里一个被调用的名字都没有时，检查会按「空集上的干净不算干净」报出来
      + 'const helper = (x) => x;\nexport const u = helper(1);\n',
  }, (dir) => {
    const r = checkNames(dir);
    assert.equal(r.ok, true, '都不是真调用：' + r.problems.join('\n'));
    assert.ok(r.checked >= 1, `扫到的名字太少（${r.checked}）`);
  });
});

test('names：模板正文里的不算、`${}` 里的算（这一对才是词法器的判据）', () => {
  withRuntime({'a.js': 'export const s = `foo(1) ${missing(2)}`;\n'}, (dir) => {
    const r = checkNames(dir);
    assert.equal(r.ok, false, '`${missing(2)}` 是真调用，必须报');
    assert.ok(r.problems.some((p) => p.includes('missing')), r.problems.join('\n'));
    assert.ok(!r.problems.some((p) => p.includes('foo')), '模板正文里的 foo(1) 不算调用');
  });
});

test('names：对象字面量 / 类里的方法定义不算调用', () => {
  // `{foo() {}}` 与 `class A { bar() {} }` 里，名字后面也跟 `(` —— 但那是定义
  withRuntime({
    'a.js': 'export const o = {\n  foo() { return 1; },\n  async bar() { return 2; },\n};\n'
      + 'export class A {\n  baz() { return 3; }\n}\n'
      // 另加一个**真调用**：夹具里一个被调用的名字都没有时，检查会按「空集上的干净不算干净」报出来
      + 'export const use = () => helper(1);\nconst helper = (x) => x;\n',
  }, (dir) => {
    const r = checkNames(dir);
    assert.equal(r.ok, true, '方法定义不是漏绑定：' + r.problems.join('\n'));
    assert.ok(r.checked >= 1, `扫到的名字太少（${r.checked}）`);
  });
});

test('names：真库当前没有漏绑定的名字（整仓扫）', () => {
  // 扫的是**整仓**（src / bin / tools / tests / examples），比 `check` 里的 src 更宽 ——
  // 丢 import 这一族在 tools/ 里同样发生过（守卫自己也会漏绑定，而它们只在 CI 里跑）。
  const r = checkNames(ROOT, '.');
  assert.equal(r.ok, true, '仓库自己必须过这道检查：\n' + r.problems.join('\n'));
  assert.ok(r.checked > 1200, `扫到的被调用名字太少（${r.checked}），检查可能没扫到文件`);
});
