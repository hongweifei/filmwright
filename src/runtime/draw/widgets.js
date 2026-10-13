// 更高一层的共用图元：计数、矩阵、流程图、标签列表。
// 章节镜头用这些组合，不要各画一份。
import {theme as C, fonts as F, accent} from '../../contract/config.js';
import {text, panel, roundRect, measure, font} from './primitives.js';
import {clamp, inv, easeOut3} from '../motion/ease.js';
import {hexA} from './color.js';

/** 滚动计数：从 0 数到 value，t 为 0..1 的进度。 */
export function counter(value, t) {
  const p = easeOut3(clamp(t));
  return Math.round(value * p);
}

/** 大数字 + 单位 + 标签。 */
export function bigStat(ctx, x, y, value, label, t, o = {}) {
  const {color = C.text, size = 96, unit = '', label2 = '', unitSize = 40} = o;
  const p = easeOut3(clamp(t));
  const shown = Math.round(value * p);
  const vs = String(shown);
  const w = measure(vs, font(size, F.num, 900));
  ctx.save();
  ctx.globalAlpha = p;
  text(ctx, vs, x, y, {
    size, family: F.num, weight: 900, color, align: 'center', baseline: 'middle',
    glow: hexA(color, 0.85), glowBlur: 28,
  });
  if (unit) {
    text(ctx, unit, x + w / 2 + 6 + measure(unit, font(unitSize, F.num, 700)) / 2, y, {
      size: unitSize, family: F.num, weight: 700, color, align: 'center', baseline: 'middle', alpha: 0.75,
    });
  }
  text(ctx, label, x, y + size * 0.72, {
    size: 24, weight: 600, color: C.dim, align: 'center', baseline: 'middle',
  });
  if (label2) {
    text(ctx, label2, x, y + size * 0.72 + 34, {
      size: 19, family: F.mono, weight: 400, color: C.faint, align: 'center', baseline: 'middle',
    });
  }
  ctx.restore();
}

/**
 * 格子矩阵：用于「31 文件 × 3 形状」。cells 为 {ok:boolean, label} 的数组（行优先）。
 * revealT 控制逐格亮起的进度。
 */
export function matrix(ctx, x, y, cols, cells, o = {}) {
  const {
    cw = 30, ch = 30, gap = 6, okColor = C.ok, badColor = C.bad,
    reveal = 1, alpha = 1, borderOnly = false, offColor = '#1B2436',
  } = o;
  ctx.save();
  ctx.globalAlpha = alpha;
  const rows = Math.ceil(cells.length / cols);
  cells.forEach((cell, i) => {
    const cx = x + (i % cols) * (cw + gap);
    const cy = y + Math.floor(i / cols) * (ch + gap);
    const appear = clamp((reveal * cells.length - i) * 1.4);
    if (appear <= 0) return;
    const on = cell && cell.ok;
    const col = !cell ? offColor : on ? okColor : badColor;
    ctx.save();
    ctx.globalAlpha = alpha * appear;
    if (borderOnly || !cell) {
      ctx.strokeStyle = hexA(col, cell ? 0.75 : 0.35);
      ctx.lineWidth = 1.6;
      roundRect(ctx, cx, cy, cw, ch, 5);
      ctx.stroke();
    } else {
      ctx.shadowColor = col;
      ctx.shadowBlur = on ? 7 : 10;
      ctx.fillStyle = hexA(col, on ? 0.85 : 0.9);
      roundRect(ctx, cx, cy, cw, ch, 5);
      ctx.fill();
    }
    ctx.restore();
  });
  ctx.restore();
  return {w: cols * (cw + gap) - gap, h: rows * (ch + gap) - gap};
}

/** 一行「输入 → 处理 → 输出」的流程盒。boxes 为 {label, sub, color}。 */
export function flow(ctx, x, y, w, h, boxes, o = {}) {
  const {gap = 54, p = 1, arrowColor = C.line, boxFill = C.panel} = o;
  const bw = (w - gap * (boxes.length - 1)) / boxes.length;
  boxes.forEach((b, i) => {
    const bx = x + i * (bw + gap);
    const local = clamp((p * boxes.length - i) * 1.6);
    if (local <= 0) return;
    ctx.save();
    ctx.globalAlpha = local;
    panel(ctx, bx, y, bw, h, {
      r: 12, fill: boxFill, stroke: hexA(b.color ?? C.line, 0.9), lw: 2,
      glow: b.color ? hexA(b.color, 0.4 * local) : null, glowBlur: 20,
    });
    text(ctx, b.label, bx + bw / 2, y + h / 2 - (b.sub ? 12 : 0), {
      size: b.size ?? 25, weight: 700, color: C.text, align: 'center', baseline: 'middle', maxW: bw - 20,
    });
    if (b.sub) {
      text(ctx, b.sub, bx + bw / 2, y + h / 2 + 20, {
        size: 17, family: F.mono, weight: 400, color: b.color ?? C.dim,
        align: 'center', baseline: 'middle', maxW: bw - 16,
      });
    }
    ctx.restore();
    if (i < boxes.length - 1) {
      const ax = bx + bw + 8, ay = y + h / 2;
      const aw = gap - 16;
      const ap = clamp((p * boxes.length - i - 0.5) * 1.6);
      if (ap > 0) {
        ctx.save();
        ctx.globalAlpha = ap;
        ctx.strokeStyle = arrowColor;
        ctx.fillStyle = arrowColor;
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(ax + aw - 8, ay);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(ax + aw, ay);
        ctx.lineTo(ax + aw - 9, ay - 6);
        ctx.lineTo(ax + aw - 9, ay + 6);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }
  });
}

/** 标签胶囊列表（自动折行）。 */
export function chips(ctx, x, y, w, items, o = {}) {
  const {
    size = 21, hgt = 44, gapX = 12, gapY = 12, p = 1,
    color = accent(0), fill = null,
  } = o;
  let cx = x, cy = y, row = 0;
  items.forEach((it, i) => {
    const label = typeof it === 'string' ? it : it.label;
    const c = (typeof it === 'object' && it.color) || color;
    const tw = measure(label, font(size, F.sans, 700)) + 34;
    if (cx + tw > x + w && cx > x) {
      cx = x;
      cy += hgt + gapY;
      row++;
    }
    const local = clamp((p * items.length - i) * 1.5);
    if (local > 0) {
      ctx.save();
      ctx.globalAlpha = local;
      panel(ctx, cx, cy, tw, hgt, {
        r: hgt / 2, fill: fill ?? hexA(c, 0.13), stroke: hexA(c, 0.65), lw: 1.6,
      });
      text(ctx, label, cx + tw / 2, cy + hgt / 2, {
        size, weight: 700, color: C.text, align: 'center', baseline: 'middle',
      });
      ctx.restore();
    }
    cx += tw + gapX;
  });
  return cy + hgt - y;
}

/** 一个带标题的区块（标题 + 细分隔线 + 内容由回调画）。 */
export function section(ctx, x, y, w, title, p, o = {}) {
  const {color = accent(0), size = 24, sub = null} = o;
  const a = easeOut3(clamp(p));
  if (a <= 0.01) return;
  ctx.save();
  ctx.globalAlpha = a;
  text(ctx, title, x, y, {size, weight: 700, color});
  if (sub) {
    text(ctx, sub, x + measure(title, font(size, F.sans, 700)) + 12, y - 1, {
      size: 17, family: F.mono, weight: 400, color: C.faint,
    });
  }
  ctx.fillStyle = hexA(color, 0.35);
  ctx.fillRect(x, y + 12, w * a, 2);
  ctx.restore();
}

/** 行内代码片（等宽 + 底色）。 */
export function code(ctx, s, x, y, o = {}) {
  const {size = 22, color = accent(3), padX = 10, bg = null, align = 'left'} = o;
  const w = measure(s, font(size, F.mono, 600)) + padX * 2;
  const bx = align === 'center' ? x - w / 2 : x;
  if (bg) {
    panel(ctx, bx, y - size * 0.82, w, size * 1.7, {r: 6, fill: bg, stroke: null});
  }
  text(ctx, s, bx + padX, y, {size, family: F.mono, weight: 600, color});
  return w;
}
