// ==================== 成员列表 ====================
let membersLoading = false;
let membersSearchTimer = null;

async function loadMembers() {
  const container = document.getElementById('membersList');
  if (membersLoading) return;
  membersLoading = true;
  if (container) showSkeleton(container, 'grid', 8);
  try {
    // P3 分页修复：后端 /api/users/list 默认 100 条/页（paginate defaultSize:100），
    // 此前一次拉全量会静默截断——成员超 100 人时列表只显示前 100 人。
    // 改为逐页拉取累积，保持成员页/地图对全量数据的依赖（客户端角色/关键词过滤
    // 基于完整的 membersCache）。
    const MEMBERS_PAGE_SIZE = 100;
    const MEMBERS_MAX_PAGES = 100; // 防御性上限（1 万人足够），防异常 total 死循环
    let all = [];
    let total = 0;
    for (let page = 1; page <= MEMBERS_MAX_PAGES; page++) {
      const res = await api(`/api/users/list?page=${page}&pageSize=${MEMBERS_PAGE_SIZE}`, { method: 'GET' });
      if (!res.ok) break;
      const data = await res.json();
      const rows = data.users || [];
      all = all.concat(rows);
      if (typeof data.total === 'number') total = data.total;
      if (!rows.length || all.length >= total) break;
    }
    if (all.length) {
      membersCache = all;
      populateRoleFilter();
      filterMembers();
      if (typeof mapInstance !== 'undefined' && mapInstance) updateMapMarkers();
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('members.load_failed_msg'), 'error');
  } finally {
    membersLoading = false;
  }
}

function populateRoleFilter() {
  const select = document.getElementById('memberRoleFilter');
  if (!select) return;
  // 保持当前选中值
  const currentVal = select.value;
  const roles = new Set();
  membersCache.forEach(m => roles.add(m.role));
  const roleLabels = { 'super_admin': __('members.role_super_admin'), 'admin': __('members.role_admin'), 'member': __('members.role_member') };
  select.innerHTML = '<option value="">' + __('members.role_all') + '</option>' +
    Array.from(roles).sort().map(r => `<option value="${r}">${roleLabels[r] || r}</option>`).join('');
  if (currentVal) select.value = currentVal;
}

function filterMembers(searchText) {
  clearTimeout(membersSearchTimer);
  membersSearchTimer = setTimeout(() => {
    doFilterMembers(searchText);
  }, 200);
}

// VN-8 滚动位置保持（VRCNext lvKeepScroll 借鉴）：重渲染前记录滚动锚点，渲染后恢复，
// 避免筛选/搜索时列表跳回顶部（与 posts.js 通用思路一致）。
function getMembersScrollEl() {
  const container = document.getElementById('membersList');
  if (!container) return window;
  let el = container;
  const root = document.getElementById('tab-members') || container;
  while (el && el !== root) {
    const s = window.getComputedStyle(el);
    if (/(auto|scroll|overlay)/.test(s.overflowY)) return el;
    el = el.parentElement;
  }
  return window;
}

function doFilterMembers(searchText) {
  if (typeof searchText === 'undefined' || searchText === null) {
    const input = document.querySelector('#tab-members .search-box');
    searchText = input ? input.value : '';
  }
  const roleFilter = document.getElementById('memberRoleFilter')?.value || '';
  const filtered = membersCache.filter(m => {
    const name = (m.displayName || m.loginId || '').toLowerCase();
    const search = searchText.toLowerCase();
    if (search && !name.includes(search)) return false;
    if (roleFilter && m.role !== roleFilter) return false;
    return true;
  });
  const scrollEl = getMembersScrollEl();
  const savedTop = scrollEl.scrollTop;
  renderMembers(filtered);
  if (scrollEl && scrollEl.scrollHeight >= savedTop) {
    requestAnimationFrame(() => { scrollEl.scrollTop = savedTop; });
  }
  const countEl = document.getElementById('memberCount');
  if (countEl) {
    const total = membersCache.length;
    if (searchText || roleFilter) {
      countEl.textContent = __('members.found_count', {found: filtered.length, total: total});
    } else {
      countEl.textContent = __('members.total_count', {n: total});
    }
  }
}

// ==================== 站内成员头像加载链 ====================
// 与群组列表/地图同一套思路（group.js / map.js）：后端 getAvatarUrl 已把 VRChat CDN URL
// 代理改写为 /api/avatar/proxy?u=<原始URL>；原始 URL 是绑定/同步时的快照，签名过期或
// assets.amlcdn.com（国内 TLS 阻断）时代理回源会失败 → 默认占位。这里统一补齐：
//   1) 反解代理 URL 识别 amlcdn / 死链，直接改道；2) 空值/近期失败走 /api/avatar/user
//     按 VRChat ID 实时解析（系统账号链路，302 回 /proxy 复用缓存）；
//   3) 加载失败时经 /user 重试一次再落到默认占位。
const MEMBER_AVATAR_PROXY_PREFIX = '/api/avatar/proxy?u=';
function rawProxiedAvatar(url) {
  if (url && typeof url === 'string' && url.indexOf(MEMBER_AVATAR_PROXY_PREFIX) === 0) {
    try { return decodeURIComponent(url.slice(MEMBER_AVATAR_PROXY_PREFIX.length)) || ''; } catch (e) { return ''; }
  }
  return url || '';
}
function memberVrcFallback(m) {
  const uid = m.vrchatId || m.vrchat_id || '';
  return uid ? `/api/avatar/user?u=${encodeURIComponent(uid)}` : '';
}
function memberAvatarSrc(m) {
  let url = m.profilePicOverrideThumbnail || m.avatarUrl || '';
  if (/^https?:\/\/[^/]*assets\.amlcdn\.com\//i.test(rawProxiedAvatar(url))) url = '';
  if (!url) return memberVrcFallback(m) || '/api/avatar/default';
  const proxied = proxyAvatar(url);
  if (window.__avatarFailCached(proxied)) {
    return memberVrcFallback(m) || '/api/avatar/default';
  }
  return proxied;
}
// 头像加载失败：有 VRChat ID 时先经 /api/avatar/user 重试一次（规避 DB 存储的过期签名/死链），
// 再不行才落 __avatarFail（默认占位 + 60s 失败冷却，防 429 重试风暴）。
function memberAvatarOnError(img) {
  if (!img) return;
  const fb = img.dataset.vrcFallback || '';
  const failKey = img.dataset.avatarFailKey || img.src;
  if (fb && img.dataset.retried !== '1') {
    img.dataset.retried = '1';
    img.onerror = null;
    img.src = fb;
    img.onerror = function () { window.__avatarFail && window.__avatarFail(this, failKey); };
    return;
  }
  window.__avatarFail && window.__avatarFail(img, failKey);
}

// F-头像重试：订阅 ui.js __avatarRetryReady（系统会话恢复后 /api/avatar/user 头像自动重试），
// 命中 data-avatar-fail-key 的成员头像重置 retried 标记并重新加载（走 memberAvatarOnError 链）。
(function () {
  let _bound = false;
  function bindMemberAvatarRetry() {
    if (_bound) return;
    _bound = true;
    document.addEventListener('__avatarRetryReady', function (e) {
      const src = e && e.detail && e.detail.src;
      if (!src) return;
      document.querySelectorAll('img[data-avatar-fail-key]').forEach(function (img) {
        if (img.dataset.avatarFailKey !== src) return;
        img.dataset.retried = '0';
        img.onerror = function () { memberAvatarOnError(img); };
        img.src = img.dataset.avatarFailKey || src;
      });
    });
  }
  window.__bindMemberAvatarRetry = bindMemberAvatarRetry;
})();

function renderMembers(members) {
  // F-头像重试：确保重试监听已绑定（一次性）
  if (typeof window.__bindMemberAvatarRetry === 'function') window.__bindMemberAvatarRetry();
  // 新增：头像预览切换函数
  window.cycleAvatar = function(img) {
    if (!img.dataset.avatars) return;
    const urls = img.dataset.avatars.split(';').filter(Boolean);
    if (urls.length < 2) return;
    let idx = img.dataset.avatarIdx ? parseInt(img.dataset.avatarIdx) : 0;
    idx = (idx + 1) % urls.length;
    img.dataset.avatarIdx = idx;
    img.src = urls[idx];
  };

  const container = document.getElementById('membersList');
  if (!container) return;
  if (!members || members.length === 0) {
    renderEmpty(container, { icon: '👥', text: __('members.no_members') });
    return;
  }
  const roleLabels = { 'super_admin': __('members.role_super_admin'), 'admin': __('members.role_admin'), 'member': __('members.role_member') };
  container.innerHTML = members.map(m => {
    const avSrc = memberAvatarSrc(m);
    const vrcFallback = memberVrcFallback(m);
    const overridePic = proxyAvatar(m.profilePicOverrideThumbnail || '');
    const cycleSet = [avSrc, overridePic].filter(Boolean).join(';') || '/api/avatar/default';
    // 自定义标签：后端已按隐私开关过滤，这里只做安全转义 + 数量兜底
    const tags = Array.isArray(m.selfTags) ? m.selfTags.slice(0, 8) : [];
    const tagsHtml = tags.length
      ? `<div class="member-tags">${tags.map(t => `<span class="tag tag-accent">${esc(t)}</span>`).join('')}</div>`
      : '';
    return `
    <div class="member-card">
      <div class="member-card-click" data-member-id="${escAttr(String(m.id))}">
        <img src="${escAttr(avSrc)}" class="member-avatar" alt="${escAttr(m.displayName || m.loginId)}" loading="lazy"
          data-vrc-fallback="${escAttr(vrcFallback)}"
          data-avatar-fail-key="${escAttr(avSrc)}" data-avatars="${escAttr(cycleSet)}" >
        <div class="member-info">
          <div class="member-name">${esc(m.displayName || m.loginId)}${(m.trustLevel || m.trustLevelCn) ? ` <span class="member-trust-badge" style="background:${trustColorOf(m.trustLevel) || '#9e9e9e'}">${esc(m.trustLevelCn || m.trustLevel)}</span>` : ''}</div>
          <div class="member-role">${roleLabels[m.role] || __("members.role_guest")}</div>
          <div class="member-like">❤️ ${m.likeCount || 0}</div>
          ${tagsHtml}
        </div>
      </div>
      ${m.locationVisible ? `<div class="member-location">📍 ${esc(m.location || __('members.unknown_location'))}</div>` : ''}
      <button class="btn btn-sm btn-outline ml-auto" data-show-detail="${escAttr(String(m.id))}">${__('members.card')}</button>
    </div>
  `;
  }).join('');
  container.querySelectorAll?.('.member-avatar').forEach(img => { img.onerror = function () { memberAvatarOnError(this); }; });
}

// 成员卡片点击（原内联 onclick 迁移到 document 级委托；CSP nonce 策略会拦截内联事件处理器）
document.addEventListener('click', function (e) {
  if (!e.target || !e.target.closest || !e.target.closest('#membersList')) return;
  const t = e.target;
  const avatar = t.closest('.member-avatar');
  if (avatar) {
    if (window.cycleAvatar) cycleAvatar(avatar);
    return;
  }
  const btn = t.closest('button[data-show-detail]');
  if (btn && btn.dataset.showDetail) { showMemberDetail(btn.dataset.showDetail); return; }
  const clickArea = t.closest('.member-card-click');
  if (clickArea && clickArea.dataset.memberId && typeof goToProfile === 'function') goToProfile(clickArea.dataset.memberId);
});

// ==================== 站内用户名片本地缓存（localStorage） ====================
// 与 VRChat 名片同思路：点开先秒开本地缓存，再后台刷新，达到「瞬间弹出」的体感。
const MEMBER_CARD_CACHE_KEY = 'memberCardCache';
const MEMBER_CARD_CACHE_TTL = 5 * 60 * 1000; // 5 分钟过期（站内资料变化比 VRChat 实时资料更慢，TTL 可略短）
const MEMBER_CARD_CACHE_MAX = 80;
function memberCardCacheRead() {
  try {
    const raw = localStorage.getItem(MEMBER_CARD_CACHE_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return (obj && typeof obj === 'object') ? obj : {};
  } catch (e) { return {}; }
}
function memberCardCacheGet(uid) {
  const cache = memberCardCacheRead();
  const hit = cache[uid];
  if (!hit || !hit.d) return null;
  if (Date.now() - (hit.t || 0) > MEMBER_CARD_CACHE_TTL) return null;
  return hit.d;
}
function memberCardCacheSet(uid, detail) {
  if (!uid || !detail) return;
  try {
    const cache = memberCardCacheRead();
    cache[uid] = { t: Date.now(), d: detail };
    const keys = Object.keys(cache);
    if (keys.length > MEMBER_CARD_CACHE_MAX) {
      keys.sort((a, b) => (cache[a].t || 0) - (cache[b].t || 0));
      for (let i = 0; i < keys.length - MEMBER_CARD_CACHE_MAX; i++) delete cache[keys[i]];
    }
    localStorage.setItem(MEMBER_CARD_CACHE_KEY, JSON.stringify(cache));
  } catch (e) { /* 静默降级 */ }
}

// 把一份名片数据填入 DOM（缓存命中与接口刷新共用，避免重复逻辑）
function paintMemberCard(u) {
  const modal = document.getElementById('memberModal');
  const img = document.getElementById('ucAvatar');
  const nameEl = document.getElementById('ucName');
  const roleEl = document.getElementById('ucRole');
  const locationEl = document.getElementById('ucLocation');
  const mottoEl = document.getElementById('ucMotto');
  const birthdayEl = document.getElementById('ucBirthday');
  const vrcNameEl = document.getElementById('ucVrcName');
  const joinedEl = document.getElementById('ucJoined');
  const bioEl = document.getElementById('ucBio');
  const tagsEl = document.getElementById('ucTags');
  if (img) {
    img.dataset.vrcFallback = memberVrcFallback(u);
    img.dataset.avatarFailKey = memberAvatarSrc(u);
    img.dataset.retried = '0';
    img.onerror = function () { memberAvatarOnError(img); };
    img.src = memberAvatarSrc(u);
  }
  if (nameEl) nameEl.textContent = u.displayName || u.loginId || __('unknown_user');
  const roleMap = { 'super_admin': __('members.role_super_admin'), 'admin': __('members.role_admin'), 'member': __('members.role_member') };
  if (roleEl) roleEl.textContent = roleMap[u.role] || u.role || '—';
  if (mottoEl) mottoEl.textContent = u.motto || u.bio || '';
  if (locationEl) {
    if (u.locationVisible && u.location) {
      locationEl.className = 'd-flex gap-4 items-center';
      locationEl.innerHTML = `<span class="text-muted2">${__('members.location')}：</span><span>${esc(u.location)}</span>`;
    } else {
      locationEl.className = 'd-none';
    }
  }
  if (birthdayEl) {
    if (u.birthday) {
      birthdayEl.className = 'd-flex gap-4 items-center';
      birthdayEl.innerHTML = `<span class="text-muted2">${__('profile.birthday')}：</span><span>${esc(u.birthday)}</span>`;
    } else {
      birthdayEl.className = 'd-none';
    }
  }
  if (vrcNameEl) {
    if (u.vrchatName) {
      vrcNameEl.className = 'd-flex gap-4 items-center';
      vrcNameEl.innerHTML = `<span class="text-muted2">${__('members.vrc')}</span><span>${esc(u.vrchatName)}</span>`;
    } else {
      vrcNameEl.className = 'd-none';
    }
  }
  if (joinedEl) {
    if (u.joinedAt) {
      joinedEl.className = 'd-flex gap-4 items-center';
      joinedEl.innerHTML = `<span class="text-muted2">${__('members.joined')}</span><span>${fmtDate(u.joinedAt)}</span>`;
    } else {
      joinedEl.className = 'd-none';
    }
  }
  if (bioEl) {
    if (u.bio) {
      bioEl.className = 'member-bio-text';
      bioEl.textContent = u.bio;
    } else {
      bioEl.className = 'd-none';
    }
  }
  if (tagsEl) {
    const tags = Array.isArray(u.selfTags) ? u.selfTags.slice(0, 8) : [];
    if (tags.length) {
      tagsEl.className = 'member-tags mt-4';
      tagsEl.innerHTML = tags.map(t => `<span class="tag tag-accent">${esc(t)}</span>`).join('');
    } else {
      tagsEl.className = 'd-none';
      tagsEl.innerHTML = '';
    }
  }
  const linksEl = document.getElementById('memberCardLinks');
  if (linksEl) {
    let html = '';
    if (u.evtCount > 0) {
      html += `<a href="#" data-action="member-events" data-member-id="${u.id}" class="btn btn-sm btn-outline">📅 ${__('members.n_events', {n: u.evtCount})}</a>`;
    }
    if (u.photoCount > 0) {
      html += `<a href="#" data-action="member-photos" data-member-id="${u.id}" class="btn btn-sm btn-outline">📷 ${__('members.n_photos', {n: u.photoCount})}</a>`;
    }
    if (currentUser && currentUser.id === u.id) {
      html += `<a href="#" data-action="member-edit-profile" class="btn btn-sm btn-outline">${__('members.edit_profile')}</a>`;
    }
    if (currentUser && currentUser.id !== u.id) {
      // 关注/互关按钮容器：数据异步拉取后填入（renderMemberCardSkeleton 会清空）
      // data-uid 用于防串台：切到他人民片后，迟到响应不覆盖新名片按钮
      html += `<span id="memberFollowBtn" data-uid="${escAttr(String(u.id))}"></span>`;
    }
    if (currentUser) {
      html += `<button data-action="member-notes" data-member-id="${u.id}" data-member-name="${escAttr(u.displayName || u.loginId)}" class="btn btn-sm btn-outline">📝 ${__('members.notes')}</button>`;
      if (currentUser.id !== u.id) {
        html += `<button data-action="member-report" data-member-id="${u.id}" data-member-name="${escAttr(u.displayName || u.loginId)}" class="btn btn-sm btn-outline">🚩 ${__('members.report_btn')}</button>`;
      }
    }
    html += `<a href="#" data-action="member-profile" data-member-id="${u.id}" class="btn btn-sm btn-outline">${__('members.full_profile')}</a>`;
    linksEl.innerHTML = html || '';
    if (currentUser && currentUser.id !== u.id) refreshMemberFollowBtn(u.id);
  }
  if (modal) showModal('memberModal');
}

// ==================== 名片关注/互关（成员卡片关注功能） ====================
// 状态：未关注→关注；对方已关注我且我未关注→回关；已关注未互关→已关注（可取消）；
// 互关（已是好友）→互关（可取消，取消会同时解除好友关系并弹确认）。
async function refreshMemberFollowBtn(userId) {
  const el = document.getElementById('memberFollowBtn');
  if (!el || !currentUser || String(currentUser.id) === String(userId)) return;
  // 防串台：等待响应期间若已切到他人民片（容器被重建为他人 uid），丢弃迟到响应
  if (String(el.dataset.uid) !== String(userId)) return;
  try {
    const res = await api(`/api/follows/status/${userId}`, { method: 'GET' });
    if (!res.ok) return;
    const d = await res.json();
    if (String((document.getElementById('memberFollowBtn') || {}).dataset?.uid) !== String(userId)) return;
    const following = !!d.following, followedBy = !!d.followedBy;
    let label, action, cls;
    if (following && followedBy) { label = __('follows.mutual'); action = 'member-unfollow'; cls = 'btn-outline'; }
    else if (following) { label = __('follows.followed'); action = 'member-unfollow'; cls = 'btn-outline'; }
    else if (followedBy) { label = __('follows.follow_back'); action = 'member-follow'; cls = 'btn-accent'; }
    else { label = __('follows.follow'); action = 'member-follow'; cls = 'btn-accent'; }
    const mutual = following && followedBy ? '1' : '0';
    el.innerHTML = `<button class="btn btn-sm ${cls}" data-action="${action}" data-member-id="${userId}" data-mutual="${mutual}">${esc(label)}</button>`;
  } catch (e) { /* 静默：关注按钮拉取失败不影响名片展示 */ }
}

async function memberFollow(userId, follow, mutual) {
  if (!currentUser) { toast(__('please_login'), 'error'); return; }
  if (!follow && mutual) {
    const ok = await new Promise((resolve) => showConfirm(
      __('follows.confirm_unfollow_friend'),
      () => resolve(true), () => resolve(false)
    ));
    if (!ok) return;
  }
  try {
    const opts = { method: follow ? 'POST' : 'DELETE' };
    if (follow) {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify({ targetUserId: parseInt(userId, 10) });
    }
    const res = await api(follow ? '/api/follows' : '/api/follows/' + userId, opts);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      toast(errText(d) || __('follows.operation_failed'), 'error');
      return;
    }
    toast(follow ? __('follows.followed') : __('follows.unfollowed'), 'success');
    refreshMemberFollowBtn(userId);
  } catch (e) {
    if (isApiHandledError(e)) return;
    toast(e.message, 'error');
  }
}

function renderMemberCardSkeleton(userId, failed) {
  const modal = document.getElementById('memberModal');
  const img = document.getElementById('ucAvatar');
  if (img) {
    img.onerror = null;
    img.dataset.vrcFallback = '';
    img.dataset.retried = '0';
    img.src = '/api/avatar/default';
  }
  const nameEl = document.getElementById('ucName');
  if (nameEl) nameEl.textContent = failed ? __('members.detail_load_failed') : __('common.loading');
  ['ucRole', 'ucMotto', 'ucLocation', 'ucBirthday', 'ucVrcName', 'ucJoined', 'ucTags'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = '';
    el.className = 'd-none';
  });
  const bioEl = document.getElementById('ucBio');
  if (bioEl) { bioEl.textContent = ''; bioEl.className = 'd-none'; }
  const linksEl = document.getElementById('memberCardLinks');
  if (linksEl) linksEl.innerHTML = '';
  if (modal) { if (typeof showModal === 'function') showModal('memberModal'); else modal.classList.add('show'); }
}

async function showMemberCard(userId) {
  if (!userId) userId = currentUser?.id;
  if (!userId) return;
  // 归属标记：防止快速连续点不同人时，迟到响应覆盖当前弹窗（与 VRChat 名片同防串台机制）
  const token = memberCardOpener.begin(userId);
  try {
    // 1) 先秒开本地缓存（如有），立即弹出，零网络等待
    const cached = memberCardCacheGet(userId);
    if (cached) paintMemberCard(cached);
    else renderMemberCardSkeleton(userId, false); // 无缓存先出骨架，杜绝「点进去啥都没有」

    // 2) 无论有无缓存，都后台刷新最新数据（不阻塞弹出）
    const res = await api(`/api/users/${userId}/card`, { method: 'GET' });
    if (memberCardOpener.stale(token)) return; // 已切换到他人/关闭，丢弃过期响应
    if (res.ok) {
      const u = await res.json();
      if (memberCardOpener.stale(token)) return;
      memberCardCacheSet(userId, u);
      // 仅在「无缓存首屏」或「数据有变化」时重绘；缓存命中时刷新但不闪烁（对比 avatar 即可）
      paintMemberCard(u);
    } else if (!cached) {
      // 无缓存且请求失败：骨架标记失败，避免白屏
      toast(__('members.detail_load_failed'), 'error');
      renderMemberCardSkeleton(userId, true);
    }
  } catch {
    if (!memberCardCacheGet(userId)) {
      toast(__('members.detail_load_failed'), 'error');
      renderMemberCardSkeleton(userId, true);
    }
  }
}

// 查看该用户的活动记录
window.showUserEvents = function(userId) {
  closeModal('memberModal');
  // 切换到活动 tab，并过滤显示该用户报名的活动
  // 通过调用后端 API 获取该用户活动
  switchTab('events');
  toast(__('members.loading_events'), 'info');
  // 在 events.js 中需要一个全局函数来显示特定用户的活动
  if (typeof loadUserEvents === 'function') {
    loadUserEvents(userId);
  }
};

// 查看该用户的照片
window.showUserPhotos = function(userId) {
  closeModal('memberModal');
  switchTab('album');
  toast(__('members.loading_photos'), 'info');
  if (typeof loadUserPhotos === 'function') {
    loadUserPhotos(userId);
  }
};

function showMemberDetail(id) { showMemberCard(id); }

// ==================== 用户备注管理 ====================
let currentNoteUserId = null;
let currentNoteColor = '';
const NOTE_COLOR_PALETTE = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'gray'];
const NOTE_COLOR_MAP = {
  red: '#ef4444', orange: '#f97316', yellow: '#eab308', green: '#22c55e',
  blue: '#3b82f6', purple: '#a855f7', pink: '#ec4899', gray: '#6b7280'
};
function selectNoteColor(color, el) {
  currentNoteColor = (currentNoteColor === color) ? '' : color;
  document.querySelectorAll('#memberNotesModal .note-color-dot').forEach(d => d.classList.remove('selected'));
  if (currentNoteColor && el) el.classList.add('selected');
}

async function openMemberNotes(userId, userName) {
  currentNoteUserId = userId;
  const modal = document.getElementById('memberNotesModal');
  if (!modal) {
    const modalHtml = `
      <div id="memberNotesModal" class="modal">
        <div class="modal-content modal-sm">
          <div class="modal-header">
            <h3>📝 ${__('members.notes_title')}</h3>
            <button class="modal-close" data-action="close-notes" aria-label="${__('common.close')}">✕</button>
          </div>
          <div class="form-group">
            <label>${__('members.notes_for')} ${esc(userName)}</label>
            <textarea id="memberNoteText" class="form-input" rows="4" maxlength="200" placeholder="${__('members.notes_placeholder')}"></textarea>
            <div class="text-right text-xs text-muted mt-2"><span id="memberNoteCount">0</span>/200</div>
          </div>
          <div class="form-group">
            <label>${__('members.notes_color')}</label>
            <div class="note-colors">
              ${NOTE_COLOR_PALETTE.map(c => `<span class="note-color-dot" data-action="note-color" data-color="${c}" style="background:${NOTE_COLOR_MAP[c]}" title="${c}"></span>`).join('')}
            </div>
          </div>
          <div class="form-group">
            <label>${__('members.notes_tags')}</label>
            <input id="memberNoteTags" class="form-input" type="text" maxlength="255" placeholder="${__('members.notes_tags_placeholder')}">
          </div>
          <div id="memberNotesError" class="text-13 text-red d-none mb-4"></div>
          <div class="form-actions">
            <button data-action="note-delete" class="btn btn-sm btn-danger">${__('common.delete')}</button>
            <button type="button" data-action="close-notes" class="btn btn-sm btn-outline">${__('common.cancel')}</button>
            <button data-action="note-save" class="btn btn-sm btn-accent">${__('common.save')}</button>
          </div>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHtml);
  }
  
  const textarea = document.getElementById('memberNoteText');
  const countEl = document.getElementById('memberNoteCount');
  if (textarea) {
    textarea.value = '';
    textarea.oninput = () => {
      if (countEl) countEl.textContent = textarea.value.length;
    };
  }
  
  try {
    const res = await api(`/api/users/${userId}/notes`, { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      if (data.note) {
        textarea.value = data.note.noteText || '';
        if (countEl) countEl.textContent = textarea.value.length;
        currentNoteColor = data.note.noteColor || '';
        const tagsEl = document.getElementById('memberNoteTags');
        if (tagsEl) tagsEl.value = (data.note.noteTags || []).join(', ');
        document.querySelectorAll('#memberNotesModal .note-color-dot').forEach(d => {
          d.classList.toggle('selected', d.dataset.color === currentNoteColor);
        });
      }
    }
  } catch {}
  
  showModal('memberNotesModal');
}

async function saveMemberNote() {
  if (!currentNoteUserId) return;
  const textarea = document.getElementById('memberNoteText');
  const tagsEl = document.getElementById('memberNoteTags');
  const errorEl = document.getElementById('memberNotesError');
  const noteText = textarea.value.trim();
  
  if (!noteText) {
    if (errorEl) errorEl.textContent = __('members.notes_empty');
    if (errorEl) errorEl.classList.remove('d-none');
    return;
  }
  const noteTags = tagsEl ? tagsEl.value.split(',').map(s => s.trim()).filter(Boolean) : [];
  
  try {
    const res = await api(`/api/users/${currentNoteUserId}/notes`, {
      method: 'POST',
      body: JSON.stringify({ noteText, noteColor: currentNoteColor, noteTags })
    });
    if (res.ok) {
      toast(__('members.notes_saved'), 'success');
      closeModal('memberNotesModal');
    } else {
      const err = await res.json();
      if (errorEl) errorEl.textContent = errText(err) || __('members.notes_save_failed');
      if (errorEl) errorEl.classList.remove('d-none');
    }
  } catch (e) {
    if (errorEl) errorEl.textContent = __('members.notes_save_failed');
    if (errorEl) errorEl.classList.remove('d-none');
  }
}

async function deleteMemberNote() {
  if (!currentNoteUserId) return;
  showConfirm(__('members.notes_confirm_delete'), async function () {
    try {
      const res = await api(`/api/users/${currentNoteUserId}/notes`, { method: 'DELETE' });
      if (res.ok) {
        toast(__('members.notes_deleted'), 'success');
        const textarea = document.getElementById('memberNoteText');
        if (textarea) textarea.value = '';
        const countEl = document.getElementById('memberNoteCount');
        if (countEl) countEl.textContent = '0';
      } else {
        toast(__('members.notes_delete_failed'), 'error');
      }
    } catch (e) {
      toast(__('members.notes_delete_failed'), 'error');
    }
  });
}

// ==================== F-18 举报玩家/头像 ====================
let currentReportUserId = null;
async function reportUser(userId, userName) {
  currentReportUserId = userId;
  const modal = document.getElementById('reportUserModal');
  if (!modal) {
    const html = `
      <div id="reportUserModal" class="modal">
        <div class="modal-content modal-sm">
          <div class="modal-header">
            <h3>🚩 ${__('members.report_title')}</h3>
            <button class="modal-close" data-action="close-report" aria-label="${__('common.close')}">✕</button>
          </div>
          <div class="form-group">
            <label>${__('members.report_for')} ${esc(userName)}</label>
            <div class="form-group">
              <label>${__('members.report_type')}</label>
              <select id="reportType" class="form-input">
                <option value="player">${__('members.report_type_player')}</option>
                <option value="avatar">${__('members.report_type_avatar')}</option>
              </select>
            </div>
            <textarea id="reportReason" class="form-input" rows="4" maxlength="500" placeholder="${__('members.report_reason_placeholder')}"></textarea>
            <div class="text-right text-xs text-muted mt-2"><span id="reportCount">0</span>/500</div>
          </div>
          <div id="reportError" class="text-13 text-red d-none mb-4"></div>
          <div class="form-actions">
            <button data-action="close-report" class="btn btn-sm btn-outline">${__('common.cancel')}</button>
            <button data-action="report-submit" class="btn btn-sm btn-danger">${__('members.report_submit')}</button>
          </div>
        </div>
      </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
    const ta = document.getElementById('reportReason');
    const cnt = document.getElementById('reportCount');
    if (ta) ta.oninput = () => { if (cnt) cnt.textContent = ta.value.length; };
  }
  showModal('reportUserModal');
}

async function submitUserReport() {
  if (!currentReportUserId) return;
  const typeEl = document.getElementById('reportType');
  const reasonEl = document.getElementById('reportReason');
  const errorEl = document.getElementById('reportError');
  const type = typeEl ? typeEl.value : 'player';
  const reason = reasonEl ? reasonEl.value.trim() : '';
  if (!reason) {
    if (errorEl) { errorEl.textContent = __('members.report_reason_empty'); errorEl.classList.remove('d-none'); }
    return;
  }
  try {
    const res = await api('/api/moderations', {
      method: 'POST',
      body: JSON.stringify({ targetType: type, targetUserId: currentReportUserId, reason })
    });
    if (res.ok) {
      toast(__('members.report_submitted'), 'success');
      closeModal('reportUserModal');
    } else {
      const err = await res.json();
      if (errorEl) { errorEl.textContent = errText(err) || __('members.report_failed'); errorEl.classList.remove('d-none'); }
    }
  } catch (e) {
    if (errorEl) { errorEl.textContent = __('members.report_failed'); errorEl.classList.remove('d-none'); }
  }
}

// 管理员：加载审核队列（容器存在时渲染，缺失则安全跳过）
// 后端默认 20 条/页（最多 50），此前前端不带 page 参数，超 20 条的旧举报永远看不到；
// 这里维护 status+page 状态并渲染分页条。
let modQueueStatus = 'pending';
let modQueuePage = 1;

async function loadModerationQueue(status, page) {
  const box = document.getElementById('moderationQueue');
  if (!box) return;
  if (status) {
    if (status !== modQueueStatus) { modQueueStatus = status; modQueuePage = 1; }
  }
  if (page) modQueuePage = page;
  try {
    const params = new URLSearchParams();
    params.set('status', modQueueStatus);
    params.set('page', modQueuePage);
    params.set('pageSize', '50');
    const res = await api('/api/moderations?' + params.toString());
    if (!res.ok) return;
    const data = await res.json();
    if (!data.items || !data.items.length) {
      box.innerHTML = '<p class="text-muted2">' + __('members.report_queue_empty') + '</p>';
      renderModerationPagination(null);
      return;
    }
    box.innerHTML = data.items.map(it => {
      const actionsHtml = it.status === 'pending'
        ? `<button class="btn btn-sm btn-accent" data-action="mod-approve" data-mod-id="${it.id}">${__('common.approve')}</button>
           <button class="btn btn-sm btn-outline" data-action="mod-reject" data-mod-id="${it.id}">${__('common.reject')}</button>`
        : (it.status === 'approved'
          ? `<button class="btn btn-sm btn-outline" data-action="mod-revert" data-mod-id="${it.id}">${__('members.report_revert')}</button>`
          : '');
      return `
      <div class="moderation-item" data-id="${it.id}">
        <div class="moderation-meta"><b>${esc(it.targetName)}</b> · ${esc(it.targetType)} · ${esc(it.reporterName || '')}</div>
        <div class="moderation-reason">${esc(it.reason)}</div>
        ${renderModerationRemote(it)}
        <div class="moderation-actions">${actionsHtml}</div>
      </div>`;
    }).join('');
    renderModerationPagination(data);
  } catch {}
}

function renderModerationPagination(data) {
  const el = document.getElementById('moderationPagination');
  if (!el) return;
  const total = (data && data.total) || 0;
  const pageSize = (data && data.pageSize) || 50;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (!data || totalPages <= 1) { el.innerHTML = ''; return; }
  let html = '';
  if (modQueuePage > 1) {
    html += `<button class="btn btn-xs btn-outline" data-action="mod-page" data-value="1" title="${__('admin_users.title_first_page')}">&laquo;</button>`;
    html += `<button class="btn btn-xs btn-outline" data-action="mod-page" data-value="${modQueuePage - 1}">&lsaquo;</button>`;
  }
  const start = Math.max(1, modQueuePage - 2);
  const end = Math.min(totalPages, modQueuePage + 2);
  for (let p = start; p <= end; p++) {
    html += `<button class="btn btn-xs ${p === modQueuePage ? 'btn-accent' : 'btn-outline'}" data-action="mod-page" data-value="${p}">${p}</button>`;
  }
  if (modQueuePage < totalPages) {
    html += `<button class="btn btn-xs btn-outline" data-action="mod-page" data-value="${modQueuePage + 1}">&rsaquo;</button>`;
    html += `<button class="btn btn-xs btn-outline" data-action="mod-page" data-value="${totalPages}" title="${__('admin_users.title_last_page')}">&raquo;</button>`;
  }
  el.innerHTML = html;
}

async function resolveModeration(id, action) {
  try {
    const res = await api('/api/moderations/' + id + '/resolve', {
      method: 'POST',
      body: JSON.stringify({ action })
    });
    if (res.ok) { toast(__('members.report_resolved'), 'success'); loadModerationQueue(); }
    else toast(__('members.report_resolve_failed'), 'error');
  } catch { toast(__('members.report_resolve_failed'), 'error'); }
}

// 渲染审核项的远程动作状态（block/mute 结果或撤销标记；remoteResult 为空则无显示）
function renderModerationRemote(it) {
  if (!it.remoteResult) return '';
  let p = null;
  try { p = JSON.parse(it.remoteResult); } catch (e) { return ''; }
  if (!p || typeof p !== 'object') return '';
  let text = '';
  if (p.revoked) {
    text = __('members.report_remote_revoked');
  } else if (p.applied) {
    const parts = [];
    if (p.block !== undefined && p.block !== null) parts.push('block ' + p.block);
    if (p.mute !== undefined && p.mute !== null) parts.push('mute ' + p.mute);
    text = __('members.report_remote_applied', { detail: parts.join(' · ') || '-' });
  } else {
    const reasonMap = {
      'avatar-local': __('members.report_remote_reason_avatar'),
      'no-vrchat-id': __('members.report_remote_reason_no_vrc'),
      'no-admin-cookie': __('members.report_remote_reason_no_admin')
    };
    text = __('members.report_remote_skipped') + '（' + (reasonMap[p.reason] || p.reason || '') + '）';
  }
  return '<div class="moderation-remote text-13">' + esc(text) + '</div>';
}

// 撤销已通过项的远程屏蔽/静音（unblock/unmute）
async function revertModeration(id) {
  try {
    const res = await api('/api/moderations/' + id + '/revert', { method: 'POST' });
    if (res.ok) { toast(__('members.report_reverted'), 'success'); reloadModerationQueue(); }
    else toast(__('members.report_revert_failed'), 'error');
  } catch { toast(__('members.report_revert_failed'), 'error'); }
}

// 按当前激活的审核状态标签刷新队列（撤销后保留在已通过视图）
function reloadModerationQueue() {
  const active = document.querySelector('#adminModerationSection [data-mqt].btn-accent');
  loadModerationQueue(active ? active.getAttribute('data-mqt') : 'pending');
}


// ==================== 获取成员备注 ====================
function getMemberNotes(userId) {
  return api(`/api/users/${userId}/notes`, { method: 'GET' });
}

// ==================== 关闭成员备注模态框 ====================
function closeMemberNotesModal() {
  closeModal('memberNotesModal');
}

// ==================== 群组成员 VRChat 风格名片详情 ====================
// 点击群组/世界分布中的成员头像，弹出其在 VRChat 上的真实资料：
// 头像、昵称、简介、信任等级、徽章、在线状态、当前所在世界、bio 链接等。
// VRChat 信任等级色阶（按用户确认：就这 5 个主等级，对齐 VRCX 显示）
// 恶劣玩家(灰) → 游客(白) → 新用户(蓝) → 用户(绿) → 常驻玩家(橙) → 资深玩家(紫)
// 注：VRChat API 偶发返回 trusted/legend 等更高阶值，下方保留为兜底色（映射到相近色），
//     但 UI 主文案只展示以上 5 级，不会凭空造__('auto_members_1')等。
const VRC_TRUST_COLOR = {
  'negative': '#9e9e9e',  // 恶劣玩家（灰）：会被其他玩家自动屏蔽
  'visitor': '#ffffff',   // 游客（白）：新加入，权限有限，安全等级高玩家眼中可能不显示动作/模型
  'new': '#2196f3',       // 新用户（蓝）：可上传模型和世界，但上传的世界默认私人
  'user': '#4caf50',      // 用户（绿）：大多数功能开放，好友可完全访问其模型功能
  'known': '#ff9800',     // 常驻玩家（橙）
  'trusted': '#1565c0',   // 信任（深蓝，API 罕见值兜底）
  'vetted': '#fb8c00',    // 审核（深橙，API 罕见值兜底）
  'veteran': '#9c27b0',   // 资深玩家（紫）
  'legend': '#7b1fa2'     // 传奇（紫红，API 罕见值兜底，UI 不主推）
};
// 暴露到全局，使群组卡片等其它模块可复用同一套 VRChat 信任色阶（VRCX 风格统一）
window.VRC_TRUST_COLOR = VRC_TRUST_COLOR;
// 信任等级 -> 中文名（按用户确认：就这 5 个主等级）
// 层级：恶劣玩家 < 游客 < 新用户 < 用户 < 常驻玩家 < 资深玩家（trusted/legend 等罕见值兜底，不主推）
const TRUST_CN = {
  'negative': __('auto_members_2'), 'visitor': __('auto_members_3'), 'new': __('auto_members_4'), 'user': __('auto_members_5'),
  'known': __('auto_members_6'), 'trusted': __('auto_members_7'), 'vetted': __('auto_members_8'), 'veteran': __('auto_members_9'), 'legend': __('auto_members_10')
};
window.TRUST_CN = TRUST_CN;
// 小写归一化查找，兼容 VRChat API 偶发大小写差异（API 返回值为全小写）
function trustColorOf(level) {
  if (!level) return '';
  return VRC_TRUST_COLOR[(level || '').toLowerCase()] || '';
}
window.trustColorOf = trustColorOf;
const VRC_STATUS_LABEL = {
  'active': __('auto_members_11'), 'join me': __('auto_members_12'), 'ask me': __('auto_members_13'), 'busy': __('auto_members_14'), 'offline': __('auto_members_15')
};

function copyVrcName(el) {
  const text = el.textContent.trim();
  if (!text || text === __('auto_members_16')) return;
  copyTextToClipboard(text)
    .then(() => toast(__('members.name_copied'), 'success'))
    .catch(() => toast(__('members.copy_failed'), 'error'));
}
window.copyVrcName = copyVrcName;

// ==================== 群组玩家详情本地缓存（localStorage） ====================
// 点开名片时先秒开本地缓存，再后台刷新，避免每次都要等接口（尤其网络慢/接口抖动时）。
// 结构：{ <vrchatId>: { t: <写入时间戳ms>, d: <detail 对象> } }
const VRC_DETAIL_CACHE_KEY = 'vrcMemberDetailCache';
const VRC_DETAIL_CACHE_TTL = 10 * 60 * 1000; // 10 分钟过期
const VRC_DETAIL_CACHE_MAX = 60;              // 最多缓存 60 人（防止撑爆 localStorage 5MB 配额）

function vrcDetailCacheRead() {
  try {
    const raw = localStorage.getItem(VRC_DETAIL_CACHE_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return (obj && typeof obj === 'object') ? obj : {};
  } catch (e) { return {}; }
}

function vrcDetailCacheGet(vrchatId) {
  const cache = vrcDetailCacheRead();
  const hit = cache[vrchatId];
  if (!hit || !hit.d) return null;
  // 过期即视为未命中（但保留条目，待写入时淘汰）
  if (Date.now() - (hit.t || 0) > VRC_DETAIL_CACHE_TTL) return null;
  return hit.d;
}

function vrcDetailCacheSet(vrchatId, detail) {
  if (!vrchatId || !detail) return;
  try {
    const cache = vrcDetailCacheRead();
    cache[vrchatId] = { t: Date.now(), d: detail };
    // 超过上限：按写入时间淘汰最旧条目（LRU by timestamp）
    const keys = Object.keys(cache);
    if (keys.length > VRC_DETAIL_CACHE_MAX) {
      keys.sort((a, b) => (cache[a].t || 0) - (cache[b].t || 0));
      for (let i = 0; i < keys.length - VRC_DETAIL_CACHE_MAX; i++) delete cache[keys[i]];
    }
    localStorage.setItem(VRC_DETAIL_CACHE_KEY, JSON.stringify(cache));
  } catch (e) {
    // localStorage 满/被禁：静默降级，不影响主流程
  }
}

// 弹窗归属守卫（统一防串台机制，见 core.js createFastModal）
const vrcCardOpener = createFastModal('vrcMember');
const memberCardOpener = createFastModal('member');

async function openVrcMemberCard(vrchatId) {
  if (!vrchatId) return;
  const modal = document.getElementById('vrcMemberModal');
  const body = document.getElementById('vrcMemberBody');
  if (!modal || !body) return;

  // 标记弹窗归属，必须在 showModal 前设置以覆盖任何进行中的旧请求
  // 注意：必须先 begin 再使用 token（含缓存渲染），否则 TDZ 报错
  const token = vrcCardOpener.begin(vrchatId);

  // 缓存命中：先秒开缓存内容，同时后台拉最新数据刷新（无 spinner，体验最快）
  const cached = vrcDetailCacheGet(vrchatId);
  if (cached) {
    renderVrcMemberCard(cached, token);
  } else {
    body.innerHTML = `<div class="vrc-card-loading">
      <svg class="vrc-spinner" width="36" height="36" viewBox="0 0 36 36" aria-label=__('auto_members_17')>
        <circle cx="18" cy="18" r="14" fill="none" stroke="var(--border)" stroke-width="3"/>
        <circle cx="18" cy="18" r="14" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" stroke-dasharray="60 28">
          <animateTransform attributeName="transform" type="rotate" from="0 18 18" to="360 18 18" dur="0.8s" repeatCount="indefinite"/>
        </circle>
      </svg>
      <p>${__('members.loading_vrc_profile')}</p>
    </div>`;
  }
  showModal('vrcMemberModal');

  try {
    // 阶段1：仅 DB 数据，极速返回（~10ms）→ 即使有缓存也后台刷新，保证资料最新
    const res = await api('/api/group/members/' + encodeURIComponent(vrchatId) + '/detail', { method: 'GET', timeout: 30000 });
    if (vrcCardOpener.stale(token)) return; // 已切换到他人/关闭，丢弃过期响应（防串台）
    if (!res.ok) throw new Error('LOAD_FAILED');
    const data = await res.json();
    if (vrcCardOpener.stale(token)) return;
    const d = data.detail || {};
    // 详情接口可能缺 trust/online（尤其非好友），用本地 roster 回退补全，保证详情可见信誉/在线状态
    const rb = (window.__groupRosterById && window.__groupRosterById[vrchatId]) || null;
    if (rb) {
      if (d.isOnline == null) d.isOnline = rb.isOnline;
      if (d.trustLevel == null) d.trustLevel = rb.trustLevel;
      if (!d.status && rb.vrchatStatus != null) d.status = rb.vrchatStatus;
      if (d.isFriend == null) d.isFriend = rb.isFriend;
    }
    vrcDetailCacheSet(vrchatId, d);
    renderVrcMemberCard(d, token);

    // 阶段2：异步补拉 VRChat 实时资料（头像/状态/公开模型等），不阻塞首屏渲染
    if (data.vrcPending) {
      vrcLoadRealTime(vrchatId, d, token);
    }
  } catch (err) {
    if (vrcCardOpener.stale(token)) return; // 过期响应：不渲染、不弹错
    // 已有缓存时请求失败不弹错，保留缓存内容展示
    if (cached) return;
    if (isApiHandledError(err)) return;
    renderEmpty(body, { icon: '⚠️', text: __('auto_members_18') });
  }
}

// P2-55 阶段2：异步拉取 VRChat 实时资料并局部刷新名片（不阻塞首屏）
// P3-XX 提速：主响应只等核心资料（≤5s）；modelsPending 时延迟重查一次命中后台回写的缓存（秒回），
// 避免公开模型串行拉取把详情拖到 12~13s。
async function vrcLoadRealTime(vrchatId, baseD, token) {
  const body = document.getElementById('vrcMemberBody');
  if (!body) return;
  const mergeV = (v) => {
    const merged = Object.assign({}, baseD);
    const fields = ['displayName','avatarUrl','profilePicOverrideThumbnail','userIcon','bio','bioLinks',
      'status','statusDescription','trustLevel','trustLevelCn','trustRank','developerType','developerTypeCn',
      'isTroll','badges','platform','location','instance','isVrcPlus','ageVerified','ageVerificationStatus',
      'representedGroup','languages','pronouns','previousDisplayNames','lastPlatform',
      'dateJoined','allowAvatarCopying','bannerColor','bannerType',
      'hasVrcPublicModels','publicModels','joinedInstanceAt','isInGame'];
    fields.forEach(f => { if (v[f] !== undefined && v[f] !== '' && v[f] !== null) merged[f] = v[f]; });
    // 状态：仅好友视角才允许覆盖（非好友 API 返回 stale offline）
    if (!merged.isFriend && baseD.status) merged.status = baseD.status;
    return merged;
  };
  try {
    const res = await api('/api/group/members/' + encodeURIComponent(vrchatId) + '/vrchat', { method: 'GET', timeout: 12000 });
    if (vrcCardOpener.stale(token)) return; // 过期实时拉取丢弃（防串台）
    if (!res.ok) return; // 失败不阻断，保留 DB 基础资料
    const data = await res.json();
    if (vrcCardOpener.stale(token)) return;
    const v = data.vrc || {};
    const merged = mergeV(v);
    vrcDetailCacheSet(vrchatId, merged); // 合并实时资料后更新缓存，下次秒开更完整
    renderVrcMemberCard(merged, token);

    // 公开模型后台补拉中：3s 后重查一次（此时后台已回写缓存 → cached:true 秒回带模型）
    if (data.modelsPending && !vrcCardOpener.stale(token)) {
      setTimeout(async () => {
        if (vrcCardOpener.stale(token)) return;
        try {
          const res2 = await api('/api/group/members/' + encodeURIComponent(vrchatId) + '/vrchat', { method: 'GET', timeout: 8000 });
          if (vrcCardOpener.stale(token) || !res2.ok) return;
          const d2 = await res2.json();
          if (vrcCardOpener.stale(token)) return;
          const v2 = d2.vrc || {};
          if (v2.publicModels && v2.publicModels.length) {
            const merged2 = mergeV(v2);
            vrcDetailCacheSet(vrchatId, merged2);
            renderVrcMemberCard(merged2, token);
          }
        } catch (e) { /* 模型补拉失败/超时：忽略，保留当前展示，下次点开走缓存 */ }
      }, 3000);
    }
  } catch (e) {
    // 超时/限流：忽略，保留 DB 基础资料
  }
}

function renderVrcMemberCard(d, forId) {
  const body = document.getElementById('vrcMemberBody');
  if (!body) return;
  // 二次保险：仅当渲染目标与当前弹窗归属一致时才落盘，杜绝任何过期/错用户响应串台
  if (forId != null && vrcCardOpener.stale(forId)) return;
  // 头像优先顺序：用户上传的自定义头像大图 > 当前模型缩略图 > 后端按 VRChat ID 解析 > 默认图。
  // 与群组列表同一链路（P2-46）：assets.amlcdn.com 历史缩略图国内 TLS 层即被阻断，直接弃用；
  // CDN 地址经 proxyAvatar（直连优先/代理兜底/失败记忆）；DB 无头像时走 /api/avatar/user
  // 按 ID 解析真实头像（列表已验证可达），避免名片永远挂默认占位图。
  const rawCustomAvatar = d.profilePicOverrideThumbnail || d.profilePicOverride || '';
  const rawCurrentAvatar = d.avatarUrl || '';
  const customAvatar = /^https?:\/\/[^/]*assets\.amlcdn\.com\//i.test(rawProxiedAvatar(rawCustomAvatar)) ? '' : rawCustomAvatar;
  const currentAvatar = /^https?:\/\/[^/]*assets\.amlcdn\.com\//i.test(rawProxiedAvatar(rawCurrentAvatar)) ? '' : rawCurrentAvatar;
  const vrcAvatarFallback = d.vrchatId ? '/api/avatar/user?u=' + encodeURIComponent(d.vrchatId) : '';
  const avatar = proxyAvatar(customAvatar || currentAvatar || vrcAvatarFallback) || '/api/avatar/default';
  // 在线状态文案以 group_roster 权威同步值（d.isOnline）为根基，确保与群组列表完全一致：
  // 离线时一律显示「⚫ 离线」，避免被 API 对非好友返回的 stale/offline 文案误标；
  // 在线时再附加 DB 同步到的具体状态（active/join me 等），好友视角下才展示 API 实时精确状态。
  // 在线状态文案：DB 权威同步值（d.isOnline）。当 isOnline 为真但 status 为 unknown（同步候选态）
  // 时，不显示「unknown」原值，统一兜底为「🟢 在线」，避免名片出现生硬的「未知」字样。
  const statusLabel = d.isOnline
    ? (VRC_STATUS_LABEL[d.status] || __('auto_members_19'))
    : __('auto_members_20');
  const trustColor = trustColorOf(d.trustLevel) || '#9e9e9e';
  // 信任等级：VRChat API 未返回（隐私墙隐藏 / 非好友 / 限流）时后端不填充。
  // 按用户要求：隐藏时不显示生硬的「未公开」，统一降级为「隐藏」。
  const trustText = d.trustLevelCn || d.trustLevel || __('auto_members_21');
  const badges = (d.badges || []).filter(Boolean);
  // FE-1：过滤危险 URL scheme（javascript:/data: 等），仅放行 http/https 或无 scheme 链接
  const bioLinks = (d.bioLinks || []).filter(Boolean).filter(function (l) { return typeof safeHref === 'function' ? safeHref(l) : true; });
  const profileUrl = 'https://vrchat.com/home/user/' + escAttr(d.vrchatId || '');
  const joined = d.lastLogin ? new Date(d.lastLogin).toLocaleDateString(getCurrentLang ? getCurrentLang() : 'zh') : '—';
  // 语言代码 → 中文名（借鉴 VRCX $languages）
  const LANG_CN = { zho: __('auto_members_22'), eng: __('auto_members_23'), jpn: __('auto_members_24'), kor: __('auto_members_25'), fra: __('auto_members_26'), deu: __('auto_members_27'), spa: __('auto_members_28'), rus: __('auto_members_29'), cht: __('auto_members_30'), por: __('auto_members_31'), ita: __('auto_members_32'), tha: __('auto_members_33'), ind: __('auto_members_34'), vie: __('auto_members_35'), ara: __('auto_members_36'), nld: __('auto_members_37'), pol: __('auto_members_38'), tur: __('auto_members_39'), swe: __('auto_members_40'), dan: __('auto_members_41'), fin: __('auto_members_42'), nor: __('auto_members_43'), ces: __('auto_members_44'), hun: __('auto_members_45'), ron: __('auto_members_46'), ukr: __('auto_members_47') };
  const languagesText = (d.languages || []).map(l => LANG_CN[l] || l).join('、');
  // 注册日期
  const dateJoined = d.dateJoined ? new Date(d.dateJoined).toLocaleDateString(getCurrentLang ? getCurrentLang() : 'zh') : '';
  // 主页展示群（≠ 当前房间所属群）
  const repGroup = d.representedGroup || null;
  // F-24: 所在世界 → 地图名 + vrchat.com 官网世界页链接（VRCX/RVW 同款）。
  // world_id 来自 d.worldId（VRChat user.worldId）或 location 首段（wrld_xxx:instance...）；
  // world_name 由后端经 world_cache 解析为真实名称，解析失败时保留 wrld_id 降级显示。
  const curWorldId = d.worldId || (d.location ? String(d.location).split(':')[0] : '') || '';
  const curWorldInstanceId = d.location ? (String(d.location).split(':')[1] || '') : '';
  const rawWorldName = d.worldName || '';
  const displayWorldName = rawWorldName && !/^wrld_[0-9a-fA-F-]+$/.test(String(rawWorldName)) ? rawWorldName : '';
  const worldUrl = curWorldId
    ? 'https://vrchat.com/home/world/' + encodeURIComponent(curWorldId) + (curWorldInstanceId ? '?instanceId=' + encodeURIComponent(curWorldInstanceId) : '')
    : '';
  const worldHtml = worldUrl
    ? `<a href="${escAttr(worldUrl)}" target="_blank" rel="noopener" class="vrc-world-link">🌐 ${esc(displayWorldName || curWorldId)}</a>`
    : (displayWorldName ? '🌐 ' + esc(displayWorldName) : '—');
  // 结构化实例信息
  const inst = d.instance || null;
  const instAccessLabel = inst ? (inst.accessTypeName === 'groupPlus' ? __('members.vrc_access_group_plus') : (inst.accessTypeName || __('auto_members_48'))) : '';
  // 横幅色（profile bannerColor hex 不带 #）
  const bannerColor = (d.bannerColor && /^([0-9a-fA-F]{6})$/.test(d.bannerColor)) ? '#' + d.bannerColor : '';

  // V8 增强字段
  const ACTIVITY_LABEL = { active7d: __('auto_members_49'), active30d: __('auto_members_50'), inactive: __('auto_members_51') };
  const activityLabel = ACTIVITY_LABEL[d.activityLevel] || '—';
  const lu = d.localUser || { bound: false };
  const ct = d.contribution || { publicModels: 0, eventSigns: 0, totalCheckins: 0 };
  const recent = d.recentActivity || [];
  const pubModels = d.publicModels || [];
  const fmtDateTime = (x) => x ? new Date(x).toLocaleString(getCurrentLang ? getCurrentLang() : 'zh', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

  // F-10: 名片对应 VRC 账号已绑定到当前登录用户本人时，隐藏发起邀请/好友申请入口
  const isSelfCard = lu.bound && currentUser && String(lu.id || '') === String(currentUser.id || '');

  const localUserHtml = lu.bound ? `
    <div class="vrc-localuser">
      <span class="vrc-section-label">${__('members.vrc_bind_label')}</span>
      <div class="vrc-localuser-row">
        <span class="vrc-localuser-badge">${__('members.vrc_bound')}</span>
        <span class="vrc-meta-v">${esc(lu.displayName || lu.loginId)}（@${esc(lu.loginId)}）</span>
        <span class="vrc-role-tag role-${(lu.role || 'member')}">${lu.role === 'super_admin' ? __('members.role_super_admin') : lu.role === 'admin' ? __('members.role_admin') : __('auto_members_52')}</span>
      </div>
      ${lu.registeredAt ? `<div class="text-13 text-muted2">${__('members.registered_at')} ${fmtDateTime(lu.registeredAt)}</div>` : ''}
    </div>` : `
    <div class="vrc-localuser">
      <span class="vrc-section-label">${__('members.vrc_bind_label')}</span>
      <div class="vrc-localuser-row"><span class="vrc-localuser-badge off">${__('members.vrc_unbound')}</span><span class="text-13 text-muted2">${__('members.vrc_unbound_hint')}</span></div>
    </div>`;

  const recentHtml = recent.length ? `
    <div class="vrc-recent">
      <span class="vrc-section-label">${__('members.vrc_recent_label')}</span>
      <ul class="vrc-recent-list">
        ${recent.map(r => `<li><span class="vrc-recent-type">${esc(r.type)}</span><span class="vrc-recent-title">${esc(r.title || '-')}</span><span class="vrc-recent-at">${fmtDateTime(r.at)}</span></li>`).join('')}
      </ul>
    </div>` : '';

  const perfBadge = (perf) => {
    if (!perf) return '';
    const map = { Excellent: ['excellent', __('auto_members_53')], Good: ['good', __('auto_members_54')], Medium: ['medium', __('auto_members_55')], Poor: ['poor', __('auto_members_56')], VeryPoor: ['verypoor', __('auto_members_57')] };
    const [cls, label] = map[perf] || ['', perf];
    return `<span class="vrc-model-perf perf-${cls}">${esc(label)}</span>`;
  };
  const fmtModelDate = (s) => {
    if (!s) return '';
    const dt = new Date(s);
    if (isNaN(dt)) return '';
    return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
  };
  const modelCard = (m) => {
    const img = m.thumbnailUrl
      ? `<img class="vrc-model-img" src="${escAttr(m.thumbnailUrl)}" alt="${escAttr(m.name)}" loading="lazy">`
      : `<div class="vrc-model-img img-failed"></div>`;
    const tags = (Array.isArray(m.tags) ? m.tags.slice(0, 4) : [])
      .map(t => `<span class="vrc-model-tag">${esc(t)}</span>`).join('');
    const date = fmtModelDate(m.createdAt);
    const meta = [
      perfBadge(m.performanceRating),
      m.platform ? `<span class="vrc-model-platform">${esc(m.platform)}</span>` : '',
      (typeof m.favoriteCount === 'number' || (typeof m.favoriteCount === 'string' && m.favoriteCount !== '')) ? `<span class="vrc-model-fav">♥ ${esc(String(m.favoriteCount))}</span>` : ''
    ].filter(Boolean).join('');
    const inner = `
      ${img}
      <div class="vrc-model-info">
        <div class="vrc-model-name" title="${escAttr(m.name)}">${esc(m.name || __('auto_members_58'))}</div>
        ${m.authorName ? `<div class="vrc-model-author">by ${esc(m.authorName)}</div>` : ''}
        ${tags ? `<div class="vrc-model-tags">${tags}</div>` : ''}
        <div class="vrc-model-meta">${meta}${date ? `<span class="vrc-model-date">${date}</span>` : ''}</div>
      </div>`;
    let linkOpen, linkClose;
    if (m.url) {
      if (/^https?:\/\//i.test(m.url)) {
        linkOpen = `<a class="vrc-model-card" href="${escAttr(m.url)}" target="_blank" rel="noopener">`;
        linkClose = '</a>';
      } else {
        // 站内路由（收藏已并入 VRC 页签子视图）：切到 VRC 页签并指定目标子视图
        linkOpen = `<a class="vrc-model-card" href="javascript:void(0)" data-action="vrc-goto-collections">`;
        linkClose = '</a>';
      }
    } else {
      linkOpen = `<div class="vrc-model-card">`;
      linkClose = '</div>';
    }
    return linkOpen + inner + linkClose;
  };
  let modelsHtml = '';
  if (pubModels && pubModels.length) {
    const vrcCount = pubModels.filter(m => m.source === 'vrchat').length;
    modelsHtml = `
    <div class="vrc-models">
      <span class="vrc-section-label">${__('members.public_models_label')}${vrcCount ? `（${__('members.vrc_public_count_note', { n: pubModels.length })}）` : __('auto_members_59')}</span>
      <div class="vrc-model-list">
        ${pubModels.map(modelCard).join('')}
      </div>
    </div>`;
  } else {
    // 异常/缺失提示：区分「未查询」「查询过但无结果」「本站也无收藏」
    const tip = (d.hasVrcPublicModels === false)
      ? __('members.vrc_model_empty')
      : __('auto_members_60');
    modelsHtml = `
    <div class="vrc-models">
      <span class="vrc-section-label">${__('members.public_models_label')}</span>
      <div class="vrc-model-empty">${esc(tip)}</div>
    </div>`;
  }

  body.innerHTML = `
    <div class="vrc-card">
      <div class="vrc-card-banner" ${bannerColor ? `style="background:${escAttr(bannerColor)}"` : ''}></div>
      <div class="vrc-card-head">
        <div class="vrc-avatar-wrap">
          <img src="${escAttr(avatar)}" class="vrc-avatar" alt="${esc(d.displayName)}">
          <div class="vrc-avatar-fallback" style="display:none">${(d.displayName || '?').charAt(0).toUpperCase()}</div>
        </div>
        <div class="vrc-head-meta">
          <div class="vrc-name-row">
            <h3 class="vrc-displayname" data-action="copy-vrc-name" title="${esc(__('auto_members_61'))}">${esc(d.displayName || __('auto_members_62'))}</h3>
            <span class="vrc-status-pill ${d.isOnline ? 'online' : 'offline'}" title="${esc(__('auto_members_63'))}">${statusLabel}</span>
            ${d.isVrcPlus ? `<span class="vrc-plus-badge" title="VRC+ ${__('members.vrc_plus')}">⭐ ${__('members.vrc_plus')}</span>` : ''}
            ${d.ageVerified ? `<span class="vrc-age-badge" title="${esc(__('members.age_verified_tooltip').replace('{status}', d.ageVerificationStatus || '18+'))}">🔞 ${__('members.verified')}</span>` : ''}
            ${d.userIcon ? `<img src="${escAttr(d.userIcon)}" class="vrc-usericon" alt="${esc(__('auto_members_64'))}" title="${esc(badges.join('，'))}">` : ''}
            <span class="vrc-friend-badge ${d.isFriend ? 'is-friend' : 'not-friend'}" title="${esc(d.isFriend ? __('members.vrc_friend_tip') : __('members.vrc_not_friend_tip'))}">${d.isFriend ? '🤝 ' + __('members.vrc_friend') : __('auto_members_66')}</span>
          </div>
          <div class="vrc-subline">
            <span class="vrc-trust" style="--trust:${trustColor}" title="${esc(__('members.vrc_trust_tip'))}">
              ${d.trustLevel ? '🛡️ ' : '🔒 '}${__('members.vrc_trust_label')}：${esc(trustText)}
            </span>
            ${d.developerType && d.developerType !== 'none' ? `<span class="vrc-dev">${esc(d.developerTypeCn || d.developerType)}</span>` : ''}
            ${d.isTroll ? `<span class="vrc-troll" title="${esc(__('members.vrc_troll_tip'))}">☠️ ${esc(__('members.vrc_troll_label'))}</span>` : ''}
            ${customAvatar && currentAvatar && currentAvatar !== customAvatar ? `<span class="vrc-avatar-source" title="${esc(__('members.custom_avatar'))}">🖼️ ${__('members.custom_avatar')}</span>` : ''}
          </div>
        </div>
      </div>

      ${badges.length ? `<div class="vrc-badges">
        <span class="vrc-section-label">${__('members.vrc_badges_label')}</span>
        <div class="vrc-badge-list">${badges.map(b => `<span class="vrc-badge">🏅 ${esc(b)}</span>`).join('')}</div>
      </div>` : ''}

      ${d.bio ? `<div class="vrc-bio">
        <span class="vrc-section-label">${__('members.vrc_bio_label')}</span>
        <p class="vrc-bio-text">${esc(d.bio)}</p>
      </div>` : ''}

      ${bioLinks.length ? `<div class="vrc-links">
        <span class="vrc-section-label">${__('members.vrc_links_label')}</span>
        <div class="vrc-link-list">${bioLinks.map(l => `<a href="${escAttr(l)}" target="_blank" rel="noopener" class="vrc-link">🔗 ${esc(l)}</a>`).join('')}</div>
      </div>` : ''}

      <div class="vrc-meta-grid">
        <div class="vrc-meta-item">
          <span class="vrc-meta-k">${__('members.vrc_meta_world')}</span>
          <span class="vrc-meta-v">${worldHtml}</span>
        </div>
        <div class="vrc-meta-item">
          <span class="vrc-meta-k">${__('members.vrc_meta_platform')}</span>
          <span class="vrc-meta-v">${d.platform ? esc(d.platform) : '—'}</span>
        </div>
        <div class="vrc-meta-item">
          <span class="vrc-meta-k">${__('members.vrc_meta_group_join')}</span>
          <span class="vrc-meta-v">${d.joinedAt ? fmtDateTime(d.joinedAt) : '—'}</span>
        </div>
        <div class="vrc-meta-item">
          <span class="vrc-meta-k">${__('members.vrc_meta_last_login')}</span>
          <span class="vrc-meta-v">${joined}</span>
        </div>
        <div class="vrc-meta-item">
          <span class="vrc-meta-k">${__('members.vrc_meta_activity')}</span>
          <span class="vrc-meta-v">${activityLabel}</span>
        </div>
        <div class="vrc-meta-item">
          <span class="vrc-meta-k">${__('members.vrc_meta_registered')}</span>
          <span class="vrc-meta-v">${dateJoined || '—'}</span>
        </div>
        ${languagesText ? `<div class="vrc-meta-item">
          <span class="vrc-meta-k">${__('members.vrc_meta_language')}</span>
          <span class="vrc-meta-v">🗣️ ${esc(languagesText)}</span>
        </div>` : ''}
        ${d.pronouns ? `<div class="vrc-meta-item">
          <span class="vrc-meta-k">${__('members.vrc_meta_pronouns')}</span>
          <span class="vrc-meta-v">${esc(d.pronouns)}</span>
        </div>` : ''}
        <div class="vrc-meta-item">
          <span class="vrc-meta-k">${__('members.vrc_meta_trust_level')}</span>
          <span class="vrc-meta-v">${d.trustLevel ? `Lv.${d.trustRank || 0}（${trustText}）` : __('auto_members_68')}</span>
        </div>
        <div class="vrc-meta-item">
          <span class="vrc-meta-k">${__('members.vrc_meta_contribution')}</span>
          <span class="vrc-meta-v">${__('members.vrc_contribution_summary', { m: ct.publicModels, e: ct.eventSigns, c: ct.totalCheckins })}</span>
        </div>
        ${repGroup && repGroup.name ? `<div class="vrc-meta-item vrc-meta-full">
          <span class="vrc-meta-k">${__('members.vrc_meta_rep_group')}</span>
          <span class="vrc-meta-v">🏠 ${esc(repGroup.name)}${repGroup.id ? ` <span class="vrc-meta-sub">${esc(repGroup.id)}</span>` : ''}</span>
        </div>` : ''}
        ${d.allowAvatarCopying === true ? `<div class="vrc-meta-item">
          <span class="vrc-meta-k">${__('members.vrc_meta_current_model')}</span>
          <span class="vrc-meta-v">${__('members.vrc_copy_allowed')}</span>
        </div>` : (d.allowAvatarCopying === false ? `<div class="vrc-meta-item">
          <span class="vrc-meta-k">${__('members.vrc_meta_current_model')}</span>
          <span class="vrc-meta-v">${__('members.vrc_copy_denied')}</span>
        </div>` : '')}
        ${inst && !inst.isOffline ? `<div class="vrc-meta-item vrc-meta-full">
          <span class="vrc-meta-k">${__('members.vrc_meta_instance')}</span>
          <span class="vrc-meta-v">🚪 ${esc(inst.instanceName || '—')}${instAccessLabel ? ` · ${esc(instAccessLabel)}` : ''}${inst.region ? ` · ${__('members.region_label')} ${esc(inst.region.toUpperCase())}` : ''}${inst.groupId ? ` · ${__('members.instance_owner_group')} ${esc(inst.groupId)}` : ''}</span>
        </div>` : ''}
        ${d.statusDescription ? `<div class="vrc-meta-item vrc-meta-full">
          <span class="vrc-meta-k">${__('members.vrc_meta_status_desc')}</span>
          <span class="vrc-meta-v">${esc(d.statusDescription)}</span>
        </div>` : ''}
        ${d.lastPlatform ? `<div class="vrc-meta-item">
          <span class="vrc-meta-k">${__('members.vrc_meta_last_platform')}</span>
          <span class="vrc-meta-v">${esc(d.lastPlatform)}</span>
        </div>` : ''}
        ${d.joinedInstanceAt && d.isInGame ? `<div class="vrc-meta-item">
          <span class="vrc-meta-k">${__('members.vrc_meta_enter_instance')}</span>
          <span class="vrc-meta-v">${fmtDateTime(d.joinedInstanceAt)}</span>
        </div>` : ''}
        ${(Array.isArray(d.previousDisplayNames) && d.previousDisplayNames.length) ? `<div class="vrc-meta-item vrc-meta-full">
          <span class="vrc-meta-k">${__('members.vrc_meta_prev_names')}</span>
          <span class="vrc-meta-v">${esc(d.previousDisplayNames.slice(0, 8).join(' · '))}${d.previousDisplayNames.length > 8 ? ' …' : ''}</span>
        </div>` : ''}
      </div>

      ${localUserHtml}
      ${modelsHtml}
      ${recentHtml}

      <div class="vrc-card-actions">
        <a href="${profileUrl}" target="_blank" rel="noopener" class="btn btn-sm btn-primary">${__('members.vrc_view_in_vrchat')}</a>
        ${!isSelfCard && !d.isFriend && d.vrchatId ? `<button type="button" class="btn btn-sm btn-outline" data-action="vrc-friend" data-vrc-id="${escAttr(d.vrchatId)}">🤝 ${__('members.vrc_friend_request_btn')}</button>` : ''}
        ${!isSelfCard && d.isFriend && d.vrchatId && inst && !inst.isOffline && /^wrld_[0-9a-fA-F-]+:.+$/.test(d.location || '') ? `<button type="button" class="btn btn-sm btn-outline" data-action="vrc-invite" data-vrc-id="${escAttr(d.vrchatId)}" data-location="${escAttr(d.location)}">📨 ${__('members.vrc_invite_btn')}</button>` : ''}
        ${!isSelfCard && d.isFriend && d.vrchatId ? `<button type="button" class="btn btn-sm btn-outline" data-action="vrc-boop" data-vrc-id="${escAttr(d.vrchatId)}" title="${escAttr(__('members.vrc_boop_hint'))}">👋 ${__('members.vrc_boop_btn')}</button>` : ''}
        ${!isSelfCard && d.vrchatId ? `<button type="button" class="btn btn-sm btn-outline" data-action="vrc-note" data-vrc-id="${escAttr(d.vrchatId)}">📝 ${__('members.vrc_note_btn')}</button>` : ''}
      </div>
    </div>`;

  // 头像失败兜底：先按 VRChat ID 经 /api/avatar/user 重试一次，再失败切首字母占位
  const avatarImg = body.querySelector('.vrc-avatar');
  const avatarFallbackEl = body.querySelector('.vrc-avatar-fallback');
  if (avatarImg) {
    avatarImg.onerror = function () {
      if (vrcAvatarFallback && avatarImg.getAttribute('src') !== vrcAvatarFallback && !avatarImg.dataset.vrcAvatarRetried) {
        avatarImg.dataset.vrcAvatarRetried = '1';
        avatarImg.onerror = function () {
          avatarImg.style.display = 'none';
          if (avatarFallbackEl) avatarFallbackEl.style.display = 'flex';
        };
        avatarImg.src = vrcAvatarFallback;
        return;
      }
      avatarImg.style.display = 'none';
      if (avatarFallbackEl) avatarFallbackEl.style.display = 'flex';
    };
  }
}

// ==================== F-10 VRChat 官方实例邀请 / 好友申请 ====================
async function vrcSendInvite(targetUserId, instanceId, btn) {
  if (!targetUserId || !instanceId) return;
  if (btn) btn.disabled = true;
  try {
    const res = await api('/api/vrc-invites/world', {
      method: 'POST',
      body: JSON.stringify({ targetUserId, instanceId }),
      timeout: 20000
    });
    if (res.ok) {
      toast(__('members.vrc_invite_sent'), 'success');
    } else {
      const err = await res.json().catch(() => ({}));
      toast(errText(err) || __('members.vrc_invite_failed'), 'error');
    }
  } catch (e) {
    toast(__('members.vrc_invite_failed'), 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function vrcSendFriendRequest(targetUserId, btn) {
  if (!targetUserId) return;
  if (btn) btn.disabled = true;
  try {
    const res = await api('/api/vrc-invites/friend-request', {
      method: 'POST',
      body: JSON.stringify({ targetUserId }),
      timeout: 20000
    });
    if (res.ok) {
      toast(__('members.vrc_friend_request_sent'), 'success');
      if (btn) btn.remove();
    } else {
      const err = await res.json().catch(() => ({}));
      toast(errText(err) || __('members.vrc_friend_request_failed'), 'error');
      if (btn) btn.disabled = false;
    }
  } catch (e) {
    toast(__('members.vrc_friend_request_failed'), 'error');
    if (btn) btn.disabled = false;
  }
}

// ==================== F-24 VRChat 个人写操作（Boop / 备注） ====================
// 两个写接口均要求已绑定 VRChat 账号（NEED_BIND 由后端引导）；真实调用需 VRChat
// 官方 API 权限与互为好友关系，交付后以真实账号联调验证（见 docs/19 F-24）。
async function vrcBoop(targetUserId, btn) {
  if (!targetUserId) return;
  if (btn) btn.disabled = true;
  try {
    const res = await api('/api/vrc-invites/boop', {
      method: 'POST',
      body: JSON.stringify({ targetUserId }),
      timeout: 20000
    });
    if (res.ok) {
      toast(__('members.vrc_boop_sent'), 'success');
    } else {
      const err = await res.json().catch(() => ({}));
      toast(errText(err) || __('members.vrc_boop_failed'), 'error');
    }
  } catch (e) {
    toast(__('members.vrc_boop_failed'), 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function vrcEditNote(targetUserId, btn) {
  if (!targetUserId) return;
  showInput(__('members.vrc_note_prompt'), '', async (val) => {
    if (val === null) return;
    if (btn) btn.disabled = true;
    try {
      const res = await api('/api/vrc-invites/note', {
        method: 'POST',
        body: JSON.stringify({ targetUserId, note: val }),
        timeout: 20000
      });
      if (res.ok) {
        toast(val ? __('members.vrc_note_saved') : __('members.vrc_note_cleared'), 'success');
      } else {
        const err = await res.json().catch(() => ({}));
        toast(errText(err) || __('members.vrc_note_failed'), 'error');
      }
    } catch (e) {
      toast(__('members.vrc_note_failed'), 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  });
}

// ==================== F-16 头像详情（使用历史 + 标签 + 收藏） ====================
let currentAvatarDetail = null; // { vrchatId, avatarId, displayName, localUserId, avatarUrl }

async function openAvatarDetail(vrchatId, avatarId, displayName, localUserId, avatarUrl) {
  currentAvatarDetail = {
    vrchatId: vrchatId || '',
    avatarId: avatarId || '',
    displayName: displayName || '',
    localUserId: Number(localUserId) || 0,
    avatarUrl: avatarUrl || ''
  };
  const modal = document.getElementById('avatarDetailModal');
  if (!modal) {
    document.body.insertAdjacentHTML('beforeend', `
      <div id="avatarDetailModal" class="modal">
        <div class="modal-content">
          <div class="modal-header">
            <h3>🖼️ ${__('members.avatar_detail_title')}</h3>
            <button class="modal-close" data-action="close-avatar-detail" aria-label="${__('common.close')}">✕</button>
          </div>
          <div id="avatarDetailBody" class="avatar-detail-body">
            <div class="avatar-detail-loading">${__('common.loading')}</div>
          </div>
        </div>
      </div>
    `);
  }
  const body = document.getElementById('avatarDetailBody');
  if (body) body.innerHTML = `<div class="avatar-detail-loading">${__('common.loading')}</div>`;
  showModal('avatarDetailModal');
  await loadAvatarDetail();
}

async function loadAvatarDetail() {
  const d = currentAvatarDetail;
  if (!d) return;
  const body = document.getElementById('avatarDetailBody');
  if (!body) return;
  const hasAvatarId = /^avtr_/i.test(d.avatarId);
  const results = await Promise.allSettled([
    d.localUserId ? api(`/api/friends/avatar-history/${d.localUserId}`) : Promise.resolve(null),
    hasAvatarId ? api(`/api/avatar-tags/${encodeURIComponent(d.avatarId)}`) : Promise.resolve(null)
  ]);
  let history = { items: [], totalAvatars: 0, totalUses: 0 };
  let tags = [];
  const histRes = results[0].status === 'fulfilled' ? results[0].value : null;
  const tagRes = results[1].status === 'fulfilled' ? results[1].value : null;
  if (histRes && histRes.ok) { try { history = await histRes.json(); } catch {} }
  if (tagRes && tagRes.ok) { try { const td = await tagRes.json(); tags = td.tags || []; } catch {} }
  renderAvatarDetail(history, tags);
}

function renderAvatarDetail(history, tags) {
  const d = currentAvatarDetail;
  if (!d) return;
  const body = document.getElementById('avatarDetailBody');
  if (!body) return;
  const hasAvatarId = /^avtr_/i.test(d.avatarId);
  const fmtT = (x) => x ? new Date(x).toLocaleString(getCurrentLang ? getCurrentLang() : 'zh', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

  const histItems = history.items || [];
  const historyHtml = d.localUserId ? `
    <div class="avatar-detail-block">
      <span class="vrc-section-label">${__('members.avatar_history_label')}${history.totalAvatars ? `（${__('members.avatar_history_total').replace('{a}', history.totalAvatars).replace('{u}', history.totalUses)}）` : ''}</span>
      ${histItems.length ? `<div class="avatar-hist-list">${histItems.map(it => `
        <div class="avatar-hist-item">
          <img class="avatar-hist-img" src="${escAttr(it.avatarUrl || '/api/avatar/default')}" alt="" loading="lazy">
          <div class="avatar-hist-fallback" style="display:none">🖼️</div>
          <div class="avatar-hist-meta">
            <div class="avatar-hist-id" title="${escAttr(it.avatarId)}">${esc(it.avatarId)}</div>
            <div class="avatar-hist-times">${__('members.avatar_uses').replace('{n}', it.useCount)} · ${__('members.avatar_first_seen')} ${fmtT(it.firstSeenAt)} · ${__('members.avatar_last_seen')} ${fmtT(it.lastSeenAt)}</div>
          </div>
        </div>`).join('')}</div>` : `<div class="avatar-detail-empty">${__('members.avatar_history_empty')}</div>`}
    </div>` : `<div class="avatar-detail-empty">${__('members.avatar_not_bound')}</div>`;

  const tagsHtml = hasAvatarId ? `
    <div class="avatar-detail-block">
      <span class="vrc-section-label">${__('members.avatar_tags_label')}</span>
      <div class="avatar-tag-edit">
        <input id="avatarTagInput" class="form-input" type="text" maxlength="255" placeholder="${__('members.avatar_tags_placeholder')}" value="${escAttr(tags.join(', '))}">
        <div class="form-actions mt-2">
          <button type="button" class="btn btn-sm btn-danger" data-action="avatar-tags-clear">${__('common.delete')}</button>
          <button type="button" class="btn btn-sm btn-accent" data-action="avatar-tags-save">${__('common.save')}</button>
        </div>
      </div>
    </div>` : '';

  const favBtn = hasAvatarId
    ? `<button id="avatarFavoriteBtn" type="button" class="btn btn-sm btn-primary" data-action="avatar-fav">♥ ${__('members.avatar_favorite_btn')}</button>`
    : '';

  body.innerHTML = `
    <div class="avatar-detail-current">
      <img class="avatar-detail-current-img" src="${escAttr(d.avatarUrl || '/api/avatar/default')}" alt="${escAttr(d.displayName)}" data-avatar-fail-src="${escAttr(d.avatarUrl || '/api/avatar/default')}">
      <div class="avatar-detail-current-meta">
        <div class="avatar-detail-current-name">${esc(d.displayName)}</div>
        <div class="avatar-detail-current-id" title="${escAttr(d.avatarId)}">${esc(d.avatarId || __('members.avatar_no_id'))}</div>
      </div>
      <div class="avatar-detail-current-actions">${favBtn}</div>
    </div>
    ${tagsHtml}
    ${historyHtml}
  `;
}

async function favoriteAvatar() {
  const d = currentAvatarDetail;
  if (!d || !/^avtr_/i.test(d.avatarId)) return;
  if (!isLoggedIn()) { toast(__('collections.login_required'), 'error'); return; }
  try {
    const res = await api('/api/collections', {
      method: 'POST',
      body: JSON.stringify({ kind: 'avatar_model', target_id: d.avatarId, folder_id: null, notes: '', booth_url: '', visibility: 'private' })
    });
    if (res.ok) {
      toast(__('members.avatar_favorited'), 'success');
      const btn = document.getElementById('avatarFavoriteBtn');
      if (btn) { btn.disabled = true; btn.textContent = '✅ ' + __('members.avatar_favorited_label'); }
    } else {
      const err = await res.json().catch(() => ({}));
      toast(errText(err) || __('members.avatar_favorite_failed'), 'error');
    }
  } catch (e) {
    toast(__('members.avatar_favorite_failed'), 'error');
  }
}

async function saveAvatarTags() {
  const d = currentAvatarDetail;
  if (!d || !/^avtr_/i.test(d.avatarId)) return;
  const input = document.getElementById('avatarTagInput');
  if (!input) return;
  const tags = input.value.split(',').map(s => s.trim()).filter(Boolean).slice(0, 8);
  try {
    const res = await api(`/api/avatar-tags/${encodeURIComponent(d.avatarId)}`, {
      method: 'POST',
      body: JSON.stringify({ tags })
    });
    if (res.ok) {
      toast(__('members.avatar_tags_saved'), 'success');
    } else {
      const err = await res.json().catch(() => ({}));
      toast(errText(err) || __('members.avatar_tags_save_failed'), 'error');
    }
  } catch (e) {
    toast(__('members.avatar_tags_save_failed'), 'error');
  }
}

async function clearAvatarTags() {
  const d = currentAvatarDetail;
  if (!d || !/^avtr_/i.test(d.avatarId)) return;
  showConfirm(__('members.avatar_tags_confirm_clear'), async function () {
    try {
      const res = await api(`/api/avatar-tags/${encodeURIComponent(d.avatarId)}`, { method: 'DELETE' });
      if (res.ok) {
        toast(__('members.avatar_tags_cleared'), 'success');
        const input = document.getElementById('avatarTagInput');
        if (input) input.value = '';
      } else {
        toast(__('members.avatar_tags_clear_failed'), 'error');
      }
    } catch (e) {
      toast(__('members.avatar_tags_clear_failed'), 'error');
    }
  });
}

// ==================== 成员卡片 3D 倾斜（桌面端） ====================
(function () {
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  if (reduce || !finePointer) return;

  const MAX_TILT = 6; // 度
  let rafId = null;
  let current = null;

  document.addEventListener('mousemove', function (e) {
    const card = e.target.closest ? e.target.closest('.member-card') : null;
    if (card !== current) {
      if (current) resetCard(current);
      current = card;
    }
    if (!card) return;
    if (rafId) return;
    rafId = requestAnimationFrame(function () {
      rafId = null;
      if (!current) return;
      const rect = current.getBoundingClientRect();
      const px = (e.clientX - rect.left) / rect.width - 0.5;
      const py = (e.clientY - rect.top) / rect.height - 0.5;
      current.classList.add('tilt-on');
      current.style.setProperty('--tilt-y', (px * MAX_TILT).toFixed(2) + 'deg');
      current.style.setProperty('--tilt-x', (-py * MAX_TILT).toFixed(2) + 'deg');
    });
  });

  document.addEventListener('mouseout', function (e) {
    if (!current) return;
    const to = e.relatedTarget;
    if (to && current.contains(to)) return;
    resetCard(current);
    current = null;
  });

  function resetCard(card) {
    card.classList.remove('tilt-on');
    card.style.removeProperty('--tilt-x');
    card.style.removeProperty('--tilt-y');
  }
})();

// ==================== 名片/VRChat/审核等弹窗按钮事件委托（CSP nonce 下内联处理器不可用） ====================
// 迁移自成员名片链接区、备注/举报弹窗、审核队列、VRChat 名片与头像详情弹窗里的
// 内联 onclick —— 属性型处理器被 script-src nonce 拦截（与成员卡/动态同案），
// 统一改为 data-action + document 级委托，天然覆盖重渲染与懒加载时序。
let _membersDelegationHandler = null;

function _bindMembersDelegation() {
  if (_membersDelegationHandler) document.removeEventListener('click', _membersDelegationHandler);
  _membersDelegationHandler = function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
    if (!el) return;
    var action = el.getAttribute('data-action');
    var uid = el.getAttribute('data-member-id');
    switch (action) {
      case 'member-events':
        e.preventDefault();
        showUserEvents(uid);
        break;
      case 'member-photos':
        e.preventDefault();
        showUserPhotos(uid);
        break;
      case 'member-edit-profile':
        e.preventDefault();
        closeModal('memberModal');
        switchTab('me');
        break;
      case 'member-notes':
        openMemberNotes(uid, el.getAttribute('data-member-name') || '');
        break;
      case 'member-report':
        reportUser(uid, el.getAttribute('data-member-name') || '');
        break;
      case 'member-profile':
        e.preventDefault();
        closeModal('memberModal');
        if (typeof goToProfile === 'function') goToProfile(uid);
        break;
      case 'member-follow':
        e.preventDefault();
        memberFollow(uid, true, false);
        break;
      case 'member-unfollow':
        e.preventDefault();
        memberFollow(uid, false, el.getAttribute('data-mutual') === '1');
        break;
      case 'close-notes':
        closeModal('memberNotesModal');
        break;
      case 'note-color':
        selectNoteColor(el.getAttribute('data-color'), el);
        break;
      case 'note-delete':
        deleteMemberNote();
        break;
      case 'note-save':
        saveMemberNote();
        break;
      case 'close-report':
        closeModal('reportUserModal');
        break;
      case 'report-submit':
        submitUserReport();
        break;
      case 'mod-approve':
        resolveModeration(el.getAttribute('data-mod-id'), 'approve');
        break;
      case 'mod-reject':
        resolveModeration(el.getAttribute('data-mod-id'), 'reject');
        break;
      case 'mod-revert':
        revertModeration(el.getAttribute('data-mod-id'));
        break;
      case 'mod-page':
        loadModerationQueue(null, parseInt(el.getAttribute('data-value'), 10) || 1);
        break;
      case 'vrc-goto-collections':
        window.__vrcPendingView = 'collections';
        if (typeof switchTab === 'function') switchTab('vrc');
        break;
      case 'avatar-detail':
        openAvatarDetail(
          el.getAttribute('data-vrc-id') || '',
          el.getAttribute('data-avatar-id') || '',
          el.getAttribute('data-name') || '',
          parseInt(el.getAttribute('data-uid'), 10) || 0,
          el.getAttribute('data-avatar-src') || ''
        );
        break;
      case 'copy-vrc-name':
        copyVrcName(el);
        break;
      case 'vrc-friend':
        vrcSendFriendRequest(el.getAttribute('data-vrc-id') || '', el);
        break;
      case 'vrc-invite':
        vrcSendInvite(el.getAttribute('data-vrc-id') || '', el.getAttribute('data-location') || '', el);
        break;
      case 'vrc-boop':
        vrcBoop(el.getAttribute('data-vrc-id') || '', el);
        break;
      case 'vrc-note':
        vrcEditNote(el.getAttribute('data-vrc-id') || '', el);
        break;
      case 'close-avatar-detail':
        closeModal('avatarDetailModal');
        break;
      case 'avatar-tags-clear':
        clearAvatarTags();
        break;
      case 'avatar-tags-save':
        saveAvatarTags();
        break;
      case 'avatar-fav':
        favoriteAvatar();
        break;
    }
  };
  document.addEventListener('click', _membersDelegationHandler);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _bindMembersDelegation);
} else {
  _bindMembersDelegation();
}
