// 模板镜头：把 scene.json 的一条声明编译成引擎镜头。
//
// 这是「AI 自动化」的质量下限所在 —— AI 只填内容与节拍，这里负责节奏：
//   - 入场错峰：元素跟着对齐句的字幕块（BLK）依次进场，块不够就按时间铺；
//   - 停留不静止：落位后保持呼吸/脉冲（画质自检的静止阈值要求幅度够大，0.5% 等于没动）；
//   - 设计坐标：统一套 applyDesignScale，换分辨率不用改规格；
//   - 配色：accent 由引擎按章节传入，模板不自己挑色。
//
// 注册表的键必须与 contract/scene.js 的 SHOT_TYPES 一致（tests/scene-templates.test.mjs 钉住）。
import {S, BLK} from '../../contract/timeline.js';
import {resolveAt} from '../../contract/scene.js';
import {theme as C, fonts as F, accentFor} from '../../contract/config.js';
import {inv, easeOut3} from '../motion/ease.js';
import {applyDesignScale, DESIGN_SAFE} from '../layout/design.js';
import {text, panel, rule, codeBlock, caret, measure, font, terminal as terminalDraw, bars as barsDraw} from '../draw/primitives.js';
import {bigStat, flow, section, chips as chipsW} from '../draw/widgets.js';
import {picture} from '../draw/picture.js';
import {hexA} from '../draw/color.js';

const W = () => 1280;

/** 呼吸系数：幅度按静止阈值的口径给足。 */
const breathe = (n, amp = 0.035, period = 34) => 1 + Math.sin(n / period) * amp;

/**
 * 末拍预留帧数：镜头内容必须在这之前全部落位，给观众留出「看完」的时间。
 * 与画质自检的 holdFrames 默认值同数（那边判失败，这边不越界）——
 * 模板主动压节拍，比事后被自检打回更省一轮。
 */
const HOLD_RESERVE = 30;

/**
 * 把「入场起点 + 动画时长」夹进镜头可用的节拍窗口内（末拍必须留出 HOLD_RESERVE）。
 * 模板里凡是「某个动画走 N 帧才结束」的地方都用它，别各写一份。
 */
function beatEnd(sid, start, dur) {
  const s = sid ? S(sid) : null;
  const horizon = s ? s.to - HOLD_RESERVE : start + dur;
  return Math.min(start + dur, Math.max(start + 4, horizon));
}

/** 单元素入场进度（提前 4 帧起、20 帧走完，与示例片同一口径）。 */
const enterAt = (n, f) => easeOut3(inv(n, f, f + 20));

/**
 * 元素进场的帧号表：跟着对齐句的字幕块走，块不够就从最后一块按 18 帧铺；
 * 没有句锚点（数字对齐）就按时间均匀铺。
 */
function staggerFrames(sid, count, from) {
  let blocks = [];
  if (sid) {
    const s = S(sid);
    for (let i = 1; blocks.length < count; i++) {
      try { blocks.push(BLK(sid, i)); } catch { break; }   // 超出块数：BLK 抛错即止
    }
    if (blocks.length === 0) blocks.push(s.from);
    let last = blocks[blocks.length - 1];
    while (blocks.length < count) { last += 18; blocks.push(last); }
    // **为末拍预留停留时间**：元素多于字幕块时，上面的 +18 铺法会把最后一拍
    // 推到句子结束附近，停留期被吃光（实测 scenecast 的 code 镜头只剩 16 帧）。
    // 与其让自检打回，不如在这里把整串节拍等比压回安全线内。
    const horizon = s.to - HOLD_RESERVE;
    if (blocks.length > 1 && blocks[blocks.length - 1] > horizon) {
      const first = blocks[0];
      const span = horizon - first;
      // span ≤ 0 说明这个镜头的区间本来就装不下这么多元素 —— 不硬压，
      // 让画质自检报出来（它会说「内容太多或对齐太晚」并给出路）。
      if (span > 0) {
        const step = span / (blocks.length - 1);
        blocks = blocks.map((_, i) => Math.round(first + i * step));
      }
    }
  }
  const out = [];
  for (let i = 0; i < count; i++) {
    const anchor = sid ? blocks[i] : from + 16 + i * 12;
    out.push(Math.max(from + 6, anchor - 4));
  }
  return out;
}

// ---------- 各模板 ----------
// 约定：draw(ctx, n, shot, accent)，this 绑定镜头区间（this.from / this.to）。

const title = {
  // 片头的节拍是它自己的入场时间线（8 起、40 落位、58 分隔线走完）
  beats: (shot, start) => [start + 8, start + 40, start + 58],
  draw(ctx, n, shot, accent) {
    const cx = W() / 2;
    const a = easeOut3(inv(n, 8, 40));
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(0, (1 - easeOut3(a)) * 26);
    let y = 296;
    if (shot.kicker) {
      text(ctx, shot.kicker, cx, y - 96, {size: 20, family: F.mono, color: C.faint, align: 'center', baseline: 'middle', spacing: 4});
    }
    // 落位后光晕持续脉动：标题镜头常只有几秒，静止会被画质自检判停
    const pulse = 0.5 + 0.5 * Math.sin(n / 26);
    text(ctx, shot.title, cx, y, {
      size: 104, family: F.wide, weight: 700, color: C.text, align: 'center', baseline: 'middle',
      spacing: 6, glow: hexA(accent, 0.6 + 0.4 * pulse), glowBlur: 32 + 14 * pulse, maxW: DESIGN_SAFE.w,
    });
    y += 94;
    if (shot.sub) {
      text(ctx, shot.sub, cx, y, {size: 34, weight: 700, color: accent, align: 'center', baseline: 'middle', spacing: 4, maxW: DESIGN_SAFE.w});
      y += 40;
    }
    rule(ctx, cx, y, 300, easeOut3(inv(n, 30, 58)), {color: C.line, lw: 2, align: 'center'});
    y += 38;
    if (shot.en) {
      text(ctx, shot.en, cx, y, {size: 21, family: F.mono, weight: 400, color: C.faint, align: 'center', baseline: 'middle', maxW: DESIGN_SAFE.w});
    }
    ctx.restore();
  },
};

const bullets = {
  beats: (shot, start, sid) => staggerFrames(sid, shot.items.length, start),
  draw(ctx, n, shot, accent) {
    const frames = staggerFrames(shot.sid, shot.items.length, this.from);
    if (shot.heading) {
      text(ctx, shot.heading, W() / 2, 142, {
        size: 32, weight: 900, color: C.text, align: 'center', baseline: 'middle',
        alpha: enterAt(n, Math.max(this.from, frames[0] - 12)), maxW: DESIGN_SAFE.w,
      });
    }
    const rowH = 84;
    const top = shot.heading ? 208 : 168;
    const total = shot.items.length * rowH;
    const startY = top + Math.max(0, (DESIGN_SAFE.h - 60 - total) / 2);
    shot.items.forEach((it, i) => {
      const p = enterAt(n, frames[i]);
      if (p <= 0.01) return;
      const y = startY + i * rowH;
      ctx.save();
      ctx.globalAlpha = p;
      // 已落位的行保持呼吸，整段不静止
      const b = p >= 1 ? breathe(n + i * 22, 0.02, 40) : 1;
      ctx.translate(W() / 2, y + 34);
      ctx.scale(b, b);
      ctx.translate(-W() / 2, -(y + 34));
      panel(ctx, 190, y, 900, 68, {r: 10, fill: hexA(accent, 0.08), stroke: hexA(accent, 0.5), lw: 1.6});
      text(ctx, it.t, 230, y + 34, {size: 25, weight: 700, color: C.text, baseline: 'middle', maxW: it.d ? 480 : 820});
      if (it.d) {
        text(ctx, it.d, 1050, y + 34, {size: 21, weight: 600, color: C.dim, align: 'right', baseline: 'middle', maxW: 380});
      }
      ctx.restore();
    });
  },
};

const stat = {
  beats: (shot, start) => [start + 6, start + 46],
  draw(ctx, n, shot, accent) {
    const p = easeOut3(inv(n, this.from + 6, this.from + 46));
    const b = p >= 1 ? breathe(n, 0.03, 38) : 1;
    ctx.save();
    ctx.translate(W() / 2, 300);
    ctx.scale(b, b);
    ctx.translate(-W() / 2, -300);
    bigStat(ctx, W() / 2, 300, shot.value, shot.label, p, {
      color: accent, unit: shot.unit ?? '', label2: shot.label2 ?? '',
    });
    ctx.restore();
  },
};

const flowT = {
  beats: (shot, start, sid) => staggerFrames(sid, shot.boxes.length, start),
  draw(ctx, n, shot, accent) {
    const boxes = shot.boxes;
    const frames = staggerFrames(shot.sid, boxes.length, this.from);
    if (shot.heading) {
      section(ctx, 190, 150, 900, shot.heading, enterAt(n, Math.max(this.from, frames[0] - 12)), {color: accent});
    }
    const p = easeOut3(inv(n, frames[0] - 4, frames[frames.length - 1] + 24));
    flow(ctx, 190, 300, 900, 120, boxes.map((b, i) => ({label: b.label, sub: b.sub, color: i === 0 ? accent : undefined})), {p});
    // 落位后高亮沿流程循环走：持续动作，也提示阅读方向
    if (p >= 1) {
      const bw = (900 - 54 * (boxes.length - 1)) / boxes.length;
      const idx = Math.floor((n - this.from) / 60) % boxes.length;
      const x = 190 + idx * (bw + 54);
      const pulse = 0.35 + 0.35 * (0.5 + 0.5 * Math.sin((n - this.from) / 14));
      panel(ctx, x, 300, bw, 120, {r: 12, fill: null, stroke: hexA(accent, pulse), lw: 2.4, glow: hexA(accent, pulse * 0.8), glowBlur: 18});
    }
  },
};

const code = {
  beats: (shot, start, sid) => staggerFrames(sid, shot.lines.length, start),
  draw(ctx, n, shot, accent) {
    const lines = shot.lines;
    const frames = staggerFrames(shot.sid, lines.length, this.from);
    if (shot.heading) {
      section(ctx, 190, 150, 900, shot.heading, enterAt(n, Math.max(this.from, frames[0] - 12)), {color: accent});
    }
    // 逐行揭示；宽度按全量行先定死，避免加行时版面跳动
    const all = lines.map((l) => (typeof l === 'string' ? l : l.text));
    const k = Math.max(1, lines.filter((_, i) => n >= frames[i]).length);
    const cb = codeBlock(ctx, 190, 210, lines.slice(0, k), {
      size: 24, lh: 38, bg: C.codeBg, width: 900, marks: true, markColor: accent,
    });
    // 光标常闪在最新行的行尾
    const lastText = all[k - 1] ?? '';
    const caretX = 190 + 18 + Math.min(860, measure(lastText, font(24, F.mono, 400))) + 6;
    caret(ctx, caretX, 210 + cb.h - 38 + 6, 26, n, {color: accent, period: 30});
  },
};

const image = {
  beats: (shot, start, sid) => [staggerFrames(sid, 1, start)[0] + 6],
  draw(ctx, n, shot, accent) {
    const frames = staggerFrames(shot.sid, 1, this.from);
    if (shot.heading) {
      text(ctx, shot.heading, W() / 2, 150, {
        size: 30, weight: 900, color: C.text, align: 'center', baseline: 'middle',
        alpha: enterAt(n, frames[0]), maxW: DESIGN_SAFE.w,
      });
    }
    const p = enterAt(n, frames[0] + 6);
    if (p > 0.01) {
      ctx.save();
      ctx.globalAlpha = p;
      const b = p >= 1 ? breathe(n, 0.015, 42) : 1;
      const box = {x: 240, y: 210, w: 800, h: 380};
      ctx.translate(box.x + box.w / 2, box.y + box.h / 2);
      ctx.scale(b, b);
      ctx.translate(-(box.x + box.w / 2), -(box.y + box.h / 2));
      picture(ctx, shot.asset, box.x, box.y, box.w, box.h, {
        fit: 'contain', r: 12, border: hexA(accent, 0.4), lw: 1.6,
        glow: hexA(accent, 0.35), glowBlur: 24,
      });
      ctx.restore();
    }
    if (shot.note) {
      text(ctx, shot.note, W() / 2, 626, {size: 19, family: F.mono, color: C.faint, align: 'center', baseline: 'middle', alpha: p});
    }
  },
};

const compare = {
  beats: (shot, start, sid) => {
    const f = staggerFrames(sid, 2, start);
    // 两侧条目各自的进场也算拍（模板里是 f + 8 + i*10）
    const inner = Math.max(shot.left.items.length, shot.right.items.length);
    for (let i = 1; i < inner; i++) f.push(f[1] + 8 + i * 10);
    return f;
  },
  draw(ctx, n, shot, accent) {
    const frames = staggerFrames(shot.sid, 2, this.from);
    if (shot.heading) {
      section(ctx, 190, 150, 900, shot.heading, enterAt(n, Math.max(this.from, frames[0] - 12)), {color: accent});
    }
    [
      {s: shot.left, x: 190, f: frames[0]},
      {s: shot.right, x: 690, f: frames[1]},
    ].forEach(({s, x, f}, si) => {
      const p = enterAt(n, f);
      if (p <= 0.01) return;
      ctx.save();
      ctx.globalAlpha = p;
      panel(ctx, x, 220, 400, 340, {r: 14, fill: hexA(accent, 0.06), stroke: hexA(accent, 0.45), lw: 1.8});
      text(ctx, s.title, x + 28, 262, {size: 26, weight: 800, color: si === 0 ? C.dim : accent, baseline: 'middle', maxW: 344});
      rule(ctx, x + 28, 288, 344, p, {color: C.line, lw: 1.5});
      s.items.forEach((line, i) => {
        const ip = enterAt(n, f + 8 + i * 10);
        if (ip <= 0.01) return;
        text(ctx, line, x + 28, 322 + i * 40, {size: 21, weight: 600, color: C.text, baseline: 'middle', alpha: ip, maxW: 344});
      });
      ctx.restore();
    });
    // 两侧都落位后，中间的 VS 持续脉冲
    const both = Math.min(enterAt(n, frames[0]), enterAt(n, frames[1]));
    if (both > 0.5) {
      const pulse = 0.5 + 0.5 * Math.sin((n - this.from) / 16);
      text(ctx, 'VS', 640, 390, {
        size: 30, family: F.num, weight: 900, color: accent, align: 'center', baseline: 'middle',
        alpha: 0.55 + 0.45 * pulse, glow: hexA(accent, 0.6 * pulse), glowBlur: 22,
      });
    }
  },
};

// ---------- v0.2 扩充：steps / table / quote / terminal / chips / bars ----------

const steps = {
  beats: (shot, start, sid) => staggerFrames(sid, shot.steps.length, start),
  draw(ctx, n, shot, accent) {
    const rows = shot.steps;
    const frames = staggerFrames(shot.sid, rows.length, this.from);
    if (shot.heading) {
      section(ctx, 190, 150, 900, shot.heading, enterAt(n, Math.max(this.from, frames[0] - 12)), {color: accent});
    }
    const top = 220;
    const rowH = Math.min(96, Math.max(64, Math.floor(360 / rows.length)));
    const lineBottom = top + (rows.length - 1) * rowH + 28;
    // 连接线跟着最后一进的步骤生长
    const grown = frames.filter((f) => n >= f).length;
    const lp = easeOut3(inv(n, frames[0], frames[Math.max(0, grown - 1)] + 16));
    ctx.save();
    ctx.strokeStyle = hexA(accent, 0.35);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(250, top + 28);
    ctx.lineTo(250, top + 28 + (lineBottom - top - 28) * (rows.length > 1 ? lp : 0));
    ctx.stroke();
    ctx.restore();
    rows.forEach((st, i) => {
      const p = enterAt(n, frames[i]);
      if (p <= 0.01) return;
      const y = top + i * rowH;
      ctx.save();
      ctx.globalAlpha = p;
      // 循环点亮当前步骤：落位后仍有持续动作
      const active = p >= 1 && Math.floor((n - this.from) / 60) % rows.length === i;
      const pulse = active ? 0.5 + 0.5 * Math.sin((n - this.from) / 12) : 0;
      ctx.fillStyle = active ? hexA(accent, 0.9) : hexA(accent, 0.18);
      ctx.shadowColor = hexA(accent, 0.8);
      ctx.shadowBlur = active ? 10 + 14 * pulse : 0;
      ctx.beginPath();
      ctx.arc(250, y + 28, 26, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      text(ctx, String(i + 1), 250, y + 29, {
        size: 26, family: F.num, weight: 900, color: active ? C.bgDeep : accent,
        align: 'center', baseline: 'middle',
      });
      text(ctx, st.t, 310, st.d ? y + 18 : y + 28, {size: 27, weight: 800, color: C.text, baseline: 'middle', maxW: 780});
      if (st.d) {
        text(ctx, st.d, 310, y + 46, {size: 20, weight: 500, color: C.dim, baseline: 'middle', maxW: 780});
      }
      ctx.restore();
    });
  },
};

const table = {
  beats: (shot, start, sid) => staggerFrames(sid, shot.rows.length + 1, start),
  draw(ctx, n, shot, accent) {
    const cols = shot.columns;
    const rows = shot.rows;
    const frames = staggerFrames(shot.sid, rows.length + 1, this.from);
    if (shot.heading) {
      section(ctx, 190, 150, 900, shot.heading, enterAt(n, Math.max(this.from, frames[0] - 12)), {color: accent});
    }
    const x0 = 190, w = 900, rowH = 56, top = 220;
    const cw = w / cols.length;
    // 表头
    const hp = enterAt(n, frames[0]);
    if (hp > 0.01) {
      ctx.save();
      ctx.globalAlpha = hp;
      panel(ctx, x0, top, w, rowH, {r: 10, fill: hexA(accent, 0.16), stroke: hexA(accent, 0.5), lw: 1.6});
      cols.forEach((c, j) => {
        text(ctx, c, x0 + cw * j + 20, top + rowH / 2, {size: 23, weight: 800, color: accent, baseline: 'middle', maxW: cw - 30});
      });
      ctx.restore();
    }
    rows.forEach((r, i) => {
      const p = enterAt(n, frames[i + 1]);
      if (p <= 0.01) return;
      const y = top + rowH + 8 + i * (rowH - 6);
      ctx.save();
      ctx.globalAlpha = p;
      panel(ctx, x0, y, w, rowH - 6, {r: 8, fill: i % 2 ? hexA(C.panel, 0.55) : null, stroke: null});
      r.forEach((cell, j) => {
        text(ctx, cell ?? '', x0 + cw * j + 20, y + (rowH - 6) / 2, {
          size: 21, weight: j === 0 ? 700 : 500, color: j === 0 ? C.text : C.dim, baseline: 'middle', maxW: cw - 30,
        });
      });
      ctx.restore();
    });
    // 行扫描高亮：整表落位后的持续动作
    if (hp >= 1 && rows.every((_, i) => n >= frames[i + 1] + 20)) {
      const idx = Math.floor((n - this.from) / 50) % rows.length;
      const pulse = 0.25 + 0.3 * (0.5 + 0.5 * Math.sin((n - this.from) / 12));
      const y = top + rowH + 8 + idx * (rowH - 6);
      panel(ctx, x0, y, w, rowH - 6, {r: 8, fill: null, stroke: hexA(accent, pulse), lw: 1.8});
    }
  },
};

const quote = {
  beats: (shot, start, sid) => {
    const f0 = staggerFrames(sid, 1, start)[0];
    return [beatEnd(sid, f0, 22)];
  },
  draw(ctx, n, shot, accent) {
    const frames = staggerFrames(shot.sid, 1, this.from);
    const p = easeOut3(inv(n, frames[0], beatEnd(shot.sid, frames[0], 22)));
    const lines = (function () {
      // 手动折行：quote 的字号大，超宽必须换行而不是缩没
      const f = font(44, F.sans, 800);
      const out = [];
      let line = '';
      for (const ch of shot.text) {
        if (measure(line + ch, f) > 900 && line) { out.push(line); line = ch; }
        else line += ch;
      }
      if (line) out.push(line);
      return out.slice(0, 4);
    })();
    ctx.save();
    ctx.globalAlpha = p;
    ctx.translate(0, (1 - p) * 24);
    // 引号光晕脉动 = 落位后的持续动作
    const pulse = 0.5 + 0.5 * Math.sin(n / 18);
    text(ctx, '「', 640, 220, {
      size: 64, weight: 900, color: hexA(accent, 0.5 + 0.5 * pulse), align: 'center', baseline: 'middle',
      glow: hexA(accent, 0.7 * pulse), glowBlur: 26,
    });
    const startY = 320 - (lines.length - 1) * 30;
    lines.forEach((l, i) => {
      text(ctx, l, 640, startY + i * 60, {size: 44, weight: 800, color: C.text, align: 'center', baseline: 'middle'});
    });
    if (shot.who || shot.from) {
      const who = [shot.who, shot.from].filter(Boolean).join(' · ');
      text(ctx, '—— ' + who, 640, startY + lines.length * 60 + 20, {
        size: 22, weight: 500, color: C.faint, align: 'center', baseline: 'middle',
      });
    }
    ctx.restore();
  },
};

const terminalT = {
  beats: (shot, start, sid) => staggerFrames(sid, shot.lines.length, start),
  draw(ctx, n, shot, accent) {
    const lines = shot.lines.map((l) => (typeof l === 'string' ? {text: l} : l));
    const frames = staggerFrames(shot.sid, lines.length, this.from);
    if (shot.heading) {
      section(ctx, 190, 150, 900, shot.heading, enterAt(n, Math.max(this.from, frames[0] - 12)), {color: accent});
    }
    const size = 23, lh = 36, padding = 18, barH = 40;
    const height = barH + padding * 2 + lines.length * lh;   // 高度先定死，逐行揭示不跳窗
    const k = Math.max(1, lines.filter((_, i) => n >= frames[i]).length);
    terminalDraw(ctx, 190, 210, 900, lines.slice(0, k), {
      size, lh, padding, barH, height, title: shot.title ?? 'filmwright',
    });
    const lastText = lines[k - 1].text;
    const caretX = 190 + padding + Math.min(860, measure(lastText, font(size, F.mono, 400))) + 4;
    const caretY = 210 + barH + padding + (k - 1) * lh + 4;
    caret(ctx, caretX, caretY, lh - 10, n, {color: accent, period: 30});
  },
};

const chips = {
  beats: (shot, start, sid) => {
    const f0 = staggerFrames(sid, 1, start)[0];
    return [f0, beatEnd(sid, f0, 8 + shot.items.length * 10)];   // 逐颗点亮的终点也是拍
  },
  draw(ctx, n, shot, accent) {
    const frames = staggerFrames(shot.sid, 1, this.from);
    if (shot.heading) {
      section(ctx, 190, 150, 900, shot.heading, enterAt(n, Math.max(this.from, frames[0] - 12)), {color: accent});
    }
    // 揭示进度铺满整句的字幕块跨度；chips() 内部按 p 逐颗点亮。
    // 进度终点与 beats 用同一个 beatEnd 口径，两边不会打架。
    const end = beatEnd(shot.sid, frames[0], 8 + shot.items.length * 10);
    const p = easeOut3(inv(n, frames[0], end));
    if (p <= 0.01) return;
    ctx.save();
    ctx.globalAlpha = Math.min(1, p * 2);
    // 整块轻微呼吸 = 落位后的持续动作（chips 自己会摆位，不逐颗叠加）
    const b = p >= 1 ? breathe(n, 0.014, 44) : 1;
    ctx.translate(640, 340);
    ctx.scale(b, b);
    ctx.translate(-640, -340);
    chipsW(ctx, 190, 260, 900, shot.items, {p, size: 25, hgt: 54, color: accent});
    ctx.restore();
  },
};

const barsT = {
  beats: (shot, start, sid) => {
    const f0 = staggerFrames(sid, 1, start)[0];
    return [f0, beatEnd(sid, f0, 30)];   // 生长 30 帧走完（夹进镜头窗口）
  },
  draw(ctx, n, shot, accent) {
    const items = shot.items;
    const frames = staggerFrames(shot.sid, 1, this.from);
    if (shot.heading) {
      section(ctx, 190, 150, 900, shot.heading, enterAt(n, Math.max(this.from, frames[0] - 12)), {color: accent});
    }
    const p = easeOut3(inv(n, frames[0], beatEnd(shot.sid, frames[0], 30)));
    const x0 = 240, w = 800, h = 340, y0 = 200;
    barsDraw(ctx, x0, y0, w, h, shot.unit ? items.map((it) => ({...it, unit: it.unit ?? shot.unit})) : items,
      {p, baseColor: accent});
    // 循环描一根柱子的边：数值图落位后的持续动作
    if (p >= 1) {
      const gap = 10;
      const bw = (w - gap * (items.length - 1)) / items.length;
      const mx = Math.max(...items.map((it) => it.v));
      const idx = Math.floor((n - this.from) / 60) % items.length;
      const bh = (items[idx].v / mx) * h;
      const pulse = 0.3 + 0.35 * (0.5 + 0.5 * Math.sin((n - this.from) / 13));
      panel(ctx, x0 + idx * (bw + gap), y0 + h - bh, bw, bh, {
        r: 6, fill: null, stroke: hexA(accent, pulse), lw: 2, glow: hexA(accent, pulse * 0.7), glowBlur: 14,
      });
    }
  },
};

/** 模板注册表。键必须与 contract/scene.js 的 SHOT_TYPES 一致。 */
export const TEMPLATES = {
  title, bullets, stat, flow: flowT, code, image, compare,
  steps, table, quote, terminal: terminalT, chips, bars: barsT,
};

/**
 * 把校验过的 scene 编译成镜头数组（boot 的 SHOTS）。
 * 编译期只解析 at（需要时间轴数据）；字幕块查询留在 draw 里，运行时用已装载的时间轴。
 *
 * 每个镜头同时算出 **beats（节拍表，绝对帧号）**：模板画多少个错峰元素，就有
 * 多少拍。它交给画质自检当「入场/离场」的信号 —— 像素 diff 分不清一次变化是
 * 入场还是离场，而节拍是声明出来的事实（LIMITATIONS 里记的死结就靠它解开）。
 * 编译期与 draw 用同一个 staggerFrames，两边不会漂（有测试钉住）。
 */
export function compileScene(scene, tl) {
  return scene.shots.map((raw) => {
    const tpl = TEMPLATES[raw.type];
    if (!tpl) throw new Error('filmwright: scene 用了没有模板的类型 ' + raw.type);
    const start = resolveAt(raw.at, tl);
    const sid = typeof raw.at === 'string' ? raw.at
      : (raw.at && typeof raw.at === 'object' ? raw.at.s ?? null : null);
    const shot = {...raw, start, sid, beats: tpl.beats ? tpl.beats(raw, start, sid) : [start]};
    return {
      start,
      beats: shot.beats,
      // 场景规格里的 transition 透传给镜头层（crossfade/fade + frames）。
      // 它**不破坏纯函数不变量**：两个 draw 都只依赖 n，混合系数也是 n 的函数。
      ...(raw.transition !== undefined ? {transition: raw.transition} : {}),
      scene: shot,
      draw(ctx, n, t, accent) {
        ctx.save();
        applyDesignScale(ctx);
        try {
          tpl.draw.call(this, ctx, n, shot, accent ?? accentFor(1));
        } finally {
          ctx.restore();
        }
      },
    };
  });
}
