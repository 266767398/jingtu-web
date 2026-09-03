// 端到端：登录后在非安全上下文点击地图"共享位置"，确认提示是新的可操作文案
const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox'], protocolTimeout: 240000 });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message)));

  // 局域网 IP = 非安全上下文，正是用户报的场景
  await page.goto('http://192.168.2.104:3456/', { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 1200));

  await page.type('#loginId', '__diag');
  await page.type('#loginPassword', 'Diag#2026x');
  await page.evaluate(() => document.getElementById('loginPwdBtn').click());
  await new Promise((r) => setTimeout(r, 3500));

  const loggedIn = await page.evaluate(
    () => typeof currentUser !== 'undefined' && !!(currentUser && currentUser.id));
  console.log('登录:', loggedIn);
  if (!loggedIn) { await browser.close(); process.exit(1); }

  // 切到地图标签
  await page.evaluate(() => switchTab('map'));
  await new Promise((r) => setTimeout(r, 2500));

  const btnInfo = await page.evaluate(() => {
    const btn = document.getElementById('locationToggleBtn');
    return btn ? { exists: true, text: btn.textContent.trim(), disabled: btn.disabled } : { exists: false };
  });
  console.log('共享按钮:', JSON.stringify(btnInfo));

  // 清掉已有 toast，再点击
  await page.evaluate(() => {
    const c = document.getElementById('toastContainer');
    if (c) c.innerHTML = '';
    const btn = document.getElementById('locationToggleBtn');
    if (btn) btn.click(); else if (typeof startLocationTracking === 'function') startLocationTracking();
  });
  await new Promise((r) => setTimeout(r, 2500));

  const after = await page.evaluate(() => {
    const toasts = [...document.querySelectorAll('#toastContainer .toast')]
      .map((t) => t.textContent.trim().slice(0, 200));
    const btn = document.getElementById('locationToggleBtn');
    return { toasts, btnText: btn ? btn.textContent.trim() : null };
  });
  console.log('点击后 toast:', JSON.stringify(after.toasts, null, 2));
  console.log('按钮文案:', after.btnText);

  // 个人中心的"更新我的位置"按钮
  await page.evaluate(() => switchTab('me'));
  await new Promise((r) => setTimeout(r, 2000));
  const meBtn = await page.evaluate(() => {
    const b = document.getElementById('updateMyLocationBtn');
    if (!b) return { exists: false };
    const c = document.getElementById('toastContainer');
    if (c) c.innerHTML = '';
    b.click();
    return { exists: true };
  });
  await new Promise((r) => setTimeout(r, 2000));
  const meAfter = await page.evaluate(() => ({
    toasts: [...document.querySelectorAll('#toastContainer .toast')]
      .map((t) => t.textContent.trim().slice(0, 200)),
    btnDisabled: document.getElementById('updateMyLocationBtn')?.disabled,
  }));
  console.log('updateMyLocationBtn:', JSON.stringify(meBtn), JSON.stringify(meAfter, null, 2));

  console.log('[pageerror]', errs.length, errs.slice(0, 5));
  await browser.close();
})();

