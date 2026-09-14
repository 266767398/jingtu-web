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
let postsFilterDate = ''; // VN-12 日期筛选（YYYY-MM-DD，空=全部）
let postsDetailCache = {};

// VN-10 每页条数可配置（localStorage 记忆，VRCNext TL_PAGE_SIZES 借鉴）
const POSTS_PAGE_SIZES = [10, 20, 50, 100];
let postsPageSize = (function() {
  try {
    var saved = parseInt(localStorage.getItem('jt_posts_page_size'), 10);
    if (saved && POSTS_PAGE_SIZES.indexOf(saved) !== -1) return saved;
  } catch (e) {}
  return (window.__heroConfig && window.__heroConfig.posts_per_page) || 20;
})();

// ==================== 加载动态列表 ====================
let postsLoading = false;
let postsKeepScroll = false; // VN-8 滚动位置保持开关（VRCNext lvKeepScroll 借鉴）
let postsSavedScrollTop = 0;

function getPostsScrollEl() {
  // 优先找时间线列表的滚动容器，退化为 window
  var wrap = document.querySelector('#tab-posts');
  if (!wrap) return window;
  // 主内容区域滚动：找设置了 overflow 的祖先
  var el = document.getElementById('postsList');
  while (el && el !== wrap) {
    var s = window.getComputedStyle(el);
    if (/(auto|scroll|overlay)/.test(s.overflowY)) return el;
    el = el.parentElement;
  }
  return window;
}

function loadPosts(page) {
  page = page || 1;
  const container = document.getElementById('postsList');
  if (!container) return;
  if (postsLoading && page !== postsCurrentPage) return;
  postsLoading = true;
  const isFirstPage = page === 1;
  const scrollEl = getPostsScrollEl();
  if (isFirstPage && postsKeepScroll && scrollEl) {
    postsKeepScroll = false;
    postsSavedScrollTop = scrollEl.scrollTop;
  }
  if (isFirstPage) showSkeleton(container, 'rows', 4);

  const params = new URLSearchParams();
  params.set('page', page);
  params.set('pageSize', postsPageSize);
  if (postsFilterType) params.set('type', postsFilterType);
  if (postsFilterUserId) params.set('userId', postsFilterUserId);
  if (postsFilterDate) params.set('date', postsFilterDate);

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
      renderEmpty(container, { icon: '📝', text: __('posts.load_failed') });
    })
    .finally(() => { postsLoading = false; });
}

// ==================== __('auto_posts_1')按钮控制 ====================
function updatePostsLoadMoreBtn() {
  const btn = document.getElementById('postsLoadMoreBtn');
  if (!btn) return;
  if (postsHasMore) showEl(btn); else hideEl(btn);
}

function loadMorePosts() {
  if (!postsHasMore || postsLoading) return;
  postsLoading = true;
  postsCurrentPage++;
  const container = document.getElementById('postsList');
  if (!container) { postsLoading = false; return; }
  container.innerHTML += '<div class="posts-loading-more"><div class="jt-skel jt-skel-rows" style="--n:1"></div></div>';
  const params = new URLSearchParams();
  params.set('page', postsCurrentPage);
  params.set('pageSize', postsPageSize);
  if (postsFilterType) params.set('type', postsFilterType);
  if (postsFilterUserId) params.set('userId', postsFilterUserId);
  if (postsFilterDate) params.set('date', postsFilterDate);

  api('/api/posts?' + params.toString())
    .then(r => r.json())
    .then(data => {
      postsCurrentPage = data.page || 1;
      postsTotalPages = data.totalPages || 1;
      postsHasMore = data.hasMore === true;
      const loadingEl = container.querySelector('.posts-loading-more');
      if (loadingEl) loadingEl.remove();
      container.innerHTML += (data.posts || []).map(p => buildPostCard(p)).join('');
      updatePostsLoadMoreBtn();
    })
    .catch(err => {
      if (isApiHandledError(err)) return;
      const loadingEl = container.querySelector('.posts-loading-more');
      if (loadingEl) loadingEl.remove();
      toast(__('posts.load_more_failed'), 'error');
    })
    .finally(() => { postsLoading = false; });
}

// ==================== 渲染动态卡片 ====================
function renderPosts(posts, isFirstPage) {
  const container = document.getElementById('postsList');
  if (!container) return;

  if (!posts.length) {
    if (isFirstPage) {
      renderEmpty(container, { icon: '📝', text: __('posts.empty') });
    }
    return;
  }

  if (isFirstPage) {
    container.innerHTML = posts.map(p => buildPostCard(p)).join('');
    // VN-8 滚动位置保持：渲染完成后恢复（VRCNext lvKeepScroll 借鉴）
    if (postsSavedScrollTop > 0) {
      var sc = getPostsScrollEl();
      var target = postsSavedScrollTop;
      postsSavedScrollTop = 0;
      requestAnimationFrame(function() {
        if (sc === window) window.scrollTo(0, target);
        else sc.scrollTop = target;
      });
    }
  } else {
    container.innerHTML += posts.map(p => buildPostCard(p)).join('');
  }
}

// ==================== 构建动态卡片 HTML ====================
function buildPostCard(post) {
  const time = fmtTime(post.createdAt);
  const avatarUrl = post.user && post.user.avatarUrl ? post.user.avatarUrl : '/api/avatar/default';
  const isOwner = currentUser && currentUser.id === post.userId;
  const isAdmin = currentUser && (currentUser.role === 'super_admin' || currentUser.role === 'admin');

  let mediaHtml = '';
  if (post.media && post.media.length > 0) {
    const images = post.media.filter(function(m) { return m.mediaType === 'image'; });
    const videos = post.media.filter(function(m) { return m.mediaType === 'video'; });

    if (images.length > 0) {
      let gridClass = 'grid-4';
      if (images.length === 1) gridClass = 'single';
      else if (images.length <= 2) gridClass = 'two';
      mediaHtml += '<div class="post-media-grid ' + gridClass + '">';
      for (let i = 0; i < images.length; i++) {
        const m = images[i];
        const src = m.thumbUrl || m.mediaUrl;
        mediaHtml += '<div class="post-media-item"><img class="post-media-img" data-post-id="' + post.id + '" data-idx="' + i + '" src="' + escAttr(src) + '" alt="' + __('posts.alt_image') + '" loading="lazy" onerror="this.parentElement.innerHTML=\'<div class=media-error>' + __('posts.load_failed') + '</div>\'"></div>';
      }
      mediaHtml += '</div>';
    }

    for (let v = 0; v < videos.length; v++) {
      const vm = videos[v];
      mediaHtml += '<div class="post-video-item"><video class="post-video-player" src="' + escAttr(vm.mediaUrl) + '" controls preload="metadata" onerror="this.parentElement.innerHTML=\'<div class=media-error>' + __('posts.video_load_failed') + '</div>\'"></video></div>';
    }
  }

  const likeIcon = post.liked ? '❤️' : '🤍';
  const likeBtnClass = post.liked ? 'active' : '';

  let cardHtml = '<div class="post-card" data-post-id="' + post.id + '">';
  cardHtml += '<div class="post-header">';
  cardHtml += '<img class="post-avatar" src="' + escAttr(avatarUrl) + '" alt="" onerror="this.src=\'/api/avatar/default\'">';
  cardHtml += '<div class="post-user-info"><span class="post-username">' + esc(post.user ? post.user.name : __('posts.user')) + '</span><span class="post-time">' + esc(time) + '</span></div>';
  cardHtml += '<div class="post-actions-top">';
  if (post.isPinned) cardHtml += '<span class="post-pin-badge">' + __('posts.pin') + '</span>';
  if (isOwner || isAdmin) cardHtml += '<span class="post-menu-btn" tabindex="0" role="button" aria-label="' + esc(__('posts.aria_more_actions')) + '" onclick="showPostMenu(event,' + post.id + ')">⋯</span>';
  cardHtml += '</div></div>';

  if (post.content) cardHtml += '<div class="post-content">' + esc(post.content) + '</div>';
  cardHtml += mediaHtml;

  cardHtml += '<div class="post-stats"><span data-like-count="' + (post.likeCount || 0) + '">❤️ ' + (post.likeCount || 0) + '</span><span data-comment-count="' + (post.commentCount || 0) + '">💬 ' + (post.commentCount || 0) + '</span></div>';

  cardHtml += '<div class="post-actions">';
  cardHtml += '<button class="post-action-btn ' + likeBtnClass + '" onclick="togglePostLike(' + post.id + ')"><span>' + likeIcon + '</span> <span>' + (post.liked ? __('liked') : __('like')) + '</span></button>';
  cardHtml += '<button class="post-action-btn" onclick="focusPostComment(' + post.id + ')"><span>💬</span> <span>' + __('posts.comment_btn') + '</span></button>';
  cardHtml += '</div>';

  // 评论预览
  if (post.comments && post.comments.length > 0) {
    cardHtml += '<div class="post-comments-preview">';
    const maxPreview = Math.min(post.comments.length, 3);
    for (let ci = 0; ci < maxPreview; ci++) {
      const c = post.comments[ci];
      const cAvatar = c.user && c.user.avatarUrl ? c.user.avatarUrl : '/api/avatar/default';
      cardHtml += '<div class="post-comment-item"><img class="post-comment-avatar" src="' + escAttr(cAvatar) + '" alt="" onerror="this.src=\'/api/avatar/default\'"><div class="post-comment-body"><span class="post-comment-name">' + esc(c.user ? c.user.name : __('posts.user')) + '</span><span class="post-comment-text">' + esc(c.content) + '</span></div></div>';
    }
    if (post.commentCount > 3) cardHtml += '<div class="post-comments-more" onclick="showPostDetail(' + post.id + ')">' + __('posts.view_all_comments', {n: post.commentCount}) + '</div>';
    cardHtml += '</div>';
  }

  cardHtml += '<div class="post-comment-input-area" id="postCommentArea-' + post.id + '" style="display:none">';
  cardHtml += '<input type="text" class="post-comment-input" id="postCommentInput-' + post.id + '" placeholder="' + __('posts.placeholder') + '" maxlength="2000" onkeydown="if(event.key===\'Enter\') submitPostComment(' + post.id + ')">';
  cardHtml += '<button class="post-comment-submit" onclick="submitPostComment(' + post.id + ')">' + __('posts.send_btn') + '</button>';
  cardHtml += '</div></div>';

  return cardHtml;
}

// ==================== 分页（加载更多模式） ====================
function togglePostLike(postId) {
  if (!currentUser) { toast(__('posts.login_first'), 'warning'); return; }
  const card = document.querySelector('.post-card[data-post-id="' + postId + '"]');
  if (!card) return;
  const likeBtn = card.querySelector('.post-action-btn');
  const likeCountEl = card.querySelector('.post-stats span:first-child');
  const isLiked = likeBtn && likeBtn.classList.contains('active');
  
  if (isLiked) {
    likeBtn.classList.remove('active');
    likeBtn.innerHTML = '<span>🤍</span> <span>' + __('like') + '</span>';
    if (likeCountEl) {
      const count = parseInt(likeCountEl.getAttribute('data-like-count')) || 0;
      const newCount = Math.max(0, count - 1);
      likeCountEl.setAttribute('data-like-count', newCount);
      likeCountEl.textContent = '❤️ ' + newCount;
    }
  } else {
    likeBtn.classList.add('active');
    likeBtn.innerHTML = '<span>❤️</span> <span>' + __('liked') + '</span>';
    if (likeCountEl) {
      const count = parseInt(likeCountEl.getAttribute('data-like-count')) || 0;
      const newCount = count + 1;
      likeCountEl.setAttribute('data-like-count', newCount);
      likeCountEl.textContent = '❤️ ' + newCount;
    }
  }

  // 动效反馈：心爆裂（点赞）/ 小回弹（取消）。likes-anim.css 实现，prefers-reduced-motion 会自动降级。
  // 在乐观 UI 已更新后立即触发，无需等服务端返回，避免「点完有 0.5 秒没反应」
  try { if (window.SITE_LIKE) window.SITE_LIKE.triggerBurst(likeBtn, !isLiked); } catch (e) { /* 静默 */ }
  
  // api() 对 400/404 不会抛异常，必须显式检查 res.ok，否则乐观 UI 永远不会回滚
  function rollbackLike() {
    if (isLiked) {
      likeBtn.classList.add('active');
      likeBtn.innerHTML = '<span>❤️</span> <span>' + __('liked') + '</span>';
      if (likeCountEl) {
        const count = parseInt(likeCountEl.getAttribute('data-like-count')) || 0;
        const newCount = count + 1;
        likeCountEl.setAttribute('data-like-count', newCount);
        likeCountEl.textContent = '❤️ ' + newCount;
      }
    } else {
      likeBtn.classList.remove('active');
      likeBtn.innerHTML = '<span>🤍</span> <span>' + __('like') + '</span>';
      if (likeCountEl) {
        const count = parseInt(likeCountEl.getAttribute('data-like-count')) || 0;
        const newCount = Math.max(0, count - 1);
        likeCountEl.setAttribute('data-like-count', newCount);
        likeCountEl.textContent = '❤️ ' + newCount;
      }
    }
  }

  api('/api/posts/' + postId + '/like', { method: 'POST', body: { content: '' } })
    .then(function(res) {
      if (!res.ok) {
        toast(__('posts.op_failed'), 'error');
        rollbackLike();
      }
    })
    .catch(function(err) {
      if (!isApiHandledError(err)) {
        toast(__('posts.op_failed'), 'error');
        rollbackLike();
      }
    });
}

// ==================== 评论 ====================
function focusPostComment(postId) {
  const area = document.getElementById('postCommentArea-' + postId);
  if (!area) return;
  area.style.display = 'flex';
  const input = document.getElementById('postCommentInput-' + postId);
  if (input) input.focus();
}

function submitPostComment(postId) {
  if (!currentUser) { toast(__('posts.login_first'), 'warning'); return; }
  const input = document.getElementById('postCommentInput-' + postId);
  if (!input) return;
  const content = input.value.trim();
  if (!content) return;

  const card = document.querySelector('.post-card[data-post-id="' + postId + '"]');
  const commentCountEl = card ? card.querySelector('.post-stats span:last-child') : null;
  
  if (commentCountEl) {
    const count = parseInt(commentCountEl.getAttribute('data-comment-count')) || 0;
    const newCount = count + 1;
    commentCountEl.setAttribute('data-comment-count', newCount);
    commentCountEl.textContent = '💬 ' + newCount;
  }
  
  const previewArea = card ? card.querySelector('.post-comments-preview') : null;
  // newComment 必须提升到 if 块外：旧实现用 const 声明在块内，
  // 回滚分支引用它会抛 ReferenceError，导致回滚静默失败。
  let newComment = null;
  if (previewArea) {
    const avatarUrl = currentUser.avatarUrl || '/api/avatar/default';
    newComment = document.createElement('div');
    newComment.className = 'post-comment-item';
    newComment.innerHTML = '<img class="post-comment-avatar" src="' + escAttr(avatarUrl) + '" alt="" onerror="this.src=\'/api/avatar/default\'"><div class="post-comment-body"><span class="post-comment-name">' + esc(currentUser.displayName || currentUser.loginId) + '</span><span class="post-comment-text">' + esc(content) + '</span></div>';
    previewArea.appendChild(newComment);
    const moreLink = previewArea.querySelector('.post-comments-more');
    if (moreLink) moreLink.remove();
  }

  input.value = '';
  const area = document.getElementById('postCommentArea-' + postId);
  if (area) area.style.display = 'none';

  // api() 对 400/404 不会抛异常，必须显式检查 res.ok
  function rollbackComment() {
    if (commentCountEl) {
      const count = parseInt(commentCountEl.getAttribute('data-comment-count')) || 0;
      const newCount = Math.max(0, count - 1);
      commentCountEl.setAttribute('data-comment-count', newCount);
      commentCountEl.textContent = '💬 ' + newCount;
    }
    if (previewArea && newComment && newComment.parentNode === previewArea) {
      previewArea.removeChild(newComment);
    }
    // 失败时把内容还给用户，避免辛苦打的评论丢失
    input.value = content;
  }

  api('/api/posts/' + postId + '/comments', { method: 'POST', body: { content: content } })
    .then(function(res) {
      if (!res.ok) {
        toast(__('posts.comment_failed'), 'error');
        rollbackComment();
      }
    })
    .catch(function(err) {
      if (!isApiHandledError(err)) {
        toast(__('posts.comment_failed'), 'error');
        rollbackComment();
      }
    });
}

// ==================== 操作菜单 ====================
function showPostMenu(event, postId) {
  event.stopPropagation();
  const menu = document.createElement('div');
  menu.className = 'post-context-menu';
  let html = '<div class="post-menu-item" onclick="editPost(' + postId + ')">' + __('posts.edit') + '</div>';
  html += '<div class="post-menu-item" onclick="deletePost(' + postId + ')">' + __('posts.delete') + '</div>';
  if (currentUser && (currentUser.role === 'super_admin' || currentUser.role === 'admin')) {
    html += '<div class="post-menu-item" onclick="togglePinPost(' + postId + ')">' + __('posts.toggle_pin') + '</div>';
  }
  menu.innerHTML = html;
  menu.style.cssText = 'position:fixed;z-index:1000;top:' + event.clientY + 'px;left:' + event.clientX + 'px;';
  document.body.appendChild(menu);
  // 边界 clamp：避免菜单在视口右下角溢出导致看不到/点不到
  const rect = menu.getBoundingClientRect();
  const pad = 8;
  let top = rect.top, left = rect.left;
  if (left + rect.width > window.innerWidth - pad) {
    left = window.innerWidth - rect.width - pad;
  }
  if (top + rect.height > window.innerHeight - pad) {
    top = window.innerHeight - rect.height - pad;
  }
  if (left < pad) left = pad;
  if (top < pad) top = pad;
  menu.style.top = top + 'px';
  menu.style.left = left + 'px';
  setTimeout(function() { document.addEventListener('click', function() { menu.remove(); }, { once: true }); }, 0);
}

function deletePost(postId) {
  showConfirm(__('posts.delete_confirm'), function() {
    api('/api/posts/' + postId, { method: 'DELETE' })
      .then(function(r) { return r.json().then(function(data) { return { ok: r.ok, data: data }; }).catch(function() { return { ok: false, data: null }; }); })
      .then(function(r2) {
        // 4xx 等非抛错失败也会 resolve 到这里：不校验成功标记就弹「删除成功」是假成功
        if (r2.ok && r2.data && r2.data.success !== false) {
          toast(__('posts.deleted'), 'success');
          loadPosts(postsCurrentPage);
        } else {
          toast(__('posts.delete_failed'), 'error');
        }
      })
      .catch(function(err) { if (!isApiHandledError(err)) toast(__('posts.delete_failed'), 'error'); });
  });
}

function editPost(postId) {
  api('/api/posts/' + postId)
    .then(function(r) { return r.json(); })
    .then(function(post) {
      var existing = document.getElementById('editPostModal');
      if (existing) { existing.closest('.modal-overlay').remove(); }

      var overlay = document.createElement('div');
      overlay.className = 'modal-overlay active';
      overlay.innerHTML = '<div class="modal create-post-modal" id="editPostModal">'
        + '<div class="modal-header"><h3>' + __('posts.edit_post_title') + '</h3><button class="modal-close" onclick="closeEditPostModal()">&times;</button></div>'
        + '<div class="modal-body">'
        + '<textarea class="create-post-textarea" id="editPostContent" placeholder="' + __('posts.share_placeholder') + '" maxlength="5000">' + esc(post.content) + '</textarea>'
        + '<div class="create-post-preview" id="editPostPreview"></div>'
        + '<div class="create-post-options">'
        + '<label class="create-post-file-btn">' + __('posts.add_media_btn') + '<input type="file" accept="image/*,video/*" multiple style="display:none" id="editPostFiles" onchange="previewEditPostMedia(event)"></label>'
        + '<select class="create-post-visibility" id="editPostVisibility">'
        + '<option value="members_only"' + (post.visibility === 'members_only' ? ' selected' : '') + '>' + __('posts.visibility_member') + '</option>'
        + '<option value="public"' + (post.visibility === 'public' ? ' selected' : '') + '>' + __('posts.visibility_public') + '</option>'
        + '<option value="private"' + (post.visibility === 'private' ? ' selected' : '') + '>' + __('posts.visibility_private') + '</option>'
        + '</select></div></div>'
        + '<div class="modal-footer"><button type="button" class="btn" onclick="closeEditPostModal()">' + __('posts.cancel_btn') + '</button><button class="btn btn-primary" onclick="submitEditPost(' + postId + ')" id="editPostBtn">' + __('posts.save_btn') + '</button></div></div>';
      document.body.appendChild(overlay);
      overlay.addEventListener('click', function(e) { if (e.target === overlay) closeEditPostModal(); });

      var preview = document.getElementById('editPostPreview');
      if (preview && post.media && post.media.length > 0) {
        window._editPostMediaIds = [];
        window._editPostPreviewUrls = [];
        post.media.forEach(function(m) {
          var div = document.createElement('div');
          div.className = 'create-post-preview-item';
          div.setAttribute('data-media-id', m.id);
          window._editPostMediaIds.push(m.id);
          if (m.mediaType === 'video') {
            div.innerHTML = '<video src="/' + escAttr(m.mediaUrl) + '" height="100" controls></video><span class="preview-remove" onclick="removeEditPostMedia(this)">&times;</span>';
          } else {
            div.innerHTML = '<img src="/' + escAttr(m.mediaUrl) + '" height="100"><span class="preview-remove" onclick="removeEditPostMedia(this)">&times;</span>';
          }
          preview.appendChild(div);
        });
      }
    })
    .catch(function(err) { toast(__('posts.load_failed'), 'error'); });
}

function closeEditPostModal() {
  if (window._editPostPreviewUrls) {
    window._editPostPreviewUrls.forEach(function(url) { URL.revokeObjectURL(url); });
    window._editPostPreviewUrls = null;
  }
  // 按 id 直接定位自己的遮罩。原先用 querySelector('.modal-overlay.active')
  // 取的是文档里第一个激活遮罩 —— 同时开着别的模态框时会删错人，
  // 而本模态框留在 DOM 里、按钮还是 disabled，下次打开就再也提交不了。
  var modal = document.getElementById('editPostModal');
  var overlay = modal && modal.closest('.modal-overlay');
  if (overlay) overlay.remove();
}

function previewEditPostMedia(event) {
  if (window._editPostPreviewUrls) {
    window._editPostPreviewUrls.forEach(function(url) { URL.revokeObjectURL(url); });
  }
  window._editPostPreviewUrls = [];
  var files = event.target.files;
  var preview = document.getElementById('editPostPreview');
  if (!preview) return;
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    var url = URL.createObjectURL(f);
    window._editPostPreviewUrls.push(url);
    var div = document.createElement('div');
    div.className = 'create-post-preview-item';
    if (f.type.startsWith('video/')) {
      div.innerHTML = '<video src="' + url + '" height="100" controls></video><span class="preview-remove" onclick="removeEditPostMedia(this)">&times;</span>';
    } else {
      div.innerHTML = '<img src="' + url + '" height="100"><span class="preview-remove" onclick="removeEditPostMedia(this)">&times;</span>';
    }
    preview.appendChild(div);
  }
}

function removeEditPostMedia(el) {
  var div = el.parentElement;
  var mediaId = div.getAttribute('data-media-id');
  if (mediaId) {
    if (!window._removedMediaIds) window._removedMediaIds = [];
    window._removedMediaIds.push(parseInt(mediaId));
  }
  div.remove();
}

function submitEditPost(postId) {
  var contentEl = document.getElementById('editPostContent');
  var content = contentEl ? contentEl.value.trim() : '';
  var visibilityEl = document.getElementById('editPostVisibility');
  var visibility = visibilityEl ? visibilityEl.value : 'members_only';
  var fileInput = document.getElementById('editPostFiles');
  var files = fileInput ? fileInput.files : null;
  var btn = document.getElementById('editPostBtn');
  if (btn) btn.disabled = true;

  if (!content && (!files || files.length === 0) && (!window._removedMediaIds || window._removedMediaIds.length === 0)) {
    toast(__('posts.content_required'), 'warning');
    if (btn) btn.disabled = false;
    return;
  }

  var formData = new FormData();
  formData.append('content', content);
  formData.append('visibility', visibility);
  if (window._removedMediaIds && window._removedMediaIds.length > 0) {
    formData.append('removeMediaIds', JSON.stringify(window._removedMediaIds));
  }
  if (files) {
    for (var i = 0; i < files.length; i++) {
      formData.append('media', files[i]);
    }
  }

  apiForm('/api/posts/' + postId, formData, { method: 'PUT' })
    .then(function(r) {
      // apiForm 只对 401/403/429/5xx 抛错，400（内容超长、文件类型不支持等）
      // 会直接走到这里。不判 r.ok 就会在什么都没保存的情况下弹__('auto_posts_2')。
      return r.json().catch(function() { return {}; }).then(function(data) {
        if (!r.ok) throw new Error(data.error || __('posts.edit_failed'));
        return data;
      });
    })
    .then(function() {
      toast(__('posts.edited'), 'success');
      closeEditPostModal();
      loadPosts(postsCurrentPage);
    })
    .catch(function(err) {
      if (!isApiHandledError(err)) toast(err.message || __('posts.edit_failed'), 'error');
    })
    .finally(function() {
      // 成功时模态框已被移除，这句无害；失败时必须让用户能再点一次。
      if (btn) btn.disabled = false;
    });
}

function togglePinPost(postId) {
  const card = document.querySelector('.post-card[data-post-id="' + postId + '"]');
  const isPinned = card && card.querySelector('.post-pin-badge');
  api('/api/posts/' + postId + '/pin', { method: 'PUT', body: { pinned: !isPinned } })
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
    + '<div class="modal-header"><h3>' + __('posts.create_post_title') + '</h3><button class="modal-close" onclick="closeCreatePostModal()">&times;</button></div>'
    + '<div class="modal-body">'
    + '<textarea class="create-post-textarea" id="createPostContent" placeholder="' + __('posts.share_placeholder') + '" maxlength="5000"></textarea>'
    + '<div class="create-post-preview" id="createPostPreview"></div>'
    + '<div class="create-post-options">'
    + '<label class="create-post-file-btn">' + __('posts.add_media_btn') + '<input type="file" accept="image/*,video/*" multiple style="display:none" id="createPostFiles" onchange="previewPostMedia(event)"></label>'
    + '<select class="create-post-visibility" id="createPostVisibility">'
    + '<option value="members_only">' + __('posts.visibility_member') + '</option><option value="public">' + __('posts.visibility_public') + '</option><option value="private">' + __('posts.visibility_private') + '</option>'
    + '</select></div></div>'
    + '<div class="modal-footer"><button type="button" class="btn" onclick="closeCreatePostModal()">' + __('posts.cancel_btn') + '</button><button class="btn btn-primary" onclick="submitCreatePost()" id="createPostBtn">' + __('posts.publish_btn') + '</button></div></div>';
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
  var modal = document.getElementById('createPostModal');
  var overlay = modal && modal.closest('.modal-overlay');
  if (overlay) overlay.remove();
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
    .then(function(r) {
      // 同 submitEditPost：400 不会抛，必须自己判，
      // 否则内容被服务端拒了还会弹__('auto_posts_3')，用户以为发出去了。
      return r.json().catch(function() { return {}; }).then(function(data) {
        if (!r.ok) throw new Error(data.error || __('posts.post_failed'));
        return data;
      });
    })
    .then(function() {
      toast(__('posts.created'), 'success');
      closeCreatePostModal();
      loadPosts(1);
      var tabBtn = document.querySelector('.tab-btn[data-tab="posts"]');
      if (tabBtn) tabBtn.click();
    })
    .catch(function(err) {
      if (!isApiHandledError(err)) toast(err.message || __('posts.post_failed'), 'error');
    })
    .finally(function() {
      if (btn) btn.disabled = false;
    });
}

// ==================== 动态详情查看 ====================
// 弹窗归属守卫（统一防串台机制，见 core.js createFastModal）
const postDetailOpener = createFastModal('postDetail');

function openPostDetailModal(postId) {
  var overlay = document.getElementById('postDetailModalOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'postDetailModalOverlay';
    overlay.innerHTML = '<div class="modal post-detail-modal" id="postDetailModal">'
      + '<div class="modal-header"><h3>' + __('posts.detail_title') + '</h3><button class="modal-close" onclick="closePostDetail()">&times;</button></div>'
      + '<div class="modal-body" id="postDetailBody"></div>'
      + '<div class="modal-footer">'
      + '<div class="post-detail-actions"><button class="btn" id="postDetailLikeBtn">' + __('posts.like_btn') + '</button><button class="btn" id="postDetailShareBtn">' + __('posts.share_btn') + '</button></div>'
      + '<div class="post-detail-comment-input"><input type="text" id="postDetailCommentInput" placeholder="' + __('posts.placeholder') + '" maxlength="2000" onkeydown="if(event.key===\'Enter\') submitPostDetailComment(' + postId + ')"><button class="btn btn-primary" onclick="submitPostDetailComment(' + postId + ')">' + __('posts.send_btn') + '</button></div>'
      + '</div></div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', function(e) { if (e.target === overlay) closePostDetail(); });
  }
  return overlay;
}

function paintPostDetail(post) {
  var overlay = openPostDetailModal(post.id);
  var body = document.getElementById('postDetailBody');
  if (body) {
    body.innerHTML = buildPostCard(post);
    // 加载全部评论
    api('/api/posts/' + post.id + '/comments')
      .then(function(r2) { return r2.json(); })
      .then(function(data) {
        if (postDetailOpener.stale(String(post.id))) return; // 已切换到其它动态，丢弃过期评论
        var cc = document.createElement('div');
        cc.className = 'post-detail-comments';
        cc.innerHTML = '<h4>' + __('posts.all_comments_title') + '</h4>';
        var cmts = data.comments || [];
        for (var j = 0; j < cmts.length; j++) {
          var c = cmts[j];
          var ca = c.user && c.user.avatarUrl ? c.user.avatarUrl : '/api/avatar/default';
          var canEdit = currentUser && (currentUser.id === (c.user ? c.user.id : null) || currentUser.role === 'super_admin' || currentUser.role === 'admin');
          var actions = canEdit
            ? '<span class="post-comment-actions"><button class="btn-text" onclick="editPostComment(' + post.id + ',' + c.id + ')">' + __('edit') + '</button><button class="btn-text" onclick="deletePostComment(' + post.id + ',' + c.id + ')">' + __('delete') + '</button></span>'
            : '';
          cc.innerHTML += '<div class="post-comment-item" data-comment-id="' + c.id + '"><img class="post-comment-avatar" src="' + escAttr(ca) + '" alt="" onerror="this.src=\'/api/avatar/default\'"><div class="post-comment-body"><span class="post-comment-name">' + esc(c.user ? c.user.name : __('posts.user')) + '</span><span class="post-comment-text" id="postCommentText-' + c.id + '">' + esc(c.content) + '</span><span class="post-comment-time">' + fmtTime(c.createdAt) + '</span>' + actions + '</div></div>';
        }
        if (cmts.length === 0) cc.innerHTML += (function(){ var w=document.createElement('div'); renderEmpty(w, { icon: '💬', text: __('posts.no_comments') }); return w.innerHTML; })();
        body.appendChild(cc);
      })
      .catch(function() {});
  }
  var likeBtn = document.getElementById('postDetailLikeBtn');
  if (likeBtn) likeBtn.innerHTML = (post.liked ? __('posts.liked_btn') : __('posts.unliked_btn')) + ' (' + post.likeCount + ')';
  var shareBtn = document.getElementById('postDetailShareBtn');
  if (shareBtn) shareBtn.onclick = function () { sharePublicLink('post', post.id); };
  overlay.classList.add('active');
  document.getElementById('postDetailModal').classList.add('active');
}

function showPostDetail(postId) {
  if (!postId) return;
  var token = postDetailOpener.begin(postId); // 锁定归属，覆盖任何进行中的旧请求
  // 1) 先秒开内存缓存（列表点进来时已有），立即弹出，零网络等待
  if (postsDetailCache[postId]) {
    paintPostDetail(postsDetailCache[postId]);
  }
  // 2) 后台刷新最新数据（含评论），不阻塞弹出
  api('/api/posts/' + postId)
    .then(function(r) { return r.json(); })
    .then(function(post) {
      if (postDetailOpener.stale(token)) return; // 已切换到其它动态/关闭，丢弃过期响应
      postsDetailCache[postId] = post;
      paintPostDetail(post);
    })
    .catch(function(err) {
      if (postDetailOpener.stale(token)) return;
      // 仅在无缓存时提示错误；有缓存则保留缓存内容
      if (!postsDetailCache[postId] && !isApiHandledError(err)) toast(__('posts.load_failed'), 'error');
    });
}

function closePostDetail() {
  var overlay = document.getElementById('postDetailModalOverlay');
  if (overlay) overlay.remove();
}

function togglePostDetailLike(postId) {
  if (!currentUser) { toast(__('posts.login_first'), 'warning'); return; }
  api('/api/posts/' + postId + '/like', { method: 'POST', body: { content: '' } })
    .then(function(r) { return r.json().then(function(data) { return { ok: r.ok, data: data }; }); })
    .then(function(r2) {
      if (!r2.ok || !r2.data || r2.data.liked === undefined) {
        // 失败/异常包络：重取详情恢复真实计数，避免渲染「( undefined )」假成功
        showPostDetail(postId);
        toast(__('posts.op_failed'), 'error');
        return;
      }
      var btn = document.getElementById('postDetailLikeBtn');
      if (btn) btn.innerHTML = (r2.data.liked ? __('posts.liked_btn') : __('posts.unliked_btn')) + ' (' + r2.data.likeCount + ')';
    })
    .catch(function(err) { if (!isApiHandledError(err)) toast(__('posts.op_failed'), 'error'); });
}

function submitPostDetailComment(postId) {
  if (!currentUser) { toast(__('posts.login_first'), 'warning'); return; }
  var input = document.getElementById('postDetailCommentInput');
  if (!input || !input.value.trim()) return;
  var content = input.value.trim();
  api('/api/posts/' + postId + '/comments', { method: 'POST', body: { content: content } })
    .then(function(r) { return r.json().then(function(data) { return { ok: r.ok, data: data }; }); })
    .then(function(r2) {
      // 只有确认成功才清空输入框；失败保留内容，用户不必重打
      if (r2.ok && r2.data && r2.data.success !== false) {
        input.value = '';
        showPostDetail(postId);
      } else {
        toast(__('posts.comment_failed'), 'error');
      }
    })
    .catch(function(err) { if (!isApiHandledError(err)) toast(__('posts.comment_failed'), 'error'); });
}

function deletePostComment(postId, commentId) {
  if (!currentUser) { toast(__('posts.login_first'), 'warning'); return; }
  showConfirm(__('ui.confirm_delete'), function() {
    api('/api/posts/' + postId + '/comments/' + commentId, { method: 'DELETE' })
      .then(function(r) { return r.json(); })
      .then(function() { showPostDetail(postId); })
      .catch(function(err) { if (!isApiHandledError(err)) toast(__('posts.comment_failed'), 'error'); });
  });
}

function editPostComment(postId, commentId) {
  if (!currentUser) { toast(__('posts.login_first'), 'warning'); return; }
  var textEl = document.getElementById('postCommentText-' + commentId);
  if (!textEl) return;
  var original = textEl.textContent;
  var input = document.createElement('input');
  input.type = 'text';
  input.value = original;
  input.maxLength = 2000;
  input.className = 'post-comment-edit-input';
  textEl.innerHTML = '';
  textEl.appendChild(input);
  input.focus();
  var finish = function(save) {
    if (save) {
      var content = input.value.trim();
      if (!content) { showPostDetail(postId); return; }
      api('/api/posts/' + postId + '/comments/' + commentId, { method: 'PUT', body: { content: content } })
        .then(function(r) { return r.json(); })
        .then(function() { showPostDetail(postId); })
        .catch(function(err) { if (!isApiHandledError(err)) { toast(__('posts.comment_failed'), 'error'); showPostDetail(postId); } });
    } else {
      showPostDetail(postId);
    }
  };
  input.onkeydown = function(e) {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  input.onblur = function() { finish(true); };
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
  viewer.innerHTML = '<button class="media-viewer-close" id="mediaViewerClose">&times;</button>'
    + '<div class="media-viewer-content"><img src="' + escAttr(images[idx].mediaUrl || images[idx].thumbUrl) + '" class="media-viewer-img" id="mediaViewerImg"></div>'
    + '<div class="media-viewer-nav">'
    + '<button class="btn btn-xs" onclick="navigateMediaViewer(-1)">' + __('posts.prev') + '</button>'
    + '<span id="mediaViewerCounter">' + (idx + 1) + ' / ' + images.length + '</span>'
    + '<button class="btn btn-xs" onclick="navigateMediaViewer(1)">' + __('posts.next') + '</button></div>';
  document.body.appendChild(viewer);

  // 统一清理：无论通过关闭按钮、点击遮罩还是 Esc 关闭，都移除键盘监听，避免重复绑定泄漏
  function cleanupViewer() {
    if (viewer.parentNode) viewer.remove();
    document.removeEventListener('keydown', keyHandler);
  }
  viewer.addEventListener('click', function(e) { if (e.target === viewer) cleanupViewer(); });
  var closeBtn = viewer.querySelector('#mediaViewerClose');
  if (closeBtn) closeBtn.addEventListener('click', cleanupViewer);

  function keyHandler(e) {
    if (e.key === 'Escape') cleanupViewer();
    else if (e.key === 'ArrowLeft') navigateMediaViewer(-1);
    else if (e.key === 'ArrowRight') navigateMediaViewer(1);
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
  postsKeepScroll = true;
  document.querySelectorAll('#tab-posts .post-filter-btn').forEach(function(btn) {
    btn.classList.toggle('active', (btn.dataset.type || '') === type);
  });
  loadPosts(1);
}

// ==================== VN-12 日期筛选（VRCNext 借鉴） ====================
function filterPostsByDate(date) {
  postsFilterDate = date || '';
  postsCurrentPage = 1;
  postsKeepScroll = true;
  loadPosts(1);
}

function resetPostsDateFilter() {
  filterPostsByDate('');
}

// ==================== VN-10 每页条数可配置（VRCNext TL_PAGE_SIZES 借鉴） ====================
function setPostsPageSize(size) {
  size = parseInt(size, 10);
  if (POSTS_PAGE_SIZES.indexOf(size) === -1) return;
  postsPageSize = size;
  try { localStorage.setItem('jt_posts_page_size', String(size)); } catch (e) {}
  postsCurrentPage = 1;
  postsKeepScroll = true;
  loadPosts(1);
}
