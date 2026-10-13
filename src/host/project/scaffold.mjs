// 项目脚手架：filmwright new <目录>。
//
// 给 agent 的第一块地：新目录 + 能直接跑通的最小项目。
// 两种模板：
//   scene（默认）—— 声明式规格路线，AI 只改 scene.json 与 narration.txt；
//   shots        —— 手写镜头路线（逃生舱的起点）。
import {existsSync, mkdirSync, writeFileSync, readdirSync} from 'node:fs';
import {join, basename} from 'node:path';

const slugOf = (dir) => basename(dir).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '') || 'my-film';

const gitignore = `.work/
renders/
audio/cache/
public/assets/*/audio.wav
`;

const narrationTmpl = (slug) => `# ${slug} 的解说词
# 说明：一行一句；| 只切字幕块，不影响朗读；空行 = 段末（换镜头）

# CHAPTER 1 开场
## gap 20
这里是第一句解说词。|改成你自己的内容。
这里是第二句。|竖线只切字幕块，不影响朗读。

# CHAPTER 2 正文
## gap 20
改完解说词，跑 filmwright tts 重新生成时间轴。|帧号自动跟着变。
`;

const configTmpl = (slug) => `// ${slug} 的配置。全字段与校验规则见 docs/config.md。
export default {
  slug: '${slug}',
  size: {width: 1280, height: 720},
  fps: 30,

  title: {big: '${slug}', rest: '新片子', en: 'made with filmwright', tagline: '一帧一个函数'},
  chapterTech: ['', '正文'],
  hud: [
    {fromS: 'S01', toS: 'S02', label: '开场', tech: 'intro'},
    {fromS: 'S03', toS: 'S03', label: '正文', tech: 'body'},
  ],
  credit: {kicker: 'NEW', title: '${slug}', byline: '', note: ''},
  builtBy: '',

  tts: {engine: 'edge', voice: 'zh-CN-YunxiNeural', rate: '+0%'},

  // 素材（图片）：文件放 public/ 下，这里声明名字；scene 的 image 镜头引用它。
  assets: [],

  theme: {accents: ['#3FA7FF', '#35D07F', '#F5B942']},
};
`;

const sceneTmpl = (slug) => JSON.stringify({
  $schema: 'filmwright/scene-v0',
  shots: [
    {type: 'title', at: 1, title: slug, sub: '用 scene.json 做片子', en: 'AI writes content, engine keeps determinism'},
    {
      type: 'bullets', at: 'S01', heading: '先改这里',
      items: [
        {t: '一句话一个要点', d: 'items 跟着字幕块错峰进场'},
        {t: '节拍用句 id', d: 'at: "S02" 自动对齐时间轴'},
      ],
    },
    {type: 'stat', at: 'S03', value: 3, unit: '步', label: 'tts → check → all'},
  ],
}, null, 2) + '\n';

const shotsTmpl = (slug) => `// ${slug} 的手写镜头。规格路线见 scene.json / docs/scene.md。
// 纪律：只声明 start；区间由引擎串接。draw 必须是普通函数（要读 this.from）。
import {text, theme as C, fonts as F, cutBefore, inv, easeOut3, hexA, applyDesignScale} from 'filmwright';

const TITLE = {
  start: 1,
  draw(ctx, n) {
    ctx.save();
    applyDesignScale(ctx);
    const a = easeOut3(inv(n, 8, 40));
    ctx.globalAlpha = a;
    text(ctx, '${slug}', 640, 320, {
      size: 96, family: F.wide, weight: 700, color: C.text,
      align: 'center', baseline: 'middle', glow: hexA(C.accents[0], 0.8), glowBlur: 36,
    });
    ctx.restore();
  },
};

const BODY = {
  start: cutBefore('S01'),
  draw(ctx, n) {
    ctx.save();
    applyDesignScale(ctx);
    const a = easeOut3(inv(n, Math.max(this.from, 40), Math.max(this.from, 40) + 16));
    text(ctx, '改我：镜头就是逐帧的函数', 640, 340, {
      size: 40, weight: 900, color: C.text, align: 'center', baseline: 'middle', alpha: a,
    });
    ctx.restore();
  },
};

export const SHOTS = [TITLE, BODY];
`;

/**
 * 建骨架。目录必须不存在或为空 —— 不覆盖别人的东西。
 * @returns {{dir: string, slug: string, template: string, files: string[]}}
 */
export function scaffoldProject(targetDir, {template = 'scene'} = {}) {
  const dir = targetDir;
  if (!['scene', 'shots'].includes(template)) {
    const e = new Error('filmwright: 不认识的模板 ' + template);
    e.code = 'BAD_TEMPLATE';
    e.hint = '可用：scene / shots';
    throw e;
  }
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    const e = new Error('filmwright: 目标目录已存在且非空：' + dir);
    e.code = 'DIR_NOT_EMPTY';
    e.hint = '换个目录名，或先清空它（脚手架从不覆盖已有文件）';
    throw e;
  }
  const slug = slugOf(dir);
  const files = {
    'film.config.mjs': configTmpl(slug),
    'script/narration.txt': narrationTmpl(slug),
    '.gitignore': gitignore,
    'public/fonts/README.md': '# 字体\n\n把 ttf/otf 放在这里（配置的 `fontFiles` 默认引用\n' +
      '`fonts/NotoSansSC.ttf`、`fonts/Orbitron[wght].ttf`、`fonts/Audiowide-Regular.ttf`、`fonts/Exo2-Italic.ttf`）。\n' +
      '字体没就绪就画，度量全错；加载失败会回退到系统字体（不报错）。\n' +
      '可直接抄 `examples/minimal/public/fonts/`（SIL OFL 1.1）。\n',
    'public/assets/README.md': '# 素材\n\n图片放这里，配置 `assets` 声明名字，scene 的 image 镜头用 `asset` 引用。\n',
  };
  if (template === 'scene') files['scene.json'] = sceneTmpl(slug);
  else files['shots/index.js'] = shotsTmpl(slug);

  for (const [rel, body] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, '..'), {recursive: true});
    writeFileSync(p, body, 'utf8');
  }
  return {dir, slug, template, files: Object.keys(files)};
}
