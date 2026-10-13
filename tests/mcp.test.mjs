// MCP 服务器的端到端测试：真起进程、走 JSON-RPC 握手、列工具、调两个只读工具。
// SDK 没装（没跑 npm install）时整体跳过 —— 核心命令不依赖它，测试也不该依赖。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let sdkMissing = false;
try {
  await import('@modelcontextprotocol/sdk/server/mcp.js');
} catch {
  sdkMissing = true;
}

/** 起一个 MCP 会话，返回 call() 与 close()。 */
function openSession() {
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
    setTimeout(() => rej(new Error('MCP 超时：' + method)), 30000);
    send({jsonrpc: '2.0', id: myId, method, params});
  });
  return {
    call,
    notify: send,
    text: async (name, args) => {
      const r = await call('tools/call', {name, arguments: args});
      return {payload: JSON.parse(r.result.content[0].text), isError: !!r.result.isError};
    },
    close: () => { rl.close(); srv.kill(); },
  };
}

test('MCP：握手 → 8 个工具齐 → 只读工具真能跑', {skip: sdkMissing && '没装 @modelcontextprotocol/sdk（npm install 后启用）'}, async () => {
  const s = openSession();
  try {
    const init = await s.call('initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'test', version: '0'},
    });
    assert.equal(init.result.serverInfo.name, 'filmwright');
    s.notify({jsonrpc: '2.0', method: 'notifications/initialized'});

    const tools = await s.call('tools/list', {});
    const names = tools.result.tools.map((t) => t.name);
    for (const want of ['filmwright_new', 'filmwright_schema', 'filmwright_timeline', 'filmwright_scene_validate',
      'filmwright_tts', 'filmwright_check', 'filmwright_stills', 'filmwright_render', 'filmwright_all']) {
      assert.ok(names.includes(want), '缺工具 ' + want);
    }

    const v = await s.text('filmwright_scene_validate', {project: join(ROOT, 'examples', 'scenecast')});
    assert.equal(v.payload.ok, true, JSON.stringify(v.payload.errors));
    assert.equal(v.isError, false);

    const t = await s.text('filmwright_timeline', {project: join(ROOT, 'examples', 'scenecast')});
    assert.equal(t.payload.data.sentences.length, 7);
    assert.equal(t.payload.data.sentences[0].id, 'S01');

    // 坏目录：不是异常，是 isError + 结构化 code（NO_PROJECT_DIR）
    const bad = await s.text('filmwright_check', {project: join(ROOT, 'no-such-dir-xyz')});
    assert.equal(bad.isError, true);
    assert.equal(bad.payload.errors[0].code, 'NO_PROJECT_DIR');
  } finally {
    s.close();
  }
});
