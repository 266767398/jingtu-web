// 复验本轮修复：操作日志端点 / i18n 关键键 / 滚轮 / 相册上传按钮
const puppeteer = require('puppeteer');
const BASE = 'http://127.0.0.1:3456';

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new', args: ['--no-sandbox'], protocolTimeout: 180000
  });
  const p = await browser.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 200)); });

  await p.goto(BASE, { waitUntil: 'networkidle2' });
  await p.type('#loginId', '__diag');
  await p.type('#loginPassword', 'Diag#2026x');
  await p.click('#loginPwdBtn');
  await new Promise(r => setTimeout(r, 4000));

  const loggedIn = await p.evaluate(() => {
    // currentUser 是 core.js 顶层 `let`，属于全局声明式环境，不挂在 window 上
    try { return !!(currentUser && currentUser.id); } catch { return false; }
  });
  console.log('登录:', loggedIn ? 'OK' : '失败');
  if (!loggedIn) { await browser.close(); process.exit(1); }

  // 1) i18n 关键键不再返回键名
  const i18n = await p.evaluate(() => {
    const keys = ['server_error', 'session_expired', 'rate_limited', 'unknown',
      'edit', 'delete', 'logout', 'events.title', 'map.locating', 'live.obs_server'];
    const out = {};
    keys.forEach(k => { out[k] = __(k); });
    return out;
  });
  console.log('\n[1] i18n 关键键：');
  let i18nBad = 0;
  for (const [k, v] of Object.entries(i18n)) {
    const ok = v !== k;
    if (!ok) i18nBad++;
    console.log(`   ${ok ? 'OK  ' : 'FAIL'} ${k.padEnd(18)} -> ${v}`);
  }

  // 2) 操作日志端点
  const logRes = await p.evaluate(async () => {
    const r = await fetch('/api/admin/oper-logs?page=1&pageSize=5', { credentials: 'include' });
    const t = await r.text();
    return { status: r.status, body: t.slice(0, 600) };
  });
  console.log('\n[2] /api/admin/oper-logs ->', logRes.status);
  console.log('   ', logRes.body);

  // 3) 滚轮
  const wheel = await p.evaluate(async () => {
    window.scrollTo(0, 0);
    const before = window.scrollY;
    window.scrollBy(0, 500);
    await new Promise(r => setTimeout(r, 300));
    return { before, after: window.scrollY, htmlOv: getComputedStyle(document.documentElement).overflowY, bodyOv: getComputedStyle(document.body).overflowY };
  });
  console.log('\n[3] 滚动:', JSON.stringify(wheel));

  // 4) 相册上传按钮
  await p.evaluate(() => switchTab('album'));
  await new Promise(r => setTimeout(r, 2500));
  const album = await p.evaluate(() => {
    const btn = document.getElementById('albumUploadBtn');
    const input = document.getElementById('albumUpload');
    return {
      btnFound: !!btn, btnText: btn ? btn.textContent.trim() : null,
      inputFound: !!input, inputId: input ? input.id : null
    };
  });
  console.log('\n[4] 相册上传:', JSON.stringify(album));

  // 5) CSS 变量是否已全部有值
  const vars = await p.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const names = ['--bg2', '--bg3', '--text1', '--text-muted2', '--danger', '--input-bg', '--card-bg-hover', '--accent-bg', '--active-bg', '--code-bg', '--mobile-tab-bar-h'];
    const out = {};
    names.forEach(n => { out[n] = cs.getPropertyValue(n).trim() || '(空)'; });
    return out;
  });
  console.log('\n[5] CSS 变量:');
  Object.entries(vars).forEach(([k, v]) => console.log(`   ${v === '(空)' ? 'FAIL' : 'OK  '} ${k.padEnd(20)} = ${v}`));

  console.log('\n[6] 控制台错误:', errs.length);
  errs.slice(0, 10).forEach(e => console.log('   ' + e));

  await browser.close();
  console.log('\n=== i18n 失败键数: ' + i18nBad + ' ===');
})().catch(e => { console.error('脚本异常:', e.message); process.exit(1); });
