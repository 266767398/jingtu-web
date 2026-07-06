// ==================== 主题系统 V5.5 ====================
const THEME_STORAGE_KEY = 'jingtu_theme_config';

function defaultThemeConfig() {
  return { mode: 'manual', brightness: 'dark', accentColor: '#7c5cfc' };
}

function loadThemeConfig() {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw) return { ...defaultThemeConfig(), ...JSON.parse(raw) };
  } catch {}
  return defaultThemeConfig();
}

function saveThemeConfig(config) {
  localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(config));
}

function computeBrightness(config) {
  if (config.mode === 'manual') return config.brightness;
  if (config.mode === 'auto') return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  if (config.mode === 'schedule') {
    const hour = new Date().getHours();
    return (hour >= 18 || hour < 6) ? 'dark' : 'light';
  }
  return config.brightness;
}

function applyTheme(config) {
  const brightness = computeBrightness(config);
  const html = document.documentElement;
  html.setAttribute('data-theme', brightness);
  const accent = config.accentColor || '#7c5cfc';
  html.style.setProperty('--accent', accent);
  html.style.setProperty('--accent2', accent + 'cc');
  html.style.setProperty('--hover', accent + '1a');
  const themeBtn = document.getElementById('themeBtn');
  if (themeBtn) themeBtn.textContent = brightness === 'dark' ? '🌙' : '☀️';
  if (typeof mapInstance !== 'undefined' && mapInstance) setTimeout(() => mapInstance.invalidateSize(), 100);
}

// 主题自动定时器句柄，用于清除
let _themeScheduleTimer = null;
let _themeAutoChangeHandler = null;

function initTheme() {
  const config = loadThemeConfig();
  document.querySelectorAll('.theme-mode-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.mode === config.mode));
  document.querySelectorAll('.theme-brightness-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.brightness === config.brightness));
  applyTheme(config);
  // 先清除旧的定时器和事件监听，再重新设置
  if (_themeScheduleTimer) { clearInterval(_themeScheduleTimer); _themeScheduleTimer = null; }
  if (_themeAutoChangeHandler) {
    window.matchMedia('(prefers-color-scheme: dark)').removeEventListener('change', _themeAutoChangeHandler);
    _themeAutoChangeHandler = null;
  }
  if (config.mode === 'schedule') _themeScheduleTimer = setInterval(() => applyTheme(loadThemeConfig()), 60000);
  if (config.mode === 'auto') {
    _themeAutoChangeHandler = () => applyTheme(loadThemeConfig());
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', _themeAutoChangeHandler);
  }
}

function setThemeMode(mode) {
  const config = loadThemeConfig();
  config.mode = mode;
  saveThemeConfig(config);
  document.querySelectorAll('.theme-mode-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.mode === mode));
  applyTheme(config);
}

function setBrightness(brightness) {
  const config = loadThemeConfig();
  config.mode = 'manual';
  config.brightness = brightness;
  saveThemeConfig(config);
  document.querySelectorAll('.theme-brightness-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.brightness === brightness));
  applyTheme(config);
}

function setAccentColor(color) {
  const config = loadThemeConfig();
  config.accentColor = color;
  saveThemeConfig(config);
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
  closeThemePanel();
  toast(__('ui.theme_reset'), 'success');
}
