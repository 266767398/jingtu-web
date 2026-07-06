// ==================== 个人中心模块 ====================

async function showProfile() {
  if (!currentUser) return;
  try {
    const res = await api('/api/users/me/profile', { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      // 合并完整的 profile 数据到 currentUser
      Object.assign(currentUser, {
        loginId: data.loginId,
        displayName: data.displayName,
        vrchatId: data.vrchatId,
        vrchatName: data.vrchatName,
        vrchatAvatarUrl: data.vrchatAvatarUrl,
        vrchatVerified: data.vrchatVerified,
        role: data.role,
        avatarType: data.avatarType,
        avatarUrl: data.avatarUrl,
        qq: data.qq,
        birthday: data.birthday,
        location: data.location,
        locationVisible: !!data.locationVisible,
        bio: data.bio,
        preferences: data.preferences
      });
      updateUserUI();
      // 填充表单
      document.getElementById('meDisplayName').value = currentUser.displayName || '';
      document.getElementById('meLoginId').value = currentUser.loginId || '';
      document.getElementById('meQQ').value = currentUser.qq || '';
      document.getElementById('meBirthday').value = currentUser.birthday ? currentUser.birthday.substring(0, 10) : '';
      document.getElementById('meLocation').value = currentUser.location || '';
      document.getElementById('meLocationVisible').checked = !!currentUser.locationVisible;
      document.getElementById('meBio').value = currentUser.bio || '';
      document.getElementById('meMotto').value = currentUser.motto || '';
      if (currentUser.motto) document.getElementById('meMotto').textContent = currentUser.motto;
      // 渲染 VRChat 绑定状态
      renderVRChatBindStatus();
    }
    loadMyEvents();
  } catch (err) { if (isApiHandledError(err)) return; toast(__('profile.load_failed'), 'error'); }
}

async function updateProfile() {
  const displayName = document.getElementById('meDisplayName')?.value?.trim();
  const bio = document.getElementById('meBio')?.value?.trim();
  const qq = document.getElementById('meQQ')?.value?.trim();
  const birthday = document.getElementById('meBirthday')?.value || null;
  const location = document.getElementById('meLocation')?.value?.trim();
  const preferences = currentUser.preferences || {};

  const body = {};
  if (displayName) body.displayName = displayName;
  if (bio !== undefined) body.bio = bio;
  if (qq !== undefined) body.qq = qq;
  if (birthday !== undefined) body.birthday = birthday;
  if (location !== undefined) body.location = location;
  if (Object.keys(body).length === 0) { toast(__('profile.no_changes'), 'info'); return; }

  try {
    const res = await api('/api/users/me/profile', {
      method: 'PUT',
      body
    });
    if (res.ok) {
      toast(__('profile.saved'), 'success');
      await showProfile();
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('profile.update_failed') + ': ' + err.message, 'error');
  }
}

function saveProfile() { updateProfile(); }

async function saveMotto() {
  const motto = document.getElementById('meMotto')?.value?.trim();
  if (!motto) { toast(__('profile.motto_empty'), 'error'); return; }
  // 存到 preferences 的 motto 字段
  const prefs = currentUser.preferences || {};
  prefs.motto = motto;
  try {
    const res = await api('/api/users/me/profile', {
      method: 'PUT',
      body: { preferences: prefs }
    });
    if (res.ok) {
      currentUser.motto = motto;
      document.getElementById('meMotto').textContent = motto;
      currentUser.preferences = prefs;
      toast(__('profile.motto_saved'), 'success');
    }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('profile.save_failed') + ': ' + err.message, 'error'); }
}

async function saveBio() {
  const bio = document.getElementById('meBio')?.value?.trim();
  try {
    const res = await api('/api/users/me/profile', {
      method: 'PUT',
      body: { bio }
    });
    if (res.ok) {
      currentUser.bio = bio;
      toast(__('profile.bio_saved'), 'success');
    }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('profile.save_failed') + ': ' + err.message, 'error'); }
}

// ==================== 我的活动 ====================
async function loadMyEvents() {
  const container = document.getElementById('meEventsList');
  const countEl = document.getElementById('meEventsCount');
  if (!container) return;
  container.innerHTML = '<div class="text-muted text-13">${__('profile.loading')}</div>';
  try {
    const res = await api('/api/users/me/events', { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      const events = data.events || [];
      if (countEl) countEl.textContent = `(${events.length})`;
      if (events.length === 0) {
        container.innerHTML = '<div class="text-muted text-13">${__('profile.no_events')}</div>';
        return;
      }
      const now = new Date();
      container.innerHTML = events.map(e => {
        const evtTime = e.eventTime ? new Date(e.eventTime) : null;
        const cls = evtTime && evtTime < now ? 'text-muted2' : 'text-green';
        const label = evtTime && evtTime < now ? __('events.status_ended') : __('events.status_ongoing_or_not_started');
        return `<div class="me-event-item" onclick="showEventDetail(${e.id})">
          <span class="mee-time">${fmtDate(e.eventTime)}</span>
          <span class="mee-title">${esc(e.title)}</span>
          <span class="mee-status ${cls}">${label}</span>
        </div>`;
      }).join('');
    }
  } catch (err) { container.innerHTML = '<div class="text-13 text-red">${__('profile.load_failed')}</div>'; }
}

// ==================== 头像上传/移除/切换 ====================
async function uploadAvatar(file) {
  if (!file) return;
  const formData = new FormData();
  formData.append('avatar', file);
  try {
    const res = await apiForm('/api/users/me/avatar', formData);
    if (res.ok) {
      const data = await res.json();
      currentUser.avatarUrl = data.avatarUrl;
      currentUser.avatarType = 'custom';
      updateUserUI();
      toast(__('profile.avatar_updated'), 'success');
    }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('profile.upload_failed') + ': ' + err.message, 'error'); }
}

async function removeAvatar() {
  showConfirm(__('profile.confirm_remove_avatar'), async () => {
    try {
      const res = await api('/api/users/me/avatar', { method: 'DELETE' });
      if (res.ok) {
        currentUser.avatarUrl = null;
        currentUser.avatarType = 'none';
        updateUserUI();
        toast(__('profile.avatar_removed'), 'info');
      }
    } catch (err) { if (isApiHandledError(err)) return; toast(__('profile.op_failed') + ': ' + err.message, 'error'); }
  });
}

async function switchToVRchatAvatar() {
  if (!currentUser.vrchatId) { toast(__('profile.vrc_not_bound'), 'error'); return; }
  try {
    const res = await api('/api/users/me/avatar-vrchat', { method: 'POST' });
    if (res.ok) {
      const data = await res.json();
      currentUser.avatarUrl = data.avatarUrl;
      currentUser.avatarType = 'vrchat';
      updateUserUI();
      toast(__('profile.avatar_switched_vrc'), 'success');
    }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('profile.switch_failed') + ': ' + err.message, 'error'); }
}

// ==================== VRChat 绑定（密码验证） ====================
let _vrcBindTemp = null; // 存储2FA临时状态

async function bindVRChatWithPassword() {
  const username = document.getElementById('vrchatInputId')?.value?.trim();
  const password = document.getElementById('vrchatBindPwd')?.value;
  if (!username) { toast('${__('profile.enter_vrc_username')}', 'error'); return; }
  if (!password) { toast('${__('profile.enter_vrc_password')}', 'error'); return; }
  
  const btn = document.getElementById('vrcBindBtn');
  if (btn) { btn.disabled = true; btn.textContent = '${__('profile.verifying')}'; }
  
  try {
    const res = await api('/api/auth/vrchat-bind-verify', {
      method: 'POST',
      body: { username, password }
    });
    if (res.ok) {
      const data = await res.json();
      if (data.need2fa) {
        // 需要两步验证 → 保存 bindToken 供第二步使用
        _vrcBindTemp = { bindToken: data.bindToken, ...data };
        document.getElementById('vrcBind2fa').classList.remove('d-none');
        document.getElementById('vrcLookupResult').innerHTML = `<div class="text-13 text-muted">${esc(data.message)}</div>`;
        document.getElementById('vrcLookupResult').style.display = 'block';
        document.getElementById('vrcBind2faCode').value = '';
        document.getElementById('vrcBind2faCode').focus();
      } else if (data.success) {
        // 绑定成功（无需2FA）
        if (data.user) Object.assign(currentUser, data.user);
        // V6.12: 缓存绑定状态，保留登录
        const bindUsername2 = document.getElementById('vrchatInputId')?.value?.trim();
        if (bindUsername2) localStorage.setItem('jingtu_vrc_user', bindUsername2);
        localStorage.setItem('jingtu_vrc_bound', '1');
        updateUserUI();
        renderVRChatBindStatus();
        toast(__('profile.bind_success'), 'success');
        document.getElementById('vrcLookupResult').innerHTML = `<div class="text-green text-13">✅ ${__('profile.bind_success')}</div>`;
        document.getElementById('vrcLookupResult').style.display = 'block';
        setTimeout(() => { document.getElementById('vrcLookupResult').style.display = 'none'; }, 3000);
      }
    } else {
      const err = await res.json();
      toast(err.error || __('profile.bind_failed'), 'error');
    }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('profile.bind_failed') + ': ' + err.message, 'error'); }
  finally {
    if (btn) { btn.disabled = false; btn.textContent = __('profile.send_code'); }
  }
}

async function confirmVrcBind2fa() {
  const code = document.getElementById('vrcBind2faCode')?.value?.trim();
  if (!code) { toast(__('profile.enter_code'), 'error'); return; }
  
  const btn = document.getElementById('vrcBindBtn');
  if (btn) { btn.disabled = true; btn.textContent = '${__('profile.verifying')}'; }
  
  try {
    const res = await api('/api/auth/vrchat-bind-verify', {
      method: 'POST',
      body: { code, bindToken: _vrcBindTemp?.bindToken }
    });
    if (res.ok) {
      const data = await res.json();
      if (data.success) {
        // 绑定成功：合并用户数据，然后重新从服务器获取完整资料（确保数据一致）
        if (data.user) Object.assign(currentUser, data.user);
        // 重新从服务器加载最新资料（确保 vrchatId 等字段正确同步）
        try {
          const meRes = await api('/api/users/me/profile', { method: 'GET' });
          if (meRes.ok) {
            const meData = await meRes.json();
            Object.assign(currentUser, {
              vrchatId: meData.vrchatId,
              vrchatName: meData.vrchatName,
              vrchatVerified: meData.vrchatVerified,
              vrchatAvatarUrl: meData.vrchatAvatarUrl,
              avatarType: meData.avatarType,
              avatarUrl: meData.avatarUrl
            });
          }
        } catch(e) { console.warn('刷新用户资料失败:', e); }
        // V6.12: 缓存绑定状态，保留登录
        const bindUsername = document.getElementById('vrchatInputId')?.value?.trim();
        if (bindUsername) localStorage.setItem('jingtu_vrc_user', bindUsername);
        localStorage.setItem('jingtu_vrc_bound', '1');
        document.getElementById('vrcBind2fa').classList.add('d-none');
        document.getElementById('vrcBind2faCode').value = '';
        _vrcBindTemp = null;
        updateUserUI();
        renderVRChatBindStatus();
        toast(__('profile.bind_success'), 'success');
        document.getElementById('vrcLookupResult').innerHTML = `<div class="text-green text-13">✅ ${__('profile.bind_success')}</div>`;
        document.getElementById('vrcLookupResult').style.display = 'block';
        setTimeout(() => { document.getElementById('vrcLookupResult').style.display = 'none'; }, 3000);
      }
    } else {
      const err = await res.json();
      toast(err.error || __('profile.verify_failed'), 'error');
    }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('profile.verify_failed_msg') + ': ' + err.message, 'error'); }
  finally {
    if (btn) { btn.disabled = false; btn.textContent = __('profile.send_code'); }
  }
}

async function unbindVRChat() {
  showConfirm(__('profile.vrc_unbind_confirm'), async () => {
    try {
      const res = await api('/api/auth/vrchat-unbind', { method: 'POST' });
      if (res.ok) {
        currentUser.vrchatId = null;
        currentUser.vrchatName = null;
        currentUser.vrchatVerified = false;
        // V6.9: 清除浏览器缓存的 VRChat 绑定状态和用户名
        localStorage.removeItem('jingtu_vrc_user');
        localStorage.removeItem('jingtu_vrc_bound');
        updateUserUI();
        renderVRChatBindStatus();
        toast(__('profile.vrc_unbound'), 'info');
      }
    } catch (err) { if (isApiHandledError(err)) return; toast(__('profile.unbind_failed') + ': ' + err.message, 'error'); }
  });
}

// 渲染 VRChat 绑定状态（显示已绑定信息或绑定表单）
function renderVRChatBindStatus() {
  const statusEl = document.getElementById('vrchatStatus');
  const bindForm = document.getElementById('vrchatBindForm');
  const boundStatus = document.getElementById('vrchatBoundStatus');
  if (!statusEl || !bindForm || !boundStatus) return;
  if (!currentUser) return;

  if (currentUser.vrchatId) {
    // 已绑定
    statusEl.innerHTML = '<span class="text-13 text-green">✅ ${__(\'profile.bound\')}</span>';
    bindForm.classList.add('d-none');
    boundStatus.classList.remove('d-none');

    // 填充绑定账号信息
    document.getElementById('vrchatBoundName').textContent = currentUser.vrchatName || currentUser.vrchatId;
    document.getElementById('vrchatBoundId').textContent = currentUser.vrchatId;
    document.getElementById('vrchatBoundAvatar').src = currentUser.vrchatAvatarUrl || '/assets/group-avatar.svg';
    document.getElementById('vrchatBoundProfileLink').href = `https://vrchat.com/home/user/${currentUser.vrchatId}`;

    if (currentUser.vrchatVerified) {
      document.getElementById('vrchatBoundVerified').classList.remove('d-none');
    } else {
      document.getElementById('vrchatBoundVerified').classList.add('d-none');
    }
  } else {
    // 未绑定
    statusEl.innerHTML = '<span class="text-13 text-muted2">${__(\'profile.not_bound\')}</span>';
    bindForm.classList.remove('d-none');
    boundStatus.classList.add('d-none');
  }
}

async function toggleLocationVisible() {
  const visible = document.getElementById('meLocationVisible')?.checked;
  try {
    const res = await api('/api/users/me/location', {
      method: 'PUT',
      body: { visible }
    });
    if (res.ok) {
      currentUser.locationVisible = !!visible;
      if (!visible) {
        // 关掉后服务器已删除 lat/lng，清除本地缓存
        currentUser.lat = null;
        currentUser.lng = null;
      }
      toast(visible ? __('profile.gps_visible_msg') : __('profile.gps_hidden_msg'), 'info');
    }
  } catch { toast(__('profile.gps_visibility_failed'), 'error'); }
}

// V6.13: 手动更新 GPS 位置到服务器
async function updateMyLocation() {
  if (!currentUser) { toast('${__('profile.login_first')}', 'error'); return; }
  if (!navigator.geolocation) { toast('${__('profile.gps_not_supported')}', 'error'); return; }
  const btn = document.querySelector('[onclick="updateMyLocation()"]');
  const status = document.getElementById('profileLocationStatus');
  if (btn) { btn.disabled = true; btn.textContent = __('profile.gps_getting'); }
  if (status) { status.style.display = 'inline'; status.textContent = '${__('profile.gps_getting')}'; }
  try {
    const pos = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true, timeout: 15000, maximumAge: 60000
      });
    });
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;
    const accuracy = pos.coords.accuracy;

    const res = await api('/api/users/me/location', {
      method: 'PUT',
      body: { lat, lng, visible: true }
    });
    if (res.ok) {
      currentUser.lat = lat;
      currentUser.lng = lng;
      currentUser.locationVisible = true;
      document.getElementById('meLocationVisible').checked = true;
      if (status) status.textContent = `✅ ${__('profile.gps_updated')}（${__('profile.gps_accuracy', {n: Math.round(accuracy)})}）`;
      setTimeout(() => { if (status) status.style.display = 'none'; }, 5000);
      toast(__('profile.gps_updated'), 'success');
    }
  } catch (err) {
    if (err.code === 1) toast(__('profile.enable_gps'), 'error');
    else if (err.code === 2) toast(__('profile.gps_check_failed'), 'error');
    else if (err.code === 3) toast(__('profile.gps_timeout'), 'error');
    else toast(__('profile.gps_failed') + ': ' + err.message, 'error');
    if (status) status.textContent = __('profile.gps_failed_status');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = __('profile.gps_update_btn'); }
  }
}

// ==================== 密码修改 ====================
async function changePassword() {
  const oldPwd = document.getElementById('meCurPwd')?.value;
  const newPwd = document.getElementById('meNewPwd')?.value;
  const newPwd2 = document.getElementById('meNewPwd2')?.value;
  if (!oldPwd || !newPwd) { toast('${__('profile.enter_passwords')}', 'error'); return; }
  if (newPwd !== newPwd2) { toast('${__('profile.passwords_not_match')}', 'error'); return; }
  try {
    const res = await api('/api/auth/change-password', {
      method: 'POST',
      body: { oldPassword: oldPwd, newPassword: newPwd }
    });
    if (res.ok) {
      toast(__('profile.pwd_changed'), 'success');
      setTimeout(() => logout(), 2000);
    }
  } catch (err) { if (isApiHandledError(err)) return; toast('${__('profile.change_failed')}：' + err.message, 'error'); }
}

// ==================== 改名申请 ====================
function showNameChangeModal() { showModal('nameChangeModal'); }
function submitNameChange() { submitNameChangeRequest(); }

async function submitNameChangeRequest() {
  const requestedName = document.getElementById('ncNewName')?.value?.trim();
  const reason = document.getElementById('ncReason')?.value?.trim();
  if (!requestedName) { toast(__('profile.enter_name_change'), 'error'); return; }
  try {
    const res = await api('/api/name-change/request', {
      method: 'POST',
      body: { newName: requestedName, reason }
    });
    if (res.ok) {
      toast(__('profile.name_change_submitted'), 'success');
      closeModal('nameChangeModal');
      document.getElementById('ncNewName').value = '';
      document.getElementById('ncReason').value = '';
    }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('profile.submit_failed') + ': ' + err.message, 'error'); }
}

// 兼容旧调用 — 新绑定方式使用密码验证
