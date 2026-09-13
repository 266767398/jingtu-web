// 全量 i18n 审计：同时扫描 JS 的 __() 与 HTML 的 data-i18n* 属性，
// 且不再要求键名必须含点号（edit / delete / logout 这类单词键以前从未被检查）
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const PUB = path.join(ROOT, 'public');
const LANG_DIR = path.join(PUB, 'js', 'languages');

function collectJsKeys() {
  const keys = new Set();
  const prefixes = new Set();
  const dir = path.join(PUB, 'js');
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) {
        // languages 是键的来源而非使用者；下划线开头的目录（_unwired/_archive）
        // 不会被任何页面加载，扫它们只会产出「死代码缺键」的假阳性
        // （如 admin.db.confirm_* 仅存在于 _unwired/admin-db.js）。
        // 与 round6 守卫测试的 SKIP_DIRS 口径保持一致。
        if (e.name !== 'languages' && !e.name.startsWith('_')) walk(f);
        continue;
      }
      if (!e.name.endsWith('.js')) continue;
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\b__\(\s*(['"`])([^'"`]+)\1/g)) {
        // 尾随 `+` 说明这是运行时拼接的前缀（如 __('nav.' + tab)），
        // 字面量本身永远不该被当成完整键 —— 计入它只会产出假阳性，
        // 真正的缺键反而被淹没（P1-8 与 events.month_1..12 都是这么漏掉的）。
        if (src.slice(m.index + m[0].length).search(/^\s*\+/) === 0) prefixes.add(m[2]);
        else keys.add(m[2]);
      }
    }
  };
  walk(dir);
  return { keys, prefixes };
}

function collectHtmlKeys() {
  const keys = new Set();
  const prefixes = new Set();
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  for (const m of html.matchAll(/data-i18n(?:-[a-z-]+)?\s*=\s*(['"])([^'"]+)\1/g)) {
    m[2].split(/[;,]/).map(s => s.trim()).filter(Boolean).forEach(k => keys.add(k));
  }
  for (const m of html.matchAll(/\b__\(\s*(['"])([^'"]+)\1/g)) {
    if (html.slice(m.index + m[0].length).search(/^\s*\+/) === 0) prefixes.add(m[2]);
    else keys.add(m[2]);
  }
  return { keys, prefixes };
}

/**
 * 反向检查：语言包里是否存在「拼接到一半」的前缀键。
 * 这类键运行时永远命中不了（拼接结果一定带后缀），是 P1-8 那类缺陷的直接痕迹。
 */
function findOrphanPrefixKeys(prefixes) {
  const orphans = new Set();
  for (const p of prefixes) {
    for (const localeFile of fs.readdirSync(LANG_DIR).filter(x => /^[a-z]{2}(-[A-Za-z]+)?\.js$/.test(x))) {
      const src = fs.readFileSync(path.join(LANG_DIR, localeFile), 'utf8');
      const re = new RegExp('["\']' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["\']\\s*:');
      if (re.test(src)) orphans.add(`${localeFile.replace('.js', '')}: ${p}`);
    }
  }
  return orphans;
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

const js = collectJsKeys();
const htmlc = collectHtmlKeys();
const all = new Set([...js.keys, ...htmlc.keys]);
const prefixes = new Set([...js.prefixes, ...htmlc.prefixes]);
console.log(`引用的键：JS ${js.keys.size} 个 / HTML ${htmlc.keys.size} 个 / 去重后 ${all.size} 个`);
console.log(`动态拼接前缀 ${prefixes.size} 个（后缀由运行时决定，本脚本无法校验，` +
  `需由 round6-sync-regressions.test.js 的「运行时拼接键」守卫逐个列举）：` +
  [...prefixes].sort().join('、') + '\n');

const locales = fs.readdirSync(LANG_DIR).filter(f => /^[a-z]{2}(-[A-Za-z]+)?\.js$/.test(f));
const report = {};
for (const f of locales) {
  const have = loadLocale(f);
  const missing = [...all].filter(k => !have.has(k)).sort();
  // 与某个拼接前缀完全相同的键 = 语言包里残留了半截前缀，单列出来提醒清理
  const orphan = [...have].filter(k => prefixes.has(k)).sort();
  report[f] = { missing, orphanPrefixKeys: orphan };
  console.log(`${f.padEnd(10)} 已有 ${String(have.size).padStart(5)} 键，缺 ${missing.length}，半截前缀键 ${orphan.length}`);
  if (missing.length && missing.length <= 40) missing.forEach(k => console.log('     - ' + k));
  orphan.forEach(k => console.log('     ! 半截前缀键：' + k));
}
const summary = findOrphanPrefixKeys(prefixes);
if (summary.size) console.log('\n跨语言残留：' + [...summary].join('、'));
fs.writeFileSync(path.join(__dirname, 'i18n-missing.json'), JSON.stringify(report, null, 2), 'utf8');
console.log('\n明细已写入 scripts/i18n-missing.json');
