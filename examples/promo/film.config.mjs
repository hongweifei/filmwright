// promo：filmwright 自己的介绍片。
//
// 这条片子是**狗粮**：全程由 scene.json 驱动，制作用的就是 filmwright 自己的
// 工具链（tts → schema → review → check → all）。它同时是模板语料的来源 ——
// 做真片子时冒出来的「模板不够用」清单，比凭空想需求可靠。
export default {
  slug: 'promo',
  size: {width: 1280, height: 720},
  fps: 30,

  title: {
    big: 'filmwright',
    rest: '把内容变成帧',
    en: 'content in, frames out',
    tagline: 'AI 写内容，引擎保证确定性',
  },
  chapterTech: ['', 'why it works', 'what you get', 'how to start'],
  hud: [
    {fromS: 'S01', toS: 'S03', label: '问题', tech: 'the problem'},
    {fromS: 'S04', toS: 'S06', label: '为什么成立', tech: 'determinism'},
    {fromS: 'S07', toS: 'S09', label: '拿到什么', tech: 'toolchain'},
    {fromS: 'S10', toS: 'S10', label: '怎么开始', tech: 'get started'},
  ],
  credit: {
    kicker: 'PROMO',
    title: 'filmwright',
    byline: '一条由 filmwright 自己做的介绍片',
    note: 'scene.json 驱动 · 零镜头代码',
  },
  builtBy: '',

  tts: {engine: 'auto', voice: 'zh-CN-YunxiNeural', rate: '+0%'},
  assets: ['assets/filmstrip.png'],
  theme: {accents: ['#3FA7FF', '#35D07F', '#F5B942']},
};
