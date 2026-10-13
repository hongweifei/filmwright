// 静态检查：不启浏览器，读文件就能判定。
//
// 它们抓的都是「跑起来才发现」的错，而这里几秒就能报：
//   api      —— index.js 里重名导出（只在浏览器求值时报 "Duplicate export of 'S'"）
//   imports  —— ES module 相对路径写错（会让页面**静默**不 ready）
//   timeline —— 引用了不存在的句 id / 字幕块号（只在渲到那一帧时才在画面上报错）
//   themeKeys—— 运行时代码引用了 theme 里不存在的配色键（默认值变 undefined，
//               绘制时才崩，而崩的地方离原因很远）
//   assets   —— 镜头引用了没在配置里声明的素材名（boot 时才会抛错，且要等到开浏览器）
import {readFileSync, existsSync, readdirSync, statSync} from 'node:fs';
import {join, dirname, resolve, relative} from 'node:path';
import {DEFAULT_THEME, normalizeConfig} from '../../../contract/config.js';
import {validateScene} from '../../../contract/scene.js';

/** 公开面的重名导出。`export *` 与具名导出混用时撞名，静态读 index.js 就能提前抓到。 */
export function checkPublicApi(apiFile) {
  if (!existsSync(apiFile)) return {name: 'api', ok: true, checked: 0, problems: []};
  const seen = new Map();
  const problems = [];
  let checked = 0;
  readFileSync(apiFile, 'utf8').split('\n').forEach((line, i) => {
    if (!/^\s*export\b/.test(line)) return;
    if (/^\s*export\s*\*/.test(line)) return;   // 星号导出无法静态判重
    const m = line.match(/\{([^}]*)\}/);
    if (!m) return;
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (!name || name === 'default') continue;
      checked++;
      if (seen.has(name)) {
        problems.push(`重复导出 ${name}（第 ${seen.get(name)} 行已经导出过）`);
      } else {
        seen.set(name, i + 1);
      }
    }
  });
  if (checked === 0) {
    problems.push(apiFile + ' 里一个具名导出都没读到 —— 检查脚本可能失效了');
  }
  return {name: 'api', ok: problems.length === 0, checked, problems};
}

/** 模块相对路径是否都存在。裸导入（'filmwright'）交给 import map，这里不判。 */
export function checkImports(dir, label = dir) {
  // 目录可以不存在：纯 scene 项目没有 shots/，这不是错误
  if (!existsSync(dir)) return {name: 'imports', ok: true, checked: 0, problems: []};
  const files = [];
  (function walk(d) {
    for (const e of readdirSync(d)) {
      if (e === 'node_modules' || e.startsWith('.')) continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(js|mjs)$/.test(e)) files.push(p);
    }
  })(dir);

  const bad = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const re = /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(src))) {
      const spec = m[1] || m[2];
      if (!spec || !spec.startsWith('.')) continue;
      if (!existsSync(resolve(dirname(f), spec))) bad.push(`${relative(label, f)} -> ${spec}`);
    }
  }
  return {name: 'imports', ok: bad.length === 0, checked: files.length, problems: bad};
}

/** 镜头文件里引用的句 id 与字幕块号是否真的存在。 */
export function checkTimeline(projectDir, proj) {
  const tl = proj.timeline;
  const byId = new Map(tl.sentences.map((s) => [s.id, s]));
  const blocksOf = (id) => {
    const s = byId.get(id);
    return s ? tl.subs.filter((b) => b.from >= s.from && b.to <= s.to).length : null;
  };

  const shotsDir = dirname(proj.paths.shots);
  const bad = [];
  let checked = 0;
  if (existsSync(shotsDir)) {
    for (const file of readdirSync(shotsDir).filter((f) => f.endsWith('.js'))) {
      const lines = readFileSync(join(shotsDir, file), 'utf8').split('\n');
      lines.forEach((line, i) => {
        const where = `${file}:${i + 1}`;
        for (const m of line.matchAll(/\bBLK\(\s*'(S\d+)'\s*,\s*(\d+)\s*\)/g)) {
          checked++;
          const n = blocksOf(m[1]);
          if (n === null) bad.push(`${where}: 不存在的句 ${m[1]}`);
          else if (Number(m[2]) < 1 || Number(m[2]) > n) {
            bad.push(`${where}: ${m[1]} 只有 ${n} 块，却引用了第 ${m[2]} 块`);
          }
        }
        for (const m of line.matchAll(/\bS\(\s*'(S\d+)'\s*\)/g)) {
          checked++;
          if (!byId.has(m[1])) bad.push(`${where}: 不存在的句 ${m[1]}`);
        }
      });
    }
  }
  return {name: 'timeline', ok: bad.length === 0, checked, problems: bad};
}

/**
 * 运行时代码引用的 `C.<键>`（C 即 theme）必须在 DEFAULT_THEME 里存在。
 *
 * 为什么需要这道：库内部大量把 theme 的键当**默认参数值**用
 * （`{color = C.blue}` 这种）。键名写错或漏定义时不是报错，而是默认值变成
 * `undefined`，一直传到绘制才崩 —— 崩的地方离原因很远。
 *
 * 这不是假想：迁 7465 帧真实片子时，`matrix()` 没传颜色就撞上了
 * `C.green` / `C.red` 不存在，报的是 `hexA` 里
 * 「Cannot read properties of undefined (reading 'replace')」。
 * 46 秒的示例恰好每次都显式传色，所以一直没暴露。
 *
 * 只扫运行时代码（浏览器里跑的），host 侧不画图、不适用。
 */
export function checkThemeKeys(runtimeDir) {
  const dir = join(runtimeDir, 'runtime');
  const bad = [];
  let checked = 0;
  const known = new Set(Object.keys(DEFAULT_THEME));

  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, {withFileTypes: true})) {
      const p = join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(js|mjs)$/.test(e.name)) continue;
      const lines = readFileSync(p, 'utf8').split('\n');
      lines.forEach((line, i) => {
        // 跳过注释行：注释里会举例说明，不该算引用
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        for (const m of line.matchAll(/\bC\.([A-Za-z_$][\w$]*)/g)) {
          checked++;
          if (!known.has(m[1])) {
            bad.push(`${relative(dir, p)}:${i + 1}: theme 里没有 ${m[1]}（C.${m[1]}）`);
          }
        }
      });
    }
  };
  walk(dir);

  return {
    name: 'themeKeys',
    ok: bad.length === 0,
    checked,
    problems: [...new Set(bad)],
  };
}

/**
 * 镜头里引用的素材名必须在配置的 `assets` 里声明过。
 *
 * 为什么需要这道：`img('xxx')` / `picture(ctx, 'xxx', …)` 引用一个没声明的名字时，
 * 运行时会抛错 —— 但那要等 **boot 之后**、真正渲到那一帧才发现。
 * 静态读文件几秒就能报，而且能一次列出所有笔误。
 *
 * 顺带查两件同源的事：
 *   - 声明了但 `public/` 下找不到文件 → 报出来（否则要等 boot 才报 404）
 *   - 声明了却没人用 → 只提示，不算失败（可能是留着以后用的）
 */
export function checkAssets(projectDir, rawConfig, scene = null) {
  const bad = [];
  const hints = [];
  let checked = 0;

  let cfg;
  try {
    cfg = normalizeConfig(rawConfig);
  } catch (e) {
    return {name: 'assets', ok: false, checked: 0, problems: ['配置本身读不了：' + e.message]};
  }
  const declared = new Set(cfg.assets.map((a) => a.name));

  // 1. 声明了的文件在不在
  for (const a of cfg.assets) {
    checked++;
    // src 形如 /assets/a.png → 项目里是 public/assets/a.png
    const rel = a.src.replace(/^\//, '');
    const p = join(projectDir, 'public', rel);
    if (!existsSync(p)) {
      bad.push(`声明了素材「${a.name}」但找不到文件：public/${rel}`);
    }
  }

  // 2. 镜头里用到的名字有没有声明过
  const shotsDir = join(projectDir, 'shots');
  const used = new Set();
  if (existsSync(shotsDir)) {
    for (const file of readdirSync(shotsDir).filter((f) => f.endsWith('.js'))) {
      const lines = readFileSync(join(shotsDir, file), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        // picture(ctx, '名字', …) / img('名字') / imgSize('名字')
        for (const m of line.matchAll(/\b(?:picture|img|imgSize)\s*\(\s*(?:ctx\s*,\s*)?'([^']+)'/g)) {
          checked++;
          used.add(m[1]);
          if (!declared.has(m[1])) {
            bad.push(`${file}:${i + 1}: 引用了没声明的素材「${m[1]}」`);
          }
        }
      });
    }
  }

  // 3. 声明了没人用 → 提示。镜头与 scene 两个来源都要算。
  if (scene && Array.isArray(scene.shots)) {
    for (const s of scene.shots) {
      if (s && s.type === 'image' && typeof s.asset === 'string') used.add(s.asset);
    }
  }
  for (const a of cfg.assets) {
    if (!used.has(a.name)) hints.push(`素材「${a.name}」声明了但镜头里没人用`);
  }

  return {
    name: 'assets',
    ok: bad.length === 0,
    checked,
    problems: bad,
    hints,
  };
}

/**
 * 场景规格（scene.json）的静态校验。
 *
 * 没有这个文件就跳过（纯镜头表项目）。有的话，boot 在浏览器里查的是
 * **同一份实现**（contract/scene.js）——这里只是把失败提前到不启浏览器的几秒里，
 * 而且每条错误带 code/path/hint，AI 读完能直接改。
 */
export function checkScene(projectDir, proj) {
  if (!proj.scene) {
    return {name: 'scene', ok: true, checked: 0, problems: [], notes: ['没有 scene.json（纯镜头表项目）']};
  }
  let assetNames = null;
  try {
    assetNames = normalizeConfig(proj.raw).assets.map((a) => a.name);
  } catch { /* 配置本身读不了，assets 那道会报 */ }
  const r = validateScene(proj.scene, {timeline: proj.timeline ?? {sentences: []}, assetNames});
  return {
    name: 'scene',
    ok: r.ok,
    checked: Array.isArray(proj.scene.shots) ? proj.scene.shots.length : 0,
    // 人看的字符串 + 机器读的结构化错误（--json / MCP 直接用后者，不必再解析文本）
    problems: r.errors.map((e) => `[${e.code}] ${e.path}：${e.message}${e.hint ? '（' + e.hint + '）' : ''}`),
    errors: r.errors,
  };
}
