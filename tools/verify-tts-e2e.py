# -*- coding: utf-8 -*-
"""TTS 端到端验证：在临时项目上真跑一遍，用离线引擎产出配音与时间轴。

验四件事：
  1. 引擎回退链真的生效（edge 403 → 自动落到 sapi）
  2. 产出 audio.wav + timeline.json + timeline.md，且 timeline 里如实标注引擎与切分方式
  3. 时间轴自洽：句区间不重叠、字幕不重叠、字幕块落在句区间内、总帧数与音频时长一致
  4. 逐句缓存生效（第二次跑不重新合成）
"""
import json
import os
import shutil
import subprocess
import sys
import wave

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
SRC = os.path.join(ROOT, 'examples', 'scenecast')
PROJ = os.path.join(ROOT, '.work', 'tts-e2e')

bad = 0
def ok(c, m):
    global bad
    print(('✓ ' if c else '✗ ') + m)
    if not c: bad += 1

# 造一个精简项目（3 句、2 章），跑得快
shutil.rmtree(PROJ, ignore_errors=True)
shutil.copytree(SRC, PROJ)
# 换掉解说词，只留 3 句
with open(os.path.join(PROJ, 'script', 'narration.txt'), 'w', encoding='utf-8') as fh:
    fh.write('# CHAPTER 1 第一段\n')
    fh.write('这是第一句话。|它有两个字幕块。\n')
    fh.write('这是第二句话。\n')
    fh.write('\n')
    fh.write('# CHAPTER 2 第二段\n')
    fh.write('这是第三句话。\n')
# 用 auto 链（edge 不可用时应自动落到 sapi）
cfg_path = os.path.join(PROJ, 'film.config.mjs')
cfg = open(cfg_path, encoding='utf-8').read()
cfg = cfg.replace("tts: {engine: 'edge', voice: 'zh-CN-YunxiNeural', rate: '+0%'}",
                  "tts: {engine: 'auto', rate: '+0%'}")
open(cfg_path, 'w', encoding='utf-8').write(cfg)
# 清掉旧缓存与产物，确保是新合成的
for d in ['audio', 'public/assets/scenecast']:
    shutil.rmtree(os.path.join(PROJ, d), ignore_errors=True)

print('=== 1) 跑 tts（engine: auto）===')
r = subprocess.run([sys.executable, os.path.join(ROOT, 'src', 'host', 'tts', 'build.py'),
                    '--project', PROJ],
                   capture_output=True, text=True, encoding='utf-8', errors='replace',
                   env={**os.environ, 'PYTHONIOENCODING': 'utf-8'})
print('  退出码:', r.returncode)
if r.stdout:
    print('  stdout 末 3 行:')
    for l in r.stdout.strip().splitlines()[-3:]:
        print('   ', l)
if r.returncode != 0:
    print('  stderr:', (r.stderr or '')[:800])
ok(r.returncode == 0, 'tts 成功退出')

print()
print('=== 2) 产物三件套 ===')
wav = os.path.join(PROJ, 'public', 'assets', 'scenecast', 'audio.wav')
tlp = os.path.join(PROJ, 'script', 'timeline.json')
mdp = os.path.join(PROJ, 'script', 'timeline.md')
for p in (wav, tlp, mdp):
    ok(os.path.exists(p), '产出 %s' % os.path.basename(p))

tl = json.load(open(tlp, encoding='utf-8'))
print('  timeline 关键字段：engine=%s subs_timing=%s total_frames=%s sentences=%d chapters=%d'
      % (tl.get('engine'), tl.get('subs_timing'), tl.get('total_frames'),
         len(tl.get('sentences', [])), len(tl.get('chapters', []))))
ok(tl.get('engine') == 'sapi', '如实标注实际用的引擎是 sapi（回退链生效）')
ok(tl.get('subs_timing') == 'estimated', '如实标注字幕时间是估算（sapi 无词边界）')
ok('sapi' in (tl.get('engine_note') or ''), 'engine_note 说明用了哪个引擎：%s' % tl.get('engine_note'))

print()
print('=== 3) 音频参数 ===')
with wave.open(wav, 'rb') as w:
    ch, sw, fr, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
    dur = n / fr
print('  声道 %d 采样位 %d 采样率 %d 时长 %.2fs' % (ch, sw, fr, dur))
ok(ch == 2 and sw == 2 and fr == 48000, '输出统一为 48k 双声道 16bit（与既有渲染链一致）')
expect = tl['total_frames'] / tl['fps']
ok(abs(dur - expect) < 0.15, '音频时长 %.2fs 与时间轴 %.2fs 一致（差 %.3fs）' % (dur, expect, abs(dur - expect)))

print()
print('=== 4) 时间轴自洽性 ===')
sents = tl['sentences']
subs = tl['subs']
ok(all(s['from'] < s['to'] for s in sents), '每句 from < to')
ok(all(sents[i]['to'] < sents[i + 1]['from'] for i in range(len(sents) - 1)), '句与句不重叠')
ok(all(subs[i]['to'] < subs[i + 1]['from'] for i in range(len(subs) - 1)), '字幕块之间不重叠')
# 每个字幕块都要落在它所属句的区间内
inside = True
for s in sents:
    for sb in s['subs']:
        if not (s['from'] <= sb['from'] and sb['to'] <= s['to']):
            inside = False
            print('    越界：句 %s [%d,%d] 里的字幕块 [%d,%d]'
                  % (s['id'], s['from'], s['to'], sb['from'], sb['to']))
ok(inside, '每个字幕块都落在所属句区间内')
ok(len(subs) == 4, '字幕块数 = 4（第一句切了两块），实际 %d' % len(subs))
ok(len(tl['chapters']) == 2, '章节数 2，实际 %d' % len(tl['chapters']))
# 章节起点递增
ok(tl['chapters'][0]['from'] < tl['chapters'][1]['from'], '章节起点递增')

print()
print('=== 5) 逐句缓存：第二次跑不重新合成 ===')
cache_dir = os.path.join(PROJ, 'audio', 'cache')
before = sorted(os.listdir(cache_dir))
t_before = {f: os.path.getmtime(os.path.join(cache_dir, f)) for f in before}
import time
time.sleep(1.1)
r2 = subprocess.run([sys.executable, os.path.join(ROOT, 'src', 'host', 'tts', 'build.py'),
                     '--project', PROJ],
                    capture_output=True, text=True, encoding='utf-8', errors='replace',
                    env={**os.environ, 'PYTHONIOENCODING': 'utf-8'})
after = sorted(os.listdir(cache_dir))
t_after = {f: os.path.getmtime(os.path.join(cache_dir, f)) for f in after}
ok(r2.returncode == 0, '第二次跑也成功')
ok(before == after, '缓存文件数不变（%d → %d）' % (len(before), len(after)))
unchanged = all(t_before.get(f) == t_after.get(f) for f in before)
ok(unchanged, '所有缓存文件的修改时间未变（说明命中了缓存，没重新合成）')

print()
print('=== 6) 负面对照：引擎配置写错要说清可用值 ===')
cfg2 = open(cfg_path, encoding='utf-8').read().replace("engine: 'auto'", "engine: 'nope'")
open(cfg_path, 'w', encoding='utf-8').write(cfg2)
r3 = subprocess.run([sys.executable, os.path.join(ROOT, 'src', 'host', 'tts', 'build.py'),
                     '--project', PROJ],
                    capture_output=True, text=True, encoding='utf-8', errors='replace',
                    env={**os.environ, 'PYTHONIOENCODING': 'utf-8'})
open(cfg_path, 'w', encoding='utf-8').write(cfg)   # 还原
ok(r3.returncode != 0, '写错的引擎名应失败（退出码 %d）' % r3.returncode)
err = (r3.stderr or '') + (r3.stdout or '')
ok('可用' in err and 'nope' in err, '报错列出可用的引擎名：%s' % err.strip().splitlines()[-1][:100] if err.strip() else '(无输出)')

print()
print('=== 7) 负面对照：解说词文件不存在 ===')
os.rename(os.path.join(PROJ, 'script', 'narration.txt'), os.path.join(PROJ, 'script', 'n.bak'))
r4 = subprocess.run([sys.executable, os.path.join(ROOT, 'src', 'host', 'tts', 'build.py'),
                     '--project', PROJ],
                    capture_output=True, text=True, encoding='utf-8', errors='replace',
                    env={**os.environ, 'PYTHONIOENCODING': 'utf-8'})
os.rename(os.path.join(PROJ, 'script', 'n.bak'), os.path.join(PROJ, 'script', 'narration.txt'))
ok(r4.returncode != 0 and 'narration.txt' in ((r4.stderr or '') + (r4.stdout or '')),
   '缺解说词时报错并指出路径')

print()
print('（产物留在 %s，可人工查看）' % PROJ)
print('全部通过。' if bad == 0 else '%d 项失败。' % bad)
sys.exit(1 if bad else 0)
