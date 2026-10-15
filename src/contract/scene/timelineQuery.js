// 时间轴查询：`at` 写句 id / 块号时的解析（纯查询，不校验）。


// ---------- 时间轴数据的纯查询（与 contract/timeline.js 的 S/BLK/cutBefore 语义一致，有测试钉住） ----------

export function sentenceById(tl, id) {
  return (tl?.sentences ?? []).find((x) => x.id === id) ?? null;
}


export function blocksOf(tl, id) {
  const s = sentenceById(tl, id);
  if (!s) return null;
  return (tl?.subs ?? []).filter((b) => b.from >= s.from && b.to <= s.to);
}


/** 解析对齐 token → 起始帧号。失败抛错并带 code。 */
export function resolveAt(at, tl) {
  const fail = (code, msg) => {
    const e = new Error('filmwright: scene 对齐解析失败：' + msg);
    e.code = code;
    throw e;
  };
  if (typeof at === 'number') {
    if (!Number.isInteger(at) || at < 1) fail('SCENE_AT_FRAME', `数字对齐必须是 ≥1 的整数，收到 ${at}`);
    return at;
  }
  const spec = typeof at === 'string' ? {s: at} : at;
  if (!spec || typeof spec !== 'object' || typeof spec.s !== 'string') {
    fail('SCENE_AT_SHAPE', 'at 必须是帧号、句 id（"S05"）、或 {s, block?, lead?, offset?}，收到 ' + JSON.stringify(at));
  }
  const s = sentenceById(tl, spec.s);
  if (!s) fail('SCENE_NO_SENTENCE', `句 id ${spec.s} 不在时间轴里（先跑 filmwright tts，或核对 script/timeline.md）`);
  let anchor = s.from;
  if (spec.block !== undefined) {
    const blocks = blocksOf(tl, spec.s);
    const b = blocks[spec.block - 1];
    if (!b) fail('SCENE_NO_BLOCK', `句 ${spec.s} 没有第 ${spec.block} 个字幕块（共 ${blocks.length} 块）`);
    anchor = b.from;
  }
  const lead = spec.lead ?? 8;
  if (!Number.isInteger(lead) || lead < 0) fail('SCENE_AT_LEAD', `lead 必须是 ≥0 的整数，收到 ${spec.lead}`);
  const offset = spec.offset ?? 0;
  if (!Number.isInteger(offset)) fail('SCENE_AT_OFFSET', `offset 必须是整数，收到 ${spec.offset}`);
  return Math.max(1, anchor - lead + offset);
}
