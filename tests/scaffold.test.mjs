// 脚手架的测试：正例要能被引擎直接吃下（配置可 import、镜头文件是真镜头），
// 负面对照要拒覆盖、拒未知模板。
//
// 引擎只有**命令式**一种入口：`shots/index.js` 里的 SHOTS 就是画面的唯一来源。
// 所以骨架必须产出它，且**不能再产出任何声明式规格文件**（`scene.json` 已从引擎删除）。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, writeFileSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {scaffoldProject} from '../src/host/project/scaffold.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'fw-new-'));

test('shots 模板：文件齐、配置可 import、且不产出任何声明式规格文件', async () => {
  const dir = join(tmp(), 'my-clip');
  const r = scaffoldProject(dir);
  assert.equal(r.slug, 'my-clip');
  assert.equal(r.template, 'shots');
  for (const f of ['film.config.mjs', 'script/narration.txt', '.gitignore',
    'public/fonts/README.md', 'public/assets/README.md', 'shots/index.js']) {
    assert.ok(existsSync(join(dir, f)), '缺 ' + f);
  }
  assert.ok(r.files.includes('shots/index.js'), 'r.files 要报出镜头文件：' + JSON.stringify(r.files));
  // 声明式入口已从引擎删除 ⇒ 骨架里不该再有 scene.json（有它就是迁移没做完，
  // 而 agent 会照着一个引擎根本不读的文件写画面）
  assert.ok(!existsSync(join(dir, 'scene.json')), '不该产出 scene.json');
  assert.ok(!r.files.includes('scene.json'), 'r.files 不该报 scene.json');

  // 配置骨架必须真能 import（它是引擎的入口；语法错/字段错会拖到用户第一次跑才炸）
  const cfg = (await import(pathToFileURL(join(dir, 'film.config.mjs')).href)).default;
  assert.equal(cfg.slug, 'my-clip');
  assert.equal(cfg.fps, 30);
  assert.deepEqual(cfg.size, {width: 1280, height: 720});
});

test('shots/index.js 是真镜头：export const SHOTS、带 start 与 draw（**读文本，不求值**）', () => {
  // ⚠️ 不能 import 它来断言：它 `import … from 'filmwright'`，在 Node 里解析不到
  // （包名映射只在浏览器/打包侧成立）⇒ 求值必崩。所以只读文本。
  // 而「读文本」不能写成恒真：下面每条都要求文本里**确实出现**那个结构。
  const dir = join(tmp(), 'hand-made');
  scaffoldProject(dir, {template: 'shots'});
  const src = readFileSync(join(dir, 'shots', 'index.js'), 'utf8');
  assert.match(src, /export\s+const\s+SHOTS\s*=\s*\[/, '必须导出 SHOTS 数组');
  assert.match(src, /from\s+'filmwright'/, '镜头只从公开面取东西（分层规则）');
  const starts = src.match(/start\s*:/g) ?? [];
  const draws = src.match(/draw\s*\(/g) ?? [];
  assert.ok(starts.length >= 2, `骨架应给出 2 个镜头，每个都有 start（实际 ${starts.length} 处）`);
  assert.ok(draws.length >= 2, `每个镜头都要有 draw（实际 ${draws.length} 处）`);
});

test('负面对照：目录非空必须拒绝，且不覆盖任何已有文件', () => {
  const dir = tmp();
  const keep = join(dir, 'keep.txt');
  writeFileSync(keep, '原有内容', 'utf8');
  assert.throws(() => scaffoldProject(dir), (e) => e.code === 'DIR_NOT_EMPTY');
  assert.equal(readFileSync(keep, 'utf8'), '原有内容');
  assert.ok(!existsSync(join(dir, 'film.config.mjs')), '拒绝时一个文件都不该写');
  assert.ok(!existsSync(join(dir, 'shots')), '拒绝时连目录都不该建');
});

test('负面对照：非 shots 的模板（含已删的 scene）一律拒、列出可用值、且一个文件都不落', () => {
  for (const t of ['scene', 'magic']) {
    const dir = join(tmp(), 'x-' + t);
    assert.throws(() => scaffoldProject(dir, {template: t}),
      (e) => e.code === 'BAD_TEMPLATE' && e.hint.includes('shots'),
      `模板 ${t} 应被拒并列出可用模板`);
    assert.ok(!existsSync(dir), `拒绝模板 ${t} 时不该建目录、不该落文件`);
  }
});

test('slug 从目录名净化：非法字符换成 -，且净化结果仍能进配置（可 import）', async () => {
  const dir = join(tmp(), '我的 片子!');
  const r = scaffoldProject(dir);
  assert.match(r.slug, /^[A-Za-z0-9_-]+$/);
  // 净化的意义是「无论目录名叫什么，生成的配置都必须是合法的 JS 字面量」——
  // 直接 import 一次才算真验过（目录名里带引号/换行时最危险的正是这一句）。
  const cfg = (await import(pathToFileURL(join(dir, 'film.config.mjs')).href)).default;
  assert.equal(cfg.slug, r.slug, '配置里的 slug 应与返回值一致');
});
