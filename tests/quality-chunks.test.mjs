// 分片采样的**静态不变量**（纯函数，不开浏览器）。
//
// 背景：整条时间轴的画面采样原先塞进**一次** `Runtime.evaluate`，而那次调用吃 30s 默认预算
// ⇒ 2100 帧的片子（`sampleStep: 3`，约 700 个采样帧）实测 13–55 秒，时不时报「超过 30000ms 没响应」。
// 修法是分片，但分片必须**不改变采样结果**：少一个点或多一个点都会静默改变「静止/在动」的判定。
// 这条测试钉的就是「一个不多、一个不少、无缝、带预热」。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planSampleChunks, expectedSamples} from '../src/host/checks/browser/qualityCheck.mjs';

const TH = {step: 3, windowFrames: 90};        // 与 quality.mjs 的默认阈值一致

test('分片：无缝覆盖 `[1, total]`，且每片不超过上限', () => {
  for (const total of [1, 2, 3, 4, 96, 144, 145, 1299, 1596, 2107, 2319]) {
    const chunks = planSampleChunks(total, {...TH, capSamples: 48});
    assert.ok(chunks.length >= 1, `total=${total} 至少要有一片`);
    assert.equal(chunks[0].from, 1, `total=${total} 必须从第 1 帧开始`);
    assert.equal(chunks.at(-1).to, total, `total=${total} 必须覆盖到最后一帧`);
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      assert.ok(c.from <= c.to, `total=${total} 第 ${i} 片是空的`);
      // 每片的采样点数不超过上限（这是「一次往返别做太多事」的本体）
      const n = Math.floor((c.to - c.from) / TH.step) + 1;
      assert.ok(n <= 48, `total=${total} 第 ${i} 片采了 ${n} 个点（上限 48）`);
      if (i) assert.equal(c.from, chunks[i - 1].to + 1, `total=${total} 第 ${i} 片与前一片之间有洞或重叠`);
    }
  }
});

test('分片：采样栅格连续，且**总点数守恒**（不多不少）', () => {
  for (const total of [1, 96, 145, 1299, 2107, 2319]) {
    const chunks = planSampleChunks(total, {...TH, capSamples: 48});
    // 片起点都 ≡ 1 (mod step) ⇒ 拼起来是一条连续的采样栅格（不会某片从半格开始）
    for (const c of chunks) {
      assert.equal((c.from - 1) % TH.step, 0, `total=${total}：片起点 ${c.from} 不在采样栅格上`);
    }
    const sum = chunks.reduce((a, c) => a + (Math.floor((c.to - c.from) / TH.step) + 1), 0);
    assert.equal(sum, expectedSamples(total, TH.step),
      `total=${total}：分片后总点数 ${sum} ≠ 整片一次采的 ${expectedSamples(total, TH.step)}`);
  }
});

test('分片：每片都带足够预热（少一个采样点就会把「在动」判成「静止」）', () => {
  const chunks = planSampleChunks(2107, {...TH, capSamples: 48});
  assert.ok(chunks.length > 1, '2107 帧必须被切成多片 —— 只切一片的话这条判据形同虚设');
  // ⚠️ 是 `windowFrames + step` 而不是 `windowFrames`：`back` 取的是 `n - step*(winSteps+1)`
  // 那一格。实测踩过 —— 用 `windowFrames` 时每片第一个点的 `diffW`/`maxW` 是 `null`。
  const want = TH.windowFrames + TH.step;
  for (const c of chunks) {
    assert.ok(c.warmFrames >= want,
      `预热 ${c.warmFrames} 帧不够 —— 至少 ${want}（windowFrames + step）`);
  }
  // 小片子不该被切（避免为了分片而无谓多开往返）
  assert.equal(planSampleChunks(96, {...TH, capSamples: 48}).length, 1, '96 帧应当只有一片');
});

test('`expectedSamples`：与按 step 数出来的一致（它是判「一个都不能少」的下限）', () => {
  assert.equal(expectedSamples(1, 3), 1);
  assert.equal(expectedSamples(3, 3), 1);
  assert.equal(expectedSamples(4, 3), 2);
  assert.equal(expectedSamples(2107, 3), 703);
  assert.ok(expectedSamples(2107, 3) > 700, '2100 帧的片子按 step=3 应当有 700+ 个采样点');
});
