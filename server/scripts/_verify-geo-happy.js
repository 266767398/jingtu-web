// 安全上下文（localhost）+ CDP 授权 + 模拟坐标：确认定位正常路径没被守卫误伤
const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox'], protocolTimeout: 240000 });
  const ctx = browser.defaultBrowserContext();
  await ctx.overridePermissions('http://127.0.0.1:3456', ['geolocation']);

  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message)));
  await page.setGeolocation({ latitude: 35.6812, longitude: 139.7671, accuracy: 20 });

  await page.goto('http://127.0.0.1:3456/', { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 1200));

  await page.type('#loginId', '__diag');
  await page.type('#loginPassword', 'Diag#2026x');
  await page.evaluate(() => document.getElementById('loginPwdBtn').click());
  await new Promise((r) => setTimeout(r, 3500));
  console.log('登录:', await page.evaluate(
    () => typeof currentUser !== 'undefined' && !!(currentUser && currentUser.id)));

  await page.evaluate(() => switchTab('map'));
  await new Promise((r) => setTimeout(r, 2500));

  await page.evaluate(() => {
    document.getElementById('toastContainer').innerHTML = '';
    document.getElementById('locationToggleBtn').click();
  });
  await new Promise((r) => setTimeout(r, 5000));

  const r = await page.evaluate(() => ({
    toasts: [...document.querySelectorAll('#toastContainer .toast')].map((t) => t.textContent.trim()),
    btnText: document.getElementById('locationToggleBtn')?.textContent.trim(),
    tracking: typeof locationTrackingActive !== 'undefined' ? locationTrackingActive : null,
    hasMyMarker: typeof myLocationMarker !== 'undefined' && !!myLocationMarker,
  }));
  console.log('开启共享:', JSON.stringify(r, null, 2));

  // 再点一次关闭，确认能正常停止
  await page.evaluate(() => {
    document.getElementById('toastContainer').innerHTML = '';
    document.getElementById('locationToggleBtn').click();
  });
  await new Promise((r) => setTimeout(r, 2000));
  console.log('关闭共享:', JSON.stringify(await page.evaluate(() => ({
    toasts: [...document.querySelectorAll('#toastContainer .toast')].map((t) => t.textContent.trim()),
    btnText: document.getElementById('locationToggleBtn')?.textContent.trim(),
    tracking: typeof locationTrackingActive !== 'undefined' ? locationTrackingActive : null,
  })), null, 2));

  // 个人中心的更新位置
  await page.evaluate(() => switchTab('me'));
  await new Promise((r) => setTimeout(r, 2000));
  await page.evaluate(() => {
    document.getElementById('toastContainer').innerHTML = '';
    document.getElementById('updateMyLocationBtn').click();
  });
  await new Promise((r) => setTimeout(r, 4000));
  console.log('更新我的位置:', JSON.stringify(await page.evaluate(() => ({
    toasts: [...document.querySelectorAll('#toastContainer .toast')].map((t) => t.textContent.trim()),
    btnDisabled: document.getElementById('updateMyLocationBtn')?.disabled,
    status: document.getElementById('myLocationStatus')?.textContent?.trim(),
  })), null, 2));

  console.log('[pageerror]', errs.length, errs.slice(0, 5));
  await browser.close();
})();
