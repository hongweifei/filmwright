// v0 的七个模板。每个模板是一个独立的 `{draw}` 对象，**互不引用**，只调 helpers 与库函数。
import {theme as C, fonts as F, accentFor} from '../../../contract/config.js';
import {inv, easeOut3} from '../../motion/ease.js';
import {applyDesignScale, DESIGN_SAFE} from '../../layout/design.js';
import {text, panel, rule, codeBlock, caret, measure, font, terminal as terminalDraw, bars as barsDraw, roundRect} from '../../draw/primitives.js';
import {bigStat, flow, section, chips as chipsW} from '../../draw/widgets.js';
import {picture, fitBox} from '../../draw/picture.js';
import {hexA} from '../../draw/color.js';
import {W, breathe, enterAt, staggerFrames, revealText} from './helpers.js';

// ---------- 各模板 ----------
// 约定：draw(ctx, n, shot, accent)，this 绑定镜头区间（this.from / this.to）。


export const title = {
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
    const titleOpt = {
      size: 104, family: F.wide, weight: 700, color: C.text, align: 'center', baseline: 'middle',
      spacing: 6, glow: hexA(accent, 0.6 + 0.4 * pulse), glowBlur: 32 + 14 * pulse, maxW: DESIGN_SAFE.w,
    };
    // ── 逐字入场（`reveal`）──
    // 现代动态图形最标志性的观感：字符一个一个进，而不是整块淡入。
    // ⚠️ 逐字定位的陷阱：**每个字必须按自己的 advance 居中**，不能沿用整串的 align ——
    // 早年手写逐字定位时忘了复位 textAlign，`"MoonBit"` 上屏成了 `"MoonB it"`。
    // 这里给每个字传 `align:'center'` + 它自己盒子的中心 x，从根上避开那个坑。
    // 纯函数：每个字的进度只依赖 n。
    if (shot.reveal) {
      // ⚠️ **base 必须相对镜头起点算**：title 的节拍是 `[start + 8, …]`，
      // 而 `start` 是**镜头**的起点（`this.from`）。
      // 原来这里写死 `8` —— 那只在「镜头恰好从第 1 帧开始」时才对。
      // 任何真实项目（镜头从第 100 帧起）里，逐字动画会在**镜头出现之前**就播完，
      // 观众看到的是「已经落位」⇒ 与整块画法一模一样，等于这个功能没做。
      // （`quote` 用 `frames[0]`、`bullets` 用 `Math.max(this.from, …)`，都是从镜头算的；
      //  只有 title 这一处漏了 —— 三处口径必须一致。）
      revealText(ctx, shot.title, cx, y, titleOpt, n, shot.reveal, this.from + 8);
    } else {
      text(ctx, shot.title, cx, y, titleOpt);
    }
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

export const bullets = {
  beats: (shot, start, sid) => staggerFrames(sid, shot.items.length, start),
  draw(ctx, n, shot, accent) {
    const frames = staggerFrames(shot.sid, shot.items.length, this.from);
    if (shot.heading) {
      const hBase = Math.max(this.from, frames[0] - 12);
      const hOpt = {
        size: 32, weight: 900, color: C.text, align: 'center', baseline: 'middle',
        alpha: enterAt(n, hBase), maxW: DESIGN_SAFE.w,
      };
      // 逐字入场同样下沉到 heading —— 与 title / quote 共用同一个 `revealText`。
      // 这里必须把整块的 `alpha: enterAt(...)` 交给逐字版自己算（每个字有自己的进度），
      // 否则「整块淡入」与「逐字入场」会叠在一起，看起来是双重淡入。
      if (shot.reveal) {
        revealText(ctx, shot.heading, W() / 2, 142, hOpt, n, shot.reveal, hBase);
      } else {
        text(ctx, shot.heading, W() / 2, 142, hOpt);
      }
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

export const stat = {
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

export const flowT = {
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

export const code = {
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

export const image = {
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

export const compare = {
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

