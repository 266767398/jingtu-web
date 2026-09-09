// admin-activation.js —— 后台「激活码管理」面板（列表 / 统计 / 生成 / 作废）
// 依赖：core.js（api/toast/showConfirm/copyToClipboard/fmtTime/esc/escAttr/renderEmpty/isApiHandledError/__）
// 说明：生成复用 admin-users.js 的 showGenerateCodesModal()；作废走 /api/admin/activation-codes/revoke

let _activationCodes = [];
let _activationPanelBound = false;

function initActivationPanelEvents() {
  if (_activationPanelBound) return;
  _activationPanelBound = true;
  const genBtn = document.getElementById('activationGenCodesBtn');
  if (genBtn) genBtn.addEventListener('click', function () {
    if (typeof showGenerateCodesModal === 'function') showGenerateCodesModal();
    else toast('生成弹窗未就绪，请刷新页面重试', 'error');
  });
  const refreshBtn = document.getElementById('activationRefreshBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', function () { loadActivationCodesPanel(); });
  const search = document.getElementById('activationCodeSearch');
  if (search) search.addEventListener('input', renderActivationCodes);
  const filter = document.getElementById('activationCodeStatusFilter');
  if (filter) filter.addEventListener('change', renderActivationCodes);
  const list = document.getElementById('activationCodesList');
  if (list) list.addEventListener('click', function (ev) {
    const btn = ev.target.closest('button[data-code-action]');
    if (!btn) return;
    const code = btn.getAttribute('data-code');
    const action = btn.getAttribute('data-code-action');
    if (action === 'revoke') revokeActivationCode(code);
    else if (action === 'copy') copyToClipboard(code).then(function () { toast(__('admin.copied'), 'success'); });
  });
}

async function loadActivationCodesPanel() {
  initActivationPanelEvents();
  const container = document.getElementById('activationCodesList');
  const statsEl = document.getElementById('activationCodeStats');
  if (statsEl) statsEl.innerHTML = '';
  if (container) container.innerHTML = '<div class="text-13 text-muted">加载中...</div>';
  try {
    const res = await api('/api/admin/activation-codes', { method: 'GET' });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.error || e.message || ('加载失败 (' + res.status + ')'));
    }
    const data = await res.json();
    _activationCodes = data.codes || [];
    renderActivationStats(data);
    renderActivationCodes();
  } catch (err) {
    if (isApiHandledError(err)) return;
    if (container) container.innerHTML = '';
    toast('激活码加载失败: ' + err.message, 'error');
  }
}

function renderActivationStats(data) {
  const el = document.getElementById('activationCodeStats');
  if (!el) return;
  const items = [
    ['总计', data.total],
    ['未使用', data.unused],
    ['已使用', data.used],
    ['已作废', data.revoked || 0]
  ];
  el.innerHTML = items.map(function (it) {
    return '<div class="stat-card"><div class="stat-value">' + it[1] + '</div><div class="stat-label">' + it[0] + '</div></div>';
  }).join('');
}

function renderActivationCodes() {
  const container = document.getElementById('activationCodesList');
  if (!container) return;
  const kw = (document.getElementById('activationCodeSearch')?.value || '').trim().toUpperCase();
  const status = document.getElementById('activationCodeStatusFilter')?.value || '';
  let list = _activationCodes.slice().reverse();
  if (status === 'unused') list = list.filter(function (c) { return !c.used && !c.revoked; });
  else if (status === 'used') list = list.filter(function (c) { return c.used; });
  else if (status === 'revoked') list = list.filter(function (c) { return c.revoked; });
  if (kw) {
    list = list.filter(function (c) {
      return c.code.indexOf(kw) !== -1
        || String(c.note || '').toUpperCase().indexOf(kw) !== -1
        || String(c.created_by || '').toUpperCase().indexOf(kw) !== -1;
    });
  }
  if (!list.length) {
    renderEmpty(container, { icon: '🎟', text: '暂无匹配的激活码' });
    return;
  }
  container.innerHTML = list.map(function (c) {
    let statusLabel = '未使用';
    if (c.used) statusLabel = '已使用';
    else if (c.revoked) statusLabel = '已作废';
    const codeEsc = escAttr(c.code);
    const notePart = c.note ? ' · ' + esc(c.note) : '';
    const usedInfo = c.used
      ? '<div class="admin-user-status">使用者: ' + esc(c.used_by || '-') + ' · ' + fmtTime(c.used_at) + '</div>'
      : '';
    const revokedInfo = c.revoked
      ? '<div class="admin-user-status">作废者: ' + esc(c.revoked_by || '-') + ' · ' + fmtTime(c.revoked_at)
        + (c.revoked_reason ? ' · 原因: ' + esc(c.revoked_reason) : '') + '</div>'
      : '';
    const revokeBtn = (!c.used && !c.revoked)
      ? '<button class="btn btn-sm btn-danger" data-code-action="revoke" data-code="' + codeEsc + '">🚫 作废</button>'
      : '';
    const copyBtn = '<button class="btn btn-sm btn-outline" data-code-action="copy" data-code="' + codeEsc + '">📋 复制</button>';
    return '<div class="admin-user-card">'
      + '<div class="admin-user-info">'
      + '<div class="admin-user-name activation-code-text">' + esc(c.code) + '</div>'
      + '<div class="admin-user-loginId">状态: ' + statusLabel + '</div>'
      + '<div class="admin-user-role">创建: ' + esc(c.created_by || '-') + ' · ' + fmtTime(c.created_at) + notePart + '</div>'
      + usedInfo + revokedInfo
      + '</div>'
      + '<div class="admin-user-actions">' + copyBtn + revokeBtn + '</div>'
      + '</div>';
  }).join('');
}

function revokeActivationCode(code) {
  const reason = prompt('作废原因（可留空，将记入操作日志）', '');
  if (reason === null) return;
  showConfirm('确定作废激活码 ' + code + ' ？作废后该码永久失效；已被使用的码无法作废。', async function () {
    try {
      const res = await api('/api/admin/activation-codes/revoke', {
        method: 'POST',
        body: { code: code, reason: reason }
      });
      if (res.ok) {
        const data = await res.json();
        toast(data.message || '已作废 ' + code, 'success');
        loadActivationCodesPanel();
      } else {
        const e = await res.json().catch(() => ({}));
        toast(e.error || e.message || '作废失败', 'error');
      }
    } catch (err) {
      if (isApiHandledError(err)) return;
      toast('作废失败: ' + err.message, 'error');
    }
  });
}
