// ==================== 聊天私信 + 群聊 + 实时位置 V6.13 ====================
let chatConversations = {};
let chatActiveUserId = null;
let chatActiveGroupId = null;
let chatCurrentView = 'conversations'; // conversations | chat | group | groupChat
// 群聊实时位置
let groupLocationInterval = null;
let groupLocationWatchId = null;
let groupLocationSharing = {}; // groupId → true/false
let groupLocationMarkers = {}; // groupId → { userId → L.marker }

// ==================== Tab 主入口 ====================
async function loadChatConversations(resetView = false) {
  if (!currentUser) return;
  if (resetView) {
    chatActiveUserId = null;
    chatActiveGroupId = null;
    document.getElementById('chatConversationView')?.classList.remove('d-none');
    document.getElementById('chatDetailView')?.classList.add('d-none');
    document.getElementById('chatInputArea')?.classList.add('d-none');
  }
  try {
    const [convRes, groupRes] = await Promise.all([
      api('/api/chat/conversations', { method: 'GET' }),
      api('/api/chat/groups', { method: 'GET' })
    ]);
    if (convRes.ok && groupRes.ok) {
      const convData = await convRes.json();
      const groupData = await groupRes.json();
      chatConversations = {};
      (convData.conversations || []).forEach(c => { chatConversations[c.userId] = c; });
      renderChatMain(convData.conversations || [], groupData.groups || []);
      updateChatBadge();
    }
  } catch (e) { /* 静默 */ }
}

function renderChatMain(convs, groups) {
  const listEl = document.getElementById('chatConversationList');
  if (!listEl) return;
  // 群聊区域
  const groupHtml = groups.length > 0 ? `<div class="chat-section-title">${__('chat.group_chat')}</div>
    ${groups.map(g => {
      const activeClass = chatActiveGroupId === g.id ? 'chat-conv-active' : '';
      return `<div class="chat-conv-item ${activeClass}" onclick="openGroupChat(${g.id})">
        <div class="chat-group-avatar">#</div>
        <div class="chat-conv-info">
          <div class="chat-conv-name">${esc(g.name)}</div>
          <div class="chat-conv-msg">${g.memberCount} ${__('chat.n_members_label')} · ${g.lastMessage ? esc(g.lastMessage.slice(0, 30)) : __('chat.no_messages')}</div>
        </div>
        <div class="chat-conv-time">${g.lastTime ? new Date(g.lastTime).toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit' }) : ''}</div>
      </div>`;
    }).join('')}` : '';

  // 私信区域
  const dmHtml = convs.length > 0 ? `<div class="chat-section-title">${__('chat.dm')}</div>
    ${convs.map(c => {
      const avatarSrc = c.avatarUrl ? escAttr(c.avatarUrl) : '/api/avatar/default';
      const activeClass = chatActiveUserId === c.userId ? 'chat-conv-active' : '';
      const ub = c.unreadCount > 0 ? `<span class="chat-unread-badge">${c.unreadCount > 99 ? '99+' : c.unreadCount}</span>` : '';
      return `<div class="chat-conv-item ${activeClass}" onclick="openChat(${c.userId})">
        <img src="${avatarSrc}" class="chat-conv-avatar" loading="lazy" onerror="this.src='/api/avatar/default'" />
        <div class="chat-conv-info">
          <div class="chat-conv-name">${esc(c.displayName)}${ub}</div>
          <div class="chat-conv-msg">${esc(c.lastMessage ? (c.lastMessage.length > 40 ? c.lastMessage.slice(0,40)+'…' : c.lastMessage) : '')}</div>
        </div>
        <div class="chat-conv-time">${c.lastTime ? new Date(c.lastTime).toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit' }) : ''}</div>
      </div>`;
    }).join('')}` : '';

  listEl.innerHTML = '<div class="chat-header-toolbar"><button class="btn btn-sm" onclick="showCreateGroupModal()">${__('chat.create_group')}</button></div>' +
    (groupHtml || dmHtml ? (groupHtml + dmHtml) : '<div class="chat-empty">${__('chat.no_history')}</div>');
}

// ==================== 私信（保留 V6.12） ====================
async function openChat(userId) {
  if (!currentUser) { toast(__('please_login'), 'error'); return; }
  if (String(userId) === String(currentUser.id)) { toast(__('chat.cant_self'), 'info'); return; }
  chatActiveUserId = userId;
  chatActiveGroupId = null;
  const panel = document.getElementById('chatPanel');
  if (!panel) return;

  // 聊天 Tab 按钮
  const chatTabBtn = document.getElementById('tab-btn-chat');
  if (chatTabBtn) chatTabBtn.click();

  document.getElementById('chatConversationView')?.classList.add('d-none');
  document.getElementById('chatDetailView')?.classList.remove('d-none');
  document.getElementById('chatInputArea')?.classList.remove('d-none');
  document.getElementById('chatBox').innerHTML = '<div class="chat-loading">${__('chat.loading')}</div>';

  try {
    const [histRes, userRes] = await Promise.all([
      api(`/api/chat/history/${userId}`, { method: 'GET' }),
      api(`/api/users/${userId}/card`, { method: 'GET' })
    ]);
    if (histRes.ok && userRes.ok) {
      const hist = await histRes.json();
      const user = await userRes.json();
      const displayName = user.displayName || __('unknown_user');
      const avatarSrc = user.avatarUrl ? escAttr(user.avatarUrl) : '/api/avatar/default';
      document.getElementById('chatDetailHeader').innerHTML = `
        <button class="btn btn-xs" onclick="closeChatDetail()">${__('chat.back')}</button>
        <img src="${avatarSrc}" class="chat-conv-avatar mx-4" loading="lazy" onerror="this.src='/api/avatar/default'" />
        <strong>${esc(displayName)}</strong>
        <span class="ml-auto"><button class="btn btn-xs btn-outline" onclick="viewUserOnMap(${userId})">${__('chat.view_location')}</button></span>`;
      await api(`/api/chat/read/${userId}`, { method: 'POST' }).catch(() => {});
      if (chatConversations[userId]) { chatConversations[userId].unreadCount = 0; loadChatConversations(); }
      renderMessages(hist.messages || [], userId);
    }
  } catch (e) { if (isApiHandledError(e)) return; document.getElementById('chatBox').innerHTML = '<div class="text-muted text-center p-12">${__('chat.load_failed')}</div>'; }
}

async function sendChatMessage() {
  const input = document.getElementById('chatInput');
  if (!input) return;
  const content = input.value.trim();
  if (!content) return;
  input.value = ''; input.focus();

  if (chatActiveGroupId) {
    // 群聊消息
    sendGroupMessage(chatActiveGroupId, content);
    return;
  }
  if (!chatActiveUserId) return;

  if (wsClient && wsClient.readyState === WebSocket.OPEN) {
    wsClient.send(JSON.stringify({ type: 'chat:send', receiverId: chatActiveUserId, content, userId: currentUser.id }));
    return;
  }
  try {
    const res = await api('/api/chat/send', { method: 'POST', body: JSON.stringify({ receiverId: chatActiveUserId, content }) });
    if (res.ok) { const d = await res.json(); appendReceivedMessage(d.message, true); }
  } catch (e) { if (isApiHandledError(e)) return; toast(__('chat.send_failed'), 'error'); }
}

function closeChatDetail() {
  chatActiveUserId = null;
  chatActiveGroupId = null;
  document.getElementById('chatConversationView')?.classList.remove('d-none');
  document.getElementById('chatDetailView')?.classList.add('d-none');
  document.getElementById('chatInputArea')?.classList.add('d-none');
}

function renderMessages(messages, otherId) {
  const chatBox = document.getElementById('chatBox');
  if (!chatBox) return;
  if (!messages || messages.length === 0) { chatBox.innerHTML = '<div class="chat-empty-msg">${__('chat.first_message_emoji')}</div>'; return; }
  chatBox.innerHTML = messages.map(m => {
    const isMe = m.senderId === currentUser.id;
    return `<div class="chat-msg ${isMe ? 'chat-msg-me' : 'chat-msg-other'}">
      <div class="chat-msg-bubble">${esc(m.content)}</div>
      <div class="chat-msg-time">${new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit' })}</div>
    </div>`;
  }).join('');
  chatBox.scrollTop = chatBox.scrollHeight;
}

// ==================== 群聊 V6.13 ====================
async function showCreateGroupModal() {
  // 弹出${__('chat.select_members')}对话框
  try {
    const res = await api('/api/users', { method: 'GET' });
    if (!res.ok) return;
    const data = await res.json();
    const users = data.users || [];
    const html = `
      <div class="modal" id="createGroupModal">
        <div class="modal-content" style="max-width:420px">
          <h3>${__('chat.create_group')}</h3>
          <div class="form-group"><label>${__('chat.group_name')}</label><input type="text" id="newGroupName" class="form-input" placeholder="${__('chat.group_name_placeholder')}"></div>
          <div class="form-group"><label>${__('chat.select_members')}</label>
            <div style="max-height:200px;overflow-y:auto">${users.filter(u => u.id !== currentUser.id).map(u => `
              <label class="flex-row gap-4 items-center p-4" style="cursor:pointer">
                <input type="checkbox" class="group-member-checkbox" value="${u.id}">
                <span>${esc(u.displayName || u.loginId)}</span>
              </label>`).join('')}
            </div>
          </div>
          <div class="modal-actions">
            <button class="btn" onclick="closeModal('createGroupModal')">${__('chat.cancel_btn')}</button>
            <button class="btn btn-accent" onclick="doCreateGroup()">${__('chat.create_btn')}</button>
          </div>
        </div>
      </div>`;
    // 添加到 body
    const existing = document.getElementById('createGroupModal');
    if (existing) existing.remove();
    const div = document.createElement('div');
    div.innerHTML = html;
    document.body.appendChild(div.firstElementChild);
    showModal('createGroupModal');
  } catch (e) { toast(__('chat.load_users_failed'), 'error'); }
}

async function doCreateGroup() {
  const name = document.getElementById('newGroupName')?.value?.trim();
  if (!name) { toast(__('chat.group_name_required'), 'error'); return; }
  const checks = document.querySelectorAll('.group-member-checkbox:checked');
  const memberIds = Array.from(checks).map(c => parseInt(c.value)).filter(v => v);
  try {
    const res = await api('/api/chat/groups', { method: 'POST', body: JSON.stringify({ name, memberIds }) });
    if (res.ok) {
      toast(__('chat.group_created'), 'success');
      closeModal('createGroupModal');
      loadChatConversations();
    }
  } catch (e) { if (isApiHandledError(e)) return; toast(__('chat.create_failed'), 'error'); }
}

async function openGroupChat(groupId) {
  if (!currentUser) { toast(__('please_login'), 'error'); return; }
  chatActiveGroupId = groupId;
  chatActiveUserId = null;

  document.getElementById('chatConversationView')?.classList.add('d-none');
  document.getElementById('chatDetailView')?.classList.remove('d-none');
  document.getElementById('chatInputArea')?.classList.remove('d-none');
  document.getElementById('chatBox').innerHTML = '<div class="chat-loading">${__('chat.loading_group')}</div>';

  try {
    const [grpRes, msgRes] = await Promise.all([
      api(`/api/chat/groups/${groupId}`, { method: 'GET' }),
      api(`/api/chat/groups/${groupId}/messages`, { method: 'GET' })
    ]);
    if (grpRes.ok && msgRes.ok) {
      const grp = await grpRes.json();
      const msgs = await msgRes.json();
      const members = grp.members || [];
      document.getElementById('chatDetailHeader').innerHTML = `
        <button class="btn btn-xs" onclick="closeChatDetail()">${__('chat.back')}</button>
        <div class="chat-group-avatar-sm">#</div>
        <strong>${esc(grp.group.name)}</strong>
        <span class="text-muted2 text-12 ml-4">${__('chat.n_members_label', {n: members.length})}</span>
        <span class="ml-auto">
          <button id="groupLocBtn_${groupId}" class="btn btn-xs ${groupLocationSharing[groupId] ? 'btn-danger' : ''}" onclick="toggleGroupLocation(${groupId})">
            ${groupLocationSharing[groupId] ? __('chat.stop_sharing') : '${__('chat.share_location')}'}
          </button>
        </span>`;
      renderGroupMessages(msgs.messages || [], members);
    }
  } catch (e) { if (isApiHandledError(e)) return; document.getElementById('chatBox').innerHTML = '<div class="text-muted text-center p-12">${__('chat.load_failed')}</div>'; }
}

function renderGroupMessages(messages, members) {
  const chatBox = document.getElementById('chatBox');
  if (!chatBox) return;
  if (!messages || messages.length === 0) { chatBox.innerHTML = '<div class="chat-empty-msg">${__('chat.group_start')}</div>'; return; }
  const memberMap = {};
  members.forEach(m => { memberMap[m.id] = m; });
  chatBox.innerHTML = messages.map(m => {
    const isMe = m.senderId === currentUser.id;
    const sender = memberMap[m.senderId] || {};
    const senderName = sender.displayName || m.senderName || '';
    const senderAvatar = sender.avatarUrl ? escAttr(sender.avatarUrl) : '';

    if (m.msgType === 'location') {
      // 位置消息（来自群聊实时位置共享保存的消息）
      return `<div class="chat-msg chat-msg-other">
        <div class="chat-msg-sender">${senderAvatar ? `<img src="${senderAvatar}" class="chat-mini-avatar" loading="lazy">` : ''} ${esc(senderName)}</div>
        <div class="chat-msg-bubble chat-msg-location" onclick="openMapLocation(${m.lat},${m.lng})">${__('chat.location_sharing')}</div>
        <div class="chat-msg-time">${new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit' })}</div>
      </div>`;
    }
    return `<div class="chat-msg ${isMe ? 'chat-msg-me' : 'chat-msg-other'}">
      ${!isMe ? `<div class="chat-msg-sender">${senderAvatar ? `<img src="${senderAvatar}" class="chat-mini-avatar" loading="lazy">` : ''} ${esc(senderName)}</div>` : ''}
      <div class="chat-msg-bubble">${esc(m.content)}</div>
      <div class="chat-msg-time">${new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit' })}</div>
    </div>`;
  }).join('');
  chatBox.scrollTop = chatBox.scrollHeight;
}

// 发送群消息（HTTP + WS fallback）
async function sendGroupMessage(groupId, content) {
  // 优先 WS
  if (wsClient && wsClient.readyState === WebSocket.OPEN) {
    wsClient.send(JSON.stringify({
      type: 'group:send', groupId, content,
      userId: currentUser.id, displayName: currentUser.displayName
    }));
    return;
  }
  // HTTP fallback
  try {
    const res = await api(`/api/chat/groups/${groupId}/messages`, {
      method: 'POST', body: JSON.stringify({ content })
    });
    if (!res.ok) toast(__('chat.send_failed'), 'error');
  } catch (e) { if (isApiHandledError(e)) return; toast(__('chat.send_failed'), 'error'); }
}

// ==================== 群聊实时位置共享 V6.13 ====================
function toggleGroupLocation(groupId) {
  if (groupLocationSharing[groupId]) {
    stopGroupLocation(groupId);
  } else {
    startGroupLocation(groupId);
  }
}

function startGroupLocation(groupId) {
  if (!currentUser) { toast(__('please_login'), 'error'); return; }
  if (!navigator.geolocation) { toast(__('chat.gps_not_supported'), 'error'); return; }

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;

      // 先发一条消息到群："我开启了位置共享"
      sendGroupMessage(groupId, '${__('chat.location_started_msg')}');

      // 发送实时位置（5秒一次）
      groupLocationSharing[groupId] = true;
      groupLocationWatchId = navigator.geolocation.watchPosition(
        (p) => {
          sendGroupLocationViaWS(groupId, p.coords.latitude, p.coords.longitude, p.coords.accuracy);
        },
        (err) => {
          if (err.code === 1) { toast(__('chat.gps_permission_denied'), 'error'); stopGroupLocation(groupId); }
        },
        { enableHighAccuracy: true, maximumAge: 30000, timeout: 10000 }
      );

      // 定时补充发送
      groupLocationInterval = setInterval(() => {
        if (groupLocationSharing[groupId] && navigator.geolocation) {
          navigator.geolocation.getCurrentPosition(
            (p) => sendGroupLocationViaWS(groupId, p.coords.latitude, p.coords.longitude, p.coords.accuracy),
            () => {},
            { enableHighAccuracy: false, timeout: 5000, maximumAge: 60000 }
          );
        }
      }, 5000);

      updateGroupLocBtn(groupId, true);
      toast(__('chat.group_location_started'), 'success');
    },
    (err) => {
      if (err.code === 1) toast(__('chat.grant_location_permission'), 'error');
      else toast(__('chat.gps_failed'), 'error');
    },
    { enableHighAccuracy: true, timeout: 15000 }
  );
}

function stopGroupLocation(groupId) {
  if (groupLocationWatchId !== null) {
    navigator.geolocation.clearWatch(groupLocationWatchId);
    groupLocationWatchId = null;
  }
  if (groupLocationInterval) {
    clearInterval(groupLocationInterval);
    groupLocationInterval = null;
  }

  // 发消息："已关闭位置共享"
  sendGroupMessage(groupId, '${__('chat.location_stopped_msg')}');

  // 广播 stop
  if (wsClient && wsClient.readyState === WebSocket.OPEN) {
    wsClient.send(JSON.stringify({
      type: 'group:location:stop', groupId, userId: currentUser.id
    }));
  }

  groupLocationSharing[groupId] = false;
  // 清理群内标记
  if (groupLocationMarkers[groupId]) {
    delete groupLocationMarkers[groupId];
  }
  updateGroupLocBtn(groupId, false);
  toast(__('chat.location_stopped_icon'), 'info');
}

function sendGroupLocationViaWS(groupId, lat, lng, accuracy) {
  if (!wsClient || wsClient.readyState !== WebSocket.OPEN) return;
  wsClient.send(JSON.stringify({
    type: 'group:location:update', groupId,
    userId: currentUser.id,
    displayName: currentUser.displayName || '',
    avatarUrl: currentUser.avatarUrl || '',
    lat, lng, accuracy: accuracy || null
  }));
}

function updateGroupLocBtn(groupId, active) {
  const btn = document.getElementById(`groupLocBtn_${groupId}`);
  if (btn) {
    btn.textContent = active ? __('chat.stop_sharing') : '${__('chat.share_location')}';
    btn.className = active ? 'btn btn-xs btn-danger' : 'btn btn-xs';
  }
}

// 收到群聊位置消息时处理（显示到地图面板）
function handleGroupLocationMessage(msg) {
  // 群聊位置数据在聊天界面下方显示小地图
  // 简化：如果不太复杂，在聊天框里追加位置提示
  if (msg.type === 'group:location:update') {
    // 更新小组内的小地图标记
    // 实际实现用 Leaflet 小地图放到群聊界面
    // 这里先简化：仅当群聊详情打开且匹配 groupId 时更新
  }
  if (msg.type === 'group:location:stop') {
    const gid = msg.groupId;
    if (groupLocationMarkers[gid]) {
      delete groupLocationMarkers[gid][msg.userId];
    }
  }
}

// ==================== WS 消息处理 ====================
function handleChatMessage(msg) {
  if (msg.type === 'chat:new') {
    const m = msg.message;
    if (m.senderId === currentUser.id) return;
    const talkTo = m.receiverId === currentUser.id ? m.senderId : m.receiverId;
    if (chatActiveUserId === talkTo) {
      appendReceivedMessage(m);
      api(`/api/chat/read/${m.senderId}`, { method: 'POST' }).catch(() => {});
    }
    if (chatActiveUserId !== talkTo) {
      // 不在当前对话中才重载列表（更新未读数）
      loadChatConversations();
    }
  }
  if (msg.type === 'chat:sent') {
    appendReceivedMessage(msg.message, true);
  }
  // 群聊消息 — 只在用户不在该群详情页时重载列表
  if (msg.type === 'group:new') {
    if (chatActiveGroupId === msg.groupId) {
      appendGroupMessage(msg.message);
    } else {
      loadChatConversations();
    }
  }
  // 群聊实时位置（仅群内可见，不持久化）
  if (msg.type === 'group:location:update') {
    if (chatActiveGroupId === msg.groupId) {
      showGroupLocationOnChat(msg);
    }
  }
  if (msg.type === 'group:location:stop') {
    if (chatActiveGroupId === msg.groupId) {
      hideGroupLocationOnChat(msg.userId);
    }
  }
}

function appendReceivedMessage(msg, isSent = false) {
  const chatBox = document.getElementById('chatBox');
  if (!chatBox) return;
  const otherId = msg.senderId === currentUser.id ? msg.receiverId : msg.senderId;
  if (chatActiveUserId !== otherId && !isSent) return;
  const emptyMsg = chatBox.querySelector('.chat-empty-msg');
  if (emptyMsg) emptyMsg.remove();
  const isMe = msg.senderId === currentUser.id;
  chatBox.insertAdjacentHTML('beforeend', `
    <div class="chat-msg ${isMe ? 'chat-msg-me' : 'chat-msg-other'}">
      <div class="chat-msg-bubble">${esc(msg.content)}</div>
      <div class="chat-msg-time">${new Date(msg.createdAt).toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit' })}</div>
    </div>`);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function appendGroupMessage(msg) {
  const chatBox = document.getElementById('chatBox');
  if (!chatBox) return;
  const emptyMsg = chatBox.querySelector('.chat-empty-msg');
  if (emptyMsg) emptyMsg.remove();
  const isMe = msg.senderId === currentUser.id;
  chatBox.insertAdjacentHTML('beforeend', `
    <div class="chat-msg ${isMe ? 'chat-msg-me' : 'chat-msg-other'}">
      ${!isMe ? `<div class="chat-msg-sender">${esc(msg.senderName || '')}</div>` : ''}
      <div class="chat-msg-bubble">${esc(msg.content)}</div>
      <div class="chat-msg-time">${msg.createdAt ? new Date(msg.createdAt).toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit' }) : ''}</div>
    </div>`);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function updateChatBadge() {
  const total = Object.values(chatConversations).reduce((sum, c) => sum + (c.unreadCount || 0), 0);
  const badge = document.getElementById('chatUnreadBadge');
  if (badge) {
    if (total > 0) { badge.textContent = total > 99 ? '99+' : total; badge.style.display = 'inline'; }
    else { badge.style.display = 'none'; }
  }
}

// ==================== 查看用户位置 ====================
// 从私聊切到地图并定位到该用户
function viewUserOnMap(userId) {
  if (typeof switchTab === 'function') switchTab('map');
  const tryLocate = async () => {
    if (typeof mapInstance === 'undefined' || !mapInstance) {
      setTimeout(tryLocate, 500);
      return;
    }
    const marker = leafletMarkers ? leafletMarkers[userId] : null;
    if (marker) { marker.openPopup(); mapInstance.setView(marker.getLatLng(), 14); return; }
    try {
      const res = await api('/api/users/locations', { method: 'GET' });
      if (res.ok) {
        const data = await res.json();
        const u = (data.users || []).find(x => String(x.id) === String(userId));
        if (u && typeof upsertLocationMarker === 'function') {
          upsertLocationMarker(u);
          setTimeout(() => {
            const m = leafletMarkers ? leafletMarkers[userId] : null;
            if (m) { m.openPopup(); mapInstance.setView(m.getLatLng(), 14); }
          }, 200);
        } else { toast('${__('chat.user_no_location')}', 'info'); }
      }
    } catch { toast('${__('chat.gps_info_failed')}', 'error'); }
  };
  setTimeout(tryLocate, 300);
}

// ==================== 群聊位置标记管理（小地图用） ====================
// 简化版：在聊天框内显示位置提示
function showGroupLocationOnChat(msg) {
  // 在聊天框底部显示一条"XXX 的实时位置"提示
  const locBar = document.getElementById('groupLocationBar');
  if (!locBar) return;
  // 更新或追加
  let userLoc = locBar.querySelector(`[data-uid="${msg.userId}"]`);
  if (!userLoc) {
    const el = document.createElement('div');
    el.dataset.uid = msg.userId;
    el.className = 'group-loc-item';
    locBar.appendChild(el);
    userLoc = el;
  }
  const avatarSrc = msg.avatarUrl ? escAttr(msg.avatarUrl) : '/api/avatar/default';
  userLoc.innerHTML = `<img src="${avatarSrc}" class="chat-mini-avatar" loading="lazy"> ${esc(msg.displayName || '')} 🟢`;
}

function hideGroupLocationOnChat(userId) {
  const locBar = document.getElementById('groupLocationBar');
  if (locBar) {
    const el = locBar.querySelector(`[data-uid="${userId}"]`);
    if (el) el.remove();
  }
}

// ==================== 键盘快捷键 ====================
document.addEventListener('DOMContentLoaded', () => {
  const chatInput = document.getElementById('chatInput');
  if (chatInput) {
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
    });
  }
});
