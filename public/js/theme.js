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
    themeBtn.textContent = brightness === 'dark' ? '🌙' : '☀️';
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
  applyTheme(config);
  // 先清除旧的定时器，再重新设置
  if (_themeScheduleTimer) { clearInterval(_themeScheduleTimer); _themeScheduleTimer = null; }
  // __('auto_theme_2')按时间自动切换，页面打开期间每分钟检查一次，跨 18:00/06:00 时自动切换
  if (config.mode === 'auto') {
    _themeScheduleTimer = setInterval(() => applyTheme(loadThemeConfig()), 60000);
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
