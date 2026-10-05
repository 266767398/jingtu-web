// ==================== 入口主模块 ====================

function validatePasswordStrength(pwd) {
  // 与后端 auth.js 及 setup.html 保持一致：长度 8+，同时包含大小写字母与数字，不强制要求符号
  return pwd && pwd.length >= 8 && /[a-z]/.test(pwd) && /[A-Z]/.test(pwd) && /\d/.test(pwd);
}

function scrollToTop() {
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// 定时刷新句柄提升到模块级：空闲冻结时可由 freeze.js 注册的回调统一暂停/恢复
let refreshTimer = null;
let _initialRefreshTimer = null;

function playNotificationSound() {
  if (window.__notifPrefs && window.__notifPrefs.sound === false) return;
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(880, audioCtx.currentTime);
    oscillator.frequency.setValueAtTime(1100, audioCtx.currentTime + 0.1);
    oscillator.frequency.setValueAtTime(1320, audioCtx.currentTime + 0.2);
    gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);
    oscillator.start(audioCtx.currentTime);
    oscillator.stop(audioCtx.currentTime + 0.3);
  } catch {}
}

let _notificationPermissionRequested = false;

function showBrowserNotification(title, message) {
  if (!('Notification' in window) || !currentUser) return;
  if (window.__notifPrefs && window.__notifPrefs.browser === false) return;
  if (Notification.permission === 'denied') return;
  if (Notification.permission !== 'granted') {
    if (!_notificationPermissionRequested) {
      _notificationPermissionRequested = true;
      Notification.requestPermission();
    }
    return;
  }
  try {
    new Notification(title, {
      body: message,
      icon: '/assets/group-avatar.png',
      badge: '/assets/group-avatar.png',
      tag: 'jingtu-notification',
      requireInteraction: false
    });
  } catch {}
}

async function init() {
  initLoginParticles();
  initI18n();
  initTheme();

  // 预取前端运行环境配置（含 WebSocket 地址，支持环境变量 WS_URL 自定义）。
  // 不阻塞首屏：失败则前端自动按当前协议探测 ws/wss。
  fetch('/api/client-config')
    .then(r => r.ok ? r.json() : null)
    .then(cfg => { if (cfg && cfg.wsUrl) window.__WS_URL__ = cfg.wsUrl; })
    .catch(() => {});

  const loginLoading = document.getElementById('loginLoading');
  if (loginLoading) loginLoading.style.display = 'block';

  try {
    const initCheck = await api('/api/auth/init', { method: 'GET' });
    let hasUser = true;
    if (initCheck.ok) {
      try {
        const data = await initCheck.json();
        hasUser = !data.needInit;
      } catch {
        hasUser = true;
      }
    }

    if (!hasUser) {
      document.getElementById('loginModePassword')?.classList.add('d-none');
      document.getElementById('loginModeVrc')?.classList.add('d-none');
      document.getElementById('loginModeInit')?.classList.remove('d-none');
      switchLoginMode('init');
      updateLoginTabsVisibility();
      startInitWizard();
      bindEvents();
      return;
    }

    document.getElementById('loginModeInit')?.classList.add('d-none');

    // 先尽快展示首页骨架与公开内容，避免被登录态/Me接口阻塞 5 秒白屏。
    // 登录态恢复后在 showApp 里补头像、问候、WebSocket 等私有 UI。
    document.getElementById('appHeader')?.classList.remove('d-none');
    document.getElementById('heroSection')?.classList.remove('d-none');
    document.getElementById('mainContainer')?.classList.remove('d-none');
    document.getElementById('appFooter')?.classList.remove('d-none');
    bindEvents();
    // P2-98: 支持 #<tab> 深链直达（无 hash 或非法值回落 home）
    if (typeof tabFromUrl === 'function') {
      switchTab(tabFromUrl(), true);
    } else if (activeTab === 'home') {
      switchTab('home', true);
    }

    // 登录态检查不再阻塞首屏渲染
    checkAutoLogin().then(isAutoLogged => {
      if (isAutoLogged) {
        showApp();
      } else {
        showLogin();
      }
    }).catch(() => showLogin()).finally(() => {
      if (loginLoading) loginLoading.style.display = 'none';
    });
  } catch {
    document.getElementById('loginModeInit')?.classList.add('d-none');
    showLogin();
    if (loginLoading) loginLoading.style.display = 'none';
  }

  // 启动定时刷新（P2-22：合帧节流 + 仅可见 Tab 刷新）
  // - 合帧：同一帧内的多次触发合并为一次（_refreshScheduled 防抖），并限制最小间隔避免抖动。
  // - 仅可见：只刷新当前 activeTab，后台 Tab 不再无意义轮询（切换 Tab 时 switchTab 会全量加载该 Tab）。
  // 句柄 refreshTimer/_initialRefreshTimer 为模块级变量，供空闲冻结回调暂停/恢复。
  // P2-3: 启动时的首次延迟刷新 setTimeout 原本未纳入管理，hidden 时只 clearInterval(refreshTimer)
  // 仍会被它触发一次 runRefresh，导致后台隐藏页发请求。单独跟踪并在 hidden 时一并清理。
  let _refreshScheduled = false;
  let _lastRefreshAt = 0;
  const REFRESH_MIN_GAP = 3000; // 最小刷新间隔，避免频繁触发（如切前台 + 定时器叠加）

  function runRefresh() {
    if (!currentUser) return;
    if (window.__freeze && window.__freeze.isFrozen()) return; // 空闲冻结期间不发起轮询
    const now = Date.now();
    if (now - _lastRefreshAt < REFRESH_MIN_GAP) return;
    _lastRefreshAt = now;
    // 路由模块为懒加载，未就绪时对应渲染函数尚不存在；用 typeof 守卫避免 ReferenceError
    const tab = activeTab;
    if (tab === 'home' && typeof loadHome === 'function') loadHome();
    else if (tab === 'members' && typeof loadMembers === 'function') loadMembers();
    else if (tab === 'announcements' && typeof loadAnnouncements === 'function') loadAnnouncements();
    else if (tab === 'events' && typeof loadEvents === 'function') loadEvents(currentEvtStatus);
    else if (tab === 'album' && typeof loadAlbum === 'function') loadAlbum();
    else if (tab === 'map' && typeof updateMapMarkers === 'function') updateMapMarkers();
  }

  // 合帧调度：同一轮事件循环 / 帧内的多次触发只执行一次，避免交错刷新扎堆发请求
  function scheduleRefresh() {
    if (_refreshScheduled) return;
    _refreshScheduled = true;
    const flush = function () { _refreshScheduled = false; runRefresh(); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
    else setTimeout(flush, 16);
  }

  _initialRefreshTimer = setTimeout(scheduleRefresh, 30000);
  refreshTimer = setInterval(scheduleRefresh, 75000);

  // 后台标签页暂停定时刷新（节省性能）；回到前台合帧刷新一次
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearInterval(refreshTimer);
      refreshTimer = null;
      if (_initialRefreshTimer) { clearTimeout(_initialRefreshTimer); _initialRefreshTimer = null; }
    } else {
      if (!refreshTimer) {
        scheduleRefresh(); // 回到前台立刻合帧刷新一次
        refreshTimer = setInterval(scheduleRefresh, 75000);
      }
    }
  });

  // 空闲冻结/交互解冻（freeze.js）：冻结时暂停定时轮询并断开 WebSocket，
  // 用户重新操作后立即恢复刷新调度并重连，从而在挂机时节约带宽与内存。
  if (window.__freeze && typeof window.__freeze.register === 'function') {
    window.__freeze.register({
      onFreeze: function () {
        if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
        if (_initialRefreshTimer) { clearTimeout(_initialRefreshTimer); _initialRefreshTimer = null; }
        _refreshScheduled = false;
        disconnectWebSocket();
        // 冻结是本页主动断连而非会话失效，避免解冻重连时被误报成「会话认证失败」
        wsEverOpened = true;
      },
      onUnfreeze: function () {
        if (!refreshTimer) {
          scheduleRefresh(); // 解冻立即合帧刷新一次，恢复最新数据
          refreshTimer = setInterval(scheduleRefresh, 75000);
        }
        connectWebSocket();
      }
    });
  }
}

// ==================== WebSocket 在线状态 ====================
let wsClient = null;
let wsReconnectTimer = null;
let wsReconnectAttempts = 0;
let wsPingTimer = null; // 客户端 ping 保活
const WS_MAX_RECONNECT = 3;       // 短周期快速重连次数（指数退避）
const WS_LONG_BACKOFF = 30000;    // 长周期探测间隔：重连耗尽后每 30s 试探一次，网络恢复即重连
const WS_PING_INTERVAL = 25000;   // 25 秒一次 ping 防止服务端断连
let onlineUsersList = [];
let wsLongBackoff = false;         // 进入长周期探测模式（不再刷屏，但仍会尝试恢复）
let wsEverOpened = false;          // 本次会话是否已成功建立过 WS 连接（用于区分认证失败与正常断线）

// 解析 WebSocket 地址：优先使用后端注入的环境变量 window.__WS_URL__（支持部署环境自定义），
// 否则按当前协议自动选择 ws/wss 并复用当前 host。
// 重要：必须使用 location.host（与页面同源），否则浏览器不会携带会话 cookie(connect.sid)，
// WS 升级会被 ws_service 的 verifyClient 以 401 拒绝。
// 早期 Windows 下 localhost 优先解析为 ::1(IPv6)，若反代仅监听 IPv4 会握手失败；
// 现已在 nginx 开启双栈监听（listen 80 + listen [::]:80），localhost 经 ::1 可达，无需再改写为 127.0.0.1。
// §31 规范化：若用户手输 127.0.0.1 访问（绕过 nginx 直连 Node），为与「经 localhost(nginx) 登录」建立的
// 会话 cookie 同源，将 WebSocket 目标改写回 localhost（走 nginx 反代 /ws）。否则 127.0.0.1 与 localhost
// 的 host-only cookie 不互通，verifyClient 会因无会话返回 401、浏览器报 "WebSocket connection failed"。
function resolveWsUrl() {
  if (window.__WS_URL__) return window.__WS_URL__;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let host = location.host;
  if (location.hostname === '127.0.0.1') {
    // 统一到 localhost 标准入口（nginx 80 端口反代），与登录会话同源
    host = location.port && location.port !== '80' ? `localhost:${location.port}` : 'localhost';
  }
  return `${protocol}//${host}/ws`;
}

function connectWebSocket() {
  if (wsClient && (wsClient.readyState === WebSocket.OPEN || wsClient.readyState === WebSocket.CONNECTING)) return;
  const wsUrl = resolveWsUrl();
  wsClient = new WebSocket(wsUrl);
  wsClient.onopen = () => {
    wsReconnectAttempts = 0;
    wsLongBackoff = false; // 连接成功，退出长周期探测模式
    wsEverOpened = true;   // §31：标记已成功建立，区分认证失败与正常断线
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
        // 只更新数字本身，不要给外层容器写 textContent —— 那样会把内部的数字节点
        // 整个删掉，下一条消息取不到元素而抛错，异常又被这里的 try 吞掉，
        // 在线人数就会永久停在第一次的数值。
        // 顶栏那个__('auto_main_4')已因与统计条重复而移除，实时数字现在落在统计条上；
        // 群组标签的角标由 updateGroupBadge 负责，这里一并刷新以保持跨标签可见。
        const onlineEl = document.getElementById('dashOnline');
        if (onlineEl) {
          onlineEl.textContent = msg.count || 0;
          onlineEl.classList.remove('skeleton-stat');
        }
        if (typeof updateGroupBadge === 'function') updateGroupBadge(msg.count || 0);
      }
      if (msg.type === 'new_notification' && msg.notification) {
        const n = msg.notification;
        // 刷新通知列表（如果打开则自动更新）；P1-25：必须传 reset=true，
        // 否则 notifPage 不归 1 且走追加分支，每次推送列表成倍增长
        if (typeof loadNotifications === 'function') loadNotifications(true);
        // 显示 toast 提示（除非用户当前在通知面板中）
        const notifPanel = document.getElementById('notificationPanel');
        if (!notifPanel || !notifPanel.classList.contains('show')) {
          toast(`🔔 ${n.title}`, 'info', 5000);
        }
        // 播放通知音效（如果用户开启了通知声音）
        playNotificationSound();
        // 浏览器桌面通知（如果用户开启了浏览器通知）
        showBrowserNotification(n.title, n.message);
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
      // V6.15: WebRTC 通话/语音房信令（私聊 rtc:* 与群语音房 rtc:group:* 全部转发给聊天模块）
      if (msg.type && msg.type.indexOf('rtc:') === 0) {
        if (typeof handleChatMessage === 'function') handleChatMessage(msg);
      }
      // V6.14: 群组 VRChat 成员在线状态实时同步（加入/离开/上下线）
      if (msg.type === 'group:roster_update' && typeof applyRosterUpdate === 'function') {
        applyRosterUpdate(msg);
      }
      // F-19: VRChat 官方通知实时推送（pipeline 接收后广播）。
      // 系统 VRChat 账号归站点运营方所有，通知只对管理员弹提示，普通用户静默忽略。
      if (msg.type === 'vrc_notification' && msg.notification) {
        const n = msg.notification;
        if (currentUser && (currentUser.role === 'admin' || currentUser.role === 'super_admin')) {
          const notifPanel = document.getElementById('notificationPanel');
          if (!notifPanel || !notifPanel.classList.contains('show')) {
            toast('🎮 ' + (n.title || n.senderUsername || __('main.vrc_notif', 'VRChat 通知')), 'info', 5000);
          }
          playNotificationSound();
          showBrowserNotification(n.title || __('main.vrc_notif', 'VRChat 通知'), n.message || '');
        }
      }
      // F-10: 系统账号收到的 VRChat 实例邀请 / 好友申请实时提示（管理员可见，语义同 F-19）
      if ((msg.type === 'vrc_invite' || msg.type === 'vrc_friend_request') && msg.notification) {
        const n = msg.notification;
        if (currentUser && (currentUser.role === 'admin' || currentUser.role === 'super_admin')) {
          const label = __(msg.type === 'vrc_invite' ? 'main.vrc_invite_notif' : 'main.vrc_friendreq_notif');
          const notifPanel = document.getElementById('notificationPanel');
          if (!notifPanel || !notifPanel.classList.contains('show')) {
            toast('🎮 ' + (n.senderUsername || n.title || '') + ' · ' + label, 'info', 5000);
          }
          playNotificationSound();
        }
      }
    } catch (err) {
      // 消息处理异常不再静默吞掉：保留可诊断性（单条消息异常不影响后续消息）
      // eslint-disable-next-line no-console
      console.warn('WS 消息处理异常:', err && err.message ? err.message : err);
    }
  };
  wsClient.onclose = (ev) => {
    clearInterval(wsPingTimer);
    // §31：若连接从未成功建立（onopen 未触发）即被关闭，通常是 verifyClient 因
    // 「会话 cookie 缺失/不同源」返回 401。已登录用户遇到此情况多为访问入口
    // （127.0.0.1 直连 vs localhost 经 nginx）与登录入口不一致导致 cookie 不互通，
    // 提示重新登录以重建同源会话，而不是静默失败。
    if (!wsEverOpened && currentUser && typeof toast === 'function') {
      toast(__('main.ws_auth_failed') || __('auto_main_5'), 'warn', 5000);
    }
    if (wsReconnectAttempts < WS_MAX_RECONNECT) {
      wsReconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, wsReconnectAttempts - 1), 30000);
      wsReconnectTimer = setTimeout(connectWebSocket, delay);
    } else {
      // 短周期重连耗尽后进入长周期探测模式：每 WS_LONG_BACKOFF 试探一次，
      // 网络恢复即可自动重连，不再永久停止（避免__('auto_main_6')的死状态）。
      if (!wsLongBackoff) {
        wsLongBackoff = true;
        console.warn(__('auto_main_7') + (WS_LONG_BACKOFF / 1000) + __('auto_main_8'));
      }
      wsReconnectTimer = setTimeout(connectWebSocket, WS_LONG_BACKOFF);
    }
  };
  wsClient.onerror = () => {
    // 握手失败（如 401 未认证）浏览器只报 generic error，无法读取状态码；
    // 真正的原因将由上面的 onclose(!wsEverOpened) 提示。
    wsClient?.close();
  };
}

// 点击在线人数展示在线成员列表
function showOnlineUsers() {
  // 以 WS 推来的实际名单为准，而不是去读某个 DOM 元素的文字：
  // 读 DOM 会把__('auto_main_9')解析成 0，导致列表明明有人却提示__('auto_main_10')。
  const count = Array.isArray(onlineUsersList) ? onlineUsersList.length : 0;
  if (count === 0) { toast(__('group.no_online'), 'info'); return; }
  const html = onlineUsersList.map(u => {
    // P1-1: esc() 把 ' 转成 &#39;，浏览器在 HTML 属性中会先解码实体再执行 JS，
    // userId 含 ' 即可逃逸字符串字面量注入任意代码 → XSS。改用 escJsStr 包裹单引号字符串，
    // 转义后即使被 HTML 实体解码也仍是合法 JS 字符串字面量，无法逃逸。
    const userId = `'${escJsStr(String(u.userId))}'`;
    const avatarSrc = u.avatarUrl ? escAttr(u.avatarUrl) : '/api/avatar/default';
    const displayName = esc(u.displayName || __('main.unknown_user'));
    const isMe = u.userId === currentUser?.id;
    const clickHandler = !isMe ? `goToProfile(${userId})` : '';
    return `
    <div class="online-user-popup-item" style="${!isMe ? 'cursor:pointer' : ''}" onclick="${clickHandler ? `goToProfile(${userId})` : ''}">
      <img src="${avatarSrc}" class="online-user-popup-avatar" loading="lazy" onerror="window.__avatarFail&&window.__avatarFail(this,'${escJsStr(u.avatarUrl || '/api/avatar/default')}')">
      <span class="online-user-popup-name">${displayName}</span>
      ${isMe ? '<span class="text-muted2 text-11">' + __('main.me') + '</span>' : ''}
      <span class="online-user-popup-dot" title="${__('main.online')}" aria-label="${__('main.online')}"></span>
    </div>`;
  }).join('');
  // 弹窗按需创建。这里原本写成
  //   getElementById(...) || {style:{},querySelector:()=>null} || (() => { ...创建... })()
  // 中间那个对象字面量恒为真，短路后真正负责创建弹窗的 IIFE 永远不会执行，
  // 于是下一行取 #onlineUsersCount 拿到 null，抛 "Cannot set properties of null"，
  // 表现就是点「在线」完全没反应。
  let modal = document.getElementById('onlineUsersModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'onlineUsersModal';
    modal.className = 'modal';
    modal.innerHTML = `<div class="modal-content" style="max-width:380px">
      <h3 class="section-title">${__('main.online_users')} <span id="onlineUsersCount" class="text-accent"></span></h3>
      <div id="onlineUsersBody" class="online-users-body"></div>
      <div class="modal-actions"><button class="btn" onclick="closeModal('onlineUsersModal')">${__('main.close')}</button></div>
    </div>`;
    document.body.appendChild(modal);
  }
  const countEl = modal.querySelector('#onlineUsersCount');
  if (countEl) countEl.textContent = count;
  const body = modal.querySelector('#onlineUsersBody');
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
    // 动态图片点击（事件委托）
    const postImg = e.target.closest('.post-media-img');
    if (postImg && typeof showPostMediaViewer === 'function') {
      const postId = parseInt(postImg.dataset.postId);
      const idx = parseInt(postImg.dataset.idx);
      if (!isNaN(postId) && !isNaN(idx)) {
        showPostMediaViewer(postId, idx);
        return;
      }
    }

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
    if (userMenu && isElVisible(userMenu) &&
        !userMenu.contains(e.target) && e.target !== userAvatar && !userAvatar?.contains(e.target)) {
      // 走 hideUserMenu 而不是直接改 style，才能同步 aria-expanded 和键盘监听
      if (typeof hideUserMenu === 'function') hideUserMenu(); else userMenu.classList.add('d-none');
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
  const scrollTopBtn = document.getElementById('scrollTopBtn');
  if (scrollTopBtn) {
    if (window._backToTopHandler) window.removeEventListener('scroll', window._backToTopHandler);
    window._backToTopHandler = function() {
      if (window.scrollY > 300) {
        scrollTopBtn.classList.add('show');
      } else {
        scrollTopBtn.classList.remove('show');
      }
    };
    window.addEventListener('scroll', window._backToTopHandler);
  }

  // 标签切换时滚动到顶部（通过 addEventListener 绑定，不覆盖 onclick）
  const tabs = document.querySelectorAll('.tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', function() {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

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
        const cateId = parseInt(document.getElementById('albumCate')?.value || 1);
        for (let i = 0; i < e.target.files.length; i++) {
          uploadPhoto(e.target.files[i], '', cateId);
        }
        e.target.value = '';
      }
    });
  }

  // 活动照片上传 → 直接调用uploadPhoto上传到相册并关联活动
  const evtPhotoUpload = document.getElementById('evtPhotoUpload');
  if (evtPhotoUpload) {
    evtPhotoUpload.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length) {
        const eventId = window._currentEventId;
        const cateId = parseInt(document.getElementById('albumCate')?.value || 1);
        for (let i = 0; i < e.target.files.length; i++) {
          uploadPhoto(e.target.files[i], '', cateId, eventId);
        }
        e.target.value = '';
      }
    });
  }

  // 登录框回车提交
  const loginIdEl = document.getElementById('loginId');
  if (loginIdEl) {
    // §11.8.3：输入账号即实时预览「本地 + VRChat」头像（防抖 350ms，避免每键都打接口）
    let _loginAvatarDebounce = null;
    loginIdEl.addEventListener('input', () => {
      clearTimeout(_loginAvatarDebounce);
      _loginAvatarDebounce = setTimeout(() => {
        if (typeof previewLoginAvatar === 'function') previewLoginAvatar(loginIdEl.value);
      }, 350);
    });
    // §11.8.3：点进密码框时按已填账号预览「本地 + VRChat」头像
    const loginPwdEl = document.getElementById('loginPassword');
    if (loginPwdEl) {
      loginPwdEl.addEventListener('focus', () => {
        const val = loginIdEl.value.trim();
        if (val && typeof previewLoginAvatar === 'function') previewLoginAvatar(val);
      });
    }
  }
  // 验证码输入加固：只保留数字与连字符（OTP 形如 1234-5678），限长 10 位。
  // 防止浏览器/密码管理器自动填充、输入法候选把纯数字串拼乱（用户反馈偶发"数字倒序"）。
  ['loginVrcCode', 'vrcBind2faCode', 'vrc2faCode', 'sysVrc2faCode'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', () => {
        const clean = el.value.replace(/[^\d-]/g, '').slice(0, 10);
        if (el.value !== clean) el.value = clean;
      });
    }
  });
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
        container.innerHTML = '<div class="text-muted text-12 p-12 text-center">' + __('main.no_results') + '</div>';
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
  } catch { container.innerHTML = '<div class="text-muted text-12 p-8">' + __('main.search_failed') + '</div>'; }
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
            if (img) { img.src = data.url; img.classList.remove('d-none'); }
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
  const d = window._currentEventDetail;
  if (d && parseInt(d.id) === parseInt(eventId) && d.ended) { toast(__('events.ended_no_operate'), 'error'); return; }
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
  const d = window._currentEventDetail;
  if (d && parseInt(d.id) === parseInt(eventId) && d.ended) { toast(__('events.ended_no_operate'), 'error'); return; }
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
// 客户端图片压缩（P1: images-media 技能）——上传前用 canvas 压缩，降低流量与耗时；失败则回退原图
async function compressImageFile(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(objectUrl);
      let w = img.naturalWidth, h = img.naturalHeight;
      if (w > maxDim || h > maxDim) {
        const scale = maxDim / Math.max(w, h);
        w = Math.round(w * scale); h = Math.round(h * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob(function (blob) {
        if (!blob) return reject(new Error(__('common.canvas_blob_empty')));
        resolve(blob);
      }, 'image/jpeg', quality);
    };
    img.onerror = function () { URL.revokeObjectURL(objectUrl); reject(new Error(__('common.image_decode_failed'))); };
    img.src = objectUrl;
  });
}

async function uploadPhoto(file, caption = '', cateId = null, eventId = null) {
  if (!file) return;
  if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) { toast(__('main.select_media'), 'error'); return; }

  // 上传前体积预校验（与服务端 multer limits 对齐：album 上传上限 500MB）
  const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
  if (file.size > MAX_UPLOAD_BYTES) {
    toast(__('main.file_too_large', { size: '500MB' }), 'error');
    return;
  }
  // 友好提示：图片 >80MB 会先经客户端压缩；超大文件提醒用户网络耗时
  if (file.type.startsWith('image/') && file.size > 80 * 1024 * 1024) {
    toast(__('main.image_compressing'), 'info');
  }

  // 显示进度条
  const progressWrap = document.getElementById('uploadProgress');
  const progressText = document.getElementById('uploadProgressText');
  const progressPercent = document.getElementById('uploadProgressPercent');
  const progressFill = document.getElementById('uploadProgressFill');
  const progressFile = document.getElementById('uploadProgressFile');

  if (progressWrap) progressWrap.classList.remove('d-none');
  if (progressWrap) progressWrap.classList.add('active');
  if (progressText) progressText.textContent = __('main.uploading');
  if (progressPercent) progressPercent.textContent = '0%';
  if (progressFill) progressFill.style.width = '0%';
  if (progressFile) progressFile.textContent = file.name;

  // 图片先尝试客户端压缩（视频与压缩失败均回退原文件）
  let uploadFile = file;
  if (file.type && file.type.startsWith('image/')) {
    try {
      const compressed = await compressImageFile(file, 1920, 0.85);
      if (compressed && compressed.size < file.size) uploadFile = compressed;
    } catch (e) {
      uploadFile = file;
    }
  }
  const formData = new FormData();
  formData.append('photo', uploadFile, file.name);
  if (caption) formData.append('caption', caption);
  if (cateId) formData.append('cateId', cateId);
  if (eventId) formData.append('eventId', eventId);
  try {
    const res = await uploadWithProgress('/api/album/upload', formData, function(percent) {
      if (progressPercent) progressPercent.textContent = percent + '%';
      if (progressFill) progressFill.style.width = percent + '%';
      if (progressText) progressText.textContent = percent < 100 ? __('main.uploading') : __('main.processing');
    });
    if (res.ok) {
      const data = await res.json();
      var isVideo = data.mediaType === 'video';
      toast(isVideo ? __('global.video_uploaded') : __('main.photo_uploaded'), 'success');
      if (typeof loadAlbum === 'function') loadAlbum();
      // 如果在活动详情弹窗里，重新加载活动照片
      if (eventId && typeof loadEventPhotos === 'function') {
        setTimeout(function() { loadEventPhotos(eventId); }, 300);
      }
    } else {
      const data = await res.json().catch(() => ({}));
      toast(errText(data) || __('main.upload_failed'), 'error');
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
  // 数据库可用性自检：若当前 MySQL 不可达，先探测 .env 是否缺失/损坏——
  //  .env 缺失或缺少必需项 → 跳「配置向导」重新填写 .env（自动备份原文件）
  //  .env 正常仅数据库不可达 → 跳「数据库连接恢复」页（脱离登录即可重连）
  // 已在恢复页 / 配置向导 / 迁移页时不重复跳转；网络异常（服务未起）也不跳，避免误伤。
  if (!['/db-recover.html', '/setup.html', '/migration.html'].includes(window.location.pathname)) {
    fetch('/api/system/db-status', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && d.ok === false) {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 5000);
          return fetch('/api/setup/check', { credentials: 'include', signal: controller.signal })
            .then((r) => (r.ok ? r.json() : null))
            .finally(() => clearTimeout(timer))
            .then((st) => {
              if (st && (st.configured === false || st.envValid === false)) {
                window.location.href = '/setup.html';
              } else {
                window.location.href = '/db-recover.html';
              }
            });
        }
      })
      .catch(() => {});
  }
});
