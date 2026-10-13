# -*- coding: utf-8 -*-
"""逐个比对原引擎与 filmwright 的绘制原语，找出行为差异。

迁移压测里发现某些帧有 ~1% 像素差，而 text()/panel() 已确认逐字相同。
这里把其余导出原语都比一遍。
  用法：python tools/compare-primitives.py <原 lib/draw.js> <filmwright primitives.js>
"""
import io, re, sys

A = sys.argv[1]
B = sys.argv[2]

ta = io.open(A, encoding='utf-8').read()
tb = io.open(B, encoding='utf-8').read()


def fns(text):
    """抽出顶层 function 定义（含 export）。"""
    out = {}
    for m in re.finditer(r'(?:export\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(', text):
        name = m.group(1)
        start = m.start()
        # 取到下一个顶层 function / export 或文件尾
        nxt = re.search(r'\n(?:export\s+)?function\s+', text[m.end():])
        end = m.end() + nxt.start() if nxt else len(text)
        out[name] = text[start:end]
    return out


fa, fb = fns(ta), fns(tb)
print('原 %d 个函数 / filmwright %d 个函数' % (len(fa), len(fb)))
print()
onlyA = sorted(set(fa) - set(fb))
onlyB = sorted(set(fb) - set(fa))
if onlyA:
    print('只在原引擎里有：', ', '.join(onlyA))
if onlyB:
    print('只在 filmwright 里有：', ', '.join(onlyB))
print()

diff = []
for name in sorted(set(fa) & set(fb)):
    a = re.sub(r'\s+', ' ', fa[name]).strip()
    b = re.sub(r'\s+', ' ', fb[name]).strip()
    if a != b:
        diff.append(name)
        print('=== %s 不同 ===' % name)
        # 逐行找第一处不同，给出上下文
        la = [l.rstrip() for l in fa[name].split('\n')]
        lb = [l.rstrip() for l in fb[name].split('\n')]
        for i in range(max(len(la), len(lb))):
            x = la[i] if i < len(la) else '<无>'
            y = lb[i] if i < len(lb) else '<无>'
            if x != y:
                print('  原   %s' % x.strip()[:110])
                print('  新版 %s' % y.strip()[:110])
        print()

same = len(set(fa) & set(fb)) - len(diff)
print('相同 %d 个，不同 %d 个' % (same, len(diff)))
