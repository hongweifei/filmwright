// 公开面的常驻判据。
//
// **为什么值得单独一个文件**：「镜头文件只 import `'filmwright'`」是本仓库写死的分层规则
// （见 `docs/architecture.md`），但**宿主页面自己**曾经违反它 ——
// `src/host/pages/render.html` 深链 `/kit/runtime/stage/index.js` 去拿 `boot`，
// 预览页同理。规则只要有人违反且没人管，就等于没有。
//
// 深链的代价不是「不优雅」，是**静默**：`/kit/**` 直接映射到 `src/`，
// 所以改一个目录名（本仓库刚做过一轮重排）就会让页面模块 404 ——
// 而页面 boot 不起来的表现只是「渲染超时」，看不出跟目录名有关系。
// （实测：重排后像素回归报「启动超时」，就是 `render.html` 里一行 `/kit/runtime/...` 没跟着改。）
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const PAGES = ['src/host/pages/render.html', 'src/host/pages/preview.html'];

/** 页面里所有 `from '/kit/…'` 的模块地址（含具名 / 命名空间 / 默认导入各种写法）。 */
const kitFrom = (src) => [...src.matchAll(/from\s*'(\/kit\/[^']*)'/g)].map((m) => m[1]);

/** 页面里具名导入的符号名（只统计来自 `/kit/…` 的那些）。 */
const kitNames = (src) => {
  const out = [];
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'(\/kit\/[^']*)'/g)) {
    if (!m[2].startsWith('/kit/')) continue;
    out.push(...m[1].split(',').map((s) => s.trim()).filter(Boolean));
  }
  return out;
};

test('宿主页面只从公开面取东西：不深链 /kit/<子路径>，且用到的名字都在公开面上', async () => {
  // 公开面直接**问实现**（在 Node 里 import 一次），不解析 `index.js` 的源码 ——
  // 解析会漏 `export *`（`ease.js` 那 16 个就是这么出去的），也会随写法漂移。
  const pub = await import('../src/index.js');

  let checkedPages = 0;
  let checkedNames = 0;
  for (const rel of PAGES) {
    const src = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
    const froms = kitFrom(src);

    // 下限：一个 `/kit/` 地址都没扫到 ⇒ 判据在空集上恒绿（扫描逻辑坏了，不是「干净」）
    assert.ok(froms.length > 0,
      `${rel} 里一个 /kit/ 模块地址都没扫到 —— 扫描逻辑坏了，不是"干净"`);
    checkedPages++;

    for (const f of froms) {
      assert.equal(f, '/kit/index.js',
        `${rel} 深链了 ${f}。宿主页面只该从公开面 /kit/index.js 取东西 —— `
        + '深链会让它依赖库的内部结构：改一个目录名就静默 404，而表现只是「渲染超时」');
    }
    for (const n of kitNames(src)) {
      checkedNames++;
      assert.ok(n in pub,
        `${rel} 从公开面取了 ${n}，但 src/index.js 没有导出它 —— `
        + '要么把它加进公开面，要么页面不该用它（`boot` 曾经就是这样：页面要，公开面没有）');
    }
  }
  assert.ok(checkedNames > 0, '一个名字都没核到 —— 判据在空集上恒绿');
  assert.equal(checkedPages, PAGES.length, '有页面没被扫到');
});
