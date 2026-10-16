// 照 README / 入门文档的路径走一遍，确认文档没写错。
// 覆盖：minimal 的快速开始（check + all + 文档里的 --static-only）、
// 以及 `filmwright new` 的脚手架冒烟（含「没时间轴时 check 报 NO_TIMELINE」的错误契约）。
//
// 2026-10-16：声明式入口（`scene.json` + 17 类模板）已删 ⇒ 原来那两段随之删掉：
//   · `schema` 命令已不存在（它当时靠 `SHOT_TYPES` 核「类型清单与实现一致」）；
//   · 另外五个纯 scene 示例（scenecast / gallery / three / promo / vertical）已从仓库删除，
//     现在只剩 `examples/minimal` —— 它的静态自检下面仍按文档真跑一遍。
// 用法: node tools/verify-readme.mjs
import {execFileSync} from 'node:child_process';
import {existsSync, mkdtempSync, readdirSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// 本文件在 <root>/tools/，所以根要往上两层
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KIT = join(ROOT, 'bin', 'filmwright.mjs');
const PROJ = join(ROOT, 'examples', 'minimal');

// execFileSync 返回的就是 stdout Buffer（没有 .stdout 属性）
const run = (args, opt = {}) => execFileSync('node', [KIT, ...args], {stdio: 'pipe', ...opt});
const step = (name, fn) => {
  process.stdout.write(`README 步骤 ${name} … `);
  try {
    fn();
    console.log('ok');
  } catch (e) {
    console.log('失败');
    console.log(String(e.stdout || '').slice(-2000));
    console.log(String(e.stderr || '').slice(-2000));
    process.exit(1);
  }
};

step('check', () => run(['check', '--project', PROJ]));
step('all', () => run(['all', '--project', PROJ, '--shards', '3']));

const out = join(PROJ, 'renders', 'minimal.mp4');
if (!existsSync(out)) {
  console.log('✗ README 说会产出 ' + out + '，但它不在');
  process.exit(1);
}
console.log(`产出 ${out}  ${(statSync(out).size / 1048576).toFixed(1)} MB`);

// 文档承诺 clone 后不跑 tts 也能做静态自检（`script/timeline.json` 是入库夹具）。
// 只剩 `minimal` 一个示例了：另外五个（scenecast / gallery / three / promo / vertical）
// 都是 scene.json 驱动的，已随声明式一起删掉 —— 这里刻意**不写示例清单**，
// 而是从 `examples/` 派生，免得下次加减示例又要改这里。
//
// ⚠️ 「是示例」的判据是**目录里有 `film.config.mjs`**，不是「是个目录」：
// 删示例时留下的空目录（`git rm` 只删跟踪的文件，删不掉目录本身）会被算进来，
// 而 `check` 对它必然报「找不到 film.config.mjs」—— 那是**假红**，不是示例坏了。
// 实测踩到：本机 `examples/scenecast/` 里还剩一个被占用的 `audio/cache`，
// 目录删不掉 ⇒ 不加这一条，本机永远红而 CI（干净检出）绿。跳过的目录要**报出来**。
const exRoot = join(ROOT, 'examples');
const dirs = readdirSync(exRoot, {withFileTypes: true}).filter((e) => e.isDirectory()).map((e) => e.name).sort();
const examples = dirs.filter((name) => existsSync(join(exRoot, name, 'film.config.mjs')));
const skipped = dirs.filter((name) => !examples.includes(name));
if (skipped.length) console.log(`（跳过不是项目的目录：${skipped.join(' ')} —— 里面没有 film.config.mjs）`);
if (!examples.includes('minimal')) {
  console.log(`✗ examples/ 下找不到 minimal（实际 ${JSON.stringify(examples)}）—— 枚举读错目录了`);
  process.exit(1);
}
for (const ex of examples) {
  step(`check --static-only（${ex}）`, () => run(['check', '--project', join(exRoot, ex), '--static-only']));
}

// new 冒烟：脚手架 + 错误契约一起验 —— 新项目没时间轴，check 必须报 NO_TIMELINE 而不是崩
step('new', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'fw-readme-'));
  try {
    const dir = join(tmp, 'my-film');
    const j = JSON.parse(run(['new', dir, '--json']).toString());
    if (!j.ok) throw new Error('new --json ok=false');
    let failed = null;
    try {
      run(['check', '--project', dir, '--static-only', '--json']);
    } catch (e) {
      failed = JSON.parse(e.stdout.toString());
    }
    if (!failed || failed.errors?.[0]?.code !== 'NO_TIMELINE') {
      throw new Error('新项目 check 应报 NO_TIMELINE，实际：' + JSON.stringify(failed));
    }
  } finally {
    rmSync(tmp, {recursive: true, force: true});
  }
});

console.log('\nREADME / 入门路径全部走通。');
