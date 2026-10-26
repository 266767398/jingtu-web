// ==================== 用户资料展示页 V6.7 ====================

let profileUser = null;
let profileAlbums = [];
let profileVideos = [];
let profileCurrentAlbumId = null;
let profilePageMode = 'view'; // 'view' | 'album'
// M5: 资料加载请求序号：每次加载递增，过期响应（含失败）直接丢弃，避免快速连点串台
let _profileLoadSeq = 0;
// albumPhotoList 和 currentPhotoIdx 定义在 core.js 中，此处直接使用全局变量

// ==================== 加载用户资料 ====================
async function loadUserProfile(userId) {
  // data-uid / dataset 等入口传的是字符串，统一转数字，保证下方 isOwner 严格比较（currentUser.id === userId）可靠
  userId = Number(userId);
  if (!userId) { toast(__('profile_page.invalid_id'), 'error'); return; }
  const container = document.getElementById('tab-profile-user');
  if (!container) return;
  const my = ++_profileLoadSeq;

  // 记录来源标签页，供资料页「返回」按钮回到原页面
  const activeContent = document.querySelector('.tab-content:not(.d-none)');
  window._profileReturnTab = activeContent ? activeContent.id.replace(/^tab-/, '') : 'members';

  // 切换到资料标签
  switchTabSilent('profile-user');
  profilePageMode = 'view';
  profileUser = null;

  // 显示加载状态
  document.getElementById('profileAlbums').innerHTML = '<div class="text-muted text-center-sm p-16">' + __('profile_page.loading') + '</div>';
  document.getElementById('profileVideos').innerHTML = '<div class="text-muted text-center-sm p-16">' + __('profile_page.loading') + '</div>';

  try {
    const res = await api(`/api/profile/${userId}`, { method: 'GET' });
    if (my !== _profileLoadSeq) return; // 期间又发起新加载，丢弃过期响应
    if (!res.ok) {
      if (res.status === 404) { toast(__('profile_page.not_found'), 'error'); return; }
      throw new Error('LOAD_FAILED');
    }
    const data = await res.json();
    if (my !== _profileLoadSeq) return; // 解析期间又发起新加载，同样丢弃
    profileUser = data.user ? { ...data.user, ...(data.profile || {}) } : data;
    profileAlbums = data.albums || [];
    profileVideos = data.videos || [];

    const isOwner = currentUser && currentUser.id === userId;
    renderProfileHeader(profileUser, isOwner);
    // 完整资料页背景 = 被查看用户的整站背景图（含他人），带可读遮罩；空则恢复默认
    applyProfileBg(profileUser);
    const profileUserIdEl = document.getElementById('profileUserId');
    if (profileUserIdEl) profileUserIdEl.value = userId;
    renderAlbums(profileAlbums, isOwner);
    renderVideos(profileVideos, isOwner);
  } catch (err) {
    if (my !== _profileLoadSeq) return; // 过期请求的失败不回写 UI
    if (isApiHandledError(err)) return;
    toast(__('profile.load_failed'), 'error');
    document.getElementById('profileAlbums').innerHTML = '<div class="text-muted text-center-sm p-16">' + __('profile_page.load_failed') + '</div>';
    document.getElementById('profileVideos').innerHTML = '<div class="text-muted text-center-sm p-16">' + __('profile_page.load_failed') + '</div>';
  }
}

// ==================== 静默切换标签（不触发重复加载） ====================
function switchTabSilent(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab').forEach(btn => btn.classList.toggle('active', btn.id === 'tab-btn-' + tab));
  document.querySelectorAll('.tab-content').forEach(content => content.classList.toggle('d-none', content.id !== 'tab-' + tab));
  // L1: 同步移动端底部导航高亮，与 ui.js switchTab 的高亮逻辑保持一致
  document.querySelectorAll('.mobile-tab-bar-item').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tab));
  document.title = __('app.title') + ' - ' + __('profile_page.user_profile');
}

// ==================== 完整资料页背景（被查看用户的自定义整站背景） ====================
// 进入任意成员（含自己）的完整资料页时，展示该成员的 backgroundImage；
// 叠一层卡片色半透明遮罩，保证深浅主题下正文可读。
function applyProfileBg(user) {
  const tab = document.getElementById('tab-profile-user');
  if (!tab) return;
  const bg = user && user.backgroundImage ? user.backgroundImage : '';
  if (bg) {
    tab.style.backgroundImage =
      `linear-gradient(color-mix(in srgb, var(--bg) 84%, transparent), color-mix(in srgb, var(--bg) 84%, transparent)), url(${escCssUrl(bg)})`;
    tab.style.backgroundSize = 'cover';
    tab.style.backgroundPosition = 'center';
    tab.style.backgroundRepeat = 'no-repeat';
    tab.style.backgroundAttachment = 'fixed';
    // 图片失效时回退默认（避免整页破图底色）
    const probe = new Image();
    probe.onerror = function () {
      tab.style.backgroundImage = '';
      tab.style.backgroundSize = '';
      tab.style.backgroundAttachment = '';
    };
    probe.src = bg;
  } else {
    tab.style.backgroundImage = '';
    tab.style.backgroundSize = '';
    tab.style.backgroundPosition = '';
    tab.style.backgroundRepeat = '';
    tab.style.backgroundAttachment = '';
  }
}

// ==================== 渲染资料头部 ====================
function renderProfileHeader(user, isOwner) {
  // 封面区工具按钮（仅本人）：更换横幅 / 更换头像
  const coverTools = document.getElementById('profileCoverTools');
  if (coverTools) coverTools.classList.toggle('d-none', !isOwner);

  // 封面（CSS 背景图：立即设置 + Image 预探失败时回退默认封面，与头像默认资源兜底语义一致）
  const coverBg = document.getElementById('profileCoverBg');
  const coverImg = user.coverImage || user.preferences?.coverImage || '';
  if (coverBg) {
    // V6.10: coverPosition 控制封面显示位置（top/center/bottom），适配不同尺寸的照片区域
    const pos = (user.coverPosition === 'top' || user.coverPosition === 'bottom') ? user.coverPosition : 'center';
    coverBg.style.backgroundPosition = pos;
    if (coverImg) {
      coverBg.style.backgroundImage = `url(${escCssUrl(coverImg)})`;
      const probe = new Image();
      probe.onerror = function() { coverBg.style.backgroundImage = 'url(/assets/group-banner.png)'; };
      probe.src = coverImg;
    } else {
      coverBg.style.backgroundImage = '';
    }
  }

  // 头像
  const avatar = document.getElementById('profileAvatar');
  if (avatar) {
    avatar.src = user.avatarUrl || user.vrchatAvatarUrl || '/api/avatar/default';
    avatar.alt = user.displayName || user.loginId || '';
    avatar.onerror = function() { window.__avatarFail && window.__avatarFail(this, user.avatarUrl || user.vrchatAvatarUrl || '/api/avatar/default'); };
  }

  // 显示名
  const nameEl = document.getElementById('profileName');
  if (nameEl) {
    nameEl.textContent = user.displayName || user.loginId || __('profile_page.unknown_user');
    if (user.vrchatName) {
      const vrcName = document.createElement('span');
      vrcName.className = 'profile-vrc-name';
      vrcName.textContent = __('profile_page.vrc_name', { name: user.vrchatName });
      nameEl.appendChild(vrcName);
    }
  }

  // 角色徽章
  const roleEl = document.getElementById('profileRole');
  if (roleEl) {
    const role = user.role || 'member';
    const roleLabel = role === 'super_admin' ? __('members.role_super_admin')
      : role === 'admin' ? __('members.role_admin')
      : __('members.role_member');
    roleEl.textContent = roleLabel;
    roleEl.className = 'profile-role-badge role-' + role;
  }

  // VRChat 在线状态（在线 / 离线 / 游戏中 + 当前世界名）
  const presenceEl = document.getElementById('profilePresence');
  if (presenceEl) {
    const p = user.presence;
    if (p) {
      const state = p.online ? (p.inGame ? 'ingame' : 'online') : 'offline';
      let label;
      if (state === 'ingame') label = __('presence.in_game') + (p.world ? ' · ' + p.world : '');
      else if (state === 'online') label = __('presence.online');
      else label = __('presence.offline');
      if (p.description) label += ' · ' + p.description;
      presenceEl.className = 'profile-presence presence-' + state;
      presenceEl.innerHTML = '<span class="presence-dot"></span>' + esc(label);
      presenceEl.classList.remove('d-none');
      presenceEl.title = p.lastSeen ? __('presence.last_seen') + ': ' + fmtDate(p.lastSeen) : '';
    } else {
      presenceEl.classList.add('d-none');
      presenceEl.innerHTML = '';
    }
  }

  // 个性签名
  const mottoEl = document.getElementById('profileMotto');
  if (mottoEl) {
    mottoEl.textContent = user.motto || user.preferences?.motto || '';
  }

  // 自定义标签（后端已按隐私开关过滤：他人仅在 tags_visible 开启时返回）
  const tagsEl = document.getElementById('profileTags');
  if (tagsEl) {
    const tags = Array.isArray(user.selfTags) ? user.selfTags.slice(0, 8) : [];
    if (tags.length) {
      tagsEl.className = 'profile-tags';
      tagsEl.innerHTML = tags.map(t => `<span class="tag tag-accent">${esc(t)}</span>`).join('');
    } else {
      tagsEl.className = 'profile-tags d-none';
      tagsEl.innerHTML = '';
    }
  }

  // 统计数据（头部）
  const statsEl = document.getElementById('profileStats');
  if (statsEl) {
    const albumCount = profileAlbums.length;
    const photoCount = profileAlbums.reduce((sum, a) => sum + (a.photoCount || 0), 0);
    const videoCount = profileVideos.length;
    statsEl.innerHTML = `
      <div class="profile-stat">📷 <span>${__('profile_page.n_albums', {n: albumCount})}</span></div>
      <div class="profile-stat">🖼️ <span>${__('profile_page.n_photos', {n: photoCount})}</span></div>
      <div class="profile-stat">🎬 <span>${__('profile_page.n_videos', {n: videoCount})}</span></div>
    `;
    // 底部静态统计（原有占位，补齐真实数值）
    const photoCountEl = document.getElementById('profilePhotoCount');
    if (photoCountEl) photoCountEl.textContent = photoCount;
    const videoCountEl = document.getElementById('profileVideoCount');
    if (videoCountEl) videoCountEl.textContent = videoCount;
  }

  // 详细信息：生日/所在地/网站/社交链接（隐私墙在后端已过滤，null 则不展示）
  renderProfileDetails(user, isOwner);

  // 操作按钮
  const actionsEl = document.getElementById('profileActions');
  if (actionsEl) {
    let html = '';
    if (isOwner) {
      html += '<button class="btn btn-sm btn-accent" data-action="profile-edit">' + __('profile_page.edit_profile') + '</button>';
      html += '<button class="btn btn-sm btn-outline" data-action="profile-new-album">' + __('profile_page.new_album') + '</button>';
      html += '<button class="btn btn-sm btn-outline" data-action="profile-upload-video">' + __('profile_page.upload_video') + '</button>';
      html += '<button class="btn btn-sm btn-outline" data-action="profile-export">💾 ' + __('profile_page.data_export') + '</button>';
    }
    if (!isOwner && currentUser) {
      html += '<button class="btn btn-sm btn-accent" id="profileLikeBtn" data-action="profile-like">❤️ <span id="profileLikeCount">0</span></button>';
      // 关注/互关按钮：与成员名片同款逻辑（refreshFollowBtn 异步填充）
      html += '<span id="profileFollowBtn" data-uid="' + escAttr(String(user.id)) + '"></span>';
      // 直接发私信：一键进入聊天私信
      html += '<button class="btn btn-sm btn-outline" data-action="profile-dm" data-uid="' + escAttr(String(user.id)) + '">💬 ' + __('profile_page.send_msg') + '</button>';
      html += '<span id="profileLikeStatus" class="text-13 text-muted ml-2"></span>';
    }
    if (user.vrchatId) {
      html += `<a class="btn btn-sm btn-outline" href="https://vrchat.com/home/user/${esc(user.vrchatId)}" target="_blank" rel="noopener">${__('profile_page.vrc_home')}</a>`;
    }
    actionsEl.innerHTML = html;
    // 拉取关注状态并填充关注按钮（与成员名片共用 refreshFollowBtn）
    if (!isOwner && currentUser && typeof refreshFollowBtn === 'function') {
      refreshFollowBtn('profileFollowBtn', user.id);
    }
    // 他人资料页：补充关注/粉丝计数（非本人且非好友会被隐私闸 403 拦截，静默跳过）
    if (!isOwner && currentUser) loadProfileFollowCounts(user.id);
  }

  // 加载点赞状态
  if (!isOwner && currentUser) {
    loadProfileLikeStats(user.id);
  }

  // 个人简介
  const bioCard = document.getElementById('profileBio');
  const bioContent = document.getElementById('profileBioContent');
  if (bioCard && bioContent) {
    if (user.bio) {
      bioCard.classList.remove('d-none');
      bioContent.textContent = user.bio;
    } else if (isOwner) {
      bioCard.classList.remove('d-none');
      bioContent.innerHTML = '<span class="text-muted2">' + __('profile_page.bio_empty') + '</span>';
    } else {
      bioCard.classList.add('d-none');
    }
  }
}

// ==================== 渲染详细信息（生日/所在地/网站/社交链接） ====================
// 后端已按隐私过滤：生日仅本人/好友返回，所在地按 location_visible 返回，空值直接隐藏
function renderProfileDetails(user, isOwner) {
  const detailsEl = document.getElementById('profileDetails');
  if (!detailsEl) return;
  const chips = [];
  // 生日（仅本人/好友可见，后端已过滤为空）
  if (user.birthday) {
    chips.push('<span class="profile-detail-chip">🎂 ' + esc(user.birthday) + '</span>');
  }
  // 所在地
  if (user.location) {
    chips.push('<span class="profile-detail-chip">📍 ' + esc(user.location) + '</span>');
  }
  // 个人网站（URL scheme 校验：仅 http/https，防 javascript:/data: 存储型 XSS）
  if (user.website && safeHref(user.website)) {
    chips.push(`<span class="profile-detail-chip">🌐 <a href="${escAttr(user.website)}" target="_blank" rel="noopener">${esc(__('modal.website_label'))}</a></span>`);
  }
  // 社交链接（B站/微博/GitHub）
  const socialLinks = user.socialLinks || user.social_links || {};
  if (socialLinks && typeof socialLinks === 'object') {
    if (socialLinks.bilibili && safeHref(socialLinks.bilibili)) {
      chips.push(`<span class="profile-detail-chip">📺 <a href="${escAttr(socialLinks.bilibili)}" target="_blank" rel="noopener">B站</a></span>`);
    }
    if (socialLinks.weibo && safeHref(socialLinks.weibo)) {
      chips.push(`<span class="profile-detail-chip">📣 <a href="${escAttr(socialLinks.weibo)}" target="_blank" rel="noopener">微博</a></span>`);
    }
    if (socialLinks.github && safeHref(socialLinks.github)) {
      chips.push(`<span class="profile-detail-chip">🐙 <a href="${escAttr(socialLinks.github)}" target="_blank" rel="noopener">GitHub</a></span>`);
    }
  }
  if (chips.length) {
    detailsEl.innerHTML = chips.join('');
    detailsEl.classList.remove('d-none');
  } else {
    detailsEl.classList.add('d-none');
    detailsEl.innerHTML = '';
  }
}

// ==================== 渲染相册列表 ====================
function renderAlbums(albums, isOwner) {
  const container = document.getElementById('profileAlbums');
  const actionsEl = document.getElementById('albumActions');
  if (!container) return;

  if (actionsEl) {
    actionsEl.innerHTML = isOwner ? '<button class="btn btn-accent btn-sm" data-action="profile-new-album">' + __('profile_page.new_album_btn') + '</button>' : '';
  }

  if (!albums || albums.length === 0) {
    renderEmpty(container, {
      icon: '📷',
      text: isOwner ? __('profile_page.no_album') : __('profile_page.no_public_album'),
      actions: isOwner ? [{ label: __('profile_page.create_first_album'), onClick: showAlbumModal }] : []
    });
    return;
  }

  container.innerHTML = albums.map(album => {
    const cover = album.coverUrl || album.photos?.[0]?.url || album.coverPhoto || '';
    const name = esc(album.name || __('profile_page.unnamed_album'));
    const photoCount = album.photoCount || album.photos?.length || 0;
    const privacy = album.privacy || 'public';
    const privacyLabels = { 'public': __('profile_page.public'), 'members_only': __('profile_page.member'), 'private': __('profile_page.private') };
    // P2-131: 未知 privacy 值回退到安全文案与默认样式，不把原值拼入 HTML
    const privacyLabel = privacyLabels[privacy] || __('profile_page.private');
    const privacyClass = privacyLabels[privacy] ? privacy : 'private';

    return `
    <div class="profile-album-card" data-action="profile-open-album" data-album-id="${album.id}">
      ${imgWithFallback(cover || '/api/avatar/default', 'profile-album-cover', album.name || __('profile_page.unnamed_album'))}
      <div class="profile-album-info">
        <div class="profile-album-name">${name}</div>
        <div class="profile-album-meta">
          <span>${__('profile_page.n_files', {n: photoCount})}</span>
          <span class="privacy-badge ${privacyClass} ml-4">${privacyLabel}</span>
        </div>
      </div>
    </div>`;
  }).join('');
}

// ==================== 渲染视频列表 ====================
function renderVideos(videos, isOwner) {
  const container = document.getElementById('profileVideos');
  const actionsEl = document.getElementById('videoActions');
  if (!container) return;

  if (actionsEl) {
    actionsEl.innerHTML = isOwner ? '<button class="btn btn-accent btn-sm" data-action="profile-upload-video">' + __('profile_page.upload_video') + '</button>' : '';
  }

  if (!videos || videos.length === 0) {
    renderEmpty(container, {
      icon: '🎬',
      text: isOwner ? __('profile_page.no_video') : __('profile_page.no_public_video')
    });
    return;
  }

  container.innerHTML = videos.map(video => {
    const thumb = video.thumbnailUrl || '';
    const title = esc(video.title || __('profile_page.unnamed_video'));
    const duration = video.duration ? formatDuration(video.duration) : '';
    const date = video.createdAt ? fmtDate(video.createdAt) : '';
    const privacy = video.privacy || 'public';
    const privacyLabels = { 'public': __('profile_page.public'), 'members_only': __('profile_page.member'), 'private': __('profile_page.private') };
    // P2-131: 未知 privacy 值回退到安全文案与默认样式，不把原值拼入 HTML
    const privacyLabel = privacyLabels[privacy] || __('profile_page.private');
    const privacyClass = privacyLabels[privacy] ? privacy : 'private';

    return `
    <div class="profile-video-card" data-action="profile-open-video" data-video-id="${video.id}">
      <img class="profile-video-thumb" src="${escAttr(thumb)}" alt="${title}" loading="lazy">
      <div class="profile-video-thumb" style="display:${thumb ? 'none' : 'flex'};align-items:center;justify-content:center;background:var(--bg-muted);font-size:32px">▶️</div>
      <div class="profile-video-info">
        <div class="profile-video-title">${title}</div>
        <div class="profile-video-meta">
          ${duration ? '<span>⏱ ' + duration + '</span>' : ''}
          ${date ? '<span>📅 ' + date + '</span>' : ''}
          <span class="privacy-badge ${privacyClass}">${privacyLabel}</span>
        </div>
      </div>
    </div>`;
  }).join('');
}

function formatDuration(seconds) {
  if (!seconds) return '';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ==================== 打开相册查看照片/视频 ====================
let profileCurrentPhotos = []; // 当前相册的文件列表
let profileCurrentPhotoIdx = 0;

async function openAlbum(albumId) {
  const detail = document.getElementById('albumDetail');
  const photosGrid = document.getElementById('albumDetailGrid');
  const albumsSection = document.getElementById('profileAlbums');
  if (!detail || !photosGrid) return;

  profilePageMode = 'album';
  profileCurrentAlbumId = albumId;
  detail.classList.remove('d-none');

  // 隐藏相册列表和视频列表
  const albumsCard = albumsSection?.closest('.card');
  const videosCard = document.getElementById('profileVideos')?.closest('.card');
  if (albumsCard) albumsCard.classList.add('d-none');
  if (videosCard) videosCard.classList.add('d-none');

  // 设置相册名称
  const albumNameEl = document.getElementById('albumDetailName');
  const album = profileAlbums.find(a => a.id == albumId);
  if (albumNameEl && album) albumNameEl.textContent = album.name || __('profile_page.album');

  photosGrid.innerHTML = '<div class="text-muted text-center-sm p-16">' + __('profile_page.loading') + '</div>';

  try {
    const res = await api(`/api/profile/albums/${albumId}/photos`, { method: 'GET' });
    if (!res.ok) throw new Error('LOAD_FAILED');
    const data = await res.json();
    const photos = data.photos || [];

    profileCurrentPhotos = photos;

    if (photos.length === 0) {
      renderEmpty(photosGrid, { icon: '📷', text: __('profile_page.no_content') });
    } else {
      photosGrid.innerHTML = photos.map(photo => {
        const url = photo.photoPath || photo.imageUrl || '';
        const thumb = photo.thumbPath || url;
        const desc = photo.description || '';
        const isVideo = photo.mediaType === 'video';
        const vidHtml = isVideo
          ? '<div class="profile-photo-video-thumb"><span style="font-size:32px">🎬</span></div>'
          : imgWithFallback(thumb, '', desc);
        return '<div class="profile-photo-card" data-action="profile-view-media" data-photo-id="' + photo.id + '">'
          + vidHtml
          + (isVideo ? '<span class="album-media-badge" style="position:absolute;top:4px;right:4px;font-size:16px">🎬</span>' : '')
          + '</div>';
      }).join('');
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('profile_page.load_albums_failed'), 'error');
    photosGrid.innerHTML = '<div class="text-muted text-center-sm p-16">' + __('profile_page.load_failed') + '</div>';
  }
}

// ==================== 查看相册中的媒体文件（Lightbox 集成） ====================
function profileViewMedia(photoId) {
  const idx = profileCurrentPhotos.findIndex(p => String(p.id) === String(photoId));
  if (idx === -1) return;
  const photo = profileCurrentPhotos[idx];
  const isVideo = photo.mediaType === 'video';

  if (isVideo) {
    // 视频：弹窗播放
    showProfileVideoModal(photo.photoPath);
  } else {
    // 图片：使用独立的 profile photoList，不污染全局 albumPhotoList
    window._savedAlbumState = {
      photoList: albumPhotoList,
      photoIdx: currentPhotoIdx
    };
    // 只设置 lightbox 使用的临时数据
    albumPhotoList = profileCurrentPhotos.map(p => ({
      id: p.id,
      url: p.photoPath,
      thumbnail: p.thumbPath,
      caption: p.description,
      mediaType: 'image'
    }));
    currentPhotoIdx = idx;
    showLightbox(String(photoId));
    // 关闭 lightbox 后恢复相册数据
    const origClose = closeLightbox;
    if (origClose) {
      window._origCloseLightbox = origClose;
      window.closeLightbox = function() {
        if (window._savedAlbumState) {
          albumPhotoList = window._savedAlbumState.photoList;
          currentPhotoIdx = window._savedAlbumState.photoIdx;
          window._savedAlbumState = null;
        }
        window.closeLightbox = window._origCloseLightbox;
        window._origCloseLightbox = null;
        return origClose();
      };
    }
  }
}

function showProfileVideoModal(videoPath) {
  var overlay = document.createElement('div');
  overlay.className = 'video-overlay';
  overlay.innerHTML = '<video src="' + escAttr(videoPath) + '" controls autoplay></video><button class="modal-close" data-action="close-video-overlay">✕</button>';
  overlay.addEventListener('click', function(e) { if (e.target === overlay) window.closeProfileVideoOverlay(overlay); });
  document.body.appendChild(overlay);
}

// M2: 全局关闭视频弹层：先暂停播放再移除（供 main.js Escape 统一处理调用）
window.closeProfileVideoOverlay = function (overlay) {
  if (!overlay) return;
  var video = overlay.querySelector('video');
  if (video) video.pause();
  overlay.remove();
};

function backToAlbums() {
  profilePageMode = 'view';
  profileCurrentPhotos = [];
  profileCurrentPhotoIdx = 0;
  const detail = document.getElementById('albumDetail');
  if (detail) detail.classList.add('d-none');

  const albumsCard = document.getElementById('profileAlbums')?.closest('.card');
  const videosCard = document.getElementById('profileVideos')?.closest('.card');
  if (albumsCard) albumsCard.classList.remove('d-none');
  if (videosCard) videosCard.classList.remove('d-none');
}

// ==================== 打开视频（内联播放） ====================
function openVideo(videoId) {
  const video = profileVideos.find(v => v.id == videoId);
  if (!video) { toast(__('profile_page.video_not_found'), 'error'); return; }
  const url = video.videoPath || video.videoUrl || video.url;
  if (url) {
    showProfileVideoModal(url);
  } else {
    toast(__('profile_page.invalid_video_url'), 'error');
  }
}

// ==================== 编辑资料弹窗 ====================
function showEditProfileModal() {
  if (!profileUser) return;
  document.getElementById('editMotto').value = profileUser.motto || profileUser.preferences?.motto || '';
  document.getElementById('editBio').value = profileUser.bio || '';
  document.getElementById('editLocation').value = profileUser.location || '';
  document.getElementById('editWebsite').value = profileUser.website || profileUser.preferences?.website || '';
  document.getElementById('editCoverImage').value = profileUser.coverImage || profileUser.preferences?.coverImage || '';
  // 封面显示位置
  var coverPosEl = document.getElementById('editCoverPosition');
  if (coverPosEl) {
    var pos = profileUser.coverPosition || profileUser.preferences?.coverPosition;
    coverPosEl.value = (pos === 'top' || pos === 'bottom' || pos === 'center') ? pos : 'center';
  }
  // 封面预览
  updateCoverPreview(profileUser.coverImage || profileUser.preferences?.coverImage || '');
  // 生日
  var birthdayEl = document.getElementById('editBirthday');
  if (birthdayEl) birthdayEl.value = profileUser.birthday || '';
  // 头像预览
  var avatarPreview = document.getElementById('editAvatarPreview');
  if (avatarPreview) avatarPreview.src = profileUser.avatarUrl || '/api/avatar/default';
  // 社交链接
  var socialLinks = profileUser.preferences?.social_links || profileUser.socialLinks || {};
  var biliEl = document.getElementById('editSocialBilibili');
  if (biliEl) biliEl.value = socialLinks.bilibili || '';
  var weiboEl = document.getElementById('editSocialWeibo');
  if (weiboEl) weiboEl.value = socialLinks.weibo || '';
  var githubEl = document.getElementById('editSocialGithub');
  if (githubEl) githubEl.value = socialLinks.github || '';
  showModal('editProfileModal');
}

// 封面预览：有图显示缩略背景，无图显示"未设置"占位
function updateCoverPreview(url) {
  var preview = document.getElementById('editCoverPreview');
  if (!preview) return;
  if (url) {
    preview.style.backgroundImage = 'url(' + url.replace(/["'()\\]/g, c => '\\' + c) + ')';
    preview.style.backgroundSize = 'cover';
    preview.style.backgroundPosition = 'center';
    preview.innerHTML = '';
  } else {
    preview.style.backgroundImage = '';
    preview.innerHTML = '<span class="text-muted">' + __('modal.cover_none') + '</span>';
  }
}

/**
 * 上传封面
 */
async function uploadProfileCover(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) { toast(__('profile_page.select_image'), 'error'); return; }
  if (file.size > 10 * 1024 * 1024) { toast(__('profile_page.cover_too_large'), 'error'); return; }
  try {
    var formData = new FormData();
    formData.append('cover', file);
    var res = await apiForm('/api/users/me/cover', formData);
    if (res.ok) {
      var data = await res.json();
      toast(__('profile_page.cover_updated'), 'success');
      // 更新预览与 URL 输入框
      updateCoverPreview(data.coverUrl);
      var urlInput = document.getElementById('editCoverImage');
      if (urlInput) urlInput.value = data.coverUrl;
      // 同步完整资料页横幅与本地状态：上传后立即生效，无需再点保存
      if (profileUser) {
        profileUser.coverImage = data.coverUrl;
        if (!profileUser.preferences) profileUser.preferences = {};
        profileUser.preferences.coverImage = data.coverUrl;
        renderProfileHeader(profileUser, true);
      }
      if (currentUser) {
        if (!currentUser.preferences) currentUser.preferences = {};
        currentUser.preferences.coverImage = data.coverUrl;
      }
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('profile_page.cover_upload_failed'), 'error');
  }
}

/**
 * 上传头像
 */
async function uploadProfileAvatar(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) { toast(__('profile_page.select_image'), 'error'); return; }
  try {
    var formData = new FormData();
    formData.append('avatar', file);
    var res = await apiForm('/api/users/me/avatar', formData);
    if (res.ok) {
      var data = await res.json();
      toast(__('profile_page.avatar_updated'), 'success');
      // 更新预览
      var preview = document.getElementById('editAvatarPreview');
      if (preview) preview.src = data.avatarUrl;
      // 重新加载资料
      if (currentUser) loadUserProfile(currentUser.id);
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('profile_page.avatar_upload_failed'), 'error');
  }
}

async function saveEditProfile() {
  const motto = document.getElementById('editMotto')?.value?.trim();
  const bio = document.getElementById('editBio')?.value?.trim();
  const location = document.getElementById('editLocation')?.value?.trim();
  const website = document.getElementById('editWebsite')?.value?.trim();
  const coverImage = document.getElementById('editCoverImage')?.value?.trim();
  const coverPosition = document.getElementById('editCoverPosition')?.value;
  const birthday = document.getElementById('editBirthday')?.value?.trim() || null;
  const socialBilibili = document.getElementById('editSocialBilibili')?.value?.trim() || '';
  const socialWeibo = document.getElementById('editSocialWeibo')?.value?.trim() || '';
  const socialGithub = document.getElementById('editSocialGithub')?.value?.trim() || '';

  const body = {};
  if (motto !== undefined) { body.motto = motto; }
  if (bio !== undefined) { body.bio = bio; }
  if (location !== undefined) { body.location = location; }
  if (coverImage !== undefined) { body.coverImage = coverImage; }
  if (website !== undefined) { body.website = website; }
  if (birthday !== undefined) { body.birthday = birthday || null; }
  if (coverPosition !== undefined) {
    body.coverPosition = (coverPosition === 'top' || coverPosition === 'bottom') ? coverPosition : 'center';
  }
  // 社交链接（始终提交，清空输入时后端才能同步清空旧链接）
  const socialLinks = {};
  if (socialBilibili) socialLinks.bilibili = socialBilibili;
  if (socialWeibo) socialLinks.weibo = socialWeibo;
  if (socialGithub) socialLinks.github = socialGithub;
  body.socialLinks = socialLinks;

  if (Object.keys(body).length === 0) { toast(__('profile_page.nothing_to_update'), 'info'); return; }

  try {
    const res = await api('/api/users/me/profile', { method: 'PUT', body });
    if (res.ok) {
      toast(__('profile_page.profile_updated'), 'success');
      // 更新本地缓存
      if (motto !== undefined) { profileUser.motto = motto; if (!profileUser.preferences) profileUser.preferences = {}; profileUser.preferences.motto = motto; }
      if (bio !== undefined) profileUser.bio = bio;
      if (location !== undefined) profileUser.location = location;
      if (coverImage !== undefined) { profileUser.coverImage = coverImage; if (!profileUser.preferences) profileUser.preferences = {}; profileUser.preferences.coverImage = coverImage; }
      if (website !== undefined) { if (!profileUser.preferences) profileUser.preferences = {}; profileUser.preferences.website = website; }
      if (birthday !== undefined) profileUser.birthday = birthday;
      profileUser.socialLinks = socialLinks;
      if (coverPosition !== undefined) { if (!profileUser.preferences) profileUser.preferences = {}; profileUser.preferences.coverPosition = body.coverPosition; profileUser.coverPosition = body.coverPosition; }
      if (currentUser) {
        if (motto !== undefined) { currentUser.motto = motto; if (!currentUser.preferences) currentUser.preferences = {}; currentUser.preferences.motto = motto; }
        if (bio !== undefined) currentUser.bio = bio;
        if (website !== undefined) { if (!currentUser.preferences) currentUser.preferences = {}; currentUser.preferences.website = website; }
        if (birthday !== undefined) currentUser.birthday = birthday;
        if (coverPosition !== undefined) { if (!currentUser.preferences) currentUser.preferences = {}; currentUser.preferences.coverPosition = body.coverPosition; currentUser.coverPosition = body.coverPosition; }
      }
      closeModal('editProfileModal');
      renderProfileHeader(profileUser, true);
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('profile_page.save_failed') + ': ' + err.message, 'error');
  }
}

// ==================== 相册弹窗 ====================
function showAlbumModal(albumId) {
  const titleEl = document.getElementById('albumModalTitle');
  const nameEl = document.getElementById('albumName');
  const descEl = document.getElementById('albumDesc');
  const privacyEl = document.getElementById('albumPrivacy');
  const fileArea = document.getElementById('albumFileArea');

  if (albumId) {
    // 编辑模式
    if (titleEl) titleEl.textContent = __('profile_page.edit_album');
    const album = profileAlbums.find(a => a.id == albumId);
    if (album) {
      if (nameEl) nameEl.value = album.name || '';
      if (descEl) descEl.value = album.description || '';
      if (privacyEl) privacyEl.value = album.privacy || 'public';
      nameEl?.setAttribute('data-album-id', albumId);
    }
    if (fileArea) fileArea.classList.add('d-none');
  } else {
    // 新建模式
    if (titleEl) titleEl.textContent = __('profile_page.new_album');
    if (nameEl) { nameEl.value = ''; nameEl.removeAttribute('data-album-id'); }
    if (descEl) descEl.value = '';
    if (privacyEl) privacyEl.value = 'public';
    if (fileArea) {
      fileArea.classList.remove('d-none');
      var fInput = document.getElementById('albumPhotoInput');
      if (fInput) fInput.value = '';
    }
  }
  showModal('albumModal');
}

async function saveAlbum() {
  const albumId = document.getElementById('albumName')?.getAttribute('data-album-id');
  const name = document.getElementById('albumName')?.value?.trim();
  const description = document.getElementById('albumDesc')?.value?.trim();
  const privacy = document.getElementById('albumPrivacy')?.value || 'public';
  const files = document.getElementById('albumPhotoInput')?.files;

  if (!name) { toast(__('profile_page.enter_album_name'), 'error'); return; }

  try {
    let res;
    if (albumId) {
      // 编辑
      res = await api(`/api/profile/albums/${albumId}`, { method: 'PUT', body: { name, description, privacy } });
    } else {
      // 新建
      res = await api('/api/profile/albums', { method: 'POST', body: { name, description, privacy } });
    }

    if (res.ok) {
      const data = await res.json();
      const newAlbumId = albumId || data.album?.id || data.id;
      toast(albumId ? __('profile_page.album_updated') : __('profile_page.album_created_new'), 'success');
      closeModal('albumModal');

      // 如果有文件，上传
      if (files && files.length > 0 && newAlbumId) {
        await uploadAlbumPhotos(newAlbumId, files);
      }

      // 重新加载资料页
      if (currentUser) loadUserProfile(currentUser.id);
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('profile_page.save_failed') + ': ' + err.message, 'error');
  }
}

// ==================== 上传照片/视频到相册 ====================
async function uploadAlbumPhotos(albumId, files) {
  if (!files || files.length === 0) return;
  // 上传前体积预校验（与服务端 profile 相册 multer limits 对齐：200MB）
  const MAX_PROFILE_ALBUM_BYTES = 200 * 1024 * 1024;
  // 上传前类型预校验（与服务端 multer fileFilter 对齐：图片 / 视频）
  const ALLOWED_TYPES = /^image\//i;
  const ALLOWED_VIDEO = /^video\//i;
  for (const f of files) {
    if (f.size > MAX_PROFILE_ALBUM_BYTES) {
      toast(__('profile_page.file_too_large', { name: f.name, size: '200MB' }), 'error');
      return;
    }
    if (!ALLOWED_TYPES.test(f.type) && !ALLOWED_VIDEO.test(f.type)) {
      toast(__('profile_page.file_type_invalid', { name: f.name }), 'error');
      return;
    }
  }
  const btn = document.querySelector('#albumModal .btn-accent');
  if (btn) { btn.disabled = true; btn.textContent = __('profile_page.uploading'); }

  // 显示进度条
  const progressWrap = document.getElementById('uploadProgress');
  const progressText = document.getElementById('uploadProgressText');
  const progressPercent = document.getElementById('uploadProgressPercent');
  const progressFill = document.getElementById('uploadProgressFill');
  const progressFile = document.getElementById('uploadProgressFile');

  if (progressWrap) progressWrap.classList.remove('d-none');
  if (progressWrap) progressWrap.classList.add('active');
  if (progressText) progressText.textContent = __('profile_page.uploading_file');
  if (progressPercent) progressPercent.textContent = '0%';
  if (progressFill) progressFill.style.transform = 'scaleX(0)';
  if (progressFile) progressFile.textContent = __('profile_page.n_files', {n: files.length});

  try {
    const formData = new FormData();
    for (const file of files) {
      formData.append('photos', file);
    }
    const res = await uploadWithProgress(`/api/profile/albums/${albumId}/photos`, formData, function(percent) {
      if (progressPercent) progressPercent.textContent = percent + '%';
      if (progressFill) progressFill.style.transform = 'scaleX(' + (percent / 100) + ')';
      if (progressText) progressText.textContent = percent < 100 ? __('profile_page.uploading_file') : __('profile_page.processing');
    });
    if (res.ok) {
      const data = await res.json();
      toast(__('profile_page.uploaded_n', {n: data.count || data.photos?.length || files.length}), 'success');
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('profile_page.upload_failed') + ': ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = __('save'); }
    if (progressWrap) { progressWrap.classList.remove('active'); progressWrap.classList.add('d-none'); }
  }
}

// ==================== 上传视频 ====================
async function uploadProfileVideo(files) {
  if (!files || files.length === 0) return;
  const file = files[0];
  if (!file.type.startsWith('video/')) { toast(__('profile_page.select_video'), 'error'); return; }

  // 显示进度条
  const progressWrap = document.getElementById('uploadProgress');
  const progressText = document.getElementById('uploadProgressText');
  const progressPercent = document.getElementById('uploadProgressPercent');
  const progressFill = document.getElementById('uploadProgressFill');
  const progressFile = document.getElementById('uploadProgressFile');

  if (progressWrap) progressWrap.classList.remove('d-none');
  if (progressWrap) progressWrap.classList.add('active');
  if (progressText) progressText.textContent = __('profile_page.uploading_video');
  if (progressPercent) progressPercent.textContent = '0%';
  if (progressFill) progressFill.style.transform = 'scaleX(0)';
  if (progressFile) progressFile.textContent = file.name;

  try {
    const formData = new FormData();
    formData.append('video', file);
    formData.append('title', file.name.replace(/\.[^.]+$/, ''));

    const res = await uploadWithProgress('/api/profile/videos', formData, function(percent) {
      if (progressPercent) progressPercent.textContent = percent + '%';
      if (progressFill) progressFill.style.transform = 'scaleX(' + (percent / 100) + ')';
      if (progressText) progressText.textContent = percent < 100 ? __('profile_page.uploading_video') : __('profile_page.processing');
    });
    if (res.ok) {
      toast(__('profile_page.video_uploaded'), 'success');
      if (currentUser) loadUserProfile(currentUser.id);
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('profile_page.upload_failed') + ': ' + err.message, 'error');
  } finally {
    if (progressWrap) { progressWrap.classList.remove('active'); progressWrap.classList.add('d-none'); }
  }
}

// ==================== 隐私设置 ====================
async function updateProfilePrivacy(itemType, itemId, privacy) {
  try {
    const endpoints = {
      'album': `/api/profile/albums/${itemId}/privacy`,
      'video': `/api/profile/videos/${itemId}/privacy`
    };
    const endpoint = endpoints[itemType];
    if (!endpoint) { toast(__('profile_page.unknown_type'), 'error'); return; }

    const res = await api(endpoint, { method: 'PUT', body: { privacy } });
    if (res.ok) {
      toast(__('profile_page.privacy_updated'), 'success');
      if (currentUser) loadUserProfile(currentUser.id);
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('profile_page.update_failed') + ': ' + err.message, 'error');
  }
}

// ==================== 删除相册 ====================
async function deleteProfileAlbum(albumId) {
  showConfirm(__('profile_page.confirm_delete_album'), async () => {
    try {
      const res = await api(`/api/profile/albums/${albumId}`, { method: 'DELETE' });
      if (res.ok) {
        toast(__('profile_page.album_deleted'), 'success');
        if (currentUser) loadUserProfile(currentUser.id);
      }
    } catch (err) {
      if (isApiHandledError(err)) return;
      toast(__('profile_page.delete_failed') + ': ' + err.message, 'error');
    }
  });
}

// ==================== 删除视频 ====================
async function deleteProfileVideo(videoId) {
  showConfirm(__('profile_page.confirm_delete_video'), async () => {
    try {
      const res = await api(`/api/profile/videos/${videoId}`, { method: 'DELETE' });
      if (res.ok) {
        toast(__('profile_page.video_deleted'), 'success');
        if (currentUser) loadUserProfile(currentUser.id);
      }
    } catch (err) {
      if (isApiHandledError(err)) return;
      toast(__('profile_page.delete_failed') + ': ' + err.message, 'error');
    }
  });
}

// ==================== 从成员卡片跳转到资料页 ====================
function goToProfile(userId) {
  if (!userId) return;
  loadUserProfile(userId);
}

// ==================== 他人资料页关注/粉丝计数 ====================
// 计数接口带隐私闸（非本人且非好友 403）：拿不到就静默跳过，不展示伪数字
async function loadProfileFollowCounts(userId) {
  try {
    const res = await api(`/api/follows/counts/${userId}`, { method: 'GET' });
    if (!res.ok) return;
    const d = await res.json();
    const statsEl = document.getElementById('profileStats');
    if (!statsEl) return;
    statsEl.innerHTML += `
      <div class="profile-stat">➕ <span>${__('follows.following')} ${esc(d.following || 0)}</span></div>
      <div class="profile-stat">👥 <span>${__('follows.followers')} ${esc(d.followers || 0)}</span></div>
      ${d.mutual ? `<div class="profile-stat">🔄 <span>${__('follows.mutual_list')} ${esc(d.mutual)}</span></div>` : ''}`;
  } catch (e) { /* 隐私闸/网络异常：静默跳过 */ }
}


// ==================== 用户点赞功能 ====================
// V6.XX：支持赞/取消切换；_profileLikedToday 标记当前是否已赞，按钮点击时据此决定 POST/DELETE
let _profileLikedToday = false;

async function loadProfileLikeStats(userId) {
  try {
    const res = await api(`/api/user-like/${userId}/stats`, { method: 'GET' });
    if (res.ok) {
      const stats = await res.json();
      const likeCount = document.getElementById('profileLikeCount');
      const likeBtn = document.getElementById('profileLikeBtn');
      const likeStatus = document.getElementById('profileLikeStatus');

      _profileLikedToday = !!stats.likedToday;

      if (likeCount) likeCount.textContent = stats.totalLikes || 0;

      if (stats.likedToday) {
        if (likeBtn) {
          likeBtn.disabled = false;
          likeBtn.className = 'btn btn-sm btn-outline text-muted';
          likeBtn.innerHTML = '💔 <span id="profileLikeCount">' + (stats.totalLikes || 0) + '</span>';
          likeBtn.title = __('album.unliked');
        }
        if (likeStatus) likeStatus.textContent = __('likes.today_liked');
      } else {
        if (likeBtn) {
          likeBtn.disabled = false;
          likeBtn.className = 'btn btn-sm btn-accent';
          likeBtn.innerHTML = '❤️ <span id="profileLikeCount">' + (stats.totalLikes || 0) + '</span>';
          likeBtn.title = '';
        }
        if (likeStatus) likeStatus.textContent = __('likes.daily_once');
      }
    }
  } catch {}
}

async function profileLikeUser() {
  const profileUserId = document.getElementById('profileUserId')?.value;
  if (!profileUserId || !currentUser) return;

  const likeBtn = document.getElementById('profileLikeBtn');
  const likeCount = document.getElementById('profileLikeCount');
  const likeStatus = document.getElementById('profileLikeStatus');

  try {
    if (_profileLikedToday) {
      // 已赞 → 取消点赞
      const res = await api(`/api/user-like/${profileUserId}/like`, { method: 'DELETE' });
      if (res.ok) {
        const data = await res.json();
        toast(data.message || __('album.unliked'), 'success');
        _profileLikedToday = false;
        if (likeCount) likeCount.textContent = data.likeCount || 0;
        if (likeBtn) {
          likeBtn.className = 'btn btn-sm btn-accent';
          likeBtn.innerHTML = '❤️ <span id="profileLikeCount">' + (data.likeCount || 0) + '</span>';
          likeBtn.title = '';
        }
        if (likeStatus) likeStatus.textContent = __('likes.daily_once');
      }
    } else {
      // 未赞 → 点赞
      const res = await api(`/api/user-like/${profileUserId}/like`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        toast(data.message || __('profile_page.like_success'), 'success');
        _profileLikedToday = true;
        if (likeCount) likeCount.textContent = data.likeCount || 0;
        if (likeBtn) {
          likeBtn.className = 'btn btn-sm btn-outline text-muted';
          likeBtn.innerHTML = '💔 <span id="profileLikeCount">' + (data.likeCount || 0) + '</span>';
          likeBtn.title = __('album.unliked');
        }
        if (likeStatus) likeStatus.textContent = __('likes.today_liked');
      }
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('likes.like_failed'), 'error');
  }
}

// ==================== F-4 数据导出/导入 ====================
let dataExportLastText = '';

function openDataExportModal() {
  const m = document.getElementById('dataExportModal');
  if (m) m.classList.add('show');
  switchDataPane('export');
  const text = document.getElementById('dataExportText');
  if (text) text.value = '';
  hideDataMsg();
}

function closeDataExportModal() {
  const m = document.getElementById('dataExportModal');
  if (m) m.classList.remove('show');
}

function switchDataPane(pane) {
  const exportTab = document.getElementById('dataExportTabBtn');
  const importTab = document.getElementById('dataImportTabBtn');
  const exportPane = document.getElementById('dataExportPane');
  const importPane = document.getElementById('dataImportPane');
  if (pane === 'import') {
    exportTab.classList.remove('active'); importTab.classList.add('active');
    exportPane.classList.add('d-none'); importPane.classList.remove('d-none');
  } else {
    exportTab.classList.add('active'); importTab.classList.remove('active');
    exportPane.classList.remove('d-none'); importPane.classList.add('d-none');
  }
}

function showDataMsg(msg, type) {
  const el = document.getElementById('dataExportMsg');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('d-none', 'text-red', 'text-green');
  el.classList.add(type === 'success' ? 'text-green' : 'text-red');
}

function hideDataMsg() {
  const el = document.getElementById('dataExportMsg');
  if (el) el.classList.add('d-none');
}

async function exportData(format) {
  hideDataMsg();
  try {
    const res = await api('/api/users/me/export?format=' + format, { method: 'GET' });
    if (!res.ok) {
      if (res.status === 401) { toast(__('profile_page.login_required'), 'error'); return; }
      throw new Error('EXPORT_FAILED');
    }
    if (format === 'csv') {
      const text = await res.text();
      dataExportLastText = text.replace(/^\uFEFF/, '');
      const ta = document.getElementById('dataExportText');
      if (ta) ta.value = dataExportLastText;
    } else {
      const data = await res.json();
      dataExportLastText = JSON.stringify(data, null, 2);
      const ta = document.getElementById('dataExportText');
      if (ta) ta.value = dataExportLastText;
    }
    showDataMsg(__('profile_page.export_success'), 'success');
  } catch (err) {
    showDataMsg(__('profile_page.export_failed'), 'error');
  }
}

async function copyDataExport() {
  const ta = document.getElementById('dataExportText');
  if (!ta || !ta.value) { toast(__('profile_page.export_empty'), 'error'); return; }
  try {
    await navigator.clipboard.writeText(ta.value);
    toast(__('profile_page.copied'), 'success');
  } catch (e) {
    // 降级：手动选中
    ta.focus(); ta.select();
    try { document.execCommand('copy'); toast(__('profile_page.copied'), 'success'); }
    catch (_) { toast(__('profile_page.copy_failed'), 'error'); }
  }
}

function downloadDataExport() {
  const ta = document.getElementById('dataExportText');
  if (!ta || !ta.value) { toast(__('profile_page.export_empty'), 'error'); return; }
  const isJson = dataExportLastText && dataExportLastText.trim().startsWith('{');
  const filename = isJson ? 'jingtu-backup.json' : 'friends.csv';
  const mime = isJson ? 'application/json' : 'text/csv';
  const blob = new Blob([ta.value], { type: mime + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function importData() {
  hideDataMsg();
  const ta = document.getElementById('dataImportText');
  if (!ta || !ta.value.trim()) { toast(__('profile_page.import_empty'), 'error'); return; }
  let body;
  try { body = JSON.parse(ta.value); }
  catch (e) { showDataMsg(__('profile_page.import_invalid'), 'error'); return; }

  const btn = document.getElementById('dataImportBtn');
  if (btn) btn.disabled = true;
  try {
    const res = await api('/api/users/me/import', { method: 'POST', body });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(errText(err) || 'IMPORT_FAILED');
    }
    const data = await res.json();
    const counts = data.imported || {};
    const n = Object.values(counts).reduce((a, b) => a + (b || 0), 0);
    showDataMsg(__('profile_page.import_success', { n }), 'success');
    toast(__('profile_page.import_success', { n }), 'success');
  } catch (err) {
    showDataMsg(err.message === 'IMPORT_FAILED' ? __('profile_page.import_failed') : err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// 绑定数据导出/导入弹窗事件（幂等）
function bindDataExportEvents() {
  const closeBtn = document.getElementById('dataExportCloseBtn');
  const exportTab = document.getElementById('dataExportTabBtn');
  const importTab = document.getElementById('dataImportTabBtn');
  const jsonBtn = document.getElementById('exportJsonBtn');
  const csvBtn = document.getElementById('exportCsvBtn');
  const copyBtn = document.getElementById('dataExportCopyBtn');
  const dlBtn = document.getElementById('dataExportDownloadBtn');
  const importBtn = document.getElementById('dataImportBtn');
  const modal = document.getElementById('dataExportModal');

  if (modal && !modal.dataset.bound) {
    modal.dataset.bound = '1';
    if (closeBtn) closeBtn.addEventListener('click', closeDataExportModal);
    if (exportTab) exportTab.addEventListener('click', () => switchDataPane('export'));
    if (importTab) importTab.addEventListener('click', () => switchDataPane('import'));
    if (jsonBtn) jsonBtn.addEventListener('click', () => exportData('json'));
    if (csvBtn) csvBtn.addEventListener('click', () => exportData('csv'));
    if (copyBtn) copyBtn.addEventListener('click', copyDataExport);
    if (dlBtn) dlBtn.addEventListener('click', downloadDataExport);
    if (importBtn) importBtn.addEventListener('click', importData);
    // 点击遮罩关闭
    modal.addEventListener('click', (e) => { if (e.target === modal) closeDataExportModal(); });
  }
}

// 暴露给全局（onclick 调用）
window.openDataExportModal = openDataExportModal;

// 页面加载时绑定事件
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindDataExportEvents);
} else {
  bindDataExportEvents();
}

// ==================== 个人主页按钮事件委托（CSP nonce 下内联处理器不可用） ====================
// 迁移自个人主页操作按钮/相册卡片/视频卡片/照片卡片/视频弹窗里的内联 onclick ——
// 属性型处理器被 script-src nonce 拦截（与成员卡/动态同案），统一改为
// data-action + document 级委托，天然覆盖重渲染与懒加载时序。
let _profilePageClickHandler = null;

function _bindProfilePageDelegation() {
  if (_profilePageClickHandler) document.removeEventListener('click', _profilePageClickHandler);
  _profilePageClickHandler = function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
    if (!el) return;
    var action = el.getAttribute('data-action');
    switch (action) {
      case 'profile-back':
        // 返回进入资料页前的标签页（成员/聊天/好友等）
        if (typeof switchTab === 'function') {
          switchTab(window._profileReturnTab || 'members');
        }
        break;
      case 'profile-edit':
        showEditProfileModal();
        break;
      case 'profile-new-album':
        showAlbumModal();
        break;
      case 'profile-upload-video': {
        var input = document.getElementById('profileVideoUpload');
        if (input) input.click();
        break;
      }
      case 'profile-export':
        openDataExportModal();
        break;
      case 'profile-like':
        profileLikeUser();
        break;
      case 'profile-dm':
        // 直接打开与该成员的私信（openChat 内部会切到聊天标签）
        if (typeof openChat === 'function') openChat(el.getAttribute('data-uid'));
        break;
      case 'profile-open-album':
        openAlbum(el.getAttribute('data-album-id'));
        break;
      case 'profile-open-video':
        openVideo(el.getAttribute('data-video-id'));
        break;
      case 'profile-view-media':
        profileViewMedia(el.getAttribute('data-photo-id'));
        break;
      case 'close-video-overlay': {
        var overlay = el.closest('.video-overlay');
        if (overlay) window.closeProfileVideoOverlay(overlay);
        break;
      }
    }
  };
  document.addEventListener('click', _profilePageClickHandler);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _bindProfilePageDelegation);
} else {
  _bindProfilePageDelegation();
}