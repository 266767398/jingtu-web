// ==================== 页面空闲冻结 / 交互解冻（节约带宽与内存） ====================
// 需求：网站无用户操作（鼠标/键盘/滚动/点击/触摸/聚焦）连续 2 分钟后进入「冻结」态，
// 各业务模块通过注册回调暂停后台轮询定时器与 WebSocket 心跳，节省带宽、内存与 CPU；
// 任意一次用户操作立即「解冻」，恢复全部轮询与实时连接。
//
// 对外接口：
//   window.__freeze.isFrozen()                          → boolean
//   window.__freeze.register({ onFreeze, onUnfreeze })  → 注册冻结/解冻回调
//     - 若注册时已处于冻结态，会立即调用 onFreeze（兼容懒加载模块在冻结后才注入）
//
// 事件监听采用捕获阶段（capture: true, passive: true），即使业务代码 stopPropagation
// 也不影响空闲检测；mousemove 带 3s 节流 + 6px 位移阈值，鼠标原地悬停不触发解冻。
// 页面隐藏（切后台 Tab）时由浏览器自身节流，本模块不额外冻结；回到可见即重置计时。
(function () {
  'use strict';

  var IDLE_MS = 2 * 60 * 1000;   // 2 分钟无操作 → 冻结
  var MOVE_THROTTLE_MS = 3000;   // mousemove 判定节流
  var MOVE_DELTA = 6;            // 位移阈值（px）：低于视为「悬停抖动」，不算操作

  var frozen = false;
  var idleTimer = null;
  var callbacks = [];
  var lastMoveAt = 0;
  var lastMovePos = null;

  function warn(kind, e) {
    try {
      // eslint-disable-next-line no-console
      console.warn('[freeze] ' + kind + ' 回调异常:', e && e.message ? e.message : e);
    } catch (err) { /* 忽略 */ }
  }

  function fire(kind) {
    for (var i = 0; i < callbacks.length; i++) {
      var fn = callbacks[i] && callbacks[i][kind];
      if (typeof fn === 'function') {
        try { fn(); } catch (e) { warn(kind, e); }
      }
    }
  }

  function freeze() {
    if (frozen) return;
    frozen = true;
    try { document.documentElement.classList.add('site-frozen'); } catch (e) {}
    try { document.dispatchEvent(new CustomEvent('page:freeze')); } catch (e) {}
    fire('onFreeze');
  }

  function unfreeze() {
    if (!frozen) return;
    frozen = false;
    try { document.documentElement.classList.remove('site-frozen'); } catch (e) {}
    try { document.dispatchEvent(new CustomEvent('page:unfreeze')); } catch (e) {}
    fire('onUnfreeze');
  }

  // 任意用户操作：重置空闲计时；若当前已冻结则立即解冻
  function onActivity() {
    if (frozen) unfreeze();
    clearTimeout(idleTimer);
    idleTimer = setTimeout(freeze, IDLE_MS);
  }

  // mousemove：节流 + 位移判定，避免把「鼠标悬停」当成活动
  function onMove(e) {
    var now = Date.now();
    if (now - lastMoveAt < MOVE_THROTTLE_MS) return;
    var x = e.clientX, y = e.clientY;
    if (lastMovePos && Math.abs(x - lastMovePos.x) < MOVE_DELTA && Math.abs(y - lastMovePos.y) < MOVE_DELTA) return;
    lastMovePos = { x: x, y: y };
    lastMoveAt = now;
    onActivity();
  }

  // 明确的用户操作事件
  var ACTIVITY_EVENTS = ['mousedown', 'keydown', 'pointerdown', 'touchstart', 'scroll', 'wheel', 'focus'];
  for (var i = 0; i < ACTIVITY_EVENTS.length; i++) {
    document.addEventListener(ACTIVITY_EVENTS[i], onActivity, { capture: true, passive: true });
  }
  document.addEventListener('mousemove', onMove, { capture: true, passive: true });

  // 回到可见 Tab 视为一次活动：刷新空闲计时并解冻
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) onActivity();
  });

  window.__freeze = {
    isFrozen: function () { return frozen; },
    register: function (entry) {
      if (!entry || typeof entry !== 'object') return;
      callbacks.push(entry);
      // 模块可能在冻结后才被懒加载：立即同步当前状态
      if (frozen && typeof entry.onFreeze === 'function') {
        try { entry.onFreeze(); } catch (e) { warn('onFreeze', e); }
      }
    }
  };

  // 页面打开即视为一次活动，避免刚加载就冻结
  onActivity();
})();
