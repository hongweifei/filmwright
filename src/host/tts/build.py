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
import asyncio, hashlib, json, os, re, subprocess, sys
import numpy as np

FPS = 30
SR = 48000
SHORT_TAIL = 45


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


class Tts:
    def __init__(self, root, cfg):
        self.root = root
        self.slug = cfg['slug']
        self.engine = os.environ.get('TTS_ENGINE') or cfg['tts'].get('engine', 'edge')
        self.voice = os.environ.get('VOICE') or cfg['tts'].get('voice', 'zh-CN-YunxiNeural')
        self.rate = os.environ.get('RATE') or cfg['tts'].get('rate', '+0%')
        self.fps = cfg.get('fps', FPS)
        self.gap = int(os.environ.get('GAP', cfg['tts'].get('gap', 10)))
        self.para_gap = int(os.environ.get('PARA_GAP', cfg['tts'].get('paraGap', 20)))
        self.chapter_gap = int(os.environ.get('CHAPTER_GAP', cfg['tts'].get('chapterGap', 45)))
        self.lead = int(os.environ.get('LEAD', cfg['tts'].get('lead', 40)))
        self.tail = int(os.environ.get('TAIL', cfg['tts'].get('tail', 90)))
        self.tries = int(os.environ.get('EDGE_TRIES', cfg['tts'].get('tries', 8)))
        self.pace = float(os.environ.get('EDGE_PACE', cfg['tts'].get('pace', 0.6)))
        self.cache = os.path.join(root, 'audio', 'cache')
        os.makedirs(self.cache, exist_ok=True)

    def cache_path(self, text, ext):
        sig = '%s|%s|%s|%s' % (self.engine, self.voice, self.rate, text)
        return os.path.join(self.cache, hashlib.sha1(sig.encode('utf-8')).hexdigest()[:16] + ext)

    async def synth_edge(self, text):
        import edge_tts
        mp3, js = self.cache_path(text, '.mp3'), self.cache_path(text, '.json')
        if os.path.exists(mp3) and os.path.exists(js):
            with open(js, encoding='utf-8') as fh:
                return mp3, json.load(fh)
        why = ''
        for attempt in range(1, self.tries + 1):
            audio, words = bytearray(), []
            try:
                comm = edge_tts.Communicate(
                    text, self.voice, rate=self.rate, boundary='WordBoundary',
                    connect_timeout=15, receive_timeout=25)

                async def collect():
                    async for ch in comm.stream():
                        if ch['type'] == 'audio':
                            audio.extend(ch['data'])
                        elif ch['type'] == 'WordBoundary':
                            words.append({'t': ch['offset'] / 1e7, 'd': ch['duration'] / 1e7,
                                          'text': ch['text']})

                await asyncio.wait_for(collect(), timeout=40)
                if audio:
                    break
                why = '端点返回空音频'
            except TypeError:
                raise SystemExit("filmwright: edge-tts 过旧：pip install 'edge-tts==7.2.8'")
            except asyncio.TimeoutError:
                why = '超时'
            except Exception as e:
                why = '%s: %s' % (type(e).__name__, e)
            if attempt == self.tries:
                raise SystemExit('filmwright: edge-tts 试了 %d 次仍拿不到音频（%s）：%s'
                                 % (self.tries, why, text[:30]))
            back = min(8.0, 1.2 * attempt)
            print('  edge-tts 第 %d/%d 次失败（%s），等 %.1fs' % (attempt, self.tries, why, back))
            await asyncio.sleep(back)
        with open(mp3, 'wb') as fh:
            fh.write(audio)
        with open(js, 'w', encoding='utf-8') as fh:
            json.dump(words, fh, ensure_ascii=False)
        await asyncio.sleep(self.pace)
        return mp3, words

    def decode(self, mp3):
        out = subprocess.run(['ffmpeg', '-v', 'error', '-i', mp3, '-f', 'f32le',
                              '-ac', '1', '-ar', str(SR), '-'],
                             capture_output=True, check=True).stdout
        return np.frombuffer(out, dtype=np.float32).copy()


def trim_edges(x, thr=0.004):
    idx = np.where(np.abs(x) > thr)[0]
    if len(idx) == 0:
        return x, 0.0
    a = max(0, idx[0] - int(0.03 * SR))
    b = min(len(x), idx[-1] + int(0.12 * SR))
    return x[a:b], a / SR


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


async def run(project_dir):
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
        mp3, words = await t.synth_edge(tts_text)
        x, lead_cut = trim_edges(t.decode(mp3))
        dur = len(x) / SR
        starts = chunk_starts(tts_text, chunks, words, lead_cut, dur)
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
    peak = float(np.max(np.abs(y))) or 1.0
    y = y / peak * 0.89

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

    tl = {'fps': t.fps, 'total_frames': total, 'engine': t.engine, 'voice': t.voice,
          'rate': t.rate, 'slug': t.slug, 'chapters': chapters, 'sentences': sentences,
          'subs': all_subs, 'chars': total_chars, 'speech_sec': round(speech_sec, 2)}
    os.makedirs(os.path.join(project_dir, 'script'), exist_ok=True)
    with open(os.path.join(project_dir, 'script', 'timeline.json'), 'w', encoding='utf-8') as fh:
        json.dump(tl, fh, ensure_ascii=False, indent=1)
    with open(os.path.join(project_dir, 'script', 'timeline.md'), 'w', encoding='utf-8') as fh:
        fh.write('# 时间轴（%s · %s %s，共 %d 帧 = %.1fs，%d 字，语速 %.2f 字/秒）\n\n'
                 % (t.engine, t.voice, t.rate, total, total / t.fps, total_chars,
                    total_chars / max(1e-6, speech_sec)))
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
    raise SystemExit(asyncio.run(run(pd)))
