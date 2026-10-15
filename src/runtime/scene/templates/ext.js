// v0.2 扩充的八个模板。约定与 core.js 相同：`draw(ctx, n, shot, accent)`，`this` 绑定镜头区间。
import {theme as C, fonts as F, accentFor} from '../../../contract/config.js';
import {inv, easeOut3} from '../../motion/ease.js';
import {applyDesignScale, DESIGN_SAFE} from '../../layout/design.js';
import {text, panel, rule, codeBlock, caret, measure, font, terminal as terminalDraw, bars as barsDraw, roundRect} from '../../draw/primitives.js';
import {bigStat, flow, section, chips as chipsW} from '../../draw/widgets.js';
import {clipFrame} from '../../clips.js';
import {hexA} from '../../draw/color.js';
import {W, breathe, beatEnd, enterAt, staggerFrames, revealText, drawImageFit} from './helpers.js';

// ---------- v0.2 扩充：steps / table / quote / terminal / chips / bars ----------

export const steps = {
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

export const table = {
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

export const quote = {
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
    const lineOpt = {size: 44, weight: 800, color: C.text, align: 'center', baseline: 'middle'};
    // 逐字入场：**跨行接着数**（offset），所以整段是一句一句地进，不是每行从 0 重来
    let charBase = 0;
    lines.forEach((l, i) => {
      const y = startY + i * 60;
      if (shot.reveal) {
        revealText(ctx, l, 640, y, lineOpt, n, shot.reveal, frames[0], charBase);
        charBase += [...l].length;
      } else {
        text(ctx, l, 640, y, lineOpt);
      }
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

export const terminalT = {
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

export const chips = {
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

/**
 * `line` 模板：折线图，带**逐点绘制**动画与数值增长。
 *
 * 与 `bars` 的分工：bars 适合「几个离散项比大小」，line 适合「随时间的趋势」。
 *
 * 动画（都是 n 的纯函数）：
 *   - 折线从起点开始**逐段画出**（进度 p 控制画到第几个点）
 *   - 每个点落位后有一个高亮点（循环脉动，作为落位后的持续动作）
 *   - 末端点带数值标签，数字随绘制进度滚动
 *
 * 字段：`heading?`、`points`（[{v, label?}]，2–8 个）、`unit?`、`baseline?`（Y 轴起点，默认 0）
 */
export const lineT = {
  beats: (shot, start, sid) => {
    const f0 = staggerFrames(sid, 1, start)[0];
    // 绘制 40 帧 + 每个点落位各一拍（最多 3 拍，避免节拍过多挤压停留期）
    const n = Math.min(3, (shot.points ?? []).length);
    const out = [f0];
    for (let i = 1; i <= n; i++) out.push(beatEnd(sid, f0, 40 + i * 6));
    return out;
  },
  draw(ctx, n, shot, accent) {
    const pts = shot.points ?? [];
    if (pts.length < 2) return;
    const frames = staggerFrames(shot.sid, 1, this.from);
    if (shot.heading) {
      section(ctx, 190, 150, 900, shot.heading, enterAt(n, Math.max(this.from, frames[0] - 12)), {color: accent});
    }
    // 绘制进度：0..1 线性走完（用 easeOut3 让收尾更柔）
    const p = easeOut3(inv(n, frames[0], beatEnd(shot.sid, frames[0], 40)));

    const x0 = 260, y0 = 230, w = 760, h = 300;
    const base = shot.baseline ?? 0;
    const mx = Math.max(...pts.map((q) => q.v), base + 1e-6);
    const mn = Math.min(...pts.map((q) => q.v), base);
    const span = (mx - mn) || 1;
    const X = (i) => x0 + (w * i) / (pts.length - 1);
    const Y = (v) => y0 + h - ((v - mn) / span) * h;

    // 坐标轴：底边 + 左侧
    rule(ctx, x0, y0 + h, w, 1, {color: C.line});
    rule(ctx, x0, y0, 1, h, {color: C.line});

    // 折线：按进度画到第 k 段（最后一段按小数插值，画面连续）
    const total = pts.length - 1;
    const drawn = p * total;
    const k = Math.min(total, Math.floor(drawn));
    ctx.save();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.shadowColor = hexA(accent, 0.5);
    ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.moveTo(X(0), Y(pts[0].v));
    for (let i = 1; i <= k; i++) ctx.lineTo(X(i), Y(pts[i].v));
    if (k < total) {
      const frac = drawn - k;
      const x = X(k) + (X(k + 1) - X(k)) * frac;
      const y = Y(pts[k].v) + (Y(pts[k + 1].v) - Y(pts[k].v)) * frac;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();

    // 数据点：已画到的点才显示（每个点的出现时刻由它在折线上的位置决定）
    pts.forEach((q, i) => {
      const arrive = i / total;
      if (p + 1e-9 < arrive) return;
      const landed = Math.min(1, (p - arrive) * 6 + 0.001);
      const x = X(i), y = Y(q.v);
      // 点：外圈发光 + 内芯
      ctx.save();
      ctx.globalAlpha = landed;
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fillStyle = C.bg;
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = accent;
      ctx.stroke();
      // 落位后的持续动作：高亮环脉动（幅度按画质自检的静止阈值口径给足）
      const pulse = 0.25 + 0.3 * (0.5 + 0.5 * Math.sin((n - this.from) / 11 + i));
      ctx.beginPath();
      ctx.arc(x, y, 11 + 3 * pulse, 0, Math.PI * 2);
      ctx.strokeStyle = hexA(accent, pulse);
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();

      // 标签：X 轴
      if (q.label) {
        text(ctx, q.label, x, y0 + h + 26, {
          size: 18, family: F.mono, color: C.faint, align: 'center', baseline: 'middle',
          alpha: landed,
        });
      }
      // 末端点的数值：数字随进度滚到目标值
      if (i === pts.length - 1) {
        const shown = Math.round(q.v * p);
        text(ctx, String(shown) + (shot.unit ?? ''), x, y - 30, {
          size: 24, weight: 700, family: F.mono, color: accent, align: 'center', baseline: 'middle',
          alpha: landed,
        });
      }
    });
  },
};

export const barsT = {
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

/**
 * `clip` 模板：把视频/图片序列片段摆进画面，随时间播放。
 *
 * **取帧是同步的纯函数**：`clipFrame(name, n, {from, fps})` 按「全局帧 → 源帧号」
 * 查一张**已预解码**的图（见 runtime/clips.js）。源帧号只由 n 决定，所以
 * 「第 N 帧只是 N 的函数」不受影响 —— 抽帧那步 I/O 已经在宿主侧做完了。
 */
export const clipT = {
  beats: (shot, start) => [start + 6, start + 30],
  draw(ctx, n, shot, accent) {
    const frames = staggerFrames(shot.sid, 1, this.from);
    const p = enterAt(n, frames[0]);
    if (shot.heading) {
      text(ctx, shot.heading, W() / 2, 150, {
        size: 30, weight: 900, color: C.text, align: 'center', baseline: 'middle',
        alpha: p, maxW: DESIGN_SAFE.w,
      });
    }
    if (p <= 0.01) return;
    ctx.save();
    ctx.globalAlpha = p;
    const box = {x: 220, y: 200, w: 840, h: 400};
    // 取帧：from 默认 1（片段从它自己的第 1 帧开始放），fps 默认按输出帧率
    // 取帧：`from` = 本镜头起始帧（全局帧 this.from 对应片段的第 1 帧）。
    // 与 boot 里 collectClipUses 的 clipFrom 是同一个量 —— 两处必须一致，
    // 否则「预解码的区间」与「实际取用的帧」会错位（实测漏解前 18 帧）。
    const im = clipFrame(shot.clip, n, {from: this.from, fps: shot.fps ?? 30});
    drawImageFit(ctx, im, box, shot.fit ?? 'contain', accent);
    ctx.restore();
    if (shot.note) {
      text(ctx, shot.note, W() / 2, 626, {
        size: 19, family: F.mono, color: C.faint, align: 'center', baseline: 'middle', alpha: p,
      });
    }
  },
};

