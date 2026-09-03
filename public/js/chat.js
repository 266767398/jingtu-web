// ==================== 聊天私信 + 群聊 + 实时位置 V6.13 ====================
let chatConversations = {};
let chatActiveUserId = null;
let chatActiveGroupId = null;
let chatUnreadData = null;
let chatSearchTimeout = null;
let chatCurrentView = 'conversations'; // conversations | chat | group | groupChat
// 群聊实时位置
let groupLocationSharing = {}; // groupId → true/false（本端是否正在共享）
let groupLocationMarkers = {}; // groupId → { userId → L.marker }（兼容保留）
// §群位置-单例定位：全站只起一个 watchPosition，按群集合广播，
// 避免「多群并发 watch 受限」+「watch 与 setInterval 双重定位冗余」
let glWatchId = null;
const glGroups = new Set();     // 正在共享的群集合
let glLastSent = 0;             // 全局节流时间戳（≥4s 才发一次）
const groupLocLastSeen = {};    // groupId → { userId → ts }，幽灵标记清扫用
let glSweepTimer = null;        // 幽灵标记清扫定时器
const LOC_STALE_MS = 30000;     // 超过 30s 未更新的标记视为幽灵

// 分页状态
let chatPage = 1;
let chatTotal = 0;
let chatPageSize = 50;
let groupChatPage = 1;
let groupChatTotal = 0;

function formatChatTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const lang = _currentLang || 'zh';
  return date.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
}

let chatLoading = false;

// ==================== Tab 主入口 ====================
async function loadChatConversations(resetView = false) {
  if (!currentUser || chatLoading) return;
  chatLoading = true;
  if (resetView) {
    chatActiveUserId = null;
    chatActiveGroupId = null;
    document.getElementById('chatConversationView')?.classList.remove('d-none');
    document.getElementById('chatDetailView')?.classList.add('d-none');
    document.getElementById('chatInputArea')?.classList.add('d-none');
  }
  try {
    const [convRes, groupRes, unreadRes] = await Promise.all([
      api('/api/chat/conversations', { method: 'GET' }),
      api('/api/chat/groups', { method: 'GET' }),
      api('/api/chat/unread-count', { method: 'GET' })
    ]);
    if (convRes.ok && groupRes.ok) {
      const convData = await convRes.json();
      const groupData = await groupRes.json();
      chatUnreadData = unreadRes.ok ? await unreadRes.json() : null;
      chatConversations = {};
      (convData.conversations || []).forEach(c => { chatConversations[c.userId] = c; });
      if (chatUnreadData) {
        const groupUnreadMap = {};
        (chatUnreadData.groups || []).forEach(g => { groupUnreadMap[g.groupId] = g.count; });
        groupData.groups = (groupData.groups || []).map(g => ({ ...g, unreadCount: groupUnreadMap[g.id] || 0 }));
      }
      renderChatMain(convData.conversations || [], groupData.groups || []);
      updateChatBadge();
    }
  } catch (e) { toast(__('chat.load_failed') || __('auto_chat_1'), 'error'); }
  finally { chatLoading = false; }
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
        <div class="chat-conv-time">${formatChatTime(g.lastTime)}</div>
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
        <div class="chat-conv-time">${formatChatTime(c.lastTime)}</div>
      </div>`;
    }).join('')}` : '';

  const contentHtml = (groupHtml || dmHtml) ? (groupHtml + dmHtml) : '';
  listEl.innerHTML = `
    <div class="chat-header-toolbar">
      <div class="chat-search-box">
        <input type="text" id="chatSearchInput" placeholder="${__('chat.search_placeholder')}" oninput="debouncedChatSearch(this.value)" onkeydown="if(event.key==='Enter')chatSearch(this.value)">
        <button class="btn btn-xs" onclick="chatSearch(document.getElementById('chatSearchInput').value)">🔍</button>
        <button class="btn btn-xs" onclick="clearChatSearch()">✕</button>
      </div>
      <button class="btn btn-sm" onclick="showCreateGroupModal()">${__('chat.create_group')}</button>
      <button class="btn btn-sm btn-outline" onclick="showJoinByCodeModal()">${__('chat.join_by_code')}</button>
    </div>
    <div id="chatSearchResults"></div>
    <div id="chatConversationListContent">` + contentHtml + `</div>`;
  if (!groupHtml && !dmHtml) {
    renderEmpty(document.getElementById('chatConversationListContent'), { icon: '💬', text: __('chat.no_history') });
  }
}

// ==================== 私信（保留 V6.12） ====================
async function openChat(userId) {
  if (!currentUser) { toast(__('please_login'), 'error'); return; }
  if (String(userId) === String(currentUser.id)) { toast(__('chat.cant_self'), 'info'); return; }
  stopTypingIndicator();
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
  document.getElementById('chatBox').innerHTML = '<div class="chat-loading">' + __('chat.loading') + '</div>';

  try {
    chatPage = 1;
    const [histRes, userRes] = await Promise.all([
      api(`/api/chat/history/${userId}?page=1&pageSize=${chatPageSize}`, { method: 'GET' }),
      api(`/api/users/${userId}/card`, { method: 'GET' })
    ]);
    if (histRes.ok && userRes.ok) {
      const hist = await histRes.json();
      const user = await userRes.json();
      const displayName = user.displayName || __('unknown_user');
      const avatarSrc = user.avatarUrl ? escAttr(user.avatarUrl) : '/api/avatar/default';
      chatTotal = hist.total || 0;
      document.getElementById('chatDetailHeader').innerHTML = `
        <button class="btn btn-xs" onclick="closeChatDetail()">${__('chat.back')}</button>
        <img src="${avatarSrc}" class="chat-conv-avatar mx-4" loading="lazy" onerror="this.src='/api/avatar/default'" />
        <strong>${esc(displayName)}</strong>
        <span class="ml-auto"><button class="btn btn-xs btn-outline" onclick="viewUserOnMap(${userId})">${__('chat.view_location')}</button></span>`;
      const unreadMsgIds = (hist.messages || []).filter(m => !m.isRead && m.receiverId === currentUser.id).map(m => m.id);
      if (unreadMsgIds.length > 0) {
        await api('/api/chat/messages/read-batch', { method: 'PATCH', body: JSON.stringify({ messageIds: unreadMsgIds }) }).catch(() => {});
      }
      if (chatConversations[userId]) { chatConversations[userId].unreadCount = 0; loadChatConversations(); }
      renderMessages(hist.messages || [], userId);
    }
  } catch (e) { if (isApiHandledError(e)) return; renderEmpty(document.getElementById('chatBox'), { icon: '⚠️', text: __('chat.load_failed') }); }
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
  stopTypingIndicator();
  chatActiveUserId = null;
  chatActiveGroupId = null;
  document.getElementById('chatConversationView')?.classList.remove('d-none');
  document.getElementById('chatDetailView')?.classList.add('d-none');
  document.getElementById('chatInputArea')?.classList.add('d-none');
}

function stopTypingIndicator() {
  if (chatTypingTimeout) { clearTimeout(chatTypingTimeout); chatTypingTimeout = null; }
  const typingEl = document.getElementById('chatTypingIndicator');
  if (typingEl) typingEl.remove();
  if (wsClient && wsClient.readyState === WebSocket.OPEN && chatActiveUserId) {
    wsClient.send(JSON.stringify({ type: 'chat:typing', receiverId: chatActiveUserId, userId: currentUser.id, stop: true }));
  }
}

// 聊天媒体消息渲染（图片/视频/语音）。后端媒体消息存于 mediaUrl/mediaType，
// 前端此前仅渲染文本导致媒体消息显示空白气泡（聊天问题 9.4 / P2-27）。
function chatMediaBlock(m) {
  if (!m || !m.mediaUrl || !m.mediaType) return '';
  const url = escAttr(m.mediaUrl);
  if (m.mediaType === 'image') {
    return `<img class="chat-media chat-media-img" src="${url}" alt="" loading="lazy" style="max-width:100%;border-radius:8px;display:block">`;
  }
  if (m.mediaType === 'video') {
    return `<video class="chat-media chat-media-video" src="${url}" controls preload="metadata" style="max-width:100%;border-radius:8px;display:block;background:#000"></video>`;
  }
  if (m.mediaType === 'audio') {
    return `<audio class="chat-media chat-media-audio" src="${url}" controls style="max-width:100%;display:block"></audio>`;
  }
  return '';
}

function renderMessages(messages, otherId) {
  const chatBox = document.getElementById('chatBox');
  if (!chatBox) return;
  if (!messages || messages.length === 0) { renderEmpty(chatBox, { icon: '💬', text: __('chat.first_message_emoji'), cls: 'chat-empty-msg' }); return; }
  chatBox.innerHTML = messages.map(m => {
    const isMe = m.senderId === currentUser.id;
    return `<div class="chat-msg ${isMe ? 'chat-msg-me' : 'chat-msg-other'}">
      <div class="chat-msg-bubble">${chatMediaBlock(m)}${m.content ? esc(m.content) : ''}</div>
      <div class="chat-msg-time">${new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit' })}</div>
    </div>`;
  }).join('');
  chatBox.scrollTop = chatBox.scrollHeight;
}

// ==================== 群聊 V6.13 ====================
async function showCreateGroupModal() {
  // 弹出选择成员对话框
  try {
    const res = await api('/api/users/list', { method: 'GET' });
    if (!res.ok) return;
    const data = await res.json();
    const users = data.users || [];
    const html = `
      <div class="modal" id="createGroupModal">
        <div class="modal-content" style="max-width:420px">
          <h3 class="section-title">${__('chat.create_group')}</h3>
          <div class="form-group"><label>${__('chat.group_name')}</label><input type="text" id="newGroupName" class="form-input" placeholder="${__('chat.group_name_placeholder')}"></div>
          <div class="form-group"><label class="flex-row items-center gap-4" style="cursor:pointer"><input type="checkbox" id="newGroupPrivate"> <span>${__('chat.private_group')}</span></label><span class="text-xs text-muted">${__('chat.private_group_hint')}</span></div>
          <div class="form-group"><label>${__('chat.select_members')}</label>
            <div style="max-height:200px;overflow-y:auto">${users.filter(u => u.id !== currentUser.id).map(u => `
              <label class="flex-row gap-4 items-center p-4" style="cursor:pointer">
                <input type="checkbox" class="group-member-checkbox" value="${u.id}">
                <span>${esc(u.displayName || u.loginId)}</span>
              </label>`).join('')}
            </div>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn" onclick="closeModal('createGroupModal')">${__('chat.cancel_btn')}</button>
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
  const isPrivate = document.getElementById('newGroupPrivate')?.checked;
  try {
    const res = await api('/api/chat/groups', { method: 'POST', body: JSON.stringify({ name, memberIds, isPublic: !isPrivate }) });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      toast(isPrivate ? __('chat.group_created_private') : __('chat.group_created'), 'success');
      closeModal('createGroupModal');
      loadChatConversations();
      if (data.inviteCode) showInviteCodeModal(data.inviteCode, data.name);
    }
  } catch (e) { if (isApiHandledError(e)) return; toast(__('chat.create_failed'), 'error'); }
}

async function openGroupChat(groupId) {
  if (!currentUser) { toast(__('please_login'), 'error'); return; }
  // 防御：群组 ID 必须有效，避免请求 /api/chat/groups/undefined/messages 触发 500
  const gid = parseInt(groupId);
  if (!Number.isInteger(gid) || gid <= 0) {
    console.warn(__('auto_chat_2'), groupId);
    toast(__('auto_chat_3'), 'error');
    return;
  }
  chatActiveGroupId = gid;
  chatActiveUserId = null;

  document.getElementById('chatConversationView')?.classList.add('d-none');
  document.getElementById('chatDetailView')?.classList.remove('d-none');
  document.getElementById('chatInputArea')?.classList.remove('d-none');
  document.getElementById('chatBox').innerHTML = '<div class="chat-loading">' + __('chat.loading_group') + '</div>';

  try {
    groupChatPage = 1;
    const [grpRes, msgRes] = await Promise.all([
      api(`/api/chat/groups/${groupId}`, { method: 'GET' }),
      api(`/api/chat/groups/${groupId}/messages?page=1&pageSize=${chatPageSize}`, { method: 'GET' })
    ]);
    if (grpRes.ok && msgRes.ok) {
      const grp = await grpRes.json();
      const msgs = await msgRes.json();
      groupChatTotal = msgs.total || 0;
      const members = grp.members || [];
      document.getElementById('chatDetailHeader').innerHTML = `
        <button class="btn btn-xs" onclick="closeChatDetail()">${__('chat.back')}</button>
        <div class="chat-group-avatar-sm">#</div>
        <strong>${esc(grp.group.name)}</strong>
        <span class="text-muted2 text-12 ml-4">${__('chat.n_members_label', {n: members.length})}</span>
        <span class="ml-auto">
          <button id="groupLocBtn_${groupId}" class="btn btn-xs ${groupLocationSharing[groupId] ? 'btn-danger' : ''}" onclick="toggleGroupLocation(${groupId})">
            ${groupLocationSharing[groupId] ? __('chat.stop_sharing') : __('chat.share_location')}
          </button>
          <button class="btn btn-xs btn-outline ml-2" onclick="showGroupSettings(${groupId})">${__('chat.group_settings')}</button>
        </span>`;
      const unreadMsgIds = (msgs.messages || []).filter(m => !m.isRead).map(m => m.id);
      if (unreadMsgIds.length > 0) {
        await api(`/api/chat/groups/${groupId}/messages/read-batch`, { method: 'PATCH', body: JSON.stringify({ messageIds: unreadMsgIds }) }).catch(() => {});
      }
      loadChatConversations();
      renderGroupMessages(msgs.messages || [], members);
    }
  } catch (e) { if (isApiHandledError(e)) return; renderEmpty(document.getElementById('chatBox'), { icon: '⚠️', text: __('chat.load_failed') }); }
}

function renderGroupMessages(messages, members) {
  const chatBox = document.getElementById('chatBox');
  if (!chatBox) return;
  if (!messages || messages.length === 0) { renderEmpty(chatBox, { icon: '💬', text: __('chat.group_start'), cls: 'chat-empty-msg' }); return; }
  const memberMap = {};
  members.forEach(m => { memberMap[m.id] = m; });
  chatBox.innerHTML = messages.map(m => {
    const isMe = m.senderId === currentUser.id;
    const sender = memberMap[m.senderId] || {};
    const senderName = sender.displayName || m.senderName || '';
    const senderAvatar = sender.avatarUrl ? escAttr(sender.avatarUrl) : '/api/avatar/default';

    if (m.msgType === 'location') {
      // 位置消息（来自群聊实时位置共享保存的消息）
      return `<div class="chat-msg chat-msg-other">
        <div class="chat-msg-sender">${senderAvatar ? `<img src="${senderAvatar}" class="chat-mini-avatar" loading="lazy">` : ''} ${esc(senderName)}</div>
        <div class="chat-msg-bubble chat-msg-location" onclick="openMapLocation(${m.lat},${m.lng})">${__('chat.location_sharing')}</div>
        <div class="chat-msg-time">${new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit' })}</div>
      </div>`;
    }
    if (m.mediaUrl && m.mediaType) {
      return `<div class="chat-msg ${isMe ? 'chat-msg-me' : 'chat-msg-other'}">
        ${!isMe ? `<div class="chat-msg-sender">${senderAvatar ? `<img src="${senderAvatar}" class="chat-mini-avatar" loading="lazy">` : ''} ${esc(senderName)}</div>` : ''}
        <div class="chat-msg-bubble">${chatMediaBlock(m)}${m.content ? esc(m.content) : ''}</div>
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
    if (res.ok) {
      const d = await res.json().catch(() => null);
      if (d && d.message) appendGroupMessage(d.message);
    } else {
      toast(__('chat.send_failed'), 'error');
    }
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
  if (!ensureGeolocation()) return;

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      // 加入共享群集合并启动单例 watch（多群共用同一个定位句柄）
      glGroups.add(groupId);
      groupLocationSharing[groupId] = true;
      ensureGlobalWatch();
      startGroupLocSweep();

      // 用独立信令通知群成员「开始共享」（不进消息表、不计未读，避免污染群聊）
      sendGroupLocationToggle(groupId, true);

      updateGroupLocBtn(groupId, true);
      toast(__('chat.group_location_started'), 'success');
    },
    (err) => {
      toastGeoError(err);
    },
    { enableHighAccuracy: true, timeout: 15000 }
  );
}

function stopGroupLocation(groupId) {
  glGroups.delete(groupId);
  groupLocationSharing[groupId] = false;

  // 独立信令通知「停止共享」+ 广播 stop，让他人移除标记（均不持久化、不计未读）
  sendGroupLocationToggle(groupId, false);
  if (wsClient && wsClient.readyState === WebSocket.OPEN) {
    wsClient.send(JSON.stringify({
      type: 'group:location:stop', groupId, userId: currentUser.id
    }));
  }

  // 清理本端位置栏中自己的项
  if (groupLocationMarkers[groupId]) delete groupLocationMarkers[groupId][currentUser.id];
  const myBar = document.getElementById('groupLocationBar');
  const myEl = myBar && myBar.querySelector(`[data-uid="${currentUser.id}"]`);
  if (myEl) myEl.remove();
  if (groupLocLastSeen[groupId]) delete groupLocLastSeen[groupId][currentUser.id];

  // 没有任何群在共享时释放唯一 watch，避免空转耗电
  stopGlobalWatchIfIdle();
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
    btn.textContent = active ? __('chat.stop_sharing') : __('chat.share_location');
    btn.className = active ? 'btn btn-xs btn-danger' : 'btn btn-xs';
  }
}

// 全局唯一 geolocation watch：位置变化时向所有正在共享的群广播（带节流）
function ensureGlobalWatch() {
  if (glWatchId != null) return;
  if (!ensureGeolocation()) return;
  glWatchId = navigator.geolocation.watchPosition(
    (p) => {
      const now = Date.now();
      if (now - glLastSent < 4000) return; // 节流，避免高频刷屏
      glLastSent = now;
      const { latitude, longitude, accuracy } = p.coords;
      glGroups.forEach((gid) => sendGroupLocationViaWS(gid, latitude, longitude, accuracy));
    },
    (err) => {
      toastGeoError(err);
      // 定位失败：停止全部群的共享，避免按钮卡在__('auto_chat_4')却不再发坐标
      Array.from(glGroups).forEach((gid) => stopGroupLocation(gid));
    },
    { enableHighAccuracy: true, maximumAge: 30000, timeout: 10000 }
  );
}

function stopGlobalWatchIfIdle() {
  if (glGroups.size === 0 && glWatchId != null) {
    navigator.geolocation.clearWatch(glWatchId);
    glWatchId = null;
  }
}

// 幽灵标记清扫：超过 LOC_STALE_MS 未更新的成员从位置栏移除
// （覆盖对端刷新/关页未点停止导致标记永不消失的场景）
function startGroupLocSweep() {
  if (glSweepTimer) return;
  glSweepTimer = setInterval(() => {
    const gid = chatActiveGroupId;
    if (!gid) return;
    const seen = groupLocLastSeen[gid];
    if (!seen) return;
    const now = Date.now();
    const bar = document.getElementById('groupLocationBar');
    for (const uid in seen) {
      if (now - seen[uid] > LOC_STALE_MS) {
        delete seen[uid];
        if (groupLocationMarkers[gid]) delete groupLocationMarkers[gid][uid];
        const el = bar && bar.querySelector(`[data-uid="${uid}"]`);
        if (el) el.remove();
      }
    }
  }, 10000);
}

// 位置开关信令（开始/停止共享），走独立信令不进消息表、不计未读
function sendGroupLocationToggle(groupId, sharing) {
  if (!wsClient || wsClient.readyState !== WebSocket.OPEN) return;
  wsClient.send(JSON.stringify({
    type: 'group:location:toggle', groupId,
    userId: currentUser.id,
    displayName: currentUser.displayName || '',
    sharing: !!sharing
  }));
}

// ==================== WS 消息处理 ====================
function handleChatMessage(msg) {
  if (msg.type === 'chat:typing') {
    if (msg.senderId === chatActiveUserId) {
      const header = document.getElementById('chatDetailHeader');
      if (header) {
        if (msg.stop) {
          const typingEl = document.getElementById('chatTypingIndicator');
          if (typingEl) typingEl.remove();
        } else {
          if (!document.getElementById('chatTypingIndicator')) {
            header.insertAdjacentHTML('beforeend', '<span id="chatTypingIndicator" class="chat-typing-indicator">' + __('chat.typing') + '</span>');
          }
        }
      }
    }
    return;
  }
  if (msg.type === 'chat:new') {
    const m = msg.message;
    if (m.senderId === currentUser.id) return;
    const talkTo = m.receiverId === currentUser.id ? m.senderId : m.receiverId;
    if (talkTo === chatActiveUserId) {
      const typingEl = document.getElementById('chatTypingIndicator');
      if (typingEl) typingEl.remove();
    }
    if (chatActiveUserId === talkTo) {
      appendReceivedMessage(m);
      api('/api/chat/messages/read-batch', { method: 'PATCH', body: JSON.stringify({ messageIds: [m.id] }) }).catch(() => {});
    }
    if (chatActiveUserId !== talkTo) {
      // 不在当前对话中才重载列表（更新未读数）
      loadChatConversations();
    }
  }
  if (msg.type === 'chat:sent') {
    const sentMsg = msg.message;
    // 仅当仍处于对应私聊会话时才渲染回执，避免切走会话后消息串台显示到其它会话（聊天问题 9.1）
    if (chatActiveUserId === sentMsg.receiverId) {
      appendReceivedMessage(sentMsg, true);
    }
    return;
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
  // 位置开关信令：渲染为系统提示行（不持久化、不计未读），避免污染群聊消息流
  if (msg.type === 'group:location:toggle') {
    if (chatActiveGroupId === msg.groupId && msg.userId !== currentUser.id) {
      appendGroupSystemLine(
        (msg.sharing ? '📍 ' : '⏹ ') +
        (msg.displayName || __('chat.someone')) +
        (msg.sharing ? __('chat.location_sys_start') : __('chat.location_sys_stop'))
      );
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
      <div class="chat-msg-bubble">${chatMediaBlock(msg)}${msg.content ? esc(msg.content) : ''}</div>
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
      <div class="chat-msg-bubble">${chatMediaBlock(msg)}${msg.content ? esc(msg.content) : ''}</div>
      <div class="chat-msg-time">${msg.createdAt ? new Date(msg.createdAt).toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit' }) : ''}</div>
    </div>`);
  chatBox.scrollTop = chatBox.scrollHeight;
}

// 群聊系统提示行（位置开关等）：居中、弱提示、不持久化、不计未读
function appendGroupSystemLine(text) {
  const chatBox = document.getElementById('chatBox');
  if (!chatBox) return;
  const emptyMsg = chatBox.querySelector('.chat-empty-msg');
  if (emptyMsg) emptyMsg.remove();
  const div = document.createElement('div');
  div.className = 'chat-system-msg';
  div.style.cssText = 'text-align:center;font-size:12px;color:var(--text-muted);padding:6px 0;';
  div.textContent = text;
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function updateChatBadge() {
  let total = Object.values(chatConversations).reduce((sum, c) => sum + (c.unreadCount || 0), 0);
  if (chatUnreadData && chatUnreadData.groups) {
    total += chatUnreadData.groups.reduce((sum, g) => sum + (g.count || 0), 0);
  }
  const badge = document.getElementById('chatUnreadBadge');
  if (badge) {
    if (total > 0) { badge.textContent = total > 99 ? '99+' : total; showEl(badge, 'inline'); }
    else { hideEl(badge); }
  }
}

function debouncedChatSearch(keyword) {
  if (chatSearchTimeout) clearTimeout(chatSearchTimeout);
  chatSearchTimeout = setTimeout(() => {
    chatSearch(keyword);
  }, 300);
}

async function chatSearch(keyword) {
  keyword = (keyword || '').trim();
  const searchResultsEl = document.getElementById('chatSearchResults');
  const contentEl = document.getElementById('chatConversationListContent');
  if (!searchResultsEl || !contentEl) return;
  if (!keyword) {
    searchResultsEl.innerHTML = '';
    contentEl.style.display = '';
    return;
  }
  if (keyword.length < 2) return;
  try {
    const res = await api(`/api/chat/search?keyword=${encodeURIComponent(keyword)}&scope=all`, { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      const pmHtml = data.privateMessages.length > 0 ? `<div class="chat-section-title">${__('chat.search_pm')}</div>
        ${data.privateMessages.map(m => {
          const otherId = m.senderId === currentUser.id ? m.receiverId : m.senderId;
          const avatarSrc = m.senderAvatar ? escAttr(m.senderAvatar) : '/api/avatar/default';
          return `<div class="chat-conv-item" onclick="openChat(${otherId})">
            <img src="${avatarSrc}" class="chat-conv-avatar" onerror="this.src='/api/avatar/default'">
            <div class="chat-conv-info">
              <div class="chat-conv-name">${esc(m.senderName || __('unknown_user'))}</div>
              <div class="chat-conv-msg">${esc(m.content.slice(0, 30))}</div>
            </div>
            <div class="chat-conv-time">${formatChatTime(m.createdAt)}</div>
          </div>`;
        }).join('')}` : '';
      const gmHtml = data.groupMessages.length > 0 ? `<div class="chat-section-title">${__('chat.search_group')}</div>
        ${data.groupMessages.map(m => {
          const avatarSrc = m.senderAvatar ? escAttr(m.senderAvatar) : '/api/avatar/default';
          return `<div class="chat-conv-item" onclick="openGroupChat(${m.groupId})">
            <div class="chat-group-avatar">#</div>
            <div class="chat-conv-info">
              <div class="chat-conv-name">${esc(m.groupName || __('chat.group'))}</div>
              <div class="chat-conv-msg">${esc(m.senderName)}: ${esc(m.content.slice(0, 30))}</div>
            </div>
            <div class="chat-conv-time">${formatChatTime(m.createdAt)}</div>
          </div>`;
        }).join('')}` : '';
      contentEl.style.display = 'none';
      if (pmHtml || gmHtml) {
        searchResultsEl.innerHTML = pmHtml + gmHtml;
      } else {
        renderEmpty(searchResultsEl, { icon: '🔍', text: __('chat.no_search_results') });
      }
    }
  } catch (e) { }
}

function clearChatSearch() {
  const input = document.getElementById('chatSearchInput');
  if (input) input.value = '';
  const searchResultsEl = document.getElementById('chatSearchResults');
  const contentEl = document.getElementById('chatConversationListContent');
  if (searchResultsEl) searchResultsEl.innerHTML = '';
  if (contentEl) contentEl.style.display = '';
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
      const res = await api('/api/users/all/locations', { method: 'GET' });
      if (res.ok) {
        const data = await res.json();
        const u = (data.markers || []).find(x => String(x.id) === String(userId));
        if (u && typeof upsertLocationMarker === 'function') {
          upsertLocationMarker(u);
          setTimeout(() => {
            const m = leafletMarkers ? leafletMarkers[userId] : null;
            if (m) { m.openPopup(); mapInstance.setView(m.getLatLng(), 14); }
          }, 200);
        } else { toast(__('chat.user_no_location'), 'info'); }
      }
    } catch { toast(__('chat.gps_info_failed'), 'error'); }
  };
  setTimeout(tryLocate, 300);
}

// ==================== 群聊位置标记管理（小地图用） ====================
// 简化版：在聊天框内显示位置提示
function showGroupLocationOnChat(msg) {
  // 记录最后上报时间，供幽灵标记清扫使用
  const gid = msg.groupId;
  groupLocLastSeen[gid] = groupLocLastSeen[gid] || {};
  groupLocLastSeen[gid][msg.userId] = Date.now();
  // 在聊天框底部显示成员的实时位置提示
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

// ==================== 群聊设置 V6.15 ====================
async function showGroupSettings(groupId) {
  try {
    const [grpRes, adminRes] = await Promise.all([
      api(`/api/chat/groups/${groupId}`, { method: 'GET' }),
      api(`/api/chat/groups/${groupId}/admins`, { method: 'GET' })
    ]);
    if (!grpRes.ok || !adminRes.ok) return;
    const grp = await grpRes.json();
    const adminData = await adminRes.json();
    const group = grp.group;
    const members = grp.members || [];
    const admins = adminData.admins || [];
    const isCreator = group.creatorId === currentUser.id;
    const isAdmin = admins.some(a => a.id === currentUser.id);

    let html = `<div class="modal" id="groupSettingsModal">
      <div class="modal-content" style="max-width:500px">
        <h3 class="section-title">${__('chat.group_settings')}</h3>
        <div class="form-group"><label>${__('chat.group_name')}</label><strong>${esc(group.name)}</strong></div>
        <div class="form-group"><label>${__('chat.group_creator')}</label><strong>${members.find(m => m.id === group.creatorId)?.displayName || __('unknown_user')}</strong></div>
        <div class="form-group"><label>${__('chat.member_list')} (${members.length})</label>
          <div style="max-height:250px;overflow-y:auto">${members.map(m => {
            const isMemberAdmin = admins.some(a => a.id === m.id);
            const isMe = m.id === currentUser.id;
            let actions = '';
            if (isCreator && !isMe) {
              actions += `<button class="btn btn-xs ml-2" onclick="toggleGroupAdmin(${groupId}, ${m.id}, ${!isMemberAdmin})">${isMemberAdmin ? __('chat.remove_admin') : __('chat.add_admin')}</button>`;
              if (!isMemberAdmin) {
                actions += `<button class="btn btn-xs btn-danger ml-2" onclick="kickGroupMember(${groupId}, ${m.id})">${__('chat.kick')}</button>`;
              }
            } else if (isAdmin && !isMe && !isMemberAdmin && !isCreator) {
              actions += `<button class="btn btn-xs btn-danger ml-2" onclick="kickGroupMember(${groupId}, ${m.id})">${__('chat.kick')}</button>`;
            }
            return `<div class="flex-row items-center p-3 border-b border-border">
              <img src="${m.avatarUrl ? escAttr(m.avatarUrl) : '/api/avatar/default'}" class="chat-mini-avatar">
              <span>${esc(m.displayName)}</span>
              ${isMemberAdmin ? '<span class="badge badge-accent ml-auto">' + __('chat.admin_badge') + '</span>' : ''}
              ${isMe ? '<span class="badge badge-success ml-auto">' + __('chat.me_badge') + '</span>' : ''}
              ${actions}
            </div>`;
          }).join('')}</div>
        </div>`;

    // §P1-6: 群主可见隐私设置与邀请码管理
    if (isCreator) {
      html += `<div class="form-group mt-4"><label>${__('chat.group_privacy')}</label>`;
      if (group.isPublic) {
        html += `<button class="btn btn-outline" onclick="setGroupPrivacy(${groupId}, false)">${__('chat.make_private')}</button>`;
      } else {
        html += `<div class="flex-row items-center flex-wrap gap-4">
          <code style="font-family:monospace;font-size:1.1rem;letter-spacing:1px;background:var(--bg);padding:4px 8px;border-radius:6px" id="grpInviteCode">${escAttr(group.inviteCode || '')}</code>
          <button class="btn btn-xs" onclick="copyGroupInvite('${escAttr(group.inviteCode || '')}')">${__('chat.copy_code')}</button>
          <button class="btn btn-xs" onclick="regenerateInvite(${groupId})">${__('chat.regen_code')}</button>
          <button class="btn btn-xs btn-outline" onclick="setGroupPrivacy(${groupId}, true)">${__('chat.make_public')}</button>
        </div>`;
      }
      html += `</div>`;
    }

    if (!isCreator) {
      html += `<button class="btn btn-danger w-full mt-4" onclick="leaveGroup(${groupId})">${__('chat.leave_group')}</button>`;
    }

    html += `<button class="btn w-full mt-2" onclick="closeModal('groupSettingsModal')">${__('chat.close')}</button></div></div>`;

    const existing = document.getElementById('groupSettingsModal');
    if (existing) existing.remove();
    const div = document.createElement('div');
    div.innerHTML = html;
    document.body.appendChild(div.firstElementChild);
    showModal('groupSettingsModal');
  } catch (e) { toast(__('chat.load_failed'), 'error'); }
}

async function toggleGroupAdmin(groupId, userId, add) {
  try {
    const res = add
      ? await api(`/api/chat/groups/${groupId}/admins`, { method: 'POST', body: JSON.stringify({ userId }) })
      : await api(`/api/chat/groups/${groupId}/admins/${userId}`, { method: 'DELETE' });
    if (res.ok) {
      toast(add ? __('chat.admin_added') : __('chat.admin_removed'), 'success');
      showGroupSettings(groupId);
    }
  } catch (e) { if (isApiHandledError(e)) return; toast(__('chat.op_failed'), 'error'); }
}

async function kickGroupMember(groupId, userId) {
  showConfirm(__('chat.kick_confirm'), async () => {
    try {
      const res = await api(`/api/chat/groups/${groupId}/kick`, { method: 'POST', body: JSON.stringify({ userId }) });
      if (res.ok) {
        toast(__('chat.kicked'), 'success');
        showGroupSettings(groupId);
      }
    } catch (e) { if (isApiHandledError(e)) return; toast(__('chat.op_failed'), 'error'); }
  });
}

async function leaveGroup(groupId) {
  showConfirm(__('chat.leave_confirm'), async () => {
    try {
      const res = await api(`/api/chat/groups/${groupId}/leave`, { method: 'POST' });
      if (res.ok) {
        toast(__('chat.left_group'), 'success');
        closeModal('groupSettingsModal');
        closeChatDetail();
        loadChatConversations();
      }
    } catch (e) { if (isApiHandledError(e)) return; toast(__('chat.op_failed'), 'error'); }
  });
}

// ==================== 凭邀请码加入私密群 §P1-6 ====================
function showJoinByCodeModal() {
  const div = document.createElement('div');
  div.innerHTML = `<div class="modal" id="joinByCodeModal">
    <div class="modal-content" style="max-width:420px">
      <h3 class="section-title">${__('chat.join_by_code')}</h3>
      <p class="text-sm text-muted">${__('chat.join_by_code_hint')}</p>
      <div class="form-group"><input type="text" id="joinCodeInput" class="form-input" placeholder="${__('chat.invite_code')}" style="text-transform:uppercase" maxlength="32"></div>
      <div class="modal-actions">
        <button type="button" class="btn" onclick="closeModal('joinByCodeModal')">${__('chat.cancel_btn')}</button>
        <button class="btn btn-accent" onclick="doJoinByCode()">${__('chat.join')}</button>
      </div>
    </div>
  </div>`;
  const existing = document.getElementById('joinByCodeModal');
  if (existing) existing.remove();
  document.body.appendChild(div.firstElementChild);
  showModal('joinByCodeModal');
}

async function doJoinByCode() {
  const code = document.getElementById('joinCodeInput')?.value?.trim();
  if (!code) { toast(__('chat.enter_code'), 'error'); return; }
  try {
    const res = await api('/api/chat/groups/join-by-code', { method: 'POST', body: JSON.stringify({ inviteCode: code }) });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      toast(__('chat.joined'), 'success');
      closeModal('joinByCodeModal');
      loadChatConversations();
      if (data.groupId) openGroupChat(data.groupId);
    }
  } catch (e) { if (isApiHandledError(e)) return; toast(__('chat.join_failed'), 'error'); }
}

// ==================== 群隐私 / 邀请码管理 §P1-6 ====================
async function setGroupPrivacy(groupId, isPublic) {
  try {
    const res = await api(`/api/chat/groups/${groupId}`, { method: 'PATCH', body: JSON.stringify({ isPublic }) });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      toast(isPublic ? __('chat.now_public') : __('chat.now_private'), 'success');
      showGroupSettings(groupId);
      if (data.inviteCode) showInviteCodeModal(data.inviteCode, '');
    }
  } catch (e) { if (isApiHandledError(e)) return; toast(__('chat.op_failed'), 'error'); }
}

async function regenerateInvite(groupId) {
  try {
    const res = await api(`/api/chat/groups/${groupId}`, { method: 'PATCH', body: JSON.stringify({ regenerateCode: true }) });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data.inviteCode) {
        const el = document.getElementById('grpInviteCode');
        if (el) el.textContent = data.inviteCode;
        showInviteCodeModal(data.inviteCode, '');
        toast(__('chat.code_regenerated'), 'success');
      }
    }
  } catch (e) { if (isApiHandledError(e)) return; toast(__('chat.op_failed'), 'error'); }
}

function copyGroupInvite(code) {
  if (!code) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(code)
      .then(() => toast(__('chat.copied'), 'success'))
      .catch(() => toast(__('chat.copy_failed'), 'error'));
  } else {
    toast(__('chat.copy_failed'), 'error');
  }
}

function showInviteCodeModal(code, name) {
  const div = document.createElement('div');
  div.innerHTML = `<div class="modal" id="inviteCodeModal">
    <div class="modal-content" style="max-width:420px">
      <h3 class="section-title">${esc(name || __('chat.private_group'))} · ${__('chat.invite_code')}</h3>
      <p class="text-sm text-muted">${__('chat.invite_code_hint')}</p>
      <div class="flex-row items-center gap-4 p-4">
        <code style="font-family:monospace;font-size:1.2rem;letter-spacing:1px;background:var(--bg);padding:6px 10px;border-radius:6px" id="inviteCodeText">${esc(code)}</code>
        <button class="btn btn-accent" onclick="copyGroupInvite('${escAttr(code)}')">${__('chat.copy_code')}</button>
      </div>
      <button class="btn w-full mt-2" onclick="closeModal('inviteCodeModal')">${__('chat.close')}</button>
    </div>
  </div>`;
  const existing = document.getElementById('inviteCodeModal');
  if (existing) existing.remove();
  document.body.appendChild(div.firstElementChild);
  showModal('inviteCodeModal');
}

// ==================== 消息分页加载 ====================
let chatLoadingMore = false;
let chatTypingTimeout = null;
let lastTypingSent = 0;
async function loadMoreMessages() {
  if (chatLoadingMore) return;
  const chatBox = document.getElementById('chatBox');
  if (!chatBox) return;
  const reqUser = chatActiveUserId, reqGroup = chatActiveGroupId; // 快照，防切换会话时旧数据污染新会话

  if (chatActiveUserId && chatPage * chatPageSize < chatTotal) {
    chatLoadingMore = true;
    chatBox.insertAdjacentHTML('afterbegin', '<div id="chatLoadingMore" class="chat-loading-more">' + __('chat.loading') + '</div>');
    chatPage++;
    try {
      const res = await api(`/api/chat/history/${chatActiveUserId}?page=${chatPage}&pageSize=${chatPageSize}`, { method: 'GET' });
      if (res.ok) {
        const data = await res.json();
        if (reqUser !== chatActiveUserId || reqGroup !== chatActiveGroupId) return; // 会话已切换，丢弃旧数据
        prependMessages(data.messages || []);
      }
    } catch (e) { chatPage--; }
    finally { chatLoadingMore = false; const loader = document.getElementById('chatLoadingMore'); if (loader) loader.remove(); }
  } else if (chatActiveGroupId && groupChatPage * chatPageSize < groupChatTotal) {
    chatLoadingMore = true;
    chatBox.insertAdjacentHTML('afterbegin', '<div id="chatLoadingMore" class="chat-loading-more">' + __('chat.loading') + '</div>');
    groupChatPage++;
    try {
      const res = await api(`/api/chat/groups/${chatActiveGroupId}/messages?page=${groupChatPage}&pageSize=${chatPageSize}`, { method: 'GET' });
      if (res.ok) {
        const data = await res.json();
        if (reqUser !== chatActiveUserId || reqGroup !== chatActiveGroupId) return;
        prependGroupMessages(data.messages || []);
      }
    } catch (e) { groupChatPage--; }
    finally { chatLoadingMore = false; const loader = document.getElementById('chatLoadingMore'); if (loader) loader.remove(); }
  }
}

function prependMessages(messages) {
  const chatBox = document.getElementById('chatBox');
  if (!chatBox || !messages || messages.length === 0) return;
  const prevScroll = chatBox.scrollTop;
  const prevHeight = chatBox.scrollHeight;
  const newContent = messages.map(m => {
    const isMe = m.senderId === currentUser.id;
    return `<div class="chat-msg ${isMe ? 'chat-msg-me' : 'chat-msg-other'}">
      <div class="chat-msg-bubble">${esc(m.content)}</div>
      <div class="chat-msg-time">${new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit' })}</div>
    </div>`;
  }).join('');
  chatBox.insertAdjacentHTML('afterbegin', newContent);
  // 锚定原阅读位置：向上加载历史后保持当前消息的视觉位置不变（聊天问题 9.2）
  chatBox.scrollTop = prevScroll + (chatBox.scrollHeight - prevHeight);
}

function prependGroupMessages(messages) {
  const chatBox = document.getElementById('chatBox');
  if (!chatBox || !messages || messages.length === 0) return;
  const prevScroll = chatBox.scrollTop;
  const prevHeight = chatBox.scrollHeight;
  const newContent = messages.map(m => {
    const isMe = m.senderId === currentUser.id;
    return `<div class="chat-msg ${isMe ? 'chat-msg-me' : 'chat-msg-other'}">
      ${!isMe ? `<div class="chat-msg-sender">${esc(m.senderName || '')}</div>` : ''}
      <div class="chat-msg-bubble">${esc(m.content)}</div>
      <div class="chat-msg-time">${new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit' })}</div>
    </div>`;
  }).join('');
  chatBox.insertAdjacentHTML('afterbegin', newContent);
  // 锚定原阅读位置：向上加载历史后保持当前消息的视觉位置不变（聊天问题 9.2）
  chatBox.scrollTop = prevScroll + (chatBox.scrollHeight - prevHeight);
}

// ==================== 键盘快捷键 ====================
document.addEventListener('DOMContentLoaded', () => {
  const chatInput = document.getElementById('chatInput');
  if (chatInput) {
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
    });
    chatInput.addEventListener('input', () => {
      if (chatActiveUserId && wsClient && wsClient.readyState === WebSocket.OPEN) {
        const now = Date.now();
        if (now - lastTypingSent > 3000) {
          wsClient.send(JSON.stringify({ type: 'chat:typing', receiverId: chatActiveUserId, userId: currentUser.id }));
          lastTypingSent = now;
        }
        if (chatTypingTimeout) clearTimeout(chatTypingTimeout);
        chatTypingTimeout = setTimeout(() => {
          if (wsClient && wsClient.readyState === WebSocket.OPEN) {
            wsClient.send(JSON.stringify({ type: 'chat:typing', receiverId: chatActiveUserId, userId: currentUser.id, stop: true }));
          }
        }, 2000);
      }
    });
  }
  const chatBox = document.getElementById('chatBox');
  if (chatBox) {
    chatBox.addEventListener('scroll', () => {
      if (chatBox.scrollTop < 50) {
        loadMoreMessages();
      }
    });
  }

  // 离开/刷新页面时尽力广播停止，减少他人端幽灵标记（不可靠，主要靠前端清扫兜底）
  window.addEventListener('beforeunload', () => {
    if (glGroups.size === 0 || !wsClient || wsClient.readyState !== WebSocket.OPEN) return;
    const payload = JSON.stringify({ type: 'group:location:stop' });
    try {
      glGroups.forEach((gid) => {
        wsClient.send(JSON.stringify({ type: 'group:location:stop', groupId: gid, userId: currentUser.id }));
      });
    } catch (e) {}
  });
});
