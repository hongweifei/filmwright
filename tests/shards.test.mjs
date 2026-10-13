// 分片重试与续跑的单元测试（依赖注入，不真开浏览器）。
//
// 为什么要测这个：长片渲到 90% 时某个分片因浏览器抖动失败，此前整条命令就失败，
// 用户得自己发现再重跑。现在分片失败会自动重试一次，且如实记录 —— 这是「长片
// 可靠性」的核心行为，必须有测试钉住，且要能证明「喂它坏的，它真的会重试」。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, existsSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {renderSharded} from '../src/host/cli/commands.mjs';

/** 造一个最小 ctx：只需要 paths.workDir。 */
function makeCtx() {
  const dir = mkdtempSync(join(tmpdir(), 'fw-shard-'));
  return {projectDir: dir, proj: {paths: {workDir: dir}}, opts: {}, args: {}};
}

/** 记录每次调用的假渲染：把 out 写成非空文件，模拟成功。 */
function fakeRender(behavior) {
  const calls = [];
  return {
    calls,
    fn: async (_dir, _proj, {from, to, out}) => {
      const key = `${from}-${to}`;
      calls.push(key);
      const n = calls.filter((c) => c === key).length;   // 这是该分片第几次尝试
      const action = behavior(key, n);
      if (action === 'fail') throw new Error('注入的分片失败（负面对照）');
      writeFileSync(out, 'x'.repeat(64));                 // 非空文件 = 渲染成功
    },
  };
}

const noopConcat = async () => { /* 不跑真 ffmpeg */ };
const silent = () => {};

test('正常路径：每片一次成功，attempts=1、retried=0', async () => {
  const ctx = makeCtx();
  const r = fakeRender(() => 'ok');
  const out = await renderSharded(ctx, {
    from: 1, to: 120, shards: 2, out: join(ctx.proj.paths.workDir, 'o.mp4'),
    crf: '16', say: silent, deps: {render: r.fn, concat: noopConcat},
  });
  assert.equal(r.calls.length, 2, '两个分片各渲一次');
  assert.equal(out.retried, 0);
  assert.equal(out.reused, 0);
  assert.ok(out.parts.every((p) => p.attempts === 1), JSON.stringify(out.parts));
});

test('负面对照：某片首次失败 → 自动重试并成功，retried=1、该片 attempts=2', async () => {
  const ctx = makeCtx();
  // 只有第一个分片（1-60）的**第一次**尝试失败
  const r = fakeRender((key, n) => (key === '1-60' && n === 1 ? 'fail' : 'ok'));
  const out = await renderSharded(ctx, {
    from: 1, to: 120, shards: 2, out: join(ctx.proj.paths.workDir, 'o.mp4'),
    crf: '16', say: silent, deps: {render: r.fn, concat: noopConcat},
  });
  assert.equal(out.retried, 1, '应有 1 个分片被重试');
  const first = out.parts.find((p) => p.from === 1);
  assert.equal(first.attempts, 2, '首个分片应为 2 次尝试');
  assert.equal(first.reused, false);
  assert.equal(r.calls.filter((c) => c === '1-60').length, 2, '该分片应被调用两次');
});

test('负面对照：两次都失败 → 抛错，且 hint 指向 --resume（不掩盖）', async () => {
  const ctx = makeCtx();
  const r = fakeRender((key) => (key === '1-60' ? 'fail' : 'ok'));
  let err = null;
  try {
    await renderSharded(ctx, {
      from: 1, to: 120, shards: 2, out: join(ctx.proj.paths.workDir, 'o.mp4'),
      crf: '16', say: silent, deps: {render: r.fn, concat: noopConcat},
    });
  } catch (e) { err = e; }
  assert.ok(err, '两次都失败必须抛错');
  assert.match(err.message, /已各自重试 1 次/, '错误信息要说明重试过');
  assert.match(err.hint ?? '', /--resume/, 'hint 要指向续跑');
  assert.equal(r.calls.filter((c) => c === '1-60').length, 2, '失败分片恰好试两次，不多试');
});

test('--resume：已有非空分片直接复用，不调用渲染', async () => {
  const ctx = makeCtx();
  // 先正常渲一次，留下分片文件
  const first = fakeRender(() => 'ok');
  await renderSharded(ctx, {
    from: 1, to: 120, shards: 2, out: join(ctx.proj.paths.workDir, 'o.mp4'),
    crf: '16', say: silent, deps: {render: first.fn, concat: noopConcat},
  });
  assert.ok(existsSync(join(ctx.proj.paths.workDir, 'parts', 'part_00.mp4')));

  const second = fakeRender(() => 'ok');
  const out = await renderSharded(ctx, {
    from: 1, to: 120, shards: 2, out: join(ctx.proj.paths.workDir, 'o.mp4'),
    crf: '16', say: silent, resume: true, deps: {render: second.fn, concat: noopConcat},
  });
  assert.equal(out.reused, 2, '两个分片都应复用');
  assert.equal(second.calls.length, 0, '复用时不该再调渲染');
});

test('负面对照：不带 --resume 时必须重渲（不复用旧分片）', async () => {
  const ctx = makeCtx();
  const first = fakeRender(() => 'ok');
  await renderSharded(ctx, {
    from: 1, to: 120, shards: 2, out: join(ctx.proj.paths.workDir, 'o.mp4'),
    crf: '16', say: silent, deps: {render: first.fn, concat: noopConcat},
  });
  const second = fakeRender(() => 'ok');
  const out = await renderSharded(ctx, {
    from: 1, to: 120, shards: 2, out: join(ctx.proj.paths.workDir, 'o.mp4'),
    crf: '16', say: silent, deps: {render: second.fn, concat: noopConcat},
  });
  assert.equal(out.reused, 0, '默认必须清空重渲');
  assert.equal(second.calls.length, 2, '两个分片都要重渲');
});

test('concat 收到 list.txt，且里面是相对路径（跨平台稳定）', async () => {
  const ctx = makeCtx();
  const r = fakeRender(() => 'ok');
  let seen = null;
  await renderSharded(ctx, {
    from: 1, to: 120, shards: 2, out: join(ctx.proj.paths.workDir, 'o.mp4'),
    crf: '16', say: silent,
    deps: {render: r.fn, concat: async ({listFile}) => { seen = readFileSync(listFile, 'utf8'); }},
  });
  assert.ok(seen, 'concat 应收到 listFile');
  assert.match(seen, /file 'part_00\.mp4'/, 'list.txt 用 basename（相对路径）');
  assert.ok(!/[A-Za-z]:[\\/]/.test(seen), 'list.txt 不该出现盘符绝对路径：' + seen);
});
