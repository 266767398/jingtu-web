// 补充 geo.* 系列文案（地理定位错误的统一提示）
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', '..', 'public', 'js', 'languages');

const T = {
  'geo.insecure_context': {
    zh: '⚠️ 浏览器仅允许在安全来源使用定位。当前通过 {origin} 访问，属于非安全来源，'
      + '浏览器会直接拒绝且不会弹出授权框。请改用 https:// 域名，或在本机用 http://localhost:3456 访问。',
    en: '⚠️ Browsers only allow geolocation on secure origins. You are on {origin}, '
      + 'which is not secure, so the browser blocks it without ever showing a permission prompt. '
      + 'Use an https:// address, or open http://localhost:3456 on this machine.',
    ja: '⚠️ ブラウザは安全なオリジンでのみ位置情報を許可します。現在 {origin} でアクセスしており、'
      + '安全でないため、許可ダイアログが表示されずに拒否されます。https:// のアドレスか、'
      + '本機では http://localhost:3456 をご利用ください。',
    fr: '⚠️ Les navigateurs n\'autorisent la géolocalisation que sur des origines sécurisées. '
      + 'Vous êtes sur {origin}, qui n\'est pas sécurisée : le navigateur la bloque sans jamais '
      + 'afficher de demande d\'autorisation. Utilisez une adresse https:// ou http://localhost:3456.',
    de: '⚠️ Browser erlauben Standortzugriff nur bei sicheren Ursprüngen. Sie nutzen {origin}, '
      + 'was nicht sicher ist – der Browser blockiert ohne jede Berechtigungsabfrage. '
      + 'Verwenden Sie eine https://-Adresse oder http://localhost:3456.',
    ru: '⚠️ Браузеры разрешают геолокацию только для безопасных источников. Вы используете {origin}, '
      + 'который небезопасен, поэтому браузер блокирует запрос, не показывая окно разрешения. '
      + 'Используйте адрес https:// или http://localhost:3456.',
  },
  'geo.unsupported': {
    zh: '您的浏览器不支持定位功能',
    en: 'Your browser does not support geolocation',
    ja: 'お使いのブラウザは位置情報に対応していません',
    fr: 'Votre navigateur ne prend pas en charge la géolocalisation',
    de: 'Ihr Browser unterstützt keine Standortbestimmung',
    ru: 'Ваш браузер не поддерживает геолокацию',
  },
  'geo.permission_denied': {
    zh: '定位权限被拒绝。请在浏览器地址栏左侧的图标里允许"位置"权限后重试。',
    en: 'Location permission denied. Allow "Location" via the icon in the address bar and retry.',
    ja: '位置情報の許可が拒否されました。アドレスバー左のアイコンから「位置情報」を許可して再試行してください。',
    fr: 'Autorisation de localisation refusée. Autorisez « Localisation » via l\'icône de la barre d\'adresse.',
    de: 'Standortzugriff verweigert. Erlauben Sie „Standort" über das Symbol in der Adressleiste.',
    ru: 'Доступ к геолокации запрещён. Разрешите «Местоположение» через значок в адресной строке.',
  },
  'geo.unavailable': {
    zh: '无法获取位置，请检查设备的定位服务是否已开启',
    en: 'Unable to get your location. Check that device location services are on.',
    ja: '位置を取得できません。端末の位置情報サービスが有効か確認してください。',
    fr: 'Impossible d\'obtenir votre position. Vérifiez les services de localisation de l\'appareil.',
    de: 'Standort konnte nicht ermittelt werden. Prüfen Sie die Ortungsdienste des Geräts.',
    ru: 'Не удалось определить местоположение. Проверьте службы геолокации устройства.',
  },
  'geo.timeout': {
    zh: '定位超时，请到开阔处再试一次',
    en: 'Location request timed out. Try again in an open area.',
    ja: '位置情報の取得がタイムアウトしました。開けた場所で再試行してください。',
    fr: 'Délai de localisation dépassé. Réessayez dans un espace dégagé.',
    de: 'Zeitüberschreitung bei der Ortung. Versuchen Sie es im Freien erneut.',
    ru: 'Время ожидания геолокации истекло. Попробуйте на открытой местности.',
  },
  'geo.failed': {
    zh: '定位失败',
    en: 'Failed to get location',
    ja: '位置情報の取得に失敗しました',
    fr: 'Échec de la localisation',
    de: 'Standortbestimmung fehlgeschlagen',
    ru: 'Не удалось определить местоположение',
  },
};

for (const lang of ['zh', 'en', 'ja', 'fr', 'de', 'ru']) {
  const p = path.join(DIR, lang + '.js');
  let src = fs.readFileSync(p, 'utf8');
  const lines = [];
  for (const [key, vals] of Object.entries(T)) {
    const re = new RegExp('["\']' + key.replace(/\./g, '\\.') + '["\']\\s*:');
    if (re.test(src)) continue;
    lines.push('  ' + JSON.stringify(key) + ': ' + JSON.stringify(vals[lang]) + ',');
  }
  if (!lines.length) { console.log(lang, '无需补充'); continue; }

  const idx = src.lastIndexOf('};');
  if (idx < 0) { console.log(lang, '!! 找不到对象结尾'); continue; }
  // 前一个属性可能没有尾逗号，先补上再追加，否则会拼出语法错误
  let head = src.slice(0, idx);
  if (!/,\s*$/.test(head)) head = head.replace(/(\S)(\s*)$/, '$1,$2');
  const out = head + lines.join('\n') + '\n' + src.slice(idx);
  try {
    new Function(out);
  } catch (e) {
    console.log(lang, '!! 生成结果语法错误，未写入:', e.message);
    continue;
  }
  fs.writeFileSync(p, out, 'utf8');
  console.log(lang, '补充了', lines.length, '条');
}
