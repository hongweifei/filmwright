# -*- coding: utf-8 -*-
"""把一块区域渲染成 ASCII 亮度图，用来"看"差异（无图形界面时也能比对）。

  用法：python tools/ascii-region.py <png> <x0,y0,x1,y1> [cols]
"""
import sys
from PIL import Image

path = sys.argv[1]
x0, y0, x1, y1 = (int(v) for v in sys.argv[2].split(','))
cols = int(sys.argv[3]) if len(sys.argv) > 3 else 64

im = Image.open(path).convert('L').crop((x0, y0, x1, y1))
w, h = im.size
rows = max(1, int(cols * h / w / 2))     # 字符高宽比约 2:1
im = im.resize((cols, rows))
px = list(im.get_flattened_data()) if hasattr(im, 'get_flattened_data') else list(im.getdata())
RAMP = ' .:-=+*#%@'
print('  %s  (%d,%d)-(%d,%d)  灰度(取整/26):' % (path.split('\\')[-1], x0, y0, x1, y1))
for r in range(rows):
    line = ''.join(RAMP[min(9, px[r * cols + c] // 26)] for c in range(cols))
    print('    |' + line + '|')
