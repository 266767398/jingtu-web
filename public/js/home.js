// ==================== 首页模块 (Home Tab) ====================
// V1.0 — 显示快捷入口、即将开始的活动、最新动态

async function loadHome() {
  // 更新欢迎语
  updateGreeting();

  // 加载即将开始的活动
  loadHomeUpcomingEvents();

  // 加载最新动态
  loadHomeLatestPosts();
}

function updateGreeting() {
  const el = document.getElementById('homeGreeting');
  if (!el) return;
  const hour = new Date().getHours();
  let greeting = '';
  if (hour < 6) greeting = __('home.greeting_night');
  else if (hour < 12) greeting = __('home.greeting_morning');
  else if (hour < 14) greeting = __('home.greeting_noon');
  else if (hour < 18) greeting = __('home.greeting_afternoon');
  else greeting = __('home.greeting_evening');
  el.textContent = greeting;
}

async function loadHomeUpcomingEvents() {
  const container = document.getElementById('homeUpcomingEvents');
  if (!container) return;
  container.innerHTML = '<div class="skeleton-card"></div><div class="skeleton-card"></div>';
  try {
    const res = await api('/api/events', { method: 'GET' });
    if (!res.ok) { container.innerHTML = '<p class="text-muted2">' + __('load_failed') + '</p>'; return; }
    const data = await res.json();
    const events = (data.events || data || []).slice(0, 3);
    if (events.length === 0) {
      container.innerHTML = `<div class="welcome-card" style="grid-column:1/-1"><p class="text-muted2" data-i18n="home.no_upcoming">${__('home.no_upcoming')}</p></div>`;
      return;
    }
    container.innerHTML = events.map(e => {
      const isPast = new Date(e.eventTime || e.event_time) < new Date();
      const signedCount = e.signedCount ?? e.signed_count ?? 0;
      const maxCount = e.maxParticipants ?? e.max_participants ?? 0;
      const statusBadge = isPast
        ? `<span class="event-countdown past">${__('events.past')}</span>`
        : `<span class="event-countdown upcoming">${__('events.upcoming')}</span>`;
      return `<div class="event-card" onclick="switchTab('events')" style="cursor:pointer">
        <div class="event-time">📅 ${fmtDate(e.eventTime || e.event_time)}</div>
        <div style="font-weight:700;font-size:15px;margin-bottom:4px">${esc(e.title || e.event_title || '')}</div>
        <div class="flex-row gap-6 items-center">
          ${statusBadge}
          ${maxCount > 0 ? `<span class="sign-count">👥 ${signedCount}/${maxCount}</span>` : `<span class="sign-count">👥 ${signedCount}</span>`}
        </div>
        ${e.place ? `<div class="event-place">📍 ${esc(e.place)}</div>` : ''}
      </div>`;
    }).join('');
  } catch {
    container.innerHTML = '<p class="text-muted2">' + __('load_failed') + '</p>';
  }
}

async function loadHomeLatestPosts() {
  const container = document.getElementById('homeLatestPosts');
  if (!container) return;
  try {
    const res = await api('/api/posts?limit=3', { method: 'GET' });
    if (!res.ok) { container.innerHTML = ''; return; }
    const data = await res.json();
    const posts = data.posts || data || [];
    if (posts.length === 0) {
      container.innerHTML = `<p class="text-muted2" data-i18n="posts.empty">${__('posts.empty')}</p>`;
      return;
    }
    container.innerHTML = posts.map(p => {
      const avatar = p.avatarUrl || p.authorAvatar || '';
      const name = esc(p.authorName || p.author_name || __('unknown_user'));
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
  } catch {}
}
