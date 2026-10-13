# -*- coding: utf-8 -*-
"""在给定的小矩形上比差异，用来区分「平坦填充区」与「文字区」。

  用法：python tools/diff-probe.py <a.png> <b.png> <name:x0,y0,x1,y1> ...
"""
import sys
from PIL import Image
import statistics

a = Image.open(sys.argv[1]).convert('RGB')
b = Image.open(sys.argv[2]).convert('RGB')

for spec in sys.argv[3:]:
    name, box = spec.split(':')
    x0, y0, x1, y1 = (int(v) for v in box.split(','))
    ca, cb = a.crop((x0, y0, x1, y1)), b.crop((x0, y0, x1, y1))
    pa = list(ca.get_flattened_data()) if hasattr(ca, 'get_flattened_data') else list(ca.getdata())
    pb = list(cb.get_flattened_data()) if hasattr(cb, 'get_flattened_data') else list(cb.getdata())
    diffs = [abs(pa[i][c] - pb[i][c]) for i in range(len(pa)) for c in range(3)]
    big = sum(1 for d in diffs if d > 8) / len(diffs) * 100
    print('%-16s (%4d,%4d)-(%4d,%4d)  平均差 %6.2f  最大 %3d  >8 占 %5.2f%%' % (
        name, x0, y0, x1, y1, statistics.mean(diffs), max(diffs), big))
