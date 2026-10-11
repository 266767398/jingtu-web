// ==================== 安全告警（后台） ====================
// 依赖：core.js（api / esc / errText / isApiHandledError）
// 后端：server/routes/security_routes.js —— GET /api/admin/security/alerts/stats
// 说明：最近一小时的登录失败/可疑请求/限流触发/CSRF 拦截计数（每小时自动重置）。
(function () {
  'use strict';
  let secBound = false;

  async function loadAdminSecurity() {
    try {
      const res = await api('/api/admin/security/alerts/stats', { method: 'GET' });
      if (!res.ok) return;
      const d = await res.json();
      const s = d.stats || {};
      const el = document.getElementById('adminSecurityStats');
      if (!el) return;
      el.innerHTML =
        '<div class="stat-card"><div class="stat-value text-red">' + (s.loginFailures || 0) + '</div><div class="stat-label">' + __('auto_admin_sec_3') + '</div></div>' +
        '<div class="stat-card"><div class="stat-value text-red">' + (s.suspiciousRequests || 0) + '</div><div class="stat-label">' + __('auto_admin_sec_4') + '</div></div>' +
        '<div class="stat-card"><div class="stat-value text-muted2">' + (s.rateLimitTriggered || 0) + '</div><div class="stat-label">' + __('auto_admin_sec_5') + '</div></div>' +
        '<div class="stat-card"><div class="stat-value text-muted2">' + (s.csrfFailures || 0) + '</div><div class="stat-label">' + __('auto_admin_sec_6') + '</div></div>';
    } catch (e) {
      const box = document.getElementById('adminSecurityStats');
      if (box) box.innerHTML = '<p class="text-13 text-red">' + __('auto_admin_sec_8') + '</p>';
    }
  }

  function bindSecurityEvents() {
    if (secBound) return;
    secBound = true;
    const refreshBtn = document.getElementById('adminSecurityRefreshBtn');
    if (refreshBtn) refreshBtn.addEventListener('click', loadAdminSecurity);
  }

  function initAdminSecurityEvents() {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindSecurityEvents);
    else bindSecurityEvents();
  }

  // 暴露给 admin-ui.js PANEL_LOADERS / switchTab
  window.loadAdminSecurity = loadAdminSecurity;
  window.initAdminSecurityEvents = initAdminSecurityEvents;

  initAdminSecurityEvents();
})();