// 画面质量自检：抓「不崩但不好看」的问题。
//
// 与 frames 检查互补：frames 只证明「每帧都画得出来」，这个证明「画出来的能看」。
// 三类问题，都是一部真实片子 QC 时定下来的判据：
//   - 静止过久：内容区连续多帧没有可见变化（观众会觉得卡住）
//   - 末拍停留不足：离场前没有稳定期（末拍元素来不及落位就切走了）
//   - 空白帧：内容区几乎没有与主色调不同的像素（等于没画东西）
//
// **聚合与判定是纯函数**（不碰浏览器），所以能被单元测试覆盖；
// 只有采样那一步要真开浏览器（在 runtime/qc/analysis.js 里做）。

/** 默认阈值。可用 check 的 --quality-* 覆盖。 */
export const THRESHOLDS = {
  /** 连续静止超过这么多帧就报警（30fps 下 90 帧 = 3 秒）。 */
  staticFrames: 90,
  /** 末拍稳定期下限（帧）。 */
  holdFrames: 30,
  /** 内容区「有东西」的最低比例；低于它算空白帧。 */
  inkMin: 0.004,
  /** 采样步长（帧）。与真实片子的 QC 口径一致。 */
  sampleStep: 3,
  /** 单帧灰度差小于它就算「这一拍没动」。 */
  staticThr: 0.5,
  /**
   * 「静止」的第二个判据：**逐格最大差**的上限。
   *
   * 平均值会把缓慢的局部移动洗掉：实测那部片子里元素在 3 秒内缓慢位移，
   * 内容区平均灰度变化只有 0.04–0.12（低于 staticThr），
   * 可像素上 PSNR 只有 22.7 dB —— 画面明显不同。
   * 变化集中在少数格子上，被 32×18 格一平均就没了。
   */
  staticMaxCell: 3.0,
  /**
   * 采样时算 maxW / diffW 的窗口（帧）。90 帧 ≈ 3 秒 —— 与 staticFrames 同量级，
   * 因为这两个量就是用来判断「3 秒里动了没有」的。
   */
  staticWindowFrames: 90,
  /**
   * 入场豁免帧数：镜头刚开始的这段时间不判「空白」与「静止」。
   * 元素入场本来就是从空到有，开场一两帧几乎是空的属于正常；
   * 不豁免会把每个镜头的入场误报成「空白帧」。
   */
  entranceGrace: 20,
  /** 离场豁免帧数：同上，切镜头那一瞬间的画面不属于这个镜头。 */
  exitGrace: 6,
  /**
   * 「显著变化」阈值：用来找「一拍真正落位」。
   * 必须明显高于 staticThr —— 呼吸类持续动效读 0.2–0.5，
   * 元素入场读 1–18；两者混在一个阈值里会让判据自相矛盾。
   */
  beatThr: 2.0,
};

/**
 * 把逐帧采样按镜头区间聚合成统计量。
 * @param {Array<{n:number, diff:number|null, ink:number}>} samples
 * @param {Array<{from:number, to:number, id?:string}>} shots
 */
export function aggregateShots(samples, shots, th = THRESHOLDS) {
  const out = [];
  for (const s of shots) {
    const inShot = samples.filter((x) => x.n >= s.from && x.n <= s.to);
    if (inShot.length === 0) continue;

    // 入场豁免：镜头刚接管的这段不参与「静止」与「空白」判定。
    // 元素入场本来就是从空到有，开场一两帧几乎是空的属于正常。
    //
    // 末尾也要豁免一点点：镜头区间是**含端点**的，而下一个镜头的第一帧可能已经
    // 把上一镜头的元素清掉了（实测 SH02 的 f560 是 SH03 的开场，ink 0.00%）。
    // 那是切镜头的瞬间，不是这个镜头"画空了"。
    const body = inShot.filter(
      (x) => x.n >= s.from + th.entranceGrace && x.n <= s.to - th.exitGrace
    );
    const judged = body.length > 0 ? body : inShot;

    // 最长连续静止。
    //
    // 判据：在**一段候选静止区间**里，累计变化始终没到可见程度。
    //
    // 为什么是累计而不是逐点：实测一部真实片子里元素在缓慢漂移，
    // 每 30 帧的窗口差只有 0.04–0.12（每个窗口单独看都"静止"），
    // 可 180 帧前后 PSNR 只有 22.7 dB —— 画面明显变了。
    // 逐窗口看永远看不出来，必须把变化累加起来看。
    //
    // 做法：每个采样点把「与上一个采样点的差」累加进 acc。
    //   - acc 超过可见阈值 → 这一段不静止，从当前点重新起算
    //   - 否则这一段继续延长，记下最长长度
    // 用逐格最大差做同样的事（抓被平均洗掉的局部移动）。
    let longest = 0;
    let longestAt = null;
    let runStart = null;
    let accMean = 0;
    let accCell = 0;
    for (const x of judged) {
      if (x.diff === null || x.diff === undefined) continue;
      if (runStart === null) {
        runStart = x.n;
        accMean = 0;
        accCell = 0;
        continue;
      }
      accMean += x.diff;
      // 逐格最大差没有逐点的值，用窗口峰值近似
      accCell = Math.max(accCell, x.maxW ?? 0);
      const len = x.n - runStart;
      const moved = accMean >= th.staticThr * th.sampleStep * 2 || accCell >= th.staticMaxCell;
      if (moved) {
        // 这一段到头了：它的长度算进去，然后从当前点重新起算
        if (len > longest) { longest = len; longestAt = runStart; }
        runStart = x.n;
        accMean = 0;
        accCell = 0;
      } else if (len > longest) {
        longest = len;
        longestAt = runStart;
      }
    }

    // 末拍稳定期。
    //
    // **有声明节拍（beats）时按声明算** —— 这是 scene 模板自动带来的，也是手写镜头
    // 可选声明的。声明是事实，不是猜测：最后一拍之后留多久一目了然，所以这条
    // 从「只报告」升级成硬判据（judgeQuality 里判失败）。
    //
    // **没有声明时退回像素推断**，而像素 diff 分不清一次变化是「入场」还是「离场」，
    // 三个概念必须分开，混在一起判据就会自相矛盾：
    //   1. 静止（staticThr 低 0.5）—— 画面有没有在动；呼吸动效读 0.2–0.5
    //   2. 落位（beatThr 高 2.0）—— 有没有一拍元素真正到位；入场读 1–18
    //   3. 离场 —— 末尾那几拍是**走**，不是**落位**
    // 拿不准的不硬给结论：这条路径下 hold 只作读数进摘要，不判失败。
    let hold = null;          // null = 不判
    let holdNote = '';
    let holdSource = 'none';
    let beatsBeyond = 0;      // 最后一拍超出镜头末帧多少（>0 判失败）
    if (Array.isArray(s.beats) && s.beats.length) {
      holdSource = 'declared';
      const last = Math.max(...s.beats);
      if (last > s.to) {
        beatsBeyond = last - s.to;
        holdNote = `最后一拍 f${last} 排在镜头末 f${s.to} 之后`;
      } else {
        hold = s.to - last;
      }
    } else {
      const beats = judged.filter((x) => x.diff !== null && x.diff >= th.beatThr);
      if (beats.length === 0) {
        holdNote = '无显著落位';
      } else {
        holdSource = 'inferred';
        // 末尾连续几拍（相邻间隔 ≤ 2 个采样步长）算离场
        let runLen = 1;
        for (let k = beats.length - 1; k > 0; k--) {
          if (beats[k].n - beats[k - 1].n <= th.sampleStep * 2) runLen++;
          else break;
        }
        if (runLen >= 2 && beats[beats.length - 1].n > s.to - th.exitGrace - th.sampleStep * 4) {
          holdNote = `末尾 ${runLen} 拍连续，判为离场`;
        } else {
          hold = s.to - beats[beats.length - 1].n;
        }
      }
    }

    const inks = judged.map((x) => x.ink);
    // 最低墨迹出现在哪一帧（诊断用：能直接知道该看哪一帧）
    let inkAt = null;
    let inkMin = Infinity;
    for (const x of judged) {
      if (x.ink < inkMin) { inkMin = x.ink; inkAt = x.n; }
    }
    out.push({
      id: s.id ?? `f${s.from}-${s.to}`,
      from: s.from,
      to: s.to,
      frames: s.to - s.from + 1,
      sampled: inShot.length,
      judged: judged.length,
      longestStatic: longest,
      staticAt: longestAt,
      hold,
      holdNote,
      holdSource,
      beatsBeyond,
      beats: Array.isArray(s.beats) && s.beats.length ? s.beats : null,
      inkMin,
      inkAt,
      inkMean: inks.reduce((a, b) => a + b, 0) / inks.length,
    });
  }
  return out;
}

/** 按阈值判定，返回问题描述（空数组 = 通过）。 */
export function judgeQuality(stats, th = THRESHOLDS) {
  const problems = [];
  const sec = (n) => (n / 30).toFixed(1);
  for (const s of stats) {
    // ① 静止过久 —— 稳健，作失败判定
    if (s.longestStatic > th.staticFrames) {
      problems.push(
        `镜头 ${s.id}（f${s.from}-${s.to}）连续静止 ${s.longestStatic} 帧 ≈ ${sec(s.longestStatic)}s` +
        `（上限 ${sec(th.staticFrames)}s），从 f${s.staticAt} 起`
      );
    }
    // ② 空白帧 —— 稳健，作失败判定
    if (s.inkMin < th.inkMin) {
      problems.push(
        `镜头 ${s.id}（f${s.from}-${s.to}）内容区最低墨迹 ${(s.inkMin * 100).toFixed(2)}%` +
        `（下限 ${(th.inkMin * 100).toFixed(2)}%）：有一帧几乎是空的`
      );
    }
    // ③ 末拍稳定期 —— **声明了节拍的镜头判失败，没声明的只报告**。
    //
    // 为什么以前只能报告：像素 diff 分不清一次变化是「入场」还是「离场」，
    // 而这条恰恰要求区分。实测三种读法都不对（量末尾静止 → 有呼吸的镜头永远读 0；
    // 把末尾几拍算落位 → 离场被当末拍；连续几拍算离场 → 被片尾压黑切断）。
    // 现在 scene 模板自动声明节拍（staggerFrames 就是节拍表），信号是**事实**
    // 不是猜测，于是可以硬判：最后一拍之后停留不足 holdFrames，观众来不及看完。
    if (s.beatsBeyond > 0) {
      problems.push(
        `镜头 ${s.id}（f${s.from}-${s.to}）的节拍排到镜头结束之后 ${s.beatsBeyond} 帧` +
        `（${s.holdNote}）：内容太多或对齐太晚 —— 删减条目、把 at 提前，或让下一镜头更晚`
      );
    } else if (s.holdSource === 'declared' && s.hold !== null && s.hold < th.holdFrames) {
      problems.push(
        `镜头 ${s.id}（f${s.from}-${s.to}）末拍后只停留 ${s.hold} 帧（<${th.holdFrames}）：` +
        `最后一拍刚落位就切镜，观众来不及看完 —— 把内容对齐到更靠前的字幕块，或让下一镜头的 at 更晚`
      );
    }
    // holdSource === 'inferred' 的走 notes（见 qualityCheck.mjs），不进 problems。
  }
  return problems;
}

/** 一行摘要（每个镜头的读数，供人工核对阈值是否合理）。 */
export function summarize(stats) {
  return stats.map((s) => {
    const hold = s.hold === null
      ? `不判（${s.holdNote || '—'}）`
      : `${s.hold}${s.holdSource === 'declared' ? '（声明）' : '（推断，仅报告）'}`;
    return `  ${String(s.id).padEnd(12)} f${String(s.from).padStart(4)}-${String(s.to).padStart(4)}` +
      `  最长静止 ${String(s.longestStatic).padStart(3)}  末拍 ${hold.padStart(18)}` +
      `  墨迹最低 ${(s.inkMin * 100).toFixed(2)}%`;
  });
}