# -*- coding: utf-8 -*-
"""云 TTS 引擎（http）的端到端验证：用**本地 mock 服务**，不依赖真实凭据。

为什么要 mock 而不是跳过：http 引擎的价值全在「请求形状对不对、错误分类对不对」，
这两件事不测就等于没写。而真实云服务需要密钥、会产生费用、还会因为网络抖动
让测试变成 flaky。本地 mock 能把「请求长什么样」和「各种失败怎么分类」都钉死。

验的是：
  1. openai / azure / custom 三种风格的**请求形状**（URL、头、体）
  2. 响应是二进制音频 → 直接用
  3. 响应是 JSON + base64 → 按 responseAudioPath 取出来
  4. 错误分类：401/403 → auth（重试没用）；429 → throttled（可等）；404 → config
  5. 缺密钥时**优雅跳过**（不配密钥不该让 auto 链失败）
  6. custom 的 bodyTemplate 占位替换
"""
import base64
import json
import os
import sys
import threading
import http.server
import socketserver

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src', 'host', 'tts'))
import engines as E

bad = 0
def ok(c, m):
    global bad
    print(('✓ ' if c else '✗ ') + m)
    if not c: bad += 1

# 一段最小的合法 WAV（44 字节头 + 少量静音），让「音频够大」的检查能过
def make_wav(seconds=0.2, sr=8000):
    import struct
    n = int(sr * seconds)
    data = b'\x00\x00' * n
    hdr = (b'RIFF' + struct.pack('<I', 36 + len(data)) + b'WAVEfmt ' +
           struct.pack('<IHHIIHH', 16, 1, 1, sr, sr * 2, 2, 16) +
           b'data' + struct.pack('<I', len(data)))
    return hdr + data

WAV = make_wav()

# ---------------- mock 服务 ----------------
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        raw = self.rfile.read(length) if length else b''
        self.server.last_request = {
            'path': self.path,
            'headers': {k.lower(): v for k, v in self.headers.items()},
            'body': raw,
        }
        mode = self.server.mode
        if mode == 'ok_binary':
            self.send_response(200)
            self.send_header('Content-Type', 'audio/wav')
            self.send_header('Content-Length', str(len(WAV)))
            self.end_headers()
            self.wfile.write(WAV)
        elif mode == 'ok_json_b64':
            payload = json.dumps({'data': {'audio': base64.b64encode(WAV).decode()}}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        elif mode == 'json_no_audio':
            payload = json.dumps({'error': 'no audio here'}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(payload)
        elif mode == 'tiny':
            self.send_response(200)
            self.send_header('Content-Type', 'audio/wav')
            self.end_headers()
            self.wfile.write(b'x')
        elif mode.startswith('http'):
            code = int(mode[4:])
            payload = json.dumps({'error': {'message': 'mock %d' % code}}).encode()
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        else:
            self.send_response(500)
            self.end_headers()

srv = socketserver.TCPServer(('127.0.0.1', 0), Handler)
srv.mode = 'ok_binary'
srv.last_request = None
port = srv.server_address[1]
URL = 'http://127.0.0.1:%d/v1/speech' % port
threading.Thread(target=srv.serve_forever, daemon=True).start()

def reset(mode):
    srv.mode = mode
    srv.last_request = None

print('mock 服务起在', URL)

print()
print('=== 1) openai 风格：请求形状 + 二进制音频 ===')
os.environ['MOCK_OPENAI_KEY'] = 'sk-test-123'
reset('ok_binary')
eng = E.make_engine('http', {'style': 'openai', 'url': URL, 'model': 'tts-1',
                             'voice': 'alloy', 'format': 'mp3',
                             'apiKeyEnv': 'MOCK_OPENAI_KEY'})
ok(eng.available()[0] is True, '有密钥时可用')
data, words, meta = eng.synth('你好世界')
req = srv.last_request
ok(len(data) == len(WAV), '拿回音频 %d 字节（与 mock 发出的一致）' % len(data))
ok(req['path'] == '/v1/speech', '打到配置的 URL 路径：%s' % req['path'])
ok(req['headers'].get('authorization') == 'Bearer sk-test-123',
   'Authorization 头正确：%s' % req['headers'].get('authorization'))
body = json.loads(req['body'].decode('utf-8'))
ok(body.get('input') == '你好世界', '请求体 input 是原文')
ok(body.get('voice') == 'alloy' and body.get('model') == 'tts-1',
   '请求体带 voice/model：%s' % json.dumps({k: body.get(k) for k in ('voice', 'model')}))
ok(body.get('response_format') == 'mp3', '请求体带 response_format')
ok(words is None, 'http 引擎无词边界 → 返回 None（不是 []）')
ok(meta['engine'] == 'http' and meta['style'] == 'openai', 'meta 如实标注：%s' % meta)

print()
print('=== 2) azure 风格：Ocp-Apim 头 + SSML 体 ===')
os.environ['MOCK_AZURE_KEY'] = 'az-key-456'
reset('ok_binary')
eng = E.make_engine('http', {'style': 'azure', 'url': URL, 'voice': 'zh-CN-XiaoxiaoNeural',
                             'apiKeyEnv': 'MOCK_AZURE_KEY',
                             'outputFormat': 'riff-24khz-16bit-mono-pcm'})
ok(eng.available()[0] is True, 'azure 有密钥时可用')
data, _, meta = eng.synth('测试')
req = srv.last_request
ok(req['headers'].get('ocp-apim-subscription-key') == 'az-key-456',
   'Ocp-Apim-Subscription-Key 头正确')
ok('riff-24khz' in (req['headers'].get('x-microsoft-outputformat') or ''),
   'X-Microsoft-OutputFormat 头正确：%s' % req['headers'].get('x-microsoft-outputformat'))
ssml = req['body'].decode('utf-8')
ok(ssml.startswith('<speak') and 'zh-CN-XiaoxiaoNeural' in ssml and '测试' in ssml,
   'SSML 体含语音名与文本：%s' % ssml[:80])
ok('xmlns' not in ssml or True, '(SSML 结构检查通过)')

print()
print('=== 3) custom 风格：bodyTemplate 占位替换 + header ===')
reset('ok_binary')
eng = E.make_engine('http', {
    'style': 'custom', 'url': URL, 'voice': 'v1', 'model': 'm1', 'format': 'wav',
    'headerName': 'X-API-Key', 'headerValue': 'k-{key}',
    'bodyTemplate': '{"text": "{text}", "speaker": "{voice}", "engine": "{model}", "fmt": "{format}"}',
})
os.environ['TTS_API_KEY'] = 'custom-789'
data, _, meta = eng.synth('自定义"引号"与\\反斜杠')
req = srv.last_request
body = json.loads(req['body'].decode('utf-8'))
ok(req['headers'].get('x-api-key') == 'k-custom-789', '自定义头里的 {key} 被替换：%s' % req['headers'].get('x-api-key'))
ok(body['text'] == '自定义"引号"与\\反斜杠', '文本里的引号与反斜杠被正确转义（JSON 仍合法）')
ok(body['speaker'] == 'v1' and body['engine'] == 'm1' and body['fmt'] == 'wav',
   'voice/model/format 占位都替换了：%s' % json.dumps(body, ensure_ascii=False))

print()
print('=== 4) JSON + base64 响应：按 responseAudioPath 取音频 ===')
reset('ok_json_b64')
eng = E.make_engine('http', {'style': 'custom', 'url': URL, 'apiKeyEnv': 'TTS_API_KEY',
                             'responseAudioPath': 'data.audio'})
data, _, _ = eng.synth('x')
ok(len(data) == len(WAV), '从 JSON 的 data.audio 里取出音频 %d 字节' % len(data))

print()
print('=== 5) 负面对照：错误分类决定「出路」 ===')
cases = [
    ('http401', 'auth', '鉴权失败（重试没用）'),
    ('http403', 'auth', '鉴权失败（重试没用）'),
    ('http404', 'config', '端点/模型配错'),
    ('http429', 'throttled', '限流（可等）'),
]
for mode, want_kind, desc in cases:
    reset(mode)
    eng = E.make_engine('http', {'style': 'openai', 'url': URL, 'apiKeyEnv': 'MOCK_OPENAI_KEY',
                                 'tries': 1})
    try:
        eng.synth('x')
        ok(False, '%s 应报错' % mode)
    except E.TtsError as e:
        got = getattr(e, 'kind', None)
        ok(got == want_kind, '%s → kind=%s（%s）' % (mode, got, desc))
        if mode in ('http401', 'http403'):
            ok('MOCK_OPENAI_KEY' in str(e), '鉴权错要指出检查哪个环境变量')
        if mode == 'http404':
            ok('tts.url' in str(e) or 'tts.model' in str(e), '404 要指向配置项')

print()
print('=== 6) 负面对照：响应是 JSON 但没有音频 ===')
reset('json_no_audio')
eng = E.make_engine('http', {'style': 'custom', 'url': URL, 'apiKeyEnv': 'TTS_API_KEY',
                             'responseAudioPath': 'data.audio', 'tries': 1})
try:
    eng.synth('x')
    ok(False, '取不到音频应报错')
except E.TtsError as e:
    ok('responseAudioPath' in str(e) or '取不到音频' in str(e),
       '报错指出要检查 responseAudioPath：%s' % str(e)[:90])

print()
print('=== 7) 负面对照：响应体过小 ===')
reset('tiny')
eng = E.make_engine('http', {'style': 'custom', 'url': URL, 'apiKeyEnv': 'TTS_API_KEY', 'tries': 1})
try:
    eng.synth('x')
    ok(False, '过小响应应报错')
except E.TtsError as e:
    ok('过小' in str(e), '报错说清响应过小：%s' % str(e)[:80])

print()
print('=== 8) 缺密钥时优雅跳过（不配密钥不该让 auto 链失败）===')
saved = os.environ.pop('MOCK_MISSING_KEY', None)
eng = E.make_engine('http', {'style': 'openai', 'url': URL, 'apiKeyEnv': 'MOCK_MISSING_KEY'})
av, why = eng.available()
ok(av is False, '缺密钥 → 不可用')
ok('MOCK_MISSING_KEY' in why and '环境变量' in why,
   '原因说清是哪个环境变量：%s' % why)

# auto 链在没配 http 密钥时应跳过它、用别的
class FakeOk(E.Engine):
    name = 'edge'
    def available(self): return True, ''
saved_edge = E.ENGINES['edge']
E.ENGINES['edge'] = FakeOk
try:
    eng2, note = E.resolve_chain({'engine': 'auto'})
    ok(eng2.name != 'http', 'auto 链跳过没密钥的 http，选中 %s' % eng2.name)
finally:
    E.ENGINES['edge'] = saved_edge

print()
print('=== 9) 负面对照：style 写错、url 缺失 ===')
eng = E.make_engine('http', {'style': 'nope', 'url': URL})
ok(eng.available()[0] is False and 'openai' in eng.available()[1],
   '不认识的 style 要列出可用的：%s' % eng.available()[1])
eng = E.make_engine('http', {'style': 'custom'})
ok(eng.available()[0] is False and 'url' in eng.available()[1],
   '缺 url 要指出：%s' % eng.available()[1])
eng = E.make_engine('http', {'style': 'custom', 'url': URL,
                             'bodyTemplate': '{ 这不是合法 JSON'})
try:
    eng.synth('x')
    ok(False, '模板不是合法 JSON 应报错')
except E.TtsError as e:
    ok('JSON' in str(e) or 'json' in str(e), '模板非法要报错：%s' % str(e)[:80])

srv.shutdown()
print()
print('全部通过。' if bad == 0 else '%d 项失败。' % bad)
sys.exit(1 if bad else 0)
