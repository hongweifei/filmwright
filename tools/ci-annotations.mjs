// 读某次 CI run 的失败 annotation。
//
// 为什么需要它：公开仓库未登录时，Actions 的 **job 日志 API 会重定向到登录页**，
// 拿不到日志正文；而 **annotation 是公开可读的**。所以 CI 里用 `::error::`
// 输出关键读数（见 .github/workflows/ci.yml 的「失败现场」步骤），这个工具负责取回来。
//
//   node tools/ci-annotations.mjs            # 看最近 4 次 run
//   node tools/ci-annotations.mjs <run-id>   # 看指定 run
//
// 需要网络；证书被中间拦截的环境下用 NODE_TLS_REJECT_UNAUTHORIZED=0。
import https from 'node:https';

const REPO = process.env.FILMWRIGHT_REPO || 'hongweifei/filmwright';

const get = (path) => new Promise((res, rej) => {
  https.get({host: 'api.github.com', path, headers: {'User-Agent': 'filmwright-ci', Accept: 'application/vnd.github+json'}}, (r) => {
    const c = [];
    r.on('data', (x) => c.push(x));
    r.on('end', () => {
      try { res(JSON.parse(Buffer.concat(c).toString('utf8'))); } catch (e) { rej(new Error('HTTP ' + r.statusCode + ' 非 JSON')); }
    });
  }).on('error', rej);
});

const arg = process.argv[2];
const runs = arg ? [{id: Number(arg)}] : (await get(`/repos/${REPO}/actions/runs?per_page=4`)).workflow_runs;

for (const w of runs) {
  const full = arg ? await get(`/repos/${REPO}/actions/runs/${w.id}`) : w;
  if (!full.head_sha) { console.log(`run ${w.id}: 读不到（私有或不存在？）`); continue; }
  const jobs = (await get(`/repos/${REPO}/actions/runs/${w.id}/jobs?per_page=20`)).jobs ?? [];
  const bad = jobs.filter((j) => j.conclusion !== 'success' && j.conclusion !== 'skipped');
  console.log(`=== run ${w.id} ${full.head_sha.slice(0, 7)} ${full.status} ${full.conclusion ?? ''} | 失败 job: ${bad.map((j) => j.name).join(', ') || '无'}`);
  for (const j of bad) {
    for (const s of j.steps ?? []) {
      if (s.conclusion !== 'success' && s.conclusion !== 'skipped') console.log(`   ✗ ${s.number}. ${s.name}`);
    }
  }
  const cr = await get(`/repos/${REPO}/commits/${full.head_sha}/check-runs?per_page=30`);
  for (const c of cr.check_runs ?? []) {
    if (c.conclusion === 'success' || !c.output?.annotations_count) continue;
    const a = await get(`/repos/${REPO}/check-runs/${c.id}/annotations`);
    for (const ann of a.annotations ?? []) {
      if (ann.annotation_level !== 'failure') continue;
      console.log(`   [${c.name.slice(0, 26)}] ${ann.message.slice(0, 900)}`);
    }
  }
}
