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

// P-8: 最近渲染消息 id 去重缓存（LRU，上限 300 条）。
// 场景：WS 抖动导致 chat:new/group:new 偶发重推，或分页加载与实时推送在临界时刻
// 同一条消息被渲染两次（历史上出现过相同内容重复出现两行的偶发问题）。
// 实时路径 appendReceivedMessage/appendGroupMessage 渲染前检查，历史翻页 prepend*
// 在渲染时跳过缓存中已有的 id（与实时撞车时不双份）。整体重建（renderMessages）
// 也会记录渲染过的 id，保证之后 WS 重推同一条时被幂等跳过。
const _recentRenderedMsgIds = new Map();
const _RECENT_MSG_MAX = 300;
function markMsgRendered(msgId) {
  if (msgId == null) return;
  if (_recentRenderedMsgIds.has(msgId)) return true; // 已在缓存 → 重复
  _recentRenderedMsgIds.set(msgId, Date.now());
  if (_recentRenderedMsgIds.size > _RECENT_MSG_MAX) {
    const oldestKey = _recentRenderedMsgIds.keys().next().value;
    _recentRenderedMsgIds.delete(oldestKey);
  }
  return false;
}

// ==================== Tab 主入口 ====================
let _chatListRefreshTimer = null;
// P-3: 会话列表被动刷新防抖——群聊/私信消息频发时（chat:new/group:new 每当不在当前会话
// 就触发 loadChatConversations 全量三接口拉取），防抖 2.5s 合并为一次，避免请求风暴。
function scheduleChatListRefresh() {
  clearTimeout(_chatListRefreshTimer);
  _chatListRefreshTimer = setTimeout(() => {
    _chatListRefreshTimer = null;
    loadChatConversations();
  }, 2500);
}

// QQ 风格左右分栏：宽屏时会话列表与聊天详情同屏显示，窄屏仍保持整页切换。
// 用 #chatPanel 上的 chat-detail-open 类表达「当前是否有打开的会话」，CSS 据此控制布局。
function setChatDetailOpen(open) {
  const panel = document.getElementById('chatPanel');
  if (panel) panel.classList.toggle('chat-detail-open', !!open);
}

// ==================== 消息 / 好友 左侧栏子切换（好友与聊天合并） ====================
// 聊天左侧栏顶部有「消息 / 好友」两个子视图：消息=会话列表+群聊；好友=好友列表，点好友直接开聊。
let chatLeftView = 'msg'; // msg | friends

function applyChatLeftView() {
  const friends = chatLeftView === 'friends';
  const list = document.getElementById('chatConversationList');
  const pane = document.getElementById('chatFriendsPane');
  if (list) list.classList.toggle('d-none', friends);
  if (pane) pane.classList.toggle('d-none', !friends);
  document.querySelectorAll('#chatConversationView .chat-subnav-btn').forEach(b => {
    const on = b.getAttribute('data-action') === (friends ? 'chat-sub-friends' : 'chat-sub-msg');
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-selected', 'true'); else b.removeAttribute('aria-selected');
  });
}

function setChatLeftView(view) {
  chatLeftView = view === 'friends' ? 'friends' : 'msg';
  applyChatLeftView();
  if (chatLeftView === 'friends') loadChatFriends();
}

async function loadChatFriends() {
  const pane = document.getElementById('chatFriendsPane');
  if (!pane || !currentUser) return;
  pane.innerHTML = '<div class="chat-loading">' + __('common.loading') + '</div>';
  try {
    const res = await api('/api/friends?status=accepted', { method: 'GET' });
    if (!res.ok) { pane.innerHTML = `<div class="chat-empty">${esc(__('chat.load_failed'))}</div>`; return; }
    const d = await res.json().catch(() => ({}));
    const list = d.list || [];
    if (!list.length) {
      renderEmpty(pane, { icon: '🤝', text: __('chat.friends_empty'), cls: 'chat-empty' });
      return;
    }
    pane.innerHTML = `<div class="chat-section-title">${__('chat.tab_friends')}</div>` + list.map(f => {
      const avatarSrc = f.avatarUrl ? escAttr(f.avatarUrl) : '/api/avatar/default';
      return `<div class="chat-conv-item" data-action="chat-open-dm" data-uid="${f.id}" tabindex="0" role="button" aria-label="${escAttr(f.displayName || '')}">
        <img src="${avatarSrc}" class="chat-conv-avatar" loading="lazy" data-avatar-fail-src="${escAttr(f.avatarUrl || '/api/avatar/default')}" />
        <div class="chat-conv-info">
          <div class="chat-conv-name">${esc(f.displayName || __('common.user'))}</div>
          <div class="chat-conv-msg">${f.vrchatName ? esc(f.vrchatName) : ''}</div>
        </div>
        <span class="chat-conv-time">💬</span>
      </div>`;
    }).join('');
  } catch (e) {
    if (isApiHandledError(e)) return;
    pane.innerHTML = `<div class="chat-empty">${esc(__('chat.load_failed'))}</div>`;
  }
}

async function loadChatConversations(resetView = false) {
  if (!currentUser || chatLoading) return;
  chatLoading = true;
  if (resetView) {
    chatActiveUserId = null;
    chatActiveGroupId = null;
    document.getElementById('chatConversationView')?.classList.remove('d-none');
    document.getElementById('chatDetailView')?.classList.add('d-none');
    document.getElementById('chatInputArea')?.classList.add('d-none');
    setChatDetailOpen(false);
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
      return `<div class="chat-conv-item ${activeClass}" data-action="chat-open-group" data-gid="${g.id}" tabindex="0" role="button" aria-label="${escAttr(g.name || '')}">
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
      return `<div class="chat-conv-item ${activeClass}" data-action="chat-open-dm" data-uid="${c.userId}" tabindex="0" role="button" aria-label="${escAttr(c.displayName || '')}">
        <img src="${avatarSrc}" class="chat-conv-avatar" loading="lazy" data-avatar-fail-src="${escAttr(c.avatarUrl || '/api/avatar/default')}" />
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
        <input type="text" id="chatSearchInput" placeholder="${__('chat.search_placeholder')}">
        <button class="btn btn-xs" data-action="chat-search-go">🔍</button>
        <button class="btn btn-xs" data-action="chat-search-clear">✕</button>
      </div>
      <button class="btn btn-sm" data-action="chat-create-group">${__('chat.create_group')}</button>
      <button class="btn btn-sm btn-outline" data-action="chat-join-code">${__('chat.join_by_code')}</button>
    </div>
    <div id="chatSearchResults"></div>
    <div id="chatConversationListContent">` + contentHtml + `</div>`;
  if (!groupHtml && !dmHtml) {
    renderEmpty(document.getElementById('chatConversationListContent'), { icon: '💬', text: __('chat.no_history') });
  }
  // 刷新后恢复左侧栏子视图状态（消息/好友）
  applyChatLeftView();
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
  setChatDetailOpen(true);
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
        <button class="btn btn-xs" data-action="chat-back">${__('chat.back')}</button>
        <img src="${avatarSrc}" class="chat-conv-avatar mx-4" loading="lazy" data-avatar-fail-src="${escAttr(user.avatarUrl || '/api/avatar/default')}" />
        <strong>${esc(displayName)}</strong>
        <span class="ml-auto">
          <button class="btn btn-xs btn-outline" data-action="chat-call" data-call-type="voice" data-uid="${userId}" title="${esc(__('rtc.voice_call'))}">📞</button>
          <button class="btn btn-xs btn-outline ml-2" data-action="chat-call" data-call-type="video" data-uid="${userId}" title="${esc(__('rtc.video_call'))}">📹</button>
          <button class="btn btn-xs btn-outline ml-2" data-action="chat-view-loc" data-uid="${userId}">${__('chat.view_location')}</button>
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

// 聊天输入区媒体入口（原内联 onclick 迁移到委托）
document.addEventListener('click', function (e) {
  const btn = e.target.closest('#chatImageBtn, #chatVideoBtn, #chatAudioBtn');
  if (!btn) return;
  if (btn.id === 'chatImageBtn') pickChatImage();
  else if (btn.id === 'chatVideoBtn') pickChatVideo();
  else pickChatAudio();
});

function closeChatDetail() {
  stopTypingIndicator();
  chatActiveUserId = null;
  chatActiveGroupId = null;
  document.getElementById('chatConversationView')?.classList.remove('d-none');
  document.getElementById('chatDetailView')?.classList.add('d-none');
  document.getElementById('chatInputArea')?.classList.add('d-none');
  setChatDetailOpen(false);
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
    return `<img class="chat-media chat-media-img" src="${url}" alt="" loading="lazy" style="max-width:100%;border-radius:8px;display:block" data-img-fallback="1">`;
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
  // P-8: 整体重建也记录已渲染 id，之后 WS 重推同一条不双份
  messages.forEach(m => { if (m.id != null) markMsgRendered(m.id); });
  chatBox.innerHTML = messages.map(m => {
    const isMe = m.senderId === currentUser.id;
    const recallBtn = canRecallPrivateMsg(m)
      ? `<button class="chat-msg-recall" data-action="chat-recall-private" data-mid="${m.id}">${__('chat.recall')}</button>`
      : '';
    return `<div class="chat-msg ${isMe ? 'chat-msg-me' : 'chat-msg-other'}" data-mid="${m.id}">
      <div class="chat-msg-bubble">${chatMediaBlock(m)}${m.content ? esc(m.content) : ''}</div>
      <div class="chat-msg-time">${formatChatTime(m.createdAt)} ${recallBtn}</div>
    </div>`;
  }).join('');
  chatBox.scrollTop = chatBox.scrollHeight;
}

// ==================== 群聊 V6.13 ====================

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
  setChatDetailOpen(true);
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
        <button class="btn btn-xs" data-action="chat-back">${__('chat.back')}</button>
        <div class="chat-group-avatar-sm">#</div>
        <strong>${esc(grp.group.name)}</strong>
        <span class="text-muted2 text-12 ml-4">${__('chat.n_members_label', {n: members.length})}</span>
        <span class="ml-auto">
          <button id="groupLocBtn_${groupId}" class="btn btn-xs ${groupLocationSharing[groupId] ? 'btn-danger' : ''}" data-action="chat-toggle-group-loc" data-gid="${groupId}">
            ${groupLocationSharing[groupId] ? __('chat.stop_sharing') : __('chat.share_location')}
          </button>
          <button id="groupVoiceBtn_${groupId}" class="btn btn-xs btn-outline ml-2" data-action="chat-toggle-group-voice" data-gid="${groupId}">🎤 ${__('rtc.voice_room')}</button>
          <button class="btn btn-xs btn-outline ml-2" data-action="chat-group-settings" data-gid="${groupId}">${__('chat.group_settings')}</button>
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
    if (groupLocationSharing[gid]) stopGroupLocation(gid, true);
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
  // P-8: 同 renderMessages，整体重建记录已渲染 id
  messages.forEach(m => { if (m.id != null) markMsgRendered(m.id); });
  chatBox.innerHTML = messages.map(m => {
    const isMe = m.senderId === currentUser.id;
    const sender = memberMap[m.senderId] || {};
    const senderName = sender.displayName || m.senderName || '';
    const senderAvatar = sender.avatarUrl ? escAttr(sender.avatarUrl) : '/api/avatar/default';
    const msgId = m.id;

    if (m.msgType === 'location') {
      // 位置消息（来自群聊实时位置共享保存的消息）
      return `<div class="chat-msg chat-msg-other" data-mid="${msgId}">
        <div class="chat-msg-sender">${senderAvatar ? `<img src="${senderAvatar}" class="chat-mini-avatar" loading="lazy" data-avatar-fail-src="${escAttr(sender.avatarUrl || '/api/avatar/default')}">` : ''} ${esc(senderName)}</div>
        <div class="chat-msg-bubble chat-msg-location" data-action="chat-open-map-loc" data-lat="${m.lat}" data-lng="${m.lng}">${__('chat.location_sharing')}</div>
        <div class="chat-msg-time">${formatChatTime(m.createdAt)}</div>
      </div>`;
    }
    const recallBtn = canRecallGroupMsg(m)
      ? `<button class="chat-msg-recall" data-action="chat-recall-group" data-gid="${chatActiveGroupId}" data-mid="${msgId}">${__('chat.recall')}</button>`
      : '';
    if (m.mediaUrl && m.mediaType) {
      return `<div class="chat-msg ${isMe ? 'chat-msg-me' : 'chat-msg-other'}" data-mid="${msgId}">
        ${!isMe ? `<div class="chat-msg-sender">${senderAvatar ? `<img src="${senderAvatar}" class="chat-mini-avatar" loading="lazy" data-avatar-fail-src="${escAttr(sender.avatarUrl || '/api/avatar/default')}">` : ''} ${esc(senderName)}</div>` : ''}
        <div class="chat-msg-bubble">${chatMediaBlock(m)}${m.content ? esc(m.content) : ''}</div>
        <div class="chat-msg-time">${formatChatTime(m.createdAt)} ${recallBtn}</div>
      </div>`;
    }
    return `<div class="chat-msg ${isMe ? 'chat-msg-me' : 'chat-msg-other'}" data-mid="${msgId}">
      ${!isMe ? `<div class="chat-msg-sender">${senderAvatar ? `<img src="${senderAvatar}" class="chat-mini-avatar" loading="lazy" data-avatar-fail-src="${escAttr(sender.avatarUrl || '/api/avatar/default')}">` : ''} ${esc(senderName)}</div>` : ''}
      <div class="chat-msg-bubble">${esc(m.content)}</div>
      <div class="chat-msg-time">${formatChatTime(m.createdAt)} ${recallBtn}</div>
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
      // 不在当前对话中才重载列表（更新未读数）；P-3: 防抖合并
      scheduleChatListRefresh();
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
  // 群聊消息 — 只在用户不在该群详情页时重载列表（P-3: 防抖合并）
  if (msg.type === 'group:new') {
    if (chatActiveGroupId === msg.groupId) {
      appendGroupMessage(msg.message);
    } else {
      scheduleChatListRefresh();
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
  // P-8: WS 实时路径幂等——同一条消息（重推/回执/临界时刻）只渲染一次
  if (markMsgRendered(msg.id)) return;
  const emptyMsg = chatBox.querySelector('.chat-empty-msg');
  if (emptyMsg) emptyMsg.remove();
  const isMe = msg.senderId === currentUser.id;
  const recallBtn = canRecallPrivateMsg(msg)
    ? `<button class="chat-msg-recall" data-action="chat-recall-private" data-mid="${msg.id}">${__('chat.recall')}</button>`
    : '';
  chatBox.insertAdjacentHTML('beforeend', `
    <div class="chat-msg ${isMe ? 'chat-msg-me' : 'chat-msg-other'}" data-mid="${msg.id}">
      <div class="chat-msg-bubble">${chatMediaBlock(msg)}${msg.content ? esc(msg.content) : ''}</div>
      <div class="chat-msg-time">${formatChatTime(msg.createdAt)} ${recallBtn}</div>
    </div>`);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function appendGroupMessage(msg) {
  const chatBox = document.getElementById('chatBox');
  if (!chatBox) return;
  // P-8: 同 appendReceivedMessage，实时群消息幂等去重
  if (markMsgRendered(msg.id)) return;
  const emptyMsg = chatBox.querySelector('.chat-empty-msg');
  if (emptyMsg) emptyMsg.remove();
  const isMe = msg.senderId === currentUser.id;
  const recallBtn = canRecallGroupMsg(msg)
    ? `<button class="chat-msg-recall" data-action="chat-recall-group" data-gid="${chatActiveGroupId}" data-mid="${msg.id}">${__('chat.recall')}</button>`
    : '';
  chatBox.insertAdjacentHTML('beforeend', `
    <div class="chat-msg ${isMe ? 'chat-msg-me' : 'chat-msg-other'}" data-mid="${msg.id}">
      ${!isMe ? `<div class="chat-msg-sender">${esc(msg.senderName || '')}</div>` : ''}
      <div class="chat-msg-bubble">${chatMediaBlock(msg)}${msg.content ? esc(msg.content) : ''}</div>
      <div class="chat-msg-time">${msg.createdAt ? formatChatTime(msg.createdAt) : ''} ${recallBtn}</div>
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
          return `<div class="chat-conv-item" data-action="chat-open-dm" data-uid="${otherId}">
            <img src="${avatarSrc}" class="chat-conv-avatar" data-avatar-fail-src="${escAttr(m.senderAvatar || '/api/avatar/default')}">
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
          return `<div class="chat-conv-item" data-action="chat-open-group" data-gid="${m.groupId}">
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
  // P-8: 历史分页反向去重——若某条已在实时路径渲染过（临界时刻），跳过避免双份
  const toRender = messages.filter(m => m.id == null || !_recentRenderedMsgIds.has(m.id));
  if (!toRender.length) return;
  const newContent = toRender.map(m => {
    const isMe = m.senderId === currentUser.id;
    return `<div class="chat-msg ${isMe ? 'chat-msg-me' : 'chat-msg-other'}">
      <div class="chat-msg-bubble">${chatMediaBlock(m)}${m.content ? esc(m.content) : ''}</div>
      <div class="chat-msg-time">${formatChatTime(m.createdAt)}</div>
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
  // P-8: 与 prependMessages 一致——临界时刻实时已渲染的消息在历史翻页中跳过
  const toRender = messages.filter(m => m.id == null || !_recentRenderedMsgIds.has(m.id));
  if (!toRender.length) return;
  const newContent = toRender.map(m => {
    const isMe = m.senderId === currentUser.id;
    if (m.msgType === 'location' && m.lat != null && m.lng != null) {
      return `<div class="chat-msg chat-msg-other">
        <div class="chat-msg-sender">${esc(m.senderName || '')}</div>
        <div class="chat-msg-bubble chat-msg-location" data-action="chat-open-map-loc" data-lat="${m.lat}" data-lng="${m.lng}">${__('chat.location_sharing')}</div>
        <div class="chat-msg-time">${formatChatTime(m.createdAt)}</div>
      </div>`;
    }
    return `<div class="chat-msg ${isMe ? 'chat-msg-me' : 'chat-msg-other'}">
      ${!isMe ? `<div class="chat-msg-sender">${esc(m.senderName || '')}</div>` : ''}
      <div class="chat-msg-bubble">${chatMediaBlock(m)}${m.content ? esc(m.content) : ''}</div>
      <div class="chat-msg-time">${formatChatTime(m.createdAt)}</div>
    </div>`;
  }).join('');
  chatBox.insertAdjacentHTML('afterbegin', newContent);
  // 锚定原阅读位置：向上加载历史后保持当前消息的视觉位置不变（聊天问题 9.2）
  chatBox.scrollTop = prevScroll + (chatBox.scrollHeight - prevHeight);
}

// 私聊/群聊通用：从会话数据或已知用户缓存取显示名
function getChatUserName(userId) {
  const uid = String(userId);
  const conv = chatConversations[uid];
  if (conv && conv.displayName) return conv.displayName;
  return __('unknown_user');
}

// ==================== 聊天输入/媒体绑定 ====================
document.addEventListener('DOMContentLoaded', () => {
  ['chatImageInput', 'chatVideoInput', 'chatAudioInput'].forEach((fid) => {
    const el = document.getElementById(fid);
    if (!el) return;
    el.addEventListener('change', function () {
      if (fid === 'chatImageInput') onChatImageSelected(this);
      else if (fid === 'chatVideoInput') onChatVideoSelected(this);
      else onChatAudioSelected(this);
    });
  });
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

});

// ==================== 聊天页内联事件迁移（CSP nonce 拦截属性型处理器） ====================
// 会话列表 / 私聊 / 群聊 / 搜索 / 群设置 / 邀请码 / 位置消息 / RTC 通话控件
// 统一改为 data-action + document 级委托，天然覆盖重渲染与懒加载时序。
let _chatDelegationHandler = null;
let _chatKeydownHandler = null;
let _chatInputHandler = null;

function _bindChatDelegation() {
  if (_chatDelegationHandler) document.removeEventListener('click', _chatDelegationHandler);
  if (_chatKeydownHandler) document.removeEventListener('keydown', _chatKeydownHandler);
  if (_chatInputHandler) document.removeEventListener('input', _chatInputHandler);
  _chatDelegationHandler = function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
    if (!el) return;
    var action = el.getAttribute('data-action');
    switch (action) {
      case 'chat-open-group':
        openGroupChat(el.getAttribute('data-gid'));
        break;
      case 'chat-open-dm':
        openChat(el.getAttribute('data-uid'));
        break;
      case 'chat-search-go':
        chatSearch((document.getElementById('chatSearchInput') || {}).value || '');
        break;
      case 'chat-search-clear':
        clearChatSearch();
        break;
      case 'chat-sub-msg':
        setChatLeftView('msg');
        break;
      case 'chat-sub-friends':
        setChatLeftView('friends');
        break;
      case 'chat-create-group':
        showCreateGroupModal();
        break;
      case 'chat-join-code':
        showJoinByCodeModal();
        break;
      case 'chat-back':
        closeChatDetail();
        break;
      case 'chat-call':
        startPrivateCall(el.getAttribute('data-uid'), el.getAttribute('data-call-type'));
        break;
      case 'chat-view-loc':
        viewUserOnMap(el.getAttribute('data-uid'));
        break;
      case 'chat-recall-private':
        recallPrivateMessage(el.getAttribute('data-mid'));
        break;
      case 'chat-recall-group':
        recallGroupMessage(el.getAttribute('data-gid'), el.getAttribute('data-mid'));
        break;
      case 'chat-close-create-group':
        closeModal('createGroupModal');
        break;
      case 'chat-do-create-group':
        doCreateGroup();
        break;
      case 'chat-toggle-group-loc':
        toggleGroupLocation(el.getAttribute('data-gid'));
        break;
      case 'chat-toggle-group-voice':
        toggleGroupVoiceRoom(el.getAttribute('data-gid'));
        break;
      case 'chat-group-settings':
        showGroupSettings(el.getAttribute('data-gid'));
        break;
      case 'chat-open-map-loc':
        if (typeof window.openMapLocation === 'function') {
          window.openMapLocation(parseFloat(el.getAttribute('data-lat')), parseFloat(el.getAttribute('data-lng')));
        }
        break;
      case 'chat-toggle-admin':
        toggleGroupAdmin(el.getAttribute('data-gid'), el.getAttribute('data-uid'), el.getAttribute('data-add') === '1');
        break;
      case 'chat-kick':
        kickGroupMember(el.getAttribute('data-gid'), el.getAttribute('data-uid'));
        break;
      case 'chat-set-privacy':
        setGroupPrivacy(el.getAttribute('data-gid'), el.getAttribute('data-is-public') === '1');
        break;
      case 'chat-copy-invite':
        copyGroupInvite(el.getAttribute('data-code') || '');
        break;
      case 'chat-regen-invite':
        regenerateInvite(el.getAttribute('data-gid'));
        break;
      case 'chat-leave-group':
        leaveGroup(el.getAttribute('data-gid'));
        break;
      case 'chat-dissolve-group':
        dissolveGroup(el.getAttribute('data-gid'));
        break;
      case 'chat-close-group-settings':
        closeModal('groupSettingsModal');
        break;
      case 'chat-close-join-code':
        closeModal('joinByCodeModal');
        break;
      case 'chat-do-join-code':
        doJoinByCode();
        break;
      case 'chat-close-invite-code':
        closeModal('inviteCodeModal');
        break;
      case 'rtc-toggle-cam':
        rtcToggleCamera();
        break;
      case 'rtc-toggle-screen':
        rtcToggleScreenShare();
        break;
      case 'rtc-toggle-screen-audio':
        rtcToggleScreenAudio();
        break;
      case 'rtc-hangup':
        hangupPrivateCall();
        break;
      case 'rtc-decline':
        declinePrivateCall();
        break;
      case 'rtc-accept':
        acceptPrivateCall();
        break;
      case 'rtc-group-toggle-screen':
        rtcToggleGroupScreenShare();
        break;
      case 'rtc-group-toggle-screen-audio':
        rtcToggleGroupScreenAudio();
        break;
      case 'rtc-group-leave':
        leaveGroupVoiceRoom(el.getAttribute('data-gid'));
        break;
    }
  };
  _chatKeydownHandler = function (e) {
    if (e.key !== 'Enter') return;
    var t = e.target;
    if (t && t.id === 'chatSearchInput') {
      e.preventDefault();
      chatSearch(t.value || '');
      return;
    }
    var el = t && t.closest ? t.closest('[data-action][role="button"]') : null;
    if (!el) return;
    e.preventDefault();
    el.click();
  };
  _chatInputHandler = function (e) {
    var t = e.target;
    if (t && t.id === 'chatSearchInput') debouncedChatSearch(t.value || '');
  };
  document.addEventListener('click', _chatDelegationHandler);
  document.addEventListener('keydown', _chatKeydownHandler);
  document.addEventListener('input', _chatInputHandler);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _bindChatDelegation);
} else {
  _bindChatDelegation();
}
