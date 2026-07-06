// ==================== 认证系统 ====================
async function loadMe() {
  try {
    await ensureCsrf();
    const res = await fetch('/api/users/me/profile', { method: 'GET', credentials: 'include', headers: { 'X-CSRF-Token': csrfToken || '' } });
    if (res.ok) { const data = await res.json(); currentUser = data.user || data; return currentUser; }
  } catch {}
  currentUser = null; return null;
}

async function login(loginId, password, remember = false) {
  const loginPwdBtn = document.getElementById('loginPwdBtn');
  if (loginPwdBtn) { loginPwdBtn.disabled = true; loginPwdBtn.textContent = __('auth.logging_in'); }
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(safeUrl('/api/auth/login'), {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken || '' },
      body: JSON.stringify({ loginId, password, remember }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const data = await res.json();
    if (res.ok && data.success) {
      currentUser = data.user;
      csrfToken = null; await ensureCsrf();
      if (remember) {
        // 只记住登录ID，不存密码
        localStorage.setItem('jingtu_remember', JSON.stringify({ loginId }));
      } else localStorage.removeItem('jingtu_remember');
      sessionStorage.removeItem('manual_logout');
      toast(__('auth.login_ok'), 'success'); showApp(); return true;
    } else { toast(data.error || __('auth.login_failed'), 'error'); return false; }
  } catch (err) {
    if (err.name === 'AbortError') toast(__('auth.login_timeout'), 'error');
    else toast(__('auth.network_error') + ': ' + err.message, 'error');
    return false;
  } finally {
    if (loginPwdBtn) { loginPwdBtn.disabled = false; loginPwdBtn.textContent = __('auth.login_btn'); }
  }
}

async function logout(redirect = true, silent = false) {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  disconnectWebSocket();
  // 停止所有定时轮询
  if (typeof stopGroupPolling === 'function') stopGroupPolling();
  currentUser = null; csrfToken = null; membersCache = []; albumPhotoList = [];
  signedEvents.clear(); albumScrollLock.clear();
  localStorage.removeItem('jingtu_remember');
  // V6.12: logout 不清除 VRChat 缓存（jingtu_vrc_bound / jingtu_vrc_user）
  sessionStorage.removeItem('manual_logout'); // 改为清除而非设置！避免 checkAutoLogin 跳过 VRChat 登录
  resetVrcLoginState();
  closeAllModals();
  if (!silent) toast(__('auth.logged_out'), 'info');
  if (redirect) showLogin();
}

async function checkAutoLogin() {
  if (sessionStorage.getItem('manual_logout') === 'true') { sessionStorage.removeItem('manual_logout'); return false; }
  // 先检查 session 是否仍然有效
  const user = await loadMe();
  if (user) { showApp(); return true; }
  // 检查是否有记住的登录ID，预填登录表单
  const saved = localStorage.getItem('jingtu_remember');
  if (saved) {
    try {
      const { loginId } = JSON.parse(saved);
      if (loginId) {
        const loginIdInput = document.getElementById('loginId');
        if (loginIdInput) loginIdInput.value = loginId;
      }
    } catch { localStorage.removeItem('jingtu_remember'); }
  }
  // V6.9: VRChat 缓存和标签切换统一由 showLogin() 处理
  return false;
}

function showLogin() { 
  const overlay = document.getElementById('loginOverlay'); 
  if (overlay) {
    overlay.style.display = 'flex'; 
    overlay.style.animation = 'none';
    // 强制回流后重新触发动画
    void overlay.offsetHeight;
    overlay.style.animation = 'overlayFadeIn 0.4s ease';
  }
  // 有用户时默认隐藏初始化 Tab（无用户场景由 init() 覆盖）
  document.getElementById('loginModeInit')?.classList.add('d-none');
  // V6.15: 两个登录标签始终可见，默认密码登录
  updateLoginTabsVisibility();
  switchLoginMode('password');
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
  const overlay = document.getElementById('loginOverlay');
  if (overlay) {
    overlay.style.animation = 'overlayFadeIn 0.3s ease reverse';
    setTimeout(() => { overlay.style.display = 'none'; overlay.style.animation = ''; }, 320);
  }
  stopLoginParticles();
  // 显示主界面元素（Header / Hero / 主容器默认是 d-none）
  document.getElementById('appHeader')?.classList.remove('d-none');
  document.getElementById('heroSection')?.classList.remove('d-none');
  document.getElementById('mainContainer')?.classList.remove('d-none');
  updateUserUI();
  switchTab(activeTab || 'members');
  connectWebSocket();
  if (typeof loadMyLikes === 'function') loadMyLikes();
}
async function doLogout() { await logout(true); }

// ==================== 登录辅助函数 ====================
function switchLoginMode(mode) {
  document.querySelectorAll('.login-tab-btn').forEach(btn => btn.classList.toggle('active', btn.id === 'loginMode' + mode.charAt(0).toUpperCase() + mode.slice(1)));
  const fieldMap = { password: 'loginPasswordFields', vrchat: 'loginVrcFields', init: 'loginInitFields' };
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
}

async function doPasswordLogin() {
  const loginId = document.getElementById('loginId')?.value;
  const password = document.getElementById('loginPassword')?.value;
  const remember = document.getElementById('rememberLogin')?.checked || false;
  if (!loginId || !password) { toast(__('auth.enter_account_pwd'), 'error'); return; }
  const ok = await login(loginId, password, remember);
  if (ok) {
    if (currentUser.vrchatId && currentUser.vrchatName) {
      // V6.12: 已绑定 VRChat → 标记缓存，保留登录
      localStorage.setItem('jingtu_vrc_bound', '1');
      toast('✅ ${__('auth.vrc_bound_hint')}', 'success');
    } else {
      // V6.9: 未绑定 → 引导绑定 VRChat 账号
      setTimeout(() => promptVrcBind(), 700);
    }
  }
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

  // 更新用户名缓存
  if (vrchatUser) localStorage.setItem('jingtu_vrc_user', vrchatUser);

  try {
    await ensureCsrf();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(safeUrl('/api/auth/vrchat-login'), {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken || '' },
      body: JSON.stringify({ username: vrchatUser, password: vrchatPass }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    csrfToken = null; // 单次消费

    if (res.ok) {
      const data = await res.json();
      if (data.needBind) {
        // V6.9: 绑定已被移除 → 清除本地缓存，隐藏 VRChat 标签
        localStorage.removeItem('jingtu_vrc_bound');
        localStorage.removeItem('jingtu_vrc_user');
        updateLoginTabsVisibility();
        toast(__('auth.vrc_not_bound_warn'), 'warn');
        switchLoginMode('password');
        document.getElementById('loginId')?.focus();
      } else if (data.need2fa) {
        // 需要验证码 → 显示验证码输入区，开始倒计时
        _vrcLoginTemp = { loginToken: data.loginToken };
        document.getElementById('vrcLoginCodeArea')?.classList.remove('d-none');
        document.getElementById('vrcLoginCodeInputWrap')?.classList.remove('d-none');
        document.getElementById('vrcLoginNo2faMsg')?.classList.add('d-none');
        const codeInput = document.getElementById('loginVrcCode');
        if (codeInput) { codeInput.value = ''; codeInput.focus(); }
        toast(data.message || __('auth.code_sent'), 'success');
        startVrcCodeCountdown();
      } else if (data.success) {
        // V6.12: 不需要2FA → 不直接登录，先停在这里让用户点"登录"按钮
        _vrcLoginTemp = { no2fa: true, data };
        document.getElementById('vrcLoginCodeArea')?.classList.remove('d-none');
        document.getElementById('vrcLoginCodeInputWrap')?.classList.add('d-none');
        document.getElementById('vrcLoginNo2faMsg')?.classList.remove('d-none');
        toast(__('auth.no_code_needed'), 'info');
        // 无2FA不需要倒计时，改按钮文字
        const sendBtn = document.getElementById('sendVrcCodeBtn');
        if (sendBtn) { sendBtn.disabled = false; sendBtn.querySelector('.login-btn-text').textContent = __('auth.ready'); }
      } else {
        toast(data.error || __('auth.login_failed_vrc'), 'error');
      }
    } else {
      // 非 200 响应 → 读取错误消息
      try { const err = await res.json(); toast(err.error || __('auth.vrc_login_failed'), 'error'); }
      catch { toast(__('auth.vrc_login_failed'), 'error'); }
    }
  } catch (err) {
    if (err.name === 'AbortError') toast(__('auth.timeout_retry'), 'error');
    else toast(__('auth.network_error') + ': ' + err.message, 'error');
  } finally {
    if (btn && !_vrcLoginTemp) { btn.disabled = false; btn.querySelector('.login-btn-text').textContent = __('auth.send_code'); }
  }
}

function startVrcCodeCountdown() {
  const btn = document.getElementById('sendVrcCodeBtn');
  if (!btn) return;
  let seconds = 60;
  btn.disabled = true;
  const update = () => {
    if (seconds <= 0) {
      btn.disabled = false;
      btn.querySelector('.login-btn-text').textContent = __('auth.resend');
      _vrcCodeCountdown = null;
      return;
    }
    btn.querySelector('.login-btn-text').textContent = __('auth.cooldown', {n: seconds});
    seconds--;
    _vrcCodeCountdown = setTimeout(update, 1000);
  };
  update();
}

async function doVrcLoginConfirm() {
  const btn = document.getElementById('loginVrcConfirmBtn');
  if (btn) { btn.disabled = true; btn.querySelector('.login-btn-text').textContent = __('auth.logging_in'); }

  try {
    // V6.12: 无2FA情况 → 直接用之前存的数据登录
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

    // 有2FA情况 → 需要验证码
    const code = document.getElementById('loginVrcCode')?.value.trim();
    if (!code || code.length < 4) { toast(__('auth.enter_full_code'), 'error'); if (btn) { btn.disabled = false; btn.querySelector('.login-btn-text').textContent = __('auth.login_btn'); } return; }
    if (!_vrcLoginTemp?.loginToken) { toast(__('auth.send_code_first'), 'error'); if (btn) { btn.disabled = false; btn.querySelector('.login-btn-text').textContent = __('auth.login_btn'); } return; }

    await ensureCsrf();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(safeUrl('/api/auth/vrchat-login'), {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken || '' },
      body: JSON.stringify({ code, loginToken: _vrcLoginTemp.loginToken }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    csrfToken = null;

    if (res.ok) {
      const data = await res.json();
      if (data.success) {
        currentUser = data.user;
        await ensureCsrf();
        // 缓存 VRChat 用户名 + 标记绑定状态
        const vrcUser = document.getElementById('loginVrcUser')?.value.trim();
        if (vrcUser) localStorage.setItem('jingtu_vrc_user', vrcUser);
        localStorage.setItem('jingtu_vrc_bound', '1');
        toast(__('auth.vrc_login_ok'), 'success');
        showApp();
        resetVrcLoginState();
      } else {
        toast(data.error || __('auth.login_failed'), 'error');
      }
    } else {
      try { const err = await res.json(); toast(err.error || __('auth.login_failed'), 'error'); }
      catch { toast(__('auth.login_failed'), 'error'); }
    }
  } catch (err) {
    if (err.name === 'AbortError') toast(__('auth.timeout_retry'), 'error');
    else toast(__('auth.login_failed') + ': ' + err.message, 'error');
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
  if (input.type === 'password') { input.type = 'text'; btn.textContent = '🙈'; }
  else { input.type = 'password'; btn.textContent = '👁️'; }
}
// 保留旧函数名兼容
function togglePwdVrc() { togglePwd('loginVrcPass', 'pwdToggleVrc'); }
function togglePwdInit() { togglePwd('initPassword', 'pwdToggleInit'); }


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
