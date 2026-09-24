// ==================== 好友系统（成员端） ====================
// 对应后端 server/routes/friends.js（docs/10 §3）。
// 通过 GET/POST/DELETE /api/friends/* 驱动；目标用户通过 GET /api/users/search 发现。
(function () {
  'use strict';

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
    return (u && (u.displayName || u.display_name)) || __('nav.members') || __('common.user');
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
  // F-11 共同好友徽章（点击展开共同好友列表）
  function mutualBadge(id, n) {
    const label = (__('friends.mutual_badge') || __('auto_friends_1')) + ' ' + n;
    return `<button class="btn btn-sm btn-ghost mutual-badge" data-action="mutual" data-id="${id}" title="${esc(label)}">${esc(label)}</button>`;
  }
  // F-11 衍生：共同好友最多 Top5（纯前端只读聚合，零后端/零写入，复用 counts）
  function mutualTopHtml(counts, byId) {
    const entries = Object.keys(counts || {})
      .map(id => ({ id: parseInt(id, 10), count: counts[id] }))
      .filter(x => x.count > 0 && byId[x.id])
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
    if (!entries.length) return '';
    const title = __('friends.mutual_top_title') || __('auto_friends_2');
    return `
      <div class="mutual-top" style="margin:0 0 12px;padding:12px;background:var(--card,#fff);border:1px solid var(--border,#e5e7eb);border-radius:12px;">
        <div style="font-weight:600;margin-bottom:8px;font-size:13px;">${esc(title)}</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;">
          ${entries.map(e => {
            const u = byId[e.id];
            const nm = name(u);
            return `<button class="mutual-top-item" data-action="mutual" data-id="${e.id}" title="${esc(nm + ' · ' + e.count)}" style="display:flex;align-items:center;gap:6px;padding:4px 8px;border:1px solid var(--border,#e5e7eb);border-radius:999px;background:transparent;cursor:pointer;">
              <img src="${escAttr(avatar(u))}" alt="${escAttr(nm)}" style="width:26px;height:26px;border-radius:50%;object-fit:cover;" onerror="this.src='/api/avatar/default'">
              <span style="font-size:12px;max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(nm)}</span>
              <span style="font-size:11px;color:var(--muted,#888);">${e.count}</span>
            </button>`;
          }).join('')}
        </div>
      </div>`;
  }

  // ==================== 渲染入口 ====================
  function showFriends() {
    const root = document.getElementById('tab-friends');
    if (!root) return;
    root.innerHTML = `
      <div class="social-wrap">
        <h2 class="section-title">${__('friends.title')}</h2>
        <div class="social-search">
          <input id="friendSearch" class="form-control" type="text" placeholder="${escAttr(__('friends.search_placeholder'))}" autocomplete="off">
          <div id="friendSearchResults" class="social-search-results"></div>
        </div>
        <div class="social-section">
          <h3 class="social-h3">${__('friends.friend_requests')}</h3>
          <div id="friendRequests"></div>
        </div>
        <div class="social-section">
          <h3 class="social-h3">${__('friends.my_friends')}</h3>
          <div id="friendList"></div>
        </div>
        <div class="social-section">
          <h3 class="social-h3">${__('friends.feed_title')}</h3>
          <div id="friendFeed"></div>
        </div>
        <div class="social-section">
          <h3 class="social-h3">${__('friends.blocked_list')}</h3>
          <div id="friendBlocked"></div>
        </div>
      </div>`;
    bindFriendsEvents();
    loadRequests();
    loadFriends();
    loadFeed();
    loadBlocked();
  }

  // ==================== 数据加载 ====================
  async function loadRequests() {
    const el = document.getElementById('friendRequests');
    if (!el) return;
    try {
      const res = await api('/api/friends/requests', { method: 'GET' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { el.innerHTML = `<div class="text-muted2 p-16">${esc(errText(d))}</div>`; return; }
      const incoming = (d.incoming || []);
      const outgoing = (d.outgoing || []);
      if (!incoming.length && !outgoing.length) {
        el.innerHTML = `<div class="text-muted2 p-16">${esc(__('friends.no_requests'))}</div>`;
        return;
      }
      let html = '';
      if (incoming.length) {
        html += `<div class="social-sublabel">${esc(__('friends.incoming'))}</div>`;
        html += incoming.map(r => userRowHtml(r,
          btn('accept', r.requestId, __('friends.accept'), 'btn-accent') +
          btn('reject', r.requestId, __('friends.reject'), 'btn-danger')
        )).join('');
      }
      if (outgoing.length) {
        html += `<div class="social-sublabel">${esc(__('friends.outgoing'))}</div>`;
        html += outgoing.map(r => userRowHtml(r,
          btn('cancel', r.id, __('friends.cancel_request'))
        )).join('');
      }
      el.innerHTML = html;
    } catch (e) {
      if (isApiHandledError(e)) return;
      el.innerHTML = `<div class="text-muted2 p-16">${esc(e.message)}</div>`;
    }
  }

  async function loadFriends() {
    const el = document.getElementById('friendList');
    if (!el) return;
    try {
      const [fRes, mRes] = await Promise.all([
        api('/api/friends?status=accepted', { method: 'GET' }),
        api('/api/friends/mutuals', { method: 'GET' })
      ]);
      const d = await fRes.json().catch(() => ({}));
      if (!fRes.ok) { el.innerHTML = `<div class="text-muted2 p-16">${esc(errText(d))}</div>`; return; }
      const list = (d.list || []);
      const md = await mRes.json().catch(() => ({}));
      const counts = (md && md.counts) || {};
      if (!list.length) { el.innerHTML = `<div class="text-muted2 p-16">${esc(__('friends.no_friends'))}</div>`; return; }
      const byId = {};
      list.forEach(u => { byId[u.id] = u; });
      el.innerHTML = mutualTopHtml(counts, byId) + list.map(r => userRowHtml(r,
        mutualBadge(r.id, counts[r.id] || 0) +
        btn('history', r.id, __('friends.history'), 'btn-ghost') +
        btn('worldhist', r.id, __('friends.world_history'), 'btn-ghost') +
        btn('message', r.id, __('chat.dm'), 'btn-outline') +
        btn('block', r.id, __('friends.block'), 'btn-outline') +
        btn('remove', r.id, __('friends.remove'), 'btn-danger')
      )).join('');
    } catch (e) {
      if (isApiHandledError(e)) return;
      el.innerHTML = `<div class="text-muted2 p-16">${esc(e.message)}</div>`;
    }
  }

  async function loadBlocked() {
    const el = document.getElementById('friendBlocked');
    if (!el) return;
    try {
      const res = await api('/api/friends?status=blocked', { method: 'GET' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { el.innerHTML = `<div class="text-muted2 p-16">${esc(errText(d))}</div>`; return; }
      const list = (d.list || []);
      if (!list.length) { el.innerHTML = `<div class="text-muted2 p-16">${esc(__('friends.no_friends'))}</div>`; return; }
      el.innerHTML = list.map(r => userRowHtml(r,
        btn('unblock', r.id, __('friends.unblock'), 'btn-accent')
      )).join('');
    } catch (e) {
      if (isApiHandledError(e)) return;
      el.innerHTML = `<div class="text-muted2 p-16">${esc(e.message)}</div>`;
    }
  }

  async function loadSearch(q) {
    const el = document.getElementById('friendSearchResults');
    if (!el) return;
    if (!q || q.trim().length < 2) { el.innerHTML = ''; return; }
    try {
      const res = await api('/api/users/search?q=' + encodeURIComponent(q.trim()), { method: 'GET' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { el.innerHTML = `<div class="text-muted2 p-8">${esc(errText(d))}</div>`; return; }
      const users = d.users || [];
      if (!users.length) { el.innerHTML = `<div class="text-muted2 p-8">${esc(__('friends.no_friends'))}</div>`; return; }
      el.innerHTML = users.map(u => userRowHtml(u,
        btn('add', u.id, __('friends.send_request'), 'btn-accent')
      )).join('');
    } catch (e) {
      if (isApiHandledError(e)) return;
      el.innerHTML = `<div class="text-muted2 p-8">${esc(e.message)}</div>`;
    }
  }

  // ==================== F-12 好友动态 Feed ====================
  let _feedPage = 1;
  let _feedDone = false;

  function fmtTime(t) {
    if (!t) return '';
    const d = new Date(t);
    if (isNaN(d.getTime())) return '';
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function feedItemHtml(it) {
    const nm = esc(it.userName || '');
    const time = esc(fmtTime(it.time));
    const av = escAttr(it.avatarUrl || '/api/avatar/default');
    let body = '';
    if (it.kind === 'post') {
      const verb = __('friends.feed_post');
      body = `<div class="text-13" style="margin:4px 0 0;color:var(--text,#333);">${esc(it.content || '')}</div>`;
      body += `<div class="text-12" style="margin-top:4px;color:var(--muted,#999);">❤ ${it.likeCount || 0} · 💬 ${it.commentCount || 0}</div>`;
    } else if (it.kind === 'event_sign') {
      const verb = __('friends.feed_sign');
      body = `<div class="text-13" style="margin:4px 0 0;color:var(--text,#333);">${esc(it.eventTitle || '')}</div>`;
    } else if (it.kind === 'photo') {
      const verb = __('friends.feed_photo');
      body = `<img src="${escAttr(it.thumbPath || it.photoPath)}" alt="" loading="lazy" onerror="this.style.display='none'" style="margin-top:6px;max-width:100%;border-radius:8px;max-height:220px;object-fit:cover;">`;
      if (it.desc) body += `<div class="text-13" style="margin:4px 0 0;color:var(--text,#333);">${esc(it.desc)}</div>`;
    } else {
      return '';
    }
    return `
      <div class="social-row feed-item" style="align-items:flex-start;">
        <img class="social-avatar" src="${av}" alt="${nm}" onerror="this.src='/api/avatar/default'">
        <div class="social-meta" style="flex:1;">
          <div class="social-name">${nm} <span class="text-12 text-muted2">${esc(__('friends.feed_' + (it.kind === 'post' ? 'post' : it.kind === 'event_sign' ? 'sign' : 'photo')))}</span></div>
          <div class="text-12 text-muted2">${time}</div>
          ${body}
        </div>
      </div>`;
  }

  async function loadFeed(reset) {
    const el = document.getElementById('friendFeed');
    if (!el) return;
    if (reset) { _feedPage = 1; _feedDone = false; }
    try {
      const res = await api(`/api/friends/feed?page=${_feedPage}&pageSize=15`, { method: 'GET' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { if (reset) el.innerHTML = `<div class="text-muted2 p-16">${esc(errText(d))}</div>`; return; }
      const items = d.items || [];
      if (reset && !items.length) {
        el.innerHTML = `<div class="text-muted2 p-16">${esc(__('friends.feed_empty'))}</div>`;
        _feedDone = true;
        return;
      }
      let html = (reset ? '' : el.innerHTML.replace(/<button[^>]*data-feed-more[\s\S]*$/, ''));
      html += items.map(feedItemHtml).join('');
      // “加载更多”按钮：本页仍有下一页数据时展示
      if (items.length >= 15 && !_feedDone) {
        html += `<div class="text-center p-8"><button class="btn btn-sm btn-outline" data-feed-more>${esc(__('friends.feed_load_more'))}</button></div>`;
      } else {
        _feedDone = true;
      }
      el.innerHTML = html;
      _feedPage += 1;
    } catch (e) {
      if (isApiHandledError(e)) return;
      if (reset) el.innerHTML = `<div class="text-muted2 p-16">${esc(e.message)}</div>`;
    }
  }

  // ==================== F-11 共同好友弹窗 ====================
  let _mutualModalReady = false;
  function ensureMutualModal() {
    if (_mutualModalReady && document.getElementById('mutualFriendsModal')) return;
    const el = document.createElement('div');
    el.className = 'modal';
    el.id = 'mutualFriendsModal';
    el.style.display = 'none';
    el.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h3 id="mutualFriendsTitle" class="modal-title"></h3>
          <button class="modal-close" data-modal-close="mutualFriendsModal" aria-label="close">&times;</button>
        </div>
        <div class="modal-body" id="mutualFriendsBody"></div>
      </div>`;
    document.body.appendChild(el);
    _mutualModalReady = true;
  }

  async function showMutualFriends(id) {
    ensureMutualModal();
    const title = document.getElementById('mutualFriendsTitle');
    const body = document.getElementById('mutualFriendsBody');
    if (title) title.textContent = __('friends.mutual_title') || __('auto_friends_4');
    if (body) body.innerHTML = `<div class="text-muted2 p-16">${esc(__('common.loading') || __('auto_friends_5'))}</div>`;
    showModal('mutualFriendsModal');
    try {
      const res = await api('/api/friends/mutuals/' + id, { method: 'GET' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { if (body) body.innerHTML = `<div class="text-muted2 p-16">${esc(errText(d))}</div>`; return; }
      const list = d.mutualFriends || [];
      if (title) title.textContent = (__('friends.mutual_title') || __('auto_friends_6')) + '（' + (d.count || 0) + '）';
      if (body) body.innerHTML = list.length
        ? list.map(u => userRowHtml(u, btn('message', u.id, __('chat.dm'), 'btn-outline'))).join('')
        : `<div class="text-muted2 p-16">${esc(__('friends.no_mutual') || __('auto_friends_7'))}</div>`;
    } catch (e) {
      if (isApiHandledError(e)) return;
      if (body) body.innerHTML = `<div class="text-muted2 p-16">${esc(e.message)}</div>`;
    }
  }

  // ==================== F-13 好友变更历史 ====================
  let _histModalReady = false;
  function ensureHistModal() {
    if (_histModalReady && document.getElementById('friendHistModal')) return;
    const el = document.createElement('div');
    el.className = 'modal';
    el.id = 'friendHistModal';
    el.style.display = 'none';
    el.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h3 id="friendHistTitle" class="modal-title"></h3>
          <button class="modal-close" data-modal-close="friendHistModal" aria-label="close">&times;</button>
        </div>
        <div class="modal-body" id="friendHistBody"></div>
      </div>`;
    document.body.appendChild(el);
    _histModalReady = true;
  }

  // change_type → 本地化文案映射（后端返回 name|avatar|online|offline|status|world）
  function histTypeLabel(t) {
    const map = {
      name: 'friends.hist_name',
      avatar: 'friends.hist_avatar',
      online: 'friends.hist_online',
      offline: 'friends.hist_offline',
      status: 'friends.hist_status',
      world: 'friends.hist_world'
    };
    const key = map[t] || 'friends.hist_unknown';
    return __(key);
  }

  async function showFriendHistory(id) {
    ensureHistModal();
    const title = document.getElementById('friendHistTitle');
    const body = document.getElementById('friendHistBody');
    if (title) title.textContent = __('friends.hist_title');
    if (body) body.innerHTML = `<div class="text-muted2 p-16">${esc(__('common.loading') || '加载中...')}</div>`;
    showModal('friendHistModal');
    try {
      const res = await api('/api/friends/history/' + id, { method: 'GET' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { if (body) body.innerHTML = `<div class="text-muted2 p-16">${esc(errText(d))}</div>`; return; }
      const items = d.items || [];
      if (!items.length) {
        if (body) body.innerHTML = `<div class="text-muted2 p-16">${esc(__('friends.hist_empty'))}</div>`;
        return;
      }
      if (body) body.innerHTML = items.map(r => {
        const t = fmtTime(r.time);
        return `
          <div class="hist-item" style="display:flex;gap:10px;padding:10px 0;border-bottom:1px solid var(--border,#e5e7eb);">
            <div style="flex-shrink:0;width:auto;min-width:72px;font-size:12px;color:var(--muted,#888);padding-top:2px;">${esc(t)}</div>
            <div style="flex:1;min-width:0;">
              <div class="text-13" style="font-weight:600;">${esc(histTypeLabel(r.type))}</div>
              <div class="text-13 text-muted2" style="word-break:break-all;">
                ${esc(r.oldValue || '—')} → ${esc(r.newValue || '—')}
              </div>
            </div>
          </div>`;
      }).join('');
    } catch (e) {
      if (isApiHandledError(e)) return;
      if (body) body.innerHTML = `<div class="text-muted2 p-16">${esc(e.message)}</div>`;
    }
  }

  // ==================== F-14 世界访问足迹 ====================
  let _worldHistModalReady = false;
  function ensureWorldHistModal() {
    if (_worldHistModalReady && document.getElementById('friendWorldHistModal')) return;
    const el = document.createElement('div');
    el.className = 'modal';
    el.id = 'friendWorldHistModal';
    el.style.display = 'none';
    el.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h3 id="friendWorldHistTitle" class="modal-title"></h3>
          <button class="modal-close" data-modal-close="friendWorldHistModal" aria-label="close">&times;</button>
        </div>
        <div class="modal-body" id="friendWorldHistBody"></div>
      </div>`;
    document.body.appendChild(el);
    _worldHistModalReady = true;
  }

  async function showFriendWorldHistory(id) {
    ensureWorldHistModal();
    const title = document.getElementById('friendWorldHistTitle');
    const body = document.getElementById('friendWorldHistBody');
    if (title) title.textContent = __('friends.world_hist_title');
    if (body) body.innerHTML = `<div class="text-muted2 p-16">${esc(__('common.loading') || '加载中...')}</div>`;
    showModal('friendWorldHistModal');
    try {
      const res = await api('/api/friends/world-history/' + id, { method: 'GET' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { if (body) body.innerHTML = `<div class="text-muted2 p-16">${esc(errText(d))}</div>`; return; }
      const items = (d.items || []);
      if (!items.length) {
        if (body) body.innerHTML = `<div class="text-muted2 p-16">${esc(__('friends.world_hist_empty'))}</div>`;
        return;
      }
      // 汇总行：共 X 个世界 · Y 次访问
      const summary = (__('friends.world_hist_summary') || '{worlds} 个世界 · {visits} 次访问')
        .replace('{worlds}', d.totalWorlds || items.length)
        .replace('{visits}', d.totalVisits || 0);
      if (body) body.innerHTML = `
        <div class="text-13 text-muted2" style="margin-bottom:10px;">${esc(summary)}</div>
        ${items.map(r => {
          const name = r.worldName || r.worldId || '—';
          return `
            <div class="hist-item" style="display:flex;gap:10px;padding:10px 0;border-bottom:1px solid var(--border,#e5e7eb);align-items:center;">
              <div style="flex:1;min-width:0;">
                <div class="text-13" style="font-weight:600;word-break:break-all;">${esc(name)}</div>
                <div class="text-12 text-muted2" style="word-break:break-all;">
                  ${esc(r.worldId)} · ${r.visitCount}${esc(__('friends.world_hist_visits'))}
                </div>
                <div class="text-12 text-muted2" style="margin-top:2px;">
                  ${esc(__('friends.world_hist_first'))}: ${esc(fmtTime(r.firstVisitAt))} · ${esc(__('friends.world_hist_last'))}: ${esc(fmtTime(r.lastVisitAt))}
                </div>
              </div>
            </div>`;
        }).join('')}`;
    } catch (e) {
      if (isApiHandledError(e)) return;
      if (body) body.innerHTML = `<div class="text-muted2 p-16">${esc(e.message)}</div>`;
    }
  }

  // ==================== 操作 ====================
  async function doAction(action, id) {
    // 破坏性操作（移除好友 / 拉黑）需二次确认，避免误触且移除不可逆
    if (action === 'remove' || action === 'block') {
      const label = action === 'remove' ? __('friends.remove') : __('friends.block');
      const warn = action === 'remove'
        ? __('friends.confirm_remove')
        : __('friends.confirm_block');
      const ok = await new Promise((resolve) => showConfirm(`${warn}\n\n${label}：${__('friends.op_irreversible')}`, () => resolve(true), () => resolve(false)));
      if (!ok) return;
    }
    try {
      let r;
      if (action === 'add') r = await req('POST', '/api/friends/request', { targetUserId: id });
      else if (action === 'accept' || action === 'reject') r = await req('POST', '/api/friends/respond', { requestId: id, action });
      else if (action === 'cancel' || action === 'remove') r = await req('DELETE', '/api/friends/' + id);
      else if (action === 'block') r = await req('POST', '/api/friends/block', { targetUserId: id });
      else if (action === 'unblock') r = await req('DELETE', '/api/friends/block/' + id);
      else return;

      if (!r.res.ok) { toast(errText(r.d) || __('friends.op_failed'), 'error'); return; }
      const msg = {
        add: __('friends.request_sent'),
        accept: __('friends.request_accepted'),
        reject: __('friends.request_rejected'),
        cancel: __('friends.removed'),
        remove: __('friends.removed'),
        block: __('friends.blocked'),
        unblock: __('friends.unblocked')
      }[action] || __('friends.request_sent');
      toast(msg, 'success');
      // 刷新相关列表
      if (action === 'add') { const s = document.getElementById('friendSearch'); if (s) loadSearch(s.value); }
      loadRequests(); loadFriends(); loadBlocked();
    } catch (e) {
      if (isApiHandledError(e)) return;
      toast(e.message, 'error');
    }
  }

  function bindFriendsEvents() {
    const root = document.getElementById('tab-friends');
    if (!root) return;
    // 根节点点击委托只需绑定一次（root 容器本身不会被替换）
    if (!root.dataset.bound) {
      root.dataset.bound = '1';
      root.addEventListener('click', (e) => {
        const more = e.target.closest('[data-feed-more]');
        if (more) { loadFeed(false); return; }
        const b = e.target.closest('[data-action]');
        if (!b) return;
        const action = b.dataset.action;
        const id = parseInt(b.dataset.id);
        if (action === 'message') { if (typeof openChat === 'function') openChat(id); else switchTab('chat'); return; }
        if (action === 'mutual') { showMutualFriends(id); return; }
        if (action === 'history') { showFriendHistory(id); return; }
        if (action === 'worldhist') { showFriendWorldHistory(id); return; }
        doAction(action, id);
      });
    }
    // 搜索输入框每次渲染都会被重建，必须重新绑定，否则二次进入 tab 后搜索失效
    const search = document.getElementById('friendSearch');
    if (search) {
      search.addEventListener('input', debounce(() => loadSearch(search.value), 300));
    }
  }

  window.showFriends = showFriends;
})();
