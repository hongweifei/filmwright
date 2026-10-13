// 合成时间轴夹具：读 script/narration.txt，按与 tts 相同的解析规则产出 timeline.json。
//
// 用途：**不是配音**。edge-tts 端点不可达（限流 / 网络）时，让纯规格示例仍能
// 跑 check 与渲染验收 —— 时间轴是数据，夹具只需形状与节拍正确。
// 真实项目请跑 `filmwright tts`（本工具会明确标注自己是合成夹具）。
//
//   node tools/make-timeline-fixture.mjs --project examples/gallery [--fps 30]
//
// 节拍模型：中文 ~4.5 字/秒；句间 10 帧、段末 20 帧、章前 45 帧、开头 40 帧、
// 结尾 90 帧；字幕块按 | 切、按字数分摊。与 src/host/tts/build.py 的默认值对齐。
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
// 没有默认目标：这工具会**覆盖** timeline.json，默认指向某个真实项目迟早出事
// （开发中真发生过一次：参数前缀写错回落到默认值，把 examples/minimal 的夹具覆盖了）。
const projectDir = arg('project', null);
if (!projectDir) {
  console.error('用法：node tools/make-timeline-fixture.mjs --project <项目目录>');
  process.exit(2);
}
const fps = Number(arg('fps', '30'));
const LEAD = 40, TAIL = 90, GAP = 10, PARA_GAP = 20, CHAPTER_GAP = 45;

const weight = (s) => {
  let w = 0;
  for (const ch of s) {
    if (/[\u4e00-\u9fff，。：、！？；""''（】]/.test(ch)) w += 1;
    else if (/\s/.test(ch)) w += 0.5;
    else w += 0.45;
  }
  return Math.max(2, w);
};

// 解析：与 build.py 同一套标记（# CHAPTER / ## gap / 空行 / |）
const items = [];
let chap = 0, pendingGap = 0;
for (const rawLine of readFileSync(join(projectDir, 'script', 'narration.txt'), 'utf8').split('\n')) {
  const line = rawLine.trim();
  if (!line) {
    const last = [...items].reverse().find((x) => x.type === 'sent');
    if (last) last.paraEnd = true;
    continue;
  }
  const cm = line.match(/^#\s*CHAPTER\s+(\d+)\s+(.*)$/);
  if (cm) {
    chap = Number(cm[1]);
    const last = [...items].reverse().find((x) => x.type === 'sent');
    if (last) last.paraEnd = true;
    items.push({type: 'chapter', chapter: chap, title: cm[2].trim()});
    continue;
  }
  if (/^##\s*gap\s+(\d+)/.test(line)) { pendingGap += Number(RegExp.$1); continue; }
  if (line.startsWith('#')) continue;
  items.push({type: 'sent', chapter: chap, raw: line, gapBefore: pendingGap, paraEnd: false});
  pendingGap = 0;
}

let frame = LEAD;
const sentences = [], subs = [], chapters = [];
let sid = 0;
for (const it of items) {
  if (it.type === 'chapter') {
    frame += CHAPTER_GAP;
    chapters.push({n: it.chapter, title: it.title, from: Math.max(1, frame - CHAPTER_GAP + 20)});
    continue;
  }
  frame += it.gapBefore;
  const id = 'S' + String(++sid).padStart(2, '0');
  const blocks = it.raw.split('|').map((b) => b.trim()).filter(Boolean);
  const total = blocks.reduce((a, b) => a + weight(b), 0);
  const dur = Math.max(45, Math.round(total * (fps / 4.5)));
  const from = frame;
  let cur = from;
  blocks.forEach((b, i) => {
    const bf = i === blocks.length - 1 ? from + dur - cur : Math.max(20, Math.round(dur * weight(b) / total));
    const bt = Math.min(from + dur, cur + bf);
    subs.push({from: cur, to: bt, text: b});
    cur = bt;
  });
  const to = Math.max(cur, from + 45);
  sentences.push({id, chapter: it.chapter, from, to, text: it.raw.replace(/\|/g, '')});
  frame = to + (it.paraEnd ? PARA_GAP : GAP);
}
const totalFrames = sentences.length ? sentences[sentences.length - 1].to + TAIL : 1;
const tl = {
  fps, total_frames: totalFrames, chapters, sentences, subs,
  _fixture: 'tools/make-timeline-fixture.mjs 合成 —— 跑 filmwright tts 会被真实时间轴覆盖',
};
writeFileSync(join(projectDir, 'script', 'timeline.json'), JSON.stringify(tl, null, 1) + '\n', 'utf8');
console.log(`合成时间轴：${sentences.length} 句 / ${subs.length} 块 / ${totalFrames} 帧 -> script/timeline.json`);
for (const s of sentences) console.log(`  ${s.id} ch${s.chapter} ${s.from}-${s.to} ${s.text.slice(0, 26)}`);
