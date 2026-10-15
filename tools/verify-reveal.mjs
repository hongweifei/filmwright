// 逐字入场（`title.reveal`）验收。
//
//   node tools/verify-reveal.mjs [<仓库根>]
//
// ## 守什么
//
// `reveal` 把标题 / 引号按**码点**逐个送进场（`{stagger, dur, dy}`）。三条性质：
//
// 1. **逐个进场**：中间帧上左边的字先落位、右边的还没画 ⇒ 与「整块画法的**同帧**」的差异
//    沿列方向**递增**（不是处处一样平的整块淡入）；
// 2. **不引入不确定性**：同一帧两次渲染**逐字节一致**（每个字的进度只依赖 n）；
// 3. **落位后不排坏字**：落位帧与整块画法的同帧之间不允许出现**显著差异像素**（间距 / 字宽 /
//    光晕任一错位都会露出来）。
//
// ## 改前的两条判据是坏的（已修，点名）
//
// ⚠️ **「落位后逐字节相同」原本是自比自**：`shot()` 每次都 `rmSync` 重建项目目录，于是
// `f70.png` 与 `plain.png` **是同一个路径**，`rawRgb` 两边读到的都是最后渲的那张 ⇒ 恒 true。
// 现在每帧渲完立刻拷到稳定路径（`.work/revealtest-shots/<tag>.png`）再比。
// **实测证据**：把 `revealText` 的字距去掉（`px += adv[i]`）后，落位帧与整块帧的哈希是
// `668819dfab02` vs `2ed2e56579de`（明明不同），而改前的工具照样打印「✓ 逐字节相同」并 exit 0。
//
// ⚠️ **「第 10 / 30 / 70 帧互不相同」已删**：标题模板自带的入场动画（帧 8→40 的 alpha 与位移）
// 加光晕脉动，让它在 `reveal` 完全失效时照样成立 —— 实测把进度写成恒 1（等于没做 reveal），
// 该条仍然 ✓、整份工具仍然 exit 0。**它宣称的「不是整块淡入」恰恰不是它测的。**
// 顶上来的是 `[reveal-interim]` + `[reveal-order]`：在**同一帧**上拿整块画法当参照，才与 reveal 有关。
//
// ## ⚠️ 「落位后**逐字节**相同」这条文档口径实测不成立（本工具只报不改）
//
// `docs/scene.md` 与该文件旧注释都写「每个字按自己的 advance 居中，所以落位后与整块画法逐字节相同」。
// 实测**不成立**：落位帧确实与整块帧不同（最大像素差 **24**、3395 个像素差 ≥8、但**没有**任何像素差 ≥32）
// —— 是**逐字光晕叠加 vs 整串光晕**的残差，不是排坏。所以这条改成量级判据：
// **|Δ| ≥ 48 的像素必须为 0**（真逐字实测 0 个、最大 24；丢字距缺陷实测 26835 个、最大 228）。
// `src/` 不在被派范围 ⇒ 没去改实现，只把这条漂移打在输出里。
//
// ## 它自己的负面对照（每次运行都跑，走的是**同一套判据函数**）
//
// `selfCheck()` 在 `os.tmpdir()` 下造一个临时仓库根（拷 `index.html` / `src` / `bin` /
// `examples/gallery`），把缺陷注进**临时根的** `src/runtime/scene/templates.js`，再把自己当子进程
// 跑一遍（env `FW_REVEAL_NEG_CHILD=1` ⇒ 内层只跑标题那三条、且不再嵌套对照）。
// **三份缺陷各只该红它对应的那一条**（见 `DEFECTS` 的 red / green 表），真源码一字不动；
// 临时根跑完即删（含 SIGINT / SIGTERM 钩子 —— `try/finally` 挡不住被杀）。
//
// ## 没覆盖的（如实记）
//
// - **引号的「跨行接着数」没有判据**：原来的「落位后逐字节相同」既在自比自，用的第 70 帧其实
//   **还没落位** —— 引号 47 字 × `stagger 3` + `dur 12` ⇒ 落位在百帧开外（实测第 70 帧与整块帧
//   最大差 234）。补它要先定出引号的落位帧，本次没做，故意**不拿假判据充数**。
// - **时间方向**（已落位区域随帧向右扩大）没判：它要同一帧的整块参照，多渲一帧。
import {execFileSync, spawnSync} from 'node:child_process';
import {copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';

// ⚠️ 必须给兜底：CI 里不带参数跑（这条被 verify-invocation.mjs 守着）
const ROOT = (process.argv[2] ?? process.cwd()).replace(/\\/g, '/');
const P = join(ROOT, '.work', 'revealtest');
const SHOTS = join(ROOT, '.work', 'revealtest-shots');
const SELF = fileURLToPath(import.meta.url);
// 负面对照的内层：只跑标题那三条判据，且**不再嵌套对照**（否则无限递归）
const INNER = process.env.FW_REVEAL_NEG_CHILD === '1';

let bad = 0;
/** 每条判据都带一个**机器可读的 kind**：负面对照靠它认「红的是哪一条」，
 *  不靠中文文案 —— 文案一改，匹配文案的对照就变成假绿。 */
const ok = (c, kind, m) => { console.log(`${c ? '✓' : '✗'} [${kind}] ${m}`); if (!c) bad++; };

const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 12);

/**
 * 渲一帧静帧，并把它拷到**稳定路径**再返回。
 *
 * ⚠️ 每次都重建项目目录（`scene.json` 由我们完全控制），所以上一帧的路径会被下一帧覆盖 ——
 * 改前「落位帧 vs 整块帧」正是踩在这一点上变成自比自的。
 */
const shot = (extra, n, tag) => {
  // ⚠️ Windows 上 Chrome 可能还握着目录句柄（EBUSY）—— 给 rmSync 重试，
  //    别把「上一个浏览器还没放手」记成渲染失败（仓库里踩过这条）。
  rmSync(P, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
  cpSync(join(ROOT, 'examples', 'gallery'), P, {recursive: true});
  rmSync(join(P, 'audio'), {recursive: true, force: true});
  rmSync(join(P, 'renders'), {recursive: true, force: true});
  writeFileSync(join(P, 'scene.json'), JSON.stringify({shots: [{at: 1, ...extra}]}, null, 2));
  // ⚠️ **二分「夹具 vs 引擎」**：把写进去的 scene.json 读回来核一遍。
  // 加这条是因为 CI（Linux）报「逐字帧与整块帧**哈希完全相同**」而本机（Windows）不同 ——
  // 那说明逐字分支根本没走。可能是「夹具没写进去」，也可能是「引擎没读它」，
  // 这条断言把前一半钉死：夹具错了就在**这里**红，而不是在下游判据上红得莫名其妙。
  const back = JSON.parse(readFileSync(join(P, 'scene.json'), 'utf8')).shots[0];
  if (extra.reveal !== undefined && back.reveal === undefined) {
    throw new Error(`filmwright: 夹具的 reveal 没写进 scene.json（${join(P, 'scene.json')}）`);
  }
  // ⚠️ **自定位诊断**：把夹具实际写进去的 reveal 打出来。
  // CI（Linux）报「逐字帧与整块帧哈希完全相同」而本机（Windows）不复现 ⇒
  // 下一次再红时，这一行就能说明「夹具里到底有没有 reveal」，
  // 不用再靠读代码猜（接线、路径、项目类型我都已经逐一排除过）。
  if (extra.reveal !== undefined) {
    console.log(`  [diag] 夹具 shot 的键：${Object.keys(back).join(' ')}`);
    console.log(`  [diag] 夹具 reveal = ${JSON.stringify(back.reveal)}`);
  }
  mkdirSync(join(P, 'out'), {recursive: true});
  execFileSync('node', [join(ROOT, 'bin', 'filmwright.mjs'), 'stills', '--project', P,
    '--frames', String(n), '--dir', join(P, 'out')], {stdio: ['ignore', 'ignore', 'inherit']});
  const stable = join(SHOTS, `${tag}.png`);
  copyFileSync(join(P, 'out', `f${String(n).padStart(5, '0')}.png`), stable);
  return {hash: sha(stable), png: stable};
};

/** 解成 raw RGB（不经任何统计量 / 有损编码）—— 显著差异像素就在这上面数。 */
const rawRgb = (png) => execFileSync('ffmpeg',
  ['-v', 'error', '-i', png, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
  {maxBuffer: 64 * 1024 * 1024});

/** 逐列平均 |Δ|：ffmpeg 求差后纵向按面积平均成 1 行灰度。宽度由输入自己决定（不写死分辨率）。 */
const colProfile = (a, b) => execFileSync('ffmpeg',
  ['-v', 'error', '-i', a, '-i', b, '-filter_complex',
    '[0][1]blend=all_mode=difference,format=gray,scale=iw:1:flags=area',
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], {maxBuffer: 8 * 1024 * 1024});

/** 只统计**有差异的列**（两帧同帧、同场景，唯一差别就是 reveal）：把它们按列均分四段求和。 */
function diffBands(buf) {
  const v = [...buf];
  let first = -1, last = -1;
  v.forEach((x, i) => { if (x > 0) { if (first < 0) first = i; last = i; } });
  const total = v.reduce((s, x) => s + x, 0);
  if (first < 0) return {first, last, total, bands: [0, 0, 0, 0], ratio: 0};
  const span = last - first + 1;
  const bands = [0, 0, 0, 0];
  for (let i = first; i <= last; i++) bands[Math.min(3, Math.floor((i - first) * 4 / span))] += v[i];
  // 首段为 0、尾段非 0 ⇒ 左边已经落位、右边还在动：方向明确成立，比值记 ∞。
  const ratio = bands[0] > 0 ? bands[3] / bands[0] : (bands[3] > 0 ? Infinity : 0);
  return {first, last, total, bands, ratio};
}

/** 显著差异像素：任一通道 |Δ| ≥ BIG 的像素个数（落位帧上不该有）。 */
const BIG = 48;
function bigDiffPixels(a, b) {
  if (a.length !== b.length || a.length === 0) return {n: -1, max: -1};
  let n = 0, max = 0;
  for (let i = 0; i < a.length; i += 3) {
    const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
    if (d > max) max = d;
    if (d >= BIG) n++;
  }
  return {n, max};
}

// ── 夹具 ──
const RV = {stagger: 3, dur: 12, dy: 26};
const T = {type: 'title', title: '把内容变成帧', sub: '副标题', kicker: 'KICKER'};
const Q = {type: 'quote', who: 'filmwright',
  text: '一句要长到需要折行的话，用来验证逐字入场跨行之后仍然连续，而不是每行各自重新开始。'};

// 探针帧是**夹具自己的**选点：第 10 帧落在逐字窗口里（只剩最左边一两个字在动），第 70 帧标题已落位
// （标题的逐字窗口约帧 8→35）。实现的时间线一变，选点可能落到「一字未进」或「全部落位」上 ——
// 那时 `[reveal-interim]` / `[reveal-landed]` 会**响亮地红**，而不是静默变绿。
const N_MID = 10, N_END = 70;
// 方向阈值：实测真逐字 2.52、整块淡入 1.27（见负面对照 DEFECTS②）。
const ORDER_MIN = 1.6;

function titleJudges() {
  const rvMid = shot({...T, reveal: RV}, N_MID, 'title-reveal-mid');
  const plMid = shot(T, N_MID, 'title-plain-mid');
  const rvEnd = shot({...T, reveal: RV}, N_END, 'title-reveal-end');
  const plEnd = shot(T, N_END, 'title-plain-end');
  console.log(`  标题 逐字 第${N_MID}帧 ${rvMid.hash} / 第${N_END}帧 ${rvEnd.hash}；`
    + `整块 第${N_MID}帧 ${plMid.hash} / 第${N_END}帧 ${plEnd.hash}`);

  const prof = diffBands(colProfile(rvMid.png, plMid.png));
  const ratio = Number.isFinite(prof.ratio) ? prof.ratio.toFixed(2) : '∞（首段为 0）';
  console.log(`  中间帧差异剖面（列 ${prof.first}..${prof.last}，总差 ${prof.total}）：`
    + `${prof.bands.join(' / ')}  尾段/首段 = ${ratio}`);
  ok(prof.total > 0, 'reveal-interim',
    '中间帧上 reveal 真的改变了画面（总差 0 ⇒ 逐字等于没做，别让它在空集上恒绿）');
  ok(prof.ratio >= ORDER_MIN, 'reveal-order',
    `差异沿列**递增**：尾段/首段 = ${ratio} ≥ ${ORDER_MIN} ⇒ 左边的字先落位、右边的还没画，`
    + '是**逐个**而不是整块淡入（整块实测约 1.27）');

  // 内层只跑对照表里那三条（少渲一帧、也少一条与缺陷无关的判据）
  if (!INNER) {
    const rvEndB = shot({...T, reveal: RV}, N_END, 'title-reveal-end-b');
    ok(rvEnd.hash === rvEndB.hash, 'reveal-stable',
      '同一帧两次渲染**逐字节一致** ⇒ 逐字不引入不确定性');
  }

  const landed = bigDiffPixels(rawRgb(rvEnd.png), rawRgb(plEnd.png));
  console.log(`  落位帧 vs 整块帧：最大像素差 ${landed.max}，|Δ| ≥ ${BIG} 的像素 ${landed.n} 个`);
  console.log('  （注：两者**并非逐字节相同** —— 逐字光晕叠加 vs 整串光晕有残差，'
    + '`docs/scene.md` 的「逐字节相同」实测不成立，本判据按量级判）');
  ok(landed.n === 0, 'reveal-landed', landed.n === 0
    ? `落位后与整块画法只差光晕 / 抗锯齿的残差（|Δ| ≥ ${BIG} 的像素 0 个）⇒ 没有把字排坏`
    : `落位后与整块画法有 ${landed.n} 个像素差 ≥ ${BIG}（最大 ${landed.max}）`
      + ' ⇒ 间距 / 字宽 / 光晕被排坏了');
}

function quoteJudges() {
  const rvMid = shot({...Q, reveal: RV}, N_MID, 'quote-reveal-mid');
  const rvMidB = shot({...Q, reveal: RV}, N_MID, 'quote-reveal-mid-b');
  const plMid = shot(Q, N_MID, 'quote-plain-mid');
  console.log(`  quote 逐字 第${N_MID}帧 ${rvMid.hash}；整块 第${N_MID}帧 ${plMid.hash}`);
  const prof = diffBands(colProfile(rvMid.png, plMid.png));
  const ratio = Number.isFinite(prof.ratio) ? prof.ratio.toFixed(2) : '∞（首段为 0）';
  console.log(`  quote 中间帧差异剖面（列 ${prof.first}..${prof.last}，总差 ${prof.total}）：`
    + `${prof.bands.join(' / ')}  尾段/首段 = ${ratio}（**不判定**：引号要按折行区单独校准，本次没做）`);
  ok(prof.total > 0, 'quote-interim',
    'quote：中间帧上 reveal 同样真的改变了画面（总差 0 ⇒ 引号的逐字等于没做）');
  ok(rvMid.hash === rvMidB.hash, 'quote-stable', 'quote：同一帧两次渲染**逐字节一致**');
}

// ── bullets 的 heading：同一个 `revealText`，但**位置不同**（居中在 142，字号小得多）──
// 与 title/quote 分开判，是因为逐字定位依赖「每个字按自己的 advance 居中」；
// 换一个字号/位置就换了一次宽度累加，正是早年 `"MoonBit"` → `"MoonB it"` 那类错位的高发处。
function bulletsJudges() {
  const B = {type: 'bullets', heading: '要点清单的标题', items: [{t: '一'}, {t: '二'}]};
  const rvMid = shot({...B, reveal: RV}, N_MID, 'bullets-reveal-mid');
  const rvMidB = shot({...B, reveal: RV}, N_MID, 'bullets-reveal-mid-b');
  const plMid = shot(B, N_MID, 'bullets-plain-mid');
  console.log(`  bullets heading 逐字 第${N_MID}帧 ${rvMid.hash}；整块 第${N_MID}帧 ${plMid.hash}`);
  // 判据用**哈希不同**（而不是 ffmpeg 的列剖面）：heading 字号小、位置不同，
  // 列剖面在这条路径上取不到差异（实测 total=0 而两个哈希明明不同 ⇒ 那是量测方法的问题，不是判据）。
  ok(rvMid.hash !== plMid.hash, 'bullets-interim',
    'bullets heading：中间帧上 reveal 真的改变了画面（与整块画法的哈希不同 ⇒ 逐字不是等于没做）');
  ok(rvMid.hash === rvMidB.hash, 'bullets-stable',
    'bullets heading：同一帧两次渲染**逐字节一致**');
  // 落位后应当回到整块画法的量级（错位/丢字距会把它顶到两百以上，与 reveal 那份同口径）
  const rvEnd = shot({...B, reveal: RV}, N_END, 'bullets-reveal-end');
  const plEnd = shot(B, N_END, 'bullets-plain-end');
  const big = bigDiffPixels(rawRgb(rvEnd.png), rawRgb(plEnd.png));
  console.log(`  bullets heading 落位后（第${N_END}帧）：|Δ| ≥ ${BIG} 的像素 ${big.n}，最大差 ${big.max}`);
  ok(big.n === 0, 'bullets-landed',
    `bullets heading：落位后与整块画法没有大残差（|Δ| ≥ ${BIG} 的像素 ${big.n}，应为 0；`
    + `实测最大差 ${big.max} —— 错位/丢字距会顶到两百以上）`);
}

// ── 负面对照 ──────────────────────────────────────────────────────────────────
const TMP_ROOTS = [];
const dropTmp = () => {
  for (const d of TMP_ROOTS.splice(0)) {
    rmSync(d, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
  }
};
process.on('exit', dropTmp);
// ⚠️ `try/finally` 挡不住被杀（SIGINT / SIGTERM 默认直接终止），要单独挂钩子：先清再退。
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.on(sig, () => { dropTmp(); process.exit(code); });
}

const TEMPL_REL = 'src/runtime/scene/templates.js';
const indent = (s) => s.trimEnd().split('\n').map((l) => '    | ' + l).join('\n');

/** 三份缺陷，各只该红它对应的那一条（内层只跑标题这三条判据）。 */
const DEFECTS = [
  {
    name: '逐字失效：进度恒为 1（reveal 等于没做）',
    patches: [['const t = easeOut3(inv(n, t0, t0 + dur));', 'const t = 1;']],
    // 没有动作 ⇒「有动作」与「方向」两条同时不成立；落位帧本身是对的。
    red: ['reveal-interim', 'reveal-order'], green: ['reveal-landed'],
  },
  {
    name: '整块淡入：所有字共用同一进度',
    patches: [['const t0 = base + (offset + i) * per;', 'const t0 = base;']],
    // 有动作（剖面非空）但处处一样平 ⇒ 只该红「方向」这一条。
    red: ['reveal-order'], green: ['reveal-interim', 'reveal-landed'],
  },
  {
    name: '落位丢字距：px += adv[i]',
    patches: [['px += adv[i] + spacing;', 'px += adv[i];']],
    // 中间帧上看不出来（那时右边的字根本没画，剖面与字距无关），落位帧才露馅 ⇒ 只该红「落位」。
    red: ['reveal-landed'], green: ['reveal-interim', 'reveal-order'],
  },
];

const runInner = (root) => {
  const r = spawnSync(process.execPath, [SELF, root], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: {...process.env, FW_REVEAL_NEG_CHILD: '1'},
  });
  return {status: r.status, error: r.error, out: `${r.stdout ?? ''}${r.stderr ?? ''}`};
};

function selfCheck() {
  const tmp = join(tmpdir(), `fw-reveal-neg-${process.pid}-${Date.now()}`);
  TMP_ROOTS.push(tmp);
  console.log(`\n  负面对照：临时仓库根 ${tmp}`);
  try {
    // 临时仓库根：渲染页 + 运行时源码 + 入口 + 夹具。`src` 必须**拷一份** —— 缺陷只注进副本。
    for (const rel of ['index.html', 'src', 'bin']) {
      cpSync(join(ROOT, rel), join(tmp, rel), {recursive: true});
    }
    cpSync(join(ROOT, 'examples', 'gallery'), join(tmp, 'examples', 'gallery'), {recursive: true});
    const templ = join(tmp, TEMPL_REL);
    const pristine = readFileSync(templ, 'utf8');

    for (const d of DEFECTS) {
      let patched = pristine;
      let anchored = true;
      for (const [from, to] of d.patches) {
        const hits = patched.split(from).length - 1;
        if (hits !== 1) {
          // ⚠️ 替换静默命中 0 次 = 假绿：锚点漂了就**报红**，不让它悄悄跑成「没缺陷」。
          ok(false, 'neg-anchor',
            `缺陷「${d.name}」的锚点在 ${TEMPL_REL} 里命中 ${hits} 次（应为 1）⇒ 对照失效，先修锚点`);
          anchored = false;
          break;
        }
        patched = patched.replace(from, to);
      }
      if (!anchored) continue;

      writeFileSync(templ, patched);
      const before = bad;
      const r = runInner(tmp);
      const reds = new Set([...r.out.matchAll(/^✗ \[([^\]]+)\]/gm)].map((m) => m[1]));
      const greens = new Set([...r.out.matchAll(/^✓ \[([^\]]+)\]/gm)].map((m) => m[1]));
      const summary = r.out.match(/✗ (\d+) 项失败/);
      const ranJudges = reds.size + greens.size;
      // ⚠️ 先把「内层没跑起来」与「判据没红」分开报（两类都算失败）：
      // 渲染 / 启动失败会让一条判据都没跑到，别把它当成「缺陷被抓住了」。
      ok(ranJudges > 0, 'neg-ran', ranJudges > 0
        ? `缺陷「${d.name}」⇒ 内层跑到了 ${ranJudges} 条判据`
        : `缺陷「${d.name}」⇒ 内层**一条判据都没跑到**（渲染 / 启动失败？）—— 对照无法判定，按失败记`);
      ok(r.status === 1 && !r.error, 'neg-exit',
        `缺陷「${d.name}」⇒ 内层退出码 ${r.status}`
        + `${r.error ? `（子进程没起来：${r.error.message}）` : ''}（要求 1 = 判据红，不是崩）`);
      ok(d.red.every((k) => reds.has(k)) && reds.size === d.red.length, 'neg-red',
        `缺陷「${d.name}」⇒ 内层红点 ${[...reds].join(' / ') || '（一条都没有）'}`
        + `（要求恰好 ${d.red.join(' / ')}）`);
      ok(d.green.every((k) => greens.has(k)), 'neg-green',
        `缺陷「${d.name}」⇒ 另外几条仍绿（${d.green.join(' / ')}）`
        + '⇒ 红的确实是它对应的那一条，不是临时根坏了');
      ok(Boolean(summary) && Number(summary[1]) === reds.size, 'neg-summary',
        `缺陷「${d.name}」⇒ 内层跑完并自报「${summary ? summary[0] : '（没有收尾行，可能中途崩了）'}」`);
      if (bad > before) console.log(indent(r.out));
    }
    writeFileSync(templ, pristine);
  } catch (e) {
    ok(false, 'neg-crash', `负面对照自己出错：${e && e.message ? e.message : String(e)}`);
  } finally {
    dropTmp();
    ok(!existsSync(tmp), 'neg-cleanup', '临时仓库根（含注入缺陷的源码副本）已删干净');
  }
}

// ── 跑 ──
mkdirSync(SHOTS, {recursive: true});
titleJudges();
if (!INNER) {
  quoteJudges();
// ⚠️ bullets 那组**不进内层**：内层（负面对照的子进程）按设计只跑标题那三条以控成本，
// 我加进来时忘了这层，5 次额外渲染把内层的预算撑爆 ⇒ 缺陷① 那次「一条判据都没跑到」。
if (!INNER) bulletsJudges();
  selfCheck();
}
rmSync(P, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
rmSync(SHOTS, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
console.log(bad === 0 ? '\n✓ 逐字入场全部符合预期' : `\n✗ ${bad} 项失败`);
process.exit(bad ? 1 : 0);
