// 从前端 JS 里提取真实调用的 GET 端点，逐个冒烟，找出 5xx
// P3-148：登录口令改环境变量注入（对齐 smoke-api.js 的 SMOKE_LOGIN_ID / SMOKE_PASSWORD 口径）
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const BASE = 'http://127.0.0.1:3456';
const JS_DIR = path.join(__dirname, '..', '..', 'public', 'js');

const LOGIN_ID = process.env.SMOKE_LOGIN_ID;
const LOGIN_PASS = process.env.SMOKE_PASSWORD;
if (!LOGIN_ID || !LOGIN_PASS) {
  console.error('需要设置 SMOKE_LOGIN_ID / SMOKE_PASSWORD（对应 P2-172 创建的 __diag 账号口令）');
  process.exit(2);
}

// 收集 api('/api/...') 里的静态路径（跳过含模板变量的）
function collect() {
  const urls = new Set();
  for (const f of fs.readdirSync(JS_DIR)) {
    if (!f.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(JS_DIR, f), 'utf8');
    for (const m of src.matchAll(/api\(\s*[`'"](\/api\/[^`'"]*)[`'"]/g)) {
      const u = m[1];
      if (u.includes('${')) continue;
      urls.add(u);
    }
  }
  return [...urls].sort();
}

(async () => {
  const all = collect();
  console.log(`从前端提取到 ${all.length} 个静态 API 路径\n`);
  const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'], protocolTimeout: 300000 });
  const p = await b.newPage();
  await p.goto(BASE, { waitUntil: 'networkidle2' });
  await p.type('#loginId', LOGIN_ID);
  await p.type('#loginPassword', LOGIN_PASS);
  await p.click('#loginPwdBtn');
  await new Promise(r => setTimeout(r, 4500));

  const results = await p.evaluate(async (list) => {
    const out = [];
    for (const url of list) {
      try {
        const r = await fetch(url, { credentials: 'include' });
        out.push({ url, status: r.status });
      } catch (e) { out.push({ url, status: 'THROW' }); }
    }
    return out;
  }, all);

  const fails = results.filter(r => r.status === 'THROW' || r.status >= 500);
  const notFound = results.filter(r => r.status === 404);
  const ok = results.filter(r => r.status < 400).length;

  console.log(`2xx/3xx: ${ok}    4xx(非404): ${results.filter(r => r.status >= 400 && r.status < 500 && r.status !== 404).length}    404: ${notFound.length}    5xx: ${fails.length}`);

  if (fails.length) {
    console.log('\n=== 5xx（真实故障）===');
    fails.forEach(r => console.log(`  ${r.status} ${r.url}`));
  }
  if (notFound.length) {
    console.log('\n=== 404（前端调了不存在的端点）===');
    notFound.forEach(r => console.log(`  ${r.url}`));
  }

  await b.close();
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('异常:', e.message); process.exit(2); });
