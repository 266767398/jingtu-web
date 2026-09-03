// ==================== 首页模块 (Home Tab) ====================
// V1.0 — 显示统计概览、即将开始的活动、最新动态

let homeLoading = false;

// 首页统计条点击（事件委托）
// 原来这里绑的是 .home-quick-card —— 那块__('auto_home_1')九宫格与上方标签栏完全重复，
// 已整块移除，跳转能力并入统计条本身。
// __('auto_home_2')那一项不跳标签，而是弹出在线成员列表：这个入口原先挂在顶栏的__('auto_home_3')
// 和 Hero 统计卡片上，那两处都因重复被移除，功能移交到这里。
document.addEventListener('click', function(e) {
  // 功能导航卡片：点击直接进入对应模块（首页__('auto_home_4')的核心交互）
  const feat = e.target.closest('.home-feature-card');
  if (feat) {
    const tab = feat.dataset.tab;
    if (tab && typeof switchTab === 'function') switchTab(tab);
    return;
  }
  // 首页「加入社群」CTA：点击按钮直达对应模块
  const cta = e.target.closest('.home-cta [data-tab]');
  if (cta) {
    const tab = cta.getAttribute('data-tab');
    if (tab && typeof switchTab === 'function') switchTab(tab);
    return;
  }
  const item = e.target.closest('.home-stat-bar .hs-item');
  if (!item) return;
  if (item.dataset.action === 'online') {
    if (typeof showOnlineUsers === 'function') showOnlineUsers();
    return;
  }
  const tab = item.getAttribute('data-tab');
  if (!tab) return;
  // 从统计条点__('auto_home_5')时显示全部活动，而不是默认的__('auto_home_6')（避免有统计数字但点进去空白）
  if (tab === 'events' && typeof currentEvtStatus !== 'undefined') currentEvtStatus = 'all';
  if (typeof switchTab === 'function') switchTab(tab);
});

// ==================== 首页功能导航（模块展示入口） ====================
// 按分类聚合全部功能模块，渲染为图标卡片网格，让用户一眼浏览、一键进入。
// 图标复用顶栏 tab 的 emoji；标题复用 nav.*（已多语言）；描述用 home.feature_desc.*。
const FEATURE_GROUPS = [
  { cat: 'community', items: [
    { tab: 'members', icon: '👥' },
    { tab: 'group', icon: '🎮' },
    { tab: 'chat', icon: '💬' },
    { tab: 'friends', icon: '🤝' },
    { tab: 'follows', icon: '➕' },
    { tab: 'announcements', icon: '📢' },
  ]},
  { cat: 'content', items: [
    { tab: 'posts', icon: '📝' },
    { tab: 'album', icon: '🖼️' },
    { tab: 'live', icon: '📺' },
    { tab: 'events', icon: '📅' },
  ]},
  { cat: 'discover', items: [
    { tab: 'map', icon: '🗺️' },
    { tab: 'birthday', icon: '🎂' },
    { tab: 'collections', icon: '📚' },
  ]},
  { cat: 'personal', items: [
    { tab: 'notifications', icon: '🔔' },
    { tab: 'me', icon: '👤' },
  ]},
];
const FEATURE_ADMIN = { tab: 'admin', icon: '⚙️' };

// 2026-08-31：与 loader.js 的 DISABLED_FEATURES 保持同步。
// 这里仅用于首页功能网格的「不展示」过滤；运行时安全由 loader.js 的 switchTab 拦截兜底。
const HOME_DISABLED_FEATURES = new Set(['live']);

function featureCardHtml(it) {
  const title = __('nav.' + it.tab);
  const desc = __('home.feature_desc_' + it.tab);
  return '<button type="button" class="home-feature-card" data-tab="' + escAttr(it.tab) + '"'
    + ' data-ripple aria-label="' + escAttr(title) + '">'
    + '<span class="home-feature-icon">' + it.icon + '</span>'
    + '<span class="home-feature-body">'
    + '<span class="home-feature-title">' + esc(title) + '</span>'
    + '<span class="home-feature-desc">' + esc(desc) + '</span>'
    + '</span>'
    + '<span class="home-feature-arrow" aria-hidden="true">›</span>'
    + '</button>';
}

function renderFeatureGrid() {
  const container = document.getElementById('homeFeatureGrid');
  if (!container) return;
  let html = '';
  FEATURE_GROUPS.forEach(function (group) {
    html += '<div class="home-feature-group">';
    html += '<div class="home-feature-cat">' + esc(__('home.feature_cat_' + group.cat)) + '</div>';
    html += '<div class="home-feature-cards">';
    group.items.forEach(function (it) {
      // 过滤掉已被禁用（feature gate）的入口（如直播）
      if (HOME_DISABLED_FEATURES.has(it.tab)) return;
      html += featureCardHtml(it);
    });
    html += '</div></div>';
  });
  // 管理后台：仅对管理员展示（与 ui.js 的 .admin-only 判定保持一致）
  if (currentUser && (currentUser.role === 'admin' || currentUser.role === 'super_admin')) {
    html += '<div class="home-feature-group">';
    html += '<div class="home-feature-cat">' + esc(__('home.feature_cat_admin')) + '</div>';
    html += '<div class="home-feature-cards">' + featureCardHtml(FEATURE_ADMIN) + '</div></div>';
  }
  container.innerHTML = html;
}

// 首页各区块独立加载，避免单个慢接口阻塞整个页面渲染
function loadBlock(name, loader, ms) {
  return Promise.race([
    loader(),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error(name + ' timeout')), ms))
  ]).catch(e => { console.warn('[home load]', name, e.message || e); });
}

async function loadHome() {
  if (homeLoading) return;
  homeLoading = true;
  try {
    updateGreeting();
    renderFeatureGrid();
    await Promise.all([
      loadBlock('stats', loadDashboardStats, 15000),
      loadBlock('events', loadHomeUpcomingEvents, 15000),
      loadBlock('posts', loadHomeLatestPosts, 15000),
      loadBlock('photos', loadHomeFeaturedPhotos, 15000)
    ]);
  } finally {
    homeLoading = false;
  }
}

async function loadDashboardStats() {
  if (!currentUser) {
    await loadPublicDashboardStats();
    return;
  }
  try {
    const res = await api('/api/stats', { method: 'GET' });
    if (!res.ok) {
      await loadPublicDashboardStats();
      return;
    }
    const data = await res.json();
    updateDashboardValue('dashMembers', data.members || 0);
    updateDashboardValue('dashOnline', data.online || 0);
    updateDashboardValue('dashEvents', data.events || 0);
    updateDashboardValue('dashPhotos', data.photos || 0);
    updateDashboardValue('dashPosts', data.posts || 0);
    updateDashboardTrend('dashMembersTrend', data.memberGrowth);
  } catch (err) {
    if (!isApiHandledError(err)) {
      await loadPublicDashboardStats();
    }
  }
}

async function loadPublicDashboardStats() {
  try {
    const res = await api('/api/public/stats', { method: 'GET' });
    if (!res.ok) return;
    const data = await res.json();
    updateDashboardValue('dashMembers', data.totalUsers || 0);
    updateDashboardValue('dashOnline', data.onlineCount || 0);
    updateDashboardValue('dashEvents', data.totalEvents || 0);
    updateDashboardValue('dashPhotos', data.totalPhotos || 0);
    updateDashboardValue('dashPosts', data.totalPosts || 0);
  } catch {}
}

function updateDashboardValue(id, value) {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = typeof value === 'number' ? value.toLocaleString() : value;
    el.classList.remove('skeleton-stat');
  }
}

function updateDashboardTrend(id, growthData) {
  const el = document.getElementById(id);
  if (!el || !growthData || !Array.isArray(growthData)) {
    el.innerHTML = '';
    return;
  }
  const todayCount = growthData.length > 0 ? growthData[growthData.length - 1].count : 0;
  const yesterdayCount = growthData.length > 1 ? growthData[growthData.length - 2].count : 0;
  const diff = todayCount - yesterdayCount;
  if (diff > 0) {
    el.className = 'dashboard-trend up';
    el.textContent = `+${diff}`;
  } else if (diff < 0) {
    el.className = 'dashboard-trend down';
    el.textContent = `${diff}`;
  } else {
    el.className = 'dashboard-trend steady';
    el.textContent = '-';
  }
}

function updateGreeting() {
  const el = document.getElementById('homeGreeting');
  if (el) {
    const hour = new Date().getHours();
    let greeting = '';
    if (hour < 6) greeting = __('home.greeting_night');
    else if (hour < 12) greeting = __('home.greeting_morning');
    else if (hour < 14) greeting = __('home.greeting_noon');
    else if (hour < 18) greeting = __('home.greeting_afternoon');
    else greeting = __('home.greeting_evening');
    el.textContent = greeting;
  }
  // 欢迎卡头像：登录用户显示其头像，未登录显示默认人像
  const av = document.getElementById('homeWelcomeAvatar');
  if (av) {
    if (currentUser && currentUser.avatarUrl) {
      av.innerHTML = '<img src="' + escAttr(currentUser.avatarUrl) + '" alt="" onerror="this.style.display=\'none\'">';
    } else {
      av.textContent = '👤';
    }
  }
}

// 无结束时间的活动，按默认时长（3 小时）估算结束点。
// 否则创建时未填结束时间的活动将永远停留在「进行中/首页」，造成__('auto_home_7')的问题。
const EVENT_DEFAULT_DURATION_MS = 3 * 60 * 60 * 1000;

// 计算单个活动的实时状态：进行中 / 即将开始 / 已结束（往期）
// 与后端 /api/events 的 status 过滤逻辑保持一致（以 event_time + ends_at 判定）
function getHomeEventStatus(e) {
  const start = new Date(e.time || e.eventTime || e.event_time);
  if (isNaN(start)) return 'unknown';
  const rawEnds = e.endsAt || e.ends_at;
  // endsAt 缺失时按开始时间 + 默认时长兜底，避免过去的无结束时间活动被误判为进行中
  const ends = rawEnds ? new Date(rawEnds) : new Date(start.getTime() + EVENT_DEFAULT_DURATION_MS);
  const now = new Date();
  if (now > ends) return 'past';
  if (now < start) return 'upcoming';
  return 'ongoing';
}

async function loadHomeUpcomingEvents() {
  const container = document.getElementById('homeUpcomingEvents');
  if (!container) return;
  showSkeleton(container, 'grid', 2);
  try {
    const res = await api('/api/events?pageSize=6&isArchive=0', { method: 'GET' });
    if (!res.ok) {
      renderEmpty(container, { icon: '⚠️', text: __('load_failed') });
      return;
    }
    const data = await res.json();
    // 仅保留__('auto_home_8')与__('auto_home_9')的活动，过滤掉已结束/往期活动
    const allEvents = data.events || data || [];
    const activeEvents = allEvents.filter(e => {
      const s = getHomeEventStatus(e);
      return s === 'ongoing' || s === 'upcoming';
    });
    const events = activeEvents.slice(0, 3);
    if (events.length === 0) {
      renderEmpty(container, { text: __('home.no_upcoming') });
      return;
    }
    container.innerHTML = events.map(e => {
      const eventDate = new Date(e.time || e.eventTime || e.event_time);
      const status = getHomeEventStatus(e); // 'ongoing' | 'upcoming'
      const signedCount = e.signCount ?? e.signedCount ?? e.signed_count ?? 0;
      const maxCount = e.maxSign ?? e.maxParticipants ?? e.max_participants ?? 0;
      const statusBadge = status === 'ongoing'
        ? `<span class="event-countdown ongoing">${__('events.ongoing')}</span>`
        : `<span class="event-countdown upcoming">${__('events.upcoming')}</span>`;
      return `<div class="event-card" onclick="switchTab('events')" style="cursor:pointer">
        <div class="event-time">📅 ${fmtDate(eventDate)}</div>
        <div style="font-weight:700;font-size:15px;margin-bottom:4px">${esc(e.title || e.event_title || '')}</div>
        <div class="flex-row gap-6 items-center">
          ${statusBadge}
          ${maxCount > 0 ? `<span class="sign-count">👥 ${signedCount}/${maxCount}</span>` : `<span class="sign-count">👥 ${signedCount}</span>`}
        </div>
        ${e.place ? `<div class="event-place">📍 ${esc(e.place)}</div>` : ''}
      </div>`;
    }).join('');
  } catch (err) {
    if (!isApiHandledError(err)) {
      renderEmpty(container, { icon: '⚠️', text: __('load_failed') });
    }
  }
}

async function loadHomeLatestPosts() {
  const container = document.getElementById('homeLatestPosts');
  if (!container) return;
  try {
    const res = await api('/api/posts?limit=3', { method: 'GET' });
    if (!res.ok) {
      container.innerHTML = '';
      return;
    }
    const data = await res.json();
    const posts = data.posts || data || [];
    if (posts.length === 0) {
      renderEmpty(container, { icon: '📝', text: __('posts.empty') });
      return;
    }
    container.innerHTML = posts.map(p => {
      const avatar = (p.user && p.user.avatarUrl) || p.avatarUrl || p.authorAvatar || '/api/avatar/default';
      const name = esc((p.user && p.user.name) || p.authorName || p.author_name || __('unknown_user'));
      const content = esc((p.content || '').substring(0, 100));
      return `<div class="post-mini-item" onclick="switchTab('posts')">
        <img class="post-mini-avatar" src="${avatar || '/api/avatar/default'}" alt="" onerror="this.src='/api/avatar/default'" loading="lazy">
        <div class="post-mini-body">
          <div class="post-mini-author">${name}</div>
          <div class="post-mini-content">${content}${(p.content || '').length > 100 ? '...' : ''}</div>
          <div class="post-mini-time">${fmtDate(p.createdAt || p.created_at)}</div>
        </div>
      </div>`;
    }).join('');
  } catch (err) {
    if (!isApiHandledError(err)) {
      container.innerHTML = '';
    }
  }
}

async function loadHomeFeaturedPhotos() {
  const container = document.getElementById('homeFeaturedPhotos');
  if (!container) return;
  try {
    const res = await api('/api/album/photos?page=1', { method: 'GET' });
    if (!res.ok) { container.innerHTML = ''; return; }
    const data = await res.json();
    const photos = (data.photos || []).slice(0, 6);
    if (photos.length === 0) {
      renderEmpty(container, { icon: '🖼️', text: __('home.no_photos') });
      return;
    }
    container.innerHTML = photos.map((p, i) => {
      const src = p.thumbnail || p.url;
      const alt = esc(p.caption || __('home.photo_alt'));
      const eager = i < 3 ? 'eager' : 'lazy';
      return '<a class="featured-photo" href="javascript:void(0)" onclick="switchTab(\'album\')">'
        + '<img src="' + escAttr(src) + '" alt="' + alt + '" loading="' + eager + '" onerror="this.src=\'/assets/group-avatar.svg\'">'
        + '</a>';
    }).join('');
  } catch (err) {
    if (!isApiHandledError(err)) container.innerHTML = '';
  }
}

// 问候语实时跟随用户电脑时间：回到前台 / 每分钟刷新一次，避免长时间挂机跨时段后仍显示旧问候
(function setupGreetingLiveRefresh() {
  if (document.hidden === undefined) return;
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) updateGreeting();
  });
  setInterval(updateGreeting, 60000);
})();
