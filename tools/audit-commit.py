# -*- coding: utf-8 -*-
"""提交前审计：1) 机器专属路径泄漏  2) 体积  3) 该忽略的是否真被忽略

用法：git add -A && python tools/audit-commit.py
"""
import io, os, re, subprocess, sys

# 仓库根 = 本文件所在 tools/ 的上级（不写死绝对路径）
R = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 审计脚本自己会命中它自己的规则（正则里写着 "Projects"、"dsh-memory-video" 这些
# 用来找泄漏的样例）。跳过自身，否则每次都要人工忽略这几条假阳性。
SELF = os.path.relpath(os.path.abspath(__file__), R).replace('\\', '/')


def git(*a):
    p = subprocess.run(['git'] + list(a), cwd=R, capture_output=True)
    return p.stdout.decode('utf-8', 'replace')


files = [f for f in git('diff', '--cached', '--name-only').split('\n') if f.strip()]
print('暂存文件 %d 个\n' % len(files))

# 1. 机器专属路径
#    注意：「程序安装位置」不是机器专属 —— 一个找浏览器的列表本来就该写
#    C:/Program Files/...，那是跨机器通用的常量。真正要抓的是**这台机器的**路径：
#    用户主目录、项目目录、具体端口、以及被写进源码的缓存位置。
PAT = re.compile(
    r'[A-Za-z]:[\\/](Users|Projects)[\\/]'      # C:/Users/... 或 D:/Projects/...
    r'|/Users/[^/\s]+/|/home/[^/\s]+/'
    r'|localhost:\d{4,}|127\.0\.0\.1:\d{4,}'    # 具体端口（每次运行都不同）
    r'|dsh-memory-video|node_modules/\.remotion'  # 跨项目缓存依赖
)
INSTALL_DIR_OK = re.compile(r'Program Files( \(x86\))?/[A-Za-z]+/[A-Za-z]+/')

hits = []
for f in files:
    if f == SELF:
        continue          # 审计脚本自己：正则里就有这些样例
    p = os.path.join(R, f)
    if not os.path.exists(p) or f.endswith(('.ttf', '.otf', '.woff2')):
        continue
    try:
        text = io.open(p, encoding='utf-8').read()
    except (UnicodeDecodeError, OSError):
        continue
    for i, line in enumerate(text.split('\n'), 1):
        if PAT.search(line) and not INSTALL_DIR_OK.search(line):
            hits.append('%s:%d  %s' % (f, i, line.strip()[:110]))

if hits:
    print('⚠ 机器专属路径 %d 处：' % len(hits))
    for h in hits[:20]:
        print('   ' + h)
else:
    print('✓ 没有机器专属路径')

# 2. 体积
print('\n各文件体积（前 10）：')
rows = []
for f in files:
    p = os.path.join(R, f)
    if os.path.exists(p):
        rows.append((os.path.getsize(p), f))
rows.sort(reverse=True)
total = sum(s for s, _ in rows)
for s, f in rows[:10]:
    print('  %8.2f MB  %s' % (s / 1048576, f))
print('  ----')
print('  合计 %.1f MB' % (total / 1048576))

# 3. 不该进来的
print('\n检查不该提交的东西：')
bad = [f for f in files if re.search(r'(^|/)(out|qc|renders)/|audio\.wav|node_modules|audio/cache', f)]
print('  ' + ('✓ 没有产物/缓存/音频' if not bad else '⚠ 混进了：' + ', '.join(bad[:10])))

sys.exit(1 if (hits or bad) else 0)
