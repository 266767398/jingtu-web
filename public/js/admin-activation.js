// admin-activation.js —— 后台「激活码管理」面板（列表 / 统计 / 生成 / 作废）
// 依赖：core.js（api/toast/showConfirm/copyToClipboard/fmtTime/esc/escAttr/renderEmpty/isApiHandledError/__）
// 说明：生成复用 admin-users.js 的 showGenerateCodesModal()；作废走 /api/admin/activation-codes/revoke

let _activationCodes = [];
let _activationPanelBound = false;

function isActivationCodeExpired(c) {
  return !!(c && c.expires_at && !c.used && !c.revoked && new Date(c.expires_at).getTime() <= Date.now());
}

const EXPIRING_SOON_MS = 7 * 24 * 60 * 60 * 1000;

function isActivationCodeExpiringSoon(c) {
  return !!(c && c.expires_at && !c.used && !c.revoked && !isActivationCodeExpired(c)
    && new Date(c.expires_at).getTime() - Date.now() < EXPIRING_SOON_MS);
}

function filterActivationCodes(kw, status) {
  let list = _activationCodes.slice().reverse();
  if (status === 'unused') list = list.filter(function (c) { return !c.used && !c.revoked && !isActivationCodeExpired(c); });
  else if (status === 'used') list = list.filter(function (c) { return c.used; });
  else if (status === 'revoked') list = list.filter(function (c) { return c.revoked; });
  else if (status === 'expired') list = list.filter(isActivationCodeExpired);
  if (kw) {
    list = list.filter(function (c) {
      return c.code.indexOf(kw) !== -1
        || String(c.note || '').toUpperCase().indexOf(kw) !== -1
        || String(c.created_by || '').toUpperCase().indexOf(kw) !== -1;
    });
  }
  return list;
}

function initActivationPanelEvents() {
  if (_activationPanelBound) return;
  _activationPanelBound = true;
  const genBtn = document.getElementById('activationGenCodesBtn');
  if (genBtn) genBtn.addEventListener('click', function () {
    if (typeof showGenerateCodesModal === 'function') showGenerateCodesModal();
    else toast(__('admin.activation.gen_modal_not_ready'), 'error');
  });
  const refreshBtn = document.getElementById('activationRefreshBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', function () { loadActivationCodesPanel(); });
  const copyUnusedBtn = document.getElementById('activationCopyUnusedBtn');
  if (copyUnusedBtn) copyUnusedBtn.addEventListener('click', copyUnusedActivationCodes);
  const exportBtn = document.getElementById('activationExportBtn');
  if (exportBtn) exportBtn.addEventListener('click', exportActivationCodesCsv);
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
  if (container) container.innerHTML = '<div class="text-13 text-muted">' + __('common.loading') + '</div>';
  try {
    const res = await api('/api/admin/activation-codes', { method: 'GET' });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(errText(e) || (__('common.load_failed') + ' (' + res.status + ')'));
    }
    const data = await res.json();
    _activationCodes = data.codes || [];
    renderActivationStats(data);
    renderActivationCodes();
  } catch (err) {
    if (isApiHandledError(err)) return;
    if (container) container.innerHTML = '';
    toast(__('admin.activation.load_fail') + err.message, 'error');
  }
}

function renderActivationStats(data) {
  const el = document.getElementById('activationCodeStats');
  if (!el) return;
  const items = [
    [__('admin.activation.stat_total'), data.total],
    [__('admin.activation.status_unused'), data.unused],
    [__('admin.activation.status_used'), data.used],
    [__('admin.activation.status_revoked'), data.revoked || 0],
    [__('admin.activation.status_expired'), data.expired || 0]
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
  const list = filterActivationCodes(kw, status);
  if (!list.length) {
    renderEmpty(container, { icon: '🎟', text: __('admin.activation.no_match') });
    return;
  }
  container.innerHTML = list.map(function (c) {
    let statusLabel = __('admin.activation.status_unused');
    if (c.used) statusLabel = __('admin.activation.status_used');
    else if (c.revoked) statusLabel = __('admin.activation.status_revoked');
    else if (isActivationCodeExpired(c)) statusLabel = __('admin.activation.status_expired');
    else if (isActivationCodeExpiringSoon(c)) statusLabel = __('admin.activation.status_unused_expiring');
    const codeEsc = escAttr(c.code);
    const notePart = c.note ? ' · ' + esc(c.note) : '';
    const usedInfo = c.used
      ? '<div class="admin-user-status">' + __('admin.activation.used_by') + ' ' + esc(c.used_by || '-') + ' · ' + fmtTime(c.used_at) + '</div>'
      : '';
    const revokedInfo = c.revoked
      ? '<div class="admin-user-status">' + __('admin.activation.revoked_by') + ' ' + esc(c.revoked_by || '-') + ' · ' + fmtTime(c.revoked_at)
        + (c.revoked_reason ? ' · ' + __('admin.activation.reason') + ' ' + esc(c.revoked_reason) : '') + '</div>'
      : '';
    const expiresInfo = (!c.used && !c.revoked && c.expires_at)
      ? '<div class="admin-user-status">' + __('admin.activation.expires_at') + ' ' + fmtTime(c.expires_at)
        + (isActivationCodeExpired(c) ? '<span style="color:#f87171">' + __('admin.activation.expired_badge') + '</span>' : '')
        + (isActivationCodeExpiringSoon(c) ? '<span style="color:#f59e0b">' + __('admin.activation.expiring_badge') + '</span>' : '')
        + '</div>'
      : '';
    const revokeBtn = (!c.used && !c.revoked)
      ? '<button class="btn btn-sm btn-danger" data-code-action="revoke" data-code="' + codeEsc + '">🚫 ' + __('admin.activation.revoke_btn') + '</button>'
      : '';
    const copyBtn = '<button class="btn btn-sm btn-outline" data-code-action="copy" data-code="' + codeEsc + '">📋 ' + __('admin.activation.copy_btn') + '</button>';
    return '<div class="admin-user-card">'
      + '<div class="admin-user-info">'
      + '<div class="admin-user-name activation-code-text">' + esc(c.code) + '</div>'
      + '<div class="admin-user-loginId">' + __('admin.activation.status_label') + ' ' + statusLabel + '</div>'
      + '<div class="admin-user-role">' + __('admin.activation.created_by') + ' ' + esc(c.created_by || '-') + ' · ' + fmtTime(c.created_at) + notePart + '</div>'
      + usedInfo + revokedInfo + expiresInfo
      + '</div>'
      + '<div class="admin-user-actions">' + copyBtn + revokeBtn + '</div>'
      + '</div>';
  }).join('');
}

function revokeActivationCode(code) {
  const reason = prompt(__('admin.activation.revoke_reason_prompt'), '');
  if (reason === null) return;
  showConfirm(__('admin.activation.revoke_confirm', { code: code }), async function () {
    try {
      const res = await api('/api/admin/activation-codes/revoke', {
        method: 'POST',
        body: { code: code, reason: reason }
      });
      if (res.ok) {
        const data = await res.json();
        toast(data.message || __('admin.activation.revoked_ok', { code: code }), 'success');
        loadActivationCodesPanel();
      } else {
        const e = await res.json().catch(() => ({}));
        toast(errText(e) || __('admin.activation.revoke_fail'), 'error');
      }
    } catch (err) {
      if (isApiHandledError(err)) return;
      toast(__('admin.activation.revoke_fail_prefix') + err.message, 'error');
    }
  });
}

function copyUnusedActivationCodes() {
  const codes = _activationCodes
    .filter(function (c) { return !c.used && !c.revoked && !isActivationCodeExpired(c); })
    .map(function (c) { return c.code; });
  if (!codes.length) {
    toast(__('admin.activation.no_unused_to_copy'), 'warn');
    return;
  }
  copyToClipboard(codes.join('\r\n')).then(function () {
    toast(__('admin.activation.copied_n', { n: codes.length }), 'success');
  });
}

function activationCodeStatusText(c) {
  if (c.used) return __('admin.activation.status_used');
  if (c.revoked) return __('admin.activation.status_revoked');
  if (isActivationCodeExpired(c)) return __('admin.activation.status_expired');
  if (isActivationCodeExpiringSoon(c)) return __('admin.activation.status_unused_expiring2');
  return __('admin.activation.status_unused');
}

function exportActivationCodesCsv() {
  const kw = (document.getElementById('activationCodeSearch')?.value || '').trim().toUpperCase();
  const status = document.getElementById('activationCodeStatusFilter')?.value || '';
  const list = filterActivationCodes(kw, status);
  if (!list.length) {
    toast(__('admin.activation.no_export'), 'warn');
    return;
  }
  const fmtTimePlain = function (t) { return String(t || '').replace('T', ' ').slice(0, 19); };
  const head = [
    __('admin.activation.csv_code'), __('admin.activation.csv_status'), __('admin.activation.csv_note'),
    __('admin.activation.csv_creator'), __('admin.activation.csv_created_at'), __('admin.activation.csv_expires'),
    __('admin.activation.csv_user'), __('admin.activation.csv_used_at')
  ];
  const rows = list.map(function (c) {
    return [
      c.code,
      activationCodeStatusText(c),
      c.note || '',
      c.created_by || '',
      fmtTimePlain(c.created_at),
      c.expires_at ? fmtTimePlain(c.expires_at) : __('admin.activation.permanent'),
      c.used_by || '',
      fmtTimePlain(c.used_at)
    ];
  });
  const csv = '\uFEFF' + [head].concat(rows).map(function (r) {
    return r.map(function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; }).join(',');
  }).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'activation-codes-' + new Date().toISOString().slice(0, 10) + '.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  toast(__('admin.activation.exported_n', { n: list.length }), 'success');
}
