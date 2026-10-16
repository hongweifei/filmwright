// 验收：命令式入口（手写 `shots/index.js`）的能力与校验。
//
//   node tools/verify-imperative.mjs [<仓库根>] [--gpu]
//
// ## 为什么需要它
//
// 手写镜头没有声明式那层兜底（`scene.json` 与内置镜头类型已删），所以
// **写错不会有人替你拦**。实测抓到过两个难查的失败：
//
//   · `{type: 'sparkle'}`（不认识的效果名）→ **静默失效**：不报错，
//     画面与不写效果一模一样；
//   · `blur radius=999`（越界）→ 不报错**而且真的生效** —— 绕过了契约上限，
//     渲染出带振铃的画面（"半径越大反而越锐"）。
//
// 所以这个工具钉两件事：
//   1. 手写镜头声明的字段（effects / transform / animate / beats / transition）
//      都要真的被引擎支持，且形状错误**当场报**（走同一套校验）；
//   2. 合成原语（`withLayer` 的 blend / 组 alpha / transform）要有**可量化的区分力**，
//      每条都配一个负面对照 —— 把能力关掉时判据必须红。
//
// ## 一个已知限制（如实记下）
//
// `setShots` 的校验跑在**浏览器 boot** 时，所以这些形状错误在
// `check --static-only`（Node 侧、不开浏览器）**抓不到**，要跑到渲染或预览才报。
// 本工具用 `stills`（会开浏览器）来验，正是因为这个。
import {spawnSync} from 'node:child_process';
import {cpSync, readdirSync, rmSync, writeFileSync, mkdirSync, readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const ROOT = resolve(argv[0] && !argv[0].startsWith('--') ? argv[0] : resolve(HERE, '..')).replace(/\\/g, '/');
const USE_GPU = argv.includes('--gpu');
const KIT = join(ROOT, 'bin', 'filmwright.mjs');
const SRC = join(ROOT, 'examples', 'minimal');
const P = join(ROOT, '.work', 'fx-imperative');

let bad = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) bad++; };
const line = (c = '─') => console.log(c.repeat(76));

rmSync(P, {recursive: true, force: true});
cpSync(SRC, P, {
  recursive: true,
  filter: (s) => {
    const rel = relative(SRC, s).replace(/\\/g, '/');
    if (!rel) return true;
    if (['audio', 'renders', '.work'].includes(rel.split('/')[0])) return false;
    return rel !== 'public/assets/minimal';          // 10MB 成品配音，验收用不上
  },
});
mkdirSync(join(P, 'shots'), {recursive: true});

/** 跑一次 stills，返回 {code, raw, json, hashes, rgb}（`decode` 时解出 RGB 像素）。 */
function stills(frames, tag, {decode = false} = {}) {
  const dir = join(P, '.work', tag);
  rmSync(dir, {recursive: true, force: true});
  const r = spawnSync('node', [KIT, 'stills', '--project', P, '--frames', frames.join(','),
    '--dir', dir, '--json', ...(USE_GPU ? ['--gpu'] : [])],
    {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024});
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* 非 json */ }
  const hashes = {};
  const rgb = {};
  try {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.png')).sort()) {
      const bytes = readFileSync(join(dir, f));
      hashes[f] = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
      if (decode) rgb[f] = decodePng(bytes, join(dir, f));
    }
  } catch { /* 目录可能没建 */ }
  return {code: r.status, json, hashes, rgb, raw: r.stdout + r.stderr};
}

/**
 * PNG → `{w, h, rgb}`：尺寸直接从 IHDR 读（不额外调 ffprobe），像素用 ffmpeg 解成 RGB24。
 *
 * 为什么合成判据非要像素不可：hash 只能回答"一样不一样"，而下面三条要量的是
 * **方向与比例**（乘式只会更暗、组 alpha 的"一半"、位移的线性）—— 都得在像素上算。
 */
function decodePng(bytes, p) {
  const w = bytes.readUInt32BE(16), h = bytes.readUInt32BE(20);
  const g = spawnSync('ffmpeg', ['-v', 'error', '-i', p, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    {maxBuffer: 64 * 1024 * 1024});
  if (g.status !== 0) { console.log('ffmpeg 解码失败：' + p); process.exit(1); }
  return {w, h, rgb: g.stdout};
}

/** 跑一次"自定义画面"的渲染并解出第一帧像素（合成判据用）。 */
function pixels(extra, drawBody, tag) {
  write(extra, drawBody);
  const r = stills([30], tag, {decode: true});
  if (r.code !== 0) {
    console.log(`渲染失败(${tag})：` + String(r.raw).slice(-400));
    process.exit(1);
  }
  return Object.values(r.rgb)[0];
}

/**
 * 写一个手写镜头（只用 shots/index.js）。
 *
 * `extra` 拼进镜头字面量的字段（effects/transform/…）；`drawBody` 不给时用
 * 默认的"画一行字"内容 —— 合成那几节要自己画（亮块/重叠矩形）。
 */
function write(extra = '', drawBody = '') {
  const body = drawBody || `      ctx.save(); applyDesignScale(ctx);
      ctx.fillStyle = C.text;
      ctx.font = '700 64px sans-serif';
      text(ctx, 'IMPERATIVE ' + n, view.W / 2, 300, {size: 64, weight: 900, color: C.text, align: 'center', baseline: 'middle'});
      ctx.restore();`;
  writeFileSync(join(P, 'shots', 'index.js'),
    `import {view, withLayer, theme as C, text, applyDesignScale} from 'filmwright';
export const SHOTS = [
  {start: 1${extra},
   draw(ctx, n) {
${body}
   }},
];
`, 'utf8');
}

/** 断言"这次调用报了错，且错误码是 want"。 */
function expectError(label, extra, wantCode) {
  write(extra);
  const r = stills([30], 'err');
  const codes = (r.json?.errors ?? []).map((e) => e.code);
  const hit = codes.includes(wantCode);
  ok(r.code !== 0 && hit, `${label} ⇒ 当场报错且码是 ${wantCode}（实得 ${r.code === 0 ? '没报错' : codes.join('/')}）`);
  return r;
}

console.log(`命令式入口验收（${USE_GPU ? '--gpu' : '默认档'}）\n`);

line('═');
console.log('一、效果链：手写镜头声明的 effects 真的生效');
line();
write('');
const base = stills([30], 'base');
ok(base.code === 0, '不带 effects 的手写镜头能渲染');
write(', effects: [{type: "blur", radius: 14}]');
const withFx = stills([30], 'blur');
ok(withFx.code === 0, '带 effects 的手写镜头能渲染');
const b0 = Object.values(base.hashes)[0], b1 = Object.values(withFx.hashes)[0];
ok(b0 && b1 && b0 !== b1, `效果**真的生效**了（画面 ${b0} → ${b1}）`);

line('═');
console.log('二、写错要**当场报**（这两条是实测抓到的静默失效）');
line();
expectError('不认识的效果名', ', effects: [{type: "sparkle", radius: 1}]', 'SCENE_FX_TYPE');
expectError('参数越界', ', effects: [{type: "blur", radius: 999}]', 'SCENE_FX_RANGE');
expectError('空效果链', ', effects: []', 'SCENE_FX_SHAPE');

line('═');
console.log('三、命令式镜头要支持的通用字段（effects / transform / animate / beats / transition）');
line();
// 逐个装上，确认都能渲染（有错会以非零退出体现）
write(', transform: {x: 12, alpha: 0.95}');
ok(stills([30], 'tf').code === 0, 'transform 可用');
write(', animate: {y: [{frame: 1, v: 0}, {frame: 30, v: 40}]}');
ok(stills([30], 'an').code === 0, 'animate 可用（frame 锚点）');
write(', beats: [10, 40], animate: {y: [{beat: 1, v: 0}, {beat: 2, v: 40}]}');
ok(stills([30], 'beat').code === 0, 'animate 可用（beat 锚点 + 自声明 beats）');
write(', beats: [10, 40], effects: [{type: "blur", radius: [{beat: 1, v: 0}, {beat: 2, v: 12}]}]');
ok(stills([30], 'fxbeat').code === 0, '**效果参数也能用 beat 锚点**（与 animate 同一套）');
write(', transition: {type: "fade", frames: 10}, effects: [{type: "glow", intensity: 0.4}]');
ok(stills([30], 'mix').code === 0, 'transition + effects 同时用');

line('═');
console.log('四、节拍锚点的两条运行期校验');
line();
expectError('没有 beats 却用 beat 锚点（animate）', ', animate: {y: [{beat: 1, v: 0}]}', 'SCENE_ANIM_NO_BEATS');
expectError('没有 beats 却用 beat 锚点（effects）', ', effects: [{type: "blur", radius: [{beat: 1, v: 4}]}]', 'SCENE_ANIM_NO_BEATS');
expectError('beat 超出实际拍数', ', beats: [10, 40], effects: [{type: "blur", radius: [{beat: 5, v: 4}]}]', 'SCENE_ANIM_RANGE');

line('═');
console.log('五、一条已知限制（如实验，不假装没有）');
line();
{
  // 形状校验跑在浏览器 boot 时，所以静态自检（Node 侧、不开浏览器）抓不到它。
  // 这条**不是**期望它报错，而是把现状钉住：将来若把校验前移，这条会失败，
  // 那时就该反过来更新它。
  write(', effects: [{type: "sparkle"}]');
  const r = spawnSync('node', [KIT, 'check', '--project', P, '--static-only', '--json'],
    {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024});
  const staticSawIt = r.status !== 0;
  console.log(`  check --static-only 对写错的效果链：${staticSawIt ? '报错' : '没报错（校验在浏览器 boot 时才跑）'}`);
  ok(!staticSawIt, '现状如文档所述：静态自检抓不到，要跑到渲染/预览');
}

// ───────── 下面三条：合成原语的量化判据（每条都自带负面对照） ─────────
// 它们补的是**被删掉的 verify-composite 留下的覆盖**：那个工具守的是声明式
// `layers` 容器/父子绑定/空物体（随声明式一起没了），但底下的 `withLayer`
// （blend / 组 alpha / transform）仍然是公开面，仍然需要有人证明它真的在干活。
// 判据一律**量方向与比例**，不写"画面变了"那种恒真的话。

/**
 * blend 判据：`mul`（乘式）相对 `noBlend`（不写 blend）只允许**更暗**。
 *
 * 乘式的数学性质就是逐通道 ≤ 原值，所以"更亮的像素数必须为 0"是**硬判据**，
 * 任何方向搞反（比如误当成 screen/lighten）都会当场红。
 */
function judgeBlendDarker(noBlend, mul) {
  let n = 0, drop = 0, baseSum = 0, darker = 0, brighter = 0, worstUp = 0;
  for (let i = 0; i < noBlend.length; i += 3) {
    const down = Math.max(noBlend[i] - mul[i], noBlend[i + 1] - mul[i + 1], noBlend[i + 2] - mul[i + 2]);
    const up = Math.max(mul[i] - noBlend[i], mul[i + 1] - noBlend[i + 1], mul[i + 2] - noBlend[i + 2]);
    if (down <= 0 && up <= 0) continue;                   // 这个像素没被图层碰到
    n++;
    drop += Math.max(down, 0);
    baseSum += (noBlend[i] + noBlend[i + 1] + noBlend[i + 2]) / 3;
    if (down >= 3 && up <= 1) darker++;
    if (up > 1) { brighter++; if (up > worstUp) worstUp = up; }
  }
  const meanDrop = n ? drop / n : 0;
  const baseMean = n ? baseSum / n : 0;
  const dropRel = baseMean ? meanDrop / baseMean : 0;
  const darkerPct = n ? darker / n : 0;
  return {n, meanDrop, baseMean, dropRel, darkerPct, brighter, worstUp,
    ok: n > 20000 && meanDrop >= 4 && dropRel > 0.25 && darkerPct >= 0.95 && brighter === 0};
}

/**
 * 组 alpha 判据：`half`（alpha=0.5）必须落在 `bg`（纯背景）与 `full`（alpha=1）之间，
 * 且**每一处都落在同一个比例上** —— 后者才是"整组半透明"的意思。
 *
 * 为什么还要看比例的标准差：把 alpha 实现成"逐个绘制操作设 globalAlpha"是经典错误 ——
 * 那样重叠区会被混合两次（比例 0.75），非重叠区还是 0.5，均值看着仍像"半透明"，
 * 只有**比例不一致**能抓住它。
 */
function judgeAlpha(bg, half, full) {
  const ratios = [];
  let d1 = 0, d05 = 0;
  for (let i = 0; i < bg.length; i += 3) {
    const fd = (Math.abs(bg[i] - full[i]) + Math.abs(bg[i + 1] - full[i + 1]) + Math.abs(bg[i + 2] - full[i + 2])) / 3;
    if (fd <= 60) continue;                              // 图层没盖到、或盖得几乎看不出来 → 比值没意义
    const md = (Math.abs(bg[i] - half[i]) + Math.abs(bg[i + 1] - half[i + 1]) + Math.abs(bg[i + 2] - half[i + 2])) / 3;
    d1 += fd; d05 += md; ratios.push(md / fd);
  }
  const n = ratios.length;
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const ratio = n ? d05 / d1 : 0;
  const d1Mean = n ? d1 / n : 0;
  const sd = Math.sqrt(mean(ratios.map((r) => (r - ratio) ** 2)));
  return {n, d1: d1Mean, ratio, sd, ok: n > 20000 && d1Mean >= 20 && ratio > 0.3 && ratio < 0.7 && sd < 0.03};
}

/** 位移判据：同样比例的位移（x=D 与 x=2D）必须给出成比例的质心移动（按区域比）。 */
function judgeShift(a, b, c) {
  const s1 = b.x - a.x, s2 = c.x - a.x;
  const ratio = s1 !== 0 ? s2 / s1 : 0;
  return {s1, s2, ratio, n: a.n, bn: b.n, cn: c.n,
    ok: a.n > 5000 && b.n > 5000 && c.n > 5000 && s1 > 100 && s2 > 200 && ratio > 1.8 && ratio < 2.2};
}

/** 某颜色像素的质心与包围盒（"按区域比"用的就是它，不是整帧）。 */
function colorRegion(rgb, w, h, hit) {
  let sx = 0, sy = 0, n = 0, minX = w, maxX = -1, minY = h, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      if (!hit(rgb[i], rgb[i + 1], rgb[i + 2])) continue;
      sx += x; sy += y; n++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return {n, x: n ? sx / n : 0, y: n ? sy / n : 0, minX, maxX, minY, maxY};
}

line('═');
console.log('六、合成原语：withLayer 的 blend 真的生效（乘式只会更暗，不会更亮）');
line();
{
  const rect = (opts) => `      ctx.save(); applyDesignScale(ctx);
      withLayer(ctx, ${opts}, (c) => {
        c.fillStyle = '#808080';
        c.fillRect(200, 200, 880, 320);
      });
      ctx.restore();`;
  const noBlend = pixels('', rect('{}'), 'blend-no');
  const mul = pixels('', rect("{blend: 'multiply'}"), 'blend-mul');
  const j = judgeBlendDarker(noBlend.rgb, mul.rgb);
  console.log(`  图层覆盖区 ${j.n} 像素：平均压暗 ${j.meanDrop.toFixed(1)} 级` +
    `（占原亮度 ${(j.dropRel * 100).toFixed(0)}%），更暗的 ${(j.darkerPct * 100).toFixed(1)}%，` +
    `更亮的 ${j.brighter} 个（最多 +${j.worstUp} 级）`);
  ok(j.ok, `multiply 相对不写 blend **只会更暗**：覆盖区更暗 ${(j.darkerPct * 100).toFixed(1)}%、` +
    `一个像素都没更亮、平均压暗 ${(j.dropRel * 100).toFixed(0)}%`);
  // 负面对照：把 blend 关掉（同一张图自己比自己）⇒ 覆盖区一个像素都没被压暗 ⇒ 必须红
  const jOff = judgeBlendDarker(noBlend.rgb, noBlend.rgb);
  ok(!jOff.ok, `负面对照：blend 关掉时判据**必须红**（此时"覆盖区"${jOff.n} 像素、平均压暗 ${jOff.meanDrop.toFixed(1)} 级）`);
}

line('═');
console.log('七、合成原语：组 alpha 真的生效（0.5 该落在背景与全量的正中间，且处处一致）');
line();
{
  const fullBody = `      ctx.save(); applyDesignScale(ctx);
      withLayer(ctx, {}, (c) => {
        c.fillStyle = '#C04040'; c.fillRect(240, 220, 520, 320);
        c.fillStyle = '#808080'; c.fillRect(560, 300, 480, 260);
      });
      ctx.restore();`;
  const bgBody = `      // 什么都不画：这一帧就是纯背景（组 alpha 的参照）`;
  const bg = pixels('', bgBody, 'alpha-bg');
  const full = pixels('', fullBody, 'alpha-full');
  const half = pixels('', fullBody.replace('withLayer(ctx, {},', 'withLayer(ctx, {alpha: 0.5},'), 'alpha-half');
  const j = judgeAlpha(bg.rgb, half.rgb, full.rgb);
  console.log(`  图层覆盖区 ${j.n} 像素：全量相对背景平均差 ${j.d1.toFixed(1)} 级，` +
    `半量/全量的比例 ${j.ratio.toFixed(3)}（同一比例的标准差 ${j.sd.toFixed(4)}）`);
  ok(j.ok, `alpha=0.5 让画面**朝着背景走一半**（比例 ${j.ratio.toFixed(3)} ∈ (0.3, 0.7)），` +
    `且处处一致（标准差 ${j.sd.toFixed(4)} < 0.03 ⇒ 不是"重叠处混两次"）`);
  // 负面对照：把 0.5 换成 1（能力恒等）⇒ 比例变 1 ⇒ 必须红
  const jOff = judgeAlpha(bg.rgb, full.rgb, full.rgb);
  ok(!jOff.ok, `负面对照：alpha 恒等（0.5 换成 1）时判据**必须红**（比例 ${jOff.ratio.toFixed(3)} 不在区间内）`);
}

line('═');
console.log('八、合成原语：transform 的位移真的移动了内容（按区域比，不看整帧）');
line();
{
  const D = 160;
  const hit = (r, g, b) => r > 180 && g < 90 && b > 180;      // 品红：引擎自己的背板/HUD/字幕不用这个色
  const body = (dx) => `      ctx.save(); applyDesignScale(ctx);
      withLayer(ctx, ${dx ? `{transform: {x: ${dx}}}` : '{}'}, (c) => {
        c.fillStyle = '#FF00FF';
        c.fillRect(300, 280, 160, 160);
      });
      ctx.restore();`;
  const at = (dx, tag) => {
    const p = pixels('', body(dx), tag);
    return colorRegion(p.rgb, p.w, p.h, hit);
  };
  const c0 = at(0, 'shift-0'), c1 = at(D, 'shift-1'), c2 = at(2 * D, 'shift-2');
  console.log(`  色块质心 x：位移 0 → ${c0.x.toFixed(1)}（${c0.n} 像素，包围盒 x ${c0.minX}..${c0.maxX}）；` +
    `+${D} → ${c1.x.toFixed(1)}（${c1.n} 像素，x ${c1.minX}..${c1.maxX}）；` +
    `+${2 * D} → ${c2.x.toFixed(1)}（${c2.n} 像素，x ${c2.minX}..${c2.maxX}）`);
  const j = judgeShift(c0, c1, c2);
  ok(j.ok, `位移真的搬动了内容：+${D} 帧位移 ${j.s1.toFixed(1)}px、+${2 * D} 位移 ${j.s2.toFixed(1)}px` +
    `（比例 ${j.ratio.toFixed(3)} ∈ (1.8, 2.2) ⇒ 线性、不是噪声）`);
  // 负面对照：transform 写成恒等（位移 0）⇒ 质心不动 ⇒ 必须红
  const jOff = judgeShift(c0, c0, c0);
  ok(!jOff.ok, `负面对照：transform 恒等时判据**必须红**（位移 ${jOff.s1.toFixed(1)}px / ${jOff.s2.toFixed(1)}px）`);
}

rmSync(P, {recursive: true, force: true});
line('═');
console.log(bad === 0 ? '✓ 命令式入口的能力与校验都成立' : `✗ ${bad} 项失败`);
process.exit(bad ? 1 : 0);
