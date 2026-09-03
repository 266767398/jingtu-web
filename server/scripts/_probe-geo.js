// 验证假说：非安全上下文（http + 局域网 IP）下 geolocation 不弹窗、直接 code 1 失败
const puppeteer = require('puppeteer');

const LAN = process.env.__LAN_ORIGIN || 'http://192.168.2.104:3456';
const LOCAL = 'http://127.0.0.1:3456';

async function probe(origin, label) {
  const b = await puppeteer.launch({ args: ['--no-sandbox'], protocolTimeout: 120000 });
  const page = await b.newPage();
  try {
    await page.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    const r = await page.evaluate(() => new Promise((resolve) => {
      const out = {
        origin: location.origin,
        isSecureContext: window.isSecureContext,
        hasGeolocationObject: !!navigator.geolocation,
      };
      if (!navigator.geolocation) { out.result = 'no-api'; return resolve(out); }
      const t = setTimeout(() => { out.result = 'timeout(无回调,可能在等弹窗)'; resolve(out); }, 6000);
      navigator.geolocation.getCurrentPosition(
        () => { clearTimeout(t); out.result = 'success'; resolve(out); },
        (e) => {
          clearTimeout(t);
          out.result = 'error';
          out.code = e.code;
          out.codeName = { 1: 'PERMISSION_DENIED', 2: 'POSITION_UNAVAILABLE', 3: 'TIMEOUT' }[e.code];
          out.message = e.message;
          resolve(out);
        },
        { enableHighAccuracy: true, timeout: 5000 }
      );
    }));
    console.log('[' + label + ']', JSON.stringify(r, null, 1));
  } catch (e) {
    console.log('[' + label + '] 访问失败:', String(e).slice(0, 120));
  }
  await b.close();
}

(async () => {
  await probe(LOCAL, 'localhost(安全上下文)');
  await probe(LAN, '局域网IP(非安全上下文)');
})();
