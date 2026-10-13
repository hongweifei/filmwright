# -*- coding: utf-8 -*-
"""生成示例用的素材图：一条胶片（5 格）。

为什么不用文字：图片里画字要依赖字体，而这张图是**夹具**，
换个机器字体不同就会让像素基准备不住。所以只用几何图形。

用法：python tools/make-sample-asset.py <输出png>
"""
import sys
from PIL import Image, ImageDraw

W, H = 640, 160
BG = (10, 14, 24)
FRAME = (20, 30, 48)
ACC = [(63, 167, 255), (139, 92, 246), (53, 208, 127), (34, 211, 238), (245, 185, 66)]

im = Image.new('RGB', (W, H), BG)
d = ImageDraw.Draw(im, 'RGBA')

pad = 10
fw = (W - pad * (len(ACC) + 1)) // len(ACC)
for i, col in enumerate(ACC):
    x0 = pad + i * (fw + pad)
    y0 = 34
    y1 = H - 34
    d.rounded_rectangle([x0, y0, x0 + fw, y1], radius=6,
                        fill=FRAME, outline=(col[0], col[1], col[2], 200), width=2)
    # 每格里的「内容」按序号递增地填 —— 表示"帧号决定画面"
    fill_w = int((fw - 16) * (i + 1) / len(ACC))
    d.rectangle([x0 + 8, y1 - 14, x0 + 8 + fill_w, y1 - 6],
                fill=(col[0], col[1], col[2], 255))

# 齿孔
for i in range(len(ACC) + 1):
    x = pad // 2 + i * (fw + pad)
    for y in (10, H - 18):
        d.rounded_rectangle([x, y, x + 6, y + 8], radius=2, fill=(70, 84, 110, 255))

im.save(sys.argv[1])
print('已生成', sys.argv[1], im.size)
