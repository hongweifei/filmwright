// 照 README / 入门文档的路径走一遍，确认文档没写错。
// 覆盖：minimal 的快速开始（check + all）、两个纯 scene 示例的静态自检、
// 以及 `filmwright new` 的脚手架冒烟（含「没时间轴时 check 报 NO_TIMELINE」的错误契约）。
// 用法: node tools/verify-readme.mjs
import {execFileSync} from 'node:child_process';
import {existsSync, mkdtempSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
// **从实现里读类型清单**，不在工具里硬编码数字 —— 这里曾经写着 `n !== 13`，
// 而类型已经涨到 18，于是这个"守卫"一直在失败（它从没进过 CI，所以没人发现）。
// 数字从实现读，加类型时它才跟得上。
import {SHOT_TYPES} from '../src/contract/scene.js';

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

// 纯规格示例：文档承诺 clone 后不跑 tts 也能 check（timeline.json 是入库夹具）
// `three` 也一样满足（它是纯 scene.json 项目，静态自检**不需要** three 这个可选依赖）。
// `promo` / `vertical` 之前**落在所有检查之外** —— 这一条是盘点 examples/ 时补上的。
for (const ex of ['scenecast', 'gallery', 'three', 'promo', 'vertical']) {
  step(`check --static-only（${ex}）`, () => run(['check', '--project', join(ROOT, 'examples', ex), '--static-only']));
}

// schema 命令：机器可读规格必须能解析，且**类型清单与实现一致**
// （这里曾经硬编码 `n !== 13`，类型涨到 18 之后它一直在失败 —— 而它从没进过 CI）
step('schema', () => {
  const j = JSON.parse(run(['schema', '--json']).toString());
  if (!j.ok) throw new Error('schema --json ok=false');
  const got = Object.keys(j.data.schema.types).sort();
  const want = [...SHOT_TYPES].sort();
  if (got.join(',') !== want.join(',')) {
    throw new Error(`schema 类型清单与实现不一致：\n  实现 ${want.length} 类：${want.join(' ')}\n  输出 ${got.length} 类：${got.join(' ')}`);
  }
});

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
