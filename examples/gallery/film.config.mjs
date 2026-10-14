// gallery：13 类模板镜头各一镜，全部由 scene.json 驱动（项目里没有 shots/）。
// 它同时是模板的目视验收件：filmwright check 过十道，stills 逐类看图。
export default {
  slug: 'gallery',
  size: {width: 1280, height: 720},
  fps: 30,

  title: {big: 'gallery', rest: '模板镜头一览', en: '13 template shots, zero code', tagline: 'AI 填内容，模板管节奏'},
  chapterTech: ['', 'text & list', 'numbers & code', 'data & media'],
  hud: [
    {fromS: 'S01', toS: 'S04', label: '文字与要点', tech: 'text'},
    {fromS: 'S05', toS: 'S08', label: '数字与代码', tech: 'numbers'},
    {fromS: 'S09', toS: 'S12', label: '数据与画面', tech: 'media'},
  ],
  credit: {kicker: 'GALLERY', title: '13 templates', byline: 'examples/gallery', note: 'scene.json 驱动，零镜头代码'},
  builtBy: '',

  tts: {engine: 'auto', voice: 'zh-CN-YunxiNeural', rate: '+0%'},
  assets: ['assets/filmstrip.png'],
  theme: {accents: ['#3FA7FF', '#35D07F', '#F5B942']},
};
