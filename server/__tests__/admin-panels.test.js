/**
 * 后台面板补全 —— 文件存放 / 安全告警 / Webhook 三个接口族的接线守卫。
 *
 * 背景：docs/jingtu-docs.html「接口族（11 族）」标注这三个族为「部分无 UI・管理员接口族」。
 * 后端 route 早已存在（files.js / security_routes.js / webhooks.js），
 * 前端却零调用（此前只能 curl 直连）。本用例把「接入即视为完成」的最小闭环固化为测试：
 *   ① index.html 侧栏出现对应入口按钮；
 *   ② index.html 有对应 data-panel 容器与约定 id；
 *   ③ loader.js ROUTE_MODULES / TAB_MODULES.admin 登记三个懒加载模块；
 *   ④ 三个模块文件存在且暴露约定入口函数；
 *   ⑤ CSP 下不得使用内联 onclick（属性型处理器会被 nonce 拦截）；
 *   ⑥ admin-ui.js PANEL_LOADERS 映射懒加载入口；
 *   ⑦ 新模块用到的 auto_admin_* i18n 键在 zh 齐全且 6 语言键集同构（check-lang-keys 同规则）。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const PUB = path.join(ROOT, 'public');
const JS_DIR = path.join(PUB, 'js');
const LANGS = [
  { file: 'zh.js', varName: '_LANG_ZH' },
  { file: 'en.js', varName: '_LANG_EN' },
  { file: 'ja.js', varName: '_LANG_JA' },
  { file: 'fr.js', varName: '_LANG_FR' },
  { file: 'de.js', varName: '_LANG_DE' },
  { file: 'ru.js', varName: '_LANG_RU' }
];

const read = (p) => fs.readFileSync(p, 'utf8');
const html = read(path.join(PUB, 'index.html'));
const loaderJs = read(path.join(JS_DIR, 'loader.js'));
const adminUiJs = read(path.join(JS_DIR, 'admin-ui.js'));

const NEW_PANELS = {
  files: { file: 'admin-files.js', loaders: ['loadAdminFiles'], inits: ['initAdminFilesEvents'] },
  security: { file: 'admin-security.js', loaders: ['loadAdminSecurity'], inits: ['initAdminSecurityEvents'] },
  webhooks: { file: 'admin-webhooks.js', loaders: ['loadAdminWebhooks'], inits: ['initAdminWebhooksEvents'] }
};

describe('后台面板补全：文件/安全/Webhook 接线闭合', () => {
  test('index.html 侧栏出现三个新入口按钮', () => {
    const nav = (html.match(/<nav class="admin-nav" id="adminNav">([\s\S]*?)<\/nav>/) || [])[1] || '';
    for (const target of Object.keys(NEW_PANELS)) {
      expect(nav).toMatch(new RegExp('data-target="' + target + '"'));
    }
  });

  test('index.html 存在三个 data-panel 容器与约定 id', () => {
    const ids = { files: 'adminFilesSection', security: 'adminSecuritySection', webhooks: 'adminWebhooksSection' };
    for (const [target, id] of Object.entries(ids)) {
      expect(html).toMatch(new RegExp('data-panel="' + target + '"'));
      expect(html).toMatch(new RegExp('id="' + id + '"'));
    }
  });

  test('loader.js 登记三个懒加载模块（ROUTE_MODULES + TAB_MODULES.admin）', () => {
    const routeBlock = (loaderJs.match(/ROUTE_MODULES\s*=\s*\[([\s\S]*?)\];/) || [])[1] || '';
    const adminTab = (loaderJs.match(/admin:\s*\[([\s\S]*?)\]/) || [])[1] || '';
    for (const [, cfg] of Object.entries(NEW_PANELS)) {
      expect(routeBlock).toMatch(new RegExp("'" + cfg.file + "'"));
      expect(adminTab).toMatch(new RegExp("'" + cfg.file + "'"));
    }
  });

  test('三个模块文件存在且暴露约定入口函数', () => {
    for (const [, cfg] of Object.entries(NEW_PANELS)) {
      const pth = path.join(JS_DIR, cfg.file);
      expect(fs.existsSync(pth)).toBe(true);
      const src = read(pth);
      for (const fn of [...cfg.loaders, ...cfg.inits]) {
        expect(src).toMatch(new RegExp('function\\s+' + fn + '\\s*\\('));
      }
    }
  });

  test('CSP 兼容：新模块不得使用内联 onclick', () => {
    for (const [, cfg] of Object.entries(NEW_PANELS)) {
      const pth = path.join(JS_DIR, cfg.file);
      if (!fs.existsSync(pth)) continue;
      expect(read(pth)).not.toMatch(/onclick\s*=/);
    }
  });

  test('admin-ui.js PANEL_LOADERS 映射三个面板懒加载入口', () => {
    const block = (adminUiJs.match(/PANEL_LOADERS\s*=\s*\{([\s\S]*?)\n\s*\};/) || [])[1] || '';
    for (const target of Object.keys(NEW_PANELS)) {
      expect(block).toMatch(new RegExp('^\\s*' + target + ':', 'm'));
    }
  });

  test('新模块的 auto_admin_files/sec/wh_* i18n 键在 zh 齐全且 6 语言键集同构', () => {
    // 与 scripts/check-lang-keys.js 同法：vm 求值取 Object.keys，避免正则误捕值内引号
    const langKeys = {};
    for (const e of LANGS) {
      const sandbox = { window: {} };
      vm.createContext(sandbox);
      vm.runInContext(read(path.join(JS_DIR, 'languages', e.file)), sandbox, { filename: e.file });
      langKeys[e.file] = Object.keys(sandbox.window[e.varName] || {});
    }
    const zhKeys = langKeys['zh.js'];
    const zhSet = new Set(zhKeys);
    // 6 语言键集与 zh 完全同构（缺/多均失败，同 check-lang-keys 硬规则）
    for (const e of LANGS) {
      const set = new Set(langKeys[e.file]);
      expect(zhKeys.filter((k) => !set.has(k))).toEqual([]);
      expect(langKeys[e.file].filter((k) => !zhSet.has(k))).toEqual([]);
    }
    // 新模块引用的 auto_admin_* 键必须存在于 zh（即全部语言）
    const needed = new Set();
    for (const [, cfg] of Object.entries(NEW_PANELS)) {
      const pth = path.join(JS_DIR, cfg.file);
      if (!fs.existsSync(pth)) continue;
      for (const m of read(pth).matchAll(/auto_admin_(?:files|sec|wh)_[\w]+/g)) needed.add(m[0]);
    }
    for (const k of needed) expect(zhSet.has(k)).toBe(true);
  });
});

describe('激活码管理面板接线闭合', () => {
  test('admin-nav 出现激活码管理入口（data-target="activation"）', () => {
    const nav = (html.match(/<nav class="admin-nav" id="adminNav">([\s\S]*?)<\/nav>/) || [])[1] || '';
    expect(nav).toMatch(/data-target="activation"/);
  });

  test('index.html 存在 activation 面板容器与约定 id', () => {
    expect(html).toMatch(/data-panel="activation"/);
    expect(html).toMatch(/id="activationCodesSection"/);
    expect(html).toMatch(/id="activationCodesList"/);
  });

  test('loader.js 登记 admin-activation.js', () => {
    expect(loaderJs).toContain('admin-activation.js');
  });

  test('admin-ui.js PANEL_LOADERS 映射 activation 懒加载入口', () => {
    const block = (adminUiJs.match(/PANEL_LOADERS\s*=\s*\{([\s\S]*?)\n\s*\};/) || [])[1] || '';
    expect(block).toMatch(/^\s*activation:/m);
  });

  test('admin-activation.js 存在且暴露约定入口函数', () => {
    const pth = path.join(JS_DIR, 'admin-activation.js');
    expect(fs.existsSync(pth)).toBe(true);
    const src = read(pth);
    for (const fn of ['loadActivationCodesPanel', 'initActivationPanelEvents']) {
      expect(src).toMatch(new RegExp('function\\s+' + fn + '\\s*\\('));
    }
  });

  test('CSP 兼容：激活码面板不得使用内联 onclick', () => {
    expect(read(path.join(JS_DIR, 'admin-activation.js'))).not.toMatch(/onclick\s*=/);
  });

  test('admin.activation.* i18n 键在 zh 齐全且 6 语言键集同构', () => {
    const langKeys = {};
    for (const e of LANGS) {
      const sandbox = { window: {} };
      vm.createContext(sandbox);
      vm.runInContext(read(path.join(JS_DIR, 'languages', e.file)), sandbox, { filename: e.file });
      langKeys[e.file] = Object.keys(sandbox.window[e.varName] || {});
    }
    const zhKeys = langKeys['zh.js'];
    const zhSet = new Set(zhKeys);
    expect(zhSet.has('admin.activation.stat_total')).toBe(true);
    expect(zhSet.has('admin.activation.exported_n')).toBe(true);
    for (const e of LANGS) {
      const set = new Set(langKeys[e.file]);
      expect(zhKeys.filter((k) => !set.has(k))).toEqual([]);
      expect(langKeys[e.file].filter((k) => !zhSet.has(k))).toEqual([]);
    }
  });
});