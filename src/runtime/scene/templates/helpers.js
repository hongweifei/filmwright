// 模板共享的助手：时间与节奏换算、逐字入场、按 fit 摆图。
// 从 templates.js（原 1036 行）拆出 —— 16 个模板都只调这些助手，**模板之间零互相引用**。
import {S, BLK} from '../../../contract/timeline.js';
import {inv, easeOut3} from '../../motion/ease.js';
import {text, panel, rule, codeBlock, caret, measure, font, terminal as terminalDraw, bars as barsDraw, roundRect} from '../../draw/primitives.js';
import {picture, fitBox} from '../../draw/picture.js';
import {hexA} from '../../draw/color.js';

export const W = () => 1280;

/** 呼吸系数：幅度按静止阈值的口径给足。 */
export const breathe = (n, amp = 0.035, period = 34) => 1 + Math.sin(n / period) * amp;

/**
 * 末拍预留帧数：镜头内容必须在这之前全部落位，给观众留出「看完」的时间。
 * 与画质自检的 holdFrames 默认值同数（那边判失败，这边不越界）——
 * 模板主动压节拍，比事后被自检打回更省一轮。
 */
export const HOLD_RESERVE = 30;

/**
 * 把「入场起点 + 动画时长」夹进镜头可用的节拍窗口内（末拍必须留出 HOLD_RESERVE）。
 * 模板里凡是「某个动画走 N 帧才结束」的地方都用它，别各写一份。
 */
export function beatEnd(sid, start, dur) {
  const s = sid ? S(sid) : null;
  const horizon = s ? s.to - HOLD_RESERVE : start + dur;
  return Math.min(start + dur, Math.max(start + 4, horizon));
}

/** 单元素入场进度（提前 4 帧起、20 帧走完，与示例片同一口径）。 */
export const enterAt = (n, f) => easeOut3(inv(n, f, f + 20));

/**
 * 元素进场的帧号表：跟着对齐句的字幕块走，块不够就从最后一块按 18 帧铺；
 * 没有句锚点（数字对齐）就按时间均匀铺。
 */
export function staggerFrames(sid, count, from) {
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


/**
 * 逐字入场：把一串文字**按码点**逐字画出来，每字带自己的落位偏移与透明度。
 *
 * ⚠️ 逐字定位的陷阱：**每个字必须按自己的 advance 居中**，不能沿用整串的 align ——
 * 早年手写逐字定位时忘了复位 textAlign，`"MoonBit"` 上屏成了 `"MoonB it"`。
 * 这里给每个字传 `align:'center'` + 它自己盒子的中心 x，从根上避开那个坑。
 *
 * 纯函数：每个字的进度只依赖 n。
 * `offset` 让**跨行接着数** —— `quote` 折行之后，整段仍是一句一句地进，而不是每行从 0 重来。
 *
 * @param {object} rv `{stagger, dur, dy}`：字间隔几帧 / 单字用几帧 / 从下方多少像素落位
 * @param {number} base 第一个字开始入场的帧号
 * @param {number} offset 本串第一个字在整段里的序号（跨行用）
 */
export function revealText(ctx, str, x, y, opt, n, rv, base, offset = 0) {
  // ⚠️ **`base` 非有限时退化成整块画法，而不是让文字消失。**
  // 三个调用点里有两个的 `base` 是从镜头算出来的（`this.from + 8` / `Math.max(this.from, …)`），
  // 一旦哪一层没把 `from` 传下来，`base` 就是 `NaN` ⇒ 每个字的进度都是 `NaN`
  // ⇒ `if (t > 0)` 全为假 ⇒ **一个字都不画**：文字**静默消失**，而不是报错。
  // 那是个很难查的失败模式（画面看起来只是"少了一行字"），所以宁可退回整块画法。
  if (!Number.isFinite(base)) {
    text(ctx, String(str), x, y, {...opt, maxW: opt.maxW ?? null});
    return;
  }
  const chars = [...String(str)];              // 按**码点**切：中文/emoji 都不能按 UTF-16 切
  const per = rv.stagger ?? 3;
  const dur = rv.dur ?? 12;
  const dy = rv.dy ?? 26;
  const spacing = opt.spacing ?? 0;
  const f = font(opt.size, opt.family, opt.weight);
  const adv = chars.map((c) => measure(c, f));
  const totalW = adv.reduce((a, b) => a + b, 0) + spacing * Math.max(0, chars.length - 1);
  let px = x - totalW / 2;
  for (const [i, c] of chars.entries()) {
    const t0 = base + (offset + i) * per;
    const t = easeOut3(inv(n, t0, t0 + dur));
    if (t > 0) text(ctx, c, px + adv[i] / 2, y + (1 - t) * dy, {...opt, maxW: null, alpha: t});
    px += adv[i] + spacing;
  }
}


/** 把一张图按 fit 规则摆进框，带描边与发光（与 picture 同一套观感）。 */
export function drawImageFit(ctx, im, box, fit, accent) {
  const natW = im.naturalWidth || im.width || box.w;
  const natH = im.naturalHeight || im.height || box.h;
  const {dw, dh} = fitBox(natW, natH, box.w, box.h, fit);
  const dx = box.x + (box.w - dw) / 2;
  const dy = box.y + (box.h - dh) / 2;
  ctx.save();
  roundRect(ctx, box.x, box.y, box.w, box.h, 12);
  ctx.clip();
  ctx.drawImage(im, dx, dy, dw, dh);
  ctx.restore();
  ctx.save();
  ctx.strokeStyle = hexA(accent, 0.4);
  ctx.lineWidth = 1.6;
  ctx.shadowColor = hexA(accent, 0.35);
  ctx.shadowBlur = 24;
  roundRect(ctx, box.x, box.y, box.w, box.h, 12);
  ctx.stroke();
  ctx.restore();
}
