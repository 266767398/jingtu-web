// ==================== 入口主模块 ====================

function validatePasswordStrength(pwd) {
  return pwd && pwd.length >= 8 && /[a-z]/.test(pwd) && /[A-Z]/.test(pwd) && /\d/.test(pwd) && /[^a-zA-Z0-9]/.test(pwd);
}

async function init() {
  // 初始化粒子背景
  initLoginParticles();

  // 初始化国际化
  initI18n();

  // 初始化主题
  initTheme();

  // 显示"正在检查登录状态"
  const loginLoading = document.getElementById('loginLoading');
  if (loginLoading) loginLoading.style.display = 'block';

  try {
    //⭐ 先检测数据库是否有用户
    const initCheck = await api('/api/auth/check-init', { method: 'GET' });
    if (initCheck.ok) {
      const { hasUser } = await initCheck.json();
      if (!hasUser) {
        // 无用户 → 先 showLogin（设置密码模式），再覆盖为初始化模式
        showLogin();
        document.getElementById('loginModePassword')?.classList.add('d-none');
        document.getElementById('loginModeVrc')?.classList.add('d-none');
        document.getElementById('loginModeInit')?.classList.remove('d-none');
        switchLoginMode('init');
        updateLoginTabsVisibility();
        if (loginLoading) loginLoading.style.display = 'none';
        // 无用户时跳过 auto login 检查，直接继续到 bindEvents()
        bindEvents();
        return;
      }
    }
    // 有用户 → 正常检查登录状态
    const isAutoLogged = await checkAutoLogin();
    if (!isAutoLogged) {
      showLogin();
    }
  } catch (err) {
    showLogin();
  } finally {
    if (loginLoading) loginLoading.style.display = 'none';
  }

  bindEvents();

  // 启动定时刷新（交错执行避免同时请求）
  let refreshTimer = null;
  let refreshQueue = ['home', 'members', 'announcements', 'events', 'album'];
  let refreshIdx = 0;

  function doStaggeredRefresh() {
    if (!currentUser) return;
    const tab = refreshQueue[refreshIdx % refreshQueue.length];
    refreshIdx++;
    if (tab === 'home') { if (activeTab === 'home') loadHome(); }
    else if (tab === 'members') loadMembers();
    else if (tab === 'announcements') loadAnnouncements();
    else if (tab === 'events') loadEvents(currentEvtStatus);
    else if (tab === 'album') loadAlbum();
    // 如果当前在地图Tab，每次刷新后也更新地图标记
    if (activeTab === 'map' && typeof updateMapMarkers === 'function') {
      setTimeout(updateMapMarkers, 500);
    }
  }

  setTimeout(doStaggeredRefresh, 30000);
  refreshTimer = setInterval(doStaggeredRefresh, 75000);

  // 后台标签页暂停定时刷新（节省性能）
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    } else {
      if (!refreshTimer) {
        doStaggeredRefresh(); // 回到前台立刻刷新一次
        refreshTimer = setInterval(doStaggeredRefresh, 75000);
      }
    }
  });
}

// ==================== WebSocket 在线状态 ====================
let wsClient = null;
let wsReconnectTimer = null;
let wsReconnectAttempts = 0;
let wsPingTimer = null; // 客户端 ping 保活
const WS_MAX_RECONNECT = 10;
const WS_PING_INTERVAL = 25000; // 25 秒一次 ping 防止服务端断连
let onlineUsersList = [];

function connectWebSocket() {
  if (wsClient && wsClient.readyState === WebSocket.OPEN) return;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${location.host}/ws`;
  wsClient = new WebSocket(wsUrl);
  wsClient.onopen = () => {
    wsReconnectAttempts = 0;
    // 启动客户端 ping 保活
    clearInterval(wsPingTimer);
    wsPingTimer = setInterval(() => {
      if (wsClient && wsClient.readyState === WebSocket.OPEN) {
        wsClient.send(JSON.stringify({ type: 'ping' }));
      } else {
        clearInterval(wsPingTimer);
      }
    }, WS_PING_INTERVAL);
    if (currentUser) {
      wsClient.send(JSON.stringify({
        type: 'online',
        userId: currentUser.id,
        displayName: currentUser.displayName || '',
        avatarUrl: currentUser.avatarUrl || ''
      }));
    }
  };
  wsClient.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'online_users') {
        onlineUsersList = msg.users || [];
        document.getElementById('heroOnline').textContent = msg.count || 0;
        document.getElementById('headerOnline').textContent = `${__('main.online_count', {n: msg.count || 0})}`;
      }
      if (msg.type === 'new_notification' && msg.notification) {
        const n = msg.notification;
        // 刷新通知列表（如果打开则自动更新）
        if (typeof loadNotifications === 'function') loadNotifications();
        // 显示 toast 提示（除非用户当前在通知面板中）
        toast(`🔔 ${n.title}`, 'info', 5000);
      }
      // V6.11: 实时位置更新
      if ((msg.type === 'location:update' || msg.type === 'location:stop') && typeof handleLocationMessage === 'function') {
        handleLocationMessage(msg);
      }
      // V6.12: 聊天消息
      if (msg.type === 'chat:new' || msg.type === 'chat:sent') {
        if (typeof handleChatMessage === 'function') handleChatMessage(msg);
        if (typeof loadChatConversations === 'function' && activeTab !== 'chat') {
          setTimeout(loadChatConversations, 500);
        }
      }
      // V6.13: 群聊消息+实时位置
      if (msg.type === 'group:new' || msg.type === 'group:location:update' || msg.type === 'group:location:stop') {
        if (typeof handleChatMessage === 'function') handleChatMessage(msg);
      }
    } catch {}
  };
  wsClient.onclose = () => {
    if (wsReconnectAttempts < WS_MAX_RECONNECT) {
      wsReconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, wsReconnectAttempts - 1), 30000);
      wsReconnectTimer = setTimeout(connectWebSocket, delay);
    }
  };
  wsClient.onerror = () => { wsClient?.close(); };
}

// 点击在线人数展示在线成员列表
function showOnlineUsers() {
  const count = parseInt(document.getElementById('heroOnline')?.textContent) || 0;
  if (count === 0) { toast(__('group.no_online'), 'info'); return; }
  const html = onlineUsersList.map(u => {
    const userId = typeof u.userId === 'number' ? u.userId : `'${esc(String(u.userId))}'`;
    const avatarSrc = u.avatarUrl ? escAttr(u.avatarUrl) : '/api/avatar/default';
    const displayName = esc(u.displayName || '${__('main.unknown_user')}');
    const isMe = u.userId === currentUser?.id;
    const clickHandler = !isMe ? `goToProfile(${userId})` : '';
    return `
    <div class="online-user-popup-item" style="${!isMe ? 'cursor:pointer' : ''}" onclick="${clickHandler ? `goToProfile(${userId})` : ''}">
      <img src="${avatarSrc}" class="online-user-popup-avatar" loading="lazy">
      <span class="online-user-popup-name">${displayName}</span>
      ${isMe ? '<span class="text-muted2 text-11">${__('main.me')}</span>' : ''}
      <span class="online-user-popup-dot" title="${__('main.online')}" aria-label="${__('main.online')}"></span>
    </div>`;
  }).join('');
  // 使用通用的 showModal 弹窗模式
  const modal = document.getElementById('onlineUsersModal') || (() => {
    const m = document.createElement('div');
    m.id = 'onlineUsersModal';
    m.className = 'modal';
    m.innerHTML = `<div class="modal-content" style="max-width:380px">
      <h3>${__('main.online_users')} <span id="onlineUsersCount" class="text-accent"></span></h3>
      <div id="onlineUsersBody" class="online-users-body"></div>
      <div class="modal-actions"><button class="btn" onclick="closeModal('onlineUsersModal')">${__('main.close')}</button></div>
    </div>`;
    document.body.appendChild(m);
    return m;
  })();
  document.getElementById('onlineUsersCount').textContent = count;
  const body = document.getElementById('onlineUsersBody');
  if (body) body.innerHTML = html;
  showModal('onlineUsersModal');
}

function disconnectWebSocket() {
  clearTimeout(wsReconnectTimer);
  clearInterval(wsPingTimer);
  if (wsClient) {
    if (currentUser) {
      try { wsClient.send(JSON.stringify({ type: 'offline', userId: currentUser.id })); } catch {}
    }
    wsClient.close();
    wsClient = null;
  }
}

function bindEvents() {
  // 确保先移除已有的全局监听器再重新添加
  const oldClickHandler = window._mainClickHandler;
  if (oldClickHandler) document.removeEventListener('click', oldClickHandler);

  window._mainClickHandler = (e) => {
    // 主题面板外部点击${__('main.close')}
    const themePanel = document.getElementById('themePanel');
    const themeBtn = document.getElementById('themeBtn');
    if (themePanel && themePanel.classList.contains('show') &&
        !themePanel.contains(e.target) && e.target !== themeBtn) {
      closeThemePanel();
    }

    // 通知面板外部点击${__('main.close')}
    const notifPanel = document.getElementById('notificationPanel');
    const bellBtn = document.getElementById('bellBtn');
    if (notifPanel && notifPanel.classList.contains('show') &&
        !notifPanel.contains(e.target) && e.target !== bellBtn && !bellBtn?.contains(e.target)) {
      notifPanel.classList.remove('show');
    }

    // 用户菜单外部点击${__('main.close')}
    const userMenu = document.getElementById('userDropdown');
    const userAvatar = document.getElementById('userMenuTrigger');
    if (userMenu && userMenu.style.display === 'block' &&
        !userMenu.contains(e.target) && e.target !== userAvatar && !userAvatar?.contains(e.target)) {
      userMenu.style.display = 'none';
    }
  };
  document.addEventListener('click', window._mainClickHandler);

  // ESC ${__('main.close')}弹窗
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeAllModals();
      if (typeof closeLightbox === 'function') closeLightbox();
    }
  });

  // 返回顶部按钮（避免重复添加监听器）
  const backToTopBtn = document.getElementById('backToTopBtn');
  if (backToTopBtn) {
    if (window._backToTopHandler) window.removeEventListener('scroll', window._backToTopHandler);
    window._backToTopHandler = function() {
      if (window.scrollY > 300) {
        backToTopBtn.classList.add('visible');
      } else {
        backToTopBtn.classList.remove('visible');
      }
    };
    window.addEventListener('scroll', window._backToTopHandler);
  }

  // 头像文件输入监听
  const avatarFileInput = document.getElementById('meAvatarUpload');
  if (avatarFileInput) {
    avatarFileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        uploadAvatar(e.target.files[0]);
      }
    });
  }

  // 相册上传输入监听 — 支持多选循环上传
  const albumUpload = document.getElementById('albumUpload');
  if (albumUpload) {
    albumUpload.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length) {
        for (let i = 0; i < e.target.files.length; i++) {
          uploadPhoto(e.target.files[i], '', null);
        }
        e.target.value = ''; // 重置input，允许重复选择相同文件
      }
    });
  }

  // 活动照片上传 → 直接调用uploadPhoto上传到相册并关联活动
  const evtPhotoUpload = document.getElementById('evtPhotoUpload');
  if (evtPhotoUpload) {
    evtPhotoUpload.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length) {
        const eventId = window._currentEventId;
        for (let i = 0; i < e.target.files.length; i++) {
          uploadPhoto(e.target.files[i], '', null, eventId);
        }
        e.target.value = ''; // 重置input，允许重复选择相同文件
      }
    });
  }

  // 登录框回车提交
  const loginPwd = document.getElementById('loginPassword');
  if (loginPwd) {
    loginPwd.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doPasswordLogin();
    });
  }
  const loginVrcPwd = document.getElementById('loginVrcPass');
  if (loginVrcPwd) {
    loginVrcPwd.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendVrcLoginCode();
    });
  }
  // VRChat 用户名输入框 Enter 也触發发送验证码
  const loginVrcUser = document.getElementById('loginVrcUser');
  if (loginVrcUser) {
    loginVrcUser.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendVrcLoginCode();
    });
  }

  // 群组图片上传绑定
  bindGroupImageUploads();
}

// ==================== 搜索 ====================
let searchTimer = null;
let searchBlurBlocked = false; // 搜索结果点击时阻止blur隐藏
let _searchPending = null; // 记录上次防抖未执行的搜索词

function globalSearch(query) {
  clearTimeout(searchTimer);
  if (!query || query.length < 2) { hideSearchResults(); _searchPending = null; return; }
  _searchPending = query;
  searchTimer = setTimeout(() => { _searchPending = null; globalSearchDo(query); }, 300);
}

// Enter 键直接触发搜索（同样走防抖，避免重复请求）
function globalSearchEnter(query) {
  clearTimeout(searchTimer);
  if (!query || query.length < 2) { hideSearchResults(); return; }
  if (_searchPending === query) {
    // 防抖队列中已有同一关键词，取消防抖立即执行
    _searchPending = null;
    globalSearchDo(query);
  } else {
    globalSearchDo(query);
  }
}

async function globalSearchDo(query) {
  const container = document.getElementById('globalSearchResults');
  if (!container) return;
  // 显示骨架屏加载状态
  container.innerHTML = '<div class="skeleton-card-md" style="margin:4px 6px"></div><div class="skeleton-card-md" style="margin:4px 6px"></div>';
  container.style.display = 'block';
  try {
    const res = await api(`/api/search?q=${encodeURIComponent(query)}`, { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      const results = [
        ...(data.announcements || []).map(a => ({ ...a, type: 'announcements' })),
        ...(data.events || []).map(e => ({ ...e, type: 'events' })),
        ...(data.users || []).map(u => ({ ...u, type: 'members' }))
      ];
      if (results.length === 0) {
        container.innerHTML = '<div class="text-muted text-12 p-12 text-center">${__('main.no_results')}</div>';
      } else {
        container.innerHTML = results.slice(0, 10).map(r =>
        `<div class="search-result-item" onmousedown="searchBlurBlocked=true" onclick="searchBlurBlocked=false;switchTab('${r.type}');hideSearchResults()">
          <span class="search-result-type">${r.type === 'announcements' ? '📢' : r.type === 'events' ? '📅' : '👤'}</span>
          <span class="search-result-title">${esc(r.title || r.preview || r.displayName || r.loginId || '')}</span>
          <span class="search-result-cat">${r.type === 'announcements' ? __('global.category_announce') : r.type === 'events' ? __('global.category_event') : __('global.category_member')}</span>
        </div>`
        ).join('');
      }
      container.style.display = 'block';
    }
  } catch { container.innerHTML = '<div class="text-muted text-12 p-8">${__('main.search_failed')}</div>'; }
}

function hideSearchResults() {
  const container = document.getElementById('globalSearchResults');
  if (container) container.style.display = 'none';
}

// 群组图片上传 — 监听三个input的change事件
function bindGroupImageUploads() {
  ['avatar', 'banner', 'hero'].forEach(type => {
    const inputId = type === 'avatar' ? 'avatarInput' : type === 'banner' ? 'bannerInput' : 'heroInput';
    const input = document.getElementById(inputId);
    if (input) {
      input.addEventListener('change', async (e) => {
        if (!e.target.files || !e.target.files[0]) return;
        const file = e.target.files[0];
        if (!file.type.startsWith('image/')) { toast(__('global.upload_select_images'), 'error'); return; }
        const formData = new FormData();
        formData.append('image', file);
        formData.append('type', type);
        try {
          const res = await apiForm('/api/admin/group-image', formData);
          if (res.ok) {
            const data = await res.json();
            // 更新对应预览图
            const imgId = type === 'avatar' ? 'adminAvatar' : type === 'banner' ? 'adminBanner' : 'adminHero';
            const img = document.getElementById(imgId);
            if (img) { img.src = data.url; img.style.display = ''; }
            toast(__('main.group_updated', {type: (type === 'avatar' ? __('global.avatar') : type === 'banner' ? __('global.banner') : __('global.cover'))}), 'success');
          }
        } catch (err) { if (isApiHandledError(err)) return; toast(__('main.upload_failed') + ': ' + err.message, 'error'); }
        e.target.value = '';
      });
    }
  });
}

// ==================== 活动报名 ====================
async function signEvent(eventId) {
  showConfirm(__('main.confirm_signup'), async () => {
    try {
      const res = await api(`/api/events/${eventId}/sign`, { method: 'POST' });
      if (res.ok) {
        toast(__('events.sign_success'), 'success');
        signedEvents.add(eventId);
        if (typeof showEventDetail === 'function') showEventDetail(eventId);
      }
    } catch (err) { if (isApiHandledError(err)) return; toast(__('main.signup_failed') + ': ' + err.message, 'error'); }
  });
}

async function unsignEvent(eventId) {
  showConfirm(__('main.confirm_cancel_signup'), async () => {
    try {
      const res = await api(`/api/events/${eventId}/unsign`, { method: 'POST' });
      if (res.ok) {
        toast(__('main.signup_cancelled'), 'info');
        signedEvents.delete(eventId);
        if (typeof showEventDetail === 'function') showEventDetail(eventId);
      }
    } catch (err) { if (isApiHandledError(err)) return; toast(__('main.op_failed') + ': ' + err.message, 'error'); }
  });
}

// ==================== 照片上传（逻辑，支持进度条） ====================
async function uploadPhoto(file, caption = '', albumId = null, eventId = null) {
  if (!file) return;
  if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) { toast(__('main.select_media'), 'error'); return; }

  // 显示进度条
  const progressWrap = document.getElementById('uploadProgress');
  const progressText = document.getElementById('uploadProgressText');
  const progressPercent = document.getElementById('uploadProgressPercent');
  const progressFill = document.getElementById('uploadProgressFill');
  const progressFile = document.getElementById('uploadProgressFile');

  if (progressWrap) progressWrap.classList.remove('d-none');
  if (progressWrap) progressWrap.classList.add('active');
  if (progressText) progressText.textContent = '${__('main.uploading')}';
  if (progressPercent) progressPercent.textContent = '0%';
  if (progressFill) progressFill.style.width = '0%';
  if (progressFile) progressFile.textContent = file.name;

  const formData = new FormData();
  formData.append('photo', file);
  if (caption) formData.append('caption', caption);
  if (albumId) formData.append('albumId', albumId);
  if (eventId) formData.append('eventId', eventId);
  try {
    const res = await uploadWithProgress('/api/upload', formData, function(percent) {
      if (progressPercent) progressPercent.textContent = percent + '%';
      if (progressFill) progressFill.style.width = percent + '%';
      if (progressText) progressText.textContent = percent < 100 ? '${__('main.uploading')}' : '${__('main.processing')}';
    });
    if (res.ok) {
      const data = await res.json();
      var isVideo = data.mediaType === 'video';
      toast(isVideo ? __('global.video_uploaded') : __('main.photo_uploaded'), 'success');
      loadAlbum();
      // 如果在活动详情弹窗里，重新加载活动照片
      if (eventId && typeof loadEventPhotos === 'function') {
        setTimeout(function() { loadEventPhotos(eventId); }, 300);
      }
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('main.upload_failed') + ': ' + err.message, 'error');
  } finally {
    if (progressWrap) { progressWrap.classList.remove('active'); progressWrap.classList.add('d-none'); }
  }
}

// ==================== DOMContentLoaded ====================
document.addEventListener('DOMContentLoaded', () => {
  init();
});
