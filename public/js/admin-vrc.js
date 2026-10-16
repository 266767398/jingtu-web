// ==================== 管理员 - VRChat 系统管理模块 ====================

function initVrcEventDelegates() {
  const container = document.getElementById('tab-admin');
  if (container && !container._vrcDelegateInit) {
    container._vrcDelegateInit = true;
    container.addEventListener('click', handleVrcAction);
  }
  const reviewList = document.getElementById('nameReviewList');
  if (reviewList && !reviewList._vrcDelegateInit) {
    reviewList._vrcDelegateInit = true;
    reviewList.addEventListener('click', handleVrcAction);
  }
}

function handleVrcAction(e) {
    const el = e.target.closest('[data-vrc-action], [data-action]');
    if (!el) return;
    
    if (el.hasAttribute('data-vrc-action')) {
      const action = el.dataset.vrcAction;
      const id = el.dataset.id;
      const value = el.dataset.value;
      
      switch (action) {
        case 'show-name-review':
          showNameReviewModal();
          break;
        case 'review-name':
          reviewNameChange(id, value);
          break;
        case 'hide-login':
          hideSystemVrcLogin();
          break;
        case 'do-logout':
          doSystemVrcLogout();
          break;
        case 'show-login':
          showSystemVrcLogin();
          break;
        case 'load-notifications':
          loadVrcNotifications();
          break;
        case 'toggle-credentials':
          toggleSystemVrcCredentials();
          break;
        case 'save-credentials':
          saveSystemVrcCredentials();
          break;
        case 'clear-credentials':
          clearSystemVrcCredentials();
          break;
        case 'blacklist-sync':
          syncVrcBlacklist();
          break;
        case 'blacklist-edit':
          editVrcBlacklistItem(id);
          break;
        case 'blacklist-add':
          addVrcBlacklistItem();
          break;
        case 'blacklist-load':
          loadVrcBlacklist();
          break;
        case 'blacklist-remove':
          removeVrcBlacklistItem(id);
          break;
      }
    } else if (el.hasAttribute('data-action')) {
      const action = el.dataset.action;
      const value = parseInt(el.dataset.value);
      
      switch (action) {
        case 'load-oper-log':
          loadOperLog(value);
          break;
      }
    }
}

// ========== 数据库管理权限检查（已移除） ==========
// checkDbPermission 删除：它只是 `if (typeof window.showDbSection === 'function')`
// 的空壳，而 showDbSection 只存在于从未被 index.html 引入的 admin-db.js，
// 判断永远为假 —— 也就是说 ui.js 里 switchTab('admin') 那行调用一直是个空操作。
// 数据库管理面板本来就没有对应的 HTML，接线时请一并恢复。

// ========== 系统状态统计 ==========
async function loadAdminStats() {
  try {
    const res = await api('/api/admin/stats', { method: 'GET' });
    if (res.ok) {
      const d = await res.json();
      const fields = ['statTotalUsers', 'statBannedUsers', 'statPendingReviews', 'statLiveEvents', 'statTotalPhotos', 'statTotalAnnouncements'];
      const values = [d.totalUsers, d.totalBanned, d.pendingApproval, d.totalEvents, d.totalPhotos, d.totalAnnouncements || 0];
      fields.forEach((id, i) => {
        const el = document.getElementById(id);
        if (el) {
          el.textContent = values[i] ?? '-';
          el.classList.remove('skeleton-stat');
        }
      });
    }
  } catch {}
}

// ========== VRChat 日历同步 ==========
async function syncVRChatEvents() {
  if (!currentUser || currentUser.role !== 'super_admin') {
    toast(__('permission_denied'), 'error');
    return;
  }
  try {
    toast(__('admin.vrc_syncing'), 'info');
    const res = await api('/api/events/sync-vrchat', { method: 'POST' });
    if (res.ok) {
      const data = await res.json();
      toast(__('admin_vrc.synced_events', {n: data.added || 0}), 'success');
      if (typeof loadEvents === 'function') loadEvents(currentEvtStatus);
    }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('admin_vrc.sync_failed') + ': ' + err.message, 'error'); }
}

// ========== VRChat 黑名单（超管维护：用户名 / 用户URL / 做了什么） ==========
// 与 VRChat 群黑名单联动：本地库是唯一存储，source=group 表示从群黑名单自动同步而来；
// banned 表示当前是否在 VRChat 群黑名单中；每条可单独编辑详情并直接写回本地库。
// 列表本地搜索过滤（blSearch 输入框），不产生额外请求。
let _vrcBlacklistCache = [];

async function loadVrcBlacklist() {
  if (!currentUser || currentUser.role !== 'super_admin') return;
  const listEl = document.getElementById('vrcBlacklistList');
  if (!listEl) return;
  listEl.innerHTML = '<p class="text-muted2 text-13">' + __('admin_vrc.bl_loading') + '</p>';
  try {
    const res = await api('/api/admin/vrc-blacklist', { method: 'GET', timeout: 30000 });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(errText(err) || __('admin_vrc.load_failed')); }
    const data = await res.json();
    _vrcBlacklistCache = data.items || [];
    renderVrcBlacklistList();
  } catch (e) {
    const msg = String((e && e.message) || __('admin_vrc.load_failed'));
    listEl.innerHTML = '<p class="text-red text-13">' + (typeof esc === 'function' ? esc(msg) : msg) + '</p>';
  }
}

// 纯本地渲染（搜索过滤不产生请求）：名字 / VRChat ID / URL / 原因 / 添加人
function renderVrcBlacklistList() {
  const listEl = document.getElementById('vrcBlacklistList');
  if (!listEl) return;
  const items = _vrcBlacklistCache;
  if (!items.length) { listEl.innerHTML = '<p class="text-muted2 text-13">' + __('admin_vrc.bl_empty') + '</p>'; return; }
  const kw = (document.getElementById('blSearch')?.value || '').trim().toLowerCase();
  const shown = kw
    ? items.filter(function (it) {
        const hay = [it.memberName, it.username, it.vrchatId, it.url, it.reason, it.createdByName]
          .filter(Boolean).join(' ').toLowerCase();
        return hay.indexOf(kw) !== -1;
      })
    : items;
  if (!shown.length) {
    listEl.innerHTML = '<p class="text-muted2 text-13">' + __('admin_vrc.bl_no_result') + '</p>';
    return;
  }
  listEl.innerHTML = shown.map(it => {
    const name = it.memberName || it.username || it.vrchatId || '-';
    const avatarHtml = it.avatarUrl
      ? `<img class="vrc-blacklist-avatar" src="${escAttr(it.avatarUrl)}" alt="" loading="lazy">`
      : '<span class="vrc-blacklist-avatar vrc-blacklist-avatar-fallback">🚫</span>';
    const sourceBadge = it.source === 'group'
      ? `<span class="vrc-blacklist-source">${__('admin_vrc.bl_source_group')}</span>`
      : `<span class="vrc-blacklist-source vrc-blacklist-source-manual">${__('admin_vrc.bl_source_manual')}</span>`;
    const bannedBadge = it.banned
      ? `<span class="vrc-blacklist-banned">${__('admin_vrc.bl_banned')}</span>`
      : `<span class="vrc-blacklist-banned vrc-blacklist-unbanned">${__('admin_vrc.bl_unbanned')}</span>`;
    const trustLabel = it.trustLevelCn || it.trustLevel;
    const trustDot = trustLabel
      ? `<span class="vrc-blacklist-trust" title="${__('admin_vrc.bl_trust', {t: trustLabel})}">●</span>`
      : '';
    return `<div class="vrc-blacklist-item">
      <div class="vrc-blacklist-head">
        ${avatarHtml}
        <span class="vrc-blacklist-name">${name}${trustDot}</span>
        ${it.vrchatId ? `<span class="vrc-blacklist-id">${esc(it.vrchatId)}</span>` : ''}
        ${sourceBadge}${bannedBadge}
        <button class="btn btn-xs btn-outline" data-vrc-action="blacklist-edit" data-id="${escAttr(String(it.id))}" title="${__('admin_vrc.bl_edit')}">✏️ ${__('admin_vrc.bl_edit')}</button>
        <button class="btn btn-xs btn-outline" data-vrc-action="blacklist-remove" data-id="${escAttr(String(it.id))}" title="${__('admin_vrc.bl_remove')}">🗑️ ${__('admin_vrc.bl_remove')}</button>
      </div>
      ${it.url ? `<div class="vrc-blacklist-url">🔗 <a href="${escAttr(it.url)}" target="_blank" rel="noopener noreferrer">${esc(it.url)}</a></div>` : ''}
      ${it.reason ? `<div class="vrc-blacklist-reason">${__('admin_vrc.bl_reason_label')}${esc(it.reason)}</div>` : ''}
      <div class="vrc-blacklist-meta">${__('admin_vrc.bl_added_by')} ${esc(it.createdByName || __('admin_vrc.bl_system_sync'))} · ${fmtDate(it.createdAt)}${it.syncedAt ? ' · ' + __('admin_vrc.bl_synced_at') + ' ' + fmtDate(it.syncedAt) : ''}</div>
    </div>`;
  }).join('');
  // 头像加载失败时兜底隐藏（CSP script-src 无 unsafe-inline，内联 onerror 会被拦截，改用事件监听）
  listEl.querySelectorAll('img.vrc-blacklist-avatar').forEach(function (img) {
    img.addEventListener('error', function () { this.style.display = 'none'; });
  });
}

// 黑名单搜索框输入（本地过滤，无需重新请求）
function onVrcBlacklistSearch() {
  clearTimeout(window._blSearchTimer);
  window._blSearchTimer = setTimeout(renderVrcBlacklistList, 250);
}

// 手动同步 VRChat 群黑名单 ⇄ 本地（超管）；busy 锁防连点
let _vrcBlacklistSyncBusy = false;
async function syncVrcBlacklist() {
  if (!currentUser || currentUser.role !== 'super_admin') {
    toast(__('admin_vrc.super_admin_only'), 'error');
    return;
  }
  if (_vrcBlacklistSyncBusy) return;
  _vrcBlacklistSyncBusy = true;
  const btn = document.querySelector('[data-vrc-action="blacklist-sync"]');
  if (btn) btn.disabled = true;
  try {
    toast(__('admin_vrc.bl_syncing'), 'info');
    const res = await api('/api/admin/vrc-blacklist/sync', { method: 'POST', timeout: 60000 });
    if (!res.ok) { const err = await res.json().catch(() => ({})); toast(errText(err) || __('admin_vrc.op_failed'), 'error'); return; }
    const d = await res.json();
    toast(__('admin_vrc.bl_synced', { a: d.added || 0, u: d.updated || 0, r: d.revoked || 0 }), 'success');
    loadVrcBlacklist();
    if (typeof loadGroupBans === 'function') loadGroupBans();
  } catch (err) { if (isApiHandledError(err)) return; toast(__('admin_vrc.op_failed') + ': ' + err.message, 'error'); }
  finally {
    _vrcBlacklistSyncBusy = false;
    if (btn) btn.disabled = false;
  }
}

// 编辑黑名单详情（超管；直接写本地库 reason/username/url）
// 用 createOverlayDialog 定制内容弹窗：保存成功走 _cleanup('confirm') 解锁滚动并关闭，
// 校验/保存失败则保持弹窗打开继续编辑（不闪关）。
function editVrcBlacklistItem(id) {
  if (!currentUser || currentUser.role !== 'super_admin') return;
  const item = _vrcBlacklistCache.find(function (it) { return String(it.id) === String(id); }) || {};
  const overlay = createOverlayDialog(`
    <div class="confirm-dialog" style="max-width:460px">
      <div class="confirm-msg"><b style="font-size:15px">${esc(__('admin_vrc.bl_edit_title'))}</b>
        ${item.vrchatId ? `<div class="text-muted text-12 mt-4 mono">${esc(item.vrchatId)}</div>` : ''}
      </div>
      <div class="form-group mb-8">
        <label class="form-label">${__('admin_vrc.bl_username')}</label>
        <input type="text" id="blEditName" class="search-box" value="${escAttr(item.memberName || item.username || '')}" maxlength="255" style="width:100%;box-sizing:border-box">
      </div>
      <div class="form-group mb-8">
        <label class="form-label">${__('admin_vrc.bl_url')}</label>
        <input type="text" id="blEditUrl" class="search-box" value="${escAttr(item.url || '')}" maxlength="2048" placeholder="https://vrchat.com/home/user/usr_..." style="width:100%;box-sizing:border-box">
      </div>
      <div class="form-group mb-8">
        <label class="form-label">${__('admin_vrc.bl_reason_label2')}</label>
        <textarea id="blEditReason" rows="4" class="search-box" maxlength="2000" placeholder="${escAttr(__('admin_vrc.bl_reason_ph'))}" style="width:100%;box-sizing:border-box;resize:vertical">${esc(item.reason || '')}</textarea>
      </div>
      <div class="confirm-actions" style="margin-top:12px">
        <button class="btn btn-accent btn-sm" data-action="confirm">${__('admin_vrc.bl_edit_save')}</button>
        <button class="btn btn-outline btn-sm" data-action="cancel">${__('core.cancel_btn')}</button>
      </div>
    </div>`, null, null);
  const nameEl = overlay.querySelector('#blEditName');
  const urlEl = overlay.querySelector('#blEditUrl');
  const reasonEl = overlay.querySelector('#blEditReason');
  const okBtn = overlay.querySelector('[data-action="confirm"]');
  const cancelBtn = overlay.querySelector('[data-action="cancel"]');
  if (nameEl) setTimeout(function () { nameEl.focus({ preventScroll: true }); }, 60);
  // 覆盖 createOverlayDialog 默认接线：保存成功才关闭，失败保持弹窗
  okBtn.onclick = async function () {
    const name = (nameEl.value || '').trim();
    const url = (urlEl.value || '').trim();
    const reason = (reasonEl.value || '').trim();
    if (!name) { toast(__('admin_vrc.bl_need_username'), 'error'); nameEl.focus(); return; }
    try {
      const res = await api('/api/admin/vrc-blacklist/' + id, {
        method: 'PUT',
        body: { username: name, url, reason },
        timeout: 30000
      });
      if (!res.ok) { const err = await res.json().catch(() => ({})); toast(errText(err) || __('admin_vrc.op_failed'), 'error'); return; }
      toast(__('admin_vrc.bl_edited'), 'success');
      overlay._cleanup('confirm');
      loadVrcBlacklist();
      if (typeof loadGroupBans === 'function') loadGroupBans();
    } catch (err) { if (isApiHandledError(err)) return; toast(__('admin_vrc.op_failed') + ': ' + err.message, 'error'); }
  };
  cancelBtn.onclick = function () { overlay._cleanup('cancel'); };
  overlay.onclick = function (e) { if (e.target === overlay) overlay._cleanup('cancel'); };
  // Enter 快速保存（textarea 内换行不拦截）；Esc 关闭
  overlay.addEventListener('keydown', function (e) {
    const tag = e.target && e.target.tagName;
    if (e.key === 'Enter' && tag !== 'TEXTAREA' && tag !== 'BUTTON') {
      e.preventDefault();
      okBtn.click();
    } else if (e.key === 'Escape') {
      overlay._cleanup('cancel');
    }
  });
}

async function addVrcBlacklistItem() {
  if (!currentUser || currentUser.role !== 'super_admin') {
    toast(__('admin_vrc.super_admin_only'), 'error');
    return;
  }
  const username = document.getElementById('blUsername')?.value?.trim();
  if (!username) { toast(__('admin_vrc.bl_need_username'), 'error'); return; }
  try {
    const res = await api('/api/admin/vrc-blacklist', {
      method: 'POST',
      body: {
        username,
        url: document.getElementById('blUrl')?.value?.trim() || '',
        vrchatId: document.getElementById('blVrchatId')?.value?.trim() || '',
        reason: document.getElementById('blReason')?.value?.trim() || ''
      },
      timeout: 30000
    });
    if (!res.ok) { const err = await res.json().catch(() => ({})); toast(errText(err) || __('admin_vrc.op_failed'), 'error'); return; }
    toast(__('admin_vrc.bl_added'), 'success');
    ['blUsername', 'blUrl', 'blVrchatId', 'blReason'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    loadVrcBlacklist();
  } catch (err) { if (isApiHandledError(err)) return; toast(__('admin_vrc.op_failed') + ': ' + err.message, 'error'); }
}

async function removeVrcBlacklistItem(id) {
  if (!currentUser || currentUser.role !== 'super_admin') {
    toast(__('admin_vrc.super_admin_only'), 'error');
    return;
  }
  showConfirm(__('admin_vrc.bl_remove_confirm'), async () => {
    try {
      const res = await api('/api/admin/vrc-blacklist/' + id, { method: 'DELETE', timeout: 30000 });
      if (!res.ok) { const err = await res.json().catch(() => ({})); toast(errText(err) || __('admin_vrc.op_failed'), 'error'); return; }
      toast(__('admin_vrc.bl_removed'), 'success');
      loadVrcBlacklist();
    } catch (err) { if (isApiHandledError(err)) return; toast(__('admin_vrc.op_failed') + ': ' + err.message, 'error'); }
  });
}

// ========== 改名审核 ==========
function showNameReviewModal() {
  initVrcEventDelegates();
  showModal('nameReviewModal');
  loadNameChangeRequests();
}

async function loadNameChangeRequests() {
  // 后端 /api/name-change 系列为 requireAdminCompat（admin+），前端不可再拦死普通管理员
  if (!currentUser || (currentUser.role !== 'admin' && currentUser.role !== 'super_admin')) {
    toast(__('admin_vrc.name_review_denied'), 'error');
    return;
  }
  try {
    const res = await api('/api/name-change/pending', { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      renderNameChangeRequests(data.requests || []);
    }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('admin_vrc.load_name_failed') + ': ' + err.message, 'error'); }
}

function renderNameChangeRequests(requests) {
  const container = document.getElementById('nameReviewList');
  if (!container) return;
  if (!requests || requests.length === 0) {
    renderEmpty(container, { icon: '📝', text: __('admin_vrc.no_pending_requests') });
    return;
  }
  container.innerHTML = requests.map(r => `
    <div class="name-change-card">
      <div class="name-change-user">
        <img src="/api/avatar/default" class="name-change-avatar" alt="${esc(r.displayName || '')}" loading="lazy">
        <div>
          <div class="name-change-name">${esc(r.displayName || '')}</div>
          <div class="name-change-time">${__('admin_vrc.applied_at')} ${fmtDate(r.createTime)}</div>
        </div>
      </div>
      <div class="name-change-detail">
        <div>${__('admin_vrc.current_name')}<strong>${esc(r.oldName || '')}</strong></div>
        <div>${__('admin_vrc.requested_name')}<strong>${esc(r.newName || '')}</strong></div>
        ${r.reason ? `<div class="name-change-reason">${__('admin_vrc.reason')}${esc(r.reason)}</div>` : ''}
      </div>
      <div class="name-change-actions">
        <button class="btn btn-sm btn-accent" data-vrc-action="review-name" data-id="${escAttr(String(r.id))}" data-value="approve">${__('admin.approve')}</button>
        <button class="btn btn-sm btn-danger" data-vrc-action="review-name" data-id="${escAttr(String(r.id))}" data-value="reject">${__('admin.reject')}</button>
      </div>
    </div>
  `).join('');
}

async function reviewNameChange(requestId, action) {
  showConfirm(action === 'approve' ? __('admin_vrc.confirm_approve') : __('admin_vrc.confirm_reject'), async () => {
    try {
      const res = await api('/api/name-change/review', {
        method: 'POST',
        body: { id: requestId, action }
      });
      if (res.ok) {
        toast(action === 'approve' ? __('admin_vrc.approved') : __('admin_vrc.rejected'), 'success');
        loadNameChangeRequests();
        updateNameReviewPreview();
        if (typeof loadAdminStats === 'function') loadAdminStats();
      }
    } catch (err) { if (isApiHandledError(err)) return; toast(__('admin_vrc.op_failed') + ': ' + err.message, 'error'); }
  });
}

async function updateNameReviewPreview() {
  if (!currentUser || (currentUser.role !== 'admin' && currentUser.role !== 'super_admin')) return;
  try {
    const res = await api('/api/name-change/pending', { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      const count = (data.requests || []).length;
      const preview = document.getElementById('nameChangeList');
      if (preview) {
        preview.innerHTML = count > 0
          ? `<button type="button" class="btn btn-sm btn-accent" data-vrc-action="show-name-review">${esc(__('admin_vrc.pending_count', {n: count}))} →</button>`
          : `<p class="text-13 text-muted2">${esc(__('admin.no_pending_requests'))}</p>`;
      }
    }
  } catch {}
}

// ========== 操作日志（增强版） ==========
let operLogSearchTimer = null;
let operLogCurrentPage = 1;

function showAdminOperLog() {
  // 原实现只对隐藏面板（d-none）内的 #operLog 做平滑滚动——用户停留在系统 VRChat
  // 面板时点击该按钮，目标元素不可见，表现「点了没反应」。改为触发侧边栏「操作日志」
  // 导航项：bindAdminNav 事件委托会调用 showPanel('logs') 真正切换面板并加载日志。
  const btn = document.querySelector('#adminNav .admin-nav-item[data-target="logs"]');
  if (btn) btn.click();
}

function onOperLogSearch(value) {
  clearTimeout(operLogSearchTimer);
  operLogSearchTimer = setTimeout(() => loadOperLog(1), 300);
}

function onOperLogFilter() {
  loadOperLog(1);
}

// 操作日志类型下拉：index.html 里静态写死了十几个老类型，实际 oper_type 有 60+ 种，
// 类型筛选形同虚设。后端已有 /api/admin/oper-log-types（按出现次数取前 50），
// 首次进入日志面板时拉取并合并进下拉，保留当前选中值不打断操作。
let operLogTypesLoaded = false;

function populateOperLogTypes(types) {
  const sel = document.getElementById('operLogTypeFilter');
  if (!sel) return;
  const prev = sel.value;
  const seen = new Set();
  Array.from(sel.options).forEach(o => { if (o.value) seen.add(o.value); });
  (types || []).forEach(t => {
    if (t && !seen.has(t)) {
      seen.add(t);
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      sel.appendChild(opt);
    }
  });
  sel.value = prev;
}

async function loadOperLogTypes() {
  if (operLogTypesLoaded) return;
  operLogTypesLoaded = true;
  try {
    const res = await api('/api/admin/oper-log-types', { method: 'GET' });
    if (res.ok) {
      const d = await res.json();
      populateOperLogTypes(d.types || []);
    }
  } catch {}
}

async function loadOperLog(page) {
  const container = document.getElementById('operLog');
  if (!container) return;
  initVrcEventDelegates();
  loadOperLogTypes();
  operLogCurrentPage = page || 1;
  container.innerHTML = '<div class="skeleton-card-list" style="margin:4px"></div><div class="skeleton-card-list" style="margin:4px"></div>';
  try {
    const params = new URLSearchParams();
    params.set('page', operLogCurrentPage);
    params.set('pageSize', '20');
    const type = document.getElementById('operLogTypeFilter')?.value || '';
    const user = document.getElementById('operLogUserSearch')?.value?.trim() || '';
    if (type) params.set('type', type);
    if (user) params.set('user', user);
    const res = await api('/api/admin/oper-logs?' + params.toString(), { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      const logs = data.logs || [];
      if (!logs || logs.length === 0) {
        container.innerHTML = '<div class="text-muted text-13 p-8">' + __('admin_vrc.no_oper_log') + '</div>';
        const paginationEl = document.getElementById('operLogPagination');
        if (paginationEl) paginationEl.innerHTML = '';
        return;
      }
      container.innerHTML = logs.map(l =>
        `<div class="admin-log-item">
          <span class="text-muted2 text-11">${esc(l.adminVrcId || '')} · ${fmtDate(l.createTime)}</span>
          <div class="text-13 mt-2"><span class="admin-log-type">${esc(l.operType || '')}</span>${l.content ? '：' + esc(l.content) : ''}</div>
        </div>`
      ).join('');
      renderOperLogPagination(data);
    }
  } catch { container.innerHTML = '<div class="text-muted text-13 p-8">' + __('admin_vrc.load_failed') + '</div>'; }
}

function renderOperLogPagination(data) {
  const container = document.getElementById('operLogPagination');
  if (!container) return;
  if (!data || data.totalPages <= 1) { container.innerHTML = ''; return; }
  const current = data.page;
  const total = data.totalPages;
  let html = `<span class="text-12 text-muted2 mr-4">${__('admin_vrc.total_entries', {n: data.total})}</span>`;
  if (current > 1) {
    html += `<button class="btn btn-xs btn-outline" data-action="load-oper-log" data-value="1" title="${__('admin_vrc.first_page')}">&laquo;</button>`;
    html += `<button class="btn btn-xs btn-outline" data-action="load-oper-log" data-value="${current - 1}">&lsaquo;</button>`;
  }
  const start = Math.max(1, current - 2);
  const end = Math.min(total, current + 2);
  for (let i = start; i <= end; i++) {
    html += `<button class="btn btn-xs ${i === current ? 'btn-accent' : 'btn-outline'}" data-action="load-oper-log" data-value="${i}">${i}</button>`;
  }
  if (current < total) {
    html += `<button class="btn btn-xs btn-outline" data-action="load-oper-log" data-value="${current + 1}">&rsaquo;</button>`;
    html += `<button class="btn btn-xs btn-outline" data-action="load-oper-log" data-value="${total}" title="${__('admin_vrc.last_page')}">&raquo;</button>`;
  }
  container.innerHTML = html;
}

// ========== 系统 VRChat 登录 ==========
async function checkSystemVrcStatus() {
  if (!currentUser || currentUser.role !== 'super_admin') return;
  try {
    const res = await api('/api/health', { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      const statusEl = document.getElementById('systemVrcStatus');
      const actionsEl = document.getElementById('systemVrcActions');
      if (!statusEl) return;
      const credBtn = '<button class="btn btn-sm btn-outline ml-6" data-vrc-action="toggle-credentials">🔑 ' + __('admin_vrc.cred_btn') + '</button>';
      const pipelineWarn = renderVrcPipelineWarning(data.pipeline);
      const reloginWarn = renderVrcReloginWarning(data.vrcAutoRelogin);
      if (data.systemVrcLogin) {
        statusEl.innerHTML = (data.systemVrcStale
          ? '<span class="text-orange">⚠️ ' + __('admin_vrc.logged_in_stale') + '</span>'
          : '<span class="text-green">🟢 ' + __('admin_vrc.logged_in') + '</span>')
          + pipelineWarn + reloginWarn;
        if (actionsEl) actionsEl.innerHTML = '<button class="btn btn-sm btn-outline" data-vrc-action="hide-login">' + __('admin_vrc.refresh') + '</button><button class="btn btn-sm btn-danger ml-6" data-vrc-action="do-logout">' + __('admin_vrc.logout') + '</button>' + credBtn;
        // V8.2: 展示系统 VRChat cookie 软性过期设置与剩余有效期
        const wrap = document.getElementById('systemVrcExpireWrap');
        if (wrap) {
          const remain = data.vrcCookieExpiresAt
            ? new Date(data.vrcCookieExpiresAt).toLocaleString()
            : __('admin_vrc.never_expire');
          wrap.classList.remove('d-none');
          wrap.innerHTML =
            '<div class="vrc-expire-row">' +
              '<label class="vrc-expire-label">' + __('admin_vrc.cookie_expire_label') + '</label>' +
              '<select id="vrcCookieExpireSel" class="form-control form-control-sm">' +
                '<option value="0"' + (data.vrcCookieExpireDays === 0 ? ' selected' : '') + '>' + __('admin_vrc.expire_forever') + '</option>' +
                '<option value="7"' + (data.vrcCookieExpireDays === 7 ? ' selected' : '') + '>' + __('admin_vrc.expire_week') + '</option>' +
                '<option value="30"' + (data.vrcCookieExpireDays === 30 ? ' selected' : '') + '>' + __('admin_vrc.expire_month') + '</option>' +
                '<option value="90"' + (data.vrcCookieExpireDays === 90 ? ' selected' : '') + '>' + __('admin_vrc.expire_quarter') + '</option>' +
                '<option value="180"' + (data.vrcCookieExpireDays === 180 ? ' selected' : '') + '>' + __('admin_vrc.expire_half_year') + '</option>' +
                '<option value="365"' + (data.vrcCookieExpireDays === 365 ? ' selected' : '') + '>' + __('admin_vrc.expire_year') + '</option>' +
              '</select>' +
              '<button class="btn btn-sm btn-accent" data-action="vrc-cookie-expire-save">' + __('admin_vrc.save') + '</button>' +
            '</div>' +
            '<div class="vrc-expire-hint text-muted">' + __('admin_vrc.expire_remain', { t: remain }) + '</div>';
        }
      } else {
        const wrap = document.getElementById('systemVrcExpireWrap');
        if (wrap) wrap.classList.add('d-none');
        statusEl.innerHTML = '<span class="text-muted">🔴 ' + __('admin_vrc.not_logged_in') + '</span>' + pipelineWarn + reloginWarn;
        if (actionsEl) actionsEl.innerHTML = '<button class="btn btn-sm btn-accent" data-vrc-action="show-login">' + __('admin_vrc.login_vrc') + '</button>' + credBtn;
      }
    }
  } catch { document.getElementById('systemVrcStatus') && (document.getElementById('systemVrcStatus').innerHTML = '<span class="text-red">' + __('admin_vrc.check_failed') + '</span>'); }
}

function renderVrcPipelineWarning(pipeline) {
  if (!pipeline || !pipeline.sessionRejected) return '';
  return '<div class="text-13 text-red mt-4">⚠️ ' + __('admin_vrc.session_rejected') + '</div>';
}

// F-30: 自动重登熔断/退避告警横幅（防封禁加固：连败指数退避进行中）
function renderVrcReloginWarning(relogin) {
  if (!relogin || !(relogin.failStreak > 0)) return '';
  const sec = relogin.backoffRemainingSec || 0;
  const msg = sec > 0
    ? __('admin_vrc.relogin_backoff', { n: relogin.failStreak, s: sec })
    : __('admin_vrc.relogin_backoff_end', { n: relogin.failStreak });
  return '<div class="text-13 text-orange mt-4">🛡️ ' + msg + '</div>';
}

// ========== 系统 VRChat 自动重登凭据（防 1006 IP 不一致） ==========
function toggleSystemVrcCredentials() {
  const wrap = document.getElementById('systemVrcCredWrap');
  if (!wrap) return;
  const hiding = wrap.classList.toggle('d-none');
  if (hiding) {
    const userEl = document.getElementById('sysVrcCredUser');
    const passEl = document.getElementById('sysVrcCredPass');
    const totpEl = document.getElementById('sysVrcCredTotp');
    if (userEl) userEl.value = '';
    if (passEl) passEl.value = '';
    if (totpEl) totpEl.value = '';
  } else {
    refreshSystemVrcCredStatus();
  }
}

async function refreshSystemVrcCredStatus() {
  if (!currentUser || currentUser.role !== 'super_admin') return;
  const statusEl = document.getElementById('systemVrcCredStatus');
  const clearBtn = document.getElementById('sysVrcCredClearBtn');
  if (!statusEl) return;
  try {
    const res = await api('/api/vrc-credentials-status', { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      statusEl.textContent = data.configured ? __('admin_vrc.cred_configured') : __('admin_vrc.cred_not_configured');
      if (clearBtn) clearBtn.classList.toggle('d-none', !data.configured);
    } else {
      statusEl.textContent = __('admin_vrc.load_failed');
    }
  } catch { statusEl.textContent = __('admin_vrc.load_failed'); }
}

async function saveSystemVrcCredentials() {
  if (!currentUser || currentUser.role !== 'super_admin') {
    toast(__('admin_vrc.super_admin_only'), 'error');
    return;
  }
  const username = document.getElementById('sysVrcCredUser')?.value?.trim();
  const password = document.getElementById('sysVrcCredPass')?.value;
  const totpSecret = document.getElementById('sysVrcCredTotp')?.value?.trim() || '';
  if (!username || !password) { toast(__('admin_vrc.fill_cred_account'), 'error'); return; }
  try {
    const res = await api('/api/vrc-save-credentials', {
      method: 'POST',
      body: { username, password, totpSecret }
    });
    if (res.ok) {
      toast(__('admin_vrc.cred_saved'), 'success');
      refreshSystemVrcCredStatus();
      checkSystemVrcStatus();
    } else {
      const err = await res.json().catch(() => ({}));
      toast(errText(err) || __('admin_vrc.save_failed'), 'error');
    }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('admin_vrc.save_failed') + ': ' + err.message, 'error'); }
}

// ==================== 在线更新（超管专属，GIT 拉取 + 自动重启） ====================
// 前端仅渲染状态与发起请求；git fetch/merge、依赖安装检测、跨平台重启排程均在
// server/routes/git_update.js 完成。更新只改受版本控制的文件，不触碰 .env/数据库/uploads。
function gitEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function loadGitUpdateStatus() {
  const el = document.getElementById('gitUpdateStatus');
  if (!el) return;
  el.innerHTML = '<span class="text-muted2">正在检测 Git 状态…</span>';
  try {
    const res = await api('/api/admin/git-status', { method: 'GET', timeout: 30000 });
    if (!res.ok) return;
    const d = await res.json();
    if (!d.isGitRepo) {
      el.innerHTML = '<span class="text-warn">' + gitEsc(d.message || '未检测到 Git 仓库，在线更新不可用') + '</span>';
      return;
    }
    const fetchState = d.fetchOk
      ? (d.behind > 0
          ? '<span class="text-success">🔽 远端有 <b>' + (d.behind || 0) + '</b> 个新提交可更新</span>'
          : (d.ahead > 0
              ? '<span class="text-warn">⚠ 本地领先远端，在线更新暂不可用</span>'
              : '<span class="text-success">✅ 已是最新版本</span>'))
      : '<span class="text-warn">⚠ 无法连接远端（离线或凭据问题），仅显示本地状态</span>';
    const aheadWarn = d.ahead > 0 ? ' · 本地领先远端 <b>' + d.ahead + '</b> 个提交' : '';
    const dirtyWarn = d.localChanges > 0 ? ' · 本地有 <b>' + d.localChanges + '</b> 处未提交改动' : '';
    el.innerHTML = [
      '<div class="git-update-line">分支：<b>' + gitEsc(d.branch) + '</b>',
      d.remote ? ' · 远端：<code>' + gitEsc(d.remote) + '</code>' : '',
      '</div>',
      '<div class="git-update-line">当前提交：<code>' + gitEsc(d.commit || '') + '</code>',
      d.subject ? ' · ' + gitEsc(d.subject) : '',
      '</div>',
      '<div class="git-update-line">' + fetchState + aheadWarn + dirtyWarn + '</div>'
    ].join('');
  } catch (err) {
    if (isApiHandledError(err)) { el.innerHTML = '<span class="text-warn">Git 状态查询失败</span>'; return; }
    el.innerHTML = '<span class="text-warn">查询失败：' + gitEsc(err.message || err) + '</span>';
  }
}

function runGitUpdate() {
  if (!currentUser || currentUser.role !== 'super_admin') { toast(__('admin_vrc.super_admin_setting'), 'error'); return; }
  const btn = document.getElementById('gitUpdateBtn');
  const resultEl = document.getElementById('gitUpdateResult');
  const restartBox = document.getElementById('cfgGitRestart');
  const restart = !!(restartBox && restartBox.checked);
  const confirmMsg = '确定从 GitHub 拉取并应用最新代码？'
    + (restart ? '\n更新成功后服务将自动重启（约 3 秒中断），页面会暂时无法访问。' : '\n更新成功后需手动点击「仅重启服务」使代码生效。')
    + '\n\n更新不会改动 .env、数据库与 uploads/ 等用户数据。';
  // M8: 原生 confirm 换行内样式化确认弹窗
  showConfirm(confirmMsg, function () { doGitUpdate(btn, resultEl, restart); });
}

async function doGitUpdate(btn, resultEl, restart) {
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 正在更新…'; }
  if (resultEl) resultEl.innerHTML = '<span class="text-muted2">正在拉取远端代码（fetch → 快进合并 → 依赖检测），请稍候…</span>';
  try {
    const res = await api('/api/admin/git-update', { method: 'POST', body: { restart }, timeout: 180000 });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      if (resultEl) resultEl.innerHTML = '<span class="text-warn">' + gitEsc(errText(d) || '更新失败') + '</span>';
      return;
    }
    const d = await res.json();
    if (resultEl) {
      if (d.updated) {
        resultEl.innerHTML = '<span class="text-success">✅ ' + gitEsc(d.message || '更新成功') + '</span>'
          + (d.filesChangedCount ? '<div class="text-12 text-muted2 mt-4">变更文件 ' + d.filesChangedCount + ' 个' + (d.depsInstalled ? '，已自动安装依赖' : '') + '</div>' : '');
      } else {
        resultEl.innerHTML = '<span class="text-success">✅ ' + gitEsc(d.message || '已是最新版本') + '</span>';
      }
      if (d.restarting) {
        setTimeout(function () { window.location.reload(); }, 6000);
      }
    }
    loadGitUpdateStatus();
  } catch (err) {
    if (isApiHandledError(err)) { if (resultEl) resultEl.innerHTML = '<span class="text-warn">更新失败（详见页面提示）</span>'; return; }
    if (resultEl) resultEl.innerHTML = '<span class="text-warn">更新失败：' + gitEsc(err.message || err) + '</span>';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⬆️ 检查并更新'; }
  }
}

function runGitRestart() {
  if (!currentUser || currentUser.role !== 'super_admin') { toast(__('admin_vrc.super_admin_setting'), 'error'); return; }
  const resultEl = document.getElementById('gitUpdateResult');
  // M8: 原生 confirm 换行内样式化确认弹窗
  showConfirm('确定重启服务？重启约需 3 秒，期间网站暂时无法访问。\n\n适用于：已手动拉取代码或修改服务端配置后需要重载。', function () {
    doGitRestart(resultEl);
  });
}

async function doGitRestart(resultEl) {
  try {
    const res = await api('/api/admin/git-restart', { method: 'POST', timeout: 15000 });
    if (!res.ok) { const d = await res.json().catch(() => ({})); if (resultEl) resultEl.innerHTML = '<span class="text-warn">' + gitEsc(errText(d) || '重启失败') + '</span>'; return; }
    const d = await res.json();
    if (resultEl) resultEl.innerHTML = '<span class="text-success">✅ ' + gitEsc(d.message || '服务正在重启') + '</span>';
    setTimeout(function () { window.location.reload(); }, 6000);
  } catch (err) {
    if (isApiHandledError(err)) return;
    if (resultEl) resultEl.innerHTML = '<span class="text-warn">重启失败：' + gitEsc(err.message || err) + '</span>';
  }
}

// Git 更新/重启 + VRC cookie 有效期保存（原内联 onclick 迁移到委托）
document.addEventListener('click', function (e) {
  const actEl = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
  if (actEl && actEl.getAttribute('data-action') === 'vrc-cookie-expire-save') { saveVrcCookieExpire(); return; }
  if (e.target.closest('#gitUpdateBtn')) { runGitUpdate(); return; }
  if (e.target.closest('#gitRestartBtn')) { runGitRestart(); return; }
});

// 黑名单本地搜索（输入委托，兼容 CSP 禁内联处理器）
document.addEventListener('input', function (e) {
  const t = e.target;
  if (t && t.id === 'blSearch') onVrcBlacklistSearch();
});

function clearSystemVrcCredentials() {
  if (!currentUser || currentUser.role !== 'super_admin') {
    toast(__('admin_vrc.super_admin_only'), 'error');
    return;
  }
  showConfirm(__('admin_vrc.confirm_clear_cred'), async () => {
    try {
      const res = await api('/api/vrc-clear-credentials', { method: 'POST' });
      if (res.ok) {
        toast(__('admin_vrc.cred_cleared'), 'info');
        refreshSystemVrcCredStatus();
        checkSystemVrcStatus();
      } else {
        const err = await res.json().catch(() => ({}));
        toast(errText(err) || __('admin_vrc.op_failed'), 'error');
      }
    } catch (err) { if (isApiHandledError(err)) return; toast(__('admin_vrc.op_failed') + ': ' + err.message, 'error'); }
  });
}

function showSystemVrcLogin() {
  if (!currentUser || currentUser.role !== 'super_admin') {
    toast(__('admin_vrc.super_admin_only'), 'error');
    return;
  }
  document.getElementById('systemVrcLoginForm')?.classList.remove('d-none');
  document.getElementById('systemVrcError')?.classList.add('d-none');
}

// F-19: 拉取系统 VRChat 账号的官方通知列表（REST 兜底，与 pipeline WS 实时推送互补）
async function loadVrcNotifications() {
  if (!currentUser || (currentUser.role !== 'admin' && currentUser.role !== 'super_admin')) return;
  const listEl = document.getElementById('vrcNotifList');
  if (!listEl) return;
  listEl.innerHTML = '<p class="text-muted2 text-13">' + __('admin_vrc.notif_loading') + '</p>';
  try {
    const res = await api('/api/vrc-notifications?n=50', { timeout: 20000 });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.message || __('admin_vrc.notif_fail'));
    const list = Array.isArray(data.notifications) ? data.notifications : [];
    if (!list.length) {
      listEl.innerHTML = '<p class="text-muted2 text-13">' + __('admin_vrc.notif_empty') + '</p>';
      return;
    }
    listEl.innerHTML = list.map(nt => {
      const time = nt.createdAt ? new Date(nt.createdAt).toLocaleString() : '';
      const msg = nt.message ? '<div class="text-13 text-muted">' + esc(String(nt.message).slice(0, 200)) + '</div>' : '';
      return '<div class="vrc-notif-item mb-8"><div class="text-13"><strong>' + esc(nt.title || nt.type || 'VRChat') + '</strong>' +
        (nt.senderUsername ? ' <span class="text-muted2">@' + esc(nt.senderUsername) + '</span>' : '') +
        (time ? ' <span class="text-muted2">· ' + time + '</span>' : '') + '</div>' + msg + '</div>';
    }).join('');
  } catch (e) {
    const errText = String(e.message || __('admin_vrc.notif_fail'));
    listEl.innerHTML = '<p class="text-red text-13">' + (typeof esc === 'function' ? esc(errText) : errText) + '</p>';
  }
}

function hideSystemVrcLogin() {
  document.getElementById('systemVrcLoginForm')?.classList.add('d-none');
  document.getElementById('systemVrc2faForm')?.classList.add('d-none');
}

async function doSystemVrcLogin() {
  if (!currentUser || currentUser.role !== 'super_admin') {
    toast(__('admin_vrc.super_admin_only'), 'error');
    return;
  }
  const username = document.getElementById('sysVrcUser')?.value?.trim();
  const password = document.getElementById('sysVrcPass')?.value;
  if (!username || !password) { toast(__('admin.fill_vrc_account'), 'error'); return; }
  try {
    const res = await api('/api/login', {
      method: 'POST',
      body: { username, password }
    });
    if (res.ok) {
      const data = await res.json();
      if (data.need2fa) {
        const methods = Array.isArray(data.methods) ? data.methods : [];
        const method = methods.includes('emailOtp')
          ? 'emailOtp'
          : (methods.includes('totp') ? 'totp' : 'otp');
        const form = document.getElementById('systemVrc2faForm');
        if (form) form.dataset.method = method;
        document.getElementById('systemVrc2faForm')?.classList.remove('d-none');
        const hint = document.getElementById('sysVrc2faHint');
        if (hint) hint.textContent = method === 'emailOtp' ? __('admin.enter_email_code') : __('admin.enter_auth_code');
        toast(__('admin_vrc.need_2fa'), 'info');
        document.getElementById('sysVrc2faCode')?.focus({ preventScroll: true });
        return;
      }
      toast(__('admin_vrc.login_ok_vrc'), 'success');
      hideSystemVrcLogin();
      checkSystemVrcStatus();
    } else {
      const errData = await res.json();
      const errEl = document.getElementById('systemVrcError');
      if (errEl) { errEl.textContent = errText(errData) || __('admin_vrc.login_failed'); errEl.classList.remove('d-none'); }
    }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('admin_vrc.login_failed_msg') + ': ' + err.message, 'error'); }
}

async function doSystemVrc2FA() {
  if (!currentUser || currentUser.role !== 'super_admin') {
    toast(__('admin_vrc.super_admin_only'), 'error');
    return;
  }
  const code = document.getElementById('sysVrc2faCode')?.value?.trim();
  const method = document.getElementById('systemVrc2faForm')?.dataset.method;
  if (!code || code.length < 4) { toast(__('admin_vrc.enter_full_code'), 'error'); return; }
  if (!method) { toast(__('admin_vrc.login_failed'), 'error'); return; }
  try {
    const res = await api('/api/2fa', {
      method: 'POST',
      body: { code, method }
    });
    if (res.ok) {
      const data = await res.json();
      if (data.success) {
        toast(__('admin_vrc.login_ok_excl'), 'success');
        hideSystemVrcLogin();
        checkSystemVrcStatus();
      }
    } else {
      // 透传后端真实失败原因（如验证码错误 / 2FA 次数过多 / 服务器内部错误），
      // 而非一律显示"验证码错误"——否则 500 会被误读成"验证码填了没反应"。
      let errData = null;
      try { errData = await res.json(); } catch (e) { /* 非 JSON 错误体，走兜底文案 */ }
      const errEl2 = document.getElementById('systemVrc2faError');
      if (errEl2) {
        errEl2.textContent = errText(errData) || __('admin_vrc.wrong_code');
        errEl2.classList.remove('d-none');
      }
    }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('admin_vrc.fa_failed'), 'error'); }
}

function cancelSystemVrc2FA() { hideSystemVrcLogin(); }

// V8.2: 保存系统 VRChat cookie 软性过期时间
async function saveVrcCookieExpire() {
  if (!currentUser || currentUser.role !== 'super_admin') {
    toast(__('admin_vrc.super_admin_only'), 'error');
    return;
  }
  const sel = document.getElementById('vrcCookieExpireSel');
  if (!sel) return;
  const days = parseInt(sel.value, 10);
  try {
    const res = await api('/api/vrc-cookie-expire', { method: 'PUT', body: { expireDays: days } });
    if (res.ok) {
      toast(__('admin_vrc.expire_saved'), 'success');
      checkSystemVrcStatus();
    } else {
      const err = await res.json();
      toast(errText(err) || __('admin_vrc.save_failed'), 'error');
    }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('admin_vrc.save_failed') + ': ' + err.message, 'error'); }
}

// ========== 群组同步 ==========
async function adminSyncGroupMembers() {
  if (!currentUser || (currentUser.role !== 'admin' && currentUser.role !== 'super_admin')) {
    toast(__('permission_denied'), 'error');
    return;
  }
  const btn = document.getElementById('btnSyncGroup');
  if (btn) { btn.disabled = true; btn.textContent = __('admin_vrc.syncing'); }
  try {
    toast(__('admin_vrc.syncing_group'), 'info');
    const res = await api('/api/group/members/sync', { method: 'POST' });
    if (res.ok) {
      const data = await res.json();
      toast(__('admin_vrc.synced_members', {n: data.total || 0}), 'success');
    } else {
      const err = await res.json();
      toast(errText(err) || __('admin_vrc.sync_err'), 'error');
    }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('admin_vrc.sync_failed') + ': ' + err.message, 'error'); }
  finally {
    if (btn) { btn.disabled = false; btn.textContent = __('admin_vrc.sync_group_btn'); }
  }
}

// ========== ⚙️ 系统设置 ==========
// F-5: 媒体镜像源 JSON ↔ 逐行文本（名称|URL模板|Referer(可选)）互转
function mirrorsToLines(jsonStr) {
  let arr;
  try { arr = JSON.parse(jsonStr || '[]'); } catch (e) { return ''; }
  if (!Array.isArray(arr)) return '';
  return arr.map(function (m) {
    if (!m || !m.urlTemplate) return '';
    return [m.name || '', m.urlTemplate, m.referer || ''].filter(function (p, i) { return i < 2 || p; }).join('|');
  }).filter(Boolean).join('\n');
}
function linesToMirrors(text) {
  return String(text || '').split(/\r?\n/).map(function (line) {
    line = line.trim();
    if (!line) return null;
    const parts = line.split('|').map(function (p) { return p.trim(); });
    const entry = { name: parts[0] || '', urlTemplate: parts[1] || '' };
    if (parts[2]) entry.referer = parts[2];
    return entry;
  }).filter(function (e) { return e && e.urlTemplate; });
}

async function loadSystemConfig() {
  const contentEl = document.getElementById('adminSettingsContent');
  if (!contentEl) return;
  try {
    const res = await api('/api/admin/config', { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      const cfg = data || {};
      const setVal = (id, val) => {
        const el = document.getElementById(id);
        if (el) {
          if (el.type === 'checkbox') el.checked = val === '1' || val === true;
          else el.value = val || '';
        }
      };
      setVal('cfgSiteName', cfg.site_name);
      setVal('cfgAllowRegister', cfg.allow_register);
      setVal('cfgRequireApproval', cfg.require_approval);
      setVal('cfgHideForgot', cfg.hide_forgot_password);
      setVal('cfgSiteNotice', cfg.site_notice);
      setVal('cfgContactEmail', cfg.contact_email);
      setVal('cfgMaxPhotoUpload', cfg.max_photo_upload);
      setVal('cfgMaxVideoSize', cfg.max_video_size_mb);
      // Hero 装修
      setVal('cfgHeroTitle', cfg.hero_title);
      setVal('cfgHeroSubtitle', cfg.hero_subtitle);
      setVal('cfgHeroDescription', cfg.hero_description);
      setVal('cfgHeroBgUrl', cfg.hero_bg_url);
      setVal('cfgHeroBgColor', cfg.hero_bg_color);
      setVal('cfgHeroOverlayOpacity', cfg.hero_bg_overlay_opacity);
      setVal('cfgHeroAccentColor', cfg.hero_accent_color);
      setVal('cfgHeroShowStats', cfg.hero_show_stats);
      setVal('cfgHeroShowBadge', cfg.hero_show_badge);
      setVal('cfgHeroBadgeText', cfg.hero_badge_text);
      setVal('cfgHeroAnimation', cfg.hero_animation);
      setVal('cfgPostsPerPage', cfg.posts_per_page);
      setVal('cfgPostMaxImages', cfg.post_max_images);
      setVal('cfgPostMaxVideos', cfg.post_max_videos);
      setVal('cfgPostVideoMaxSize', cfg.post_video_max_size_mb);
      // 全局请求限制（超管可调）
      setVal('cfgReqMaxUpload', cfg.req_max_upload_mb);
      setVal('cfgReqMaxBody', cfg.req_max_body_mb);
      setVal('cfgReqMaxOther', cfg.req_max_other_mb);
      // F-5: 媒体代理源池（后端存 JSON，前端以「名称|URL模板|Referer」逐行编辑）
      setVal('cfgMediaMirrors', mirrorsToLines(cfg.media_provider_mirrors));
      setVal('cfgMediaMirrorFirst', cfg.media_provider_mirror_first);
      setVal('cfgMediaTimeout', cfg.media_provider_timeout_ms);
      // VRChat 群组定时任务开关（默认开启，空值视为 1）
      setVal('cfgSchedRosterRefresh', cfg.sched_roster_refresh === undefined || cfg.sched_roster_refresh === null ? '1' : cfg.sched_roster_refresh);
      setVal('cfgSchedTrustEnrich', cfg.sched_trust_enrich === undefined || cfg.sched_trust_enrich === null ? '1' : cfg.sched_trust_enrich);
      if (cfg.hero_title) {
        const pt = document.getElementById('heroPreviewTitle');
        if (pt) pt.textContent = cfg.hero_title;
      }
      if (cfg.hero_bg_url) {
        const pi = document.getElementById('heroPreviewImg');
        if (pi) pi.src = cfg.hero_bg_url;
      }
    }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('auto_admin_vrc_1'), 'error'); }
}

// Hero 背景 URL 预览实时更新
function previewHeroBg() {
  const url = document.getElementById('cfgHeroBgUrl')?.value?.trim();
  const pi = document.getElementById('heroPreviewImg');
  const pt = document.getElementById('heroPreviewTitle');
  if (url && pi) pi.src = url;
  if (pt) pt.textContent = document.getElementById('cfgHeroTitle')?.value?.trim() || __('app.title');
}

// 绑定 Hero 预览事件 — 在 loadSystemConfig 中不会覆盖，需在 admin tab 初始化时绑定一次
function bindHeroPreviewEvents() {
  ['cfgHeroBgUrl', 'cfgHeroTitle'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.removeEventListener('input', previewHeroBg);
      el.addEventListener('input', previewHeroBg);
    }
  });
}

async function saveSystemConfig() {
  if (!currentUser || currentUser.role !== 'super_admin') {
    toast(__('admin_vrc.super_admin_setting'), 'error');
    return;
  }
  const getVal = (id) => {
    const el = document.getElementById(id);
    if (!el) return '';
    return el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value.trim();
  };
  const config = {
    site_name: getVal('cfgSiteName'),
    allow_register: getVal('cfgAllowRegister'),
    require_approval: getVal('cfgRequireApproval'),
    hide_forgot_password: getVal('cfgHideForgot'),
    site_notice: getVal('cfgSiteNotice'),
    contact_email: getVal('cfgContactEmail'),
    max_photo_upload: getVal('cfgMaxPhotoUpload'),
    max_video_size_mb: getVal('cfgMaxVideoSize'),
    hero_title: getVal('cfgHeroTitle'),
    hero_subtitle: getVal('cfgHeroSubtitle'),
    hero_description: getVal('cfgHeroDescription'),
    hero_bg_url: getVal('cfgHeroBgUrl'),
    hero_bg_color: getVal('cfgHeroBgColor'),
    hero_bg_overlay_opacity: getVal('cfgHeroOverlayOpacity'),
    hero_accent_color: getVal('cfgHeroAccentColor'),
    hero_show_stats: getVal('cfgHeroShowStats'),
    hero_show_badge: getVal('cfgHeroShowBadge'),
    hero_badge_text: getVal('cfgHeroBadgeText'),
    hero_animation: getVal('cfgHeroAnimation'),
    posts_per_page: getVal('cfgPostsPerPage'),
    post_max_images: getVal('cfgPostMaxImages'),
    post_max_videos: getVal('cfgPostMaxVideos'),
    post_video_max_size_mb: getVal('cfgPostVideoMaxSize'),
    req_max_upload_mb: getVal('cfgReqMaxUpload'),
    req_max_body_mb: getVal('cfgReqMaxBody'),
    req_max_other_mb: getVal('cfgReqMaxOther'),
    media_provider_mirrors: JSON.stringify(linesToMirrors(getVal('cfgMediaMirrors'))),
    media_provider_mirror_first: getVal('cfgMediaMirrorFirst'),
    media_provider_timeout_ms: getVal('cfgMediaTimeout'),
    sched_roster_refresh: getVal('cfgSchedRosterRefresh'),
    sched_trust_enrich: getVal('cfgSchedTrustEnrich'),
  };
  if (!config.site_name) { toast(__('fill_required'), 'error'); return; }
  try {
    const res = await api('/api/admin/config', { method: 'PUT', body: { config } });
    if (res.ok) {
      toast(__('admin.settings_saved'), 'success');
      loadSystemConfig();
    } else {
      // 与同文件 vrcCookieExpire 一致：非 2xx 给明确失败提示，不再静默零反馈
      const err = await res.json().catch(() => ({}));
      toast(errText(err) || __('admin_vrc.save_failed'), 'error');
    }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('admin_vrc.save_failed') + ': ' + err.message, 'error'); }
}

async function doSystemVrcLogout() {
  if (!currentUser || currentUser.role !== 'super_admin') {
    toast(__('admin_vrc.super_admin_feature'), 'error');
    return;
  }
  showConfirm(__('admin_vrc.confirm_logout_vrc'), async () => {
    try {
      const res = await api('/api/logout', { method: 'POST' });
      if (res.ok) {
        toast(__('admin_vrc.logged_out_vrc'), 'info');
        checkSystemVrcStatus();
      }
    } catch {}
  });
}

initVrcEventDelegates();
