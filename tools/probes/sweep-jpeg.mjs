// JPEG 质量 → 编码耗时 / 载荷大小的曲线。
//
//   node tools/probes/sweep-jpeg.mjs [<仓库根>] [帧数]
//
// ## 为什么量这个
//
// 逐帧剖析显示**绘制只占 0.19ms**，而 `canvas.toBlob('image/jpeg', q)` 占 **16ms 以上**
// —— 瓶颈全在编码。而中间帧的质量是**可以降的**：
// 终点本来就是 H.264 有损编码（默认 `-crf 16`），中间再保 0.92 没有意义。
//
// JPEG 编码耗时大致与非零系数个数成正比，所以降质量应当**直接**省时间。
// 这个探针量出曲线，再由人决定取哪一档（不自动决定 —— 那是画质取舍，不是纯性能问题）。
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {withSession} from '../../src/host/media/renderRange.mjs';
import {loadProject} from '../../src/host/project/load.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const ROOT = resolve(argv[0] && !argv[0].startsWith('--') ? argv[0] : join(HERE, '..', '..'));
const N = Number(argv.find((a) => /^\d+$/.test(a)) ?? 40);
const PROJECT = join(ROOT, 'examples', 'scenecast');
const QS = [0.95, 0.92, 0.85, 0.75, 0.65, 0.5];

const proj = await loadProject(PROJECT);
console.log(`JPEG 质量 → 编码耗时 / 载荷（${N} 帧，720p）\n`);
await withSession(PROJECT, proj, {}, async (sess) => {
  const r = await sess.evaluate(`(async () => {
    const cv = document.getElementById('c');
    const N = ${N}, QS = ${JSON.stringify(QS)};
    const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    const out = [];
    for (const q of QS) {
      // 预热一次（第一帧有字体/缓存开销）
      window.__renderFrame(1);
      await new Promise((res) => cv.toBlob(res, 'image/jpeg', q));
      const t = [], sizes = [];
      for (let i = 0; i < N; i++) {
        window.__renderFrame(1 + i);
        const a = performance.now();
        const b = await new Promise((res) => cv.toBlob(res, 'image/jpeg', q));
        t.push(performance.now() - a);
        sizes.push(b.size);
      }
      out.push({q, ms: med(t), kb: med(sizes) / 1024});
    }
    return out;
  })()`);
  const base = r.find((x) => x.q === 0.92);
  console.log('  质量    中位耗时     载荷       相对 q=0.92');
  for (const x of r) {
    const d = ((x.ms / base.ms - 1) * 100).toFixed(0);
    console.log(`  ${String(x.q).padEnd(6)} ${x.ms.toFixed(2).padStart(7)} ms  ${x.kb.toFixed(1).padStart(6)} KB  ${d > 0 ? '+' : ''}${d}%`);
  }
  console.log(`\n  ⇒ q=0.75 相对 q=0.92 省 ${(base.ms - r.find((x) => x.q === 0.75).ms).toFixed(2)} ms/帧`);
  console.log('  ⚠️ 这是**画质取舍**，不是纯性能问题 —— 定档前要出图比一眼（工具不能替人决定）。');
});
