// 全仓扫描：有没有文件不是合法 UTF-8（含 BOM 或非法字节）。
// 起因：我用 PowerShell 的 Add-Content 追加 .gitignore，它按 GBK 写，
// 中文注释变成了非法 UTF-8 —— 这类问题肉眼看不出来，必须用工具扫。
import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join, relative} from 'node:path';

const ROOT = process.argv[2].replace(/\\/g, '/');
const SKIP_DIRS = new Set(['node_modules', '.git', '.work', 'renders', '__pycache__', 'out', 'qc']);
const TEXT_EXT = /\.(md|json|mjs|js|py|txt|yml|yaml|html|css|ts|ps1|gitignore|srt)$/i;
const NAMES = new Set(['.gitignore', 'LICENSE']);

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

    // 1) BOM 检查（多数文件不该有 BOM；但 .ps1 需要 UTF-8 BOM 才能正确读中文）
    const hasBom = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
    if (hasBom && !e.name.endsWith('.ps1')) {
      problems.push({rel, why: '有 UTF-8 BOM（多数文件不该有）'});
    }

    // 2) 非法 UTF-8 字节
    const text = buf.toString('utf8');
    if (text.includes('\uFFFD')) {
      // 找出第一处非法字节的位置，便于定位
      const idx = text.indexOf('\uFFFD');
      const line = text.slice(0, idx).split('\n').length;
      problems.push({rel, why: `不是合法 UTF-8（第 ${line} 行附近）`});
    }

    // 3) UTF-16 的痕迹（PowerShell 重定向默认可能写 UTF-16LE）
    if (buf.length > 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
      problems.push({rel, why: '是 UTF-16LE 编码'});
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
