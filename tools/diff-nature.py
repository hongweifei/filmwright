# -*- coding: utf-8 -*-
"""判断差异的性质：抗锯齿/亚像素位移，还是真的内容不同。

做法：对两图轻微模糊后再比。抗锯齿差异会被抹平（平均差大幅下降），
真的内容差异（多一个元素、颜色不同）不会被抹平。
  用法：python tools/diff-nature.py <a.png> <b.png>
"""
import sys
from PIL import Image, ImageChops, ImageFilter
import statistics

a = Image.open(sys.argv[1]).convert('RGB')
b = Image.open(sys.argv[2]).convert('RGB')


def meandiff(x, y):
    d = ImageChops.difference(x, y).convert('L')
    px = list(d.get_flattened_data()) if hasattr(d, 'get_flattened_data') else list(d.getdata())
    return statistics.mean(px), sum(1 for v in px if v > 8) / len(px) * 100


m0, p0 = meandiff(a, b)
# 轻微模糊
ab = a.filter(ImageFilter.GaussianBlur(1.0))
bb = b.filter(ImageFilter.GaussianBlur(1.0))
m1, p1 = meandiff(ab, bb)
# 更强模糊
ab2 = a.filter(ImageFilter.GaussianBlur(2.0))
bb2 = b.filter(ImageFilter.GaussianBlur(2.0))
m2, p2 = meandiff(ab2, bb2)

# 位移测试：b 相对 a 平移 1 像素，看是否更接近
best = (m0, 0, 0)
for dx in (-1, 0, 1):
    for dy in (-1, 0, 1):
        if dx == 0 and dy == 0:
            continue
        shifted = ImageChops.offset(b, dx, dy)
        mm, _ = meandiff(a, shifted)
        if mm < best[0]:
            best = (mm, dx, dy)

print('原始            平均差 %6.2f   差>8 像素 %5.2f%%' % (m0, p0))
print('模糊 1px 后     平均差 %6.2f   差>8 像素 %5.2f%%' % (m1, p1))
print('模糊 2px 后     平均差 %6.2f   差>8 像素 %5.2f%%' % (m2, p2))
print('最佳 ±1 位移    平均差 %6.2f   (dx=%d, dy=%d)' % best)
print()
if m0 < 0.5:
    print('结论：几乎一致')
elif m2 < m0 * 0.35:
    print('结论：主要是抗锯齿 / 亚像素渲染差异（模糊后基本消失）—— 不是内容不同')
elif best[0] < m0 * 0.6:
    print('结论：主要是整体位移导致的（平移后明显更接近）')
else:
    print('结论：存在真实内容差异（模糊与平移都消不掉）')
