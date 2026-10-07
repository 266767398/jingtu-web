// ==================== 管理员 - 用户管理模块 ====================

let adminUserSearchTimer = null;
let adminUserCurrentPage = 1;
let adminUsersLoading = false;

function initAdminUsersEventDelegates() {
  const container = document.getElementById('adminUsersSection');
  if (!container || container._userDelegateInit) return;
  container._userDelegateInit = true;
  
  container.addEventListener('click', (e) => {
    const el = e.target.closest('[data-user-action], [data-action]');
    if (!el) return;
    
    if (el.hasAttribute('data-user-action')) {
      const action = el.dataset.userAction;
      const userId = el.dataset.userId;
      const userName = el.dataset.userName;
      const userRole = el.dataset.userRole;
      const userEmail = el.dataset.userEmail;
      
      switch (action) {
        case 'approve':
          approveUser(userId);
          break;
        case 'ban':
          banUser(userId);
          break;
        case 'unban':
          unbanUser(userId);
          break;
        case 'edit':
          showEditUser(userId, userName, userRole);
          break;
        case 'reset-pwd':
          showResetPwd(userId);
          break;
        case 'delete':
          deleteUser(userId);
          break;
        case 'login-history':
          viewLoginHistory(userId);
          break;
        case 'edit-admin':
          showEditAdmin(userId, userName, userRole, userEmail);
          break;
        case 'delete-admin':
          deleteAdmin(userId);
          break;
      }
    } else if (el.hasAttribute('data-action')) {
      const action = el.dataset.action;
      const value = parseInt(el.dataset.value);
      
      switch (action) {
        case 'load-users':
          loadUsersAdmin(value);
          break;
        case 'load-oper-log':
          loadOperLog(value);
          break;
        case 'load-admin-mgr':
          loadAdminMgrList(value);
          break;
      }
    }
  });
}

async function loadUsersAdmin(page) {
  if (!currentUser || (currentUser.role !== 'admin' && currentUser.role !== 'super_admin')) {
    toast(__('permission_denied'), 'error');
    return;
  }
  if (adminUsersLoading) return;
  adminUsersLoading = true;
  initAdminUsersEventDelegates();
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
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('admin_users.load_failed') + ': ' + err.message, 'error');
  } finally {
    adminUsersLoading = false;
  }
}

// 统一的用户管理刷新入口：列表 + 顶部统计卡（待审核计数等）一起重载。
// 任何写操作（审批/删除/封禁/解封/新建/编辑）成功后都必须调用它，
// 确保列表与仪表盘统计始终与后端真实状态一致，杜绝__('auto_admin_users_1')
// 或__('auto_admin_users_2')的前后端状态不同步。page 缺省沿用当前页。
function refreshUserManagement(page) {
  loadUsersAdmin(page || adminUserCurrentPage);
  if (typeof loadAdminStats === 'function') loadAdminStats();
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
    html += `<button class="btn btn-xs btn-outline" data-action="load-users" data-value="1" title="${__('admin_users.title_first_page')}">&laquo;</button>`;
    html += `<button class="btn btn-xs btn-outline" data-action="load-users" data-value="${current - 1}">&lsaquo;</button>`;
  }
  const start = Math.max(1, current - 2);
  const end = Math.min(total, current + 2);
  for (let i = start; i <= end; i++) {
    html += `<button class="btn btn-xs ${i === current ? 'btn-accent' : 'btn-outline'}" data-action="load-users" data-value="${i}">${i}</button>`;
  }
  if (current < total) {
    html += `<button class="btn btn-xs btn-outline" data-action="load-users" data-value="${current + 1}">&rsaquo;</button>`;
    html += `<button class="btn btn-xs btn-outline" data-action="load-users" data-value="${total}" title="${__('admin_users.title_last_page')}">&raquo;</button>`;
  }
  container.innerHTML = html;
}

function renderUsersAdmin(users) {
  const container = document.getElementById('adminUsersList');
  if (!container) return;
  // 隐藏系统预置的默认超管/管理员占位账号，避免用户疑惑__('auto_admin_users_3')
  const RESERVED_LOGINS = new Set(['superadmin', 'super_admin']);
  const filtered = (users || []).filter(u => !RESERVED_LOGINS.has(u.loginId) && u.email !== 'admin@jingtu.com');
  if (filtered.length === 0) {
    renderEmpty(container, { icon: '👤', text: __('admin_users.no_match') });
    return;
  }
  container.innerHTML = filtered.map(u => {
    const name = esc(u.displayName || u.loginId);
    const loginId = esc(u.loginId);
    const avatarSrc = escAttr(u.avatarUrl || '/api/avatar/default');
    const id_esc = escAttr(String(u.id) || '');
    const role_esc = escAttr(u.role || 'member');
    const name_attr = escAttr(u.displayName || u.loginId);
    let roleLabel = __('unknown');
    if (u.role === 'super_admin') roleLabel = __('members.role_super_admin');
    else if (u.role === 'admin') roleLabel = __('members.role_admin');
    else if (u.role === 'member') roleLabel = __('members.role_member');
    let statusLabel = __('admin.pending_review');
    if (u.banned) statusLabel = __('admin.banned');
    else if (u.approved) statusLabel = __('admin.approved');
    const approveBtn = !u.approved ? `<button class="btn btn-sm btn-accent" data-user-action="approve" data-user-id="${id_esc}">${__('admin.approve')}</button>` : '';
    const banBtn = !u.banned
      ? `<button class="btn btn-sm btn-danger" data-user-action="ban" data-user-id="${id_esc}">${__('admin.ban')}</button>`
      : `<button class="btn btn-sm" data-user-action="unban" data-user-id="${id_esc}">${__('admin.unban')}</button>`;
    const editBtn = `<button class="btn btn-sm" data-user-action="edit" data-user-id="${id_esc}" data-user-name="${name_attr}" data-user-role="${role_esc}">✏️ ${__('edit')}</button>`;
    const pwdBtn = `<button class="btn btn-sm" data-user-action="reset-pwd" data-user-id="${id_esc}">🔑 ${__('admin.reset_pwd')}</button>`;
    const historyBtn = `<button class="btn btn-sm" data-user-action="login-history" data-user-id="${id_esc}">📜 ${__('admin_users.login_history')}</button>`;
    const delBtn = `<button class="btn btn-sm btn-danger" data-user-action="delete" data-user-id="${id_esc}">${__('delete')}</button>`;
    return `<div class="admin-user-card">
      <img src="${avatarSrc}" class="admin-user-avatar" alt="${name}" loading="lazy" onerror="window.__avatarFail&&window.__avatarFail(this,'${escJsStr(u.avatarUrl || '/api/avatar/default')}')">
      <div class="admin-user-info">
        <div class="admin-user-name">${name}</div>
        <div class="admin-user-loginId">${__('admin_users.login_id')}: ${loginId}</div>
        <div class="admin-user-role">${__('admin_users.role')}: ${roleLabel}</div>
        <div class="admin-user-status">${__('admin_users.status')}: ${statusLabel}</div>
      </div>
      <div class="admin-user-actions">
        ${approveBtn}${banBtn}${editBtn}${pwdBtn}${historyBtn}${delBtn}
      </div>
    </div>`;
  }).join('');
}

async function approveUser(userId) {
  showConfirm(__('admin.approve_confirm'), async () => {
    try {
      const res = await api(`/api/admin/users/${userId}/approve`, { method: 'POST' });
      if (res.ok) { toast(__('admin_users.approved'), 'success'); refreshUserManagement(); }
    } catch (err) { if (isApiHandledError(err)) return; toast(__('admin_users.op_failed') + ': ' + err.message, 'error'); }
  });
}

async function banUser(userId) {
  showConfirm(__('admin.ban_confirm'), async () => {
    try {
      const res = await api(`/api/admin/users/${userId}/ban`, { method: 'POST' });
      if (res.ok) { toast(__('admin_users.banned'), 'success'); refreshUserManagement(); }
    } catch (err) { if (isApiHandledError(err)) return; toast(__('admin_users.op_failed') + ': ' + err.message, 'error'); }
  });
}

async function unbanUser(userId) {
  showConfirm(__('admin.unban_confirm'), async () => {
    try {
      const res = await api(`/api/admin/users/${userId}/unban`, { method: 'POST' });
      if (res.ok) { toast(__('admin_users.unbanned'), 'success'); refreshUserManagement(); }
    } catch (err) { if (isApiHandledError(err)) return; toast(__('admin_users.op_failed') + ': ' + err.message, 'error'); }
  });
}

async function deleteUser(userId) {
  showConfirm(__('admin.user_delete_confirm'), async () => {
    try {
      const res = await api(`/api/admin/users/${userId}`, { method: 'DELETE' });
      if (res.ok) { toast(__('admin_users.deleted'), 'success'); refreshUserManagement(); }
    } catch (err) { if (isApiHandledError(err)) return; toast(__('admin_users.op_failed') + ': ' + err.message, 'error'); }
  });
}

// S-6: 查看指定用户的登录历史（最近 20 条）
async function viewLoginHistory(userId) {
  const listEl = document.getElementById('loginHistoryList');
  if (!listEl) { toast(__('admin_users.op_failed'), 'error'); return; }
  showModal('loginHistoryModal');
  listEl.innerHTML = '<p class="text-muted2">' + __('loading_ellipsis') + '</p>';
  try {
    const res = await api(`/api/users/${userId}/login-history?limit=20`, { method: 'GET' });
    const data = await res.json();
    if (!res.ok) {
      listEl.innerHTML = `<p class="text-red">${esc(errText(data) || __('admin_users.op_failed'))}</p>`;
      return;
    }
    const rows = Array.isArray(data.list) ? data.list : [];
    if (rows.length === 0) {
      listEl.innerHTML = '<p class="text-muted2">' + __('admin_users.no_login_history') + '</p>';
      return;
    }
    listEl.innerHTML = rows.map((r) => {
      const okTxt = r.success ? '✅ ' + __('admin_users.success') : '❌ ' + __('admin_users.fail');
      const provider = r.provider === 'vrc' ? 'VRChat' : __('admin_users.provider_local');
      const time = esc(String(r.created_at || '') + '');
      const ip = esc(String(r.ip || '-') + '');
      const reason = esc(String(r.reason || '') + '');
      const ua = esc(String(r.user_agent || '') + '');
      return `<div style="padding:8px 0;border-bottom:1px dashed var(--border)">
        <div><strong>${time}</strong> <span class="text-muted2">${provider} · ${okTxt}</span></div>
        <div class="text-muted2">IP: ${ip} · ${reason}</div>
        <div class="text-muted2 text-12" style="word-break:break-all">${ua}</div>
      </div>`;
    }).join('');
  } catch (err) {
    listEl.innerHTML = `<p class="text-red">${esc(__('admin_users.op_failed'))}: ${esc(err.message)}</p>`;
  }
}

// ========== 创建用户弹窗 ==========
function showAddUserModal() {
  document.getElementById('newUserLoginId').value = '';
  document.getElementById('newUserPassword').value = '';
  document.getElementById('newUserDisplayName').value = '';
  document.getElementById('newUserRole').value = 'member';
  const emailEl = document.getElementById('newUserEmail'); if (emailEl) emailEl.value = '';
  document.getElementById('addUserError').textContent = '';
  document.getElementById('addUserError').classList.add('d-none');
  showModal('addUserModal');
}

async function createUser() {
  const loginId = document.getElementById('newUserLoginId')?.value?.trim();
  const password = document.getElementById('newUserPassword')?.value;
  const displayName = document.getElementById('newUserDisplayName')?.value?.trim();
  const role = document.getElementById('newUserRole')?.value || 'member';
  const email = document.getElementById('newUserEmail')?.value?.trim();
  if (!loginId || !password) { toast(__('admin.fill_login_pwd'), 'error'); return; }
  const errorEl = document.getElementById('addUserError');
  try {
    const res = await api('/api/admin/users', {
      method: 'POST',
      body: { loginId, password, displayName, role, email }
    });
    if (res.ok) {
      toast(__('admin_users.created'), 'success');
      closeModal('addUserModal');
      document.getElementById('newUserLoginId').value = '';
      document.getElementById('newUserPassword').value = '';
      document.getElementById('newUserDisplayName').value = '';
      loadUsersAdmin(1);
      if (typeof loadAdminStats === 'function') loadAdminStats();
      return;
    }
    const errData = await res.json().catch(() => ({}));
    if (errorEl) {
      errorEl.textContent = errText(errData) || __('admin_users.create_failed') + ' (' + res.status + ')';
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

// ========== 生成激活码弹窗 ==========
let _generatedCodes = [];

function showGenerateCodesModal() {
  const countEl = document.getElementById('genCodesCount');
  const noteEl = document.getElementById('genCodesNote');
  const expiresEl = document.getElementById('genCodesExpires');
  const errEl = document.getElementById('genCodesError');
  const wrapEl = document.getElementById('genCodesResultWrap');
  const listEl = document.getElementById('genCodesResult');
  if (countEl) countEl.value = '1';
  if (noteEl) noteEl.value = '';
  if (expiresEl) expiresEl.value = '0';
  if (errEl) { errEl.textContent = ''; errEl.classList.add('d-none'); }
  if (wrapEl) wrapEl.classList.add('d-none');
  if (listEl) listEl.innerHTML = '';
  _generatedCodes = [];
  showModal('generateCodesModal');
}

async function generateCodes() {
  const count = Math.min(200, Math.max(1, parseInt(document.getElementById('genCodesCount')?.value, 10) || 1));
  const note = document.getElementById('genCodesNote')?.value?.trim() || '';
  const expiresDays = Math.min(3650, Math.max(0, parseInt(document.getElementById('genCodesExpires')?.value, 10) || 0));
  const errEl = document.getElementById('genCodesError');
  const wrapEl = document.getElementById('genCodesResultWrap');
  const listEl = document.getElementById('genCodesResult');
  const btn = document.getElementById('genCodesModalSubmitBtn');
  const showErr = (msg) => {
    if (errEl) { errEl.textContent = msg; errEl.classList.remove('d-none'); }
    else toast(msg, 'error');
  };
  if (errEl) errEl.classList.add('d-none');
  if (wrapEl) wrapEl.classList.add('d-none');
  if (btn) btn.disabled = true;
  try {
    const res = await api('/api/admin/activation-codes/generate', {
      method: 'POST',
      body: { count, note, expiresDays }
    });
    if (res.ok) {
      const data = await res.json();
      _generatedCodes = data.codes || [];
      if (listEl) {
        listEl.innerHTML = _generatedCodes.map(code =>
          '<div class="gen-code-row"><code class="gen-code-text">' + code + '</code>' +
          '<button type="button" class="btn btn-sm btn-outline gen-code-copy" data-code="' + escAttr(code) + '">' + __('admin.copy') + '</button></div>'
        ).join('');
        listEl.querySelectorAll('.gen-code-copy').forEach(function(b) {
          b.addEventListener('click', function() {
            copyToClipboard(this.getAttribute('data-code')).then(function() { toast(__('admin.copied'), 'success'); });
          });
        });
      }
      if (wrapEl) {
        const exp = data.expiresAt;
        let expEl = document.getElementById('genCodesExpiresInfo');
        if (exp) {
          if (!expEl) {
            expEl = document.createElement('p');
            expEl.id = 'genCodesExpiresInfo';
            expEl.className = 'text-13 text-muted mt-8';
            wrapEl.insertBefore(expEl, wrapEl.firstChild);
          }
          expEl.textContent = __('modal.gen_expires_until', { date: String(exp).replace('T', ' ').slice(0, 19) });
          expEl.classList.remove('d-none');
        } else if (expEl) {
          expEl.classList.add('d-none');
        }
        wrapEl.classList.remove('d-none');
      }
      toast(__('admin_users.codes_generated', { count: _generatedCodes.length }), 'success');
      return;
    }
    const errData = await res.json().catch(() => ({}));
    showErr(errText(errData) || __('admin_users.codes_gen_failed') + ' (' + res.status + ')');
  } catch (err) {
    if (isApiHandledError(err)) return;
    showErr(err.message || __('admin_users.codes_gen_failed'));
  } finally {
    if (btn) btn.disabled = false;
  }
}

function copyGeneratedCodes() {
  if (!_generatedCodes.length) return;
  copyToClipboard(_generatedCodes.join('\r\n')).then(function() { toast(__('admin.copied'), 'success'); });
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
  const confirmPassword = prompt(__('admin_users.confirm_pwd_prompt'));
  if (confirmPassword === null) return; // 用户取消
  try {
    const res = await api(`/api/users/${userId}`, {
      method: 'PUT',
      body: { displayName, role, confirmPassword }
    });
    if (res.ok) {
      toast(__('admin_users.updated'), 'success');
      closeModal('editUserModal');
      refreshUserManagement();
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
  const confirmPassword = document.getElementById('resetPwdConfirm')?.value;
  if (!confirmPassword) { toast(__('admin_users.confirm_pwd_required'), 'error'); return; }
  try {
    const res = await api(`/api/admin/users/${userId}/reset-password`, {
      method: 'POST',
      body: { newPassword, confirmPassword }
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


// ==================== 操作日志管理 ====================
// 这里原本有一份 loadOperLog + renderOperLog，渲染进 #operLogList、读取
// #operLogSearch / #operLogType —— 这三个元素在 index.html 里都不存在。
// 而 admin-vrc.js 比本文件后加载，它那份同名的 loadOperLog（渲染进真实存在的
// #operLog，读 #operLogUserSearch / #operLogTypeFilter）才是实际生效的实现。
// 同名函数跨文件重复定义没有任何报错，只会静默覆盖，这里留下的死代码
// 会让后来者误以为改对了地方。已删除，操作日志统一见 admin-vrc.js。

// （此处的 exportData(type, format) 死代码已删除：全站无任何调用点，
// 且与 profile-page.js 的 exportData(format) 同名互相覆盖。
// 个人中心导出见 profile-page.js，如需管理端导出请另行命名接入。）

// ==================== 系统备份 ====================
async function createBackup() {
  if (!currentUser || (currentUser.role !== 'admin' && currentUser.role !== 'super_admin')) {
    toast(__('permission_denied'), 'error');
    return;
  }
  if (!confirm(__('admin.backup_confirm'))) return;
  try {
    const res = await api('/api/admin/backups/create', { method: 'POST' });
    if (res.ok) {
      const data = await res.json();
      if (data.success) {
        toast(__('admin.backup_success') + ': ' + data.filename, 'success');
        loadBackups();
      } else {
        toast(errText(data) || __('admin.backup_failed'), 'error');
      }
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('admin.backup_failed') + ': ' + err.message, 'error');
  }
}

async function loadBackups() {
  if (!currentUser || (currentUser.role !== 'admin' && currentUser.role !== 'super_admin')) {
    toast(__('permission_denied'), 'error');
    return;
  }
  try {
    const res = await api('/api/admin/backups', { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      renderBackups(data.backups);
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('admin.load_backups_failed') + ': ' + err.message, 'error');
  }
}

function renderBackups(backups) {
  const container = document.getElementById('backupList');
  if (!container) return;
  
  if (!backups || backups.length === 0) {
    container.innerHTML = __('auto_admin_users_4');
    return;
  }
  
  container.innerHTML = `
    <table style="width:100%;border-collapse:collapse">
      <thead>
        <tr style="background:var(--card2)">
          <th style="padding:8px;text-align:left;font-size:12px;font-weight:600;border-bottom:1px solid var(--border)" data-i18n="admin.backup_name">文件名</th>
          <th style="padding:8px;text-align:left;font-size:12px;font-weight:600;border-bottom:1px solid var(--border)" data-i18n="admin.backup_size">大小</th>
          <th style="padding:8px;text-align:left;font-size:12px;font-weight:600;border-bottom:1px solid var(--border)" data-i18n="admin.backup_time">创建时间</th>
          <th style="padding:8px;text-align:left;font-size:12px;font-weight:600;border-bottom:1px solid var(--border)" data-i18n="admin.backup_action">操作</th>
        </tr>
      </thead>
      <tbody>
        ${backups.map(b => {
          const filename = b.name || b.filename;
          const encodedFilename = encodeURIComponent(filename);
          const createdDate = b.createdAt ? new Date(b.createdAt) : null;
          const createdText = createdDate && !isNaN(createdDate.getTime()) ? createdDate.toLocaleString() : __('unknown');
          return `
          <tr style="border-bottom:1px solid var(--border);transition:background 0.2s" onmouseenter="this.style.background='var(--hover)'" onmouseleave="this.style.background='transparent'">
            <td style="padding:8px;font-size:12px">${esc(filename)}</td>
            <td style="padding:8px;font-size:12px">${b.sizeFormatted}</td>
            <td style="padding:8px;font-size:12px">${createdText}</td>
            <td style="padding:8px;font-size:12px">
              <button onclick="downloadBackup('${escJsStr(encodedFilename)}')" class="btn btn-sm btn-outline" style="padding:2px 8px" data-i18n="admin.download">下载</button>
              <button onclick="deleteBackup('${escJsStr(encodedFilename)}')" class="btn btn-sm btn-red" style="padding:2px 8px" data-i18n="admin.delete">删除</button>
            </td>
          </tr>
        `; }).join('')}
      </tbody>
    </table>
  `;
}

function downloadBackup(encodedFilename) {
  window.open(`/api/admin/backups/${encodedFilename}/download`, '_blank');
}

async function deleteBackup(encodedFilename) {
  const filename = decodeURIComponent(encodedFilename);
  if (!confirm(__('admin.backup_delete_confirm', {filename}))) return;
  try {
    const res = await api(`/api/admin/backups/${encodedFilename}`, { method: 'DELETE' });
    if (res.ok) {
      const data = await res.json();
      if (data.success) {
        toast(__('admin.backup_deleted'), 'success');
        loadBackups();
      }
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('admin.backup_delete_failed') + ': ' + err.message, 'error');
  }
}


// ==================== 管理员管理（超级管理员专用） ====================
let adminMgrCurrentPage = 1;
let adminMgrSearchTimer = null;

// 通用分页渲染：生成带 data-action / data-value 的按钮，配合 initAdminUsersEventDelegates 事件委托。
// 此前 renderAdminMgrList 调用了一个并不存在的 renderPagination，导致多页时分页必抛 ReferenceError。
function renderPagination(current, total, action) {
  if (!total || total <= 1) return '';
  let html = '';
  if (current > 1) {
    html += `<button class="btn btn-xs btn-outline" data-action="${action}" data-value="1" title="${__('admin_users.title_first_page')}">&laquo;</button>`;
    html += `<button class="btn btn-xs btn-outline" data-action="${action}" data-value="${current - 1}">&lsaquo;</button>`;
  }
  const start = Math.max(1, current - 2);
  const end = Math.min(total, current + 2);
  for (let i = start; i <= end; i++) {
    html += `<button class="btn btn-xs ${i === current ? 'btn-accent' : 'btn-outline'}" data-action="${action}" data-value="${i}">${i}</button>`;
  }
  if (current < total) {
    html += `<button class="btn btn-xs btn-outline" data-action="${action}" data-value="${current + 1}">&rsaquo;</button>`;
    html += `<button class="btn btn-xs btn-outline" data-action="${action}" data-value="${total}" title="${__('admin_users.title_last_page')}">&raquo;</button>`;
  }
  return html;
}

async function loadAdminMgrList(page) {
  const mgrSection = document.getElementById('adminManageSection');
  if (!mgrSection) return;
  if (!currentUser || currentUser.role !== 'super_admin') {
    mgrSection.style.display = 'none';
    return;
  }
  mgrSection.style.display = 'block';
  adminMgrCurrentPage = page || 1;
  const search = document.getElementById('adminMgrSearch')?.value?.trim() || '';
  const role = document.getElementById('adminMgrRoleFilter')?.value || '';
  
  try {
    const params = new URLSearchParams();
    params.set('page', adminMgrCurrentPage);
    params.set('pageSize', '20');
    params.set('role', role);
    if (search) params.set('search', search);
    
    const res = await api('/api/admin/users?' + params.toString(), { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      renderAdminMgrList(data.users || [], data.totalPages || 1);
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('admin.load_failed') + ': ' + err.message, 'error');
  }
}

function onAdminMgrSearch(value) {
  clearTimeout(adminMgrSearchTimer);
  adminMgrSearchTimer = setTimeout(() => loadAdminMgrList(1), 300);
}

function renderAdminMgrList(users, totalPages) {
  const container = document.getElementById('adminMgrList');
  if (!container) return;
  
  if (!users || users.length === 0) {
    renderEmpty(container, { icon: '🔐', text: __('admin.no_admins') });
    const pagEl = document.getElementById('adminMgrPagination'); if (pagEl) pagEl.innerHTML = '';
    return;
  }
  
  container.innerHTML = users.map(u => {
    const name = esc(u.displayName || u.loginId);
    const loginId = esc(u.loginId);
    const avatarSrc = escAttr(u.avatarUrl || '/api/avatar/default');
    const id_esc = esc(String(u.id) || '');
    let roleLabel = __('members.role_admin');
    if (u.role === 'super_admin') roleLabel = __('members.role_super_admin');
    const isSelf = currentUser && currentUser.id == u.id;
    const name_attr = escAttr(u.displayName || u.loginId);
    const role_attr = escAttr(u.role);
    const editBtn = !isSelf ? `<button class="btn btn-sm" data-user-action="edit-admin" data-user-id="${id_esc}" data-user-name="${name_attr}" data-user-role="${role_attr}" data-user-email="${escAttr(u.email || '')}">✏️ ${__('edit')}</button>` : '';
    const delBtn = !isSelf ? `<button class="btn btn-sm btn-danger" data-user-action="delete-admin" data-user-id="${id_esc}">${__('delete')}</button>` : '';
    return `<div class="admin-user-card">
      <img src="${avatarSrc}" class="admin-user-avatar" alt="${name}" loading="lazy" onerror="window.__avatarFail&&window.__avatarFail(this,'${escJsStr(u.avatarUrl || '/api/avatar/default')}')">
      <div class="admin-user-info">
        <div class="admin-user-name">${name}${isSelf ? ' <span style="color:var(--accent)">(' + __('admin.self') + ')</span>' : ''}</div>
        <div class="admin-user-loginId">${__('admin_users.login_id')}: ${loginId}</div>
        <div class="admin-user-role">${__('admin.role')}: ${roleLabel}</div>
        ${u.email ? '<div class="admin-user-loginId">📧 ' + esc(u.email) + '</div>' : ''}
      </div>
      <div class="admin-user-actions">
        ${editBtn}${delBtn}
      </div>
    </div>`;
  }).join('');
  
  const pagination = document.getElementById('adminMgrPagination');
  if (pagination) pagination.innerHTML = renderPagination(adminMgrCurrentPage, totalPages, 'load-admin-mgr');
}

function showAddAdminModal() {
  document.getElementById('newAdminLoginId').value = '';
  document.getElementById('newAdminDisplayName').value = '';
  document.getElementById('newAdminPassword').value = '';
  document.getElementById('newAdminRole').value = 'admin';
  document.getElementById('newAdminEmail').value = '';
  document.getElementById('addAdminError').textContent = '';
  document.getElementById('addAdminError').classList.add('d-none');
  showModal('addAdminModal');
}

async function createAdmin() {
  const loginId = document.getElementById('newAdminLoginId')?.value?.trim();
  const displayName = document.getElementById('newAdminDisplayName')?.value?.trim();
  const password = document.getElementById('newAdminPassword')?.value;
  const role = document.getElementById('newAdminRole')?.value || 'admin';
  const email = document.getElementById('newAdminEmail')?.value?.trim();
  
  if (!loginId || !password) { toast(__('admin.fill_login_pwd'), 'error'); return; }
  
  const errorEl = document.getElementById('addAdminError');
  try {
    const res = await api('/api/admin/users', {
      method: 'POST',
      body: { loginId, password, displayName: displayName || loginId, role, email }
    });
    if (res.ok) {
      toast(__('admin.admin_created'), 'success');
      closeModal('addAdminModal');
      loadAdminMgrList(1);
    } else {
      const errData = await res.json().catch(() => ({}));
      if (errorEl) {
        errorEl.textContent = errText(errData) || __('admin.create_failed') + ' (' + res.status + ')';
        errorEl.classList.remove('d-none');
      }
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    if (errorEl) { errorEl.textContent = err.message || __('admin.create_failed'); errorEl.classList.remove('d-none'); }
    else { toast(__('admin.create_failed') + ': ' + err.message, 'error'); }
  }
}

// 管理员管理页按钮（原内联 onclick 迁移到委托）
document.addEventListener('click', function (e) {
  if (e.target.closest('#adminAddBtn')) { showAddAdminModal(); return; }
  if (e.target.closest('#adminRefreshBtn')) { loadAdminMgrList(1); return; }
});

function showEditAdmin(userId, displayName, role, email) {
  document.getElementById('editAdminId').value = userId;
  document.getElementById('editAdminDisplayName').value = displayName || '';
  document.getElementById('editAdminRole').value = role || 'admin';
  const emailEl = document.getElementById('editAdminEmail');
  if (emailEl) emailEl.value = email || '';
  document.getElementById('editAdminError').textContent = '';
  document.getElementById('editAdminError').classList.add('d-none');
  showModal('editAdminModal');
}

async function updateAdmin() {
  const userId = document.getElementById('editAdminId')?.value;
  const displayName = document.getElementById('editAdminDisplayName')?.value?.trim();
  const role = document.getElementById('editAdminRole')?.value;
  const email = document.getElementById('editAdminEmail')?.value?.trim();
  
  if (!userId) { toast(__('admin_users.invalid_id'), 'error'); return; }
  if (!displayName) { toast(__('admin.fill_display_name'), 'error'); return; }
  
  const confirmPassword = prompt(__('admin_users.confirm_pwd_prompt'));
  if (confirmPassword === null) return; // 用户取消
  try {
    const res = await api(`/api/users/${userId}`, {
      method: 'PUT',
      body: { displayName, role, email: email || null, confirmPassword }
    });
    if (res.ok) {
      toast(__('admin.admin_updated'), 'success');
      closeModal('editAdminModal');
      loadAdminMgrList(adminMgrCurrentPage);
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('admin.update_failed') + ': ' + err.message, 'error');
  }
}

async function deleteAdmin(userId) {
  showConfirm(__('admin.admin_delete_confirm'), async () => {
    try {
      const res = await api(`/api/admin/users/${userId}`, { method: 'DELETE' });
      if (res.ok) {
        toast(__('admin.admin_deleted'), 'success');
        loadAdminMgrList(adminMgrCurrentPage);
      }
    } catch (err) {
      if (isApiHandledError(err)) return;
      toast(__('admin.delete_failed') + ': ' + err.message, 'error');
    }
  });
}

// ==================== 管理面板快捷导航 ====================
function scrollToAdminSection(id) {
  const el = document.getElementById(id);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.add('highlight');
    setTimeout(() => el.classList.remove('highlight'), 1000);
  }
}

// ==================== 个人中心页面 ====================
async function loadMePage() {
  if (!currentUser) return;
  
  // 加载个人信息
  const el = (id) => document.getElementById(id);
  // 表单类元素（input）用 .value 填充，textContent 对 input 不生效
  const dn = el('meDisplayName'); if (dn) dn.value = currentUser.displayName || currentUser.loginId || '-';
  const li = el('meLoginId'); if (li) li.value = currentUser.loginId || '-';
  // 展示类元素（div/span）用 textContent 填充
  const e = el('meEmail'); if (e) e.textContent = currentUser.email || '-';
  
  let roleLabel = __('members.role_member');
  if (currentUser.role === 'super_admin') roleLabel = __('members.role_super_admin');
  else if (currentUser.role === 'admin') roleLabel = __('members.role_admin');
  const r = el('meRole'); if (r) r.textContent = roleLabel;
  
  const createTimeVal = currentUser.createTime || currentUser.createdAt;
  const rt = el('meRegisterTime'); if (rt) rt.textContent = createTimeVal ? new Date(createTimeVal).toLocaleString() : '-';
  const ll = el('meLastLogin'); if (ll) ll.textContent = currentUser.lastLoginTime ? new Date(currentUser.lastLoginTime).toLocaleString() : '-';
  const vn = el('meVrcName'); if (vn) vn.textContent = currentUser.vrchatName || '-';
  const vi = el('meVrcId'); if (vi) vi.textContent = currentUser.vrchatId || '-';
  
  // 安全评分（简单计算）
  let score = 50;
  if (currentUser.email) score += 20;
  if (currentUser.vrchatId) score += 10;
  const ss = el('meSecurityScore'); if (ss) ss.textContent = score + '/100';
  
  // 密码强度（模拟）
  const ps = el('mePasswordStrength'); if (ps) ps.textContent = __('me.pwd_unknown');

  // 个人中心的 4 张统计卡（发帖/照片/活动/评论）。
  // 填充它们的 updateMeStats() 原先只被 ui.js 里那份同名 loadMePage 调用，
  // 而那份被本文件（后加载）静默覆盖了 —— 于是 #meTotalPosts 等四个元素
  // 从来没被写过值，接口 /api/profile/stats 一直是好的，只是没人调。
  if (typeof updateMeStats === 'function') updateMeStats();
}

// showChangePasswordModal 已删除：它无人调用，且会对 index.html 里并不存在的
// #changePwdCurrent 等元素直接 `.value = ''`，一旦被调用必抛
// "Cannot set properties of null"。改密码入口在个人中心（profile.js）。

// changePassword 曾在此重复定义（读 #changePwdCurrent/#changePwdNew/#changePwdConfirm，
// 这些元素在 index.html 里都不存在），被后加载的 profile.js 中同名实现静默覆盖。
// 死代码已删除，改密码的唯一实现见 profile.js（读 #meCurPwd / #meNewPwd / #meNewPwd2）。

async function logoutAllSessions() {
  showConfirm(__('me.logout_all_confirm'), async () => {
    try {
      const res = await api('/api/users/me/logout-all', { method: 'POST' });
      if (res.ok) {
        toast(__('me.logout_all_success'), 'success');
      }
    } catch (err) {
      if (isApiHandledError(err)) return;
      toast(__('me.logout_all_failed') + ': ' + err.message, 'error');
    }
  });
}
