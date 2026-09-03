let liveCache = { streams: [], myStreams: [], currentStream: null };
let liveLoading = false;
let liveCommentTimer = null;

async function loadLiveStreams() {
  const container = document.getElementById('liveList');
  if (!container) return;
  showSkeleton(container, 'grid', 4);
  if (liveLoading) return;
  liveLoading = true;
  try {
    const [liveRes, endedRes] = await Promise.all([
      api('/api/live?status=live&pageSize=12'),
      api('/api/live?status=ended&pageSize=6')
    ]);
    if (liveRes.ok) {
      const data = await liveRes.json();
      liveCache.streams = data.streams || [];
    }
    if (endedRes.ok) {
      const data = await endedRes.json();
      liveCache.endedStreams = data.streams || [];
    }
    renderLivePage();
  } catch (err) {
    if (err && typeof isApiHandledError === 'function' && isApiHandledError(err)) return;
    toast(__('live.load_failed'), 'error');
  } finally {
    liveLoading = false;
  }
}

function renderLivePage() {
  const container = document.getElementById('liveList');
  if (!container) return;

  const liveNow = liveCache.streams || [];
  const ended = liveCache.endedStreams || [];

  if (liveNow.length === 0 && ended.length === 0) {
    renderEmpty(container, {
      icon: '📺',
      text: __('live.no_streams'),
      actions: [{ label: __('live.create_first'), variant: 'accent', onClick: openCreateLiveModal }]
    });
    return;
  }

  let html = '';

  if (liveNow.length > 0) {
    html += '<div class="live-section-header"><span class="live-live-dot"></span> ' + __('live.live_now') + '</div>';
    html += '<div class="live-grid">';
    html += liveNow.map(s => renderLiveCard(s, true)).join('');
    html += '</div>';
  }

  if (ended.length > 0) {
    html += '<div class="live-section-header" style="margin-top:24px">' + __('live.ended') + '</div>';
    html += '<div class="live-grid">';
    html += ended.map(s => renderLiveCard(s, false)).join('');
    html += '</div>';
  }

  container.innerHTML = html;
}

function renderLiveCard(s, isLive) {
  const thumb = s.thumbnailUrl || '';
  const avatar = s.userAvatar || '/api/avatar/default';
  const statusBadge = isLive
    ? '<span class="live-badge live">' + __('live.live_now') + '</span>'
    : '<span class="live-badge ended">' + __('live.ended_short') + '</span>';

  return `
    <div class="live-card" onclick="openLivePlayer(${s.id})">
      <div class="live-thumb">
        ${thumb ? `<img src="${esc(thumb)}" alt="" loading="lazy"/>` : '<div class="live-thumb-placeholder">📺</div>'}
        ${statusBadge}
        <span class="live-viewers">👁 ${s.viewerCount || 0}</span>
      </div>
      <div class="live-info">
        <div class="live-title">${esc(s.title)}</div>
        <div class="live-meta">
          <img src="${esc(avatar)}" class="live-avatar" alt=""/>
          <span>${esc(s.userName)}</span>
          <span class="live-created">${fmtDate(s.createdAt)}</span>
        </div>
      </div>
    </div>
  `;
}

async function openLivePlayer(streamId) {
  try {
    const res = await api(`/api/live/${streamId}`);
    if (!res.ok) { toast(__('live.not_found'), 'error'); return; }
    const s = await res.json();
    liveCache.currentStream = s;

    const modal = ensureModal('livePlayerModal', __('live.watching'));
    modal.innerHTML = `
      <div class="live-player-container">
        <div class="live-player-video">
          ${s.status === 'live'
            ? `<video id="liveVideoPlayer" src="${esc(s.streamUrl)}" controls autoplay></video>`
            : `<div class="live-player-ended">
                 <div class="live-ended-icon">📺</div>
                 <div>${__('live.broadcast_ended')}</div>
               </div>`
          }
          <div class="live-player-overlay">
            <span class="live-badge ${s.status === 'live' ? 'live' : 'ended'}">${s.status === 'live' ? __('live.live_now') : __('live.ended_short')}</span>
            <span class="live-viewers-big">👁 ${s.viewerCount || 0}</span>
          </div>
        </div>
        <div class="live-player-info">
          <div class="live-player-title">${esc(s.title)}</div>
          <div class="live-player-meta">
            <img src="${esc(s.userAvatar)}" class="live-avatar" alt=""/>
            <span class="live-player-host">${esc(s.userName)}</span>
          </div>
          ${s.description ? `<div class="live-player-desc">${esc(s.description)}</div>` : ''}
          ${s.status === 'live' ? `
            <div class="live-player-actions">
              <button class="btn btn-sm btn-outline" onclick="sendLiveLike(${s.id})">❤️ <span id="liveLikeCount">0</span></button>
              <button class="btn btn-sm btn-outline" onclick="toggleLiveComments()">💬 ${__('live.comments')}</button>
              ${s.userId === currentUser?.id ? `<button class="btn btn-sm btn-danger" onclick="endLiveStream(${s.id})">⏹ ${__('live.end_broadcast')}</button>` : ''}
            </div>
          ` : ''}
        </div>
        <div class="live-comments-panel d-none" id="liveCommentsPanel">
          <div class="live-comments-header">💬 ${__('live.comments')}</div>
          <div class="live-comments-list" id="liveCommentsList"></div>
          ${s.status === 'live' ? `
            <div class="live-comments-input">
              <input type="text" id="liveCommentInput" placeholder="${__('live.type_comment')}" maxlength="200"/>
              <button class="btn btn-sm btn-accent" onclick="sendLiveComment(${s.id})">${__('live.send')}</button>
            </div>
          ` : ''}
        </div>
      </div>
    `;

    showModal('livePlayerModal');

    if (s.status === 'live') {
      enterLiveRoom(streamId);
      loadLiveComments(streamId);
      loadLiveLikeCount(streamId);
      startLiveCommentPolling(streamId);
    }
  } catch {
    toast(__('live.load_failed'), 'error');
  }
}

async function enterLiveRoom(streamId) {
  try {
    await api(`/api/live/${streamId}/enter`, { method: 'POST' });
  } catch {}
}

async function leaveLiveRoom(streamId) {
  try {
    await api(`/api/live/${streamId}/leave`, { method: 'POST' });
  } catch {}
}

async function loadLiveComments(streamId) {
  try {
    const res = await api(`/api/live/${streamId}/comments?pageSize=50`);
    if (!res.ok) return;
    const data = await res.json();
    const list = document.getElementById('liveCommentsList');
    if (!list) return;
    // 无论接口返回顺序如何，统一按时间升序渲染，最新评论落在底部，符合聊天式阅读习惯
    const comments = (data.comments || []).slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const stickToBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
    const prevScroll = list.scrollTop;
    const prevHeight = list.scrollHeight;
    list.innerHTML = comments.map(c => `
      <div class="live-comment-item">
        <img src="${esc(c.userAvatar || '/api/avatar/default')}" class="live-comment-avatar" alt=""/>
        <div class="live-comment-body">
          <span class="live-comment-user">${esc(c.userName)}</span>
          <span class="live-comment-time">${fmtTime(c.createdAt)}</span>
          <div class="live-comment-text">${esc(c.content)}</div>
        </div>
      </div>
    `).join('');
    const newHeight = list.scrollHeight;
    // 用户停在底部时自动跟随最新；向上翻看历史时不强行拉回（视频/直播问题 8.x / 17）
    list.scrollTop = stickToBottom ? newHeight : prevScroll + (newHeight - prevHeight);
  } catch {}
}

async function sendLiveComment(streamId) {
  const input = document.getElementById('liveCommentInput');
  if (!input || !input.value.trim()) return;
  try {
    const res = await api(`/api/live/${streamId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: input.value.trim() })
    });
    if (res.ok) {
      input.value = '';
      loadLiveComments(streamId);
    } else {
      toast(__('live.comment_failed'), 'error');
    }
  } catch {
    toast(__('live.comment_failed'), 'error');
  }
}

async function loadLiveLikeCount(streamId) {
  try {
    const res = await api(`/api/live/${streamId}/likes`);
    if (res.ok) {
      const data = await res.json();
      const el = document.getElementById('liveLikeCount');
      if (el) el.textContent = data.likeCount || 0;
    }
  } catch {}
}

async function sendLiveLike(streamId) {
  try {
    const res = await api(`/api/live/${streamId}/like`, { method: 'POST' });
    if (res.ok) {
      const data = await res.json();
      const el = document.getElementById('liveLikeCount');
      if (el) el.textContent = data.likeCount || 0;
      toast(__('live.liked'), 'success');
    }
  } catch {}
}

function toggleLiveComments() {
  const panel = document.getElementById('liveCommentsPanel');
  if (panel) panel.classList.toggle('d-none');
}

function startLiveCommentPolling(streamId) {
  if (liveCommentTimer) clearInterval(liveCommentTimer);
  liveCommentTimer = setInterval(() => loadLiveComments(streamId), 5000);
}

function stopLiveCommentPolling() {
  if (liveCommentTimer) { clearInterval(liveCommentTimer); liveCommentTimer = null; }
}

async function endLiveStream(streamId) {
  if (!confirm(__('live.confirm_end'))) return;
  try {
    const res = await api(`/api/live/${streamId}/end`, { method: 'POST' });
    if (res.ok) {
      toast(__('live.ended_success'), 'success');
      hideModal('livePlayerModal');
      stopLiveCommentPolling();
      if (liveCache.currentStream) {
        leaveLiveRoom(liveCache.currentStream.id);
        liveCache.currentStream = null;
      }
      loadLiveStreams();
    } else {
      const data = await res.json();
      toast(data.error || __('live.end_failed'), 'error');
    }
  } catch {
    toast(__('live.end_failed'), 'error');
  }
}

function openCreateLiveModal() {
  const modal = ensureModal('createLiveModal', __('live.create_broadcast'));
  modal.innerHTML = `
    <div class="live-create-form">
      <div class="form-group">
        <label>${__('live.title_label')} *</label>
        <input type="text" id="liveTitle" maxlength="100" placeholder="${__('live.title_placeholder')}"/>
      </div>
      <div class="form-group">
        <label>${__('live.desc_label')}</label>
        <textarea id="liveDesc" rows="3" maxlength="500" placeholder="${__('live.desc_placeholder')}"></textarea>
      </div>
      <div class="form-group">
        <label>${__('live.thumbnail_label')}</label>
        <input type="file" id="liveThumbnail" accept="image/*"/>
      </div>
      <div class="form-group">
        <label><input type="checkbox" id="livePublic" checked/> ${__('live.public_label')}</label>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-outline" onclick="hideModal('createLiveModal')">${__('ui.cancel')}</button>
        <button class="btn btn-accent" onclick="submitCreateLive()">${__('live.create_and_go_live')}</button>
      </div>
    </div>
  `;
  showModal('createLiveModal');
}

async function submitCreateLive() {
  const title = document.getElementById('liveTitle')?.value.trim();
  if (!title) { toast(__('live.title_required'), 'error'); return; }

  const desc = document.getElementById('liveDesc')?.value.trim() || '';
  const isPublic = document.getElementById('livePublic')?.checked !== false;
  const thumbnail = document.getElementById('liveThumbnail')?.files?.[0];

  const formData = new FormData();
  formData.append('title', title);
  formData.append('description', desc);
  formData.append('isPublic', isPublic ? 'true' : 'false');
  if (thumbnail) formData.append('thumbnail', thumbnail);

  try {
    const res = await apiForm('/api/live', formData);
    if (res.ok) {
      const data = await res.json();
      hideModal('createLiveModal');
      toast(__('live.created'), 'success');

      if (data.rtmpUrl) {
        const streamModal = ensureModal('liveStreamKeyModal', __('live.stream_ready'));
        // OBS 的「设置 → 直播」有两个独立输入框：服务器 + 推流码。
        // 以前这里只给一个 `/live/rtmp/4` 的站内相对路径，OBS 根本无法使用。
        streamModal.innerHTML = `
          <div class="live-stream-info">
            <div class="live-stream-url-row">
              <span class="live-stream-label">${__('live.obs_server')}</span>
              <code id="liveRtmpServer">${esc(data.rtmpUrl)}</code>
              <button class="btn btn-sm btn-outline" data-copy-target="liveRtmpServer">${__('live.copy')}</button>
            </div>
            <div class="live-stream-url-row">
              <span class="live-stream-label">${__('live.obs_key')}</span>
              <code id="liveStreamKey">${esc(data.streamKey || '')}</code>
              <button class="btn btn-sm btn-outline" data-copy-target="liveStreamKey">${__('live.copy')}</button>
            </div>
            <div class="live-stream-url-row">
              <span class="live-stream-label">${__('live.playback_url')}</span>
              <code id="liveHlsUrl">${esc(data.streamUrl)}</code>
              <button class="btn btn-sm btn-outline" data-copy-target="liveHlsUrl">${__('live.copy')}</button>
            </div>
            <p class="live-stream-hint">${__('live.stream_hint')}</p>
            <div class="form-actions">
              <button class="btn btn-accent" id="liveStartBtn">${__('live.start_broadcast')}</button>
            </div>
          </div>
        `;
        // 用事件委托代替 onclick 内联字符串：推流码含随机字符，直接拼进 onclick 属性
        // 一旦出现引号就会破坏 HTML 并让按钮失效。
        streamModal.querySelectorAll('[data-copy-target]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            const el = document.getElementById(btn.dataset.copyTarget);
            if (el) copyLiveStreamKey(el.textContent);
          });
        });
        const startBtn = streamModal.querySelector('#liveStartBtn');
        if (startBtn) startBtn.addEventListener('click', function () { startLiveStream(data.streamId); });
        showModal('liveStreamKeyModal');
      }
    } else {
      const data = await res.json();
      toast(data.error || __('live.create_failed'), 'error');
    }
  } catch {
    toast(__('live.create_failed'), 'error');
  }
}

async function startLiveStream(streamId) {
  try {
    const res = await api(`/api/live/${streamId}/start`, { method: 'POST' });
    if (res.ok) {
      hideModal('liveStreamKeyModal');
      toast(__('live.started'), 'success');
      openLivePlayer(streamId);
      loadLiveStreams();
    } else {
      const data = await res.json();
      toast(data.error || __('live.start_failed'), 'error');
    }
  } catch {
    toast(__('live.start_failed'), 'error');
  }
}

function copyLiveStreamKey(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => toast(__('live.copied'), 'success'));
  } else {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast(__('live.copied'), 'success'); } catch {}
    document.body.removeChild(ta);
  }
}

function cleanupLiveOnModalClose() {
  if (liveCache.currentStream) {
    leaveLiveRoom(liveCache.currentStream.id);
    liveCache.currentStream = null;
  }
  stopLiveCommentPolling();
}

document.addEventListener('DOMContentLoaded', () => {
  const closeBtn = document.querySelector('[data-modal-close="livePlayerModal"]');
  if (closeBtn) closeBtn.addEventListener('click', cleanupLiveOnModalClose);
});