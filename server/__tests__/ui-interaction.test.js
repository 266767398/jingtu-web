/**
 * 境途同游前端交互回归测试：弹窗无障碍层、滚动锁与样式守卫。
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..', '..');
const UI_JS_PATH = path.join(ROOT, 'public', 'js', 'ui.js');
const CSS_DIR = path.join(ROOT, 'public', 'css');

const readUtf8 = (filePath) => fs.readFileSync(filePath, 'utf8');
const uiSource = readUtf8(UI_JS_PATH);

function modalRuntimeSource() {
  const start = uiSource.indexOf('// ==================== 移动端 Tab 折叠菜单 ====================');
  const end = uiSource.indexOf('// ==================== 图片查看器键盘导航 ====================');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('无法定位 ui.js 中的移动端菜单/弹窗无障碍代码块');
  }
  return `
    var activeTab = 'home';
    var currentUser = null;
    var switchTab = function() {};
    var __ = function(key) { return key; };
    ${uiSource.slice(start, end)}
    window.__uiModalTest = {
      lockBodyScroll,
      unlockBodyScroll,
      openMobileTabMenu,
      closeMobileTabMenu,
      isModalOpen,
      activateModalA11y,
      deactivateModalA11y,
      initModalAccessibility,
      modalStack: _modalStack,
      scrollLockOwners: _scrollLockOwners
    };
  `;
}

function createDom(bodyHtml = '') {
  const dom = new JSDOM(`<!doctype html><html><head><style>
    .modal { display: none; }
    .modal.show { display: flex; }
    .d-none { display: none !important; }
  </style></head><body>${bodyHtml}</body></html>`, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'http://localhost/'
  });

  Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() {
      if (!this.isConnected) return null;
      if (this.hasAttribute('hidden')) return null;
      if (this.style && this.style.display === 'none') return null;
      return this.parentElement || dom.window.document.body;
    }
  });

  dom.window.eval(modalRuntimeSource());
  return dom;
}

function modalMarkup(id, extraClass = '', extraAttrs = '') {
  return `
    <div id="${id}" class="modal ${extraClass}" ${extraAttrs}>
      <div class="modal-content">
        <button class="modal-close" type="button">关闭</button>
        <button class="first" type="button">第一个</button>
        <button class="last" type="button">最后一个</button>
      </div>
    </div>`;
}

function mobileMenuMarkup() {
  return `
    <button id="mobileTabMenuBtn" type="button" aria-expanded="false">更多</button>
    <div id="mobileTabOverlay" class="mobile-tab-overlay"></div>
    <div id="mobileTabMenu" class="mobile-tab-menu">
      <button class="mobile-tab-close" type="button">关闭菜单</button>
      <button class="mobile-tab-item" type="button" data-tab-id="home">首页</button>
    </div>`;
}

function flushMutations() {
  // 弹窗无障碍层用 requestAnimationFrame 合帧（P3-3）：rAF 由 jsdom 以 ~16ms
  // 定时器驱动，setTimeout(0) 会先触发，断言时 syncModalA11y 尚未执行，
  // 滚动锁/弹窗栈必然不满足。必须等足一帧再断言。
  return new Promise(resolve => setTimeout(resolve, 30));
}

function getModalBlock() {
  const start = uiSource.indexOf('// ==================== 模态框焦点陷阱与键盘导航 ====================');
  const end = uiSource.indexOf('// ==================== 图片查看器键盘导航 ====================');
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return uiSource.slice(start, end);
}

function readCssInLoadOrder() {
  const ordered = [
    '01-variables.css',
    '02-base.css',
    '03-layout.css',
    '04-components.css',
    '05-auth.css',
    '06-members.css',
    '07-profile.css',
    '08-chat-posts.css',
    'ui-enhance.css',
    'favorites.css',
    '99-design-system.css'
  ];
  return ordered.map(name => `/* ${name} */\n${readUtf8(path.join(CSS_DIR, name))}`).join('\n');
}

function cssRulesForSelector(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rules = [];
  const re = new RegExp(`(^|})[^{}]*${escaped}[^{}]*\\{([^{}]*)\\}`, 'g');
  let match;
  while ((match = re.exec(css)) !== null) {
    rules.push(match[2]);
  }
  return rules;
}

function lastOverflowSetting(rules) {
  return rules
    .flatMap(rule => Array.from(rule.matchAll(/overflow(?:-y)?\s*:\s*[^;]+/gi), match => match[0].trim()))
    .at(-1);
}

describe('弹窗无障碍层不会破坏整页滚动与 Tab 顺序', () => {
  // 原缺陷：只按是否缺少 d-none 判断，会把默认 display:none 的弹窗当成已打开。
  test('初始化时所有关闭的弹窗都不应被判定为打开', async () => {
    const dom = createDom(`${modalMarkup('defaultClosed')}${modalMarkup('dNoneClosed', 'd-none')}`);
    const api = dom.window.__uiModalTest;

    api.initModalAccessibility();
    await flushMutations();

    const defaultClosed = dom.window.document.getElementById('defaultClosed');
    const dNoneClosed = dom.window.document.getElementById('dNoneClosed');
    expect(api.isModalOpen(defaultClosed)).toBe(false);
    expect(api.isModalOpen(dNoneClosed)).toBe(false);
    expect(defaultClosed.getAttribute('role')).toBeNull();
    expect(dNoneClosed.getAttribute('role')).toBeNull();
    expect(api.modalStack).toHaveLength(0);
    expect(dom.window.document.body.style.overflow).toBe('');
  });

  // 原缺陷：初始化误判关闭弹窗后会残留 body overflow:hidden，整页无法滚动。
  test('初始化后 body 仍可滚动（不残留 overflow:hidden）', async () => {
    const dom = createDom(`${modalMarkup('closed')}${modalMarkup('alsoClosed', 'd-none')}`);
    const api = dom.window.__uiModalTest;

    dom.window.document.body.style.overflow = 'auto';
    api.initModalAccessibility();
    await flushMutations();

    expect(dom.window.document.body.style.overflow).toBe('auto');
    expect(api.scrollLockOwners.size).toBe(0);
  });

  // 原缺陷：没有弹窗时仍安装焦点陷阱，导致页面级 Tab 键被错误拦截。
  test('未打开弹窗时 Tab 键不被劫持', async () => {
    const dom = createDom(`<button id="outside" type="button">外部按钮</button>${modalMarkup('closed')}`);
    const api = dom.window.__uiModalTest;

    api.initModalAccessibility();
    await flushMutations();
    dom.window.document.getElementById('outside').focus();
    const event = new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    dom.window.document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(api.modalStack).toHaveLength(0);
    expect(dom.window.document.activeElement.id).toBe('outside');
  });

  // 原缺陷：弹窗关闭时没有恢复之前的滚动状态，造成页面永久锁死。
  test('打开弹窗锁定滚动、关闭后恢复滚动', async () => {
    const dom = createDom(`<button id="outside" type="button">外部按钮</button>${modalMarkup('modal')}`);
    const api = dom.window.__uiModalTest;
    const modal = dom.window.document.getElementById('modal');

    dom.window.document.body.style.overflow = 'auto';
    api.initModalAccessibility();
    modal.classList.add('show');
    await flushMutations();

    expect(api.modalStack).toEqual([modal]);
    expect(modal.getAttribute('role')).toBe('dialog');
    expect(modal.getAttribute('aria-modal')).toBe('true');
    expect(dom.window.document.body.style.overflow).toBe('hidden');

    modal.querySelector('.modal-close').click();
    await flushMutations();

    expect(api.modalStack).toHaveLength(0);
    expect(modal.getAttribute('aria-hidden')).toBe('true');
    expect(dom.window.document.body.style.overflow).toBe('auto');
  });

  // 原缺陷：多层弹窗共用一个布尔锁，关闭上层时会提前解锁底层弹窗背景。
  test('嵌套弹窗：关闭上层后滚动仍保持锁定，全部关闭才恢复', async () => {
    const dom = createDom(`${modalMarkup('base')}${modalMarkup('top')}`);
    const api = dom.window.__uiModalTest;
    const base = dom.window.document.getElementById('base');
    const top = dom.window.document.getElementById('top');

    api.initModalAccessibility();
    base.classList.add('show');
    await flushMutations();
    top.classList.add('show');
    await flushMutations();

    expect(api.modalStack).toEqual([base, top]);
    expect(dom.window.document.body.style.overflow).toBe('hidden');

    top.querySelector('.modal-close').click();
    await flushMutations();
    expect(api.modalStack).toEqual([base]);
    expect(dom.window.document.body.style.overflow).toBe('hidden');

    base.querySelector('.modal-close').click();
    await flushMutations();
    expect(api.modalStack).toHaveLength(0);
    expect(dom.window.document.body.style.overflow).toBe('');
  });

  // 原缺陷：core.js 通过内联 display 打开弹窗，若只看 .show 会漏掉并失去无障碍处理。
  test('通过内联 display 打开的弹窗同样被识别（core.js showModal 路径）', async () => {
    const dom = createDom(modalMarkup('inlineModal'));
    const api = dom.window.__uiModalTest;
    const modal = dom.window.document.getElementById('inlineModal');

    api.initModalAccessibility();
    modal.style.display = 'flex';
    await flushMutations();

    expect(api.isModalOpen(modal)).toBe(true);
    expect(api.modalStack).toEqual([modal]);
    expect(modal.getAttribute('aria-modal')).toBe('true');
    expect(dom.window.document.body.style.overflow).toBe('hidden');

    modal.style.display = 'none';
    await flushMutations();
    expect(api.modalStack).toHaveLength(0);
    expect(dom.window.document.body.style.overflow).toBe('');
  });

  // 原缺陷：打开中的弹窗被删除时没有释放锁，后续页面仍不可滚动。
  test('从 DOM 移除打开中的弹窗也会释放滚动锁', async () => {
    const dom = createDom(modalMarkup('removable'));
    const api = dom.window.__uiModalTest;
    const modal = dom.window.document.getElementById('removable');

    api.initModalAccessibility();
    modal.classList.add('show');
    await flushMutations();
    expect(dom.window.document.body.style.overflow).toBe('hidden');

    modal.remove();
    await flushMutations();

    expect(modal.getAttribute('aria-hidden')).toBe('true');
    expect(api.modalStack).toHaveLength(0);
    expect(api.scrollLockOwners.size).toBe(0);
    expect(dom.window.document.body.style.overflow).toBe('');
  });

  // 原缺陷：移动端菜单和弹窗各自重置 body.overflow，关闭任意一方会误解锁另一方。
  test('移动端菜单与弹窗同时打开时，关闭其一不会误解锁', async () => {
    const dom = createDom(`${mobileMenuMarkup()}${modalMarkup('modal')}`);
    const api = dom.window.__uiModalTest;
    const modal = dom.window.document.getElementById('modal');

    api.initModalAccessibility();
    api.openMobileTabMenu();
    expect(dom.window.document.body.style.overflow).toBe('hidden');
    expect(api.scrollLockOwners.has('mobile-tab-menu')).toBe(true);

    modal.classList.add('show');
    await flushMutations();
    expect(api.scrollLockOwners.has(modal)).toBe(true);

    api.closeMobileTabMenu();
    expect(api.scrollLockOwners.has('mobile-tab-menu')).toBe(false);
    expect(api.scrollLockOwners.has(modal)).toBe(true);
    expect(dom.window.document.body.style.overflow).toBe('hidden');

    modal.querySelector('.modal-close').click();
    await flushMutations();
    expect(api.scrollLockOwners.size).toBe(0);
    expect(dom.window.document.body.style.overflow).toBe('');
  });
});

describe('静态守卫：避免再次退回按 d-none 判断弹窗可见性', () => {
  // 原缺陷：多个位置各自判断 d-none/show/display，修复后应统一经由 isModalOpen。
  test('ui.js 使用 isModalOpen 作为唯一可见性判定入口', () => {
    const modalBlock = getModalBlock();
    const isModalOpenMatch = modalBlock.match(/function\s+isModalOpen\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/);
    expect(isModalOpenMatch).not.toBeNull();

    const withoutHelper = modalBlock.replace(isModalOpenMatch[0], '');
    expect(withoutHelper).toMatch(/function\s+activateModalA11y[\s\S]*?isModalOpen\(modalEl\)/);
    expect(withoutHelper).toMatch(/function\s+syncModalA11y[\s\S]*?isModalOpen\(modalEl\)/);
    expect(withoutHelper).toMatch(/function\s+handleModalKeydown[\s\S]*?isModalOpen\(_activeModal\)/);
    expect(withoutHelper).toMatch(/function\s+handleModalBackdropClick[\s\S]*?isModalOpen\(_activeModal\)/);
    expect(withoutHelper).not.toMatch(/classList\.contains\(['"]d-none['"]\)/);
    expect(withoutHelper).not.toMatch(/getComputedStyle\([^)]*\)\.display\s*!==\s*['"]none['"]/);
  });

  // 原缺陷：弹窗只用单个 activeModal 布尔状态，嵌套关闭会提前释放滚动锁。
  test('滚动锁使用弹窗栈，避免多层弹窗提前解锁', () => {
    const modalBlock = getModalBlock();

    expect(modalBlock).toMatch(/const\s+_modalStack\s*=\s*\[\]/);
    expect(modalBlock).toMatch(/_modalStack\.push\(modalEl\)/);
    expect(modalBlock).toMatch(/_modalStack\.splice\(idx,\s*1\)/);
    expect(modalBlock).toMatch(/lockBodyScroll\(modalEl\)/);
    expect(modalBlock).toMatch(/unlockBodyScroll\(modalEl\)/);
    expect(modalBlock).toMatch(/if\s*\(\s*_modalStack\.length\s*===\s*0\s*\)/);
    expect(modalBlock).toMatch(/_activeModal\s*=\s*_modalStack\[_modalStack\.length\s*-\s*1\]/);
  });

  // 原缺陷：菜单、灯箱、弹窗分别写 body overflow，关闭一个会破坏另一个的锁。
  test('移动端菜单、灯箱与弹窗共用同一套引用计数滚动锁', () => {
    expect(uiSource).toMatch(/const\s+_scrollLockOwners\s*=\s*new\s+Set\s*\(\s*\)/);
    expect(uiSource).toMatch(/function\s+lockBodyScroll\s*\(owner\)[\s\S]*?_scrollLockOwners\.add\(owner\)/);
    expect(uiSource).toMatch(/function\s+unlockBodyScroll\s*\(owner\)[\s\S]*?_scrollLockOwners\.delete\(owner\)[\s\S]*?_scrollLockOwners\.size\s*===\s*0/);
    expect(uiSource).toMatch(/function\s+openMobileTabMenu[\s\S]*?lockBodyScroll\(['"]mobile-tab-menu['"]\)/);
    expect(uiSource).toMatch(/function\s+closeMobileTabMenu[\s\S]*?unlockBodyScroll\(['"]mobile-tab-menu['"]\)/);
    expect(uiSource).toMatch(/function\s+openGenericLightbox[\s\S]*?lockBodyScroll\(['"]generic-lightbox['"]\)/);
    expect(uiSource).toMatch(/function\s+closeGenericLightbox[\s\S]*?unlockBodyScroll\(['"]generic-lightbox['"]\)/);
    expect(uiSource).toMatch(/function\s+activateModalA11y[\s\S]*?lockBodyScroll\(modalEl\)/);
    expect(uiSource).toMatch(/function\s+deactivateModalA11y[\s\S]*?unlockBodyScroll\(modalEl\)/);
  });

  // 原缺陷：登录遮罩/模态根层 overflow:hidden，内容过高时移动端无法纵向滚动。
  test('登录遮罩与模态层允许纵向滚动', () => {
    const css = readCssInLoadOrder();
    const loginRules = cssRulesForSelector(css, '.login-overlay');
    const modalRules = cssRulesForSelector(css, '.modal');

    expect(loginRules.some(rule => /overflow-y\s*:\s*auto/i.test(rule))).toBe(true);
    expect(modalRules.some(rule => /overflow-y\s*:\s*auto/i.test(rule))).toBe(true);
    expect(lastOverflowSetting(loginRules)).toMatch(/overflow-y\s*:\s*auto/i);
    expect(lastOverflowSetting(modalRules)).toMatch(/overflow-y\s*:\s*auto/i);
  });
});
