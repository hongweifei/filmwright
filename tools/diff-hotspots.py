# -*- coding: utf-8 -*-
"""差异热点定位：把画面切成 16x9 块，按平均差排序，指出差异集中在哪。
  用法：python tools/diff-hotspots.py <我方png> <原片png>
"""
import sys
from PIL import Image, ImageChops
import statistics

mine = Image.open(sys.argv[1]).convert('RGB')
orig = Image.open(sys.argv[2]).convert('RGB')
W, H = mine.size
d = ImageChops.difference(mine, orig).convert('L')

COLS, ROWS = 16, 9
cells = []
for gy in range(ROWS):
    for gx in range(COLS):
        box = (gx * W // COLS, gy * H // ROWS, (gx + 1) * W // COLS, (gy + 1) * H // ROWS)
        px = list(d.crop(box).get_flattened_data()) if hasattr(d, 'get_flattened_data') else list(d.crop(box).getdata())
        cells.append((statistics.mean(px), max(px), gx, gy, box))

cells.sort(reverse=True)
print('热点（按平均差排序，前 8 块）：')
for mean, mx, gx, gy, box in cells[:8]:
    print('  块(%2d,%d) 位置 x=%4d-%4d y=%4d-%4d  平均差 %6.2f 最大 %3d' % (
        gx, gy, box[0], box[2], box[1], box[3], mean, mx))

allpx = list(d.get_flattened_data()) if hasattr(d, 'get_flattened_data') else list(d.getdata())
print('\n整帧平均差 %.2f，其中 >8 的像素占 %.2f%%' % (
    statistics.mean(allpx), sum(1 for v in allpx if v > 8) / len(allpx) * 100))
