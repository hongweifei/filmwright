// 全仓扫描：有没有文件不是合法 UTF-8（含 BOM、非法字节），或换行风格不统一。
//
// 起因：我用 PowerShell 的 Add-Content 追加 .gitignore，它按系统默认编码（GBK）写，
// 中文注释变成了非法 UTF-8 —— 这类问题肉眼看不出来，必须用工具扫。
// 同一批操作还留下了一处 CRLF（仓库统一 LF），所以顺带一起查。
import {readdirSync, readFileSync} from 'node:fs';
import {join, relative} from 'node:path';

const ROOT = process.argv[2].replace(/\\/g, '/');
const SKIP_DIRS = new Set(['node_modules', '.git', '.work', 'renders', '__pycache__', 'out', 'qc']);
const TEXT_EXT = /\.(md|json|mjs|js|py|txt|yml|yaml|html|css|ts|ps1|gitignore|srt)$/i;
const NAMES = new Set(['.gitignore', 'LICENSE']);
// 这些文件允许 CRLF（Windows 专用脚本等）；其余统一 LF
const ALLOW_CRLF = /\.(ps1|bat|cmd)$/i;
// 第三方文件不动（字体许可证是随字体一起分发的，改它的换行没有意义）；
// 生成产物也不该由这里管（timeline.md 由 tts 生成，其换行取决于 python 的写入）。
const SKIP_EOL = /(^|\/)(public\/fonts\/LICENSE\.md|script\/timeline\.md)$/;

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
    const rel = relative(ROOT, p).replace(/\\/g, '/');

    // 1) BOM 检查（.ps1 需要 UTF-8 BOM 才能让 PowerShell 正确读中文）
    const hasBom = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
    if (hasBom && !e.name.endsWith('.ps1')) {
      problems.push({rel, why: '有 UTF-8 BOM（多数文件不该有）'});
    }

    // 2) 非法 UTF-8 字节
    const text = buf.toString('utf8');
    if (text.includes('\uFFFD')) {
      const idx = text.indexOf('\uFFFD');
      const line = text.slice(0, idx).split('\n').length;
      problems.push({rel, why: `不是合法 UTF-8（第 ${line} 行附近）`});
    }

    // 3) UTF-16 的痕迹（PowerShell 重定向默认可能写 UTF-16LE）
    if (buf.length > 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
      problems.push({rel, why: '是 UTF-16LE 编码'});
    }

    // 4) 换行风格：混用 CRLF 与 LF 是最容易出问题的情况（diff 里整文件变化）
    if (!ALLOW_CRLF.test(e.name) && !SKIP_EOL.test(rel)) {
      const crlf = (text.match(/\r\n/g) || []).length;
      const lf = (text.match(/\n/g) || []).length;
      if (crlf > 0 && crlf < lf) {
        problems.push({rel, why: `换行混用（CRLF ${crlf} 处 / LF 共 ${lf} 处）—— 仓库统一 LF`});
      } else if (crlf > 0 && crlf === lf) {
        problems.push({rel, why: '整个文件是 CRLF —— 仓库统一 LF'});
      }
    }
  }
};

walk(ROOT);
console.log(`扫描了 ${scanned} 个文本文件`);
if (problems.length === 0) {
  console.log('✓ 全部是合法 UTF-8，无 BOM 问题');
} else {
  console.log(`✗ 发现 ${problems.length} 个编码问题：`);
  for (const p of problems) console.log(`   ${p.rel}：${p.why}`);
}
process.exit(problems.length ? 1 : 0);
