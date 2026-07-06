// ==================== 成员列表 ====================
async function loadMembers() {
  const container = document.getElementById('membersList');
  if (container) container.innerHTML = Array(8).fill('<div class="skeleton-card-grid"></div>').join('');
  try {
    const res = await api('/api/users/list', { method: 'GET' });
    if (res.ok) { const data = await res.json(); membersCache = data.users || []; populateRoleFilter(); filterMembers(); if (typeof mapInstance !== 'undefined' && mapInstance) updateMapMarkers(); }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('members.load_failed_msg'), 'error'); }
}

function populateRoleFilter() {
  const select = document.getElementById('memberRoleFilter');
  if (!select) return;
  // 保持当前选中值
  const currentVal = select.value;
  const roles = new Set();
  membersCache.forEach(m => roles.add(m.role));
  const roleLabels = { 'super_admin': __('members.role_super_admin'), 'admin': __('members.role_admin'), 'member': __('members.role_member') };
  select.innerHTML = '<option value="">' + __('members.role_all') + '</option>' +
    Array.from(roles).sort().map(r => `<option value="${r}">${roleLabels[r] || r}</option>`).join('');
  if (currentVal) select.value = currentVal;
}

function filterMembers(searchText) {
  // 支持无参调用（从 loadMembers 恢复当前搜索状态）
  if (typeof searchText === 'undefined' || searchText === null) {
    const input = document.querySelector('#tab-members .search-box');
    searchText = input ? input.value : '';
  }
  const roleFilter = document.getElementById('memberRoleFilter')?.value || '';
  const filtered = membersCache.filter(m => {
    const name = (m.displayName || m.loginId || '').toLowerCase();
    const search = searchText.toLowerCase();
    if (search && !name.includes(search)) return false;
    if (roleFilter && m.role !== roleFilter) return false;
    return true;
  });
  renderMembers(filtered);
  const countEl = document.getElementById('memberCount');
  if (countEl) {
    const total = membersCache.length;
    if (searchText || roleFilter) {
      countEl.textContent = __('members.found_count', {found: filtered.length, total: total});
    } else {
      countEl.textContent = __('members.total_count', {n: total});
    }
  }
}

function renderMembers(members) {
  const container = document.getElementById('membersList');
  if (!container) return;
  if (!members || members.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">👥</div><div>${__('members.no_members')}</div></div>';
    return;
  }
  container.innerHTML = members.map(m => `
    <div class="member-card">
      <div class="member-card-click" onclick="goToProfile(${m.id})">
        <img src="${m.avatarUrl || '/api/avatar/default'}" class="member-avatar" alt="${esc(m.displayName || m.loginId)}" loading="lazy">
        <div class="member-info">
          <div class="member-name">${esc(m.displayName || m.loginId)}</div>
          <div class="member-role">${roleLabels[m.role] || __('members.role_guest')}</div>
        </div>
      </div>
      ${m.locationVisible ? `<div class="member-location">📍 ${esc(m.location || __('members.unknown_location'))}</div>` : ''}
      <button class="btn btn-sm btn-outline ml-auto" onclick="event.stopPropagation();showMemberDetail('${m.id}')">${__('members.card')}</button>
    </div>
  `).join('');
}

async function showMemberCard(userId) {
  if (!userId) userId = currentUser?.id;
  if (!userId) return;
  try {
    const res = await api(`/api/users/${userId}/card`, { method: 'GET' });
    if (res.ok) {
      const u = await res.json();
      const modal = document.getElementById('memberModal');
      // 填充已有元素
      const img = document.getElementById('ucAvatar');
      const nameEl = document.getElementById('ucName');
      const roleEl = document.getElementById('ucRole');
      const locationEl = document.getElementById('ucLocation');
      const mottoEl = document.getElementById('ucMotto');
      const birthdayEl = document.getElementById('ucBirthday');
      const vrcNameEl = document.getElementById('ucVrcName');
      const joinedEl = document.getElementById('ucJoined');
      const bioEl = document.getElementById('ucBio');
      if (img) img.src = u.avatarUrl || '/api/avatar/default';
      if (nameEl) nameEl.textContent = u.displayName || u.loginId || __('unknown_user');
      const roleMap = { 'super_admin': __('members.role_super_admin'), 'admin': __('members.role_admin'), 'member': __('members.role_member') };
      if (roleEl) roleEl.textContent = roleMap[u.role] || u.role;
      if (mottoEl) mottoEl.textContent = u.motto || u.bio || '';
      if (locationEl) {
        if (u.locationVisible && u.location) {
          locationEl.className = 'd-flex gap-4 items-center';
          locationEl.innerHTML = `<span class="text-muted2">${__('members.location')}：</span><span>${esc(u.location)}</span>`;
        } else {
          locationEl.className = 'd-none';
        }
      }
      // 填充生日
      if (birthdayEl) {
        if (u.birthday) {
          birthdayEl.className = 'd-flex gap-4 items-center';
          birthdayEl.innerHTML = `<span class="text-muted2">${__('profile.birthday')}：</span><span>${esc(u.birthday)}</span>`;
        } else {
          birthdayEl.className = 'd-none';
        }
      }
      // 填充VRChat用户名
      if (vrcNameEl) {
        if (u.vrchatName) {
          vrcNameEl.className = 'd-flex gap-4 items-center';
          vrcNameEl.innerHTML = `<span class="text-muted2">${__('members.vrc')}</span><span>${esc(u.vrchatName)}</span>`;
        } else {
          vrcNameEl.className = 'd-none';
        }
      }
      // 填充加入时间
      if (joinedEl) {
        if (u.joinedAt) {
          joinedEl.className = 'd-flex gap-4 items-center';
          joinedEl.innerHTML = `<span class="text-muted2">${__('members.joined')}</span><span>${fmtDate(u.joinedAt)}</span>`;
        } else {
          joinedEl.className = 'd-none';
        }
      }
      // 填充简介
      if (bioEl) {
        if (u.bio) {
          bioEl.className = 'member-bio-text';
          bioEl.textContent = u.bio;
        } else {
          bioEl.className = 'd-none';
        }
      }
      // 活动记录和相册链接
      const linksEl = document.getElementById('memberCardLinks');
      if (linksEl) {
        let html = '';
        if (u.evtCount > 0) {
          html += `<a href="#" onclick="showUserEvents(${u.id})" class="btn btn-sm btn-outline">📅 ${__('members.n_events', {n: u.evtCount})}</a>`;
        }
        if (u.photoCount > 0) {
          html += `<a href="#" onclick="showUserPhotos(${u.id})" class="btn btn-sm btn-outline">📷 ${__('members.n_photos', {n: u.photoCount})}</a>`;
        }
        // 如果是当前用户，也显示编辑按钮
        if (currentUser && currentUser.id === u.id) {
          html += `<a href="#" onclick="closeModal('memberModal');switchTab('me')" class="btn btn-sm btn-outline">${__('members.edit_profile')}</a>`;
        }
        // 查看完整资料页
        html += `<a href="#" onclick="closeModal('memberModal');goToProfile(${u.id})" class="btn btn-sm btn-outline">${__('members.full_profile')}</a>`;
        linksEl.innerHTML = html || '';
      }
      if (modal) showModal('memberModal');
    }
  } catch { toast(__('members.detail_load_failed'), 'error'); }
}

// 查看该用户的活动记录
window.showUserEvents = function(userId) {
  closeModal('memberModal');
  // 切换到活动 tab，并过滤显示该用户报名的活动
  // 通过调用后端 API 获取该用户活动
  switchTab('events');
  toast(__('members.loading_events'), 'info');
  // 在 events.js 中需要一个全局函数来显示特定用户的活动
  if (typeof loadUserEvents === 'function') {
    loadUserEvents(userId);
  }
};

// 查看该用户的照片
window.showUserPhotos = function(userId) {
  closeModal('memberModal');
  switchTab('album');
  toast(__('members.loading_photos'), 'info');
  if (typeof loadUserPhotos === 'function') {
    loadUserPhotos(userId);
  }
};

function showMemberDetail(id) { showMemberCard(id); }
