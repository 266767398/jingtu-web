/*
 * motion.js —— 境途同游 GSAP 动效层
 * 设计原则（见 Impeccable / GSAP 技能 SOP）：
 *  - 克制优先：位移≤24px、时长≤0.6s、缓动 power2，避免花哨。
 *  - 尊重 prefers-reduced-motion：直接落到终态，零动画。
 *  - 渐进增强：GSAP 加载失败时回退到 reveal.js 的 CSS 揭示。
 *  - 接管 reveal.js：成功启用后设置 window.__motionGSAPEnabled，reveal.js 见旗即跳过，避免双重动画。
 */
(function () {
  'use strict';

  var reduce = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // GSAP 未就绪：交还给 reveal.js（CSS 揭示）
  if (typeof window.gsap === 'undefined') {
    return;
  }

  var gsap = window.gsap;
  if (window.ScrollTrigger) {
    gsap.registerPlugin(window.ScrollTrigger);
  }
  window.__motionGSAPEnabled = true;

  // 需要滚动揭示的元素选择器（覆盖 reveal.js 原目标 + 通用卡片）
  var REVEAL_SEL = '.list-item,.timeline-item,.chart-bar,.rank-item,' +
    '.card,.post-card,.event-card,.album-card,.member-card,[data-animate]';

  function mark(el, name) { try { el.setAttribute('data-' + name, '1'); } catch (e) {} }
  function marked(el, name) { return el.getAttribute('data-' + name) === '1'; }

  /* ---------------- 滚动揭示 ---------------- */
  function setupReveal(el) {
    if (marked(el, 'revealed')) return;
    mark(el, 'revealed');
    if (reduce) { gsap.set(el, { opacity: 1, y: 0 }); return; }
    gsap.set(el, { opacity: 0, y: 24 });
    if (window.ScrollTrigger) {
      window.ScrollTrigger.create({
        trigger: el,
        start: 'top 90%',
        once: true,
        onEnter: function () {
          gsap.to(el, { opacity: 1, y: 0, duration: 0.6, ease: 'power2.out', clearProps: 'transform' });
        }
      });
    } else {
      // 无 ScrollTrigger 时退化为“立即可见”
      gsap.to(el, { opacity: 1, y: 0, duration: 0.5, ease: 'power2.out' });
    }
  }

  function scanReveals(root) {
    (root || document).querySelectorAll(REVEAL_SEL).forEach(setupReveal);
  }

  /* ---------------- 容器入场（登录后顶栏/主区） ---------------- */
  function introChildren(container, opts) {
    if (!container || marked(container, 'intro-done')) return;
    mark(container, 'intro-done');
    if (reduce) return;
    var items = container.children && container.children.length
      ? Array.prototype.slice.call(container.children)
      : [container];
    gsap.fromTo(items,
      { opacity: 0, y: opts && opts.y != null ? opts.y : 16 },
      { opacity: 1, y: 0, duration: 0.5, ease: 'power2.out', stagger: 0.05, clearProps: 'transform' });
  }

  // 监控元素由隐藏(d-none)变可见时播放入场
  function watchReveal(container, opts) {
    if (!container) return;
    var tryPlay = function () {
      if (container.classList.contains('d-none')) return;
      var cs = getComputedStyle(container);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      introChildren(container, opts);
    };
    tryPlay();
    if ('MutationObserver' in window) {
      new MutationObserver(tryPlay).observe(container, { attributes: true, attributeFilter: ['class', 'style'] });
    }
  }

  /* ---------------- 视图（标签）切换过渡 ---------------- */
  var pendingTransition = false;
  function beginViewTransition() {
    if (reduce) return;
    var mc = document.getElementById('mainContainer');
    if (!mc || marked(mc, 'app-ready') === false) {
      // 首次进入主区时只标记就绪，不做 OUT
    }
    pendingTransition = true;
    if (mc && !reduce) {
      gsap.to(mc, { opacity: 0.25, y: 10, duration: 0.16, ease: 'power1.in' });
    }
  }

  function endViewTransition() {
    if (reduce) { pendingTransition = false; return; }
    var mc = document.getElementById('mainContainer');
    if (!mc) { pendingTransition = false; return; }
    gsap.set(mc, { opacity: 1, y: 0 });
    var kids = mc.children && mc.children.length ? Array.prototype.slice.call(mc.children) : [];
    if (kids.length) {
      gsap.fromTo(kids,
        { opacity: 0, y: 16 },
        { opacity: 1, y: 0, duration: 0.42, ease: 'power2.out', stagger: 0.05, clearProps: 'transform' });
    }
    pendingTransition = false;
  }

  /* ---------------- 按钮涟漪微交互 ---------------- */
  function bindRipple() {
    if (reduce) return;
    document.addEventListener('pointerdown', function (e) {
      var t = e.target;
      var btn = t && t.closest ? t.closest('button,.btn,[data-tab],.hs-item') : null;
      if (!btn) return;
      btn.classList.add('ripple-host');
      var rect = btn.getBoundingClientRect();
      var size = Math.max(rect.width, rect.height);
      var ripple = document.createElement('span');
      ripple.className = 'motion-ripple';
      ripple.style.width = ripple.style.height = size + 'px';
      ripple.style.left = (e.clientX - rect.left - size / 2) + 'px';
      ripple.style.top = (e.clientY - rect.top - size / 2) + 'px';
      btn.appendChild(ripple);
      gsap.fromTo(ripple, { scale: 0, opacity: 0.35 },
        { scale: 2.2, opacity: 0, duration: 0.6, ease: 'power1.out', onComplete: function () {
          if (ripple.parentNode) ripple.parentNode.removeChild(ripple);
        } });
    }, { passive: true });
  }

  /* ---------------- 装配 ---------------- */
  function init() {
    scanReveals(document);

    // 顶栏 / 主区 / 页脚 入场
    watchReveal(document.getElementById('appHeader'), { y: 14 });
    watchReveal(document.getElementById('mainContainer'), { y: 18 });
    watchReveal(document.getElementById('appFooter'), { y: 14 });

    // 登录弹窗入场（Bootstrap modal 显示后）
    var loginModal = document.getElementById('loginModal');
    if (loginModal) {
      var playedLogin = false;
      var playLogin = function () {
        if (playedLogin) return;
        if (!loginModal.classList.contains('show')) return;
        playedLogin = true;
        if (reduce) return;
        var content = loginModal.querySelector('.modal-content') || loginModal;
        var items = content.children && content.children.length
          ? Array.prototype.slice.call(content.children) : [content];
        gsap.fromTo(items, { opacity: 0, y: 22, scale: 0.98 },
          { opacity: 1, y: 0, scale: 1, duration: 0.5, ease: 'back.out(1.4)', stagger: 0.06, clearProps: 'transform' });
      };
      loginModal.addEventListener('shown.bs.modal', playLogin);
      if ('MutationObserver' in window) {
        new MutationObserver(function () { playLogin(); }).observe(loginModal, { attributes: true, attributeFilter: ['class'] });
      }
      // 兜底：若已直接显示
      if (loginModal.classList.contains('show')) playLogin();
    }

    // 标签切换：OUT（捕获点击 + 包装 switchTab），IN（MutationObserver）
    document.addEventListener('click', function (e) {
      var t = e.target;
      var tab = t && t.closest ? t.closest('[data-tab]') : null;
      if (tab) beginViewTransition();
    }, true);

    // switchTab 由后续脚本（main.js）在全局定义；此处立即尝试，并在 DOMContentLoaded 兜底包装
    function wrapSwitchTab() {
      if (window.__switchWrapped) return;
      if (typeof window.switchTab === 'function') {
        var _orig = window.switchTab;
        window.switchTab = function () {
          beginViewTransition();
          return _orig.apply(this, arguments);
        };
        window.__switchWrapped = true;
      }
    }
    wrapSwitchTab();
    document.addEventListener('DOMContentLoaded', wrapSwitchTab);

    var mc = document.getElementById('mainContainer');
    if (mc && 'MutationObserver' in window) {
      var mo = new MutationObserver(function () {
        if (pendingTransition) {
          // 等待 DOM 稳定一帧再播放 IN
          requestAnimationFrame(endViewTransition);
        }
        scanReveals(mc);
      });
      mo.observe(mc, { childList: true, subtree: true });
    }

    // 动态内容的滚动揭示（SPA 各标签按需渲染）
    if ('MutationObserver' in window) {
      var moBody = new MutationObserver(function () { scanReveals(document); });
      moBody.observe(document.body, { childList: true, subtree: false });
    }

    bindRipple();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 暴露手动刷新（与 reveal.js 的 window.refreshReveal 对齐）
  window.refreshReveal = scanReveals;
})();
