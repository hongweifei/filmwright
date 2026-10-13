// 项目装配：读取用户项目，产出渲染所需的全部数据。
//
// 一个 filmwright 项目的形状：
//   film.config.mjs   导出一个配置对象（default）
//   script/narration.txt   解说词（可选，给 tts 用）
//   script/timeline.json   tts 生成的时间轴（渲染必需）
//   scene.json             场景规格（可选）：声明式镜头，AI/模板路线的入口
//   shots/index.js         导出 SHOTS 数组（每项 {start, draw}；与 scene 可混用）
//   public/fonts/...       字体
//   public/assets/<slug>/audio.wav   配音（可选，给 mux 用）
import {existsSync, readFileSync} from 'node:fs';
import {resolve, join, relative} from 'node:path';
import {pathToFileURL} from 'node:url';

export {KIT_ROOT} from '../root.mjs';

/**
 * 项目里的路径约定。
 *
 * 目录只有两类，别混：
 *   - **产物**一律在 `.work/` 下（可随时删，重跑就有）
 *   - **交付物**是 `renders/`（成片，要留）
 * 早期版本把产物分在 `out/` 与 `qc/` 两个目录里，职责重叠。
 */
export function projectPaths(projectDir) {
  const dir = resolve(projectDir);
  if (!existsSync(dir)) throw new Error('filmwright: 项目目录不存在：' + dir);
  const work = join(dir, '.work');
  return {
    dir,
    config: join(dir, 'film.config.mjs'),
    narration: join(dir, 'script', 'narration.txt'),
    timeline: join(dir, 'script', 'timeline.json'),
    scene: join(dir, 'scene.json'),
    shots: join(dir, 'shots', 'index.js'),
    audio: (slug) => join(dir, 'public', 'assets', slug, 'audio.wav'),
    // 交付物
    rendersDir: join(dir, 'renders'),
    // 中间产物
    workDir: work,
    qcDir: join(work, 'qc'),
  };
}

export async function loadProject(projectDir) {
  const p = projectPaths(projectDir);

  if (!existsSync(p.config)) {
    throw new Error(`filmwright: 找不到 ${p.config}\n  项目里要有一个 film.config.mjs，default 导出一个配置对象。`);
  }
  const mod = await import(pathToFileURL(p.config).href);
  const raw = mod.default;
  if (!raw) throw new Error('filmwright: film.config.mjs 没有 default 导出');

  let timeline = null;
  if (existsSync(p.timeline)) {
    timeline = JSON.parse(readFileSync(p.timeline, 'utf8'));
  }
  // 场景规格：声明式镜头（AI 的落点）。没有就是纯镜头表项目。
  let scene = null;
  if (existsSync(p.scene)) {
    scene = JSON.parse(readFileSync(p.scene, 'utf8'));
  }

  return {paths: p, raw, timeline, scene};
}

/** 镜头目录相对项目根的路径；没有 shots/index.js（纯 scene 项目）给 null。 */
export function shotsRelOrNull(proj) {
  if (!existsSync(proj.paths.shots)) return null;
  return relative(proj.paths.dir, proj.paths.shots).replace(/\\/g, '/');
}

/** 需要时间轴的命令（render/check）用它，缺了就给出下一步该跑什么。 */
export function requireTimeline(proj) {
  if (!proj.timeline) {
    throw new Error(
      'filmwright: 还没有 ' + proj.paths.timeline + '\n' +
      '  先跑：filmwright tts --project <项目目录>'
    );
  }
  return proj.timeline;
}
