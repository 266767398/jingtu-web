/**
 * 境途同游 V6.5 — VRChat 群组成员在线状态
 * 功能：成员列表、在线状态检测、同步、变更通知
 */

let groupMembersCache = [];
let groupFilter = 'all';
let groupStatusRefreshing = false;

// ==================== 加载群组成员 ====================
async function loadGroupMembers() {
  try {
    const res = await api('/api/group/members?filter=' + groupFilter);
    if (!res.ok) throw new Error('LOAD_FAILED');
    const data = await res.json();
    groupMembersCache = data.members || [];
    renderGroupMembers(groupMembersCache);
    updateGroupOverview(groupMembersCache);
    loadGroupChanges();
  } catch (err) {
    if (isApiHandledError(err)) return;
    document.getElementById('groupMemberGrid').innerHTML = '<div class="empty-state">📡 ${__('group.load_failed')}</div>';
  }
}

// ==================== 渲染成员卡片 ====================
function renderGroupMembers(members) {
  const grid = document.getElementById('groupMemberGrid');
  if (!grid) return;
  if (members.length === 0) {
    grid.innerHTML = `<div class="empty-state">
      <div class="empty-icon">${groupFilter === 'online' ? '🌙' : groupFilter === 'offline' ? '☀️' : '👥'}</div>
      <p>${groupFilter === 'online' ? __('group.no_online') : groupFilter === 'offline' ? __('group.no_offline') : __('group.no_data')}</p>
      <p class="text-muted2 text-12">${__('group.sync_first')}</p>
    </div>`;
    return;
  }

  grid.innerHTML = members.map(m => {
    const isOnline = m.isOnline;
    const statusText = statusLabel(m.vrchatStatus);
    const avatar = m.avatarUrl || '';
    const displayName = m.displayName || m.vrchatName || m.vrchatId;
    const profileUrl = `https://vrchat.com/home/user/${esc(m.vrchatId || '')}`;
    const locationText = isOnline && m.worldName ? formatLocation(m.worldName) : '';
    const lastSeen = !isOnline ? formatLastSeen(m.lastSeen || m.lastLogin) : '';
    const userId = m.userId || m.user_id || null;

    return `
    <div class="group-member-card ${isOnline ? 'online' : 'offline'}">
      <div class="gm-avatar-wrap">
        ${userId ? `<div class="gm-avatar-link" onclick="goToProfile(${userId})" style="cursor:pointer">` : `<a href="${profileUrl}" target="_blank" rel="noopener" class="gm-avatar-link">`}
          ${avatar ? `<img src="${escAttr(avatar)}" class="gm-avatar" alt="${esc(displayName)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">` : ''}
          <div class="gm-avatar-fallback" style="${avatar ? '' : 'display:flex'}">${displayName.charAt(0).toUpperCase()}</div>
        ${userId ? `</div>` : `</a>`}
        <div class="gm-status-dot ${isOnline ? 'online' : ''}" title="${statusText}"></div>
      </div>
      <div class="gm-info">
        ${userId ? `<span class="gm-name" onclick="goToProfile(${userId})" style="cursor:pointer" title="${esc(displayName)}">${esc(displayName)}</span>` : `<a href="${profileUrl}" target="_blank" rel="noopener" class="gm-name" title="${esc(displayName)}">${esc(displayName)}</a>`}
        <div class="gm-status-text">${statusText}</div>
        <a href="${profileUrl}" target="_blank" rel="noopener" class="gm-vrc-link">🔗 VRChat</a>
        ${locationText ? `<div class="gm-location" title="${esc(locationText)}">🌐 ${esc(locationText)}</div>` : ''}
        ${lastSeen ? `<div class="gm-last-seen">${lastSeen}</div>` : ''}
      </div>
    </div>`;
  }).join('');
}

function statusLabel(s) {
  const map = { 'active': '🟢 ', 'join me': '🔵 ', 'ask me': '🟡 ', 'busy': '🔴 ', 'offline': '⚫ 
  return map[s] || s || '⚫ ' + __('group.offline');
}

function formatLocation(worldName) {
  if (!worldName) return '';
  const name = worldName.length > 24 ? worldName.substring(0, 22) + '...' : worldName;
  return name;
}

function formatLastSeen(d) {
  if (!d) return '';
  const dt = new Date(d);
  const now = new Date();
  const diff = now - dt;
  if (diff < 60000) return __('group.just_now');
  if (diff < 3600000) return Math.floor(diff / 60000) + __('group.minutes_ago_short');
  if (diff < 86400000) return Math.floor(diff / 3600000) + __('group.hours_ago_short');
  if (diff < 604800000) return Math.floor(diff / 86400000) + __('group.days_ago_short');
  return dt.toLocaleDateString('zh-CN');
}

// ==================== 群组概览 ====================
function updateGroupOverview(members) {
  const total = members.length;
  const online = members.filter(m => m.isOnline).length;
  const today = new Date().toDateString();
  const joinedToday = members.filter(m => m.joinedAt && new Date(m.joinedAt).toDateString() === today).length;

  document.getElementById('groupTotalMembers').textContent = total;
  document.getElementById('groupOnlineCount').textContent = online;
  document.getElementById('groupJoinedToday').textContent = joinedToday;

  const syncTime = members.length > 0 ? members[0].syncedAt : null;
  const syncEl = document.getElementById('groupSyncTime');
  if (syncEl && syncTime) syncEl.textContent = __('group.synced_at') + ' formatLastSeen(syncTime);
}

// ==================== 筛选 ====================
function filterGroupMembers(filter, btn) {
  groupFilter = filter;
  document.querySelectorAll('.group-filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === filter));
  loadGroupMembers();
}

// ==================== 刷新在线状态 ====================
async function refreshGroupStatus() {
  if (groupStatusRefreshing) return;
  groupStatusRefreshing = true;
  const btn = document.getElementById('refreshGroupBtn');
  if (btn) { btn.disabled = true; btn.textContent = __('group.refreshing'); }

  try {
    const res = await api('/api/group/members/refresh');
    if (!res.ok) {
      try {
        const errData = await res.json();
        if (errData.code === 'VRC_SYSTEM_OFFLINE' || errData.code === 'VRC_NOT_LOGGED_IN') {
          toast(__('group.bind_first'), 'warn');
        } else {
          toast(errData.error || __('group.refresh_failed'), 'error');
        }
      } catch { toast(__('group.refresh_failed'), 'error'); }
      groupStatusRefreshing = false;
      if (btn) { btn.disabled = false; btn.textContent = __('group.refresh_btn'); }
      return;
    }
    const data = await res.json();
    toast(__('group.refresh_done', {online: data.online, offline: data.offline, total: data.total}), 'success');

    // 更新当前页面
    await loadGroupMembers();

    // 更新徽章
    if (data.online > 0) {
      const badge = document.getElementById('groupBadge');
      if (badge) { badge.textContent = data.online; badge.classList.remove('d-none'); }
    }
  } catch (err) {
    if (isApiHandledError(err)) { groupStatusRefreshing = false; if (btn) { btn.disabled = false; btn.textContent = __('group.refresh_btn'); } return; }
    toast(__('group.refresh_retry'), 'error');
  }

  groupStatusRefreshing = false;
  if (btn) { btn.disabled = false; btn.textContent = __('group.refresh_btn'); }
}

// ==================== 同步群组成员 ====================
async function syncGroupMembers() {
  const btn = document.getElementById('syncGroupBtn');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = __('group.syncing');

  try {
    const res = await api('/api/group/members/sync', { method: 'POST' });
    if (!res.ok) {
      try {
        const errData = await res.json();
        if (errData.code === 'VRC_SYSTEM_OFFLINE' || errData.code === 'VRC_NOT_LOGGED_IN') {
          toast(__('group.bind_first'), 'warn');
        } else {
          toast(errData.error || __('group.sync_failed'), 'error');
        }
      } catch { toast(__('group.sync_failed_vrc'), 'error'); }
      btn.disabled = false;
      btn.textContent = __('group.sync_btn');
      return;
    }
    const data = await res.json();
    let msg = `${__('group.sync_done', {n: data.total})}`;
    if (data.joined > 0) msg += `，${__('group.new_joined', {n: data.joined})}`;
    if (data.left > 0) msg += `，${__('group.left_count', {n: data.left})}`;
    toast(msg, 'success');
    await loadGroupMembers();
  } catch (err) {
    if (isApiHandledError(err)) { btn.disabled = false; btn.textContent = __('group.sync_btn'); return; }
    toast(__('group.sync_failed_vrc'), 'error');
  }

  btn.disabled = false;
  btn.textContent = __('group.sync_btn');
}

// ==================== 变更记录 ====================
async function loadGroupChanges() {
  const section = document.getElementById('groupChangesSection');
  const list = document.getElementById('groupChangesList');
  if (!section || !list) return;

  // 仅管理员可见
  const isAdmin = currentUser && (currentUser.role === 'admin' || currentUser.role === 'super_admin');
  if (!isAdmin) { section.classList.add('d-none'); return; }
  section.classList.remove('d-none');

  try {
    const res = await api('/api/group/members/changes?limit=20');
    if (!res.ok) return;
    const data = await res.json();
    const changes = data.changes || [];
    document.getElementById('groupChangesCount').textContent = '(' + changes.length + __('group.n_changes_suffix') + ')';
    if (changes.length === 0) {
      list.innerHTML = '<div class="text-muted2 text-12 p-8">${__('group.no_changes')}</div>'; return;
    }
    list.innerHTML = changes.map(c => {
      const icon = c.changeType === 'joined' ? '✅' : c.changeType === 'left' ? '👋' : '🔄';
      const typeLabel = c.changeType === 'joined' ? __('group.status_joined') : c.changeType === 'left' ? __('group.status_left') : __('group.status_changed');
      return `<div class="group-change-item">
        <span class="group-change-icon">${icon}</span>
        <span class="group-change-name">${esc(c.vrchatName)}</span>
        <span class="group-change-type ${c.changeType}">${typeLabel}</span>
        <span class="group-change-time">${formatLastSeen(c.createdAt)}</span>
      </div>`;
    }).join('');
  } catch {}
}

// ==================== 自动轮询在线状态 ====================
let groupPollTimer = null;

function startGroupPolling() {
  if (groupPollTimer) return;
  // 每 60 秒自动刷新在线状态
  groupPollTimer = setInterval(() => {
    const tab = document.getElementById('tab-group');
    if (tab && !tab.classList.contains('d-none')) {
      refreshGroupStatus();
    }
  }, 60000);
}

function stopGroupPolling() {
  if (groupPollTimer) { clearInterval(groupPollTimer); groupPollTimer = null; }
}

// 初始化
document.addEventListener('DOMContentLoaded', () => {
  // 只在用户已登录时启动轮询，否则等待登录事件
  if (currentUser) {
    startGroupPolling();
  }
});
