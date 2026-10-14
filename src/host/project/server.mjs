// 渲染服务：把 filmwright 自己、项目目录、以及一份生成的 __PROJECT 引导模块供到浏览器。
//
// 三个入口：
//   /           渲染页（逐帧渲染用，headless 也是访问这个）
//   /preview    预览页（人用：拖动时间轴、播放、改文件热重载）
//   /__filmwright/watch   SSE，文件变化时推一条消息，预览页据此重载
//
// 项目镜头文件的写法：
//   import {text, panel} from 'filmwright';          // 由 importmap 解析到 /kit/index.js
// 不需要打包器。
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {existsSync, watch} from 'node:fs';
import {join, extname} from 'node:path';
import {KIT_ROOT, RUNTIME_ROOT} from '../root.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff2': 'font/woff2',
  '.wav': 'audio/wav',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
};

export function serveProject(projectDir, {raw, timeline, shotsRel, scene = null, clips = null, watch: doWatch = false, frameSink = null}) {
  // SSE 订阅者：文件变化时推 reload
  const clients = new Set();
  let watchers = [];

  function notify(reason) {
    const body = `data: ${JSON.stringify({reload: true, reason})}\n\n`;
    for (const c of clients) {
      try { c.write(body); } catch { /* 断了就算了 */ }
    }
  }

  function startWatching() {
    if (!doWatch || watchers.length) return;
    // 只盯会改变画面的东西：镜头、场景规格、配置、时间轴。
    // 不盯整个项目目录 —— 那会把 .work/ 里的渲染产物也算进来，自己触发自己。
    const targets = [
      {path: join(projectDir, 'shots'), kind: '镜头'},
      {path: join(projectDir, 'scene.json'), kind: '场景规格'},
      {path: join(projectDir, 'film.config.mjs'), kind: '配置'},
      {path: join(projectDir, 'script', 'timeline.json'), kind: '时间轴'},
    ];
    for (const t of targets) {
      if (!existsSync(t.path)) continue;
      try {
        const w = watch(t.path, {recursive: true}, () => notify(t.kind));
        watchers.push(w);
      } catch { /* 某些平台不支持 recursive，忽略 */ }
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const p = decodeURIComponent(url.pathname);

      // 帧直传：页面把编码好的帧**以二进制 POST 上来**，由这里写进 ffmpeg。
      //
      // 为什么不用「CDP 取回 base64」那条路（实测数据）：
      //   - base64 让载荷多 33%，且浏览器编码 + node 解码都要花 CPU；
      //   - 每帧一次 CDP 往返，而实测往返固定开销约 20ms（与载荷大小几乎无关）。
      // 这条路让页面**自己循环**渲染并 POST，整段渲染只发一次 CDP 调用。
      //
      // **背压**：写 ffmpeg stdin 遇到 drain 就先等，等完再回响应 ——
      // 页面在 `await fetch` 处自然停住，不会把内存堆满。
      if (p === '/__filmwright/frame' && req.method === 'POST') {
        if (!frameSink || typeof frameSink.write !== 'function') {
          res.writeHead(409, {'Content-Type': 'text/plain; charset=utf-8'}).end('没有接收端（不是渲染模式）');
          return;
        }
        const chunks = [];
        let tooBig = false;
        req.on('data', (c) => {
          if (tooBig) return;
          chunks.push(c);
          // 单帧超过 64MB 一定是哪里错了（正常一帧几十 KB 到 2MB）
          if (chunks.reduce((a, b) => a + b.length, 0) > 64 * 1024 * 1024) tooBig = true;
        });
        req.on('end', async () => {
          if (tooBig) {
            res.writeHead(413).end('单帧过大');
            return;
          }
          const body = Buffer.concat(chunks);
          const n = Number(url.searchParams.get('n')) || 0;
          try {
            await frameSink.write(body, n);
            res.writeHead(200, {'Content-Type': 'text/plain; charset=utf-8'}).end('ok');
          } catch (e) {
            // 写失败（ffmpeg 死了 / 已收工）→ 明确回错，页面会中断循环并把消息带回来
            res.writeHead(500, {'Content-Type': 'text/plain; charset=utf-8'})
              .end('接收帧失败：' + (e && e.message ? e.message : String(e)));
          }
        });
        return;
      }

      // 热重载通道
      if (p === '/__filmwright/watch') {
        startWatching();
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }

      // 生成的引导模块：配置 + 时间轴 + 场景规格 + 片段 + 镜头模块地址
      if (p === '/__filmwright/project.js') {
        const body =
          `export const config = ${JSON.stringify(raw)};\n` +
          `export const timeline = ${JSON.stringify(timeline)};\n` +
          `export const scene = ${JSON.stringify(scene ?? null)};\n` +
          `export const clips = ${JSON.stringify(clips ?? null)};\n` +
          `export const shotsUrl = ${shotsRel ? JSON.stringify('/proj/' + shotsRel) : 'null'};\n`;
        res.writeHead(200, {'Content-Type': MIME['.js'], 'Cache-Control': 'no-store'});
        res.end(body);
        return;
      }

      // /clips/<name>/fNNNNN.png → 抽好的帧序列（在项目 .work/clips/<key>/ 下）
      // 片段目录名带内容哈希，这里只按名字找，避免把哈希暴露给运行时。
      if (p.startsWith('/clips/') && clips) {
        const rest = p.slice('/clips/'.length);
        const slash = rest.indexOf('/');
        if (slash > 0) {
          const name = decodeURIComponent(rest.slice(0, slash));
          const file = rest.slice(slash + 1);
          const entry = clips[name];
          if (entry && /^f\d+\.png$/.test(file)) {
            const full = join(entry.dir, file);
            if (existsSync(full)) {
              const buf = await readFile(full);
              res.writeHead(200, {'Content-Type': MIME['.png'], 'Cache-Control': 'no-store'});
              res.end(buf);
              return;
            }
          }
        }
        res.writeHead(404).end('clip frame not found: ' + p);
        return;
      }

      // 渲染页 / 预览页
      if (p === '/' || p === '/index.html') {
        const html = await readFile(join(KIT_ROOT, 'index.html'), 'utf8');
        res.writeHead(200, {'Content-Type': MIME['.html'], 'Cache-Control': 'no-store'});
        res.end(html);
        return;
      }
      if (p === '/preview' || p === '/preview.html') {
        const html = await readFile(join(RUNTIME_ROOT, 'host', 'project', 'preview.html'), 'utf8');
        res.writeHead(200, {'Content-Type': MIME['.html'], 'Cache-Control': 'no-store'});
        res.end(html);
        return;
      }

      // /kit/**  → 库的运行时源码（src/）
      // /proj/** → 项目目录
      const targets = [];
      if (p.startsWith('/kit/')) targets.push(join(RUNTIME_ROOT, p.slice('/kit/'.length)));
      else if (p.startsWith('/proj/')) targets.push(join(projectDir, p.slice('/proj/'.length)));
      else if (p.startsWith('/fonts/') || p.startsWith('/assets/')) {
        // 项目把素材放在 public/ 下，但页面按根路径引用
        targets.push(join(projectDir, 'public', p));
        targets.push(join(KIT_ROOT, p));
      } else targets.push(join(KIT_ROOT, p));

      for (const f of targets) {
        // 路径穿越防护：`..` 不能跑出库目录或项目目录
        const inKit = f.startsWith(KIT_ROOT);
        const inProj = f.startsWith(projectDir);
        if (!inKit && !inProj) {
          res.writeHead(403).end('forbidden');
          return;
        }
        if (!existsSync(f)) continue;
        const buf = await readFile(f);
        res.writeHead(200, {
          'Content-Type': MIME[extname(f).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
        res.end(buf);
        return;
      }
      res.writeHead(404).end('not found: ' + p);
    } catch (e) {
      res.writeHead(500).end(String(e && e.message || e));
    }
  });

  // 关服务时一并停掉文件监听与 SSE 连接，否则进程不退出
  const close = () => {
    for (const w of watchers) { try { w.close(); } catch { /* 已关 */ } }
    watchers = [];
    for (const c of clients) { try { c.end(); } catch { /* 已断 */ } }
    clients.clear();
    server.close();
  };

  return new Promise((r) => {
    server.listen(0, '127.0.0.1', () => r(Object.assign(server, {closeProject: close})));
  });
}
