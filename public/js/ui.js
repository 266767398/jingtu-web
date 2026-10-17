// ==================== UI 更新 ====================
// VRChat 头像加载策略（直连优先、代理兜底，2026-10-06）：
//   · 客户端优先直连 VRChat CDN（VRCX 同款）：api.vrchat.cloud / api.vrchat.com /
//     assets.vrchat.com 默认返回直连地址；assets.amlcdn.com 国内普遍被墙，保持代理优先。
//   · 直连失败 → 一次代理兜底（/api/avatar/proxy 走服务端 L1/L2 缓存与多源回源）；
//     代理成功记入 __avatarProxyCache，该 URL 15 分钟内代理优先，避免反复直连超时。
//   · 代理失败（服务端返回 502 占位，见 server/routes/avatar.js sendPlaceholder）
//     → 一次客户端直连；两条路都失败才落默认占位 + 60s 双 key 失败冷却。
const AVATAR_PROXY_TTL_MS = 15 * 60 * 1000; // 代理优先记忆 TTL，与 CDN 签名生命周期相当
const AVATAR_PROXY_MAX = 300; // 记忆上限（超出清空，仅加速优化）
const AVATAR_PROXY_PREFIX = '/api/avatar/proxy?u=';
const VRC_CDN_HOST_RE = /^(https?:\/\/)?(api\.vrchat\.(cloud|com)|assets\.(amlcdn|vrchat)\.com)\//i;
const AMLCDN_RE = /^https?:\/\/[^/]*assets\.amlcdn\.com\//i;
window.__avatarProxyCache = window.__avatarProxyCache || {};

// 若字符串是代理地址（/api/avatar/proxy?u=<enc>）则反解出原始直连 URL，否则返回 ''。
// 仅允许 VRChat CDN 白名单主机直连，避免把任意地址交给 <img>。
function avatarDirectOf(s) {
  if (!s || typeof s !== 'string') return '';
  const m = String(s).match(/\/api\/avatar\/proxy\?u=([^&]+)/);
  if (!m) return '';
  let decoded = '';
  try { decoded = decodeURIComponent(m[1]); } catch (e) { return ''; }
  return VRC_CDN_HOST_RE.test(decoded) ? decoded : '';
}
function avatarProxyRemember(proxiedKey) {
  if (!proxiedKey) return;
  window.__avatarProxyCache = window.__avatarProxyCache || {};
  window.__avatarProxyCache[proxiedKey] = Date.now();
  const keys = Object.keys(window.__avatarProxyCache);
  if (keys.length > AVATAR_PROXY_MAX) window.__avatarProxyCache = {};
}
function avatarProxyPreferred(proxiedKey) {
  return !!(window.__avatarProxyCache && window.__avatarProxyCache[proxiedKey] > Date.now() - AVATAR_PROXY_TTL_MS);
}

function proxyAvatar(url) {
  if (!url || typeof url !== 'string') return url;
  if (url.indexOf(AVATAR_PROXY_PREFIX) !== -1) {
    // 已是代理地址（后端 getAvatarUrl / WS 广播已改写）：默认反解回直连（直连优先）
    const direct = avatarDirectOf(url);
    if (!direct) return url;
    if (AMLCDN_RE.test(direct)) return url; // amlcdn 代理优先
    return avatarProxyPreferred(url) ? url : direct;
  }
  if (!VRC_CDN_HOST_RE.test(url)) return url;
  const proxied = AVATAR_PROXY_PREFIX + encodeURIComponent(url);
  if (AMLCDN_RE.test(url)) return proxied; // amlcdn 代理优先
  return avatarProxyPreferred(proxied) ? proxied : url; // 其余 CDN 直连优先
}
window.proxyAvatar = proxyAvatar;

// 头像加载失败处理：
//   1) 代理失败 → 反解原始 URL 做一次客户端直连（备选直连，VRCX 同款，无需记忆）；
//   2) 直连失败 → 一次代理兜底，代理成功记入 __avatarProxyCache（该 URL 代理优先）；
//   3) 两条路都失败 / 非 CDN 源 → 弃用记忆 + 默认占位 + 60s 双 key 失败冷却。
window.__avatarFailCache = window.__avatarFailCache || {};

// ==================== 头像失败自动重试器 ====================
// 背景：/api/avatar/user 依赖 VRChat 系统账号（或用户自身绑定）会话解析群成员头像，
// 会话被 VRChat 顶号/过期期间头像会落 502 占位；此前失效后必须手动刷新页面才恢复。
// 此重试器与 __avatarFail 的 60s 失败冷却联动：冷却到期后对仍保持失败状态的动态解析
// URL（/api/avatar/user|/api/avatar/proxy）自动重新加载，系统会话恢复后无需刷新即可出图。
// 限流：仅重试"动态接口"URL；同一 img 最多重试 4 次后放弃，避免对稳定失败的地址无限打请求。
const AVATAR_RETRY_INTERVAL_MS = 30000;   // 全局扫描周期
const AVATAR_RETRY_MIN_DELAY_MS = 65000;  // 首次重试至少晚于失败时间（覆盖 60s 冷却窗）
const AVATAR_RETRY_MAX = 4;               // 单个失败 URL 最大自动重试次数
window.__avatarRetryAt = window.__avatarRetryAt || {};          // url -> next retry ts
window.__avatarRetryCount = window.__avatarRetryCount || {};    // url -> attempts
window.__avatarRetryTimer = window.__avatarRetryTimer || null;

function avatarNeedsRetry(src) {
  if (!src || typeof src !== 'string') return false;
  return src.indexOf('/api/avatar/user?') !== -1 || src.indexOf('/api/avatar/proxy?') !== -1;
}

// 失败时登记自动重试（在 __avatarFail 最终兜底处调用）：
// 每次失败会刷新 __avatarFailCache[src]=now，登记据此把重试时刻设在"冷却窗口（60s）之后"，
// 这样重试只会在冷却结束后发生，不抢跑、不产生请求风暴。
window.__avatarRegisterRetry = function (src) {
  if (!avatarNeedsRetry(src)) return;
  const now = Date.now();
  const lastFail = window.__avatarFailCache[src] || 0;
  const attempts = window.__avatarRetryCount[src] || 0;
  if (attempts >= AVATAR_RETRY_MAX) return;
  // 冷却基准点：最近一次失败发生在冷却窗内则把基准平移到冷却结束；否则从当前起算
  const baseFail = (lastFail && now - lastFail < 60000) ? lastFail : now;
  const nextAt = baseFail + AVATAR_RETRY_MIN_DELAY_MS;
  const needEarlier = !window.__avatarRetryAt[src] || window.__avatarRetryAt[src] > nextAt;
  if (needEarlier) window.__avatarRetryAt[src] = nextAt;
  scheduleAvatarRetryScan();
};

function scheduleAvatarRetryScan() {
  if (window.__avatarRetryTimer) return;
  window.__avatarRetryTimer = setTimeout(avatarRetryScan, AVATAR_RETRY_INTERVAL_MS);
  window.__avatarRetryTimer.unref && window.__avatarRetryTimer.unref();
}

// 周期扫描：对所有登记的重试 URL，若到点则重设失败冷却并通过 DOM 图片重新加载。
// 不直接改 img.src（DOM 分散各处），而是清掉失败缓存后派发自定义事件，
// 由 group/members 各渲染处监听 __avatarRetryReady 事件重新触发懒加载。
// M4: 队列非空时单次 setTimeout 自调度，队列清空即停，避免全局定时器常驻空转。
function avatarRetryScan() {
  const now = Date.now();
  for (const src in window.__avatarRetryAt) {
    if (!Object.prototype.hasOwnProperty.call(window.__avatarRetryAt, src)) continue;
    if (window.__avatarRetryAt[src] > now) continue;
    delete window.__avatarRetryAt[src];
    // 到达重试时刻：如果仍然处于失败冷却，则强行将其视为可重试（冷却到期语义）
    delete window.__avatarFailCache[src];
    window.__avatarRetryCount[src] = (window.__avatarRetryCount[src] || 0) + 1;
    // 通知各渲染模块重新加载该 URL 对应的 img（自定义事件，detail 含原 URL）
    const evt = new CustomEvent('__avatarRetryReady', { detail: { src } });
    document.dispatchEvent(evt);
  }
  // 队列仍有条目（含未到期的）则自调度下一次扫描；空则停止
  window.__avatarRetryTimer = null;
  if (Object.keys(window.__avatarRetryAt).length) scheduleAvatarRetryScan();
}
// M3: 60s 失败冷却查询统一入口（收敛 group/members/map 各自的重复内联判断）
window.__avatarFailCached = function (url) {
  return !!window.__avatarFailCache && !!url && window.__avatarFailCache[url] > Date.now() - 60000;
};
window.__avatarFail = function (img, url) {
  const failUrl = (img && img.src) || url || '';
  const retried = !!(img && img.dataset && img.dataset.avatarFailRetried === '1');
  const direct = avatarDirectOf(url) || avatarDirectOf(failUrl) || '';
  const raw = url || failUrl;
  if (!retried && img && img.dataset) {
    if (direct) {
      // 代理失败 → 客户端直连一次；onerror 传给 proxiedKey 由最后一步统一兜底
      const proxiedKey = AVATAR_PROXY_PREFIX + encodeURIComponent(direct);
      img.dataset.avatarFailRetried = '1';
      img.dataset.avatarProxyKey = proxiedKey;
      img.onerror = function () { window.__avatarFail && window.__avatarFail(this, proxiedKey); };
      img.src = direct;
      return;
    }
    if (VRC_CDN_HOST_RE.test(raw)) {
      // 直连失败 → 代理兜底一次；代理成功记入代理优先记忆（避免反复直连超时）
      const proxiedKey = AVATAR_PROXY_PREFIX + encodeURIComponent(raw);
      img.dataset.avatarFailRetried = '1';
      img.dataset.avatarProxyKey = proxiedKey;
      img.onerror = function () { window.__avatarFail && window.__avatarFail(this, proxiedKey); };
      img.onload = function () { avatarProxyRemember(proxiedKey); };
      img.src = proxiedKey;
      return;
    }
  }
  // 3) 最终兜底：弃用代理优先记忆，标记该 URL 短期失败
  if (img && img.dataset && img.dataset.avatarProxyKey) {
    window.__avatarFailCache[img.dataset.avatarProxyKey] = Date.now();
    delete window.__avatarProxyCache[img.dataset.avatarProxyKey];
  }
  window.__avatarFailCache[url] = Date.now();
  if (failUrl) window.__avatarFailCache[failUrl] = Date.now();
  // F-头像重试：仅对动态解析接口（/api/avatar/user|/proxy）登记自动重试，
  // 系统会话恢复后无需手动刷新页面即可自动出图（见 __avatarRegisterRetry）。
  const retrySrc = (img && img.dataset && (img.dataset.avatarProxyKey || url)) || url;
  if (typeof window.__avatarRegisterRetry === 'function') {
    window.__avatarRegisterRetry(retrySrc);
  }
  if (img) { img.onerror = null; img.src = '/api/avatar/default'; }
};

function updateUserUI() {
  // 加载 Hero 统计数据
  loadHeroStats();
  if (!currentUser) return;
  const avatarType = currentUser.avatarType || currentUser.avatar_type || 'custom';
  const avatarVisible = currentUser.avatarVisible !== false; // 默认可见；仅 avatarVisible===false 时隐藏
  const avatarUrl = (!avatarVisible || avatarType === 'none') ? null : (currentUser.avatarUrl || currentUser.vrchatAvatarUrl || null);
  // 顶部导航栏
  const avatar = document.getElementById('headerUserAvatar');
  const name = document.getElementById('headerUserName');
  if (avatar) {
    avatar.src = proxyAvatar(avatarUrl || '/api/avatar/default');
    avatar.onerror = function() { window.__avatarFail && window.__avatarFail(this, avatar.src || avatarUrl || '/api/avatar/default'); };
  }
  if (name) name.textContent = currentUser.displayName || currentUser.loginId || __('unknown_user');
  // 角色标签跟随显示
  const roleBadge = document.getElementById('adminBadge');
  if (roleBadge) {
    if (currentUser.role === 'super_admin') roleBadge.textContent = __('members.role_super_admin');
    else if (currentUser.role === 'admin') roleBadge.textContent = __('members.role_admin');
    else roleBadge.classList.add('d-none');
  }
  // 个人中心页面
  const profileAvatar = document.getElementById('meAvatar');
  const profileName = document.getElementById('meName');
  const profileLoginId = document.getElementById('meLoginId');
  const profileRole = document.getElementById('meRole');
  if (profileAvatar) {
    profileAvatar.src = proxyAvatar(avatarUrl || '/api/avatar/default');
    profileAvatar.onerror = function() { window.__avatarFail && window.__avatarFail(this, profileAvatar.src || avatarUrl || '/api/avatar/default'); };
  }
  if (profileName) profileName.textContent = currentUser.displayName || '';
  if (profileLoginId && !profileLoginId.value) {
    profileLoginId.value = currentUser.loginId || '';
  }
  if (profileRole) { const roleMap = { 'super_admin': __('members.role_super_admin'), 'admin': __('members.role_admin'), 'member': __('members.role_member') }; profileRole.textContent = __('profile.title') + '：' + (roleMap[currentUser.role] || currentUser.role); }
  // bio 由 profile.js 中的 loadMyProfile() 填充
  // VRChat 绑定状态
  const vrcStatus = document.getElementById('vrchatStatus');
  const vrcBindForm = document.getElementById('vrchatBindForm');
  if (vrcStatus) {
    if (currentUser.vrchatId) {
      const vBadge = currentUser.vrchatVerified ? ' <span class="text-green text-12">✅ ' + __('profile.vrc_bind') + '</span>' : ' <span class="text-muted2 text-12">⏳ ' + __('profile.vrc_not_bind') + '</span>';
      vrcStatus.innerHTML = `<div class="d-flex items-center gap-6"><span class="text-green">🟢 ` + __('profile.vrc_bind') + `</span><span class="text-muted">${esc(currentUser.vrchatName || currentUser.vrchatId)}</span>${vBadge}<button class="btn btn-sm btn-outline ml-auto" data-action="unbind-vrc">` + __('profile.vrc_unbind') + `</button></div>`;
    } else {
      vrcStatus.innerHTML = `<span class="text-muted">` + __('profile.vrc_not_bind') + `</span>`;
    }
  }
  if (vrcBindForm) {
    vrcBindForm.classList.toggle('d-none', !!currentUser.vrchatId);
  }
  // 可见性控制 — 使用 classList.toggle 覆盖 d-none CSS 类
  const isAdmin = currentUser.role === 'admin' || currentUser.role === 'super_admin';
  const isSuperAdmin = currentUser.role === 'super_admin';
  document.querySelectorAll('.admin-only').forEach(el => el.classList.toggle('d-none', !isAdmin));
  document.querySelectorAll('.superadmin-only').forEach(el => el.classList.toggle('d-none', !isSuperAdmin));
  // 管理操作栏（公告/VRC同步按钮；活动管理已统一收进后台「内容管理」面板）
  const annoBar = document.getElementById('annoAdminBar');
  if (annoBar) annoBar.classList.toggle('d-none', !isAdmin);
  // 管理员标记
  const adminBadge = document.getElementById('adminBadge');
  if (adminBadge) adminBadge.classList.toggle('d-none', !isAdmin);
}

// ==================== Hero 统计数据加载 ====================
async function loadHeroStats() {
  try {
    const res = await api('/api/public/stats', { method: 'GET' });
    if (res.ok) {
      const d = await res.json();
      // 加载 Hero 全部配置
      const heroTitle = document.getElementById('heroTitle');
      const heroSubtitle = document.getElementById('heroSubtitle');
      const heroDescription = document.getElementById('heroDescription');
      const heroBg = document.getElementById('heroImg');
      const heroSection = document.getElementById('heroSection');
      const heroGradient = document.getElementById('heroGradientOverlay');
      const heroBadge = document.getElementById('heroBadge');
      const heroStatsContainer = document.querySelector('.home-stat-bar');
      const heroParticles = document.getElementById('heroParticles');
      if (d.hero_title && heroTitle) heroTitle.textContent = d.hero_title;
      if (d.hero_subtitle && heroSubtitle) heroSubtitle.textContent = d.hero_subtitle;
      if (d.hero_description && heroDescription) heroDescription.textContent = d.hero_description;
      if (d.hero_bg_url && heroBg) heroBg.src = d.hero_bg_url;
      // 背景颜色
      if (d.hero_bg_color && heroSection) heroSection.style.backgroundColor = d.hero_bg_color;
      // 遮罩透明度
      if (d.hero_bg_overlay_opacity !== undefined && heroGradient) {
        heroGradient.style.opacity = d.hero_bg_overlay_opacity;
      }
      // 强调色
      if (d.hero_accent_color) {
        document.documentElement.style.setProperty('--hero-accent', d.hero_accent_color);
      }
      // 徽标文字
      if (d.hero_badge_text !== undefined && heroBadge) {
        heroBadge.textContent = d.hero_badge_text || '🌐 VRChat Group';
      }
      // 显示/隐藏 徽标
      if (d.hero_show_badge !== undefined && heroBadge) {
        heroBadge.classList.toggle('d-none', d.hero_show_badge === '0');
      }
      // 显示/隐藏 统计
      if (d.hero_show_stats !== undefined && heroStatsContainer) {
        heroStatsContainer.classList.toggle('d-none', d.hero_show_stats === '0');
      }
      // 动画效果
      if (d.hero_animation && heroSection) {
        heroSection.classList.remove('hero-fade-in', 'hero-slide-up');
        if (d.hero_animation !== 'none') heroSection.classList.add('hero-' + d.hero_animation);
        heroSection.style.animation = 'none';
        void heroSection.offsetWidth;
        heroSection.style.animation = '';
      }
      // 缓存配置供其他模块使用
      window.__heroConfig = d;
    }
  } catch {}
}

// ==================== Tab 角标 ====================
function checkTabBadges() {
  const lastAnnoTime = localStorage.getItem('lastAnnoVisit') || 0;
  const lastEvtTime = localStorage.getItem('lastEvtVisit') || 0;
  const annoBadge = document.getElementById('annoBadge');
  const evtBadge = document.getElementById('evtBadge');
  if (typeof announcementsCache !== 'undefined' && announcementsCache && announcementsCache.length > 0 && annoBadge) {
    const hasNew = announcementsCache.some(a => {
      const t = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      return t > Number(lastAnnoTime);
    });
    annoBadge.classList.toggle('d-none', !hasNew);
  } else if (annoBadge) {
    annoBadge.classList.add('d-none');
  }
  if (typeof eventsCache !== 'undefined' && eventsCache && eventsCache.length > 0 && evtBadge) {
    const hasNew = eventsCache.some(e => {
      const t = e.createTime || e.createdAt ? new Date(e.createTime || e.createdAt).getTime() : 0;
      return t > Number(lastEvtTime);
    });
    evtBadge.classList.toggle('d-none', !hasNew);
  } else if (evtBadge) {
    evtBadge.classList.add('d-none');
  }
}
function markAnnoSeen() { localStorage.setItem('lastAnnoVisit', Date.now().toString()); const b = document.getElementById('annoBadge'); if (b) b.classList.add('d-none'); }
function markEvtSeen() { localStorage.setItem('lastEvtVisit', Date.now().toString()); const b = document.getElementById('evtBadge'); if (b) b.classList.add('d-none'); }

// 顶部标签栏「选择移动动画」：在 .tabs 内注入一个滑动指示器，
// 平滑移动到当前 .tab.active 下方；首页（隐藏标签栏）与移动端自动隐藏。
function updateTabIndicator() {
  var tabs = document.querySelector('#mainContainer > .tabs');
  if (!tabs) return;
  var indicator = tabs.querySelector('.tab-indicator');
  if (!indicator) {
    indicator = document.createElement('span');
    indicator.className = 'tab-indicator';
    tabs.insertBefore(indicator, tabs.firstChild);
  }
  var mqDesktop = window.matchMedia('(min-width: 769px)').matches;
  var active = tabs.querySelector('.tab.active');
  if (!active || document.body.classList.contains('home-active') || !mqDesktop) {
    indicator.style.opacity = '0';
    // §P1-40: 指示器未就绪时激活文字用主题色，保证初始帧/浅色主题可读
    tabs.classList.remove('tab-indicator-ready');
    return;
  }
  var targetW = active.offsetWidth;
  var targetX = active.offsetLeft;
  // 首次定位：禁用过渡，瞬间到位，避免从 (0,0) 反向滑入的“反的”动画观感
  if (!updateTabIndicator._inited) {
    var prev = indicator.style.transition;
    indicator.style.transition = 'none';
    indicator.style.width = targetW + 'px';
    indicator.style.transform = 'translateX(' + targetX + 'px)';
    indicator.style.opacity = '1';
    // 强制重排后再恢复过渡，确保后续滑动动画正常
    void indicator.offsetWidth;
    indicator.style.transition = prev || '';
    tabs.classList.add('tab-indicator-ready');
    updateTabIndicator._inited = true;
    return;
  }
  indicator.style.opacity = '1';
  indicator.style.width = targetW + 'px';
  indicator.style.transform = 'translateX(' + targetX + 'px)';
  // §P1-40: 指示器定位完成，激活文字切为紫药丸上的白字
  tabs.classList.add('tab-indicator-ready');
}

// 窗口尺寸变化、i18n 文本渲染、首页显隐切换时，重新定位指示器
window.addEventListener('resize', updateTabIndicator, { passive: true });
window.addEventListener('load', updateTabIndicator);
// 监听 body class 变化（home-active 切换会显隐标签栏，需同步隐藏/显示指示器）
if (window.MutationObserver) {
  new MutationObserver(updateTabIndicator).observe(document.body, { attributes: true, attributeFilter: ['class'] });
}
// i18n 异步渲染后标签宽度变化，下一帧再校正一次
setTimeout(updateTabIndicator, 0);
setTimeout(updateTabIndicator, 300);

function switchTab(tab, force) {
  // M1: 标签切换统一滚动回顶（覆盖桌面顶部栏 / 移动端底部栏 / 深链 / 后退）
  window.scrollTo({ top: 0, behavior: 'auto' });
  // 滚动锁自愈：来回切换功能选项后若某覆盖层残留锁导致滚不动，先对账清锁。
  // 放在最前，即使切到同一 tab（early return 之前）也能触发修复。
  if (typeof reconcileBodyScroll === 'function') reconcileBodyScroll();
  // 首页隐藏顶部标签栏（首页底部已有功能栏），其余页面显示
  document.body.classList.toggle('home-active', tab === 'home');
  if (activeTab === tab && !force) return;
  activeTab = tab;
  document.querySelectorAll('.tab').forEach(btn => {
    const isActive = btn.id === 'tab-btn-' + tab;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', String(isActive));
    // 方向键导航（roving tabindex）：仅当前标签可 Tab 聚焦，其余从 Tab 序列移除
    btn.tabIndex = isActive ? 0 : -1;
  });
  document.querySelectorAll('.tab-content').forEach(content => content.classList.toggle('d-none', content.id !== 'tab-' + tab));
  // 同步底部功能栏（移动端）的高亮状态，确保选中样式与当前页面一致：
  // 无论从顶部选项栏、底部功能栏还是「更多」菜单进入，两处导航高亮都保持统一。
  document.querySelectorAll('.mobile-tab-bar-item').forEach(function (b) {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  updateTabIndicator();
  // 页面标题随 Tab 切换（国际化）
  const tabTitleKeys = { 'home': 'nav.home', 'members': 'nav.members', 'vrc': 'nav.vrc', 'announcements': 'nav.announcements', 'events': 'nav.events', 'album': 'nav.album', 'map': 'nav.map', 'chat': 'nav.chat', 'birthday': 'nav.birthday', 'admin': 'nav.admin', 'me': 'nav.me', 'profile-user': 'nav.profile', 'posts': 'nav.posts', 'live': 'nav.live', 'friends': 'friends.title', 'follows': 'follows.title', 'notifications': 'nav.notifications' };
  document.title = `${__('page_title_prefix')} - ${__(tabTitleKeys[tab] || 'nav.home')}`;
  // Tab 内容入场动画：先重置动画再触发
  const contentEl = document.getElementById('tab-' + tab);
  if (contentEl) {
    contentEl.style.animation = 'none';
    requestAnimationFrame(() => requestAnimationFrame(() => { contentEl.style.animation = ''; }));
  }
  if (tab === 'home') loadHome();
  else if (tab === 'members') loadMembers();
  else if (tab === 'vrc') { if (typeof clearGroupBadge === 'function') clearGroupBadge(); loadGroupMembers(); if (typeof startGroupPolling === 'function') startGroupPolling(); if (typeof switchVrcView === 'function') { switchVrcView(window.__vrcPendingView || 'group'); window.__vrcPendingView = null; } }
  else if (tab === 'announcements') { loadAnnouncements(); markAnnoSeen(); }
  else if (tab === 'events') { loadEvents(currentEvtStatus); markEvtSeen(); }
  else if (tab === 'album') loadAlbum();
  else if (tab === 'map') initMap();
  else if (tab === 'chat') loadChatConversations(true);
  else if (tab === 'birthday') { loadBirthdays(); loadBirthdayParties(); }
  else if (tab === 'posts') loadPosts();
  else if (tab === 'live') { if (typeof loadLiveStreams === 'function') loadLiveStreams(); }
  else if (tab === 'friends') { if (typeof window.showFriends === 'function') window.showFriends(); }
  else if (tab === 'follows') { if (typeof window.showFollows === 'function') window.showFollows(); }
  else if (tab === 'admin') { if (typeof initAdminNavOnce === 'function') initAdminNavOnce(); loadAdminStats(); checkSystemVrcStatus(); loadUsersAdmin(); updateNameReviewPreview(); loadPermissions(); loadPermGroups(); loadOperLog(); loadSystemConfig(); bindHeroPreviewEvents(); }
  else if (tab === 'me') showProfile();
  else if (tab === 'profile-user' && currentUser) loadUserProfile(currentUser.id);
  else if (tab === 'notifications') { loadNotifications(true); loadNotificationSettings(); }

  // 离开群组页时立即按「已读基线」重新评估角标：若在线人数已回落则清除，
  // 有新上线则显示，避免红点常驻或切换后状态不同步。
  if (tab !== 'vrc' && typeof updateGroupBadge === 'function') {
    const oc = document.getElementById('groupOnlineCount');
    if (oc) updateGroupBadge(oc.textContent);
  }
  // P2-16 离开资源密集页时停掉对应定时器，避免隐藏页面空转
  if (tab !== 'vrc' && typeof stopGroupPolling === 'function') stopGroupPolling();
  if (tab !== 'map' && typeof window.__mapTeardown === 'function') window.__mapTeardown();
  syncTabHash(tab);
}

// ==================== P2-98：Tab 深链路由（history + hash） ====================
// 全站此前 0 处 pushState/popstate：刷新/后退/分享都无法回到当前 Tab。
// 约定：home 保持干净 URL（state 携带 tab），其余 Tab 用 #<tab> 形式，可直接分享。
const ROUTABLE_TABS = ['home', 'members', 'vrc', 'announcements', 'events', 'album', 'map', 'chat', 'birthday', 'admin', 'me', 'profile-user', 'posts', 'live', 'friends', 'follows', 'notifications'];
let _suppressHashSync = false;
let _hashReplaceNext = true; // 首个由启动同步写入的条目用 replace，刷新不额外增加历史

function tabFromUrl() {
  const name = decodeURIComponent((location.hash || '').replace(/^#\/?/, ''));
  return ROUTABLE_TABS.includes(name) ? name : 'home';
}

function syncTabHash(tab) {
  if (_suppressHashSync || typeof history === 'undefined' || !history.pushState) return;
  const url = tab === 'home' ? location.pathname + location.search : '#' + tab;
  try {
    if (_hashReplaceNext) {
      history.replaceState({ tab }, '', url);
      _hashReplaceNext = false;
    } else {
      history.pushState({ tab }, '', url);
    }
  } catch (_) {}
}

window.addEventListener('popstate', function (e) {
  // M1: 后退/前进也滚动回顶（可能因同 Tab 提前 return 而不进 switchTab）
  window.scrollTo({ top: 0, behavior: 'auto' });
  const guess = (e.state && ROUTABLE_TABS.includes(e.state.tab)) ? e.state.tab : tabFromUrl();
  if (guess === activeTab) return;
  _suppressHashSync = true;
  _hashReplaceNext = true; // URL 已随前进/后退变更，只需补写 state，不可再 push
  try {
    switchTab(guess, true);
  } finally {
    _suppressHashSync = false;
    _hashReplaceNext = false;
  }
});

// 手动改地址栏 hash（含外部深链、站内锚点）也同步切页
window.addEventListener('hashchange', function () {
  // M1: 深链 / 手动改 hash 也滚动回顶（可能因同 Tab 提前 return 而不进 switchTab）
  window.scrollTo({ top: 0, behavior: 'auto' });
  const t = tabFromUrl();
  _suppressHashSync = true;
  _hashReplaceNext = true; // URL 已是目标 hash，switchTab 内部的同步改为 replace，避免多压一条历史
  try {
    if (t !== activeTab) switchTab(t, true);
  } finally {
    _suppressHashSync = false;
    _hashReplaceNext = false;
  }
});

// 底部功能栏：点击后高亮当前项（被 index.html 内联脚本调用）
function mobileTabHit(btn) {
  if (!btn) return;
  document.querySelectorAll('.mobile-tab-bar-item').forEach(function (b) {
    b.classList.toggle('active', b === btn);
  });
}

// ==================== 用户菜单 ====================
function toggleUserMenu() {
  const menu = document.getElementById('userDropdown');
  if (!menu) return;
  menu.classList.toggle('d-none');
  const isOpen = !menu.classList.contains('d-none');
  menu.setAttribute('aria-expanded', String(isOpen));
  const trigger = document.getElementById('userMenuTrigger');
  if (trigger) trigger.setAttribute('aria-expanded', String(isOpen));
  // 打开时挂 document 级 keydown 做方向键导航与 Esc 关闭；
  // 关闭（含登出触发的收起）时解绑，避免把焦点送进被遮罩盖住的菜单项。
  if (isOpen) {
    document.addEventListener('keydown', _handleUserMenuKeydown);
  } else {
    document.removeEventListener('keydown', _handleUserMenuKeydown);
  }
}
function hideUserMenu() {
  const menu = document.getElementById('userDropdown');
  if (!menu) return;
  menu.classList.add('d-none');
  menu.setAttribute('aria-expanded', 'false');
  const trigger = document.getElementById('userMenuTrigger');
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
  document.removeEventListener('keydown', _handleUserMenuKeydown);
}
function _handleUserMenuKeydown(e) {
  const menu = document.getElementById('userDropdown');
  if (!menu || menu.classList.contains('d-none')) return;
  const items = Array.from(menu.querySelectorAll('.user-dropdown-item'));
  if (!items.length) return;
  const current = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const dir = e.key === 'ArrowDown' ? 1 : -1;
    let next = current < 0 ? (dir === 1 ? 0 : items.length - 1) : (current + dir + items.length) % items.length;
    items[next].focus();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    hideUserMenu();
    const trigger = document.getElementById('userMenuTrigger');
    if (trigger) trigger.focus();
  }
}

// ==================== 通知面板 ====================
// 通知类型筛选（VRCX Log 模块思路：按类型分组聚合展示）
const NOTIF_TYPES = {
  all: { icon: '🗂️' },
  unread: { icon: '🔴' },
  system: { icon: '🔔' },
  event_reminder: { icon: '📅' },
  comment: { icon: '💬' },
  like: { icon: '❤️' },
  announcement: { icon: '📢' },
  vrc: { icon: '🎮' },
  name_change_approved: { icon: '✅' },
  name_change_rejected: { icon: '❌' }
};
let notifFilter = 'all';
let notifPage = 1;
const NOTIF_PAGE_SIZE = 30;
// M3: 通知加载请求序号：reset 时递增，过期响应直接丢弃，避免 reset 与加载更多并发重复追加
let _notifLoadSeq = 0;
// V9.6: 客户端 30 秒防抖，配合服务端 60 秒防抖，避免频繁打开面板刷爆 VRChat API
let _vrcSyncLast = 0;

// V9.6: 把本人 VRChat 官方通知并入站内通知（fire-and-forget，失败不影响原通知链路）
async function syncVrcNotifications() {
  if (Date.now() - _vrcSyncLast < 30000) return;
  // 通知设置里关闭 VRChat 官方通知后不再触发同步
  if (window.__notifPrefs && window.__notifPrefs.vrc === false) return;
  _vrcSyncLast = Date.now();
  try {
    const res = await api('/api/notifications/vrc-sync', { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      if (data.synced > 0) loadNotifications(true, true);
    }
  } catch (e) { /* 未绑定/上游失败：静默，不打断通知面板 */ }
}

async function loadNotifications(reset, skipVrcSync) {
  const my = reset ? ++_notifLoadSeq : _notifLoadSeq;
  const dropBox = document.getElementById('notificationList') || document.querySelector('#notificationPanel .notification-list');
  const centerBox = document.getElementById('notificationCenterList');
  const centerEmpty = document.getElementById('notificationCenterEmpty');
  const boxes = [dropBox, centerBox].filter(Boolean);
  if (reset) notifPage = 1;
  if (!boxes.length) return;
  if (reset && !skipVrcSync) syncVrcNotifications();
  if (reset) {
    const skel = '<div class="skeleton-card-list" style="margin:4px 8px"></div><div class="skeleton-card-list" style="margin:4px 8px"></div><div class="skeleton-card-list" style="margin:4px 8px"></div>';
    boxes.forEach(b => { b.innerHTML = skel; });
  }
  try {
    const qs = new URLSearchParams({ type: notifFilter, page: notifPage, pageSize: NOTIF_PAGE_SIZE }).toString();
    const res = await api('/api/notifications?' + qs, { method: 'GET' });
    if (my !== _notifLoadSeq) return; // 期间发生过 reset，丢弃过期响应
    if (res.ok) {
      const data = await res.json();
      if (my !== _notifLoadSeq) return; // 解析期间又发生过 reset，同样丢弃
      const notifs = data.notifications || [];
      const unread = data.unread || 0;
      // 仅首次（reset）刷新铃铛未读徽章：顶栏下拉与「我的」页两处同步
      if (reset) {
        ['bellBadge', 'bellBadgeTab'].forEach(bid => {
          const badge = document.getElementById(bid);
          if (!badge) return;
          if (unread > 0) {
            badge.textContent = unread > 99 ? '99+' : String(unread);
            badge.classList.remove('d-none');
          } else {
            badge.classList.add('d-none');
          }
        });
        if (centerEmpty) centerEmpty.classList.toggle('d-none', notifs.length > 0);
      }
      const html = notifs.map(n => `
        <div class="notification-item ${n.isRead ? '' : 'unread'}">
          <div class="ni-main" data-notif-id="${escAttr(String(n.id))}">
            <div class="ni-icon">${getNotifIcon(n.type)}</div>
            <div class="ni-body">
              <div class="ni-title">${esc(n.title)}</div>
              <div class="ni-desc">${esc(n.message || '')}</div>
              <div class="ni-time">${fmtDate(n.createdAt)}</div>
            </div>
            ${n.isRead ? '' : '<div class="ni-dot"></div>'}
          </div>
          <button class="ni-del" data-notif-id="${escAttr(String(n.id))}" title="${__('ui.delete')}">✕</button>
        </div>
      `).join('');
      if (reset) {
        boxes.forEach(b => {
          b.innerHTML = '';
          if (b === dropBox && notifs.length === 0) {
            b.innerHTML = `<div class="notification-empty">${__('ui.no_notifications')}</div>`;
          }
        });
        if (notifs.length === 0) return;
        boxes.forEach(b => b.insertAdjacentHTML('beforeend', html));
      } else {
        boxes.forEach(b => {
          b.querySelectorAll('.notif-load-more').forEach(el => el.remove());
          b.insertAdjacentHTML('beforeend', html);
        });
      }
      // 加载更多（后端分页）
      if (notifPage < (data.totalPages || 1)) {
        boxes.forEach(b => b.insertAdjacentHTML('beforeend', `<button class="notif-load-more" data-load-more="1">${__('ui.load_more') || __('auto_ui_1')}</button>`));
      }
    }
  } catch {
    if (my !== _notifLoadSeq) return; // 过期请求的失败不回写 UI
    if (reset) {
      if (dropBox) dropBox.innerHTML = `<div class="notification-empty">${__('ui.load_failed')}</div>`;
      if (centerBox) {
        centerBox.innerHTML = '';
        if (centerEmpty) centerEmpty.classList.remove('d-none');
      }
    }
  }
}

function notifLoadMore() {
  notifPage += 1;
  loadNotifications(false);
}

// 通知点击/删除/加载更多：原内联 onclick 迁移到 document 级委托（CSP nonce 会拦截内联事件处理器）
document.addEventListener('click', function (e) {
  if (!e.target || !e.target.closest) return;
  const loadMore = e.target.closest('.notif-load-more[data-load-more]');
  if (loadMore) { notifLoadMore(); return; }
  const del = e.target.closest('.ni-del[data-notif-id]');
  if (del) { e.stopPropagation(); deleteNotification(del.dataset.notifId); return; }
  const main = e.target.closest('.ni-main[data-notif-id]');
  if (main) markNotificationRead(main.dataset.notifId);
});

// VRChat 解绑按钮：原内联 onclick 迁移到 document 级委托
document.addEventListener('click', function (e) {
  if (!e.target || !e.target.closest) return;
  if (e.target.closest('[data-action="unbind-vrc"]')) {
    if (typeof unbindVRChat === 'function') unbindVRChat();
  }
});

function getNotifIcon(type) {
  const icons = {
    'name_change_approved': '✅',
    'name_change_rejected': '❌',
    'event_reminder': '📅',
    'system': '🔔',
    'comment': '💬',
    'like': '❤️',
    'announcement': '📢',
    'vrc': '🎮'
  };
  return icons[type] || '🔔';
}

function toggleNotificationPanel() {
  const panel = document.getElementById('notificationPanel');
  if (panel) {
    const wasHidden = !panel.classList.contains('show');
    panel.classList.toggle('show');
    if (wasHidden) { loadNotifications(true); loadNotificationSettings(); }
  }
}

async function markNotificationRead(id) {
  try {
    await api(`/api/notifications/${id}/read`, { method: 'POST' });
    loadNotifications(true);
  } catch { /* 静默失败，用户可以点击重试 */ }
}

async function markAllNotificationsRead() {
  try {
    const res = await api('/api/notifications/read-all', { method: 'POST' });
    if (res.ok) { toast(__('ui.all_read'), 'success'); loadNotifications(true); }
  } catch { toast(__('ui.op_failed'), 'error'); }
}

async function deleteNotification(id) {
  try {
    const res = await api(`/api/notifications/${id}`, { method: 'DELETE' });
    if (res.ok) { loadNotifications(true); }
  } catch { toast(__('ui.delete_failed'), 'error'); }
}

async function clearAllNotifications() {
  showConfirm(__('ui.confirm_clear_notifications'), async () => {
    try {
      const res = await api('/api/notifications', { method: 'DELETE' });
      if (res.ok) { toast(__('ui.notifications_cleared'), 'info'); loadNotifications(true); }
    } catch { toast(__('ui.op_failed'), 'error'); }
  });
}

// ==================== 通知偏好设置 ====================
// email 由后端（notification-service）消费；browser/sound 写入 window.__notifPrefs 供 main.js 客户端生效
let notifSettingsLoaded = false;
async function loadNotificationSettings() {
  if (notifSettingsLoaded || !currentUser) return;
  try {
    const res = await api('/api/notifications/settings', { method: 'GET' });
    if (!res.ok) return;
    const data = await res.json();
    notifSettingsLoaded = true;
    window.__notifPrefs = { email: !!data.email, browser: data.browser !== false, sound: data.sound !== false, vrc: data.vrc !== false };
    const map = { notifEmailToggle: 'email', notifBrowserToggle: 'browser', notifSoundToggle: 'sound', notifVrcToggle: 'vrc' };
    Object.keys(map).forEach(id => {
      const el = document.getElementById(id);
      if (el) el.checked = window.__notifPrefs[map[id]];
    });
  } catch { /* 静默：保持默认开关 */ }
}

async function toggleNotificationSetting(key, value) {
  const prefs = Object.assign({ email: false, browser: true, sound: true, vrc: true }, window.__notifPrefs || {});
  prefs[key] = !!value;
  window.__notifPrefs = prefs;
  try {
    const res = await api('/api/notifications/settings', {
      method: 'POST',
      body: JSON.stringify({ email: prefs.email, browser: prefs.browser, sound: prefs.sound, vrc: prefs.vrc })
    });
    if (!res.ok) throw new Error('save failed');
  } catch {
    toast(__('ui.op_failed'), 'error');
  }
}

// ==================== 密码强度 ====================
function updatePwdMeter(inputId, meterId, textId) {
  const pwd = document.getElementById(inputId)?.value || '';
  const meter = document.getElementById(meterId); const text = document.getElementById(textId);
  if (!meter || !text) return;
  let score = 0;
  if (pwd.length >= 8) score++; if (/[a-z]/.test(pwd) && /[A-Z]/.test(pwd)) score++; if (/\d/.test(pwd)) score++; if (/[^a-zA-Z0-9]/.test(pwd)) score++;
  const bars = meter.querySelectorAll('.pwd-strength-bar');
  bars.forEach((b, i) => { b.className = 'pwd-strength-bar'; if (i < score) { if (score <= 1) b.classList.add('weak'); else if (score <= 2) b.classList.add('medium'); else b.classList.add('strong'); } });
  const labels = ['', __('ui.weak'), __('ui.medium'), __('ui.strong'), __('ui.very_strong')]; text.textContent = labels[score]; text.style.color = ['', 'var(--red)', 'var(--orange)', 'var(--green)', 'var(--accent)'][score];
}
function checkPwdMatch(inputId1, inputId2, matchId) {
  const pwd1 = document.getElementById(inputId1)?.value; const pwd2 = document.getElementById(inputId2)?.value; const match = document.getElementById(matchId);
  if (!match) return;
  if (!pwd2) { match.textContent = ''; return; }
  match.textContent = pwd1 === pwd2 ? __('ui.pwd_match') : __('ui.pwd_not_match');
  match.style.color = pwd1 === pwd2 ? 'var(--green)' : 'var(--red)';
}


// P2-1 components (appended from working tree) 
// ==================== 公共 UI 组件 (P2-1 空状态 / P2-2 加载态统一) ====================
// 由 index.html 在 core.js 之后、各业务模块之前同步加载。
// 提供可复用的空状态渲染与骨架屏，消除各模块自行拼装导致的样式/语义不一致。
// 样式内联注入，引用设计令牌（var(--*)），自动适配明暗主题与 reduced-motion。

(function () {
  'use strict';

  // ---- 一次性注入样式 ----
  if (!document.getElementById('jt-ui-style')) {
    const style = document.createElement('style');
    style.id = 'jt-ui-style';
    style.textContent = [
      '.jt-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;',
      '  gap:12px;padding:48px 16px;text-align:center;color:var(--muted);}',
      '.jt-empty-icon{font-size:40px;line-height:1;opacity:.85;filter:saturate(.9);',
      '  animation:float 3s ease-in-out infinite;will-change:transform;}',
      '.jt-empty-title{font-size:15px;font-weight:600;color:var(--text);}',
      '.jt-empty-text{font-size:13px;line-height:1.6;max-width:320px;color:var(--muted);}',
      '.jt-empty-actions{margin-top:4px;display:flex;gap:8px;flex-wrap:wrap;justify-content:center;}',
      // 与现有 .skeleton-stat 风格对齐的卡片网格骨架
      '.jt-skel-grid{display:grid;gap:14px;padding:4px;',
      '  grid-template-columns:repeat(auto-fill,minmax(150px,1fr));}',
      '.jt-skel-card{border-radius:12px;overflow:hidden;background:var(--bg-elevated);',
      '  border:1px solid var(--border);}',
      '.jt-skel-thumb{aspect-ratio:4/3;background:var(--skel-base,var(--bg2));}',
      '.jt-skel-line{height:10px;margin:10px 12px;border-radius:6px;background:var(--skel-base,var(--bg2));}',
      '.jt-skel-line.short{width:55%;margin-bottom:12px;}',
      '.jt-skel-base{background:linear-gradient(90deg,var(--skel-base,var(--bg2)) 25%,',
      '  var(--skel-hi,var(--bg3,#222)) 37%,var(--skel-base,var(--bg2)) 63%);',
      '  background-size:400% 100%;animation:jt-shimmer 1.3s ease-in-out infinite;}',
      '@keyframes jt-shimmer{0%{background-position:100% 0}100%{background-position:0 0}}',
      '@media (prefers-reduced-motion: reduce){.jt-skel-base{animation:none;}}',
      // 列表行骨架
      '.jt-skel-rows{display:flex;flex-direction:column;gap:10px;padding:4px;}',
      '.jt-skel-row{display:flex;align-items:center;gap:12px;padding:8px;}',
      '.jt-skel-avatar{width:40px;height:40px;border-radius:50%;flex-shrink:0;background:var(--skel-base,var(--bg2));}',
      '.jt-skel-row .jt-skel-line{margin:0;flex:1;}'
    ].join('');
    document.head.appendChild(style);
  }

  /**
   * 渲染统一空状态。
   * @param {HTMLElement} el 目标容器（innerHTML 会被替换）
   * @param {Object} opt {icon, title, text, actions:[{label,cls,onClick}]}
   *   - icon  : 表情/符号（默认 📭）
   *   - title : 主标题（可选）
   *   - text  : 说明文案（支持 i18n key，运行时已就绪）
   *   - actions: 操作按钮数组，cls 默认 'btn btn-accent'
   */
  window.renderEmpty = function (el, opt) {
    if (!el) return;
    opt = opt || {};
    const icon = opt.icon || '📭';
    const title = opt.title ? '<div class="jt-empty-title">' + esc(opt.title) + '</div>' : '';
    const text = opt.text ? '<div class="jt-empty-text">' + esc(opt.text) + '</div>' : '';
    let actions = '';
    if (Array.isArray(opt.actions)) {
      actions = '<div class="jt-empty-actions">' + opt.actions.map(function (a, i) {
        const cls = a.cls || 'btn btn-accent';
        return '<button class="' + cls + '" data-jt-empty-action="' + i + '">' + esc(a.label) + '</button>';
      }).join('') + '</div>';
    }
    const extra = opt.cls ? ' ' + opt.cls : '';
    el.innerHTML = '<div class="jt-empty' + extra + '" role="status">' +
      '<div class="jt-empty-icon" aria-hidden="true">' + icon + '</div>' +
      title + text + actions + '</div>';
    // 绑定按钮事件（不依赖 HTML 转义后的属性，用闭包）
    if (Array.isArray(opt.actions)) {
      el.querySelectorAll('[data-jt-empty-action]').forEach(function (btn) {
        const idx = parseInt(btn.getAttribute('data-jt-empty-action'), 10);
        const a = opt.actions[idx];
        if (a && typeof a.onClick === 'function') btn.addEventListener('click', a.onClick);
      });
    }
  };

  /**
   * 显示统一骨架屏。
   * @param {HTMLElement} el 目标容器
   * @param {string} variant 'grid' | 'rows'，默认 'grid'
   * @param {number} count 占位数量，默认 6
   */
  window.showSkeleton = function (el, variant, count) {
    if (!el) return;
    variant = variant || 'grid';
    count = count || 6;
    let html;
    if (variant === 'rows') {
      html = __('auto_ui_2') +
        Array(count).fill('<div class="jt-skel-row"><div class="jt-skel-avatar jt-skel-base"></div><div class="jt-skel-line jt-skel-base"></div></div>').join('') +
        '</div>';
    } else {
      html = __('auto_ui_3') +
        Array(count).fill('<div class="jt-skel-card"><div class="jt-skel-thumb jt-skel-base"></div><div class="jt-skel-line jt-skel-base"></div><div class="jt-skel-line short jt-skel-base"></div></div>').join('') +
        '</div>';
    }
    el.innerHTML = html;
  };

  /** 清空骨架屏/加载态。 */
  window.hideSkeleton = function (el) {
    if (el) el.innerHTML = '';
  };

  /**
   * 生成并复制「公开分享落地页」链接。
   * 通过 POST /api/share 创建分享记录，复制 /api/share/:code/html 落地页 URL（匿名可访问）。
   * 失败时回退为复制当前页面地址，保证分享按钮永远可用。
   * @param {'post'|'event'|'album'} type
   * @param {number|string} targetId
   */
  window.sharePublicLink = async function (type, targetId) {
    const fallback = function () {
      const url = window.location.href;
      if (navigator.clipboard) navigator.clipboard.writeText(url).then(
        () => toast(__('share.link_copied'), 'success'),
        () => toast(__('share.link_prefix') + url, 'info')
      );
      else toast(__('share.link_prefix') + url, 'info');
    };
    try {
      const res = await api('/api/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: type, targetId: targetId })
      });
      const data = await res.json().catch(function () { return {}; });
      if (res.ok && data.shareCode) {
        const pageUrl = window.location.origin + '/api/share/' + data.shareCode + '/html';
        if (navigator.clipboard) {
          navigator.clipboard.writeText(pageUrl).then(
            () => toast(__('share.link_copied'), 'success'),
            () => toast(__('share.link_prefix') + pageUrl, 'info')
          );
        } else {
          toast(__('share.link_prefix') + pageUrl, 'info');
        }
        return;
      }
      // 不可分享（如非公开内容）：提示原因，不再复制当前页（无效公开页）
      if (data && data.message) { toast(data.message, 'info'); return; }
    } catch (err) { /* 分享系统不可用，回退 */ }
    fallback();
  };

  // esc() 统一走 core.js 全局（HTML 转义；helper 仅在受控文本/按钮标签上使用）
})();

// ==================== 移动端 Tab 折叠菜单 ====================
// 移动端菜单、灯箱与弹窗共用同一套引用计数滚动锁：
// 用 Set 记录所有锁定来源，最后一个来源释放时才恢复页面滚动，
// 避免"关闭一方误解锁另一方"的经典缺陷。

const _scrollLockOwners = new Set();
let _scrollLockOriginalOverflow = null;

function lockBodyScroll(owner) {
  if (!_scrollLockOwners.has(owner)) {
    if (_scrollLockOwners.size === 0) {
      _scrollLockOriginalOverflow = document.body.style.overflow;
    }
    _scrollLockOwners.add(owner);
  }
  if (document.body.style.overflow !== 'hidden') {
    document.body.style.overflow = 'hidden';
  }
}

function unlockBodyScroll(owner) {
  if (!_scrollLockOwners.has(owner)) return;
  _scrollLockOwners.delete(owner);
  if (_scrollLockOwners.size === 0) {
    document.body.style.overflow = _scrollLockOriginalOverflow || '';
    _scrollLockOriginalOverflow = null;
  }
}

// 滚动锁自愈：检查当前每个持锁来源是否仍对应"可见的锁定 UI"。
// 弹窗/覆盖层被直接 remove 或所在 tab 重渲染（未走 closeModal）时，
// 持锁来源会残留 → body 永远 overflow:hidden 滚不动，刷新才恢复。
// 这里在切 tab 等时机做对账：没有任何来源仍可见就清空全部锁并恢复滚动。
function reconcileBodyScroll() {
  const hasVisibleLockUI = [..._scrollLockOwners].some(function (owner) {
    if (typeof owner !== 'string') {
      // DOM 元素持锁人（无障碍层）：仍连接且处于打开态才算有效
      return !!owner.isConnected &&
        (owner.classList.contains('show') || (owner.style && owner.style.display && owner.style.display !== 'none'));
    }
    if (owner === 'mobile-tab-menu') {
      const m = document.getElementById('mobileMoreMenu');
      return !!m && m.classList.contains('show');
    }
    if (owner === 'smart-search') {
      const p = document.getElementById('smartSearchPanel');
      return !!p && !p.classList.contains('d-none');
    }
    if (owner === 'generic-lightbox') {
      return !!document.querySelector('.generic-lightbox.show');
    }
    if (owner === 'album-lightbox') {
      return !!document.querySelector('.lightbox.show');
    }
    if (owner === 'vrc-bind-guide') {
      // 实际遮罩 class 是 .vrc-bind-guide-overlay（内层卡片才是 .vrc-bind-guide-modal）
      return !!document.querySelector('.vrc-bind-guide-overlay');
    }
    if (owner.indexOf('modal:') === 0) {
      const el = document.getElementById(owner.slice('modal:'.length));
      return !!el && isModalOpen(el);
    }
    if (owner.indexOf('posts-overlay:') === 0 ||
        owner.indexOf('confirm-overlay:') === 0 ||
        owner.indexOf('admin-photo:') === 0) {
      // posts 编辑器/详情、confirm 确认层、后台相册遮罩：存在可见覆盖层才算有效
      return !!document.querySelector('.modal-overlay.active, .confirm-overlay, .modal-overlay');
    }
    return false;
  });
  if (!hasVisibleLockUI) {
    _scrollLockOwners.clear();
    _scrollLockOriginalOverflow = null;
    if (document.body.style.overflow === 'hidden') {
      document.body.style.overflow = '';
    }
  }
}

// ==================== 移动端「更多」溢出菜单 ====================
// 底部栏只放得下 9 个入口，其余 tab 收进「更多」弹出菜单，复用 window.switchTab。
// TAB_ITEMS 列出全部桌面 tab，保证手机上没有任何功能入口被遗漏。
// 菜单项用 <button>（可键盘聚焦），菜单容器 role=dialog 并支持 Escape 关闭后焦点回触发钮。
const TAB_ITEMS = [
  { id: 'home',          emoji: '🏠', i18n: 'nav.home' },
  { id: 'members',       emoji: '👥', i18n: 'nav.members' },
  { id: 'vrc',           emoji: '🎮', i18n: 'nav.vrc' },
  { id: 'announcements', emoji: '📢', i18n: 'nav.announcements' },
  { id: 'events',        emoji: '📅', i18n: 'nav.events' },
  { id: 'birthday',      emoji: '🎂', i18n: 'nav.birthday' },
  { id: 'album',         emoji: '🖼️', i18n: 'nav.album' },
  { id: 'posts',         emoji: '📝', i18n: 'nav.posts' },
  { id: 'live',          emoji: '📺', i18n: 'nav.live' },
  { id: 'map',           emoji: '🗺️', i18n: 'nav.map' },
  { id: 'chat',          emoji: '💬', i18n: 'nav.chat' },
  { id: 'friends',       emoji: '🤝', i18n: 'friends.title' },
  { id: 'follows',       emoji: '➕', i18n: 'follows.title' },
  { id: 'notifications', emoji: '🔔', i18n: 'nav.notifications' },
  { id: 'admin',         emoji: '⚙️', i18n: 'nav.admin' }
];

// 底部栏已直接展示的 tab，不重复塞进「更多」菜单
const MOBILE_BAR_TABS = new Set(['home', 'events', 'live', 'posts', 'chat', 'friends', 'follows', 'admin', 'notifications']);

let _mobileMenuInited = false;

function initMobileTabMenu() {
  const btn = document.getElementById('mobileMoreBtn');
  const menu = document.getElementById('mobileMoreMenu');
  if (!btn || !menu) return;

  // 幂等守卫：ui.js 在 DOMContentLoaded 调用一次，auth.js 在登录态恢复（showApp）再调一次。
  // 无守卫时每次调用都会重复追加菜单项、重复绑定触发钮 click 监听器，
  // 表现为「更多」菜单项翻倍 + 点击开→关双触发（菜单看起来打不开）。只允许初始化一次。
  if (_mobileMenuInited) return;
  _mobileMenuInited = true;
  // 防御性清空：即便未来出现新的调用时序，也不至于在残留子节点上二次追加。
  menu.innerHTML = '';

  // 触发钮与关闭控件的可访问性命名：走 i18n，避免硬编码中文 key 裸露
  if (!btn.getAttribute('aria-label')) btn.setAttribute('aria-label', __('nav.more') || '更多功能');
  if (!menu.getAttribute('role')) menu.setAttribute('role', 'dialog');
  if (!menu.getAttribute('aria-label')) menu.setAttribute('aria-label', __('nav.more') || '更多功能');

  TAB_ITEMS.forEach(function (it) {
    if (MOBILE_BAR_TABS.has(it.id)) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mobile-more-item';
    b.dataset.tab = it.id;
    b.innerHTML = '<span class="mm-emoji">' + it.emoji + '</span><span data-i18n="' + it.i18n + '">' + (__(it.i18n) || it.id) + '</span>';
    b.addEventListener('click', function () {
      closeMobileTabMenu();
      if (typeof window.switchTab === 'function') window.switchTab(it.id);
    });
    menu.appendChild(b);
  });

  btn.addEventListener('click', function (e) {
    e.stopPropagation();
    const open = menu.classList.toggle('show');
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) lockBodyScroll('mobile-tab-menu');
    else unlockBodyScroll('mobile-tab-menu');
  });

  document.addEventListener('click', function (e) {
    if (menu.classList.contains('show') && !menu.contains(e.target) && e.target !== btn) {
      closeMobileTabMenu();
    }
  });

  menu.addEventListener('keydown', handleMobileTabMenuKeydown);
}

function handleMobileTabMenuKeydown(e) {
  if (e.key === 'Escape') {
    closeMobileTabMenu();
  }
}

function openMobileTabMenu() {
  lockBodyScroll('mobile-tab-menu');
  const btn = document.getElementById('mobileMoreBtn');
  if (btn) btn.setAttribute('aria-expanded', 'true');
  const menu = document.getElementById('mobileMoreMenu');
  if (menu) menu.classList.add('show');
}

function closeMobileTabMenu() {
  unlockBodyScroll('mobile-tab-menu');
  const btn = document.getElementById('mobileMoreBtn');
  if (btn) btn.setAttribute('aria-expanded', 'false');
  const menu = document.getElementById('mobileMoreMenu');
  if (menu) menu.classList.remove('show');
  // 关闭后把焦点还给触发按钮，避免键盘用户焦点掉到 body（preventScroll 防视口跳动）
  if (btn) btn.focus({ preventScroll: true });
}

// M8: 移动端「更多」菜单 Esc 不依赖焦点在菜单内——原先 keydown 绑在 menu 元素上，
// 焦点落在触发按钮时按 Esc 会漏到全局链，菜单不关反而关了底层弹窗。
// 改为 capture 级 document 监听（初始化注册一次），菜单打开时独占 Esc。
if (!window.__mobileMenuEscBound) {
  window.__mobileMenuEscBound = true;
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    const m = document.getElementById('mobileMoreMenu');
    if (m && m.classList.contains('show')) {
      e.stopImmediatePropagation();
      closeMobileTabMenu();
    }
  }, true);
}

// 初始化移动端「更多」菜单（DOM 就绪后运行一次）
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initMobileTabMenu);
} else {
  initMobileTabMenu();
}

// ==================== 个人中心选项条：鼠标滚轮 → 横向滚动 ====================
// 移动端 .me-sidenav 是横排 overflow-x:auto 选项条（触屏滑动原生可用），
// 但普通鼠标的竖向滚轮在横向容器上默认无效（浏览器只把 deltaY 交给页面纵向滚动），
// 导致窄窗口/平板接鼠标时无法用滚轮切换选项。这里在「横向确有溢出」时把
// deltaY 映射为 scrollLeft；触控板横向手势（deltaX）优先。到达两端后不再拦截，
// 让页面恢复正常的纵向滚动，避免把用户"锁"在选项条里。
function initMeSidenavWheel() {
  const nav = document.querySelector('.me-sidenav');
  if (!nav || nav._meWheelInit) return;
  nav._meWheelInit = true;
  nav.addEventListener('wheel', function (e) {
    // 桌面竖排（无横向溢出）交给原生纵向滚动
    if (nav.scrollWidth <= nav.clientWidth + 1) return;
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!delta) return;
    const max = Math.max(0, nav.scrollWidth - nav.clientWidth);
    const cur = nav.scrollLeft;
    const next = Math.max(0, Math.min(max, cur + delta));
    // 已到边缘：不拦截，页面继续滚动。scrollLeft 可能是小数（DPR 缩放），
    // 亚像素差值一律视为到边界，否则末尾会误拦截页面滚动。
    if (Math.abs(next - cur) < 1) return;
    nav.scrollLeft = next;
    e.preventDefault();
  }, { passive: false });
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initMeSidenavWheel);
} else {
  initMeSidenavWheel();
}

function openGenericLightbox(element) {
  // J9: 保留 lockBodyScroll 以满足 ui-interaction.test.js 契约；同时对可选元素追加 show class 与 display 切换
  lockBodyScroll('generic-lightbox');
  if (element) {
    element.classList.add('show');
    element.style.display = 'block';
  }
}

function closeGenericLightbox(element) {
  unlockBodyScroll('generic-lightbox');
  if (element) {
    element.classList.remove('show');
    element.style.display = 'none';
  }
}

// ==================== 模态框焦点陷阱与键盘导航 ====================
// 弹窗无障碍层：以"弹窗栈 + 唯一可见性判定"替代散落各处的 d-none/show/display 判断。
// 统一经 isModalOpen 判定打开状态，避免把默认 display:none 的弹窗误判为已打开。

const _modalStack = [];
let _activeModal = null;

function isModalOpen(modalEl) {
  if (!modalEl || !modalEl.classList) return false;
  const inlineDisplay = modalEl.style && modalEl.style.display;
  if (inlineDisplay && inlineDisplay !== 'none') return true;
  if (inlineDisplay === 'none') return false;
  return modalEl.classList.contains('show');
}

const MODAL_FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getVisibleFocusables(container) {
  const list = [];
  container.querySelectorAll(MODAL_FOCUSABLE_SELECTOR).forEach(function (el) {
    if (el.getClientRects().length > 0 && !el.hasAttribute('aria-hidden')) list.push(el);
  });
  return list;
}

function activateModalA11y(modalEl) {
  if (!modalEl || !isModalOpen(modalEl)) return;
  if (_modalStack.indexOf(modalEl) === -1) {
    // P1-26: 记录打开前的焦点，关闭时归还（轻量页焦点找回触发按钮）
    modalEl._previouslyFocused = document.activeElement && document.activeElement !== document.body
      ? document.activeElement : null;
    _modalStack.push(modalEl);
  }
  if (modalEl.getAttribute('role') !== 'dialog') {
    modalEl.setAttribute('role', 'dialog');
  }
  if (modalEl.getAttribute('aria-modal') !== 'true') {
    modalEl.setAttribute('aria-modal', 'true');
  }
  if (modalEl.hasAttribute('aria-hidden')) {
    modalEl.removeAttribute('aria-hidden');
  }
  // data-no-scroll-lock 弹窗（如头像裁剪）不参与滚动锁：允许弹窗外滚动页面
  if (!modalEl.hasAttribute('data-no-scroll-lock')) lockBodyScroll(modalEl);
}

function deactivateModalA11y(modalEl) {
  if (!modalEl) return;
  const idx = _modalStack.indexOf(modalEl);
  const wasOpen = idx !== -1;
  if (wasOpen) _modalStack.splice(idx, 1);
  if (modalEl.getAttribute('aria-hidden') !== 'true') {
    modalEl.setAttribute('aria-hidden', 'true');
  }
  if (modalEl.hasAttribute('role')) modalEl.removeAttribute('role');
  if (modalEl.hasAttribute('aria-modal')) modalEl.removeAttribute('aria-modal');
  unlockBodyScroll(modalEl);
  // P1-26: 关闭时把焦点还给打开前的元素，键盘用户不丢焦点。
  // 「来回窜」根治：showModal 内部先 closeAllModals 再开新弹窗，若此处无条件归还焦点，
  // 会在新弹窗聚焦后的一帧内把焦点抢回背景触发按钮、并连带滚动视口（已滚动页面尤为明显）；
  // 且归还用无 preventScroll 的 focus()，目标在屏外时浏览器自动滚屏造成跳动。
  // 故仅当没有其他弹窗处于打开态时才归还，并加 preventScroll 保持视口不动。
  const hasOtherOpenModal = Array.from(document.querySelectorAll('.modal')).some(function (m) {
    return m !== modalEl && isModalOpen(m);
  });
  if (wasOpen && !hasOtherOpenModal && modalEl._previouslyFocused && modalEl._previouslyFocused.isConnected) {
    try { modalEl._previouslyFocused.focus({ preventScroll: true }); } catch (e) { /* 元素已不可聚焦则忽略 */ }
  }
  modalEl._previouslyFocused = null;
}

function syncModalA11y() {
  const modals = document.querySelectorAll('.modal');
  // 先清理已从 DOM 移除、但仍在栈中的弹窗，释放其滚动锁
  for (let idx = _modalStack.length - 1; idx >= 0; idx--) {
    const modalEl = _modalStack[idx];
    if (!modalEl.isConnected) {
      if (modalEl.getAttribute('aria-hidden') !== 'true') {
        modalEl.setAttribute('aria-hidden', 'true');
      }
      if (modalEl.hasAttribute('role')) modalEl.removeAttribute('role');
      if (modalEl.hasAttribute('aria-modal')) modalEl.removeAttribute('aria-modal');
      _modalStack.splice(idx, 1);
      unlockBodyScroll(modalEl);
      // 弹窗被直接 remove（未走 closeModal）时，showModal 加的 'modal:'+id 字符串锁
      // 会残留，导致 body 永久 overflow:hidden。此处一并释放，杜绝滚动锁泄漏。
      if (modalEl.id) unlockBodyScroll('modal:' + modalEl.id);
    }
  }
  modals.forEach(function (modalEl) {
    if (isModalOpen(modalEl)) {
      activateModalA11y(modalEl);
    } else {
      deactivateModalA11y(modalEl);
    }
  });
  if (_modalStack.length === 0) {
    _activeModal = null;
  } else {
    _activeModal = _modalStack[_modalStack.length - 1];
  }
}

function handleModalKeydown(e) {
  if (!_activeModal || !isModalOpen(_activeModal)) return;
  if (e.key === 'Tab') {
    // P1-26: 真实焦点陷阱——Tab/Shift+Tab 只在栈顶弹窗内循环，
    // 焦点不得逃出遮罩落到背后页面（此前为空占位，键盘用户可 Tab 出弹窗）
    const focusables = getVisibleFocusables(_activeModal);
    if (!focusables.length) { e.preventDefault(); return; }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !_activeModal.contains(active)) { e.preventDefault(); last.focus(); }
    } else {
      if (active === last || !_activeModal.contains(active)) { e.preventDefault(); first.focus(); }
    }
    return;
  }
  if (e.key === 'Escape') {
    // P1-26: 只关栈顶（最上层）弹窗，保留下层嵌套弹窗；统一走 closeModal 释放滚动锁
    if (typeof closeModal === 'function' && _activeModal.id) {
      e.stopPropagation();
      closeModal(_activeModal.id);
    }
  }
}

function handleModalBackdropClick(e) {
  if (!_activeModal || !isModalOpen(_activeModal)) return;
  const target = e.target;
  if (target && target.closest && target.closest('.modal-close')) {
    const modal = target.closest('.modal');
    if (!modal) return;
    // P1-26: 经统一入口关闭。此前直接 remove('show') 绕开 core.js closeModal，
    // showModal 加的 'modal:'+id 滚动锁永不释放 → 嵌套弹窗后 body 永久 overflow:hidden
    if (typeof closeModal === 'function' && modal.id) { closeModal(modal.id); return; }
    modal.classList.remove('show');
    if (modal.style.display === 'flex') modal.style.display = 'none';
    if (modal.id) unlockBodyScroll('modal:' + modal.id);
  }
}

function initModalAccessibility() {
  if (typeof MutationObserver === 'undefined') return;
  // P3-3: 原实现 observe(body, attributes+childList+subtree) 会在任意元素的 class/style
  // 变更时触发 syncModalA11y 遍历全部 .modal。群组页 WS roster 高频 classList.toggle
  // 会导致高频无意义重排。用 requestAnimationFrame 合帧：同一帧内多次变更只 sync 一次，
  // 既保留对动态新增 .modal 的监听（subtree 仍 true），又消除性能浪费。与 main.js
  // scheduleRefresh 的合帧思路一致。
  let rafId = null;
  const observer = new MutationObserver(function () {
    if (rafId) return;
    rafId = requestAnimationFrame(function () { rafId = null; syncModalA11y(); });
  });
  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
    childList: true,
    subtree: true
  });
  document.addEventListener('keydown', handleModalKeydown, true);
  document.addEventListener('click', handleModalBackdropClick, true);
  syncModalA11y();
  if (!window.__modalObserver) window.__modalObserver = observer;
}

// ==================== 图片查看器键盘导航 ====================
