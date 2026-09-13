// 全模块 API 冒烟：用 Node 内置 fetch 遍历所有 GET 端点，找出 5xx；404 视为清单腐化同样失败。
// 端点路径均已对照 server.js 挂载表与 routes/*.js 路由定义核实。
// 可选：设置 SMOKE_LOGIN_ID / SMOKE_PASSWORD 环境变量走真实登录；未设置时测未登录面（401/403 属预期 WARN）。
const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:3456';

const ENDPOINTS = [
  '/api/auth/session',
  '/api/users/all/locations',
  '/api/users?page=1&pageSize=10',
  '/api/users/me/events',
  '/api/admin/stats',
  '/api/admin/oper-logs?page=1&pageSize=5',
  '/api/admin/oper-log-types',
  '/api/chat/conversations',
  '/api/chat/groups',
  '/api/album/photos?page=1&pageSize=10',
  '/api/album/categories',
  '/api/events?page=1&pageSize=10',
  '/api/posts?page=1&pageSize=10',
  '/api/announcements',
  '/api/checkin/me/status',
  '/api/achievements/me',
  '/api/group/members?page=1&pageSize=10',
  '/api/social-links',
  '/api/permission-groups/groups',
  '/api/vrc/status/list',
  '/api/users/birthdays',
  '/api/group/stats',
  '/api/notifications?page=1&pageSize=10'
];

async function loginAndGetCookie() {
  if (!process.env.SMOKE_LOGIN_ID || !process.env.SMOKE_PASSWORD) return '';
  const r = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ loginId: process.env.SMOKE_LOGIN_ID, password: process.env.SMOKE_PASSWORD })
  });
  if (!r.ok) throw new Error('login failed: HTTP ' + r.status);
  return (r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')])
    .filter(Boolean)
    .map(c => c.split(';')[0])
    .join('; ');
}

(async () => {
  const cookie = await loginAndGetCookie();
  const results = [];
  for (const url of ENDPOINTS) {
    try {
      const r = await fetch(BASE + url, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
      let body = '';
      if (r.status >= 400) { try { body = (await r.text()).slice(0, 220); } catch { } }
      results.push({ url, status: r.status, body });
    } catch (e) { results.push({ url, status: 'THROW', body: e.message }); }
  }

  let bad = 0, missing = 0;
  console.log('=== 全模块 GET 冒烟 ===');
  for (const r of results) {
    const s = String(r.status);
    let tag = 'OK  ';
    if (s === '404') { tag = '404 '; missing++; }
    else if (s >= '500' || s === 'THROW') { tag = 'FAIL'; bad++; }
    else if (s >= '400') tag = 'WARN';
    console.log(`  ${tag} ${s.padEnd(6)} ${r.url}`);
    if (r.body && tag !== 'OK  ') console.log(`        ${r.body}`);
  }
  console.log(`\n5xx: ${bad}   404: ${missing}   共 ${results.length} 个端点`);
  process.exit(bad > 0 || missing > 0 ? 1 : 0);
})().catch(e => { console.error('异常:', e.message); process.exit(2); });
