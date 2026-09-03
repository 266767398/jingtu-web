// 全量 i18n 审计：同时扫描 JS 的 __() 与 HTML 的 data-i18n* 属性，
// 且不再要求键名必须含点号（edit / delete / logout 这类单词键以前从未被检查）
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const PUB = path.join(ROOT, 'public');
const LANG_DIR = path.join(PUB, 'js', 'languages');

function collectJsKeys() {
  const keys = new Set();
  const dir = path.join(PUB, 'js');
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'languages') walk(f); continue; }
      if (!e.name.endsWith('.js')) continue;
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\b__\(\s*(['"`])([^'"`]+)\1/g)) keys.add(m[2]);
    }
  };
  walk(dir);
  return keys;
}

function collectHtmlKeys() {
  const keys = new Set();
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  for (const m of html.matchAll(/data-i18n(?:-[a-z-]+)?\s*=\s*(['"])([^'"]+)\1/g)) {
    m[2].split(/[;,]/).map(s => s.trim()).filter(Boolean).forEach(k => keys.add(k));
  }
  for (const m of html.matchAll(/\b__\(\s*(['"])([^'"]+)\1/g)) keys.add(m[2]);
  return keys;
}

function loadLocale(file) {
  let src = fs.readFileSync(path.join(LANG_DIR, file), 'utf8');
  // 必须先去掉注释：键值对的匹配依赖前面是 `{` 或 `,`，
  // 而一段注释会把逗号和键名隔开，导致每个分节注释后的第一个键被漏检。
  src = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const keys = new Set();
  for (const m of src.matchAll(/(?:^|[{,]\s*)(?:(['"])([^'"]+)\1|([A-Za-z_$][\w$]*))\s*:/g)) {
    keys.add(m[2] || m[3]);
  }
  return keys;
}

const jsKeys = collectJsKeys();
const htmlKeys = collectHtmlKeys();
const all = new Set([...jsKeys, ...htmlKeys]);
console.log(`引用的键：JS ${jsKeys.size} 个 / HTML ${htmlKeys.size} 个 / 去重后 ${all.size} 个\n`);

const locales = fs.readdirSync(LANG_DIR).filter(f => /^[a-z]{2}(-[A-Za-z]+)?\.js$/.test(f));
const report = {};
for (const f of locales) {
  const have = loadLocale(f);
  const missing = [...all].filter(k => !have.has(k)).sort();
  report[f] = missing;
  console.log(`${f.padEnd(10)} 已有 ${String(have.size).padStart(5)} 键，缺 ${missing.length}`);
  if (missing.length && missing.length <= 40) missing.forEach(k => console.log('     - ' + k));
}
fs.writeFileSync(path.join(__dirname, 'i18n-missing.json'), JSON.stringify(report, null, 2), 'utf8');
console.log('\n明细已写入 scripts/i18n-missing.json');
