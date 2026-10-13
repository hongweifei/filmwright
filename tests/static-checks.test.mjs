// 静态检查的单元测试。
// 这些检查的价值在于「跑起来才发现」的错能在几秒内报出来 ——
// 所以也要证明它们**真的会报**，而不是永远绿。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkThemeKeys, checkPublicApi} from '../src/host/checks/static/index.mjs';

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
