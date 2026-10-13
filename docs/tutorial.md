# 教程：从解说词到成片

做一个 filmwright 片子只要四样东西：**配置、解说词、镜头、素材**。本教程从空目录开始做出一条完整成片，全部命令都已在 `examples/minimal` 上验证过。

## 1. 项目骨架

```
my-film/
  film.config.mjs        配置（default 导出）
  script/narration.txt   解说词
  shots/index.js         镜头，导出 SHOTS
  public/fonts/…         字体
  public/assets/…        素材（图片；tts 的配音也落在这下面）

  .work/                 中间产物，可随时删（重跑就有）
  renders/               成片，要留
```

最小起步只需要 `film.config.mjs`、`script/narration.txt`、`shots/index.js` 三个文件。

## 2. 写配置

```js
// film.config.mjs
export default {
  slug: 'my-film',
  size: {width: 1280, height: 720},
  fps: 30,
  title: {big: '我的片子', rest: '第一集', en: 'Episode 1', tagline: '…'},
  hud: [{fromS: 'S01', toS: 'S03', label: '开场', tech: 'intro'}],
  chapterTech: ['', '第二章副标'],
  credit: {kicker: 'EXAMPLE', title: 'my-film', byline: '…', note: '…'},
  tts: {engine: 'edge', voice: 'zh-CN-YunxiNeural', rate: '+0%'},
  theme: {accents: ['#3FA7FF', '#35D07F', '#F5B942']},
};
```

全字段说明见[配置参考](config.md)。写错（比如 `hud` 缺 `label`）会在跑命令时**当场报错并指出字段**。

## 3. 写解说词

```text
# CHAPTER 1 开场
## gap 20
这是一条用 filmwright 做的片子。
每一帧都由一个函数画出来，|只依赖帧号，不依赖上一帧。

# CHAPTER 2 为什么快
## gap 20
渲染的每一帧都是纯函数。
```

语法只有四条：

| 写法 | 作用 |
|---|---|
| `# CHAPTER n 标题` | 章节标记，章前自动留空白帧 |
| 空行 | 段落分隔 = 换镜头的信号；段末句后多留空白 |
| `## gap N` | 下一句前多插 N 帧空白 |
| 一句`|`之内竖线 | 只切字幕块，不影响朗读——动画节拍跟着字幕块走 |

然后生成配音与时间轴：

```bash
node bin/filmwright.mjs tts --project my-film
```

产出 `public/assets/my-film/audio.wav` 与 `script/timeline.json`（机器读）+ `script/timeline.md`（人读的表，核对节奏用它）。逐句缓存在 `audio/cache/`——**改一句词，只重合成那一句**，帧号自动跟着变，镜头不用改帧号。

## 4. 写镜头

> **先选路线**：本教程演示手写镜头（完全自由的逃生舱）。如果内容适合套模板——要点列表、大数字、流程、代码块、图片、对比——更推荐直接写声明式的 `scene.json`，AI/批量生成走这条路，节奏由模板保证：见[场景规格](scene.md)。两条路线可以在一个项目里混用。

镜头是 `{start, draw}` 对象，import 的全部来自 `'filmwright'`：

```js
// shots/index.js
import {
  text, panel, rule, theme as C, fonts as F,
  S, BLK, cutBefore, inv, easeOut3, hexA,
  applyDesignScale,
} from 'filmwright';

// 统一包装：设计坐标 + this 保留（draw 里要读 this.from，箭头函数会丢 this）
const withDesign = function (fn) {
  return function (ctx, n, t, accent) {
    ctx.save();
    applyDesignScale(ctx);
    try { fn.call(this, ctx, n, t, accent); } finally { ctx.restore(); }
  };
};

// 片头：从第 1 帧开始
const TITLE = {
  start: 1,
  draw(ctx, n) {
    const a = easeOut3(inv(n, 8, 40));            // 第 8–40 帧淡入
    ctx.save();
    ctx.globalAlpha = a;
    text(ctx, '我的片子', 640, 296, {
      size: 104, family: F.wide, weight: 700, color: C.text,
      align: 'center', baseline: 'middle',
      glow: hexA(C.accents[0], 1), glowBlur: 40,
    });
    ctx.restore();
  },
};

// 第二个镜头：掐在 S01 开口前的静音里
const PURE = {
  start: cutBefore('S01'),
  draw(ctx, n) {
    const a = easeOut3(inv(n, BLK('S01', 1) - 4, BLK('S01', 1) + 16));
    if (a > 0.01) {
      panel(ctx, 240, 220, 800, 150, {r: 16, fill: hexA(C.accents[0], 0.10), stroke: C.accents[0]});
      text(ctx, '每一帧 = 一个纯函数', 640, 295, {size: 36, align: 'center', baseline: 'middle'});
    }
  },
};

export const SHOTS = [TITLE, PURE].map((s) => ({...s, draw: withDesign(s.draw)}));
```

要点（全部是硬规则，细节见 [API 参考](api.md)）：

- **只声明 `start`，不要写 `to`**——区间由引擎串接，漏覆盖某几帧会直接报错；
- **动画起点用 `S()` / `BLK()` 查询，不要写硬编码帧号**——改词后帧号自动跟着变；
- **坐标按设计基准 1280×720 写**，用 `applyDesignScale(ctx)` 换算，输出 1080p 也等比放大；
- 内容停住时给一点持续动作（呼吸、光标闪烁），幅度要给够——否则画质自检会报「静止过久」，观众也会觉得卡。

## 5. 自检与预览

```bash
node bin/filmwright.mjs check --project my-film --static-only   # 秒级：引用关系
node bin/filmwright.mjs preview --project my-film               # 起预览页
```

`--static-only` 先抓引用错（句 id、素材名、模块路径）；然后开预览页拖时间轴看节奏。改 `shots/` 或配置后保存即热重载。

全量自检（含逐帧与画质，要真画）：

```bash
node bin/filmwright.mjs check --project my-film
```

## 6. 出片

```bash
node bin/filmwright.mjs all --project my-film --shards 3
# -> my-film/renders/my-film.mp4
```

`all` = 自检 → 分片渲染 → 合流。只想看无声画面用 `render`；想重配合音用 `tts` + `mux`。

## 7. 加素材图片

配置里声明，文件放 `public/` 下：

```js
assets: ['assets/filmstrip.png'],
```

镜头里摆它（名字写错当场报错并列出可用名字）：

```js
import {picture, easeOut3, inv, hexA} from 'filmwright';

picture(ctx, 'filmstrip', 320, 492, 640, 96, {
  fit: 'contain', alpha: easeOut3(inv(n, 410, 430)), r: 8,
  glow: hexA(C.accents[2], 0.45), glowBlur: 18,
});
```

视频没有内建支持——先用 ffmpeg 抽成图片序列再按图片用，原因见[架构](architecture.md)。

## 8. 日常迭代节奏

1. 改一句解说词 → `tts`（秒级，逐句缓存）→ 预览页自动重载；
2. 改镜头动效 → 保存即热重载；
3. 节奏满意 → `check --static-only` → `all` 出片；
4. 大改结构前，先 `node tools/regression.mjs capture`，改完 `verify`，确保没有顺带改掉一帧像素（见[质检](qc.md)）。
