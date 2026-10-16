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
import {readFileSync, readdirSync} from 'node:fs';
import {join, relative} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

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

// 不参与「必须有入口」的模块：它们是**实现细节**，不是「不想公开」。
// 规则一句话：**拆过的地方，API 是它的桶** —— 桶只转出的那些名字就是那一块的能力面，
// 底下的部件模块只是实现（它们 `export` 是为了让兄弟模块 import，不是给人用的）。
const IMPL_ONLY = new Set([
  // 桶是 runtime/composite/layer.js（公开面从那里转出 BLEND_MODES / isValidTransform）；
  // contract 侧的 BLENDS（Set）与 TRANSFORM_HINT（报错文案）是内部表，不给镜头用。
  'src/contract/composite.js',
  // `err()` 是内部错误构造器；错误码的公开面是 contract/errorCodes.js 的 ERROR_CODES。
  'src/contract/errors.js',
  'src/runtime/fx/shaders.js',      // 14 段 GLSL 源码：入口是 compileEffects / applyEffects
  'src/runtime/fx/stage.js',        // GpuStage 类：同上
]);

test('公开面覆盖能力面：`contract/` + `runtime/` 里每个具名导出都要有入口', async () => {
  // 把审计的度量（「去重导出 175 个，只有 96 个可达」）变成**常驻判据**。
  // 度量的意义是「整块能力没有入口」⇒ 判据按**名字**判可达（同名多实现的，名字有入口即可）。
  // ⚠️ 用 `fileURLToPath` + `relative` 算相对路径：手拼 `ROOT + '/'` 会因为 ROOT 自带尾斜杠
  // 变成 `//`，于是下面那张排除表**一条都匹配不上**（实测踩过：判据把该排除的部件全报成「没入口」）。
  const ROOT = fileURLToPath(new URL('..', import.meta.url));
  const relOf = (f) => relative(ROOT, f).replace(/\\/g, '/');
  const walk = (d) => readdirSync(d, {withFileTypes: true})
    .flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  const files = [...walk(join(ROOT, 'src/contract')), ...walk(join(ROOT, 'src/runtime'))]
    .filter((f) => /\.(js|mjs)$/.test(f))
    .filter((f) => !IMPL_ONLY.has(relOf(f)));

  // 下限：枚举坏了就不算通过（「空集上的干净不算干净」）
  assert.ok(files.length >= 20, `只扫到 ${files.length} 个模块 —— 枚举坏了`);

  const pub = await import('../src/index.js');
  const unreachable = [];
  let total = 0;
  for (const f of files) {
    const m = await import(pathToFileURL(f).href);
    for (const n of Object.keys(m)) {
      if (n === 'default') continue;
      total++;
      if (!(n in pub)) unreachable.push(`${f.replace(/\\/g, '/').split('/src/')[1]} 的 ${n}`);
    }
  }
  assert.ok(total >= 100, `只核到 ${total} 个导出 —— 枚举坏了`);
  assert.deepEqual(unreachable, [],
    '这些能力**没有入口**（要么加进 src/index.js，要么它本来该是模块私有、不该 export）：\n'
    + unreachable.join('\n'));
});
