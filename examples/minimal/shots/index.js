// 最小示例的镜头。注意 import 的是 'filmwright'（由 importmap 解析），
// 并且每个镜头只声明 start —— 区间由 filmwright 串接，不要自己写 to。
import {
  text, panel, rule, view, theme as C, fonts as F,
  S, BLK, cutBefore, cardFrom,
  inv, easeOut3, easeOut4, hexA, bigStat, chips, picture,
  applyDesignScale,
} from 'filmwright';

// 布局一律按设计基准 1280×720 算（配合 applyDesignScale，输出多少分辨率都一致）。
const W = () => 1280;
const H = () => 720;

// 镜头按设计基准写坐标；applyDesignScale 让它在 1080p 上也等比放大。
// 必须用 function（不是箭头函数）并 fn.call(this,…)：镜头里会读 this.from，
// 箭头函数会把 this 丢掉，导致每帧都抛错。
const withDesign = function (fn) {
  return function (ctx, n, t, accent) {
    ctx.save();
    applyDesignScale(ctx);
    try { fn.call(this, ctx, n, t, accent); } finally { ctx.restore(); }
  };
};

// ---------- 片头 ----------
const TITLE = {
  start: 1,
  draw(ctx, n) {
    const a = easeOut3(inv(n, 8, 40));
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(0, (1 - easeOut4(a)) * 26);
    text(ctx, 'filmwright', W() / 2, 296, {
      size: 104, family: F.wide, weight: 700, color: C.text, align: 'center', baseline: 'middle',
      spacing: 6, glow: hexA(C.accents[0], 1), glowBlur: 40,
    });
    text(ctx, '最小示例片', W() / 2, 390, {
      size: 34, weight: 700, color: C.accents[0], align: 'center', baseline: 'middle', spacing: 4,
    });
    rule(ctx, W() / 2, 430, 300, easeOut3(inv(n, 30, 58)), {color: C.line, lw: 2, align: 'center'});
    text(ctx, 'Draw every frame from its number', W() / 2, 468, {
      size: 21, family: F.mono, weight: 400, color: C.faint, align: 'center', baseline: 'middle',
    });
    ctx.restore();
  },
};

// ---------- 纯函数示意 ----------
const PURE = {
  start: cutBefore('S01'),
  draw(ctx, n) {
    const t0 = Math.max(this.from, S('S01').from - 2);
    text(ctx, '每一帧 = 一个纯函数', W() / 2, 150, {
      size: 36, weight: 900, color: C.text, align: 'center', baseline: 'middle',
      alpha: easeOut3(inv(n, t0, t0 + 14)),
    });
    const a = easeOut3(inv(n, BLK('S02', 1) - 4, BLK('S02', 1) + 16));
    if (a > 0.01) {
      // 缓慢呼吸：内容停住时也要有持续动作，否则观众会觉得卡住
      // （画质自检会把「连续静止 >3s」报出来）。
      // 幅度要给够 —— 0.5% 那种在这个采样口径下读不到，等于没有动作。
      const breathe = 1 + Math.sin(n / 34) * 0.035;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.translate(W() / 2, 295);
      ctx.scale(breathe, breathe);
      ctx.translate(-W() / 2, -295);
      panel(ctx, 240, 220, 800, 150, {
        r: 16, fill: hexA(C.accents[0], 0.10), stroke: C.accents[0], lw: 2.4,
        glow: hexA(C.accents[0], 0.5 + 0.35 * Math.sin(n / 34)), glowBlur: 28,
      });
      text(ctx, 'drawFrame(ctx, N)', W() / 2, 278, {
        size: 40, family: F.mono, weight: 700, color: C.text, align: 'center', baseline: 'middle',
      });
      text(ctx, '只读 N，不读上一帧、不累积状态', W() / 2, 330, {
        size: 23, weight: 600, color: C.dim, align: 'center', baseline: 'middle',
      });
      ctx.restore();
    }
    const b = easeOut3(inv(n, BLK('S03', 1) - 4, BLK('S03', 1) + 18));
    if (b > 0.01) {
      chips(ctx, 200, 420, 880, [
        {label: '可平行渲染', color: C.accents[1]},
        {label: '可跳帧出静帧', color: C.accents[1]},
        {label: '可全量自检', color: C.accents[1]},
      ], {p: b, size: 24, hgt: 54});
    }
    // 素材（图片）：boot 时已经加载完，这里同步摆它就行。
    // 用 picture 而不是 ctx.drawImage —— 名字写错会当场报错并列出可用名字。
    const c = easeOut3(inv(n, BLK('S03', 2) - 6, BLK('S03', 2) + 16));
    if (c > 0.01) {
      picture(ctx, 'filmstrip', 320, 492, 640, 96, {
        fit: 'contain', alpha: c, r: 8,
        glow: hexA(C.accents[2], 0.45), glowBlur: 18,
        border: hexA(C.accents[2], 0.35), lw: 1.4,
      });
    }
  },
};

// ---------- 分片并行 ----------
const SHARDS = {
  start: cutBefore('S04'),
  draw(ctx, n) {
    const t0 = Math.max(this.from, BLK('S04', 1) - 6);
    text(ctx, '切成几段，同时开几个实例', W() / 2, 142, {
      size: 32, weight: 900, color: C.text, align: 'center', baseline: 'middle',
      alpha: easeOut3(inv(n, t0, t0 + 14)),
    });
    const p = easeOut3(inv(n, BLK('S05', 1) - 6, BLK('S05', 1) + 30));
    const lanes = 4;
    const bw = 200, gap = 24;
    const x0 = W() / 2 - (lanes * bw + (lanes - 1) * gap) / 2;
    // 各片进度循环前进：内容停住时也要有持续动作。
    // 走满一轮就从头再来 —— 这样整段都有可见变化，而不是填满后就定住。
    const laneProgress = (i) => {
      const elapsed = n - (this.from + 40 + i * 12);
      if (elapsed <= 0) return 0;
      const cycle = elapsed / 90;          // 90 帧走完一轮
      return cycle - Math.floor(cycle);    // 取小数部分：0→1 循环
    };
    for (let i = 0; i < lanes; i++) {
      const local = Math.max(0, Math.min(1, (p * lanes - i) * 1.6));
      if (local <= 0.01) continue;
      const x = x0 + i * (bw + gap);
      const done = laneProgress(i);
      ctx.save();
      ctx.globalAlpha = local;
      panel(ctx, x, 210, bw, 56, {
        r: 10, fill: hexA(C.accents[1], 0.12), stroke: hexA(C.accents[1], 0.6), lw: 1.6,
      });
      text(ctx, `分片 ${i + 1}`, x + bw / 2, 238, {
        size: 22, weight: 700, color: C.text, align: 'center', baseline: 'middle',
      });
      // 进度条：随帧推进
      const pw = bw - 24;
      panel(ctx, x + 12, 286, pw, 12, {r: 6, fill: '#141C2C', stroke: null});
      if (done > 0.005) {
        panel(ctx, x + 12, 286, pw * done, 12, {
          r: 6, fill: C.accents[1], stroke: null, glow: C.accents[1], glowBlur: 12,
        });
      }
      ctx.restore();
    }
    text(ctx, '各片区间独立，最后无损拼接', W() / 2, 350, {
      size: 23, weight: 600, color: C.dim, align: 'center', baseline: 'middle',
      alpha: easeOut3(inv(n, BLK('S05', 2) - 4, BLK('S05', 2) + 16)),
    });
    const c = easeOut3(inv(n, BLK('S06', 1) - 4, BLK('S06', 1) + 18));
    if (c > 0.01) {
      ctx.save();
      ctx.globalAlpha = c;
      panel(ctx, 260, 408, 760, 108, {
        r: 14, fill: hexA(C.accents[2], 0.10), stroke: hexA(C.accents[2], 0.6), lw: 2,
      });
      text(ctx, '改一句解说词 → 只重合成那一句', W() / 2, 446, {
        size: 26, weight: 700, color: C.text, align: 'center', baseline: 'middle',
      });
      text(ctx, '逐句缓存，时间轴自动跟着变', W() / 2, 486, {
        size: 21, weight: 600, color: C.dim, align: 'center', baseline: 'middle',
      });
      ctx.restore();
    }
  },
};

// ---------- 拿到什么 ----------
const GETS = {
  start: cutBefore('S07'),
  draw(ctx, n) {
    const t0 = Math.max(this.from, BLK('S07', 1) - 6);
    text(ctx, '你只写镜头和文案', W() / 2, 140, {
      size: 34, weight: 900, color: C.text, align: 'center', baseline: 'middle',
      alpha: easeOut3(inv(n, t0, t0 + 14)),
    });
    const items = [
      {t: '时间轴 + 字幕', d: '由解说词生成'},
      {t: '章节卡 + HUD', d: '按句 id 区间'},
      {t: '进度条 + 片尾', d: '读配置'},
      {t: '分片渲染 + 合流', d: '一条命令'},
    ];
    items.forEach((it, i) => {
      const local = easeOut3(inv(n, BLK('S08', 1) + i * 8, BLK('S08', 1) + 20 + i * 8));
      if (local <= 0.01) return;
      const y = 208 + i * 84;
      // 已落位的条目保持轻微呼吸，避免整段画面完全静止。
      // 幅度要给够：画质自检的静止阈值是「相邻采样帧灰度差 < 0.5」，
      // 0.6% 的呼吸在这个口径下读出来是 0.2-0.4，仍然算静止 —— 等于没动。
      const breathe = local >= 1 ? 1 + Math.sin((n + i * 22) / 40) * 0.05 : 1;
      ctx.save();
      ctx.globalAlpha = local;
      ctx.translate(640, y + 34);
      ctx.scale(breathe, breathe);
      ctx.translate(-640, -(y + 34));
      panel(ctx, 190, y, 900, 68, {
        r: 10, fill: hexA(C.accents[0], 0.08), stroke: hexA(C.accents[0], 0.5), lw: 1.6,
      });
      text(ctx, it.t, 230, y + 34, {size: 25, weight: 700, color: C.text, baseline: 'middle'});
      text(ctx, it.d, 1050, y + 34, {
        size: 21, weight: 600, color: C.dim, align: 'right', baseline: 'middle',
      });
      ctx.restore();
    });
    // 末尾命令行的光标闪烁：末拍也要有落位后的持续动作
    const cmdAlpha = easeOut3(inv(n, BLK('S08', 3), BLK('S08', 3) + 20));
    text(ctx, 'filmwright all --project examples/minimal', W() / 2, 584, {
      size: 22, family: F.mono, weight: 400, color: C.accents[1], align: 'center', baseline: 'middle',
      alpha: cmdAlpha,
    });
    if (cmdAlpha > 0.5) {
      const blink = Math.floor(n / 18) % 2 === 0 ? 1 : 0.15;
      const cmdW = 22 * 0.6 * 'filmwright all --project examples/minimal'.length;
      ctx.save();
      ctx.globalAlpha = cmdAlpha * blink;
      ctx.fillStyle = C.accents[1];
      ctx.fillRect(W() / 2 + cmdW / 2 + 12, 570, 3, 22);
      ctx.restore();
    }
  },
};

export const SHOTS = [TITLE, PURE, SHARDS, GETS].map((s) => ({
  ...s,
  draw: withDesign(s.draw),
}));
