/**
 * 数据库连接恢复页逻辑（独立页面，不依赖 SPA 的 core.js）。
 *  - 进入页面时预填非敏感的数据库配置（来自 /api/setup/state）。
 *  - 「测试连接」调用 POST /api/system/db-recover { testOnly:true }。
 *  - 「保存并重连」调用 POST /api/system/db-recover，成功后热重连并跳回首页。
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const testResult = $('testResult');
  const RECOVERY_TOKEN_KEY = 'jt_recovery_token';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function showResult(type, msg) {
    testResult.className = 'test-result ' + type;
    testResult.style.display = 'block';
    testResult.innerHTML = msg;
  }

  // P2-100：本页不加载 core.js，内联轻量版错误文案提取（与 core.js errText 同逻辑）。
  // 兼容 string / Error / 嵌套包络 {error:{code,message}} / 扁平包络 {error:'串',code} / {detail} / {message}；
  // 命中 code 优先走 error.* 语言包翻译，回退后端原文；解析不出返回 ''。
  function errText(d) {
    if (d == null) return '';
    if (typeof d === 'string') return d;
    if (d instanceof Error) return d.message || '';
    const code = (d.error && typeof d.error === 'object' && d.error.code) || (typeof d.code === 'string' ? d.code : '');
    if (code) {
      const translated = __('error.' + code);
      if (translated && translated !== 'error.' + code) return translated;
    }
    if (typeof d.error === 'string') return d.error;
    if (d.error && typeof d.error === 'object') {
      return d.error.message || (typeof d.detail === 'string' ? d.detail : '') || code || '';
    }
    if (typeof d.detail === 'string') return d.detail;
    if (typeof d.message === 'string') return d.message;
    return '';
  }
  function setLoading(btn, on) {
    btn.disabled = on;
    if (on) {
      btn.dataset.label = btn.textContent;
      btn.innerHTML = '<span class="loading"></span> ' + __('db_recover.processing');
    } else if (btn.dataset.label) {
      btn.textContent = btn.dataset.label;
    }
  }

  function collect() {
    return {
      host: $('dbHost').value.trim(),
      port: $('dbPort').value.trim(),
      database: $('dbName').value.trim(),
      user: $('dbUser').value.trim(),
      password: $('dbPass').value
    };
  }

  // 恢复令牌：用户输入后暂存于 localStorage，便于测试/保存两次调用复用；
  // 明文仅存在浏览器本地，不随请求体发送（走 Authorization 头）。
  function getRecoveryToken() {
    const input = $('recoveryToken');
    const token = (input && input.value.trim()) || '';
    if (token) {
      try { localStorage.setItem(RECOVERY_TOKEN_KEY, token); } catch (_) {}
      return token;
    }
    try { return localStorage.getItem(RECOVERY_TOKEN_KEY) || ''; } catch (_) { return ''; }
  }

  // 预填：从 /api/setup/state 取非敏感草稿（失败则忽略，用户手动填）
  async function prefill() {
    try {
      const res = await fetch('/api/setup/state', { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      const d = (data.wizard && data.wizard.drafts) || {};
      if (d.dbHost) $('dbHost').value = d.dbHost;
      if (d.dbPort) $('dbPort').value = d.dbPort;
      if (d.dbName) $('dbName').value = d.dbName;
      if (d.dbUser) $('dbUser').value = d.dbUser;
    } catch (_) { /* 忽略 */ }
    // 回填上次保存的令牌（仅值，不显示明文之外额外提示）
    try {
      const saved = localStorage.getItem(RECOVERY_TOKEN_KEY);
      if (saved && $('recoveryToken') && !$('recoveryToken').value) $('recoveryToken').value = saved;
    } catch (_) {}
  }

  async function callRecover(testOnly) {
    const payload = collect();
    payload.testOnly = testOnly;
    const token = getRecoveryToken();
    const headers = { 'Content-Type': 'application/json' };
    // 恢复令牌通过 Authorization: Bearer 传递（与 .env 的 RECOVERY_TOKEN 恒定时间比对）
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch('/api/system/db-recover', {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify(payload)
    });
    let data = {};
    try { data = await res.json(); } catch (_) {}
    if (res.ok && data.success) {
      if (testOnly) {
        showResult('success', __('db_recover.db_ok_save'));
      } else {
        // P1-29: 恢复成功后令牌使命已完成——它是 db-recover 端点的 Bearer 凭据，
        // 继续留在 localStorage 会让任何 XSS/共享电脑场景多一个可用凭证的窗口期。
        // 测试连接（testOnly）时保留，避免用户还没保存就把输入清空。
        try { localStorage.removeItem(RECOVERY_TOKEN_KEY); } catch (_) {}
        const warn = data.warning ? '<br><span style="color:var(--warning)">' + esc(data.warning) + '</span>' : '';
        showResult('success', __('db_recover.saved_reconnect') + warn);
        setTimeout(() => { window.location.href = '/'; }, 1200);
      }
      return true;
    }
    // 令牌相关错误给予明确指引
    if (res.status === 401) {
      showResult('error', '✗ ' + __('db_recover.bad_token'));
      return false;
    }
    if (res.status === 503) {
      showResult('error', '✗ ' + __('db_recover.token_disabled'));
      return false;
    }
    // 业务错误：后端会给出可读 message / error
    const msg = errText(data) || (__('db_recover.request_failed') + ' (HTTP ' + res.status + ')');
    showResult('error', '✗ ' + esc(msg));
    return false;
  }

  $('testBtn').addEventListener('click', async () => {
    setLoading($('testBtn'), true);
    showResult('', '');
    try { await callRecover(true); }
    catch (e) { showResult('error', '✗ ' + esc(__('db_recover.network_error') + '：' + e.message)); }
    finally { setLoading($('testBtn'), false); }
  });

  $('saveBtn').addEventListener('click', async () => {
    setLoading($('saveBtn'), true);
    showResult('', '');
    try { await callRecover(false); }
    catch (e) { showResult('error', '✗ ' + esc(__('db_recover.network_error') + '：' + e.message)); }
    finally { setLoading($('saveBtn'), false); }
  });

  prefill();
})();
