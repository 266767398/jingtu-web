// ==================== 动态获取语言包 ====================
function getLocale(lang) {
  const langMap = {
    'zh': window._LANG_ZH,
    'en': window._LANG_EN,
    'ja': window._LANG_JA,
    'fr': window._LANG_FR,
    'de': window._LANG_DE,
    'ru': window._LANG_RU
  };
  return langMap[lang] || null;
}

// ==================== 国际化 i18n V1.0 ====================
// 支持：简体中文 (zh) / English (en) / 日本語 (ja) / Français (fr) / Deutsch (de) / Русский (ru)
// 使用 localStorage 持久化语言偏好
// 语言文件已拆分到 /js/languages/ 目录下，方便维护

// ==================== 语言信息 ====================
// 注意：emoji 使用两位 ISO 639-1 代码而非国旗 emoji。
// 国旗 emoji 在 Windows 上会回退为字母对、且存在可访问性/代表性争议，
// 统一用代码标签可跨平台一致显示（主切换器按钮与弹窗共用此字段）。
const LANG = {
  zh: { emoji: 'ZH', native: '简体中文', name: 'Chinese' },
  en: { emoji: 'EN', native: 'English', name: 'English' },
  ja: { emoji: 'JA', native: '日本語', name: 'Japanese' },
  fr: { emoji: 'FR', native: 'Français', name: 'French' },
  de: { emoji: 'DE', native: 'Deutsch', name: 'German' },
  ru: { emoji: 'RU', native: 'Русский', name: 'Russian' }
};

// 按优先级从高到低排列
const LANG_ORDER = ['zh', 'en', 'ja', 'fr', 'de', 'ru'];

// 语言包静态版本号（与 index.html 中 document.write 引入的语言包 ?v 保持一致）。
// 动态按需加载的语言包同样必须带 ?v，否则 Service Worker 可能命中旧缓存，
// 导致切换语言后文案仍显示旧语言（缓存问题 4.2）。语言包内容更新时需同步提升此版本号。
const I18N_PACK_VERSION = '20261006c';

// ==================== 翻译表（从语言文件加载） ====================

// ==================== 当前语言状态 ====================
let _currentLang = 'zh';

// ==================== 核心翻译函数 ====================
function __(key, replacements = {}) {
  // 语言包可能尚未加载（按需加载、网络失败、或 document.write 被 CSP/策略拦截），
  // 此时 getLocale 返回 null，直接解引用会抛 TypeError 导致全站功能崩溃。
  // 安全降级：缺包时返回 key 原样，保证页面不白屏、调用方可继续渲染。
  const langDict = getLocale(_currentLang) || getLocale('zh') || {};
  const fallback = getLocale('zh') || {};
  let text = langDict[key];
  if (text === undefined) text = fallback[key];
  if (text === undefined) text = key;
  // 替换占位符 {n}, {total} 等（v 中的 $ 需先转义，防止 String.replace 特殊展开 $&、$1 等）
  if (typeof text === 'string') {
    for (const [k, v] of Object.entries(replacements)) {
      const safeValue = String(v).replace(/\$/g, '$$$$');
      text = text.replace(new RegExp('\\{' + k + '\\}', 'g'), safeValue);
    }
  }
  return text;
}

// ==================== 设置语言 ====================
// 真正应用语言（假定语言包已就绪）
function _applyLanguage(lang) {
  _currentLang = lang;
  try { localStorage.setItem('preferredLang', lang); } catch(e) {}
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang;
  applyStaticI18n();
  updateLangSwitcherUI();
  reloadDynamicI18n();
  const modal = document.getElementById('langSwitcherModal');
  if (modal) {
    modal.classList.remove('show');
    setTimeout(() => { modal.remove(); }, 300);
  }
  return lang;
}

function setLanguage(lang) {
  if (!getLocale(lang)) {
    // 目标语言包尚未加载（按需加载场景）：注入脚本，加载完成后再应用
    const s = document.createElement('script');
    s.src = '/js/languages/' + lang + '.js?v=' + I18N_PACK_VERSION;
    s.onload = function () { _applyLanguage(lang); };
    s.onerror = function () { _applyLanguage('zh'); };
    document.head.appendChild(s);
    return lang;
  }
  return _applyLanguage(lang);
}

// ==================== 初始化语言 ====================
function initI18n() {
  // 兜底：若 index.html 的 document.write 语言包因任何原因未就绪
  //（CSP 拦截、网络失败、缓存错配），这里按需注入当前语言包再继续，
  // 避免 __() 在字典为 null 时崩溃。
  function ensurePacks(langs, cb) {
    const pending = langs.filter(l => !getLocale(l));
    if (pending.length === 0) return cb();
    let left = pending.length;
    pending.forEach(l => {
      const s = document.createElement('script');
      s.src = '/js/languages/' + l + '.js?v=' + I18N_PACK_VERSION;
      s.onload = s.onerror = function () {
        left--;
        if (left <= 0) cb();
      };
      document.head.appendChild(s);
    });
  }

  let lang = null;
  try {
    const urlParams = new URLSearchParams(window.location.search);
    lang = urlParams.get('lang');
  } catch(e) {}
  if (!lang || !getLocale(lang)) {
    try { lang = localStorage.getItem('preferredLang'); } catch(e) {}
  }
  if (!lang || !getLocale(lang)) {
    const browserLang = (navigator.language || '').substring(0, 2);
    if (getLocale(browserLang)) lang = browserLang;
  }
  if (!lang) lang = 'zh';

  // 至少要确保 zh 兜底包存在，否则 applyStaticI18n 会大量显示原始 key
  const needed = (lang === 'zh') ? ['zh'] : ['zh', lang];
  ensurePacks(needed, function () {
    _currentLang = lang;
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang;
    applyStaticI18n();
    updateLangSwitcherUI();
  });
  return lang;
}

// ==================== 应用静态翻译（data-i18n 元素） ====================
function applyStaticI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (!key) return;
    const text = __(key);
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      el.placeholder = text;
    } else if (el.tagName === 'IMG') {
      el.alt = text;
    } else {
      el.textContent = text;
    }
  });
  // 更新 title 中的翻译部分
  const titleEl = document.querySelector('title');
  if (titleEl) {
    // 只改后半部分
    const prefix = __(titleEl.getAttribute('data-i18n-prefix') || 'page_title_prefix');
    const suffix = titleEl.getAttribute('data-i18n-suffix');
    if (suffix) {
      titleEl.textContent = prefix + ' - ' + __(suffix);
    }
  }
  // 更新所有 data-i18n-placeholder
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = __(el.getAttribute('data-i18n-placeholder'));
  });
  // 更新所有 data-i18n-aria（aria-label 无障碍标签）
  document.querySelectorAll('[data-i18n-aria]').forEach(el => {
    el.setAttribute('aria-label', __(el.getAttribute('data-i18n-aria')));
  });
  // 更新所有 data-i18n-title（title 悬浮提示）
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.setAttribute('title', __(el.getAttribute('data-i18n-title')));
  });
}

// ==================== 动态内容翻译 ====================
function reloadDynamicI18n() {
  // 重新生成当前 Tab 的动态内容
  if (typeof activeTab !== 'undefined' && activeTab) {
    const switchTabFn = window.switchTab;
    if (typeof switchTabFn === 'function') {
      // 通过切换 Tab 刷新视图
      // 强制重新渲染当前 Tab（force=true），使动态加载的内容（接口数据、JS 渲染的文案）也随语言刷新，
      // 否则仅靠 applyStaticI18n 只能更新静态文案，动态内容仍显示旧语言（显示问题 15.1）。
      switchTabFn(activeTab, true);
    }
  }
  // 刷新导航栏用户 UI
  if (typeof updateUserUI === 'function' && window.currentUser) {
    updateUserUI();
  }
}

// ==================== 语言切换器 UI ====================
// P2-13 统一组件：所有页面共用本函数与同一 DOM 结构（button.lang-switcher-btn 触发 +
// #langSwitcherModal 弹窗）。主站（有 core.js）走 showModal/closeModal；轻量页
// （如 setup.html 只加载 i18n.js）首次弹出时注入一次限定作用域的自举样式，视觉规格与主站一致。

// 统一关闭入口：优先走 core.js 的 closeModal，轻量页无该函数时手动隐藏
function _closeLangSwitcher() {
  if (typeof closeModal === 'function') { closeModal('langSwitcherModal'); return; }
  const m = document.getElementById('langSwitcherModal');
  if (m) m.classList.remove('show');
}

// 轻量页自举样式：变量与组件规则全部限定在 #langSwitcherModal / .lang-switch 内，
// 不会影响主站既有样式（主站因存在 showModal 永远不会走到这里）。
function _injectLangSwitcherStandaloneCSS() {
  if (document.getElementById('lang-switcher-standalone-style')) return;
  const st = document.createElement('style');
  st.id = 'lang-switcher-standalone-style';
  st.textContent = [
    '.lang-switch .lang-switcher-btn{background:none;border:1px solid #2a2a3e;color:#e4e4f0;padding:6px 12px;border-radius:8px;cursor:pointer;font-size:13px;white-space:nowrap;transition:all .2s ease;display:inline-flex;align-items:center;gap:4px;font-family:inherit;}',
    '.lang-switch .lang-switcher-btn:hover{border-color:#7c5cfc;background:rgba(124,92,252,.08);}',
    '#langSwitcherModal{--border:#2a2a3e;--text:#e4e4f0;--accent:#7c5cfc;--hover-bg:rgba(124,92,252,.08);position:fixed;inset:0;z-index:1000;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.5);}',
    '#langSwitcherModal.show{display:flex;}',
    '#langSwitcherModal .modal-content{background:#141420;border:1px solid #2a2a3e;border-radius:16px;width:92%;max-width:320px;box-shadow:0 4px 32px rgba(0,0,0,.3);}',
    '#langSwitcherModal .modal-header{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid #2a2a3e;}',
    '#langSwitcherModal .modal-header h3{font-size:15px;color:#fff;font-weight:600;margin:0;}',
    '#langSwitcherModal .modal-close{background:none;border:none;color:#9898b0;font-size:16px;cursor:pointer;}',
    '#langSwitcherModal .lang-switcher-list{display:flex;flex-direction:column;gap:4px;padding:8px;}',
    '#langSwitcherModal .lang-switcher-item{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;background:transparent;border:1px solid transparent;cursor:pointer;transition:all .2s ease;font-size:14px;color:var(--text);width:100%;text-align:left;font-family:inherit;}',
    '#langSwitcherModal .lang-switcher-item:hover{background:var(--hover-bg);border-color:var(--border);}',
    '#langSwitcherModal .lang-switcher-item.active{border-color:var(--accent);background:rgba(124,92,252,.1);font-weight:600;}',
    '#langSwitcherModal .lang-emoji{font-size:12px;width:28px;text-align:center;font-weight:700;letter-spacing:.5px;}',
    '#langSwitcherModal .lang-name{flex:1;}',
    '#langSwitcherModal .lang-check{margin-left:auto;font-size:14px;}'
  ].join('\n');
  document.head.appendChild(st);
}

function showLangSwitcher() {
  const existing = document.getElementById('langSwitcherModal');
    if (existing) existing.remove();

  // 轻量页（无 core.js 的 showModal）需要自举样式才能正确展示同一组件
  if (typeof showModal !== 'function') _injectLangSwitcherStandaloneCSS();

  const langs = LANG_ORDER;
  const current = _currentLang;

  const items = langs.map(code => {
    const lang = LANG[code];
    const isActive = code === current;
    return `<button class="lang-switcher-item ${isActive ? 'active' : ''}" onclick="setLanguage('${code}');_closeLangSwitcher()">
      <span class="lang-emoji">${lang.emoji}</span>
      <span class="lang-name">${lang.native}</span>
      ${isActive ? '<span class="lang-check">✅</span>' : ''}
    </button>`;
  }).join('');

  const div = document.createElement('div');
  div.id = 'langSwitcherModal';
  div.className = 'modal';
  div.innerHTML = `<div class="modal-content modal-sm">
    <div class="modal-header"><h3>${__('lang.switch_to')}</h3><button class="modal-close" onclick="_closeLangSwitcher()" aria-label="${__('ui.close')}">✕</button></div>
    <div class="lang-switcher-list">${items}</div>
  </div>`;
  document.body.appendChild(div);
  if (typeof showModal === 'function') showModal('langSwitcherModal');
  else div.classList.add('show');
}

function updateLangSwitcherUI() {
  const btnIds = ['langSwitcherBtn'];
  btnIds.forEach(btnId => {
    const btn = document.getElementById(btnId);
    if (btn) {
      const lang = LANG[_currentLang] || LANG.zh;
      btn.innerHTML = `${lang.emoji} ${lang.native}`;
    }
  });
  document.documentElement.lang = _currentLang === 'zh' ? 'zh-CN' : _currentLang;
}

// ==================== 获取当前语言代码 ====================
function getCurrentLang() {
  return _currentLang;
}

// ==================== 语言信息 ====================
function getLangInfo(code) {
  return LANG[code] || LANG.zh;
}