// 用 MCP 的 review 工具迭代 promo（狗粮：制作者就是工具链本身）。
// 起 stdio 服务器 → 握手 → 调 filmwright_review → 落盘回图 → 打印结构化结果。
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {writeFileSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = process.argv[2];
const PROJECT = process.argv[3];
const MAX_IMAGES = Number(process.argv[4] ?? 6);

const srv = spawn('node', [join(ROOT, 'bin', 'filmwright.mjs'), 'mcp'], {stdio: ['pipe', 'pipe', 'pipe']});
const rl = createInterface({input: srv.stdout});
let id = 0;
const pending = new Map();
rl.on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (msg) => srv.stdin.write(JSON.stringify(msg) + '\n');
const call = (method, params) => new Promise((res, rej) => {
  const myId = ++id;
  pending.set(myId, res);
  setTimeout(() => rej(new Error('timeout ' + method)), 300000);
  send({jsonrpc: '2.0', id: myId, method, params});
});

try {
  await call('initialize', {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'dogfood', version: '0'}});
  send({jsonrpc: '2.0', method: 'notifications/initialized'});

  const r = await call('tools/call', {name: 'filmwright_review', arguments: {project: PROJECT, max_images: MAX_IMAGES}});
  const payload = JSON.parse(r.result.content[0].text);
  console.log('ok:', payload.ok, '| shots:', payload.data?.shots, '| stage:', payload.data?.stage ?? '-');
  console.log('errors:', JSON.stringify(payload.errors, null, 1));
  if (payload.warnings?.length) console.log('warnings:', payload.warnings.join(' | '));
  const frames = payload.data?.frames ?? [];
  const outDir = join(PROJECT, '.work', 'promo-review');
  mkdirSync(outDir, {recursive: true});
  const imgs = r.result.content.filter((c) => c.type === 'image');
  console.log('inline images:', imgs.length, 'of', frames.length);
  frames.forEach((f, i) => {
    if (i < imgs.length) {
      writeFileSync(join(outDir, `${String(i + 1).padStart(2, '0')}-${f.label.replace(/[^\w@-]/g, '_')}.png`),
        Buffer.from(imgs[i].data, 'base64'));
    }
    console.log(`  ${String(i + 1).padStart(2)}. ${String(f.frame).padStart(5)}  ${f.label}`);
  });
} finally {
  srv.kill();
}
