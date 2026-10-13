// MCP 服务器的端到端测试：真起进程、走 JSON-RPC 握手、列工具、调两个只读工具。
// SDK 没装（没跑 npm install）时整体跳过 —— 核心命令不依赖它，测试也不该依赖。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {rmSync} from 'node:fs';
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
  // 用 process.execPath 而不是裸 'node'：CI 的 windows runner 上（bash/PowerShell
  // 混合）PATH 解析可能与本机不同，裸 'node' 可能 spawn 失败。而 spawn 失败是
  // **未捕获的 error 事件**，会让测试进程立刻退出（实测 CI 上该步骤 0 秒失败、
  // 本机通过 —— 这个差异正是来源之一）。
  const srv = spawn(process.execPath, [join(ROOT, 'bin', 'filmwright.mjs'), 'mcp'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let srvErr = '';
  srv.stderr.on('data', (d) => (srvErr += d));
  const rl = createInterface({input: srv.stdout});
  let id = 0;
  const pending = new Map();
  let serverDead = null;   // 服务器起不来/已退出时的原因（call() 据此立刻拒绝）
  // 服务器进程退出/起不来时**拒绝所有 pending 调用**（并把 stderr 带出来）。
  // 只设一个标志不够：call() 可能已经在等一个永远不会来的响应，于是挂满超时
  // （实测：删掉 bin/filmwright.mjs 后测试挂满 600 秒）。
  const failAll = (why) => {
    serverDead = why;
    for (const [, entry] of pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.rej(new Error('MCP 服务器不可用：' + why + (srvErr ? '；stderr=' + srvErr.slice(-400) : '')));
    }
    pending.clear();
  };
  srv.on('error', (e) => failAll('spawn 失败 ' + e.message));
  // 退出时记下原因（即使此刻没有 pending）：后续 call() 要能立刻拒绝，
  // 否则会挂满超时 —— 实测删掉 bin/filmwright.mjs 后测试挂满 600 秒。
  srv.on('exit', (code) => { failAll('进程退出 code=' + code); });
  rl.on('line', (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    const entry = m.id ? pending.get(m.id) : null;
    if (entry) {
      clearTimeout(entry.timer);
      pending.delete(m.id);
      entry.res(m);
    }
  });
  const send = (msg) => srv.stdin.write(JSON.stringify(msg) + '\n');
  /** 工具调用：返回 {payload, content, isError}；协议层错误（无 content）直接抛原文。 */
  const callTool = async (name, args) => {
    const r = await call('tools/call', {name, arguments: args});
    if (r.error) throw new Error(`MCP 协议错误（${name}）：` + JSON.stringify(r.error).slice(0, 800));
    if (!r.result?.content) throw new Error(`MCP 返回没有 content（${name}）：` + JSON.stringify(r.result ?? null).slice(0, 800));
    return {content: r.result.content, isError: !!r.result.isError};
  };
  const call = (method, params) => new Promise((res, rej) => {
    // 服务器已经死了就立刻拒绝，别等超时。
    // 两处都要查：serverDead（exit/error 事件已触发）与 srv.exitCode（进程已退出但
    // 事件还没轮到我们处理）—— 只查前者会漏掉「spawn 后立刻调用」这个时序，
    // 实测那会让测试挂满超时而不是快速失败。
    if (serverDead || srv.exitCode !== null) {
      const why = serverDead ?? ('进程已退出 code=' + srv.exitCode);
      rej(new Error('MCP 服务器不可用：' + why + (srvErr ? '；stderr=' + srvErr.slice(-400) : '')));
      return;
    }
    const myId = ++id;
    // 超时要留足余量（review / stills 会真开浏览器渲染，CI 慢机器上可达 60s+），
    // 但**必须在收到响应时清掉定时器**：未清理的 setTimeout 会让 Node 的事件
    // 循环多活满整个超时时长 —— 实测测试只跑 4 秒、进程却挂了 302 秒才退出，
    // 在 CI 上表现为「这一步莫名跑很久然后失败」。
    const timer = setTimeout(() => { pending.delete(myId); rej(new Error('MCP 超时：' + method)); }, 300000);
    // pending 里存**对象**（res/rej/timer），不是裸解析函数 ——
    // failAll 要按字段访问它们来拒绝；存裸函数会让 failAll 静默失效，
    // 表现为「服务器死了但测试挂满超时」（这个坑真踩过）。
    pending.set(myId, {res, rej, timer});
    // 发送前再查一次：spawn 失败/进程秒退时，stdin 写入会抛 EPIPE
    try {
      send({jsonrpc: '2.0', id: myId, method, params});
    } catch (e) {
      clearTimeout(timer);
      pending.delete(myId);
      rej(new Error('MCP 写入失败（服务器可能已退出）：' + e.message));
    }
  });
  return {
    call,
    callTool,
    notify: send,
    text: async (name, args) => {
      const {content, isError} = await callTool(name, args);
      return {payload: JSON.parse(content[0].text), isError};
    },
    /**
     * 关会话：关 readline、杀掉服务器进程、**并等它真的退出**。
     * 只 kill 不等待的话，句柄还开着，测试进程要等到超时才结束。
     */
    close: async () => {
      rl.close();
      if (srv.exitCode !== null) return;
      const gone = new Promise((r) => srv.once('exit', r));
      srv.kill();
      const timer = setTimeout(() => { try { srv.kill('SIGKILL'); } catch { /* 已退 */ } r(); }, 5000);
      await gone;
      clearTimeout(timer);
    },
  };
}

test('MCP：握手 → 11 个工具齐 → 只读工具真能跑', {skip: sdkMissing && '没装 @modelcontextprotocol/sdk（npm install 后启用）'}, async () => {
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
      'filmwright_tts', 'filmwright_check', 'filmwright_stills', 'filmwright_review', 'filmwright_srt',
      'filmwright_render', 'filmwright_all']) {
      assert.ok(names.includes(want), '缺工具 ' + want);
    }
    assert.equal(names.length, 11, '工具数应为 11（新增工具时同步这里）：' + names.join(', '));

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
    await s.close();
  }
});

/**
 * 回图测试要真开浏览器渲染。CI 慢机器上「启动一次浏览器 + 每帧 ~2s」很贵：
 * 实测渲染 5 帧（stills 2 + review 3）在 windows runner 上超过 120s。
 *
 * 所以这里**只渲染验证能力所需的最少帧**：stills 2 帧（验回图 + max_images
 * 约束）、review 1 帧（验「校验 + 回图」链路）。max_images 的上限/截断逻辑
 * 由单元级断言覆盖，不必靠真渲染多帧。
 */
const heavyOk = process.env.FILMWRIGHT_TEST_BROWSER === '1' || !process.env.CI;

test('MCP：stills / review 真的回图（PNG 魔数），量受 max_images 约束',
  {skip: sdkMissing ? '没装 @modelcontextprotocol/sdk（npm install 后启用）'
    : (heavyOk ? false : 'CI 上跳过重浏览器测试（本地跑，或设 FILMWRIGHT_TEST_BROWSER=1）')},
  async () => {
  const s = openSession();
  const isPng = (b64) => {
    const buf = Buffer.from(b64, 'base64');
    return buf.length > 100 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  };
  try {
    const init = await s.call('initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'test', version: '0'},
    });
    assert.equal(init.result.serverInfo.name, 'filmwright');
    s.notify({jsonrpc: '2.0', method: 'notifications/initialized'});

    // stills：渲 2 帧、要 2 张图（验回图 + 数量约束）
    const r = await s.callTool('filmwright_stills', {
      project: join(ROOT, 'examples', 'scenecast'), frames: [150, 470],
      dir: join(ROOT, '.work', 'mcp-test-stills'), max_images: 2,
    });
    const imgs = r.content.filter((c) => c.type === 'image');
    // 先验 ok：stills 失败时 `ok:false` 且**不带图**（这是设计），
    // 若直接断言图片数，失败信息只有「0 !== 2」，看不出是渲染失败还是别的。
    // （CI 上真出现过「回 0 张图」而日志无任何线索 —— 那次是 stills 本身失败。）
    assert.equal(JSON.parse(r.content[0].text).ok, true,
      'stills 命令失败，原始返回：' + r.content[0].text.slice(0, 800));
    assert.equal(imgs.length, 2,
      '应内联 2 张图；实际 content 类型=' + JSON.stringify(r.content.map((c) => c.type)));
    assert.ok(imgs.every((i) => i.mimeType === 'image/png' && isPng(i.data)), 'PNG 魔数不对');

    // review：一次调用 = 校验 + 静态自检 + 代表帧回图。
    // 只渲 1 帧：链路正确性不需要更多帧，而慢机器上每帧都要钱。
    const v = await s.callTool('filmwright_review', {
      project: join(ROOT, 'examples', 'scenecast'), max_images: 1,
    });
    const payload = JSON.parse(v.content[0].text);
    assert.equal(payload.ok, true, 'review 失败：' + JSON.stringify(payload.errors));
    const vImgs = v.content.filter((c) => c.type === 'image');
    assert.equal(vImgs.length, 1,
      'max_images=1 应给 1 张；实际类型=' + JSON.stringify(v.content.map((c) => c.type)) +
      ' payload=' + v.content[0].text.slice(0, 600));
    assert.ok(vImgs[0] && isPng(vImgs[0].data), 'review 回的图必须是 PNG');
    assert.ok(payload.data.frames.length === 1 && payload.data.frames[0].frame > 0);
    assert.ok(payload.data.shots >= 8, 'scenecast 有 8 个镜头，shots 应报全量');
    // 调用方能从「shots 全量 vs frames 只回 1 条」看出发生了截断；
    // 截断说明（note）只在 stills 那条路径上加，review 不做断言。
    assert.ok(payload.data.frames.length < payload.data.shots,
      'max_images=1 而镜头更多时，frames 应少于 shots（据此可知有截断）');
  } finally {
    await s.close();
    rmSync(join(ROOT, '.work', 'mcp-test-stills'), {recursive: true, force: true});
    rmSync(join(ROOT, 'examples', 'scenecast', '.work', 'review'), {recursive: true, force: true});
  }
});
