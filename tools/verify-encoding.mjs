// 全仓扫描：有没有文件不是合法 UTF-8（含 BOM、非法字节），或换行风格不统一。
//
// 起因：我用 PowerShell 的 Add-Content 追加 .gitignore，它按系统默认编码（GBK）写，
// 中文注释变成了非法 UTF-8 —— 这类问题肉眼看不出来，必须用工具扫。
// 同一批操作还留下了一处 CRLF（仓库统一 LF），所以顺带一起查。
//
//   node tools/verify-encoding.mjs [<仓库根>]
//
// ⚠️ CI 里是**不带参数**跑的（`node tools/verify-encoding.mjs`）⇒ ROOT 必须有兜底，
// `resolve(undefined)` 会抛 ERR_INVALID_ARG_TYPE（CI 实测红过）。
//
// ── 它自己的负面对照（每次运行都跑，见文件末尾的 selfCheck()）────────────────────
// 审计口径：**一个永远绿的检查不是检查**。本工具守的四类性质（BOM / 非法 UTF-8 /
// UTF-16LE / 换行风格）在真仓库里恰好**全部成立** ⇒ 光看「跑绿」证明不了那些分支在工作：
// 把某一条判据整段删掉，真仓库照样绿。而它原来的判据全是「扫到东西才 push 问题」，
// 没有任何东西逼那些分支**真的报过一次**。
// 做法：在**临时目录**里造一批「各自只含一种缺陷」的文本 + 几个「必须放行」的文本，
// 用同一个 scan() 扫它，逐条要求：
//   · 造出来的每一种缺陷都被报出来（少一种 ⇒ 那条分支是死的）；
//   · 必须放行的文件**一个都不许报**（乱报 ⇒ 判据没有区分力）；
//   · 扫到的文件个数 == 造出来的个数（递归与扩展名过滤没漏）。
// 任何一条不满足 ⇒ 本工具自己失败（exit 1）。
// ⚠️ 临时物落在 os.tmpdir()，跑完即删；**绝不改真源码**（本仓曾两次把真文件改坏）。
// ⚠️ 另外补了一条下限断言：扫到 0 个文件也算失败 —— 空集上的「干净」不算干净。
import {mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, relative, resolve} from 'node:path';

// resolve() 保证 ROOT 是**绝对路径**：下面要用它拼相对路径，
// 相对路径会抛 ERR_INVALID_FILE_URL_PATH（CI 步骤里传 `.` 时踩到过）。
const ROOT = resolve(process.argv[2] ?? process.cwd()).replace(/\\/g, '/');
const SKIP_DIRS = new Set(['node_modules', '.git', '.work', 'renders', '__pycache__', 'out', 'qc']);
const TEXT_EXT = /\.(md|json|mjs|js|py|txt|yml|yaml|html|css|ts|ps1|gitignore|srt)$/i;
const NAMES = new Set(['.gitignore', 'LICENSE']);
// 这些文件允许 CRLF（Windows 专用脚本等）；其余统一 LF
const ALLOW_CRLF = /\.(ps1|bat|cmd)$/i;
// 第三方文件不动（字体许可证是随字体一起分发的，改它的换行没有意义）；
// 生成产物也不该由这里管（timeline.md 由 tts 生成，其换行取决于 python 的写入）。
// ⚠️ 字体许可证的路径写成 `fonts/LICENSE.md` 而**不带** `public/` 前缀：字体已从
// 「每个示例各存一份」收敛到库根一份，项目侧的 `public/fonts/` 只是可选的覆盖层。
// 这样两种位置都能豁免（`(^|\/)` 已经吃掉了前面的目录）。
const SKIP_EOL = /(^|\/)(fonts\/LICENSE\.md|script\/timeline\.md)$/;

// 问题种类做成机器可读的 kind（`why` 是给人看的）：负面对照要能**逐条**要求
// 「哪种缺陷必须被抓到」，而不是去匹配提示文案（文案一改对照就假绿）。
const KIND_NAME = {
  bom: 'UTF-8 BOM',
  utf8: '非法 UTF-8 字节',
  utf16: 'UTF-16LE 编码',
  'eol-crlf': '整文件 CRLF',
  'eol-mixed': 'CRLF/LF 混用',
  'eol-cr': '孤立 CR（\\r 后面不接 \\n）',
};

/** 扫一棵树。返回 {scanned, problems:[{rel, kind, why}]}。 */
const scan = (root) => {
  const problems = [];
  let scanned = 0;

  const walk = (dir) => {
    for (const e of readdirSync(dir, {withFileTypes: true})) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(join(dir, e.name));
        continue;
      }
      if (!(TEXT_EXT.test(e.name) || NAMES.has(e.name))) continue;
      const p = join(dir, e.name);
      const buf = readFileSync(p);
      scanned++;
      const rel = relative(root, p).replace(/\\/g, '/');

      // 1) BOM 检查（.ps1 需要 UTF-8 BOM 才能让 PowerShell 正确读中文）
      const hasBom = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
      if (hasBom && !e.name.endsWith('.ps1')) {
        problems.push({rel, kind: 'bom', why: '有 UTF-8 BOM（多数文件不该有）'});
      }

      // 2) 非法 UTF-8 字节
      const text = buf.toString('utf8');
      if (text.includes('\uFFFD')) {
        const idx = text.indexOf('\uFFFD');
        const line = text.slice(0, idx).split('\n').length;
        problems.push({rel, kind: 'utf8', why: `不是合法 UTF-8（第 ${line} 行附近）`});
      }

      // 3) UTF-16 的痕迹（PowerShell 重定向默认可能写 UTF-16LE）
      if (buf.length > 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
        problems.push({rel, kind: 'utf16', why: '是 UTF-16LE 编码'});
      }

      // 4) 换行风格：混用 CRLF 与 LF 是最容易出问题的情况（diff 里整文件变化）
      if (!ALLOW_CRLF.test(e.name) && !SKIP_EOL.test(rel)) {
        const crlf = (text.match(/\r\n/g) || []).length;
        const lf = (text.match(/\n/g) || []).length;
        const cr = (text.match(/\r/g) || []).length;
        if (cr > crlf) {
          // 孤立 CR（老 Mac 行尾）：此时 crlf 与 lf 可能都是 0，下面两条判据**完全看不见它**。
          problems.push({rel, kind: 'eol-cr', why: `有 ${cr - crlf} 处孤立 CR（\\r 后面不接 \\n）—— 仓库统一 LF`});
        } else if (crlf > 0 && crlf < lf) {
          problems.push({rel, kind: 'eol-mixed', why: `换行混用（CRLF ${crlf} 处 / LF 共 ${lf} 处）—— 仓库统一 LF`});
        } else if (crlf > 0 && crlf === lf) {
          problems.push({rel, kind: 'eol-crlf', why: '整个文件是 CRLF —— 仓库统一 LF'});
        }
      }
    }
  };

  walk(root);
  return {scanned, problems};
};

// ── 负面对照用的夹具（全是**缺陷字节本身**，不是实现里的常量）──────────────────
// 每个坏文件都只含**一种**缺陷 ⇒ 「哪一种没被报出来」可以直接定位到死掉的那条分支。
const BOM = Buffer.from([0xEF, 0xBB, 0xBF]);
const NEG_FIXTURES = [
  // 必须放行的：干净 LF 文件、.ps1（允许 BOM）、两个 SKIP_EOL 的豁免路径（允许 CRLF）
  {name: 'clean.md', bytes: Buffer.from('# 干净文件\n正文一行\n', 'utf8'), expect: []},
  {name: 'keep-bom.ps1', bytes: Buffer.concat([BOM, Buffer.from('Write-Host 中文\n', 'utf8')]), expect: []},
  {name: 'script/timeline.md', bytes: Buffer.from('# 生成产物\r\n允许 CRLF\r\n', 'utf8'), expect: []},
  {name: 'fonts/LICENSE.md', bytes: Buffer.from('# 字体许可证\r\n允许 CRLF\r\n', 'utf8'), expect: []},
  // 必须报出来的：每种缺陷各一份
  {name: 'bom.md', bytes: Buffer.concat([BOM, Buffer.from('# 带 BOM 的标题\n', 'utf8')]), expect: ['bom']},
  {name: 'gbk.md', bytes: Buffer.from([0xD6, 0xD0, 0xCE, 0xC4, 0x0A]), expect: ['utf8']},   // GBK 的「中文」
  {name: 'utf16le.md', bytes: Buffer.from([0xFF, 0xFE, 0x61, 0x00, 0x62, 0x00]), expect: ['utf8', 'utf16']},
  {name: 'crlf.md', bytes: Buffer.from('a\r\nb\r\n', 'utf8'), expect: ['eol-crlf']},
  {name: 'mixed.md', bytes: Buffer.from('a\nb\r\nc\n', 'utf8'), expect: ['eol-mixed']},
  {name: 'cr-only.md', bytes: Buffer.from('a\rb\r', 'utf8'), expect: ['eol-cr']},
];

// 临时目录登记 + 清理。⚠️ try/finally 挡不住 SIGINT/SIGTERM（Node 默认直接终止、不走 finally），
// 所以除了正常路径，还挂 exit 与两个信号钩子。
const TMP_DIRS = [];
const dropTmp = () => {
  while (TMP_DIRS.length) {
    const d = TMP_DIRS.pop();
    try { rmSync(d, {recursive: true, force: true}); } catch { /* 删不掉也只是临时目录里的残留 */ }
  }
};
process.on('exit', dropTmp);
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.on(sig, () => { dropTmp(); process.exit(code); });
}

/** 在临时目录里造缺陷，要求 scan() 如实报出来。返回失败原因列表（空 = 对照通过）。 */
const selfCheck = () => {
  const dir = mkdtempSync(join(tmpdir(), 'fw-encoding-neg-'));
  TMP_DIRS.push(dir);
  for (const f of NEG_FIXTURES) {
    const p = join(dir, f.name);
    mkdirSync(dirname(p), {recursive: true});
    writeFileSync(p, f.bytes);
  }

  const fails = [];
  const got = scan(dir.replace(/\\/g, '/'));
  if (got.scanned !== NEG_FIXTURES.length) {
    fails.push(`只扫到 ${got.scanned} 个对照文件、造了 ${NEG_FIXTURES.length} 个 —— 递归或扩展名过滤漏了`);
  }
  for (const f of NEG_FIXTURES) {
    const kinds = new Set(got.problems.filter((p) => p.rel === f.name).map((p) => p.kind));
    const want = new Set(f.expect);
    for (const k of want) if (!kinds.has(k)) fails.push(`${f.name}：缺陷「${KIND_NAME[k]}」没被抓到`);
    for (const k of kinds) if (!want.has(k)) fails.push(`${f.name}：不该报的「${KIND_NAME[k]}」被报了`);
  }
  dropTmp();
  return fails;
};

const {scanned, problems} = scan(ROOT);
console.log(`扫描了 ${scanned} 个文本文件`);
if (problems.length) {
  console.log(`✗ 发现 ${problems.length} 个编码问题：`);
  for (const p of problems) console.log(`   ${p.rel}：${p.why}`);
} else if (scanned === 0) {
  console.log(`✗ 一个文本文件都没扫到（ROOT=${ROOT}）—— 空集上的「干净」不算干净`);
} else {
  console.log('✓ 全部是合法 UTF-8，无 BOM 问题');
}

const selfFails = selfCheck();
if (selfFails.length) {
  console.log(`✗ 负面对照不通过（${selfFails.length} 条）：本工具的判据有死分支，绿不代表干净`);
  for (const f of selfFails) console.log(`   ${f}`);
} else {
  const nBad = NEG_FIXTURES.filter((f) => f.expect.length).length;
  console.log(`✓ 负面对照：造了 ${NEG_FIXTURES.length} 个文件（${nBad} 个有缺陷、`
    + `${NEG_FIXTURES.length - nBad} 个必须放行），该报的都报了、不该报的没误报`);
}

process.exit(problems.length || scanned === 0 || selfFails.length ? 1 : 0);
