// ==================== 活动系统 V5.6 — 仅常规活动，生日派对移入生日Tab ====================
let eventsCache = [];
let currentEvtStatus = 'all';
let eventsLoading = false;
// 批量管理：当前已勾选（可管理）的活动 id 集合
let selectedEventIds = new Set();

async function loadEvents(status = 'ongoing') {
  const container = document.getElementById('eventsList');
  if (container) showSkeleton(container, 'grid', 6);
  if (eventsLoading) return;
  eventsLoading = true;
  try {
    let url = '/api/events?type=activity';
    if (status && status !== 'all') url += '&status=' + status;
    const res = await api(url, { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      eventsCache = data.events || [];
      renderEvents(eventsCache);
      const evtCount = document.getElementById('evtCount');
      if (evtCount) evtCount.textContent = `(${data.total != null ? data.total : eventsCache.length})`;
      if (typeof checkTabBadges === 'function') checkTabBadges();
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('events.load_failed'), 'error');
  } finally {
    eventsLoading = false;
  }
}

function switchEvtStatus(status) {
  if (eventsLoading) return;
  currentEvtStatus = status;
  document.querySelectorAll('.evt-status-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.status === status));
  loadEvents(status);
}

// 合并常规活动 + 生日派对，供日历/周视图统一展示（F-9 events+birthday）
function getCalendarEvents() {
  const acts = eventsCache || [];
  const bdays = (typeof window.birthdayPartiesCache !== 'undefined' && window.birthdayPartiesCache) ? window.birthdayPartiesCache : [];
  const map = new Map();
  acts.concat(bdays).forEach(e => { if (e && e.id != null) map.set(e.id, e); });
  return Array.from(map.values());
}
// 进入日历视图前确保活动与生日派对数据均已加载
function ensureCalendarData() {
  const p1 = (eventsCache.length === 0) ? loadEvents(currentEvtStatus) : Promise.resolve();
  const needBday = typeof window.birthdayPartiesCache === 'undefined' || window.birthdayPartiesCache.length === 0;
  let p2 = Promise.resolve();
  if (needBday) {
    if (typeof loadBirthdayParties === 'function') {
      p2 = loadBirthdayParties();
    } else if (typeof _loadScriptOnce === 'function') {
      // birthday.js 未加载（events tab 不含该模块，空闲预载可能未完成）：按需拉取模块后再装载数据
      p2 = _loadScriptOnce('birthday.js')
        .then(() => (typeof loadBirthdayParties === 'function' ? loadBirthdayParties() : undefined))
        .catch(() => { /* 模块拉取失败不阻塞日历渲染 */ });
    }
  }
  return Promise.all([p1, p2]);
}

let calSubView = 'month'; // 日历子视图：month / week（「日历」入口按钮进入上次的子视图，默认月历）
function switchEvtView(view) {
  // 「日历」入口按钮 data-view="calendar"：映射为记住的子视图（默认月历）
  if (view === 'calendar') view = (calSubView === 'week') ? 'week' : 'month';
  document.querySelectorAll('.evt-view-btn').forEach(b => b.classList.remove('active'));
  const isCal = (view === 'month' || view === 'week');
  document.querySelector(`.evt-view-btn[data-view="${isCal ? 'calendar' : view}"]`)?.classList.add('active');
  // 切换列表/日历容器
  document.getElementById('eventsListView')?.classList.toggle('d-none', view !== 'list');
  document.getElementById('eventsCalendarView')?.classList.toggle('d-none', !isCal);
  if (isCal) {
    calSubView = view;
    calendarViewDate = new Date();
    ensureCalendarData().then(() => {
      if (view === 'month') renderCalendarView(getCalendarEvents());
      else renderWeekView(getCalendarEvents());
    });
  }
}
// 日历内部月/周子视图切换（导航栏按钮调用）
window.switchCalView = function (sub) {
  if (sub === 'month' || sub === 'week') switchEvtView(sub);
};

function renderEvents(events) {
  const container = document.getElementById('eventsList');
  if (!container) return;
  if (!events || events.length === 0) {
    const canCreate = currentUser && (currentUser.role === 'admin' || currentUser.role === 'super_admin');
    renderEmpty(container, {
      icon: '🎉',
      text: __('events.no_events'),
      actions: canCreate ? [{ label: __('events.create_first'), onClick: showEventModal }] : []
    });
    // 列表清空：同步清理批量选择（防止残留不可见的已选项被误删）
    selectedEventIds.clear();
    updateBatchBar();
    return;
  }
  // 选择集裁剪：仅保留「当前可见且可管理」的活动（与卡片 canManage 同源判断，切换筛选后不留不可见勾选）
  const validIds = new Set();
  const myUid2 = currentUser ? currentUser.id : null;
  events.forEach(e => {
    const can = currentUser && (currentUser.role === 'admin' || currentUser.role === 'super_admin' || (e.createUserId != null && myUid2 != null && String(e.createUserId) === String(myUid2)));
    if (can) validIds.add(String(e.id));
  });
  selectedEventIds = new Set(Array.from(selectedEventIds).filter(id => validIds.has(id)));
  const isAdminOrSuper = currentUser && (currentUser.role === 'admin' || currentUser.role === 'super_admin');
  const myUid = currentUser ? currentUser.id : null;
  container.innerHTML = events.map(e => {
    const cd = getCountdown(e.time, e.endsAt); const evtStatus = getEventStatus(e.time, e.endsAt);
    const ended = evtStatus === 'past';
    const isCreator = myUid != null && e.createUserId != null && String(e.createUserId) === String(myUid);
    // 管理权限：管理员/超级管理员，或活动创建者本人
    const canManage = isAdminOrSuper || isCreator;
    const visBadge = e.visibility === 'public' ? '<span class="visibility-badge public">' + __('events.public') + '</span>' : e.visibility === 'members_only' ? '<span class="visibility-badge members">' + __('events.member_only_tag') + '</span>' : '';
    const worldThumb = e.worldImageUrl ? `<div class="event-world-thumb-wrap"><img src="${escAttr(e.worldImageUrl)}" class="event-world-thumb" alt="${esc(e.worldName || 'World')}" loading="lazy" onerror="this.parentElement.style.display='none'"></div>` : '';
    // 列表卡片管理操作：编辑 + 删除（管理员/创建者可操作；已结束活动仅管理员可删，普通创建者不可）
    const editBtn = canManage ? `<button type="button" class="event-edit-btn" title="${__('events.edit_event')}" onclick="event.stopPropagation();editEventCard('${escJsStr(String(e.id))}')">✏️</button>` : '';
    const delBtn = canManage ? `<button type="button" class="event-del-btn" title="${__('events.delete')}" ${((!isAdminOrSuper && ended) ? 'disabled' : '')} onclick="event.stopPropagation();confirmDeleteEvent('${escJsStr(String(e.id))}'${e.eventType === 'birthday' ? ', true' : ''})">🗑️</button>` : '';
    // 批量选择框：仅对「可管理」卡片显示（与删除权限一致）
    const chk = canManage ? `<label class="event-select" onclick="event.stopPropagation()"><input type="checkbox" class="evt-select-cb" data-evt-id="${escAttr(String(e.id))}" ${selectedEventIds.has(String(e.id)) ? 'checked' : ''} onchange="onEventSelectChange('${escJsStr(String(e.id))}', this.checked)"></label>` : '';
    return `<div class="event-card ${evtStatus === 'past' ? 'past' : ''}" data-evt-id="${escAttr(String(e.id))}" onclick="showEventDetail('${escJsStr(String(e.id))}')">
      ${chk}
      ${editBtn}
      ${worldThumb}
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:6px">
        ${cd ? `<span class="event-countdown ${cd.cls}">⏱ ${cd.text}</span>` : evtStatus === 'past' ? '<span class="event-countdown past">✅ ' + __('events.ended') + '</span>' : evtStatus === 'upcoming' ? '<span class="event-countdown upcoming">📅 ' + __('events.about_to_start') + '</span>' : ''}
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
  // 渲染后同步批量工具条（可见性/计数/全选态）
  updateBatchBar();
}

// 超级管理员从卡片直接编辑活动
function editEventCard(id) {
  window._currentEventId = parseInt(id);
  showEditEvent();
}

// ==================== 活动批量管理 ====================
// 勾选变化：维护选中集合并刷新工具条
function onEventSelectChange(evtId, checked) {
  evtId = String(evtId);
  if (checked) selectedEventIds.add(evtId); else selectedEventIds.delete(evtId);
  updateBatchBar();
}

// 全选/取消全选（仅针对当前列表「可管理」卡片）
function toggleSelectAll(checked) {
  const cards = document.querySelectorAll('#eventsList .event-card[data-evt-id]');
  cards.forEach(card => {
    const id = card.dataset.evtId;
    const cb = card.querySelector('.evt-select-cb');
    if (!cb) return; // 不可管理卡片无勾选框
    cb.checked = checked;
    if (checked) selectedEventIds.add(id); else selectedEventIds.delete(id);
  });
  updateBatchBar();
}

// 刷新批量工具条（计数 / 删除按钮可用态 / 可见性）
function updateBatchBar() {
  const bar = document.getElementById('evtBatchBar');
  const countEl = document.getElementById('evtBatchCount');
  const delBtn = document.getElementById('evtBatchDeleteBtn');
  const selectAllCb = document.getElementById('evtSelectAll');
  if (!bar) return;
  const hasManageable = document.querySelector('#eventsList .evt-select-cb');
  bar.classList.toggle('d-none', !hasManageable); // 无管理权限（列表里无勾选框）则隐藏工具条
  const n = selectedEventIds.size;
  if (countEl) countEl.textContent = `已选 ${n} 项`;
  if (delBtn) delBtn.disabled = n === 0;
  const archBtn = document.getElementById('evtBatchArchiveBtn');
  if (archBtn) archBtn.disabled = n === 0;
  // 全选框状态：与当前列表可管理卡片勾选情况同步
  if (selectAllCb) {
    const all = document.querySelectorAll('#eventsList .evt-select-cb');
    const checked = document.querySelectorAll('#eventsList .evt-select-cb:checked');
    selectAllCb.checked = all.length > 0 && all.length === checked.length;
    selectAllCb.indeterminate = checked.length > 0 && checked.length < all.length;
  }
}

// 取消批量选择
function cancelBatchSelect() {
  selectedEventIds.clear();
  document.querySelectorAll('#eventsList .evt-select-cb').forEach(cb => cb.checked = false);
  updateBatchBar();
}

// 批量归档：确认 → 调后端 batch-archive → 清理缓存 + 刷新列表/日历
async function batchArchiveEvents() {
  if (selectedEventIds.size === 0) return;
  const ids = Array.from(selectedEventIds).map(id => parseInt(id, 10));
  showConfirm(__('events.batch_archive_confirm', { n: ids.length }), async () => {
    try {
      const res = await api('/api/events/batch-archive', { method: 'POST', body: { ids } });
      if (res.ok) {
        const data = res.ok ? await res.json() : null;
        toast(__('events.batch_archived', { n: (data && data.archived) || ids.length }), 'success');
        selectedEventIds.clear();
        loadEvents(currentEvtStatus);
        const calView = document.getElementById('eventsCalendarView');
        if (calView && !calView.classList.contains('d-none')) {
          if (calSubView === 'week') renderWeekView(getCalendarEvents());
          else renderCalendarView(getCalendarEvents());
        }
      } else {
        toast(__('events.batch_archive_failed'), 'error');
      }
    } catch (err) {
      if (isApiHandledError(err)) return;
      toast(__('events.batch_archive_failed'), 'error');
    }
  });
}

// 批量删除：确认 → 调后端 batch-delete → 清理缓存 + 刷新列表/日历
async function batchDeleteEvents() {
  if (selectedEventIds.size === 0) return;
  const ids = Array.from(selectedEventIds).map(id => parseInt(id, 10));
  showConfirm(__('events.batch_delete_confirm', { n: ids.length }), async () => {
    try {
      const res = await api('/api/events/batch-delete', { method: 'POST', body: { ids } });
      const data = res.ok ? await res.json() : null;
      if (res.ok) {
        toast(__('events.batch_deleted', { n: (data && data.deleted) || ids.length }), 'success');
        // 从内存缓存剔除，避免幽灵项
        eventsCache = (eventsCache || []).filter(e => !selectedEventIds.has(String(e.id)));
        if (window.birthdayPartiesCache) window.birthdayPartiesCache = window.birthdayPartiesCache.filter(e => !selectedEventIds.has(String(e.id)));
        selectedEventIds.clear();
        loadEvents(currentEvtStatus);
        // 生日模块跨模块同步
        if (typeof loadBirthdayParties === 'function') loadBirthdayParties();
        if (typeof loadBirthdays === 'function') loadBirthdays();
        // 日历视图强制重渲染
        const calView = document.getElementById('eventsCalendarView');
        if (calView && !calView.classList.contains('d-none')) {
          if (calSubView === 'week') renderWeekView(getCalendarEvents());
          else renderCalendarView(getCalendarEvents());
        }
      } else {
        toast(__('events.batch_delete_failed'), 'error');
      }
    } catch (err) {
      if (isApiHandledError(err)) return;
      toast(__('events.batch_delete_failed'), 'error');
    }
  });
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
  return { text: __('events.ongoing'), cls: 'ongoing' };
}
function getEventStatus(timeStr, endsStr) {
  if (!timeStr) return 'unknown';
  const now = new Date();
  const start = new Date(timeStr);
  // endsAt 缺失时按开始时间 + 默认 3 小时兜底，避免无结束时间的过去活动误判为进行中
  const ends = endsStr ? new Date(endsStr) : new Date(start.getTime() + 3 * 60 * 60 * 1000);
  if (now > ends) return 'past';
  if (now < start) return 'upcoming';
  return 'ongoing';
}

async function showEventDetail(id) {
  window.showEventDetail = showEventDetail;
  window._currentEventId = parseInt(id);
  try {
    const res = await api(`/api/events/detail/${id}`, { method: 'GET' });
    if (res.ok) {
      const e = await res.json();
      const ended = !!(e.ended);
      window._currentEventDetail = e;
      // 以服务端 signedByMe 为准同步报名状态（修复登录后已报名活动仍显示__('auto_events_1')的问题）
      if (e.signedByMe) signedEvents.add(parseInt(id)); else signedEvents.delete(parseInt(id));
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
        ? '<span class="visibility-badge public">' + __('events.public') + '</span>'
        : '<span class="visibility-badge members">' + __('events.member_only') + '</span>';
      document.getElementById('evtDetDesc').innerHTML = escapeNewlines(e.desc || e.description || __('no_data'));
      showEl('evtDetSignBar');
      showEl('evtDetPhotos');
      showEl('evtDetComments');
      showEl('evtDetTeamsSection');

      // 已结束活动横幅
      const endedBannerEl = document.getElementById('evtDetEndedBanner');
      if (endedBannerEl) endedBannerEl.style.display = ended ? '' : 'none';
      
      // 管理操作 — 管理员或活动创建者可见（删除权限后端同样按此放宽）
      const isAdmin = currentUser && (currentUser.role === 'admin' || currentUser.role === 'super_admin');
      const isCreator = currentUser && e.createUserId != null && String(e.createUserId) === String(currentUser.id);
      const canManage = isAdmin || isCreator;
      document.getElementById('evtDetAdminActions').style.display = canManage ? '' : 'none';
      if (canManage) {
        const typeIcons = { activity: '🎮', meeting: '🤝', birthday: '🎂', other: '📋' };
  const typeLabels = { activity: __('events.type_activity'), meeting: __('events.type_meeting'), birthday: __('events.type_birthday'), other: __('events.type_other') };
  const eventIcon = typeIcons[e.eventType] || '📅';
  const isBirthday = e.eventType === 'birthday';
        // 删除权限：管理员/超级管理员始终可删（含已结束活动）；普通创建者仅未结束活动可删。
        const deleteDisabled = (!isAdmin && ended);
        const deleteBtn = deleteDisabled
          ? `<button class="btn btn-sm btn-danger ml-6" disabled title="${__('events.ended_no_delete')}">${__('events.delete')}</button>`
          : (isBirthday
            ? `<button class="btn btn-sm btn-danger ml-6" onclick="confirmDeleteEvent(${id}, true)">${__('events.delete')}</button>`
            : `<button class="btn btn-sm btn-danger ml-6" onclick="confirmDeleteEvent(${id}, false)">${__('events.delete')}</button>`);
      // 签到按钮仅管理员可见（后端 /checkin 仅管理员可调用，避免创建者误点收到 403）
      const checkinBtnHtml = isAdmin ? `<button class="btn btn-sm btn-white-glass ml-6" id="evtDetCheckinBtn">✅ ${__('events.sign_in')}</button>` : '';
      document.getElementById('evtDetAdminActions').innerHTML = isBirthday
        ? `<button class="btn btn-sm btn-white-glass" onclick="editBirthdayParty(${id})">${__('events.edit_party')}</button>
           ${deleteBtn}
           ${checkinBtnHtml}
           <button class="btn btn-sm btn-white-glass ml-6" onclick="sharePublicLink('event', ${id})">🔗 ${__('share.btn')}</button>`
        : `<button class="btn btn-sm btn-white-glass" onclick="showEditEvent()">${__('events.edit_event')}</button>
           ${deleteBtn}
           ${checkinBtnHtml}
           <button class="btn btn-sm btn-white-glass ml-6" onclick="sharePublicLink('event', ${id})">🔗 ${__('share.btn')}</button>`;
      }
      if (isAdmin) showEl('evtDetCheckinBar'); else hideEl('evtDetCheckinBar');
      document.getElementById('evtDetUploadBtn').className = isAdmin ? '' : 'd-none';
      // 已结束活动：禁用签到入口（编辑入口保留供管理员使用）
      const evtCheckinBtn = document.getElementById('evtDetCheckinBtn');
      if (evtCheckinBtn) {
        if (ended) { evtCheckinBtn.disabled = true; evtCheckinBtn.classList.add('disabled'); evtCheckinBtn.title = __('events.ended_no_checkin'); }
        else { evtCheckinBtn.disabled = false; evtCheckinBtn.classList.remove('disabled'); }
      }
      
      // ${__('events.sign_in')}列表
      const checkinListEl = document.getElementById('evtDetCheckinList');
      if (checkinListEl && e.checkinList) {
        checkinListEl.innerHTML = e.checkinList.length > 0 
          ? e.checkinList.map(c =>
              `<div class="det-checkin-item">✅ ${esc(c.user_name || c.displayName || c.name || __('events.user'))}</div>`
            ).join('') 
          : '<div class="text-muted text-12">' + __('events.no_sign_ins') + '</div>';
      }
      const checkinCountEl = document.getElementById('evtDetCheckinCount');
      if (checkinCountEl) checkinCountEl.textContent = `${__('events.n_checked_in', {n: e.checkinCount || 0})}`;
      
      // 报名按钮
      const signBtn = document.getElementById('evtDetSignBtn');
      if (signBtn) {
        if (ended) {
          signBtn.innerHTML = '<span class="event-ended-tag">🚫 ' + __('events.ended') + '</span>';
        } else {
        const isSigned = e.signedByMe === true || signedEvents.has(parseInt(id));
        if (currentUser && !currentUser.banned) {
          if (e.maxSign > 0 && e.signCount >= e.maxSign) {
            signBtn.innerHTML = '<span class="text-muted">' + __('events.full') + '</span>';
          } else if (isSigned) {
            signBtn.innerHTML = `<button class="btn btn-sm sign-btn-cancel" onclick="unsignEvent(${id})">${__('events.signed_cancel')}</button>`;
          } else {
            signBtn.innerHTML = `<button class="btn btn-sm btn-accent" onclick="signEvent(${id})">${__('events.sign_up_btn')}</button>`;
          }
        } else {
          signBtn.innerHTML = '<span class="text-muted">' + __('events.login_to_sign') + '</span>';
        }
        }
      }
      
      document.getElementById('evtDetSignCount').textContent = `${__('events.signed_up_count', {n: e.signCount || 0})}`;
      document.getElementById('evtDetMaxSign').textContent = e.maxSign ? `/ ${__('events.limit', {n: e.maxSign})}` : '';
      
      // 报名列表
      const signList = document.getElementById('evtDetSignList');
      if (signList && e.signList) {
        signList.innerHTML = e.signList.length > 0 
          ? e.signList.map(s =>
              `<div class="det-sign-item">${__('events.user_prefix')}${esc(s.user_name || s.displayName || s.name || __('events.user'))}</div>`
            ).join('') 
          : '<div class="text-muted text-12">' + __('events.no_signups') + '</div>';
      }
      
      // 初始化${__('events.sign_in')}按钮
      initCheckinBtn();
      // 使用 showModal 带动画
      showModal('eventDetailModal');
      // 加载评论
      loadEventComments(id);
      loadEventPhotos(id);
      loadEventTeams(id);
      // 已结束活动：关闭评论输入与发送
      const cInput = document.getElementById('evtDetCommentInput');
      const cSend = document.getElementById('evtDetCommentSendBtn');
      if (ended) {
        if (cInput) { cInput.disabled = true; cInput.placeholder = __('events.comments_closed'); }
        if (cSend) { cSend.disabled = true; cSend.classList.add('disabled'); }
      } else {
        if (cInput) { cInput.disabled = false; cInput.placeholder = __('events.write_comment'); }
        if (cSend) { cSend.disabled = false; cSend.classList.remove('disabled'); }
      }
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
  if (eventsLoading) return;
  eventsLoading = true;
  const container = document.getElementById('archiveList');
  if (!container) { eventsLoading = false; return; }
  container.innerHTML = '<div class="skeleton-card"></div>';
  try {
    const res = await api('/api/events?include_archived=1', { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      const archived = (data.events || []).filter(e => e.isArchive);
      if (archived.length === 0) {
        renderEmpty(container, { icon: '📦', text: __('events.no_archive') });
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
  } catch { if (container) container.innerHTML = '<div class="text-13 text-red">' + __('events.load_failed') + '</div>'; }
  finally { eventsLoading = false; }
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
  if (maxSign < 0) { toast(__('events.max_sign_invalid'), 'error'); return; }
  if (endTime && endTime <= eventTime) { toast(__('events.end_before_start'), 'error'); return; }
  const btn = document.getElementById('evtModalSaveBtn');
  if (btn) { btn.disabled = true; btn.dataset.old = btn.textContent; btn.textContent = __('events.submitting'); }
  try {
    const body = { title, description: desc, time: eventTime, endsAt: endTime || undefined, worldId, worldName, worldImageUrl, visibility, place, maxSign };
    const res = await api('/api/events', { method: 'POST', body });
    if (res.ok) { toast(__('events.created'), 'success'); sessionStorage.removeItem('evtDraft'); closeModal('eventModal'); if (!document.getElementById('tab-events')?.classList.contains('d-none')) { switchEvtView('list'); reloadEventsSmart(eventTime); } else { loadEvents(currentEvtStatus); } }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('operation_failed'), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = btn.dataset.old; }
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
  if (maxSign < 0) { toast(__('events.max_sign_invalid'), 'error'); return; }
  if (endTime && endTime <= eventTime) { toast(__('events.end_before_start'), 'error'); return; }
  const btn = document.getElementById('bdaySaveBtn');
  if (btn) { btn.disabled = true; btn.dataset.old = btn.textContent; btn.textContent = __('events.submitting'); }
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
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = btn.dataset.old || __('create'); }
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
      if (!res.ok) { throw new Error(__('events.load_failed')); }
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
      showEl(preview, 'flex');
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
  const endsAt = document.getElementById('eeEndsAt')?.value || undefined;
  const maxSign = parseInt(document.getElementById('eeMaxSign')?.value) || 0;
  if (!title || !time) { toast(__('events.title_time_required'), 'error'); return; }
  if (maxSign < 0) { toast(__('events.max_sign_invalid'), 'error'); return; }
  if (endsAt && endsAt <= time) { toast(__('events.end_before_start'), 'error'); return; }
  const btn = document.getElementById('eeSaveBtn');
  if (btn) { btn.disabled = true; btn.dataset.old = btn.textContent; btn.textContent = __('events.submitting'); }
  try {
    const res = await api(`/api/events/${id}`, {
      method: 'PUT',
      body: {
        title,
        time,
        endsAt,
        place: document.getElementById('eePlace')?.value,
        desc: document.getElementById('eeDesc')?.value,
        maxSign,
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
      // 编辑后仅刷新当前筛选页，不强制切换 Tab（避免编辑被意外挪到 upcoming 的 Tab 漂移）
      loadEvents(currentEvtStatus);
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('events.edit_failed'), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = btn.dataset.old; }
  }
}

// ==================== 删除活动 / 生日活动 ====================
// id: 活动 id；isBirthday: 是否为生日活动（用于删除后刷新 birthday 模块）
async function confirmDeleteEvent(id, isBirthday) {
  id = id || window._currentEventId;
  if (!id) { toast(__('events.cannot_get_id'), 'error'); return; }
  const msg = isBirthday ? __('events.delete_birthday_confirm') : __('events.delete_confirm');
  showConfirm(msg, async () => {
    try {
      const res = await api(`/api/events/${id}`, { method: 'DELETE' });
      if (res.ok) {
        toast(__('events.deleted'), 'success');
        closeModal('eventDetailModal');
        // 立即从内存缓存剔除已删活动，避免日历/列表幽灵项（D5）
        const delId = parseInt(id);
        eventsCache = (eventsCache || []).filter(e => parseInt(e.id) !== delId);
        if (window.birthdayPartiesCache) window.birthdayPartiesCache = window.birthdayPartiesCache.filter(e => parseInt(e.id) !== delId);
        loadEvents(currentEvtStatus);
        // 生日活动同时刷新生日模块（派对列表 + 日历），保持跨模块状态同步
        if (typeof loadBirthdayParties === 'function') loadBirthdayParties();
        if (typeof loadBirthdays === 'function') loadBirthdays();
        // 若当前处于日历视图，强制重渲染以消除残留（D5）
        const calView = document.getElementById('eventsCalendarView');
        if (calView && !calView.classList.contains('d-none')) {
          if (calSubView === 'week') renderWeekView(getCalendarEvents());
          else renderCalendarView(getCalendarEvents());
        }
      } else {
        toast(__('events.delete_failed'), 'error');
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
        list.innerHTML = '<div class="text-muted text-12">' + __('events.no_comments') + '</div>';
        return;
      }
      list.innerHTML = comments.map(c => `
        <div class="det-comment-item" data-comment-id="${c.id}">
          <img src="${escAttr(c.avatarUrl || '/api/avatar/default')}" class="det-comment-avatar" alt="" loading="lazy">
          <div class="det-comment-body">
            <div class="det-comment-header">
              <span class="det-comment-user">${esc(c.userName || __('unknown_user'))}</span>
              <span class="det-comment-time">${fmtTime(c.createdAt)}</span>
              ${currentUser && (currentUser.id === c.userId || currentUser.role === 'super_admin' || currentUser.role === 'admin') ? 
                `<button class="btn-text det-comment-del" onclick="editEventComment(${eventId}, ${c.id})">${__('edit')}</button><button class="btn-text det-comment-del" onclick="deleteEventComment(${eventId}, ${c.id})">${__('delete')}</button>` : ''}
            </div>
            <div class="det-comment-content" id="eventCommentText-${c.id}">${esc(c.content)}</div>
          </div>
        </div>
      `).join('');
    }
  } catch { const list = document.getElementById('evtDetCommentList'); if (list) list.innerHTML = '<div class="text-muted text-12">' + __('events.load_failed') + '</div>'; }
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

async function editEventComment(eventId, commentId) {
  eventId = parseInt(eventId);
  commentId = parseInt(commentId);
  if (isNaN(eventId) || isNaN(commentId)) { toast(__('events.param_error'), 'error'); return; }
  const textEl = document.getElementById('eventCommentText-' + commentId);
  if (!textEl) return;
  const original = textEl.textContent;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = original;
  input.maxLength = 2000;
  input.className = 'det-comment-edit-input';
  textEl.innerHTML = '';
  textEl.appendChild(input);
  input.focus();
  const finish = async (save) => {
    if (save) {
      const content = input.value.trim();
      if (!content) { loadEventComments(eventId); return; }
      try {
        const res = await api(`/api/events/${eventId}/comments/${commentId}`, { method: 'PUT', body: { content } });
        if (res.ok) { toast(__('operation_success'), 'success'); loadEventComments(eventId); }
        else { loadEventComments(eventId); }
      } catch { toast(__('events.comment_post_failed'), 'error'); loadEventComments(eventId); }
    } else {
      loadEventComments(eventId);
    }
  };
  input.onkeydown = function(e) {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  input.onblur = function() { finish(true); };
}

// ==================== 活动${__('events.sign_in')} ====================
function initCheckinBtn() {
  const btn = document.getElementById('evtDetCheckinBtn');
  if (btn) {
    btn.onclick = async function() {
      const eventId = window._currentEventId;
      if (!eventId) { toast(__('events.cannot_get_id'), 'error'); return; }
      showConfirm(__('events.mark_all_checkin'), async () => {
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
  // 注意：这里不能写 `getElementById('qrModal') || {style:{},innerHTML:''}` ——
  // 那个占位对象恒为真且没有 remove()，弹窗不存在时会抛
  // "existing.remove is not a function"，也就是第一次点二维码必然失败。
  const existing = document.getElementById('qrModal');
  if (existing) existing.remove();
  const div = document.createElement('div');
  div.id = 'qrModal';
  div.className = 'modal';
  div.innerHTML = `<div class="modal-content modal-sm"><div class="modal-header"><h3>📱 ${__('events.checkin_qr')}</h3><button class="modal-close" onclick="closeModal('qrModal')" aria-label="${__('events.aria_close')}">✕</button></div>${html}</div>`;
  document.body.appendChild(div);
  showModal('qrModal');
};
// 打开弹窗时自动填充__('auto_events_2')作为开始时间，+2h作为结束时间
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
  const year = calendarViewDate.getFullYear();
  const month = calendarViewDate.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date();
  const isCurrentMonth = today.getFullYear() === year && today.getMonth() === month;
  const todayDate = today.getDate();

  // 按日期索引活动
  const evtMap = {};
  if (events && events.length > 0) {
    events.forEach(e => {
    if (!e.time) return;
    const d = new Date(e.time);
    const day = d.getDate();
    if (d.getFullYear() === year && d.getMonth() === month) {
      if (!evtMap[day]) evtMap[day] = [];
      evtMap[day].push(e);
    }
  });
  }

  const monthNames = Array.from({length:12},(_,i)=>__('events.month_'+(i+1)));
  
  let html = `
    <div class="evt-calendar-nav">
      <button class="btn btn-sm btn-outline" onclick="calendarPrevMonth()" title="${__('events.prev_month')}">◀</button>
      <h3>${year} ${monthNames[month]}</h3>
      <div class="d-flex gap-4">
        <button class="btn btn-sm btn-outline" onclick="switchCalView('week')" title="${__('events.view_week')}">${__('events.view_week')}</button>
        ${!isCurrentMonth ? `<button class="evt-calendar-today-btn" onclick="resetCalendarMonth()" title="${__('events.back_to_today')}">${__('events.today')}</button>` : ''}
        <button class="btn btn-sm btn-outline" onclick="calendarNextMonth()" title="${__('events.next_month')}">▶</button>
      </div>
    </div>`;
  
  html += '<div class="evt-calendar-grid">';
  html += '<div class="evt-calendar-weekday">' + __('events.weekday_sun') + '</div><div class="evt-calendar-weekday">' + __('events.weekday_mon') + '</div><div class="evt-calendar-weekday">' + __('events.weekday_tue') + '</div><div class="evt-calendar-weekday">' + __('events.weekday_wed') + '</div><div class="evt-calendar-weekday">' + __('events.weekday_thu') + '</div><div class="evt-calendar-weekday">' + __('events.weekday_fri') + '</div><div class="evt-calendar-weekday">' + __('events.weekday_sat') + '</div>';
  
  // 空白格（当月第一天之前的）
  for (let i = 0; i < firstDay; i++) {
    html += '<div class="evt-calendar-day other-month" style="background:transparent;cursor:default"></div>';
  }
  
  for (let day = 1; day <= daysInMonth; day++) {
    const dayEvents = evtMap[day] || [];
    const hasEvent = dayEvents.length > 0;
    const hasBirthday = hasEvent && dayEvents.some(e => e.eventType === 'birthday');
    const isToday = isCurrentMonth && day === todayDate;
    const cls = 'evt-calendar-day' + (isToday ? ' today' : '') + (hasBirthday ? ' has-birthday' : '');
    let dayContent = `<div class="day-num">${day}</div>`;
    if (hasEvent) {
      const names = dayEvents.slice(0, 2).map(e => (e.eventType === 'birthday' ? '🎂 ' : '') + esc(e.title || '')).join('、');
      const cakeBadge = hasBirthday ? '<span class="evt-cake-badge" title="' + __('events.birthday_party') + '">🎂</span>' : '';
      dayContent += `<div class="evt-dots"><div class="evt-dot${hasBirthday ? ' evt-dot-birthday' : ''}" title="${esc(names)}">${__('events.count_events', {n: dayEvents.length})}</div>${cakeBadge}</div>`;
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
      <div class="cal-event-item${e.eventType === 'birthday' ? ' cal-event-birthday' : ''}" onclick="showEventDetail('${escJsStr(String(e.id))}')">
        <span class="cal-event-time">${fmtTime(e.time)}</span>
        <span class="cal-event-title">${e.eventType === 'birthday' ? '🎂 ' : ''}${esc(e.title)}</span>
        ${e.worldName ? `<span class="cal-event-world">🌐${esc(e.worldName)}</span>` : ''}
      </div>`).join('');
  } else {
      html += '<div class="text-muted text-13">' + __('events.no_events') + '</div>';
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
  renderCalendarView(getCalendarEvents());
};
window.calendarNextMonth = function() {
  calendarViewDate.setMonth(calendarViewDate.getMonth() + 1);
  renderCalendarView(getCalendarEvents());
};

// 重置日历到当月
window.resetCalendarMonth = function() {
  calendarViewDate = new Date();
  renderCalendarView(getCalendarEvents());
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
  const dayEvents = getCalendarEvents().filter(e => {
    if (!e.time) return false;
    const d = new Date(e.time);
    return d.getDate() === day && d.getMonth() === month && d.getFullYear() === year;
  });
  if (dayEvents.length === 0) {
    container.innerHTML = '<div class="text-muted text-13">' + __('events.no_events') + '</div>';
    return;
  }
  container.innerHTML = `<div class="cal-day-title">📌 ${__('events.date_format', {year: year, month: month+1, day: day})} (${__('events.count_events', {n: dayEvents.length})})</div>` +
    dayEvents.map(e => `
      <div class="cal-event-item${e.eventType === 'birthday' ? ' cal-event-birthday' : ''}" onclick="showEventDetail('${escJsStr(String(e.id))}')">
        <span class="cal-event-time">${fmtTime(e.time)}</span>
        <span class="cal-event-title">${e.eventType === 'birthday' ? '🎂 ' : ''}${esc(e.title)}</span>
        ${e.worldName ? `<span class="cal-event-world">🌐${esc(e.worldName)}</span>` : ''}
      </div>`).join('');
}

// ==================== 周视图 ====================
function renderWeekView(events) {
  const container = document.getElementById('eventsCalendarView');
  if (!container) return;
  if (!events || events.length === 0) {
    renderEmpty(container, { icon: '📅', text: __('events.no_events') });
    return;
  }
  const today = new Date();
  const startOfWeek = new Date(calendarViewDate);
  startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
  const weekDays = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(startOfWeek);
    d.setDate(d.getDate() + i);
    weekDays.push(d);
  }
  const evtMap = {};
  weekDays.forEach(d => {
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    evtMap[key] = [];
  });
  events.forEach(e => {
    if (!e.time) return;
    const d = new Date(e.time);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (evtMap[key]) {
      evtMap[key].push(e);
    }
  });
  const monthNames = Array.from({length:12},(_,i)=>__('events.month_'+(i+1)));
  let html = `
    <div class="evt-calendar-nav">
      <button class="btn btn-sm btn-outline" onclick="weekPrev()" title="${__('events.prev_week')}">◀</button>
      <h3>${weekDays[0].getFullYear()} ${monthNames[weekDays[0].getMonth()]} ${weekDays[0].getDate()} - ${monthNames[weekDays[6].getMonth()]} ${weekDays[6].getDate()}</h3>
      <div class="d-flex gap-4">
        <button class="btn btn-sm btn-outline" onclick="switchCalView('month')" title="${__('events.view_month')}">${__('events.view_month')}</button>
        <button class="evt-calendar-today-btn" onclick="resetWeek()" title="${__('events.back_to_today')}">${__('events.today')}</button>
        <button class="btn btn-sm btn-outline" onclick="weekNext()" title="${__('events.next_week')}">▶</button>
      </div>
    </div>`;
  html += '<div class="week-view-grid">';
  weekDays.forEach((d, idx) => {
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const dayEvents = evtMap[key] || [];
    const isToday = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
    const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map(d => __('events.weekday_' + d));
    html += `<div class="week-view-day${isToday ? ' today' : ''}" onclick="weekShowDayEvents(${d.getDate()}, ${d.getMonth()}, ${d.getFullYear()})">`;
    html += `<div class="week-day-header">${dayNames[idx]}<br><span class="week-day-num">${d.getDate()}</span></div>`;
    html += '<div class="week-day-events">';
    if (dayEvents.length > 0) {
      dayEvents.slice(0, 3).forEach(e => {
        html += `<div class="week-event-item${e.eventType === 'birthday' ? ' week-event-birthday' : ''}" onclick="showEventDetail('${escJsStr(String(e.id))}')">${e.eventType === 'birthday' ? '🎂 ' : ''}${esc(e.title)}</div>`;
      });
      if (dayEvents.length > 3) {
        html += `<div class="week-event-more">+${dayEvents.length - 3}</div>`;
      }
    } else {
      html += '<div class="week-day-empty"></div>';
    }
    html += '</div></div>';
  });
  html += '</div>';
  html += '<div class="cal-day-events" id="calDayEvents"><div class="text-muted text-13">' + __('events.select_day') + '</div></div>';
  container.innerHTML = html;
}
window.weekPrev = function() {
  calendarViewDate.setDate(calendarViewDate.getDate() - 7);
  renderWeekView(getCalendarEvents());
};
window.weekNext = function() {
  calendarViewDate.setDate(calendarViewDate.getDate() + 7);
  renderWeekView(getCalendarEvents());
};
window.resetWeek = function() {
  calendarViewDate = new Date();
  renderWeekView(getCalendarEvents());
};
window.weekShowDayEvents = function(day, month, year) {
  const container = document.getElementById('eventsCalendarView');
  if (!container) return;
  const dayEvents = getCalendarEvents().filter(e => {
    if (!e.time) return false;
    const d = new Date(e.time);
    return d.getDate() === day && d.getMonth() === month && d.getFullYear() === year;
  });
  const weekDays = container.querySelectorAll('.week-view-day');
  weekDays.forEach(w => w.classList.remove('selected'));
  weekDays.forEach(w => {
    const numEl = w.querySelector('.week-day-num');
    if (numEl && parseInt(numEl.textContent) === day) w.classList.add('selected');
  });
  const dayEventsContainer = document.getElementById('calDayEvents');
  if (!dayEventsContainer) return;
  if (dayEvents.length === 0) {
    dayEventsContainer.innerHTML = '<div class="text-muted text-13">' + __('events.no_events') + '</div>';
    return;
  }
  const monthNames = Array.from({length:12},(_,i)=>__('events.month_'+(i+1)));
  dayEventsContainer.innerHTML = `<div class="cal-day-title">📌 ${year} ${monthNames[month]} ${day} (${__('events.count_events', {n: dayEvents.length})})</div>` +
    dayEvents.map(e => `
      <div class="cal-event-item${e.eventType === 'birthday' ? ' cal-event-birthday' : ''}" onclick="showEventDetail('${escJsStr(String(e.id))}')">
        <span class="cal-event-time">${fmtTime(e.time)}</span>
        <span class="cal-event-title">${e.eventType === 'birthday' ? '🎂 ' : ''}${esc(e.title)}</span>
        ${e.worldName ? `<span class="cal-event-world">🌐${esc(e.worldName)}</span>` : ''}
      </div>`).join('');
};

// ==================== 活动照片 ====================
let eventPhotoList = []; // 当前详情弹窗的活动照片

async function loadEventPhotos(eventId) {
  const container = document.getElementById('evtDetPhotos');
  if (!container) return;
  container.innerHTML = '<div style="color:var(--text2);font-size:13px;grid-column:1/-1">📷 ' + __('events.loading') + '</div>';
  try {
    const res = await api(`/api/events/${eventId}/photos`, { method: 'GET' });
    if (!res.ok) throw new Error(__('events.load_failed'));
    eventPhotoList = await res.json();
    if (!eventPhotoList || eventPhotoList.length === 0) {
      container.innerHTML = '<div style="color:var(--text2);font-size:13px;grid-column:1/-1">' + __('events.no_photos') + '</div>';
      return;
    }
    container.innerHTML = eventPhotoList.map(function(p) {
      var isV = p.mediaType === 'video';
      var hasThumb = isV && p.thumbnail && p.thumbnail.indexOf('placeholder') === -1;
      var mediaHtml;
      if (isV && hasThumb) {
        mediaHtml = '<img src="' + escAttr(p.thumbnail) + '" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover">';
      } else if (isV) {
        mediaHtml = '<div class="photo-item-video-thumb" style="width:100%;height:100%;background:var(--bg-secondary);display:flex;align-items:center;justify-content:center;border-radius:6px"><span style="font-size:28px">🎬</span></div>';
      } else {
        mediaHtml = '<img src="' + escAttr(p.thumbnail || p.url) + '" alt="" loading="lazy">';
      }
      return '<div class="photo-item" onclick="showEventPhoto(\'' + escJsStr(String(p.id)) + '\')">'
        + mediaHtml
        + (isV ? '<span class="album-media-badge" style="position:absolute;bottom:4px;right:4px;font-size:14px">🎬</span>' : '')
        + '</div>';
    }).join('');
  } catch {
    container.innerHTML = '<div style="color:var(--text2);font-size:13px;grid-column:1/-1">' + __('events.load_failed') + '</div>';
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

// ==================== 活动队伍系统 ====================
let eventTeamsCache = [];

async function loadEventTeams(eventId) {
  try {
    const res = await api(`/api/event-teams/${eventId}`);
    if (res.ok) {
      eventTeamsCache = await res.json();
      renderEventTeams(eventId);
    }
  } catch {}
}

function renderEventTeams(eventId) {
  const container = document.getElementById('evtDetTeams');
  if (!container) return;
  const teams = eventTeamsCache.teams || [];
  if (teams.length === 0) {
    container.innerHTML = '<div class="event-teams-empty">' + __('teams.no_teams') + '</div>' +
      '<button class="btn btn-sm btn-accent mt-8" onclick="openCreateTeam(' + eventId + ')">' + __('teams.create_team') + '</button>';
    return;
  }
  container.innerHTML = '<div class="event-teams-list">' + teams.map(t => {
    const members = t.members || [];
    const isMember = members.some(m => m.id === currentUser?.id);
    const isLeader = t.leader_id === currentUser?.id;
    return `
      <div class="event-team-card">
        <div class="event-team-header">
          <span class="event-team-name">${esc(t.name)}</span>
          <span class="event-team-count">${members.length} ${__('teams.members')}</span>
        </div>
        <div class="event-team-members">
          ${members.map(m => `
            <div class="event-team-member">
              <img src="${esc(m.avatarUrl || '/api/avatar/default')}" class="event-team-avatar" alt=""/>
              <span>${esc(m.display_name)}</span>
              ${m.id === t.leader_id ? '<span class="event-team-leader-badge">' + __('teams.leader') + '</span>' : ''}
            </div>
          `).join('')}
        </div>
        <div class="event-team-actions">
          ${isLeader ? `
            <button class="btn btn-sm btn-outline" onclick="disbandTeam(${t.id}, ${eventId})">${__('teams.disband')}</button>
          ` : isMember ? `
            <button class="btn btn-sm btn-outline" onclick="leaveTeam(${t.id}, ${eventId})">${__('teams.leave')}</button>
          ` : `
            <button class="btn btn-sm btn-accent" onclick="joinTeam(${t.id}, ${eventId})">${__('teams.join')}</button>
          `}
        </div>
      </div>
    `;
  }).join('') + '</div>';
}

function openCreateTeam(eventId) {
  const modal = ensureModal('createTeamModal', __('teams.create_team'));
  modal.innerHTML = `
    <div class="event-team-form">
      <div class="form-group">
        <label>${__('teams.team_name')} *</label>
        <input type="text" id="teamName" maxlength="30" placeholder="${__('teams.team_name_placeholder')}"/>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-outline" onclick="hideModal('createTeamModal')">${__('ui.cancel')}</button>
        <button class="btn btn-accent" onclick="submitCreateTeam(${eventId})">${__('teams.create')}</button>
      </div>
    </div>
  `;
  showModal('createTeamModal');
}

async function submitCreateTeam(eventId) {
  const name = document.getElementById('teamName')?.value.trim();
  if (!name) { toast(__('teams.team_name_required'), 'error'); return; }
  try {
    const res = await api('/api/event-teams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId, name })
    });
    if (res.ok) {
      toast(__('teams.created'), 'success');
      hideModal('createTeamModal');
      loadEventTeams(eventId);
    } else {
      const data = await res.json();
      toast(data.error || __('teams.create_failed'), 'error');
    }
  } catch { toast(__('teams.create_failed'), 'error'); }
}

async function joinTeam(teamId, eventId) {
  try {
    const res = await api(`/api/event-teams/${teamId}/join`, { method: 'POST' });
    if (res.ok) { toast(__('teams.joined'), 'success'); loadEventTeams(eventId); }
    else { const data = await res.json(); toast(data.error || __('teams.join_failed'), 'error'); }
  } catch { toast(__('teams.join_failed'), 'error'); }
}

async function leaveTeam(teamId, eventId) {
  if (!confirm(__('teams.confirm_leave'))) return;
  try {
    const res = await api(`/api/event-teams/${teamId}/leave`, { method: 'POST' });
    if (res.ok) { toast(__('teams.left'), 'success'); loadEventTeams(eventId); }
    else { const data = await res.json(); toast(data.error || __('teams.leave_failed'), 'error'); }
  } catch { toast(__('teams.leave_failed'), 'error'); }
}

async function disbandTeam(teamId, eventId) {
  if (!confirm(__('teams.confirm_disband'))) return;
  try {
    const res = await api(`/api/event-teams/${teamId}`, { method: 'DELETE' });
    if (res.ok) { toast(__('teams.disbanded'), 'success'); loadEventTeams(eventId); }
    else { const data = await res.json(); toast(data.error || __('teams.disband_failed'), 'error'); }
  } catch { toast(__('teams.disband_failed'), 'error'); }
}
