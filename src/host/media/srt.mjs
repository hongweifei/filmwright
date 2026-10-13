// 字幕导出：timeline.json 的 subs → SRT。
//
// 为什么需要：字幕是烧进画面的（见 LIMITATIONS），但投稿到 B 站 / YouTube
// 还需要外挂字幕文件；此前只能自己从 timeline.json 里扒。
//
// 双语：框架**不翻译**（AI 在框架外的边界不破）——外部 agent 产出一份
// [{from, to, text}] 或按块对齐的译文，这里只负责合成双语轨。
import {readFileSync, writeFileSync, existsSync, mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';

/** 帧号 → SRT 时间戳（HH:MM:SS,mmm）。fps 由时间轴给。 */
export function frameToTime(frame, fps) {
  const totalMs = Math.round(((frame - 1) / fps) * 1000);
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`;
}

/**
 * 从时间轴生成 SRT 文本。
 * @param {{fps:number, subs:Array<{from:number,to:number,text:string}>}} tl
 * @param {{translation?: Array<{from:number,to:number,text:string}>|Map<number,string>}} [opt]
 *   translation：双语轨。给数组就按 from 帧对齐；给 Map 就按块序号（1 起）对齐。
 *   两种都允许缺项——缺的那块只出原文（不编内容）。
 */
export function buildSrt(tl, opt = {}) {
  const fps = tl.fps ?? 30;
  const subs = tl.subs ?? [];
  if (!Array.isArray(subs) || subs.length === 0) {
    const e = new Error('filmwright: 时间轴里没有字幕块（subs 为空）');
    e.code = 'NO_SUBS';
    e.hint = '时间轴由 filmwright tts 生成；解说词里的 | 决定字幕块怎么切';
    throw e;
  }
  const tr = opt.translation ?? null;
  const lookup = (block, i) => {
    if (!tr) return null;
    if (tr instanceof Map) return tr.get(i + 1) ?? null;
    const hit = tr.find((t) => t.from === block.from);
    return hit ? hit.text : null;
  };
  const lines = [];
  subs.forEach((b, i) => {
    // SRT 的结束时间用「下一块开始」而不是本块的 to：
    // 块之间本来就有空隙，按 to 写会让字幕在空隙里消失再出现（闪断）。
    const next = subs[i + 1];
    const endFrame = next ? Math.max(b.to, next.from) : b.to;
    const translated = lookup(b, i);
    lines.push(String(i + 1));
    lines.push(`${frameToTime(b.from, fps)} --> ${frameToTime(endFrame, fps)}`);
    lines.push(b.text);
    if (translated) lines.push(translated);
    lines.push('');
  });
  return lines.join('\n');
}

/**
 * 写 SRT 文件。
 * @param {object} proj loadProject 的结果
 * @param {{out?:string, translation?:any}} opt
 * @returns {{out:string, blocks:number, bilingual:boolean}}
 */
export function exportSrt(proj, opt = {}) {
  const tl = proj.timeline;
  if (!tl) {
    const e = new Error('filmwright: 还没有时间轴，无法导出字幕');
    e.code = 'NO_TIMELINE';
    e.hint = '先跑 filmwright tts';
    throw e;
  }
  const slug = proj.raw.slug ?? 'film';
  const out = opt.out ?? join(dirname(proj.paths.timeline), `${slug}.srt`);
  const srt = buildSrt(tl, {translation: opt.translation});
  mkdirSync(dirname(out), {recursive: true});   // --out 指到还不存在的目录也要能写
  writeFileSync(out, srt, 'utf8');
  return {out, blocks: (tl.subs ?? []).length, bilingual: !!opt.translation};
}

/** 读一份译文文件（JSON：[{from,to,text}] 或 {1:"…",2:"…"}）。 */
export function readTranslation(path) {
  if (!path) return null;
  if (!existsSync(path)) {
    const e = new Error('filmwright: 找不到译文文件 ' + path);
    e.code = 'NO_TRANSLATION_FILE';
    e.hint = '译文是 JSON：[{from,to,text}]（按 from 帧对齐）或 {"1": "…"}（按字幕块序号对齐）';
    throw e;
  }
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (Array.isArray(raw)) return raw;
  const m = new Map();
  for (const [k, v] of Object.entries(raw)) m.set(Number(k), String(v));
  return m;
}
