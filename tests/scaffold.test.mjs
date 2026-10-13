// 脚手架的测试：正例要能直接被校验器接受，负面对照要拒覆盖。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, writeFileSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {scaffoldProject} from '../src/host/project/scaffold.mjs';
import {validateScene} from '../src/contract/scene.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'fw-new-'));

test('scene 模板：文件齐、配置可 import、starter 规格对三句时间轴合法', async () => {
  const dir = join(tmp(), 'my-clip');
  const r = scaffoldProject(dir);
  assert.equal(r.slug, 'my-clip');
  for (const f of ['film.config.mjs', 'script/narration.txt', 'scene.json', '.gitignore']) {
    assert.ok(existsSync(join(dir, f)), '缺 ' + f);
  }
  const cfg = (await import(pathToFileURL(join(dir, 'film.config.mjs')).href)).default;
  assert.equal(cfg.slug, 'my-clip');
  // starter 的 at 引用 S01..S03：配一份三句时间轴，校验必须过
  const tl = {
    fps: 30,
    sentences: ['S01', 'S02', 'S03'].map((id, i) => ({id, chapter: 1, from: 100 + i * 100, to: 180 + i * 100, text: 'x'})),
    subs: [],
  };
  const scene = JSON.parse(readFileSync(join(dir, 'scene.json'), 'utf8'));
  const v = validateScene(scene, {timeline: tl, assetNames: []});
  assert.equal(v.ok, true, JSON.stringify(v.errors));
});

test('shots 模板：产出 shots/index.js，不产 scene.json', () => {
  const dir = join(tmp(), 'hand-made');
  const r = scaffoldProject(dir, {template: 'shots'});
  assert.ok(existsSync(join(dir, 'shots', 'index.js')));
  assert.ok(!existsSync(join(dir, 'scene.json')));
  assert.ok(r.files.includes('shots/index.js'));
});

test('负面对照：目录非空必须拒绝，且不覆盖任何已有文件', () => {
  const dir = tmp();
  const keep = join(dir, 'keep.txt');
  writeFileSync(keep, '原有内容', 'utf8');
  assert.throws(() => scaffoldProject(dir), (e) => e.code === 'DIR_NOT_EMPTY');
  assert.equal(readFileSync(keep, 'utf8'), '原有内容');
  assert.ok(!existsSync(join(dir, 'film.config.mjs')), '拒绝时一个文件都不该写');
});

test('负面对照：未知模板要报 BAD_TEMPLATE 并列出可用的', () => {
  const dir = join(tmp(), 'x');
  assert.throws(() => scaffoldProject(dir, {template: 'magic'}),
    (e) => e.code === 'BAD_TEMPLATE' && e.hint.includes('scene'));
});

test('slug 从目录名净化：非法字符换成 -', () => {
  const dir = join(tmp(), '我的 片子!');
  const r = scaffoldProject(dir);
  assert.match(r.slug, /^[A-Za-z0-9_-]+$/);
});
