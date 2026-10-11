/**
 * M4（docs/12-审计问题清单）：语言包键序校验。
 * 背景：6 份语言文件（zh/en/ja/fr/de/ru）历史上键数一致但同键行号错位（各自手改、插入位置不同），
 * 无法按行号/diff 校验，新增文案容易漏补语言。
 *
 * 本脚本按 Object.keys 顺序对比 6 份文件的键集合：
 *  - 硬性失败（exit 1）：任一文件与 zh 基准存在缺键/多键（新增文案漏补、删键未同步）；
 *  - 软性警告：键序与 zh 基准错位（提示可手工对齐，不阻塞）。
 *
 * 用法：node scripts/check-lang-keys.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const LANGS = [
  { file: 'zh.js', varName: '_LANG_ZH' },
  { file: 'en.js', varName: '_LANG_EN' },
  { file: 'ja.js', varName: '_LANG_JA' },
  { file: 'fr.js', varName: '_LANG_FR' },
  { file: 'de.js', varName: '_LANG_DE' },
  { file: 'ru.js', varName: '_LANG_RU' },
];

const LANG_DIR = path.join(__dirname, '..', 'public', 'js', 'languages');

function loadKeys(entry) {
  const src = fs.readFileSync(path.join(LANG_DIR, entry.file), 'utf8');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: entry.file });
  const pack = sandbox.window[entry.varName];
  if (!pack || typeof pack !== 'object') {
    throw new Error(entry.file + ': 解析失败，未找到 window.' + entry.varName);
  }
  return Object.keys(pack);
}

const all = new Map();
for (const e of LANGS) all.set(e.file, loadKeys(e));

const zh = all.get('zh.js');
const zhSet = new Set(zh);
let failed = false;
let warnings = 0;

console.log('zh.js: ' + zh.length + ' 键（基准）\n');
for (const [file, keys] of all) {
  if (file === 'zh.js') continue;
  const set = new Set(keys);
  const missing = zh.filter((k) => !set.has(k));
  const extra = keys.filter((k) => !zhSet.has(k));
  if (missing.length || extra.length) {
    failed = true;
    console.log('[FAIL] ' + file + ': 键集合与 zh 不一致');
    if (missing.length) console.log('  缺键 (' + missing.length + '): ' + missing.slice(0, 20).join(', ') + (missing.length > 20 ? ' ...' : ''));
    if (extra.length) console.log('  多键 (' + extra.length + '): ' + extra.slice(0, 20).join(', ') + (extra.length > 20 ? ' ...' : ''));
  }
  const orderDrift = keys.filter((k, i) => zh[i] !== k).length;
  if (orderDrift > 0) {
    warnings++;
    console.log('[WARN] ' + file + ': 键序与 zh 错位 ' + orderDrift + ' 处（可手工对齐，不阻塞）');
  }
  console.log('  ' + file + ': ' + keys.length + ' 键' + (missing.length + extra.length === 0 ? '（键集合一致）' : ''));
}

console.log(failed ? '\n❌ 键集合不一致，请补齐缺键/删除多键后重跑。' : '\n' + (warnings ? '✅ 键集合一致（' + warnings + ' 个文件存在键序错位警告）' : '✅ 6 份语言包键集合与键序全部一致'));
process.exit(failed ? 1 : 0);
