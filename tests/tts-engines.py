# -*- coding: utf-8 -*-
"""TTS 引擎层的行为验证：回退链、可用性判定、无词边界时的返回约定。

从仓库根或 tests/ 下都能跑（路径按 __file__ 定位，不依赖 cwd）。
由 tools/run-python-tests.mjs 接进 `npm test`；没装 python/numpy 时优雅跳过。
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src', 'host', 'tts'))
import engines as E

bad = 0
def ok(c, m):
    global bad
    print(('✓ ' if c else '✗ ') + m)
    if not c: bad += 1

print('=== 1) 引擎注册表 ===')
ok(set(E.ENGINES) == {'edge', 'sapi', 'http', 'command'},
   '注册了 edge / sapi / http / command：%s' % sorted(E.ENGINES))
try:
    E.make_engine('nope', {})
    ok(False, '不认识的引擎应报错')
except E.TtsError as e:
    ok('可用' in str(e) and 'nope' in str(e), '不认识的引擎报错并列出可用的：%s' % str(e)[:80])

print()
print('=== 2) 可用性判定（不实际合成）===')
e_edge = E.make_engine('edge', {})
av_edge, why_edge = e_edge.available()
print('  edge 探测结果：%s（%s）' % (av_edge, why_edge or 'ok'))
ok(e_edge.has_word_boundary is True, 'edge 有词边界')
ok(isinstance(av_edge, bool), 'edge.available() 真探连通性并返回布尔（不只看装了包）')
e_sapi = E.make_engine('sapi', {})
av, why = e_sapi.available()
ok(av is True, 'sapi 可用（Windows 自带）：%s' % (why or 'ok'))
ok(e_sapi.has_word_boundary is False, 'sapi **没有**词边界（上层据此选估算策略）')
e_cmd = E.make_engine('command', {})
ok(e_cmd.available()[0] is False, 'command 没配 command 时不可用')
e_cmd2 = E.make_engine('command', {'command': 'echo x > {out}'})
ok(e_cmd2.available()[0] is True, 'command 配了就可用')

print()
print('=== 3) 回退链：配置 ["edge","sapi"] ===')
# 3a) 用「可用但合成失败」的假 edge：验证**合成期**失败也会回退
class FakeEdgeFail(E.Engine):
    name = 'edge'
    has_word_boundary = True
    def available(self): return True, ''
    def synth(self, text): raise E.TtsError('假装 403', kind='unavailable')

saved = E.ENGINES['edge']
E.ENGINES['edge'] = FakeEdgeFail
try:
    eng, note = E.resolve_chain({'engine': ['edge', 'sapi'], 'voice': ''})
    ok(eng.name == 'edge', '合成期才失败时，resolve_chain 仍选 edge（回退发生在实际合成时）')
    # 真回退由 build 层做：它捕获 TtsError 后换下一个引擎。这里验引擎本身的行为。
    try:
        eng.synth('x')
        ok(False, '假 edge 应抛错')
    except E.TtsError as e:
        ok(e.kind == 'unavailable', '抛出的错带 kind=unavailable（上层据此决定换引擎）：%s' % e.kind)
finally:
    E.ENGINES['edge'] = saved

# 3b) 用「不可用」的假 edge：验证 resolve_chain 直接跳过它
class FakeEdgeDown(E.Engine):
    name = 'edge'
    def available(self): return False, '假装 403 不可用'

E.ENGINES['edge'] = FakeEdgeDown
try:
    eng, note = E.resolve_chain({'engine': ['edge', 'sapi'], 'voice': ''})
    ok(eng.name == 'sapi', 'edge 不可用时应直接落到 sapi，实际 %s' % eng.name)
    print('    说明：', note)
finally:
    E.ENGINES['edge'] = saved

# 3c) 真实环境：edge 的可用性探测结果（我这边应是不可用 → 自动降级）
eng_real, note_real = E.resolve_chain({'engine': 'auto', 'voice': ''})
print('    真实 auto 链选中：%s（%s）' % (eng_real.name, note_real))
ok(eng_real.name in ('edge', 'sapi', 'command'), 'auto 链总能选出可用的引擎')

print()
print('=== 4) 全不可用时的报错要**逐条说明原因** ===')
class Dead(E.Engine):
    name = 'edge'
    def available(self): return False, '假装没装'

E.ENGINES['dead'] = Dead
try:
    E.resolve_chain({'engine': 'dead'})
    ok(False, '全不可用应报错')
except E.TtsError as e:
    msg = str(e)
    ok('不可用' in msg and '假装没装' in msg, '报错列出每个引擎为什么不行：%s' % msg.replace('\n', ' ')[:100])
    ok(e.kind == 'unavailable', 'kind 标为 unavailable（上层据此给「换引擎」的出路）')
finally:
    del E.ENGINES['dead']

print()
print('=== 5) 语速换算：+20% → SAPI 的 2 档 ===')
cases = [('+0%', 0), ('+20%', 2), ('-20%', -2), ('+100%', 10), ('-100%', -10), ('+999%', 10), ('乱写', 0)]
for rate, want in cases:
    got = E._rate_to_sapi(rate)
    ok(got == want, '%s → %d（期望 %d）' % (rate, got, want))

print()
print('=== 6) SAPI 真的能合成一句话（端到端，离线）===')
try:
    data, words, meta = e_sapi.synth('离线合成测试。')
    ok(len(data) > 1000, '产出音频 %d 字节' % len(data))
    ok(words is None, '无词边界时返回 None（不是 [] —— 两者处理不同）')
    ok(meta['engine'] == 'sapi' and meta['format'] == 'wav', 'meta 如实标注引擎与格式：%s' % meta)
except E.TtsError as e:
    ok(False, 'SAPI 合成失败：%s' % e)

print()
print('=== 7) SAPI 音色列表 ===')
vs = e_sapi.voices()
ok(len(vs) >= 1, '列出 %d 个音色：%s' % (len(vs), [v['id'] for v in vs][:3]))

print()
print('=== 8) command 引擎：真跑一条命令 ===')
import tempfile
with tempfile.TemporaryDirectory() as td:
    out = os.path.join(td, 'o.wav')
    # 用 ffmpeg 造一段静音当「TTS 的输出」
    cmd = 'ffmpeg -y -v error -f lavfi -i anullsrc=r=48000:cl=mono -t 0.3 {out}'
    eng = E.make_engine('command', {'command': cmd})
    try:
        data, words, meta = eng.synth('随便')
        ok(len(data) > 100, 'command 产出 %d 字节，format=%s' % (len(data), meta['format']))
        ok(words is None, 'command 无词边界 → None')
    except E.TtsError as e:
        ok(False, 'command 失败：%s' % e)

print()
print('=== 9) 负面对照：command 失败要说清退出码与输出 ===')
eng = E.make_engine('command', {'command': 'exit 3'})
try:
    eng.synth('x')
    ok(False, '失败命令应报错')
except E.TtsError as e:
    ok('退出码' in str(e), '报错含退出码：%s' % str(e)[:80])

print()
print('=== 10) 负面对照：command 产出过小文件要被拦住 ===')
eng = E.make_engine('command', {'command': 'echo hi > {out}'})
try:
    eng.synth('x')
    ok(False, '过小产物应报错')
except E.TtsError as e:
    ok('过小' in str(e), '报错说清过小：%s' % str(e)[:80])

print()
print(('全部通过。' if bad == 0 else '%d 项失败。' % bad))
sys.exit(1 if bad else 0)
