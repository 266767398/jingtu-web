// ==================== 文件存放管理（后台） ====================
// 依赖：core.js（api / toast / showConfirm / showInput / esc / escAttr / errText / isApiHandledError）
// 后端：server/routes/files.js —— GET/DELETE /api/admin/files* 六个端点
// 说明：upload 目录列表在客户端筛选 + 分页；删除/重命名/下载均按相对路径（含子目录）操作。
(function () {
  'use strict';
  let filesBound = false;
  let filesAll = [];
  let filesPage = 1;
  let filesPageSize = 50;
  let filesKeyword = '';

  function filesMatch(f) {
    if (!filesKeyword) return true;
    return (f.path || f.name || '').toLowerCase().indexOf(filesKeyword) !== -1;
  }

  function fmtDate(s) {
    if (!s) return '-';
    try { return new Date(s).toLocaleString(); } catch (e) { return s; }
  }

  async function loadAdminFiles() {
    try {
      const res = await api('/api/admin/files', { method: 'GET' });
      if (!res.ok) return;
      const d = await res.json();
      filesAll = d.files || [];
      const statsEl = document.getElementById('adminFilesStats');
      if (statsEl) {
        statsEl.innerHTML =
          '<div class="stat-card"><div class="stat-value">' + (d.total || 0) + '</div><div class="stat-label">' + __('auto_admin_files_3') + '</div></div>' +
          '<div class="stat-card"><div class="stat-value">' + esc(d.totalSize || '0 KB') + '</div><div class="stat-label">' + __('auto_admin_files_4') + '</div></div>';
      }
      renderAdminFiles();
    } catch (e) {
      const box = document.getElementById('adminFilesList');
      if (box) box.innerHTML = '<p class="text-13 text-red">' + __('auto_admin_files_12') + '</p>';
    }
  }

  function renderAdminFiles() {
    const listEl = document.getElementById('adminFilesList');
    if (!listEl) return;
    const filtered = filesAll.filter(filesMatch);
    const total = filtered.length;
    filesPage = Math.min(filesPage, Math.max(1, Math.ceil(total / filesPageSize)));
    const start = (filesPage - 1) * filesPageSize;
    const items = filtered.slice(start, start + filesPageSize);
    if (total === 0) {
      listEl.innerHTML = '<div class="text-muted2 text-13 p-16">' + __('auto_admin_files_10') + '</div>';
    } else {
      listEl.innerHTML = items.map((f) => {
        const rel = f.path || f.name || '';
        return '<div class="admin-user-card">' +
          '<span class="admin-user-avatar" style="display:flex;align-items:center;justify-content:center;font-size:18px">📄</span>' +
          '<div class="admin-user-info">' +
          '<div class="admin-user-name">' + esc(rel) + '</div>' +
          '<div class="admin-user-meta">' + esc(f.sizeFormatted || (f.size + ' B')) + ' · ' + __('auto_admin_files_20') + ': ' + esc(f.type || 'FILE') + ' · ' + __('auto_admin_files_21') + ': ' + esc(fmtDate(f.modifiedAt)) + '</div>' +
          '</div>' +
          '<div class="admin-user-actions">' +
          '<button type="button" class="btn btn-sm btn-outline" data-f-download="' + escAttr(rel) + '">⬇️ ' + __('auto_admin_files_16') + '</button>' +
          '<button type="button" class="btn btn-sm btn-outline" data-f-rename="' + escAttr(rel) + '">✏️ ' + __('auto_admin_files_17') + '</button>' +
          '<button type="button" class="btn btn-sm btn-danger" data-f-del="' + escAttr(rel) + '">🗑 ' + __('auto_admin_files_18') + '</button>' +
          '</div></div>';
      }).join('');
    }
    renderFilesPagination(total);
  }

  function renderFilesPagination(total) {
    const el = document.getElementById('adminFilesPagination');
    if (!el) return;
    const pages = Math.max(1, Math.ceil(total / filesPageSize));
    if (pages <= 1) { el.innerHTML = ''; return; }
    let html = '';
    for (let p = 1; p <= pages; p++) {
      html += '<button type="button" class="pg-btn' + (p === filesPage ? ' active' : '') + '" data-f-page="' + p + '">' + p + '</button>';
    }
    el.innerHTML = html;
  }

  function deleteFile(rel) {
    showConfirm(__('auto_admin_files_13'), async () => {
      try {
        const res = await api('/api/admin/files/' + encodeURIComponent(rel), { method: 'DELETE' });
        if (res.ok) { toast(__('auto_admin_files_14'), 'success'); loadAdminFiles(); }
        else { const d = await res.json().catch(() => ({})); toast(errText(d) || __('auto_admin_files_15'), 'error'); }
      } catch (e) { if (isApiHandledError(e)) return; toast(__('auto_admin_files_15') + ': ' + e.message, 'error'); }
    });
  }

  function renameFile(rel) {
    showInput(__('auto_admin_files_22'), rel, async (val) => {
      const newName = (val || '').trim();
      if (!newName) { toast(__('auto_admin_files_24'), 'error'); return; }
      try {
        const res = await api('/api/admin/files/rename', {
          method: 'POST',
          body: { filepath: rel, newName }
        });
        if (res.ok) { toast(__('auto_admin_files_23'), 'success'); loadAdminFiles(); }
        else { const d = await res.json().catch(() => ({})); toast(errText(d) || __('auto_admin_files_24'), 'error'); }
      } catch (e) { if (isApiHandledError(e)) return; toast(__('auto_admin_files_24') + ': ' + e.message, 'error'); }
    });
  }

  function createDir() {
    showInput(__('auto_admin_files_25'), '', async (val) => {
      const name = (val || '').trim();
      if (!name) { toast(__('auto_admin_files_27'), 'error'); return; }
      try {
        const res = await api('/api/admin/files/create-dir', {
          method: 'POST',
          body: { name, parent: '' }
        });
        if (res.ok) { toast(__('auto_admin_files_26'), 'success'); loadAdminFiles(); }
        else { const d = await res.json().catch(() => ({})); toast(errText(d) || __('auto_admin_files_27'), 'error'); }
      } catch (e) { if (isApiHandledError(e)) return; toast(__('auto_admin_files_27') + ': ' + e.message, 'error'); }
    });
  }

  function cleanupFiles() {
    const daysEl = document.getElementById('adminFilesCleanupDays');
    const days = parseInt((daysEl || {}).value, 10);
    if (!Number.isFinite(days) || days < 0 || days > 3650) { toast(__('auto_admin_files_30'), 'error'); return; }
    showConfirm(__('auto_admin_files_28') + '（' + days + ' ' + __('auto_admin_files_32') + '）', async () => {
      try {
        const res = await api('/api/admin/files/cleanup', {
          method: 'POST',
          body: { days }
        });
        if (res.ok) {
          const d = await res.json();
          toast(__('auto_admin_files_29') + ': ' + (d.message || (d.deleted + ' / ' + d.freed)), 'success');
          loadAdminFiles();
        }
        else { const d = await res.json().catch(() => ({})); toast(errText(d) || __('auto_admin_files_30'), 'error'); }
      } catch (e) { if (isApiHandledError(e)) return; toast(__('auto_admin_files_30') + ': ' + e.message, 'error'); }
    });
  }

  function downloadFile(rel) {
    window.open('/api/admin/files/' + encodeURIComponent(rel) + '/download', '_blank', 'noopener');
  }

  function bindFilesEvents() {
    if (filesBound) return;
    filesBound = true;

    const refreshBtn = document.getElementById('adminFilesRefreshBtn');
    if (refreshBtn) refreshBtn.addEventListener('click', loadAdminFiles);
    const createBtn = document.getElementById('adminFilesCreateDirBtn');
    if (createBtn) createBtn.addEventListener('click', createDir);
    const cleanupBtn = document.getElementById('adminFilesCleanupBtn');
    if (cleanupBtn) cleanupBtn.addEventListener('click', cleanupFiles);
    const search = document.getElementById('adminFilesSearch');
    if (search) search.addEventListener('input', (e) => {
      filesKeyword = (e.target.value || '').trim().toLowerCase();
      filesPage = 1;
      renderAdminFiles();
    });

    const list = document.getElementById('adminFilesList');
    if (list) list.addEventListener('click', (e) => {
      const dl = e.target.closest('[data-f-download]');
      if (dl) { downloadFile(dl.dataset.fDownload); return; }
      const rn = e.target.closest('[data-f-rename]');
      if (rn) { renameFile(rn.dataset.fRename); return; }
      const del = e.target.closest('[data-f-del]');
      if (del) deleteFile(del.dataset.fDel);
    });
    const pg = document.getElementById('adminFilesPagination');
    if (pg) pg.addEventListener('click', (e) => {
      const b = e.target.closest('[data-f-page]');
      if (b) { filesPage = parseInt(b.dataset.fPage, 10); renderAdminFiles(); }
    });
  }

  function initAdminFilesEvents() {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindFilesEvents);
    else bindFilesEvents();
  }

  // 暴露给 admin-ui.js PANEL_LOADERS / switchTab
  window.loadAdminFiles = loadAdminFiles;
  window.initAdminFilesEvents = initAdminFilesEvents;

  initAdminFilesEvents();
})();
