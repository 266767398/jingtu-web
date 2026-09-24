// ==================== 用户资料展示页 V6.7 ====================

let profileUser = null;
let profileAlbums = [];
let profileVideos = [];
let profileCurrentAlbumId = null;
let profilePageMode = 'view'; // 'view' | 'album'
// albumPhotoList 和 currentPhotoIdx 定义在 core.js 中，此处直接使用全局变量

// ==================== 加载用户资料 ====================
async function loadUserProfile(userId) {
  if (!userId) { toast(__('profile_page.invalid_id'), 'error'); return; }
  const container = document.getElementById('tab-profile-user');
  if (!container) return;

  // 切换到资料标签
  switchTabSilent('profile-user');
  profilePageMode = 'view';
  profileUser = null;

  // 显示加载状态
  document.getElementById('profileAlbums').innerHTML = '<div class="text-muted text-center-sm p-16">' + __('profile_page.loading') + '</div>';
  document.getElementById('profileVideos').innerHTML = '<div class="text-muted text-center-sm p-16">' + __('profile_page.loading') + '</div>';

  try {
    const res = await api(`/api/profile/${userId}`, { method: 'GET' });
    if (!res.ok) {
      if (res.status === 404) { toast(__('profile_page.not_found'), 'error'); return; }
      throw new Error('LOAD_FAILED');
    }
    const data = await res.json();
    profileUser = data.user ? { ...data.user, ...(data.profile || {}) } : data;
    profileAlbums = data.albums || [];
    profileVideos = data.videos || [];

    const isOwner = currentUser && currentUser.id === userId;
    renderProfileHeader(profileUser, isOwner);
    const profileUserIdEl = document.getElementById('profileUserId');
    if (profileUserIdEl) profileUserIdEl.value = userId;
    renderAlbums(profileAlbums, isOwner);
    renderVideos(profileVideos, isOwner);
  } catch (err) {
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
  document.title = __('app.title') + ' - ' + __('profile_page.user_profile');
}

// ==================== 渲染资料头部 ====================
function renderProfileHeader(user, isOwner) {
  // 封面
  const coverBg = document.getElementById('profileCoverBg');
  const coverImg = user.coverImage || user.preferences?.coverImage || '';
  if (coverBg) {
    if (coverImg) {
      coverBg.style.backgroundImage = `url(${escCssUrl(coverImg)})`;
    } else {
      coverBg.style.backgroundImage = '';
    }
  }

  // 头像
  const avatar = document.getElementById('profileAvatar');
  if (avatar) {
    avatar.src = user.avatarUrl || user.vrchatAvatarUrl || '/api/avatar/default';
    avatar.alt = user.displayName || user.loginId || '';
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

  // 个性签名
  const mottoEl = document.getElementById('profileMotto');
  if (mottoEl) {
    mottoEl.textContent = user.motto || user.preferences?.motto || '';
  }

  // 统计数据
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
  }

  // 操作按钮
  const actionsEl = document.getElementById('profileActions');
  if (actionsEl) {
    let html = '';
    if (isOwner) {
      html += '<button class="btn btn-sm btn-accent" onclick="showEditProfileModal()">' + __('profile_page.edit_profile') + '</button>';
      html += '<button class="btn btn-sm btn-outline" onclick="showAlbumModal()">' + __('profile_page.new_album') + '</button>';
      html += '<button class="btn btn-sm btn-outline" onclick="document.getElementById(\'profileVideoUpload\').click()">' + __('profile_page.upload_video') + '</button>';
      html += '<button class="btn btn-sm btn-outline" onclick="openDataExportModal()">💾 ' + __('profile_page.data_export') + '</button>';
    }
    if (!isOwner && currentUser) {
      html += '<button class="btn btn-sm btn-accent" id="profileLikeBtn" onclick="profileLikeUser()">❤️ <span id="profileLikeCount">0</span></button>';
      html += '<span id="profileLikeStatus" class="text-13 text-muted ml-2"></span>';
    }
    if (user.vrchatId) {
      html += `<a class="btn btn-sm btn-outline" href="https://vrchat.com/home/user/${esc(user.vrchatId)}" target="_blank" rel="noopener">${__('profile_page.vrc_home')}</a>`;
    }
    actionsEl.innerHTML = html;
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

// ==================== 渲染相册列表 ====================
function renderAlbums(albums, isOwner) {
  const container = document.getElementById('profileAlbums');
  const actionsEl = document.getElementById('albumActions');
  if (!container) return;

  if (actionsEl) {
    actionsEl.innerHTML = isOwner ? '<button class="btn btn-accent btn-sm" onclick="showAlbumModal()">' + __('profile_page.new_album_btn') + '</button>' : '';
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

    return `
    <div class="profile-album-card" onclick="openAlbum(${album.id})">
      <img class="profile-album-cover" src="${escAttr(cover || '/api/avatar/default')}" alt="${name}" loading="lazy" onerror="this.src='/api/avatar/default'">
      <div class="profile-album-info">
        <div class="profile-album-name">${name}</div>
        <div class="profile-album-meta">
          <span>${__('profile_page.n_files', {n: photoCount})}</span>
          <span class="privacy-badge ${privacy} ml-4">${privacyLabels[privacy] || privacy}</span>
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
    actionsEl.innerHTML = isOwner ? '<button class="btn btn-accent btn-sm" onclick="document.getElementById(\'profileVideoUpload\').click()">' + __('profile_page.upload_video') + '</button>' : '';
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

    return `
    <div class="profile-video-card" onclick="openVideo(${video.id})">
      <img class="profile-video-thumb" src="${escAttr(thumb)}" alt="${title}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
      <div class="profile-video-thumb" style="display:${thumb ? 'none' : 'flex'};align-items:center;justify-content:center;background:var(--bg-muted);font-size:32px">▶️</div>
      <div class="profile-video-info">
        <div class="profile-video-title">${title}</div>
        <div class="profile-video-meta">
          ${duration ? '<span>⏱ ' + duration + '</span>' : ''}
          ${date ? '<span>📅 ' + date + '</span>' : ''}
          <span class="privacy-badge ${privacy}">${privacyLabels[privacy] || privacy}</span>
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
          : '<img src="' + escAttr(thumb) + '" alt="' + esc(desc) + '" loading="lazy">';
        return '<div class="profile-photo-card" onclick="profileViewMedia(' + photo.id + ')">'
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
  overlay.innerHTML = '<video src="' + escAttr(videoPath) + '" controls autoplay></video><button class="modal-close" onclick="this.parentElement.remove()">✕</button>';
  overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

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
  // 社交链接
  const socialLinks = {};
  if (socialBilibili) socialLinks.bilibili = socialBilibili;
  if (socialWeibo) socialLinks.weibo = socialWeibo;
  if (socialGithub) socialLinks.github = socialGithub;
  if (Object.keys(socialLinks).length > 0) body.socialLinks = socialLinks;

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
      if (currentUser) {
        if (motto !== undefined) { currentUser.motto = motto; if (!currentUser.preferences) currentUser.preferences = {}; currentUser.preferences.motto = motto; }
        if (bio !== undefined) currentUser.bio = bio;
        if (website !== undefined) { if (!currentUser.preferences) currentUser.preferences = {}; currentUser.preferences.website = website; }
        if (birthday !== undefined) currentUser.birthday = birthday;
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
  if (progressFill) progressFill.style.width = '0%';
  if (progressFile) progressFile.textContent = __('profile_page.n_files', {n: files.length});

  try {
    const formData = new FormData();
    for (const file of files) {
      formData.append('photos', file);
    }
    const res = await uploadWithProgress(`/api/profile/albums/${albumId}/photos`, formData, function(percent) {
      if (progressPercent) progressPercent.textContent = percent + '%';
      if (progressFill) progressFill.style.width = percent + '%';
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
  if (progressFill) progressFill.style.width = '0%';
  if (progressFile) progressFile.textContent = file.name;

  try {
    const formData = new FormData();
    formData.append('video', file);
    formData.append('title', file.name.replace(/\.[^.]+$/, ''));

    const res = await uploadWithProgress('/api/profile/videos', formData, function(percent) {
      if (progressPercent) progressPercent.textContent = percent + '%';
      if (progressFill) progressFill.style.width = percent + '%';
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


// ==================== 用户点赞功能 ====================
async function loadProfileLikeStats(userId) {
  try {
    const res = await api(`/api/user-like/${userId}/stats`, { method: 'GET' });
    if (res.ok) {
      const stats = await res.json();
      const likeCount = document.getElementById('profileLikeCount');
      const likeBtn = document.getElementById('profileLikeBtn');
      const likeStatus = document.getElementById('profileLikeStatus');
      
      if (likeCount) likeCount.textContent = stats.totalLikes || 0;
      
      if (stats.likedToday) {
        if (likeBtn) {
          likeBtn.disabled = true;
          likeBtn.className = 'btn btn-sm btn-outline text-muted';
        }
        if (likeStatus) likeStatus.textContent = __('likes.today_liked');
      } else {
        if (likeBtn) {
          likeBtn.disabled = false;
          likeBtn.className = 'btn btn-sm btn-accent';
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
    const res = await api(`/api/user-like/${profileUserId}/like`, { method: 'POST' });
    if (res.ok) {
      const data = await res.json();
      toast(data.message || __('profile_page.like_success'), 'success');
      if (likeCount) likeCount.textContent = data.likeCount || 0;
      if (likeBtn) {
        likeBtn.disabled = true;
        likeBtn.className = 'btn btn-sm btn-outline text-muted';
      }
      if (likeStatus) likeStatus.textContent = __('likes.today_liked');
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