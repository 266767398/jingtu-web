/**
 * 境途同游 V6.9 — 动态/朋友圈前端模块
 * 完全独立模块
 */

// ==================== 状态 ====================
let postsCurrentPage = 1;
let postsTotalPages = 1;
let postsHasMore = false;
let postsFilterType = '';
let postsFilterUserId = null;
let postsDetailCache = {};

// ==================== 加载动态列表 ====================
function loadPosts(page) {
  page = page || 1;
  const container = document.getElementById('postsList');
  if (!container) return;
  const isFirstPage = page === 1;
  if (isFirstPage) container.innerHTML = '<div class="loading">${__('posts.loading')}</div>';

  const params = new URLSearchParams();
  params.set('page', page);
  var pageSize = (window.__heroConfig && window.__heroConfig.posts_per_page) || 20;
  params.set('pageSize', pageSize);
  if (postsFilterType) params.set('type', postsFilterType);
  if (postsFilterUserId) params.set('userId', postsFilterUserId);

  api('/api/posts?' + params.toString())
    .then(r => r.json())
    .then(data => {
      postsCurrentPage = data.page || 1;
      postsTotalPages = data.totalPages || 1;
      postsHasMore = data.hasMore === true;
      renderPosts(data.posts || [], isFirstPage);
      updatePostsLoadMoreBtn();
    })
    .catch(err => {
      if (isApiHandledError(err)) return;
      container.innerHTML = '<div class="empty-state"><div class="empty-icon">📝</div><div class="empty-sub">${__('posts.load_failed')}</div></div>';
    });
}

// ==================== "加载更多"按钮控制 ====================
function updatePostsLoadMoreBtn() {
  const btn = document.getElementById('postsLoadMoreBtn');
  if (!btn) return;
  btn.style.display = postsHasMore ? '' : 'none';
}

function loadMorePosts() {
  if (!postsHasMore) return;
  postsCurrentPage++;
  const container = document.getElementById('postsList');
  if (!container) return;
  // 在底部显示加载指示器
  container.innerHTML += '<div class="loading posts-loading-more">${__('posts.loading')}</div>';
  const params = new URLSearchParams();
  params.set('page', postsCurrentPage);
  var pageSize = (window.__heroConfig && window.__heroConfig.posts_per_page) || 20;
  params.set('pageSize', pageSize);
  if (postsFilterType) params.set('type', postsFilterType);
  if (postsFilterUserId) params.set('userId', postsFilterUserId);

  api('/api/posts?' + params.toString())
    .then(r => r.json())
    .then(data => {
      postsCurrentPage = data.page || 1;
      postsTotalPages = data.totalPages || 1;
      postsHasMore = data.hasMore === true;
      // 移除加载指示器
      const loadingEl = container.querySelector('.posts-loading-more');
      if (loadingEl) loadingEl.remove();
      // 追加内容（不重绘已有列表）
      container.innerHTML += (data.posts || []).map(p => buildPostCard(p)).join('');
      // 为追加的图片绑定点击事件
      (data.posts || []).forEach(p => {
        if (!p.media) return;
        p.media.forEach((m, idx) => {
          if (m.mediaType !== 'image') return;
          const img = container.querySelector('.post-media-img[data-post-id="' + p.id + '"][data-idx="' + idx + '"]');
          if (img) img.addEventListener('click', function() { showPostMediaViewer(p.id, idx); });
        });
      });
      updatePostsLoadMoreBtn();
    })
    .catch(err => {
      if (isApiHandledError(err)) return;
      const loadingEl = container.querySelector('.posts-loading-more');
      if (loadingEl) loadingEl.remove();
      toast(__('posts.load_more_failed'), 'error');
    });
}

// ==================== 渲染动态卡片 ====================
function renderPosts(posts, isFirstPage) {
  const container = document.getElementById('postsList');
  if (!container) return;

  if (!posts.length) {
    if (isFirstPage) {
      container.innerHTML = '<div class="empty-state"><div class="empty-icon">📝</div><div class="empty-sub">${__('posts.empty')}</div></div>';
    }
    return;
  }

  if (isFirstPage) {
    container.innerHTML = posts.map(p => buildPostCard(p)).join('');
  } else {
    container.innerHTML += posts.map(p => buildPostCard(p)).join('');
  }

  // 绑定图片点击（首次渲染时）
  if (isFirstPage) {
    posts.forEach(p => {
      if (!p.media) return;
      p.media.forEach((m, idx) => {
        if (m.mediaType !== 'image') return;
        const img = container.querySelector('.post-media-img[data-post-id="' + p.id + '"][data-idx="' + idx + '"]');
        if (img) img.addEventListener('click', function() { showPostMediaViewer(p.id, idx); });
      });
    });
  }
}

// ==================== 构建动态卡片 HTML ====================
function buildPostCard(post) {
  var time = fmtTime(post.createdAt);
  var avatarUrl = post.user && post.user.avatarUrl ? post.user.avatarUrl : '/api/avatar/default';
  var isOwner = currentUser && currentUser.id === post.userId;
  var isAdmin = currentUser && (currentUser.role === 'super_admin' || currentUser.role === 'admin');

  var mediaHtml = '';
  if (post.media && post.media.length > 0) {
    var images = post.media.filter(function(m) { return m.mediaType === 'image'; });
    var videos = post.media.filter(function(m) { return m.mediaType === 'video'; });

    if (images.length > 0) {
      var gridClass = 'grid-4';
      if (images.length === 1) gridClass = 'single';
      else if (images.length <= 2) gridClass = 'two';
      mediaHtml += '<div class="post-media-grid ' + gridClass + '">';
      for (var i = 0; i < images.length; i++) {
        var m = images[i];
        var src = m.thumbUrl || m.mediaUrl;
        mediaHtml += '<div class="post-media-item"><img class="post-media-img" data-post-id="' + post.id + '" data-idx="' + i + '" src="' + escAttr(src) + '" alt="${__('posts.alt_image')}" loading="lazy" onerror="this.parentElement.innerHTML=\'<div class=media-error>${__('posts.load_failed')}</div>\'"></div>';
      }
      mediaHtml += '</div>';
    }

    for (var v = 0; v < videos.length; v++) {
      var vm = videos[v];
      mediaHtml += '<div class="post-video-item"><video class="post-video-player" src="' + escAttr(vm.mediaUrl) + '" controls preload="metadata" onerror="this.parentElement.innerHTML=\'<div class=media-error>${__('posts.video_load_failed')}</div>\'"></video></div>';
    }
  }

  var likeIcon = post.liked ? '❤️' : '🤍';
  var likeBtnClass = post.liked ? 'active' : '';

  var cardHtml = '<div class="post-card" data-post-id="' + post.id + '">';
  cardHtml += '<div class="post-header">';
  cardHtml += '<img class="post-avatar" src="' + escAttr(avatarUrl) + '" alt="" onerror="this.src=\'/api/avatar/default\'">';
  cardHtml += '<div class="post-user-info"><span class="post-username">' + esc(post.user ? post.user.name : __('posts.user')) + '</span><span class="post-time">' + esc(time) + '</span></div>';
  cardHtml += '<div class="post-actions-top">';
  if (post.isPinned) cardHtml += '<span class="post-pin-badge">${__('posts.pin')}</span>';
  if (isOwner || isAdmin) cardHtml += '<span class="post-menu-btn" onclick="showPostMenu(event,' + post.id + ')">⋯</span>';
  cardHtml += '</div></div>';

  if (post.content) cardHtml += '<div class="post-content">' + esc(post.content) + '</div>';
  cardHtml += mediaHtml;

  cardHtml += '<div class="post-stats"><span>❤️ ' + (post.likeCount || 0) + '</span><span>💬 ' + (post.commentCount || 0) + '</span></div>';

  cardHtml += '<div class="post-actions">';
  cardHtml += '<button class="post-action-btn ' + likeBtnClass + '" onclick="togglePostLike(' + post.id + ')"><span>' + likeIcon + '</span> <span>' + (post.liked ? __('liked') : __('like')) + '</span></button>';
  cardHtml += '<button class="post-action-btn" onclick="focusPostComment(' + post.id + ')"><span>💬</span> <span>${__('posts.comment_btn')}</span></button>';
  cardHtml += '</div>';

  // 评论预览
  if (post.comments && post.comments.length > 0) {
    cardHtml += '<div class="post-comments-preview">';
    var maxPreview = Math.min(post.comments.length, 3);
    for (var ci = 0; ci < maxPreview; ci++) {
      var c = post.comments[ci];
      var cAvatar = c.user && c.user.avatarUrl ? c.user.avatarUrl : '/api/avatar/default';
      cardHtml += '<div class="post-comment-item"><img class="post-comment-avatar" src="' + escAttr(cAvatar) + '" alt="" onerror="this.src=\'/api/avatar/default\'"><div class="post-comment-body"><span class="post-comment-name">' + esc(c.user ? c.user.name : __('posts.user')) + '</span><span class="post-comment-text">' + esc(c.content) + '</span></div></div>';
    }
    if (post.commentCount > 3) cardHtml += '<div class="post-comments-more" onclick="showPostDetail(' + post.id + ')">' + __('posts.view_all_comments', {n: post.commentCount}) + '</div>';
    cardHtml += '</div>';
  }

  cardHtml += '<div class="post-comment-input-area" id="postCommentArea-' + post.id + '" style="display:none">';
  cardHtml += '<input type="text" class="post-comment-input" id="postCommentInput-' + post.id + '" placeholder="${__('posts.placeholder')}" maxlength="2000" onkeydown="if(event.key===\'Enter\') submitPostComment(' + post.id + ')">';
  cardHtml += '<button class="post-comment-submit" onclick="submitPostComment(' + post.id + ')">' + __('posts.send_btn') + '</button>';
  cardHtml += '</div></div>';

  return cardHtml;
}

// ==================== 分页（加载更多模式） ====================
function togglePostLike(postId) {
  if (!currentUser) { toast(__('posts.login_first'), 'warning'); return; }
  api('/api/posts/' + postId + '/like', { method: 'POST', body: { content: '' } })
    .then(function(r) { return r.json(); })
    .then(function() { loadPosts(postsCurrentPage); })
    .catch(function(err) { if (!isApiHandledError(err)) toast(__('posts.op_failed'), 'error'); });
}

// ==================== 评论 ====================
function focusPostComment(postId) {
  var area = document.getElementById('postCommentArea-' + postId);
  if (!area) return;
  area.style.display = 'flex';
  var input = document.getElementById('postCommentInput-' + postId);
  if (input) input.focus();
}

function submitPostComment(postId) {
  if (!currentUser) { toast(__('posts.login_first'), 'warning'); return; }
  var input = document.getElementById('postCommentInput-' + postId);
  if (!input) return;
  var content = input.value.trim();
  if (!content) return;

  api('/api/posts/' + postId + '/comments', { method: 'POST', body: { content: content } })
    .then(function(r) { return r.json(); })
    .then(function() { input.value = ''; loadPosts(postsCurrentPage); })
    .catch(function(err) { if (!isApiHandledError(err)) toast(__('posts.comment_failed'), 'error'); });
}

// ==================== 操作菜单 ====================
function showPostMenu(event, postId) {
  event.stopPropagation();
  var menu = document.createElement('div');
  menu.className = 'post-context-menu';
  var html = '<div class="post-menu-item" onclick="deletePost(' + postId + ')">${__('posts.delete')}</div>';
  if (currentUser && (currentUser.role === 'super_admin' || currentUser.role === 'admin')) {
    html += '<div class="post-menu-item" onclick="togglePinPost(' + postId + ')">${__('posts.toggle_pin')}</div>';
  }
  menu.innerHTML = html;
  menu.style.cssText = 'position:fixed;z-index:1000;top:' + event.clientY + 'px;left:' + event.clientX + 'px;';
  document.body.appendChild(menu);
  setTimeout(function() { document.addEventListener('click', function() { menu.remove(); }, { once: true }); }, 0);
}

function deletePost(postId) {
  showConfirm(__('posts.delete_confirm'), function() {
    api('/api/posts/' + postId, { method: 'DELETE' })
      .then(function(r) { return r.json(); })
      .then(function() { toast(__('posts.deleted'), 'success'); loadPosts(postsCurrentPage); })
      .catch(function(err) { if (!isApiHandledError(err)) toast(__('posts.delete_failed'), 'error'); });
  });
}

function togglePinPost(postId) {
  api('/api/posts/' + postId + '/pin', { method: 'PUT', body: { pinned: true } })
    .then(function(r) { return r.json(); })
    .then(function(d) { toast(d.pinned ? __('posts.pinned') : __('posts.unpinned'), 'success'); loadPosts(1); })
    .catch(function(err) { if (!isApiHandledError(err)) toast(__('posts.op_failed'), 'error'); });
}

// ==================== 发布动态 ====================
function showCreatePostModal() {
  if (!currentUser) { toast(__('posts.login_first'), 'warning'); return; }
  var existing = document.getElementById('createPostModal');
  if (existing) { existing.closest('.modal-overlay').classList.add('active'); return; }

  var overlay = document.createElement('div');
  overlay.className = 'modal-overlay active';
  overlay.innerHTML = '<div class="modal create-post-modal" id="createPostModal">'
    + '<div class="modal-header"><h3>${__('posts.create_post_title')}</h3><button class="modal-close" onclick="closeCreatePostModal()">&times;</button></div>'
    + '<div class="modal-body">'
    + '<textarea class="create-post-textarea" id="createPostContent" placeholder="${__('posts.share_placeholder')}" maxlength="5000"></textarea>'
    + '<div class="create-post-preview" id="createPostPreview"></div>'
    + '<div class="create-post-options">'
    + '<label class="create-post-file-btn">${__('posts.add_media_btn')}<input type="file" accept="image/*,video/*" multiple style="display:none" id="createPostFiles" onchange="previewPostMedia(event)"></label>'
    + '<select class="create-post-visibility" id="createPostVisibility">'
    + '<option value="members_only">${__(\'posts.visibility_member\')}</option><option value="public">${__(\'posts.visibility_public\')}</option><option value="private">${__(\'posts.visibility_private\')}</option>'
    + '</select></div></div>'
    + '<div class="modal-footer"><button class="btn" onclick="closeCreatePostModal()">${__(\'posts.cancel_btn\')}</button><button class="btn btn-primary" onclick="submitCreatePost()" id="createPostBtn">${__(\'posts.publish_btn\')}</button></div></div>';
  document.body.appendChild(overlay);
  overlay.addEventListener('click', function(e) { if (e.target === overlay) closeCreatePostModal(); });
  setTimeout(function() { var el = document.getElementById('createPostContent'); if (el) el.focus(); }, 100);
}

function closeCreatePostModal() {
  // 释放所有预览 ObjectURL
  if (window._postPreviewUrls) {
    window._postPreviewUrls.forEach(function(url) { URL.revokeObjectURL(url); });
    window._postPreviewUrls = null;
  }
  var overlay = document.querySelector('.modal-overlay.active');
  if (overlay && overlay.querySelector('#createPostModal')) overlay.remove();
}

function previewPostMedia(event) {
  // 释放旧的预览 URL
  if (window._postPreviewUrls) {
    window._postPreviewUrls.forEach(function(url) { URL.revokeObjectURL(url); });
  }
  window._postPreviewUrls = [];
  var files = event.target.files;
  var preview = document.getElementById('createPostPreview');
  if (!preview) return;
  preview.innerHTML = '';
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    var url = URL.createObjectURL(f);
    window._postPreviewUrls.push(url);
    var div = document.createElement('div');
    div.className = 'create-post-preview-item';
    if (f.type.startsWith('video/')) {
      div.innerHTML = '<video src="' + url + '" height="100" controls></video><span class="preview-remove" onclick="this.parentElement.remove()">&times;</span>';
    } else {
      div.innerHTML = '<img src="' + url + '" height="100"><span class="preview-remove" onclick="this.parentElement.remove()">&times;</span>';
    }
    preview.appendChild(div);
  }
}

function submitCreatePost() {
  var contentEl = document.getElementById('createPostContent');
  var content = contentEl ? contentEl.value.trim() : '';
  var visibilityEl = document.getElementById('createPostVisibility');
  var visibility = visibilityEl ? visibilityEl.value : 'members_only';
  var fileInput = document.getElementById('createPostFiles');
  var files = fileInput ? fileInput.files : null;
  var btn = document.getElementById('createPostBtn');
  if (btn) btn.disabled = true;

  if (!content && (!files || files.length === 0)) {
    toast(__('posts.content_required'), 'warning');
    if (btn) btn.disabled = false;
    return;
  }

  var formData = new FormData();
  formData.append('content', content);
  formData.append('visibility', visibility);
  if (files) {
    for (var i = 0; i < files.length; i++) {
      formData.append('media', files[i]);
    }
  }

  apiForm('/api/posts', formData)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      toast(__('posts.created'), 'success');
      closeCreatePostModal();
      loadPosts(1);
      var tabBtn = document.querySelector('.tab-btn[data-tab="posts"]');
      if (tabBtn) tabBtn.click();
    })
    .catch(function(err) {
      if (!isApiHandledError(err)) toast(__('posts.post_failed'), 'error');
      if (btn) btn.disabled = false;
    });
}

// ==================== 动态详情查看 ====================
function showPostDetail(postId) {
  api('/api/posts/' + postId)
    .then(function(r) { return r.json(); })
    .then(function(post) {
      postsDetailCache[postId] = post;
      var overlay = document.getElementById('postDetailModalOverlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'postDetailModalOverlay';
        overlay.innerHTML = '<div class="modal post-detail-modal" id="postDetailModal">'
          + '<div class="modal-header"><h3>${__('posts.detail_title')}</h3><button class="modal-close" onclick="closePostDetail()">&times;</button></div>'
          + '<div class="modal-body" id="postDetailBody"></div>'
          + '<div class="modal-footer">'
          + '<div class="post-detail-actions"><button class="btn" id="postDetailLikeBtn">${__('posts.like_btn')}</button></div>'
          + '<div class="post-detail-comment-input"><input type="text" id="postDetailCommentInput" placeholder="${__('posts.placeholder')}" maxlength="2000" onkeydown="if(event.key===\'Enter\') submitPostDetailComment(' + postId + ')"><button class="btn btn-primary" onclick="submitPostDetailComment(' + postId + ')">${__('posts.send_btn')}</button></div>'
          + '</div></div>';
        document.body.appendChild(overlay);
        overlay.addEventListener('click', function(e) { if (e.target === overlay) closePostDetail(); });
      }
      var body = document.getElementById('postDetailBody');
      if (body) {
        body.innerHTML = buildPostCard(post);
        // 加载全部评论
        api('/api/posts/' + post.id + '/comments')
          .then(function(r2) { return r2.json(); })
          .then(function(data) {
            var cc = document.createElement('div');
            cc.className = 'post-detail-comments';
            cc.innerHTML = '<h4>${__('posts.all_comments_title')}</h4>';
            var cmts = data.comments || [];
            for (var j = 0; j < cmts.length; j++) {
              var c = cmts[j];
              var ca = c.user && c.user.avatarUrl ? c.user.avatarUrl : '/api/avatar/default';
              cc.innerHTML += '<div class="post-comment-item"><img class="post-comment-avatar" src="' + escAttr(ca) + '" alt="" onerror="this.src=\'/api/avatar/default\'"><div class="post-comment-body"><span class="post-comment-name">' + esc(c.user ? c.user.name : __('posts.user')) + '</span><span class="post-comment-text">' + esc(c.content) + '</span><span class="post-comment-time">' + fmtTime(c.createdAt) + '</span></div></div>';
            }
            if (cmts.length === 0) cc.innerHTML += '<div class="empty-state">${__('posts.no_comments')}</div>';
            body.appendChild(cc);
          });
      }
      var likeBtn = document.getElementById('postDetailLikeBtn');
      if (likeBtn) likeBtn.innerHTML = (post.liked ? __('posts.liked_btn') : __('posts.unliked_btn')) + ' (' + post.likeCount + ')';
      overlay.classList.add('active');
      document.getElementById('postDetailModal').classList.add('active');
    })
    .catch(function(err) { if (!isApiHandledError(err)) toast('${__('posts.load_failed')}', 'error'); });
}

function closePostDetail() {
  var overlay = document.getElementById('postDetailModalOverlay');
  if (overlay) overlay.remove();
}

function togglePostDetailLike(postId) {
  if (!currentUser) { toast(__('posts.login_first'), 'warning'); return; }
  api('/api/posts/' + postId + '/like', { method: 'POST', body: { content: '' } })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      var btn = document.getElementById('postDetailLikeBtn');
      if (btn) btn.innerHTML = (d.liked ? __('posts.liked_btn') : __('posts.unliked_btn')) + ' (' + d.likeCount + ')';
    })
    .catch(function(err) { if (!isApiHandledError(err)) toast(__('posts.op_failed'), 'error'); });
}

function submitPostDetailComment(postId) {
  if (!currentUser) { toast(__('posts.login_first'), 'warning'); return; }
  var input = document.getElementById('postDetailCommentInput');
  if (!input || !input.value.trim()) return;
  var content = input.value.trim();
  api('/api/posts/' + postId + '/comments', { method: 'POST', body: { content: content } })
    .then(function(r) { return r.json(); })
    .then(function() { input.value = ''; showPostDetail(postId); })
    .catch(function(err) { if (!isApiHandledError(err)) toast(__('posts.comment_failed'), 'error'); });
}

// ==================== 图片查看器 ====================
function showPostMediaViewer(postId, idx) {
  var post = postsDetailCache[postId];
  var images = [];
  if (post && post.media) {
    for (var i = 0; i < post.media.length; i++) {
      if (post.media[i].mediaType === 'image') images.push(post.media[i]);
    }
  }
  if (!images.length) return;

  var viewer = document.createElement('div');
  viewer.className = 'media-viewer-overlay';
  viewer.dataset.postId = postId;
  viewer.dataset.currentIdx = idx;
  viewer.innerHTML = '<button class="media-viewer-close" onclick="this.parentElement.remove()">&times;</button>'
    + '<div class="media-viewer-content"><img src="' + escAttr(images[idx].mediaUrl || images[idx].thumbUrl) + '" class="media-viewer-img" id="mediaViewerImg"></div>'
    + '<div class="media-viewer-nav">'
    + '<button class="btn btn-xs" onclick="navigateMediaViewer(-1)">${__('posts.prev')}</button>'
    + '<span id="mediaViewerCounter">' + (idx + 1) + ' / ' + images.length + '</span>'
    + '<button class="btn btn-xs" onclick="navigateMediaViewer(1)">${__('posts.next')}</button></div>';
  document.body.appendChild(viewer);
  viewer.addEventListener('click', function(e) { if (e.target === viewer) viewer.remove(); });

  function keyHandler(e) {
    if (e.key === 'Escape') { viewer.remove(); document.removeEventListener('keydown', keyHandler); }
    if (e.key === 'ArrowLeft') navigateMediaViewer(-1);
    if (e.key === 'ArrowRight') navigateMediaViewer(1);
  }
  document.addEventListener('keydown', keyHandler);
}

function navigateMediaViewer(delta) {
  var viewer = document.querySelector('.media-viewer-overlay');
  if (!viewer) return;
  var postId = parseInt(viewer.dataset.postId);
  var idx = parseInt(viewer.dataset.currentIdx);
  var post = postsDetailCache[postId];
  var images = [];
  if (post && post.media) {
    for (var i = 0; i < post.media.length; i++) {
      if (post.media[i].mediaType === 'image') images.push(post.media[i]);
    }
  }
  if (!images.length) return;
  idx = (idx + delta + images.length) % images.length;
  viewer.dataset.currentIdx = idx;
  var img = document.getElementById('mediaViewerImg');
  if (img) img.src = images[idx].mediaUrl || images[idx].thumbUrl;
  var counter = document.getElementById('mediaViewerCounter');
  if (counter) counter.textContent = (idx + 1) + ' / ' + images.length;
}

// ==================== 类型筛选 ====================
function filterPostsByType(type) {
  postsFilterType = type;
  postsCurrentPage = 1;
  loadPosts(1);
}
