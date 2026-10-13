// 下载某次 run 的 ci-failure artifact（未登录也能下载公开仓库的 artifact）。
//   node tools/ci-artifact.mjs [run-id]
import https from 'node:https';
import {writeFileSync, mkdirSync} from 'node:fs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? '0';
const REPO = process.env.FILMWRIGHT_REPO || 'hongweifei/filmwright';

const get = (host, path, {json = true, redirect = 0} = {}) => new Promise((res, rej) => {
  https.get({host, path, headers: {'User-Agent': 'filmwright-ci', Accept: json ? 'application/vnd.github+json' : '*/*'}}, (r) => {
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && redirect < 5) {
      const u = new URL(r.headers.location, `https://${host}`);
      r.resume();
      get(u.host, u.pathname + u.search, {json, redirect: redirect + 1}).then(res, rej);
      return;
    }
    const c = [];
    r.on('data', (x) => c.push(x));
    r.on('end', () => {
      const buf = Buffer.concat(c);
      res({status: r.statusCode, headers: r.headers, buf, text: buf.toString('utf8')});
    });
  }).on('error', rej);
});

const runId = process.argv[2] || (await get('api.github.com', `/repos/${REPO}/actions/runs?per_page=1`)).text;
let rid = runId;
if (!/^\d+$/.test(String(runId))) {
  const j = JSON.parse(String(runId));
  rid = j.workflow_runs[0].id;
  console.log('最新 run:', rid, j.workflow_runs[0].head_sha.slice(0, 7), j.workflow_runs[0].conclusion);
}
const arts = JSON.parse((await get('api.github.com', `/repos/${REPO}/actions/runs/${rid}/artifacts`)).text);
console.log('artifacts:', (arts.artifacts ?? []).map((a) => a.name + '(' + a.size_in_bytes + 'B)').join(', ') || '无');
mkdirSync('.work/ci', {recursive: true});
for (const a of arts.artifacts ?? []) {
  const z = await get('api.github.com', `/repos/${REPO}/actions/artifacts/${a.id}/zip`, {json: false});
  const out = `.work/ci/${a.name}.zip`;
  writeFileSync(out, z.buf);
  console.log('下载', out, z.buf.length, 'bytes | HTTP', z.status);
  // zip 里是单个 txt；直接扫文本内容（zip 未压缩小文件时可读）
  const s = z.buf.toString('utf8');
  const i = s.indexOf('== 时间 ==');
  if (i >= 0) console.log('\n--- 现场内容 ---\n' + s.slice(i, i + 3000));
  else console.log('（内容被压缩，用 Expand-Archive 解开看）');
}
