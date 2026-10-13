// scenecast：纯场景规格示例 —— 项目里没有 shots/，全部画面来自 scene.json。
// 这是「AI 自动化」路线的验收件：AI 只写内容与节拍，节奏由模板镜头负责。
export default {
  slug: 'scenecast',
  size: {width: 1280, height: 720},
  fps: 30,

  title: {
    big: 'filmwright',
    rest: 'AI 自动化视频制作',
    en: 'scene.json → frames',
    tagline: '内容交给模型，确定性交给引擎',
  },

  chapterTech: ['', 'what AI writes', 'one command'],

  hud: [
    {fromS: 'S01', toS: 'S02', label: '逐帧的底座', tech: 'deterministic'},
    {fromS: 'S03', toS: 'S05', label: '规格即镜头', tech: 'scene.json'},
    {fromS: 'S06', toS: 'S07', label: '拿到什么', tech: 'one command'},
  ],

  credit: {
    kicker: 'EXAMPLE',
    title: 'scenecast',
    byline: 'examples/scenecast',
    note: '没有 shots/，画面全部来自 scene.json',
  },
  builtBy: '',

  tts: {engine: 'edge', voice: 'zh-CN-YunxiNeural', rate: '+0%'},

  assets: ['assets/filmstrip.png'],

  theme: {
    accents: ['#3FA7FF', '#35D07F', '#F5B942'],
  },
};
