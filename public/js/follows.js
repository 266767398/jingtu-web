// ==================== 关注系统（成员端） ====================
// 对应后端 server/routes/follows.js（docs/10 §6）。
// 通过 GET/POST/DELETE /api/follows/* 驱动；目标用户通过 GET /api/users/search 发现。
(function () {
  'use strict';

  function errMsg(d) {
    try {
      if (!d) return '';
      if (typeof d.error === 'string') return d.error;
      if (d.error && typeof d.error === 'object') {
        const code = d.error.code;
        if (code) { const t = __('error.' + code); if (t && t !== 'error.' + code) return t; }
        return d.error.message || code || '';
      }
      return '';
    } catch (e) { return ''; }
  }

  async function req(method, path, body) {
    const opts = { method };
    if (body !== undefined) {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(body);
    }
    const res = await api(path, opts);
    const d = await res.json().catch(() => ({}));
    return { res, d };
  }

  function avatar(u) {
    return (u && (u.avatarUrl || u.vrchat_avatar_url)) || '/api/avatar/default';
  }
  function name(u) {
    return (u && (u.displayName || u.display_name)) || __('common.user');
  }

  function userRowHtml(u, actionsHtml) {
    return `
      <div class="social-row">
        <img class="social-avatar" src="${escAttr(avatar(u))}" alt="${escAttr(name(u))}" onerror="this.src='/api/avatar/default'">
        <div class="social-meta">
          <div class="social-name">${esc(name(u))}</div>
          ${u && u.vrchatName ? `<div class="social-sub text-13 text-muted2">${esc(u.vrchatName)}</div>` : ''}
        </div>
        <div class="social-actions">${actionsHtml}</div>
      </div>`;
  }

  function btn(action, id, label, cls) {
    return `<button class="btn btn-sm ${cls || 'btn-outline'}" data-action="${action}" data-id="${id}">${esc(label)}</button>`;
  }

  // ==================== 渲染入口 ====================
  function showFollows() {
    const root = document.getElementById('tab-follows');
    if (!root) return;
    root.innerHTML = `
      <div class="social-wrap">
        <h2 class="section-title">${__('follows.title')}</h2>
        <div class="social-search">
          <input id="followSearch" class="form-control" type="text" placeholder="${escAttr(__('friends.search_placeholder'))}" autocomplete="off">
          <div id="followSearchResults" class="social-search-results"></div>
        </div>
        <div class="social-section">
          <h3 class="social-h3">${__('follows.following')}</h3>
          <div id="followFollowing"></div>
        </div>
        <div class="social-section">
          <h3 class="social-h3">${__('follows.followers')}</h3>
          <div id="followFollowers"></div>
        </div>
      </div>`;
    bindFollowsEvents();
    loadFollowing();
    loadFollowers();
  }

  // ==================== 数据加载 ====================
  async function loadFollowing() {
    const el = document.getElementById('followFollowing');
    if (!el) return;
    try {
      const res = await api('/api/follows/following', { method: 'GET' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { el.innerHTML = `<div class="text-muted2 p-16">${esc(errMsg(d))}</div>`; return; }
      const list = (d.list || []);
      if (!list.length) { el.innerHTML = `<div class="text-muted2 p-16">${esc(__('follows.no_following'))}</div>`; return; }
      el.innerHTML = list.map(r => userRowHtml(r, btn('unfollow', r.id, __('follows.unfollow'), 'btn-danger'))).join('');
    } catch (e) {
      if (isApiHandledError(e)) return;
      el.innerHTML = `<div class="text-muted2 p-16">${esc(e.message)}</div>`;
    }
  }

  async function loadFollowers() {
    const el = document.getElementById('followFollowers');
    if (!el) return;
    try {
      const res = await api('/api/follows/followers', { method: 'GET' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { el.innerHTML = `<div class="text-muted2 p-16">${esc(errMsg(d))}</div>`; return; }
      const list = (d.list || []);
      if (!list.length) { el.innerHTML = `<div class="text-muted2 p-16">${esc(__('follows.no_followers'))}</div>`; return; }
      // 粉丝列表：提供关注/取关切换（后端幂等）
      el.innerHTML = list.map(r => userRowHtml(r, btn('follow', r.id, __('follows.follow'), 'btn-accent'))).join('');
    } catch (e) {
      if (isApiHandledError(e)) return;
      el.innerHTML = `<div class="text-muted2 p-16">${esc(e.message)}</div>`;
    }
  }

  async function loadSearch(q) {
    const el = document.getElementById('followSearchResults');
    if (!el) return;
    if (!q || q.trim().length < 2) { el.innerHTML = ''; return; }
    try {
      const res = await api('/api/users/search?q=' + encodeURIComponent(q.trim()), { method: 'GET' });
      const d = await res.json().catch(() => ({}));
      const users = d.users || [];
      if (!res.ok) { el.innerHTML = `<div class="text-muted2 p-8">${esc(errMsg(d))}</div>`; return; }
      if (!users.length) { el.innerHTML = `<div class="text-muted2 p-8">${esc(__('follows.no_results'))}</div>`; return; }
      el.innerHTML = users.map(u => userRowHtml(u, btn('follow', u.id, __('follows.follow'), 'btn-accent'))).join('');
    } catch (e) {
      if (isApiHandledError(e)) return;
      el.innerHTML = `<div class="text-muted2 p-8">${esc(e.message)}</div>`;
    }
  }

  // ==================== 操作 ====================
  async function doAction(action, id) {
    try {
      let r;
      if (action === 'follow') r = await req('POST', '/api/follows', { targetUserId: id });
      else if (action === 'unfollow') r = await req('DELETE', '/api/follows/' + id);
      else return;

      if (!r.res.ok) { toast(errMsg(r.d) || __('follows.operation_failed'), 'error'); return; }
      const msg = (action === 'follow') ? __('follows.followed') : __('follows.unfollowed');
      toast(msg, 'success');
      if (action === 'follow') { const s = document.getElementById('followSearch'); if (s) loadSearch(s.value); }
      loadFollowing(); loadFollowers();
    } catch (e) {
      if (isApiHandledError(e)) return;
      toast(e.message, 'error');
    }
  }

  function bindFollowsEvents() {
    const root = document.getElementById('tab-follows');
    if (!root) return;
    // 根节点点击委托只需绑定一次（root 容器本身不会被替换）
    if (!root.dataset.bound) {
      root.dataset.bound = '1';
      root.addEventListener('click', (e) => {
        const b = e.target.closest('[data-action]');
        if (!b) return;
        doAction(b.dataset.action, parseInt(b.dataset.id));
      });
    }
    // 搜索输入框每次渲染都会被重建，必须重新绑定，否则二次进入 tab 后搜索失效
    const search = document.getElementById('followSearch');
    if (search) {
      search.addEventListener('input', debounce(() => loadSearch(search.value), 300));
    }
  }

  window.showFollows = showFollows;
})();
