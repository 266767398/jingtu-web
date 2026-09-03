// reveal.js — 滚动揭示动画接线（配合 animations.css 的 .list-item / .timeline-item / .chart-bar / .rank-item）
// P0 改良：animations.css 此前未被任何文件引入，且揭示系统无 JS 触发。本文件补上 IntersectionObserver。
(function () {
  'use strict';

  // 若 GSAP 动效层已接管滚动揭示，则本模块让位，避免双重动画
  if (window.__motionGSAPEnabled) return;

  var SELECTOR = '.list-item:not(.visible),.timeline-item:not(.visible),.chart-bar:not(.visible),.rank-item:not(.visible)';

  function revealAll(root) {
    (root || document).querySelectorAll(SELECTOR).forEach(function (el) {
      io.observe(el);
    });
  }

  // 不支持 IntersectionObserver 时直接显示，避免内容永久隐藏
  if (!('IntersectionObserver' in window)) {
    document.querySelectorAll(SELECTOR.replace(/:not\(.visible\)/g, '')).forEach(function (el) {
      el.classList.add('visible');
    });
    return;
  }

  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        io.unobserve(entry.target);
      }
    });
  }, { rootMargin: '0px 0px -10% 0px', threshold: 0.05 });

  function init() {
    revealAll(document);
    // 监听动态插入的内容（SPA 各标签页按需渲染），自动为新元素接线
    if ('MutationObserver' in window) {
      var mo = new MutationObserver(function (mutations) {
        mutations.forEach(function (m) {
          m.addedNodes.forEach(function (node) {
            if (node.nodeType === 1) revealAll(node);
          });
        });
      });
      mo.observe(document.body, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 供其他模块手动触发（例如在标签页切换后）
  window.refreshReveal = revealAll;
})();
