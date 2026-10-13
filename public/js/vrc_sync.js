// VRChat 收藏同步状态栏（V10.1）
// 顶部全局状态条：登录/进入站点后自动把 VRChat 官方收藏（地图/模型/好友/分组）
// 快照同步到本地库（POST /api/vrc-favorites/sync，后台执行），同步期间在此条展示进度；
// 收藏页读取走快照零回源、秒开。手动「刷新」、群组同步/在线状态刷新也在此条透出。
(function () {
  'use strict';
  if (window.__vrcSyncLoaded) return;
  window.__vrcSyncLoaded = true;

  const POLL_GAP = 2500;
  const POLL_MAX = 60;

  let _sn = { running: false, step: '', stepLabel: '', stepIndex: 0, stepTotal: 0, lastAt: 0 };
  let _pollTimer = null;
  let _hideTimer = null;
  let _pollCount = 0;
  let _inFlight = false;

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    if (typeof window.esc === 'function') { try { return window.esc(s); } catch (e) { } }
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function __(k, p) {
    if (typeof window.__ === 'function') { try { return window.__(k, p); } catch (e) { } }
    return k;
  }

  function ensureBar() {
    let bar = $('vrcSyncBar');
    if (!bar) {
      const main = document.getElementById('mainContainer');
      if (!main) return null;
      bar = document.createElement('div');
      bar.id = 'vrcSyncBar';
      bar.className = 'vrc-sync-bar d-none';
      bar.setAttribute('role', 'status');
      bar.setAttribute('aria-live', 'polite');
      const tabs = main.querySelector('.tabs');
      if (tabs && tabs.nextSibling) main.insertBefore(bar, tabs.nextSibling);
      else main.appendChild(bar);
    }
    return bar;
  }

  function clearHide() {
    if (_hideTimer) { clearTimeout(_hideTimer); _hideTimer = null; }
  }

  function clearPoll() {
    if (_pollTimer) { clearTimeout(_pollTimer); _pollTimer = null; }
  }

  function fmtTime(ts) {
    if (!ts) return '--:--';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '--:--';
    const p = (n) => (n < 10 ? '0' : '') + n;
    return p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function setState(cls, html, withClose) {
    const bar = ensureBar();
    if (!bar) return;
    clearHide();
    const closeBtn = withClose
      ? '<button type="button" class="vrc-sync-close" data-act="close" title="' + esc(__('vrcsync.close_title')) + '">✕</button>'
      : '';
    bar.className = 'vrc-sync-bar ' + cls;
    bar.innerHTML = '<span class="vrc-sync-inner">' + html + '</span>' + closeBtn;
  }

  function showBusy(text) {
    setState('vrc-sync-busy', '<span class="vrc-sync-spinner"></span><span>' + esc(text) + '</span>');
  }

  function showResult(text, opts) {
    opts = opts || {};
    setState(opts.err ? 'vrc-sync-err' : 'vrc-sync-ok', text, true);
    if (opts.done !== false) {
      clearHide();
      _hideTimer = setTimeout(hide, opts.keepMs || 6000);
    }
  }

  function hide() {
    clearPoll();
    clearHide();
    const bar = $('vrcSyncBar');
    if (bar) bar.classList.add('d-none');
  }

  function schedulePoll(ms) {
    clearPoll();
    _pollTimer = setTimeout(runPoll, ms == null ? POLL_GAP : ms);
  }

  function progressText(sync) {
    const label = sync.stepLabel ? '（' + sync.stepLabel + '）' : '';
    if (sync.stepTotal > 0) {
      return __('vrcsync.syncing_steps', { step: sync.stepIndex || 0, total: sync.stepTotal }) + label + ' ' + (sync.stepIndex || 0) + '/' + sync.stepTotal + ' ...';
    }
    return __('vrcsync.syncing');
  }

  async function runPoll() {
    if (_pollCount >= POLL_MAX) {
      showBusy(__('vrcsync.queued'));
      return;
    }
    _pollCount++;
    try {
      const d = await window.apiJson('/api/vrc-favorites/sync-status', { silent: true, timeout: 9000 });
      const sync = d.sync || {};
      _sn = sync;
      if (sync.running) {
        showBusy(progressText(sync));
        schedulePoll();
        return;
      }
      if ((sync.lastAt || 0) > 0) {
        const ps = d.perScope || {};
        const w = ps['items:world'] || {}, a = ps['items:avatar'] || {}, f = ps['items:friend'] || {};
        const total = (w.count || 0) + (a.count || 0) + (f.count || 0);
        showResult(
          __('vrcsync.done', { w: w.count || 0, a: a.count || 0, f: f.count || 0 }) +
          ' · 上次同步 ' + fmtTime(sync.lastAt) +
          ' <button type="button" class="btn btn-xs btn-outline vrc-sync-reload" data-act="resync">🔄 ' + __('vrcsync.resync_btn') + '</button>',
          { done: true }
        );
        if (typeof window.dispatchEvent === 'function') {
          try { window.dispatchEvent(new CustomEvent('vrcfav:synced', { detail: { total: total } })); } catch (e) {}
        }
        return;
      }
      showResult(__('vrcsync.pending'), { done: true, keepMs: 4000 });
    } catch (e) {
      // 单个状态查询失败：网络抖动，稍后重试
      schedulePoll(4000);
    }
  }

  async function startFavSync(opts) {
    opts = opts || {};
    if (_inFlight) return;
    _inFlight = true;
    try {
      if (!currentUser || !currentUser.id || !currentUser.vrchatId) {
        if (opts.force) { hide(); }
        return;
      }
      try {
        clearPoll();
        clearHide();
        if (opts.startMsg) showBusy(opts.startMsg);
        else showBusy(__('vrcsync.syncing_full'));
        _pollCount = 0;
        await window.apiJson('/api/vrc-favorites/sync', { method: 'POST', silent: true, timeout: 12000 });
      } catch (e) {
        if (opts.silentFail) { hide(); return; }
        showResult(__('vrcsync.start_failed'), { done: true, keepMs: 4000 });
        return;
      }
      schedulePoll(2500);
    } finally {
      _inFlight = false;
    }
  }

  // 通用任务透出（群组同步/在线状态刷新等按钮复用顶部条）
  function showTask(text) {
    clearPoll();
    showBusy(text);
  }

  function taskDone(text, opts) {
    clearPoll();
    let keepMs = 5000, err = false;
    if (typeof opts === 'object' && opts !== null) { keepMs = opts.keepMs != null ? opts.keepMs : keepMs; err = !!opts.err; }
    else if (typeof opts === 'number') keepMs = opts;
    showResult(err ? ('⚠️ ' + text) : text, { err: err, done: keepMs !== 0, keepMs: keepMs });
  }

  // 事件委托：关闭 / 重新同步
  function bindBar() {
    const bar = ensureBar();
    if (!bar) return;
    const onDoc = function (e) {
      const el = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
      if (!el || el.closest('#vrcSyncBar') !== bar) return;
      if (el.getAttribute('data-act') === 'close') { hide(); }
      else if (el.getAttribute('data-act') === 'resync') { hide(); startFavSync({ startMsg: __('vrcsync.resyncing') }); }
    };
    document.addEventListener('click', onDoc);
    return function () { document.removeEventListener('click', onDoc); };
  }
  bindBar();

  // 登录/会话恢复后自动同步（由 auth.js showApp 调用）
  window.maybeStartVrcFavSync = function () {
    try {
      if (typeof currentUser === 'undefined' || !currentUser) return;
      if (!currentUser.id || !currentUser.vrchatId) return;
      // 会话恢复场景 nextTick 避免与首屏渲染抢时间片
      setTimeout(function () {
        try { startFavSync(); } catch (e) {}
      }, 600);
    } catch (e) {}
  };

  window.vrcSync = {
    startFavSync: startFavSync,
    showTask: showTask,
    taskDone: taskDone,
    hide: hide,
    getState: function () { return _sn; }
  };
})();