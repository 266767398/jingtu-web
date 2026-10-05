// ==================== 聊天私信 + 群聊 + 实时位置 V6.13 ====================
let chatConversations = {};
let chatActiveUserId = null;
let chatActiveGroupId = null;
let chatUnreadData = null;
let chatSearchTimeout = null;
let chatCurrentView = 'conversations'; // conversations | chat | group | groupChat
// 群角色缓存：gid → { isCreator, isAdmin }（打开群聊时拉取，用于撤回按钮可见性判断）
let chatGroupRoles = {};
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

// ==================== RTC 实时通话状态 ====================
let rtcIceServers = null;              // 缓存 /api/chat/rtc/config 下发的 iceServers
let rtcTurnConfigured = false;
let rtcPrivate = null;                 // 私聊 1v1：{ status, peerId, roomId, callType, localStream, screenStream, pc, isCaller, timer, screenSharing }
let rtcGroupRoom = null;               // 群语音房：{ groupId, roomKey, members:[], peerMap:{userId→pc}, localStream, screenStream, screenSharing }
let rtcPttRecorder = null;             // 按住说话 MediaRecorder
let rtcPttChunks = [];
let rtcPttTimer = 0;
let rtcPttStartedAt = 0;
let rtcAudioCtx = null;                // 音效 AudioContext（懒加载、用户手势解锁）
let rtcRingTimer = 0;                  // 来电铃声循环定时器
const rtcVolumeWatchers = new Map();   // 音量监视器：key -> stop()
let rtcRemoteStream = null;            // 当前通话已挂载的远端流（重建浮层时用于重挂音量监视）

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
  } catch (e) { toast(__('chat.load_failed'), 'error'); }
  finally { chatLoading = false; }
}

function renderChatMain(convs, groups) {
  const listEl = document.getElementById('chatConversationList');
  if (!listEl) return;
  // 群聊区域
  const groupHtml = groups.length > 0 ? `<div class="chat-section-title">${__('chat.group_chat')}</div>
    ${groups.map(g => {
      const activeClass = chatActiveGroupId === g.id ? 'chat-conv-active' : '';
      return `<div class="chat-conv-item ${activeClass}" tabindex="0" role="button" aria-label="${escAttr(g.name || '')}" onclick="openGroupChat(${g.id})" onkeydown="if(event.key==='Enter')openGroupChat(${g.id})">
        <div class="chat-group-avatar">#</div>
        <div class="chat-conv-info">
          <div class="chat-conv-name">${esc(g.name)}</div>
          <div class="chat-conv-msg">${__('chat.n_members_label', {n: g.memberCount})} · ${g.lastMessage ? esc(g.lastMessage.slice(0, 30)) : __('chat.no_messages')}</div>
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
      return `<div class="chat-conv-item ${activeClass}" tabindex="0" role="button" aria-label="${escAttr(c.displayName || '')}" onclick="openChat(${c.userId})" onkeydown="if(event.key==='Enter')openChat(${c.userId})">
        <img src="${avatarSrc}" class="chat-conv-avatar" loading="lazy" onerror="window.__avatarFail&&window.__avatarFail(this,'${escJsStr(c.avatarUrl || '/api/avatar/default')}')" />
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
    // 快照校验：响应返回期间用户可能已切换到其他会话，避免把旧会话渲染到当前视图（串台）
    if (chatActiveUserId !== userId) return;
    if (histRes.ok && userRes.ok) {
      const hist = await histRes.json();
      const user = await userRes.json();
      const displayName = user.displayName || __('unknown_user');
      const avatarSrc = user.avatarUrl ? escAttr(user.avatarUrl) : '/api/avatar/default';
      chatTotal = hist.total || 0;
      document.getElementById('chatDetailHeader').innerHTML = `
        <button class="btn btn-xs" onclick="closeChatDetail()">${__('chat.back')}</button>
        <img src="${avatarSrc}" class="chat-conv-avatar mx-4" loading="lazy" onerror="window.__avatarFail&&window.__avatarFail(this,'${escJsStr(user.avatarUrl || '/api/avatar/default')}')" />
        <strong>${esc(displayName)}</strong>
        <span class="ml-auto">
          <button class="btn btn-xs btn-outline" onclick="startPrivateCall(${userId},'voice')" title="${esc(__('rtc.voice_call'))}">📞</button>
          <button class="btn btn-xs btn-outline ml-2" onclick="startPrivateCall(${userId},'video')" title="${esc(__('rtc.video_call'))}">📹</button>
          <button class="btn btn-xs btn-outline ml-2" onclick="viewUserOnMap(${userId})">${__('chat.view_location')}</button>
        </span>`;
      const unreadMsgIds = (hist.messages || []).filter(m => !m.isRead && m.receiverId === currentUser.id).map(m => m.id);
      if (unreadMsgIds.length > 0) {
        await api('/api/chat/messages/read-batch', { method: 'PATCH', body: JSON.stringify({ messageIds: unreadMsgIds }) }).catch(() => {});
        if (chatActiveUserId !== userId) return;
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
    else {
      // 发送失败：回填正文，避免用户内容丢失
      input.value = content; input.focus();
      toast(__('chat.send_failed'), 'error');
    }
  } catch (e) {
    if (isApiHandledError(e)) { input.value = content; input.focus(); return; }
    input.value = content; input.focus();
    toast(__('chat.send_failed'), 'error');
  }
}

// 媒体上传入口（图片/视频/语音）：WS 不承载二进制，媒体只能走 HTTP multipart；
// api() 会 JSON.stringify FormData，必须用 apiForm()（浏览器自设 boundary）。
// 三类入口仅校验规则与按钮 id 不同，收敛到共享实现，保留各入口函数名供 DOM 内联调用。
const CHAT_MEDIA_RULES = {
  image: { btn: 'chatImageBtn', kind: 'image/', exts: ['.jpg', '.jpeg', '.png', '.gif', '.webp'], typeKey: 'chat.image_type_error', sizeKey: 'chat.image_too_large' },
  video: { btn: 'chatVideoBtn', kind: 'video/', exts: ['.mp4', '.mov', '.webm', '.avi', '.mkv'], typeKey: 'chat.video_type_error', sizeKey: 'chat.video_too_large' },
  audio: { btn: 'chatAudioBtn', kind: 'audio/', exts: ['.mp3', '.wav', '.ogg', '.m4a', '.webm'], typeKey: 'chat.audio_type_error', sizeKey: 'chat.audio_too_large' }
};

function pickChatMedia(inputId) {
  if (!currentUser) { toast(__('please_login'), 'error'); return; }
  if (!chatActiveGroupId && !chatActiveUserId) return;
  const input = document.getElementById(inputId);
  if (input) input.click();
}

async function uploadChatMedia(el, media) {
  const rule = CHAT_MEDIA_RULES[media];
  const file = el.files && el.files[0];
  el.value = ''; // 允许重选同一文件
  if (!file) return;
  const ext = '.' + (file.name.split('.').pop() || '').toLowerCase();
  if (!file.type.startsWith(rule.kind) || !rule.exts.includes(ext)) { toast(__(rule.typeKey), 'error'); return; }
  if (file.size > 100 * 1024 * 1024) { toast(__(rule.sizeKey), 'error'); return; }
  if (!chatActiveGroupId && !chatActiveUserId) return;
  const btn = document.getElementById(rule.btn);
  if (btn) btn.disabled = true;
  try {
    const fd = new FormData();
    fd.append('file', file);
    let url;
    if (chatActiveGroupId) { url = `/api/chat/groups/${chatActiveGroupId}/messages`; fd.append('msgType', media); }
    else { url = '/api/chat/send'; fd.append('receiverId', chatActiveUserId); }
    const res = await apiForm(url, fd);
    if (!res.ok) {
      const d = await res.json().catch(() => null);
      toast(errText(d) || __('chat.send_failed'), 'error');
      return;
    }
    const d = await res.json().catch(() => null);
    if (!d || !d.message) return;
    if (chatActiveGroupId) appendGroupMessage(d.message);
    else appendReceivedMessage(d.message, true);
  } catch (e) {
    if (!isApiHandledError(e)) toast(__('chat.send_failed'), 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function pickChatImage() { pickChatMedia('chatImageInput'); }
function onChatImageSelected(el) { return uploadChatMedia(el, 'image'); }
function pickChatVideo() { pickChatMedia('chatVideoInput'); }
function onChatVideoSelected(el) { return uploadChatMedia(el, 'video'); }
function pickChatAudio() { pickChatMedia('chatAudioInput'); }
function onChatAudioSelected(el) { return uploadChatMedia(el, 'audio'); }

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
    return `<img class="chat-media chat-media-img" src="${url}" alt="" loading="lazy" style="max-width:100%;border-radius:8px;display:block" onerror="window.__imgFail(this)">`;
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
    const recallBtn = canRecallPrivateMsg(m)
      ? `<button class="chat-msg-recall" data-mid="${m.id}" onclick="recallPrivateMessage(${m.id})">${__('chat.recall')}</button>`
      : '';
    return `<div class="chat-msg ${isMe ? 'chat-msg-me' : 'chat-msg-other'}" data-mid="${m.id}">
      <div class="chat-msg-bubble">${chatMediaBlock(m)}${m.content ? esc(m.content) : ''}</div>
      <div class="chat-msg-time">${new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit' })} ${recallBtn}</div>
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
                <span>${esc(u.displayName || __('chat.someone'))}</span>
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
    console.warn('[chat] openGroupChat: invalid groupId', groupId);
    toast(__('chat.invalid_group'), 'error');
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
    // 群角色（撤回按钮可见性）：admin 列表加载失败不阻塞主流程
    const adminRes = await api(`/api/chat/groups/${groupId}/admins`, { method: 'GET' }).catch(() => null);
    let grp = null;
    if (grpRes.ok) grp = await grpRes.json().catch(() => null);
    if (adminRes && adminRes.ok) {
      const adminData = await adminRes.json().catch(() => ({ admins: [] }));
      chatGroupRoles[gid] = {
        isCreator: !!grp && grp.group && grp.group.creatorId === currentUser.id,
        isAdmin: (adminData.admins || []).some(a => a.id === currentUser.id)
      };
    }
    // 快照校验：响应返回期间用户可能已切换到其他会话，避免旧群聊渲染串台
    if (chatActiveGroupId !== gid) return;
    if (grpRes.ok && msgRes.ok) {
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
          <button id="groupVoiceBtn_${groupId}" class="btn btn-xs btn-outline ml-2" onclick="toggleGroupVoiceRoom(${groupId})">🎤 ${__('rtc.voice_room')}</button>
          <button class="btn btn-xs btn-outline ml-2" onclick="showGroupSettings(${groupId})">${__('chat.group_settings')}</button>
        </span>`;
      const unreadMsgIds = (msgs.messages || []).filter(m => !m.isRead).map(m => m.id);
      if (unreadMsgIds.length > 0) {
        await api(`/api/chat/groups/${groupId}/messages/read-batch`, { method: 'PATCH', body: JSON.stringify({ messageIds: unreadMsgIds }) }).catch(() => {});
        if (chatActiveGroupId !== gid) return;
      }
      loadChatConversations();
      renderGroupMessages(msgs.messages || [], members);
    }
  } catch (e) { if (isApiHandledError(e)) return; renderEmpty(document.getElementById('chatBox'), { icon: '⚠️', text: __('chat.load_failed') }); }
}

// ==================== 消息撤回 ====================
// 群消息撤回权限：本人消息（10分钟内 或 群主/管理员）或他人消息（仅群主/管理员，无时间限制）
function canRecallGroupMsg(m) {
  if (!m || !m.id || !currentUser) return false;
  const role = chatGroupRoles[m.groupId] || chatGroupRoles[chatActiveGroupId] || {};
  const isMe = m.senderId === currentUser.id;
  if (isMe) {
    const within10 = m.createdAt && (Date.now() - new Date(m.createdAt).getTime()) <= 10 * 60 * 1000;
    return within10 || role.isCreator || role.isAdmin;
  }
  return role.isCreator || role.isAdmin;
}

// 私聊撤回权限：仅发送者本人，且须在10分钟内
function canRecallPrivateMsg(m) {
  if (!m || !m.id || !currentUser) return false;
  if (m.senderId !== currentUser.id) return false;
  return !!(m.createdAt && (Date.now() - new Date(m.createdAt).getTime()) <= 10 * 60 * 1000);
}

// 在聊天消息区内按 data-mid 将消息标记为「已撤回」
function markMessageRecalled(msgId) {
  const chatBox = document.getElementById('chatBox');
  if (!chatBox) return;
  const el = chatBox.querySelector(`.chat-msg[data-mid="${msgId}"]`);
  if (!el) return;
  const bubble = el.querySelector('.chat-msg-bubble');
  if (bubble) bubble.innerHTML = esc(__('chat.recalled_msg'));
  const btn = el.querySelector('.chat-msg-recall');
  if (btn) btn.remove();
  el.classList.add('chat-msg-recalled');
}

async function recallGroupMessage(groupId, msgId) {
  if (!msgId) return;
  try {
    const res = await api(`/api/chat/groups/${groupId}/messages/${msgId}`, { method: 'DELETE' });
    if (res.ok) {
      markMessageRecalled(msgId);
      toast(__('chat.recalled'), 'success');
      loadChatConversations();
    }
  } catch (e) { if (isApiHandledError(e)) return; toast(__('chat.op_failed'), 'error'); }
}

async function recallPrivateMessage(msgId) {
  if (!msgId) return;
  try {
    const res = await api(`/api/chat/messages/${msgId}`, { method: 'DELETE' });
    if (res.ok) {
      markMessageRecalled(msgId);
      toast(__('chat.recalled'), 'success');
      loadChatConversations();
    }
  } catch (e) { if (isApiHandledError(e)) return; toast(__('chat.op_failed'), 'error'); }
}

// 群被解散：清理本端群状态并刷新会话列表
function handleGroupDissolved(groupId) {
  const gid = parseInt(groupId);
  if (gid && chatActiveGroupId === gid) {
    if (rtcGroupRoom && rtcGroupRoom.groupId === gid) leaveGroupVoiceRoom(gid);
    if (groupLocationSharing[gid]) stopGroupLocation(gid);
    closeChatDetail();
  }
  delete chatGroupRoles[gid];
  toast(__('chat.dissolved_toast'), 'info');
  loadChatConversations();
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
    const msgId = m.id;

    if (m.msgType === 'location') {
      // 位置消息（来自群聊实时位置共享保存的消息）
      return `<div class="chat-msg chat-msg-other" data-mid="${msgId}">
        <div class="chat-msg-sender">${senderAvatar ? `<img src="${senderAvatar}" class="chat-mini-avatar" loading="lazy" onerror="window.__avatarFail&&window.__avatarFail(this,'${escJsStr(sender.avatarUrl || '/api/avatar/default')}')">` : ''} ${esc(senderName)}</div>
        <div class="chat-msg-bubble chat-msg-location" onclick="window.openMapLocation&&openMapLocation(${m.lat},${m.lng})">${__('chat.location_sharing')}</div>
        <div class="chat-msg-time">${new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit' })}</div>
      </div>`;
    }
    const recallBtn = canRecallGroupMsg(m)
      ? `<button class="chat-msg-recall" data-mid="${msgId}" onclick="recallGroupMessage(${chatActiveGroupId}, ${msgId})">${__('chat.recall')}</button>`
      : '';
    if (m.mediaUrl && m.mediaType) {
      return `<div class="chat-msg ${isMe ? 'chat-msg-me' : 'chat-msg-other'}" data-mid="${msgId}">
        ${!isMe ? `<div class="chat-msg-sender">${senderAvatar ? `<img src="${senderAvatar}" class="chat-mini-avatar" loading="lazy" onerror="window.__avatarFail&&window.__avatarFail(this,'${escJsStr(sender.avatarUrl || '/api/avatar/default')}')">` : ''} ${esc(senderName)}</div>` : ''}
        <div class="chat-msg-bubble">${chatMediaBlock(m)}${m.content ? esc(m.content) : ''}</div>
        <div class="chat-msg-time">${new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit' })} ${recallBtn}</div>
      </div>`;
    }
    return `<div class="chat-msg ${isMe ? 'chat-msg-me' : 'chat-msg-other'}" data-mid="${msgId}">
      ${!isMe ? `<div class="chat-msg-sender">${senderAvatar ? `<img src="${senderAvatar}" class="chat-mini-avatar" loading="lazy" onerror="window.__avatarFail&&window.__avatarFail(this,'${escJsStr(sender.avatarUrl || '/api/avatar/default')}')">` : ''} ${esc(senderName)}</div>` : ''}
      <div class="chat-msg-bubble">${esc(m.content)}</div>
      <div class="chat-msg-time">${new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit' })} ${recallBtn}</div>
    </div>`;
  }).join('');
  chatBox.scrollTop = chatBox.scrollHeight;
}

// 发送群消息（HTTP + WS fallback）
async function sendGroupMessage(groupId, content) {
  const scheduler = () => {
    const input = document.getElementById('chatInput');
    if (input) { input.value = content; input.focus(); }
  };
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
      // 发送失败：回填正文（发送前已清空输入框），避免用户内容丢失
      scheduler();
      toast(__('chat.send_failed'), 'error');
    }
  } catch (e) {
    if (isApiHandledError(e)) { scheduler(); return; }
    scheduler();
    toast(__('chat.send_failed'), 'error');
  }
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
  if (glGroups.size === 0) stopGroupLocSweep();
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
      // 定位失败：停止全部群的共享，避免按钮卡在共享状态却不再发坐标
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

function stopGroupLocSweep() {
  if (glSweepTimer) { clearInterval(glSweepTimer); glSweepTimer = null; }
}

// 空闲冻结：暂停/恢复位置幽灵标记清扫定时器，挂机时减少空转（见 freeze.js）
if (window.__freeze && typeof window.__freeze.register === 'function') {
  window.__freeze.register({
    onFreeze: function () { stopGroupLocSweep(); },
    onUnfreeze: function () { startGroupLocSweep(); }
  });
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
    if (!sentMsg) return;
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
  // 自发群消息回执（服务端 group:sent）：渲染自己刚发出的消息
  if (msg.type === 'group:sent') {
    if (chatActiveGroupId === msg.groupId && msg.message) {
      appendGroupMessage(msg.message);
    }
    return;
  }
  // WS 发送失败反馈（非成员/异常），避免静默丢消息
  if (msg.type === 'chat:error') {
    toast(errText(msg) || __('chat.send_failed'), 'error');
    return;
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
  // 私聊消息撤回：对端实时将对应消息标记为「已撤回」
  if (msg.type === 'chat:recalled') {
    if (msg.messageId) markMessageRecalled(msg.messageId);
    return;
  }
  // 群消息撤回：当前群内实时标记，否则重载列表刷新最后一条预览
  if (msg.type === 'group:recalled') {
    if (chatActiveGroupId === msg.groupId) {
      markMessageRecalled(msg.messageId);
    } else {
      loadChatConversations();
    }
    return;
  }
  // 群被解散：清理本端群状态并刷新会话列表
  if (msg.type === 'group:dissolved') {
    handleGroupDissolved(msg.groupId);
    return;
  }
  // RTC 实时通话信令：全部以 'rtc:' 开头，统一分发到 RTC 模块（main.js 已转发至此）
  if (msg.type && msg.type.indexOf('rtc:') === 0) {
    handleRtcMessage(msg);
    return;
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
  const recallBtn = canRecallPrivateMsg(msg)
    ? `<button class="chat-msg-recall" data-mid="${msg.id}" onclick="recallPrivateMessage(${msg.id})">${__('chat.recall')}</button>`
    : '';
  chatBox.insertAdjacentHTML('beforeend', `
    <div class="chat-msg ${isMe ? 'chat-msg-me' : 'chat-msg-other'}" data-mid="${msg.id}">
      <div class="chat-msg-bubble">${chatMediaBlock(msg)}${msg.content ? esc(msg.content) : ''}</div>
      <div class="chat-msg-time">${new Date(msg.createdAt).toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit' })} ${recallBtn}</div>
    </div>`);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function appendGroupMessage(msg) {
  const chatBox = document.getElementById('chatBox');
  if (!chatBox) return;
  const emptyMsg = chatBox.querySelector('.chat-empty-msg');
  if (emptyMsg) emptyMsg.remove();
  const isMe = msg.senderId === currentUser.id;
  const recallBtn = canRecallGroupMsg(msg)
    ? `<button class="chat-msg-recall" data-mid="${msg.id}" onclick="recallGroupMessage(${chatActiveGroupId}, ${msg.id})">${__('chat.recall')}</button>`
    : '';
  chatBox.insertAdjacentHTML('beforeend', `
    <div class="chat-msg ${isMe ? 'chat-msg-me' : 'chat-msg-other'}" data-mid="${msg.id}">
      ${!isMe ? `<div class="chat-msg-sender">${esc(msg.senderName || '')}</div>` : ''}
      <div class="chat-msg-bubble">${chatMediaBlock(msg)}${msg.content ? esc(msg.content) : ''}</div>
      <div class="chat-msg-time">${msg.createdAt ? new Date(msg.createdAt).toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit' }) : ''} ${recallBtn}</div>
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

// P3-64: 搜索竞态防护——每次发起递增 seq，旧请求返回时不覆盖新结果
let chatSearchSeq = 0;
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
  const mySeq = ++chatSearchSeq;
  try {
    const res = await api(`/api/chat/search?keyword=${encodeURIComponent(keyword)}&scope=all`, { method: 'GET' });
    if (!res || !res.ok) {
      if (mySeq !== chatSearchSeq) return;
      toast(__('chat.search_failed') || '搜索失败，请稍后重试', 'error');
      return;
    }
    const data = await res.json();
    if (mySeq !== chatSearchSeq) return;
      const pmHtml = data.privateMessages.length > 0 ? `<div class="chat-section-title">${__('chat.search_pm')}</div>
        ${data.privateMessages.map(m => {
          const otherId = m.senderId === currentUser.id ? m.receiverId : m.senderId;
          const avatarSrc = m.senderAvatar ? escAttr(m.senderAvatar) : '/api/avatar/default';
          return `<div class="chat-conv-item" onclick="openChat(${otherId})">
            <img src="${avatarSrc}" class="chat-conv-avatar" onerror="window.__avatarFail&&window.__avatarFail(this,'${escJsStr(m.senderAvatar || '/api/avatar/default')}')">
            <div class="chat-conv-info">
              <div class="chat-conv-name">${esc(m.senderName || __('unknown_user'))}</div>
              <div class="chat-conv-msg">${esc((m.content || '').slice(0, 30))}</div>
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
              <div class="chat-conv-msg">${esc(m.senderName || '')}: ${esc((m.content || '').slice(0, 30))}</div>
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
  } catch (e) {
    // P3-69: 搜索异常给出反馈（原静默吞掉）
    if (mySeq !== chatSearchSeq) return;
    toast(__('chat.search_failed') || '搜索失败，请稍后重试', 'error');
  }
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
  let retries = 0;
  const MAX_RETRIES = 10; // P3-69: 地图初始化失败时停止轮询，避免每 500ms 无限自调
  const tryLocate = async () => {
    if (typeof mapInstance === 'undefined' || !mapInstance) {
      if (++retries > MAX_RETRIES) { toast(__('map.load_failed'), 'error'); return; }
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
  userLoc.innerHTML = `<img src="${avatarSrc}" class="chat-mini-avatar" loading="lazy" onerror="window.__avatarFail&&window.__avatarFail(this,'${escJsStr(msg.avatarUrl || '/api/avatar/default')}')"> ${esc(msg.displayName || '')} 🟢`;
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
              <img src="${m.avatarUrl ? escAttr(m.avatarUrl) : '/api/avatar/default'}" class="chat-mini-avatar" onerror="window.__avatarFail&&window.__avatarFail(this,'${escJsStr(m.avatarUrl || '/api/avatar/default')}')">
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
          <button class="btn btn-xs" onclick="copyGroupInvite('${escJsStr(group.inviteCode || '')}')">${__('chat.copy_code')}</button>
          <button class="btn btn-xs" onclick="regenerateInvite(${groupId})">${__('chat.regen_code')}</button>
          <button class="btn btn-xs btn-outline" onclick="setGroupPrivacy(${groupId}, true)">${__('chat.make_public')}</button>
        </div>`;
      }
      html += `</div>`;
    }

    if (!isCreator) {
      html += `<button class="btn btn-danger w-full mt-4" onclick="leaveGroup(${groupId})">${__('chat.leave_group')}</button>`;
    } else {
      html += `<button class="btn btn-danger w-full mt-4" onclick="dissolveGroup(${groupId})">${__('chat.dissolve_group')}</button>`;
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

// 解散群组（仅群主）：二次确认后物理删除群及全部数据
async function dissolveGroup(groupId) {
  showConfirm(__('chat.dissolve_confirm'), async () => {
    try {
      const res = await api(`/api/chat/groups/${groupId}`, { method: 'DELETE' });
      if (res.ok) {
        toast(__('chat.dissolved'), 'success');
        closeModal('groupSettingsModal');
        if (chatActiveGroupId === groupId) closeChatDetail();
        delete chatGroupRoles[groupId];
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

// 复制文本到剪贴板（兼容 http/内网 IP 等非安全上下文，navigator.clipboard 不可用时降级 execCommand）
function copyTextToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  return new Promise(function (resolve, reject) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error('copy failed'));
    } catch (e) { reject(e); }
  });
}

function copyGroupInvite(code) {
  if (!code) { toast(__('chat.copy_failed'), 'error'); return; }
  copyTextToClipboard(String(code))
    .then(() => toast(__('chat.copied'), 'success'))
    .catch(() => toast(__('chat.copy_failed'), 'error'));
}

function showInviteCodeModal(code, name) {
  const div = document.createElement('div');
  div.innerHTML = `<div class="modal" id="inviteCodeModal">
    <div class="modal-content" style="max-width:420px">
      <h3 class="section-title">${esc(name || __('chat.private_group'))} · ${__('chat.invite_code')}</h3>
      <p class="text-sm text-muted">${__('chat.invite_code_hint')}</p>
      <div class="flex-row items-center gap-4 p-4">
        <code style="font-family:monospace;font-size:1.2rem;letter-spacing:1px;background:var(--bg);padding:6px 10px;border-radius:6px" id="inviteCodeText">${esc(code)}</code>
        <button class="btn btn-accent" onclick="copyGroupInvite('${escJsStr(code)}')">${__('chat.copy_code')}</button>
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
      <div class="chat-msg-bubble">${chatMediaBlock(m)}${m.content ? esc(m.content) : ''}</div>
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
    if (m.msgType === 'location' && m.lat != null && m.lng != null) {
      return `<div class="chat-msg chat-msg-other">
        <div class="chat-msg-sender">${esc(m.senderName || '')}</div>
        <div class="chat-msg-bubble chat-msg-location" onclick="window.openMapLocation&&openMapLocation(${m.lat},${m.lng})">${__('chat.location_sharing')}</div>
        <div class="chat-msg-time">${new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit' })}</div>
      </div>`;
    }
    return `<div class="chat-msg ${isMe ? 'chat-msg-me' : 'chat-msg-other'}">
      ${!isMe ? `<div class="chat-msg-sender">${esc(m.senderName || '')}</div>` : ''}
      <div class="chat-msg-bubble">${chatMediaBlock(m)}${m.content ? esc(m.content) : ''}</div>
      <div class="chat-msg-time">${new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit' })}</div>
    </div>`;
  }).join('');
  chatBox.insertAdjacentHTML('afterbegin', newContent);
  // 锚定原阅读位置：向上加载历史后保持当前消息的视觉位置不变（聊天问题 9.2）
  chatBox.scrollTop = prevScroll + (chatBox.scrollHeight - prevHeight);
}

// ==================== RTC 实时通话模块 ====================
// 信令全部复用现有 WS（'rtc:' 前缀由 main.js 转发到 handleChatMessage）；
// 媒体（按住说话录音）走 HTTP multipart（apiForm），WS 不承载二进制。
// 契约对应 server/ws_service.js handleRtcSignal：
//   私聊：rtc:invite|cancel|accept|decline|offer|answer|candidate|hangup（带 targetId）
//   响应：rtc:invite / rtc:accepted / rtc:declined / rtc:canceled / rtc:offer|answer|candidate(sdp/candidate)
//         / rtc:hangup / rtc:invite:failed / rtc:error
//   群语音房（mesh）：rtc:group:join|leave|hangup（带 groupId）、rtc:group:offer|answer|candidate（带 groupId+targetId）
//   响应：rtc:group:joined(members) / rtc:group:member:join(member) / rtc:group:member:leave(userId)
//         / rtc:group:left / rtc:group:error；群 offer/answer/candidate 携带 senderId/targetId/roomKey
function rtcSend(payload) {
  if (wsClient && wsClient.readyState === WebSocket.OPEN) {
    wsClient.send(JSON.stringify(payload));
    return true;
  }
  return false;
}

async function ensureRtcIce() {
  if (rtcIceServers) return rtcIceServers;
  const fallback = [{ urls: 'stun:stun.l.google.com:19302' }];
  try {
    const res = await api('/api/chat/rtc/config', { method: 'GET' });
    if (!res.ok) throw new Error('rtc config failed');
    const d = await res.json();
    rtcIceServers = (d.iceServers && d.iceServers.length) ? d.iceServers : fallback;
    rtcTurnConfigured = !!d.turnConfigured;
  } catch (e) {
    rtcIceServers = fallback;
  }
  return rtcIceServers;
}

function rtcFmtTime(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

// ---- WebAudio 提示音（合成音效，无需音频素材） ----
function rtcEnsureAudio() {
  if (!rtcAudioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) rtcAudioCtx = new AC();
  }
  if (rtcAudioCtx && rtcAudioCtx.state === 'suspended') rtcAudioCtx.resume();
  return rtcAudioCtx;
}

function rtcTone(freq, durSec, type, gain, delaySec) {
  const ctx = rtcEnsureAudio();
  if (!ctx) return;
  const t = ctx.currentTime + (delaySec || 0);
  try {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type || 'sine';
    osc.frequency.value = freq;
    g.gain.setValueAtTime(gain || 0.12, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + (durSec || 0.2));
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + (durSec || 0.2) + 0.05);
  } catch (e) {}
}

function rtcPlayRing() {
  rtcStopRing();
  rtcTone(880, 0.16, 'sine', 0.09, 0);
  rtcTone(880, 0.16, 'sine', 0.09, 0.28);
  rtcRingTimer = setInterval(() => {
    rtcTone(880, 0.16, 'sine', 0.09, 0);
    rtcTone(880, 0.16, 'sine', 0.09, 0.28);
  }, 700);
}

function rtcStopRing() {
  if (rtcRingTimer) { clearInterval(rtcRingTimer); rtcRingTimer = 0; }
}

function rtcPlayConnected() { rtcTone(660, 0.12, 'sine', 0.1, 0); rtcTone(880, 0.16, 'sine', 0.1, 0.12); }
function rtcPlayHangup() { rtcTone(440, 0.16, 'sine', 0.09, 0); rtcTone(330, 0.22, 'sine', 0.09, 0.16); }
function rtcPlayPttStart() { rtcTone(720, 0.05, 'square', 0.05, 0); }
function rtcPlayPttStop() { rtcTone(480, 0.05, 'square', 0.05, 0); }

// ---- 音量监视（WebAudio Analyser，不输出到扬声器） ----
function rtcWatchVolumeImpl(stream, cb) {
  if (!stream || !stream.getAudioTracks().length) return null;
  const ctx = rtcEnsureAudio();
  if (!ctx) return null;
  try {
    const src = ctx.createMediaStreamSource(stream);
    const ana = ctx.createAnalyser();
    ana.fftSize = 256;
    ana.smoothingTimeConstant = 0.5;
    src.connect(ana);
    const buf = new Uint8Array(ana.frequencyBinCount);
    let raf = 0;
    const tick = () => {
      ana.getByteFrequencyData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i];
      try { cb(sum / buf.length / 255); } catch (e) {}
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      try { src.disconnect(); ana.disconnect(); } catch (e) {}
    };
  } catch (e) { return null; }
}

function rtcSetVolumeWatch(key, stream, cb) {
  rtcStopVolumeWatch(key);
  if (stream && stream.getAudioTracks().length) {
    const stop = rtcWatchVolumeImpl(stream, cb);
    if (stop) rtcVolumeWatchers.set(key, stop);
  }
}

function rtcStopVolumeWatch(key) {
  const stop = rtcVolumeWatchers.get(key);
  if (stop) { stop(); rtcVolumeWatchers.delete(key); }
}

function rtcStopVolumesByPrefix(prefix) {
  rtcVolumeWatchers.forEach((stop, key) => {
    if (key.indexOf(prefix) === 0) {
      try { stop(); } catch (e) {}
      rtcVolumeWatchers.delete(key);
    }
  });
}

// level 0~1 → 宽度百分比（UI 更新）
function rtcSetLevel(id, level) {
  const el = document.getElementById(id);
  if (el) el.style.width = Math.max(2, Math.min(100, Math.round(level * 100))) + '%';
}

function rtcStopStream(stream) {
  if (stream) stream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
}

// 麦克风采集统一开启回音消除/降噪/自动增益（防回音第一层防线）。
// 仅 audio:true 时 Safari 等浏览器不保证启用 AEC，扬声器外放声会被再次采集形成回音环路。
const RTC_AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

function rtcClosePeer(pc) {
  if (!pc) return;
  try {
    pc.onicecandidate = null;
    pc.ontrack = null;
    pc.onconnectionstatechange = null;
    pc.onnegotiationneeded = null;
    pc.close();
  } catch (e) {}
}

// 构造 RTCPeerConnection，并挂上通用的 ICE/轨道/连接状态回调（私聊与群聊共用骨架）
function rtcBuildPeer(handlers) {
  const pc = new RTCPeerConnection({ iceServers: rtcIceServers || [{ urls: 'stun:stun.l.google.com:19302' }] });
  pc.onicecandidate = (e) => { if (e.candidate && handlers.onIce) handlers.onIce(pc, e.candidate.toJSON()); };
  pc.ontrack = (e) => { if (handlers.onTrack) handlers.onTrack(pc, e); };
  pc.onconnectionstatechange = () => { if (handlers.onState) handlers.onState(pc); };
  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'disconnected' && handlers.onDisconnected) handlers.onDisconnected(pc);
  };
  return pc;
}

// 远端连通性探测失败（ICE disconnected）时保守提示，避免完全静默
function rtcWarnBrokenCall() {
  toast(__('rtc.disconnected'), 'error');
}

// ==================== 私聊 1v1 通话 ====================
function rtcIsUserOnline(userId) {
  return !!(window.onlineUsersList || []).some(u => String(u.userId) === String(userId));
}

async function startPrivateCall(userId, callType) {
  if (!currentUser) { toast(__('please_login'), 'error'); return; }
  if (String(userId) === String(currentUser.id)) { toast(__('chat.cant_self'), 'info'); return; }
  if (rtcPrivate && rtcPrivate.status !== 'idle') { toast(__('rtc.busy'), 'error'); return; }
  if (rtcGroupRoom) { toast(__('rtc.busy'), 'error'); return; }
  if (!rtcIsUserOnline(userId)) { toast(__('rtc.offline'), 'error'); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: RTC_AUDIO, video: callType === 'video' });
  } catch (e) {
    toast(__('rtc.media_error'), 'error');
    return;
  }
  await ensureRtcIce();
  rtcPrivate = {
    status: 'outgoing', peerId: userId, roomId: null, callType: callType === 'video' ? 'video' : 'voice',
    localStream: stream, screenStream: null, pc: null, isCaller: true, timer: 0, screenSharing: false, screenAudioSender: null
  };
  if (!rtcSend({ type: 'rtc:invite', targetId: userId, callType: rtcPrivate.callType })) {
    rtcClearPrivate();
    toast(__('rtc.ws_down'), 'error');
    return;
  }
  renderPrivateCallOverlay();
  startPrivateCallTimer(0);
}

function acceptPrivateCall() {
  const inv = rtcPrivate;
  if (!inv || inv.status !== 'ringing') return;
  (async () => {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: RTC_AUDIO, video: inv.callType === 'video' });
    } catch (e) {
      toast(__('rtc.media_error'), 'error');
      hangupPrivateCall();
      return;
    }
    inv.localStream = stream;
    inv.status = 'active';
    rtcPlayConnected();
    rtcSend({ type: 'rtc:accept', targetId: inv.peerId });
    inv.pc = rtcBuildPeer({
      onIce: (pc, c) => rtcSend({ type: 'rtc:candidate', targetId: inv.peerId, candidate: c }),
      onTrack: (pc, e) => rtcAttachRemoteStream(pc, e),
      onState: () => { if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') hangupPrivateCall(true); },
      onDisconnected: () => rtcWarnBrokenCall()
    });
    inv.localStream.getTracks().forEach(t => inv.pc.addTrack(t, inv.localStream));
    hideRtcIncomingPopup();
    renderPrivateCallOverlay();
    startPrivateCallTimer(0);
  })();
}

function declinePrivateCall() {
  const inv = rtcPrivate;
  if (!inv || inv.status !== 'ringing') return;
  rtcSend({ type: 'rtc:decline', targetId: inv.peerId });
  hideRtcIncomingPopup();
  rtcClearPrivate();
}

function hangupPrivateCall(remote = false) {
  const inv = rtcPrivate;
  if (!inv) return;
  rtcPlayHangup();
  if (inv.status === 'active' || inv.status === 'outgoing' || inv.status === 'ringing') {
    rtcSend({ type: 'rtc:hangup', targetId: inv.peerId });
  }
  if (!remote && inv.status === 'ringing') {
    // 挂断母版的未接来电也通知对方取消
    rtcSend({ type: 'rtc:cancel', targetId: inv.peerId });
  }
  hideRtcIncomingPopup();
  hideRtcCallOverlay();
  rtcClearPrivate();
}

function rtcClearPrivate() {
  rtcStopRing();
  rtcStopVolumesByPrefix('private:');
  rtcRemoteStream = null;
  if (rtcPrivate) {
    rtcStopStream(rtcPrivate.screenStream);
    rtcStopStream(rtcPrivate.localStream);
    rtcClosePeer(rtcPrivate.pc);
  }
  stopPrivateCallTimer();
  hideRtcIncomingPopup();
  hideRtcCallOverlay();
  rtcPrivate = null;
}

// 桌面音频轨输出路由：未挂到任何 audio/video 元素的远程轨永远无声
// （即便 track.enabled=true 也听不到），必须挂到音频元素上"共享声音"开关才有实际作用。
function routeScreenAudioTrack(elId, track) {
  const el = document.getElementById(elId);
  if (!el) return;
  let ms = el.srcObject;
  if (!(ms instanceof MediaStream)) { ms = new MediaStream(); el.srcObject = ms; }
  // 清理已结束的旧轨（停止共享后重新共享会追加新轨，避免流内轨无限堆积）
  ms.getTracks().forEach(t => { if (t.readyState === 'ended') { try { ms.removeTrack(t); } catch (e) {} } });
  if (!ms.getTracks().includes(track)) ms.addTrack(track);
}

function rtcAttachRemoteStream(pc, e) {
  if (!e || !e.track || !e.streams || !e.streams[0]) return;
  const stream = e.streams[0];
  const inv = rtcPrivate;
  // 识别对端屏幕共享的"桌面音频轨"（音频轨 + 流 id 与 offer 声明的屏幕流一致）：
  // 该轨默认静音——若本机扬声器外放后再被麦克风采集会形成回音环路（防回音核心）。
  if (inv && e.track.kind === 'audio' && inv.screenStreamId && stream.id === inv.screenStreamId) {
    inv.screenAudioTracks = inv.screenAudioTracks || [];
    if (!inv.screenAudioTracks.includes(e.track)) inv.screenAudioTracks.push(e.track);
    routeScreenAudioTrack('rtcScreenAudioOut', e.track); // 挂输出 sink，"共享声音"开关才可听
    e.track.enabled = !!inv.screenAudioEnabled;
    updateScreenAudioBtn();
    return; // 桌面音频不参与远程视频显示与音量监测
  }
  rtcRemoteStream = stream;
  const el = document.getElementById('rtcRemoteVideo');
  if (el) {
    el.srcObject = stream;
    el.classList.toggle('rtc-hidden', !rtcPrivate || rtcPrivate.callType !== 'video');
  }
  rtcSetVolumeWatch('private:remote', stream, (lv) => rtcSetLevel('rtcRemoteLevel', lv));
}

// 私聊通话浮层（绝对定位盖在聊天面板上）
function renderPrivateCallOverlay() {
  const panel = document.getElementById('chatDetailView');
  if (!panel) return;
  hideRtcCallOverlay(); // 先移除旧浮层再重建，避免重复元素
  const inv = rtcPrivate;
  if (!inv) return;
  const name = getChatUserName(inv.peerId);
  const isVideo = inv.callType === 'video';
  const stateText = inv.status === 'outgoing' ? __('rtc.calling') : (inv.status === 'active' ? __('rtc.in_call') : __('rtc.waiting_accept'));
  const div = document.createElement('div');
  div.id = 'rtcCallOverlay';
  div.className = 'rtc-call-overlay';
  div.innerHTML = `
    <div class="rtc-call-box">
      <div class="rtc-call-remote ${isVideo ? '' : 'rtc-voice-mode'}">
        <video id="rtcRemoteVideo" autoplay playsinline></video>
        <div class="rtc-call-audio-indicator">🎧 ${esc(__('rtc.voice_call'))}</div>
      </div>
      <div class="rtc-call-info">
        <strong>${esc(name)}</strong>
        <span id="rtcCallState" class="text-muted2 text-13">${esc(stateText)}</span>
        <span id="rtcCallTimer" class="text-muted2 text-13">${rtcFmtTime(0)}</span>
      </div>
      <div class="rtc-call-levels">
        <div class="rtc-level-row" title="${esc(__('rtc.remote_level'))}"><i>⬇</i><span class="rtc-level-track"><span id="rtcRemoteLevel" class="rtc-level-fill"></span></span></div>
        <div class="rtc-level-row" title="${esc(__('rtc.mic_level'))}"><i>⬆</i><span class="rtc-level-track"><span id="rtcLocalLevel" class="rtc-level-fill"></span></span></div>
      </div>
      <div class="rtc-call-local">
        <video id="rtcLocalVideo" autoplay muted playsinline></video>
      </div>
      <div class="rtc-call-actions">
        ${isVideo ? `<button id="rtcCamBtn" class="btn btn-xs btn-outline" onclick="rtcToggleCamera()">🎥 ${esc(__('rtc.toggle_camera'))}</button>` : ''}
        <button id="rtcScreenBtn" class="btn btn-xs btn-outline" onclick="rtcToggleScreenShare()">🖥 ${esc(__('rtc.share_screen'))}</button>
        <button id="rtcScreenAudioBtn" class="btn btn-xs btn-outline rtc-hidden" onclick="rtcToggleScreenAudio()">🔇 ${esc(__('rtc.screen_audio'))}</button>
        <button id="rtcHangupBtn" class="btn btn-xs btn-danger" onclick="hangupPrivateCall()">📵 ${esc(__('rtc.hangup'))}</button>
      </div>
      <audio id="rtcScreenAudioOut" autoplay playsinline class="rtc-hidden"></audio>
    </div>`;
  panel.appendChild(div);
  const localVideo = document.getElementById('rtcLocalVideo');
  if (localVideo && inv.localStream) localVideo.srcObject = inv.localStream;
  if (inv.localStream && !isVideo) {
    // 语音通话只取音频：不展示本地视频画面
    localVideo?.classList.add('rtc-hidden');
  }
  rtcSetVolumeWatch('private:local', inv.localStream, (lv) => rtcSetLevel('rtcLocalLevel', lv));
  if (rtcRemoteStream) rtcSetVolumeWatch('private:remote', rtcRemoteStream, (lv) => rtcSetLevel('rtcRemoteLevel', lv));
  // 浮层重建后 srcObject 随元素销毁丢失，需恢复桌面音频轨到输出元素
  if (inv.screenAudioTracks && inv.screenAudioTracks.length) {
    inv.screenAudioTracks.forEach(t => { try { routeScreenAudioTrack('rtcScreenAudioOut', t); } catch (e) {} });
  }
  updateScreenAudioBtn();
}

function hideRtcCallOverlay() {
  const el = document.getElementById('rtcCallOverlay');
  if (el) el.remove();
}

function updateRtcCallState() {
  const inv = rtcPrivate;
  if (!inv) return;
  const stateEl = document.getElementById('rtcCallState');
  const timerEl = document.getElementById('rtcCallTimer');
  if (stateEl) stateEl.textContent = inv.status === 'active' ? __('rtc.in_call') : (inv.status === 'outgoing' ? __('rtc.calling') : __('rtc.waiting_accept'));
  if (timerEl) timerEl.textContent = rtcFmtTime(inv.timer);
}

function startPrivateCallTimer(sec) {
  stopPrivateCallTimer();
  const inv = rtcPrivate;
  if (!inv) return;
  inv.timer = sec || 0;
  updateRtcCallState();
  inv.timerId = setInterval(() => {
    if (!rtcPrivate) { stopPrivateCallTimer(); return; }
    rtcPrivate.timer++;
    updateRtcCallState();
  }, 1000);
}

function stopPrivateCallTimer() {
  if (rtcPrivate && rtcPrivate.timerId) { clearInterval(rtcPrivate.timerId); rtcPrivate.timerId = null; }
}

// ==================== 来电弹窗 ====================
function renderRtcIncomingPopup(msg) {
  const panel = document.getElementById('chatDetailView');
  if (!panel) return;
  hideRtcIncomingPopup();
  const name = (msg.caller && msg.caller.displayName) || getChatUserName(msg.senderId);
  const avatar = (msg.caller && msg.caller.avatarUrl) ? escAttr(msg.caller.avatarUrl) : '/api/avatar/default';
  const isVideo = msg.callType === 'video';
  const div = document.createElement('div');
  div.id = 'rtcIncomingPopup';
  div.className = 'rtc-incoming-popup';
  div.innerHTML = `
    <img src="${avatar}" class="chat-conv-avatar" onerror="window.__avatarFail&&window.__avatarFail(this,'${escJsStr((msg.caller && msg.caller.avatarUrl) || '/api/avatar/default')}')" />
    <div class="rtc-incoming-info">
      <strong>${esc(name)}</strong>
      <span class="text-muted2 text-13">${isVideo ? '📹 ' : '📞 '}${esc(__('rtc.incoming'))}</span>
    </div>
    <div class="rtc-incoming-actions">
      <button class="btn btn-xs btn-danger" onclick="declinePrivateCall()">✕ ${esc(__('rtc.decline'))}</button>
      <button class="btn btn-xs btn-primary" onclick="acceptPrivateCall()">✓ ${esc(__('rtc.accept'))}</button>
    </div>`;
  panel.appendChild(div);
  rtcPlayRing();
}

function hideRtcIncomingPopup() {
  rtcStopRing();
  const el = document.getElementById('rtcIncomingPopup');
  if (el) el.remove();
}

// ==================== 屏幕共享 ====================
// 请求 video+audio：浏览器选择器勾选「分享音频」后回传系统/标签页音频轨（macOS 需 Chrome 141+，
// Linux/Firefox/Safari 不支持系统音频时 aTrack 为 null，仅画面正常共享）
async function rtcToggleScreenShare() {
  const inv = rtcPrivate;
  if (!inv || inv.status !== 'active' || !inv.pc) return;
  if (inv.screenSharing) { rtcStopScreenShare(); return; }
  let screenStream;
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch (e) { return; } // 用户取消共享
  const vTrack = screenStream.getVideoTracks()[0];
  if (!vTrack) { rtcStopStream(screenStream); return; }
  const aTrack = screenStream.getAudioTracks()[0] || null;
  if (aTrack) toast(__('rtc.screen_audio_tip'), 'info'); // 佩戴耳机可避免共享者本机回音
  vTrack.addEventListener('ended', () => { rtcStopScreenShare(); });
  inv.screenStream = screenStream;
  inv.screenSharing = true;
  const localVideo = document.getElementById('rtcLocalVideo');
  if (localVideo) { localVideo.srcObject = screenStream; localVideo.classList.remove('rtc-hidden'); }
  const pc = inv.pc;
  try {
    const vSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (vSender) {
      await vSender.replaceTrack(vTrack);
    } else {
      pc.addTrack(vTrack, inv.localStream);
    }
    // 屏幕音频轨（与麦克风并存），保存 sender 引用供停止共享时移除
    if (aTrack) inv.screenAudioSender = pc.addTrack(aTrack, screenStream);
    await pc.createOffer();
    await pc.setLocalDescription();
    // screenStreamId 供对端识别"桌面音频轨"：该轨默认静音防回音（对端外放后再被其麦克风采集会成环）
    rtcSend({ type: 'rtc:offer', targetId: inv.peerId, sdp: pc.localDescription, screenShare: !!(aTrack), screenStreamId: aTrack ? screenStream.id : null });
  } catch (e) {}
}

async function rtcStopScreenShare() {
  const inv = rtcPrivate;
  if (!inv) return;
  if (inv.screenStream) {
    inv.screenStream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
    inv.screenStream = null;
  }
  inv.screenSharing = false;
  const localVideo = document.getElementById('rtcLocalVideo');
  if (localVideo && inv.localStream) {
    localVideo.srcObject = inv.localStream;
    if (inv.callType !== 'video') localVideo.classList.add('rtc-hidden');
  }
  const pc = inv.pc;
  if (!pc) return;
  try {
    if (inv.callType === 'video') {
      const vSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      const camTrack = (inv.localStream.getTracks().find(t => t.kind === 'video')) || null;
      if (vSender && camTrack) await vSender.replaceTrack(camTrack);
    } else {
      // 语音通话时共享屏幕是后加的 track，停止后移除并重协商
      const vSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (vSender) pc.removeTrack(vSender);
    }
    // 移除屏幕音频轨并重协商
    if (inv.screenAudioSender) {
      try { pc.removeTrack(inv.screenAudioSender); } catch (e) {}
      inv.screenAudioSender = null;
    }
    await pc.createOffer();
    await pc.setLocalDescription();
    // 停止共享：通知对端清除屏幕音频静音标记
    rtcSend({ type: 'rtc:offer', targetId: inv.peerId, sdp: pc.localDescription, screenShare: false, screenStreamId: null });
  } catch (e) {}
}

// 私聊"共享声音"开关：控制是否外放对端的桌面音频（默认静音防回音）
function rtcToggleScreenAudio() {
  const inv = rtcPrivate;
  if (!inv || !inv.screenStreamId) { toast(__('rtc.share_screen_first'), 'info'); return; }
  inv.screenAudioEnabled = !inv.screenAudioEnabled;
  (inv.screenAudioTracks || []).forEach(t => { try { t.enabled = inv.screenAudioEnabled; } catch (e) {} });
  updateScreenAudioBtn();
}
function updateScreenAudioBtn() {
  const btn = document.getElementById('rtcScreenAudioBtn');
  if (!btn) return;
  const inv = rtcPrivate;
  const active = !!(inv && inv.screenStreamId);
  const on = !!(inv && inv.screenStreamId && inv.screenAudioEnabled);
  btn.classList.toggle('rtc-hidden', !active);
  btn.classList.toggle('btn-danger', on);
  btn.innerHTML = on ? `🔊 ${esc(__('rtc.screen_audio_on'))}` : `🔇 ${esc(__('rtc.screen_audio'))}`;
}

function rtcToggleCamera() {
  const inv = rtcPrivate;
  if (!inv || !inv.localStream || inv.callType !== 'video') return;
  const vTrack = inv.localStream.getTracks().find(t => t.kind === 'video');
  if (vTrack) vTrack.enabled = !vTrack.enabled;
}

// ==================== 群语音房（mesh） ====================
async function toggleGroupVoiceRoom(groupId) {
  if (rtcGroupRoom && rtcGroupRoom.groupId === groupId) {
    leaveGroupVoiceRoom(groupId);
  } else {
    joinGroupVoiceRoom(groupId);
  }
}

async function joinGroupVoiceRoom(groupId) {
  const gid = parseInt(groupId, 10);
  if (!gid) return;
  if (!currentUser) { toast(__('please_login'), 'error'); return; }
  if (rtcGroupRoom && rtcGroupRoom.groupId === gid) return;
  if (rtcGroupRoom) { toast(__('rtc.in_another_room'), 'error'); return; }
  if (rtcPrivate && rtcPrivate.status !== 'idle') { toast(__('rtc.busy'), 'error'); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: RTC_AUDIO, video: false });
  } catch (e) {
    toast(__('rtc.media_error'), 'error');
    return;
  }
  await ensureRtcIce();
  rtcGroupRoom = { groupId: gid, roomKey: null, members: [], peerMap: {}, localStream: stream, screenStream: null, screenSharing: false, screenAudioSenders: {}, timer: 0, timerId: null };
  if (!rtcSend({ type: 'rtc:group:join', groupId: gid })) {
    leaveGroupVoiceRoom(gid);
    toast(__('rtc.ws_down'), 'error');
    return;
  }
  renderGroupVoiceBar();
}

function leaveGroupVoiceRoom(groupId) {
  const room = rtcGroupRoom;
  if (!room) return;
  if (!groupId || room.groupId === groupId) {
    rtcSend({ type: 'rtc:group:leave', groupId: room.groupId });
    rtcClearGroupRoom();
  }
}

function rtcClearGroupRoom() {
  const room = rtcGroupRoom;
  if (!room) return;
  stopGroupVoiceTimer();
  rtcStopVolumesByPrefix('group:');
  rtcStopStream(room.screenStream);
  rtcStopStream(room.localStream);
  Object.keys(room.peerMap || {}).forEach((uid) => rtcClosePeer(room.peerMap[uid]));
  room.peerMap = {};
  rtcGroupRoom = null;
  hideGroupVoiceBar();
  updateGroupVoiceBtn();
}

// mesh 确定性 offerer：userId 较小的一方发 offer，避免双方同时发 offer 造成 glare
function rtcGroupCreatePeer(remoteUserId) {
  const room = rtcGroupRoom;
  if (!room) return null;
  const uid = parseInt(remoteUserId, 10);
  if (room.peerMap[uid]) return room.peerMap[uid];
  const pc = rtcBuildPeer({
    onIce: (pc, c) => rtcSend({ type: 'rtc:group:candidate', groupId: room.groupId, targetId: uid, candidate: c }),
    onTrack: (pc, e) => rtcGroupAttachRemoteStream(uid, pc, e),
    onState: () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        rtcClosePeer(pc);
        if (room.peerMap[uid] === pc) delete room.peerMap[uid];
        renderGroupMemberList();
      }
    },
    onDisconnected: () => rtcWarnBrokenCall()
  });
  room.peerMap[uid] = pc;
  room.localStream.getTracks().forEach(t => pc.addTrack(t, room.localStream));
  // 本端为较小 userId → 作为 offerer 主动发起，否则等对方 offer
  if (Number(currentUser.id) < uid) {
    pc.createOffer().then(() => pc.setLocalDescription()).then(() => {
      rtcSend({ type: 'rtc:group:offer', groupId: room.groupId, targetId: uid, sdp: pc.localDescription });
    }).catch((e) => {});
  }
  return pc;
}

// 群语音房：每位共享者对端一个独立桌面音频输出元素（随成员离开清理），
// 未挂 sink 的远程轨即便 enabled=true 也无声，必须有输出路由"共享声音"开关才可听。
function routeGroupScreenAudioTrack(uid, track) {
  const bar = document.getElementById('groupVoiceBar');
  if (!bar) return;
  let el = document.getElementById('rtcGroupScreenAudioOut_' + uid);
  if (!el) {
    el = document.createElement('audio');
    el.id = 'rtcGroupScreenAudioOut_' + uid;
    el.autoplay = true;
    el.setAttribute('playsinline', '');
    bar.appendChild(el);
  }
  let ms = el.srcObject;
  if (!(ms instanceof MediaStream)) { ms = new MediaStream(); el.srcObject = ms; }
  ms.getTracks().forEach(t => { if (t.readyState === 'ended') { try { ms.removeTrack(t); } catch (e) {} } });
  if (!ms.getTracks().includes(track)) ms.addTrack(track);
}

function rtcGroupAttachRemoteStream(uid, pc, e) {
  if (!e || !e.track || !e.streams || !e.streams[0]) return;
  const stream = e.streams[0];
  const room = rtcGroupRoom;
  // 识别对端屏幕共享的"桌面音频轨"：默认静音防回音（详见 rtcAttachRemoteStream 注释）
  if (room && e.track.kind === 'audio' && room.screenStreamIds && room.screenStreamIds[uid] && stream.id === room.screenStreamIds[uid]) {
    room.screenAudioTracksByUid = room.screenAudioTracksByUid || {};
    room.screenAudioTracksByUid[uid] = room.screenAudioTracksByUid[uid] || [];
    if (!room.screenAudioTracksByUid[uid].includes(e.track)) room.screenAudioTracksByUid[uid].push(e.track);
    routeGroupScreenAudioTrack(uid, e.track); // 挂输出 sink，"共享声音"开关才可听
    e.track.enabled = !!room.screenAudioEnabled;
    updateGroupScreenAudioBtn();
    return; // 桌面音频不参与成员 tile 画面与音量监测
  }
  const tile = document.getElementById('rtcGroupTile_' + uid);
  const video = tile && tile.querySelector('video');
  if (video) {
    video.srcObject = stream;
    video.classList.remove('rtc-hidden');
  }
  const barTile = document.getElementById('rtcGroupBarTile_' + uid);
  const barVideo = barTile && barTile.querySelector('video');
  if (barVideo) {
    barVideo.srcObject = stream;
    barVideo.classList.remove('rtc-hidden');
  }
  rtcSetVolumeWatch('group:' + uid, stream, (lv) => {
    rtcSetLevel('rtcTileLevel_' + uid, lv);
    const t = document.getElementById('rtcGroupBarTile_' + uid);
    if (t) t.classList.toggle('rtc-speaking', lv > 0.12);
  });
}

// 群语音房状态栏（显示成员 + 离开/共享按钮）
function renderGroupVoiceBar() {
  const view = document.getElementById('chatDetailView');
  if (!view) return;
  hideGroupVoiceBar();
  const room = rtcGroupRoom;
  if (!room) return;
  const div = document.createElement('div');
  div.id = 'groupVoiceBar';
  div.className = 'rtc-group-bar';
  div.innerHTML = `
    <div class="rtc-group-joined-label">🎤 ${esc(__('rtc.voice_room'))} <span id="rtcGroupCount">${room.members.length}</span> <span id="rtcGroupTimer" class="rtc-group-timer">${rtcFmtTime(room.timer || 0)}</span></div>
    <div id="rtcGroupMembers" class="rtc-group-members"></div>
    <div class="rtc-group-actions">
      <span class="rtc-level-row rtc-group-mic" title="${esc(__('rtc.mic_level'))}"><i>⬆</i><span class="rtc-level-track"><span id="rtcGroupMicLevel" class="rtc-level-fill"></span></span></span>
      <button id="rtcGroupScreenBtn" class="btn btn-xs btn-outline" onclick="rtcToggleGroupScreenShare()">🖥 ${esc(__('rtc.share_screen'))}</button>
      <button id="rtcGroupScreenAudioBtn" class="btn btn-xs btn-outline rtc-hidden" onclick="rtcToggleGroupScreenAudio()">🔇 ${esc(__('rtc.screen_audio'))}</button>
      <button class="btn btn-xs btn-danger" onclick="leaveGroupVoiceRoom(${room.groupId})">📵 ${esc(__('rtc.leave_room'))}</button>
    </div>`;
  const header = document.getElementById('chatDetailHeader');
  if (header && header.nextElementSibling) header.nextElementSibling.insertAdjacentElement('beforebegin', div);
  else view.insertBefore(div, view.firstChild.nextSibling);
  // 加入中（尚无成员列表）时先渲染占位
  renderGroupMemberList();
  updateGroupVoiceBtn();
  startGroupVoiceTimer();
  rtcSetVolumeWatch('group:local', room.localStream, (lv) => rtcSetLevel('rtcGroupMicLevel', lv));
  updateGroupScreenAudioBtn();
}

// 群语音房通话计时（加入即开始，离开停止）
function startGroupVoiceTimer() {
  const room = rtcGroupRoom;
  if (!room || room.timerId) return;
  room.timer = room.timer || 0;
  const el = document.getElementById('rtcGroupTimer');
  if (el) el.textContent = rtcFmtTime(room.timer);
  room.timerId = setInterval(() => {
    if (!rtcGroupRoom) { stopGroupVoiceTimer(); return; }
    rtcGroupRoom.timer++;
    const tEl = document.getElementById('rtcGroupTimer');
    if (tEl) tEl.textContent = rtcFmtTime(rtcGroupRoom.timer);
  }, 1000);
}

function stopGroupVoiceTimer() {
  if (rtcGroupRoom && rtcGroupRoom.timerId) { clearInterval(rtcGroupRoom.timerId); rtcGroupRoom.timerId = null; }
}

function hideGroupVoiceBar() {
  const el = document.getElementById('groupVoiceBar');
  if (el) el.remove();
}

function renderGroupMemberList() {
  const room = rtcGroupRoom;
  if (!room) return;
  const wrap = document.getElementById('rtcGroupMembers');
  if (!wrap) return;
  const countEl = document.getElementById('rtcGroupCount');
  if (countEl) countEl.textContent = room.members.length;
  if (room.members.length === 0) {
    wrap.innerHTML = `<span class="text-muted2 text-12">${esc(__('rtc.room_empty'))}</span>`;
    return;
  }
  wrap.innerHTML = room.members.map((m) => {
    const uid = m.userId;
    const nm = m.displayName || getChatUserName(uid);
    const av = m.avatarUrl ? escAttr(m.avatarUrl) : '/api/avatar/default';
    return `<span id="rtcGroupBarTile_${uid}" class="rtc-group-tile" title="${esc(nm)}">
      <img src="${av}" class="rtc-group-avatar" onerror="window.__avatarFail&&window.__avatarFail(this,'${escJsStr(m.avatarUrl || '/api/avatar/default')}')" />
      <video class="rtc-hidden" autoplay playsinline></video>
      <span class="rtc-tile-level"><span id="rtcTileLevel_${uid}" class="rtc-tile-level-fill"></span></span>
      <em>${esc(nm)}</em>
    </span>`;
  }).join('');
}

function updateGroupVoiceBtn() {
  const gid = rtcGroupRoom ? rtcGroupRoom.groupId : null;
  document.querySelectorAll('[id^="groupVoiceBtn_"]').forEach((btn) => {
    const btnGid = parseInt(btn.id.split('_')[1], 10);
    const active = gid === btnGid;
    btn.classList.toggle('btn-danger', active);
    btn.classList.toggle('btn-outline', !active);
    btn.innerHTML = active ? `🎤 ${esc(__('rtc.leave_room'))}` : `🎤 ${esc(__('rtc.voice_room'))}`;
  });
}

async function rtcToggleGroupScreenShare() {
  const room = rtcGroupRoom;
  if (!room) return;
  if (room.screenSharing) { rtcStopGroupScreenShare(); return; }
  let screenStream;
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch (e) { return; }
  const vTrack = screenStream.getVideoTracks()[0];
  if (!vTrack) { rtcStopStream(screenStream); return; }
  const aTrack = screenStream.getAudioTracks()[0] || null;
  if (aTrack) toast(__('rtc.screen_audio_tip'), 'info'); // 佩戴耳机可避免共享者本机回音
  vTrack.addEventListener('ended', () => { rtcStopGroupScreenShare(); });
  room.screenStream = screenStream;
  room.screenSharing = true;
  room.screenAudioSenders = room.screenAudioSenders || {}; // uid -> audio sender
  const ids = Object.keys(room.peerMap);
  for (const uid of ids) {
    const pc = room.peerMap[uid];
    if (!pc) continue;
    try {
      const vSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (vSender) {
        await vSender.replaceTrack(vTrack);
      } else {
        pc.addTrack(vTrack, room.localStream);
      }
      // 屏幕音频轨（与麦克风并存），保存 sender 引用供停止共享时移除
      if (aTrack && !room.screenAudioSenders[uid]) {
        room.screenAudioSenders[uid] = pc.addTrack(aTrack, screenStream);
      }
      // 每次都对每个对端重协商：新增音轨必须协商，replaceTrack 场景多发一次 offer 无副作用
      await pc.createOffer();
      await pc.setLocalDescription();
      // screenStreamId 供对端识别"桌面音频轨"：该轨默认静音防回音（见 rtcToggleScreenShare 注释）
      rtcSend({ type: 'rtc:group:offer', groupId: room.groupId, targetId: uid, sdp: pc.localDescription, screenShare: !!(aTrack), screenStreamId: aTrack ? screenStream.id : null });
    } catch (e) {}
  }
}

async function rtcStopGroupScreenShare() {
  const room = rtcGroupRoom;
  if (!room) return;
  if (room.screenStream) {
    room.screenStream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
    room.screenStream = null;
  }
  room.screenSharing = false;
  const ids = Object.keys(room.peerMap);
  for (const uid of ids) {
    const pc = room.peerMap[uid];
    if (!pc) continue;
    try {
      const vSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (vSender) pc.removeTrack(vSender);
      // 移除屏幕音频轨并重协商
      if (room.screenAudioSenders && room.screenAudioSenders[uid]) {
        try { pc.removeTrack(room.screenAudioSenders[uid]); } catch (e) {}
        delete room.screenAudioSenders[uid];
      }
      await pc.createOffer();
      await pc.setLocalDescription();
      // 停止共享：通知对端清除屏幕音频静音标记
      rtcSend({ type: 'rtc:group:offer', groupId: room.groupId, targetId: uid, sdp: pc.localDescription, screenShare: false, screenStreamId: null });
    } catch (e) {}
  }
}

// 群语音房"共享声音"开关：控制是否外放各对端的桌面音频（默认静音防回音）
function rtcToggleGroupScreenAudio() {
  const room = rtcGroupRoom;
  if (!room) return;
  const anyScreen = Object.keys(room.screenStreamIds || {}).some(k => room.screenStreamIds[k]);
  if (!anyScreen) { toast(__('rtc.share_screen_first'), 'info'); return; }
  room.screenAudioEnabled = !room.screenAudioEnabled;
  Object.keys(room.screenAudioTracksByUid || {}).forEach(uid => {
    (room.screenAudioTracksByUid[uid] || []).forEach(t => { try { t.enabled = room.screenAudioEnabled; } catch (e) {} });
  });
  updateGroupScreenAudioBtn();
}
function updateGroupScreenAudioBtn() {
  const btn = document.getElementById('rtcGroupScreenAudioBtn');
  if (!btn) return;
  const room = rtcGroupRoom;
  const active = !!room && Object.keys(room.screenStreamIds || {}).some(k => room.screenStreamIds[k]);
  const on = !!(room && room.screenAudioEnabled && active);
  btn.classList.toggle('rtc-hidden', !active);
  btn.classList.toggle('btn-danger', on);
  btn.innerHTML = on ? `🔊 ${esc(__('rtc.screen_audio_on'))}` : `🔇 ${esc(__('rtc.screen_audio'))}`;
}

// ==================== 按住说话（PTT 语音消息） ====================
// 私聊：POST /api/chat/send（receiverId）；群聊：POST /api/chat/groups/{gid}/messages（msgType=audio）
async function startPttRecording() {
  if (!currentUser) { toast(__('please_login'), 'error'); return; }
  if (rtcPttRecorder) return;
  if (!chatActiveUserId && !chatActiveGroupId) return;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: RTC_AUDIO, video: false });
  } catch (e) {
    toast(__('rtc.media_error'), 'error');
    return;
  }
  let mime = 'audio/webm;codecs=opus';
  if (typeof MediaRecorder !== 'function' || !MediaRecorder.isTypeSupported(mime)) {
    rtcStopStream(stream);
    toast(__('chat.audio_type_error'), 'error');
    return;
  }
  rtcPttChunks = [];
  const rec = new MediaRecorder(stream, { mimeType: mime });
  rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) rtcPttChunks.push(e.data); };
  rec.onstop = () => {
    rtcStopStream(stream);
    const blob = new Blob(rtcPttChunks, { type: mime });
    rtcPttChunks = [];
    if (blob.size < 2 * 1024) {
      toast(__('rtc.ptt_too_short'), 'info');
      return;
    }
    uploadPttBlob(blob);
  };
  rec.onerror = () => { rtcStopStream(stream); rtcPttChunks = []; toast(__('rtc.media_error'), 'error'); };
  rec.start(250);
  rtcPttRecorder = rec;
  rtcPttStartedAt = Date.now();
  rtcPlayPttStart();
  renderPttIndicator();
  rtcSetVolumeWatch('ptt', stream, (lv) => rtcSetLevel('rtcPttLevel', lv));
}

function stopPttRecording() {
  if (!rtcPttRecorder) return;
  rtcPlayPttStop();
  rtcStopVolumeWatch('ptt');
  hidePttIndicator();
  try { rtcPttRecorder.stop(); } catch (e) {}
  rtcPttRecorder = null;
}

function renderPttIndicator() {
  const panel = document.getElementById('chatPanel') || document.body;
  hidePttIndicator();
  const div = document.createElement('div');
  div.id = 'rtcPttIndicator';
  div.className = 'rtc-ptt-indicator';
  div.innerHTML = `◉ ${esc(__('rtc.recording'))} <span id="rtcPttTimerText">00:00</span> <span class="rtc-ptt-level"><span id="rtcPttLevel" class="rtc-ptt-level-fill"></span></span>`;
  panel.appendChild(div);
  rtcPttTimer = setInterval(() => {
    const el = document.getElementById('rtcPttTimerText');
    if (el) el.textContent = rtcFmtTime(Math.floor((Date.now() - rtcPttStartedAt) / 1000));
  }, 1000);
}

function hidePttIndicator() {
  const el = document.getElementById('rtcPttIndicator');
  if (el) el.remove();
  if (rtcPttTimer) { clearInterval(rtcPttTimer); rtcPttTimer = 0; }
}

async function uploadPttBlob(blob) {
  const gid = chatActiveGroupId;
  const uid = chatActiveUserId;
  if (!gid && !uid) return;
  const fd = new FormData();
  fd.append('file', blob, 'voice-' + Date.now() + '.webm');
  let url;
  if (gid) { url = `/api/chat/groups/${gid}/messages`; fd.append('msgType', 'audio'); }
  else { url = '/api/chat/send'; fd.append('receiverId', uid); }
  try {
    const res = await apiForm(url, fd);
    if (!res.ok) {
      const d = await res.json().catch(() => null);
      toast(errText(d) || __('chat.send_failed'), 'error');
      return;
    }
    const d = await res.json().catch(() => null);
    if (!d || !d.message) return;
    if (gid) appendGroupMessage(d.message);
    else appendReceivedMessage(d.message, true);
  } catch (e) {
    if (!isApiHandledError(e)) toast(__('chat.send_failed'), 'error');
  }
}

function initRtcPttButton() {
  const area = document.getElementById('chatInputArea');
  if (!area || document.getElementById('rtcPttBtn')) return;
  const btn = document.createElement('button');
  btn.id = 'rtcPttBtn';
  btn.type = 'button';
  btn.className = 'btn btn-sm rtc-ptt-btn';
  btn.textContent = '🎙 ' + __('rtc.ptt_hold');
  btn.setAttribute('aria-pressed', 'false');
  const setPressed = (on) => btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.addEventListener('pointerdown', (e) => { e.preventDefault(); setPressed(true); startPttRecording(); });
  btn.addEventListener('pointerup', () => { setPressed(false); stopPttRecording(); });
  btn.addEventListener('pointercancel', () => { setPressed(false); stopPttRecording(); });
  btn.addEventListener('pointerleave', () => { setPressed(false); stopPttRecording(); });
  btn.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (e.repeat) return;
      setPressed(true);
      startPttRecording();
    }
  });
  btn.addEventListener('keyup', (e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      setPressed(false);
      stopPttRecording();
    }
  });
  btn.addEventListener('blur', () => { setPressed(false); stopPttRecording(); });
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  const sendBtn = document.getElementById('chatSendBtn');
  if (sendBtn && sendBtn.parentNode) sendBtn.parentNode.insertBefore(btn, sendBtn);
  else area.appendChild(btn);
}

// ==================== RTC 信令分发 ====================
function handleRtcMessage(msg) {
  const type = msg.type || '';
  // ----- 私聊 1v1 -----
  if (type === 'rtc:invite') {
    if (!msg.senderId) return;
    // 忙线：自己在通话中或已在语音房 → 自动拒绝
    if ((rtcPrivate && rtcPrivate.status !== 'idle') || rtcGroupRoom) {
      rtcSend({ type: 'rtc:decline', targetId: msg.senderId });
      toast(__('rtc.busy'), 'info');
      return;
    }
    rtcPrivate = {
      status: 'ringing', peerId: msg.senderId, roomId: msg.roomId || null,
      callType: msg.callType === 'video' ? 'video' : 'voice',
      localStream: null, screenStream: null, pc: null, isCaller: false, timer: 0, screenSharing: false, screenAudioSender: null
    };
    renderRtcIncomingPopup(msg);
    return;
  }
  if (type === 'rtc:invite:failed') {
    toast(errText(msg) || __('rtc.offline'), 'error');
    rtcClearPrivate();
    return;
  }
  if (type === 'rtc:accepted') {
    const inv = rtcPrivate;
    if (!inv || inv.status !== 'outgoing') return;
    inv.status = 'active';
    rtcPlayConnected();
    updateRtcCallState();
    renderPrivateCallOverlay();
    // 呼叫方创建 peer 并发出 offer
    inv.pc = rtcBuildPeer({
      onIce: (pc, c) => rtcSend({ type: 'rtc:candidate', targetId: inv.peerId, candidate: c }),
      onTrack: (pc, e) => rtcAttachRemoteStream(pc, e),
      onState: () => { if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') hangupPrivateCall(true); },
      onDisconnected: () => rtcWarnBrokenCall()
    });
    inv.localStream.getTracks().forEach(t => inv.pc.addTrack(t, inv.localStream));
    inv.pc.createOffer().then(() => inv.pc.setLocalDescription()).then(() => {
      rtcSend({ type: 'rtc:offer', targetId: inv.peerId, sdp: inv.pc.localDescription });
    }).catch((e) => {});
    startPrivateCallTimer(0);
    return;
  }
  if (type === 'rtc:declined') {
    toast(__('rtc.declined'), 'info');
    rtcClearPrivate();
    return;
  }
  if (type === 'rtc:canceled') {
    hideRtcIncomingPopup();
    if (rtcPrivate && rtcPrivate.status === 'ringing') {
      toast(__('rtc.canceled'), 'info');
    }
    rtcClearPrivate();
    return;
  }
  if (type === 'rtc:offer') {
    const inv = rtcPrivate;
    if (!inv || inv.status !== 'active' || !inv.pc) return;
    if (!msg.sdp) return;
    // 记录对端屏幕共享状态：供 onTrack 识别桌面音频轨并默认静音（防回音）
    inv.screenShareActive = !!msg.screenShare;
    inv.screenStreamId = msg.screenStreamId || null;
    if (!inv.screenShareActive) {
      inv.screenAudioEnabled = false;
      inv.screenAudioTracks = [];
      updateScreenAudioBtn(); // 对端已停止共享：立即复位/隐藏"共享声音"按钮
    }
    const asyncWork = async () => {
      await inv.pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
      const answer = await inv.pc.createAnswer();
      await inv.pc.setLocalDescription(answer);
      rtcSend({ type: 'rtc:answer', targetId: inv.peerId, sdp: inv.pc.localDescription });
    };
    asyncWork.catch(() => {});
    return;
  }
  if (type === 'rtc:answer') {
    const inv = rtcPrivate;
    if (!inv || !inv.pc || !msg.sdp) return;
    inv.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }).catch(() => {});
    return;
  }
  if (type === 'rtc:candidate') {
    const inv = rtcPrivate;
    if (!inv || !inv.pc || !msg.candidate) return;
    inv.pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {});
    return;
  }
  if (type === 'rtc:hangup') {
    if (rtcPrivate && rtcPrivate.peerId === msg.senderId) {
      toast(__('rtc.remote_hangup'), 'info');
    }
    rtcPlayHangup();
    rtcClearPrivate();
    return;
  }
  if (type === 'rtc:error') {
    toast(errText(msg) || __('rtc.error'), 'error');
    if (rtcPrivate) {
      rtcPlayHangup();
      rtcClearPrivate();
    }
    return;
  }

  // ----- 群语音房 -----
  if (type === 'rtc:group:joined') {
    const room = rtcGroupRoom;
    if (!room || room.groupId !== msg.groupId) return;
    room.roomKey = msg.roomKey || room.roomKey;
    room.members = (msg.members || []).filter(m => m && m.userId !== currentUser.id);
    renderGroupMemberList();
    // 向现有成员逐个建连（mesh 确定性 offerer 策略在 rtcGroupCreatePeer 内实现）
    room.members.forEach(m => rtcGroupCreatePeer(m.userId));
    return;
  }
  if (type === 'rtc:group:member:join') {
    const room = rtcGroupRoom;
    if (!room || room.groupId !== msg.groupId) return;
    const mem = msg.member;
    if (!mem) return;
    if (!room.members.some(m => m.userId === mem.userId)) {
      room.members.push(mem);
    }
    renderGroupMemberList();
    rtcGroupCreatePeer(mem.userId);
    appendGroupSystemLine('🎤 ' + (mem.displayName || '') + __('rtc.sys_join'));
    return;
  }
  if (type === 'rtc:group:member:leave') {
    const room = rtcGroupRoom;
    if (!room || room.groupId !== msg.groupId) return;
    const uid = msg.userId;
    room.members = room.members.filter(m => m.userId !== uid);
    rtcStopVolumeWatch('group:' + uid);
    rtcClosePeer(room.peerMap[uid]);
    delete room.peerMap[uid];
    // 清理该成员的屏幕共享状态与桌面音频输出，避免成员离开后按钮残留"共享中"
    if (room.screenStreamIds) delete room.screenStreamIds[uid];
    if (room.screenShareBy) delete room.screenShareBy[uid];
    if (room.screenAudioTracksByUid) delete room.screenAudioTracksByUid[uid];
    const screenAudioEl = document.getElementById('rtcGroupScreenAudioOut_' + uid);
    if (screenAudioEl) {
      try { if (screenAudioEl.srcObject) screenAudioEl.srcObject.getTracks().forEach(t => t.stop()); } catch (e) {}
      screenAudioEl.remove();
    }
    updateGroupScreenAudioBtn();
    renderGroupMemberList();
    appendGroupSystemLine(__('rtc.sys_leave'));
    return;
  }
  if (type === 'rtc:group:left') {
    if (rtcGroupRoom && (!msg.groupId || rtcGroupRoom.groupId === msg.groupId)) {
      rtcClearGroupRoom();
    }
    return;
  }
  if (type === 'rtc:group:error') {
    toast(errText(msg) || __('rtc.error'), 'error');
    if (rtcGroupRoom && (!msg.groupId || rtcGroupRoom.groupId === msg.groupId)) rtcClearGroupRoom();
    return;
  }
  if (type === 'rtc:group:offer') {
    const room = rtcGroupRoom;
    if (!room || room.groupId !== msg.groupId || !msg.sdp || msg.senderId === currentUser.id) return;
    const uid = msg.senderId;
    // 记录该对端是否在屏幕共享：供 onTrack 识别桌面音频轨并默认静音（防回音）
    room.screenShareBy = room.screenShareBy || {};
    room.screenStreamIds = room.screenStreamIds || {};
    room.screenShareBy[uid] = !!msg.screenShare;
    room.screenStreamIds[uid] = msg.screenStreamId || null;
    if (!room.screenShareBy[uid]) {
      // 对端停止共享：复位其桌面音频轨静音
      if (room.screenAudioTracksByUid && room.screenAudioTracksByUid[uid]) {
        room.screenAudioTracksByUid[uid].forEach(t => { try { t.enabled = false; } catch (e) {} });
      }
      if (room.screenAudioTracksByUid) delete room.screenAudioTracksByUid[uid];
      updateGroupScreenAudioBtn();
    }
    rtcGroupCreatePeer(uid);
    const pc = room.peerMap[uid];
    if (!pc) return;
    const asyncWork = async () => {
      await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      rtcSend({ type: 'rtc:group:answer', groupId: room.groupId, targetId: uid, sdp: pc.localDescription });
    };
    asyncWork.catch(() => {});
    return;
  }
  if (type === 'rtc:group:answer') {
    const room = rtcGroupRoom;
    if (!room || room.groupId !== msg.groupId || !msg.sdp || msg.senderId === currentUser.id) return;
    const pc = room.peerMap[msg.senderId];
    if (!pc) return;
    pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }).catch(() => {});
    return;
  }
  if (type === 'rtc:group:candidate') {
    const room = rtcGroupRoom;
    if (!room || room.groupId !== msg.groupId || !msg.candidate || msg.senderId === currentUser.id) return;
    const pc = room.peerMap[msg.senderId];
    if (!pc) return;
    pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {});
    return;
  }
}

// 私聊/群聊通用：从会话数据或已知用户缓存取显示名
function getChatUserName(userId) {
  const uid = String(userId);
  const conv = chatConversations[uid];
  if (conv && conv.displayName) return conv.displayName;
  return __('unknown_user');
}

// ==================== 键盘快捷键 ====================
document.addEventListener('DOMContentLoaded', () => {
  // 用户任意交互即解锁 AudioContext，保证来电铃声/提示音可播
  ['pointerdown', 'keydown', 'touchstart'].forEach((evt) => {
    document.addEventListener(evt, () => rtcEnsureAudio(), { passive: true });
  });
  initRtcPttButton();
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
    try {
      if (rtcPrivate && rtcPrivate.status !== 'idle' && rtcPrivate.peerId) {
        wsClient.send(JSON.stringify({ type: 'rtc:hangup', targetId: rtcPrivate.peerId, userId: currentUser.id }));
        if (rtcPrivate.status === 'ringing') {
          wsClient.send(JSON.stringify({ type: 'rtc:cancel', targetId: rtcPrivate.peerId, userId: currentUser.id }));
        }
      }
      if (rtcGroupRoom && rtcGroupRoom.groupId) {
        wsClient.send(JSON.stringify({ type: 'rtc:group:leave', groupId: rtcGroupRoom.groupId, userId: currentUser.id }));
      }
    } catch (e) {}
    if (glGroups.size === 0 || !wsClient || wsClient.readyState !== WebSocket.OPEN) return;
    const payload = JSON.stringify({ type: 'group:location:stop' });
    try {
      glGroups.forEach((gid) => {
        wsClient.send(JSON.stringify({ type: 'group:location:stop', groupId: gid, userId: currentUser.id }));
      });
    } catch (e) {}
  });
});
