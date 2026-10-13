# -*- coding: utf-8 -*-
"""迁移验收：迁移后渲染的帧 vs 原片 mp4 的同一帧，算 PSNR。

原片是有损 h264，所以 PSNR 不会是无穷大；但它能证明「迁过来画面没走样」。
  用法：python tools/compare-original.py <迁移项目> <原片mp4> <帧号...>
"""
import io, os, subprocess, sys

PROJ = sys.argv[1]
MP4 = sys.argv[2]
FRAMES = [int(x) for x in sys.argv[3:]]

CMP = os.path.join(PROJ, '.work', 'cmp')
os.makedirs(CMP, exist_ok=True)

# 1. 用 filmwright 出静帧（一次调用，避免多次启动浏览器）
still_dir = os.path.join(CMP, 'still')
subprocess.run(['node', os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'bin', 'filmwright.mjs'),
                'stills', '--project', PROJ, '--frames', ','.join(str(f) for f in FRAMES),
                '--dir', still_dir], check=True, capture_output=True)

FPS = 30
print('帧号     时间(s)   PSNR(dB)   说明')
worst = None
for n in FRAMES:
    t = (n - 1) / FPS
    orig = os.path.join(CMP, 'orig_f%05d.png' % n)
    # **帧精确**取帧：用 select 滤镜，不要用 -ss。
    # -ss 放在 -i 前是快速定位，实测 5 个相邻时间点会取回同一帧 ——
    # 拿它做逐帧比对会得到"全都一样"的假结论。
    subprocess.run(['ffmpeg', '-v', 'error', '-i', MP4,
                    '-vf', 'select=eq(n\\,%d)' % (n - 1), '-vsync', '0',
                    '-frames:v', '1', orig, '-y'], check=True)
    mine = os.path.join(still_dir, 'f%05d.png' % n)
    if not os.path.exists(mine):
        print('%-7d %-9.2f 缺帧（没渲出来）' % (n, t))
        worst = 0
        continue
    r = subprocess.run(['ffmpeg', '-v', 'info', '-i', mine, '-i', orig,
                        '-lavfi', 'psnr', '-f', 'null', os.devnull],
                       capture_output=True, text=True)
    psnr = None
    for line in (r.stderr or '').split('\n'):
        if 'average:' in line:
            psnr = float(line.split('average:')[1].split()[0])
    if psnr is None:
        print('%-7d %-9.2f 算不出（两图尺寸不一致？）' % (n, t))
        worst = 0
        continue
    note = '一致' if psnr > 40 else ('接近' if psnr > 33 else '偏差大')
    print('%-7d %-9.2f %-10.2f %s' % (n, t, psnr, note))
    if worst is None or psnr < worst:
        worst = psnr

print()
if worst is None:
    print('没有可比帧')
    sys.exit(1)
print('最低 PSNR：%.2f dB' % worst)
if worst < 33:
    print('✗ 有帧偏差过大 —— 迁移后画面与原片不一致')
    sys.exit(1)
print('✓ 迁移后画面与原片一致（有损编码下 PSNR 均在 %.1f dB 以上）' % worst)
