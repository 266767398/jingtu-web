// ==================== UI 更新 ====================
function updateUserUI() {
  // 加载 Hero 统计数据
  loadHeroStats();
  if (!currentUser) return;
  const avatarType = currentUser.avatarType || currentUser.avatar_type || 'custom';
  const avatarUrl = avatarType === 'none' ? null : (currentUser.avatarUrl || currentUser.vrchatAvatarUrl || null);
  // 顶部导航栏
  const avatar = document.getElementById('headerUserAvatar');
  const name = document.getElementById('headerUserName');
  if (avatar) avatar.src = avatarUrl || '/api/avatar/default';
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
  if (profileAvatar) profileAvatar.src = avatarUrl || '/api/avatar/default';
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
      vrcStatus.innerHTML = `<div class="d-flex items-center gap-6"><span class="text-green">🟢 ` + __('profile.vrc_bind') + `</span><span class="text-muted">${esc(currentUser.vrchatName || currentUser.vrchatId)}</span>${vBadge}<button class="btn btn-sm btn-outline ml-auto" onclick="unbindVRChat()">` + __('profile.vrc_unbind') + `</button></div>`;
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
  // 管理操作栏（公告/活动/VRC同步按钮）
  const annoBar = document.getElementById('annoAdminBar');
  const evtBar = document.getElementById('evtAdminBar');
  if (annoBar) annoBar.classList.toggle('d-none', !isAdmin);
  if (evtBar) evtBar.classList.toggle('d-none', !isAdmin);
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
      const heroMembers = document.getElementById('heroMembers');
      const heroPhotos = document.getElementById('heroPhotos');
      if (heroMembers) { heroMembers.textContent = d.totalUsers ?? '-'; heroMembers.classList.remove('skeleton-stat'); }
      if (heroPhotos) { heroPhotos.textContent = d.totalPhotos ?? '-'; heroPhotos.classList.remove('skeleton-stat'); }
      // 加载 Hero 全部配置
      const heroTitle = document.getElementById('heroTitle');
      const heroSubtitle = document.getElementById('heroSubtitle');
      const heroDescription = document.getElementById('heroDescription');
      const heroBg = document.getElementById('heroImg');
      const heroSection = document.getElementById('heroSection');
      const heroGradient = document.getElementById('heroGradientOverlay');
      const heroBadge = document.getElementById('heroBadge');
      const heroStatsContainer = document.querySelector('.hero-stats');
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

function switchTab(tab) {
  if (activeTab === tab) return;
  activeTab = tab;
  document.querySelectorAll('.tab').forEach(btn => btn.classList.toggle('active', btn.id === 'tab-btn-' + tab));
  document.querySelectorAll('.tab-content').forEach(content => content.classList.toggle('d-none', content.id !== 'tab-' + tab));
  // 页面标题随 Tab 切换（国际化）
  const tabTitleKeys = { 'home': 'nav.home', 'members': 'nav.members', 'group': 'nav.group', 'announcements': 'nav.announcements', 'events': 'nav.events', 'album': 'nav.album', 'map': 'nav.map', 'chat': 'nav.chat', 'birthday': 'nav.birthday', 'admin': 'nav.admin', 'me': 'nav.me', 'profile-user': 'nav.profile', 'posts': 'nav.posts' };
  document.title = `${__('page_title_prefix')} - ${__(tabTitleKeys[tab] || 'nav.home')}`;
  // Tab 内容入场动画：先重置动画再触发
  const contentEl = document.getElementById('tab-' + tab);
  if (contentEl) {
    contentEl.style.animation = 'none';
    requestAnimationFrame(() => requestAnimationFrame(() => { contentEl.style.animation = ''; }));
  }
  if (tab === 'home') loadHome();
  else if (tab === 'members') loadMembers();
  else if (tab === 'group') loadGroupMembers();
  else if (tab === 'announcements') { loadAnnouncements(); markAnnoSeen(); }
  else if (tab === 'events') { loadEvents(currentEvtStatus); markEvtSeen(); }
  else if (tab === 'album') loadAlbum();
  else if (tab === 'map') initMap();
  else if (tab === 'chat') loadChatConversations(true);
  else if (tab === 'birthday') { loadBirthdays(); loadBirthdayParties(); }
  else if (tab === 'posts') loadPosts();
  else if (tab === 'admin') { loadAdminStats(); checkSystemVrcStatus(); loadUsersAdmin(); updateNameReviewPreview(); loadPermissions(); loadPermGroups(); loadOperLog(); loadSystemConfig(); bindHeroPreviewEvents(); }
  else if (tab === 'me') showProfile();
  else if (tab === 'profile-user' && currentUser) loadUserProfile(currentUser.id);
}

// ==================== 用户菜单 ====================
function toggleUserMenu() {
  const menu = document.getElementById('userDropdown');
  if (menu) menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
}
function hideUserMenu() { const menu = document.getElementById('userDropdown'); if (menu) menu.style.display = 'none'; }

// ==================== 通知面板 ====================
async function loadNotifications() {
  const list = document.getElementById('notificationList') || document.querySelector('#notificationPanel .notification-list');
  if (list) list.innerHTML = '<div class="skeleton-card-list" style="margin:4px 8px"></div><div class="skeleton-card-list" style="margin:4px 8px"></div><div class="skeleton-card-list" style="margin:4px 8px"></div>';
  try {
    const res = await api('/api/notifications', { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      const notifs = data.notifications || [];
      const unread = data.unread || 0;
      // 更新铃铛徽章
      const badge = document.getElementById('bellBadge');
      if (badge) {
        if (unread > 0) {
          badge.textContent = unread > 99 ? '99+' : String(unread);
          badge.classList.remove('d-none');
        } else {
          badge.classList.add('d-none');
        }
      }
      // 渲染通知列表
      const list = document.getElementById('notificationList') || document.querySelector('#notificationPanel .notification-list');
      if (list) {
        if (notifs.length === 0) {
          list.innerHTML = '<div class="notification-empty">${__('ui.no_notifications')}</div>';
        } else {
          list.innerHTML = notifs.map(n => `
            <div class="notification-item ${n.isRead ? '' : 'unread'}">
              <div class="ni-main" onclick="markNotificationRead('${escJsStr(String(n.id))}')">
                <div class="ni-icon">${getNotifIcon(n.type)}</div>
                <div class="ni-body">
                  <div class="ni-title">${esc(n.title)}</div>
                  <div class="ni-desc">${esc(n.message || '')}</div>
                  <div class="ni-time">${fmtDate(n.createdAt)}</div>
                </div>
                ${n.isRead ? '' : '<div class="ni-dot"></div>'}
              </div>
              <button class="ni-del" onclick="event.stopPropagation();deleteNotification('${escJsStr(String(n.id))}')" title="${__('ui.delete')}">✕</button>
            </div>
          `).join('');
        }
      }
    }
  } catch { const list = document.getElementById('notificationList') || document.querySelector('#notificationPanel .notification-list'); if (list) list.innerHTML = '<div class="notification-empty">${__('ui.load_failed')}</div>'; }
}

function getNotifIcon(type) {
  const icons = {
    'name_change_approved': '✅',
    'name_change_rejected': '❌',
    'event_reminder': '📅',
    'system': '🔔',
    'comment': '💬',
    'like': '❤️',
    'announcement': '📢'
  };
  return icons[type] || '🔔';
}

function toggleNotificationPanel() {
  const panel = document.getElementById('notificationPanel');
  if (panel) {
    const wasHidden = !panel.classList.contains('show');
    panel.classList.toggle('show');
    if (wasHidden) loadNotifications();
  }
}

async function markNotificationRead(id) {
  try {
    await api(`/api/notifications/${id}/read`, { method: 'POST' });
    loadNotifications();
  } catch { /* 静默失败，用户可以点击重试 */ }
}

async function markAllNotificationsRead() {
  try {
    const res = await api('/api/notifications/read-all', { method: 'POST' });
    if (res.ok) { toast(__('ui.all_read'), 'success'); loadNotifications(); }
  } catch { toast(__('ui.op_failed'), 'error'); }
}

async function deleteNotification(id) {
  try {
    const res = await api(`/api/notifications/${id}`, { method: 'DELETE' });
    if (res.ok) { loadNotifications(); }
  } catch { toast(__('ui.delete_failed'), 'error'); }
}

async function clearAllNotifications() {
  showConfirm(__('ui.confirm_clear_notifications'), async () => {
    try {
      const res = await api('/api/notifications', { method: 'DELETE' });
      if (res.ok) { toast(__('ui.notifications_cleared'), 'info'); loadNotifications(); }
    } catch { toast(__('ui.op_failed'), 'error'); }
  });
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
