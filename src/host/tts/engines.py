# -*- coding: utf-8 -*-
"""TTS 引擎层：把「用哪个引擎合成一句话」抽象出来。

## 为什么需要这一层

原先只有 edge-tts 一条路，而它是**联网服务、会整段不可用**（实测撞上过 403：
`WSServerHandshakeError: 403`，同时 voices 端点正常返回 —— 微软侧故障，不是本机问题）。
配音一旦不可用，带解说的片子就完全做不了，等于框架一半能力废掉。

所以引擎要可换，并且**能按顺序回退**：

    edge（首选，神经音色最好）
      ↓ 不可用
    sapi（Windows 系统自带，完全离线）
      ↓ 不可用
    command（逃生舱：任何命令行 TTS 都能接，如 piper / 自训模型）
      ↓
    file（你自己录/自己产好音频，框架只负责对时间轴）

## 词边界是引擎能力的差别，不是「有/无」那么简单

edge 会给 WordBoundary（每个词的起始秒与时长），所以字幕块能**精确**对齐到词。
其他引擎大多没有，只能按字数比例估算。这个差别会传给上层（`has_word_boundary`），
让时间轴生成选择不同的切分策略，并在 timeline.json 里如实标注
（`subs_timing: "word" | "estimated"`）—— 使用者的字幕切换点是否精确，不该靠猜。
"""
import base64
import json
import os
import shutil
import subprocess
import sys
import time


class TtsError(Exception):
    """合成失败。带上「该怎么办」的出路，不要只抛一个异常名。

    `kind` 让上层能给出**不同的**出路（这是实测出来的需求）：
      - 'unavailable'：服务不可用（403 / 握手失败）→ 重试没用，要换引擎或等
      - 'throttled'  ：限流 / 超时 / 空音频 → 等一会儿或放慢 pace
      - 'config'     ：配置写错 → 改配置
      - 'engine'     ：引擎自身失败 → 看引擎输出
    """

    def __init__(self, message, kind='engine'):
        super().__init__(message)
        self.kind = kind


class Engine:
    """引擎基类。子类实现 `synth(text) -> (pcm_float32, words, meta)`。"""

    name = 'base'
    has_word_boundary = False

    def __init__(self, cfg, log=None):
        self.cfg = cfg
        self.log = log or (lambda *a: None)

    def available(self):
        """本机能不能用（不实际合成）。返回 (bool, 原因)。"""
        return False, '未实现'

    def voices(self):
        """可用音色列表（诊断用）。返回 [{id, name, gender, locale}]。"""
        return []

    def synth(self, text):
        """合成一句话。

        返回 (pcm, words, meta)：
          pcm    float32 numpy 数组，单声道，采样率见 self.sample_rate
          words  [{t, d, text}]；无词边界时返回 None（不是空列表 —— 空列表表示
                 「有词边界但一个都没拿到」，两者的处理不同）
          meta   {engine, voice, cached}
        """
        raise NotImplementedError

    sample_rate = 48000


# ---------------------------------------------------------------- edge（联网）

class EdgeEngine(Engine):
    """微软 edge-tts。音质最好，但**会整段不可用**（403），所以必须有后备。

    `available()` 会**真的探一次连通性**（合成一个极短音节）——
    只看「包装了没」是不够的：实测 `import edge_tts` 成功、`list_voices()` 也正常，
    但合成一律 403。那种情况下如果判成「可用」，回退链就永远不会生效，
    使用者拿到的是一句 403 而不是「已自动降级到离线引擎」。
    """

    name = 'edge'
    has_word_boundary = True
    sample_rate = 48000

    def __init__(self, cfg, log=None):
        super().__init__(cfg, log=log)
        # 连通性探测结果（None = 还没探过）。同一实例只探一次。
        self._probe = None

    def available(self):
        try:
            import edge_tts  # noqa: F401
        except ImportError:
            return False, '没装 edge-tts（pip install edge-tts）'
        # 探一次真合成。缓存结果：同一进程里问多次不必反复联网
        # （时间轴会为每句问一次「用哪个引擎」，不缓存就是每句多一次网络往返）。
        if self._probe is None:
            self._probe = self._probe_synth()
        return self._probe

    def _probe_synth(self):
        import asyncio
        import edge_tts

        async def go():
            try:
                comm = edge_tts.Communicate('测', self.cfg.get('voice', 'zh-CN-YunxiNeural'),
                                            connect_timeout=10, receive_timeout=15)
                n = 0
                async for ch in comm.stream():
                    if ch['type'] == 'audio':
                        n += len(ch['data'])
                        if n > 2000:
                            return True
                return n > 0, '探针拿到 0 字节音频'
            except Exception as e:
                why = '%s: %s' % (type(e).__name__, str(e)[:80])
                return False, why
        ok, why = asyncio.run(go())
        return (True, '') if ok else (False, why)

    def voices(self):
        import asyncio
        import edge_tts

        async def go():
            try:
                return await edge_tts.list_voices()
            except Exception as e:
                raise TtsError('取音色列表失败：%s: %s' % (type(e).__name__, str(e)[:120]))
        vs = asyncio.run(go())
        return [{'id': v['ShortName'], 'name': v.get('FriendlyName', ''),
                 'gender': v.get('Gender', ''), 'locale': v.get('Locale', '')} for v in vs]

    def synth(self, text):
        import asyncio
        import edge_tts

        voice = self.cfg.get('voice', 'zh-CN-YunxiNeural')
        rate = self.cfg.get('rate', '+0%')
        tries = int(self.cfg.get('tries', 8))

        async def go():
            why = ''
            for attempt in range(1, tries + 1):
                audio, words = bytearray(), []
                try:
                    comm = edge_tts.Communicate(
                        text, voice, rate=rate, boundary='WordBoundary',
                        connect_timeout=15, receive_timeout=25)

                    async def collect():
                        async for ch in comm.stream():
                            if ch['type'] == 'audio':
                                audio.extend(ch['data'])
                            elif ch['type'] == 'WordBoundary':
                                words.append({'t': ch['offset'] / 1e7,
                                              'd': ch['duration'] / 1e7,
                                              'text': ch['text']})

                    await asyncio.wait_for(collect(), timeout=40)
                    if audio:
                        return bytes(audio), words
                    why = '端点返回空音频'
                except TypeError:
                    raise TtsError("edge-tts 过旧：pip install 'edge-tts==7.2.8'")
                except asyncio.TimeoutError:
                    why = '超时'
                except Exception as e:
                    why = '%s: %s' % (type(e).__name__, str(e))
                if attempt < tries:
                    back = min(8.0, 1.2 * attempt)
                    self.log('  edge-tts 第 %d/%d 次失败（%s），等 %.1fs' % (attempt, tries, why, back))
                    await asyncio.sleep(back)
            # 区分「服务不可用」与「限流」——出路完全不同
            unavailable = ('403' in why) or ('Handshake' in why) or ('WSServerHandshake' in why)
            kind = 'unavailable' if unavailable else 'throttled'
            raise TtsError('edge-tts 试了 %d 次仍拿不到音频（%s）' % (tries, why), kind=kind)

        mp3, words = asyncio.run(go())
        return mp3, words, {'engine': 'edge', 'voice': voice, 'format': 'mp3'}


# ---------------------------------------------------------------- sapi（离线）

class SapiEngine(Engine):
    """Windows 系统自带语音（System.Speech）。**完全离线**，用于 edge 不可用时兜底。

    局限（必须让使用者知道）：
      - 音质是「桌面合成」水平，明显不如 edge 的神经音色；
      - **没有词边界** → 字幕块时间只能按字数比例估算（timeline.json 会标 estimated）；
      - 采样率 22050Hz 单声道（上游会重采样，不影响成片）。
    """

    name = 'sapi'
    has_word_boundary = False
    sample_rate = 22050

    def _powershell(self):
        return shutil.which('powershell') or shutil.which('pwsh')

    def available(self):
        if sys.platform != 'win32':
            return False, 'SAPI 只在 Windows 上可用'
        ps = self._powershell()
        if not ps:
            return False, '找不到 powershell'
        try:
            vs = self.voices()
        except TtsError as e:
            return False, str(e)
        if not vs:
            return False, '系统里没有安装任何语音'
        return True, ''

    def voices(self):
        ps = self._powershell()
        script = ('Add-Type -AssemblyName System.Speech\n'
                  '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer\n'
                  '$s.GetInstalledVoices() | ForEach-Object {\n'
                  '  $i = $_.VoiceInfo\n'
                  '  "$($i.Name)|$($i.Culture)|$($i.Gender)"\n'
                  '}\n')
        path = _write_ps1(script)
        try:
            r = subprocess.run([ps, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path],
                               capture_output=True, text=True, errors='replace')
            if r.returncode != 0:
                raise TtsError('列出 SAPI 语音失败：%s' % (r.stderr or '')[:200])
            out = []
            for line in (r.stdout or '').splitlines():
                parts = line.strip().split('|')
                if len(parts) == 3 and parts[0]:
                    out.append({'id': parts[0], 'name': parts[0],
                                'gender': parts[2], 'locale': parts[1]})
            return out
        finally:
            _rm(path)

    def synth(self, text):
        ps = self._powershell()
        voice = self.cfg.get('voice') or ''
        rate = self.cfg.get('rate', '+0%')
        # SAPI 的 Rate 是 -10..10 的整数，不是百分比。这里做个换算，
        # 免得配置里写 '+0%' 传进去变成非法值（SAPI 会静默用 0，看不出问题）。
        sapi_rate = _rate_to_sapi(rate)

        script = ('param([string]$Text, [string]$Out, [string]$Voice, [int]$Rate)\n'
                  'Add-Type -AssemblyName System.Speech\n'
                  '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer\n'
                  'if ($Voice -ne "") { $s.SelectVoice($Voice) }\n'
                  '$s.Rate = $Rate\n'
                  '$s.SetOutputToWaveFile($Out)\n'
                  '$s.Speak($Text)\n'
                  '$s.Dispose()\n')
        path = _write_ps1(script)
        out_wav = path + '.out.wav'
        try:
            args = [ps, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path,
                    '-Text', text, '-Out', out_wav, '-Voice', voice, '-Rate', str(sapi_rate)]
            r = subprocess.run(args, capture_output=True, text=True, errors='replace')
            if r.returncode != 0 or not os.path.exists(out_wav):
                raise TtsError('SAPI 合成失败：%s' % ((r.stderr or '').strip()[:300] or '没有产出文件'))
            with open(out_wav, 'rb') as fh:
                data = fh.read()
            if len(data) < 100:
                raise TtsError('SAPI 产出的音频过小（%d 字节），可能这句没读出声音' % len(data))
            # 无词边界：明确返回 None（不是 []）——上层据此选估算策略
            return data, None, {'engine': 'sapi', 'voice': voice or '(默认)',
                                'format': 'wav', 'sapi_rate': sapi_rate}
        finally:
            _rm(path)
            _rm(out_wav)


# ------------------------------------------------------------ command（逃生舱）

class CommandEngine(Engine):
    """用任意命令行 TTS 合成：模板里用 {out} 与 {text_file} 占位。

    存在的意义：不让框架绑死在某一个 TTS 上。piper、自训模型、公司内部服务
    都能接进来 —— 框架只要求「给我一个音频文件」，其余交给命令。

    cfg:
      command  必需，如 'piper --model zh.onnx --output_file {out} < {text_file}'
      format   'wav' | 'mp3'（默认按扩展名猜）
    """

    name = 'command'
    has_word_boundary = False
    sample_rate = 48000

    def available(self):
        cmd = self.cfg.get('command')
        if not cmd:
            return False, '没配 tts.command'
        return True, ''

    def synth(self, text):
        cmd = self.cfg.get('command') or ''
        if not cmd:
            raise TtsError('tts.command 没配：写一条能产出音频的命令，'
                           '用 {out} 与 {text_file} 占位', kind='config')
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            text_file = os.path.join(td, 'text.txt')
            out_file = os.path.join(td, 'out.wav')
            with open(text_file, 'w', encoding='utf-8') as fh:
                fh.write(text)
            line = cmd.replace('{out}', _q(out_file)).replace('{text_file}', _q(text_file))
            r = subprocess.run(line, shell=True, capture_output=True, text=True, errors='replace')
            if r.returncode != 0 or not os.path.exists(out_file):
                raise TtsError('tts.command 失败（退出码 %d）：%s'
                               % (r.returncode, ((r.stderr or '') + (r.stdout or '')).strip()[:300]))
            with open(out_file, 'rb') as fh:
                data = fh.read()
            if len(data) < 100:
                raise TtsError('tts.command 产出的音频过小（%d 字节）' % len(data))
            return data, None, {'engine': 'command', 'voice': self.cfg.get('voice', ''),
                                'format': self.cfg.get('format') or _ext_format(out_file)}


# ------------------------------------------------------------ http（云 TTS）

class HttpEngine(Engine):
    """通用 HTTP TTS：把请求发出去、把音频拿回来。适配常见的云服务。

    为什么做成一等公民而不是让你写 `command` 调 curl：
      - **凭据走环境变量**，不写进配置（配置会进 git，密钥不该进 git）；
      - 常见服务的请求形状差别很大，但都是「POST JSON → 拿音频字节」，
        用 `style` 预设覆盖，不必每家写一份代码；
      - 失败时能区分「鉴权失败（401/403，要检查密钥）」与「限流（429，等一等）」
        与「服务端错（5xx，重试可能有用）」—— 出路完全不同。

    ## 配置

        tts: {
          engine: 'http',
          style: 'openai',            // 'openai' | 'azure' | 'custom'
          // 密钥从环境变量读（不写在这里）。变量名可自定义：
          apiKeyEnv: 'OPENAI_API_KEY',
          // 可选覆盖端点与模型/音色
          url: 'https://api.openai.com/v1/audio/speech',
          model: 'tts-1',
          voice: 'alloy',
          format: 'mp3',
        }

    ## 预设的请求形状

    | style | 方法 | 端点 | 请求体 | 鉴权 |
    |---|---|---|---|---|
    | `openai` | POST | `{url}`（默认 OpenAI speech） | `{model, input, voice, response_format}` | `Authorization: Bearer {key}` |
    | `azure` | POST | `{url}`（你的区域端点，含 `X-Microsoft-OutputFormat`） | SSML 或纯文本 | `Ocp-Apim-Subscription-Key: {key}` |
    | `custom` | POST | `{url}` | `{bodyTemplate}` 渲染后的 JSON | `{headerName}: {headerValue}` |

    `custom` 用 `{text}` / `{voice}` / `{model}` / `{format}` 占位，
    音频既可以直接是响应体（默认），也可以是 JSON 里的 base64
    （`responseAudioPath: 'data.audio'`）。
    """

    name = 'http'
    has_word_boundary = False     # 通用实现不保证有词边界；下面有需要时可加
    sample_rate = 48000

    def available(self):
        cfg = self.cfg
        style = cfg.get('style', 'openai')
        if style not in ('openai', 'azure', 'custom'):
            return False, '不认识的 style「%s」；可用：openai / azure / custom' % style
        url = self._url()
        if not url:
            return False, '没配 tts.url（或用 style 的默认端点）'
        if style != 'custom':
            key = self._key()
            if not key:
                return False, ('没读到 API 密钥：环境变量 %s 是空的。'
                               '密钥只从环境变量读（不写进配置 —— 配置会进 git）'
                               % self._key_env())
        return True, ''

    def _key_env(self):
        return self.cfg.get('apiKeyEnv') or {
            'openai': 'OPENAI_API_KEY',
            'azure': 'AZURE_SPEECH_KEY',
            'custom': 'TTS_API_KEY',
        }.get(self.cfg.get('style', 'openai'), 'TTS_API_KEY')

    def _key(self):
        return os.environ.get(self._key_env(), '').strip()

    def _url(self):
        if self.cfg.get('url'):
            return self.cfg['url']
        style = self.cfg.get('style', 'openai')
        if style == 'openai':
            return 'https://api.openai.com/v1/audio/speech'
        return ''

    def _request(self, text):
        """构造 (url, headers, body_bytes)。拆出来便于单测（不必真发请求）。"""
        style = self.cfg.get('style', 'openai')
        url = self._url()
        voice = self.cfg.get('voice') or {'openai': 'alloy'}.get(style, '')
        fmt = self.cfg.get('format') or ('mp3' if style == 'openai' else 'wav')
        model = self.cfg.get('model') or {'openai': 'tts-1'}.get(style, '')

        if style == 'openai':
            headers = {'Content-Type': 'application/json',
                       'Authorization': 'Bearer ' + self._key()}
            body = {'model': model or 'tts-1', 'input': text,
                    'voice': voice or 'alloy', 'response_format': fmt}
        elif style == 'azure':
            headers = {'Content-Type': 'application/ssml+xml',
                       'X-Microsoft-OutputFormat': self.cfg.get('outputFormat')
                       or 'riff-24khz-16bit-mono-pcm',
                       'Ocp-Apim-Subscription-Key': self._key()}
            # Azure 的语音名在 SSML 的 voice 里
            ssml_voice = voice or 'zh-CN-XiaoxiaoNeural'
            body = ('<speak version="1.0" xml:lang="zh-CN"><voice name="%s">%s</voice></speak>'
                    % (ssml_voice, _xml_escape(text)))
            return url, headers, body.encode('utf-8'), 'ssml'
        else:  # custom
            headers = {'Content-Type': 'application/json'}
            hn = self.cfg.get('headerName')
            if hn:
                headers[hn] = str(self.cfg.get('headerValue', '')).replace('{key}', self._key())
            tmpl = self.cfg.get('bodyTemplate') or '{"text": "{text}"}'
            raw = (tmpl.replace('{text}', _json_escape(text))
                       .replace('{voice}', _json_escape(voice))
                       .replace('{model}', _json_escape(model))
                       .replace('{format}', _json_escape(fmt)))
            # 先验证是合法 JSON（配置写错要当场报）。
            # **必须包成 TtsError**：直接抛 JSONDecodeError 的话，上层只会看到
            # 一个没有出路的异常名（实测就是这么漏出去的）。
            try:
                body = json.loads(raw)
            except ValueError as e:
                raise TtsError('tts.bodyTemplate 渲染后不是合法 JSON：%s\n  渲染结果：%s'
                               % (e, raw[:200]), kind='config')
        return url, headers, json.dumps(body, ensure_ascii=False).encode('utf-8'), 'json'

    def synth(self, text):
        import urllib.error
        import urllib.request

        url, headers, body, _kind = self._request(text)
        tries = int(self.cfg.get('tries', 3))
        timeout = float(self.cfg.get('timeout', 60))
        why = ''
        for attempt in range(1, tries + 1):
            try:
                req = urllib.request.Request(url, data=body, headers=headers, method='POST')
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    data = resp.read()
                    ctype = resp.headers.get('Content-Type', '')
                if len(data) < 100 and not (data[:1] == b'{'):
                    # 注意判据顺序：**先看是不是 JSON**，再看大小。
                    # 「JSON 但取不到音频」与「响应太小」是两种完全不同的错，
                    # 前者要检查 responseAudioPath，后者是服务端异常 ——
                    # 实测把它们混在一起报「响应体过小（26 字节）」，误导排查方向。
                    why = '响应体过小（%d 字节）' % len(data)
                elif 'json' in ctype or data[:1] == b'{':
                    # 有些服务把音频放在 JSON 里（base64）
                    data2 = self._extract_from_json(data)
                    if data2 is None:
                        why = ('响应是 JSON 但取不到音频（检查 tts.responseAudioPath，'
                               '当前为 %r）：%s'
                               % (self.cfg.get('responseAudioPath') or 'data', data[:160]))
                    else:
                        return data2, None, {'engine': 'http', 'voice': self.cfg.get('voice', ''),
                                             'format': self.cfg.get('format') or 'mp3',
                                             'style': self.cfg.get('style', 'openai')}
                elif len(data) < 100:
                    why = '响应体过小（%d 字节）' % len(data)
                else:
                    return data, None, {'engine': 'http', 'voice': self.cfg.get('voice', ''),
                                        'format': self.cfg.get('format') or _guess_format(ctype),
                                        'style': self.cfg.get('style', 'openai')}
            except urllib.error.HTTPError as e:
                detail = ''
                try:
                    detail = e.read().decode('utf-8', 'replace')[:200]
                except Exception:
                    pass
                why = 'HTTP %d %s' % (e.code, detail)
                # 鉴权失败重试没用 —— 立刻抛，并说清要检查什么
                if e.code in (401, 403):
                    raise TtsError('TTS 服务拒绝鉴权（%s）：检查环境变量 %s 是否正确、'
                                   '是否已过期、以及该密钥有没有这个服务的权限'
                                   % (why, self._key_env()), kind='auth')
                if e.code == 404:
                    raise TtsError('TTS 端点不存在（%s）：检查 tts.url 与 tts.model'
                                   % why, kind='config')
                if e.code == 429:
                    why = '限流（429）：%s' % detail
            except Exception as e:
                why = '%s: %s' % (type(e).__name__, str(e)[:150])
            if attempt < tries:
                back = min(8.0, 1.5 * attempt)
                self.log('  http 第 %d/%d 次失败（%s），等 %.1fs' % (attempt, tries, why, back))
                time.sleep(back)
        kind = 'throttled' if '429' in why else 'engine'
        raise TtsError('TTS 服务试了 %d 次仍失败（%s）' % (tries, why), kind=kind)

    def _extract_from_json(self, data):
        """从 JSON 响应里取音频（base64）。路径由 responseAudioPath 指定，如 'data.audio'。"""
        try:
            j = json.loads(data.decode('utf-8'))
        except Exception:
            return None
        path = self.cfg.get('responseAudioPath') or 'data'
        cur = j
        for part in path.split('.'):
            if isinstance(cur, dict) and part in cur:
                cur = cur[part]
            elif isinstance(cur, list) and part.isdigit() and int(part) < len(cur):
                cur = cur[int(part)]
            else:
                return None
        if not isinstance(cur, str):
            return None
        try:
            return base64.b64decode(cur)
        except Exception:
            return None

    def voices(self):
        # 通用实现不枚举音色：各服务的列表端点与形状都不一样，猜不如让用户查文档。
        # 但把**当前配置会用到的音色**报出来，至少能确认配置读到了。
        v = self.cfg.get('voice')
        return [{'id': v, 'name': v, 'gender': '', 'locale': ''}] if v else []


def _xml_escape(s):
    return (s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
             .replace('"', '&quot;').replace("'", '&apos;'))


def _json_escape(s):
    """把文本塞进 JSON 模板里时转义（只转必要字符，避免破坏模板结构）。"""
    return (str(s).replace('\\', '\\\\').replace('"', '\\"')
            .replace('\n', '\\n').replace('\r', '\\r').replace('\t', '\\t'))


def _guess_format(content_type):
    ct = (content_type or '').lower()
    if 'mpeg' in ct or 'mp3' in ct:
        return 'mp3'
    if 'wav' in ct or 'x-wav' in ct:
        return 'wav'
    if 'ogg' in ct or 'opus' in ct:
        return 'ogg'
    return 'mp3'


# ------------------------------------------------------------------ 注册与回退

ENGINES = {
    'edge': EdgeEngine,
    'sapi': SapiEngine,
    'http': HttpEngine,
    'command': CommandEngine,
}


def make_engine(name, cfg, log=None):
    if name not in ENGINES:
        raise TtsError('不认识的 tts.engine「%s」；可用：%s'
                       % (name, ' / '.join(sorted(ENGINES))), kind='config')
    return ENGINES[name](cfg, log=log)


def resolve_chain(cfg, log=None):
    """按配置与可用性定出「实际用哪个引擎」。

    cfg.engine 支持三种写法：
      'edge'               只用 edge（失败即失败 —— 要确定性时用这个）
      'sapi'               只用 sapi
      ['edge','sapi']      按顺序回退（推荐：联网好就用好的，断了自动降级）
      'auto'               等价于 ['edge','http','sapi','command']

    auto 的顺序有讲究：**音质优先，其次离线可用**。
    edge（神经音色）→ http（你自己的云服务，通常音质最好且稳定）→
    sapi（离线兜底，音质一般）→ command（逃生舱）。
    注意 http 需要密钥，没配密钥就自动跳过 —— 不会因为没配而让整条链失败。

    返回 (engine 实例, 说明文字)。全都不可用时抛 TtsError 并列出**每个引擎为什么不行**
    —— 「都不可用」这种信息没用，要知道具体缺什么才能修。
    """
    raw = cfg.get('engine', 'edge')
    if raw == 'auto':
        order = ['edge', 'http', 'sapi', 'command']
    elif isinstance(raw, (list, tuple)):
        order = list(raw)
    else:
        order = [raw]

    reasons = []
    for name in order:
        try:
            eng = make_engine(name, cfg, log=log)
        except TtsError as e:
            reasons.append('%s：%s' % (name, e))
            continue
        ok, why = eng.available()
        if ok:
            return eng, '用 %s' % name
        reasons.append('%s：%s' % (name, why))
    raise TtsError('配置的 TTS 引擎都不可用：\n    ' + '\n    '.join(reasons), kind='unavailable')


# ------------------------------------------------------------------ 小工具

def _write_ps1(content):
    """写一个临时 .ps1（带 BOM，保证 PowerShell 正确读中文）。

    为什么落文件而不是塞命令行：中文与引号经过多层转义必然出问题
    （实测 "No characters are allowed after a here-string header"）。
    """
    import tempfile
    fd, path = tempfile.mkstemp(suffix='.ps1')
    os.close(fd)
    with open(path, 'w', encoding='utf-8-sig') as fh:
        fh.write(content)
    return path


def _rm(path):
    try:
        if path and os.path.exists(path):
            os.remove(path)
    except OSError:
        pass


def _q(p):
    """给 shell 命令模板用的路径引号（同时兼容 Windows 与 POSIX）。"""
    return '"%s"' % p if ' ' in p else p


def _ext_format(path):
    ext = os.path.splitext(path)[1].lower().lstrip('.')
    return ext or 'wav'


def _rate_to_sapi(rate):
    """'+20%' → SAPI 的 -10..10。

    换算按「每 10% 对应 1 档」近似（SAPI 的档位与百分比没有公开的精确映射，
    这里取线性近似并夹到范围内；精确语速仍以 edge 为准）。
    """
    s = str(rate).strip().rstrip('%')
    try:
        pct = float(s)
    except ValueError:
        return 0
    return max(-10, min(10, int(round(pct / 10.0))))
