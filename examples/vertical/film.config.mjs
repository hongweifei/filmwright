// 竖屏示例（1080×1920）的配置。
//
// ## 为什么要这个示例
//
// 引擎的设计基准是 1280×720（横向）。竖屏输出时 `applyDesignScale` 会取
// min(W/1280, H/720) = 0.84 并把内容**居中**放在高画布的中间一条 ——
// 上面下面各留一大片空白。这不是 bug，是「设计基准是横向」的直接后果。
//
// 所以这个示例示范**竖屏该怎么做**：镜头自己用 view.W / view.H 写坐标
// （不走 applyDesignScale），于是版面由镜头完全控制。
// 内建的 HUD / 字幕 / 进度条读 view 按比例摆，竖屏下会自动跟着走。
export default {
  slug: 'vertical',
  size: {width: 1080, height: 1920},
  fps: 30,

  tts: {engine: 'auto', voice: 'zh-CN-YunxiNeural', rate: '+0%'},

  // 竖屏字幕：屏幕窄，字号相对画布宽度算（见 subtitle 的默认换算），
  // 双语时两行要留够高度，否则小字会贴到底边。
  subtitle: {primary: 'first', size: 44, size2: 28, gap: 10, lift: 40},

  theme: {
    accents: ['#5B9BFF', '#35D07F', '#F5B942'],
  },

  assets: [],
};
