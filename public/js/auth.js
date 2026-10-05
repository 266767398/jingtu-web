// ==================== 认证系统 ====================
async function loadMe() {
  try {
    const res = await api('/api/users/me/profile');
    if (res.ok) { 
      const data = await res.json(); 
      currentUser = data.user || data; 
      return currentUser; 
    }
  } catch {}
  currentUser = null; 
  return null;
}

async function login(loginId, password, remember = false) {
  const loginPwdBtn = document.getElementById('loginPwdBtn');
  const loginLoading = document.getElementById('loginLoading');
  if (loginPwdBtn) { loginPwdBtn.disabled = true; loginPwdBtn.textContent = __('auth.logging_in'); }
  try {
    const res = await api('/api/auth/login', { 
      method: 'POST', 
      body: { loginId, password, remember }
    });
    const data = await res.json();
    if (res.ok && data.success) {
      // 登录接口返回的 user（来自 sessionUser）仅含基础字段，缺少 email / 注册时间 /
      // 最后登录等资料字段。这里用 /me/profile 的完整档案覆盖，确保个人中心账号信息卡片
      // 能正确显示，而非全部显示 "-"。
      currentUser = data.user;
      try { await loadMe(); } catch (e) { /* 失败则保留 sessionUser 的基础字段 */ }
      await ensureCsrf();
      if (remember) {
        localStorage.setItem('jingtu_remember', JSON.stringify({ loginId }));
      } else localStorage.removeItem('jingtu_remember');
      sessionStorage.removeItem('manual_logout');
      if (loginLoading) loginLoading.style.display = 'none';
      toast(__('auth.login_ok'), 'success'); 
      showApp(); 
      return true;
    } else if (data.need2fa) {
      // S-6: 账号已开启两步验证——密码已验证，进入验证码输入步骤
      if (loginLoading) loginLoading.style.display = 'none';
      showLogin2fa(data);
      return false;
    } else { 
      if (loginLoading) loginLoading.style.display = 'none';
      toast(errText(data) || __('auth.login_failed'), 'error'); 
      return false; 
    }
  } catch (err) {
    if (loginLoading) loginLoading.style.display = 'none';
    if (!isApiHandledError(err)) {
      toast(__('auth.network_error') + ': ' + err.message, 'error');
    }
    return false;
  } finally {
    if (loginPwdBtn) { loginPwdBtn.disabled = false; loginPwdBtn.textContent = __('auth.login_btn'); }
  }
}

async function logout(redirect = true, silent = false) {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  disconnectWebSocket();
  if (typeof stopGroupPolling === 'function') stopGroupPolling();
  currentUser = null; csrfToken = null; membersCache = []; albumPhotoList = [];
  signedEvents.clear(); albumScrollLock.clear();
  clearLoginFlag();
  localStorage.removeItem('jingtu_remember');
  sessionStorage.removeItem('manual_logout');
  resetVrcLoginState();
  // 登出时必须显式收起用户下拉菜单：打开菜单时在 document 上挂了 _handleUserMenuKeydown，
  // 不收起就不会解绑，登录遮罩弹出后方向键/Esc 仍会把焦点送进被遮住的菜单项里。
  if (typeof hideUserMenu === 'function') hideUserMenu();
  closeAllModals();
  if (!silent) toast(__('auth.logged_out'), 'info');
  if (redirect) {
    document.getElementById('loginModeInit')?.classList.add('d-none');
    showLogin();
  }
}

async function checkAutoLogin() {
  try {
    if (sessionStorage.getItem('manual_logout') === 'true') { sessionStorage.removeItem('manual_logout'); return false; }
    // 登录标记 Cookie 不存在 → 本浏览器从未登录过。connect.sid 是 HttpOnly 前端读不到，
    // 探测会话是唯一手段，但冷启动无会话时 /me/profile 必 401（控制台红字噪音），
    // 用标记跳过这次必失败的探测；有标记的浏览器仍会真实探测以区分会话有效/过期。
    const user = hasLoginFlag() ? await loadMe() : null;
    if (user) { showApp(); return true; }
    const saved = localStorage.getItem('jingtu_remember');
    if (saved) {
      try {
        const { loginId } = JSON.parse(saved);
        if (loginId) {
          const loginIdInput = document.getElementById('loginId');
          if (loginIdInput) { loginIdInput.value = loginId; previewLoginAvatar(loginId); }
        }
      } catch { localStorage.removeItem('jingtu_remember'); }
    }
  } catch {}
  return false;
}

// ==================== 登录标记 Cookie ====================
// connect.sid 是 HttpOnly，前端无法用 document.cookie 判断会话是否存在，
// 导致 checkAutoLogin 每次冷启动都白打一次必 401 的 /me/profile 探测请求。
// 这里用普通 Cookie 记录"本浏览器登录过"，随登录 showApp() 写入、logout() 清除，
// 与 connect.sid 生命周期天然同步（用户清 Cookie 时一起消失）。
// 会话有效性永远由 loadMe() 的响应决定；跳过探测只会让冷启动直达登录页，
// 不会误伤合法会话（有标记才探测）。过期会话仍会探测到 401 并走登录页兜底。
function setLoginFlag() {
  try {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `jingtu_login=1; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax${secure}`;
  } catch {}
}
function clearLoginFlag() {
  try {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `jingtu_login=; path=/; max-age=0; SameSite=Lax${secure}`;
  } catch {}
}
function hasLoginFlag() {
  return document.cookie.split('; ').some(part => part.startsWith('jingtu_login='));
}

function showLogin() { 
  const loginLoading = document.getElementById('loginLoading');
  if (loginLoading) loginLoading.style.display = 'none';
  
  _loadingCount = 0;
  const bar = (document.getElementById('globalLoadBar') || {style:{}});
  if (bar) { bar.style.opacity = '0'; bar.style.width = '0'; }
  
  const overlay = document.getElementById('loginOverlay'); 
  if (overlay) {
    overlay.style.display = 'flex'; 
    overlay.style.animation = 'none';
    void overlay.offsetHeight;
    overlay.style.animation = 'overlayFadeIn 0.4s ease';
  }
  document.getElementById('loginModeInit')?.classList.add('d-none');
  updateLoginTabsVisibility();
  switchLoginMode('password');
  // 读取公开配置，按需隐藏「找回密码」入口（未登录也能生效）
  loadSocialLinks();
}

// V6.15: 两个登录标签始终可见（本地账号 + VRChat），初始化标签默认隐藏
function updateLoginTabsVisibility() {
  // 两个标签始终显示，不隐藏
  document.getElementById('loginModeVrc')?.classList.remove('d-none');
  document.getElementById('loginModePassword')?.classList.remove('d-none');
  // 初始化标签——有用户时永远隐藏。仅在 main.js init() 无用户检测时临时显示
  document.getElementById('loginModeInit')?.classList.add('d-none');
  // 标签栏始终显示
  const tabBar = document.querySelector('.login-tab-bar');
  if (tabBar) tabBar.style.display = 'flex';
  // 预填 VRChat 缓存用户名
  const cachedVrcUser = localStorage.getItem('jingtu_vrc_user');
  if (cachedVrcUser) {
    const vrcInput = document.getElementById('loginVrcUser');
    if (vrcInput) vrcInput.value = cachedVrcUser;
  }
}
function showApp() {
  const loginLoading = document.getElementById('loginLoading');
  if (loginLoading) loginLoading.style.display = 'none';
  
  const overlay = document.getElementById('loginOverlay');
  if (overlay) {
    overlay.style.animation = 'overlayFadeIn 0.3s ease reverse';
    setTimeout(() => { overlay.style.display = 'none'; overlay.style.animation = ''; }, 320);
  }
  stopLoginParticles();
  
  _loadingCount = 0;
  const bar = (document.getElementById('globalLoadBar') || {style:{}});
  if (bar) { bar.style.opacity = '0'; bar.style.width = '0'; }

  try {
    setLoginFlag();
    document.getElementById('appHeader')?.classList.remove('d-none');
    document.getElementById('heroSection')?.classList.remove('d-none');
    document.getElementById('mainContainer')?.classList.remove('d-none');
    document.getElementById('appFooter')?.classList.remove('d-none');
    updateUserUI();
    // 首页公开内容已在 init() 中提前加载，登录态恢复后只需更新用户相关 UI，
    // 避免重复请求和首屏闪烁。
    wsReconnectAttempts = 0;
    wsLongBackoff = false;
    connectWebSocket();
    if (typeof loadMyLikes === 'function') loadMyLikes();
    loadSocialLinks();
    if (typeof initMobileTabMenu === 'function') initMobileTabMenu();
    if (typeof initFormValidation === 'function') initFormValidation();
    // 签到 / 成就：必须等登录完成才初始化。
    // 这两个模块自带 DOMContentLoaded 自启，但那时用户还在登录页，
    // 既会往隐藏的 #tab-home 里塞卡片，又会白打一次必然 401 的请求。
    if (typeof checkinModule !== 'undefined') checkinModule.init();
    if (typeof achievementsModule !== 'undefined') achievementsModule.init();
  } catch {}
}

async function loadSocialLinks() {
  try {
    const res = await api('/api/social-links', { method: 'GET' });
    if (res.ok) {
      const links = await res.json();
      const vrcLink = document.getElementById('footerVrcGroupLink');
      const kookLink = document.getElementById('footerKookLink');
      const oopzLink = document.getElementById('footerOopzLink');
      if (vrcLink && links.vrcGroupUrl) {
        vrcLink.href = links.vrcGroupUrl;
        vrcLink.removeAttribute('onclick');
      }
      if (kookLink && links.kookUrl) {
        kookLink.href = links.kookUrl;
        kookLink.removeAttribute('onclick');
        kookLink.target = '_blank';
        kookLink.rel = 'noopener';
      }
      if (oopzLink && links.oopzUrl) {
        oopzLink.href = links.oopzUrl;
        oopzLink.removeAttribute('onclick');
        oopzLink.target = '_blank';
        oopzLink.rel = 'noopener';
      }
      const forgotLink = document.getElementById('forgotPwdLink');
      if (forgotLink) forgotLink.style.display = (links.hideForgotPassword === '1') ? 'none' : '';
    }
  } catch (e) { }
}
async function doLogout() { await logout(true); }

// ==================== 登录辅助函数 ====================
function switchLoginMode(mode) {
  const modeIdMap = { password: 'Password', register: 'Register', vrchat: 'Vrc', init: 'Init' };
  const modeId = 'loginMode' + modeIdMap[mode];
  document.querySelectorAll('.login-tab-btn').forEach(btn => btn.classList.toggle('active', btn.id === modeId));
  const fieldMap = { password: 'loginPasswordFields', register: 'loginRegisterFields', vrchat: 'loginVrcFields', init: 'loginInitFields' };
  Object.entries(fieldMap).forEach(([key, id]) => document.getElementById(id)?.classList.toggle('d-none', key !== mode));
  // 移动滑块指示器
  const slider = document.getElementById('loginTabSlider');
  const activeBtn = document.querySelector('.login-tab-btn.active');
  if (slider && activeBtn) {
    slider.style.width = activeBtn.offsetWidth + 'px';
    slider.style.left = activeBtn.offsetLeft + 'px';
  }
  // 切换离开 VRChat 标签时重置验证码状态
  if (mode !== 'vrchat' && typeof resetVrcLoginState === 'function') resetVrcLoginState();
  // 切换标签时清理 2FA 验证码状态（留在密码 tab 也不恢复旧验证码）
  if (typeof resetLogin2fa === 'function') resetLogin2fa();
}

async function doPasswordLogin() {
  const loginId = document.getElementById('loginId')?.value;
  const password = document.getElementById('loginPassword')?.value;
  const remember = document.getElementById('rememberLogin')?.checked || false;
  if (!loginId || !password) { toast(__('auth.enter_account_pwd'), 'error'); return; }
  const ok = await login(loginId, password, remember);
  if (ok) {
    if (currentUser.vrchatId && currentUser.vrchatName) {
      localStorage.setItem('jingtu_vrc_bound', '1');
    } else {
      setTimeout(() => promptVrcBind(), 700);
    }
  }
}

// ==================== 两步验证（TOTP）登录第二步 ====================
// S-6: /login 密码验证通过且账号开启 2FA 时返回 need2fa + userId，
// 前端切换到验证码输入区，提交 /auth/2fa/verify 完成会话建立。
let _login2faUserId = null;

function showLogin2fa(data) {
  _login2faUserId = data.userId;
  document.getElementById('loginPasswordFields')?.classList.add('d-none');
  document.getElementById('login2faArea')?.classList.remove('d-none');
  const codeInput = document.getElementById('login2faCode');
  if (codeInput) { codeInput.value = ''; codeInput.focus(); }
  toast(data.message || __('login.2fa_hint'), 'info');
}

function resetLogin2fa() {
  _login2faUserId = null;
  document.getElementById('login2faArea')?.classList.add('d-none');
  document.getElementById('loginPasswordFields')?.classList.remove('d-none');
  const codeInput = document.getElementById('login2faCode');
  if (codeInput) codeInput.value = '';
}

async function doLogin2fa() {
  const code = document.getElementById('login2faCode')?.value?.trim();
  if (!code || code.length !== 6) { toast(__('login.2fa_enter_code'), 'error'); return; }
  if (!_login2faUserId) { toast(__('auth.login_failed'), 'error'); resetLogin2fa(); return; }
  const btn = document.getElementById('login2faBtn');
  const btnText = btn?.querySelector('.login-btn-text');
  if (btn) btn.disabled = true;
  if (btnText) btnText.textContent = __('auth.logging_in');
  try {
    const res = await api('/api/auth/2fa/verify', {
      method: 'POST',
      body: { userId: _login2faUserId, code }
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.success) {
      currentUser = data.user;
      try { await loadMe(); } catch (e) { /* 失败则保留 sessionUser 的基础字段 */ }
      await ensureCsrf();
      sessionStorage.removeItem('manual_logout');
      if (data.user && data.user.vrchatId && data.user.vrchatName) {
        localStorage.setItem('jingtu_vrc_bound', '1');
      }
      toast(__('auth.login_ok'), 'success');
      showApp();
      resetLogin2fa();
      return true;
    } else {
      toast(errText(data) || __('login.2fa_wrong_code'), 'error');
      // 会话标记丢失（2FA_STEP_REQUIRED）或锁定 → 退回密码步骤重来
      if (data.code === '2FA_STEP_REQUIRED' || data.code === 'ACCOUNT_LOCKED') resetLogin2fa();
      return false;
    }
  } catch (err) {
    if (!isApiHandledError(err)) toast(__('auth.network_error') + ': ' + err.message, 'error');
    return false;
  } finally {
    if (btn) btn.disabled = false;
    if (btnText) btnText.textContent = __('login.2fa_confirm');
  }
}

// 激活码注册：提交用户名/密码/激活码，后端校验消耗激活码并建立会话，成功后直接进入应用
async function doRegister() {
  const username = document.getElementById('regUsername')?.value?.trim();
  const password = document.getElementById('regPassword')?.value || '';
  const activationCode = document.getElementById('regActivationCode')?.value?.trim() || '';
  if (!username || !password || !activationCode) { toast(__('register.fill_all'), 'error'); return; }
  const regBtn = document.getElementById('registerBtn');
  const btnText = regBtn?.querySelector('.login-btn-text');
  if (regBtn) regBtn.disabled = true;
  if (btnText) btnText.textContent = __('register.submitting');
  try {
    const res = await api('/api/auth/register', {
      method: 'POST',
      body: { username, password, activationCode }
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.success) {
      // 后端注册成功即已建立会话，补拉完整档案与 CSRF 令牌后进入应用
      currentUser = data.user;
      try { await loadMe(); } catch (e) { /* 失败则保留注册返回的基础字段 */ }
      await ensureCsrf();
      sessionStorage.removeItem('manual_logout');
      const loginIdInput = document.getElementById('loginId');
      if (loginIdInput) loginIdInput.value = username;
      toast(__('register.ok'), 'success');
      showApp();
    } else {
      toast(errText(data) || __('register.failed'), 'error');
    }
  } catch (err) {
    if (!isApiHandledError(err)) toast(__('auth.network_error') + ': ' + err.message, 'error');
  } finally {
    if (regBtn) regBtn.disabled = false;
    if (btnText) btnText.textContent = __('register.submit_btn');
  }
}

// 登录页账号头像预览（§11.8.3）：输入 loginId 后实时预览「本地头像 + VRChat 头像」
// 匿名未记住的账号后端按 M-2 防枚举返回 null，此处降级为「账号首字母」彩色占位头像，
// 保证两个槽位永远有图（默认 SVG 路由支持 ?name= 生成首字母/首汉字，绝无裂图）。
function loginAvatarPlaceholder(loginId) {
  const c = String(loginId || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').charAt(0);
  return '/api/avatar/default?name=' + encodeURIComponent(c || '');
}

async function previewLoginAvatar(loginId) {
  const wrap = document.getElementById('loginAvatarPreview');
  const localImg = document.getElementById('loginLocalAvatar');
  const vrcImg = document.getElementById('loginVrcAvatar');
  if (!wrap || !localImg || !vrcImg) return;
  const id = (loginId || '').trim();
  if (!id) {
    wrap.style.display = 'none';
    return;
  }
  const placeholder = loginAvatarPlaceholder(id);
  let data = null;
  try {
    data = await api('/api/auth/preview?loginId=' + encodeURIComponent(id));
  } catch (e) {
    data = null; // 限流/网络错误静默降级为占位，不干扰登录流程
  }
  wrap.style.display = 'flex';
  localImg.src = (data && data.avatarUrl) || placeholder;
  vrcImg.src = (data && data.vrchatAvatarUrl) || placeholder;
}

// V6.6: 登录后引导用户绑定 VRChat 账号
function promptVrcBind() {
  switchTab('me');
  toast(__('auth.vrc_bind_hint'), 'info');
  setTimeout(() => {
    const bindInput = document.getElementById('vrchatInputId');
    if (bindInput) {
      bindInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
      bindInput.focus();
    }
  }, 400);
}

// ==================== VRChat 记住账号 ====================
// V6.8.1: 移除 base64 密码存储，仅记住用户名
const VRC_USER_KEY = 'jingtu_vrc_user';

function saveVrcUser(username) {
  if (username) localStorage.setItem(VRC_USER_KEY, username);
}

function clearVrcUser() {
  localStorage.removeItem(VRC_USER_KEY);
}

function loadVrcUser() {
  return localStorage.getItem(VRC_USER_KEY) || '';
}

// ==================== VRChat 登录（两步内联流程） ====================
let _vrcLoginTemp = null; // 存储 loginToken
let _vrcCodeCountdown = null; // 倒计时定时器

async function sendVrcLoginCode() {
  const vrchatUser = document.getElementById('loginVrcUser')?.value.trim();
  const vrchatPass = document.getElementById('loginVrcPass')?.value;
  if (!vrchatUser || !vrchatPass) { toast(__('auth.enter_vrc_account'), 'error'); return; }

  const btn = document.getElementById('sendVrcCodeBtn');
  if (btn) { btn.disabled = true; btn.querySelector('.login-btn-text').textContent = __('auth.sending'); }

  if (vrchatUser) localStorage.setItem('jingtu_vrc_user', vrchatUser);

  try {
    const res = await api('/api/auth/vrchat-login', { 
      method: 'POST', 
      body: { username: vrchatUser, password: vrchatPass }
    });

    if (res.ok) {
      const data = await res.json();
      if (data.needBind) {
        showVrcBindGuide(data);
      } else if (data.need2fa) {
        const methods = Array.isArray(data.methods) ? data.methods : [];
        const method = methods.includes('emailOtp')
          ? 'emailOtp'
          : (methods.includes('totp') ? 'totp' : 'otp');
        _vrcLoginTemp = { loginToken: data.loginToken, method };
        document.getElementById('vrcLoginCodeArea')?.classList.remove('d-none');
        document.getElementById('vrcLoginCodeInputWrap')?.classList.remove('d-none');
        document.getElementById('vrcLoginNo2faMsg')?.classList.add('d-none');
        const codeInput = document.getElementById('loginVrcCode');
        if (codeInput) { codeInput.value = ''; codeInput.focus(); }
        toast(data.message || __('auth.code_sent'), 'success');
        startVrcCodeCountdown();
      } else if (data.success) {
        _vrcLoginTemp = { no2fa: true, data };
        document.getElementById('vrcLoginCodeArea')?.classList.remove('d-none');
        document.getElementById('vrcLoginCodeInputWrap')?.classList.add('d-none');
        document.getElementById('vrcLoginNo2faMsg')?.classList.remove('d-none');
        toast(__('auth.no_code_needed'), 'info');
        const sendBtn = document.getElementById('sendVrcCodeBtn');
        if (sendBtn) { sendBtn.disabled = false; sendBtn.querySelector('.login-btn-text').textContent = __('auth.ready'); }
      } else {
        toast(errText(data) || __('auth.login_failed_vrc'), 'error');
      }
    } else {
      try {
        const err = await res.json();
        if (err.needBind) {
          showVrcBindGuide(err);
        } else if (!err.code || !VRC_BUSINESS_CODES.has(err.code)) {
          // api() 的 401/403 拦截器已对 VRC_BUSINESS_CODES 内的业务码 toast 过，
          // 这里再弹就是同一句话两遍；只有未被拦截覆盖的错误才由调用方兜底提示。
          toast(errText(err) || __('auth.vrc_login_failed'), 'error');
        }
      } catch { toast(__('auth.vrc_login_failed'), 'error'); }
    }
  } catch (err) {
    if (!isApiHandledError(err)) {
      toast(__('auth.network_error') + ': ' + err.message, 'error');
    }
  } finally {
    if (btn && !_vrcLoginTemp) { btn.disabled = false; btn.querySelector('.login-btn-text').textContent = __('auth.send_code'); }
  }
}

function startVrcCodeCountdown() {
  const btn = document.getElementById('sendVrcCodeBtn');
  if (!btn) return;
  let seconds = 60;
  btn.disabled = true;
  // 文案节点可能不存在（模板改版）。原先直接 .textContent 会在定时器里抛，
  // 后续 update 不再被排期，按钮就永远停在禁用状态，验证码再也发不出去。
  const setText = (t) => {
    const el = btn.querySelector('.login-btn-text') || btn;
    el.textContent = t;
  };
  const update = () => {
    if (seconds <= 0) {
      btn.disabled = false;
      setText(__('auth.resend'));
      _vrcCodeCountdown = null;
      return;
    }
    setText(__('auth.cooldown', {n: seconds}));
    seconds--;
    _vrcCodeCountdown = setTimeout(update, 1000);
  };
  update();
}

async function doVrcLoginConfirm() {
  const btn = document.getElementById('loginVrcConfirmBtn');
  if (btn) { btn.disabled = true; btn.querySelector('.login-btn-text').textContent = __('auth.logging_in'); }

  try {
    if (_vrcLoginTemp?.no2fa && _vrcLoginTemp?.data?.success) {
      currentUser = _vrcLoginTemp.data.user;
      await ensureCsrf();
      const vrcUser = document.getElementById('loginVrcUser')?.value.trim();
      if (vrcUser) localStorage.setItem('jingtu_vrc_user', vrcUser);
      localStorage.setItem('jingtu_vrc_bound', '1');
      toast(__('auth.vrc_login_ok'), 'success');
      showApp();
      resetVrcLoginState();
      if (btn) { btn.disabled = false; btn.querySelector('.login-btn-text').textContent = __('auth.login_btn'); }
      return;
    }

    const code = document.getElementById('loginVrcCode')?.value.trim();
    if (!code || code.length < 4) { toast(__('auth.enter_full_code'), 'error'); if (btn) { btn.disabled = false; btn.querySelector('.login-btn-text').textContent = __('auth.login_btn'); } return; }
    if (!_vrcLoginTemp?.loginToken) { toast(__('auth.send_code_first'), 'error'); if (btn) { btn.disabled = false; btn.querySelector('.login-btn-text').textContent = __('auth.login_btn'); } return; }

    const res = await api('/api/auth/vrchat-login', { 
      method: 'POST', 
      body: { code, method: _vrcLoginTemp.method, loginToken: _vrcLoginTemp.loginToken }
    });

    if (res.ok) {
      const data = await res.json();
      if (data.success) {
        currentUser = data.user;
        await ensureCsrf();
        const vrcUser = document.getElementById('loginVrcUser')?.value.trim();
        if (vrcUser) localStorage.setItem('jingtu_vrc_user', vrcUser);
        localStorage.setItem('jingtu_vrc_bound', '1');
        toast(__('auth.vrc_login_ok'), 'success');
        showApp();
        resetVrcLoginState();
      } else {
        toast(errText(data) || __('auth.login_failed'), 'error');
      }
    } else {
      try {
        const err = await res.json();
        // 同上：VRC_BUSINESS_CODES 已由 api() 拦截器 toast，避免验证码错误提示两遍
        if (!err.code || !VRC_BUSINESS_CODES.has(err.code)) {
          toast(errText(err) || __('auth.login_failed'), 'error');
        }
      } catch { toast(__('auth.login_failed'), 'error'); }
    }
  } catch (err) {
    if (!isApiHandledError(err)) {
      toast(__('auth.login_failed') + ': ' + err.message, 'error');
    }
  } finally {
    if (btn) { btn.disabled = false; btn.querySelector('.login-btn-text').textContent = __('auth.login_btn'); }
  }
}

function resetVrcLoginState() {
  _vrcLoginTemp = null;
  if (_vrcCodeCountdown) { clearTimeout(_vrcCodeCountdown); _vrcCodeCountdown = null; }
  const btn = document.getElementById('sendVrcCodeBtn');
  if (btn) { btn.disabled = false; btn.querySelector('.login-btn-text').textContent = __('auth.send_code'); }
  document.getElementById('vrcLoginCodeArea')?.classList.add('d-none');
  document.getElementById('vrcLoginCodeInputWrap')?.classList.add('d-none');
  document.getElementById('vrcLoginNo2faMsg')?.classList.add('d-none');
  const codeInput = document.getElementById('loginVrcCode');
  if (codeInput) codeInput.value = '';
}

function togglePwd(inputId, btnId) {
  const input = document.getElementById(inputId);
  const btn = document.getElementById(btnId);
  if (!input || !btn) return;
  const visible = input.type === 'password';
  input.type = visible ? 'text' : 'password';
  btn.classList.toggle('is-visible', visible);
  btn.setAttribute('aria-pressed', String(visible));
  btn.setAttribute('aria-label', visible ? __('auth.hide_password') : __('auth.show_password'));
  btn.title = visible ? __('auth.hide_password') : __('auth.show_password');
}
function togglePwdVrc() { togglePwd('loginVrcPass', 'pwdToggleVrc'); }
function togglePwdInit() { togglePwd('initPassword', 'pwdToggleInit'); }

function showVrcBindGuide(data) {
  localStorage.removeItem('jingtu_vrc_bound');
  localStorage.removeItem('jingtu_vrc_user');
  const guide = document.createElement('div');
  guide.className = 'vrc-bind-guide-overlay';
  guide.innerHTML = `
    <div class="vrc-bind-guide-modal">
      <div class="vrc-bind-guide-icon">🔐</div>
      <h3 class="vrc-bind-guide-title section-title">${__('auth.vrc_not_bound_title')}</h3>
      <p class="vrc-bind-guide-desc">${__('auth.vrc_not_bound_desc', { name: esc(data?.vrchatUser?.displayName || '') })}</p>
      <div class="vrc-bind-guide-steps">
        <div class="vrc-bind-step"><span class="vrc-bind-step-num">1</span><span>${__('auth.vrc_bind_step1')}</span></div>
        <div class="vrc-bind-step"><span class="vrc-bind-step-num">2</span><span>${__('auth.vrc_bind_step2')}</span></div>
        <div class="vrc-bind-step"><span class="vrc-bind-step-num">3</span><span>${__('auth.vrc_bind_step3')}</span></div>
      </div>
      <div class="vrc-bind-guide-actions">
        <button class="vrc-bind-btn vrc-bind-btn-primary" id="vrcBindSwitchPwd">${__('auth.vrc_bind_switch')}</button>
        <button class="vrc-bind-btn" id="vrcBindClose">${__('auth.vrc_bind_close')}</button>
      </div>
    </div>
  `;
  document.body.appendChild(guide);
  setTimeout(() => guide.classList.add('show'), 50);
  guide.querySelector('#vrcBindClose').onclick = () => guide.remove();
  guide.querySelector('#vrcBindSwitchPwd').onclick = () => {
    guide.remove();
    switchLoginMode('password');
    document.getElementById('loginId')?.focus();
  };
  guide.onclick = (e) => { if (e.target === guide) guide.remove(); };
  toast(__('auth.vrc_not_bound'), 'warn');
}


// ==================== 登录粒子背景（Premium） ====================
function initLoginParticles() {
  // 如果已有粒子动画，不重复初始化
  if (window._particleAnimId) return;
  const canvas = document.getElementById('loginParticles');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let particles = [], gradientTime = 0;
  window._particleAnimId = null;
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#7c5cfc';

  function resize() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }

  // 先移除旧的 resize 监听器再添加
  if (window._loginResizeHandler) window.removeEventListener('resize', window._loginResizeHandler);
  window._loginResizeHandler = resize;
  window.addEventListener('resize', window._loginResizeHandler);
  resize();

  class Particle {
    constructor() { this.reset(); }
    reset() {
      this.x = Math.random() * canvas.width;
      this.y = Math.random() * canvas.height;
      this.size = Math.random() * 2.5 + 0.5;
      this.speedX = (Math.random() - 0.5) * 0.3;
      this.speedY = (Math.random() - 0.5) * 0.3;
      this.opacity = Math.random() * 0.5 + 0.1;
      this.hue = Math.random() < 0.4 ? 260 : 220 + Math.random() * 60;
      this.pulse = Math.random() * Math.PI * 2;
      this.pulseSpeed = 0.01 + Math.random() * 0.02;
      // 随机选择颜色变体：紫色系/蓝色系/青色系/粉色系
      const hues = [260, 240, 200, 320];
      this.hue = hues[Math.floor(Math.random() * hues.length)] + (Math.random() - 0.5) * 30;
      this.sizeMult = 0.8 + Math.random() * 0.4;
    }
    update() {
      this.x += this.speedX; this.y += this.speedY;
      if (this.x < 0 || this.x > canvas.width) this.speedX *= -1;
      if (this.y < 0 || this.y > canvas.height) this.speedY *= -1;
      this.pulse += this.pulseSpeed;
    }
    draw() {
      const pulseOpacity = this.opacity * (0.6 + 0.4 * Math.sin(this.pulse));
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${this.hue}, 80%, 75%, ${pulseOpacity})`;
      ctx.fill();
      // 发光效果
      if (this.size > 1.5) {
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.size * 3, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${this.hue}, 80%, 75%, ${pulseOpacity * 0.08})`;
        ctx.fill();
      }
    }
  }

  function initParticles() {
    particles = Array.from({
      length: Math.min(Math.floor((canvas.width * canvas.height) / 10000), 100)
    }, () => new Particle());
  }
  initParticles();

  function connect() {
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = particles[i].x - particles[j].x, dy = particles[i].y - particles[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 200) {
          const alpha = 0.12 * (1 - dist / 200);
          const hue = (particles[i].hue + particles[j].hue) / 2;
          ctx.beginPath();
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.strokeStyle = `hsla(${hue}, 70%, 70%, ${alpha})`;
          ctx.lineWidth = 0.6;
          ctx.stroke();
        }
      }
    }
  }

  function animate() {
    gradientTime += 0.003;
    // 动态渐变背景 — 更丰富的色彩
    const hue1 = 260 + 12 * Math.sin(gradientTime);
    const hue2 = 210 + 18 * Math.sin(gradientTime + 1.2);
    const hue3 = 280 + 15 * Math.sin(gradientTime + 2.5);
    const gradient = ctx.createRadialGradient(
      canvas.width * 0.25, canvas.height * 0.2, 0,
      canvas.width * 0.6, canvas.height * 0.6, Math.max(canvas.width, canvas.height) * 0.85
    );
    gradient.addColorStop(0, `hsla(${hue1}, 65%, 38%, 1)`);
    gradient.addColorStop(0.3, `hsla(${hue3}, 55%, 28%, 1)`);
    gradient.addColorStop(0.6, `hsla(255, 50%, 22%, 1)`);
    gradient.addColorStop(0.85, `hsla(${hue2}, 55%, 15%, 1)`);
    gradient.addColorStop(1, 'hsla(240, 55%, 7%, 1)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 第二层光晕
    const glowGrad = ctx.createRadialGradient(
      canvas.width * 0.7, canvas.height * 0.8, 0,
      canvas.width * 0.7, canvas.height * 0.8, Math.max(canvas.width, canvas.height) * 0.5
    );
    glowGrad.addColorStop(0, `hsla(320, 50%, 25%, 0.15)`);
    glowGrad.addColorStop(1, 'transparent');
    ctx.fillStyle = glowGrad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    particles.forEach(p => { p.update(); p.draw(); });
    connect();
    window._particleAnimId = requestAnimationFrame(animate);
  }
  animate();

  // 空闲冻结解冻后恢复动画循环的入口（见 freeze.js）：
  // 仅当登录页粒子画布仍挂载且未隐藏时重启；已进入主页（stopLoginParticles 隐藏画布）则跳过。
  window._resumeLoginParticles = function () {
    if (window._particleAnimId) return;
    const cvs = document.getElementById('loginParticles');
    if (!cvs || cvs.style.display === 'none') return;
    animate();
  };
}

// 登录后停止粒子动画以节省性能
function stopLoginParticles() {
  if (window._particleAnimId) {
    cancelAnimationFrame(window._particleAnimId);
    window._particleAnimId = null;
  }
  const canvas = document.getElementById('loginParticles');
  if (canvas) {
    canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    canvas.style.display = 'none';
  }
}

// 空闲冻结：暂停登录页粒子动画（rAF），挂机时节省 GPU/CPU 开销；交互解冻后恢复（见 freeze.js）
if (window.__freeze && typeof window.__freeze.register === 'function') {
  window.__freeze.register({
    onFreeze: function () {
      if (window._particleAnimId) {
        cancelAnimationFrame(window._particleAnimId);
        window._particleAnimId = null;
      }
    },
    onUnfreeze: function () {
      if (typeof window._resumeLoginParticles === 'function') window._resumeLoginParticles();
    }
  });
}

// ==================== 忘记密码功能 ====================
let resetToken = '';

function showForgotPassword() {
  showModal('forgotPasswordModal');
  document.getElementById('forgotStep1')?.classList.remove('d-none');
  document.getElementById('forgotStep2')?.classList.add('d-none');
  document.getElementById('forgotStep3')?.classList.add('d-none');
  const titleEl = document.getElementById('forgotModalTitle'); if (titleEl) titleEl.textContent = __('forgot.title');
  const emailEl = document.getElementById('forgotEmail'); if (emailEl) emailEl.value = '';
  const codeEl = document.getElementById('forgotCode'); if (codeEl) codeEl.value = '';
  const newPwEl = document.getElementById('forgotNewPassword'); if (newPwEl) newPwEl.value = '';
  const emailErr = document.getElementById('forgotEmailError'); if (emailErr) emailErr.textContent = '';
  const codeErr = document.getElementById('forgotCodeError'); if (codeErr) codeErr.textContent = '';
  const pwErr = document.getElementById('forgotPasswordError'); if (pwErr) pwErr.textContent = '';
  resetToken = '';
}

function closeForgotPassword(e) {
  if (!e || e.target === e.currentTarget) {
    closeModal('forgotPasswordModal');
  }
}

function backToStep1() {
  document.getElementById('forgotStep1')?.classList.remove('d-none');
  document.getElementById('forgotStep2')?.classList.add('d-none');
  document.getElementById('forgotStep3')?.classList.add('d-none');
  const titleEl = document.getElementById('forgotModalTitle'); if (titleEl) titleEl.textContent = __('forgot.title');
}

function backToStep2() {
  document.getElementById('forgotStep1')?.classList.add('d-none');
  document.getElementById('forgotStep2')?.classList.remove('d-none');
  document.getElementById('forgotStep3')?.classList.add('d-none');
  const titleEl = document.getElementById('forgotModalTitle'); if (titleEl) titleEl.textContent = __('forgot.verify_code');
}

async function sendForgotCode() {
  const email = document.getElementById('forgotEmail')?.value?.trim();
  const errorEl = document.getElementById('forgotEmailError');
  
  if (!email) {
      if (errorEl) errorEl.textContent = __('forgot.enter_email');
      return;
    }

    if (!email.includes('@')) {
      if (errorEl) errorEl.textContent = __('forgot.invalid_email');
      return;
    }

    if (errorEl) errorEl.textContent = '';

    try {
      const res = await api('/api/auth/forgot-password', {
        method: 'POST',
        body: { email }
      });
      const data = await res.json();

      if (data.success) {
        resetToken = data.token || '';
        document.getElementById('forgotStep1')?.classList.add('d-none');
        document.getElementById('forgotStep2')?.classList.remove('d-none');
        const titleEl = document.getElementById('forgotModalTitle'); if (titleEl) titleEl.textContent = __('forgot.verify_code');
        toast(__('forgot.code_sent'), 'success');
      } else {
        if (errorEl) errorEl.textContent = errText(data) || __('forgot.send_failed');
      }
    } catch (e) {
      if (!isApiHandledError(e)) {
        if (errorEl) errorEl.textContent = __('forgot.network_error');
      }
    }
}

async function verifyForgotCode() {
  const code = document.getElementById('forgotCode')?.value?.trim();
  const errorEl = document.getElementById('forgotCodeError');

  if (!code || code.length !== 6) {
    if (errorEl) errorEl.textContent = __('forgot.enter_code');
    return;
  }

  if (errorEl) errorEl.textContent = '';

  try {
    const res = await api('/api/auth/verify-reset-code', {
      method: 'POST',
      body: { token: resetToken, code }
    });
    const data = await res.json();

    if (data.success) {
      document.getElementById('forgotStep2')?.classList.add('d-none');
      document.getElementById('forgotStep3')?.classList.remove('d-none');
      const titleEl = document.getElementById('forgotModalTitle'); if (titleEl) titleEl.textContent = __('forgot.set_new_password');
    } else {
      if (errorEl) errorEl.textContent = errText(data) || __('forgot.verify_failed');
      if (data.expired) {
        backToStep1();
        toast(__('forgot.code_expired'), 'info');
      }
    }
  } catch (e) {
    if (!isApiHandledError(e)) {
      if (errorEl) errorEl.textContent = __('forgot.network_error');
    }
  }
}

async function resetPassword() {
  const newPassword = document.getElementById('forgotNewPassword')?.value;
  const code = document.getElementById('forgotCode')?.value?.trim();
  const errorEl = document.getElementById('forgotPasswordError');

  if (!newPassword) {
    if (errorEl) errorEl.textContent = __('forgot.enter_new_password');
    return;
  }

  const strength = validatePasswordStrength(newPassword);
  if (!strength.valid) {
    if (errorEl) errorEl.textContent = strength.errors.join(' ');
    return;
  }

  if (errorEl) errorEl.textContent = '';

  try {
    const res = await api('/api/auth/reset-password', {
      method: 'POST',
      body: { token: resetToken, code, newPassword }
    });
    const data = await res.json();

    if (data.success) {
      closeForgotPassword();
      toast(data.message, 'success');
    } else {
      if (errorEl) errorEl.textContent = errText(data) || __('forgot.reset_failed');
      if (data.expired) {
        backToStep1();
        toast(__('forgot.link_expired'), 'info');
      }
    }
  } catch (e) {
    if (!isApiHandledError(e)) {
      if (errorEl) errorEl.textContent = __('forgot.network_error');
    }
  }
}
