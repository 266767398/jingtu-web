// ==================== Webhook 通知管理（后台） ====================
// 依赖：core.js（api / toast / showConfirm / esc / escAttr / errText / isApiHandledError）
// 后端：server/routes/webhooks.js —— /api/admin/webhooks 六个端点
// 说明：密钥在列表端仅展示掩码（前4位+****）；编辑/新增时留空密钥表示不修改/不设置。
(function () {
  'use strict';
  let whBound = false;
  let whEvents = [];
  let whList = [];
  let whEditId = null;

  async function loadAdminWebhooks() {
    try {
      const eventsRes = await api('/api/admin/webhooks/events', { method: 'GET' });
      if (eventsRes.ok) {
        const ed = await eventsRes.json();
        whEvents = ed.events || [];
      }
      const res = await api('/api/admin/webhooks', { method: 'GET' });
      if (!res.ok) return;
      const d = await res.json();
      whList = d.webhooks || [];
      renderWebhookList(whList);
      renderWhEventBox(whEditId ? null : new Set());
    } catch (e) {
      const box = document.getElementById('adminWebhookList');
      if (box) box.innerHTML = '<p class="text-13 text-red">' + __('auto_admin_wh_7') + '</p>';
    }
  }

  function renderWhEventBox(selected) {
    const box = document.getElementById('whEventBox');
    if (!box) return;
    selected = selected || new Set();
    box.innerHTML = '<div class="text-13 text-muted2 mb-4">' + __('auto_admin_wh_34') + '</div>' +
      '<div class="flex-row gap-4 flex-wrap">' +
      whEvents.map((ev) =>
        '<label class="wh-evt-label"><input type="checkbox" value="' + escAttr(ev) + '"' + (selected.has(ev) ? ' checked' : '') + '> ' + esc(ev) + '</label>'
      ).join('') +
      '</div>';
  }

  function renderWebhookList(list) {
    const el = document.getElementById('adminWebhookList');
    if (!el) return;
    if (!list || list.length === 0) {
      el.innerHTML = '<div class="text-muted2 text-13 p-16">' + __('auto_admin_wh_5') + '</div>';
      return;
    }
    el.innerHTML = list.map((w) => {
      const evs = (w.events || '').split(',');
      const evChips = evs
        .filter(Boolean)
        .map((e) => '<span class="badge badge-valid">' + esc(e) + '</span>')
        .join(' ') || '-';
      return '<div class="admin-user-card">' +
        '<span class="admin-user-avatar" style="display:flex;align-items:center;justify-content:center;font-size:18px">🔗</span>' +
        '<div class="admin-user-info">' +
        '<div class="admin-user-name">' + esc(w.url) + '</div>' +
        '<div class="admin-user-meta">' + evChips + '</div>' +
        '<div class="admin-user-meta">' + __('auto_admin_wh_10') + ': ' + esc(w.secret || '-') + ' · ' + __('auto_admin_wh_12') + ': ' + esc(fmtDateTime(w.created_at) || '-') + '</div>' +
        '</div>' +
        '<div class="admin-user-actions">' +
        '<span class="badge ' + (w.enabled ? 'badge-live' : 'badge-ended') + '">' + (w.enabled ? __('auto_admin_wh_11') : __('auto_admin_wh_36')) + '</span>' +
        '<button type="button" class="btn btn-sm btn-outline" data-wh-test="' + escAttr(w.id) + '">📡 ' + __('auto_admin_wh_13') + '</button>' +
        '<button type="button" class="btn btn-sm btn-outline" data-wh-enable="' + escAttr(w.id) + '" data-wh-cur="' + (w.enabled ? '1' : '0') + '">' + (w.enabled ? __('auto_admin_wh_37') : __('auto_admin_wh_38')) + '</button>' +
        '<button type="button" class="btn btn-sm btn-outline" data-wh-edit="' + escAttr(w.id) + '">✏️ ' + __('auto_admin_wh_14') + '</button>' +
        '<button type="button" class="btn btn-sm btn-danger" data-wh-del="' + escAttr(w.id) + '">🗑 ' + __('auto_admin_wh_15') + '</button>' +
        '</div></div>';
    }).join('');
  }

  function openWebhookForm(id) {
    whEditId = id || null;
    const form = document.getElementById('adminWebhookForm');
    if (!form) return;
    form.classList.remove('d-none');
    const urlEl = document.getElementById('whUrl');
    const secretEl = document.getElementById('whSecret');
    const titleEl = document.getElementById('whFormTitle');
    if (!urlEl || !secretEl) return;
    if (whEditId) {
      if (titleEl) titleEl.textContent = __('auto_admin_wh_28');
      urlEl.value = '';
      // 编辑时必须清空密钥输入框：否则上次把玩时残留的字符会在保存时被
      // collectWhForm 当新密钥提交，直接顶掉已加密入库的原密钥。
      secretEl.value = '';
      secretEl.placeholder = __('auto_admin_wh_30');
      const w = whList.find((x) => String(x.id) === String(whEditId));
      if (w) {
        urlEl.value = w.url || '';
        const cur = new Set(String(w.events || '').split(',').filter(Boolean));
        renderWhEventBox(cur);
      } else {
        renderWhEventBox(new Set());
      }
    } else {
      if (titleEl) titleEl.textContent = __('auto_admin_wh_35');
      urlEl.value = '';
      secretEl.value = '';
      secretEl.placeholder = __('auto_admin_wh_40');
      renderWhEventBox(new Set());
    }
  }

  function closeWebhookForm() {
    whEditId = null;
    const form = document.getElementById('adminWebhookForm');
    if (form) form.classList.add('d-none');
  }

  function collectWhForm() {
    const urlEl = document.getElementById('whUrl');
    const secretEl = document.getElementById('whSecret');
    const url = (urlEl ? urlEl.value : '').trim();
    if (!url) { toast(__('auto_admin_wh_19'), 'error'); return null; }
    const evs = Array.from(document.querySelectorAll('#whEventBox input[type="checkbox"]:checked')).map((c) => c.value);
    if (evs.length === 0) { toast(__('auto_admin_wh_20'), 'error'); return null; }
    const payload = { url, events: evs };
    const secret = secretEl ? secretEl.value.trim() : '';
    if (secret) payload.secret = secret;
    return payload;
  }

  async function saveWebhook() {
    const payload = collectWhForm();
    if (!payload) return;
    try {
      let res;
      if (whEditId) {
        res = await api('/api/admin/webhooks/' + encodeURIComponent(whEditId), {
          method: 'PUT',
          body: payload
        });
      } else {
        res = await api('/api/admin/webhooks', {
          method: 'POST',
          body: payload
        });
      }
      if (res.ok) {
        toast(whEditId ? __('auto_admin_wh_23') : __('auto_admin_wh_21'), 'success');
        closeWebhookForm();
        loadAdminWebhooks();
      } else {
        const d = await res.json().catch(() => ({}));
        toast(errText(d) || (whEditId ? __('auto_admin_wh_24') : __('auto_admin_wh_22')), 'error');
      }
    } catch (e) { if (isApiHandledError(e)) return; toast((whEditId ? __('auto_admin_wh_24') : __('auto_admin_wh_22')) + ': ' + e.message, 'error'); }
  }

  async function testWebhook(id) {
    toast(__('auto_admin_wh_25'), 'info');
    try {
      const res = await api('/api/admin/webhooks/' + encodeURIComponent(id) + '/test', { method: 'POST' });
      const d = await res.json().catch(() => ({}));
      if (d && d.success === true) { toast(__('auto_admin_wh_26'), 'success'); }
      else { toast(errText(d) || __('auto_admin_wh_27'), 'error'); }
    } catch (e) { if (isApiHandledError(e)) return; toast(__('auto_admin_wh_27') + ': ' + e.message, 'error'); }
  }

  async function toggleWebhook(id, curEnabled) {
    try {
      const res = await api('/api/admin/webhooks/' + encodeURIComponent(id), {
        method: 'PUT',
        body: { enabled: curEnabled ? 0 : 1 }
      });
      if (res.ok) { loadAdminWebhooks(); }
      else { const d = await res.json().catch(() => ({})); toast(errText(d) || __('auto_admin_wh_24'), 'error'); }
    } catch (e) { if (isApiHandledError(e)) return; toast(__('auto_admin_wh_24') + ': ' + e.message, 'error'); }
  }

  function deleteWebhook(id) {
    showConfirm(__('auto_admin_wh_16'), async () => {
      try {
        const res = await api('/api/admin/webhooks/' + encodeURIComponent(id), { method: 'DELETE' });
        if (res.ok) { toast(__('auto_admin_wh_17'), 'success'); loadAdminWebhooks(); }
        else { const d = await res.json().catch(() => ({})); toast(errText(d) || __('auto_admin_wh_18'), 'error'); }
      } catch (e) { if (isApiHandledError(e)) return; toast(__('auto_admin_wh_18') + ': ' + e.message, 'error'); }
    });
  }

  function bindWebhookEvents() {
    if (whBound) return;
    whBound = true;

    const addBtn = document.getElementById('adminWebhookAddBtn');
    if (addBtn) addBtn.addEventListener('click', () => openWebhookForm(null));
    const refreshBtn = document.getElementById('adminWebhookRefreshBtn');
    if (refreshBtn) refreshBtn.addEventListener('click', loadAdminWebhooks);
    const saveBtn = document.getElementById('whSaveBtn');
    if (saveBtn) saveBtn.addEventListener('click', saveWebhook);
    const cancelBtn = document.getElementById('whCancelBtn');
    if (cancelBtn) cancelBtn.addEventListener('click', closeWebhookForm);

    const list = document.getElementById('adminWebhookList');
    if (list) list.addEventListener('click', (e) => {
      const test = e.target.closest('[data-wh-test]');
      if (test) { testWebhook(test.dataset.whTest); return; }
      const enable = e.target.closest('[data-wh-enable]');
      if (enable) { toggleWebhook(enable.dataset.whEnable, enable.dataset.whCur === '1'); return; }
      const ed = e.target.closest('[data-wh-edit]');
      if (ed) { openWebhookForm(ed.dataset.whEdit); return; }
      const del = e.target.closest('[data-wh-del]');
      if (del) deleteWebhook(del.dataset.whDel);
    });
  }

  function initAdminWebhooksEvents() {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindWebhookEvents);
    else bindWebhookEvents();
  }

  // 暴露给 admin-ui.js PANEL_LOADERS / switchTab
  window.loadAdminWebhooks = loadAdminWebhooks;
  window.initAdminWebhooksEvents = initAdminWebhooksEvents;

  initAdminWebhooksEvents();
})();