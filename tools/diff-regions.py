# -*- coding: utf-8 -*-
"""定位差异区域：把画面按功能区切开，算每块的平均绝对差。
  用法：python tools/diff-regions.py <我方png> <原片png>
"""
import sys
from PIL import Image, ImageChops
import statistics

mine = Image.open(sys.argv[1]).convert('RGB')
orig = Image.open(sys.argv[2]).convert('RGB')
W, H = mine.size
diff = ImageChops.difference(mine, orig)

REGIONS = [
    ('顶部 HUD',    (0, 0, W, 105)),
    ('内容区',      (60, 110, W - 60, H - 230)),
    ('字幕带',      (0, H - 230, W, H - 40)),
    ('底部进度条',  (0, H - 40, W, H)),
    ('左边缘',      (0, 105, 60, H - 230)),
    ('右边缘',      (W - 60, 105, W, H - 230)),
]
print('区域          平均差   最大差  不同像素占比')
for name, box in REGIONS:
    d = diff.crop(box).convert('L')
    px = list(d.get_flattened_data()) if hasattr(d, 'get_flattened_data') else list(d.getdata())
    mean = statistics.mean(px)
    mx = max(px)
    changed = sum(1 for v in px if v > 8) / len(px)
    print('%-12s %8.2f %8d %9.2f%%' % (name, mean, mx, changed * 100))

# 整体
allpx = list(diff.convert('L').get_flattened_data()) if hasattr(diff, 'get_flattened_data') else list(diff.convert('L').getdata())
print('整帧          %8.2f %8d %9.2f%%' % (
    statistics.mean(allpx), max(allpx),
    sum(1 for v in allpx if v > 8) / len(allpx) * 100))
