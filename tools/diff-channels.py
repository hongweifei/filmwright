# -*- coding: utf-8 -*-
"""看差异的"颜色构成"：分区算 R/G/B 三通道的带符号平均差。

如果某个通道系统性偏移，说明是**颜色值**不同；
如果三通道都在 0 附近随机抖动，那是抗锯齿/位置差异。
  用法：python tools/diff-channels.py <a.png> <b.png>
"""
import sys
from PIL import Image
import statistics

a = Image.open(sys.argv[1]).convert('RGB')
b = Image.open(sys.argv[2]).convert('RGB')

REGIONS = [
    ('报错面板', (812, 200, 1204, 406)),
    ('代码块',   (76, 186, 766, 420)),
    ('标题',     (300, 110, 980, 170)),
    ('整帧',     (0, 0, a.size[0], a.size[1])),
]

print('区域        R 带符号均差   G 带符号均差   B 带符号均差   |差|>8 占比')
for name, box in REGIONS:
    ca = a.crop(box)
    cb = b.crop(box)
    pa = list(ca.get_flattened_data()) if hasattr(ca, 'get_flattened_data') else list(ca.getdata())
    pb = list(cb.get_flattened_data()) if hasattr(cb, 'get_flattened_data') else list(cb.getdata())
    dr = [pa[i][0] - pb[i][0] for i in range(len(pa))]
    dg = [pa[i][1] - pb[i][1] for i in range(len(pa))]
    db = [pa[i][2] - pb[i][2] for i in range(len(pa))]
    big = sum(1 for i in range(len(pa))
              if abs(dr[i]) > 8 or abs(dg[i]) > 8 or abs(db[i]) > 8) / len(pa) * 100
    print('%-10s %13.2f %14.2f %14.2f %11.2f%%' % (
        name, statistics.mean(dr), statistics.mean(dg), statistics.mean(db), big))
