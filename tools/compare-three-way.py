# -*- coding: utf-8 -*-
"""三方对比：原引擎渲染 / 迁移后渲染 / 原片 mp4。

这一步的意义：如果「原引擎 vs 原片 mp4」自己就差得远，说明 mp4 已经过期，
拿它当迁移的验收基线是错的。

用法（路径都由调用方给，不写死任何本机目录）：
  python tools/compare-three-way.py <原引擎静帧目录> <迁移后静帧目录> <抽帧目录> <帧号...>
"""
import os, subprocess, sys

if len(sys.argv) < 5:
    print(__doc__)
    sys.exit(2)

ORIG = sys.argv[1]                                  # 原引擎渲染
MINE = sys.argv[2]                                  # 迁移后渲染
MP4F = sys.argv[3]                                  # 从 mp4 抽的帧
FRAMES = [int(x) for x in sys.argv[4:]]


def psnr(a, b):
    r = subprocess.run(['ffmpeg', '-v', 'info', '-i', a, '-i', b,
                        '-lavfi', 'psnr', '-f', 'null', os.devnull],
                       capture_output=True, text=True)
    for line in (r.stderr or '').split('\n'):
        if 'average:' in line:
            return float(line.split('average:')[1].split()[0])
    return None


print('帧号    原引擎 vs mp4    迁移 vs 原引擎    迁移 vs mp4    结论')
for n in FRAMES:
    o = os.path.join(ORIG, 'f%05d.png' % n)
    m = os.path.join(MINE, 'f%05d.png' % n)
    p = os.path.join(MP4F, 'orig_f%05d.png' % n)
    a = psnr(o, p) if os.path.exists(o) and os.path.exists(p) else None
    b = psnr(m, o) if os.path.exists(m) and os.path.exists(o) else None
    c = psnr(m, p) if os.path.exists(m) and os.path.exists(p) else None
    concl = ''
    if a is not None and a < 33:
        concl = 'mp4 已过期，不能当基线'
    elif b is not None and b > 40:
        concl = '迁移一致（逐像素几乎相同）'
    elif b is not None and b > 33:
        concl = '迁移接近'
    elif b is not None:
        concl = '迁移有差异'
    f = lambda v: '  —  ' if v is None else '%6.2f' % v
    print('%-6d %s          %s            %s       %s' % (n, f(a), f(b), f(c), concl))
