/**
 * M5（docs/12-审计问题清单）：统一版本戳。
 * 背景：16 个主脚本各自手工维护 ?v=，同一天 b/h/i 多档并存，漏升戳导致浏览器/SW
 * 旧缓存命中、改动不生效；i18n 语言包戳还需 I18N_PACK_VERSION 与 index.html 双写同步。
 *
 * 本脚本以单一版本戳为事实来源，一键刷全：
 *  - index.html 中所有 ?v=<stamp>（CSS/JS/语言包 document.write）统一替换；
 *  - i18n.js 的 I18N_PACK_VERSION 同步为同一戳。
 *
 * 用法：
 *   node scripts/bump-version.js            # 自动生成新戳（今天日期 + 下一个字母）
 *   node scripts/bump-version.js 20261010a  # 指定新戳
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pubDir = path.join(root, 'public');
const i18nPath = path.join(root, 'public', 'js', 'i18n.js');

const STAMP_RE = /20\d{6}[a-z]/;

function htmlFiles() {
  return fs.readdirSync(pubDir).filter((f) => f.endsWith('.html'));
}

function allStamps(text) {
  const out = new Set();
  let m;
  const re = /v=(20\d{6}[a-z])/g;
  while ((m = re.exec(text))) out.add(m[1]);
  const im = text.match(/I18N_PACK_VERSION = '([^']+)'/);
  if (im) out.add(im[1]);
  return out;
}

function autoStamp(pagesText) {
  const now = new Date();
  const ymd = String(now.getFullYear()) +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0');
  let maxLetter = -1;
  for (const s of allStamps(pagesText)) {
    if (s.startsWith(ymd)) maxLetter = Math.max(maxLetter, s.charCodeAt(8) - 97);
  }
  return ymd + String.fromCharCode(97 + maxLetter + 1);
}

function main() {
  const arg = process.argv[2];
  if (arg !== undefined && !STAMP_RE.test(arg)) {
    console.error('❌ 版本戳格式应为 YYYYMMDD + 字母（如 20261010a）');
    process.exit(1);
  }
  // 全域覆盖范围：
  //  - public/*.html（CSS/JS/语言包 document.write 的 ?v=）
  //  - public/css/style.css（@import 子样式表也带 ?v=，历史实测漏过多次导致子样式改不动）
  //  - server/routes/share.js（服务端渲染的分享页 CSS 引用）
  //  - public/js/i18n.js（I18N_PACK_VERSION）
  const pageFiles = htmlFiles().map((f) => path.join(pubDir, f));
  const cssEntry = path.join(pubDir, 'css', 'style.css');
  const shareRoute = path.join(root, 'server', 'routes', 'share.js');
  const allFiles = [...pageFiles, cssEntry, shareRoute];
  const allText = allFiles.map((p) => {
    try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; }
  }).join('\n');
  const stamp = arg || autoStamp(allText);
  const oldStamps = allStamps(allText);

  let replaced = 0;
  for (const p of allFiles) {
    let html;
    try { html = fs.readFileSync(p, 'utf8'); } catch (e) { continue; }
    const next = html.replace(/v=20\d{6}[a-z]/g, function (m) { replaced++; return 'v=' + stamp; });
    if (next !== html) fs.writeFileSync(p, next, 'utf8');
  }

  const i18n = fs.readFileSync(i18nPath, 'utf8');
  const nextI18n = i18n.replace(/I18N_PACK_VERSION = '([^']+)'/, "I18N_PACK_VERSION = '" + stamp + "'");
  fs.writeFileSync(i18nPath, nextI18n, 'utf8');

  console.log('新版本戳: ' + stamp);
  console.log('覆盖文件: ' + allFiles.map((p) => path.relative(root, p)).join(', '));
  console.log('替换 ?v= 共 ' + replaced + ' 处；旧戳（本次统一覆盖）: ' + Array.from(oldStamps).join(', '));
  console.log('i18n.js I18N_PACK_VERSION 已同步。');
}

main();
