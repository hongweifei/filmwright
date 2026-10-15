// 增量重渲：把渲染切成段，按**内容哈希**复用已经渲好的段。
//
// ## 要解决的问题
//
// 复杂镜头每帧可能几百毫秒到几秒，5 分钟片子单机要几小时。而实际迭代时
// 改的通常只有**一两个镜头** —— 其余段落的画面一个像素都不会变。
//
// ## 为什么这里可以安全复用（而不是「看着一样就复用」）
//
// 这个引擎的绘制是纯函数（第 N 帧只依赖 N），所以「一段帧的画面」完全由
// **影响绘制的一切输入**决定。把那些输入哈希起来当段的键：
//   - 项目里所有参与绘制的文件内容（配置、scene、shots、字体清单、素材清单）
//   - 输出分辨率 / fps / 段的帧区间 / crf
//   - 引擎自身源码的指纹（升了引擎版本就该重渲）
// 键相同 ⇒ 输入逐字节相同 ⇒ 在同一个确定性引擎下渲染结果逐字节相同。
// 这不是启发式判断，是可验证的推断 —— `tools/verify-incremental.mjs` 会把复用的段
// 与重渲的段做逐帧像素比对来证明它。
//
// ## 与 --resume 的区别
//
// `--resume` 只看「分片文件在不在」，用于**同一次渲染**被中断后续跑；
// 这里是**跨次**复用，键里带全部输入指纹，改了任何东西都会自动失效。
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {join, relative} from 'node:path';

/** 引擎自身源码的指纹（升引擎就该重渲，否则复用的是旧引擎的画面）。 */
export function engineFingerprint(runtimeRoot) {
  const h = createHash('sha1');
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(js|mjs)$/.test(e.name)) continue;
      h.update(relative(runtimeRoot, p).replace(/\\/g, '/'));
      h.update(readFileSync(p));
    }
  };
  // 只hash运行时（浏览器里跑的绘制代码）——宿主侧的改动不影响画面
  walk(join(runtimeRoot, 'runtime'));
  walk(join(runtimeRoot, 'contract'));
  return h.digest('hex').slice(0, 12);
}

/** 项目输入指纹：所有会影响画面的文件内容。 */
export function projectFingerprint(proj, projectDir) {
  const h = createHash('sha1');
  const addFile = (label, p) => {
    h.update(label);
    if (existsSync(p)) h.update(readFileSync(p));
    else h.update('(missing)');
  };
  addFile('config', proj.paths.config);
  addFile('scene', proj.paths.scene);
  addFile('timeline', proj.paths.timeline);
  addFile('shots', proj.paths.shots);

  // 字体与素材**文件本身**的指纹（换了字体文件但名字没变，画面会变）
  const pub = join(projectDir, 'public');
  const addTree = (label, dir) => {
    if (!existsSync(dir)) return;
    const walk = (d) => {
      for (const e of readdirSync(d, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
        const p = join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        // 只认会影响画面的（图片/字体）；忽略音频与缓存
        if (!/\.(ttf|otf|woff2?|png|jpe?g|svg|webp)$/i.test(e.name)) continue;
        h.update(`${label}:${relative(pub, p).replace(/\\/g, '/')}`);
        h.update(readFileSync(p));
      }
    };
    walk(dir);
  };
  addTree('fonts', join(pub, 'fonts'));
  addTree('assets', join(pub, 'assets'));

  // 片段素材：用抽好的帧数 + 源指纹（帧内容由 clips 的内容寻址缓存保证）
  for (const c of proj.raw?.clips ?? []) h.update(`clip:${JSON.stringify(c)}`);
  return h.digest('hex').slice(0, 12);
}

/**
 * **全局**指纹：与「哪一段」无关、影响整片的所有输入。
 *
 * 单独拆出来是按段归因的前提 —— 只有真正全局的东西放这里，
 * 镜头内容留给 segmentKey 的局部部分（见下面 shotFingerprint / segmentKeyFor）。
 */
export function globalFingerprint(proj, projectDir) {
  const h = createHash('sha1');
  const addFile = (label, p) => {
    h.update(label);
    h.update(existsSync(p) ? readFileSync(p) : '(missing)');
  };
  addFile('config', proj.paths.config);        // 主题、尺寸、fps 影响每一帧
  addFile('timeline', proj.paths.timeline);    // 句 id 与帧号影响每一帧的字幕/HUD
  // 字体与素材文件：任何一个都可能出现在任意段里，所以算全局
  const pub = join(projectDir, 'public');
  const addTree = (label, dir) => {
    if (!existsSync(dir)) return;
    const walk = (d) => {
      for (const e of readdirSync(d, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
        const p = join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!/\.(ttf|otf|woff2?|png|jpe?g|svg|webp)$/i.test(e.name)) continue;
        h.update(`${label}:${relative(pub, p).replace(/\\/g, '/')}`);
        h.update(readFileSync(p));
      }
    };
    walk(dir);
  };
  addTree('fonts', join(pub, 'fonts'));
  addTree('assets', join(pub, 'assets'));
  for (const c of proj.raw?.clips ?? []) h.update(`clip:${JSON.stringify(c)}`);
  return h.digest('hex').slice(0, 12);
}

/**
 * **单个场景镜头**的指纹（局部）。
 *
 * 只有「与某段重叠的镜头」才该影响那一段 —— 这是增量重渲真正省时间的地方：
 * 改一个镜头只让覆盖它的段失效，其余段照旧复用。
 * 把整份 scene.json 算进每个段的话，改一个镜头会让**所有**段失效，
 * 那就等于每次都全渲（我第一版就是这样，等于白做）。
 */
export function sceneShotFingerprint(shot, index) {
  return createHash('sha1')
    .update(`shot[${index}]:`)
    .update(JSON.stringify(shot))
    .digest('hex').slice(0, 12);
}

/** 子合成（comps）的指纹：只有引用它的段才受影响。 */
export function compFingerprint(name, def) {
  return createHash('sha1')
    .update(`comp:${name}:`)
    .update(JSON.stringify(def))
    .digest('hex').slice(0, 12);
}

/**
 * 收录「一个段覆盖哪些镜头」时要传递的依赖。
 *
 * 规则简单但必须准：
 *   - 段与某个 scene 镜头区间重叠 → 收那个镜头的指纹
 *   - 那个镜头是 `comp` 类型 → 还要收它引用的 comp（以及 comp 内部再引用的 comp）
 *   - 那个镜头是 `clip` 类型 → 该片段已由 clips 配置进全局指纹（源文件变了会全失效，
 *     这是有意的保守：片段可能被多处引用，逐段追引用链收益低、出错代价高）
 *   - 项目是手写镜头（shots/index.js）→ scene 不存在，只能整文件当全局（保守）
 */
export function collectShotDeps(scene, range) {
  const deps = [];
  if (!scene?.shots?.length) return deps;
  const comps = scene.comps ?? {};
  const seenComp = new Set();
  const addComp = (name) => {
    if (seenComp.has(name) || !comps[name]) return;
    seenComp.add(name);
    deps.push(compFingerprint(name, comps[name]));
    // comp 内部还可能引用别的 comp
    for (const sh of comps[name].shots ?? []) {
      if (sh?.type === 'comp' && sh.comp) addComp(sh.comp);
    }
  };
  const starts = scene.shots.map((s) => (typeof s.at === 'number' ? s.at : null));
  scene.shots.forEach((shot, i) => {
    const st = starts[i];
    if (st === null) return;                 // 句 id 形式：调用方会用解析后的区间重算
    // 该镜头的区间是 [st, next-1]；段 [from, to] 与它重叠的判据必须用 `>=`：
    // 段起点正好等于 next（即下一镜头的起点）时**不该**算重叠 ——
    // 用 `>` 会把上一个镜头也算进来（实测把 100 起的段错配到 1–99 的镜头）。
    const next = starts[i + 1] ?? Infinity;
    if (range.from >= next) return;          // 段完全在这个镜头之后
    if (range.to < st) return;               // 段完全在这个镜头之前
    deps.push(sceneShotFingerprint(shot, i));
    if (shot.type === 'comp' && shot.comp) addComp(shot.comp);
  });
  return deps;
}

/**
 * 段键：全局指纹 + **该段覆盖的镜头** + 段参数。
 *
 * @param {object} o
 * @param {string} o.engine 引擎指纹
 * @param {string} o.global 全局指纹（配置/时间轴/字体/素材/clips）
 * @param {string} [o.shotsHash] 段覆盖的镜头依赖合并哈希（缺省=所有段共享，退化为全局）
 * @param {number} o.from @param {number} o.to
 * @param {number} o.width @param {number} o.height @param {number} o.fps @param {string} o.crf
 */
export function segmentKey(o) {
  return createHash('sha1')
    .update([o.engine, o.global, o.shotsHash ?? '*', o.from, o.to, o.width, o.height, o.fps, o.crf].join('|'))
    .digest('hex').slice(0, 16);
}

/** 把一组镜头依赖合并成一个哈希（顺序无关：先排序再拼接）。 */
export function mergeDeps(deps) {
  if (!deps.length) return 'none';
  return createHash('sha1').update([...deps].sort().join('|')).digest('hex').slice(0, 16);
}

/**
 * 手写镜头项目（`shots/index.js`）的指纹。
 *
 * 手写镜头的 `start` 是代码里算出来的（可能调 `cutBefore()` 等查询），
 * host 侧无法在不求值该模块的情况下知道「哪个镜头覆盖哪些帧」——
 * 而求值它需要 DOM（绘制原语）。所以这里**整个文件算全局**：
 * 改一行就让所有段失效。保守但正确（宁可多渲，不可复用旧画面）。
 * 返回 null 表示没有手写镜头文件。
 */
export function manualShotsFingerprint(shotsPath) {
  if (!shotsPath || !existsSync(shotsPath)) return null;
  return createHash('sha1').update(readFileSync(shotsPath)).digest('hex').slice(0, 12);
}

/** 把全局指纹与手写镜头指纹合成最终全局键。 */
export function combineGlobal(global, manualShots) {
  if (!manualShots) return global;
  return createHash('sha1').update(global + '|' + manualShots).digest('hex').slice(0, 12);
}

/**
 * 把帧区间切成段。
 * @param {number} total 总帧数
 * @param {number} segFrames 每段多少帧（默认 300 —— 约 10 秒 @30fps）
 * @param {number} from @param {number} to
 */
export function planSegments(total, segFrames, from, to) {
  const seg = Math.max(1, segFrames);
  const out = [];
  for (let a = from; a <= to; a += seg) {
    out.push({index: out.length, from: a, to: Math.min(to, a + seg - 1)});
  }
  return out;
}

/** 段缓存目录。 */
export const segmentDir = (workDir) => join(workDir, 'segments');

/**
 * 查一个段是否已缓存且可用（文件在、非空、键匹配）。
 * 键存在单独的小文件里，便于人读诊断（而不是猜文件名）。
 */
export function findCached(dir, index, key) {
  const part = join(dir, `seg${String(index).padStart(4, '0')}-${key}.mp4`);
  const meta = join(dir, `seg${String(index).padStart(4, '0')}-${key}.json`);
  if (!existsSync(part) || statSync(part).size === 0) return null;
  if (!existsSync(meta)) return null;
  try {
    const m = JSON.parse(readFileSync(meta, 'utf8'));
    if (m.key !== key) return null;
    if (m.bytes !== statSync(part).size) return null;   // 大小对不上 = 文件被改过
    return {part, meta: m};
  } catch {
    return null;
  }
}

/** 登记一个段（写完立刻落盘，中断也不影响已完成的段）。 */
export function recordSegment(dir, index, key, {from, to, frames, bytes}) {
  mkdirSync(dir, {recursive: true});
  writeFileSync(join(dir, `seg${String(index).padStart(4, '0')}-${key}.json`),
    JSON.stringify({key, index, from, to, frames, bytes, at: new Date().toISOString()}, null, 1), 'utf8');
}

/** 清掉不再匹配当前键的旧段（避免缓存无限增长）。 */
export function pruneSegments(dir, liveKeys) {
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const f of readdirSync(dir)) {
    const m = f.match(/^seg\d+-([0-9a-f]+)\.(mp4|json)$/);
    if (!m) continue;
    if (liveKeys.has(m[1])) continue;
    rmSync(join(dir, f), {force: true});
    removed++;
  }
  return removed;
}
