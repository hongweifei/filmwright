// 最小示例片的配置：演示「一个片子只要这些」。
export default {
  slug: 'minimal',
  size: {width: 1280, height: 720},
  fps: 30,

  title: {
    big: 'filmwright',
    rest: '最小示例',
    en: 'Draw every frame from its number',
    tagline: '一帧一个函数，平行渲染',
  },

  // 章节副标（第 2 章起显示）
  chapterTech: ['', 'why it is fast', 'what you get'],

  // 顶部 HUD：按句 id 区间给标签
  hud: [
    {fromS: 'S01', toS: 'S03', label: '最小示例', tech: 'minimal'},
    {fromS: 'S04', toS: 'S06', label: '为什么快', tech: 'deterministic'},
    {fromS: 'S07', toS: 'S08', label: '拿到什么', tech: 'what you get'},
  ],

  credit: {
    kicker: 'EXAMPLE',
    title: 'filmwright',
    byline: 'examples/minimal',
    note: '跑 filmwright all --project examples/minimal 复现',
  },
  builtBy: '',

  tts: {
    engine: 'edge',
    voice: 'zh-CN-YunxiNeural',
    rate: '+0%',
  },

  // 素材：写在 public/ 下，页面按根路径取（/assets/... → public/assets/...）。
  // boot 时**全部加载完**才开画 —— 没加载完就画，canvas 什么都不画，那是空白帧不是报错。
  // 镜头里用 picture(ctx, 'filmstrip', x, y, w, h) 摆它。
  assets: ['assets/filmstrip.png'],

  theme: {
    accents: ['#3FA7FF', '#35D07F', '#F5B942'],
  },
};
