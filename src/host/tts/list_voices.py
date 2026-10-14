# -*- coding: utf-8 -*-
"""列出各 TTS 引擎的可用性与音色（`filmwright voices`）。

这条命令的用途是**做片子之前先探路**：TTS 是联网服务、会整段不可用
（实测 edge 合成 403 而 list_voices 正常），所以先问一句「现在能用什么」，
比合成到一半才发现引擎挂了要好。
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import engines


def load_cfg(project_dir):
    """从 film.config.mjs 取 slug 与 tts 配置（用 node 求值，不自己解析 JS）。"""
    cfg_path = os.path.join(project_dir, 'film.config.mjs')
    if not os.path.exists(cfg_path):
        return {'slug': 'film', 'tts': {}}
    import subprocess
    script = ("import(%s).then(m => { const c = m.default || {}; "
              "console.log(JSON.stringify({slug: c.slug || 'film', tts: c.tts || {}})); });"
              % json.dumps('file:///' + cfg_path.replace('\\', '/').replace('%', '%25')))
    out = subprocess.run(['node', '--input-type=module', '-e', script],
                         capture_output=True, text=True, encoding='utf-8', errors='replace')
    if out.returncode != 0:
        return {'slug': 'film', 'tts': {}, '_error': (out.stderr or '')[:200]}
    return json.loads(out.stdout.strip().splitlines()[-1])


def main():
    project_dir = None
    as_json = '--json' in sys.argv
    for i, a in enumerate(sys.argv):
        if a == '--project' and i + 1 < len(sys.argv):
            project_dir = sys.argv[i + 1]
    project_dir = os.path.abspath(project_dir or '.')

    cfg = load_cfg(project_dir)
    tts_cfg = dict(cfg.get('tts') or {})
    for env, key in (('TTS_ENGINE', 'engine'), ('VOICE', 'voice'), ('RATE', 'rate'),
                     ('TTS_COMMAND', 'command')):
        if os.environ.get(env):
            tts_cfg[key] = os.environ[env]

    configured = tts_cfg.get('engine', 'edge')
    result = {
        'configured_engine': configured,
        'engines': [],
        'resolved': None,
        'slug': cfg.get('slug', 'film'),
    }
    if cfg.get('_error'):
        result['config_error'] = cfg['_error']

    for name in sorted(engines.ENGINES):
        eng = engines.make_engine(name, tts_cfg)
        ok, why = eng.available()
        entry = {
            'name': name,
            'available': bool(ok),
            'reason': why or '',
            'has_word_boundary': eng.has_word_boundary,
            'voices': [],
        }
        if ok:
            try:
                entry['voices'] = eng.voices()
            except engines.TtsError as e:
                entry['reason'] = str(e)[:200]
        result['engines'].append(entry)

    # 配置里写的引擎最终会解析成什么（含回退）
    try:
        eng, note = engines.resolve_chain(tts_cfg)
        result['resolved'] = {'engine': eng.name, 'note': note,
                              'has_word_boundary': eng.has_word_boundary}
    except engines.TtsError as e:
        result['resolved'] = {'engine': None, 'error': str(e)}

    if as_json:
        print(json.dumps(result, ensure_ascii=False))
        return 0

    print('项目 %s' % project_dir)
    print('配置的引擎：%s' % configured)
    print()
    print('各引擎可用性：')
    for e in result['engines']:
        mark = '✓' if e['available'] else '✗'
        wb = '有词边界（字幕可精确对齐）' if e['has_word_boundary'] else '无词边界（字幕按字数估算）'
        print('  %s %-8s %s' % (mark, e['name'], wb))
        if not e['available'] and e['reason']:
            print('      不可用：%s' % e['reason'])
    print()
    r = result['resolved']
    if r.get('engine'):
        print('实际会用：%s（%s）' % (r['engine'], r['note']))
    else:
        print('实际会用：没有可用引擎')
        print('  %s' % (r.get('error') or '').replace('\n', '\n  '))
    print()
    for e in result['engines']:
        if e['voices']:
            print('%s 的可用音色（%d 个）：' % (e['name'], len(e['voices'])))
            for v in e['voices'][:24]:
                extra = ' '.join(x for x in (v.get('gender'), v.get('locale')) if x)
                print('  %-34s %s' % (v['id'], extra))
            if len(e['voices']) > 24:
                print('  …（还有 %d 个）' % (len(e['voices']) - 24))
    if result['resolved'] and result['resolved'].get('engine') == 'sapi':
        print()
        print('提示：当前会用离线引擎 SAPI。音质不如 edge 的神经音色，且字幕切换点是'
              '按字数估算的（timeline.json 会标 subs_timing: estimated）。')
        print('      想换回高质量音色：等 edge 服务恢复后把 tts.engine 改回 "edge"，'
              '或用 tts.engine "command" 接自己的 TTS。')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
