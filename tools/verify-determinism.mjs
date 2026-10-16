// 捕获确定性的**回归验证**：多轮渲染同一区间，全部帧必须逐字节一致。
//
//   node tools/verify-determinism.mjs [<仓库根>] [轮数]
//
// ## 为什么需要这个工具
//
// 曾经有一个真 bug：绘制是纯函数且确定，但取像素走 `Page.captureScreenshot`，
// 而截图取的是**合成器已呈现的那一帧**（异步），于是偶尔取到上一帧。
// 实测 8 轮 × 60 帧里，3 帧出现过「7 次一致 + 1 次孤例」。
//
// 危害被有损编码放大：60 帧里 1 帧不同，编出的 mp4 可能 45/60 帧都不同
// （GOP 与码率控制连锁），像素回归与增量重渲的判据全部失效。
//
// 修法：改成从 **canvas 后备存储**直接读（绘制是同步的，读它没有竞态）。
// 实测：画布直读 0/60 不稳定，截图 3/60 不稳定；且两者**像素完全相同**
// （只是 PNG 编码不同：画布直读体积大，但像素哈希一致）。
//
// 这个工具就是钉住这个性质：**多轮渲染必须完全一致**。
//
// ## ⚠️ 它有一个结构性盲区：**同一会话内**的不一致它看不见
//
// 它的每轮都是**新会话**，比的是"第 i 轮的帧 n"与"第 j 轮的帧 n"。于是
// 「一帧在本会话里**第一次**渲染与之后渲染不同」这类缺陷**两轮会同样地错**，
// 跨轮哈希照样一致 ⇒ 这里全绿，而引擎其实违反了不变量。
// 实测踩过（2026-10）：图片素材没等 `decode()`，一个会话里第一次画带 `shadowBlur` 的图片
// 与之后再画差 4 万个通道 —— 本工具完全量不到（区间 1..60 里也没有那几帧）。
// 那条性质由 `tools/verify-assets.mjs` 的 2b 段钉住（**同一个会话里同一帧渲两遍**必须逐像素相同），
// 它带 `--negative`（去掉 `decode()` 必须红）。**两个工具是互补的，别以为这里绿就等于确定。**
//
// ## 判据四条（只留第 1 条会恒绿）
//
// 1. **跨轮逐字节一致**：同一帧号在各轮里的 PNG 字节哈希只有一种取值，
//    且该帧号必须在**每一轮**都出现 —— 遍历各轮键的**并集**，只看第 1 轮的键
//    会让「第 1 轮缺的那几帧」永远不被检查。
// 2. **帧数下限**：每轮捕获到的帧数必须正好等于请求区间长度（`to - from + 1`）。
//    没有这条，`renderRange` 静默不落盘时会打印「不稳定帧 0 / 0」并 ✓ exit 0
//    —— **空集上的一致不是一致**。
// 3. **非恒定下限**：整个区间所有轮的所有帧不能只有一种哈希（唯一哈希 ≥ 2）。
//    没有这条，取像素退化成「每次都回同一张」也照样全绿。
// 4. **至少 2 轮**：1 轮时「同一帧号在各轮里的取值集合」恒为 1 个元素，判据恒真。
//
// 2–4 是「这个区间真的量到了东西」的下限，不是产品性质本身。
// 判据里没有实现常量：帧数上限来自**本工具自己声明的请求区间**，不是写死的分辨率或帧号。
//
// ## 负面对照（每次运行都跑，没有开关）
//
// 本工具自己造缺陷证明判据能红：把被测仓库的 `src/`（渲染页 `src/host/pages/render.html` 在内）复制到
// **临时仓库根**（`os.tmpdir()` 下，跑完即删），注入缺陷后用**同一套判据**判：
//   A. 取像素跨轮返回不同字节（模拟 `Page.captureScreenshot` 那类竞态）；
//   B. 捕获静默不落盘（PNG 一个都不写 ⇒ 空集）。
// A 必须**只**红「跨轮一致」那条，B 必须红「帧数下限」+「非恒定」两条。
// 真源码一行都不动：缺陷全部注入临时副本。
// 对照自己也要能证伪 —— 某份缺陷没让判据变红就判失败，
// 否则「我们有负面对照」本身就是一条永远绿的断言。
import {createHash} from 'node:crypto';
import {readFileSync, readdirSync, rmSync, mkdirSync, cpSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {dirname, resolve, join} from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
// resolve() 保证 ROOT 是**绝对路径**：下面会用 `pathToFileURL(`${ROOT}/…`)` 拼 URL，
// 相对路径会直接抛 ERR_INVALID_FILE_URL_PATH。
const ROOT = resolve(process.argv[2] ?? resolve(HERE, '..')).replace(/\\/g, '/');
const ROUNDS = Number(process.argv[3] ?? 6);
const FROM = 1, TO = 60;

if (!Number.isInteger(ROUNDS) || ROUNDS < 1) {
  console.error(`✗ 轮数「${process.argv[3]}」不是正整数 —— 一轮都不跑就判「一致」是恒绿`);
  process.exit(1);
}

/** 夹具项目：与产品路径里的同一个 `examples/minimal`（区间内一直有动画）。 */
const PROJECT = `${ROOT}/examples/minimal`;
// 但**传给引擎**的路径要用本机形态：`src/host/project/server.mjs` 的静态服务白名单是
// `f.startsWith(projectDir)`，而 `path.join()` 会把分隔符统一成本机形态 —— 混用分隔符时
// `/assets/**` 会被判 403。主跑一直「能用」只是因为夹具正好在仓库根之下，
// 撞上了另一条 `startsWith(KIT_ROOT)`；换成临时仓库根就立刻暴露。
const PROJECT_DIR = resolve(PROJECT);

/**
 * 按给定的**仓库根**导入渲染路径。负面对照靠它导入**临时副本**里的模块
 * （模块按 URL 缓存，所以不同根 = 不同实例，不会互相污染）。
 */
const toolkit = async (root) => ({
  loadProject: (await import(pathToFileURL(`${root}/src/host/project/load.mjs`).href)).loadProject,
  renderRange: (await import(pathToFileURL(`${root}/src/host/media/renderRange.mjs`).href)).renderRange,
});

/** 读一轮的 PNG 目录 → {帧号: 字节哈希}。目录里非帧文件不算帧。 */
const hashRound = (dir) => {
  const out = {};
  for (const f of readdirSync(dir)) {
    const m = /\d+/.exec(f);
    if (!m) continue;
    out[Number(m[0])] = createHash('sha256').update(readFileSync(join(dir, f))).digest('hex').slice(0, 12);
  }
  return out;
};

/** 捕获 n 轮：每轮一次 `renderRange`（各自一个浏览器实例），落 PNG 后逐帧哈希。 */
const captureRounds = async (root, projectDir, workDir, {from, to, rounds, onRound}) => {
  const {loadProject, renderRange} = await toolkit(root);
  const proj = await loadProject(projectDir);
  const runs = [];
  for (let i = 1; i <= rounds; i++) {
    const dir = join(workDir, `r${i}`);
    const t0 = Date.now();
    await renderRange(projectDir, proj, {from, to, out: null, pngDir: dir});
    const r = hashRound(dir);
    runs.push(r);
    if (onRound) onRound(i, r, ((Date.now() - t0) / 1000).toFixed(1));
  }
  return runs;
};

/**
 * 判一次「多轮捕获」。
 * @returns {{problems: string[], unstable: {n: number, vals: string[]}[], frames: number, hashes: number}}
 *   problems —— 判据本身不成立（轮数不足 / 帧数不符 / 缺帧 / 整段恒定）
 *   unstable —— 跨轮字节不一致的帧
 * 两者任一非空即判失败。
 */
const judge = (runs, {from, to, rounds}) => {
  const problems = [];
  const unstable = [];
  const expected = to - from + 1;

  // 下限：至少两轮（1 轮时每帧在各轮的取值集合恒为 1 个元素）
  if (rounds < 2) {
    problems.push(`只捕获了 ${rounds} 轮 —— 少于 2 轮时「逐字节一致」恒真，判据没有区分力`);
  }
  // 下限：每轮帧数必须正好是请求区间
  for (let i = 0; i < runs.length; i++) {
    const got = Object.keys(runs[i]).length;
    if (got !== expected) problems.push(`第 ${i + 1} 轮捕获 ${got} 帧，请求区间 ${from}..${to} 应为 ${expected} 帧`);
  }

  // 逐帧比对：走各轮并集，避免「第 1 轮缺帧 ⇒ 该帧从不被检查」
  const nums = [...new Set(runs.flatMap((r) => Object.keys(r).map(Number)))].sort((a, b) => a - b);
  for (const n of nums) {
    const present = runs.filter((r) => r[n] !== undefined).length;
    if (present !== runs.length) {
      problems.push(`帧 ${n} 只在 ${present} / ${runs.length} 轮里出现 —— 缺帧的那几轮根本没被比`);
      continue;
    }
    const vals = [...new Set(runs.map((r) => r[n]))];
    if (vals.length > 1) unstable.push({n, vals});
  }

  // 下限：整段不能恒定（否则「取像素退化成常量」也能全绿）
  const hashes = new Set(runs.flatMap((r) => Object.values(r)));
  if (hashes.size < 2) {
    problems.push(`整个区间只有 ${hashes.size} 种帧字节 —— 要么这段真的静止（那这个工具什么也量不到），`
      + '要么取像素退化成了常量（每次都回同一张）');
  }
  return {problems, unstable, frames: nums.length, hashes: hashes.size};
};

// ---------- 正常输入：判据必须全绿 ----------

const W = `${ROOT}/.work/determinism`;
rmSync(W, {recursive: true, force: true});
mkdirSync(W, {recursive: true});
console.log(`=== 捕获 ${FROM}..${TO}，共 ${ROUNDS} 轮（${PROJECT}）===`);
const runs = await captureRounds(ROOT, PROJECT_DIR, W, {
  from: FROM, to: TO, rounds: ROUNDS,
  onRound: (i, r, secs) => process.stdout.write(
    `  第 ${i} 轮  ${Object.keys(r).length} 帧（唯一 ${new Set(Object.values(r)).size}）  ${secs}s\n`),
});

const v = judge(runs, {from: FROM, to: TO, rounds: ROUNDS});
console.log(`\n不稳定帧：${v.unstable.length} / ${v.frames}`);
for (const u of v.unstable) {
  const counts = {};
  for (const r of runs) counts[r[u.n]] = (counts[r[u.n]] ?? 0) + 1;
  console.log(`  帧 ${u.n}: ${JSON.stringify(counts)}`);
}
console.log(`唯一帧字节：${v.hashes} 种 / ${v.frames} 帧`);
for (const p of v.problems) console.log(`  ✗ ${p}`);
rmSync(W, {recursive: true, force: true});

const mainOk = v.problems.length === 0 && v.unstable.length === 0;
console.log(mainOk
  ? `\n✓ ${ROUNDS} 轮 × ${v.frames} 帧全部逐字节一致（捕获无竞态）`
  : `\n✗ 判据失败：${v.unstable.length} 帧跨轮不一致，另有 ${v.problems.length} 条下限不成立`);

// ---------- 负面对照：注入缺陷 ⇒ 同一套判据必须变红 ----------
//
// 临时根里只放这次渲染真正要用的东西：`src/`（被测代码，渲染页 `src/host/pages/render.html` 在其中）。
// 项目夹具直接用真仓库里那份 —— 渲染只读它（pngDir 落在临时根里），不往项目目录写东西。

const NEG = {from: 1, to: 2, rounds: 2};
const NEG_FRAMES = NEG.to - NEG.from + 1;   // 缺陷 A 靠它认「第几轮」
const TMP_ROOTS = new Set();

const dropTmp = () => {
  for (const r of TMP_ROOTS) {
    try { rmSync(r, {recursive: true, force: true}); } catch { /* 临时物删不掉不算失败 */ }
  }
  TMP_ROOTS.clear();
};
// try/finally 挡不住 SIGINT/SIGTERM（见 verify-incremental 那次踩坑），所以另挂钩子。
const onSignal = (sig) => { dropTmp(); process.exit(sig === 'SIGINT' ? 130 : 143); };
process.on('exit', dropTmp);
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

/** 把锚点替换成缺陷版；锚点没命中就抛 —— 别让「替换了个寂寞」变成假绿。 */
const inject = (file, anchor, patch, what) => {
  const src = readFileSync(file, 'utf8');
  if (!src.includes(anchor)) throw new Error(`负面对照 ${what}：注入锚点在 ${file} 里没命中，替换会静默落空`);
  writeFileSync(file, src.replace(anchor, patch));
};

/** 造一个临时仓库根：复制 src/（渲染页在 `src/host/pages/render.html`，跟着 src/ 一起过去），再注入缺陷。 */
const makeNegRoot = (base, name, patch) => {
  const root = join(base, name);
  mkdirSync(root, {recursive: true});
  cpSync(join(ROOT, 'src'), join(root, 'src'), {recursive: true});
  // 临时仓库根就是新的「库根」⇒ `/fonts/` 的兜底也落在这里。不拷字体的话，
  // 这个根里一份字体都没有，页面会静默回退系统字体 —— 在 CI 的 ubuntu 上
  // （无中文字体）中文直接画不出来，测的就不再是产品里那条路径了。
  cpSync(join(ROOT, 'fonts'), join(root, 'fonts'), {recursive: true});
  patch(root);
  TMP_ROOTS.add(root);
  return root;
};

// 缺陷 A：第 2 轮起的帧字节与第 1 轮不同（模拟「取到的是别的一帧」那类竞态）
const A_ANCHOR = `      const dataUrl = r.result?.result?.value;
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
        throw new Error('filmwright: 第 ' + n + ' 帧取像素失败（toDataURL 没返回图像）');
      }
      return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');`;
const A_PATCH = `      const dataUrl = r.result?.result?.value;
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
        throw new Error('filmwright: 第 ' + n + ' 帧取像素失败（toDataURL 没返回图像）');
      }
      // 【负面对照注入的缺陷】第 2 轮起的帧字节比第 1 轮多一个字节。
      // 对照每轮 ${NEG_FRAMES} 帧、每轮一个新会话，所以用累计调用次数除每轮帧数认轮次。
      const raw = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
      const call = (globalThis.__fwNegCalls = (globalThis.__fwNegCalls ?? 0) + 1);
      return Math.floor((call - 1) / ${NEG_FRAMES}) % 2 === 1
        ? Buffer.concat([raw, Buffer.from([0])])
        : raw;`;
const patchA = (root) => inject(join(root, 'src', 'host', 'browser', 'session.mjs'), A_ANCHOR, A_PATCH, 'A');

// 缺陷 B：捕获一个 PNG 都不写（静默空集）。
// ⚠️ 替换文本必须**保持分支形状**：这一行原本是 `if (pngDir) …; else if (…ff.stdin…)`，
// 把条件改成 `pngDir && 假` 会让它掉进 ffmpeg 那一支（那时 `ff` 是 null），
// 崩在写 ffmpeg 而不是红在判据上。所以只在**分支体内**再套一层假条件。
// （锚点里含反引号与 `${…}`，这里只当**文本**用，所以走单引号字符串。）
const B_ANCHOR = 'if (pngDir) writeFileSync(join(pngDir, `f${String(n).padStart(5, \'0\')}.png`), buf);';
const B_PATCH = 'if (pngDir) { if (globalThis.__fwNegWrite) writeFileSync(join(pngDir, `f${String(n).padStart(5, \'0\')}.png`), buf); }';
const patchB = (root) => inject(join(root, 'src', 'host', 'media', 'renderRange.mjs'), B_ANCHOR, B_PATCH, 'B');

/** 跑一份负面对照；expect 决定「怎样才算按预期变红」。 */
const runNegative = async (base, name, patch, why, expect) => {
  console.log(`\n  ${name}：${why}`);
  const root = makeNegRoot(base, name, patch);
  const t0 = Date.now();
  let negRuns = null;
  try {
    negRuns = await captureRounds(root, PROJECT_DIR, join(root, '.work'), {
      ...NEG,
      onRound: (i, r) => process.stdout.write(`    第 ${i} 轮  ${Object.keys(r).length} 帧（唯一 ${new Set(Object.values(r)).size}）\n`),
    });
  } catch (e) {
    // 跑不完 ⇒ 对照没成立。这跟「判据变红」是两回事，必须分开说，不许算通过。
    console.log(`    ✗ 负面对照没跑完（不是判据变红）：${String((e && e.message) || e).split('\n')[0].slice(0, 200)}`);
    return false;
  }
  const nv = judge(negRuns, NEG);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`    判据输出：跨轮不一致 ${nv.unstable.length} / ${nv.frames} 帧；下限问题 ${nv.problems.length} 条`
    + `；唯一帧字节 ${nv.hashes} 种  （${secs}s）`);
  for (const p of nv.problems) console.log(`      · ${p}`);
  console.log(`    若只看「跨轮一致」那一条，这份缺陷会被判：${nv.unstable.length === 0 ? '绿（逃逸）' : '红'}`);
  const red = expect(nv);
  console.log(red ? '    ✓ 负面对照按预期变红' : '    ✗ 负面对照没有变红 —— 判据对这份缺陷是瞎的');
  return red;
};

console.log('\n=== 负面对照（临时仓库根，真源码一行不动）===');
let negOk = true;
try {
  const base = join(tmpdir(), `fw-det-neg-${process.pid}`);
  rmSync(base, {recursive: true, force: true});
  mkdirSync(base, {recursive: true});
  TMP_ROOTS.add(base);
  negOk = await runNegative(base, 'A-bytes', patchA,
    '取像素跨轮返回不同字节 ⇒ 必须红在「跨轮一致」',
    (nv) => nv.problems.length === 0 && nv.unstable.length > 0) && negOk;
  negOk = await runNegative(base, 'B-empty', patchB,
    '一个 PNG 都不写 ⇒ 必须红在「帧数下限」（旧判据在这里会 ✓ 0 帧全一致）',
    (nv) => nv.problems.length > 0) && negOk;
} finally {
  dropTmp();
}

const ok = mainOk && negOk;
console.log(ok
  ? '\n✓ 两遍都成立：正常输入全绿，注入缺陷必红'
  : '\n✗ 判据或负面对照有问题（见上）');
process.exit(ok ? 0 : 1);
