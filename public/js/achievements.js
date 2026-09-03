class AchievementsModule {
  constructor() {
    this.container = null;
    this.achievements = [];
  }

  init() {
    this.container = document.getElementById('achievements-container');
    if (!this.container) {
      this.createContainer();
    }
    this.loadAchievements();
  }

  createContainer() {
    const html = `
      <div id="achievements-container" class="achievements-card">
        <div class="achievements-header">
          <h3 class="achievements-title section-title">🏆 ${__('achievements.title')}</h3>
          <div class="achievements-stats">
            <span class="stat-item">
              <span class="stat-value" id="achievement-unlocked">0</span>
              <span class="stat-label">${__('achievements.unlocked')}</span>
            </span>
            <span class="stat-divider">|</span>
            <span class="stat-item">
              <span class="stat-value" id="achievement-total">0</span>
              <span class="stat-label">${__('achievements.total')}</span>
            </span>
            <span class="stat-divider">|</span>
            <span class="stat-item">
              <span class="stat-value" id="achievement-points">0</span>
              <span class="stat-label">${__('achievements.points')}</span>
            </span>
          </div>
        </div>
        <div class="achievements-tabs">
          <button class="ach-tab active" data-ach-action="switch-tab" data-filter="all">${__('achievements.all')}</button>
          <button class="ach-tab" data-ach-action="switch-tab" data-filter="unlocked">${__('achievements.unlocked')}</button>
          <button class="ach-tab" data-ach-action="switch-tab" data-filter="locked">${__('achievements.locked')}</button>
        </div>
        <div class="achievements-grid" id="achievements-grid"></div>
      </div>
    `;
    // 同 checkin：成就属于__('auto_achievements_1')数据，放个人中心而不是首页顶部。
    const host = document.getElementById('tab-me');
    if (host) {
      host.insertAdjacentHTML('beforeend', html);
      this.container = document.getElementById('achievements-container');
      this.initEventDelegates();
    }
  }

  initEventDelegates() {
    if (!this.container || this.container._achDelegateInit) return;
    this.container._achDelegateInit = true;
    
    this.container.addEventListener('click', (e) => {
      const el = e.target.closest('[data-ach-action]');
      if (!el) return;
      
      const action = el.dataset.achAction;
      const filter = el.dataset.filter;
      
      if (action === 'switch-tab') {
        this.switchTab(filter, el);
      }
    });
  }

  async loadAchievements() {
    try {
      const res = await api('/api/achievements/me');
      // 必须检查 res.ok：api() 对 4xx 不抛异常，错误体会被当成成就数据渲染成空列表
      if (!res.ok) { toast(__('ui.load_failed'), 'error'); return; }
      const data = await res.json();
      this.achievements = data.achievements || [];
      
      const el = document.getElementById('achievement-unlocked'); if (el) el.textContent = data.unlockedCount || 0;
      const el2 = document.getElementById('achievement-total'); if (el2) el2.textContent = data.totalAchievements || 0;
      const el3 = document.getElementById('achievement-points'); if (el3) el3.textContent = data.achievementPoints || 0;
      
      this.renderAchievements('all');
    } catch (e) {
      if (typeof isApiHandledError !== 'function' || !isApiHandledError(e)) {
        toast(__('ui.load_failed'), 'error');
      }
    }
  }

  switchTab(filter, tabEl) {
    document.querySelectorAll('.ach-tab').forEach(t => t.classList.remove('active'));
    // 旧实现依赖隐式全局 event，严格模式/现代浏览器下为 undefined 会抛异常
    if (tabEl) tabEl.classList.add('active');
    this.renderAchievements(filter);
  }

  renderAchievements(filter) {
    const grid = document.getElementById('achievements-grid');
    if (!grid) return;

    let filtered = this.achievements;
    if (filter === 'unlocked') {
      filtered = this.achievements.filter(a => a.isUnlocked);
    } else if (filter === 'locked') {
      filtered = this.achievements.filter(a => !a.isUnlocked);
    }

    const rarityColors = {
      common: 'rarity-common',
      rare: 'rarity-rare',
      epic: 'rarity-epic',
      legendary: 'rarity-legendary'
    };

    grid.innerHTML = filtered.map(a => `
      <div class="achievement-item ${a.isUnlocked ? 'unlocked' : 'locked'} ${rarityColors[a.rarity] || ''}">
        <div class="achievement-icon">${a.isUnlocked ? esc(a.icon) || '🏆' : '🔒'}</div>
        <div class="achievement-info">
          <div class="achievement-name">${a.isUnlocked ? esc(a.name) : __('achievements.hidden')}</div>
          <div class="achievement-desc">${a.isUnlocked ? esc(a.description) : __('achievements.progress')}: ${a.progress}/${a.conditionValue}</div>
        </div>
        ${!a.isUnlocked && a.progress > 0 ? `
        <div class="achievement-progress">
          <div class="achievement-progress-bar" style="width: ${a.percentage}%"></div>
        </div>
        ` : ''}
        <div class="achievement-points">+${a.points}</div>
        ${a.isUnlocked ? `<div class="achievement-date">${this.formatDate(a.unlockedAt)}</div>` : ''}
      </div>
    `).join('');
  }

  formatDate(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    return `${date.getMonth() + 1}/${date.getDate()}`;
  }
}

const achievementsModule = new AchievementsModule();

// 不在 DOMContentLoaded 自启：那时用户还在登录页，
// 卡片会被塞进隐藏的 #tab-home，请求也必然 401。
// 初始化由 auth.js 的 showApp() 在登录成功后调用。