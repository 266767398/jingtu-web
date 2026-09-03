// 反验证：把旧写法注入回去，确认新增的 geo 测试真会变红（不是空跑的摆设）
const fs = require('fs');
const path = require('path');
const P = path.join(__dirname, '..', '..', 'public', 'js', 'map.js');
const BAK = P + '.injbak';

if (process.argv[2] === 'restore') {
  fs.copyFileSync(BAK, P);
  fs.unlinkSync(BAK);
  console.log('已还原 map.js');
  process.exit(0);
}

fs.copyFileSync(P, BAK);
let s = fs.readFileSync(P, 'utf8');
const before = s;

s = s.replace(/if \(!ensureGeolocation\(\)\) return;/,
  "if (!navigator.geolocation) { toast(__('profile.gps_not_supported'), 'error'); return; }");
s = s.replace(/      toastGeoError\(err\);/,
  "      if (err.code === 1) toast(__('map.enable_gps'), 'error');");

if (s === before) { console.log('!! 注入锚点没匹配上，反验证无效'); process.exit(1); }
fs.writeFileSync(P, s, 'utf8');
console.log('已注入旧写法，现在跑测试应当变红');
