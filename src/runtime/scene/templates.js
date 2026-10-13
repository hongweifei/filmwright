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
import {text, panel, rule, codeBlock, caret, measure, font} from '../draw/primitives.js';
import {bigStat, flow, section} from '../draw/widgets.js';
import {picture} from '../draw/picture.js';
import {hexA} from '../draw/color.js';

const W = () => 1280;

/** 呼吸系数：幅度按静止阈值的口径给足。 */
const breathe = (n, amp = 0.035, period = 34) => 1 + Math.sin(n / period) * amp;

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

/** 模板注册表。键必须与 contract/scene.js 的 SHOT_TYPES 一致。 */
export const TEMPLATES = {title, bullets, stat, flow: flowT, code, image, compare};

/**
 * 把校验过的 scene 编译成镜头数组（boot 的 SHOTS）。
 * 编译期只解析 at（需要时间轴数据）；字幕块查询留在 draw 里，运行时用已装载的时间轴。
 */
export function compileScene(scene, tl) {
  return scene.shots.map((raw) => {
    const tpl = TEMPLATES[raw.type];
    if (!tpl) throw new Error('filmwright: scene 用了没有模板的类型 ' + raw.type);
    const start = resolveAt(raw.at, tl);
    const sid = typeof raw.at === 'string' ? raw.at
      : (raw.at && typeof raw.at === 'object' ? raw.at.s ?? null : null);
    const shot = {...raw, start, sid};
    return {
      start,
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
