// ==================== 模型收藏馆管理（后台） ====================
(function () {
  'use strict';
  let mcAdminBound = false;
  let mcInvalidPage = 1;
  let mcCurrentUserId = null;

  function statusBadge(status) {
    if (status === 'valid') return '<span class="badge badge-valid">' + __('model_coll.status_valid') + '</span>';
    if (status === 'invalid') return '<span class="badge badge-invalid">' + __('model_coll.status_invalid') + '</span>';
    return '<span class="badge badge-unknown">' + __('model_coll.status_unknown') + '</span>';
  }

  function loadAdminModelCollections() {
    loadMcAdminStats();
    loadInvalidList(1);
  }

  // 统一的模型收藏馆管理刷新入口：统计 + 全站失效列表 + 当前用户详情一起重载。
  // 任何删除/编辑/扫描操作后调用，确保三处视图始终与后端真实状态一致，
  // 杜绝__('auto_admin_model_collections_1')导致的前后状态不同步。
  function refreshMcAdmin() {
    loadMcAdminStats();
    loadInvalidList(mcInvalidPage);
    if (mcCurrentUserId) loadUserModelCollections(mcCurrentUserId);
  }

  async function loadMcAdminStats() {
    try {
      const res = await api('/api/collections/admin/stats', { method: 'GET' });
      if (!res.ok) return;
      const d = await res.json();
      const s = d.summary || {};
      const el = document.getElementById('mcAdminStats');
      if (el) el.innerHTML = `
        <div class="mc-stat"><span class="mc-stat-val">${s.total || 0}</span><span class="mc-stat-label" data-i18n="model_coll.count">收藏总数</span></div>
        <div class="mc-stat"><span class="mc-stat-val text-green">${s.valid || 0}</span><span class="mc-stat-label" data-i18n="model_coll.valid_count">有效</span></div>
        <div class="mc-stat"><span class="mc-stat-val text-red">${s.invalid || 0}</span><span class="mc-stat-label" data-i18n="model_coll.invalid_count">已失效</span></div>
        <div class="mc-stat"><span class="mc-stat-val text-muted2">${s.unknown || 0}</span><span class="mc-stat-label" data-i18n="model_coll.unknown_count">未检测</span></div>
        <div class="mc-stat"><span class="mc-stat-val">${d.userCount || 0}</span><span class="mc-stat-label" data-i18n="model_coll.user_count">收藏用户数</span></div>`;
    } catch (e) { /* 忽略 */ }
  }

  async function loadInvalidList(page) {
    mcInvalidPage = page || 1;
    try {
      const params = new URLSearchParams();
      params.set('page', mcInvalidPage);
      params.set('pageSize', '30');
      const res = await api('/api/collections/admin/invalid?' + params.toString(), { method: 'GET' });
      if (!res.ok) return;
      const d = await res.json();
      const el = document.getElementById('mcAdminInvalidList');
      if (!el) return;
      if (!d.items || d.items.length === 0) { el.innerHTML = `<div class="text-muted2 text-13 p-16">${__('model_coll.no_invalid')}</div>`; return; }
      el.innerHTML = d.items.map(r => `
        <div class="mc-card" data-mc-invalid-id="${r.id}">
          <img class="mc-thumb" src="${escAttr(r.thumbnailUrl || '/api/avatar/default')}" alt="${escAttr(r.modelName)}" onerror="this.src='/api/avatar/default'">
          <div class="mc-info">
            <div class="mc-name">${esc(r.modelName || r.modelId)}</div>
            <div class="mc-meta">${esc(r.modelId)}</div>
            <div class="mc-meta text-13 text-red">${esc(r.invalidReason || '')}</div>
            <div class="mc-meta text-13 text-muted2">${__('model_coll.owner')}: ${esc(r.ownerName || r.ownerVrcName || '-')}</div>
          </div>
          <div class="mc-actions">
            <button class="btn btn-sm btn-danger" data-mc-invalid-del="${r.id}">${__('model_coll.delete')}</button>
          </div>
        </div>`).join('');
      renderInvalidPagination(d);
    } catch (e) { /* 忽略 */ }
  }

  function renderInvalidPagination(d) {
    const el = document.getElementById('mcAdminInvalidPagination');
    if (!el) return;
    const pages = Math.ceil((d.total || 0) / (d.pageSize || 30)) || 1;
    if (pages <= 1) { el.innerHTML = ''; return; }
    let html = '';
    for (let p = 1; p <= pages; p++) html += `<button class="pg-btn ${p === mcInvalidPage ? 'active' : ''}" data-mc-invalid-page="${p}">${p}</button>`;
    el.innerHTML = html;
  }

  async function lookupUser() {
    const q = (document.getElementById('mcAdminUserSearch').value || '').trim();
    if (!q) { toast(__('model_coll.enter_user'), 'error'); return; }
    try {
      const params = new URLSearchParams();
      params.set('search', q);
      params.set('pageSize', '20');
      const res = await api('/api/admin/users?' + params.toString(), { method: 'GET' });
      if (!res.ok) return;
      const d = await res.json();
      const matches = d.users || [];
      const box = document.getElementById('mcAdminUserMatches');
      if (!box) return;
      box.classList.remove('d-none');
      if (matches.length === 0) { box.innerHTML = `<div class="text-muted2 text-13">${__('model_coll.no_user_match')}</div>`; return; }
      box.innerHTML = matches.map(u => `
        <div class="admin-user-row" data-mc-user-id="${u.id}" style="cursor:pointer">
          <span>${esc(u.display_name || u.login_id)}</span>
          <span class="text-13 text-muted2">${esc(u.login_id || '')} ${u.vrchat_name ? '· ' + esc(u.vrchat_name) : ''}</span>
        </div>`).join('');
    } catch (e) { if (isApiHandledError(e)) return; toast(e.message, 'error'); }
  }

  async function loadUserModelCollections(userId) {
    mcCurrentUserId = userId;
    try {
      const res = await api('/api/collections/admin/user/' + userId, { method: 'GET' });
      if (!res.ok) { const d = await res.json().catch(() => ({})); toast(d.error || __('model_coll.load_failed'), 'error'); return; }
      const d = await res.json();
      const u = d.user || {};
      const s = d.summary || {};
      const box = document.getElementById('mcAdminUserDetail');
      if (!box) return;
      box.classList.remove('d-none');
      box.innerHTML = `
        <div class="mc-admin-user-head">
          <div><b>${esc(u.display_name || u.login_id)}</b> <span class="text-13 text-muted2">(${esc(u.login_id || '')})</span></div>
          <div class="mc-summary mt-8">
            <div class="mc-stat"><span class="mc-stat-val">${s.total || 0}</span><span class="mc-stat-label" data-i18n="model_coll.count">收藏总数</span></div>
            <div class="mc-stat"><span class="mc-stat-val text-green">${s.valid || 0}</span><span class="mc-stat-label" data-i18n="model_coll.valid_count">有效</span></div>
            <div class="mc-stat"><span class="mc-stat-val text-red">${s.invalid || 0}</span><span class="mc-stat-label" data-i18n="model_coll.invalid_count">已失效</span></div>
            <div class="mc-stat"><span class="mc-stat-val text-muted2">${s.unknown || 0}</span><span class="mc-stat-label" data-i18n="model_coll.unknown_count">未检测</span></div>
          </div>
          <div class="flex-row gap-8 mt-8 flex-wrap">
            <button class="btn btn-sm btn-outline" data-mc-user-scan="${userId}">🔄 ${__('model_coll.admin_scan_user')}</button>
            <button class="btn btn-sm btn-danger" data-mc-user-delall="${userId}">🗑️ ${__('model_coll.admin_delete_user_all')}</button>
          </div>
        </div>
        <div id="mcAdminUserCollList" class="model-coll-list mt-8"></div>`;
      const listEl = document.getElementById('mcAdminUserCollList');
      if (listEl) {
        if (!d.collections || d.collections.length === 0) listEl.innerHTML = `<div class="text-muted2 text-13 p-16">${__('model_coll.empty')}</div>`;
        else listEl.innerHTML = d.collections.map(r => `
          <div class="mc-card">
            <img class="mc-thumb" src="${escAttr(r.thumbnailUrl || '/api/avatar/default')}" alt="${escAttr(r.modelName)}" onerror="this.src='/api/avatar/default'">
            <div class="mc-info">
              <div class="mc-name">${esc(r.modelName || r.modelId)} ${r.isRecommended ? '⭐' : ''}</div>
              <div class="mc-meta">${esc(r.modelId)}</div>
              <div class="mc-meta">${statusBadge(r.status)} ${r.invalidReason ? `<span class="text-13 text-red">${esc(r.invalidReason)}</span>` : ''}</div>
              ${r.notes ? `<div class="mc-meta text-13 text-muted2">${__('model_coll.notes')}: ${esc(r.notes)}</div>` : ''}
            </div>
            <div class="mc-actions">
              <button class="btn btn-sm btn-outline" data-mc-user-edit="${r.id}">${__('edit')}</button>
              <button class="btn btn-sm btn-danger" data-mc-user-del="${r.id}">${__('model_coll.delete')}</button>
            </div>
          </div>`).join('');
      }
    } catch (e) { if (isApiHandledError(e)) return; toast(__('model_coll.load_failed') + ': ' + e.message, 'error'); }
  }

  async function deleteCollection(id) {
    showConfirm(__('model_coll.delete_confirm'), async () => {
      try {
        const res = await api('/api/collections/admin/' + id, { method: 'DELETE' });
        if (res.ok) { toast(__('model_coll.deleted'), 'success'); refreshMcAdmin(); }
        else { const d = await res.json().catch(() => ({})); toast(d.error || __('model_coll.delete_failed'), 'error'); }
      } catch (e) { if (isApiHandledError(e)) return; toast(__('model_coll.delete_failed') + ': ' + e.message, 'error'); }
    });
  }

  async function editCollectionNotes(id) {
    showInput(__('model_coll.edit_notes'), '', async (val) => {
      try {
        const res = await api('/api/collections/' + id, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ notes: val || '' })
        });
        if (res.ok) { toast(__('model_coll.updated'), 'success'); refreshMcAdmin(); }
        else { const d = await res.json().catch(() => ({})); toast(d.error || __('model_coll.update_failed'), 'error'); }
      } catch (e) { if (isApiHandledError(e)) return; toast(__('model_coll.update_failed') + ': ' + e.message, 'error'); }
    });
  }

  async function deleteUserAll(userId) {
    showConfirm(__('model_coll.admin_delete_user_all_confirm'), async () => {
      try {
        const res = await api('/api/collections/admin/user/' + userId, { method: 'DELETE' });
        if (res.ok) { const d = await res.json(); toast(__('model_coll.admin_deleted_n', { n: d.deleted || 0 }), 'success'); refreshMcAdmin(); }
        else { const d = await res.json().catch(() => ({})); toast(d.error || __('model_coll.delete_failed'), 'error'); }
      } catch (e) { if (isApiHandledError(e)) return; toast(__('model_coll.delete_failed'), 'error'); }
    });
  }

  async function scanUser(userId) {
    toast(__('model_coll.scanning'), 'info');
    try {
      const res = await api('/api/collections/admin/user/' + userId + '/scan', { method: 'POST' });
      if (res.ok) { const d = await res.json(); toast(__('model_coll.scan_done', { n: d.scanned || 0, m: d.newlyInvalid || 0 }), 'success'); refreshMcAdmin(); }
      else { const d = await res.json().catch(() => ({})); toast(d.error || __('model_coll.scan_fail'), 'error'); }
    } catch (e) { if (isApiHandledError(e)) return; toast(__('model_coll.scan_fail') + ': ' + e.message, 'error'); }
  }

  async function scanAll() {
    toast(__('model_coll.scanning'), 'info');
    try {
      const res = await api('/api/collections/admin/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ batchSize: 200 }) });
      if (res.ok) { const d = await res.json(); toast(__('model_coll.scan_done', { n: d.scanned || 0, m: d.newlyInvalid || 0 }), 'success'); refreshMcAdmin(); }
      else { const d = await res.json().catch(() => ({})); toast(d.error || __('model_coll.scan_fail'), 'error'); }
    } catch (e) { if (isApiHandledError(e)) return; toast(__('model_coll.scan_fail') + ': ' + e.message, 'error'); }
  }

  async function deleteAllInvalid() {
    showConfirm(__('model_coll.admin_delete_invalid_confirm'), async () => {
      try {
        const res = await api('/api/collections/admin/invalid?pageSize=500', { method: 'GET' });
        if (!res.ok) return;
        const d = await res.json();
        const items = d.items || [];
        let deleted = 0;
        for (const it of items) {
          const r = await api('/api/collections/admin/' + it.id, { method: 'DELETE' });
          if (r.ok) deleted++;
        }
        toast(__('model_coll.admin_deleted_n', { n: deleted }), 'success');
        refreshMcAdmin();
      } catch (e) { if (isApiHandledError(e)) return; toast(e.message, 'error'); }
    });
  }

  function bindMcAdminEvents() {
    if (mcAdminBound) return;
    mcAdminBound = true;

    const lookupBtn = document.getElementById('mcAdminUserLookupBtn');
    if (lookupBtn) lookupBtn.addEventListener('click', lookupUser);
    const searchInput = document.getElementById('mcAdminUserSearch');
    if (searchInput) searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') lookupUser(); });

    const scanBtn = document.getElementById('mcAdminScanBtn');
    if (scanBtn) scanBtn.addEventListener('click', scanAll);
    const delAllBtn = document.getElementById('mcAdminDeleteAllInvalidBtn');
    if (delAllBtn) delAllBtn.addEventListener('click', deleteAllInvalid);

    const matches = document.getElementById('mcAdminUserMatches');
    if (matches) matches.addEventListener('click', (e) => {
      const row = e.target.closest('[data-mc-user-id]');
      if (row) { loadUserModelCollections(parseInt(row.dataset.mcUserId)); matches.classList.add('d-none'); }
    });

    const detail = document.getElementById('mcAdminUserDetail');
    if (detail) detail.addEventListener('click', (e) => {
      const t = e.target;
      if (t.dataset.mcUserScan) scanUser(parseInt(t.dataset.mcUserScan));
      else if (t.dataset.mcUserDelall) deleteUserAll(parseInt(t.dataset.mcUserDelall));
      else if (t.dataset.mcUserDel) deleteCollection(parseInt(t.dataset.mcUserDel));
      else if (t.dataset.mcUserEdit) editCollectionNotes(parseInt(t.dataset.mcUserEdit));
    });

    const invalidList = document.getElementById('mcAdminInvalidList');
    if (invalidList) invalidList.addEventListener('click', (e) => {
      const b = e.target.closest('[data-mc-invalid-del]');
      if (b) deleteCollection(parseInt(b.dataset.mcInvalidDel));
    });
    const invalidPg = document.getElementById('mcAdminInvalidPagination');
    if (invalidPg) invalidPg.addEventListener('click', (e) => {
      const b = e.target.closest('[data-mc-invalid-page]');
      if (b) loadInvalidList(parseInt(b.dataset.mcInvalidPage));
    });
  }

  // 暴露给 switchTab
  window.loadAdminModelCollections = loadAdminModelCollections;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindMcAdminEvents);
  else bindMcAdminEvents();

  function isApiHandledError(err) {
    return err && (err.message === 'FORBIDDEN' || err.message === 'RATE_LIMITED' || err.message === 'SERVER_ERROR');
  }
})();
