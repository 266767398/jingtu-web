// 全模块 API 冒烟：用真实登录会话遍历所有 GET 端点，找出 5xx
const puppeteer = require('puppeteer');
const BASE = 'http://127.0.0.1:3456';

const ENDPOINTS = [
  '/api/auth/me',
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
  '/api/live/streams',
  '/api/checkin/status',
  '/api/achievements',
  '/api/members?page=1&pageSize=10',
  '/api/social-links',
  '/api/permission-groups',
  '/api/vrc/status/list',
  '/api/birthday/upcoming',
  '/api/group/info',
  '/api/notifications?page=1&pageSize=10'
];

(async () => {
  const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'], protocolTimeout: 240000 });
  const p = await b.newPage();
  await p.goto(BASE, { waitUntil: 'networkidle2' });
  await p.type('#loginId', '__diag');
  await p.type('#loginPassword', 'Diag#2026x');
  await p.click('#loginPwdBtn');
  await new Promise(r => setTimeout(r, 4500));

  const results = await p.evaluate(async (list) => {
    const out = [];
    for (const url of list) {
      try {
        const r = await fetch(url, { credentials: 'include' });
        let body = '';
        if (r.status >= 400) { try { body = (await r.text()).slice(0, 220); } catch { } }
        out.push({ url, status: r.status, body });
      } catch (e) { out.push({ url, status: 'THROW', body: e.message }); }
    }
    return out;
  }, ENDPOINTS);

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
  await b.close();
  process.exit(bad > 0 ? 1 : 0);
})().catch(e => { console.error('异常:', e.message); process.exit(2); });
