// ==================== 管理员 - 用户管理模块 ====================

let adminUserSearchTimer = null;
let adminUserCurrentPage = 1;

async function loadUsersAdmin(page) {
  if (!currentUser || (currentUser.role !== 'admin' && currentUser.role !== 'super_admin')) {
    toast(__('permission_denied'), 'error');
    return;
  }
  adminUserCurrentPage = page || 1;
  const q = document.getElementById('adminUserSearch')?.value?.trim() || '';
  const role = document.getElementById('adminUserRoleFilter')?.value || '';
  const status = document.getElementById('adminUserStatusFilter')?.value || '';
  try {
    const params = new URLSearchParams();
    params.set('page', adminUserCurrentPage);
    params.set('pageSize', '20');
    if (q) params.set('search', q);
    if (role) params.set('role', role);
    if (status) params.set('status', status);
    const res = await api('/api/admin/users?' + params.toString(), { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      renderUsersAdmin(data.users || []);
      renderAdminPagination(data);
    }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('admin_users.load_failed') + ': ' + err.message, 'error'); }
}

function onAdminUserSearch(value) {
  clearTimeout(adminUserSearchTimer);
  adminUserSearchTimer = setTimeout(() => loadUsersAdmin(1), 300);
}

function onAdminUserFilter() {
  loadUsersAdmin(1);
}

function renderAdminPagination(data) {
  const container = document.getElementById('adminUserPagination');
  if (!container) return;
  if (!data || data.totalPages <= 1) { container.innerHTML = ''; return; }
  const current = data.page;
  const total = data.totalPages;
  let html = '';
  if (current > 1) {
    html += `<button class="btn btn-xs btn-outline" onclick="loadUsersAdmin(1)" title="${__('admin_users.title_first_page')}">&laquo;</button>`;
    html += `<button class="btn btn-xs btn-outline" onclick="loadUsersAdmin(${current - 1})">&lsaquo;</button>`;
  }
  const start = Math.max(1, current - 2);
  const end = Math.min(total, current + 2);
  for (let i = start; i <= end; i++) {
    html += `<button class="btn btn-xs ${i === current ? 'btn-accent' : 'btn-outline'}" onclick="loadUsersAdmin(${i})">${i}</button>`;
  }
  if (current < total) {
    html += `<button class="btn btn-xs btn-outline" onclick="loadUsersAdmin(${current + 1})">&rsaquo;</button>`;
    html += `<button class="btn btn-xs btn-outline" onclick="loadUsersAdmin(${total})" title="${__('admin_users.title_last_page')}">&raquo;</button>`;
  }
  container.innerHTML = html;
}

function renderUsersAdmin(users) {
  const container = document.getElementById('adminUsersList');
  if (!container) return;
  if (!users || users.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">👤</div><div class="text-muted2">${__('admin_users.no_match')}</div></div>';
    return;
  }
  container.innerHTML = users.map(u => {
    const name = esc(u.displayName || u.loginId);
    const loginId = esc(u.loginId);
    const avatarSrc = escAttr(u.avatarUrl || '/api/avatar/default');
    const id_esc = esc(String(u.id) || '');
    const role_esc = esc(u.role || 'member');
    let roleLabel = __('unknown');
    if (u.role === 'super_admin') roleLabel = __('members.role_super_admin');
    else if (u.role === 'admin') roleLabel = __('members.role_admin');
    else if (u.role === 'member') roleLabel = __('members.role_member');
    let statusLabel = __('admin.pending_review');
    if (u.banned) statusLabel = __('admin.banned');
    else if (u.approved) statusLabel = __('admin.approved');
    const approveBtn = !u.approved ? `<button class="btn btn-sm btn-accent" onclick="approveUser('${id_esc}')">${__('admin.approve')}</button>` : '';
    const banBtn = !u.banned
      ? `<button class="btn btn-sm btn-danger" onclick="banUser('${id_esc}')">${__('admin.ban')}</button>`
      : `<button class="btn btn-sm" onclick="unbanUser('${id_esc}')">${__('admin.unban')}</button>`;
    const name_js = escJsStr(u.displayName || u.loginId);
    const editBtn = `<button class="btn btn-sm" onclick="showEditUser('${id_esc}', '${name_js}', '${role_esc}')">✏️ ${__('edit')}</button>`;
    const pwdBtn = `<button class="btn btn-sm" onclick="showResetPwd('${id_esc}')">🔑 ${__('admin.reset_pwd')}</button>`;
    const delBtn = `<button class="btn btn-sm btn-danger" onclick="deleteUser('${id_esc}')">${__('delete')}</button>`;
    return `<div class="admin-user-card">
      <img src="${avatarSrc}" class="admin-user-avatar" alt="${name}" loading="lazy">
      <div class="admin-user-info">
        <div class="admin-user-name">${name}</div>
        <div class="admin-user-loginId">${__('admin_users.login_id')}: ${loginId}</div>
        <div class="admin-user-role">${__('admin_users.role')}: ${roleLabel}</div>
        <div class="admin-user-status">${__('admin_users.status')}: ${statusLabel}</div>
      </div>
      <div class="admin-user-actions">
        ${approveBtn}${banBtn}${editBtn}${pwdBtn}${delBtn}
      </div>
    </div>`;
  }).join('');
}

async function approveUser(userId) {
  showConfirm(__('admin.approve_confirm'), async () => {
    try {
      const res = await api(`/api/admin/users/${userId}/approve`, { method: 'POST' });
      if (res.ok) { toast(__('admin_users.approved'), 'success'); loadUsersAdmin(adminUserCurrentPage); }
    } catch (err) { if (isApiHandledError(err)) return; toast(__('admin_users.op_failed') + ': ' + err.message, 'error'); }
  });
}

async function banUser(userId) {
  showConfirm(__('admin.ban_confirm'), async () => {
    try {
      const res = await api(`/api/admin/users/${userId}/ban`, { method: 'POST' });
      if (res.ok) { toast(__('admin_users.banned'), 'success'); loadUsersAdmin(adminUserCurrentPage); }
    } catch (err) { if (isApiHandledError(err)) return; toast(__('admin_users.op_failed') + ': ' + err.message, 'error'); }
  });
}

async function unbanUser(userId) {
  showConfirm(__('admin.unban_confirm'), async () => {
    try {
      const res = await api(`/api/admin/users/${userId}/unban`, { method: 'POST' });
      if (res.ok) { toast(__('admin_users.unbanned'), 'success'); loadUsersAdmin(adminUserCurrentPage); }
    } catch (err) { if (isApiHandledError(err)) return; toast(__('admin_users.op_failed') + ': ' + err.message, 'error'); }
  });
}

async function deleteUser(userId) {
  showConfirm(__('admin.user_delete_confirm'), async () => {
    try {
      const res = await api(`/api/admin/users/${userId}`, { method: 'DELETE' });
      if (res.ok) { toast(__('admin_users.deleted'), 'success'); loadUsersAdmin(adminUserCurrentPage); }
    } catch (err) { if (isApiHandledError(err)) return; toast(__('admin_users.op_failed') + ': ' + err.message, 'error'); }
  });
}

// ========== 创建用户弹窗 ==========
function showAddUserModal() {
  document.getElementById('newUserLoginId').value = '';
  document.getElementById('newUserPassword').value = '';
  document.getElementById('newUserDisplayName').value = '';
  document.getElementById('newUserRole').value = 'member';
  document.getElementById('addUserError').textContent = '';
  document.getElementById('addUserError').classList.add('d-none');
  showModal('addUserModal');
}

async function createUser() {
  const loginId = document.getElementById('newUserLoginId')?.value?.trim();
  const password = document.getElementById('newUserPassword')?.value;
  const displayName = document.getElementById('newUserDisplayName')?.value?.trim();
  const role = document.getElementById('newUserRole')?.value || 'member';
  if (!loginId || !password) { toast(__('admin.fill_login_pwd'), 'error'); return; }
  const errorEl = document.getElementById('addUserError');
  try {
    const res = await api('/api/admin/users', {
      method: 'POST',
      body: { loginId, password, displayName, role }
    });
    if (res.ok) {
      toast(__('admin_users.created'), 'success');
      closeModal('addUserModal');
      document.getElementById('newUserLoginId').value = '';
      document.getElementById('newUserPassword').value = '';
      document.getElementById('newUserDisplayName').value = '';
      loadUsersAdmin(1);
      return;
    }
    const errData = await res.json().catch(() => ({}));
    if (errorEl) {
      errorEl.textContent = errData.error || errData.message || `${__('admin_users.create_failed')} (${res.status})`;
      if (errData.details && Array.isArray(errData.details)) {
        errorEl.textContent += __('admin_users.colon') + errData.details.join(__('admin_users.semicolon'));
      }
      errorEl.classList.remove('d-none');
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    if (errorEl) { errorEl.textContent = err.message || __('admin_users.create_failed'); errorEl.classList.remove('d-none'); }
    else { toast(__('admin_users.create_failed') + ': ' + err.message, 'error'); }
  }
}

// ========== 编辑用户弹窗 ==========
function showEditUser(userId, displayName, role) {
  document.getElementById('editUserId').value = userId;
  document.getElementById('editUserDisplayName').value = displayName || '';
  document.getElementById('editUserRole').value = role || 'member';
  showModal('editUserModal');
}

async function updateUser() {
  const userId = document.getElementById('editUserId')?.value;
  const displayName = document.getElementById('editUserDisplayName')?.value;
  const role = document.getElementById('editUserRole')?.value;
  if (!userId) { toast(__('admin_users.invalid_id'), 'error'); return; }
  if (!displayName) { toast(__('admin.fill_display_name'), 'error'); return; }
  try {
    const res = await api(`/api/users/${userId}`, {
      method: 'PUT',
      body: { displayName, role }
    });
    if (res.ok) {
      toast(__('admin_users.updated'), 'success');
      closeModal('editUserModal');
      loadUsersAdmin(adminUserCurrentPage);
    }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('admin_users.update_failed') + ': ' + err.message, 'error'); }
}

// ========== 重置密码弹窗 ==========
function showResetPwd(userId) {
  document.getElementById('resetPwdUserId').value = userId;
  document.getElementById('resetPwdNew').value = '';
  document.getElementById('resetPwdError').textContent = '';
  document.getElementById('resetPwdError').classList.add('d-none');
  showModal('resetPwdModal');
}

async function resetUserPassword() {
  const userId = document.getElementById('resetPwdUserId')?.value;
  const newPassword = document.getElementById('resetPwdNew')?.value;
  if (!userId) { toast(__('admin_users.invalid_id'), 'error'); return; }
  if (!newPassword || newPassword.length < 8) { toast(__('admin_users.pwd_min_length'), 'error'); return; }
  try {
    const res = await api(`/api/admin/users/${userId}/reset-password`, {
      method: 'POST',
      body: { newPassword }
    });
    if (res.ok) {
      const data = await res.json();
      toast(data.message || __('admin_users.pwd_reset'), 'success');
      closeModal('resetPwdModal');
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    const errorEl = document.getElementById('resetPwdError');
    const errMsg = err.message === 'RATE_LIMITED' ? __('admin_users.rate_limited') : (err.message || __('admin_users.op_failed'));
    if (errorEl) { errorEl.textContent = errMsg; errorEl.classList.remove('d-none'); }
    else toast(__('admin_users.reset_failed') + ': ' + errMsg, 'error');
  }
}
