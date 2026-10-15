// ==================== 个人中心模块 ====================
let profileLoading = false;

// ==================== 个人中心侧边导航（tab-me） ====================
let meSidebarBound = false;
function initMeSidebar() {
  const nav = document.querySelector('.me-sidenav');
  if (!nav) return;
  if (!meSidebarBound) {
    meSidebarBound = true;
    nav.addEventListener('click', (e) => {
      const item = e.target.closest('.me-sidenav-item');
      if (!item) return;
      const id = item.getAttribute('data-me-target');
      if (!id) return;
      nav.querySelectorAll('.me-sidenav-item').forEach(b => b.classList.toggle('active', b === item));
      document.querySelectorAll('#tab-me .me-content > .card').forEach(sec => {
        sec.classList.toggle('me-sec-active', sec.id === id);
      });
      // 移动端横向导航：切换后滚到对应区块，避免内容区意外停留上方
      const target = document.getElementById(id);
      if (target && window.innerWidth <= 768) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
  // 每次进入 tab-me 都应用当前高亮项（默认第一个区块）
  const active = nav.querySelector('.me-sidenav-item.active');
  const id = active ? active.getAttribute('data-me-target') : 'avatarPrefCard';
  document.querySelectorAll('#tab-me .me-content > .card').forEach(sec => {
    sec.classList.toggle('me-sec-active', sec.id === id);
  });
}

async function showProfile() {
  if (!currentUser || profileLoading) return;
  profileLoading = true;
  try {
    initMeSidebar();
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
        preferences: data.preferences,
        selfTags: Array.isArray(data.selfTags) ? data.selfTags : [],
        tagsVisible: !!data.tagsVisible
      });
      updateUserUI();
      // 填充表单（M10: DOM 直取统一空值守卫，元素未挂载时跳过赋值）
      const displayNameEl = document.getElementById('meDisplayName'); if (displayNameEl) displayNameEl.value = currentUser.displayName || '';
      const loginIdEl = document.getElementById('meLoginId'); if (loginIdEl) loginIdEl.value = currentUser.loginId || '';
      const qqEl = document.getElementById('meQQ'); if (qqEl) qqEl.value = currentUser.qq || '';
      const birthdayEl = document.getElementById('meBirthday'); if (birthdayEl) birthdayEl.value = currentUser.birthday ? currentUser.birthday.substring(0, 10) : '';
      const locationEl = document.getElementById('meLocation'); if (locationEl) locationEl.value = currentUser.location || '';
      const locationVisibleEl = document.getElementById('meLocationVisible'); if (locationVisibleEl) locationVisibleEl.checked = !!currentUser.locationVisible;
      const bioEl = document.getElementById('meBio'); if (bioEl) bioEl.value = currentUser.bio || '';
      const mottoEl = document.getElementById('meMotto'); if (mottoEl) mottoEl.value = currentUser.motto || '';
      // 渲染 VRChat 绑定状态
      renderVRChatBindStatus();
      // S-6: 渲染两步验证（TOTP）设置状态（仅超管显示设置卡片）
      renderTotpStatus();
      // 渲染头像显示设置（§11.8.8）
      renderAvatarPref();
      // 渲染自定义标签（新增）
      renderSelfTags();
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

// ==================== 自定义标签 ====================
function renderSelfTags() {
  const list = document.getElementById('meTagsList');
  if (list) {
    const tags = currentUser.selfTags || [];
    if (tags.length === 0) {
      list.innerHTML = '<div class="text-muted2 text-12">' + __('profile.tags_empty') + '</div>';
    } else {
      list.innerHTML = tags.map((t, i) =>
        `<span class="tag tag-accent">${esc(t)}<button type="button" class="tag-x" data-i="${i}" aria-label="${__('profile.tag_remove')}">×</button></span>`
      ).join('');
    }
  }
  const vis = document.getElementById('meTagsVisible');
  if (vis) vis.checked = !!currentUser.tagsVisible;
}

let _tagsSaving = false;
async function saveSelfTags({ selfTags, tagsVisible }) {
  if (_tagsSaving) return;
  _tagsSaving = true;
  try {
    const res = await api('/api/users/me/profile', {
      method: 'PUT',
      body: { selfTags, tagsVisible }
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast(errText(err) || __('profile.tags_save_failed'), 'error');
      renderSelfTags(); // 回滚 UI
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (Array.isArray(data.selfTags)) currentUser.selfTags = data.selfTags;
    else if (selfTags !== undefined) currentUser.selfTags = selfTags;
    if (tagsVisible !== undefined) currentUser.tagsVisible = !!tagsVisible;
    renderSelfTags();
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('profile.tags_save_failed') + ': ' + err.message, 'error');
    renderSelfTags();
  } finally {
    _tagsSaving = false;
  }
}

function addSelfTag() {
  const input = document.getElementById('meTagInput');
  const raw = input?.value?.trim();
  if (!input || !raw) return;
  const tags = Array.isArray(currentUser.selfTags) ? currentUser.selfTags.slice() : [];
  if (tags.length >= 8) { toast(__('profile.tags_limit'), 'error'); return; }
  if (raw.length > 20) { toast(__('profile.tags_too_long'), 'error'); return; }
  if (tags.includes(raw)) { toast(__('profile.tags_duplicate'), 'error'); return; }
  input.value = '';
  saveSelfTags({ selfTags: tags.concat([raw]) });
}

function removeSelfTag(i) {
  const tags = Array.isArray(currentUser.selfTags) ? currentUser.selfTags.slice() : [];
  if (i < 0 || i >= tags.length) return;
  tags.splice(i, 1);
  saveSelfTags({ selfTags: tags });
}

function onTagsVisibleToggle() {
  const vis = document.getElementById('meTagsVisible');
  if (!vis) return;
  saveSelfTags({ tagsVisible: vis.checked });
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
        return `<div class="me-event-item" data-action="profile-open-event" data-evt-id="${e.id}">
          <span class="mee-time">${fmtDate(e.eventTime)}</span>
          <span class="mee-title">${esc(e.title)}</span>
          <span class="mee-status ${cls}">${label}</span>
        </div>`;
      }).join('');
    }
  } catch (err) { container.innerHTML = '<div class="text-13 text-red">' + __('profile.load_failed') + '</div>'; }
}

// ==================== 头像上传/移除/切换 ====================
// 上传进行中标志：防连点并发（同一用户一次只允许一个上传任务，
// 历史 BUG：重复点击触发 2+ 并发上传，后端 cleanup 互相误删刚生成的主图 → 头像 404）
let _avatarUploadBusy = false;

async function uploadAvatar(file) {
  if (!file) return;
  if (_avatarUploadBusy) return; // 进行中直接忽略，防止并发
  _avatarUploadBusy = true;
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
      if (typeof syncAvatarCache === 'function') syncAvatarCache(); // 同步登录页头像缓存
      toast(__('profile.avatar_updated'), 'success');
    }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('profile.upload_failed') + ': ' + err.message, 'error'); }
    finally { _avatarUploadBusy = false; } // 无论成败释放锁
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
        if (typeof removeCachedAvatar === 'function') removeCachedAvatar(currentUser.loginId); // 移除登录页头像缓存
        toast(__('profile.avatar_removed'), 'info');
      }
    } catch (err) { if (isApiHandledError(err)) return; toast(__('profile.op_failed') + ': ' + err.message, 'error'); }
  });
}

async function switchToVRchatAvatar() {
  if (!currentUser.vrchatId) { toast(__('profile.vrc_not_bound'), 'error'); return; }
  try {
    const res = await api('/api/users/me/avatar-vrchat', { method: 'POST', timeout: 20000 });
    if (res.ok) {
      const data = await res.json();
      currentUser.avatarUrl = data.avatarUrl;
      currentUser.avatarType = 'vrchat';
      currentUser.avatarVisible = true; // 切换到 VRChat 头像即默认启用显示
      updateUserUI();
      renderAvatarPref();
      if (typeof syncAvatarCache === 'function') syncAvatarCache(); // 同步登录页头像缓存
      toast(__('profile.avatar_switched_vrc'), 'success');
    }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('profile.switch_failed') + ': ' + err.message, 'error'); }
}

// ==================== 头像显示设置（是否显示 + 显示哪种） §11.8.8 ====================
// 与上传/切换头像解耦：本组函数只改「显示开关」与「选用哪种头像」。

// 头像来源预览图失败回落默认头像（原内联 onerror="this.src='/api/avatar/default'" 被 CSP 拦截，
// 改由 JS 属性绑定；已回落后清掉自身处理器，避免默认头像自身失败时无限循环）
// 命名避开 auth.js 的同名全局函数 bindAvatarDefaultFallback（后者先加载，同名覆盖会静默失效）
function bindAvatarPrefFallback(img) {
  if (!img || img.dataset.avatarDefaultFb) return;
  img.dataset.avatarDefaultFb = '1';
  img.onerror = function () {
    if (img.getAttribute('src') === '/api/avatar/default') return;
    img.onerror = null;
    img.src = '/api/avatar/default';
  };
}

function renderAvatarPref() {
  const vis = document.getElementById('meAvatarVisible');
  if (vis) vis.checked = !!currentUser.avatarVisible;

  const custImg = document.getElementById('prefCustomImg');
  const vrcImg = document.getElementById('prefVrcImg');
  if (custImg) { bindAvatarPrefFallback(custImg); custImg.src = currentUser.customAvatarPath || '/api/avatar/default'; }
  if (vrcImg) { bindAvatarPrefFallback(vrcImg); vrcImg.src = currentUser.vrchatAvatarUrl || '/api/avatar/default'; }

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

// 头像来源选择 / 我的事件列表（原内联 onclick 迁移到委托）
document.addEventListener('click', function (e) {
  const item = e.target.closest('.avatar-pref-item');
  if (item) {
    const type = item.dataset.type;
    if (type) selectAvatarPref(type);
    return;
  }
  const evtItem = e.target.closest('[data-action="profile-open-event"]');
  if (evtItem) {
    const id = evtItem.getAttribute('data-evt-id');
    if (id && typeof window.showEventDetail === 'function') window.showEventDetail(Number(id));
  }
});

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
      if (typeof syncAvatarCache === 'function') syncAvatarCache(); // 同步登录页头像缓存
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
let _vrcBindResendCd = null; // 重发验证码倒计时定时器
// 本地记住的 VRChat 账号密码（重新登录免输入，仅勾选「记住」时保存）
const VRC_CREDS_KEY = 'jingtu_vrc_creds';
let _vrcReloginActive = false; // 重新登录流程标记（失败时回落显示绑定表单）

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
      body: { username, password },
      // P3 打磨：VRChat 上游在海外、国内网络慢时单次可达 30s+，默认 10s 会先 abort
      // 报"请求超时"，用户以为没反应反复点击。放宽到 90s 覆盖上游最坏时长。
      timeout: 90000
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
        // preventScroll：2FA 区紧跟在按钮下方展开，默认 focus 会把页面滚到输入框处（"点击窜到下面"），
        // 焦点照常给到输入框但页面滚动位置保持不变。
        document.getElementById('vrcBind2faCode').focus({ preventScroll: true });
        startVrcBindResendCountdown();
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
        _vrcReloginActive = false;
        saveVrcCredsIfChecked();
        resetVrcBindResend();
        updateUserUI();
        if (typeof syncAvatarCache === 'function') syncAvatarCache(); // 同步登录页头像缓存
        renderVRChatBindStatus();
        toast(__('profile.bind_success'), 'success');
        document.getElementById('vrcLookupResult').innerHTML = `<div class="text-green text-13">✅ ${__('profile.bind_success')}</div>`;
        showEl('vrcLookupResult');
        setTimeout(() => { hideEl('vrcLookupResult'); }, 3000);
      }
    } else {
      const err = await res.json();
      toast(errText(err) || __('profile.bind_failed'), 'error');
      // 重新登录流程失败（密码错误/账号失效等）→ 回落显示绑定表单，便于用户重输密码
      if (_vrcReloginActive) {
        showVrcReloginForm();
      }
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
      },
      // P3 打磨：2FA 验证 / 拿资料都打 VRChat 上游，放宽超时避免 10s 误杀
      timeout: 90000
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
        _vrcReloginActive = false;
        saveVrcCredsIfChecked();
        document.getElementById('vrcBind2fa').classList.add('d-none');
        document.getElementById('vrcBind2faCode').value = '';
        _vrcBindTemp = null;
        resetVrcBindResend();
        updateUserUI();
        if (typeof syncAvatarCache === 'function') syncAvatarCache(); // 同步登录页头像缓存
        renderVRChatBindStatus();
        toast(__('profile.bind_success'), 'success');
        document.getElementById('vrcLookupResult').innerHTML = `<div class="text-green text-13">✅ ${__('profile.bind_success')}</div>`;
        showEl('vrcLookupResult');
        setTimeout(() => { hideEl('vrcLookupResult'); }, 3000);
      }
    } else {
      const err = await res.json();
      toast(errText(err) || __('profile.verify_failed'), 'error');
      if (_vrcReloginActive) showVrcReloginForm();
    }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('profile.verify_failed_msg') + ': ' + err.message, 'error'); if (_vrcReloginActive) showVrcReloginForm(); }
  finally {
    if (btn) { btn.disabled = false; btn.textContent = __('profile.send_code'); }
  }
}

// 重发绑定验证码：复用现有 bindToken 重新触发邮件验证码（绑定不设时间限制）
async function resendVrcBindCode() {
  const token = _vrcBindTemp?.bindToken;
  if (!token) { toast(__('profile.enter_code'), 'error'); return; }

  const btn = document.getElementById('vrcBindResendBtn');
  if (btn) { btn.disabled = true; btn.textContent = __('auth.sending'); }

  try {
    const res = await api('/api/auth/vrchat-bind-verify', {
      method: 'POST',
      body: { bindToken: token, resend: true },
      timeout: 90000
    });
    if (res.ok) {
      const data = await res.json();
      if (data.bindToken) _vrcBindTemp.bindToken = data.bindToken;
      toast(data.message || __('profile.code_resent'), 'success');
      document.getElementById('vrcBind2faCode').value = '';
      document.getElementById('vrcBind2faCode').focus({ preventScroll: true });
    } else {
      const err = await res.json();
      if (err.expired || err.code === '2FA_LOCKED') {
        // 会话已失效 → 退回第一步重新输入账号密码
        _vrcBindTemp = null;
        document.getElementById('vrcBind2fa').classList.add('d-none');
      }
      toast(errText(err) || __('profile.verify_failed'), 'error');
    }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('profile.verify_failed_msg') + ': ' + err.message, 'error'); }
  finally {
    startVrcBindResendCountdown();
  }
}

// 重发验证码 5 秒冷却：绑定不做长时间限制，最多5秒防连点
function startVrcBindResendCountdown() {
  const btn = document.getElementById('vrcBindResendBtn');
  if (!btn) return;
  if (_vrcBindResendCd) { clearTimeout(_vrcBindResendCd); _vrcBindResendCd = null; }
  let seconds = 5;
  btn.disabled = true;
  btn.textContent = __('profile.resend_cooldown', { n: seconds });
  const update = () => {
    if (seconds <= 0) {
      btn.disabled = false;
      btn.textContent = __('profile.resend_code');
      _vrcBindResendCd = null;
      return;
    }
    btn.textContent = __('profile.resend_cooldown', { n: seconds });
    seconds--;
    _vrcBindResendCd = setTimeout(update, 1000);
  };
  update();
}

// 清理重发状态（绑定成功后调用）
function resetVrcBindResend() {
  if (_vrcBindResendCd) { clearTimeout(_vrcBindResendCd); _vrcBindResendCd = null; }
  const btn = document.getElementById('vrcBindResendBtn');
  if (btn) { btn.disabled = true; btn.textContent = __('profile.resend_code'); }
}

// 绑定成功时按「记住账号密码」勾选状态保存/清除本地凭据
function saveVrcCredsIfChecked() {
  const cb = document.getElementById('rememberVrcCreds');
  const username = document.getElementById('vrchatInputId')?.value?.trim();
  const password = document.getElementById('vrchatBindPwd')?.value;
  try {
    if (cb && cb.checked && username && password) {
      localStorage.setItem(VRC_CREDS_KEY, JSON.stringify({ username, password }));
    } else {
      localStorage.removeItem(VRC_CREDS_KEY);
    }
  } catch (e) { /* localStorage 不可用时忽略 */ }
}

// 重新登录失败回落：显示绑定表单，预填记住的用户名，聚焦密码框
function showVrcReloginForm() {
  const bindForm = document.getElementById('vrchatBindForm');
  const boundStatus = document.getElementById('vrchatBoundStatus');
  if (bindForm) bindForm.classList.remove('d-none');
  if (boundStatus) boundStatus.classList.add('d-none');
  const idInput = document.getElementById('vrchatInputId');
  const savedUser = (() => { try { const c = JSON.parse(localStorage.getItem(VRC_CREDS_KEY) || 'null'); return c && c.username; } catch (e) { return null; } })();
  if (idInput && !idInput.value) idInput.value = savedUser || localStorage.getItem('jingtu_vrc_user') || '';
  const pwdInput = document.getElementById('vrchatBindPwd');
  if (pwdInput) { pwdInput.value = ''; pwdInput.focus({ preventScroll: true }); }
  toast(__('profile.vrc_relogin_enter_pwd'), 'info');
}

// 重新登录 VRChat：已记住账号密码则直接发送验证码并弹出验证码输入框；未记住则显示表单预填用户名
async function reloginVRChat() {
  let creds = null;
  try { creds = JSON.parse(localStorage.getItem(VRC_CREDS_KEY) || 'null'); } catch (e) { creds = null; }
  const idInput = document.getElementById('vrchatInputId');
  const pwdInput = document.getElementById('vrchatBindPwd');
  const bindForm = document.getElementById('vrchatBindForm');
  const boundStatus = document.getElementById('vrchatBoundStatus');
  const bind2fa = document.getElementById('vrcBind2fa');
  if (idInput && creds && creds.username) idInput.value = creds.username;
  if (pwdInput && creds && creds.password) pwdInput.value = creds.password;

  if (creds && creds.username && creds.password) {
    // 有记住的账号密码 → 隐藏已绑定卡片，自动发送验证码，随后显示验证码输入框
    _vrcReloginActive = true;
    if (bindForm) bindForm.classList.add('d-none');
    if (boundStatus) boundStatus.classList.add('d-none');
    if (bind2fa) bind2fa.classList.add('d-none');
    await bindVRChatWithPassword();
  } else {
    // 未记住密码 → 显示绑定表单预填用户名，仅需输入密码
    _vrcReloginActive = true;
    showVrcReloginForm();
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
        currentUser.vrchatAvatarUrl = null;
        // 服务端解绑时若正在展示 VRChat 头像会回落为 none，前端同步，避免残留旧头像
        if (currentUser.avatarType === 'vrchat') {
          currentUser.avatarType = 'none';
          currentUser.avatarUrl = null;
        }
        // V6.9: 清除浏览器缓存的 VRChat 绑定状态和用户名
        localStorage.removeItem('jingtu_vrc_user');
        localStorage.removeItem('jingtu_vrc_bound');
        localStorage.removeItem(VRC_CREDS_KEY);
        _vrcReloginActive = false;
        updateUserUI();
        renderAvatarPref();
        if (typeof syncAvatarCache === 'function') syncAvatarCache(); // 同步登录页头像缓存
        renderVRChatBindStatus();
        toast(__('profile.vrc_unbound'), 'info');
      }
    } catch (err) { if (isApiHandledError(err)) return; toast(__('profile.unbind_failed') + ': ' + err.message, 'error'); }
  });
}

// 重新同步：从本站服务器重新加载已同步的缓存快照（模型 / 地图 / 好友），不回源 VRChat 官方
async function resyncVrcLocal() {
  const vs = window.vrcSync;
  if (vs && typeof vs.showTask === 'function') vs.showTask(__('profile.vrc_resync_running'));
  try {
    // 并行读取本地库快照（不带 refresh=1，纯本地，零回源官方）
    await Promise.all([
      apiJson('/api/vrc-favorites/groups?n=100', { timeout: 20000 }),
      apiJson('/api/vrc-favorites/items?type=world&n=100', { timeout: 20000 }),
      apiJson('/api/vrc-favorites/items?type=avatar&n=100', { timeout: 20000 }),
      apiJson('/api/vrc-favorites/items?type=friend&n=200', { timeout: 20000 }),
      apiJson('/api/collections', { timeout: 20000 })
    ]);
    // 通知收藏页用最新本地快照重渲染
    try { window.dispatchEvent(new CustomEvent('vrcfav:synced', { detail: {} })); } catch (e) {}
    if (vs && typeof vs.taskDone === 'function') vs.taskDone(__('profile.vrc_resync_done'), { keepMs: 4000 });
  } catch (e) {
    if (vs && typeof vs.taskDone === 'function') vs.taskDone(__('profile.vrc_resync_failed'), { err: true });
  }
}

// 拉取同步：从 VRChat 官方拉取自己最新的收藏地图 / 模型 / 好友
function pullVrcOfficial() {
  const vs = window.vrcSync;
  if (!vs || typeof vs.startFavSync !== 'function') {
    toast(__('vrcsync.start_failed'), 'error');
    return;
  }
  vs.startFavSync({ startMsg: __('profile.vrc_pull_running') });
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

    // 填充绑定账号信息（J6: 各处 getElementById 判空后再赋值，页面结构不完整也不抛 TypeError）
    const boundNameEl = document.getElementById('vrchatBoundName'); if (boundNameEl) boundNameEl.textContent = currentUser.vrchatName || currentUser.vrchatId;
    const boundIdEl = document.getElementById('vrchatBoundId'); if (boundIdEl) boundIdEl.textContent = currentUser.vrchatId;
    const boundAvatarEl = document.getElementById('vrchatBoundAvatar'); if (boundAvatarEl) boundAvatarEl.src = proxyAvatar(currentUser.vrchatAvatarUrl) || '/assets/group-avatar.svg';
    const boundProfileLinkEl = document.getElementById('vrchatBoundProfileLink'); if (boundProfileLinkEl) boundProfileLinkEl.href = `https://vrchat.com/home/user/${currentUser.vrchatId}`;

    const boundVerifiedEl = document.getElementById('vrchatBoundVerified');
    if (boundVerifiedEl) {
      if (currentUser.vrchatVerified) {
        boundVerifiedEl.classList.remove('d-none');
      } else {
        boundVerifiedEl.classList.add('d-none');
      }
    }

    // 同步按钮原生 title 悬浮详情：原生 title 不走 data-i18n 引擎，用 __() 覆写（随语言切换重渲染刷新）
    const resyncBtnEl = document.getElementById('vrcResyncLocalBtn');
    if (resyncBtnEl) resyncBtnEl.title = __('profile.vrc_resync_tip');
    const pullBtnEl = document.getElementById('vrcPullSyncBtn');
    if (pullBtnEl) pullBtnEl.title = __('profile.vrc_pull_sync_tip');
  } else {
    // 未绑定
    statusEl.innerHTML = '<span class="text-13 text-muted2">' + __('profile.not_bound') + '</span>';
    bindForm.classList.remove('d-none');
    boundStatus.classList.add('d-none');
    // 本地已记住凭据 → 默认勾选「记住账号密码」，提示可快捷重新登录
    const rememberCb = document.getElementById('rememberVrcCreds');
    if (rememberCb) {
      let hasCreds = false;
      try { const c = JSON.parse(localStorage.getItem(VRC_CREDS_KEY) || 'null'); hasCreds = !!(c && c.username && c.password); } catch (e) {}
      rememberCb.checked = hasCreds;
    }
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
    if (codeInput) { codeInput.value = ''; codeInput.focus({ preventScroll: true }); }
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

// 侧边导航自启动：profile.js 为懒加载模块，加载即代表进入个人中心页面结构已就绪，
// 顶层调用一次（hoisting 保证 initMeSidebar 已定义），后续 showProfile 每次进入再矫正高亮。
if (typeof initMeSidebar === 'function') { try { initMeSidebar(); } catch (e) {} }
