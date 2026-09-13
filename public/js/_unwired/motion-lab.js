// 境途同游 — Motion.Lab 轻量动效层
// 提供两类符合百度设计规范（轻量、克制）的微交互：
//   1) ripple-click：按钮点击涟漪（pointerdown 事件委托，自动跳过 reduced-motion）
//   2) fade-in-up：卡片/区块进入视口时的淡入上移（IntersectionObserver + MutationObserver，
//      自动接住 SPA 动态渲染的内容；尊重 prefers-reduced-motion）
(function () {
  'use strict';

  var reduceMotion = !!(window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  /* ==================== 1. 点击涟漪 ==================== */
  function createRipple(e) {
    if (reduceMotion) return;
    var target = e.target && e.target.closest ? e.target.closest('.btn, [data-ripple]') : null;
    if (!target) return;
    // 涟漪需要定位上下文；.btn 在 04-components.css 已设 position:relative + overflow:hidden
    if (getComputedStyle(target).position === 'static') {
      target.style.position = 'relative';
    }
    var rect = target.getBoundingClientRect();
    var size = Math.max(rect.width, rect.height);
    var ripple = document.createElement('span');
    ripple.className = 'ripple';
    ripple.style.width = ripple.style.height = size + 'px';
    ripple.style.left = (e.clientX - rect.left - size / 2) + 'px';
    ripple.style.top = (e.clientY - rect.top - size / 2) + 'px';
    target.appendChild(ripple);
    var cleanup = function () { if (ripple.parentNode) ripple.parentNode.removeChild(ripple); };
    ripple.addEventListener('animationend', cleanup);
    // 兜底：极端情况下 animationend 不触发时仍移除
    setTimeout(cleanup, 800);
  }

  if (!reduceMotion) {
    document.addEventListener('pointerdown', createRipple, { passive: true });
  }

  /* ==================== 2. 进入视口淡入上移 ==================== */
  var CARD_SEL = '.card, .admin-user-card, .me-stat-card, .stat-card, .glass-card, .home-feature-card';
  // 仅对主内容区卡片做入场，排除弹窗内部（避免弹窗打开时整片动画）
  var SCOPE = 'main, #app, .container, [role="main"], .app-main';

  var io = ('IntersectionObserver' in window) ? new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      var el = entry.target;
      el.classList.add('ml-rise');
      // 动画结束后移除类，避免 animation-fill 长期覆盖 :hover 的 transform
      var onEnd = function () {
        el.classList.remove('ml-rise');
        el.removeEventListener('animationend', onEnd);
      };
      el.addEventListener('animationend', onEnd);
      io.unobserve(el);
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 }) : null;

  function tagCard(el) {
    if (!el || el.dataset.ml || (el.closest && el.closest('.modal'))) return;
    el.dataset.ml = '1';
    if (io) {
      io.observe(el);
    } else {
      el.classList.add('ml-rise'); // 无 IO 支持时直接显示
    }
  }

  function scan(root) {
    if (!root) return;
    var cards = root.querySelectorAll(CARD_SEL);
    for (var i = 0; i < cards.length; i++) tagCard(cards[i]);
  }

  function init() {
    scan(document.querySelector(SCOPE) || document.body);
    // 接住 SPA 动态插入的卡片（tab 切换 / 列表重渲染）
    if ('MutationObserver' in window) {
      var mo = new MutationObserver(function (mutations) {
        for (var m = 0; m < mutations.length; m++) {
          var added = mutations[m].addedNodes;
          for (var n = 0; n < added.length; n++) {
            var node = added[n];
            if (node.nodeType !== 1) continue;
            if (node.matches && node.matches(CARD_SEL)) {
              tagCard(node);
            } else if (node.querySelectorAll) {
              var inner = node.querySelectorAll(CARD_SEL);
              for (var k = 0; k < inner.length; k++) tagCard(inner[k]);
            }
          }
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.MotionLab = { scan: scan, tag: tagCard };
})();
