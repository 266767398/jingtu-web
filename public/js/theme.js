// ==================== 主题系统 V5.5 ====================
const THEME_STORAGE_KEY = 'jingtu_theme_config';

const THEME_MODE_MIGRATION = { system: 'auto', time: 'auto' };

function defaultThemeConfig() {
  return { mode: 'manual', brightness: 'dark', accentColor: '#7c5cfc' };
}

function loadThemeConfig() {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (THEME_MODE_MIGRATION[parsed.mode]) {
        parsed.mode = THEME_MODE_MIGRATION[parsed.mode];
        saveThemeConfig(parsed);
      }
      return { ...defaultThemeConfig(), ...parsed };
    }
  } catch {}
  return defaultThemeConfig();
}

function saveThemeConfig(config) {
  localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(config));
}

// 主题配置持久化到服务器（preferences.theme）：localStorage 只作为本机快速缓存，
// 服务器是跨设备/清缓存后的恢复来源。写入失败不影响本次使用，仅静默回退本地。
let _themeSyncTimer = null;
function syncThemeToServer(config) {
  if (typeof api !== 'function') return;
  if (typeof currentUser === 'undefined' || !currentUser) return;
  clearTimeout(_themeSyncTimer);
  _themeSyncTimer = setTimeout(() => {
    _themeSyncTimer = null;
    api('/api/users/me/profile', { method: 'PUT', body: { theme: config }, silent: true })
      .then((res) => {
        if (res && res.ok && currentUser) {
          if (!currentUser.preferences) currentUser.preferences = {};
          currentUser.preferences.theme = config;
        }
      })
      .catch(() => { /* 离线/未登录时仅保留本地配置 */ });
  }, 400);
}

// 登录后从服务器恢复主题（由 auth.js loadMe 调用）。
// 服务器有配置 → 以服务器为准覆盖本地；服务器无配置 → 把本地配置作为初始值上传。
function hydrateThemeFromServer(theme) {
  if (theme && typeof theme === 'object' && !Array.isArray(theme) && Object.keys(theme).length) {
    const config = { ...defaultThemeConfig(), ...theme };
    saveThemeConfig(config);
    initTheme();
    return;
  }
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw) syncThemeToServer(JSON.parse(raw));
  } catch { /* ignore */ }
}

function computeBrightness(config) {
  if (config.mode === 'manual') return config.brightness;
  // __('auto_theme_1')改为按当前时间自动切换：18:00-06:00 为暗色，其余为亮色
  if (config.mode === 'auto') {
    const hour = new Date().getHours();
    return (hour >= 18 || hour < 6) ? 'dark' : 'light';
  }
  return config.brightness;
}

function applyTheme(config) {
  const html = document.documentElement;
  // “跟随系统(按时间)”与“手动”统一通过 computeBrightness 计算明暗，再写入 data-theme，
  // 避免 auto 模式下固定写 'auto' 导致 18:00/06:00 的时间切换实际不生效。
  const brightness = computeBrightness(config);
  html.setAttribute('data-theme', brightness);
  const accent = config.accentColor || '#7c5cfc';
  html.style.setProperty('--accent', accent);
  html.style.setProperty('--accent2', accent + 'cc');
  html.style.setProperty('--hover', accent + '1a');
  const themeBtn = document.getElementById('themeBtn');
  if (themeBtn) {
    const brightness = computeBrightness(config);
    // F6 加固：按钮内含 <span aria-hidden> 承载图标，更新图标不覆盖 aria-label
    const iconEl = themeBtn.querySelector('span');
    if (iconEl) { iconEl.textContent = brightness === 'dark' ? '🌙' : '☀️'; }
    else { themeBtn.textContent = brightness === 'dark' ? '🌙' : '☀️'; }
  }
  if (typeof mapInstance !== 'undefined' && mapInstance) setTimeout(() => mapInstance.invalidateSize(), 100);
}

// 主题自动定时器句柄，用于清除
let _themeScheduleTimer = null;
let _themeAutoChangeHandler = null;

function initTheme() {
  const config = loadThemeConfig();
  document.querySelectorAll('.theme-mode-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.mode === config.mode));
  document.querySelectorAll('.theme-brightness-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.brightness === config.brightness));
  syncAnimSwitch();
  applyTheme(config);
  maybeHintReducedMotion();
  // 先清除旧的定时器，再重新设置
  if (_themeScheduleTimer) { clearInterval(_themeScheduleTimer); _themeScheduleTimer = null; }
  // __('auto_theme_2')按时间自动切换，页面打开期间每分钟检查一次，跨 18:00/06:00 时自动切换
  if (config.mode === 'auto') {
    _themeScheduleTimer = setInterval(() => applyTheme(loadThemeConfig()), 60000);
  }
}

// U-02：检测到系统「减少动态效果」且用户未强制开启动画时，仅提示一次，
// 引导到主题面板的「动态效果 → 强制开启」开关（.force-anim 逃生舱）。
function maybeHintReducedMotion() {
  try {
    if (document.documentElement.classList.contains('force-anim')) return;
    if (!window.matchMedia || !window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (localStorage.getItem('jingtu_anim_hint')) return;
    localStorage.setItem('jingtu_anim_hint', '1');
    if (typeof toast === 'function' && typeof __ === 'function') {
      setTimeout(() => toast(__('ui.anim_reduced_hint'), 'info'), 800);
    }
  } catch (e) { /* localStorage 不可用则跳过提示 */ }
}

// 空闲冻结：暂停/恢复「按时间自动切换主题」的每分钟检查（见 freeze.js）
if (window.__freeze && typeof window.__freeze.register === 'function') {
  window.__freeze.register({
    onFreeze: function () {
      if (_themeScheduleTimer) { clearInterval(_themeScheduleTimer); _themeScheduleTimer = null; }
    },
    onUnfreeze: function () {
      if (_themeScheduleTimer) return;
      const config = loadThemeConfig();
      if (config.mode === 'auto') {
        _themeScheduleTimer = setInterval(() => applyTheme(loadThemeConfig()), 60000);
      }
    }
  });
}

function setThemeMode(mode) {
  const config = loadThemeConfig();
  config.mode = mode;
  saveThemeConfig(config);
  syncThemeToServer(config);
  document.querySelectorAll('.theme-mode-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.mode === mode));
  applyTheme(config);
}

function setBrightness(brightness) {
  const config = loadThemeConfig();
  config.mode = 'manual';
  config.brightness = brightness;
  saveThemeConfig(config);
  syncThemeToServer(config);
  document.querySelectorAll('.theme-brightness-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.brightness === brightness));
  applyTheme(config);
}

function setAccentColor(color) {
  const config = loadThemeConfig();
  config.accentColor = color;
  saveThemeConfig(config);
  syncThemeToServer(config);
  applyTheme(config);
}

function toggleThemePanel() {
  const panel = document.getElementById('themePanel');
  if (!panel) return;
  panel.classList.toggle('show');
}

function closeThemePanel() {
  const panel = document.getElementById('themePanel');
  if (panel) panel.classList.remove('show');
}

function resetTheme() {
  localStorage.removeItem(THEME_STORAGE_KEY);
  initTheme();
  syncThemeToServer(defaultThemeConfig());
  closeThemePanel();
  toast(__('ui.theme_reset'), 'success');
}

// ==================== 动态效果开关（force-anim 逃生舱 UI）====================
// 背景：桌面端若系统/浏览器开启「减少动态效果」(prefers-reduced-motion: reduce)，
// 站点会按无障碍规范把所有 CSS 动画立即结束（看起来像"动画卡住/静止"），
// 而手机端通常没开该偏好所以动画正常。这里把 loader.js 的 ?anim=on 逃生舱
// 暴露成主题面板里的可视化开关，用户可一键强制开启动画。
function syncAnimSwitch() {
  const forced = document.documentElement.classList.contains('force-anim');
  document.querySelectorAll('[data-anim]').forEach(btn => {
    btn.classList.toggle('active', forced ? btn.dataset.anim === 'on' : btn.dataset.anim === 'auto');
  });
}

function setAnimMode(mode) {
  try {
    if (mode === 'on') localStorage.setItem('jingtu_anim', 'on');
    else localStorage.removeItem('jingtu_anim');
  } catch (e) { /* localStorage 不可用则仅本次生效 */ }
  document.documentElement.classList.toggle('force-anim', mode === 'on');
  syncAnimSwitch();
}
document.addEventListener('click', function (e) {
  const btn = e.target && e.target.closest ? e.target.closest('[data-anim]') : null;
  if (!btn) return;
  setAnimMode(btn.dataset.anim);
});

// ==================== 用户单独的网站背景 ====================
// 与主题（亮度/强调色）相互独立：背景图来自用户资料 preferences.backgroundImage，
// 登录后整站展示（loadMe 时应用）。空值 = 恢复主题默认背景。
function applyUserSiteBackground(url) {
  const layer = document.getElementById('siteBgLayer');
  if (!layer) return;
  // 有背景图时给 body 打标记：CSS 据此把卡片/面板/页脚等 UI 半透明化，让背景透出
  document.body.classList.toggle('has-site-bg', !!url);
  if (url) {
    layer.style.backgroundImage = `url(${escCssUrl(url)})`;
    // 图片探测失败（文件被清理/URL 失效）时静默回退默认背景，避免留下破图底色
    const probe = new Image();
    probe.onerror = function () {
      layer.style.backgroundImage = '';
      document.body.classList.remove('has-site-bg');
    };
    probe.src = url;
  } else {
    layer.style.backgroundImage = '';
  }
}

// 刷新「我的 → 主题与外观」中的背景预览（预览框按图片实际宽高比自适应，不再固定裁剪）
function refreshSiteBgUI(url) {
  const preview = document.getElementById('meSiteBgPreview');
  if (!preview) return;
  if (url) {
    preview.style.backgroundImage = `url(${escCssUrl(url)})`;
    preview.style.backgroundSize = 'cover';
    preview.style.backgroundPosition = 'center';
    preview.style.aspectRatio = '';
    preview.innerHTML = '';
    const probe = new Image();
    probe.onload = function () { preview.style.aspectRatio = (probe.naturalWidth / probe.naturalHeight).toFixed(3); };
    probe.src = url;
  } else {
    preview.style.backgroundImage = '';
    preview.style.backgroundSize = '';
    preview.style.aspectRatio = '';
    preview.innerHTML = '<span class="text-muted2">' + __('me.site_bg_none') + '</span>';
  }
}

async function uploadSiteBackground(file) {
  if (!file) return false;
  if (!file.type.startsWith('image/')) { toast(__('profile_page.select_image'), 'error'); return false; }
  if (file.size > 15 * 1024 * 1024) { toast(__('me.site_bg_too_large'), 'error'); return false; }
  try {
    const formData = new FormData();
    formData.append('background', file);
    const res = await apiForm('/api/users/me/background', formData);
    if (res.ok) {
      const data = await res.json();
      applyUserSiteBackground(data.backgroundUrl);
      refreshSiteBgUI(data.backgroundUrl);
      if (currentUser) {
        if (!currentUser.preferences) currentUser.preferences = {};
        currentUser.preferences.backgroundImage = data.backgroundUrl;
        currentUser.backgroundImage = data.backgroundUrl;
      }
      toast(__('me.site_bg_updated'), 'success');
      return true;
    }
  } catch (err) {
    if (isApiHandledError(err)) return false;
    toast(__('me.site_bg_upload_failed'), 'error');
  }
  return false;
}

async function clearSiteBackground() {
  try {
    const res = await api('/api/users/me/background', { method: 'DELETE' });
    if (res.ok) {
      applyUserSiteBackground('');
      refreshSiteBgUI('');
      if (currentUser) {
        if (!currentUser.preferences) currentUser.preferences = {};
        currentUser.preferences.backgroundImage = '';
        currentUser.backgroundImage = '';
      }
      toast(__('me.site_bg_cleared'), 'success');
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('me.site_bg_upload_failed'), 'error');
  }
}

// ==================== 用户横幅（封面照片） ====================
// 横幅即公开主页/成员详情的封面图，存在 preferences.coverImage（与编辑资料弹窗同一字段）。
// 在「我的 → 主题与外观」管理。媒体本身存放在私有目录 /uploads/covers/（见 uploads_auth.js）：
// 仅登录用户可见，游客态由前端兜底（封面 onerror 回退 /assets/group-banner.png，背景失败则隐藏）。
function applyBannerPreview(url) {
  const preview = document.getElementById('meBannerPreview');
  if (!preview) return;
  if (url) {
    preview.style.backgroundImage = `url(${escCssUrl(url)})`;
    preview.style.backgroundSize = 'cover';
    preview.style.backgroundPosition = 'center';
    preview.style.aspectRatio = '';
    preview.innerHTML = '';
    const probe = new Image();
    probe.onload = function () { preview.style.aspectRatio = (probe.naturalWidth / probe.naturalHeight).toFixed(3); };
    probe.src = url;
  } else {
    preview.style.backgroundImage = '';
    preview.style.backgroundSize = '';
    preview.style.aspectRatio = '';
    preview.innerHTML = '<span class="text-muted2">' + __('me.banner_none') + '</span>';
  }
}

// 登录后同步横幅预览（由 auth.js loadMe 调用）
function refreshBannerUI(url) {
  applyBannerPreview(url);
}

async function uploadBanner(file) {
  if (!file) return false;
  if (!file.type.startsWith('image/')) { toast(__('profile_page.select_image'), 'error'); return false; }
  if (file.size > 10 * 1024 * 1024) { toast(__('me.banner_too_large'), 'error'); return false; }
  try {
    const formData = new FormData();
    formData.append('cover', file);
    const res = await apiForm('/api/users/me/cover', formData);
    if (res.ok) {
      const data = await res.json();
      applyBannerPreview(data.coverUrl);
      if (currentUser) {
        if (!currentUser.preferences) currentUser.preferences = {};
        currentUser.preferences.coverImage = data.coverUrl;
        currentUser.coverImage = data.coverUrl;
      }
      // 同步完整资料页横幅（若已打开）与成员名片，无需再点保存
      if (typeof loadUserProfile === 'function' && typeof profileUser !== 'undefined' && profileUser && String(profileUser.id) === String(currentUser.id)) {
        loadUserProfile(currentUser.id);
      }
      toast(__('me.banner_updated'), 'success');
      return true;
    }
  } catch (err) {
    if (isApiHandledError(err)) return false;
    toast(__('me.banner_upload_failed'), 'error');
  }
  return false;
}

async function clearBanner() {
  try {
    const res = await api('/api/users/me/profile', {
      method: 'PUT',
      body: { coverImage: '' }
    });
    if (res.ok) {
      applyBannerPreview('');
      if (currentUser) {
        if (!currentUser.preferences) currentUser.preferences = {};
        currentUser.preferences.coverImage = '';
        currentUser.coverImage = '';
      }
      if (typeof loadUserProfile === 'function' && typeof profileUser !== 'undefined' && profileUser && String(profileUser.id) === String(currentUser.id)) {
        loadUserProfile(currentUser.id);
      }
      toast(__('me.banner_cleared'), 'success');
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('me.banner_upload_failed'), 'error');
  }
}
