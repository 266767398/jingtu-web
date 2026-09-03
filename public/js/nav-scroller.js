// nav-scroller.js — 顶部标签栏边缘滑动 + 左右翻页按钮（需求③改进）
// 桌面端 .tabs 为单行「溢出隐藏」；当鼠标靠近标签栏【自身】左/右边缘时，
// 导航内容自动向左/右平滑滑动；并提供与标签栏实际边缘对齐的可见翻页按钮，
// 点击即可翻页。检测范围基于标签栏真实几何（getBoundingClientRect），
// 而非视口边缘，避免页面其它区域误触发。

(function () {
  'use strict';

  var tabs = document.querySelector('#mainContainer > .tabs');
  if (!tabs) return;

  var mq = window.matchMedia('(min-width: 769px)');
  var EDGE = 200;       // 距标签栏自身边缘多少像素内触发自动滑动（范围加大，速度梯度更明显）
  var STEP = 6;         // 基础每帧滑动像素（进入检测区外侧的起步速度）
  var MAX_SPEED = 30;   // 越靠近边缘滑动越快（上限，已上调以拉开速度区间）
  var CLICK_STEP = 200; // 点击翻页按钮一次滚动的像素
  var raf = null;
  var velocity = 0;     // 当前方向：-1 左 / 1 右 / 0 停

  // ---- 同步 header 实际高度给 CSS 变量，让 tabs 的 sticky top 紧贴 header 下方 ----
  function updateHeaderHeight() {
    var header = document.querySelector('body > header');
    var h = 68; // 兜底：单行 header 约 60-64px + 少量间距
    if (header) {
      var r = header.getBoundingClientRect();
      if (r.height > 0) h = Math.ceil(r.height);
    }
    document.documentElement.style.setProperty('--header-height', h + 'px');
  }

  function overflowing() {
    return tabs.scrollWidth - tabs.clientWidth > 2;
  }
  function maxScroll() {
    return Math.max(0, tabs.scrollWidth - tabs.clientWidth);
  }
  function clamp(v) {
    return Math.max(0, Math.min(maxScroll(), v));
  }

  // ---- 创建左右翻页按钮（固定定位，覆盖在标签栏真实边缘，避免被 overflow 裁剪）----
  function makeBtn(cls, label, dir) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'tab-scroll-btn ' + cls;
    b.setAttribute('aria-label', label);
    b.textContent = dir < 0 ? '‹' : '›';
    b.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      tabs.scrollLeft = clamp(tabs.scrollLeft + dir * CLICK_STEP);
      updateButtons();
    });
    b.addEventListener('mouseenter', function () { setVelocity(0); });
    document.body.appendChild(b);
    return b;
  }
  var btnL = makeBtn('tab-scroll-left', __('auto_nav_scroller_1'), -1);
  var btnR = makeBtn('tab-scroll-right', __('auto_nav_scroller_2'), 1);

  function tick() {
    if (velocity === 0 || !overflowing()) { raf = null; return; }
    var next = clamp(tabs.scrollLeft + velocity);
    if (next === tabs.scrollLeft) { raf = null; velocity = 0; return; }
    tabs.scrollLeft = next;
    raf = requestAnimationFrame(tick);
  }
  function setVelocity(v) {
    if (velocity === v) return;
    velocity = v;
    if (v !== 0 && !raf) raf = requestAnimationFrame(tick);
    if (v === 0 && raf) { cancelAnimationFrame(raf); raf = null; }
  }

  // 将翻页按钮定位到标签栏「实际」左/右边缘，并按滚动位置控制显隐
  function updateButtons() {
    if (!mq.matches || !overflowing()) { hideButtons(); return; }
    var r = tabs.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) { hideButtons(); return; } // 被隐藏（如首页）
    var canLeft = tabs.scrollLeft > 2;
    var canRight = tabs.scrollLeft < maxScroll() - 2;
    btnL.classList.toggle('show', canLeft);
    btnR.classList.toggle('show', canRight);
    var top = r.top + r.height / 2;
    btnL.style.top = top + 'px';
    btnR.style.top = top + 'px';
    btnL.style.left = (r.left + 16) + 'px';
    btnR.style.left = (r.right - 16) + 'px';
  }
  function hideButtons() {
    btnL.classList.remove('show');
    btnR.classList.remove('show');
  }

  function onMove(e) {
    if (!mq.matches) { setVelocity(0); return; }
    if (e.target === btnL || e.target === btnR) { setVelocity(0); return; }
    if (!overflowing()) { setVelocity(0); updateButtons(); return; }
    var r = tabs.getBoundingClientRect();
    // 仅在鼠标位于选项栏自身垂直范围内才检测，避免页面其它区域误触发翻页
    var yOK = e.clientY >= r.top && e.clientY <= r.bottom;
    if (!yOK) { setVelocity(0); updateButtons(); return; }
    var x = e.clientX;
    // 速度映射：采用较平缓的指数（1.3）曲线 + 起步速度，
    // 使鼠标从检测区外缘向边缘移动时速度“肉眼可见地”持续提升（而非仅贴边才猛增）。
    if (x >= r.left && x <= r.left + EDGE) {
      var t1 = 1 - (x - r.left) / EDGE;            // 0~1，越靠边越大
      var e1 = Math.pow(t1, 1.3);                  // 平缓缓动，速度梯度更明显
      setVelocity(-(STEP + (MAX_SPEED - STEP) * e1));
    } else if (x <= r.right && x >= r.right - EDGE) {
      var t2 = 1 - (r.right - x) / EDGE;
      var e2 = Math.pow(t2, 1.3);
      setVelocity(STEP + (MAX_SPEED - STEP) * e2);
    } else {
      setVelocity(0);
    }
    updateButtons();
  }

  window.addEventListener('mousemove', onMove, { passive: true });
  window.addEventListener('blur', function () { setVelocity(0); });
  document.addEventListener('mouseleave', function () { setVelocity(0); });
  tabs.addEventListener('wheel', function (e) {
    if (!overflowing()) return;
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return; // 竖向滚轮交给页面
    var next = clamp(tabs.scrollLeft + e.deltaX);
    if (next !== tabs.scrollLeft) tabs.scrollLeft = next;
    e.preventDefault();
    updateButtons();
  }, { passive: false });
  tabs.addEventListener('scroll', updateButtons, { passive: true });
  window.addEventListener('resize', function () { updateHeaderHeight(); setVelocity(0); updateButtons(); });
  window.addEventListener('scroll', function () { updateHeaderHeight(); updateButtons(); }, { passive: true });
  mq.addEventListener('change', function () { setVelocity(0); updateButtons(); });
  // 标签栏宽度变化（i18n 文本渲染、字体加载、内容增删）→ 重算按钮位置与显隐
  if (window.ResizeObserver) { new ResizeObserver(updateButtons).observe(tabs); }
  // header 高度变化（搜索框展开、body class 切换等）→ 同步 sticky top
  var header = document.querySelector('body > header');
  if (header && window.ResizeObserver) { new ResizeObserver(updateHeaderHeight).observe(header); }
  // 首页隐藏标签栏（body.home-active）→ 同步隐藏翻页按钮
  if (window.MutationObserver) {
    new MutationObserver(function () { updateHeaderHeight(); updateButtons(); }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }
  window.addEventListener('load', function () { updateHeaderHeight(); updateButtons(); });
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', updateHeaderHeight);
  } else {
    updateHeaderHeight();
  }
  setTimeout(function () { updateHeaderHeight(); updateButtons(); }, 400); // 兜底：等待 i18n 文本渲染后重算
  updateHeaderHeight();
  updateButtons();
})();
