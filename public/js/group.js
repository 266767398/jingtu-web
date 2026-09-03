/**
 * 境途同游 V6.5 — VRChat 群组成员在线状态
 * 功能：成员列表、在线状态检测、同步、变更通知、实时更新、世界分布
 */

// 复制文本到剪贴板（兼容 http/旧浏览器降级方案）
function copyToClipboard(text) {
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

// 复制世界实例链接（VRCX 风格：wrld_xxx:instanceId~region）
function copyWorldInstance(location) {
  if (!location) return;
  copyToClipboard(location)
    .then(function () { if (typeof toast === 'function') toast(__('group.instance_copied') || __('auto_group_1'), 'success'); })
    .catch(function () { if (typeof toast === 'function') toast(__('ui.copy_failed') || __('auto_group_2'), 'error'); });
}

let groupMembersCache = [];
let groupFilter = 'all';
let groupSearch = '';
let groupStatusRefreshing = false;
let groupLoading = false;
let groupStats = null;
let groupSearchTimer = null;

// ==================== 加载群组成员 ====================
async function loadGroupMembers() {
  if (groupLoading) return;
  groupLoading = true;
  try {
    const params = new URLSearchParams({ filter: groupFilter });
    if (groupSearch) params.set('search', groupSearch);
    const res = await api('/api/group/members?' + params.toString());
    if (!res.ok) throw new Error('LOAD_FAILED');
    const data = await res.json();
    groupMembersCache = data.members || [];
    renderGroupMembers(groupMembersCache);
    updateGroupOverview(groupMembersCache);
    loadGroupChanges();
    contributePresence();
  } catch (err) {
    if (isApiHandledError(err)) return;
    renderEmpty(document.getElementById('groupMemberGrid'), { icon: '📡', text: __('group.load_failed') });
  } finally {
    groupLoading = false;
  }
}

// ==================== 方案 B: 贡献本人好友在线状态（群友互助） ====================
// 已登录且绑定 VRChat 的用户，加载群组时把自己的好友视角上报服务器，
// 补充系统账号因隐私墙看不到的非好友成员的真实在线状态。每 5 分钟最多上报一次。
let _lastPresenceContribute = 0;
async function contributePresence() {
  if (typeof currentUser === 'undefined' || !currentUser || !currentUser.id) return;
  const now = Date.now();
  if (now - _lastPresenceContribute < 5 * 60 * 1000) return;
  _lastPresenceContribute = now;
  try {
    await api('/api/group/presence/contribute', { method: 'POST', timeout: 20000 });
  } catch (e) { /* 静默：仅在已绑定 VRChat 且在线时有效，失败不影响主流程 */ }
}

// ==================== 加载群组统计 ====================
async function loadGroupStats() {
  try {
    const res = await api('/api/group/stats');
    if (!res.ok) return;
    const data = await res.json();
    groupStats = data;
    updateGroupStatsUI(data);
  } catch {}
}

// ==================== 渲染成员卡片 ====================
function renderGroupMembers(members) {
  const grid = document.getElementById('groupMemberGrid');
  if (!grid) return;
  if (members.length === 0) {
    const icon = groupFilter === 'online' ? '🌙' : groupFilter === 'offline' ? '☀️' : groupFilter === 'web' ? '🌐' : groupFilter === 'ingame' ? '🎮' : groupFilter === 'nonfriend' ? '👤' : '👥';
    const line1 = groupFilter === 'online' ? __('group.no_online')
      : groupFilter === 'offline' ? __('group.no_offline')
      : groupFilter === 'web' ? __('group.no_web')
      : groupFilter === 'ingame' ? __('group.no_ingame')
      : groupFilter === 'nonfriend' ? __('group.no_nonfriend')
      : __('group.no_data');
    renderEmpty(grid, { icon: icon, text: line1 + ' · ' + __('group.sync_first') });
    return;
  }

  grid.innerHTML = members.map(m => {
    const isOnline = m.isOnline;
    const isFriend = !!m.isFriend;
    const status = memberStatusMeta(isOnline, isFriend, m.vrchatStatus, m.isInGame, m.statusDescription);
    // 头像与名片保持一致：优先展示用户自定义头像大图，避免当前佩戴的机器人/奇怪模型遮挡真实形象
    const avatarUrl = m.profilePicOverrideThumbnail || m.avatarUrl;
    // VRCX 风格：DB 无头像时，直接用 VRChat 公开头像端点（api.vrchat.com/api/1/users/{id}/image），
    // 由浏览器并行加载（不走后端批量接口），加载速度与 VRCX 一致。
    const vrcFallback = `https://api.vrchat.com/api/1/users/${encodeURIComponent(m.vrchatId || '')}/image`;
    const proxied = proxyAvatar(avatarUrl || vrcFallback);
    // 【P2-46 渐进加载】仅当该 URL 近期失败过（429/裂图冷却 60s）时才用 default 图标占位，
    // 否则首屏直接渲染真实头像 URL（浏览器并行加载数百张无压力）。
    const avatarFailed = window.__avatarFailCache && proxied && window.__avatarFailCache[proxied] > Date.now() - 60000;
    const avatar = avatarFailed ? '/api/avatar/default' : proxied;
    const displayName = m.displayName || m.vrchatName || m.vrchatId;
    // VRCX 风格信任等级色阶：在头像外围以彩色信任环呈现，复用成员名片同一套 VRC_TRUST_COLOR（小写归一化）
    const trustColor = (typeof window.trustColorOf === 'function')
      ? window.trustColorOf(m.trustLevel)
      : ((window.VRC_TRUST_COLOR && m.trustLevel && window.VRC_TRUST_COLOR[(m.trustLevel || '').toLowerCase()]) || '');
    // 【P2-62】状态行只显示玩家自定义状态文字，无自定义时仅显示圆点（不再兜底__('auto_group_3')）
    const statusText = status.text;

    const vid = escJsStr(m.vrchatId || '');
    // 缓存到全局，供 openVrcMemberCard 在详情接口缺字段时回退（确保详情可见信誉/在线状态）
    try { (window.__groupRosterById = window.__groupRosterById || {})[m.vrchatId || m.vrcUserId] = m; } catch (e) {}
    return `
    <div class="group-member-card ${!isOnline ? 'offline' : (m.isInGame ? 'online ingame' : 'online web')}${isFriend ? ' is-friend' : ' not-friend'}" role="button" tabindex="0"
         data-vrchat-id="${escAttr(m.vrchatId || '')}"
         data-tip-dot="${status.dotClass}"
         onclick="openVrcMemberCard('${vid}')"
         onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openVrcMemberCard('${vid}')}">
      <div class="gm-avatar-wrap${trustColor ? ' has-trust-ring' : ''}"${trustColor ? ` style="--tc:${trustColor}"` : ''}>
        <div class="gm-avatar-link" style="cursor:pointer">
          ${avatar ? `<img src="${escAttr(avatar)}" class="gm-avatar" alt="${esc(displayName)}" data-avatar="${escAttr(proxied || '')}" loading="lazy" onerror="window.__avatarFail&&window.__avatarFail(this,'${escAttr(avatar)}')">` : ''}
          <img src="/api/avatar/default" class="gm-avatar" alt="${esc(displayName)}" style="display:none" loading="lazy" onload="this.style.display='';var fb=this.parentNode.querySelector('.gm-avatar-fallback');if(fb)fb.style.display='none';" onerror="this.remove()">
          <div class="gm-avatar-fallback" style="${avatar ? '' : 'display:flex'}">${displayName.charAt(0).toUpperCase()}</div>
        </div>
        ${!isFriend ? '<div class="gm-friend-badge" title="' + __('group.non_friend_tooltip') + '">👤</div>' : ''}
      </div>
      <div class="gm-status-pill ${status.dotClass}" title="${esc(status.title || '')}">${esc(statusText)}</div>
      <span class="gm-name" title="${esc(displayName)}">${esc(displayName)}</span>
    </div>`;
  }).join('');
}

function memberStatusMeta(isOnline, isFriend, vrchatStatus, isInGame, statusDescription) {
  // 【P2-62】状态行 = 圆点 + 玩家自定义状态文字（VRCX 对齐）
  // 圆点颜色/样式表达系统在线状态：绿实心=在线(游戏内)、绿空心圈=网页在线、灰实心=离线、灰空心=未知、
  // 蓝实心=欢迎加入(join me)、橙实心=请先询问(ask me)、红实心=请勿打扰(busy)。
  // 文字只显示 statusDescription（玩家在游戏里自己写的状态），不再显示__('auto_group_4')等系统枚举文字。
  const desc = statusDescription || '';

  if (isOnline === null || isOnline === undefined) {
    return { dotClass: 'unknown', text: desc, title: __('auto_group_5') };
  }
  if (!isOnline) {
    return { dotClass: 'offline', text: desc, title: __('auto_group_6') + (isFriend ? '' : __('auto_group_7')) };
  }
  // 在线：VRChat 预设状态（busy/ask me/join me）优先决定圆点颜色，否则按是否游戏内区分绿实心/绿空心
  let dc;
  if (vrchatStatus === 'busy') dc = 'busy';
  else if (vrchatStatus === 'ask me') dc = 'askme';
  else if (vrchatStatus === 'join me') dc = 'joinme';
  else dc = isInGame ? 'online' : 'web';
  return { dotClass: dc, text: desc, title: desc ? (desc + (isInGame ? ' · 游戏内' : __('auto_group_8'))) : (isInGame ? '游戏内在线' : __('auto_group_9')) };
}

// 【hover 提示】圆点类型 → 状态名（用于卡片悬停提示第一行）
function statusTipLabel(dotClass) {
  const map = {
    'online': __('group.tip_status_online'),
    'web': __('group.tip_status_web'),
    'joinme': __('group.tip_status_joinme'),
    'askme': __('group.tip_status_askme'),
    'busy': __('group.tip_status_busy'),
    'offline': __('group.tip_status_offline'),
    'unknown': __('group.tip_status_unknown')
  };
  return map[dotClass] || '';
}

// ==================== 群组玩家卡片 hover 提示（全局单例挂 body，避免卡片 overflow:hidden 裁剪） ====================
let _gmTipEl = null;
let _gmTipTarget = null;
function ensureGroupTip() {
  if (_gmTipEl) return _gmTipEl;
  _gmTipEl = document.createElement('div');
  _gmTipEl.className = 'gm-hover-tip';
  _gmTipEl.setAttribute('role', 'tooltip');
  document.body.appendChild(_gmTipEl);
  return _gmTipEl;
}
function showGroupTip(card) {
  if (_gmTipTarget === card) return; // 同一卡片内移动，无需重复渲染
  _gmTipTarget = card;
  const dot = card.getAttribute('data-tip-dot') || '';
  const tip = ensureGroupTip();
  tip.innerHTML =
    `<div class="gm-tip-row"><span class="gm-tip-dot ${escAttr(dot)}"></span><span class="gm-tip-label">${esc(statusTipLabel(dot))}</span></div>` +
    `<div class="gm-tip-row gm-tip-action">${esc(__('group.tip_click_detail'))}</div>`;
  const r = card.getBoundingClientRect();
  // 先显示再量尺寸，保证定位准确
  tip.style.opacity = '1';
  tip.style.visibility = 'visible';
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  let left = r.left + r.width / 2 - tw / 2;
  let top = r.top - th - 8;
  if (left < 8) left = 8;
  if (left + tw > window.innerWidth - 8) left = window.innerWidth - tw - 8;
  if (top < 8) top = r.bottom + 8; // 上方放不下 → 放到卡片下方
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}
function hideGroupTip() {
  _gmTipTarget = null;
  if (_gmTipEl) {
    _gmTipEl.style.opacity = '0';
    _gmTipEl.style.visibility = 'hidden';
  }
}

// ==================== 实时增量更新（WebSocket 推送 group:roster_update） ====================
// 服务端在以下时机广播：① 每30秒状态刷新结束；② 全量同步(/group/members/sync)后；
// ③ 手动刷新状态(/group/members/refresh)后；④ 成员加入/离开群组后（forceRosterBroadcast）。
// 数据来源统一为 group_roster，保证前端与服务器实际状态一致。
let _rosterRefreshTimer = null;
function applyRosterUpdate(msg) {
  if (!msg) return;
  const grid = document.getElementById('groupMemberGrid');

  // 1) 增量更新已渲染卡片的状态点（即时反映上下线，不整页重渲染）
  if (Array.isArray(msg.members) && grid) {
    for (const m of msg.members) {
      if (!m || !m.vrchatId) continue;
      const card = grid.querySelector(`.group-member-card[data-vrchat-id="${CSS.escape(m.vrchatId)}"]`);
      if (!card) continue;
      const isOnline = !!m.isOnline;
      const isInGame = !!m.isInGame;
      const isFriend = !!m.isFriend;
      const status = memberStatusMeta(isOnline, isFriend, m.status, isInGame, m.statusDescription);
      card.classList.toggle('online', isOnline);
      card.classList.toggle('offline', !isOnline);
      card.classList.toggle('ingame', isOnline && isInGame);
      card.classList.toggle('web', isOnline && !isInGame);
      card.classList.toggle('is-friend', isFriend);
      card.classList.toggle('not-friend', !isFriend);
      // 状态 pill 徽章：更新圆点 class 与玩家自定义状态文字（无文字时仅显示圆点）
      const pillEl = card.querySelector('.gm-status-pill');
      if (pillEl) {
        pillEl.className = `gm-status-pill ${status.dotClass}`;
        pillEl.textContent = status.text;
      }
      // 同步 hover 提示的圆点类型（状态翻转时 tooltip 文字同步变化）
      card.setAttribute('data-tip-dot', status.dotClass);
      // 所在地/最后可见行随状态变化：上线显示所在地（网页端显示__('auto_group_10')，游戏内显示世界名），离线显示最后可见
      const locationEl = card.querySelector('.gm-location');
      const lastSeenEl = card.querySelector('.gm-last-seen');
      const newLocation = isOnline ? (isInGame && m.worldName ? `🌐 ${formatLocation(m.worldName)}` : __('group.web_online_short')) : '';
      if (locationEl) {
        if (newLocation) locationEl.textContent = newLocation; else locationEl.remove();
      } else if (newLocation) {
        const info = card.querySelector('.gm-info');
        if (info) info.insertAdjacentHTML('beforeend', `<div class="gm-location" title="${escAttr(newLocation)}">${esc(newLocation)}</div>`);
      }
      if (lastSeenEl && isOnline) lastSeenEl.remove();
      // 同步缓存，避免下次整页渲染回退
      if (Array.isArray(groupMembersCache)) {
        const c = groupMembersCache.find(x => x.vrchatId === m.vrchatId);
        if (c) { c.isOnline = isOnline; c.isInGame = isInGame; c.vrchatStatus = m.status; c.isFriend = isFriend; if (m.worldName != null) c.worldName = m.worldName; if (m.statusDescription != null) c.statusDescription = m.statusDescription; }
      }
    }
  }

  // 2) 用广播中的权威统计统一更新概览卡（groupOnlineCount / groupTotalMembers）
  if (Array.isArray(msg.groups) && msg.groups.length > 0) {
    // 本应用为单一 VRChat 群组，取第一个群组的统计；多群组时按当前 groupFilter 对应的群组匹配。
    const g = msg.groups[0];
    const onlineEl = document.getElementById('groupOnlineCount');
    const inGameEl = document.getElementById('groupInGameCount');
    const webEl = document.getElementById('groupWebOnlineCount');
    const totalEl = document.getElementById('groupTotalMembers');
    const unknownEl = document.getElementById('groupUnknownCount');

    // 本地缓存兜底：广播缺失/异常时使用缓存重算
    const cached = (typeof groupMembersCache !== 'undefined' && Array.isArray(groupMembersCache)) ? groupMembersCache : [];
    let useFallback = false;
    let fb = null;
    if (cached.length && Number(g.onlineCount) > 0 && Number(g.inGameCount) === 0 && Number(g.webOnlineCount != null ? g.webOnlineCount : (g.onlineCount - (g.inGameCount || 0))) === 0) {
      useFallback = true;
      fb = {
        online: cached.filter(m => m.isOnline).length,
        ingame: cached.filter(m => m.isInGame).length,
        web: cached.filter(m => m.isOnline && !m.isInGame).length,
        unknown: cached.filter(m => m.isOnline && m.isFriend === false).length,
        total: cached.length
      };
      // eslint-disable-next-line no-console
      console.log(__('auto_group_11'), fb);
    }

    if (onlineEl) onlineEl.textContent = useFallback ? fb.online : g.onlineCount;
    if (inGameEl) inGameEl.textContent = useFallback ? fb.ingame : g.inGameCount;
    if (webEl) webEl.textContent = useFallback ? fb.web : (g.webOnlineCount != null ? g.webOnlineCount : (g.onlineCount - (g.inGameCount || 0)));
    if (totalEl) totalEl.textContent = useFallback ? fb.total : g.totalCount;
    if (unknownEl) unknownEl.textContent = useFallback ? fb.unknown : (g.unknownCount ?? 0);
    const syncEl = document.getElementById('groupSyncTime');
    if (syncEl && msg.timestamp) syncEl.textContent = __('group.synced_at') + formatLastSeen(new Date(msg.timestamp));
  }

  // 3) 防抖整页重渲染：仅当处于__('auto_group_12')（online/offline/nonfriend）时，状态翻转会改变
  //    可见成员集合（新上线者需出现、新离线者需消失），才需要整页重渲染；默认 all 视图下
  //    增量更新已足够，跳过整页避免无谓重排造成的视觉跳变。防抖窗口延长至 1500ms，
  //    过滤后端 stable 窗口内的残留抖动（双保险）。
  if (groupFilter && groupFilter !== 'all') {
    if (_rosterRefreshTimer) clearTimeout(_rosterRefreshTimer);
    _rosterRefreshTimer = setTimeout(() => {
      if (typeof loadGroupMembers === 'function') loadGroupMembers();
      if (typeof loadGroupStats === 'function') loadGroupStats();
    }, 1500);
  }

  // 增量更新后，确保新出现的卡片也会被分批懒加载头像
  lazyLoadGroupAvatars(grid);
}

// ==================== 群组头像分批懒加载器 ====================
// 防 429 雪崩：分批、间隔把真实头像打代理加载
let _avatarLazyTimer = null;
function lazyLoadGroupAvatars(grid) {
  if (!grid) return;
  if (_avatarLazyTimer) clearTimeout(_avatarLazyTimer);
  const BATCH = 12;
  const GAP = 400; // ms
  function step() {
    const pending = grid.querySelectorAll('.gm-avatar[data-avatar]:not([data-loaded]):not([data-failed])');
    if (pending.length === 0) { _avatarLazyTimer = null; return; }
    let n = 0;
    pending.forEach(img => {
      if (n >= BATCH) return;
      const real = img.getAttribute('data-avatar');
      if (!real) { img.setAttribute('data-failed', '1'); return; }
      // 近期失败冷却（60s）内跳过，避免反复打代理
      if (window.__avatarFailCache && window.__avatarFailCache[real] > Date.now() - 60000) {
        img.setAttribute('data-failed', '1'); return;
      }
      img.src = real;
      img.setAttribute('data-loaded', '1');
      n++;
    });
    _avatarLazyTimer = setTimeout(step, GAP);
  }
  _avatarLazyTimer = setTimeout(step, 200);
}

function formatLocation(worldName) {
  if (!worldName) return '';
  const name = worldName.length > 24 ? worldName.substring(0, 22) + '...' : worldName;
  return name;
}

function formatLastSeen(d) {
  if (!d) return '';
  const dt = new Date(d);
  const now = new Date();
  const diff = now - dt;
  if (diff < 60000) return __('group.just_now');
  if (diff < 3600000) return Math.floor(diff / 60000) + __('group.minutes_ago_short');
  if (diff < 86400000) return Math.floor(diff / 3600000) + __('group.hours_ago_short');
  if (diff < 604800000) return Math.floor(diff / 86400000) + __('group.days_ago_short');
  return dt.toLocaleDateString('zh-CN');
}

// ==================== 群组概览 ====================
function updateGroupOverview(members) {
  const total = members.length;
  const online = members.filter(m => m.isOnline).length;
  const ingame = members.filter(m => m.isInGame).length;
  const web = members.filter(m => m.isOnline && !m.isInGame).length;
  const today = new Date().toDateString();
  const joinedToday = members.filter(m => m.joinedAt && new Date(m.joinedAt).toDateString() === today).length;

  document.getElementById('groupTotalMembers').textContent = total;
  document.getElementById('groupOnlineCount').textContent = online;
  document.getElementById('groupInGameCount').textContent = ingame;
  document.getElementById('groupWebOnlineCount').textContent = web;
  document.getElementById('groupJoinedToday').textContent = joinedToday;

  const syncTime = members.length > 0 ? members[0].syncedAt : null;
  const syncEl = document.getElementById('groupSyncTime');
  if (syncEl && syncTime) syncEl.textContent = __('group.synced_at') + formatLastSeen(syncTime);
}

// ==================== 更新统计UI ====================
// 这里的数字全部属于「群组」标签自己：来自 VRChat 群组花名册，
// 指的是群成员在游戏里的在线状态和群成员总数。
// 它们**不能**写进首页统计条的 #dashOnline / #dashMembers ——
// 那两个是__('auto_group_13')，语义不同；两边互相覆盖会让
// 用户看到数字在切标签时来回跳。同理也不写 #groupBadge（本站在线角标）。
function updateGroupStatsUI(stats) {
  const total = document.getElementById('groupTotalMembers');
  const online = document.getElementById('groupOnlineCount');
  const ingame = document.getElementById('groupInGameCount');
  const web = document.getElementById('groupWebOnlineCount');
  const unknown = document.getElementById('groupUnknownCount');

  // 本地 members 缓存兜底：接口返回异常（在线>0但游戏内+网页端都是0）时重新计算
  const cached = (typeof groupMembersCache !== 'undefined' && Array.isArray(groupMembersCache)) ? groupMembersCache : [];
  let fallback = null;
  const onlineVal = Number(stats.onlineCount ?? 0);
  const ingameVal = Number(stats.inGameCount ?? 0);
  const webVal = Number(stats.webOnlineCount ?? (onlineVal - ingameVal));
  if (cached.length && onlineVal > 0 && ingameVal === 0 && webVal === 0) {
    fallback = {
      total: cached.length,
      online: cached.filter(m => m.isOnline).length,
      ingame: cached.filter(m => m.isInGame).length,
      web: cached.filter(m => m.isOnline && !m.isInGame).length,
      unknown: cached.filter(m => m.isOnline && m.isFriend === false).length
    };
    // eslint-disable-next-line no-console
    console.log(__('auto_group_14'), fallback, __('auto_group_15'), stats);
  }

  if (total) total.textContent = fallback ? fallback.total : (stats.totalMembers ?? cached.length ?? '-');
  if (online) online.textContent = fallback ? fallback.online : (stats.onlineCount ?? '-');
  if (ingame) ingame.textContent = fallback ? fallback.ingame : (stats.inGameCount ?? '-');
  if (web) web.textContent = fallback ? fallback.web : (stats.webOnlineCount ?? (onlineVal - ingameVal));
  if (unknown) unknown.textContent = fallback ? fallback.unknown : (stats.unknownCount ?? 0);
}

// ==================== 更新群组Tab徽章 ====================
// 显示的是**本站**实时在线人数（数据来自 WebSocket 的 online_users 推送）。
// 首页统计条只在首页可见，这个角标是它在其它标签下的常驻替身 ——
// 顶栏原来那个__('auto_group_16')就是因为和这两处重复而被移除的。
//
// 红点（角标）显示/清除策略：
//   ① 用户正在查看群组页时 —— 视为已读，立即清除角标，并记录当前在线人数为「已读基线」。
//   ② 用户离开群组页后 —— 仅当实时在线人数【超过】已读基线（有新成员上线）时才重新提示，
//      避免角标一直挂着；人数回落到基线或以下则清除。
//   这样角标只在「有真正新增在线」时才出现，不会被常驻显示。
let _groupBadgeSeenOnline = 0;
function _isOnGroupTab() {
  const el = document.getElementById('tab-group');
  return !!el && !el.classList.contains('d-none');
}
function updateGroupBadge(count) {
  const badge = document.getElementById('groupBadge');
  if (!badge) return;
  count = Number(count) || 0;
  if (_isOnGroupTab()) {
    // 正在查看群组：已读，清除角标并刷新基线
    badge.classList.add('d-none');
    _groupBadgeSeenOnline = count;
    return;
  }
  if (count > _groupBadgeSeenOnline) {
    badge.textContent = count;
    badge.classList.remove('d-none');
  } else {
    badge.classList.add('d-none');
    _groupBadgeSeenOnline = count;
  }
}
// 显式清除（如进入群组页时调用），同时刷新基线
function clearGroupBadge() {
  const badge = document.getElementById('groupBadge');
  if (badge) badge.classList.add('d-none');
  _groupBadgeSeenOnline = 0;
}

// ==================== 筛选 ====================
function filterGroupMembers(filter, btn) {
  groupFilter = filter;
  document.querySelectorAll('.group-filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === filter));
  loadGroupMembers();
}

// ==================== 搜索玩家 ====================
// 群组内按显示名 / VRChat 名称 / VRChat ID 实时搜索，300ms 防抖避免每次按键都打请求。
function setupGroupSearch() {
  const input = document.getElementById('groupSearchInput');
  if (!input) return;
  input.addEventListener('input', () => {
    input.closest('.group-search-box').classList.toggle('has-value', input.value.length > 0);
    if (groupSearchTimer) clearTimeout(groupSearchTimer);
    groupSearchTimer = setTimeout(() => {
      groupSearch = input.value.trim();
      loadGroupMembers();
    }, 300);
  });
  // 清空按钮
  const clearBtn = document.getElementById('groupSearchClear');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      input.value = '';
      input.closest('.group-search-box').classList.remove('has-value');
      groupSearch = '';
      loadGroupMembers();
      input.focus();
    });
  }
}

// ==================== 刷新在线状态 ====================
async function refreshGroupStatus() {
  if (groupStatusRefreshing) return;
  groupStatusRefreshing = true;
  const btn = document.getElementById('refreshGroupBtn');
  if (btn) { btn.disabled = true; btn.textContent = __('group.refreshing'); }

  try {
    // 刷新在线状态要并发拉 VRChat 好友状态（最多 100 人 / 5 并发 / 20 页），
    // 服务端跑 20~60s 是常态。默认 10s 超时会在服务端还在跑时 abort，
    // 用户看到__('auto_group_17')以为失败反复点，反而加重 VRChat 限流。与 sync 对齐为 3 分钟。
    const res = await api('/api/group/members/refresh', { timeout: 180000 });
    if (!res.ok) {
      try {
        const errData = await res.json();
        if (errData.code === 'VRC_SYSTEM_OFFLINE' || errData.code === 'VRC_NOT_LOGGED_IN') {
          toast(__('group.bind_first'), 'warn');
        } else if (errData.code === 'SYNC_COOLDOWN') {
          toast(errData.detail || __('group.refresh_cooldown'), 'warn');
        } else {
          toast(errData.error || __('group.refresh_failed'), 'error');
        }
      } catch { toast(__('group.refresh_failed'), 'error'); }
      return;
    }
    const data = await res.json();
    toast(__('group.refresh_done', {online: data.online, offline: data.offline, total: data.total}), 'success');

    await loadGroupMembers();
    await loadGroupStats();

    // 复用 updateGroupBadge 的「在群组页即视为已读」逻辑，避免手动点亮角标与查看状态冲突（群组问题 13.x）
    if (typeof updateGroupBadge === 'function') updateGroupBadge(data.online);
  } catch (err) {
    if (!isApiHandledError(err)) toast(__('group.refresh_retry'), 'error');
  } finally {
    // 恢复只写一处。原先早退、catch、函数末尾各抄了一份，
    // 任何一条新增的 return 路径漏抄，按钮就永久禁用、刷新功能报废。
    groupStatusRefreshing = false;
    if (btn) { btn.disabled = false; btn.textContent = __('group.refresh_btn'); }
  }
}

// ==================== 同步群组成员 ====================
async function syncGroupMembers() {
  const btn = document.getElementById('syncGroupBtn');
  if (!btn) return;
  if (btn.disabled) return; // 已在同步中，忽略重复点击
  btn.disabled = true;
  btn.textContent = __('group.syncing');

  try {
    // 全量同步要串行拉多页 VRChat 数据，几十秒是常态。
    // 用默认的 10 秒超时会在服务端还在跑的时候就 abort，
    // 用户看到__('auto_group_18')以为没反应就反复点，反而把事情搞乱。
    const res = await api('/api/group/members/sync', { method: 'POST', timeout: 180000 });
    if (!res.ok) {
      try {
        const errData = await res.json();
        if (errData.code === 'VRC_SYSTEM_OFFLINE' || errData.code === 'VRC_NOT_LOGGED_IN') {
          toast(__('group.bind_first'), 'warn');
        } else if (errData.code === 'SYNC_COOLDOWN') {
          toast(errData.detail || __('group.sync_cooldown'), 'warn');
        } else {
          toast(errData.detail || errData.error || __('group.sync_failed'), 'error');
        }
      } catch { toast(__('group.sync_failed_vrc'), 'error'); }
      return;
    }
    const data = await res.json();
    let msg = `${__('group.sync_done', {n: data.total})}`;
    if (data.joined > 0) msg += `，${__('group.new_joined', {n: data.joined})}`;
    if (data.left > 0) msg += `，${__('group.left_count', {n: data.left})}`;
    toast(msg, 'success');
    await loadGroupMembers();
    await loadGroupStats();
  } catch (err) {
    if (!isApiHandledError(err)) toast(__('group.sync_failed_vrc'), 'error');
  } finally {
    // 放在 finally：之前 catch 分支里 loadGroupMembers() 等再抛一次，
    // 或者中途 return，都可能绕过末尾那两行，把按钮永久留在 disabled 状态。
    btn.disabled = false;
    btn.textContent = __('group.sync_btn');
  }
}

// ==================== 变更记录 ====================
async function loadGroupChanges() {
  const section = document.getElementById('groupChangesSection');
  const list = document.getElementById('groupChangesList');
  if (!section || !list) return;

  const isAdmin = currentUser && (currentUser.role === 'admin' || currentUser.role === 'super_admin');
  if (!isAdmin) { section.classList.add('d-none'); return; }
  section.classList.remove('d-none');

  try {
    const res = await api('/api/group/members/changes?limit=20');
    if (!res.ok) return;
    const data = await res.json();
    const changes = data.changes || [];
    document.getElementById('groupChangesCount').textContent = '(' + changes.length + __('group.n_changes_suffix') + ')';
    if (changes.length === 0) {
      renderEmpty(list, { icon: '🔄', text: __('group.no_changes') }); return;
    }
    list.innerHTML = changes.map(c => {
      const icon = c.changeType === 'joined' ? '✅' : c.changeType === 'left' ? '👋' : '🔄';
      const typeLabel = c.changeType === 'joined' ? __('group.status_joined') : c.changeType === 'left' ? __('group.status_left') : __('group.status_changed');
      return `<div class="group-change-item">
        <span class="group-change-icon">${icon}</span>
        <span class="group-change-name">${esc(c.vrchatName)}</span>
        <span class="group-change-type ${c.changeType}">${typeLabel}</span>
        <span class="group-change-time">${formatLastSeen(c.createdAt)}</span>
      </div>`;
    }).join('');
  } catch {}
}

// ==================== WebSocket 实时更新处理 ====================
function handleGroupStatsUpdate(data) {
  if (!data) return;
  
  const onlineCount = data.onlineCount;
  const totalMembers = data.totalMembers;
  const worldDistribution = data.worldDistribution;

  updateGroupStatsUI({
    onlineCount,
    totalMembers,
    worldDistribution,
    onlineRate: totalMembers > 0 ? Math.round((onlineCount / totalMembers) * 100) : 0
  });

  toast(__('group.stats_updated', {online: onlineCount}), 'info', 3000);
}

// ==================== 自动轮询在线状态 ====================
let groupPollTimer = null;
let groupPollInterval = 30000; // 当前轮询间隔，限流时指数退避（上限 5min）
const GROUP_POLL_MIN = 30000;
const GROUP_POLL_MAX = 300000;

function startGroupPolling() {
  if (groupPollTimer) return;
  const tick = () => {
    const tab = document.getElementById('tab-group');
    if (tab && !tab.classList.contains('d-none')) {
      // 限流感知：若处于 VRChat 限流窗口内，跳过本轮请求并把间隔翻倍，避免越刷越糟（雪崩）
      const limitedUntil = window._vrcRateLimitedUntil || 0;
      if (Date.now() < limitedUntil) {
        groupPollInterval = Math.min(groupPollInterval * 2, GROUP_POLL_MAX);
      } else if (groupPollInterval > GROUP_POLL_MIN) {
        groupPollInterval = GROUP_POLL_MIN; // 限流解除后回落到基准
      }
      if (Date.now() >= limitedUntil) {
        loadGroupStats();
      }
      // 注意：成员卡片的在线状态点不再由本 30s 轮询整页拉取驱动，
      // 而是由后端 status 稳定化后的 WebSocket 增量推送（group:roster_update）驱动，
      // 避免与 WS 推送双源冲突造成状态来回跳（窜动）。整页 loadGroupMembers
      // 仅作为 WS 推送的兜底（见 applyRosterUpdate 防抖），不在轮询里重复调用。
    }
    // 以当前（可能退避后的）间隔重新调度，实现动态节奏
    clearInterval(groupPollTimer);
    groupPollTimer = setInterval(tick, groupPollInterval);
  };
  groupPollTimer = setInterval(tick, groupPollInterval);
}

function stopGroupPolling() {
  if (groupPollTimer) { clearInterval(groupPollTimer); groupPollTimer = null; }
}

// ==================== 初始化 ====================
document.addEventListener('DOMContentLoaded', () => {
  setupGroupSearch();
  // 群组玩家卡片 hover 提示（事件委托，动态渲染的卡片也生效）
  document.addEventListener('mouseover', (e) => {
    const card = e.target && e.target.closest ? e.target.closest('.group-member-card') : null;
    if (card) showGroupTip(card);
  });
  document.addEventListener('mouseout', (e) => {
    const card = e.target && e.target.closest ? e.target.closest('.group-member-card') : null;
    if (!card) return;
    // 仍在同一张卡片内部移动（子元素间切换）时不隐藏，避免闪烁
    const related = e.relatedTarget;
    if (related && related.closest && related.closest('.group-member-card') === card) return;
    hideGroupTip();
  });
  if (currentUser) {
    startGroupPolling();
    loadGroupStats();
  }
});