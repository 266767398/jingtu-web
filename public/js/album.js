// ==================== 相册系统 ====================
let albumCateLoaded = false;
let lastCateId = 0;
let albumLoading = false;

function initAlbumEventDelegates() {
  const albumGrid = document.getElementById('albumGrid');
  if (albumGrid && !albumGrid._albumDelegateInit) {
    albumGrid._albumDelegateInit = true;
    albumGrid.addEventListener('click', (e) => {
      const el = e.target.closest('[data-album-action]');
      if (!el) return;
      const action = el.dataset.albumAction;
      const id = el.dataset.id;
      if (action === 'show-lightbox') showLightbox(id);
    });
  }
  
  const lbThumbs = document.getElementById('lbThumbs');
  if (lbThumbs && !lbThumbs._thumbsDelegateInit) {
    lbThumbs._thumbsDelegateInit = true;
    lbThumbs.addEventListener('click', (e) => {
      const el = e.target.closest('[data-thumb-idx]');
      if (!el) return;
      const idx = parseInt(el.dataset.thumbIdx);
      if (!isNaN(idx)) {
        currentPhotoIdx = idx;
        updateLightbox();
      }
    });
  }
  
  const recycleList = document.getElementById('recycleList');
  if (recycleList && !recycleList._recycleDelegateInit) {
    recycleList._recycleDelegateInit = true;
    recycleList.addEventListener('click', (e) => {
      const el = e.target.closest('[data-recycle-action]');
      if (!el) return;
      const action = el.dataset.recycleAction;
      const id = el.dataset.id;
      if (action === 'restore') restorePhoto(id);
      else if (action === 'permanent-delete') permanentDelete(id);
    });
  }
  
  const commentsList = document.getElementById('lbComments');
  if (commentsList && !commentsList._commentsDelegateInit) {
    commentsList._commentsDelegateInit = true;
    commentsList.addEventListener('click', (e) => {
      const el = e.target.closest('[data-comment-action]');
      if (!el) return;
      const action = el.dataset.commentAction;
      if (action === 'delete') {
        const photoId = el.dataset.photoId;
        const commentId = el.dataset.commentId;
        deletePhotoComment(photoId, commentId);
      } else if (action === 'edit') {
        const photoId = el.dataset.photoId;
        const commentId = el.dataset.commentId;
        editPhotoComment(photoId, commentId);
      }
    });
  }
}

// 加载相册分类
async function loadAlbumCategories() {
  const sel = document.getElementById('albumCate');
  if (!sel) return;
  try {
    const res = await api('/api/album/categories', { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      const cats = data.categories || [];
      sel.innerHTML = '<option value="0">' + __('album.all_categories') + '</option>' + cats.map(c =>
        `<option value="${c.id}">${esc(c.name)}</option>`
      ).join('');
      albumCateLoaded = true;
    }
  } catch (e) {
    toast(__('album.cate_failed'), 'error');
  }
}

async function loadAlbum(albumId = null) {
  const currentCate = parseInt(document.getElementById('albumCate')?.value || 0);
  if (currentCate !== lastCateId) {
    albumPage = 1;
    lastCateId = currentCate;
  }
  const container = document.getElementById('albumGrid');
  if (container && albumPage === 1) showSkeleton(container, 'grid', 9);
  if (albumLoading) return;
  albumLoading = true;
  try {
    if (!albumCateLoaded) await loadAlbumCategories();
    const cateId = document.getElementById('albumCate')?.value || 0;
    let url = albumId
      ? `/api/album/photos?album=${albumId}&page=${albumPage}`
      : `/api/album/photos?page=${albumPage}&cate=${cateId}`;
    const res = await api(url, { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      albumPhotoList = data.photos || [];
      renderAlbum(albumPhotoList);
      const loadMore = document.getElementById('albumPager');
      if (loadMore) loadMore.style.display = data.hasMore ? '' : 'none';
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('load_failed'), 'error');
  } finally {
    albumLoading = false;
  }
}

function renderAlbum(photos) {
  const container = document.getElementById('albumGrid');
  if (!container) return;
  initAlbumEventDelegates();
  if (!photos || photos.length === 0) { renderEmpty(container, { icon: '📷', title: __('album.no_photos'), text: __('album.upload_hint') }); return; }
  const html = photos.map(p => {
    const isVideo = p.mediaType === 'video';
    const hasThumb = isVideo && p.thumbnail && !p.thumbnail.includes('placeholder');
    const mediaHtml = isVideo
      ? (hasThumb
        ? imgWithFallback(p.thumbnail, 'album-photo-thumb', p.caption || __('album.video'))
        : `<div class="album-photo-thumb video-thumb" style="background:var(--bg-secondary);display:flex;align-items:center;justify-content:center"><span style="font-size:36px">🎬</span></div>`)
      : imgWithFallback(p.thumbnail || p.url, 'album-photo-thumb', p.caption || __('album.photo'));
    const badgeHtml = isVideo ? '<span class="album-media-badge">🎬</span>' : '';
    return `<div class="album-photo-card photo-item" data-id="${escAttr(String(p.id))}" data-album-action="show-lightbox">${mediaHtml}${badgeHtml}<div class="album-photo-caption">${esc(p.caption || '')}</div>${p.likes ? `<div class="album-photo-likes">❤️ ${p.likes}</div>` : ''}</div>`;
  }).join('');
  if (albumPage === 1) { container.innerHTML = html; document.getElementById('albumDropzone')?.classList.toggle('has-photos', photos.length > 0); } else container.innerHTML += html;
  initAlbumEventDelegates();
}

function showLightbox(photoId) {
  const idx = albumPhotoList.findIndex(p => String(p.id) === String(photoId));
  if (idx === -1) return;
  currentPhotoIdx = idx; updateLightbox();
  const lightbox = document.getElementById('lightbox');
  if (lightbox) {
    lightbox.style.display = 'flex';
    requestAnimationFrame(() => requestAnimationFrame(() => lightbox.classList.add('show')));
  }
}

function updateLightbox() {
  if (currentPhotoIdx < 0 || currentPhotoIdx >= albumPhotoList.length) return;
  const p = albumPhotoList[currentPhotoIdx];
  const isVideo = p.mediaType === 'video';
  // 切换图片/视频显示
  const imgContainer = document.getElementById('lightboxImgContainer');
  if (imgContainer) {
    if (isVideo) {
      imgContainer.innerHTML = '<video id="lightboxVideo" class="lightbox-video" src="' + escAttr(p.url) + '" controls autoplay style="max-width:90vw;max-height:80vh;border-radius:8px;"></video>';
      document.getElementById('lightboxImg')?.classList.add('d-none');
    } else {
      imgContainer.innerHTML = '<img id="lightboxImg" src="' + escAttr(p.url || p.thumbnail) + '" alt="" style="max-width:90vw;max-height:80vh;object-fit:contain;border-radius:8px;" onerror="window.__imgFail(this)">';
    }
  }
  const caption = document.getElementById('lbDesc');
  if (caption) {
    caption.textContent = p.caption || '';
    caption.classList.toggle('d-none', !p.caption);
  }
  const idx = document.getElementById('lbCounter'); if (idx) idx.textContent = `${currentPhotoIdx + 1} / ${albumPhotoList.length}`;
  // 更新点赞数及状态
  const likeCount = document.getElementById('likeCount');
  if (likeCount) likeCount.textContent = p.likes || 0;
  const likeBtn = document.getElementById('likeBtn');
  if (likeBtn) {
    const isLiked = myLikedPhotoIds.has(Number(p.id));
    likeBtn.innerHTML = `${isLiked ? '💖' : '❤️'} <span id="likeCount">${p.likes || 0}</span>`;
  }
  // 更新底部缩略图导航栏
  renderThumbnails();
  // 更新描述编辑按钮可见性
  const editBtn = document.getElementById('lbEditDescBtn');
  if (editBtn) {
    if (currentUser && p) {
      editBtn.classList.remove('d-none');
      editBtn.onclick = () => editPhotoDesc(p.id, p.caption || '');
    } else {
      editBtn.classList.add('d-none');
    }
  }
  loadPhotoComments(p.id);
}

function renderThumbnails() {
  const container = document.getElementById('lbThumbs');
  if (!container) return;
  initAlbumEventDelegates();
  if (!albumPhotoList || albumPhotoList.length === 0) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = albumPhotoList.map((p, i) => {
    const isV = p.mediaType === 'video';
    const hasThumb = isV && p.thumbnail && !p.thumbnail.includes('placeholder');
    const activeClass = i === currentPhotoIdx ? 'active' : '';
    const thumbStyle = `width:60px;height:60px;object-fit:cover;border-radius:6px;cursor:pointer;flex-shrink:0;border:2px solid ${i === currentPhotoIdx ? 'var(--accent)' : 'transparent'}`;
    if (isV && hasThumb) {
      return `<img src="${escAttr(p.thumbnail)}" class="${activeClass}" data-thumb-idx="${i}" alt="" loading="lazy" style="${thumbStyle}" onerror="window.__imgFail(this)">`;
    }
    return isV
      ? `<div class="lb-thumb-item ${activeClass}" data-thumb-idx="${i}" style="width:60px;height:60px;background:var(--bg-secondary);display:inline-flex;align-items:center;justify-content:center;border-radius:6px;cursor:pointer;flex-shrink:0;border:2px solid ${i === currentPhotoIdx ? 'var(--accent)' : 'transparent'}"><span style="font-size:20px">🎬</span></div>`
      : `<img src="${escAttr(p.thumbnail || p.url)}" class="${activeClass}" data-thumb-idx="${i}" alt="" loading="lazy" onerror="window.__imgFail(this)">`;
  }).join('');
  initAlbumEventDelegates();
  // 滚动到当前缩略图可见
  const activeImg = container.querySelector('.active');
  if (activeImg) activeImg.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
}
function lightboxPrev() { if (currentPhotoIdx > 0) { currentPhotoIdx--; updateLightbox(); } }
function lightboxNext() { if (currentPhotoIdx < albumPhotoList.length - 1) { currentPhotoIdx++; updateLightbox(); } }
function stopSlideshow() {
  if (!slideTimer) return;
  clearInterval(slideTimer); slideTimer = null;
  const btn = document.getElementById('lbSlideBtn');
  if (btn) { btn.textContent = __('album.slideshow'); btn.classList.remove('playing'); }
  const lightbox = document.getElementById('lightbox');
  if (lightbox && slideshowNavHandler) { lightbox.removeEventListener('click', slideshowNavHandler); slideshowNavHandler = null; }
}
function closeLightbox() {
  stopSlideshow();
  const lightbox = document.getElementById('lightbox');
  if (lightbox) {
    lightbox.classList.remove('show');
    setTimeout(() => { lightbox.style.display = 'none'; }, 270);
  }
}
let slideTimer = null;
let slideshowNavHandler = null;
function toggleSlideshow() {
  const btn = document.getElementById('lbSlideBtn');
  if (slideTimer) { stopSlideshow(); return; }
  if (!albumPhotoList || albumPhotoList.length < 2) { toast(__('album.need_2_photos'), 'info'); return; }
  if (btn) { btn.textContent = __('album.slideshow_stop'); btn.classList.add('playing'); }
  slideTimer = setInterval(() => {
    currentPhotoIdx = (currentPhotoIdx + 1) % albumPhotoList.length;
    updateLightbox();
  }, 3000);
  // 手动翻页时自动停止
  const lightbox = document.getElementById('lightbox');
  if (lightbox) {
    slideshowNavHandler = () => { stopSlideshow(); };
    lightbox.addEventListener('click', slideshowNavHandler, { once: true });
  }
}
function lightboxNav(dir) { if (dir === -1) lightboxPrev(); else lightboxNext(); }

async function likePhoto(photoId) {
  try {
    // 优化反馈：在请求发出前先翻转按钮文案 + 触发心爆裂动画
    // （posts.js 乐观更新在前；这里采用「先到服务端、再更新 UI」的模式以保证计数准确）
    const pBefore = albumPhotoList.find(p => p.id === photoId);
    const wasLiked = pBefore ? myLikedPhotoIds.has(Number(photoId)) : false;
    const res = await api(`/api/photos/${photoId}/like`, { method: 'POST' });
    if (res.ok) {
      const data = await res.json();
      const p = albumPhotoList.find(p => p.id === photoId);
      if (p && data.likes !== undefined) p.likes = data.likes;
      // 翻转 like 状态集合 + 按钮文案
      const nowLiked = !wasLiked;
      if (nowLiked) myLikedPhotoIds.add(Number(photoId));
      else myLikedPhotoIds.delete(Number(photoId));
      const likeBtn = document.getElementById('likeBtn');
      if (likeBtn) {
        likeBtn.innerHTML = `${nowLiked ? '💖' : '❤️'} <span id="likeCount">${p ? p.likes || 0 : 0}</span>`;
      }
      // 动效反馈：点赞/取消 心爆裂 vs 小回弹
      try { if (window.SITE_LIKE && likeBtn) window.SITE_LIKE.triggerBurst(likeBtn, nowLiked); } catch (e) { /* 静默 */ }
      toast(__('album.liked'), 'success');
    }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('album.like_failed'), 'error'); }
}

async function deletePhoto() {
  showConfirm(__('album.delete_confirm'), async () => {
    if (currentPhotoIdx === null || currentPhotoIdx < 0) return;
    const p = albumPhotoList[currentPhotoIdx]; if (!p) return;
    try { const res = await api(`/api/photos/${p.id}`, { method: 'DELETE' }); if (res.ok) { toast(__('album.deleted'), 'success'); albumPhotoList.splice(currentPhotoIdx, 1); if (albumPhotoList.length === 0) closeLightbox(); else { if (currentPhotoIdx >= albumPhotoList.length) currentPhotoIdx = albumPhotoList.length - 1; updateLightbox(); } } } catch (err) { if (isApiHandledError(err)) return; toast(__('album.delete_failed'), 'error'); }
  });
}
async function sharePhoto() {
  if (currentPhotoIdx === null) return; const p = albumPhotoList[currentPhotoIdx]; if (!p) return;
  // 复用全局分享函数：生成公开落地页链接（无需登录即可查看）
  await sharePublicLink('album', p.id);
}

// ==================== 相册选择模式 ====================
let albumSelectMode = false;
const selectedPhotoIds = new Set();

function toggleAlbumSelect() {
  albumSelectMode = !albumSelectMode;
  const btn = document.getElementById('albumSelectBtn');
  const delBtn = document.getElementById('albumBatchDelBtn');
  // P3-66: 元素缺失时不抛 TypeError（选择模式逻辑照常推进）
  if (albumSelectMode) {
    if (btn) btn.textContent = __('album.cancel_select');
    if (delBtn) delBtn.classList.remove('d-none');
    selectedPhotoIds.clear();
    // 重新渲染所有照片卡片加 checkbox
    document.querySelectorAll('.album-photo-card').forEach(el => {
      el.classList.add('selectable');
      const pid = el.getAttribute('data-id');
      if (pid && !el.querySelector('.album-select-checkbox')) {
        const cb = document.createElement('div');
        cb.className = 'album-select-checkbox';
        cb.textContent = '☐';
        cb.onclick = (e) => { e.stopPropagation(); toggleAlbumSelectItem(pid, el); };
        el.prepend(cb);
      }
    });
  } else {
    if (btn) btn.textContent = __('album.select_btn');
    if (delBtn) delBtn.classList.add('d-none');
    selectedPhotoIds.clear();
    document.querySelectorAll('.album-photo-card').forEach(el => {
      el.classList.remove('selectable', 'selected');
      el.querySelector('.album-select-checkbox')?.remove();
    });
  }
}

function toggleAlbumSelectItem(photoId, cardEl) {
  if (!cardEl) cardEl = document.querySelector(`.album-photo-card[data-id="${CSS.escape(photoId)}"]`);
  if (!cardEl) return;
  if (selectedPhotoIds.has(photoId)) {
    selectedPhotoIds.delete(photoId);
    cardEl.classList.remove('selected');
    cardEl.querySelector('.album-select-checkbox').textContent = '☐';
  } else {
    selectedPhotoIds.add(photoId);
    cardEl.classList.add('selected');
    cardEl.querySelector('.album-select-checkbox').textContent = '☑';
  }
  // 更新批量删除按钮文本
  const delBtn = document.getElementById('albumBatchDelBtn');
  if (delBtn) delBtn.textContent = selectedPhotoIds.size > 0 ? `🗑️ ${__('album.delete')} (${selectedPhotoIds.size})` : __('album.batch_delete_btn');
}

async function batchDeletePhotos() {
  if (selectedPhotoIds.size === 0) { toast(__('album.select_first'), 'error'); return; }
  showConfirm(__('album.confirm_batch_delete_n', {n: selectedPhotoIds.size}), async () => {
    try {
      const res = await api('/api/album/photos/batch-delete', {
        method: 'POST',
        body: { ids: Array.from(selectedPhotoIds) }
      });
      if (res.ok) {
        const data = await res.json();
        toast(__('album.deleted_n', {n: data.count || selectedPhotoIds.size}), 'success');
        albumSelectMode = false; // 退出选择模式
        selectedPhotoIds.clear();
        const selBtn = document.getElementById('albumSelectBtn');
        const delBtn = document.getElementById('albumBatchDelBtn');
        if (selBtn) selBtn.textContent = __('album.select_btn'); // P3-66: 判空避免 TypeError
        if (delBtn) delBtn.classList.add('d-none');
        document.querySelectorAll('.album-select-checkbox').forEach(el => el.closest('.album-photo-card')?.classList.remove('selectable', 'selected'));
        document.querySelectorAll('.album-select-checkbox').forEach(el => el.remove());
        loadAlbum();
      }
    } catch (err) { if (isApiHandledError(err)) return; toast(__('album.batch_delete_failed') + ': ' + err.message, 'error'); }
  });
}

// ==================== 回收站 ====================
async function showRecycle() {
  try {
    const res = await api('/api/album/recycle', { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      const container = document.getElementById('recycleList');
      if (!container) return;
      if (!data || data.length === 0) {
        renderEmpty(container, { icon: '🗑️', text: __('album.trash_empty') });
      } else {
        container.innerHTML = data.map(p => `
          <div class="recycle-item">
            <img src="${escAttr(p.thumbPath || p.path)}" class="recycle-thumb" alt="${__('album.alt_photo')}" loading="lazy" onerror="window.__imgFail(this)">
            <div class="recycle-info">
              <div class="recycle-desc">${esc(p.desc || __('album.no_desc'))}</div>
              <div class="recycle-meta">${__('album.uploader')}${esc(p.uploaderName || __('unknown'))} · ${__('album.deleted_at')}：${fmtDate(p.recycleTime)}</div>
            </div>
            <div class="recycle-actions">
              <button class="btn btn-sm btn-accent" data-recycle-action="restore" data-id="${escAttr(String(p.id))}">${__('album.restore')}</button>
              <button class="btn btn-sm btn-danger" data-recycle-action="permanent-delete" data-id="${escAttr(String(p.id))}">${__('album.permanent_delete')}</button>
            </div>
          </div>
        `).join('');
      }
      initAlbumEventDelegates();
      showModal('recycleModal');
    }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('album.load_trash_failed') + ': ' + err.message, 'error'); }
}

async function restorePhoto(photoId) {
  try {
    const res = await api(`/api/album/photos/${photoId}/restore`, { method: 'POST' });
    if (res.ok) { toast(__('album.restored'), 'success'); showRecycle(); }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('album.restore_failed') + ': ' + err.message, 'error'); }
}

async function permanentDelete(photoId) {
  showConfirm(__('album.permanent_delete_confirm'), async () => {
    try {
      const res = await api(`/api/album/photos/${photoId}/permanent`, { method: 'DELETE' });
      if (res.ok) { toast(__('album.permanently_deleted'), 'success'); showRecycle(); }
    } catch (err) { if (isApiHandledError(err)) return; toast(__('album.delete_failed') + ': ' + err.message, 'error'); }
  });
}

function loadMoreAlbum() {
  if (albumLoading) return;
  albumPage++;
  loadAlbum();
}

async function editPhotoDesc(photoId, currentDesc) {
  showInput(__('album.edit_desc'), currentDesc || '', function(newDesc) {
    if (newDesc === null) return;
    (async function() {
      try {
        const res = await api(`/api/photos/${photoId}`, {
          method: 'PUT',
          body: { caption: newDesc.trim() }
        });
        if (res.ok) {
          toast(__('album.desc_updated'), 'success');
          const p = albumPhotoList.find(p => String(p.id) === String(photoId));
          if (p) p.caption = newDesc.trim();
          updateLightbox();
        }
      } catch (err) { if (isApiHandledError(err)) return; toast(__('album.desc_update_failed') + ': ' + err.message, 'error'); }
    })();
  });
}

async function postComment() {
  const input = document.getElementById('commentInput'); const text = input?.value?.trim();
  if (!text) { toast(__('album.enter_comment'), 'error'); return; }
  if (currentPhotoIdx === null) return; const p = albumPhotoList[currentPhotoIdx]; if (!p) return;
  try {
    const res = await api(`/api/photos/${p.id}/comments`, { method: 'POST', body: { content: text } });
    if (res.ok) {
      toast(__('album.comment_posted'), 'success');
      if (input) input.value = '';
      loadPhotoComments(p.id); // 刷新评论
    }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('album.comment_post_failed'), 'error'); }
}

// ==================== 已点赞照片缓存 ====================
let myLikedPhotoIds = new Set();
// P3-65: 点赞请求在途锁（同一 photoId 忽略重复点击，避免双请求 + 计数错乱）
const likePending = new Set();

async function loadMyLikes() {
  if (!currentUser) return;
  try {
    const res = await api('/api/album/my-likes', { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      myLikedPhotoIds = new Set((data.likedIds || []).map(Number));
    }
  } catch {}
}

async function toggleLike() {
  if (currentPhotoIdx === null || currentPhotoIdx < 0) return;
  const p = albumPhotoList[currentPhotoIdx];
  if (!p) return;
  const pid = Number(p.id);
  // P3-65: 请求在途时忽略重复点击，防两个请求基于同一 wasLiked 同时 POST
  if (likePending.has(pid)) return;
  likePending.add(pid);
  try {
    if (myLikedPhotoIds.has(pid)) {
      // 已点赞 → 取消点赞
      try {
        const res = await api(`/api/photos/${p.id}/like`, { method: 'DELETE' });
        if (res.ok) {
          myLikedPhotoIds.delete(pid);
          if (p.likes !== undefined) p.likes = Math.max(0, p.likes - 1);
          toast(__('album.unliked'), 'info');
          updateLightbox();
        }
      } catch (err) { if (isApiHandledError(err)) return; toast(__('album.unlike_failed'), 'error'); }
    } else {
      // 未点赞 → 点赞
      await likePhoto(p.id);
      myLikedPhotoIds.add(pid);
      updateLightbox();
    }
  } finally {
    likePending.delete(pid);
  }
}

// ==================== 相册评论加载 ====================
async function loadPhotoComments(photoId) {
  const list = document.getElementById('lbComments');
  if (!list) return;
  try {
    const res = await api(`/api/photos/${photoId}/comments`, { method: 'GET' });
    if (res.ok) {
      const comments = await res.json();
      if (!comments || comments.length === 0) {
        renderEmpty(list, { icon: '💬', text: __('album.no_comments') });
        return;
      }
      list.innerHTML = comments.map(c => `
        <div class="det-comment-item" data-comment-id="${c.id}">
          <img src="${escAttr(c.avatarUrl || '/api/avatar/default')}" class="det-comment-avatar" alt="" loading="lazy" onerror="window.__avatarFail&&window.__avatarFail(this,'${escJsStr(c.avatarUrl || '/api/avatar/default')}')">
          <div class="det-comment-body">
            <div class="det-comment-header">
              <span class="det-comment-user">${esc(c.userName || __('unknown_user'))}</span>
              <span class="det-comment-time">${fmtTime(c.createdAt)}</span>
              ${currentUser && (currentUser.id === c.userId || currentUser.role === 'super_admin' || currentUser.role === 'admin')
                ? `<button class="btn-text det-comment-del" data-comment-action="edit" data-photo-id="${escAttr(String(photoId))}" data-comment-id="${escAttr(String(c.id))}">${__('edit')}</button><button class="btn-text det-comment-del" data-comment-action="delete" data-photo-id="${escAttr(String(photoId))}" data-comment-id="${escAttr(String(c.id))}">${__('album.delete_comment_btn')}</button>` : ''}
            </div>
            <div class="det-comment-content" id="albumCommentText-${c.id}">${esc(c.content)}</div>
          </div>
        </div>
      `).join('');
      initAlbumEventDelegates();
    }
  } catch { list.innerHTML = '<div class="text-muted text-12">' + __('album.load_failed') + '</div>'; }
}

async function deletePhotoComment(photoId, commentId) {
  showConfirm(__('album.confirm_delete_comment'), async () => {
    try {
      const res = await api(`/api/photos/${photoId}/comments/${commentId}`, { method: 'DELETE' });
      if (res.ok) { toast(__('album.comment_deleted'), 'success'); loadPhotoComments(photoId); }
    } catch (err) { if (isApiHandledError(err)) return; toast(__('album.delete_comment_failed'), 'error'); }
  });
}

async function editPhotoComment(photoId, commentId) {
  const textEl = document.getElementById('albumCommentText-' + commentId);
  if (!textEl) return;
  const original = textEl.textContent;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = original;
  input.maxLength = 2000;
  input.className = 'det-comment-edit-input';
  textEl.innerHTML = '';
  textEl.appendChild(input);
  input.focus();
  // P3-65: Enter 提交 → loadPhotoComments 重载列表 → input 被移除触发 onblur → 再 finish(true)
  // 会造成同一评论 PUT 两次；成功路径保持 saving=true，onblur 二次触发直接忽略
  let saving = false;
  const finish = async (save) => {
    if (saving) return;
    saving = true;
    if (save) {
      const content = input.value.trim();
      if (!content) { loadPhotoComments(photoId); return; }
      try {
        const res = await api(`/api/photos/${photoId}/comments/${commentId}`, { method: 'PUT', body: { content } });
        if (res.ok) { toast(__('operation_success'), 'success'); }
        loadPhotoComments(photoId);
      } catch (err) {
        saving = false; // 失败允许重试
        if (isApiHandledError(err)) return;
        toast(__('album.delete_comment_failed'), 'error');
        loadPhotoComments(photoId);
      }
    } else {
      loadPhotoComments(photoId);
    }
  };
  input.onkeydown = function(e) {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  input.onblur = function() { finish(true); };
}

// Enter 键发送评论
document.addEventListener('DOMContentLoaded', () => {
  const ci = document.getElementById('commentInput');
  if (ci) {
    ci.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        postComment();
      }
    });
  }
  // 拖拽上传
  const dropzone = document.getElementById('albumDropzone');
  if (dropzone) {
    // 浏览器默认会在文件被拖放到页面任意位置时直接打开该文件，从而整页导航离开单页应用。
    // 用户只要没有精确落在 dropzone 上就看不到任何反应（其实是页面被替换了）。
    // 因此在 document 上兜底阻止默认行为，只有 dropzone 内的 drop 才真正处理。
    ['dragover', 'drop'].forEach(function (evt) {
      document.addEventListener(evt, function (e) {
        if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
        if (dropzone.contains(e.target)) return;
        e.preventDefault();
      });
    });

    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('drag-over');
    });
    // dragleave 在移动到子元素时也会触发，用 relatedTarget 判断是否真的离开了 dropzone，
    // 否则拖动过程中高亮会不停闪烁。
    dropzone.addEventListener('dragleave', (e) => {
      if (e.relatedTarget && dropzone.contains(e.relatedTarget)) return;
      dropzone.classList.remove('drag-over');
    });
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag-over');
      if (e.dataTransfer.files && e.dataTransfer.files.length) {
        // 跟点击上传保持一致：带上当前选中的分类，否则后端拿不到 cateId
        const cateId = parseInt(document.getElementById('albumCate')?.value || '1', 10) || 1;
        for (let i = 0; i < e.dataTransfer.files.length; i++) {
          uploadPhoto(e.dataTransfer.files[i], '', cateId);
        }
      }
    });
  }
});

// ==================== 相册分类管理（管理员） ====================
function showCreateAlbumCate() {
  showInput(__('album.enter_category_name'), '', function(name) {
    if (!name || !name.trim()) return;
    (async () => {
      try {
        const res = await api('/api/album/categories', { method: 'POST', body: { name: name.trim() } });
        if (res.ok) {
          toast(__('album.category_created'), 'success');
          albumCateLoaded = false;
          loadAlbum();
        }
      } catch (err) { if (isApiHandledError(err)) return; toast(__('album.create_failed'), 'error'); }
    })();
  });
}

function showDelAlbumCate() {
  (async () => {
    try {
      const res = await api('/api/album/categories', { method: 'GET' });
      if (res.ok) {
        const data = await res.json();
        const cats = (data.categories || []).filter(c => c.id !== 1);
        if (cats.length === 0) { toast(__('album.no_category_to_delete'), 'info'); return; }
        const msg = __('album.select_category_delete') + '\n' + cats.map((c, i) => `${i + 1}. ${c.name}`).join('\n') + '\n\n' + __('album.enter_indices');
        showInput(msg, '', function(input) {
          if (!input) return;
          const indices = input.split(',').map(s => parseInt(s.trim()) - 1).filter(i => i >= 0 && i < cats.length);
          if (indices.length === 0) { toast(__('album.invalid_selection'), 'error'); return; }
          const toDelete = indices.map(i => cats[i]);
          showConfirm(__('album.delete_category_confirm') + __('album.delete_category_warn') + '\n' + toDelete.map(c => '· ' + c.name).join('\n'), async function() {
            for (const c of toDelete) {
              try {
                await api(`/api/album/categories/${c.id}`, { method: 'DELETE' });
              } catch {}
            }
            toast(__('album.category_deleted'), 'success');
            albumCateLoaded = false;
            loadAlbum();
          });
        });
      }
    } catch {}
  })();
}

// 显示指定用户上传的照片
window.loadUserPhotos = async function(userId) {
  try {
    const grid = document.getElementById('albumGrid');
    if (grid) showSkeleton(grid, 'grid', 9);
    const res = await api(`/api/users/${userId}/photos`, { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      albumPhotoList = data.photos || [];
      albumPage = 1;
      renderAlbum(albumPhotoList);
    }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('album.load_user_photos_failed'), 'error'); }
};
