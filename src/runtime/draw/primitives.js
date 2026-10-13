// Canvas 2D 图元库：全片共用的"脊柱"。镜头只组合这些，不要各写一份。
import {theme as C, fonts as F, view, accent} from '../../contract/config.js';
import {clamp} from '../motion/ease.js';

export const font = (size, family = F.sans, weight = 700) => `${weight} ${size}px ${family}`;

let measureCtx = null;
/** 用真实的浏览器字体度量文本宽度（字体加载后调用）。 */
export function measure(text, f) {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  measureCtx.font = f;
  return measureCtx.measureText(text).width;
}

/** 缩小字号直到宽度装得下。 */
export function fit(text, maxW, size, family = F.sans, weight = 700) {
  let s = size;
  for (let i = 0; i < 40 && s > 8; i++) {
    if (measure(text, font(s, family, weight)) <= maxW) break;
    s -= 1;
  }
  return s;
}

export function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** 面板：圆角、底色、描边，可选外发光。 */
export function panel(ctx, x, y, w, h, o = {}) {
  const {
    r = 14, fill = C.panel, stroke = C.line, lw = 2, glow = null, glowBlur = 26, alpha = 1,
  } = o;
  ctx.save();
  ctx.globalAlpha = alpha;
  if (glow) {
    ctx.shadowColor = glow;
    ctx.shadowBlur = glowBlur;
  }
  roundRect(ctx, x, y, w, h, r);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (glow) ctx.shadowBlur = 0;
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lw;
    ctx.stroke();
  }
  ctx.restore();
}

export function pill(ctx, x, y, w, h, o = {}) {
  panel(ctx, x, y, w, h, {r: h / 2, ...o});
}

/** 文本。x/y 为锚点，align 决定水平锚、baseline 决定垂直锚。 */
export function text(ctx, s, x, y, o = {}) {
  const {
    size = 28, family = F.sans, weight = 700, color = C.text,
    align = 'left', baseline = 'alphabetic', alpha = 1, spacing = 0,
    glow = null, glowBlur = 18, maxW = null, stroke = null, lw = 0,
  } = o;
  ctx.save();
  ctx.globalAlpha = alpha;
  let use = size;
  if (maxW !== null) use = fit(s, maxW, size, family, weight);
  ctx.font = font(use, family, weight);
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  // 字距用原生 letterSpacing（Chromium 支持）。早先手写逐字定位时忘了把 textAlign
  // 复位成 left，每个字都按中心画，于是 "MoonBit" 上屏成 "MoonB it"。
  if (spacing && 'letterSpacing' in ctx) ctx.letterSpacing = spacing + 'px';
  if (glow) {
    ctx.shadowColor = glow;
    ctx.shadowBlur = glowBlur;
  }
  if (stroke) {
    ctx.lineWidth = lw;
    ctx.strokeStyle = stroke;
    ctx.strokeText(s, x, y);
  }
  ctx.fillStyle = color;
  ctx.fillText(s, x, y);
  if (spacing && 'letterSpacing' in ctx) ctx.letterSpacing = '0px';
  ctx.restore();
  return use;
}

/** 把文本按最大宽度折行。 */
export function wrap(ctx, s, maxW, f) {
  ctx.font = f;
  const out = [];
  let line = '';
  for (const ch of [...s]) {
    if (ch === '\n') {
      out.push(line);
      line = '';
      continue;
    }
    if (ctx.measureText(line + ch).width > maxW && line) {
      out.push(line);
      line = ch;
    } else {
      line += ch;
    }
  }
  if (line) out.push(line);
  return out;
}

/** 发光包裹：在回调里画的东西带光晕。 */
export function glowWith(ctx, color, blur, fn) {
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  fn();
  ctx.restore();
}

/** 横向箭头。 */
export function arrowR(ctx, x, y, w, o = {}) {
  const {color = C.dim, lw = 2, head = 9} = o;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w - head, y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x + w, y);
  ctx.lineTo(x + w - head, y - head * 0.62);
  ctx.lineTo(x + w - head, y + head * 0.62);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * 代码块：等宽字体，行首可选行号，可按回调给每行上色。
 * lines: [{text, color?, mark?: 'add'|'hl'|'err'}] 或纯字符串数组。
 */
export function codeBlock(ctx, x, y, lines, o = {}) {
  const {
    size = 26, lh = 40, color = '#C8D4E8', numColor = C.faint,
    nums = false, marks = true, padding = 18, markColor = C.hi,
    bg = null, r = 12, width = null,
  } = o;
  const rows = lines.map((l) => (typeof l === 'string' ? {text: l} : l));
  const w = width ?? Math.max(...rows.map((r2) => measure(r2.text, font(size, F.mono, 400)))) + padding * 2 + (nums ? 44 : 0);
  const h = rows.length * lh + padding * 2;
  if (bg) panel(ctx, x, y, w, h, {r, fill: bg, stroke: C.lineSoft});
  rows.forEach((row, i) => {
    const ty = y + padding + lh * i + lh * 0.72;
    if (marks && row.mark) {
      const mc = row.mark === 'err' ? C.bad : row.mark === 'ok' ? C.ok : markColor;
      ctx.save();
      ctx.globalAlpha = 0.16;
      roundRect(ctx, x + 6, y + padding + lh * i + 2, w - 12, lh - 6, 6);
      ctx.fillStyle = mc;
      ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.fillStyle = mc;
      roundRect(ctx, x + 6, y + padding + lh * i + 2, 4, lh - 6, 2);
      ctx.fill();
      ctx.restore();
    }
    if (nums) text(ctx, String(i + 1), x + padding + 30, ty, {size: size * 0.8, family: F.mono, weight: 400, color: numColor, align: 'right'});
    text(ctx, row.text, x + padding + (nums ? 52 : 0), ty, {size, family: F.mono, weight: 400, color: row.color ?? color});
  });
  return {w, h};
}

/** 终端窗口：标题栏 + 内容行。 */
export function terminal(ctx, x, y, w, lines, o = {}) {
  const {size = 25, lh = 38, title = 'terminal', titleColor = C.dim, padding = 18, r = 12, barH = 40, height = null} = o;
  const rows = lines.map((l) => (typeof l === 'string' ? {text: l} : l));
  const h = height ?? rows.length * lh + padding * 2 + barH;
  panel(ctx, x, y, w, h, {r, fill: C.termBg, stroke: C.line});
  // 标题栏
  ctx.save();
  roundRect(ctx, x, y, w, barH, r);
  ctx.fillStyle = C.panelHi;
  ctx.fill();
  ctx.fillRect(x, y + barH - r, w, r);
  ctx.restore();
  ctx.save();
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y + barH);
  ctx.lineTo(x + w, y + barH);
  ctx.stroke();
  ctx.restore();
  ['#FF6B6B', '#F5B942', '#35D07F'].forEach((c, i) => {
    ctx.beginPath();
    ctx.arc(x + 22 + i * 20, y + barH / 2, 6, 0, Math.PI * 2);
    ctx.fillStyle = c;
    ctx.globalAlpha = 0.85;
    ctx.fill();
    ctx.globalAlpha = 1;
  });
  text(ctx, title, x + w / 2, y + barH / 2 + 2, {size: 20, family: F.mono, weight: 400, color: titleColor, align: 'center', baseline: 'middle'});
  rows.forEach((row, i) => {
    const ty = y + barH + padding + lh * i + lh * 0.72;
    text(ctx, row.text, x + padding, ty, {
      size, family: F.mono, weight: 400,
      color: row.color ?? '#B9C6DC',
    });
  });
  return {w, h};
}

/** 光标块（终端/输入框的闪烁竖线）。n 为帧号。 */
export function caret(ctx, x, y, h, n, o = {}) {
  const {color = accent(0), w = 3, period = 30} = o;
  const on = Math.floor(n / (period / 2)) % 2 === 0;
  if (!on) return;
  ctx.save();
  ctx.globalAlpha = 0.9;
  ctx.shadowColor = color;
  ctx.shadowBlur = 10;
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

/** 水平分隔线，p 为 0..1 的展开进度。 */
export function rule(ctx, x, y, w, p, o = {}) {
  const {color = C.line, lw = 2, align = 'left'} = o;
  ctx.save();
  ctx.fillStyle = color;
  const ww = w * clamp(p);
  ctx.fillRect(align === 'center' ? x - ww / 2 : align === 'right' ? x - ww : x, y, ww, lw);
  ctx.restore();
}

/** 竖向条形图（用于性能比值一类）。 */
export function bars(ctx, x, y, w, h, items, o = {}) {
  const {gap = 10, labelSize = 19, valueSize = 20, max = null, baseColor = accent(0), hiIndex = -1, p = 1} = o;
  const mx = max ?? Math.max(...items.map((i) => i.v));
  const bw = (w - gap * (items.length - 1)) / items.length;
  items.forEach((it, i) => {
    const bh = (it.v / mx) * h * clamp(p);
    const bx = x + i * (bw + gap);
    const isHi = i === hiIndex;
    panel(ctx, bx, y + h - bh, bw, bh, {
      r: 6,
      fill: it.color ?? (isHi ? C.hi : baseColor),
      stroke: null,
      glow: p > 0.35 ? (it.color ?? (isHi ? C.hi : baseColor)) : null,
      glowBlur: 16,
    });
    text(ctx, it.v.toFixed(1) + (it.unit ?? ''), bx + bw / 2, y + h - bh - 12, {
      size: valueSize, family: F.num, weight: 700, color: isHi ? C.hi : C.text, align: 'center',
    });
    text(ctx, it.label, bx + bw / 2, y + h + 26, {
      size: labelSize, family: F.sans, weight: 600, color: isHi ? C.hi : C.dim, align: 'center',
    });
  });
}

/** 十六进制转储：每行 offset + 16 字节 + ASCII。highlight 为要高亮的字节下标集合。 */
export function hexdump(ctx, x, y, bytes, o = {}) {
  const {
    size = 22, lh = 32, perLine = 16, hi = new Set(), hiColor = C.ok,
    color = '#9FB0C8', offColor = C.faint, divideAfter = null,
  } = o;
  for (let i = 0; i < bytes.length; i += perLine) {
    const row = i / perLine;
    const ty = y + row * lh;
    text(ctx, i.toString(16).padStart(8, '0'), x, ty, {size: size * 0.92, family: F.mono, weight: 400, color: offColor});
    let cx = x + measure('00000000', font(size * 0.92, F.mono, 400)) + 22;
    for (let j = 0; j < perLine && i + j < bytes.length; j++) {
      const idx = i + j;
      const s = bytes[idx].toString(16).padStart(2, '0');
      const isHi = hi.has(idx);
      text(ctx, s, cx, ty, {
        size, family: F.mono, weight: isHi ? 700 : 400,
        color: isHi ? hiColor : color,
        glow: isHi ? hiColor : null, glowBlur: 12,
      });
      cx += measure('00', font(size, F.mono, 700)) + 12;
    }
    if (divideAfter !== null && (i === divideAfter - perLine || (i < divideAfter && i + perLine > divideAfter))) {
      // 分界虚线画在两行之间
      ctx.save();
      ctx.setLineDash([6, 6]);
      ctx.strokeStyle = C.hi;
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.75;
      ctx.beginPath();
      ctx.moveTo(x - 12, ty + lh * 0.42);
      ctx.lineTo(x + 640, ty + lh * 0.42);
      ctx.stroke();
      ctx.restore();
    }
  }
}

/** 放大镜/聚光圈：把注意力压在某个矩形上，外面压暗。 */
export function spotlight(ctx, x, y, w, h, strength = 0.72, r = 10) {
  ctx.save();
  ctx.fillStyle = `rgba(3,5,10,${strength})`;
  ctx.beginPath();
  ctx.rect(0, 0, view.W, view.H);
  roundRect(ctx, x, y, w, h, r);
  ctx.fill('evenodd');
  ctx.restore();
}

/** 网格背景：轻微的技术感底纹。 */
export function grid(ctx, n, o = {}) {
  const {step = 64, color = 'rgba(60,90,140,0.09)', drift = 0} = o;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  const off = (drift % step);
  for (let x = -step + off; x < view.W + step; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, view.H);
    ctx.stroke();
  }
  for (let y = -step + off; y < view.H + step; y += step) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(view.W, y);
    ctx.stroke();
  }
  ctx.restore();
}
