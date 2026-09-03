// ==================== 公告系统 ====================
let announcementsCache = [];
let announcementsLoading = false;
let announcementSaving = false;

async function loadAnnouncements() {
  const container = document.getElementById('announcementsList');
  if (container) container.innerHTML = Array(4).fill('<div class="skeleton-card-list"></div>').join('');
  if (announcementsLoading) return;
  announcementsLoading = true;
  try {
    const res = await api('/api/announcements', { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      announcementsCache = data.announcements || [];
      renderAnnouncements(announcementsCache);
      if (typeof checkTabBadges === 'function') checkTabBadges();
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('announcements.load_failed'), 'error');
  } finally {
    announcementsLoading = false;
  }
}

function renderAnnouncements(list) {
  const container = document.getElementById('announcementsList');
  if (!container) return;
  if (!list || list.length === 0) {
    const canCreate = currentUser && (currentUser.role === 'admin' || currentUser.role === 'super_admin');
    renderEmpty(container, {
      icon: '📢',
      text: __('announcements.no_announcements'),
      actions: canCreate ? [{ label: __('announcements.create_first'), onClick: showAnnounceModal }] : []
    });
    return;
  }
  container.innerHTML = list.map(a => `
    <div class="anno-card ${a.pinned ? 'pinned' : ''}" onclick="showAnnouncementDetail('${escJsStr(String(a.id))}')">
      ${a.pinned ? '<div class="anno-pin-badge">' + __('announcements.pin') + '</div>' : ''}
      <div class="anno-title">${esc(a.title)}</div>
      <div class="anno-meta">
        <span>📅 ${fmtDate(a.createdAt)}</span>
        ${a.updatedAt && a.updatedAt !== a.createdAt ? `<span class="anno-edited">${__('announcements.edited')}</span>` : ''}
        ${a.visibility ? '<span>' + (a.visibility === 'public' ? __('announcements.public') : __('announcements.member_only')) + '</span>' : ''}
      </div>
      <div class="anno-summary">${esc(a.content ? a.content.substring(0, 100) : '')}${a.content && a.content.length > 100 ? '...' : ''}</div>
    </div>
  `).join('');
}

async function showAnnouncementDetail(id) {
  try {
    const res = await api(`/api/announcements/${id}`, { method: 'GET' });
    if (res.ok) {
      const data = await res.json(); const a = data.announcement;
      const modal = document.getElementById('eventDetailModal');
      if (!modal) { toast(__('announcements.modal_not_found'), 'error'); return; }
      document.getElementById('evtDetTitle').textContent = a.title || __('announcements.announcement');
      document.getElementById('evtDetMeta').innerHTML = `<span>${__('announcements.published_at')} ${fmtDate(a.createdAt)}</span>${a.updatedAt ? `<span>${__('announcements.edited_at')} ${fmtDate(a.updatedAt)}</span>` : ''}`;
      document.getElementById('evtDetVisBadge').innerHTML = a.visibility === 'public' ? '<span class="visibility-badge public">' + __('announcements.public') + '</span>' : '<span class="visibility-badge members">' + __('announcements.member_only') + '</span>';
      document.getElementById('evtDetDesc').innerHTML = escapeNewlines(a.content || '');
      // 管理员显示编辑/删除按钮
      const isAdmin = currentUser && (currentUser.role === 'admin' || currentUser.role === 'super_admin');
      const adminActions = document.getElementById('evtDetAdminActions');
      adminActions.style.display = isAdmin ? 'flex' : 'none';
      adminActions.innerHTML = isAdmin ? `
        <button class="btn btn-sm btn-white-glass" onclick="editAnnouncement('${escJsStr(String(a.id))}')">${__('announcements.edit')}</button>
        <button class="btn btn-sm btn-danger ml-6" onclick="deleteAnnouncement('${escJsStr(String(a.id))}')">${__('announcements.delete')}</button>
      ` : '';
      hideEl('evtDetSignBar');
      hideEl('evtDetCheckinBar');
      hideEl('evtDetUploadBtn');
      hideEl('evtDetPhotos');
      hideEl('evtDetComments');
      hideEl('evtDetTeamsSection');
      showModal('eventDetailModal');
    }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('announcements.load_detail_failed'), 'error'); }
}

// 公告编辑
async function editAnnouncement(id) {
  const a = announcementsCache.find(a => String(a.id) === String(id));
  if (!a) { toast(__('announcements.edit_failed'), 'error'); return; }
  document.getElementById('annEditId').value = a.id;
  document.getElementById('annTitle').value = a.title || '';
  document.getElementById('annContent').value = a.content || '';
  document.getElementById('annPinned').checked = !!a.pinned;
  document.getElementById('annVisibility').value = a.visibility || 'members_only';
  document.getElementById('annModalTitle').textContent = __('announcements.edit_title_suffix');
  document.getElementById('annSaveBtn').textContent = __('save');
  closeModal('eventDetailModal');
  showModal('announceModal');
}

async function saveAnnounceEdit(id) {
  const title = document.getElementById('annTitle')?.value;
  const content = document.getElementById('annContent')?.value;
  const pinned = document.getElementById('annPinned')?.checked || false;
  const visibility = document.getElementById('annVisibility')?.value || 'members_only';
  if (!title || !content) { toast(__('announcements.title_content_required'), 'error'); return; }
  try {
    const res = await api(`/api/announcements/${id}`, { method: 'PUT', body: { title, content, pinned, visibility } });
    if (res.ok) { toast(__('announcements.updated'), 'success'); closeModal('announceModal'); loadAnnouncements(); }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('announcements.update_failed'), 'error');
  }
}

async function deleteAnnouncement(id) {
  showConfirm(__('announcements.confirm_delete'), async () => {
    try {
      const res = await api(`/api/announcements/${id}`, { method: 'DELETE' });
      if (res.ok) { toast(__('announcements.deleted'), 'success'); closeModal('eventDetailModal'); loadAnnouncements(); }
    } catch (err) {
      if (isApiHandledError(err)) return;
      toast(__('announcements.delete_failed'), 'error');
    }
  });
}

function showAnnounceModal() { 
  document.getElementById('annEditId').value = '';
  document.getElementById('annTitle').value = '';
  document.getElementById('annContent').value = '';
  document.getElementById('annPinned').checked = false;
  document.getElementById('annVisibility').value = 'members_only';
  document.getElementById('annModalTitle').textContent = __('announcements.publish_title_suffix');
  document.getElementById('annSaveBtn').textContent = __('announcements.publish_btn');
  showModal('announceModal'); 
}

async function saveAnnouncementForm() {
  if (announcementSaving) return;
  announcementSaving = true;
  const saveButton = document.getElementById('annSaveBtn');
  if (saveButton) saveButton.disabled = true;
  try {
    const editId = document.getElementById('annEditId')?.value;
    if (editId) await saveAnnounceEdit(editId);
    else await saveAnnounce();
  } finally {
    announcementSaving = false;
    if (saveButton) saveButton.disabled = false;
  }
}

async function saveAnnounce() {
  const title = document.getElementById('annTitle')?.value; const content = document.getElementById('annContent')?.value;
  const pinned = document.getElementById('annPinned')?.checked || false; const visibility = document.getElementById('annVisibility')?.value || 'members_only';
  if (!title || !content) { toast(__('announcements.title_content_required'), 'error'); return; }
  try { const res = await api('/api/announcements', { method: 'POST', body: { title, content, pinned, visibility } }); if (res.ok) { toast(__('announcements.created'), 'success'); closeModal('announceModal'); loadAnnouncements(); } } catch (err) { if (isApiHandledError(err)) return; toast(__('announcements.create_failed'), 'error'); }
}
