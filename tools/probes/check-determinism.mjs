// **快速**确定性检查：同一个效果、同一帧、两次渲染，比哈希。
//
//   node tools/probes/check-determinism.mjs [<仓库根>] [预设名|all]
//
// ## 为什么需要它（而不是只用 verify-effects）
//
// `verify-effects` 里已经有"每个效果都必须同一帧两次渲染逐字节一致"那一节，
// 但它**跑一次约 10 分钟**（要跑完前面六节）。排查 `displace` 这类问题时，
// 每改一版着色器就要等 10 分钟 —— **迭代太慢**。
//
// 这个工具只做那一件事：**约 1 分钟**跑完所有效果。判据与 verify-effects 完全一致，
// 所以它定位到的问题可以直接用 verify-effects 复核。
//
// ## 它怎么帮 `displace` 排查（上一轮写下的下一步）
//
// 拿掉噪声、换成一个**常量位移**先确认稳定，再逐块加回 `h()` → `vn()` → 双 `vn` 调用，
// **看哪一块开始不稳定**。每加一块跑一次这个工具（1 分钟），而不是 10 分钟。
//
// ## 两个已经被它排除的猜测（有证据，不是推断）
//
//   · `grain` 用 `fract(sin(dot(...)) * 43758.5453)` 这种 hash ⇒ 一致，**hash 没问题**；
//   · `distort` 会偏移纹理采样坐标 ⇒ 一致，**偏移采样也没问题**。
//
// ## 夹具：`examples/minimal` + **手写镜头**
//
// 声明式那层（`scene.json` / 内置镜头类型）已删，夹具改成手写镜头：镜头里铺一片
// 高对比条纹（模糊/位移这类效果要有结构才看得出来），`effects:` 字段挂在镜头上。
// 素材只需要 `public/assets/filmstrip.png`（配置里声明了），所以整体拷贝示例、
// 跳过配音与历史产物即可。
//
// ⚠️ **同一帧整帧比哈希**是确定性判据；但**行为判据不能整帧比**：引擎会在镜头之上画
// 随时间变化的 HUD/字幕（进度条、章节卡、字幕），第 100 帧与第 130 帧整帧本来就不同，
// 拿整帧比"不同帧不同"会**恒真**。所以行为判据统一比**条纹所在的中央区域**
// （`crop=1200:240:40:240`）—— 那里只有镜头自己画的内容，实测同一镜头在
// 100/130 帧逐字节相同（见最后那条负面对照）。
import {execFileSync} from 'node:child_process';
import {cpSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const ROOT = resolve(argv[0] && !argv[0].startsWith('--') ? argv[0] : join(HERE, '..', '..'));
const WHICH = argv.find((a) => !a.startsWith('--') && !a.includes('/') && !a.includes('\\')
  && !/^[A-Za-z]:/.test(a)) ?? 'all';

/** 逃生舱的源码：反色 + 扫线，两个 uniform 都是标量（能真生效，不是直通）。 */
const CUSTOM_SRC = `
uniform float amount;
void main(){
  vec4 c = texture2D(t, uv);
  float line = step(0.5, fract(uv.y / texelY / 6.0));
  vec3 inv = vec3(1.0 - c.r, 1.0 - c.g, 1.0 - c.b);
  gl_FragColor = vec4(mix(c.rgb, inv, amount) * mix(0.8, 1.0, line), c.a);
}`;

/** 每个效果一份"能真正生效"的参数（`amount=0` 会直通，测不到东西）。 */
const PRESETS = {
  blur: {radius: 12}, glow: {intensity: 0.6, threshold: 0.6}, color: {saturation: 0.6},
  vignette: {amount: 0.5}, chromatic: {amount: 0.5}, grain: {amount: 0.35},
  pixelate: {size: 10}, radialBlur: {amount: 0.3}, distort: {amount: 0.5},
  grade: {look: 'noir', amount: 1},
  displace: {amount: 0.8, frequency: 8},
  // 逃生舱走的是**同一张 GpuStage**，所以"同一帧两次渲染逐字节一致"这条判据
  // 也必须盖到它 —— 自定义源码里的时间如果来自时钟（而不是 `frame`），
  // 这一档就会红（`frame` 是引擎唯一给的时间来源）。
  custom: {src: CUSTOM_SRC, uniforms: {amount: 0.6}},
};

const SRC = join(ROOT, 'examples', 'minimal');
const P = join(ROOT, '.work', 'detprobe');
const FRAME = 100;
/** 条纹所在的中央区域（x, y, w, h），刻意避开 HUD/字幕。 */
const CROP = [40, 240, 1200, 240];

const sha = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 12);

// ⚠️ `frame` 参数**必须真的用上** —— 第一版忘了传它，于是"不同帧"的比较
// 实际比的是同一帧（那种"测试恒真"的 bug 只有对着代码看才发现）。
const renderOnce = (fx, frame = FRAME) => {
  rmSync(P, {recursive: true, force: true});
  cpSync(SRC, P, {
    recursive: true,
    filter: (s) => {
      const rel = relative(SRC, s).replace(/\\/g, '/');
      if (!rel) return true;
      if (['audio', 'renders', '.work'].includes(rel.split('/')[0])) return false;
      return rel !== 'public/assets/minimal';   // 10MB 成品配音，这里用不上
    },
  });
  mkdirSync(join(P, 'shots'), {recursive: true});
  // 高对比条纹：位移/模糊这类效果作用在**有结构**的画面上才看得见。
  // ⚠️ `effects: []` **不是合法输入**（校验要求非空数组）。基线用例要**不写这个字段**。
  const fxSrc = fx.length ? `\n  effects: ${JSON.stringify(fx)},` : '';
  writeFileSync(join(P, 'shots', 'index.js'), `import {text, theme as C} from 'filmwright';
export const SHOTS = [
  {
    start: 1,${fxSrc}
    draw(ctx) {
      ctx.fillStyle = '#0B1020';
      ctx.fillRect(0, 0, 1280, 720);
      for (let i = 0; i < 24; i++) {
        ctx.fillStyle = i % 2 ? '#3FA7FF' : '#F5B942';
        ctx.fillRect(${CROP[0]} + i * 50, ${CROP[1]}, 30, ${CROP[3]});
      }
      text(ctx, 'determinism', 640, 140, {size: 84, weight: 900, color: C.text, align: 'center'});
    },
  },
];
`, 'utf8');
  const out = join(P, 'out');
  mkdirSync(out, {recursive: true});
  execFileSync('node', [join(ROOT, 'bin', 'filmwright.mjs'), 'stills', '--project', P,
    '--frames', String(frame), '--dir', out], {stdio: ['ignore', 'ignore', 'inherit']});
  const png = join(out, `f${String(frame).padStart(5, '0')}.png`);
  const full = readFileSync(png);
  const crop = execFileSync('ffmpeg', ['-v', 'error', '-i', png, '-vf',
    `crop=${CROP[2]}:${CROP[3]}:${CROP[0]}:${CROP[1]}`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
    {maxBuffer: 64 * 1024 * 1024});
  return {full: sha(full), crop: sha(crop)};
};

const names = WHICH === 'all' ? Object.keys(PRESETS) : [WHICH];
console.log(`快速确定性检查（同一帧 ${FRAME} 渲染两次，比哈希）\n`);
let bad = 0;
for (const n of names) {
  if (!PRESETS[n]) { console.log(`  ✗ 未知效果：${n}（可用 ${Object.keys(PRESETS).join(' / ')}）`); bad++; continue; }
  const fx = [{type: n, ...PRESETS[n]}];
  const a = renderOnce(fx);
  const b = renderOnce(fx);
  const same = a.full === b.full && a.crop === b.crop;
  if (!same) bad++;
  console.log(`  ${same ? '✓' : '✗'} ${n.padEnd(11)} ${a.full} / ${b.full}${same ? '' : '  ← **不一致：违反"第 N 帧只是 N 的函数"**'}`);
}
rmSync(P, {recursive: true, force: true});

// ── 附带的**行为**判据：`displace` 的参数真的生效吗 ──
// 只用站得住的判据。原本想写"frequency 大 ⇒ 高频含量上升"，
// 但实测**不成立**（位移类效果对边缘能量的影响不稳定），
// 改成"不同 frequency 输出不同"—— 能证伪、也不会假阳性。
// 判据比的是**条纹区域**（`crop`）：整帧里有随时间变化的 HUD/字幕，
// 拿它比"不同帧不同"会恒真（下面最后一条就是这个说法的负面对照）。
// ⚠️ 这一节本该放进 `tools/verify-effects.mjs`（那里是守门工具的家），
// 但写它的时候**机器负载过高**（`渲染页 130.7s 内没就绪`），那个工具跑一次约 10 分钟、
// 当时跑不完 —— **不提交没跑过的验证代码**，所以先放在这个跑得动的探针里（约 1 分钟）。
// 等机器空闲时应把它挪进 verify-effects。
console.log('\n行为判据（displace）：');
const hashes = {};
const get = (fx, n) => { const k = JSON.stringify([fx, n]); hashes[k] ??= renderOnce(fx, n); return hashes[k]; };
const base = renderOnce([], FRAME);
const h8 = get([{type: 'displace', amount: 0.8, frequency: 8}], 100);
const checks = [
  ['displace 改变了画面', h8.crop !== base.crop],
  ['displace amount=0 与不写 effects 逐位相同（直通）', get([{type: 'displace', amount: 0}], 100).full === base.full],
  ['frequency 真的在起作用（30 ≠ 8）', get([{type: 'displace', amount: 0.8, frequency: 30}], 100).crop !== h8.crop],
  ['displace 与 distort 同参数下输出不同（不是同一个效果）',
    get([{type: 'distort', amount: 0.8, frequency: 8}], 100).crop !== h8.crop],
];
// ⚠️ 关键帧的 `frame` 是**节点内**帧号（镜头 start=1 时等于全局帧，但语义是相对节点）。
// 第一版把轨道写成 {frame:1}→{frame:40}，探针又比第 100/130 帧 —— 两点都已被夹到轨道末端，
// phase 恒定，于是"不同帧不同"这条**只靠整帧里的 HUD/字幕**变绿（旧夹具正是这样）。
// 现在轨道末端取被比较的那一帧，保证两点都落在斜坡上。
const PH2 = FRAME + 30;
const ph = [{frame: 1, v: 0}, {frame: PH2, v: 150, ease: 'linear'}];
const p1 = get([{type: 'displace', amount: 0.8, phase: ph}], FRAME);
checks.push(['phase 关键帧让不同帧不同（热浪在流动）',
  p1.crop !== get([{type: 'displace', amount: 0.8, phase: ph}], PH2).crop]);
checks.push(['带 phase 轨道时同一帧仍逐字节一致',
  p1.full === get([{type: 'displace', amount: 0.8, phase: ph}], FRAME).full]);
// 负面对照：不写 phase 时，**同一个条纹区域**在第 100 与第 130 帧逐字节相同
// ⇒ 上面那条"不同帧不同"确实来自 phase 轨道，不是被 HUD/字幕带绿的。
checks.push(['不写 phase 时同一区域在 100/130 帧逐字节相同（证明上一条不是恒真）',
  base.crop === get([], PH2).crop]);
// 更强的对照：phase **写死成常数**（单关键帧）时两帧也该相同
// ⇒ 变化确实来自"轨道在动"，而不是"写了 phase 这个参数"。
checks.push(['phase 写死成常数时两帧逐字节相同（变化来自轨道在动，不是参数存在）',
  get([{type: 'displace', amount: 0.8, phase: [{frame: 1, v: 150}]}], FRAME).crop
    === get([{type: 'displace', amount: 0.8, phase: [{frame: 1, v: 150}]}], PH2).crop]);
for (const [name, okc] of checks) {
  if (!okc) bad++;
  console.log(`  ${okc ? '✓' : '✗'} ${name}`);
}

rmSync(P, {recursive: true, force: true});
console.log(bad === 0 ? '\n✓ 全部逐字节一致，且 displace 的行为判据全过' : `\n✗ ${bad} 项失败`);
process.exit(bad ? 1 : 0);
