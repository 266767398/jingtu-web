// ==================== 活动系统 V5.6 — 仅常规活动，生日派对移入生日Tab ====================
let eventsCache = [];
let currentEvtStatus = 'ongoing';

async function loadEvents(status = 'ongoing') {
  const container = document.getElementById('eventsList');
  if (container) container.innerHTML = Array(6).fill('<div class="skeleton-card-grid"></div>').join('');
  try {
    let url = '/api/events?type=activity';
    if (status && status !== 'all') url += '&status=' + status;
    const res = await api(url, { method: 'GET' });
    if (res.ok) { const data = await res.json(); eventsCache = data.events || []; renderEvents(eventsCache); const evtCount = document.getElementById('evtCount'); if (evtCount) evtCount.textContent = `(${eventsCache.length})`; if (typeof checkTabBadges === 'function') checkTabBadges(); }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('events.load_failed'), 'error'); }
}

function switchEvtStatus(status) { currentEvtStatus = status; document.querySelectorAll('.evt-status-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.status === status)); loadEvents(status); }
function switchEvtView(view) { 
  document.querySelectorAll('.evt-view-btn').forEach(b => b.classList.remove('active')); 
  document.querySelector(`.evt-view-btn[data-view="${view}"]`)?.classList.add('active');
  // 切换列表/日历容器
  document.getElementById('eventsListView')?.classList.toggle('d-none', view !== 'list');
  document.getElementById('eventsCalendarView')?.classList.toggle('d-none', view !== 'calendar');
  if (view === 'calendar') {
    if (eventsCache.length === 0) {
      loadEvents(currentEvtStatus).then(() => {
        calendarViewDate = new Date();
        renderCalendarView(eventsCache);
      });
    } else {
      calendarViewDate = new Date();
      renderCalendarView(eventsCache);
    }
  }
}

function renderEvents(events) {
  const container = document.getElementById('eventsList');
  if (!container) return;
  if (!events || events.length === 0) {
    const canCreate = currentUser && (currentUser.role === 'admin' || currentUser.role === 'super_admin');
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">🎉</div><div>${__('events.no_events')}</div>${canCreate ? '<p class="empty-sub mt-8"><button class="btn btn-accent btn-sm" onclick="showEventModal()">${__('events.create_first')}</button></p>' : '<p class="empty-sub">${__('events.stay_tuned')}</p>'}</div>`;
    return;
  }
  container.innerHTML = events.map(e => {
    const cd = getCountdown(e.time, e.endsAt); const evtStatus = getEventStatus(e.time, e.endsAt);
    const visBadge = e.visibility === 'public' ? '<span class="visibility-badge public">${__('events.public')}</span>' : e.visibility === 'members_only' ? '<span class="visibility-badge members">${__('events.member_only_tag')}</span>' : '';
    const worldThumb = e.worldImageUrl ? `<div class="event-world-thumb-wrap"><img src="${escAttr(e.worldImageUrl)}" class="event-world-thumb" alt="${esc(e.worldName || 'World')}" loading="lazy" onerror="this.parentElement.style.display='none'"></div>` : '';
    return `<div class="event-card ${evtStatus === 'past' ? 'past' : ''}" onclick="showEventDetail('${escJsStr(String(e.id))}')">
      ${worldThumb}
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:6px">
        ${cd ? `<span class="event-countdown ${cd.cls}">⏱ ${cd.text}</span>` : evtStatus === 'past' ? '<span class="event-countdown past">✅ ${__('events.ended')}</span>' : evtStatus === 'upcoming' ? '<span class="event-countdown upcoming">📅 ${__(\'events.about_to_start\')}</span>' : ''}
        ${visBadge}
      </div>
      <div class="event-time">📅 ${fmtTime(e.time)}${e.endsAt ? ' — ' + fmtTime(e.endsAt) : ''}</div>
      <div style="font-weight:800;font-size:15px;margin-bottom:4px;margin-top:2px">${esc(e.title)}</div>
      ${e.place ? `<div class="event-place">📍 ${esc(e.place)}</div>` : ''}
      <div class="event-desc">${esc(e.description || '').substring(0, 80)}${e.description && e.description.length > 80 ? '...' : ''}</div>
      ${e.worldName ? `<div class="event-world-info">🌐 ${esc(e.worldName)}</div>` : ''}
      <div class="event-meta"><span>👤 ${__('events.participants', {n: e.participants || 0})}</span>${e.maxParticipants ? `<span>/ ${e.maxParticipants} ${__('events.max_people')}</span>` : ''}</div>
    </div>`;
  }).join('');
}

function getCountdown(timeStr, endsStr) {
  if (!timeStr) return null; const now = new Date(); const start = new Date(timeStr); const ends = endsStr ? new Date(endsStr) : null;
  if (ends && now > ends) return null; const diff = start - now;
  if (diff < 0 && !ends) return null;
  if (diff > 0) {
    const days = Math.floor(diff / 86400000); const hours = Math.floor((diff % 86400000) / 3600000); const mins = Math.floor((diff % 3600000) / 60000);
    let cls = 'soon'; if (days > 7) cls = 'far'; else if (days > 1) cls = 'near';
    let text = ''; if (days > 0) text += __('events.days', {n: days}); if (hours > 0) text += __('events.hours', {n: hours}); if (mins > 0) text += __('events.minutes', {n: mins}); text += __('events.after_start');
    return { text, cls };
  }
  return { text: '${__('events.ongoing')}', cls: 'ongoing' };
}
function getEventStatus(timeStr, endsStr) { if (!timeStr) return 'unknown'; const now = new Date(); const start = new Date(timeStr); const ends = endsStr ? new Date(endsStr) : null; if (ends && now > ends) return 'past'; if (now < start) return 'upcoming'; return 'ongoing'; }

async function showEventDetail(id) {
  window._currentEventId = parseInt(id);
  try {
    const res = await api(`/api/events/detail/${id}`, { method: 'GET' });
    if (res.ok) {
      const e = await res.json();
      const modal = document.getElementById('eventDetailModal');
      if (!modal) { toast(__('events.modal_not_found'), 'error'); return; }
      document.getElementById('evtDetTitle').textContent = e.title || __('events.event');
      document.getElementById('evtDetMeta').innerHTML = `
        <span>📅 ${fmtTime(e.time)}${e.endsAt ? ' — ' + fmtTime(e.endsAt) : ''}</span>
        ${e.place ? `<span>📍 ${esc(e.place)}</span>` : ''}
        ${e.worldName ? `<span class="d-flex gap-4 items-center">${e.worldImageUrl ? `<img src="${escAttr(e.worldImageUrl)}" style="width:18px;height:18px;border-radius:4px;object-fit:cover" loading="lazy">` : '🌐'} ${esc(e.worldName)}</span>` : ''}
        <span>👤 ${__('events.sign_count', {n: e.signCount || 0})}</span>
        ${e.updatedAt ? `<span class="text-muted2 text-11">${__('announcements.edit_at')} ${fmtDate(e.updatedAt)}</span>` : ''}`;
      document.getElementById('evtDetVisBadge').innerHTML = e.visibility === 'public'
        ? '<span class="visibility-badge public">${__('events.public')}</span>'
        : '<span class="visibility-badge members">${__('events.member_only')}</span>';
      document.getElementById('evtDetDesc').innerHTML = escapeNewlines(e.desc || e.description || __('no_data'));
      
      // 管理员操作 — 根据事件类型显示不同按钮
      const isAdmin = currentUser && (currentUser.role === 'admin' || currentUser.role === 'super_admin');
      document.getElementById('evtDetAdminActions').style.display = isAdmin ? '' : 'none';
      if (isAdmin) {
        const isBirthday = e.eventType === 'birthday';
        document.getElementById('evtDetAdminActions').innerHTML = isBirthday
          ? `<button class="btn btn-sm btn-white-glass" onclick="editBirthdayParty(${id})">${__('events.edit_party')}</button>
             <button class="btn btn-sm btn-danger ml-6" onclick="deleteBirthdayParty(${id})">${__('events.delete')}</button>
             <button class="btn btn-sm btn-white-glass ml-6" id="evtDetCheckinBtn">✅ ${__('events.sign_in')}</button>`
          : `<button class="btn btn-sm btn-white-glass" onclick="showEditEvent()">${__('events.edit_event')}</button>
             <button class="btn btn-sm btn-danger ml-6" onclick="deleteEvent()">${__('events.delete')}</button>
             <button class="btn btn-sm btn-white-glass ml-6" id="evtDetCheckinBtn">✅ ${__('events.sign_in')}</button>`;
      }
      document.getElementById('evtDetCheckinBar').style.display = isAdmin ? '' : 'none';
      document.getElementById('evtDetUploadBtn').className = isAdmin ? '' : 'd-none';
      
      // ${__('events.sign_in')}列表
      const checkinListEl = document.getElementById('evtDetCheckinList');
      if (checkinListEl && e.checkinList) {
        checkinListEl.innerHTML = e.checkinList.map(c =>
          `<div class="det-checkin-item">✅ ${__('events.admin_label', {n: ''})}</div>`
        ).join('') || '<div class="text-muted text-12">${__('events.no_sign_ins')}</div>';
      }
      const checkinCountEl = document.getElementById('evtDetCheckinCount');
      if (checkinCountEl) checkinCountEl.textContent = `${__('events.n_checked_in', {n: e.checkinCount || 0})}`;
      
      // 报名按钮
      const signBtn = document.getElementById('evtDetSignBtn');
      if (signBtn) {
        const isSigned = signedEvents.has(parseInt(id));
        if (currentUser && currentUser.role !== 'grief') {
          if (e.signCount >= (e.maxSign || 999)) {
            signBtn.innerHTML = '<span class="text-muted">${__(\'events.full\')}</span>';
          } else if (isSigned) {
            signBtn.innerHTML = `<button class="btn btn-sm sign-btn-cancel" onclick="unsignEvent(${id})">${__('events.signed_cancel')}</button>`;
          } else {
            signBtn.innerHTML = `<button class="btn btn-sm btn-accent" onclick="signEvent(${id})">${__('events.sign_up_btn')}</button>`;
          }
        } else {
          signBtn.innerHTML = '<span class="text-muted">${__(\'events.login_to_sign\')}</span>';
        }
      }
      
      document.getElementById('evtDetSignCount').textContent = `${__('events.signed_up_count', {n: e.signCount || 0})}`;
      document.getElementById('evtDetMaxSign').textContent = e.maxSign ? `/ ${__('events.limit', {n: e.maxSign})}` : '';
      
      // 报名列表
      const signList = document.getElementById('evtDetSignList');
      if (signList && e.signList) {
        signList.innerHTML = e.signList.map(s =>
          `<div class="det-sign-item">${__('events.user_prefix')}${esc(s.user_name || __('events.user'))}</div>`
        ).join('') || '<div class="text-muted text-12">${__('events.no_signups')}</div>';
      }
      
      // 初始化${__('events.sign_in')}按钮
      initCheckinBtn();
      // 使用 showModal 带动画
      showModal('eventDetailModal');
      // 加载评论
      loadEventComments(id);
      // 加载活动照片
      loadEventPhotos(id);
    }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('events.load_detail_failed'), 'error'); }
}

function showEventModal() {
  // 恢复 sessionStorage 中保存的草稿数据
  const draft = sessionStorage.getItem('evtDraft');
  if (draft) {
    try {
      const d = JSON.parse(draft);
      if (d.title) document.getElementById('evtTitle').value = d.title;
      if (d.desc) document.getElementById('evtDesc').value = d.desc;
      if (d.time) document.getElementById('evtTime').value = d.time;
      if (d.endsAt) document.getElementById('evtEndsAt').value = d.endsAt;
      if (d.place) document.getElementById('evtPlace').value = d.place;
      if (d.max !== undefined) document.getElementById('evtMax').value = d.max;
      if (d.visibility) {
        document.getElementById('evtVisibility').value = d.visibility;
        document.querySelectorAll('input[name="evtVisibility"]').forEach(r => r.checked = r.value === d.visibility);
      }
    } catch(e) { /* ignore */ }
  }
  showModal('eventModal');
  if (!draft) setDefaultTime('evtTime', 'evtEndsAt');
}

// 活动创建弹窗关闭时保存草稿
function closeEventModal() {
  const title = document.getElementById('evtTitle')?.value;
  // 只保存有内容的表单
  if (title) {
    const draft = {
      title: title,
      desc: document.getElementById('evtDesc')?.value || '',
      time: document.getElementById('evtTime')?.value || '',
      endsAt: document.getElementById('evtEndsAt')?.value || '',
      place: document.getElementById('evtPlace')?.value || '',
      max: document.getElementById('evtMax')?.value || '0',
      visibility: document.getElementById('evtVisibility')?.value || 'members_only'
    };
    try { sessionStorage.setItem('evtDraft', JSON.stringify(draft)); } catch(e) {}
  }
  closeModal('eventModal');
}
function showBirthdayEventModal() {
  // 重置表单为新建模式
  document.getElementById('bdayEditId').value = '';
  document.getElementById('bdayTitle').value = '';
  document.getElementById('bdayTime').value = '';
  document.getElementById('bdayEndsAt').value = '';
  document.getElementById('bdayDesc').value = '';
  document.getElementById('bdayMax').value = '0';
  document.getElementById('bdayModalTitle').textContent = __('events.create_bday_party');
  const saveBtn = document.getElementById('bdaySaveBtn');
  saveBtn.textContent = __('create');
  saveBtn.onclick = saveBirthdayEvent;
  showModal('birthdayEventModal');
  setDefaultTime('bdayTime', 'bdayEndsAt');
}
function showArchiveList() {
  showModal('archiveModal');
  loadArchives();
}

async function loadArchives() {
  const container = document.getElementById('archiveList');
  if (!container) return;
  container.innerHTML = '<div class="skeleton-card"></div>';
  try {
    const res = await api('/api/events?include_archived=1', { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      const archived = (data.events || []).filter(e => e.isArchive);
      if (archived.length === 0) {
        container.innerHTML = '<div class="empty-state"><div class="empty-icon">📦</div><div>${__(\'events.no_archive\')}</div></div>';
        return;
      }
      container.innerHTML = archived.map(e => `
        <div class="archive-item" onclick="showEventDetail('${escJsStr(String(e.id))}')">
          <div class="archive-title">${esc(e.title)}</div>
          <div class="archive-time">📅 ${fmtTime(e.time)}</div>
          <div class="archive-desc">${esc((e.description || '').substring(0, 80))}${e.description && e.description.length > 80 ? '...' : ''}</div>
        </div>
      `).join('');
    }
  } catch { if (container) container.innerHTML = '<div class="text-13 text-red">${__('events.load_failed')}</div>'; }
}

async function saveEvent() {
  const title = document.getElementById('evtTitle')?.value; const desc = document.getElementById('evtDesc')?.value;
  const eventTime = document.getElementById('evtTime')?.value; const endTime = document.getElementById('evtEndsAt')?.value;
  const worldId = document.getElementById('evtWorldId')?.value;
  const worldName = document.getElementById('evtWorldName')?.value;
  const worldImageUrl = document.getElementById('evtWorldImageUrl')?.value;
  const visibility = document.getElementById('evtVisibility')?.value || 'members_only';
  const place = document.getElementById('evtPlace')?.value;
  const maxSign = parseInt(document.getElementById('evtMax')?.value) || 0;
  if (!title || !eventTime) { toast(__('events.title_time_required'), 'error'); return; }
  try {
    const body = { title, description: desc, time: eventTime, endsAt: endTime || undefined, worldId, worldName, worldImageUrl, visibility, place, maxSign };
    const res = await api('/api/events', { method: 'POST', body });
    if (res.ok) { toast(__('events.created'), 'success'); sessionStorage.removeItem('evtDraft'); closeModal('eventModal'); if (!document.getElementById('tab-events')?.classList.contains('d-none')) { switchEvtView('list'); reloadEventsSmart(eventTime); } else { loadEvents(currentEvtStatus); } }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('operation_failed'), 'error');
  }
}

async function saveBirthdayEvent() {
  const title = document.getElementById('bdayTitle')?.value;
  const eventTime = document.getElementById('bdayTime')?.value;
  const endTime = document.getElementById('bdayEndsAt')?.value;
  const desc = document.getElementById('bdayDesc')?.value;
  const maxSign = parseInt(document.getElementById('bdayMax')?.value) || 0;
  const visibility = document.getElementById('bdayVisibility')?.value || 'members_only';
  if (!title || !eventTime) { toast(__('events.fill_complete'), 'error'); return; }
  try {
    const res = await api('/api/events', { method: 'POST', body: {
      title, time: eventTime, endsAt: endTime || undefined,
      description: desc || '', eventType: 'birthday',
      maxSign, visibility
    }});
    if (res.ok) { toast(__('events.bday_party_created'), 'success'); closeModal('birthdayEventModal'); loadBirthdayParties(); if (!document.getElementById('tab-events')?.classList.contains('d-none')) { switchEvtView('list'); reloadEventsSmart(eventTime); } }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('operation_failed'), 'error');
  }
}

// 保存后智能选择 Tab：未来活动切到 upcoming，已开始保持 ongoing
function reloadEventsSmart(eventTime) {
  const now = new Date();
  const evtDate = new Date(eventTime);
  if (evtDate > now) {
    currentEvtStatus = 'upcoming';
    document.querySelectorAll('.evt-status-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.status === 'upcoming'));
    loadEvents('upcoming');
  } else {
    loadEvents(currentEvtStatus);
  }
}

function showEditEvent() {
  // 从当前详情中获取活动数据
  const id = window._currentEventId;
  if (!id) return;
  // 从 eventsCache 中查找，找不到则从 API 获取
  let evt = eventsCache.find(e => parseInt(e.id) === id);
  if (evt) {
    openEditModal(evt);
  } else {
    // 缓存中没有，通过 API 获取
    api(`/api/events/detail/${id}`, { method: 'GET' }).then(res => {
      if (!res.ok) { throw new Error('${__('events.load_failed')}'); }
      return res.json();
    }).then(e => {
      openEditModal(e);
    }).catch(() => {
      toast(__('events.data_not_loaded'), 'error');
    });
  }
}

function openEditModal(evt) {
  showModal('editEventModal');
  document.getElementById('eeTitle').value = evt.title || '';
  document.getElementById('eeTime').value = evt.time ? evt.time.substring(0, 16) : '';
  document.getElementById('eeEndsAt').value = evt.endsAt ? evt.endsAt.substring(0, 16) : '';
  if (!evt.time) setDefaultTime('eeTime', 'eeEndsAt');
  document.getElementById('eePlace').value = evt.place || '';
  document.getElementById('eeDesc').value = evt.description || evt.desc || '';
  document.getElementById('eeMaxSign').value = evt.maxSign || 0;
  document.getElementById('eeVisibility').value = evt.visibility || 'members_only';
  document.getElementById('eeIsArchive').checked = !!evt.isArchive;
  // World 信息
  if (evt.worldId) {
    document.getElementById('eeWorldId').value = evt.worldId;
    document.getElementById('eeWorldName').value = evt.worldName || '';
    document.getElementById('eeWorldImageUrl').value = evt.worldImageUrl || '';
    const preview = document.getElementById('eeWorldPreview');
    if (preview) {
      preview.style.display = 'flex';
      document.getElementById('eeWorldThumb').src = evt.worldImageUrl || '';
      document.getElementById('eeWorldNameDisplay').textContent = evt.worldName || '';
    }
  }
}

async function saveEditEvent() {
  const id = window._currentEventId;
  if (!id) { toast(__('events.cannot_get_id'), 'error'); return; }
  const title = document.getElementById('eeTitle')?.value;
  const time = document.getElementById('eeTime')?.value;
  if (!title || !time) { toast(__('events.title_time_required'), 'error'); return; }
  try {
    const res = await api(`/api/events/${id}`, {
      method: 'PUT',
      body: {
        title,
        time,
        endsAt: document.getElementById('eeEndsAt')?.value || undefined,
        place: document.getElementById('eePlace')?.value,
        desc: document.getElementById('eeDesc')?.value,
        maxSign: parseInt(document.getElementById('eeMaxSign')?.value) || 0,
        visibility: document.getElementById('eeVisibility')?.value || 'members_only',
        isArchive: document.getElementById('eeIsArchive')?.checked || false,
        worldId: document.getElementById('eeWorldId')?.value || undefined,
        worldName: document.getElementById('eeWorldName')?.value || undefined,
        worldImageUrl: document.getElementById('eeWorldImageUrl')?.value || undefined
      }
    });
    if (res.ok) {
      toast(__('events.updated'), 'success');
      closeModal('editEventModal');
      reloadEventsSmart(time);
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('events.edit_failed'), 'error');
  }
}

// ==================== 删除活动 ====================
async function deleteEvent() {
  const id = window._currentEventId;
  if (!id) { toast(__('events.cannot_get_id'), 'error'); return; }
  showConfirm(__('events.delete_confirm'), async () => {
    try {
      const res = await api(`/api/events/${id}`, { method: 'DELETE' });
      if (res.ok) {
        toast(__('events.deleted'), 'success');
        closeModal('eventDetailModal');
        loadEvents(currentEvtStatus);
      }
    } catch (err) {
      if (isApiHandledError(err)) return;
      toast(__('events.delete_failed'), 'error');
    }
  });
}

// ==================== 活动评论（对接后端 API） ====================
async function postEventComment() {
  const modal = document.getElementById('eventDetailModal');
  if (!modal || modal.style.display !== 'flex') return;
  const input = document.getElementById('evtDetCommentInput');
  const text = input?.value?.trim();
  if (!text) { toast(__('events.enter_comment'), 'error'); return; }
  // 从活动详情数据中获取 ID（从 URL 里提取或从渲染的 hidden 字段获取）
  // 从当前详情弹窗的活动 ID 获取 — 我们通过 title 后面的 data 属性
  const titleEl = document.getElementById('evtDetTitle');
  if (!titleEl) return;
  try {
    // 获取当前显示的活动 ID - 通过查找最近点击的事件
    // 最简单方法：在 showEventDetail 中保存一个变量
    const eventId = window._currentEventId;
    if (!eventId) { toast(__('events.cannot_get_id'), 'error'); return; }
    const res = await api(`/api/events/${eventId}/comments`, {
      method: 'POST',
      body: { content: text }
    });
    if (res.ok) {
      toast(__('operation_success'), 'success');
      if (input) input.value = '';
      // 重新加载评论
      loadEventComments(eventId);
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('events.comment_post_failed'), 'error');
  }
}

async function loadEventComments(eventId) {
  const list = document.getElementById('evtDetCommentList');
  if (!list) return;
  try {
    const res = await api(`/api/events/${eventId}/comments`, { method: 'GET' });
    if (res.ok) {
      const comments = await res.json();
      if (!comments || comments.length === 0) {
        list.innerHTML = '<div class="text-muted text-12">${__('events.no_comments')}</div>';
        return;
      }
      list.innerHTML = comments.map(c => `
        <div class="det-comment-item">
          <img src="${escAttr(c.avatarUrl || '/api/avatar/default')}" class="det-comment-avatar" alt="" loading="lazy">
          <div class="det-comment-body">
            <div class="det-comment-header">
              <span class="det-comment-user">${esc(c.userName || __('unknown_user'))}</span>
              <span class="det-comment-time">${fmtTime(c.createdAt)}</span>
              ${currentUser && (currentUser.id === c.userId || currentUser.role === 'super_admin' || currentUser.role === 'admin') ? 
                `<button class="btn-text det-comment-del" onclick="deleteEventComment(${eventId}, ${c.id})">${__('delete')}</button>` : ''}
            </div>
            <div class="det-comment-content">${esc(c.content)}</div>
          </div>
        </div>
      `).join('');
    }
  } catch { const list = document.getElementById('evtDetCommentList'); if (list) list.innerHTML = '<div class="text-muted text-12">${__('events.load_failed')}</div>'; }
}

async function deleteEventComment(eventId, commentId) {
  eventId = parseInt(eventId);
  commentId = parseInt(commentId);
  if (isNaN(eventId) || isNaN(commentId)) { toast(__('events.param_error'), 'error'); return; }
  showConfirm(__('events.confirm_delete_comment'), async () => {
    try {
      const res = await api(`/api/events/${eventId}/comments/${commentId}`, { method: 'DELETE' });
      if (res.ok) { toast(__('events.comment_deleted'), 'success'); loadEventComments(eventId); }
    } catch { toast(__('events.delete_comment_failed'), 'error'); }
  });
}

// ==================== 活动${__('events.sign_in')} ====================
function initCheckinBtn() {
  const btn = document.getElementById('evtDetCheckinBtn');
  if (btn) {
    btn.onclick = async function() {
      const eventId = window._currentEventId;
      if (!eventId) { toast(__('events.cannot_get_id'), 'error'); return; }
      showConfirm('${__('events.mark_all_checkin')}', async () => {
        try {
          const res = await api(`/api/events/${eventId}/checkin`, { method: 'POST' });
          if (res.ok) {
            toast(__('events.sign_in_recorded'), 'success');
            showEventDetail(eventId);
          } else {
            const err = await res.json().catch(() => ({}));
            toast(err.error || __('events.sign_in_failed'), 'error');
          }
        } catch (err) { if (isApiHandledError(err)) return; toast(__('events.sign_in_failed'), 'error'); }
      });
    };
  }
}

// ==================== ${__('events.sign_in')}二维码 ====================
window.showCheckinQR = function() {
  const eventId = window._currentEventId;
  if (!eventId) { toast(__('events.cannot_get_id'), 'error'); return; }
  const qrUrl = window.location.origin + '/?checkin=' + eventId;
  const html = `
    <div style="text-align:center;padding:16px">
      <p class="text-13 text-muted mb-8">${__('events.scan_to_checkin')}</p>
      <img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(qrUrl)}" alt="${__('events.checkin_qr')}" style="width:200px;height:200px;border-radius:8px;border:2px solid var(--border)" onerror="this.onerror=null;this.src='https://chart.apis.google.com/chart?cht=qr&chs=200x200&chl='+encodeURIComponent('${encodeURIComponent(qrUrl)}');">
      <p class="text-12 text-muted2 mt-8">${__('events.or_manual_checkin')}：<button class="btn btn-sm btn-accent" onclick="document.getElementById('evtDetCheckinBtn')?.click();closeModal('qrModal')">${__('events.checkin_now')}</button></p>
    </div>`;
  // 临时弹窗展示二维码
  const existing = document.getElementById('qrModal');
  if (existing) existing.remove();
  const div = document.createElement('div');
  div.id = 'qrModal';
  div.className = 'modal';
  div.innerHTML = `<div class="modal-content modal-sm"><div class="modal-header"><h3>📱 ${__('events.checkin_qr')}</h3><button class="modal-close" onclick="closeModal('qrModal')" aria-label="${__('events.aria_close')}">✕</button></div>${html}</div>`;
  document.body.appendChild(div);
  showModal('qrModal');
};
// 打开弹窗时自动填充"下一个整点/半点"作为开始时间，+2h作为结束时间
function setDefaultTime(startId, endId) {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  // 下一个整点或半点
  const min = now.getMinutes();
  let h = now.getHours(), m;
  if (min < 30) { m = 30; } else { m = 0; h += 1; }
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
  const startStr = start.getFullYear() + '-' + pad(start.getMonth()+1) + '-' + pad(start.getDate()) + 'T' +
    pad(start.getHours()) + ':' + pad(start.getMinutes());

  const startInput = document.getElementById(startId);
  if (startInput && !startInput.value) {
    startInput.value = startStr;
  }

  const endInput = document.getElementById(endId);
  if (endInput && !endInput.value) {
    const end = new Date(start.getTime() + 7200000); // +2h
    const endStr = end.getFullYear() + '-' + pad(end.getMonth()+1) + '-' + pad(end.getDate()) + 'T' +
      pad(end.getHours()) + ':' + pad(end.getMinutes());
    endInput.value = endStr;
  }
}

// ==================== 日历视图（增强版：月份导航） ====================
let calendarViewDate = new Date(); // 当前日历显示的月份

function renderCalendarView(events) {
  const container = document.getElementById('eventsCalendarView');
  if (!container) return;
  if (!events || events.length === 0) {
    // 区分"正在加载"和"确实没活动"
    const isLoading = document.querySelector('#eventsListView .skeleton-card-grid') !== null;
    container.innerHTML = isLoading
      ? '<div class="empty-state"><div class="empty-icon">📅</div><div>${__(\'events.loading_calendar\')}</div></div>'
      : '<div class="empty-state"><div class="empty-icon">📅</div><div>${__('events.no_events')}</div></div>';
    return;
  }
  const year = calendarViewDate.getFullYear();
  const month = calendarViewDate.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date();
  const isCurrentMonth = today.getFullYear() === year && today.getMonth() === month;
  const todayDate = today.getDate();

  // 按日期索引活动
  const evtMap = {};
  events.forEach(e => {
    if (!e.time) return;
    const d = new Date(e.time);
    const day = d.getDate();
    if (d.getFullYear() === year && d.getMonth() === month) {
      if (!evtMap[day]) evtMap[day] = [];
      evtMap[day].push(e);
    }
  });

  const monthNames = Array.from({length:12},(_,i)=>__('events.month_'+i));
  
  let html = `
    <div class="evt-calendar-nav">
      <button class="btn btn-sm btn-outline" onclick="calendarPrevMonth()" title="${__('events.prev_month')}">◀</button>
      <h3>${year} ${monthNames[month]}</h3>
      <div class="d-flex gap-4">
        ${!isCurrentMonth ? `<button class="evt-calendar-today-btn" onclick="resetCalendarMonth()" title="${__('events.back_to_today')}">${__('events.today')}</button>` : ''}
        <button class="btn btn-sm btn-outline" onclick="calendarNextMonth()" title="${__('events.next_month')}">▶</button>
      </div>
    </div>`;
  
  html += '<div class="evt-calendar-grid">';
  html += '<div class="evt-calendar-weekday">${__('events.weekday_sun')}</div><div class="evt-calendar-weekday">${__('events.weekday_mon')}</div><div class="evt-calendar-weekday">${__('events.weekday_tue')}</div><div class="evt-calendar-weekday">${__('events.weekday_wed')}</div><div class="evt-calendar-weekday">${__('events.weekday_thu')}</div><div class="evt-calendar-weekday">${__('events.weekday_fri')}</div><div class="evt-calendar-weekday">${__('events.weekday_sat')}</div>';
  
  // 空白格（当月第一天之前的）
  for (let i = 0; i < firstDay; i++) {
    html += '<div class="evt-calendar-day other-month" style="background:transparent;cursor:default"></div>';
  }
  
  for (let day = 1; day <= daysInMonth; day++) {
    const hasEvent = evtMap[day] && evtMap[day].length > 0;
    const isToday = isCurrentMonth && day === todayDate;
    const cls = 'evt-calendar-day' + (isToday ? ' today' : '') + (hasEvent ? '' : '');
    let dayContent = `<div class="day-num">${day}</div>`;
    if (hasEvent) {
      const names = evtMap[day].slice(0, 2).map(e => esc(e.title || '')).join('、');
      dayContent += `<div class="evt-dots"><div class="evt-dot" title="${esc(names)}">${__('events.count_events', {n: evtMap[day].length})}</div></div>`;
    }
    html += `<div class="${cls}" onclick="calShowDayEvents(${day})"${isToday ? ' data-today="1"' : ''}>${dayContent}</div>`;
  }
  html += '</div>';

  // 今日/选中日期的活动列表
  html += '<div class="cal-day-events" id="calDayEvents">';
  
  // 获取首次显示时默认查看${__('events.today')}（如果${__('events.today')}在当前月）
  const defaultDay = isCurrentMonth ? todayDate : (Object.keys(evtMap).length > 0 ? parseInt(Object.keys(evtMap)[0]) : 1);
  const hasDefaultEvents = evtMap[defaultDay] && evtMap[defaultDay].length > 0;
  
  if (hasDefaultEvents) {
    html += `<div class="cal-day-title">📌 ${__('events.day_suffix', {n: defaultDay})} (${__('events.count_events', {n: evtMap[defaultDay].length})})</div>`;
    html += evtMap[defaultDay].map(e => `
      <div class="cal-event-item" onclick="showEventDetail('${escJsStr(String(e.id))}')">
        <span class="cal-event-time">${fmtTime(e.time)}</span>
        <span class="cal-event-title">${esc(e.title)}</span>
        ${e.worldName ? `<span class="cal-event-world">🌐${esc(e.worldName)}</span>` : ''}
      </div>`).join('');
  } else {
    html += '<div class="text-muted text-13">${__('events.no_events')}</div>';
  }
  html += '</div>';
  
  container.innerHTML = html;
  
  // 首次渲染时自动选中${__('events.today')}（或该月第一天有活动的日期）
  const autoDay = isCurrentMonth ? todayDate : (Object.keys(evtMap).length > 0 ? parseInt(Object.keys(evtMap)[0]) : 1);
  if (autoDay) {
    requestAnimationFrame(() => calShowDayEvents(autoDay));
  }
}

// 月份导航
window.calendarPrevMonth = function() {
  calendarViewDate.setMonth(calendarViewDate.getMonth() - 1);
  if (eventsCache.length === 0) { loadEvents(currentEvtStatus); return; }
  renderCalendarView(eventsCache);
};
window.calendarNextMonth = function() {
  calendarViewDate.setMonth(calendarViewDate.getMonth() + 1);
  if (eventsCache.length === 0) { loadEvents(currentEvtStatus); return; }
  renderCalendarView(eventsCache);
};

// 重置日历到当月
window.resetCalendarMonth = function() {
  calendarViewDate = new Date();
  if (eventsCache.length === 0) { loadEvents(currentEvtStatus); return; }
  renderCalendarView(eventsCache);
};

// 点击日历日期查看该日活动
window.calShowDayEvents = function calShowDayEvents(day) {
  // 更新选中高亮
  const grid = document.querySelector('.evt-calendar-grid');
  if (grid) {
    grid.querySelectorAll('.evt-calendar-day.selected').forEach(d => d.classList.remove('selected'));
    grid.querySelectorAll('.evt-calendar-day').forEach(d => {
      const numEl = d.querySelector('.day-num');
      if (numEl && parseInt(numEl.textContent) === day) d.classList.add('selected');
    });
  }
  const container = document.getElementById('calDayEvents');
  if (!container) return;
  const year = calendarViewDate.getFullYear();
  const month = calendarViewDate.getMonth();
  const dayEvents = eventsCache.filter(e => {
    if (!e.time) return false;
    const d = new Date(e.time);
    return d.getDate() === day && d.getMonth() === month && d.getFullYear() === year;
  });
  if (dayEvents.length === 0) {
    container.innerHTML = '<div class="text-muted text-13">${__('events.no_events')}</div>';
    return;
  }
  container.innerHTML = `<div class="cal-day-title">📌 ${__('events.date_format', {year: year, month: month+1, day: day})} (${__('events.count_events', {n: dayEvents.length})})</div>` +
    dayEvents.map(e => `
      <div class="cal-event-item" onclick="showEventDetail('${escJsStr(String(e.id))}')">
        <span class="cal-event-time">${fmtTime(e.time)}</span>
        <span class="cal-event-title">${esc(e.title)}</span>
        ${e.worldName ? `<span class="cal-event-world">🌐${esc(e.worldName)}</span>` : ''}
      </div>`).join('');
}

// ==================== 活动照片 ====================
let eventPhotoList = []; // 当前详情弹窗的活动照片

async function loadEventPhotos(eventId) {
  const container = document.getElementById('evtDetPhotos');
  if (!container) return;
  container.innerHTML = '<div style="color:var(--text2);font-size:13px;grid-column:1/-1">📷 ${__('events.loading')}</div>';
  try {
    const res = await api(`/api/events/${eventId}/photos`, { method: 'GET' });
    if (!res.ok) throw new Error('${__('events.load_failed')}');
    eventPhotoList = await res.json();
    if (!eventPhotoList || eventPhotoList.length === 0) {
      container.innerHTML = '<div style="color:var(--text2);font-size:13px;grid-column:1/-1">${__('events.no_photos')}</div>';
      return;
    }
    container.innerHTML = eventPhotoList.map(function(p) {
      var isV = p.mediaType === 'video';
      var hasThumb = isV && p.thumbnail && p.thumbnail.indexOf('placeholder') === -1;
      var mediaHtml;
      if (isV && hasThumb) {
        mediaHtml = '<img src="' + escAttr(p.thumbnail) + '" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover">';
      } else if (isV) {
        mediaHtml = '<div class="photo-item-video-thumb" style="width:100%;height:100%;background:#1a1a2e;display:flex;align-items:center;justify-content:center;border-radius:6px"><span style="font-size:28px">🎬</span></div>';
      } else {
        mediaHtml = '<img src="' + escAttr(p.thumbnail || p.url) + '" alt="" loading="lazy">';
      }
      return '<div class="photo-item" onclick="showEventPhoto(\'' + escJsStr(String(p.id)) + '\')">'
        + mediaHtml
        + (isV ? '<span class="album-media-badge" style="position:absolute;bottom:4px;right:4px;font-size:14px">🎬</span>' : '')
        + '</div>';
    }).join('');
  } catch {
    container.innerHTML = '<div style="color:var(--text2);font-size:13px;grid-column:1/-1">${__('events.load_failed')}</div>';
  }
}

function showEventPhoto(photoId) {
  const idx = eventPhotoList.findIndex(p => String(p.id) === String(photoId));
  if (idx === -1) return;
  // 确保 photo 也在 albumPhotoList 中（让弹窗能工作）
  // 把 eventPhotoList 合并到 albumPhotoList 去重
  eventPhotoList.forEach(ep => {
    if (!albumPhotoList.find(ap => String(ap.id) === String(ep.id))) {
      albumPhotoList.push(ep);
    }
  });
  showLightbox(photoId);
}

// 显示指定用户报名的活动
window.loadUserEvents = async function(userId) {
  try {
    const container = document.getElementById('eventsList');
    if (container) container.innerHTML = Array(6).fill('<div class="skeleton-card-grid"></div>').join('');
    const res = await api(`/api/users/${userId}/events`, { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      eventsCache = data.events || [];
      // 清除状态筛选
      currentEvtStatus = 'all';
      document.querySelectorAll('.evt-status-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.status === 'all'));
      renderEvents(eventsCache);
    }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('events.load_user_events_failed'), 'error'); }
};
