// 验收：命令式入口（shots/index.js）与声明式（scene.json）**同能力**。
//
//   node tools/verify-imperative.mjs [<仓库根>] [--gpu]
//
// ## 为什么需要它
//
// 手写镜头不走 scene.json 的校验路径（它没有 scene.json 可校验），所以
// **声明式有的规则，手写镜头可能悄悄没有**。实测抓到过两个难查的失败：
//
//   · `{type: 'sparkle'}`（不认识的效果名）→ **静默失效**：不报错，
//     画面与不写效果一模一样；
//   · `blur radius=999`（越界）→ 不报错**而且真的生效** —— 绕过了契约上限，
//     渲染出带振铃的画面（"半径越大反而越锐"）。
//
// 这个工具就是钉住"两边同能力"：声明式镜头能声明的通用字段，手写镜头都要支持、
// 且走同一套校验（写错当场报）。
//
// ## 一个已知限制（如实记下）
//
// `setShots` 的校验跑在**浏览器 boot** 时，所以这些形状错误在
// `check --static-only`（Node 侧、不开浏览器）**抓不到**，要跑到渲染或预览才报。
// 本工具用 `stills`（会开浏览器）来验，正是因为这个。
import {spawnSync} from 'node:child_process';
import {cpSync, readdirSync, rmSync, writeFileSync, mkdirSync, readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const ROOT = resolve(argv[0] && !argv[0].startsWith('--') ? argv[0] : resolve(HERE, '..')).replace(/\\/g, '/');
const USE_GPU = argv.includes('--gpu');
const KIT = join(ROOT, 'bin', 'filmwright.mjs');
const SRC = join(ROOT, 'examples', 'scenecast');
const P = join(ROOT, '.work', 'fx-imperative');

let bad = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) bad++; };
const line = (c = '─') => console.log(c.repeat(76));

rmSync(P, {recursive: true, force: true});
cpSync(SRC, P, {recursive: true});
for (const d of ['audio', 'renders', 'public/assets/scenecast']) {
  rmSync(join(P, d), {recursive: true, force: true});
}
rmSync(join(P, 'scene.json'), {force: true});      // 只用 shots/index.js
mkdirSync(join(P, 'shots'), {recursive: true});

/** 跑一次 stills，返回 {code, out, hashes}。 */
function stills(frames, tag) {
  const dir = join(P, '.work', tag);
  rmSync(dir, {recursive: true, force: true});
  const r = spawnSync('node', [KIT, 'stills', '--project', P, '--frames', frames.join(','),
    '--dir', dir, '--json', ...(USE_GPU ? ['--gpu'] : [])],
    {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024});
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* 非 json */ }
  const hashes = {};
  try {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.png')).sort()) {
      hashes[f] = createHash('sha256').update(readFileSync(join(dir, f))).digest('hex').slice(0, 12);
    }
  } catch { /* 目录可能没建 */ }
  return {code: r.status, json, hashes, raw: r.stdout + r.stderr};
}

/** 写一个手写镜头（只用 shots/index.js）。 */
function write(extra = '') {
  writeFileSync(join(P, 'shots', 'index.js'),
    `import {view, theme as C, text, applyDesignScale} from 'filmwright';
export const SHOTS = [
  {start: 1${extra},
   draw(ctx, n) {
     ctx.save(); applyDesignScale(ctx);
     ctx.fillStyle = C.text;
     ctx.font = '700 64px sans-serif';
     text(ctx, 'IMPERATIVE ' + n, view.W / 2, 300, {size: 64, weight: 900, color: C.text, align: 'center', baseline: 'middle'});
     ctx.restore();
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
console.log('一、效果链：手写镜头与声明式同能力');
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
console.log('三、声明式能声明的通用字段，手写镜头都要支持');
line();
// 逐个装上，确认都能渲染（有错会以非零退出体现）
write(', transform: {x: 12, alpha: 0.95}');
ok(stills([30], 'tf').code === 0, 'transform 可用');
write(', animate: {y: [{frame: 1, v: 0}, {frame: 30, v: 40}]}');
ok(stills([30], 'an').code === 0, 'animate 可用（frame 锚点）');
write(', beats: [10, 40], animate: {y: [{beat: 1, v: 0}, {beat: 2, v: 40}]}');
ok(stills([30], 'beat').code === 0, 'animate 可用（beat 锚点 + 自声明 beats）');
write(', beats: [10, 40], effects: [{type: "blur", radius: [{beat: 1, v: 0}, {beat: 2, v: 12}]}]');
ok(stills([30], 'fxbeat').code === 0, '**效果参数也能用 beat 锚点**（与声明式同一套）');
write(', transition: {type: "fade", frames: 10}, effects: [{type: "glow", intensity: 0.4}]');
ok(stills([30], 'mix').code === 0, 'transition + effects 同时用');

line('═');
console.log('四、节拍锚点的两条运行期校验对手写镜头同样生效');
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

rmSync(P, {recursive: true, force: true});
line('═');
console.log(bad === 0 ? '✓ 命令式入口与声明式同能力' : `✗ ${bad} 项失败`);
process.exit(bad ? 1 : 0);
