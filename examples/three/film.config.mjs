// three：声明式 3D 的最小可跑演示（一个镜头，全靠 scene.json）。
//
// 为什么**单独一个示例**而不是塞进 gallery/promo：
// 带 3D 的帧实测比不带贵 +18～26 ms/帧（1.28～1.36×），而那些示例同时是 CI 的渲染夹具。
// 单开一个，主示例保持快、轻，3D 有一个真能跑的最小演示。
export default {
  slug: 'three',
  size: {width: 1280, height: 720},
  fps: 30,

  title: {big: 'three', rest: '声明式 3D 图层', en: 'declarative 3D, zero shot code', tagline: '形状 · 相机 · 光照 · 关键帧'},
  chapterTech: ['', '3D 图层'],
  hud: [{fromS: 'S01', toS: 'S01', label: '3D 图层', tech: 'three'}],
  credit: {kicker: 'THREE', title: 'declarative 3D', byline: 'examples/three', note: '需要可选的 three'},
  builtBy: '',

  tts: {engine: 'auto', voice: 'zh-CN-YunxiNeural', rate: '+0%'},
  assets: [],
  theme: {accents: ['#5B9BFF', '#35D07F', '#F5B942']},
};
