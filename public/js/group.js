/**
 * 境途同游 V6.5 — VRChat 群组成员在线状态
 * 功能：成员列表、在线状态检测、同步、变更通知、实时更新、世界分布
 */

// 剪贴板统一走 core.js 全局 copyTextToClipboard（兼容 http/旧浏览器降级）；copyToClipboard 为兼容别名

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
let groupPage = 1;
const GROUP_PAGE_SIZE = 50;

// 群组成员排序：在线优先 → 在线内好友优先 → 昵称
function sortGroupMembers(list) {
  return list.slice().sort((a, b) => {
    const ao = a.isOnline ? 1 : 0;
    const bo = b.isOnline ? 1 : 0;
    if (ao !== bo) return bo - ao;
    const af = a.isFriend ? 1 : 0;
    const bf = b.isFriend ? 1 : 0;
    if (af !== bf) return bf - af;
    return String(a.displayName || a.vrchatName || a.vrchatId || '')
      .localeCompare(String(b.displayName || b.vrchatName || b.vrchatId || ''), 'zh');
  });
}

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
    groupPage = 1;
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
    // silent：presence 上报是后台副链路（仅已绑定 VRChat 的用户生效），
    // 失败（如上游维护/接口 5xx）不应打断用户的主流程，也不弹全局"服务器内部错误"。
    // timeout 60s：服务端需串行拉≤10 页好友列表（在线+离线各≤5 页），
    // 且受全局 40/min 令牌桶约束可能排队；20s 太短会被 abort（net::ERR_ABORTED）
    // 导致贡献永远静默失败——60s 在覆盖正常耗时与止损之间取平衡。
    // V9.5：服务端已改为 onlineOnly 快模式（只拉在线好友），实际耗时降到秒级。
    await api('/api/group/presence/contribute', { method: 'POST', timeout: 60000, silent: true });
  } catch (e) { /* 静默：仅在已绑定 VRChat 且在线时有效，失败不影响主流程 */ }
}

// ==================== 全局持续贡献（VRCX 式群友互助） ====================
// 只要登录并绑定 VRChat 的用户开着网站，就每 10 分钟后台贡献一次自己的好友状态，
// 而不只等用户打开群组 Tab。这样 group_presence_share 覆盖面远大于"只看群组的人"，
// 系统账号只需补漏（非好友回退），VRChat 官方限流被大量用户账号分摊——刷新更快、
// 更不容易撞 429。页面冻结（切后台标签/锁屏）时暂停，恢复前台后立即补一次。
let _presenceContribTimer = null;
function startGlobalPresenceContributor() {
  if (_presenceContribTimer) return;
  _presenceContribTimer = setInterval(function () {
    if (document.hidden) return; // 后台标签不浪费配额
    contributePresence();
  }, 10 * 60 * 1000);
}
function stopGlobalPresenceContributor() {
  if (_presenceContribTimer) { clearInterval(_presenceContribTimer); _presenceContribTimer = null; }
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
// 光环开关联动：个人中心切换「显示信任光环」后，事件通知群成员列表就地重渲，
// 无需刷新页面即可让光环显示/隐藏即时生效。
document.addEventListener('haloVisibleChanged', function () {
  if (typeof groupMembersCache !== 'undefined' && groupMembersCache) {
    renderGroupMembers(groupMembersCache);
  }
});
// F-头像重试：订阅 __avatarRetryReady（ui.js 头像失败自动重试器发出）。
// 系统 VRChat 会话恢复后，曾在失败冷却中的 /api/avatar/user 头像会收到重试事件，
// 此时把网格中所有仍停留在占位（data-failed/data-loaded 已设置）的对应 img 重新触发懒加载。
(function () {
  let _bound = false;
  function bindGroupAvatarRetry() {
    if (_bound) return;
    _bound = true;
    document.addEventListener('__avatarRetryReady', function (e) {
      const src = e && e.detail && e.detail.src;
      if (!src) return;
      const grid = document.getElementById('groupMemberGrid');
      if (!grid) return;
      grid.querySelectorAll('.gm-avatar[data-avatar]').forEach(function (img) {
        if (img.getAttribute('data-avatar') !== src) return;
        // 清除占位/已完成标记，重新走进懒加载队列（lazyLoadGroupAvatars 会按冷却重判定）
        img.setAttribute('data-failed', '0');
        img.removeAttribute('data-loaded');
      });
      lazyLoadGroupAvatars(grid);
    });
  }
  window.__bindGroupAvatarRetry = bindGroupAvatarRetry;
})();

function renderGroupMembers(members) {
  const grid = document.getElementById('groupMemberGrid');
  if (!grid) return;
  if (typeof window.__bindGroupAvatarRetry === 'function') window.__bindGroupAvatarRetry();
  if (members.length === 0) {
    const icon = groupFilter === 'online' ? '🌙' : groupFilter === 'offline' ? '☀️' : groupFilter === 'web' ? '🌐' : groupFilter === 'ingame' ? '🎮' : groupFilter === 'nonfriend' ? '👤' : '👥';
    const line1 = groupFilter === 'online' ? __('group.no_online')
      : groupFilter === 'offline' ? __('group.no_offline')
      : groupFilter === 'web' ? __('group.no_web')
      : groupFilter === 'ingame' ? __('group.no_ingame')
      : groupFilter === 'nonfriend' ? __('group.no_nonfriend')
      : __('group.no_data');
    renderEmpty(grid, { icon: icon, text: line1 + ' · ' + __('group.sync_first') });
    const pagEl = document.getElementById('groupMemberPagination');
    if (pagEl) pagEl.innerHTML = '';
    return;
  }

  // 在线优先 → 在线内好友优先 → 昵称排序；每页 GROUP_PAGE_SIZE 个，仅分页成员展示区
  const sorted = sortGroupMembers(members);
  const totalPages = Math.max(1, Math.ceil(sorted.length / GROUP_PAGE_SIZE));
  if (groupPage > totalPages) groupPage = totalPages;
  const pageMembers = sorted.slice((groupPage - 1) * GROUP_PAGE_SIZE, groupPage * GROUP_PAGE_SIZE);

  grid.innerHTML = pageMembers.map(m => {
    const isOnline = m.isOnline;
    const isFriend = !!m.isFriend;
    const blacklisted = !!m.blacklisted;
    const status = memberStatusMeta(isOnline, isFriend, m.vrchatStatus, m.isInGame, m.statusDescription);
    // 头像与名片保持一致：优先展示用户自定义头像大图，避免当前佩戴的机器人/奇怪模型遮挡真实形象
    let avatarUrl = m.profilePicOverrideThumbnail || m.avatarUrl;
    // assets.amlcdn.com 是 VRChat 老式缩略图 CDN，国内多数网络 TLS 层即被阻断（回源约 19s 超时）。
    // 此类历史 URL 不再直连代理，统一改走后端按 ID 解析头像接口（系统账号经 api.vrchat.cloud 可达链路）。
    if (/^https?:\/\/[^/]*assets\.amlcdn\.com\//i.test(avatarUrl || '')) avatarUrl = '';
    // VRCX 风格：DB 无头像（群成员 API 对非好友不返回 user 对象）时，走后端
    // /api/avatar/user 按 ID 解析真实头像（旧的 api.vrchat.com/users/{id}/image 兜底已 404，是死链）。
    const vrcFallback = `/api/avatar/user?u=${encodeURIComponent(m.vrchatId || '')}`;
    const proxied = proxyAvatar(avatarUrl || vrcFallback);
    // 【P2-46 渐进加载】仅当该 URL 近期失败过（429/裂图冷却 60s）时才用 default 图标占位，
    // 否则首屏直接渲染真实头像 URL（浏览器并行加载数百张无压力）。
    const avatarFailed = proxied && window.__avatarFailCached(proxied);
    const avatar = avatarFailed ? '/api/avatar/default' : proxied;
    const displayName = m.displayName || m.vrchatName || m.vrchatId;
    // VRCX 风格信任等级色阶：在头像外围以彩色信任环呈现，复用成员名片同一套 VRC_TRUST_COLOR（小写归一化）
    // 无信任等级时用默认环色，保证开关打开时每个头像都有环。
    const trustColor = ((typeof window.trustColorOf === 'function')
      ? window.trustColorOf(m.trustLevel)
      : ((window.VRC_TRUST_COLOR && m.trustLevel && window.VRC_TRUST_COLOR[(m.trustLevel || '').toLowerCase()]) || '')) || window.DEFAULT_TRUST_COLOR;
    // 【光环显示开关】每个用户可在「我的信息 → 头像显示设置」关闭自己的信任光环；
    // 语义为「我的光环是否对别人可见」——别人浏览时按该成员自己的 haloVisible 渲染，
    // 而不是按浏览者自己的开关（避免某用户关掉开关导致全站光环消失）。
    // 非网站用户（无绑定 users 记录）haloVisible 为 null → 默认显示光环。
    const haloOn = m.haloVisible !== false;
    const ringClass = haloOn ? ' has-trust-ring' : '';
    const ringStyle = haloOn ? ` style="--tc:${trustColor}"` : '';
    // 【P2-62】状态行只显示玩家自定义状态文字，无自定义时仅显示圆点（不再兜底__('auto_group_3')）
    const statusText = status.text;

    // 缓存到全局，供 openVrcMemberCard 在详情接口缺字段时回退（确保详情可见信誉/在线状态）
    try { (window.__groupRosterById = window.__groupRosterById || {})[m.vrchatId || m.vrcUserId] = m; } catch (e) {}
    return `
    <div class="group-member-card ${!isOnline ? 'offline' : (m.isInGame ? 'online ingame' : 'online web')}${isFriend ? ' is-friend' : ' not-friend'}" role="button" tabindex="0"
         data-vrchat-id="${escAttr(m.vrchatId || m.vrcUserId || '')}"
         data-tip-dot="${status.dotClass}"
         data-action="group-open-vrc-card">
      <div class="gm-avatar-wrap${ringClass}"${ringStyle}>
        <div class="gm-avatar-link" style="cursor:pointer">
          ${avatar ? `<img src="${escAttr(avatar)}" class="gm-avatar" alt="${esc(displayName)}" data-avatar="${escAttr(proxied || '')}" loading="lazy" data-avatar-fail-src="${escAttr(avatar)}">` : ''}
          <img src="/api/avatar/default" class="gm-avatar" alt="${esc(displayName)}" data-gm-default-avatar="1" ${avatar ? 'style="display:none"' : ''} loading="lazy">
          <div class="gm-avatar-fallback" style="${avatar ? '' : 'display:flex'}">${esc(displayName.charAt(0).toUpperCase())}</div>
        </div>
        ${!isFriend ? '<div class="gm-friend-badge" title="' + __('group.non_friend_tooltip') + '">👤</div>' : ''}
        ${blacklisted ? '<div class="gm-bl-badge" title="' + __('group.blacklisted_tooltip') + '">🚫</div>' : ''}
      </div>
      <div class="gm-status-pill ${status.dotClass}" title="${esc(status.title || '')}">${esc(statusText)}</div>
      <span class="gm-name" title="${esc(displayName)}">${esc(displayName)}</span>
      ${m.siteUserId && m.siteUserId !== (currentUser && currentUser.id)
        ? `<button type="button" class="gm-follow-btn ${m.isFollowing ? 'following' : ''}" data-action="group-follow" data-site-user-id="${escAttr(String(m.siteUserId))}" data-following="${m.isFollowing ? '1' : '0'}" title="${m.isFollowing ? '取消关注' : '关注'}">${m.isFollowing ? '✓ 已关注' : '+ 关注'}</button>`
        : ''}
    </div>`;
  }).join('');
  // 默认头像兜底图：仅当该成员没有主头像（avatar 为空，未渲染主 img）时才显示自身
  // 并隐藏首字母占位；有主头像的成员保持隐藏（主头像加载失败时 __avatarFail 已把
  // 主 img 的 src 换成 /api/avatar/default，无需这张重复图，否则会出现双头像错位）。
  // 失败 → 移除。原内联 onload/onerror 被 CSP 拦截，改为渲染后逐张绑定（onerror
  // 属性赋值同时让 core.js 全局错误捕获跳过这些图，避免 __avatarFail 重试链改写"移除"语义）。
  grid.querySelectorAll('img[data-gm-default-avatar]').forEach(function (img) {
    var hasMain = img.previousElementSibling && img.previousElementSibling.tagName === 'IMG';
    img.onload = function () {
      if (img.dataset.gmDefDone) return;
      img.dataset.gmDefDone = '1';
      if (hasMain) { img.style.display = 'none'; return; }
      img.style.display = '';
      var fb = img.parentNode && img.parentNode.querySelector('.gm-avatar-fallback');
      if (fb) fb.style.display = 'none';
    };
    img.onerror = function () {
      if (img.parentNode) img.parentNode.removeChild(img);
    };
    // 缓存命中时 load 事件可能已完成（complete=true），补跑一次兜底
    if (img.complete) {
      if (img.naturalWidth > 0) img.onload(); else img.onerror();
    }
  });
  renderGroupPagination(totalPages, sorted.length);
}

// 成员列表分页栏：仅作用于群组玩家展示区（统计/过滤/搜索不受影响）
function renderGroupPagination(totalPages, totalCount) {
  const pagEl = document.getElementById('groupMemberPagination');
  if (!pagEl) return;
  if (!totalPages || totalPages <= 1) { pagEl.innerHTML = ''; return; }
  let html = '';
  if (groupPage > 1) {
    html += `<button type="button" class="pagination-btn" data-group-page="1" title="${__('admin_users.title_first_page')}">&laquo;</button>`;
    html += `<button type="button" class="pagination-btn" data-group-page="${groupPage - 1}">&lsaquo;</button>`;
  }
  const start = Math.max(1, groupPage - 2);
  const end = Math.min(totalPages, groupPage + 2);
  for (let i = start; i <= end; i++) {
    html += `<button type="button" class="pagination-btn${i === groupPage ? ' active' : ''}" data-group-page="${i}">${i}</button>`;
  }
  if (groupPage < totalPages) {
    html += `<button type="button" class="pagination-btn" data-group-page="${groupPage + 1}">&rsaquo;</button>`;
    html += `<button type="button" class="pagination-btn" data-group-page="${totalPages}" title="${__('admin_users.title_last_page')}">&raquo;</button>`;
  }
  html += `<span class="text-muted2 text-12 ml-8">共 ${totalCount} 人 · 第 ${groupPage}/${totalPages} 页</span>`;
  pagEl.innerHTML = html;
}

// ==================== VRChat 黑名单视图（VRC 页新 Tab，所有登录用户可见） ====================
// GET 已放开为登录可见（后端 requireAuth）；新增/删除仍仅超管。函数放 group.js（始终加载），
// 不依赖懒加载的 admin-vrc.js，保证黑名单 Tab 对普通用户也能打开。
async function loadVrcBlacklistView() {
  const listEl = document.getElementById('vrcBlacklistViewList');
  if (!listEl) return;
  listEl.innerHTML = '<p class="text-muted2 text-13">' + __('admin_vrc.bl_loading') + '</p>';
  try {
    const res = await api('/api/admin/vrc-blacklist', { method: 'GET', timeout: 30000 });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(errText(err) || __('admin_vrc.load_failed')); }
    const data = await res.json();
    const items = data.items || [];
    const countEl = document.getElementById('vrcBlacklistViewCount');
    if (countEl) countEl.textContent = __('admin_vrc.bl_count', { n: items.length });
    const canManage = isVrcBlacklistManager();
    if (!items.length) {
      listEl.innerHTML = '<p class="text-muted2 text-13">' + __('admin_vrc.bl_empty') + '</p>';
      const addBar = document.getElementById('vrcBlacklistViewAddBar');
      if (addBar) addBar.style.display = canManage ? '' : 'none';
      return;
    }
    const addBar = document.getElementById('vrcBlacklistViewAddBar');
    if (addBar) addBar.style.display = canManage ? '' : 'none';
    listEl.innerHTML = items.map(it => {
      const name = it.memberName || it.username || it.vrchatId || '-';
      // 头像：优先后端已解析头像；assets.amlcdn.com 老 CDN 国内 TLS 阻断不直连，
      // 无头像时走后端 /api/avatar/user 按 ID 解析真实头像（系统账号回源 + 缓存 + 限速）
      let avatarUrl = it.avatarUrl || '';
      if (/^https?:\/\/[^/]*assets\.amlcdn\.com\//i.test(avatarUrl)) avatarUrl = '';
      const vrcFallback = it.vrchatId ? `/api/avatar/user?u=${encodeURIComponent(it.vrchatId)}` : '';
      const avatarSrc = proxyAvatar(avatarUrl || vrcFallback) || '/api/avatar/default';
      const avatarFailed = typeof window.__avatarFailCached === 'function' && window.__avatarFailCached(avatarSrc);
      const avatarHtml = avatarFailed
        ? '<span class="vrc-blacklist-avatar vrc-blacklist-avatar-fallback">🚫</span>'
        : `<img class="vrc-blacklist-avatar" src="${escAttr(avatarSrc)}" alt="" loading="lazy">`;
      const sourceBadge = it.source === 'group'
        ? `<span class="vrc-blacklist-source">${__('admin_vrc.bl_source_group')}</span>`
        : `<span class="vrc-blacklist-source vrc-blacklist-source-manual">${__('admin_vrc.bl_source_manual')}</span>`;
      const bannedBadge = it.banned
        ? `<span class="vrc-blacklist-banned">${__('admin_vrc.bl_banned')}</span>`
        : `<span class="vrc-blacklist-banned vrc-blacklist-unbanned">${__('admin_vrc.bl_unbanned')}</span>`;
      // 官网账号页：后端已统一带 profileUrl；再做一层前端兜底
      const profileUrl = it.profileUrl || it.url
        || (it.vrchatId ? 'https://vrchat.com/home/user/' + encodeURIComponent(it.vrchatId) : '');
      // scheme 校验：仅 http/https 才可进 href，防 javascript:/data: 注入
      const safeProfileUrl = (profileUrl && safeHref(profileUrl)) ? profileUrl : '';
      const profileBtn = safeProfileUrl
        ? `<a class="btn btn-xs btn-outline vrc-blacklist-profile" href="${escAttr(safeProfileUrl)}" target="_blank" rel="noopener noreferrer" title="${escAttr(__('admin_vrc.bl_profile'))}">🌐 ${__('admin_vrc.bl_profile')}</a>`
        : '';
      return `
      <div class="vrc-blacklist-item">
        <div class="vrc-blacklist-head">
          ${avatarHtml}
          <span class="vrc-blacklist-name">${esc(name)}</span>
          ${it.vrchatId ? `<span class="vrc-blacklist-id">${esc(it.vrchatId)}</span>` : ''}
          ${sourceBadge}${bannedBadge}
          ${profileBtn}
          ${canManage ? `<button class="btn btn-xs btn-outline ml-auto" data-vrc-action="blacklist-view-remove" data-id="${escAttr(String(it.id))}" title="${__('admin_vrc.bl_remove')}">🗑️ ${__('admin_vrc.bl_remove')}</button>` : ''}
        </div>
        ${(it.url && safeHref(it.url)) ? `<div class="vrc-blacklist-url">🔗 <a href="${escAttr(it.url)}" target="_blank" rel="noopener noreferrer">${esc(it.url)}</a></div>` : ''}
        ${it.reason ? `<div class="vrc-blacklist-reason">${__('admin_vrc.bl_reason_label')}${esc(it.reason)}</div>` : ''}
        <div class="vrc-blacklist-meta">${__('admin_vrc.bl_added_by')} ${esc(it.createdByName || __('admin_vrc.bl_system_sync'))} · ${fmtDate(it.createdAt)}${it.syncedAt ? ' · ' + __('admin_vrc.bl_synced_at') + ' ' + fmtDate(it.syncedAt) : ''}</div>
      </div>
    `;
    }).join('');
    // 头像加载失败兜底：代理失败先反解直连重试一次，仍失败换默认占位（CSP 无 inline 事件）
    listEl.querySelectorAll('img.vrc-blacklist-avatar').forEach(function (img) {
      img.addEventListener('error', function () {
        if (!this.dataset.retried) {
          this.dataset.retried = '1';
          const direct = (typeof window.avatarDirectOf === 'function' && window.avatarDirectOf(this.src)) || '';
          if (direct && direct !== this.src) { this.src = direct; return; }
        }
        const wrap = this.parentElement;
        const fb = document.createElement('span');
        fb.className = 'vrc-blacklist-avatar vrc-blacklist-avatar-fallback';
        fb.textContent = '🚫';
        if (wrap && wrap.contains(this)) wrap.replaceChild(fb, this);
        else this.style.display = 'none';
      });
    });
  } catch (e) {
    const msg = String((e && e.message) || __('admin_vrc.load_failed'));
    listEl.innerHTML = '<p class="text-red text-13">' + (typeof esc === 'function' ? esc(msg) : msg) + '</p>';
  }
}
window.loadVrcBlacklistView = loadVrcBlacklistView;

function addVrcBlacklistViewItem() {
  if (!isVrcBlacklistManager()) { toast(__('admin_vrc.super_admin_only'), 'error'); return; }
  const username = document.getElementById('blvUsername')?.value?.trim();
  if (!username) { toast(__('admin_vrc.bl_need_username'), 'error'); return; }
  try {
    api('/api/admin/vrc-blacklist', {
      method: 'POST',
      body: {
        username,
        url: document.getElementById('blvUrl')?.value?.trim() || '',
        vrchatId: document.getElementById('blvVrchatId')?.value?.trim() || '',
        reason: document.getElementById('blvReason')?.value?.trim() || ''
      },
      timeout: 30000
    }).then(async (res) => {
      if (!res.ok) { const err = await res.json().catch(() => ({})); toast(errText(err) || __('admin_vrc.op_failed'), 'error'); return; }
      toast(__('admin_vrc.bl_added'), 'success');
      ['blvUsername', 'blvUrl', 'blvVrchatId', 'blvReason'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
      loadVrcBlacklistView();
    }).catch((err) => { if (isApiHandledError(err)) return; toast(__('admin_vrc.op_failed') + ': ' + err.message, 'error'); });
  } catch (err) { if (isApiHandledError(err)) return; toast(__('admin_vrc.op_failed') + ': ' + err.message, 'error'); }
}

function removeVrcBlacklistViewItem(id) {
  if (!isVrcBlacklistManager()) { toast(__('admin_vrc.super_admin_only'), 'error'); return; }
  showConfirm(__('admin_vrc.bl_remove_confirm'), async () => {
    try {
      const res = await api('/api/admin/vrc-blacklist/' + id, { method: 'DELETE', timeout: 30000 });
      if (!res.ok) { const err = await res.json().catch(() => ({})); toast(errText(err) || __('admin_vrc.op_failed'), 'error'); return; }
      toast(__('admin_vrc.bl_removed'), 'success');
      loadVrcBlacklistView();
    } catch (err) { if (isApiHandledError(err)) return; toast(__('admin_vrc.op_failed') + ': ' + err.message, 'error'); }
  });
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
  return { dotClass: dc, text: desc, title: desc ? (desc + (isInGame ? ' · ' + __('group.ingame_label') : __('auto_group_8'))) : (isInGame ? __('group.ingame_online') : __('auto_group_9')) };
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
      // 近期失败冷却（60s）内跳过，避免反复打代理；同时登记冷却到期自动重试
      // （系统会话恢复后 ui.js __avatarRetryReady 会通知本模块重新加载该 URL）
      if (window.__avatarFailCached(real)) {
        img.setAttribute('data-failed', '1');
        if (typeof window.__avatarRegisterRetry === 'function') window.__avatarRegisterRetry(real);
        return;
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
  return dt.toLocaleDateString(getCurrentLang ? getCurrentLang() : 'zh');
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
        const el = document.getElementById('tab-vrc');
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
      input.focus({ preventScroll: true });
    });
  }
}

// ==================== 刷新在线状态 ====================
function vrcTaskBarShow(text) {
  if (typeof window.vrcSync !== 'undefined' && window.vrcSync.showTask) { try { window.vrcSync.showTask(text); } catch (e) {} }
}
function vrcTaskBarDone(text, opts) {
  if (typeof window.vrcSync !== 'undefined' && window.vrcSync.taskDone) { try { window.vrcSync.taskDone(text, opts); } catch (e) {} }
}

async function refreshGroupStatus() {
  if (groupStatusRefreshing) return;
  groupStatusRefreshing = true;
  const btn = document.getElementById('refreshGroupBtn');
  if (btn) {
    btn.disabled = true;
    // 活反馈：内嵌圆形进度环 + 动态文案，避免"正在刷新在线状态…"长时间静止像卡死
    btn.innerHTML = '<span class="ring-progress" aria-hidden="true"></span> ' + __('group.refreshing');
  }
  vrcTaskBarShow(__('group.refreshing'));

  // 心跳：每 2s 轻微呼吸一次按钮文案（透明度闪烁），提示任务仍在进行
  let heartbeat = null;
  if (btn) {
    heartbeat = setInterval(function () {
      if (!groupStatusRefreshing) return;
      btn.style.opacity = (btn.style.opacity === '0.55') ? '1' : '0.55';
    }, 2000);
  }

  try {
    // 刷新在线状态：服务端走 /auth/user/friends 全量解析（好友不截断，非好友回退≤25 人），
    // 服务端跑 20~60s 是常态。默认 10s 超时会在服务端还在跑时 abort，
    // 用户看到__('auto_group_17')以为失败反复点，反而加重 VRChat 限流。与 sync 对齐为 3 分钟。
    const res = await api('/api/group/members/refresh', { timeout: 180000 });
    if (!res.ok) {
      try {
        const errData = await res.json();
        if (errData.code === 'VRC_SYSTEM_OFFLINE' || errData.code === 'VRC_NOT_LOGGED_IN') {
          toast(__('group.bind_first'), 'warn');
          vrcTaskBarDone(__('group.bind_first'), { err: true });
        } else if (errData.code === 'SYNC_COOLDOWN') {
          toast(errData.detail || __('group.refresh_cooldown'), 'warn');
          vrcTaskBarDone(errData.detail || __('group.refresh_cooldown'), { err: true });
        } else {
          toast(errText(errData) || __('group.refresh_failed'), 'error');
          vrcTaskBarDone(errText(errData) || __('group.refresh_failed'), { err: true });
        }
      } catch { toast(__('group.refresh_failed'), 'error'); vrcTaskBarDone(__('group.refresh_failed'), { err: true }); }
      return;
    }
    const data = await res.json();
    // 顶部状态栏同时透出结果（复用收藏同步状态条），避免列表深处的用户看不到反馈
    vrcTaskBarDone(__('group.refresh_done', {online: data.online, offline: data.offline, total: data.total}), { keepMs: 5000 });
    toast(__('group.refresh_done', {online: data.online, offline: data.offline, total: data.total}), 'success');

    await loadGroupMembers();
    await loadGroupStats();

    // 复用 updateGroupBadge 的「在群组页即视为已读」逻辑，避免手动点亮角标与查看状态冲突（群组问题 13.x）
    if (typeof updateGroupBadge === 'function') updateGroupBadge(data.online);
  } catch (err) {
    if (!isApiHandledError(err)) toast(__('group.refresh_retry'), 'error');
    if (!isApiHandledError(err)) vrcTaskBarDone(__('group.refresh_retry'), { err: true });
  } finally {
    // 恢复只写一处。原先早退、catch、函数末尾各抄了一份，
    // 任何一条新增的 return 路径漏抄，按钮就永久禁用、刷新功能报废。
    groupStatusRefreshing = false;
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    if (btn) {
      btn.disabled = false;
      btn.style.opacity = '1';
      btn.textContent = __('group.sync_status_btn');
    }
  }
}

// ==================== 同步群组成员 ====================
async function syncGroupMembers() {
  const btn = document.getElementById('syncGroupBtn');
  if (!btn) return;
  if (btn.disabled) return; // 已在同步中，忽略重复点击
  btn.disabled = true;
  btn.innerHTML = '<span class="ring-progress" aria-hidden="true"></span> ' + __('group.syncing');
  vrcTaskBarShow(__('group.syncing'));

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
          vrcTaskBarDone(__('group.bind_first'), { err: true });
        } else if (errData.code === 'SYNC_COOLDOWN') {
          toast(errData.detail || __('group.sync_cooldown'), 'warn');
          vrcTaskBarDone(errData.detail || __('group.sync_cooldown'), { err: true });
        } else {
          toast(errText(errData) || __('group.sync_failed'), 'error');
          vrcTaskBarDone(errText(errData) || __('group.sync_failed'), { err: true });
        }
      } catch { toast(__('group.sync_failed_vrc'), 'error'); vrcTaskBarDone(__('group.sync_failed_vrc'), { err: true }); }
      return;
    }
    const data = await res.json();
    let msg = `${__('group.sync_done', {n: data.total})}`;
    if (data.joined > 0) msg += `，${__('group.new_joined', {n: data.joined})}`;
    if (data.left > 0) msg += `，${__('group.left_count', {n: data.left})}`;
    vrcTaskBarDone(msg, { keepMs: 6000 });
    toast(msg, 'success');
    await loadGroupMembers();
    await loadGroupStats();
  } catch (err) {
    if (!isApiHandledError(err)) toast(__('group.sync_failed_vrc'), 'error');
    if (!isApiHandledError(err)) vrcTaskBarDone(__('group.sync_failed_vrc'), { err: true });
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
    // 变动时间显示绝对时间戳（YYYY-MM-DD HH:mm），网站数据同步延后时用户能直接算出多久前发生；
    // 相对时间（formatLastSeen）放 title 作为辅助。
    const fmtChangeTime = (x) => {
      if (!x) return '—';
      const dt = new Date(x);
      if (isNaN(dt.getTime())) return esc(String(x));
      return dt.toLocaleString(getCurrentLang ? getCurrentLang() : 'zh', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    };
    list.innerHTML = changes.map(c => {
      const icon = c.changeType === 'joined' ? '✅' : c.changeType === 'left' ? '👋' : '🔄';
      const typeLabel = c.changeType === 'joined' ? __('group.status_joined') : c.changeType === 'left' ? __('group.status_left') : __('group.status_changed');
      const absTime = fmtChangeTime(c.createdAt);
      const relText = formatLastSeen(c.createdAt);
      return `<div class="group-change-item">
        <span class="group-change-icon">${icon}</span>
        <span class="group-change-name">${esc(c.vrchatName)}</span>
        <span class="group-change-type ${c.changeType}">${typeLabel}</span>
        <span class="group-change-time"${relText !== absTime ? ` title="${escAttr(relText)}"` : ''}>${absTime}</span>
      </div>`;
    }).join('');
  } catch {}
}

// ==================== F-6/F-23 群组内容管理（管理员面板） ====================
// 面板均为 admin-only 折叠项：展开时懒加载列表，写操作走用户本人 VRChat cookie（后端强制）。
function isAdminUser() {
  return !!(currentUser && (currentUser.role === 'admin' || currentUser.role === 'super_admin'));
}

// B2 修复：VRC 黑名单的增删接口后端固定 requireSuperAdmin（普通 admin 全 403），
// 前端判定与之对齐——只有超管渲染操作按钮/输入栏，普通管理员不再看到点了必失败的控件。
function isVrcBlacklistManager() {
  return !!(currentUser && currentUser.role === 'super_admin');
}

// api() 对 401/403/429/5xx 已统一弹提示；这里只兜底 400 类静默失败，把后端错误文案吐出来
async function groupAdminFail(res) {
  try {
    const d = await res.json();
    const msg = errText(d);
    if (msg) toast(msg, 'error');
  } catch {}
}

// bindGroupAdminPanel：注册"展开时懒加载"。
// 面板均为 admin-only 折叠项，位于 vrc tab 的 vrcGroupMgmtView 内。
// 若在页面加载时就拉取，会：(1) 系统 VRC 账号正常时每进站白耗 5+ 次 VRChat 配额，
// 加剧 429；(2) 系统 VRC 账号失效时在首页就同时炸出多个错误提示（重登弹窗 + 多条失败 toast）。
// 因此这里只登记加载器，真正触发在 switchVrcView 展开 groupmgmt 视图并派发 vrc:mgmt-shown 时。
let _adminPanelsRegistered = new Set();
let _pendingAdminPanelLoaders = [];
let _adminPanelHookBound = false;

function bindGroupAdminPanel(id, loader) {
  const el = document.getElementById(id);
  if (!el || !isAdminUser()) return;
  if (_adminPanelsRegistered.has(id)) return; // 重复 setupGroupAdminPanels 不重复登记
  _adminPanelsRegistered.add(id);
  _pendingAdminPanelLoaders.push(loader);
  if (!_adminPanelHookBound) {
    _adminPanelHookBound = true;
    document.addEventListener('vrc:mgmt-shown', () => {
      // 每次展开群组管理视图都重新拉取（与原"打开即刷新"行为一致），
      // 单个面板失败不影响其余
      _pendingAdminPanelLoaders.forEach(fn => { try { fn(); } catch (e) { /* 忽略 */ } });
    });
  }
}

function bindGroupAdminClick(id, fn) {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', fn);
}

function setupGroupAdminPanels() {
  if (!isAdminUser()) return;
  bindGroupAdminPanel('groupAnnouncementsSection', loadGroupAnnouncements);
  bindGroupAdminPanel('groupGalleriesSection', loadGroupGalleries);
  bindGroupAdminPanel('groupRolesSection', loadGroupRoles);
  bindGroupAdminPanel('groupAuditLogsSection', loadGroupAuditLogs);
  bindGroupAdminPanel('groupBansSection', loadGroupBans);
  bindGroupAdminPanel('groupInvitesSection', loadGroupInvites);
  bindGroupAdminClick('groupAnnPublishBtn', publishGroupAnnouncement);
  bindGroupAdminClick('groupGalCreateBtn', createGroupGallery);
  bindGroupAdminClick('groupRoleCreateBtn', createGroupRole);
  bindGroupAdminClick('groupRoleAddBtn', () => applyGroupMemberRole('add'));
  bindGroupAdminClick('groupRoleRemoveBtn', () => applyGroupMemberRole('remove'));
  bindGroupAdminClick('groupBanBtn', banGroupMemberAction);
  bindGroupAdminClick('groupCalFollowBtn', () => groupCalendarAction('follow'));
  bindGroupAdminClick('groupCalUnfollowBtn', () => groupCalendarAction('unfollow'));
  bindGroupAdminClick('groupInviteSendBtn', sendGroupInvites);
  bindGroupAdminClick('groupInviteRefreshBtn', loadGroupInvites);
}

// ---- 群公告 ----
async function loadGroupAnnouncements() {
  const list = document.getElementById('groupAnnouncementsList');
  if (!list) return;
  try {
    const res = await api('/api/group/announcements');
    if (!res.ok) { await groupAdminFail(res); return; }
    const data = await res.json();
    const items = data.announcements || [];
    if (!items.length) { renderEmpty(list, { icon: '📢', text: __('group.no_announcements') }); return; }
    list.innerHTML = items.map(a => {
      const id = a.announcementId || a.id || '';
      const title = a.title || __('group.untitled');
      const text = a.text || '';
      return `<div class="group-change-item" data-ann-id="${esc(id)}">
        <span class="group-change-icon">📢</span>
        <span class="group-change-name" title="${esc(text)}">${esc(title)}</span>
        <span class="group-change-type">${esc(String(text).slice(0, 30))}</span>
        <button class="btn btn-sm btn-outline" data-action="ann-del">${__('group.delete_btn')}</button>
      </div>`;
    }).join('');
    list.querySelectorAll('[data-action="ann-del"]').forEach(btn => {
      btn.addEventListener('click', () => deleteGroupAnnouncement(btn.closest('[data-ann-id]').dataset.annId));
    });
  } catch {}
}

async function publishGroupAnnouncement() {
  const titleEl = document.getElementById('groupAnnTitle');
  const textEl = document.getElementById('groupAnnText');
  const notifyEl = document.getElementById('groupAnnNotify');
  if (!titleEl || !textEl) return;
  const title = titleEl.value.trim();
  const text = textEl.value.trim();
  if (!title || !text) { toast(__('group.ann_required'), 'error'); return; }
  const res = await api('/api/group/announcements', { method: 'POST', body: { title, text, sendNotification: notifyEl ? !!notifyEl.checked : true } });
  if (!res.ok) { await groupAdminFail(res); return; }
  titleEl.value = '';
  textEl.value = '';
  toast(__('group.ann_published'), 'success');
  loadGroupAnnouncements();
}

async function deleteGroupAnnouncement(id) {
  if (!id) return;
  showConfirm(__('group.ann_del_confirm'), async function () {
    const res = await api('/api/group/announcements/' + encodeURIComponent(id), { method: 'DELETE' });
    if (!res.ok) { await groupAdminFail(res); return; }
    toast(__('group.op_done'), 'success');
    loadGroupAnnouncements();
  });
}

// ---- 群相册 ----
async function loadGroupGalleries() {
  const list = document.getElementById('groupGalleriesList');
  if (!list) return;
  try {
    const res = await api('/api/group/galleries');
    if (!res.ok) { await groupAdminFail(res); return; }
    const data = await res.json();
    const items = data.galleries || [];
    if (!items.length) { renderEmpty(list, { icon: '🖼️', text: __('group.no_galleries') }); return; }
    list.innerHTML = items.map(g => {
      const id = g.galleryId || g.id || '';
      const name = g.name || __('group.untitled');
      const desc = g.description || '';
      return `<div class="group-change-item" data-gal-id="${esc(id)}">
        <span class="group-change-icon">🖼️</span>
        <span class="group-change-name" title="${esc(desc)}">${esc(name)}</span>
        <button class="btn btn-sm btn-outline" data-action="gal-rename">${__('group.rename_btn')}</button>
        <button class="btn btn-sm btn-outline" data-action="gal-del">${__('group.delete_btn')}</button>
      </div>`;
    }).join('');
    list.querySelectorAll('[data-action="gal-rename"]').forEach(btn => {
      btn.addEventListener('click', () => renameGroupGallery(btn.closest('[data-gal-id]').dataset.galId, btn.parentElement.querySelector('.group-change-name').textContent));
    });
    list.querySelectorAll('[data-action="gal-del"]').forEach(btn => {
      btn.addEventListener('click', () => deleteGroupGallery(btn.closest('[data-gal-id]').dataset.galId));
    });
  } catch {}
}

async function createGroupGallery() {
  const nameEl = document.getElementById('groupGalName');
  const descEl = document.getElementById('groupGalDesc');
  if (!nameEl) return;
  const name = nameEl.value.trim();
  if (!name) { toast(__('group.gal_required'), 'error'); return; }
  const res = await api('/api/group/galleries', { method: 'POST', body: { name, description: descEl ? descEl.value.trim() : '' } });
  if (!res.ok) { await groupAdminFail(res); return; }
  nameEl.value = '';
  if (descEl) descEl.value = '';
  toast(__('group.op_done'), 'success');
  loadGroupGalleries();
}

async function renameGroupGallery(id, oldName) {
  if (!id) return;
  showInput(__('group.gal_rename_prompt'), oldName || '', async function (name) {
    if (!name || !name.trim()) return;
    const res = await api('/api/group/galleries/' + encodeURIComponent(id), { method: 'PUT', body: { name: name.trim() } });
    if (!res.ok) { await groupAdminFail(res); return; }
    toast(__('group.op_done'), 'success');
    loadGroupGalleries();
  });
}

async function deleteGroupGallery(id) {
  if (!id) return;
  showConfirm(__('group.gal_del_confirm'), async function () {
    const res = await api('/api/group/galleries/' + encodeURIComponent(id), { method: 'DELETE' });
    if (!res.ok) { await groupAdminFail(res); return; }
    toast(__('group.op_done'), 'success');
    loadGroupGalleries();
  });
}

// ---- 群角色 ----
async function loadGroupRoles() {
  const list = document.getElementById('groupRolesList');
  const select = document.getElementById('groupRoleSelect');
  if (!list) return;
  try {
    const res = await api('/api/group/roles');
    if (!res.ok) { await groupAdminFail(res); return; }
    const data = await res.json();
    const items = data.roles || [];
    // 同步"成员角色授予/移除"下拉框
    if (select) {
      select.innerHTML = items.map(r => `<option value="${esc(r.id || r.roleId || '')}">${esc(r.name || '-')}</option>`).join('');
    }
    if (!items.length) { renderEmpty(list, { icon: '🎭', text: __('group.no_roles') }); return; }
    list.innerHTML = items.map(r => {
      const id = r.id || r.roleId || '';
      const name = r.name || '-';
      const desc = r.description || '';
      return `<div class="group-change-item" data-role-id="${esc(id)}">
        <span class="group-change-icon">🎭</span>
        <span class="group-change-name" title="${esc(desc)}">${esc(name)}</span>
        <button class="btn btn-sm btn-outline" data-action="role-del">${__('group.delete_btn')}</button>
      </div>`;
    }).join('');
    list.querySelectorAll('[data-action="role-del"]').forEach(btn => {
      btn.addEventListener('click', () => deleteGroupRole(btn.closest('[data-role-id]').dataset.roleId));
    });
  } catch {}
}

async function createGroupRole() {
  const nameEl = document.getElementById('groupRoleName');
  const descEl = document.getElementById('groupRoleDesc');
  if (!nameEl) return;
  const name = nameEl.value.trim();
  if (!name) { toast(__('group.role_required'), 'error'); return; }
  const res = await api('/api/group/roles', { method: 'POST', body: { name, description: descEl ? descEl.value.trim() : '' } });
  if (!res.ok) { await groupAdminFail(res); return; }
  nameEl.value = '';
  if (descEl) descEl.value = '';
  toast(__('group.op_done'), 'success');
  loadGroupRoles();
}

async function deleteGroupRole(id) {
  if (!id) return;
  showConfirm(__('group.role_del_confirm'), async function () {
    const res = await api('/api/group/roles/' + encodeURIComponent(id), { method: 'DELETE' });
    if (!res.ok) { await groupAdminFail(res); return; }
    toast(__('group.op_done'), 'success');
    loadGroupRoles();
  });
}

async function applyGroupMemberRole(action) {
  const userIdEl = document.getElementById('groupRoleUserId');
  const select = document.getElementById('groupRoleSelect');
  if (!userIdEl || !select) return;
  const userId = userIdEl.value.trim();
  const roleId = select.value;
  if (!userId || !roleId) { toast(__('group.role_user_required'), 'error'); return; }
  const res = await api('/api/group/members/' + encodeURIComponent(userId) + '/roles/' + encodeURIComponent(roleId), { method: 'PUT', body: { action } });
  if (!res.ok) { await groupAdminFail(res); return; }
  userIdEl.value = '';
  toast(__('group.op_done'), 'success');
}

// ---- 群审计日志（F-23） ----
async function loadGroupAuditLogs() {
  const list = document.getElementById('groupAuditLogsList');
  const countEl = document.getElementById('groupAuditLogsCount');
  if (!list) return;
  try {
    const res = await api('/api/group/audit-logs');
    if (!res.ok) { await groupAdminFail(res); return; }
    const data = await res.json();
    const items = data.auditLogs || [];
    if (countEl) countEl.textContent = '(' + items.length + ')';
    if (!items.length) { renderEmpty(list, { icon: '📋', text: __('group.no_audit_logs') }); return; }
    list.innerHTML = items.map(l => {
      const desc = l.description || l.action || '-';
      const actor = (l.actor && (l.actor.displayName || l.actor.name)) || l.actorDisplayName || '';
      const time = l.created_at || l.createdAt || '';
      const timeText = time && typeof formatLastSeen === 'function' ? formatLastSeen(time) : '';
      return `<div class="group-change-item">
        <span class="group-change-icon">📋</span>
        <span class="group-change-name" title="${esc(desc)}">${esc(actor ? actor + ' · ' + desc : desc)}</span>
        <span class="group-change-time">${esc(timeText)}</span>
      </div>`;
    }).join('');
  } catch {}
}

// ---- 群黑名单（F-23）：VRChat 群封禁列表，与本地 vrc_blacklist 联动（名字/头像/详情由 /group/bans 富化） ----
async function loadGroupBans() {
  const list = document.getElementById('groupBansList');
  const countEl = document.getElementById('groupBansCount');
  if (!list) return;
  try {
    const res = await api('/api/group/bans');
    if (!res.ok) { await groupAdminFail(res); return; }
    const data = await res.json();
    const items = data.bans || [];
    if (countEl) countEl.textContent = '(' + items.length + ')';
    if (!items.length) { renderEmpty(list, { icon: '🚫', text: __('group.no_bans') }); return; }
    list.innerHTML = items.map(b => {
      const uid = b.userId || b.bannedUserId || '';
      const name = b.displayName || b.username || uid || '-';
      const avatarHtml = b.avatarUrl
        ? `<img class="group-ban-avatar" src="${escAttr(b.avatarUrl)}" alt="" loading="lazy">`
        : '<span class="group-ban-avatar group-ban-avatar-fallback">🚫</span>';
      const trustDot = b.trustLevel
        ? `<span class="group-ban-trust" title="${esc(__('members.vrc_trust_label') + ': ' + b.trustLevel)}">●</span>`
        : '';
      const reasonHtml = b.reason
        ? `<div class="group-ban-reason">${__('admin_vrc.bl_reason_label')}${esc(b.reason)}</div>`
        : '';
      return `<div class="group-change-item" data-ban-id="${esc(uid)}">
        ${avatarHtml}
        <span class="group-change-name" title="${esc(uid)}">${esc(name)}${trustDot}</span>
        <span class="group-ban-vid mono">${esc(uid)}</span>
        ${reasonHtml}
        <button class="btn btn-sm btn-outline" data-action="ban-lift">${__('group.unban_btn')}</button>
      </div>`;
    }).join('');
    // 头像加载失败时兜底隐藏（避免破图；CSP 无 inline 事件，用 addEventListener）
    list.querySelectorAll('img.group-ban-avatar').forEach(function (img) {
      img.addEventListener('error', function () { this.style.display = 'none'; });
    });
    list.querySelectorAll('[data-action="ban-lift"]').forEach(btn => {
      btn.addEventListener('click', () => unbanGroupMember(btn.closest('[data-ban-id]').dataset.banId));
    });
  } catch {}
}

async function banGroupMemberAction() {
  const el = document.getElementById('groupBanUserId');
  if (!el) return;
  const userId = el.value.trim();
  if (!userId) { toast(__('group.ban_user_required'), 'error'); return; }
  showConfirm(__('group.ban_confirm'), async function () {
    const res = await api('/api/group/bans', { method: 'POST', body: { userId } });
    if (!res.ok) { await groupAdminFail(res); return; }
    el.value = '';
    toast(__('group.op_done'), 'success');
    loadGroupBans();
  });
}

// ---- 群邀请管理（BUG-3 修复） ----
async function loadGroupInvites() {
  const list = document.getElementById('groupInvitesList');
  const countEl = document.getElementById('groupInvitesCount');
  if (!list) return;
  try {
    const res = await api('/api/group/invites?pageSize=50');
    if (!res.ok) { await groupAdminFail(res); return; }
    const data = await res.json();
    const items = data.invites || [];
    if (countEl) countEl.textContent = '(' + (data.total || items.length) + ')';
    if (!items.length) { renderEmpty(list, { icon: '✉️', text: '暂无邀请记录' }); return; }
    list.innerHTML = items.map(inv => {
      const statusMap = { pending: '待处理', accepted: '已接受', rejected: '已拒绝', expired: '已过期' };
      const statusColor = inv.status === 'pending' ? 'var(--accent)' : inv.status === 'accepted' ? 'var(--success,#52c41a)' : 'var(--muted)';
      const expires = inv.expiresAt ? new Date(inv.expiresAt).toLocaleString() : '-';
      return `<div class="group-change-item" data-invite-id="${esc(inv.id)}">
        <span class="group-change-name">${esc(inv.vrchatName || inv.vrchatId)}</span>
        <span class="group-ban-vid mono">${esc(inv.vrchatId)}</span>
        <span style="color:${statusColor};font-size:12px">${esc(statusMap[inv.status] || inv.status)}</span>
        <span class="text-muted2 text-12">邀请人：${esc(inv.inviterName || '-')}</span>
        <span class="text-muted2 text-12">到期：${esc(expires)}</span>
      </div>`;
    }).join('');
  } catch {}
}

async function sendGroupInvites() {
  const idsEl = document.getElementById('groupInviteIds');
  const msgEl = document.getElementById('groupInviteMsg');
  if (!idsEl) return;
  const raw = idsEl.value.trim();
  if (!raw) { toast('请输入至少一个 VRChat ID', 'error'); return; }
  const vrchatIds = raw.split(/[\s,;]+/).map(s => s.trim()).filter(s => s.startsWith('usr_'));
  if (!vrchatIds.length) { toast('VRChat ID 格式应为 usr_xxx', 'error'); return; }
  if (vrchatIds.length > 100) { toast('单次最多邀请 100 人', 'error'); return; }
  const message = msgEl ? msgEl.value.trim() : '';
  showConfirm(`确定向 ${vrchatIds.length} 个用户发送群邀请吗？`, async function () {
    try {
      const res = await api('/api/group/invites/batch', { method: 'POST', body: { vrchatIds, message } });
      if (!res.ok) { await groupAdminFail(res); return; }
      const data = await res.json();
      const ok = (data.results || []).filter(r => r.status === 'invited').length;
      toast(`已发送 ${ok}/${vrchatIds.length} 个邀请`, 'success');
      idsEl.value = '';
      if (msgEl) msgEl.value = '';
      loadGroupInvites();
    } catch {}
  });
}

async function unbanGroupMember(userId) {
  if (!userId) return;
  showConfirm(__('group.unban_confirm'), async function () {
    const res = await api('/api/group/bans/' + encodeURIComponent(userId), { method: 'DELETE' });
    if (!res.ok) { await groupAdminFail(res); return; }
    toast(__('group.op_done'), 'success');
    loadGroupBans();
  });
}

// ---- 群日历关注（F-23） ----
async function groupCalendarAction(action) {
  const res = await api('/api/group/calendar/follow', { method: action === 'unfollow' ? 'DELETE' : 'POST' });
  if (!res.ok) { await groupAdminFail(res); return; }
  toast(action === 'unfollow' ? __('group.cal_unfollowed') : __('group.cal_followed'), 'success');
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
    const tab = document.getElementById('tab-vrc');
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
  // P2-2: 离开 vrc Tab / 停止轮询时，增量更新留下的防抖重渲染定时器仍可能在 1500ms 内触发
  // loadGroupMembers + loadGroupStats，导致隐藏 Tab 下发起无意义请求与 DOM 操作。一并清理。
  if (_rosterRefreshTimer) { clearTimeout(_rosterRefreshTimer); _rosterRefreshTimer = null; }
  // M9: 头像分批懒加载的定时链也随停止轮询一并清理，避免 Tab 切换后空转
  if (_avatarLazyTimer) { clearTimeout(_avatarLazyTimer); _avatarLazyTimer = null; }
}

// 空闲冻结：暂停/恢复 vrc Tab 的 30s 在线轮询（见 freeze.js）。
// 解冻时仅当用户正停留在 vrc Tab 才恢复，避免在其它 Tab 下空转。
// V9.5：全局持续贡献定时器（VRCX 式群友互助）随冻结一并暂停/恢复，
// 后台标签不空耗 VRChat 配额；恢复前台时立即补贡献一次。
if (window.__freeze && typeof window.__freeze.register === 'function') {
  window.__freeze.register({
    onFreeze: function () { stopGroupPolling(); stopGlobalPresenceContributor(); },
    onUnfreeze: function () {
      if (activeTab === 'vrc' && typeof loadGroupStats === 'function') startGroupPolling();
      startGlobalPresenceContributor();
      contributePresence(); // 恢复前台立即贡献一次，状态尽早回流
    }
  });
}

// ==================== 初始化 ====================
document.addEventListener('DOMContentLoaded', () => {
  setupGroupSearch();
  // V9.5：已登录并绑定 VRChat 的用户持续贡献好友状态（VRCX 式群友互助）。
  // 5 分钟节流在 contributePresence 内部，10 分钟全局定时器 + freeze 暂停/恢复。
  if (typeof currentUser !== 'undefined' && currentUser && currentUser.id) {
    startGlobalPresenceContributor();
  }
  // F-6/F-23 管理面板绑定（内部有 isAdminUser 守卫，非管理员不绑定）
  setupGroupAdminPanels();
  // 群组成员卡片：点击 / 键盘（Enter/Space）打开 VRChat 成员名片
  // （原内联 onclick/onkeydown 被 CSP 拦截，改为文档级委托）
  document.addEventListener('click', (e) => {
    const card = e.target && e.target.closest ? e.target.closest('[data-action="group-open-vrc-card"]') : null;
    if (!card) return;
    const vid = card.getAttribute('data-vrchat-id');
    if (vid && typeof openVrcMemberCard === 'function') openVrcMemberCard(vid);
  });
  // 群组成员分页按钮：仅翻页重排缓存数据，不重新请求
  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('[data-group-page]') : null;
    if (!btn) return;
    const targetPage = parseInt(btn.getAttribute('data-group-page'), 10);
    if (!targetPage || targetPage === groupPage) return;
    groupPage = targetPage;
    renderGroupMembers(groupMembersCache);
  });
  // 群组成员卡片「关注/取消关注」按钮：阻止冒泡避免同时打开 VRChat 名片
  document.addEventListener('click', async (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('[data-action="group-follow"]') : null;
    if (!btn) return;
    e.stopPropagation();
    const siteUserId = parseInt(btn.getAttribute('data-site-user-id'), 10);
    if (!siteUserId) return;
    const isFollowing = btn.getAttribute('data-following') === '1';
    btn.disabled = true;
    try {
      if (isFollowing) {
        const res = await api('/api/follows/' + siteUserId, { method: 'DELETE' });
        if (res.ok) {
          btn.setAttribute('data-following', '0');
          btn.classList.remove('following');
          btn.textContent = '+ 关注';
          btn.title = '关注';
        }
      } else {
        const res = await api('/api/follows', { method: 'POST', body: { targetUserId: siteUserId } });
        if (res.ok) {
          btn.setAttribute('data-following', '1');
          btn.classList.add('following');
          btn.textContent = '✓ 已关注';
          btn.title = '取消关注';
        }
      }
    } catch (err) {
      if (isApiHandledError(err)) return;
      toast('操作失败', 'error');
    } finally {
      btn.disabled = false;
    }
  });
  // 黑名单视图：新增 / 删除按钮（删除仅超管渲染，非超管点不到）
  const blvAddBtn = document.getElementById('blvAddBtn');
  if (blvAddBtn) blvAddBtn.addEventListener('click', addVrcBlacklistViewItem);
  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('[data-vrc-action="blacklist-view-remove"]') : null;
    if (!btn) return;
    const id = btn.getAttribute('data-id');
    if (id) removeVrcBlacklistViewItem(id);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target && e.target.closest ? e.target.closest('[data-action="group-open-vrc-card"]') : null;
    if (!card) return;
    e.preventDefault();
    const vid = card.getAttribute('data-vrchat-id');
    if (vid && typeof openVrcMemberCard === 'function') openVrcMemberCard(vid);
  });
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