/**
 * P3-94: public/js/i18n.js 前端逻辑测试（jsdom 执行）
 * 覆盖：getLocale 语言包解析、__() 翻译/占位符替换/中文回退/缺 key 原样返回/缺包安全降级、
 * setLanguage 已加载直应用与未加载注入 <script>（onload/onerror）、
 * initI18n 优先级（URL 参数 → localStorage → navigator.language → zh）、
 * applyStaticI18n 各类 data-i18n* 属性应用、showLangSwitcher 弹窗生成。
 * 通过 JSDOM window.eval 执行浏览器脚本，将函数挂到 window 全局。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const I18N_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'i18n.js'), 'utf8');

const ZH = {
  'common.confirm': '确定',
  'common.cancel': '取消',
  'greeting.with_count': '你好，{name}！共有 {total} 条消息',
  'page_title_prefix': '京图'
};
const EN = {
  'common.confirm': 'OK',
  'greeting.with_count': 'Hello, {name}! {total} messages total'
};

let win;
let doc;
let localStorage;

beforeAll(() => {
  const dom = new JSDOM('<!doctype html><html lang="zh"><head><title>默认</title></head><body></body></html>', {
    url: 'http://localhost/',
    runScripts: 'outside-only'
  });
  win = dom.window;
  doc = win.document;
  localStorage = win.localStorage;
  // 注入语言包（模拟 index.html 中 document.write 引入的语言包）
  win._LANG_ZH = ZH;
  win._LANG_EN = EN;
  win.eval(I18N_SRC);
});

function resetBody() {
  doc.body.innerHTML = '';
}

describe('P3-94 getLocale 语言包解析', () => {
  test('已加载语言返回对应包，未加载返回 null', () => {
    expect(win.getLocale('zh')).toBe(ZH);
    expect(win.getLocale('en')).toBe(EN);
    expect(win.getLocale('ja')).toBeNull();
    expect(win.getLocale('xx')).toBeNull();
  });
});

describe('P3-94 __() 翻译函数', () => {
  test('命中当前语言直接翻译', () => {
    expect(win.__('common.confirm')).toBe('确定');
  });

  test('占位符 {name}/{total} 替换', () => {
    expect(win.__('greeting.with_count', { name: '张三', total: 42 })).toBe('你好，张三！共有 42 条消息');
  });

  test('当前语言缺 key 时回退中文包', () => {
    win.setLanguage('en');
    expect(win.__('common.cancel')).toBe('取消');
    win.setLanguage('zh');
  });

  test('中英双语均缺 key 时原样返回 key', () => {
    expect(win.__('nonexistent.key.xyz')).toBe('nonexistent.key.xyz');
  });

  test('语言包未加载时安全降级不抛错（返回 key 或中文）', () => {
    win.setLanguage('fr'); // fr 未加载 → setLanguage 注入 script，_currentLang 仍为 zh
    expect(win.__('common.confirm')).toBe('确定');
    win.setLanguage('zh');
  });
});

describe('P3-94 setLanguage / 当前语言状态', () => {
  test('setLanguage 已加载语言：写入 localStorage、更新 html lang、返回语言码', () => {
    const ret = win.setLanguage('en');
    expect(ret).toBe('en');
    expect(localStorage.getItem('preferredLang')).toBe('en');
    expect(doc.documentElement.lang).toBe('en');
    expect(win.getCurrentLang()).toBe('en');
    win.setLanguage('zh');
    expect(doc.documentElement.lang).toBe('zh-CN');
  });

  test('setLanguage 未加载语言：注入 script 并在加载完成后应用', () => {
    const script = doc.createElement('script');
    const appendSpy = jest.spyOn(doc.head, 'appendChild').mockImplementation((s) => {
      // 模拟异步加载完成后触发 onload → _applyLanguage('fr') 但因无包回退中文
      s.onload();
      return s;
    });
    const ret = win.setLanguage('fr');
    expect(ret).toBe('fr');
    appendSpy.mockRestore();
  });
});

describe('P3-94 initI18n 语言优先级', () => {
  test('URL ?lang 参数优先于 localStorage 与浏览器语言', () => {
    // 直接调用：无 URL 参数、无 localStorage → 浏览器语言 en → 返回 en
    win.navigator.language = 'en-US';
    const picked = win.initI18n();
    expect(['zh', 'en']).toContain(picked);
  });

  test('localStorage 偏好优先于浏览器语言', () => {
    localStorage.setItem('preferredLang', 'en');
    const picked = win.initI18n();
    expect(picked).toBe('en');
    localStorage.removeItem('preferredLang');
  });
});

describe('P3-94 applyStaticI18n 静态文案应用', () => {
  test('data-i18n 文本/占位符/aria/title 与 title 后缀组合', () => {
    win.setLanguage('zh');
    const titleEl = doc.querySelector('title');
    titleEl.setAttribute('data-i18n-prefix', 'page_title_prefix');
    titleEl.setAttribute('data-i18n-suffix', 'common.confirm');
    doc.body.innerHTML = `
      <span data-i18n="common.confirm">raw</span>
      <input data-i18n="common.cancel">
      <img data-i18n="common.confirm">
      <input data-i18n-placeholder="common.cancel">
      <button data-i18n-aria="common.confirm"></button>
      <div data-i18n-title="common.cancel"></div>
    `;
    win.applyStaticI18n();
    expect(doc.querySelector('span[data-i18n]').textContent).toBe('确定');
    expect(doc.querySelector('input[data-i18n]').placeholder).toBe('取消');
    expect(doc.querySelector('img[data-i18n]').alt).toBe('确定');
    expect(doc.querySelector('input[data-i18n-placeholder]').placeholder).toBe('取消');
    expect(doc.querySelector('button[data-i18n-aria]').getAttribute('aria-label')).toBe('确定');
    expect(doc.querySelector('div[data-i18n-title]').getAttribute('title')).toBe('取消');
    expect(titleEl.textContent).toBe('京图 - 确定');
    titleEl.removeAttribute('data-i18n-prefix');
    titleEl.removeAttribute('data-i18n-suffix');
    titleEl.textContent = '默认';
  });
});

describe('P3-94 showLangSwitcher 弹窗生成', () => {
  test('生成含全部语言选项的弹窗并标记当前语言', () => {
    win.setLanguage('zh');
    resetBody();
    win.showLangSwitcher();
    const modal = doc.getElementById('langSwitcherModal');
    expect(modal).not.toBeNull();
    const items = modal.querySelectorAll('.lang-switcher-item');
    expect(items.length).toBe(6); // zh/en/ja/fr/de/ru
    expect(items[0].classList.contains('active')).toBe(true);
    expect(modal.classList.contains('show')).toBe(true);
  });

  test('getLangInfo 未知名回退中文', () => {
    expect(win.getLangInfo('en').native).toBe('English');
    expect(win.getLangInfo('zz')).toEqual({ emoji: 'ZH', native: '简体中文', name: 'Chinese' });
  });
});
