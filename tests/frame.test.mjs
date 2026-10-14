// 页面侧 H.264 编码器的**纯函数部分**的单元测试。
//
// 最该测的是 `annexBFromChunk`：它是手写的**字节解析**（AVCC 长度前缀 → Annex-B 起始码，
// 外加从 AVCDecoderConfigurationRecord 里拆 SPS/PPS）。这类代码最容易在边界上错，
// 而错了的症状是"ffprobe 读不了"——看起来像编码坏了，其实是封装格式不对。
// 所以用手工构造的字节夹具把它钉死，而不是靠"跑一遍没报错"。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {annexBFromChunk, h264Available, createH264Encoder} from '../src/runtime/frame/h264.js';

const START = [0, 0, 0, 1];
/** 造一个 AVCC 格式的 chunk：每个 NAL 前是 4 字节大端长度。 */
function avcc(...nals) {
  const parts = [];
  for (const nal of nals) {
    const n = Uint8Array.from(nal);
    parts.push(Uint8Array.from([(n.length >>> 24) & 255, (n.length >>> 16) & 255,
      (n.length >>> 8) & 255, n.length & 255]), n);
  }
  const total = parts.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
/** 造一个 AVCDecoderConfigurationRecord：含给定的 SPS/PPS。 */
function description(sps, pps) {
  const head = Uint8Array.from([1, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0, 0]);
  const h = [...head];
  h[6] = (sps.length >> 8) & 255; h[7] = sps.length & 255;
  // ⚠️ PPS 段是「**数量**(1 字节) + 长度(2 字节) + 数据」—— 漏掉数量那字节就会解析失败。
  // 第一版夹具就漏了（写成 pps.length 当数量），于是测试失败；而真机数据下
  // tools/verify-h264.mjs 是通过的 —— 说明**是夹具错了，不是解析器错了**。
  return Uint8Array.from([...h, ...sps, 1,
    (pps.length >> 8) & 255, pps.length & 255, ...pps]);
}
const bytes = (u8) => [...u8];

test('annexBFromChunk：AVCC 长度前缀 → Annex-B 起始码（单个 NAL）', () => {
  const out = annexBFromChunk(avcc([0x65, 0xaa, 0xbb]), null);
  assert.deepEqual(bytes(out), [...START, 0x65, 0xaa, 0xbb]);
});

test('annexBFromChunk：一个 chunk 里有多个 NAL 时逐个加起始码', () => {
  const out = annexBFromChunk(avcc([0x41, 0x01], [0x41, 0x02], [0x41, 0x03]), null);
  assert.deepEqual(bytes(out), [
    ...START, 0x41, 0x01,
    ...START, 0x41, 0x02,
    ...START, 0x41, 0x03,
  ]);
});

test('annexBFromChunk：给了 description 就先写 SPS/PPS（顺序：SPS 再 PPS）', () => {
  const sps = [0x67, 0x64, 0x00, 0x1f];
  const pps = [0x68, 0xee, 0x3c];
  const out = annexBFromChunk(avcc([0x65, 0x11]), description(sps, pps));
  assert.deepEqual(bytes(out), [
    ...START, ...sps,       // 第一帧必须先有 SPS，否则解码器不知道分辨率
    ...START, ...pps,
    ...START, 0x65, 0x11,
  ]);
});

test('annexBFromChunk：长度前缀越界/为 0 时**停止**而不是读越界', () => {
  // 声称有 100 字节但只给了 3 字节 —— 必须停下来，不能越界读
  const bad = Uint8Array.from([0, 0, 0, 100, 0x65, 0x66, 0x67]);
  assert.deepEqual(bytes(annexBFromChunk(bad, null)), []);
  // 长度为 0 同样跳过（否则会写一个空的 NAL）
  assert.deepEqual(bytes(annexBFromChunk(Uint8Array.from([0, 0, 0, 0]), null)), []);
  // 尾巴不足 4 字节（读不出长度）也不能崩
  assert.deepEqual(bytes(annexBFromChunk(Uint8Array.from([0, 0, 0]), null)), []);
  assert.deepEqual(bytes(annexBFromChunk(new Uint8Array(0), null)), []);
});

test('annexBFromChunk：description 形状不完整时不崩，也不写半截', () => {
  // 太短（< 6 字节）⇒ 直接跳过 SPS/PPS，只处理帧数据
  const out = annexBFromChunk(avcc([0x65, 0x01]), Uint8Array.from([1, 2, 3]));
  assert.deepEqual(bytes(out), [...START, 0x65, 0x01]);
  // 声明了 2 个 SPS 但数据不够 ⇒ 停在中途，不能越界
  const d = description([0x67, 0x01], [0x68, 0x02]);
  d[5] = 0xe3;   // numSps 改成 3
  const out2 = annexBFromChunk(avcc([0x65, 0x01]), d);
  assert.ok(out2.length > 0, '仍应产出帧数据');
});

test('annexBFromChunk 是纯函数：同样的输入两次结果相同', () => {
  const c = avcc([0x65, 1, 2, 3]);
  const d = description([0x67, 9], [0x68, 8]);
  assert.deepEqual(bytes(annexBFromChunk(c, d)), bytes(annexBFromChunk(c, d)));
});

// ─────────────────────── 环境契约 ───────────────────────

test('Node 里没有 WebCodecs ⇒ h264Available() 为 false（如实报告，不假装能用）', () => {
  assert.equal(h264Available(), false);
});

test('Node 里建编码器要报一条**可行动**的错（含回退办法）', async () => {
  await assert.rejects(() => createH264Encoder({width: 640, height: 360}), (e) => {
    assert.equal(e.code, 'NO_WEBCODECS');
    assert.ok(/jpeg/i.test(e.hint), 'hint 要给出回退办法：' + e.hint);
    return true;
  });
});
