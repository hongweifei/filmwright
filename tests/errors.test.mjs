// 错误码登记表：**源码用到的码**与 `ERROR_CODES` 必须双向一致。
//
// 这条判据原先住在 `tests/scene.test.mjs` 里（那一份整篇是声明式 scene.json 的测试，
// 已随声明式一起删掉）——但它守的不是声明式，而是**码名这一层契约**，所以搬到这里。
//
// 为什么值钱：一个拼错的码名（`SCENE_FX_RNGE`）会让 `--json` 悄悄吐出一个没人认识的值，
// 而"报错了"这个现象看起来完全正常。反方向同样要管：登记了却没用的码是死条目。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ERROR_CODES} from '../src/contract/errorCodes.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('错误码：源码用到的码与登记表双向一致', () => {
  const files = [];
  (function walk(dir) {
    for (const e of readdirSync(dir, {withFileTypes: true})) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs)$/.test(e.name)) files.push(p);
    }
  })(join(ROOT, 'src'));

  const used = new Set();
  for (const abs of files) {
    // 先把**登记表本身**剥掉再扫，否则那些数组元素会被当成"用到的码"（自引用）
    const body = readFileSync(abs, 'utf8').replace(/export const \w*ERROR_CODES = \[[\s\S]*?\];/g, '');
    for (const m of body.matchAll(/\bSCENE_[A-Z0-9_]+\b/g)) used.add(m[0]);
  }

  assert.ok(files.length > 50, `只扫到 ${files.length} 个源文件 —— 扫描逻辑写错了`);
  assert.ok(used.size >= 10, `只扫到 ${used.size} 个码 —— 扫描逻辑写错了`);

  const declared = new Set(ERROR_CODES);
  assert.deepEqual([...used].filter((c) => !declared.has(c)), [], '源码用了未登记的错误码');
  assert.deepEqual([...declared].filter((c) => !used.has(c)), [], '登记表里有源码没用到的码');
});
