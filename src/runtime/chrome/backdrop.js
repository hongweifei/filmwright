// 幕底：渐变 + 呼吸的色晕 + 网格 + 暗角。所有镜头都画在它上面，不许自己铺不透明底。
import {theme as C, view} from '../../contract/config.js';
import {hexA} from '../draw/color.js';

export function drawBackdrop(ctx, t, accent) {
  const W = view.W;
  const H = view.H;
  // 按 1280×720 设计的位置等比缩放 —— 换分辨率不用改这里
  const sx = W / 1280;
  const sy = H / 720;

  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, C.bgDeep);
  g.addColorStop(0.55, C.bg);
  g.addColorStop(1, '#060910');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // 两团缓慢漂移的色晕（周期很长，不会看出循环）
  const orbs = [
    {x: 300 + Math.sin(t / 210) * 180, y: 180 + Math.cos(t / 260) * 90, r: 460, c: accent, a: 0.10},
    {x: 1010 + Math.cos(t / 250) * 150, y: 520 + Math.sin(t / 300) * 80, r: 420, c: C.accents[1], a: 0.07},
  ];
  for (const o of orbs) {
    const rg = ctx.createRadialGradient(o.x * sx, o.y * sy, 0, o.x * sx, o.y * sy, o.r * sx);
    rg.addColorStop(0, hexA(o.c, o.a));
    rg.addColorStop(1, hexA(o.c, 0));
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, W, H);
  }

  ctx.save();
  ctx.strokeStyle = 'rgba(64,104,168,0.075)';
  ctx.lineWidth = 1;
  const step = Math.round(64 * sx);
  const off = (t * 0.18) % step;
  for (let x = -step + off; x < W + step; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }
  for (let y = -step + off; y < H + step; y += step) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
  ctx.restore();

  // 暗角。中心与外半径都按**设计坐标 × 比例**算，不要写手算的近似系数。
  //
  // 这里原先写的是 `H * 0.556`。400/720 = 0.5555…，取 0.556 会得到 400.32 而不是 400 ——
  // 渐变中心偏 0.32 像素，整帧就都带上一层极淡的差异：平坦区差 1–4 级，
  // 而半透明的发光面板把它放大到约 1% 的像素有明显差异。
  // 这是把一部真实片子迁过来做逐帧比对时才发现的（迁移前后某些帧 PSNR 只有 29 dB）。
  const vg = ctx.createRadialGradient(
    640 * sx, 360 * sy, 240 * sx,
    640 * sx, 400 * sy, 860 * sx
  );
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.62)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, W, H);

  // 顶部与底部压边，给 HUD / 字幕留出干净的带
  const topH = Math.round(120 * sy);
  const tg = ctx.createLinearGradient(0, 0, 0, topH);
  tg.addColorStop(0, 'rgba(3,5,10,0.88)');
  tg.addColorStop(1, 'rgba(3,5,10,0)');
  ctx.fillStyle = tg;
  ctx.fillRect(0, 0, W, topH);

  const botY = Math.round(600 * sy);
  const bg2 = ctx.createLinearGradient(0, botY, 0, H);
  bg2.addColorStop(0, 'rgba(3,5,10,0)');
  bg2.addColorStop(1, 'rgba(3,5,10,0.93)');
  ctx.fillStyle = bg2;
  ctx.fillRect(0, botY, W, H - botY);
}
