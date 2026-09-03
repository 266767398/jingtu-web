// 从前端 JS 里提取真实调用的 GET 端点，逐个冒烟，找出 5xx
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const BASE = 'http://127.0.0.1:3456';
const JS_DIR = path.join(__dirname, '..', '..', 'public', 'js');

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
        if (r.status >= 500) { try { body = (await r.text()).slice(0, 200); } catch { } }
        out.push({ url, status: r.status, body });
      } catch (e) { out.push({ url, status: 'THROW', body: e.message }); }
    }
    return out;
  }, all);

  const fails = results.filter(r => r.status === 'THROW' || r.status >= 500);
  const notFound = results.filter(r => r.status === 404);
  const ok = results.filter(r => r.status < 400).length;

  console.log(`2xx/3xx: ${ok}    4xx(非404): ${results.filter(r => r.status >= 400 && r.status < 500 && r.status !== 404).length}    404: ${notFound.length}    5xx: ${fails.length}`);

  if (fails.length) {
    console.log('\n=== 5xx（真实故障）===');
    fails.forEach(r => console.log(`  ${r.status} ${r.url}\n      ${r.body}`));
  }
  if (notFound.length) {
    console.log('\n=== 404（前端调了不存在的端点）===');
    notFound.forEach(r => console.log(`  ${r.url}`));
  }

  await b.close();
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('异常:', e.message); process.exit(2); });
