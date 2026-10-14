// 按段归因的端到端验证：改一个镜头只重渲**覆盖它的那段**。
//
//   node tools/verify-attribution.mjs [<仓库根>]
//
// ## 为什么这条必须验
//
// 增量重渲的价值全在「改一处只重渲一小段」。如果指纹是全局的（把整份
// scene.json 算进去），改任何一个镜头都会让**所有段**失效 —— 那就等于每次都
// 全渲，功能形同虚设（我第一版就是这样，提交信息里的说法是夸大的）。
//
// 判据：用一个真实的多段项目（scenecast，8 个镜头 / 1486 帧 / 5 段），
//   A) 首次 → 全渲
//   B) 不改动再跑 → 全部复用
//   C) **只改中间某个镜头的文案** → 只有覆盖它的那几段重渲，其余段复用
//   D) 改全局输入（时间轴）→ 所有段必须失效（负面对照：不该过度复用）
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {dirname, resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = (process.argv[2] ?? resolve(HERE, '..')).replace(/\\/g, '/');
const KIT = `${ROOT}/bin/filmwright.mjs`;
const P = `${ROOT}/examples/scenecast`;
const WORK = `${P}/.work`;
const SEG = join(WORK, 'segments');
const OUT = join(WORK, 'attr-test.mp4');

let bad = 0;
const ok = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) bad++; };

// 用 200 帧/段 → 1486 帧 ≈ 8 段，能看清「只重渲中段」
const SEG_FRAMES = 200;
const run = () => {
  const r = spawnSync('node', [KIT, 'render', '--project', P, '--from', '1', '--to', '1486',
    '--out', OUT, '--incremental', '--seg-frames', String(SEG_FRAMES), '--json'],
    {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024});
  if (r.status !== 0) { console.log('渲染失败:', String(r.stderr).slice(-400)); return null; }
  const d = JSON.parse(r.stdout).data;
  // 从段缓存里读每个段是否本次新写（按 mtime）
  const parts = readdirSync(SEG).filter((f) => /^seg\d+-.*\.mp4$/.test(f))
    .map((f) => ({f, m: Number(f.match(/^seg(\d+)/)[1])}));
  return {...d, partNames: parts.map((p) => p.f)};
};

const segMeta = () => {
  if (!existsSync(SEG)) return {};
  const out = {};
  for (const f of readdirSync(SEG)) {
    const m = f.match(/^seg(\d+)-([0-9a-f]+)\.json$/);
    if (!m) continue;
    out[Number(m[1])] = JSON.parse(readFileSync(join(SEG, f), 'utf8'));
  }
  return out;
};

rmSync(SEG, {recursive: true, force: true});
rmSync(OUT, {force: true});

console.log('=== A) 首次：全渲 ===');
const a = run();
const segsA = segMeta();
ok(a && a.renderedSegments === a.segments && a.reusedSegments === 0,
  `应全渲（segments=${a?.segments}, rendered=${a?.renderedSegments}, reused=${a?.reusedSegments}）`);
ok(a?.attribution === 'per-shot', `归因粒度应为 per-shot（实际 ${a?.attribution}）`);
console.log('  段数:', a?.segments, '每段', SEG_FRAMES, '帧');

console.log('\n=== B) 不改动再跑：应全部复用 ===');
const b = run();
ok(b && b.reusedSegments === b.segments && b.renderedSegments === 0,
  `应全复用（reused=${b?.reusedSegments}/${b?.segments}, rendered=${b?.renderedSegments}）`);

console.log('\n=== C) 只改中间某个镜头：只有覆盖它的段该重渲 ===');
// scenecast 的 shots[3] 是 stat@S03（起点 602）→ 落在第 4 段（601-800）
const sceneFile = `${P}/scene.json`;
const sceneOrig = readFileSync(sceneFile);
const scene = JSON.parse(sceneOrig.toString('utf8'));
const TARGET = 3;
const targetStart = 602;
const wantSeg = Math.floor((targetStart - 1) / SEG_FRAMES);
console.log(`  目标：shots[${TARGET}]（${scene.shots[TARGET].type}@${scene.shots[TARGET].at}，起点 ${targetStart}）→ 第 ${wantSeg} 段`);
const before = {label: scene.shots[TARGET].label};
scene.shots[TARGET].label = String(before.label ?? '') + '·改';
writeFileSync(sceneFile, JSON.stringify(scene, null, 2), 'utf8');

let c = null;
try {
  c = run();
} finally {
  writeFileSync(sceneFile, sceneOrig);
}
ok(c !== null, '改镜头后渲染成功');
if (c) {
  console.log(`  结果：segments=${c.segments}, reused=${c.reusedSegments}, rendered=${c.renderedSegments}`);
  ok(c.renderedSegments >= 1, '至少重渲了目标段');
  ok(c.reusedSegments >= 1, `**其余段被复用了（reused=${c.reusedSegments}）** —— 这是增量重渲的价值`);
  ok(c.renderedSegments < c.segments,
    `没有全渲（rendered=${c.renderedSegments} < segments=${c.segments}）`);
}

console.log('\n=== D) 负面对照：改全局输入（时间轴）必须让所有段失效 ===');
// 时间轴进全局指纹（句帧号影响每一帧的字幕/HUD）
const tlFile = `${P}/script/timeline.json`;
const tlOrig = readFileSync(tlFile);
const tl = JSON.parse(tlOrig.toString('utf8'));
// 只动一句的起始帧（会移动字幕与章节卡，影响多段）
tl.sentences[0].from = (tl.sentences[0].from ?? 100) + 1;
writeFileSync(tlFile, JSON.stringify(tl, null, 1), 'utf8');
let d = null;
try {
  d = run();
} finally {
  writeFileSync(tlFile, tlOrig);
}
ok(d !== null, '改时间轴后渲染成功');
if (d) {
  console.log(`  结果：segments=${d.segments}, reused=${d.reusedSegments}, rendered=${d.renderedSegments}`);
  ok(d.renderedSegments === d.segments,
    `全局输入变了 → 所有段必须重渲（rendered=${d.renderedSegments}/${d.segments}）`);
}

// 恢复原状后再跑：注意**不能**直接断言「全复用」——
// D 步改全局输入时，原来那批段键不再匹配，被 pruneSegments 清掉了；
// E 恢复后键回到原值，但缓存已不在，所以这一轮必然重渲。
// 真正该验的是「恢复后的第二轮全复用」（缓存重新建立后能稳定命中）。
console.log('\n=== E) 恢复原状：第一轮会重渲（旧段已被清），第二轮应全复用 ===');
const e1 = run();
ok(e1 !== null, '恢复后能正常渲染');
if (e1) {
  console.log(`  第一轮：rendered=${e1.renderedSegments}, reused=${e1.reusedSegments}` +
    '（旧段在 D 步被清，属预期）');
  const e2 = run();
  ok(e2 && e2.renderedSegments === 0 && e2.reusedSegments === e2.segments,
    `第二轮应全复用（reused=${e2?.reusedSegments}/${e2?.segments}, rendered=${e2?.renderedSegments}）`);
}

// 再确认 C 步的结论稳健：改回原来的镜头内容后，只有目标段需要重渲
console.log('\n=== F) 反复改同一个镜头：每次只重渲那一段 ===');
{
  const orig = readFileSync(sceneFile);
  const s = JSON.parse(orig.toString('utf8'));
  const label0 = s.shots[TARGET].label;
  let lastRendered = [];
  for (const suffix of ['·二', '·三', '·四']) {
    const s2 = JSON.parse(orig.toString('utf8'));
    s2.shots[TARGET].label = String(label0) + suffix;
    writeFileSync(sceneFile, JSON.stringify(s2, null, 2), 'utf8');
    const r = run();
    lastRendered.push(r?.renderedSegments);
    console.log(`  改第 ${suffix.slice(1)} 次：rendered=${r?.renderedSegments}, reused=${r?.reusedSegments}`);
  }
  writeFileSync(sceneFile, orig);
  ok(lastRendered.every((n) => n === 1), `每次都应只重渲 1 段（实际 ${lastRendered.join(',')}）`);
}

rmSync(SEG, {recursive: true, force: true});
rmSync(OUT, {force: true});
console.log(bad === 0 ? '\n✓ 按段归因全部符合预期' : `\n✗ ${bad} 项失败`);
process.exit(bad ? 1 : 0);
