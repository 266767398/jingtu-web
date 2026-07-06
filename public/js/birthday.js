// ==================== 生日专区模块 ====================

let birthdaysCache = [];

async function loadBirthdays() {
  try {
    const res = await api('/api/users/birthdays', { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      birthdaysCache = data.birthdays || [];
      renderBirthdays(birthdaysCache);
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('birthday.load_failed'), 'error');
  }
}

function renderBirthdays(birthdays) {
  const container = document.getElementById('birthdaysList');
  if (!container) return;
  if (!birthdays || birthdays.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">🎂</div><div>${__('birthday.no_birthdays')}</div></div>';
    return;
  }
  const sorted = [...birthdays].sort((a, b) => {
    const aMd = (a.birthday || '').replace(/-/g, '');
    const bMd = (b.birthday || '').replace(/-/g, '');
    return aMd.localeCompare(bMd);
  });
  container.innerHTML = sorted.map(b => `
    <div class="birthday-card">
      <img src="${escAttr(b.avatarUrl || '/api/avatar/default')}" class="birthday-avatar" alt="${esc(b.displayName || b.loginId)}" loading="lazy">
      <div class="birthday-info">
        <div class="birthday-name">${esc(b.displayName || b.loginId)}</div>
        <div class="birthday-date">🎂 ${b.birthday || __('unknown')}</div>
      </div>
      ${isToday(b.birthday) ? '<div class="birthday-today-badge">${__('birthday.today')}</div>' : ''}
      ${currentUser && (currentUser.role === 'admin' || currentUser.role === 'super_admin') ? `<button class="btn btn-sm btn-outline mt-4" onclick="createBirthdayEvent(${b.id}, '${escJsStr(b.displayName || b.loginId)}', '${escJsStr(b.birthday || '')}')">${__('birthday.create_party_from_birthday')}</button>` : ''}
    </div>
  `).join('');
}

function isToday(birthday) {
  if (!birthday) return false;
  const today = new Date();
  const todayStr = `${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return birthday.endsWith(todayStr);
}

// ==================== 生日派对活动 ====================
async function loadBirthdayParties() {
  try {
    // 用现有 events API，按 birthday 类型筛选
    const res = await api('/api/events?type=birthday&status=all', { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      renderBirthdayParties(data.events || []);
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('birthday.party_load_failed'), 'error');
  }
}

function renderBirthdayParties(parties) {
  const container = document.getElementById('birthdayPartiesList');
  if (!container) return;
  if (!parties || parties.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">🎉</div><div>${__('birthday.no_parties')}</div></div>';
    return;
  }
  const isAdmin = currentUser && (currentUser.role === 'admin' || currentUser.role === 'super_admin');
  const now = new Date();
  container.innerHTML = parties.map(p => {
    const evtId = p.id;
    const evtTime = p.time;
    const evtTitle = p.title;
    const evtDesc = p.description || __('birthday.party_default');
    const evtTimeDate = evtTime ? new Date(evtTime) : null;
    const isPast = evtTimeDate && evtTimeDate < now;
    const statusBadge = isPast ? '<span class="tag tag-past">⚪ ${__(\'birthday.status_ended\')}</span>' : (p.isActive ? '<span class="tag tag-ongoing">🔴 ${__(\'birthday.status_ongoing\')}</span>' : '<span class="tag tag-upcoming">🟢 ${__(\'birthday.status_upcoming\')}</span>');
    return `<div class="event-card birthday-party">
      <div class="d-flex-between mb-4">
        <div class="event-title">🎂 ${esc(evtTitle)}</div>
        <div class="flex-center-gap6">${statusBadge}${isAdmin ? `<button class="btn btn-sm btn-outline" onclick="event.stopPropagation();editBirthdayParty(${evtId})" title="${__('edit')}">✏️</button><button class="btn btn-sm btn-outline" onclick="event.stopPropagation();deleteBirthdayParty(${evtId})" title="${__('delete')}">🗑️</button>` : ''}</div>
      </div>
      <div class="event-time">📅 ${fmtTime(evtTime)}</div>
      <div class="event-desc">${esc(evtDesc)}</div>
      <div class="mt-6"><span class="text-12 text-muted2" style="cursor:pointer" onclick="event.stopPropagation();showEventDetail(\'${escJsStr(String(evtId))}\')">${__('birthday.view_detail')}</span></div>
    </div>`;
  }).join('');
}

// 管理员：为用户创建生日派对活动
window.createBirthdayEvent = async function(userId, userName, birthday) {
  if (!birthday) { toast(__('birthday.user_no_birthday'), 'error'); return; }
  const now = new Date();
  const parts = birthday.split('-');
  // 今年的生日日期
  const bdayThisYear = new Date(now.getFullYear(), parseInt(parts[1]) - 1, parseInt(parts[2]));
  // 如果今年已过，改明年
  if (bdayThisYear < now) {
    bdayThisYear.setFullYear(now.getFullYear() + 1);
  }
  // 设置时间为生日当天晚上 20:00
  bdayThisYear.setHours(20, 0, 0, 0);
  const pad = n => String(n).padStart(2, '0');
  const startStr = bdayThisYear.getFullYear() + '-' + pad(bdayThisYear.getMonth()+1) + '-' + pad(bdayThisYear.getDate()) + 'T20:00';
  const endStr = bdayThisYear.getFullYear() + '-' + pad(bdayThisYear.getMonth()+1) + '-' + pad(bdayThisYear.getDate()) + 'T23:00';

  showConfirm(__('birthday.confirm_create_party', {name: userName, time: startStr}), async () => {
    try {
      const res = await api('/api/events', {
        method: 'POST',
        body: {
          title: __('birthday.party_title_for', {name: userName}),
          time: startStr,
          endsAt: endStr,
          description: `${__('birthday.party_desc', {name: userName})}`${__('birthday.celebrate')}`,
          eventType: 'birthday',
          visibility: 'members_only',
          maxSign: 30
        }
      });
      if (res.ok) {
        toast(__('birthday.created'), 'success');
        // 刷新生日派对列表
        loadBirthdayParties();
        // 同步更新活动页 eventsCache（为切换 Tab 做准备）
        try {
          const res2 = await api('/api/events?type=birthday&status=upcoming', { method: 'GET' });
          if (res2.ok) {
            const data2 = await res2.json();
            // 合并到 eventsCache（避免重复）
            const newEvents = data2.events || [];
            const existingIds = new Set(eventsCache.map(e => e.id));
            newEvents.forEach(e => { if (!existingIds.has(e.id)) eventsCache.unshift(e); });
            // 如果活动 Tab 正在显示，刷新展示
            if (!document.getElementById('tab-events')?.classList.contains('d-none')) {
              renderEvents(eventsCache);
            }
          }
        } catch {}
      }
    } catch (err) {
      if (isApiHandledError(err)) return;
      toast(__('birthday.create_failed'), 'error');
    }
  });
};

// ==================== 生日派对管理（编辑/删除） ====================

// 编辑生日派对 — 预填表单
async function editBirthdayParty(id) {
  const evt = eventsCache.find(e => parseInt(e.id) === id);
  if (!evt) {
    // 从缓存或 API 加载
    try {
      const res = await api(`/api/events/${id}`, { method: 'GET' });
      if (!res.ok) { toast(__('birthday.load_data_failed'), 'error'); return; }
      const data = await res.json();
      fillBirthdayForm(data.event || data);
    } catch (err) { if (isApiHandledError(err)) return; toast(__('birthday.load_failed'), 'error'); return; }
  } else {
    fillBirthdayForm(evt);
  }
  document.getElementById('bdayModalTitle').textContent = '${__('birthday.edit_party')}';
  document.getElementById('bdaySaveBtn').textContent = __('save');
  document.getElementById('bdaySaveBtn').onclick = () => saveBirthdayEdit(id);
  showModal('birthdayEventModal');
}

function fillBirthdayForm(evt) {
  document.getElementById('bdayTitle').value = evt.title || '';
  document.getElementById('bdayTime').value = evt.time ? evt.time.substring(0, 16) : '';
  document.getElementById('bdayEndsAt').value = evt.endsAt ? evt.endsAt.substring(0, 16) : '';
  document.getElementById('bdayDesc').value = evt.description || '';
  document.getElementById('bdayMax').value = evt.maxSign || 0;
  document.getElementById('bdayVisibility').value = evt.visibility || 'members_only';
  document.querySelectorAll('input[name="bdayVisibility"]').forEach(r => r.checked = r.value === (evt.visibility || 'members_only'));
}

async function saveBirthdayEdit(id) {
  const title = document.getElementById('bdayTitle')?.value;
  const eventTime = document.getElementById('bdayTime')?.value;
  const endTime = document.getElementById('bdayEndsAt')?.value;
  const desc = document.getElementById('bdayDesc')?.value;
  const maxSign = parseInt(document.getElementById('bdayMax')?.value) || 0;
  const visibility = document.getElementById('bdayVisibility')?.value || 'members_only';
  if (!title || !eventTime) { toast(__('birthday.fill_complete'), 'error'); return; }
  try {
    const res = await api(`/api/events/${id}`, { method: 'PUT', body: {
      title, time: eventTime, endsAt: endTime || undefined,
      description: desc || '', eventType: 'birthday',
      maxSign, visibility
    }});
    if (res.ok) {
      toast(__('birthday.party_updated'), 'success');
      closeModal('birthdayEventModal');
      loadBirthdayParties();
      // 只有活动Tab可见时才刷新活动列表
      if (!document.getElementById('tab-events')?.classList.contains('d-none')) {
        loadEvents(currentEvtStatus);
      }
    }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('birthday.update_failed'), 'error'); }
}

async function deleteBirthdayParty(id) {
  showConfirm(__('events.delete_confirm'), async () => {
    try {
      const res = await api(`/api/events/${id}`, { method: 'DELETE' });
      if (res.ok) {
        toast(__('birthday.party_deleted'), 'success');
        loadBirthdayParties();
        if (!document.getElementById('tab-events')?.classList.contains('d-none')) {
          loadEvents(currentEvtStatus);
        }
      }
    } catch (err) { if (isApiHandledError(err)) return; toast(__('birthday.delete_failed'), 'error'); }
  });
}

// 重置新建模式
function showBirthdayEventModalNew() {
  document.getElementById('bdayEditId').value = '';
  document.getElementById('bdayTitle').value = '';
  document.getElementById('bdayTime').value = '';
  document.getElementById('bdayEndsAt').value = '';
  document.getElementById('bdayDesc').value = '';
  document.getElementById('bdayMax').value = '0';
  document.getElementById('bdayModalTitle').textContent = '${__('birthday.create_party')}';
  document.getElementById('bdaySaveBtn').textContent = __('create');
  document.getElementById('bdaySaveBtn').onclick = saveBirthdayEvent;
  showBirthdayEventModal();
}
