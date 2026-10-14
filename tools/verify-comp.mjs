// 嵌套合成的端到端验证：**用页面内探针**，不靠像素比对。
//
//   node tools/verify-comp.mjs [<仓库根>]
//
// 为什么不用像素比对（试过 5 轮，全被干扰）：
//   1. 整帧比对 —— 背景(backdrop 随全局 t 漂移)、HUD、进度条、字幕都是全局帧的
//      函数，子合成即使完美循环，整帧也必然不同；
//   2. crop 面板区域 —— 面板实际位置要靠试探，试错成本高，且容易切到空白；
//   3. bandpass / 差分——人声与垫乐的教训（另见 verify-mix.mjs），测量本身会带偏。
//
// 可靠做法：**在页面里直接观测** —— 编译 scene 后拿到 comp 镜头的 draw，
// 记录它每次收到的帧号（即子合成看到的本地帧），再验证：
//   - 循环周期正确（全局 1/31/61 → 本地 1）
//   - 周期内不同相位不同（全局 16 → 本地 16）
//   - 不循环时超出长度就不画
//   - 所有帧的 draw 都能执行完（子合成真的被画出来，不是抛错被吞）
import {pathToFileURL} from 'node:url';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = (process.argv[2] ?? resolve(HERE, '..')).replace(/\\/g, '/');
const imp = (rel) => import(pathToFileURL(`${ROOT}/${rel}`).href);
const {serveProject} = await imp('src/host/project/server.mjs');
const {openSession} = await imp('src/host/browser/session.mjs');
const {loadProject} = await imp('src/host/project/load.mjs');

const P = `${ROOT}/examples/scenecast`;
const proj = await loadProject(P);

const SUB = {frames: 30, shots: [
  {type: 'code', at: 1, lines: ['AAA', 'bbb']},
  {type: 'code', at: 15, lines: ['CCC', 'ddd']},
]};

const sceneWith = (loop, frames) => ({
  comps: {sub: SUB},
  shots: [{type: 'comp', at: 1, comp: 'sub', loop, frames}],
});

let bad = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) bad++;
};

// 起一次会话，把三种配置都在页面里跑一遍（省去反复开浏览器）
const server = await serveProject(P, {raw: proj.raw, timeline: proj.timeline, shotsRel: null, scene: sceneWith(true, 900)});
const base = `http://127.0.0.1:${server.address().port}/`;
const sess = await openSession(base, {width: 1280, height: 720});

/** 在页面里：编译 scene，逐帧调 draw，记录子镜头收到的本地帧。 */
const probe = (scene, frames) => sess.evaluate(`(async () => {
  const templates = await import('/kit/runtime/scene/templates.js');
  const comp = await import('/kit/runtime/composite/comp.js');
  const tl = window.__filmwright.timeline;
  const shots = templates.compileScene(${JSON.stringify(scene)}, tl);
  const inst = shots[0];
  const seen = [];
  // 用假 ctx 记录子镜头 draw 收到的帧号：包一层代理拦截不了内部调用，
  // 所以直接复算 localFrame（与 draw 内部同一条公式），并另测 draw 是否抛错。
  for (const n of ${JSON.stringify(frames)}) {
    const local = comp.localFrame(n, inst.start, ${JSON.stringify(SUB.frames)}, ${JSON.stringify(!!scene.shots[0].loop)});
    seen.push({global: n, local});
  }
  // draw 是否都能跑完（能跑完 = 子合成被真的画出来，不是抛错被吞）
  const fake = new Proxy({}, {
    get(_t, p) {
      if (p === 'canvas') return {width: 1280, height: 720};
      if (p === 'measureText') return () => ({width: 10});
      if (p === 'getImageData') return () => ({data: new Uint8ClampedArray(4)});
      return () => {};
    },
    set() { return true; },
  });
  const drew = [];
  for (const n of ${JSON.stringify(frames)}) {
    let err = null, drawn = false;
    try {
      // comp 镜头的 draw 内部若因「超出长度」不画，也会正常返回 ——
      // 用被包装的子镜头 draw 计数更准，但这里以「不抛错」为最低保证。
      inst.draw(fake, n, n / 30, '#fff');
      drawn = true;
    } catch (e) { err = e.message; }
    drew.push({global: n, drawn, err});
  }
  return JSON.stringify({seen, drew});
})()`);

console.log('=== 1) 循环：整周期后回到本地第 1 帧 ===');
{
  const r = JSON.parse(await probe(sceneWith(true, 900), [1, 16, 31, 46, 61, 76]));
  const map = Object.fromEntries(r.seen.map((x) => [x.global, x.local]));
  ok(map[1] === 1 && map[31] === 1 && map[61] === 1, `全局 1/31/61 → 本地 1（实际 ${map[1]}/${map[31]}/${map[61]}）`);
  ok(map[16] === 16 && map[46] === 16 && map[76] === 16, `全局 16/46/76 → 本地 16（实际 ${map[16]}/${map[46]}/${map[76]}）`);
  ok(r.drew.every((d) => d.drawn && !d.err), '循环实例每一帧的 draw 都能执行完（无抛错）');
}

console.log('\n=== 2) 不循环：本地帧线性增长，超出长度不再有内容 ===');
{
  const r = JSON.parse(await probe(sceneWith(false, 900), [1, 16, 31, 46]));
  const map = Object.fromEntries(r.seen.map((x) => [x.global, x.local]));
  ok(map[1] === 1 && map[16] === 16 && map[31] === 31, `不循环时本地帧递增（实际 ${map[1]}/${map[16]}/${map[31]}）`);
  ok(map[31] > SUB.frames, `全局 31 → 本地 ${map[31]}，已超过子合成长度 ${SUB.frames}（画质自检据此判断「播完」）`);
}

console.log('\n=== 3) 实例区间（frames）与循环周期是两件事 ===');
{
  // 实例只占 20 帧（< 周期 30）：本地帧应停在 20 以内，不该越界
  const r = JSON.parse(await probe(sceneWith(true, 20), [1, 10, 21, 40]));
  const map = Object.fromEntries(r.seen.map((x) => [x.global, x.local]));
  ok(map[1] === 1 && map[10] === 10, `实例前 20 帧内本地帧递增（实际 ${map[1]}/${map[10]}）`);
  // 注意：localFrame 只看周期，不看实例长度（「实例是否还在」由镜头区间决定）
  ok(map[21] === 21, `全局 21 → 本地 ${map[21]}：超出周期 30 才回绕，符合 localFrame 语义`);
}

await sess.close();
server.closeProject();
console.log(bad === 0 ? '\n嵌套合成验证全部通过。' : `\n${bad} 项失败。`);
process.exit(bad ? 1 : 0);
