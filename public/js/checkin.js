class CheckinModule {
  constructor() {
    this.container = null;
    this.checkinBtn = null;
    this.statusInfo = null;
    this.isCheckingIn = false;
  }

  init() {
    this.container = document.getElementById('checkin-container');
    if (!this.container) {
      this.createContainer();
    }
    this.bindEvents();
    this.loadStatus();
  }

  createContainer() {
    const html = `
      <div id="checkin-container" class="checkin-card">
        <div class="checkin-header">
          <h3 class="checkin-title section-title">📅 ${__('checkin.title')}</h3>
          <span class="checkin-points">${__('checkin.points')}: <span id="checkin-points-value">0</span></span>
        </div>
        <div class="checkin-body">
          <div class="checkin-status" id="checkin-status">
            <div class="streak-info">
              <span class="streak-label">${__('checkin.current_streak')}</span>
              <span class="streak-value" id="current-streak">0</span>
              <span class="streak-unit">${__('checkin.days')}</span>
            </div>
            <div class="total-info">
              <span class="total-label">${__('checkin.total_checkins')}</span>
              <span class="total-value" id="total-checkins">0</span>
            </div>
          </div>
          <button id="checkin-btn" class="checkin-button" disabled>
            <span class="checkin-icon">✅</span>
            <span class="checkin-text">${__('checkin.checkin')}</span>
          </button>
          <div class="checkin-message" id="checkin-message"></div>
        </div>
        <div class="checkin-rewards" id="checkin-rewards">
          <h4>${__('checkin.rewards')}</h4>
          <div class="rewards-list" id="rewards-list"></div>
        </div>
      </div>
    `;
    // 放个人中心而不是首页：签到连续天数、成就进度都是__('auto_checkin_1')数据，
    // 首页刚做过精简，不宜再往顶部插两张大卡片。
    const host = document.getElementById('tab-me');
    if (host) {
      host.insertAdjacentHTML('beforeend', html);
      this.container = document.getElementById('checkin-container');
    }
  }

  bindEvents() {
    this.checkinBtn = document.getElementById('checkin-btn');
    // init() 每次登录都会被调用，容器不会重建但监听会重复叠加，
    // 结果是一次点击发出多个签到请求。用标记确保只绑一次。
    if (this.checkinBtn && !this.checkinBtn.dataset.bound) {
      this.checkinBtn.dataset.bound = '1';
      this.checkinBtn.addEventListener('click', () => this.doCheckin());
    }
  }

  async loadStatus() {
    try {
      const res = await api('/api/checkin/me/status');
      // 必须检查 res.ok：api() 对 4xx 不抛异常，直接 json() 会把错误体当成状态数据渲染
      if (!res.ok) {
        // 失败不能静默：按钮初始 disabled，不解除的话签到入口永远点不动
        const btn = document.getElementById('checkin-btn');
        if (btn) btn.disabled = false;
        toast(__('ui.load_failed'), 'error');
        return;
      }
      const data = await res.json();
      this.renderStatus(data);
    } catch {
      // 网络/服务异常同样解除禁用并提示，避免签到按钮静默死锁
      const btn = document.getElementById('checkin-btn');
      if (btn) btn.disabled = false;
      toast(__('ui.load_failed'), 'error');
    }
  }

  renderStatus(data) {
    const pointsEl = document.getElementById('checkin-points-value');
    const streakEl = document.getElementById('current-streak');
    const totalEl = document.getElementById('total-checkins');
    const btn = document.getElementById('checkin-btn');
    const msg = document.getElementById('checkin-message');

    if (pointsEl) pointsEl.textContent = data.checkinPoints || 0;
    if (streakEl) streakEl.textContent = data.currentStreak || 0;
    if (totalEl) totalEl.textContent = data.totalCheckins || 0;

    if (btn) {
      if (data.todayCheckedIn) {
        btn.disabled = true;
        btn.classList.add('checked-in');
        btn.innerHTML = `<span class="checkin-icon">✅</span><span class="checkin-text">${__('checkin.already_checked_in')}</span>`;
      } else {
        btn.disabled = false;
        btn.classList.remove('checked-in');
        btn.innerHTML = `<span class="checkin-icon">📝</span><span class="checkin-text">${__('checkin.checkin')}</span>`;
      }
    }

    if (msg) {
      if (data.todayCheckedIn) {
        msg.textContent = __('checkin.today_checked');
        msg.classList.add('success');
      } else {
        msg.textContent = '';
        msg.classList.remove('success', 'error');
      }
    }

    this.renderRewards(data.rewards);
  }

  renderRewards(rewards) {
    const list = document.getElementById('rewards-list');
    if (!list || !rewards) return;

    list.innerHTML = rewards.map(r => `
      <div class="reward-item ${r.achieved ? 'achieved' : ''}">
        <span class="reward-streak">${r.streak}${__('checkin.days')}</span>
        <span class="reward-points">+${r.points} ${__('checkin.point')}</span>
        <span class="reward-badge">${r.achieved ? '🏆' : '🔒'}</span>
      </div>
    `).join('');
  }

  async doCheckin() {
    if (this.isCheckingIn) return;

    const btn = document.getElementById('checkin-btn');
    const msg = document.getElementById('checkin-message');
    if (!btn) return;

    const idleHtml = `<span class="checkin-icon">📝</span><span class="checkin-text">${__('checkin.checkin')}</span>`;
    const setMsg = (text, cls) => {
      if (!msg) return;
      msg.textContent = text;
      msg.classList.toggle('success', cls === 'success');
      msg.classList.toggle('error', cls === 'error');
    };

    this.isCheckingIn = true;
    btn.disabled = true;
    btn.innerHTML = `<span class="checkin-icon">⏳</span><span class="checkin-text">${__('checkin.checking')}</span>`;

    let checkedIn = false;
    try {
      const res = await api('/api/checkin/me/checkin', {
        method: 'POST',
        body: {}
      });
      // api() 对 400/409（今日已签到）不抛异常，必须显式判断
      if (!res.ok) {
        let text = __('checkin.error');
        try { const err = await res.json(); text = errText(err) || text; } catch {}
        setMsg(text, 'error');
        return;
      }
      const data = await res.json();

      if (data.success) {
        checkedIn = true;
        setMsg(data.message, 'success');
        this.renderStatus(data);
      } else {
        setMsg(data.message, 'error');
      }
    } catch (err) {
      if (typeof isApiHandledError !== 'function' || !isApiHandledError(err)) {
        setMsg(__('checkin.error'), 'error');
      }
    } finally {
      this.isCheckingIn = false;
      // 只有签到成功才保持禁用（renderStatus 已经把按钮改成__('auto_checkin_2')）。
      // 其余所有路径都必须放开，否则用户点一次失败就再也签不了到。
      if (!checkedIn) {
        btn.disabled = false;
        btn.innerHTML = idleHtml;
      }
    }
  }
}

const checkinModule = new CheckinModule();

// 不在 DOMContentLoaded 自启：那时用户还在登录页，
// 卡片会被塞进隐藏的 #tab-home，请求也必然 401。
// 初始化由 auth.js 的 showApp() 在登录成功后调用。

