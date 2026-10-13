// 照 README / 入门文档的路径走一遍，确认文档没写错。
// 覆盖：minimal 的快速开始（check + all）、两个纯 scene 示例的静态自检、
// 以及 `filmwright new` 的脚手架冒烟（含「没时间轴时 check 报 NO_TIMELINE」的错误契约）。
// 用法: node tools/verify-readme.mjs
import {execFileSync} from 'node:child_process';
import {existsSync, mkdtempSync, rmSync, statSync} from 'node:fs';
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

// 纯规格示例：文档承诺 clone 后不跑 tts 也能 check（timeline.json 是入库夹具）
for (const ex of ['scenecast', 'gallery']) {
  step(`check --static-only（${ex}）`, () => run(['check', '--project', join(ROOT, 'examples', ex), '--static-only']));
}

// schema 命令：机器可读规格必须能解析且 13 类齐
step('schema', () => {
  const j = JSON.parse(run(['schema', '--json']).toString());
  if (!j.ok) throw new Error('schema --json ok=false');
  const n = Object.keys(j.data.schema.types).length;
  if (n !== 13) throw new Error(`schema 类型数 ${n}，不是 13`);
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
