// resolveShards 的单元测试：auto 的三重上限，以及显式超内存时的提醒。
//
// 为什么单独测：实测发现「分片反而更慢」（16 核但只剩 5GB 的机器上，
// 单片 96s、2 片 181s、4 片 133s）。根因是 auto 只看核数、不看内存 ——
// 每个分片是一个独立浏览器实例。这个判据必须可测，不能只靠真机观察。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveShards, PER_SHARD_MB, SYSTEM_MB} from '../src/host/cli/commands.mjs';

const MB = 1048576;
const opts = (cores, freeMb) => ({cores, freeBytes: freeMb * MB});

test('默认不分片；auto 才自动定', () => {
  assert.equal(resolveShards(undefined, 1000, opts(8, 8000)), 1);
  assert.equal(resolveShards(null, 1000, opts(8, 8000)), 1);
  assert.equal(resolveShards('', 1000, opts(8, 8000)), 1);
});

test('auto 受 CPU 核数约束（留一核给主进程）', () => {
  // 4 核、内存充足、帧数够多 → 3 片
  assert.equal(resolveShards('auto', 5000, opts(4, 16000)), 3);
  assert.equal(resolveShards('auto', 5000, opts(2, 16000)), 1, '2 核只能 1 片');
});

test('auto 受可用内存约束 —— 这是修掉的那个缺陷', () => {
  // 16 核但只剩 5GB：旧实现会给 15 片（必然换页）；现在应按内存收敛
  const n = resolveShards('auto', 20000, opts(16, 5000));
  const byMem = Math.floor((5000 - SYSTEM_MB) / PER_SHARD_MB);
  assert.equal(n, byMem, `应按内存给 ${byMem} 片，实际 ${n}`);
  assert.ok(n < 15, `绝不能给到 15 片（实际 ${n}）`);
  // 内存极小时退回 1 片（而不是 0 或负数）
  assert.equal(resolveShards('auto', 5000, opts(16, 1200)), 1, '内存不足 1 片时至少 1');
  assert.equal(resolveShards('auto', 5000, opts(16, 0)), 1, '可用内存 0 也至少 1 片');
});

test('auto 受帧数约束（每片至少约 60 帧，否则启动开销盖过收益）', () => {
  assert.equal(resolveShards('auto', 100, opts(16, 16000)), 2, '100 帧只值 2 片');
  assert.equal(resolveShards('auto', 30, opts(16, 16000)), 1, '30 帧不值得分片');
  assert.equal(resolveShards('auto', 1, opts(16, 16000)), 1);
});

test('auto 取三者最小值', () => {
  // 核多、内存多、但帧少 → 帧数赢
  assert.equal(resolveShards('auto', 120, opts(16, 32000)), 2);
  // 帧多、核多、但内存小 → 内存赢
  assert.equal(resolveShards('auto', 20000, opts(16, 3000)), Math.max(1, Math.floor((3000 - SYSTEM_MB) / PER_SHARD_MB)));
  // 帧多、内存多、但核少 → 核数赢
  assert.equal(resolveShards('auto', 20000, opts(3, 32000)), 2);
});

test('显式指定的片数照办（用户可能知道自己在做什么）', () => {
  assert.equal(resolveShards('8', 20000, opts(4, 4000)), 8, '显式 8 片就用 8，即使核数/内存不够');
  assert.equal(resolveShards(3, 20000, opts(16, 16000)), 3);
  assert.equal(resolveShards('1', 20000, opts(16, 16000)), 1);
});

test('负面对照：非法 --shards 要报错并给出路', () => {
  for (const bad of ['0', '-2', 'abc', '1.5x', 'NaN']) {
    assert.throws(() => resolveShards(bad, 1000, opts(8, 8000)),
      /--shards 要是正整数或 auto/, `应报错：${bad}`);
  }
  try {
    resolveShards('0', 1000, opts(8, 8000));
    assert.fail('应抛错');
  } catch (e) {
    assert.equal(e.code, 'BAD_SHARDS');
    assert.ok(e.hint && e.hint.includes('auto'), 'hint 要说明 auto 的含义');
  }
});

test('显式超出内存支撑时要在 stderr 提醒（静默变慢比报错更难查）', () => {
  // 捕获 stderr：写一个临时 hook
  const orig = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = (chunk, ...a) => { captured += String(chunk); return orig(chunk, ...a); };
  try {
    resolveShards('12', 20000, opts(16, 3000));   // 12 片但内存只够 ~3 片
  } finally {
    process.stderr.write = orig;
  }
  assert.ok(captured.includes('超出可用内存'), '要提醒超出内存，实际：' + captured.slice(0, 120));
  assert.ok(captured.includes('12'), '提醒里要指出请求的片数');
  assert.ok(captured.includes('auto'), '提醒要给出路（用 --shards auto）');

  // 而在内存够时不该啰嗦
  captured = '';
  process.stderr.write = (chunk, ...a) => { captured += String(chunk); return orig(chunk, ...a); };
  try {
    resolveShards('4', 20000, opts(16, 16000));
  } finally {
    process.stderr.write = orig;
  }
  assert.equal(captured, '', '内存够时不该提醒，实际：' + captured);
});

test('每片的内存预留量是显式常量（改它要有意识地改）', () => {
  assert.ok(PER_SHARD_MB >= 300 && PER_SHARD_MB <= 1200, `每片预留 ${PER_SHARD_MB}MB 应在合理区间`);
  assert.ok(SYSTEM_MB >= 500, '给系统留的量不能太小');
});
