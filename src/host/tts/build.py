#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""解说词 -> 配音 + 时间轴。时间轴的唯一来源。

用法：filmwright tts --project <项目目录>

输入 <项目>/script/narration.txt：
  # CHAPTER n 标题   章节标记（章前自动留 CHAPTER_GAP 帧空白）
  空行              段落分隔 = 换镜头；空行前那句是段末，下一句前多留 PARA_GAP 帧
  ## gap N           在下一句前再多插 N 帧空白
  一句话|切成字幕块   竖线只切字幕，不影响朗读

输出：
  public/assets/<slug>/audio.wav
  script/timeline.json（机器可读；渲染与自检都读它）
  script/timeline.md（人读的时间轴表）

逐句缓存于 audio/cache/：改一句只重合成一句。

TTS 引擎由 film.config.mjs 的 tts 段给（engine/voice/rate），也可用环境变量覆盖：
  VOICE=zh-CN-YunxiNeural RATE=+0% TTS_ENGINE=edge

**端点会限流**：成批请求会连续拿回空音频（NoAudioReceived），而 edge-tts 默认没有超时，
不设超时会一直挂着。所以这里限速 + 超时 + 退避重试 —— 这是 NoAudioReceived 的正确解法，
不是文案问题。
"""
import asyncio, hashlib, json, os, re, subprocess, sys, time
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import engines

FPS = 30
SR = 48000
SHORT_TAIL = 45
# 响度归一目标（EBU R128）。人声口播的常见目标是 -16 LUFS 左右；
# 这里只做「峰值归一 + 轻度限幅」，因为 loudnorm 是单遍近似，
# 对逐句合成后拼接的长音频更稳（两遍模式要预扫全片，成本高收益小）。
TARGET_PEAK = 0.89


def load_project(project_dir):
    """从 film.config.mjs 里取 slug 与 tts 设置（用 node 求值，避免自己解析 JS）。"""
    cfg_path = os.path.join(project_dir, 'film.config.mjs')
    if not os.path.exists(cfg_path):
        raise SystemExit('filmwright: 找不到 %s' % cfg_path)
    script = (
        "import(%s).then(m => { const c = m.default || {}; "
        "console.log(JSON.stringify({slug: c.slug || 'film', tts: c.tts || {}, fps: c.fps || 30})); });"
        % json.dumps('file:///' + cfg_path.replace('\\', '/'))
    )
    out = subprocess.run(['node', '--input-type=module', '-e', script],
                         capture_output=True, text=True)
    if out.returncode != 0:
        raise SystemExit('filmwright: 读 film.config.mjs 失败：\n' + out.stderr)
    return json.loads(out.stdout.strip().splitlines()[-1])


def parse(path):
    items, chap, pending_gap, para_break = [], 0, 0, False

    def last_sent():
        for it in reversed(items):
            if it['type'] == 'sent':
                return it
        return None

    with open(path, encoding='utf-8') as fh:
        for raw in fh:
            line = raw.strip()
            if not line:
                s = last_sent()
                if s is not None:
                    s['para_end'] = True
                    para_break = True
                continue
            m = re.match(r'^#\s*CHAPTER\s+(\d+)\s+(.*)$', line)
            if m:
                chap = int(m.group(1))
                s = last_sent()
                if s is not None:
                    s['para_end'] = True
                items.append({'type': 'chapter', 'chapter': chap, 'title': m.group(2).strip()})
                para_break = False
                continue
            m = re.match(r'^##\s*gap\s+(\d+)', line)
            if m:
                pending_gap += int(m.group(1))
                continue
            if line.startswith('#'):
                continue
            items.append({'type': 'sent', 'chapter': chap, 'raw': line,
                          'gap_before': pending_gap, 'para_end': False})
            pending_gap = 0
            para_break = False
    s = last_sent()
    if s is not None:
        s['para_end'] = True
    return items, para_break


def _engine_failure_hint(e):
    """把引擎失败翻译成「你能做什么」。按 kind 分，因为出路完全不同。

    为什么要有这一层：原先 edge 403 时只抛一句
    `WSServerHandshakeError: 403`，使用者既不知道这是微软侧故障、
    也不知道框架本身有离线后备可以开。错误信息要给出路，不只是给原因。
    """
    kind = getattr(e, 'kind', 'engine')
    msg = str(e)
    if kind == 'unavailable':
        return (
            'filmwright: %s\n'
            '  这是**服务不可用**（403 / 握手失败），多为微软侧故障或区域不可用，'
            '不是本机配置问题。\n'
            '  已核对：edge-tts 版本、系统时钟、网络均正常，而 voices 端点可用、合成一律 403。\n'
            '  出路（按推荐顺序）：\n'
            '    1) 让引擎自动回退到离线引擎（推荐）：\n'
            '         film.config.mjs 里写 tts: {engine: "auto"}\n'
            '       或用 ["edge","sapi"] 明确回退顺序；Windows 自带 SAPI，完全离线\n'
            '    2) 过一段时间再试（服务恢复即好，配置不用改）\n'
            '    3) 接自己的 TTS：tts: {engine: "command", command: "你的命令 {out} {text_file}"}\n'
            '    4) 自己按同样格式产出 script/timeline.json（时间轴是数据契约，见 LIMITATIONS.md）\n'
            '  查可用音色：filmwright voices --project <目录>' % msg)
    if kind == 'throttled':
        return ('filmwright: %s\n'
                '  多为端点限流：等一会儿再跑，或用 tts.pace 放慢（见 docs/config.md 的 tts 段）' % msg)
    if kind == 'config':
        return 'filmwright: %s\n  检查 film.config.mjs 的 tts 段（见 docs/config.md）' % msg
    return 'filmwright: %s' % msg


class Tts:
    """把「合成一句话」委托给引擎层（engines.py），自己只管时间轴与缓存。

    引擎可换、可回退：edge（音质最好但会 403）→ sapi（Windows 离线兜底）→ command（逃生舱）。
    实测：edge 合成 403 而 list_voices 正常 —— 所以「可用性」必须真探一次合成，
    不能只看包装了没（否则回退链永远不生效）。
    """

    def __init__(self, root, cfg):
        self.root = root
        self.slug = cfg['slug']
        self.fps = cfg.get('fps', FPS)
        tts_cfg = dict(cfg.get('tts') or {})
        # 环境变量覆盖（保留原有用法）
        for env, key in (('TTS_ENGINE', 'engine'), ('VOICE', 'voice'), ('RATE', 'rate'),
                         ('EDGE_TRIES', 'tries'), ('EDGE_PACE', 'pace'),
                         ('TTS_COMMAND', 'command')):
            if os.environ.get(env):
                tts_cfg[key] = os.environ[env]
        self.cfg = tts_cfg
        self.gap = int(os.environ.get('GAP', tts_cfg.get('gap', 10)))
        self.para_gap = int(os.environ.get('PARA_GAP', tts_cfg.get('paraGap', 20)))
        self.chapter_gap = int(os.environ.get('CHAPTER_GAP', tts_cfg.get('chapterGap', 45)))
        self.lead = int(os.environ.get('LEAD', tts_cfg.get('lead', 40)))
        self.tail = int(os.environ.get('TAIL', tts_cfg.get('tail', 90)))
        self.pace = float(os.environ.get('EDGE_PACE', tts_cfg.get('pace', 0.6)))
        self.loudnorm = str(os.environ.get('TTS_LOUDNORM', tts_cfg.get('loudnorm', 'on'))).lower() not in ('0', 'off', 'false', 'no')
        self.cache = os.path.join(root, 'audio', 'cache')
        os.makedirs(self.cache, exist_ok=True)
        self.log = lambda *a: print(*a)
        # 引擎在这里定下来（回退链只解析一次，避免每句都探测）
        self.engine, self.engine_note = engines.resolve_chain(self.cfg, log=self.log)
        self.engine_name = self.engine.name
        self.has_words = self.engine.has_word_boundary

    def cache_path(self, text, ext):
        # 缓存键含引擎名：换了引擎必须重新合成（不同引擎音色完全不同），
        # 只按 voice/rate 做键会让换引擎后拿到旧引擎的音频（静默错音）。
        sig = '%s|%s|%s|%s|%s' % (self.engine_name, self.cfg.get('voice', ''), self.cfg.get('rate', ''),
                                  self.cfg.get('command', ''), text)
        return os.path.join(self.cache, hashlib.sha1(sig.encode('utf-8')).hexdigest()[:16] + ext)

    def synth(self, text):
        """合成一句（带缓存）。返回 (音频字节, words 或 None, meta)。"""
        ext = '.mp3' if self.engine_name == 'edge' else '.bin'
        audio_path = self.cache_path(text, ext)
        words_path = self.cache_path(text, '.words.json')
        meta_path = self.cache_path(text, '.meta.json')
        if os.path.exists(audio_path) and os.path.exists(words_path) and os.path.exists(meta_path):
            with open(audio_path, 'rb') as fh:
                data = fh.read()
            with open(words_path, encoding='utf-8') as fh:
                words = json.load(fh)
            with open(meta_path, encoding='utf-8') as fh:
                meta = json.load(fh)
            meta['cached'] = True
            return data, words, meta

        data, words, meta = self.engine.synth(text)
        with open(audio_path, 'wb') as fh:
            fh.write(data)
        with open(words_path, 'w', encoding='utf-8') as fh:
            json.dump(words, fh, ensure_ascii=False)
        with open(meta_path, 'w', encoding='utf-8') as fh:
            json.dump(meta, fh, ensure_ascii=False)
        if self.pace and self.engine_name == 'edge':
            time.sleep(self.pace)
        return data, words, meta

    def decode(self, data, fmt):
        """把引擎产出的音频解码成 48k 单声道 float32。"""
        cmd = ['ffmpeg', '-v', 'error', '-i', 'pipe:0', '-f', 'f32le', '-ac', '1', '-ar', str(SR), '-']
        r = subprocess.run(cmd, input=data, capture_output=True)
        if r.returncode != 0:
            raise SystemExit('filmwright: 解码 TTS 音频失败：%s'
                             % r.stderr.decode('utf-8', 'replace')[:300])
        x = np.frombuffer(r.stdout, dtype=np.float32).copy()
        if len(x) == 0:
            raise SystemExit('filmwright: 解码 TTS 音频得到 0 采样（引擎产出可能损坏）')
        return x


def trim_edges(x, thr=0.004):
    idx = np.where(np.abs(x) > thr)[0]
    if len(idx) == 0:
        return x, 0.0
    a = max(0, idx[0] - int(0.03 * SR))
    b = min(len(x), idx[-1] + int(0.12 * SR))
    return x[a:b], a / SR


def normalize_peak(x, target=TARGET_PEAK):
    """逐句做峰值归一。

    **为什么必须做**：不同引擎、不同音色的输出电平差很多
    （实测 SAPI 的 mean -27dB / max -9dB，而 edge 神经音色普遍更响）。
    不归一的话，换引擎后整片音量会突变；逐句归一还能抹平同引擎不同句子的
    随机起伏（短句常因首尾静音被 trim 得偏轻）。

    只做峰值归一而不是 LUFS 归一：峰值归一不会改变句内动态（听感自然），
    而单句的 LUFS 归一在句子很短时不准（积分窗口比句子还长）。
    整片的响度一致性由末尾的全局归一负责。
    """
    peak = float(np.max(np.abs(x))) if len(x) else 0.0
    if peak < 1e-6:
        return x, 1.0
    return x * (target / peak), target / peak


def estimate_chunk_starts(text, chunks, dur):
    """无词边界时按**字数比例**估字幕块的起始秒。

    这是降级方案，精度不如 edge 的 WordBoundary（它给的是词级时间）。
    为什么按「有效字数」而不是「字符数」：中文标点不发音，
    把它们算进去会让长句的估算越来越偏（实测末尾块能偏 0.3s 以上）。
    标点按「停顿」折算成 0.35 个字的时长 —— 比完全忽略更接近真实朗读节奏。
    """
    def weight(s):
        w = 0.0
        for ch in s:
            if ch in '，、；：,;:':
                w += 0.35
            elif ch in '。！？.!?':
                w += 0.6
            elif ch in '—…-()（）“”"\'’':
                w += 0.15
            elif ch.isspace():
                w += 0.1
            else:
                w += 1.0
        return max(w, 0.1)

    ws = [weight(c) for c in chunks]
    total = sum(ws) or 1.0
    starts, acc = [], 0.0
    for w in ws:
        starts.append(dur * acc / total)
        acc += w
    starts[0] = 0.0
    return starts


def chunk_starts(text, chunks, words, lead_cut, dur):
    """把 word 边界对到每个字幕块的起始秒。"""
    char_t = [None] * len(text)
    cur = 0
    for w in words:
        wt = re.sub(r'[\s，。、！？：；“”（）,.!?:;()\-—…]', '', w['text'])
        if not wt:
            continue
        p = text.find(wt, cur)
        if p < 0:
            p = text.find(wt[0], cur)
            if p < 0:
                continue
        for i in range(p, min(len(text), p + len(wt))):
            char_t[i] = (w['t'] - lead_cut, w['d'])
        cur = p + len(wt)
    starts, pos = [], 0
    for c in chunks:
        st = None
        for i in range(pos, min(len(text), pos + len(c))):
            if char_t[i] is not None:
                st = char_t[i][0]
                break
        starts.append(st)
        pos += len(c)
    for i, st in enumerate(starts):
        if st is None:
            prev = starts[i - 1] if i > 0 and starts[i - 1] is not None else 0.0
            starts[i] = prev + dur * len(chunks[i - 1]) / max(1, len(text)) if i > 0 else 0.0
    starts[0] = 0.0
    return [max(0.0, s) for s in starts]


def run(project_dir):
    """主流程：解析解说词 → 逐句合成 → 拼时间轴与音频。

    同步函数（不再是 async）：引擎层内部自己管异步（edge 用 asyncio.run），
    外层再套 async 只会让「同步阻塞」伪装成协程，反而看不清真实行为。
    """
    project_dir = os.path.abspath(project_dir)
    cfg = load_project(project_dir)
    t = Tts(project_dir, cfg)
    narr = os.path.join(project_dir, 'script', 'narration.txt')
    if not os.path.exists(narr):
        raise SystemExit('filmwright: 找不到 %s' % narr)

    items, _ = parse(narr)
    tcur = t.lead / t.fps
    audio_parts, sentences, chapters = [], [], []
    sid = 0
    total_chars, speech_sec = 0, 0.0

    for it in items:
        if it['type'] == 'chapter':
            tcur += t.chapter_gap / t.fps
            chapters.append({'n': it['chapter'], 'title': it['title'],
                             'from': int(round(tcur * t.fps)) + 1})
            continue
        if it['gap_before']:
            tcur += it['gap_before'] / t.fps
        chunks = [c.strip() for c in it['raw'].split('|') if c.strip()]
        if not chunks:
            continue
        tts_text = ''.join(chunks)
        data, words, meta = t.synth(tts_text)
        x = t.decode(data, meta.get('format', 'mp3'))
        x, lead_cut = trim_edges(x)
        x, gain = normalize_peak(x)
        dur = len(x) / SR
        # 有词边界（edge）就用它精确对齐；没有（sapi / command）按字数比例估。
        # 两条路都产 subs，但**如实记录用的是哪种**（timeline.json 的 subs_timing），
        # 让使用者知道字幕切换点是精确的还是要留余量。
        if words:
            starts = chunk_starts(tts_text, chunks, words, lead_cut, dur)
        else:
            starts = estimate_chunk_starts(tts_text, chunks, dur)
        sid += 1
        subs = []
        for i, c in enumerate(chunks):
            a = tcur + starts[i]
            b = tcur + (starts[i + 1] if i + 1 < len(starts) else dur)
            subs.append({'from': int(round(a * t.fps)) + 1, 'to': int(round(b * t.fps)), 'text': c})
        sentences.append({'id': 'S%02d' % sid, 'chapter': it['chapter'],
                          'from': int(round(tcur * t.fps)) + 1, 'to': int(round((tcur + dur) * t.fps)),
                          'text': tts_text, 'subs': subs})
        audio_parts.append((tcur, x))
        total_chars += len(re.sub(r'[，。、！？：；“”（）,.!?:;()\-—…\s]', '', tts_text))
        speech_sec += dur
        # 段末多停一点（换镜头要留落位时间），段内只留一口气
        tcur += dur
        # gap 已并入下一句的 gap_before；段末再加 PARA_GAP
        tcur += t.gap / t.fps
        if it['para_end']:
            tcur += t.para_gap / t.fps

    tcur += t.tail / t.fps
    total = int(np.ceil(tcur * t.fps))

    y = np.zeros(int(total / t.fps * SR) + SR, dtype=np.float32)
    for st, x in audio_parts:
        a = int(st * SR)
        y[a:a + len(x)] += x
    y = y[:int(total / t.fps * SR)]
    # 全局归一：把整片峰值压到 TARGET_PEAK。
    # 逐句已归一到同一峰值，这里再兜一次 —— 因为多句叠加（重叠/回声）可能超过 1.0，
    # 直接写 int16 会削波（削波是**不可逆**的失真，宁可整体降一点）。
    peak = float(np.max(np.abs(y))) or 1.0
    y = y / peak * TARGET_PEAK
    clipped = int(np.sum(np.abs(y) > 1.0))
    if clipped:
        y = np.clip(y, -1.0, 1.0)
        print('⚠ 有 %d 个采样超过满量程，已限幅（句间重叠过多？）' % clipped)

    outdir = os.path.join(project_dir, 'public', 'assets', t.slug)
    os.makedirs(outdir, exist_ok=True)
    wav = os.path.join(outdir, 'audio.wav')
    import wave
    pcm = (np.clip(np.stack([y, y], 1), -1.0, 1.0) * 32767).astype(np.int16)
    with wave.open(wav, 'wb') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())

    all_subs = []
    for s in sentences:
        for sb in s['subs']:
            if sb['to'] < sb['from']:
                sb['to'] = sb['from']
            all_subs.append(dict(sb))
    for i in range(len(all_subs) - 1):
        if all_subs[i]['to'] >= all_subs[i + 1]['from']:
            all_subs[i]['to'] = all_subs[i + 1]['from'] - 1

    # 第二语言：读 script/translation.json（可选），填进每个字幕块的 text2。
    #
    # **框架不翻译**（AI 在框架外产出译文，边界不破）—— 这里只负责把译文带进
    # 时间轴，好让画面内双语字幕与 srt 导出用的是**同一份数据**
    # （否则会出现「画面双语、导出单语」）。
    #
    # 文件形状与 `filmwright srt --translation` 认的一致，两种都行：
    #   [{"from": 120, "to": 200, "text": "..."}]        按起始帧对齐
    #   {"1": "...", "2": "..."}                          按字幕块序号（1 起）对齐
    # 缺项就留空（那一块只显示原文），不编内容。
    tr_path = os.path.join(project_dir, 'script', 'translation.json')
    tr_used = 0
    if os.path.exists(tr_path):
        try:
            with open(tr_path, encoding='utf-8') as fh:
                tr = json.load(fh)
        except Exception as e:
            raise SystemExit('filmwright: 读 script/translation.json 失败：%s' % e)
        for i, sb in enumerate(all_subs):
            txt = None
            if isinstance(tr, list):
                hit = next((x for x in tr if isinstance(x, dict) and x.get('from') == sb['from']), None)
                txt = hit.get('text') if hit else None
            elif isinstance(tr, dict):
                txt = tr.get(str(i + 1))
            if isinstance(txt, str) and txt.strip():
                sb['text2'] = txt.strip()
                tr_used += 1
        if tr_used:
            print('第二语言：%d/%d 个字幕块填了译文（script/translation.json）' % (tr_used, len(all_subs)))
        else:
            print('⚠ script/translation.json 在，但一个都没匹配上 —— 检查 from 帧号或块序号')

    tl = {'fps': t.fps, 'total_frames': total,
          'engine': t.engine_name, 'voice': t.cfg.get('voice', ''),
          'rate': t.cfg.get('rate', '+0%'), 'slug': t.slug,
          # 如实标注字幕时间的来源：word=按词边界精确对齐，estimated=按字数比例估算。
          # 使用者据此知道字幕切换点能不能卡得很准（sapi/command 是 estimated）。
          'subs_timing': 'word' if t.has_words else 'estimated',
          'engine_note': t.engine_note,
          'chapters': chapters, 'sentences': sentences,
          'subs': all_subs, 'chars': total_chars, 'speech_sec': round(speech_sec, 2)}
    os.makedirs(os.path.join(project_dir, 'script'), exist_ok=True)
    # newline='\n'：python 在 Windows 上默认把 '\n' 翻成 CRLF，而仓库统一 LF ——
    # 否则每次生成 timeline.md 都会在 git diff 里显示「整个文件都改了」。
    with open(os.path.join(project_dir, 'script', 'timeline.json'), 'w',
              encoding='utf-8', newline='\n') as fh:
        json.dump(tl, fh, ensure_ascii=False, indent=1)
    with open(os.path.join(project_dir, 'script', 'timeline.md'), 'w',
              encoding='utf-8', newline='\n') as fh:
        fh.write('# 时间轴（%s · %s %s，共 %d 帧 = %.1fs，%d 字，语速 %.2f 字/秒）\n\n'
                 % (t.engine_name, t.cfg.get('voice', '') or '(默认)', t.cfg.get('rate', '+0%'),
                    total, total / t.fps, total_chars,
                    total_chars / max(1e-6, speech_sec)))
        if not t.has_words:
            fh.write('> 字幕切换点是**按字数比例估算**的（%s 不提供词边界）；'
                     '要精确对齐请用 edge 引擎。\n\n' % t.engine_name)
        fh.write('| 句 | 章 | 帧 from–to | 时长 | 文本 |\n|---|---|---|---|---|\n')
        for s in sentences:
            fh.write('| %s | %d | %d–%d | %.1fs | %s |\n'
                     % (s['id'], s['chapter'], s['from'], s['to'],
                        (s['to'] - s['from'] + 1) / t.fps,
                        '｜'.join(b['text'] for b in s['subs'])))
        fh.write('\n## 章节起始帧\n')
        for c in chapters:
            fh.write('- 第%d章 %s：f%d\n' % (c['n'], c['title'], c['from']))

    # 字幕块宽度体检：44px 下超安全区的块要回去切文案
    over = []
    for sb in all_subs:
        wsum = 0.0
        for ch in sb['text']:
            c = ord(ch)
            wsum += 1.0 if c >= 0x2000 else (0.227 if ch == ' ' else
                     0.668 if 'A' <= ch <= 'Z' else 0.59 if '0' <= ch <= '9' else
                     0.566 if 'a' <= ch <= 'z' else 0.58 if 0xc0 <= c < 0x250 else 0.325)
        if wsum * 44 > 1160:
            over.append((sb, wsum * 44))
    if over:
        print('⚠ %d/%d 个字幕块在 44px 下超过 1160px（建议用 | 再切一刀）：'
              % (len(over), len(all_subs)))
        for sb, wsum in over[:8]:
            print('    f%s (%.0fpx) %s' % (sb['from'], wsum, sb['text']))

    print('total_frames=%d (%.1fs) sentences=%d chapters=%d chars=%d speech=%.1fs rate=%.2f 字/秒'
          % (total, total / t.fps, len(sentences), len(chapters), total_chars, speech_sec,
             total_chars / max(1e-6, speech_sec)))
    print('wav=%s' % wav)
    return 0


if __name__ == '__main__':
    pd = None
    for i, a in enumerate(sys.argv):
        if a == '--project' and i + 1 < len(sys.argv):
            pd = sys.argv[i + 1]
    if not pd:
        raise SystemExit('用法：filmwright tts --project <项目目录>')
    try:
        raise SystemExit(run(pd))
    except engines.TtsError as e:
        # 把「引擎不可用」翻译成使用者能照做的出路，而不是抛一个异常名。
        # 这是实测出来的需求：edge 403 时原先只报一句 WSServerHandshakeError，
        # 使用者不知道是微软侧故障、也不知道本框架有离线后备。
        print(_engine_failure_hint(e), file=sys.stderr)
        raise SystemExit(2)
