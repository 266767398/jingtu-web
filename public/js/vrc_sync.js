// VRChat 收藏同步状态栏（V12.0）
// 顶部全局状态条。同步策略（严格区分自动 vs 手动）：
//  · 首次绑定 VRChat（本地零数据）→ 自动回源官方拉取一次，同步写入 DB；
//  · 已同步过（本地有快照）→ 登录/刷新【只读本地 DB】，绝不自动回源官方；
//  · 之后任何更新 → 只走「拉取同步」按钮手动触发，服务端回源官方 + 写 DB 同一次完成。
// 手动拉取期间在此条展示进度（POST /api/vrc-favorites/sync，后台执行）。
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

  // 登录/会话恢复后调用（由 auth.js showApp 调用）。
  // 同步策略 V12：页面加载/刷新【只读本地 DB 快照】，绝不自动拉官方；
  // 仅当本地完全无数据（首次绑定 VRChat 的新玩家）时自动回源官方一次。
  // 之后任何收藏更新只走用户手动点「拉取同步」按钮。
  window.maybeStartVrcFavSync = function () {
    try {
      if (typeof currentUser === 'undefined' || !currentUser) return;
      if (!currentUser.id || !currentUser.vrchatId) return;
      // 会话恢复场景 nextTick 避免与首屏渲染抢时间片
      setTimeout(function () {
        try { checkLocalThenMaybeFirstSync(); } catch (e) {}
      }, 600);
    } catch (e) {}
  };

  // 查询本地库快照状态：有本地数据 → 仅展示「本地就绪」；完全无数据 → 自动拉一次官方（写入 DB）
  async function checkLocalThenMaybeFirstSync() {
    try {
      const d = await window.apiJson('/api/vrc-favorites/sync-status', { silent: true, timeout: 9000 });
      const sync = d.sync || {};
      const ps = d.perScope || {};
      const w = ps['items:world'] || {}, a = ps['items:avatar'] || {}, f = ps['items:friend'] || {};
      const total = (w.count || 0) + (a.count || 0) + (f.count || 0);
      // 上次同步时间：优先取进程内 lastAt（本进程内同步过），否则取各快照最新拉取时间（DB 可靠值）
      let lastAt = sync.lastAt || 0;
      if (!lastAt) {
        [w, a, f, ps.groups || {}].forEach(s => {
          const t = s.fetchedAt ? new Date(s.fetchedAt).getTime() : 0;
          if (t > lastAt) lastAt = t;
        });
      }
      // 本地已有同步数据：只加载本地，绝不自动回源官方（刷新网站秒开）
      if (lastAt > 0 || total > 0) {
        showResult(
          __('vrcsync.local_ready', { w: w.count || 0, a: a.count || 0, f: f.count || 0 }) +
          ' · 上次同步 ' + fmtTime(lastAt) +
          ' <button type="button" class="btn btn-xs btn-outline vrc-sync-reload" data-act="resync">🔄 ' + __('vrcsync.resync_btn') + '</button>',
          { done: true, keepMs: 8000 }
        );
        return;
      }
      // 本地完全无数据（首次绑定/从未同步）→ 自动回源官方一次，写入 DB 后结束；
      // 之后任何更新只走手动「拉取同步」按钮，这里再也不会走到。
      startFavSync({ startMsg: __('vrcsync.first_sync') });
      return;
    } catch (e) {
      // 状态查询失败：静默（不打断登录流程，刷新只加载本地数据）
    }
  }

  window.vrcSync = {
    startFavSync: startFavSync,
    showTask: showTask,
    taskDone: taskDone,
    hide: hide,
    getState: function () { return _sn; }
  };
})();