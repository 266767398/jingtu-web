// ==================== 管理员 - 用户权限查看器（只读） ====================

let permInspectCache = [];
let permInspectInit = false;

// 旧实现写死到已废弃的 user_permissions 表（且不会被任何业务路由强制），
// 现改为只读查看器：调用 /api/permissions-view，分别展示「网站用户权限」与「群组用户权限」。
// ui.js 打开管理面板时会调用本函数。
async function loadPermissions() {
  const box = document.getElementById('permInspectResult');
  if (!currentUser || currentUser.role !== 'super_admin') {
    if (box) box.innerHTML = '<div class="text-muted2 text-13">' + __('admin_perms.super_admin_only_view') + '</div>';
    return;
  }
  if (!permInspectInit) {
    permInspectInit = true;
    const userSel = document.getElementById('permInspectUser');
    if (userSel) userSel.addEventListener('change', (e) => inspectUserPermissions(e.target.value));
    const search = document.getElementById('permInspectSearch');
    if (search) search.addEventListener('input', (e) => onPermInspectSearch(e.target.value));
  }
  if (box) box.innerHTML = '<div class="text-muted2 text-13">' + __('admin_perms.select_user_prompt') + '</div>';
  try {
    const res = await api('/api/users/list?pageSize=200', { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      permInspectCache = data.users || [];
      const sel = document.getElementById('permInspectUser');
      if (sel) {
        sel.innerHTML = '<option value="">' + __('admin_perms.select_user') + '</option>' +
          permInspectCache.map(u => `<option value="${u.id}">${esc(u.displayName || u.loginId)}</option>`).join('');
      }
    }
  } catch {}
}

function onPermInspectSearch(value) {
  const sel = document.getElementById('permInspectUser');
  if (!sel) return;
  const v = (value || '').toLowerCase();
  sel.innerHTML = '<option value="">' + __('admin_perms.select_user') + '</option>' +
    permInspectCache
      .filter(u => (u.displayName || u.loginId || '').toLowerCase().includes(v))
      .map(u => `<option value="${u.id}">${esc(u.displayName || u.loginId)}</option>`).join('');
}

async function inspectUserPermissions(userId) {
  const box = document.getElementById('permInspectResult');
  if (!box) return;
  if (!userId) { box.innerHTML = '<div class="text-muted2 text-13">' + __('admin_perms.select_user_prompt') + '</div>'; return; }
  box.innerHTML = '<div class="skeleton-card skeleton-card-md"></div>';
  try {
    const res = await api(`/api/permissions-view/user/${userId}`, { method: 'GET' });
    if (!res.ok) { box.innerHTML = '<div class="text-red text-13">' + __('admin_perms.load_failed') + '</div>'; return; }
    const data = await res.json();
    box.innerHTML = renderPermissionInspect(data.website, data.group);
  } catch (err) { box.innerHTML = '<div class="text-red text-13">' + __('admin_perms.load_failed') + '：' + esc(err.message) + '</div>'; }
}

// 渲染只读权限检视卡片（网站 + 群组），被__('auto_admin_perms_1')与__('auto_admin_perms_2')共同复用
function renderPermissionInspect(w, g) {
  if (!w) return '<div class="text-red text-13">' + __('admin_perms.user_not_exist') + '</div>';
  const grp = (w.permissionGroups || []).map(x => esc(x.name) + (x.isSystem ? __('admin_perms.system_marker') : '')).join('、') || __('admin_perms.none');
  const enabled = Object.keys(w.effectivePermissions || {}).filter(k => w.effectivePermissions[k]);
  const enabledLabels = enabled.map(k => PERM_LABELS[k] || k);
  const legacyN = w.legacyPermissions ? Object.keys(w.legacyPermissions).length : 0;
  let groupHtml;
  if (g && g.inGroup) {
    groupHtml =
      row(__('admin_perms.vrchat_group'), __('admin_perms.in_group') + '（' + esc(g.membershipStatusLabel || '') + '）') +
      row(__('admin_perms.online_status'), (g.isOnline ? __('admin_perms.online') : __('admin_perms.offline')) + '（' + esc(g.vrchatStatus || '') + '）') +
      (g.worldName ? row(__('admin_perms.world'), esc(g.worldName)) : '') +
      (g.roleIds && g.roleIds.length ? row(__('admin_perms.vrchat_role_ids'), esc(g.roleIds.join(', '))) : '');
  } else {
    groupHtml = row(__('admin_perms.vrchat_group'), esc((g && g.reason) || __('admin_perms.not_in_group')));
  }
  return `
    <div style="display:flex;gap:10px;align-items:center;margin-bottom:8px">
      <img src="${escAttr(w.avatarUrl || '/api/avatar/default')}" class="admin-user-avatar" alt="">
      <div><div class="admin-user-name">${esc(w.displayName || w.loginId)}</div>
      <div class="text-12 text-muted">${esc(w.loginId)} · ${__('admin_perms.role')}${esc(w.roleLabel)}（L${w.roleLevel}）</div></div>
    </div>
    <div style="font-weight:600;margin:8px 0 4px">${__('admin_perms.website_perms_title')}</div>
    ${row(__('admin_perms.belongs_groups'), grp)}
    ${row(__('admin_perms.base_group_id'), String(w.baseGroupId))}
    ${row(__('admin_perms.effective_perms') + ' (' + enabled.length + ')', enabledLabels.length ? enabledLabels.map(esc).join('、') : __('admin_perms.none'))}
    ${legacyN ? row(__('admin_perms.legacy_perms'), legacyN + __('admin_perms.legacy_perms_note')) : ''}
    <div style="font-weight:600;margin:8px 0 4px">${__('admin_perms.group_perms_title')}</div>
    ${groupHtml}
  `;
  function row(k, v) {
    return `<div style="display:flex;gap:8px;padding:4px 0;border-bottom:1px solid var(--border)">
      <span style="flex:0 0 110px;color:var(--muted2);font-size:12px">${esc(k)}</span>
      <span style="flex:1;font-size:13px">${v}</span></div>`;
  }
}

// ========== 权限组管理 V6.2 ==========

// 权限标签映射
const PERM_LABELS = {
  'can_create_album': __('admin_perms.perm_create_album'),
  'can_create_photo': __('admin_perms.perm_create_photo'),
  'can_delete_photo': __('admin_perms.perm_delete_photo'),
  'can_create_announcement': __('admin_perms.perm_create_announcement'),
  'can_edit_announcement': __('admin_perms.perm_edit_announcement'),
  'can_delete_announcement': __('admin_perms.perm_delete_announcement'),
  'can_create_event': __('admin_perms.perm_create_event'),
  'can_edit_event': __('admin_perms.perm_edit_event'),
  'can_delete_event': __('admin_perms.perm_delete_event'),
  'can_sign_event': __('admin_perms.perm_sign_event'),
  'can_comment_event': __('admin_perms.perm_comment_event'),
  'can_manage_users': __('admin.perm_users'),
  'can_manage_roles': __('admin_perms.perm_manage_roles'),
  'can_review_names': __('admin.perm_name_change'),
  'can_manage_permissions': __('admin.perm_permissions'),
  'can_sync_vrchat': __('admin.perm_vrc_sync'),
  'can_manage_rosters': __('admin_perms.perm_manage_rosters'),
  'can_view_logs': __('admin.perm_log'),
  'can_upload_group_image': __('admin_perms.perm_upload_group_image'),
  'can_edit_profile': __('admin_perms.perm_edit_profile'),
  'can_change_password': __('admin_perms.perm_change_password'),
  'can_view_members': __('admin_perms.perm_view_members'),
  'can_view_map': __('admin_perms.perm_view_map'),
  'can_view_album': __('admin_perms.perm_view_album'),
  'can_view_events': __('admin_perms.perm_view_events'),
  'can_create_album_category': __('admin_perms.perm_create_album_category'),
  'can_create_post': __('admin_perms.perm_create_post'),
  'can_delete_post': __('admin_perms.perm_delete_post'),
  'can_comment_post': __('admin_perms.perm_comment_post'),
  'can_like_post': __('admin_perms.perm_like_post')
};

let permGroupTab = 'groups';
let pgGroupsCache = [];
let pgUsersCache = [];

// Tab 切换
function switchPermGroupTab(tab) {
  permGroupTab = tab;
  document.querySelectorAll('[data-pgtab]').forEach(b => b.classList.toggle('active', b.dataset.pgtab === tab));
  document.getElementById('permGroupList').classList.toggle('d-none', tab !== 'groups');
  document.getElementById('permGroupUserMgmt').classList.toggle('d-none', tab !== 'users');
  if (tab === 'groups') loadPermGroups();
  else if (tab === 'users') loadPermGroupUsers();
}

// 加载权限组列表
async function loadPermGroups() {
  const container = document.getElementById('permGroupList');
  if (!container) return;
  container.innerHTML = '<div class="skeleton-card skeleton-card-md"></div>';
  try {
    const res = await api('/api/permission-groups/groups', { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      pgGroupsCache = data.groups || [];
      renderPermGroups(pgGroupsCache);
    }
  } catch (err) { container.innerHTML = '<div class="text-13 text-red">' + __('admin_perms.load_failed') + '</div>'; }
}

function renderPermGroups(groups) {
  const container = document.getElementById('permGroupList');
  if (!container) return;
  if (!groups || groups.length === 0) {
    renderEmpty(container, { text: __('admin_perms.no_groups') });
    return;
  }
  container.innerHTML = groups.map(g => {
    const permCount = Object.keys(g.permissions || {}).length;
    const enabledCount = Object.values(g.permissions || {}).filter(v => v).length;
    const badges = [];
    if (g.isSystem) badges.push('<span class="badge badge-system">' + __('admin_perms.system_group') + '</span>');
    if (g.isDefault) badges.push('<span class="badge badge-default">' + __('admin_perms.default_group') + '</span>');
    const delBtn = g.isSystem ? '' : `<button class="btn btn-sm btn-danger" onclick="deletePermGroup(${g.id})">${__('admin_perms.delete_group')}</button>`;
    return `<div class="perm-group-card">
      <div class="perm-group-header">
        <strong>${esc(g.name)}</strong>
        ${badges.join(' ')}
        ${g.parentId ? `<span class="text-muted text-12">→ ${__('admin_perms.inherited_from')} #${g.parentId}</span>` : ''}
      </div>
      <div class="text-12 text-muted2">${esc(g.description || __('admin_perms.no_desc'))}</div>
      <div class="text-12 text-muted mt-4">${__('admin_perms.permissions_label')}：${__('admin_perms.perm_enabled_count', {enabled: enabledCount, total: permCount})}</div>
      <div class="perm-group-actions mt-6">
        <button class="btn btn-sm btn-accent" onclick="showEditPermGroupPerms(${g.id}, '${escJsStr(g.name)}')">${__('admin_perms.set_perms')}</button>
        <button class="btn btn-sm btn-outline" onclick="showEditPermGroup(${g.id})">${__('admin_perms.edit_group')}</button>
        ${delBtn}
      </div>
    </div>`;
  }).join('');
}

// 创建权限组弹窗
async function showCreatePermGroupModal() {
  try {
    const res = await api('/api/permission-groups/groups', { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      const select = document.getElementById('cpgParentId');
      if (select) {
        select.innerHTML = '<option value="">' + __('admin_perms.no_parent') + '</option>' +
          (data.groups || []).map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('');
      }
    }
  } catch {}
  document.getElementById('cpgName').value = '';
  document.getElementById('cpgDesc').value = '';
  document.getElementById('cpgError').classList.add('d-none');
  showModal('createPermGroupModal');
}

async function createPermGroup() {
  const name = document.getElementById('cpgName')?.value?.trim();
  const description = document.getElementById('cpgDesc')?.value?.trim();
  const parentId = parseInt(document.getElementById('cpgParentId')?.value) || null;
  if (!name) { toast(__('fill_required'), 'error'); return; }
  try {
    const res = await api('/api/permission-groups/groups', {
      method: 'POST',
      body: { name, description, parentId }
    });
    if (res.ok) {
      toast(__('operation_success'), 'success');
      closeModal('createPermGroupModal');
      loadPermGroups();
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    const errorEl = document.getElementById('cpgError');
    if (errorEl) { errorEl.textContent = err.message; errorEl.classList.remove('d-none'); }
  }
}

// 编辑权限组弹窗
async function showEditPermGroup(id) {
  const g = pgGroupsCache.find(x => x.id === id);
  if (!g) return;
  document.getElementById('epgId').value = g.id;
  document.getElementById('epgName').value = g.name;
  document.getElementById('epgDesc').value = g.description || '';
  document.getElementById('epgError').classList.add('d-none');
  try {
    const res = await api('/api/permission-groups/groups', { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      const select = document.getElementById('epgParentId');
      if (select) {
        select.innerHTML = '<option value="">' + __('admin_perms.no_parent') + '</option>' +
          (data.groups || []).filter(x => x.id !== id).map(g2 => `<option value="${g2.id}" ${g.parentId === g2.id ? 'selected' : ''}>${esc(g2.name)}</option>`).join('');
      }
    }
  } catch {}
  showModal('editPermGroupModal');
}

async function savePermGroup() {
  const id = parseInt(document.getElementById('epgId')?.value);
  const name = document.getElementById('epgName')?.value?.trim();
  const description = document.getElementById('epgDesc')?.value?.trim();
  const parentId = parseInt(document.getElementById('epgParentId')?.value) || null;
  if (!id || !name) { toast(__('admin_perms.invalid_param'), 'error'); return; }
  try {
    const res = await api(`/api/permission-groups/groups/${id}`, {
      method: 'PUT',
      body: { name, description, parentId }
    });
    if (res.ok) {
      toast(__('admin_perms.group_updated'), 'success');
      closeModal('editPermGroupModal');
      loadPermGroups();
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    const errorEl = document.getElementById('epgError');
    if (errorEl) { errorEl.textContent = err.message; errorEl.classList.remove('d-none'); }
  }
}

// 删除权限组
async function deletePermGroup(id) {
  const g = pgGroupsCache.find(x => x.id === id);
  showConfirm(__('admin_perms.delete_group_confirm_full', {name: g ? g.name : id, warn: __('admin_perms.delete_group_warn')}), async () => {
    try {
      const res = await api(`/api/permission-groups/groups/${id}`, { method: 'DELETE' });
      if (res.ok) { toast(__('operation_success'), 'success'); loadPermGroups(); }
    } catch (err) { if (isApiHandledError(err)) return; toast(__('admin_perms.delete_failed'), 'error'); }
  });
}

// 编辑权限组权限
async function showEditPermGroupPerms(groupId, groupName) {
  document.getElementById('pgPermGroupName').textContent = groupName;
  const container = document.getElementById('pgPermList');
  container.innerHTML = '<div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div>';
  showModal('permGroupEditPermsModal');
  try {
    const res = await api(`/api/permission-groups/groups/${groupId}/permissions`, { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      const perms = data.permissions || {};
      const allKeys = data.allKeys || Object.keys(PERM_LABELS);
      container.innerHTML = '<div class="perm-grid">' + allKeys.map(key => `
        <label class="perm-toggle-item ${perms[key] ? 'enabled' : ''}">
          <input type="checkbox" ${perms[key] ? 'checked' : ''} onchange="toggleGroupPerm(${groupId}, '${escJsStr(key)}', this.checked)">
          <span>${esc(PERM_LABELS[key] || key)}</span>
        </label>
      `).join('') + '</div>';
    }
  } catch (err) { container.innerHTML = '<div class="text-red">' + __('admin_perms.load_failed') + '</div>'; }
}

async function toggleGroupPerm(groupId, key, value) {
  try {
    const res = await api(`/api/permission-groups/groups/${groupId}/permissions/set`, {
      method: 'POST',
      body: { key, value }
    });
    if (res.ok) {
      const data = await res.json();
      toast(data.message || __('operation_success'), 'success');
      if (data.conflict) toast(data.conflict, 'warning');
      showEditPermGroupPerms(groupId, document.getElementById('pgPermGroupName').textContent);
    }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('admin_perms.update_failed'), 'error'); }
}

// ========== 用户归属管理 ==========
async function loadPermGroupUsers() {
  try {
    const res = await api('/api/users/list', { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      pgUsersCache = data.users || [];
      filterPermGroupUsers();
    }
  } catch {}
}

function filterPermGroupUsers() {
  const searchText = (document.getElementById('pgUserSearch')?.value || '').toLowerCase();
  const container = document.getElementById('permGroupUserList');
  if (!container) return;
  const filtered = pgUsersCache.filter(u => (u.displayName || u.loginId || '').toLowerCase().includes(searchText));
  container.innerHTML = filtered.map(u => `
    <div class="admin-user-card" onclick="showUserGroupMgmt(${u.id}, '${escJsStr(u.displayName || u.loginId)}')">
      <img src="${escAttr(u.avatarUrl || '/api/avatar/default')}" class="admin-user-avatar" loading="lazy">
      <div class="admin-user-info">
        <div class="admin-user-name">${esc(u.displayName || u.loginId)}</div>
        <div class="admin-user-loginId">${esc(u.loginId)}</div>
      </div>
      <button class="btn btn-sm btn-outline">${__('admin_perms.manage_groups')}</button>
    </div>
  `).join('');
  if (filtered.length === 0) container.innerHTML = '<div class="text-muted text-13">' + __('admin_perms.user_not_found') + '</div>';
}

async function showUserGroupMgmt(userId, userName) {
  document.getElementById('pgUserGroupUserId').value = userId;
  document.getElementById('pgUserGroupUserName').textContent = __('admin_perms.user_prefix') + userName;
  document.getElementById('pgUserGroupError').classList.add('d-none');
  showModal('pgUserGroupModal');
  try {
    const res = await api(`/api/permission-groups/users/${userId}/groups`, { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      const currentGroups = document.getElementById('pgUserCurrentGroups');
      const availableGroups = document.getElementById('pgUserAvailableGroups');
      if (currentGroups) {
        currentGroups.innerHTML = (data.groups || []).map(g =>
          `<div class="group-tag">
            <span>${esc(g.name)}</span>
            <button class="group-tag-remove" onclick="removeUserFromGroup(${userId}, ${g.id})">✕</button>
          </div>`
        ).join('') || '<span class="text-muted text-12">' + __('admin_perms.not_in_any_group') + '</span>';
      }
      if (availableGroups) {
        availableGroups.innerHTML = (data.available || []).map(g =>
          `<button class="btn btn-sm btn-outline" onclick="addUserToGroup(${userId}, ${g.id})">+ ${esc(g.name)}</button>`
        ).join('') || '<span class="text-muted text-12">' + __('admin_perms.in_all_groups') + '</span>';
      }
      // 联网站/群组权限检视（调用 /api/permissions-view），与__('auto_admin_perms_3')复用同一渲染
      const pv = document.getElementById('pgUserPermView');
      if (pv) {
        try {
          const pres = await api(`/api/permissions-view/user/${userId}`, { method: 'GET' });
          if (pres.ok) { const pd = await pres.json(); pv.innerHTML = renderPermissionInspect(pd.website, pd.group); }
          else pv.innerHTML = '<div class="text-muted2 text-13">' + __('admin_perms.no_perm_view') + '</div>';
        } catch { pv.innerHTML = ''; }
      }
    }
  } catch {}
}

async function addUserToGroup(userId, groupId) {
  try {
    const res = await api(`/api/permission-groups/users/${userId}/groups`, {
      method: 'POST',
      body: { groupId }
    });
    if (res.ok) {
      toast(__('admin_perms.user_joined_group'), 'success');
      showUserGroupMgmt(userId, document.getElementById('pgUserGroupUserName').textContent.replace(__('admin_perms.user_prefix'), ''));
    }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('admin_perms.op_failed'), 'error'); }
}

async function removeUserFromGroup(userId, groupId) {
  try {
    const res = await api(`/api/permission-groups/users/${userId}/groups/${groupId}`, { method: 'DELETE' });
    if (res.ok) {
      toast(__('admin_perms.user_left_group'), 'success');
      showUserGroupMgmt(userId, document.getElementById('pgUserGroupUserName').textContent.replace(__('admin_perms.user_prefix'), ''));
    }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('admin_perms.op_failed'), 'error'); }
}
