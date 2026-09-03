// 地理定位修复的浏览器实测：安全上下文 vs 非安全上下文的提示是否正确
const puppeteer = require('puppeteer');

const ORIGINS = [
  { label: '安全上下文 (localhost)', url: 'http://127.0.0.1:3456/' },
  { label: '非安全上下文 (局域网 IP)', url: 'http://192.168.2.104:3456/' },
];

(async () => {
  const browser = await puppeteer.launch({
    args: ['--no-sandbox'],
    protocolTimeout: 240000,
  });

  for (const o of ORIGINS) {
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e.message)));
    try {
      await page.goto(o.url, { waitUntil: 'networkidle2', timeout: 60000 });
      await new Promise((r) => setTimeout(r, 1500));

      const r = await page.evaluate(() => {
        const out = {
          isSecureContext: window.isSecureContext,
          hasGeoObject: !!navigator.geolocation,
          hasHelpers: {
            geoAvailability: typeof geoAvailability === 'function',
            ensureGeolocation: typeof ensureGeolocation === 'function',
            geoErrorKey: typeof geoErrorKey === 'function',
            toastGeoError: typeof toastGeoError === 'function',
          },
        };
        out.availability = typeof geoAvailability === 'function' ? geoAvailability() : null;
        // 直接调用守卫，看它弹出的是哪条提示
        if (typeof ensureGeolocation === 'function') {
          out.ensureResult = ensureGeolocation();
          const t = document.querySelector('#toastContainer .toast');
          out.toastText = t ? t.textContent.trim().slice(0, 160) : null;
        }
        // 模拟三种错误码，检查翻译分发
        if (typeof geoErrorKey === 'function') {
          out.errKeys = [1, 2, 3].map((code) => geoErrorKey({ code }));
        }
        return out;
      });

      console.log('\n=== ' + o.label + ' — ' + o.url + ' ===');
      console.log(JSON.stringify(r, null, 2));
      console.log('[pageerror]', errs.length, errs.slice(0, 3));
    } catch (e) {
      console.log('\n=== ' + o.label + ' ===\n访问失败:', e.message);
    }
    await page.close();
  }

  await browser.close();
})();
