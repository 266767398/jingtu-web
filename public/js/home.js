// ==================== 首页模块 (Home Tab) ====================
// V1.0 — 显示统计概览、即将开始的活动、最新动态

let homeLoading = false;

// 首页统计条点击（事件委托）
// 原来这里绑的是 .home-quick-card —— 那块__('auto_home_1')九宫格与上方标签栏完全重复，
// 已整块移除，跳转能力并入统计条本身。
// __('auto_home_2')那一项不跳标签，而是弹出在线成员列表：这个入口原先挂在顶栏的__('auto_home_3')
// 和 Hero 统计卡片上，那两处都因重复被移除，功能移交到这里。
document.addEventListener('click', function(e) {
  // 首页 widget 自定义编辑态 / 恢复默认（原内联 onclick 迁移到委托）
  if (e.target.closest('#homeWidgetEditBtn')) { toggleHomeWidgetEdit(); return; }
  if (e.target.closest('#homeWidgetResetBtn')) { resetHomeWidgetLayout(); return; }
  // 精选照片「查看全部」直达相册
  if (e.target.closest('#homeViewAllBtn')) {
    if (typeof switchTab === 'function') switchTab('album');
    return;
  }
  // F-8 编辑态：显隐切换按钮（卡片内嵌的真按钮，不能放在 <button> 里所以编辑态卡片是 div）
  const wgtToggle = e.target.closest('.wgt-toggle');
  if (wgtToggle) {
    const card = wgtToggle.closest('[data-tab]');
    if (card) toggleWidgetHidden(card.dataset.tab);
    return;
  }
  // 功能导航卡片：点击直接进入对应模块（首页__('auto_home_4')的核心交互）
  const feat = e.target.closest('.home-feature-card');
  if (feat) {
    // 编辑态下点击卡片不跳转（此时卡片用于拖拽排序）
    if (feat.classList.contains('editing')) return;
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
    { tab: 'vrc', icon: '🎮' },
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

// ==================== F-8 首页 widget 自定义（拖拽排序 + 显隐 + 持久化） ====================
// 排序/显隐仅存 localStorage（个人显示偏好，不动服务端）；HOME_DISABLED_FEATURES 与
// 管理员判定始终是硬过滤——用户只能隐藏自己可见的入口，不能借自定义「解锁」被禁功能。
const HOME_LAYOUT_KEY = 'home_widget_layout_v1';
let homeWidgetEditing = false;
let homeLayout = null; // { order: ['members', ...], hidden: ['chat', ...] }

// 展开为扁平列表（含 cat 分类标记），管理员入口按角色动态附加
function defaultFeatureItems() {
  const items = [];
  FEATURE_GROUPS.forEach(function (g) {
    g.items.forEach(function (it) { items.push({ tab: it.tab, icon: it.icon, cat: g.cat }); });
  });
  if (currentUser && (currentUser.role === 'admin' || currentUser.role === 'super_admin')) {
    items.push({ tab: FEATURE_ADMIN.tab, icon: FEATURE_ADMIN.icon, cat: 'admin' });
  }
  return items;
}

function loadHomeLayout() {
  const items = defaultFeatureItems();
  const defOrder = items.map(function (i) { return i.tab; });
  const known = new Set(defOrder);
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(HOME_LAYOUT_KEY) || 'null'); } catch (_) { saved = null; }
  // 只接受当前真实存在的 tab：下线功能的旧排序/隐藏记录自动失效
  let order = (saved && Array.isArray(saved.order)) ? saved.order.filter(function (t) { return known.has(t); }) : defOrder.slice();
  // 版本迭代新增的功能入口追加到末尾，保证不会「消失」
  defOrder.forEach(function (t) { if (order.indexOf(t) === -1) order.push(t); });
  const hidden = (saved && Array.isArray(saved.hidden)) ? saved.hidden.filter(function (t) { return known.has(t); }) : [];
  homeLayout = { order: order, hidden: hidden };
}

function saveHomeLayout() {
  try { localStorage.setItem(HOME_LAYOUT_KEY, JSON.stringify(homeLayout)); } catch (_) { /* 隐私模式等场景静默失败 */ }
}

function resetHomeWidgetLayout() {
  try { localStorage.removeItem(HOME_LAYOUT_KEY); } catch (_) {}
  loadHomeLayout();
  renderFeatureGrid();
}

function toggleHomeWidgetEdit() {
  homeWidgetEditing = !homeWidgetEditing;
  if (homeWidgetEditing && !homeLayout) loadHomeLayout();
  const btn = document.getElementById('homeWidgetEditBtn');
  const resetBtn = document.getElementById('homeWidgetResetBtn');
  if (btn) {
    btn.textContent = homeWidgetEditing ? __('home.widget_done') : __('home.widget_edit');
    btn.setAttribute('aria-pressed', homeWidgetEditing ? 'true' : 'false');
  }
  if (resetBtn) resetBtn.style.display = homeWidgetEditing ? '' : 'none';
  renderFeatureGrid();
}

function toggleWidgetHidden(tab) {
  if (!homeLayout || !tab) return;
  const i = homeLayout.hidden.indexOf(tab);
  if (i >= 0) homeLayout.hidden.splice(i, 1); else homeLayout.hidden.push(tab);
  saveHomeLayout();
  renderFeatureGrid();
}

// 拖拽换位：编辑态卡片之间以 drop 目标为锚点重排 order 数组
function bindHomeWidgetDnD(container) {
  let dragTab = null;
  container.addEventListener('dragstart', function (e) {
    const card = e.target.closest('.home-feature-card.editing');
    if (!card || !homeWidgetEditing) { e.preventDefault(); return; }
    dragTab = card.dataset.tab;
    card.classList.add('dragging');
    try { e.dataTransfer.setData('text/plain', dragTab); } catch (_) {}
    e.dataTransfer.effectAllowed = 'move';
  });
  container.addEventListener('dragend', function () {
    dragTab = null;
    container.querySelectorAll('.home-feature-card.dragging').forEach(function (c) { c.classList.remove('dragging'); });
  });
  container.addEventListener('dragover', function (e) {
    if (!homeWidgetEditing || !dragTab) return;
    const card = e.target.closest('.home-feature-card.editing');
    if (!card || card.dataset.tab === dragTab) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  });
  container.addEventListener('drop', function (e) {
    if (!homeWidgetEditing || !dragTab) return;
    const card = e.target.closest('.home-feature-card.editing');
    if (!card) return;
    e.preventDefault();
    const targetTab = card.dataset.tab;
    if (targetTab === dragTab) return;
    const order = homeLayout.order;
    const from = order.indexOf(dragTab);
    const to = order.indexOf(targetTab);
    if (from < 0 || to < 0) return;
    order.splice(from, 1);
    const idx = order.indexOf(targetTab);
    order.splice(from < to ? idx + 1 : idx, 0, dragTab);
    saveHomeLayout();
    renderFeatureGrid();
  });
}

function featureCardHtml(it, opts) {
  const title = __('nav.' + it.tab);
  const desc = __('home.feature_desc_' + it.tab);
  const editing = opts && opts.editing;
  const isHidden = opts && opts.hidden;
  if (editing) {
    // 编辑态：div + draggable（卡片本身不是按钮，避免 button 嵌套 button）
    return '<div class="home-feature-card editing' + (isHidden ? ' is-hidden' : '') + '" data-tab="' + escAttr(it.tab) + '" draggable="true" aria-label="' + escAttr(title) + '">'
      + '<span class="home-feature-icon">' + it.icon + '</span>'
      + '<span class="home-feature-body">'
      + '<span class="home-feature-title">' + esc(title) + '</span>'
      + '<span class="home-feature-desc">' + esc(desc) + '</span>'
      + '</span>'
      + '<button type="button" class="wgt-toggle" data-toggle-tab="' + escAttr(it.tab) + '" title="' + escAttr(isHidden ? __('home.widget_show') : __('home.widget_hide')) + '" aria-label="' + escAttr(__('nav.' + it.tab) + ' · ' + (isHidden ? __('home.widget_show') : __('home.widget_hide'))) + '">' + (isHidden ? '🚫' : '👁️') + '</button>'
      + '</div>';
  }
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
  if (!homeLayout) loadHomeLayout();
  const items = defaultFeatureItems();
  const map = {};
  items.forEach(function (it) { map[it.tab] = it; });
  // 用户排序优先；order 里不存在的入口（理论上 loadHomeLayout 已兜底）追加到末尾双保险
  const ordered = homeLayout.order.map(function (t) { return map[t]; }).filter(Boolean);
  items.forEach(function (it) { if (ordered.indexOf(it) === -1) ordered.push(it); });

  container.classList.toggle('editing', homeWidgetEditing);
  if (!container._wgtDnDBound) { bindHomeWidgetDnD(container); container._wgtDnDBound = true; }

  // 分类标题跟随排序「连续段」出现：跨分类拖动后，同分类卡片自动聚合成一组
  let html = '';
  let lastCat = null;
  ordered.forEach(function (it) {
    // feature gate（如直播）：无论什么状态都硬过滤
    if (HOME_DISABLED_FEATURES.has(it.tab)) return;
    const isHidden = homeLayout.hidden.indexOf(it.tab) >= 0;
    if (isHidden && !homeWidgetEditing) return;
    if (it.cat !== lastCat) {
      if (lastCat !== null) html += '</div></div>';
      html += '<div class="home-feature-group"><div class="home-feature-cat">' + esc(__('home.feature_cat_' + it.cat)) + '</div><div class="home-feature-cards">';
      lastCat = it.cat;
    }
    html += featureCardHtml(it, { editing: homeWidgetEditing, hidden: isHidden });
  });
  if (lastCat !== null) html += '</div></div>';
  if (!html) html = '<div class="home-feature-empty">' + esc(__('home.widget_empty')) + '</div>';
  container.innerHTML = html;
}

// 首页各区块独立加载，避免单个慢接口阻塞整个页面渲染
function loadBlock(name, loader, ms) {
  return Promise.race([
    loader(),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error(name + ' timeout')), ms))
  ]).catch(e => {
    console.warn('[home load]', name, e.message || e);
    // 失败不能静默：清掉骨架占位并提示，避免区块永久处于加载态
    const containerMap = { events: 'homeUpcomingEvents', posts: 'homeLatestPosts', photos: 'homeFeaturedPhotos' };
    const cid = containerMap[name];
    if (cid) {
      const c = document.getElementById(cid);
      if (c) renderEmpty(c, { icon: '⚠️', text: __('load_failed') });
    }
    if (name === 'stats') resetDashboardSkeletons();
    toast(__('load_failed'), 'error');
  });
}

// 统计位失败兜底：移除 skeleton-stat 骨架类并落占位值，防止数字区域永久处于骨架态
function resetDashboardSkeletons() {
  ['dashMembers', 'dashOnline', 'dashEvents', 'dashPhotos', 'dashPosts'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.textContent = '-';
      el.classList.remove('skeleton-stat');
    }
  });
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
    if (!res.ok) {
      // 匿名兜底也失败：清除骨架并落占位值，避免统计位永久处于 loading 态
      resetDashboardSkeletons();
      return;
    }
    const data = await res.json();
    updateDashboardValue('dashMembers', data.totalUsers || 0);
    updateDashboardValue('dashOnline', data.onlineCount || 0);
    updateDashboardValue('dashEvents', data.totalEvents || 0);
    updateDashboardValue('dashPhotos', data.totalPhotos || 0);
    updateDashboardValue('dashPosts', data.totalPosts || 0);
  } catch {
    resetDashboardSkeletons();
  }
}

function updateDashboardValue(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  const next = typeof value === 'number' ? value : null;
  el.classList.remove('skeleton-stat');
  if (next === null) { el.textContent = value; return; }
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const from = parseInt(el.textContent.replace(/[^0-9]/g, '') || '0', 10);
  if (reduce || from === next) {
    el.textContent = next.toLocaleString(getCurrentLang ? getCurrentLang() : 'zh');
    return;
  }
  const dur = 600;
  const start = performance.now();
  function tick(now) {
    const t = Math.min((now - start) / dur, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    const cur = Math.round(from + (next - from) * eased);
    el.textContent = cur.toLocaleString(getCurrentLang ? getCurrentLang() : 'zh');
    if (t < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
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
      av.innerHTML = '<img src="' + escAttr(currentUser.avatarUrl) + '" alt="" onerror="window.__avatarFail&&window.__avatarFail(this,\'' + escJsStr(currentUser.avatarUrl) + '\')">';
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
        <img class="post-mini-avatar" src="${escAttr(avatar || '/api/avatar/default')}" alt="" onerror="window.__avatarFail&&window.__avatarFail(this,'${escJsStr(avatar || '/api/avatar/default')}')" loading="lazy">
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
let _greetingTimer = null;
(function setupGreetingLiveRefresh() {
  if (document.hidden === undefined) return;
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) updateGreeting();
  });
  _greetingTimer = setInterval(updateGreeting, 60000);
  // 空闲冻结：暂停/恢复问候刷新定时器（见 freeze.js）
  if (window.__freeze && typeof window.__freeze.register === 'function') {
    window.__freeze.register({
      onFreeze: function () { if (_greetingTimer) { clearInterval(_greetingTimer); _greetingTimer = null; } },
      onUnfreeze: function () {
        if (!_greetingTimer) {
          updateGreeting(); // 解冻立即刷新一次，跨时段问候即时生效
          _greetingTimer = setInterval(updateGreeting, 60000);
        }
      }
    });
  }
})();
