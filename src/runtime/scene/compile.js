// 把 scene 规格编译成镜头数组。`comp` 类型要两趟（先递归编译 comps，再编译顶层 shots）——
// 时间基换算与循环在 `composite/comp.js` 里，这里只做接线。
import {resolveAt} from '../../contract/scene.js';
import {bindLocalShots, compLength, drawCompInstance, mapBeats} from '../composite/comp.js';
import {theme as C, fonts as F, accentFor} from '../../contract/config.js';
import {applyDesignScale, DESIGN_SAFE} from '../layout/design.js';
import {compileAnimate, mergeAnimate} from './animate.js';
import {withLayer} from '../composite/layer.js';
import {compileEffects, isNoopEffects} from '../fx/compile.js';
import {paintWithEffects} from '../fx/gpu.js';
import {TEMPLATES} from './templates/registry.js';

/**
 * 编译 scene 规格 → 镜头数组。
 *
 * `comp` 类型需要先编译子合成（它们是同一份规格里的 comps 定义），
 * 所以这里做两趟：先递归编译所有 comps，再编译顶层 shots。
 * 时间基换算与循环在 composite/comp.js 里，这里是「接线」。
 */
export function compileScene(scene, tl) {
  const comps = scene.comps ?? {};
  const compiledComps = {};
  // 递归编译：comp 里还能再引用 comp（环已在 contract 层拦住）
  const compile = (name, depth = 0) => {
    if (compiledComps[name]) return compiledComps[name];
    if (depth > 16) throw new Error('filmwright: 子合成嵌套过深（>16 层）：' + name);
    const def = comps[name];
    if (!def) throw new Error('filmwright: 引用了不存在的子合成 ' + name);
    const localShots = def.shots.map((raw) => {
      if (raw.type === 'comp') {
        // 嵌套实例：把子 comp 编译好，包成「一个本地镜头」
        const inner = compile(raw.comp, depth + 1);
        const start = raw.at ?? 1;
        const ntr = raw.transform;               // 嵌套实例的 transform 同样要应用（原来也漏了）
        return {
          start,
          from: start,
          to: raw.frames ? start + raw.frames - 1 : inner.len + start - 1,
          ...(ntr !== undefined ? {transform: ntr} : {}),
          draw(ctx, n, t, accent) {
            const paint = (c) => drawCompInstance(c, {
              localShots: inner.shots, len: raw.frames ?? inner.len,
              from: start, loop: !!raw.loop,
            }, n, t, accent);
            if (ntr) {
              withLayer(ctx, {transform: ntr, alpha: ntr.alpha ?? 1, blend: ntr.blend ?? null, mode: 'shot'}, paint);
            } else {
              paint(ctx);
            }
          },
        };
      }
      const tpl = TEMPLATES[raw.type];
      if (!tpl) throw new Error('filmwright: 子合成 ' + name + ' 用了没有模板的类型 ' + raw.type);
      const start = raw.at;
      const shot = {...raw, start, sid: null, beats: tpl.beats ? tpl.beats(raw, start, null) : [start]};
      // ⚠️ **子镜头的 `transform` 原来被静默忽略**：上面那行 `...{transform: raw.transform}` 把它存了下来，
      // 但 `draw` 里从来没应用过 ⇒ 「声明了但没生效」那一族 bug（同 `empty` 编译期崩溃、`SHAPE_KEYS` 漏登记）。
      // 这里补上，语义与**顶层镜头**完全一致（`mode: 'shot'`：变换在单位矩阵上下文里生效，
      // 内容自己随后 `applyDesignScale`）。
      const tr = raw.transform;
      return {
        start, from: start, to: start, beats: shot.beats,
        ...(tr !== undefined ? {transform: tr} : {}),
        draw(ctx, n, t, accent) {
          const paint = (c) => {
            c.save();
            applyDesignScale(c);
            try {
              tpl.draw.call(this, c, n, shot, accent ?? accentFor(1));
            } finally {
              c.restore();
            }
          };
          if (tr) {
            withLayer(ctx, {transform: tr, alpha: tr.alpha ?? 1, blend: tr.blend ?? null, mode: 'shot'}, paint);
          } else {
            paint(ctx);
          }
        },
      };
    });
    const bound = bindLocalShots(localShots, def.frames);
    const len = compLength(def, bound);
    compiledComps[name] = {shots: bound, len, name};
    return compiledComps[name];
  };
  for (const name of Object.keys(comps)) compile(name);

  return scene.shots.map((raw) => {
    // comp 实例：把一条子合成放到时间轴上。
    //
    // **两个长度不能混**（这是实现时真踩过的坑）：
    //   cycleLen = 子合成自身长度（inner.len）—— 循环的周期
    //   spanLen  = 这个实例在时间轴上占多少帧（raw.frames ?? inner.len）
    // 曾经把 spanLen 当 cycleLen 传给 drawCompInstance，于是「frames: 720 的实例」
    // 里本地帧一路涨到 720，而子合成只有一个 30 帧的镜头 → 第 31 帧起什么都画不出来
    // （表现为「循环实例只在前 30 帧有画面」）。
    if (raw.type === 'comp') {
      const inner = compiledComps[raw.comp];
      if (!inner) throw new Error('filmwright: 引用了不存在的子合成 ' + raw.comp);
      const start = resolveAt(raw.at, tl);
      const loop = !!raw.loop;
      const cycleLen = inner.len;                       // 循环周期
      const spanLen = raw.frames ?? inner.len;          // 实例占用的帧数
      const to = start + spanLen - 1;
      return {
        start,
        beats: mapBeats(inner.shots[0]?.beats ?? [1], start, cycleLen, loop, to),
        ...(raw.transition !== undefined ? {transition: raw.transition} : {}),
        ...(raw.transform !== undefined ? {transform: raw.transform} : {}),
        scene: {...raw, start},
        draw(ctx, n, t, accent) {
          ctx.save();
          applyDesignScale(ctx);
          try {
            drawCompInstance(ctx,
              {localShots: inner.shots, len: cycleLen, from: start, loop},
              n, t, accent ?? accentFor(1));
          } finally {
            ctx.restore();
          }
        },
      };
    }
    // ---- 容器：并发多层（每层有自己的 z 序、时间窗、变换与关键帧）----
    if (raw.type === 'layers') {
      const shotStart = resolveAt(raw.at, tl);
      const built = (raw.layers ?? []).map((layer, i) => {
        // 空物体：不画内容、只提供变换。**必须先判它再碰 content** —— 校验层要求
        // `empty: true` 的层**不给** content（给了报互斥），所以无条件读 `c.type`
        // 会让这个能力的唯一合法写法在编译期抛 TypeError、整个镜头起不来
        // （实测踩过：`empty` 只写在绘制循环里、编译这一段漏了）。
        const empty = layer.empty === true;
        const c = layer.content;
        const tpl2 = empty ? null : TEMPLATES[c.type];
        if (!empty && !tpl2) throw new Error('filmwright: 层内容用了没有模板的类型 ' + c.type);
        // 层内容的绝对起点 = 镜头起点 + (层的 from - 1)
        const ls = shotStart + ((layer.from ?? 1) - 1);
        // 层内容也是一次模板调用，但**不带 at**（校验已拦）；beats 支持它自己的节奏
        const contentRaw = empty ? null : {...c, at: ls};
        const contentShot = empty ? {beats: []} : {...contentRaw, start: ls, sid: null,
          beats: tpl2.beats ? tpl2.beats(contentRaw, ls, null) : [ls]};
        return {
          z: layer.z ?? i,                       // 不写 z 则按声明顺序（后面的在上）
          seq: i,                                 // 同 z 时按声明顺序稳定
          idx: i,                                 // **声明下标**：`follow` 指的就是它
          follow: layer.follow,                   // 跟着同容器里的哪一层（下标）
          empty,
          ls,
          fromOff: (layer.from ?? 1) - 1,         // 层窗口（相对镜头起点的偏移）
          toOff: layer.to !== undefined ? layer.to - 1 : null,
          contentShot,
          tpl: tpl2,
          transform: layer.transform,
          // 空物体没有自己的内容 ⇒ 没有自己的节拍表，所以它的 animate / effects
          // 要等**本容器的**节拍表算出来再编译（见下面那一趟循环）。
          rawAnimate: layer.animate,
          rawEffects: layer.effects,
          anim: empty ? null : compileAnimate(layer.animate, {beats: contentShot.beats, from: ls}),
          fx: empty ? null : compileEffects(layer.effects, {beats: contentShot.beats, from: ls}),
        };
      });
      // `follow` 用**声明下标**找父层 —— `built` 下面会按 z 排序，所以这里先留一份下标表
      const byIdx = new Map(built.map((b) => [b.idx, b]));
      // 由远到近：z 小的先画（在下），同 z 按声明顺序
      built.sort((a, b) => (a.z - b.z) || (a.seq - b.seq));
      const beats = [...new Set(built.flatMap((b) => b.contentShot.beats))].sort((a, b) => a - b);
      // 空物体的 animate / effects 借**本容器的节拍表**（其余层拍号的并集）编译：
      // 「跟着节拍转/呼吸」正是空物体最常见的用法，而它自己没有内容就没有自己的拍。
      // 容器里全是空物体时表为空 ⇒ 只有 `frame` 键的关键帧可用（拍号无从谈起）。
      for (const b of built) {
        if (!b.empty) continue;
        b.anim = compileAnimate(b.rawAnimate, {beats, from: b.ls});
        b.fx = compileEffects(b.rawEffects, {beats, from: b.ls});
      }
      return {
        start: shotStart,
        beats,
        ...(raw.transition !== undefined ? {transition: raw.transition} : {}),
        ...(raw.transform !== undefined ? {transform: raw.transform} : {}),
        ...(raw.animate !== undefined ? {animate: raw.animate} : {}),
        scene: raw,
        draw(ctx, n, t, accent) {
          ctx.save();
          applyDesignScale(ctx);
          try {
            for (const L of built) {
              // 时间窗：层只在自己的窗口内出现（窗口外的帧不画它，也不报错）
              const off = n - shotStart;
              if (off < L.fromOff) continue;
              if (L.toOff !== null && off > L.toOff) continue;
              // 空物体：**不画任何内容**，它的作用只是给别的层提供变换
              if (L.empty) continue;
              const tr = mergeAnimate(L.transform, L.anim, n);
              const hasLayer = !!tr && (tr.x || tr.y || tr.rotate
                || (tr.scale !== undefined && tr.scale !== 1)
                || tr.alpha !== undefined || tr.blend !== undefined || tr.origin !== undefined);
              const leaf = (c2) => {
                if (!hasLayer) {
                  L.tpl.draw.call(this, c2, n, L.contentShot, accent ?? accentFor(1));
                } else {
                  withLayer(c2, {transform: tr, alpha: tr?.alpha ?? 1, blend: tr?.blend ?? null, mode: 'shot'},
                    (c3) => L.tpl.draw.call(this, c3, n, L.contentShot, accent ?? accentFor(1)));
                }
              };
              // 父子绑定：把**父链**的变换逐层套在外面（最外层先应用），再画自己。
              // 组合出来的仍然只是帧号的纯函数（父与自己的变换都只是 n 的函数）。
              // `seen` 防环：校验已经拦了，这里是**第二道**（运行时不能因为一个漏网配置就死循环）。
              const paint = (cc) => {
                const chain = [];
                const seen = new Set([L.idx]);
                let cur = L;
                while (cur.follow !== undefined) {
                  const p = byIdx.get(cur.follow);
                  if (!p || seen.has(p.idx)) break;
                  seen.add(p.idx);
                  chain.unshift(p);              // 最外层排在最前
                  cur = p;
                }
                let fn = leaf;
                for (let i = chain.length - 1; i >= 0; i--) {
                  const p = chain[i];
                  const ptr = mergeAnimate(p.transform, p.anim, n);
                  const inner = fn;
                  fn = (c2) => withLayer(c2, {transform: ptr, alpha: 1, blend: null, mode: 'shot'}, inner);
                }
                fn(cc);
              };
              // 层自己的效果链：与镜头级走**同一个助手**（否则两处合成逻辑会漂移）
              if (L.fx && !isNoopEffects(L.fx, n)) {
                if (paintWithEffects(ctx, L.fx, tr?.alpha ?? 1, n, paint)) continue;
              }
              paint(ctx);
            }
          } finally {
            ctx.restore();
          }
        },
      };
    }
    const tpl = TEMPLATES[raw.type];
    if (!tpl) throw new Error('filmwright: scene 用了没有模板的类型 ' + raw.type);
    const start = resolveAt(raw.at, tl);
    const sid = typeof raw.at === 'string' ? raw.at
      : (raw.at && typeof raw.at === 'object' ? raw.at.s ?? null : null);
    const shot = {...raw, start, sid, beats: tpl.beats ? tpl.beats(raw, start, sid) : [start]};
    return {
      start,
      beats: shot.beats,
      // 场景规格里的 transition 透传给镜头层（crossfade/fade + frames）。
      // 它**不破坏纯函数不变量**：两个 draw 都只依赖 n，混合系数也是 n 的函数。
      ...(raw.transition !== undefined ? {transition: raw.transition} : {}),
      // 图层变换（位移/缩放/旋转/透明度/混合模式）同样透传。
      ...(raw.transform !== undefined ? {transform: raw.transform} : {}),
      // 关键帧动画也透传（否则 scene.json 里写了 animate 到不了镜头 —— 这一步漏过）
      ...(raw.animate !== undefined ? {animate: raw.animate} : {}),
      // 效果链同理：不透传的话 scene.json 写了 effects 也不会生效
      ...(raw.effects !== undefined ? {effects: raw.effects} : {}),
      // 遮罩同理 —— **这里必须逐个透传**：镜头对象是显式构造的，
      // 少写一行就等于 scene.json 里那个字段被静默丢掉（遮罩第一版就漏了这一行：
      // 校验通过、渲染无变化，排查才发现是"编译时丢了"）。
      ...(raw.mask !== undefined ? {mask: raw.mask} : {}),
      scene: shot,
      draw(ctx, n, t, accent) {
        ctx.save();
        applyDesignScale(ctx);
        try {
          tpl.draw.call(this, ctx, n, shot, accent ?? accentFor(1));
        } finally {
          ctx.restore();
        }
      },
    };
  });
}
