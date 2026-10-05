// ==================== 个人中心模块 ====================
let profileLoading = false;

async function showProfile() {
  if (!currentUser || profileLoading) return;
  profileLoading = true;
  try {
    const res = await api('/api/users/me/profile', { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      // 合并完整的 profile 数据到 currentUser
      Object.assign(currentUser, {
        loginId: data.loginId,
        displayName: data.displayName,
        email: data.email,
        createTime: data.createTime || data.createdAt,
        lastLoginTime: data.lastLoginTime,
        vrchatId: data.vrchatId,
        vrchatName: data.vrchatName,
        vrchatAvatarUrl: data.vrchatAvatarUrl,
        vrchatVerified: data.vrchatVerified,
        role: data.role,
        avatarType: data.avatarType,
        avatarVisible: data.avatarVisible !== false,
        customAvatarPath: data.customAvatarPath || null,
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
      // 渲染 VRChat 绑定状态
      renderVRChatBindStatus();
      // S-6: 渲染两步验证（TOTP）设置状态（仅超管显示设置卡片）
      renderTotpStatus();
      // 渲染头像显示设置（§11.8.8）
      renderAvatarPref();
      // 填充「账号信息」概览卡片（邮箱 / 注册时间 / 最后登录 / VRChat 名称 ID / 安全评分）
      if (typeof loadMePage === 'function') loadMePage();
    }
    loadMyEvents();
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('profile.load_failed'), 'error');
  } finally {
    profileLoading = false;
  }
}

let profileUpdating = false;

async function updateProfile() {
  if (profileUpdating) return;
  profileUpdating = true;
  const displayName = document.getElementById('meDisplayName')?.value?.trim();
  const bio = document.getElementById('meBio')?.value?.trim();
  const qq = document.getElementById('meQQ')?.value?.trim();
  const birthday = document.getElementById('meBirthday')?.value || null;
  const location = document.getElementById('meLocation')?.value?.trim();

  const body = {};
  if (displayName) body.displayName = displayName;
  if (bio !== undefined) body.bio = bio;
  if (qq !== undefined) body.qq = qq;
  if (birthday !== undefined) body.birthday = birthday;
  if (location !== undefined) body.location = location;
  if (Object.keys(body).length === 0) {
    toast(__('profile.no_changes'), 'info');
    profileUpdating = false;
    return;
  }

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
  } finally {
    profileUpdating = false;
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
  container.innerHTML = '<div class="text-muted text-13">' + __('profile.loading') + '</div>';
  try {
    const res = await api('/api/users/me/events', { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      const events = data.events || [];
      if (countEl) countEl.textContent = `(${events.length})`;
      if (events.length === 0) {
        container.innerHTML = '<div class="text-muted text-13">' + __('profile.no_events') + '</div>';
        return;
      }
      const now = new Date();
      container.innerHTML = events.map(e => {
        const evtTime = e.eventTime ? new Date(e.eventTime) : null;
        const cls = evtTime && evtTime < now ? 'text-muted2' : 'text-green';
        const label = evtTime && evtTime < now ? __('events.status_ended') : __('events.status_ongoing_or_not_started');
        return `<div class="me-event-item" onclick="window.showEventDetail&&showEventDetail(${e.id})">
          <span class="mee-time">${fmtDate(e.eventTime)}</span>
          <span class="mee-title">${esc(e.title)}</span>
          <span class="mee-status ${cls}">${label}</span>
        </div>`;
      }).join('');
    }
  } catch (err) { container.innerHTML = '<div class="text-13 text-red">' + __('profile.load_failed') + '</div>'; }
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
      currentUser.customAvatarPath = data.avatarUrl;
      currentUser.avatarVisible = true; // 上传即默认启用显示
      updateUserUI();
      renderAvatarPref();
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
        currentUser.customAvatarPath = null;
        updateUserUI();
        renderAvatarPref();
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
      currentUser.avatarVisible = true; // 切换到 VRChat 头像即默认启用显示
      updateUserUI();
      renderAvatarPref();
      toast(__('profile.avatar_switched_vrc'), 'success');
    }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('profile.switch_failed') + ': ' + err.message, 'error'); }
}

// ==================== 头像显示设置（是否显示 + 显示哪种） §11.8.8 ====================
// 与上传/切换头像解耦：本组函数只改「显示开关」与「选用哪种头像」。

function renderAvatarPref() {
  const vis = document.getElementById('meAvatarVisible');
  if (vis) vis.checked = !!currentUser.avatarVisible;

  const custImg = document.getElementById('prefCustomImg');
  const vrcImg = document.getElementById('prefVrcImg');
  if (custImg) custImg.src = currentUser.customAvatarPath || '/api/avatar/default';
  if (vrcImg) vrcImg.src = currentUser.vrchatAvatarUrl || '/api/avatar/default';

  // 状态文案：是否已设置该种头像
  const custStatus = document.getElementById('prefCustomStatus');
  const vrcStatus = document.getElementById('prefVrcStatus');
  if (custStatus) custStatus.textContent = currentUser.customAvatarPath ? __('profile.avatar_opt_available') : __('profile.avatar_opt_unset');
  if (vrcStatus) vrcStatus.textContent = currentUser.vrchatAvatarUrl ? __('profile.avatar_opt_available') : __('profile.avatar_opt_unbound');

  // 选中态高亮（按当前 avatarType）
  const type = currentUser.avatarType || 'none';
  const prefCustom = document.getElementById('prefCustom');
  const prefVrc = document.getElementById('prefVrc');
  if (prefCustom) prefCustom.classList.toggle('active', type === 'custom');
  if (prefVrc) prefVrc.classList.toggle('active', type === 'vrchat');
  // 未设置的种类置灰不可选
  if (prefCustom) prefCustom.classList.toggle('disabled', !currentUser.customAvatarPath);
  if (prefVrc) prefVrc.classList.toggle('disabled', !currentUser.vrchatAvatarUrl);
}

function selectAvatarPref(type) {
  if (type === 'custom' && !currentUser.customAvatarPath) { toast(__('profile.avatar_opt_unset'), 'error'); return; }
  if (type === 'vrchat' && !currentUser.vrchatAvatarUrl) { toast(__('profile.avatar_opt_unbound'), 'error'); return; }
  saveAvatarPref({ avatarType: type });
}

function onAvatarVisibleToggle() {
  const vis = document.getElementById('meAvatarVisible');
  if (!vis) return;
  saveAvatarPref({ avatarVisible: vis.checked ? 1 : 0 });
}

let _avatarPrefSaving = false;
async function saveAvatarPref(patch) {
  if (_avatarPrefSaving) return;
  _avatarPrefSaving = true;
  try {
    const res = await api('/api/users/me/avatar-pref', {
      method: 'POST',
      body: JSON.stringify(patch)
    });
    if (res.ok) {
      const data = await res.json();
      currentUser.avatarType = data.avatarType;
      currentUser.avatarVisible = data.avatarVisible !== false;
      currentUser.avatarUrl = data.avatarUrl;
      updateUserUI();
      renderAvatarPref();
      toast(__('profile.avatar_pref_saved'), 'success');
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('profile.op_failed') + ': ' + err.message, 'error');
    renderAvatarPref(); // 还原 UI（如开关回弹）
  } finally {
    _avatarPrefSaving = false;
  }
}

// ==================== VRChat 绑定（密码验证） ====================
let _vrcBindTemp = null; // 存储2FA临时状态

/**
 * 从服务器回拉一次权威的 VRChat 绑定字段，覆盖到 currentUser。
 *
 * 为什么不能只信绑定接口返回的 user：那份数据是 session 快照，
 * 任何一条路径漏写 session（或上游没返回用户 ID）都会让前端以为绑定成功，
 * 而库里其实是 vrchat_id=NULL —— 表现就是__('auto_profile_1')。
 * 两条绑定路径（有无 2FA）都必须走这里，否则又会出现只修一半的不对称。
 */
async function refreshVrcBindState() {
  try {
    const meRes = await api('/api/users/me/profile', { method: 'GET' });
    if (!meRes.ok) return false;
    const meData = await meRes.json();
    Object.assign(currentUser, {
      vrchatId: meData.vrchatId,
      vrchatName: meData.vrchatName,
      vrchatVerified: meData.vrchatVerified,
      vrchatAvatarUrl: meData.vrchatAvatarUrl,
      avatarType: meData.avatarType,
      avatarUrl: meData.avatarUrl
    });
    return !!meData.vrchatId;
  } catch (e) {
    return false;
  }
}

async function bindVRChatWithPassword() {
  const username = document.getElementById('vrchatInputId')?.value?.trim();
  const password = document.getElementById('vrchatBindPwd')?.value;
  if (!username) { toast(__('profile.enter_vrc_username'), 'error'); return; }
  if (!password) { toast(__('profile.enter_vrc_password'), 'error'); return; }
  
  const btn = document.getElementById('vrcBindBtn');
  if (btn) { btn.disabled = true; btn.textContent = __('profile.verifying'); }
  
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
        showEl('vrcLookupResult');
        document.getElementById('vrcBind2faCode').value = '';
        document.getElementById('vrcBind2faCode').focus();
      } else if (data.success) {
        // 绑定成功（无需2FA）
        if (data.user) Object.assign(currentUser, data.user);
        // 和 2FA 路径保持一致：从服务器回拉一次权威资料。
        // 只信接口返回的 data.user 是不够的 —— 它来自 session 快照，
        // 万一某条路径漏写 session，前端就会以为绑好了、刷新后又提示要绑定。
        await refreshVrcBindState();
        if (!currentUser.vrchatId) {
          toast(__('profile.bind_failed'), 'error');
          renderVRChatBindStatus();
          return;
        }
        // V6.12: 缓存绑定状态，保留登录
        const bindUsername2 = document.getElementById('vrchatInputId')?.value?.trim();
        if (bindUsername2) localStorage.setItem('jingtu_vrc_user', bindUsername2);
        localStorage.setItem('jingtu_vrc_bound', '1');
        updateUserUI();
        renderVRChatBindStatus();
        toast(__('profile.bind_success'), 'success');
        document.getElementById('vrcLookupResult').innerHTML = `<div class="text-green text-13">✅ ${__('profile.bind_success')}</div>`;
        showEl('vrcLookupResult');
        setTimeout(() => { hideEl('vrcLookupResult'); }, 3000);
      }
    } else {
      const err = await res.json();
      toast(errText(err) || __('profile.bind_failed'), 'error');
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
  if (btn) { btn.disabled = true; btn.textContent = __('profile.verifying'); }
  
  try {
    const res = await api('/api/auth/vrchat-bind-verify', {
      method: 'POST',
      body: {
        code,
        method: _vrcBindTemp?.methods?.includes('emailOtp')
          ? 'emailOtp'
          : (_vrcBindTemp?.methods?.includes('totp') ? 'totp' : 'otp'),
        bindToken: _vrcBindTemp?.bindToken
      }
    });
    if (res.ok) {
      const data = await res.json();
      if (data.success) {
        // 绑定成功：合并用户数据，然后重新从服务器获取完整资料（确保数据一致）
        if (data.user) Object.assign(currentUser, data.user);
        await refreshVrcBindState();
        if (!currentUser.vrchatId) {
          toast(__('profile.bind_failed'), 'error');
          renderVRChatBindStatus();
          return;
        }
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
        showEl('vrcLookupResult');
        setTimeout(() => { hideEl('vrcLookupResult'); }, 3000);
      }
    } else {
      const err = await res.json();
      toast(errText(err) || __('profile.verify_failed'), 'error');
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
    statusEl.innerHTML = '<span class="text-13 text-green">✅ ' + __('profile.bound') + '</span>';
    bindForm.classList.add('d-none');
    boundStatus.classList.remove('d-none');

    // 填充绑定账号信息
    document.getElementById('vrchatBoundName').textContent = currentUser.vrchatName || currentUser.vrchatId;
    document.getElementById('vrchatBoundId').textContent = currentUser.vrchatId;
    document.getElementById('vrchatBoundAvatar').src = proxyAvatar(currentUser.vrchatAvatarUrl) || '/assets/group-avatar.svg';
    document.getElementById('vrchatBoundProfileLink').href = `https://vrchat.com/home/user/${currentUser.vrchatId}`;

    if (currentUser.vrchatVerified) {
      document.getElementById('vrchatBoundVerified').classList.remove('d-none');
    } else {
      document.getElementById('vrchatBoundVerified').classList.add('d-none');
    }
  } else {
    // 未绑定
    statusEl.innerHTML = '<span class="text-13 text-muted2">' + __('profile.not_bound') + '</span>';
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
  if (!currentUser) { toast(__('profile.login_first'), 'error'); return; }
  if (!ensureGeolocation()) return;
  // 按钮在 HTML 里是 <button id="updateMyLocationBtn">，并没有 onclick 属性，
  // 原先按 [onclick="updateMyLocation()"] 找永远是 null —— 点击后既不禁用也不
  // 显示__('auto_profile_2')，用户完全没有反馈。
  const btn = document.getElementById('updateMyLocationBtn');
  const status = document.getElementById('profileLocationStatus');
  if (btn) { btn.disabled = true; btn.textContent = __('profile.gps_getting'); }
  if (status) { showEl(status, 'inline'); status.textContent = __('profile.gps_getting'); }
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
      if (status) { status.textContent = `✅ ${__('profile.gps_updated')}（${__('profile.gps_accuracy', {n: Math.round(accuracy)})}）`; showEl(status, 'inline'); }
      setTimeout(() => { hideEl(status); }, 5000);
      toast(__('profile.gps_updated'), 'success');
    }
  } catch (err) {
    // err 可能是 GeolocationPositionError，也可能是 api() 抛出的网络/业务错误。
    // 只有前者才有 code 字段，后者交给通用处理，不要误报成定位失败。
    if (err && typeof err.code === 'number' && err.code >= 1 && err.code <= 3) {
      toastGeoError(err);
    } else if (typeof isApiHandledError === 'function' && isApiHandledError(err)) {
      return;
    } else {
      toast(__('profile.gps_failed') + ': ' + (err?.message || ''), 'error');
    }
    if (status) status.textContent = __('profile.gps_failed_status');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = __('profile.gps_update_btn'); }
  }
}

// ==================== 两步验证（TOTP）设置（S-6，仅超管）====================
let _totpSetupSecret = '';

function renderTotpStatus() {
  const card = document.getElementById('totpSettingsCard');
  const enableBtn = document.getElementById('totpEnableBtn');
  if (!card || !enableBtn) return;
  // 非超管不显示设置卡片（登录验证对所有开启用户生效，设置入口仅超管）
  if (!currentUser || currentUser.role !== 'super_admin') {
    card.classList.add('d-none');
    return;
  }
  card.classList.remove('d-none');
  const statusEl = document.getElementById('totpStatus');
  try {
    api('/api/auth/totp/status', { method: 'GET' }).then(async (res) => {
      const data = await res.json().catch(() => ({}));
      const enabled = !!(res.ok && data.enabled);
      if (enabled) {
        statusEl.textContent = '✅ ' + __('totp.enabled_status');
        enableBtn.classList.add('d-none');
        document.getElementById('totpDisableArea').classList.remove('d-none');
        document.getElementById('totpSetupArea').classList.add('d-none');
      } else {
        statusEl.textContent = __('totp.disabled_status');
        enableBtn.classList.remove('d-none');
        document.getElementById('totpDisableArea').classList.add('d-none');
        document.getElementById('totpSetupArea').classList.add('d-none');
      }
    });
  } catch {}
}

async function enableTotp() {
  const statusEl = document.getElementById('totpStatus');
  try {
    const res = await api('/api/auth/totp/setup', { method: 'POST', body: {} });
    const data = await res.json();
    if (!res.ok || !data.otpauthUri) {
      toast(errText(data) || __('totp.setup_failed'), 'error');
      return;
    }
    _totpSetupSecret = data.secret || '';
    document.getElementById('totpSecretText').textContent = _totpSetupSecret;
    // 二维码沿用站点既有外部 QR 服务（events.js 签到同源策略），失败回退 Google Chart
    const qrUrl = encodeURIComponent(data.otpauthUri);
    const qrImg = document.getElementById('totpQrImg');
    if (qrImg) {
      qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=360x360&data=${qrUrl}`;
      qrImg.onerror = () => { qrImg.onerror = null; qrImg.src = `https://chart.apis.google.com/chart?cht=qr&chs=360x360&chl=${qrUrl}`; };
    }
    document.getElementById('totpStatus').textContent = __('totp.setup_step');
    document.getElementById('totpSetupArea').classList.remove('d-none');
    document.getElementById('totpEnableBtn').classList.add('d-none');
    const codeInput = document.getElementById('totpConfirmCode');
    if (codeInput) { codeInput.value = ''; codeInput.focus(); }
  } catch (err) { if (!isApiHandledError(err)) toast(__('totp.setup_failed') + ': ' + err.message, 'error'); }
}

async function confirmTotp() {
  const code = document.getElementById('totpConfirmCode')?.value?.trim();
  if (!code || code.length !== 6) { toast(__('totp.enter_code'), 'error'); return; }
  const btn = document.getElementById('totpConfirmBtn');
  if (btn) btn.disabled = true;
  try {
    const res = await api('/api/auth/totp/confirm', { method: 'POST', body: { code } });
    const data = await res.json();
    if (res.ok && data.success) {
      toast(__('totp.enabled_ok'), 'success');
      _totpSetupSecret = '';
      renderTotpStatus();
    } else {
      toast(errText(data) || __('totp.wrong_code'), 'error');
    }
  } catch (err) { if (!isApiHandledError(err)) toast(__('totp.setup_failed') + ': ' + err.message, 'error'); }
  finally { if (btn) btn.disabled = false; }
}

function cancelTotpSetup() {
  _totpSetupSecret = '';
  document.getElementById('totpSetupArea').classList.add('d-none');
  document.getElementById('totpStatus').textContent = __('totp.disabled_status');
  document.getElementById('totpEnableBtn').classList.remove('d-none');
}

async function disableTotp() {
  const password = document.getElementById('totpDisablePwd')?.value;
  if (!password) { toast(__('totp.need_password'), 'error'); return; }
  const btn = document.getElementById('totpDisableBtn');
  if (btn) btn.disabled = true;
  try {
    const res = await api('/api/auth/totp/disable', { method: 'POST', body: { password } });
    const data = await res.json();
    if (res.ok && data.success) {
      toast(__('totp.disabled_ok'), 'success');
      document.getElementById('totpDisablePwd').value = '';
      renderTotpStatus();
    } else {
      toast(errText(data) || __('totp.disable_failed'), 'error');
    }
  } catch (err) { if (!isApiHandledError(err)) toast(__('totp.disable_failed') + ': ' + err.message, 'error'); }
  finally { if (btn) btn.disabled = false; }
}

async function changePassword() {
  const oldPwd = document.getElementById('meCurPwd')?.value;
  const newPwd = document.getElementById('meNewPwd')?.value;
  const newPwd2 = document.getElementById('meNewPwd2')?.value;
  if (!oldPwd || !newPwd) { toast(__('profile.enter_passwords'), 'error'); return; }
  if (newPwd !== newPwd2) { toast(__('profile.passwords_not_match'), 'error'); return; }
  try {
    const res = await api('/api/auth/change-password', {
      method: 'POST',
      body: { oldPassword: oldPwd, newPassword: newPwd }
    });
    if (res.ok) {
      toast(__('profile.pwd_changed'), 'success');
      setTimeout(() => logout(), 2000);
    }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('profile.change_failed') + '：' + err.message, 'error'); }
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
