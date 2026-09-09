/**
 * UI 设计系统与移动端一致性回归测试
 *
 * 覆盖两轮审查发现的问题：
 *   第一轮（jsdom 层叠分析）
 *     1. .btn 基础样式在多个文件中重复定义、互相覆盖
 *     2. .btn-red / .btn-cancel 在 JS 中被使用却从未定义样式
 *     3. 移动端底部栏缺少 admin-only，普通成员能看到管理入口
 *     4. 移动端「全部功能」菜单键盘不可达、无 Escape、无对话框语义
 *
 *   第二轮（Puppeteer 真实浏览器渲染）
 *     jsdom 不做布局计算、不解析 var()，只能回答"哪条声明在层叠中胜出"，
 *     回答不了"页面看起来对不对"。下面 describe('regressions found by
 *     real-browser rendering') 里的每一项都是真实浏览器截图才暴露出来的，
 *     这里用静态断言把它们钉住，避免再次回归。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const PUB = path.join(__dirname, '..', '..', 'public');
const read = (...p) => fs.readFileSync(path.join(PUB, ...p), 'utf8');

// index.html 的真实加载顺序：style.css 的 @import 链，然后三个 <link>。
// 注意 animations.css / checkin.css / achievements.css 从未被任何页面加载，
// 所以"扫描 css 目录所有文件"会得出错误结论，这里只能算实际加载的这 11 个。
const CSS_ORDER = [
  '01-variables.css', '02-base.css', '03-layout.css', '04-components.css',
  '05-auth.css', '06-members.css', '07-profile.css', '08-chat-posts.css',
  'ui-enhance.css', 'favorites.css', '99-design-system.css'
];

let win;
beforeAll(() => {
  const css = CSS_ORDER.map(f => read('css', f)).join('\n');
  const dom = new JSDOM(`<!doctype html><html><head><style>${css}</style></head><body>
    <button class="btn" id="plain"></button>
    <button class="btn btn-sm" id="sm"></button>
    <button class="btn btn-xs" id="xs"></button>
    <button class="btn btn-icon" id="icon"></button>
    <div class="card" id="card"></div>
  </body></html>`);
  win = dom.window;
});

const styleOf = id => win.getComputedStyle(win.document.getElementById(id));

const allSelectors = () => {
  const out = [];
  const walk = rules => {
    for (const r of rules) {
      if (r.selectorText) out.push(r.selectorText);
      if (r.cssRules) walk(r.cssRules);
    }
  };
  walk(win.document.styleSheets[0].cssRules);
  return out;
};
const hasSelector = sel => allSelectors().some(s => s.split(',').some(x => x.trim() === sel));
// 检测"某条声明是否真的存在"时必须先去掉注释，
// 否则会匹配到解释这条声明为何被移除的注释本身
const stripComments = css => css.replace(/\/\*[\s\S]*?\*\//g, '');

describe('button design system', () => {
  // jsdom 不解析 var()，因此断言的是"哪条声明在层叠中胜出"，
  // 这恰好正是本节要验证的东西：设计系统层必须压过历史遗留定义。
  test('.btn has a single winning base rule with a stable height', () => {
    expect(styleOf('plain').getPropertyValue('min-height')).toBe('var(--ctl-h-md)');
  });

  test('.btn padding no longer alternates between 8px16 and 10px20', () => {
    // 同一个 .btn 在 02-base 与 ui-enhance 里 padding 不一致，
    // 导致相邻按钮高度差 4px。现在统一由设计系统层给出。
    const s = styleOf('plain');
    expect(s.getPropertyValue('padding-left')).toBe('16px');
    expect(s.getPropertyValue('padding-right')).toBe('16px');
    // 上下 padding 归零，高度完全交给 min-height 决定，避免两者相加产生偏差
    expect(s.getPropertyValue('padding-top')).toBe('0px');
  });

  test('.btn font-weight is unified (was 500 in one file and 600 in another)', () => {
    expect(styleOf('plain').getPropertyValue('font-weight')).toBe('600');
  });

  test('.btn transition does not use "all", which would hijack transform', () => {
    // transition:all 会把 hover 时的 transform 也纳入过渡，
    // 与卡片自身的位移动画打架。
    const t = styleOf('plain').getPropertyValue('transition');
    expect(t).not.toMatch(/\ball\b/);
    expect(t.length).toBeGreaterThan(0);
  });

  test('size modifiers override the base height', () => {
    expect(styleOf('sm').getPropertyValue('min-height')).toBe('var(--ctl-h-sm)');
    expect(styleOf('xs').getPropertyValue('min-height')).toBe('var(--ctl-h-xs)');
  });

  test('.btn-icon stays square so icon buttons do not collapse', () => {
    const s = styleOf('icon');
    expect(s.getPropertyValue('width')).toBe(s.getPropertyValue('min-height'));
    expect(s.getPropertyValue('padding-left')).toBe('0px');
  });

  test('.card radius comes from a token rather than a hardcoded value', () => {
    expect(styleOf('card').getPropertyValue('border-radius')).toMatch(/^var\(--/);
  });
});

describe('classes used in JS must actually be styled', () => {
  test('every btn-* variant referenced in markup or scripts has a rule', () => {
    // .btn-red / .btn-cancel 曾在 JS 里被拼接进 className，却从没有对应样式，
    // 于是"删除"按钮渲染成和普通按钮一样，用户看不出这是危险操作。
    const sources = [read('index.html')];
    const jsDir = path.join(PUB, 'js');
    const collect = dir => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'languages') collect(full); continue; }
        if (e.name.endsWith('.js')) sources.push(fs.readFileSync(full, 'utf8'));
      }
    };
    collect(jsDir);

    const used = new Set();
    for (const src of sources) {
      // 前面必须不是连字符或单词字符，否则 login-btn-shimmer、tab-btn-home
      // 这类无关的类名/id 会被误当成 .btn 的变体
      for (const m of src.matchAll(/(?<![-\w])btn-[a-z0-9]+(?:-[a-z0-9]+)*\b/g)) used.add(m[0]);
    }
    expect(used.size).toBeGreaterThan(5);

    const missing = [...used].filter(c => !hasSelector('.' + c));
    expect(missing).toEqual([]);
  });

  test('.btn exposes a visible keyboard focus state', () => {
    // 只靠 :hover 的按钮对键盘用户完全没有反馈
    expect(allSelectors().some(s => /\.btn[^,]*:focus-visible/.test(s))).toBe(true);
  });
});

describe('regressions found by real-browser rendering', () => {
  const ds = () => read('css', '99-design-system.css');

  test('desktop must not show the mobile "more" button', () => {
    // 上一轮自己引入的回归：99-design-system.css 的 .btn{display:inline-flex}
    // 与 ui-enhance.css 的 .mobile-tab-menu-btn{display:none} 同为 (0,1,0)
    // 特异性，后加载者胜出，于是桌面端冒出 ☰ 并把「管理」标签挤出视口。
    // 凡"默认隐藏的按钮"都必须在设计系统层显式重申。
    const dom = new JSDOM(
      `<!doctype html><html><head><style>${CSS_ORDER.map(f => read('css', f)).join('\n')}</style></head>` +
      `<body><button class="btn btn-sm btn-outline mobile-tab-menu-btn"></button></body></html>`
    );
    const el = dom.window.document.querySelector('.mobile-tab-menu-btn');
    expect(dom.window.getComputedStyle(el).display).toBe('none');
  });

  test('the "more" button is re-shown inside the mobile breakpoint', () => {
    const mobileBlock = ds().slice(ds().indexOf('@media (max-width: 768px)'));
    expect(mobileBlock).toMatch(/\.mobile-tab-menu-btn\s*\{[^}]*display:\s*inline-flex/);
  });

  test('buttons never get squeezed by their flex container', () => {
    // 成员卡片里「查看卡片」曾被 flex 压成 38px 宽的竖条
    expect(ds()).toMatch(/\.btn[^{]*\{[^}]*flex-shrink:\s*0/);
  });

  test('controls that used to keep the native browser look are styled', () => {
    // 这些类此前只有尺寸/字号规则，从没有 background/border/color，
    // 于是保留浏览器原生外观（rgb(240,240,240) + border:2px outset），
    // 在深色主题上像 Windows 98 的白方块。.bell-btn / .theme-btn /
    // .back-to-top 出现在全部 15 个标签页。
    for (const cls of ['.bell-btn', '.theme-btn', '.back-to-top']) {
      const block = ds().match(new RegExp(`\\${cls}[^{]*\\{[^}]*\\}`, 'g'));
      expect([cls, Array.isArray(block) && block.length > 0]).toEqual([cls, true]);
      const joined = block.join('');
      expect([cls, /background/.test(joined)]).toEqual([cls, true]);
      expect([cls, /border/.test(joined)]).toEqual([cls, true]);
    }
  });

  test('the header avatar has an explicit size', () => {
    // .user-avatar-sm 全站只有 hover 动画、没有 width/height，
    // <img> 按原始像素渲染把顶栏撑到 74px，
    // 移动端更把 .header-actions 挤成 4 行、顶栏总高 213px（视口的 25%）。
    expect(ds()).toMatch(/\.user-avatar-sm\s*\{[^}]*width:\s*\d+px[^}]*height:\s*\d+px/);
  });

  test('hero text sits above a mask so it stays readable over the artwork', () => {
    // 首页 hero 背景是大字艺术图，白色标题直接压在上面几乎看不清
    expect(ds()).toMatch(/\.hero-overlay::before/);
  });

  test('online count clears its skeleton wherever it is written', () => {
    // #dashOnline 初始带 .skeleton-stat（32x24 灰色渐变块），只写 textContent
    // 而不摘掉这个 class，数字会被占位块盖住 —— 看上去就是「一直在加载」。
    // 在线人数现在只有 WebSocket 一个来源，只需守住这一处。
    const main = read('js', 'main.js');
    const mi = main.indexOf("getElementById('dashOnline')");
    expect(mi).toBeGreaterThan(-1);
    expect(main.slice(mi, mi + 400)).toMatch(/classList\.remove\(\s*'skeleton-stat'\s*\)/);
  });

  test('群组标签的统计不写进首页统计条', () => {
    // group.js 的数字来自 VRChat 群组花名册（群成员在游戏里的在线状态），
    // 与首页统计条的「本站在线用户 / 本站注册成员」语义不同。
    // 两边都往 #dashOnline / #dashMembers 写，会让数字在切标签时来回跳。
    const group = read('js', 'group.js');
    expect(group).not.toMatch(/getElementById\(\s*'dashOnline'\s*\)/);
    expect(group).not.toMatch(/getElementById\(\s*'dashMembers'\s*\)/);
  });

  test('home.no_upcoming is translated in every locale', () => {
    // 首页「暂无即将开始的活动」此前直接显示原始键名 home.no_upcoming
    const langDir = path.join(PUB, 'js', 'languages');
    for (const f of fs.readdirSync(langDir).filter(x => x.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(langDir, f), 'utf8');
      expect([f, /["']home\.no_upcoming["']\s*:/.test(src)]).toEqual([f, true]);
    }
  });

  test('every i18n key used with __() exists in the zh locale', () => {
    // __() 的实现是 langDict[key] || getLocale('zh')[key] || key，
    // 缺键时直接把键名显示给用户。曾有 375/994 个键（38%）缺失，
    // 其中 core.confirm_btn / core.cancel_btn 是所有确认弹窗的按钮文字。
    // 因为有 zh 回退链，只要 zh 齐全，其余 5 个语种会自动回退中文。
    const zh = read('js', 'languages', 'zh.js');
    const jsDir = path.join(PUB, 'js');
    const keys = new Set();
    const collect = dir => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'languages') collect(full); continue; }
        if (!e.name.endsWith('.js')) continue;
        for (const m of fs.readFileSync(full, 'utf8').matchAll(/__\(\s*'([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)'\s*\)/g)) {
          keys.add(m[1]);
        }
      }
    };
    collect(jsDir);
    expect(keys.size).toBeGreaterThan(0);
    const missing = [...keys].filter(k => !new RegExp(`["']${k.replace(/\./g, '\\.')}["']\\s*:`).test(zh));
    expect(missing).toEqual([]);
  });

  test('the back-to-top button clears the mobile bottom nav', () => {
    // 悬浮按钮此前正好压住底部导航栏最右侧的「通知」项
    expect(ds()).toMatch(/\.back-to-top\s*\{[^}]*\}|\.back-to-top\s*\{/);
    const mobileBlock = ds().slice(ds().indexOf('@media (max-width: 768px)'));
    expect(mobileBlock).toMatch(/\.back-to-top\s*\{[^}]*bottom:\s*calc\(/);
  });

  test('aria-hidden is not repurposed as a visual hiding switch', () => {
    // [aria-hidden="true"]{display:none!important} 曾灭掉所有装饰性图标：
    // .hero-wave 波浪、移动端「全部功能」按钮的 ☰。aria-hidden 只对辅助
    // 技术生效，视觉隐藏必须用 .d-none / hidden。弹窗真正的显示开关是
    // .d-none / .show（见 ui.js isModalOpen），不依赖这条规则。
    for (const f of CSS_ORDER) {
      const css = stripComments(read('css', f));
      expect([f, /\[aria-hidden=["']?true["']?\]\s*\{[^}]*display\s*:\s*none/.test(css)])
        .toEqual([f, false]);
    }
  });

  test('the toast container stays fixed, so toasts cannot scroll off screen', () => {
    // [aria-live="polite"]{position:relative} 与 .toast-container 同为 (0,1,0)
    // 特异性，但所在文件加载更晚，于是把全站 toast 变成了文档流内元素，
    // 用户滚动页面后根本看不到任何提示。
    for (const f of CSS_ORDER) {
      const css = stripComments(read('css', f));
      expect([f, /\[aria-live=["']?polite["']?\]\s*\{[^}]*position\s*:/.test(css)])
        .toEqual([f, false]);
    }
    const dom = new JSDOM(
      `<!doctype html><html><head><style>${CSS_ORDER.map(f => read('css', f)).join('\n')}</style></head>` +
      `<body><div class="toast-container" aria-live="polite"></div></body></html>`
    );
    const el = dom.window.document.querySelector('.toast-container');
    expect(dom.window.getComputedStyle(el).position).toBe('fixed');
  });

  test('toasts are lifted above the mobile bottom nav', () => {
    // 移动端 toast 原本 bottom:24px，直接盖住「聊天 / 管理 / 通知」三个 tab，
    // 提示存在的几秒内这三项点不到。
    const mobileBlock = ds().slice(ds().indexOf('@media (max-width: 768px)'));
    expect(mobileBlock).toMatch(/\.toast-container\s*\{[^}]*bottom:\s*calc\(/);
  });
});

describe('mobile / desktop navigation parity', () => {
  const html = () => read('index.html');
  const uiJs = () => read('js', 'ui.js');

  test('the mobile admin shortcut is hidden from non-admins like the desktop tab', () => {
    const dom = new JSDOM(html());
    const adminItem = dom.window.document.querySelector('.mobile-tab-bar-item[data-tab="admin"]');
    expect(adminItem).not.toBeNull();
    // 桌面端标签用 .admin-only 控制显隐；移动端此前遗漏，普通成员能看到管理入口
    expect(adminItem.classList.contains('admin-only')).toBe(true);
  });

  // 桌面标签没有 data-tab 属性，标识藏在 id="tab-btn-<name>" 里
  const desktopTabs = doc =>
    [...doc.querySelectorAll('.tabs button[id^="tab-btn-"]')]
      .map(b => b.id.replace(/^tab-btn-/, ''));

  test('every mobile bottom-bar destination also exists as a desktop tab', () => {
    const dom = new JSDOM(html());
    const d = dom.window.document;
    const desktop = new Set(desktopTabs(d));
    expect(desktop.size).toBeGreaterThan(0);
    const mobile = [...d.querySelectorAll('.mobile-tab-bar-item[data-tab]')]
      .map(b => b.dataset.tab);
    expect(mobile.length).toBeGreaterThan(0);
    expect(mobile.filter(t => !desktop.has(t))).toEqual([]);
  });

  test('the "more" menu covers every desktop tab, since the bottom bar cannot', () => {
    // 底部栏只放得下 7 项，其余功能只能靠「全部功能」菜单进入；
    // 菜单一旦漏项，那个功能在手机上就彻底无法访问。
    const dom = new JSDOM(html());
    const desktop = desktopTabs(dom.window.document);
    const src = uiJs();
    const start = src.indexOf('TAB_ITEMS');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, start + 3000);
    const inMenu = new Set([...block.matchAll(/id:\s*'([a-z0-9_-]+)'/gi)].map(m => m[1]));
    expect(inMenu.size).toBeGreaterThan(0);
    expect(desktop.filter(t => !inMenu.has(t))).toEqual([]);
  });
});

describe('mobile "more" menu accessibility', () => {
  const uiJs = () => read('js', 'ui.js');

  test('menu entries are buttons so keyboard users can reach and activate them', () => {
    // 菜单项原先是 <div onclick>，键盘完全无法聚焦
    const src = uiJs();
    const i = src.indexOf('mobile-tab-item');
    expect(i).toBeGreaterThan(-1);
    const block = src.slice(Math.max(0, i - 600), i + 200);
    expect(block).toMatch(/createElement\(\s*'button'\s*\)/);
    expect(block).toMatch(/className\s*=\s*'mobile-tab-item'/);
  });

  test('the menu is announced as a dialog and its trigger reports expanded state', () => {
    const src = uiJs();
    expect(src).toMatch(/role=["']dialog["']|setAttribute\(\s*'role',\s*'dialog'\s*\)/);
    expect(src).toMatch(/aria-expanded/);
  });

  test('Escape closes the menu and focus returns to the trigger', () => {
    const src = uiJs();
    const i = src.indexOf('handleMobileTabMenuKeydown');
    expect(i).toBeGreaterThan(-1);
    const block = src.slice(i, i + 1200);
    expect(block).toMatch(/Escape/);
    // 关闭后必须把焦点还给触发按钮，否则焦点掉到 body，键盘用户迷失
    const close = src.slice(src.indexOf('function closeMobileTabMenu'), src.indexOf('function closeMobileTabMenu') + 1200);
    expect(close).toMatch(/\.focus\(\)/);
  });

  test('the trigger and close controls carry translated accessible names', () => {
    const src = uiJs();
    const i = src.indexOf('initMobileTabMenu');
    const block = src.slice(i, i + 2000);
    expect(block).toMatch(/aria-label|data-i18n/);
    expect(block).toMatch(/__\(/);
  });

  test('nav.more exists in every locale so the label is not a raw key', () => {
    const langDir = path.join(PUB, 'js', 'languages');
    for (const f of fs.readdirSync(langDir).filter(x => x.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(langDir, f), 'utf8');
      expect([f, /["']nav\.more["']\s*:/.test(src)]).toEqual([f, true]);
    }
  });
});

describe('form control accessible names', () => {
  test('every form control is labelled or aria-labelled', () => {
    const dom = new JSDOM(read('index.html'));
    const d = dom.window.document;
    const labelled = new Set(
      [...d.querySelectorAll('label[for]')].map(l => l.getAttribute('for'))
    );
    // data-i18n-aria 的键会在运行时翻译成 aria-label，若键缺失，
    // 屏幕阅读器会直接朗读键名（和 __() 缺键显示键名是同一类问题）。
    const zh = read('js', 'languages', 'zh.js');
    const missingAriaKeys = [];
    const unnamed = [];
    for (const el of d.querySelectorAll('input, select, textarea')) {
      if (el.type === 'hidden') continue;
      if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) continue;
      const ariaKey = el.getAttribute('data-i18n-aria');
      if (ariaKey) {
        if (!new RegExp(`["']${ariaKey.replace(/\./g, '\\.')}["']\\s*:`).test(zh)) {
          missingAriaKeys.push(ariaKey);
        }
        continue;
      }
      if (el.getAttribute('title') || el.getAttribute('placeholder')) continue;
      if (el.id && labelled.has(el.id)) continue;
      if (el.closest('label')) continue;
      unnamed.push(el.id || el.name || el.outerHTML.slice(0, 60));
    }
    expect(missingAriaKeys).toEqual([]);
    expect(unnamed).toEqual([]);
  });

  test('no duplicate element ids, which would break getElementById and label[for]', () => {
    const dom = new JSDOM(read('index.html'));
    const seen = new Map();
    for (const el of dom.window.document.querySelectorAll('[id]')) {
      seen.set(el.id, (seen.get(el.id) || 0) + 1);
    }
    expect([...seen].filter(([, n]) => n > 1).map(([id]) => id)).toEqual([]);
  });
});
