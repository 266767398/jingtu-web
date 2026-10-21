// 统一收藏系统 (V8.2) — 合并「模型收藏馆」与「收藏夹」
// 覆盖：avatar_model(模型) / world(世界) / avatar_favorite(头像) 三类收藏
// 能力：多维筛选、搜索、分页(加载更多)、个性化分组、公开发现、评分、失效重检、复制游戏内形象
(function () {
  'use strict';
  if (window.__collLoaded) return;
  window.__collLoaded = true;

  function ensureI18n() {
    if (typeof window.__ !== 'undefined') return window.__;
    return function (k, d) { return d !== undefined ? d : k; };
  }
  const __ = ensureI18n();

  // 剪贴板统一走 core.js 全局 copyTextToClipboard（含 execCommand 降级）

  // 全局状态
  const state = {
    kind: 'avatar_model',
    scope: 'mine',
    folder: 'all',
    filters: { search: '', status: '', platform: '', category: '', contentRating: '' },
    sort: 'created',
    page: 1,
    pageSize: 24,
    total: 0,
    totalPages: 1,
    loading: false,
    loadSeq: 0,
    items: [],
    folders: [],
    tags: []
  };

  const KIND_LABEL = {
    avatar_model: '🎭 ' + __('nav.modelcoll'),
    world: '🌐 ' + __('nav.worlds'),
    avatar_favorite: '🧑‍🦰 ' + __('nav.avatars')
  };

  function $(id) { return document.getElementById(id); }
  function qsa(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  function isLoggedIn() { return !!window.__isLoggedIn && window.__isLoggedIn(); }
  function getUserId() { return (window.__user && window.__user.id) || null; }
  function isAdmin() { return window.__isAdmin && window.__isAdmin(); }

  // 统一走 core.js 全局 apiJson：window.api 自动带 credentials / CSRF 令牌 / 超时，apiJson 再做 JSON 解析与错误剥离
  function api(path, opts) { return window.apiJson(path, opts); }

  // ============ 数据加载 ============
  async function loadItems(reset) {
    if (state.loading) return;
    if (reset) { state.page = 1; state.items = []; }
    // F1-45: 请求序号——切换筛选/分类/kind 时旧响应后到会被丢弃，避免「新条件渲染旧数据」
    const my = ++state.loadSeq;
    state.loading = true;
    const list = $('collList');
    if (reset && list) showSkeleton(list, 'grid', 6);
    try {
      const params = new URLSearchParams();
      params.set('kind', state.kind);
      params.set('scope', state.scope);
      params.set('page', String(state.page));
      params.set('pageSize', String(state.pageSize));
      params.set('sort', state.sort);
      if (state.scope === 'mine' && state.folder !== 'all') params.set('folderId', state.folder === 'none' ? '0' : state.folder);
      if (state.filters.search) params.set('search', state.filters.search);
      if (state.filters.status) params.set('status', state.filters.status);
      if (state.filters.platform) params.set('platform', state.filters.platform);
      if (state.filters.category) params.set('category', state.filters.category);
      if (state.filters.contentRating) params.set('contentRating', state.filters.contentRating);
      const endpoint = state.scope === 'public' ? '/api/collections/discover' : '/api/collections';
      const data = await api(endpoint + '?' + params.toString());
      if (my !== state.loadSeq) return; // 期间用户已切换条件，作废旧响应
      state.items = data.items || [];
      state.total = data.total || 0;
      state.totalPages = data.totalPages || 1;
      renderItems();
      renderLoadMore();
    } catch (e) {
      if (my !== state.loadSeq) return;
      if (list) renderEmpty(list, { icon: '⚠️', text: __('common.load_failed') + (e.message ? '：' + e.message : '') });
    } finally {
      state.loading = false;
    }
  }

  function renderItems() {
    const list = $('collList');
    if (!list) return;
    if (!state.items.length) {
      renderEmpty(list, { icon: '📭', text: __('collections.empty') });
      return;
    }
    list.innerHTML = state.items.map(cardHtml).join('');
    bindCardEvents();
  }

  function cardHtml(it) {
    const thumb = it.thumbnail || (window.__defaultAvatar || '');
    const statusClass = it.status === 'invalid' ? 'invalid' : (it.status === 'valid' ? 'valid' : 'unknown');
    let meta = '';
    if (it.kind === 'avatar_model') {
      const tags = Array.isArray(it.tags) ? it.tags : (it.tags ? safeParseTags(it.tags) : []);
      meta = [
        it.size_category ? sizeLabel(it.size_category) : '',
        it.platform ? platformLabel(it.platform) : '',
        it.content_rating === '18+' ? '18+' : '',
        it.category === 'functional' ? __('model_coll.functional') : __('model_coll.white')
      ].filter(Boolean).join(' · ');
      const tagHtml = tags.slice(0, 4).map(t => `<span class="coll-card-tag">${esc(t)}</span>`).join('');
      meta += tagHtml ? '<div class="coll-card-tags">' + tagHtml + '</div>' : '';
    } else if (it.kind === 'world') {
      meta = it.world_type ? (worldTypeLabel(it.world_type)) : '';
      if (it.content_rating === '18+') meta += ' · 18+';
    }
    const pubBadges = it.visibility === 'public'
      ? `<span class="coll-badge public">🌐 ${__('collections.public')}</span>` +
        ((state.scope === 'public' && it.show_author) ? `<span class="coll-badge pubby">👤 ${esc(it.owner_name || '')}</span>` : '')
      : (state.scope !== 'public'
        ? `<span class="coll-badge private">🔒 ${__('collections.private')}</span>`
        : '');
    const ratingHtml = it.kind === 'avatar_model'
      ? `<span class="coll-card-rating">⭐ ${Number(it.rating_avg || 0).toFixed(1)} (${it.rating_count || 0})</span>`
      : '';
    const recBadgeHtml = (it.kind === 'world' || it.kind === 'avatar_model' || it.kind === 'avatar_favorite') && (Number(it.recommend_up || 0) > 0 || Number(it.recommend_down || 0) > 0)
      ? `<span class="coll-card-rec" title="${it.recommend_up} 人推荐 / ${it.recommend_down} 人不推荐">👍 ${it.recommend_up}${Number(it.recommend_down || 0) > 0 ? ' · 👎 ' + it.recommend_down : ''}</span>`
      : '';
    const isMine = state.scope !== 'public';
    const actionBtns = [];
    if (isMine) {
      if (it.kind === 'avatar_model') {
        actionBtns.push(`<button class="coll-card-btn" data-act="detail" data-id="${it.id}">📋 ${__('collections.detail')}</button>`);
        actionBtns.push(`<button class="coll-card-btn" data-act="check" data-id="${it.id}">🔄 ${__('model_coll.recheck')}</button>`);
        actionBtns.push(`<button class="coll-card-btn" data-act="setavatar" data-id="${it.id}">🎭 ${__('model_coll.copy')}</button>`);
      } else {
        actionBtns.push(`<button class="coll-card-btn" data-act="detail" data-id="${it.id}">📋 ${__('collections.detail')}</button>`);
      }
      actionBtns.push(`<button class="coll-card-btn danger" data-act="remove" data-id="${it.id}">🗑 ${__('common.delete')}</button>`);
    } else {
      actionBtns.push(`<button class="coll-card-btn" data-act="detail" data-id="${it.id}">📋 ${__('collections.detail')}</button>`);
      if (it.kind === 'avatar_model') {
        actionBtns.push(`<button class="coll-card-btn" data-act="setavatar" data-id="${it.id}">🎭 ${__('model_coll.copy')}</button>`);
      }
      actionBtns.push(`<button class="coll-card-btn" data-act="copyid" data-id="${esc(it.target_id)}">📄 ${__('common.copy')}</button>`);
    }

    return `<div class="coll-card status-${statusClass}" data-id="${it.id}">
      <div class="coll-card-thumb${it.kind === 'world' ? ' coll-card-thumb--landscape' : ''}" style="background-image:url(${escCssUrl(thumb)})"></div>
      <div class="coll-card-body">
        <div class="coll-card-title">${esc(it.name || it.target_id)}</div>
        <div class="coll-card-author">${esc(it.author || '')}</div>
        ${meta ? `<div class="coll-card-meta">${meta}</div>` : ''}
        <div class="coll-card-foot flex-row justify-between align-center">
          <div class="flex-row gap-4 align-center">${ratingHtml}${recBadgeHtml}${pubBadges}</div>
        </div>
        <div class="coll-card-actions flex-row gap-4 flex-wrap mt-4">${actionBtns.join('')}</div>
      </div>
    </div>`;
  }

  function bindCardEvents() {
    qsa('.coll-card', $('collList')).forEach(card => {
      if (card.dataset.bound) return;
      card.dataset.bound = '1';
      const id = card.getAttribute('data-id');
      qsa('[data-act]', card).forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const act = btn.getAttribute('data-act');
          handleCardAction(act, id, e);
        });
      });
      card.addEventListener('click', () => openDetail(id));
    });
  }

  async function handleCardAction(act, id, e) {
    if (act === 'detail') return openDetail(id);
    if (act === 'copyid') {
      try {
        await copyTextToClipboard(id);
        toast(__('common.operation_success'));
      } catch (e) { toast(e.message, 'error'); }
      return;
    }
    if (act === 'remove') {
      showConfirm(__('collections.confirm_remove'), async function () {
        try {
          await api('/api/collections/' + id, { method: 'DELETE' });
          toast(__('collections.removed'));
          await loadFolders();
          loadItems(true);
        } catch (e) { toast(e.message, 'error'); }
      });
      return;
    }
    if (act === 'check') {
      const release = btnBusy(e.target);
      try {
        const d = await api('/api/collections/' + id + '/check', { method: 'POST' });
        toast(d.status === 'valid' ? __('model_coll.valid') : __('model_coll.invalid') + (d.invalidReason || ''));
        loadItems(true);
      } catch (e) { toast(e.message, 'error'); }
      finally { release(); }
      return;
    }
    if (act === 'setavatar') {
      showConfirm(__('model_coll.confirm_copy'), async function () {
        const release = btnBusy(e.target);
        try {
          await api('/api/collections/' + id + '/set-avatar', { method: 'POST' });
          toast(__('model_coll.copied'));
        } catch (e) { toast(e.message, 'error'); }
        finally { release(); }
      });
      return;
    }
  }

  // ============ 加载更多 ============
  function renderLoadMore() {
    const wrap = $('collLoadMore');
    if (!wrap) return;
    if (state.page < state.totalPages) {
      wrap.innerHTML = `<button id="collLoadMoreBtn" class="btn btn-outline">${__('ui.load_more')} (${state.page}/${state.totalPages})</button>`;
      $('collLoadMoreBtn').addEventListener('click', () => {
        state.page++;
        appendPage();
      });
    } else {
      wrap.innerHTML = state.total ? `<div class="text-center text-gray text-13 py-4">— ${__('collections.end')} —</div>` : '';
    }
  }

  async function appendPage() {
    if (state.loading) return; // F1-45: 连点「加载更多」不再并发拉取拼接乱序
    const my = state.loadSeq; // 追加页归属当前条件；期间若发生 reset 则整体作废
    state.loading = true;
    try {
      const params = buildParams();
      const endpoint = state.scope === 'public' ? '/api/collections/discover' : '/api/collections';
      const data = await api(endpoint + '?' + params.toString());
      if (my !== state.loadSeq) return;
      state.items = state.items.concat(data.items || []);
      const list = $('collList');
      // insertAdjacentHTML 追加：免去整表重解析，长列表「加载更多」更顺滑
      list.insertAdjacentHTML('beforeend', data.items.map(cardHtml).join(''));
      bindCardEvents();
      renderLoadMore();
    } catch (e) { toast(e.message, 'error'); }
    finally { state.loading = false; }
  }

  function buildParams() {
    const params = new URLSearchParams();
    params.set('kind', state.kind);
    params.set('scope', state.scope);
    params.set('page', String(state.page));
    params.set('pageSize', String(state.pageSize));
    params.set('sort', state.sort);
    if (state.scope === 'mine' && state.folder === 'none') params.set('folderId', '0');
    else if (state.scope === 'mine' && state.folder !== 'all') params.set('folderId', state.folder);
    if (state.filters.search) params.set('search', state.filters.search);
    if (state.filters.status) params.set('status', state.filters.status);
    if (state.filters.platform) params.set('platform', state.filters.platform);
    if (state.filters.category) params.set('category', state.filters.category);
    if (state.filters.contentRating) params.set('contentRating', state.filters.contentRating);
    return params;
  }

  // ============ 分组 folders ============
  async function loadFolders() {
    try {
      const d = await api('/api/collections/folders');
      state.folders = d.folders || [];
      renderFolders();
    } catch (e) { /* ignore */ }
  }

  function renderFolders() {
    const ul = $('collFolderList');
    if (!ul) return;
    if (state.scope === 'public') { ul.innerHTML = '<li class="coll-folder public-hint">🌐 ' + __('collections.discover') + '</li>'; return; }
    const base = `<li class="coll-folder ${state.folder === 'all' ? 'active' : ''}" data-folder="all"><span>${__('collections.all')}</span><span class="coll-folder-count" id="collCountAll">0</span></li>
      <li class="coll-folder ${state.folder === 'none' ? 'active' : ''}" data-folder="none"><span>${__('collections.ungrouped')}</span><span class="coll-folder-count" id="collCountNone">0</span></li>`;
    const items = state.folders.map(f => `<li class="coll-folder ${String(state.folder) === String(f.id) ? 'active' : ''}" data-folder="${f.id}"><span class="coll-folder-name" title="${escAttr(__('collections.rename_folder'))}">${esc(f.name)}</span><span class="coll-folder-count">${f.item_count || 0}</span><span class="coll-folder-edit" data-rename="${f.id}" title="${escAttr(__('collections.rename_folder'))}">✏️</span><span class="coll-folder-del" data-del="${f.id}" title="${escAttr(__('auto_collections_29'))}">×</span></li>`).join('');
    ul.innerHTML = base + items;
    qsa('.coll-folder', ul).forEach(li => {
      li.addEventListener('click', (e) => {
        if (e.target.getAttribute('data-del')) {
          e.stopPropagation();
          const fid = e.target.getAttribute('data-del');
          showConfirm(__('collections.confirm_del_folder'), function () { deleteFolder(fid); });
          return;
        }
        if (e.target.getAttribute('data-rename')) {
          e.stopPropagation();
          const fid = e.target.getAttribute('data-rename');
          const f = state.folders.find(x => String(x.id) === String(fid));
          // 重命名走 showInput（确认/取消强制二选一），改名后刷新分组与当前列表
          showInput(__('collections.rename_folder'), f ? f.name : '', function (val) {
            const name = (val || '').trim();
            if (!name) return;
            renameFolder(fid, name);
          });
          return;
        }
        state.folder = li.getAttribute('data-folder');
        renderFolders();
        if (state.scope === 'mine') loadItems(true);
      });
    });
  }

  async function renameFolder(fid, name) {
    try {
      await api('/api/collections/folders/' + fid, { method: 'PUT', body: JSON.stringify({ name }) });
      toast(__('collections.folder_renamed'));
      await loadFolders();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function deleteFolder(fid) {
    try {
      await api('/api/collections/folders/' + fid, { method: 'DELETE' });
      toast(__('collections.folder_deleted'));
      await loadFolders();
      if (String(state.folder) === String(fid)) state.folder = 'all';
      loadItems(true);
    } catch (e) { toast(e.message, 'error'); }
  }

  async function addFolder() {
    const name = ($('collFolderName').value || '').trim();
    if (!name) { showErr('collFolderError', __('collections.folder_name_required')); return; }
    // 防重复提交：连点会创建多个同名分组
    const btn = $('collFolderConfirmBtn');
    if (btn && btn.disabled) return;
    if (btn) { btn.disabled = true; btn.dataset.busy = '1'; }
    try {
      await api('/api/collections/folders', { method: 'POST', body: JSON.stringify({ name }) });
      $('collFolderName').value = '';
      closeModal('collFolderModal');
      toast(__('collections.folder_added'));
      await loadFolders();
    } catch (e) { showErr('collFolderError', e.message); }
    finally { if (btn) { btn.disabled = false; delete btn.dataset.busy; } }
  }

  // ============ 标签云 ============
  async function loadTags() {
    try {
      const d = await api('/api/collections/tags');
      state.tags = d.tags || [];
      renderTags();
    } catch (e) { /* ignore */ }
  }

  function renderTags() {
    const bar = $('collTagBar');
    if (!bar) return;
    if (state.scope !== 'public' || !state.tags.length) { bar.innerHTML = ''; return; }
    bar.innerHTML = state.tags.slice(0, 20).map(t => `<button class="coll-tag" data-tag="${esc(t.tag)}">#${esc(t.tag)} <span class="coll-tag-count">${t.count}</span></button>`).join('');
    qsa('.coll-tag', bar).forEach(b => b.addEventListener('click', () => {
      state.filters.search = b.getAttribute('data-tag');
      $('collSearch').value = b.getAttribute('data-tag');
      loadItems(true);
    }));
  }

  // ============ 详情弹窗 ============
  async function openDetail(id) {
    try {
      let item = null;
      // 优先走详情端点（含 public_duplicate 标记），失败回退到列表查找
      try { const d = await api('/api/collections/' + id); item = d.item || null; } catch (e) { /* 忽略，走回退 */ }
      if (!item) item = await fetchItem(id);
      if (!item) { toast(__('collections.not_found'), 'error'); return; }
      // F-17: 世界收藏详情预取私有标签（仅本人视角展示/编辑）
      if (item.kind === 'world' && state.scope !== 'public') {
        try {
          const td = await api('/api/world-tags/' + encodeURIComponent(item.target_id));
          item.worldTags = td.tags || [];
        } catch (e) { item.worldTags = []; }
      }
      renderDetail(item);
      openModal('collDetailModal');
    } catch (e) { toast(e.message, 'error'); }
  }

  async function fetchItem(id) {
    // 优先从当前列表找
    let it = state.items.find(x => String(x.id) === String(id));
    if (it) return it;
    // 从公开/我的列表拉取
    try {
      const d = await api('/api/collections?kind=' + state.kind + '&scope=' + state.scope + '&pageSize=60&page=1');
      it = (d.items || []).find(x => String(x.id) === String(id));
    } catch (e) {}
    return it || null;
  }

  function renderDetail(it) {
    const title = $('collDetailTitle');
    const body = $('collDetailBody');
    if (title) title.textContent = it.name || it.target_id;
    const tags = Array.isArray(it.tags) ? it.tags : (it.tags ? safeParseTags(it.tags) : []);
    const rows = [];
    rows.push(['ID', it.target_id]);
    rows.push([__('collections.visibility', '可见性'), it.visibility === 'public'
      ? '🌐 ' + __('collections.public') + (state.scope === 'public' ? '' : `（${__('model_coll.status_public_tip', '已公开，他人可发现')}）`)
      : '🔒 ' + __('collections.private')]);
    rows.push([__('auto_collections_35'), KIND_LABEL[it.kind] || it.kind]);
    rows.push([__('auto_collections_36'), it.author || '-']);
    rows.push([__('auto_collections_37'), statusText(it.status)]);
    if (it.kind === 'avatar_model') {
      rows.push([__('auto_collections_38'), it.platform ? platformLabel(it.platform) : '-']);
      rows.push([__('model_coll.unity_version'), it.unity_version || '-']);
      rows.push([__('auto_collections_39'), it.size_category ? sizeLabel(it.size_category) : '-']);
      rows.push([__('auto_collections_40'), it.category === 'functional' ? __('model_coll.functional') : __('model_coll.white')]);
      rows.push([__('auto_collections_43'), it.content_rating === '18+' ? '18+' : __('auto_collections_44')]);
      rows.push([__('auto_collections_45'), String(it.heat || 0)]);
      rows.push([__('auto_collections_46'), String(it.favorite_count || 0)]);
      rows.push([__('auto_collections_47'), Number(it.rating_avg || 0).toFixed(1) + ' (' + (it.rating_count || 0) + ')']);
      if (it.booth_url && safeHref(it.booth_url)) rows.push(['BOOTH', `<a href="${esc(it.booth_url)}" target="_blank" rel="noopener">${esc(it.booth_url)}</a>`]);
    } else if (it.kind === 'world') {
      rows.push([__('auto_collections_48'), it.world_type ? worldTypeLabel(it.world_type) : '-']);
      if (it.unity_package_url) rows.push([__('auto_collections_49'), `<code>${esc(it.unity_package_url)}</code>`]);
    }
    const tagHtml = tags.length ? `<div class="coll-detail-tags">${tags.map(t => `<span class="coll-card-tag">${esc(t)}</span>`).join('')}</div>` : '';
    const isMineDetail = state.scope !== 'public';
    const pub = buildPublicButton(it);
    let actions = '';
    if (isMineDetail) {
      if (it.kind === 'avatar_model') {
        actions = `<div class="coll-detail-actions mt-8">
          <button class="btn btn-accent" id="collDetailSetAvatar">🎭 ${__('model_coll.copy')}</button>
          <button class="btn btn-outline" id="collDetailCheck">🔄 ${__('model_coll.recheck')}</button>
          ${pub.html}
        </div>`;
      } else {
        actions = `<div class="coll-detail-actions mt-8">${pub.html}</div>`;
      }
    } else {
      if (it.kind === 'avatar_model') {
        actions = `<div class="coll-detail-actions mt-8">
          <button class="btn btn-accent" id="collDetailSetAvatar">🎭 ${__('model_coll.copy')}</button>
          <button class="btn btn-outline" id="collDetailCopyId">📄 ${__('common.copy')}</button>
        </div>`;
      } else {
        actions = `<div class="coll-detail-actions mt-8">
          <button class="btn btn-outline" id="collDetailCopyId">📄 ${__('common.copy')}</button>
        </div>`;
      }
    }
    const pubHintHtml = pub.hint ? `<div class="coll-detail-hint text-13 text-muted2 mt-4">⚠️ ${pub.hint}</div>` : '';
    const pubInfoHtml = (state.scope === 'public')
      ? `<div class="coll-detail-pubinfo mt-8">${it.show_author ? ('🌟 ' + __('collections.pub_by') + ' <b>' + esc(it.owner_name || __('collections.anon')) + '</b> ' + __('collections.pub_by_suffix')) : '🕶️ ' + __('collections.pub_anon')}</div>`
      : '';
    // 推荐指数：多少人推荐 / 多少人踩 + 平均推荐指数（推荐占比换算 0~5）
    const recHtml = (it.kind === 'world' || it.kind === 'avatar_model' || it.kind === 'avatar_favorite')
      ? buildRecommendHtml(it)
      : '';
    const folderSel = isMineDetail ? `<div class="mt-8"><label>${__('collections.folder')}</label>
      <select id="collDetailFolder" class="search-box">${folderOptions(it.folder_id)}</select></div>` : '';
    const notesEl = isMineDetail ? `<div class="mt-8"><label>${__('collections.notes')}</label>
      <textarea id="collDetailNotes" class="search-box" rows="2">${esc(it.notes || '')}</textarea>
      <button class="btn btn-outline mt-4" id="collDetailSaveNotes">${__('common.save')}</button></div>` : '';
    // F-17: 世界收藏私有标签编辑区（仅本人视角；公开视角沿用世界原始 tags 展示）
    const worldTagEditHtml = (isMineDetail && it.kind === 'world') ? `
      <div class="coll-detail-tag-edit mt-8">
        <label>${__('world_tags.label')}</label>
        <input id="collDetailWorldTags" class="search-box" type="text" maxlength="255" placeholder="${__('world_tags.placeholder')}" value="${esc((it.worldTags || []).join(', '))}">
        <div class="flex-row gap-8 mt-4">
          <button class="btn btn-outline" id="collDetailWorldTagSave">${__('common.save')}</button>
          <button class="btn btn-outline" id="collDetailWorldTagClear">${__('common.delete')}</button>
        </div>
      </div>` : '';

    body.innerHTML = `
      <div class="coll-detail flex-row gap-12">
        <div class="coll-detail-thumb" style="background-image:url(${escCssUrl(it.thumbnail || (window.__defaultAvatar || ''))})"></div>
        <div class="coll-detail-info flex-1">
          <table class="coll-detail-table">${rows.map(r => `<tr><th>${esc(r[0])}</th><td>${esc(r[1])}</td></tr>`).join('')}</table>
          ${tagHtml}
          <div class="mt-8"><label>${__('collections.description')}</label><div class="coll-detail-desc">${esc(it.description || '-')}</div></div>
          ${pubInfoHtml}
          ${folderSel}
          ${notesEl}
          ${worldTagEditHtml}
          ${recHtml}
          ${actions}
          ${pubHintHtml}
        </div>
      </div>`;
    // 绑定推荐/不推荐投票
    const recUpBtn = $('collRecUp');
    const recDownBtn = $('collRecDown');
    if (recUpBtn) recUpBtn.addEventListener('click', () => voteRecommend(it, 1));
    if (recDownBtn) recDownBtn.addEventListener('click', () => voteRecommend(it, -1));
    // 绑定详情内操作
    const setBtn = $('collDetailSetAvatar');
    if (setBtn) setBtn.addEventListener('click', () => {
      showConfirm(__('model_coll.confirm_copy'), async function () {
        try { await api('/api/collections/' + it.id + '/set-avatar', { method: 'POST' }); toast(__('model_coll.copied')); } catch (e) { toast(e.message, 'error'); }
      });
    });
    const checkBtn = $('collDetailCheck');
    if (checkBtn) checkBtn.addEventListener('click', async () => {
      try { const r = await api('/api/collections/' + it.id + '/check', { method: 'POST' }); toast(r.status === 'valid' ? __('model_coll.valid') : __('model_coll.invalid')); openDetail(it.id); } catch (e) { toast(e.message, 'error'); }
    });
    const pubBtn = $('collDetailPublic');
    if (pubBtn) pubBtn.addEventListener('click', async () => {
      // 仅收藏所有者（即公开者本人）可关闭/修改；后端 WHERE user_id=? 已强制
      const vis = it.visibility === 'public' ? 'private' : 'public';
      const body = { visibility: vis };
      if (vis === 'public') {
        const sa = $('collDetailShowAuthor');
        body.show_author = !!(sa && sa.checked);
      }
      try { await api('/api/collections/' + it.id, { method: 'PUT', body: JSON.stringify(body) }); toast(vis === 'public' ? __('collections.now_public') : __('collections.now_private')); openDetail(it.id); loadItems(false); } catch (e) { toast(e.message, 'error'); }
    });
    const saToggle = $('collDetailShowAuthor');
    if (saToggle) saToggle.addEventListener('change', async () => {
      try { await api('/api/collections/' + it.id, { method: 'PUT', body: JSON.stringify({ show_author: saToggle.checked }) }); toast(saToggle.checked ? __('collections.signed_on') : __('collections.anon_on')); openDetail(it.id); } catch (e) { toast(e.message, 'error'); }
    });
    const copyIdBtn = $('collDetailCopyId');
    if (copyIdBtn) copyIdBtn.addEventListener('click', async () => {
      try { await copyTextToClipboard(it.target_id); toast(__('common.operation_success')); } catch (e) { toast(e.message, 'error'); }
    });
    const folderSelEl = $('collDetailFolder');
    if (folderSelEl) folderSelEl.addEventListener('change', async () => {
      try { await api('/api/collections/' + it.id, { method: 'PUT', body: JSON.stringify({ folder_id: folderSelEl.value || null }) }); toast(__('collections.saved')); await loadFolders(); } catch (e) { toast(e.message, 'error'); }
    });
    const saveNotes = $('collDetailSaveNotes');
    if (saveNotes) saveNotes.addEventListener('click', async () => {
      try { await api('/api/collections/' + it.id, { method: 'PUT', body: JSON.stringify({ notes: $('collDetailNotes').value }) }); toast(__('collections.saved')); } catch (e) { toast(e.message, 'error'); }
    });
    // F-17: 世界收藏私有标签保存/清空
    const wtSave = $('collDetailWorldTagSave');
    if (wtSave) wtSave.addEventListener('click', async () => {
      const input = $('collDetailWorldTags');
      const tags = (input.value || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 8);
      try {
        await api('/api/world-tags/' + encodeURIComponent(it.target_id), { method: 'POST', body: JSON.stringify({ tags }) });
        toast(__('world_tags.saved'), 'success');
        it.worldTags = tags;
      } catch (e) { toast(e.message, 'error'); }
    });
    const wtClear = $('collDetailWorldTagClear');
    if (wtClear) wtClear.addEventListener('click', () => {
      showConfirm(__('world_tags.confirm_clear'), async function () {
        try {
          await api('/api/world-tags/' + encodeURIComponent(it.target_id), { method: 'DELETE' });
          toast(__('world_tags.cleared'), 'success');
          const input = $('collDetailWorldTags');
          if (input) input.value = '';
          it.worldTags = [];
        } catch (e) { toast(e.message, 'error'); }
      });
    });
  }

  // ============ 推荐指数（多少人推荐 / 多少人踩 + 平均指数 0~5） ============
  function buildRecommendHtml(it) {
    const up = Number(it.recommend_up || 0);
    const down = Number(it.recommend_down || 0);
    const total = up + down;
    const pct = total > 0 ? Math.round((up / total) * 100) : 0;
    const avg = total > 0 ? ((up / total) * 5) : null;           // 平均指数 0~5
    const my = Number(it.my_recommend || 0);
    const avgTxt = avg == null ? '--' : avg.toFixed(1);
    return `
      <div class="coll-detail-rec mt-8">
        <div class="coll-detail-rec-head">
          <span class="coll-detail-rec-title">💡 ${__('rec.title', '推荐指数')}</span>
          <span class="coll-detail-rec-meta">${total > 0 ? `${up} 人推荐 · ${down} 人不推荐 · 平均 ${avgTxt}/5` : __('rec.no_vote', '还没有人推荐，来投出第一票吧')}</span>
        </div>
        <div class="coll-detail-rec-bar" title="${up} 人推荐 / ${total} 人投票">
          <i style="width:${pct}%"></i>
        </div>
        <div class="coll-detail-rec-actions mt-4">
          <button type="button" class="btn btn-xs ${my === 1 ? 'btn-accent' : 'btn-outline'}" id="collRecUp">👍 ${__('rec.up', '推荐')}${up ? ' · ' + up : ''}</button>
          <button type="button" class="btn btn-xs ${my === -1 ? 'btn-danger' : 'btn-outline'}" id="collRecDown">👎 ${__('rec.down', '不推荐')}${down ? ' · ' + down : ''}</button>
        </div>
      </div>`;
  }

  // 提交推荐/不推荐（后端 upsert 覆盖：同用户对同一目标只算一票，换边即覆盖）
  async function voteRecommend(it, vote) {
    try {
      const r = await api('/api/collections/' + encodeURIComponent(it.id) + '/recommend', {
        method: 'POST',
        body: JSON.stringify({ vote: vote })
      });
      it.recommend_up = r.recommend_up;
      it.recommend_down = r.recommend_down;
      it.my_recommend = r.my_recommend;
      renderDetail(it);
      const voted = vote === 1 ? __('rec.ok_up', '已推荐') : __('rec.ok_down', '已标记不推荐');
      toast(voted, 'success');
      const listItem = (state.items || []).find(x => String(x.id) === String(it.id));
      if (listItem) { listItem.recommend_up = r.recommend_up; listItem.recommend_down = r.recommend_down; }
    } catch (e) { toast(e.message || __('rec.fail', '推荐操作失败'), 'error'); }
  }

  // 构建__('auto_collections_74')按钮：
  //  - 已公开：点亮选中态（is-public-on），点击__('auto_collections_75')仅公开者本人可操作；附__('auto_collections_76')署名开关
  //  - 未公开且同模型已有他人公开副本：置灰禁用，避免公开发现页重复展示
  //  - 未公开且无冲突：正常可点，附__('auto_collections_77')勾选
  function buildPublicButton(it) {
    const isPublic = it.visibility === 'public';
    const blocked = !isPublic && it.public_duplicate;
    const authorName = it.owner_name || '';
    if (isPublic) {
      const saChk = it.show_author ? 'checked' : '';
      const byLine = it.show_author
        ? `<span class="coll-pub-by">🌟 ${__('collections.pub_by')} ${esc(authorName)} ${__('collections.pub_by_suffix')}</span>`
        : `<span class="coll-pub-by muted">🕶️ ${__('collections.pub_anon')}</span>`;
      return {
        html: `<button class="btn btn-accent is-public-on" id="collDetailPublic" title="${escAttr(__('auto_collections_81'))}">🌐 ${__('collections.public_on_click_private')}</button>
               <label class="coll-pub-author-toggle"><input type="checkbox" id="collDetailShowAuthor" ${saChk}/> ${__('collections.show_my_name')}</label>
               ${byLine}`,
        hint: ''
      };
    }
    if (blocked) {
      return {
        html: `<button class="btn btn-outline" id="collDetailPublic" disabled title="${escAttr(__('auto_collections_83'))}">🌐 ${__('collections.public_share_has_copy')}</button>`,
        hint: __('auto_collections_84')
      };
    }
    return {
      html: `<label class="coll-pub-author-toggle"><input type="checkbox" id="collDetailShowAuthor" checked/> ${__('collections.sign_public')}</label>
             <button class="btn btn-outline" id="collDetailPublic" title="${escAttr(__('auto_collections_86'))}">🌐 ${__('collections.public_share_btn')}</button>`,
      hint: ''
    };
  }

  function folderOptions(selectedId) {
    let html = '<option value="">' + __('collections.ungrouped') + '</option>';
    state.folders.forEach(f => {
      html += `<option value="${f.id}" ${String(f.id) === String(selectedId) ? 'selected' : ''}>${esc(f.name)}</option>`;
    });
    return html;
  }

  // ============ 添加收藏 ============
  async function openAdd() {
    if (!isLoggedIn()) { toast(__('collections.login_required'), 'error'); return; }
    await loadFolders();
    // 预填分组下拉
    const sel = $('collAddFolder');
    sel.innerHTML = '<option value="">' + __('collections.ungrouped') + '</option>' + state.folders.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('');
    $('collAddKind').value = state.kind;
    $('collAddTarget').value = '';
    const smInput = $('collSearchModels'); if (smInput) smInput.value = '';
    const smRes = $('collSearchModelsResults'); if (smRes) smRes.innerHTML = '';
    $('collAddNotes').value = '';
    $('collAddBooth').value = '';
    $('collAddPublic').checked = false;
    hideErr('collAddError');
    openModal('collAddModal');
  }

  async function submitAdd() {
    hideErr('collAddError');
    const kind = $('collAddKind').value;
    const target_id = $('collAddTarget').value.trim();
    if (!target_id) { showErr('collAddError', __('collections.id_required')); return; }
    // 防重复提交：连点会向同一分组重复插入条目
    const btn = $('collAddConfirmBtn');
    if (btn && btn.disabled) return;
    if (btn) { btn.disabled = true; btn.dataset.busy = '1'; }
    const body = {
      kind, target_id,
      folder_id: $('collAddFolder').value || null,
      notes: $('collAddNotes').value,
      booth_url: $('collAddBooth').value,
      visibility: $('collAddPublic').checked ? 'public' : 'private'
    };
    try {
      await api('/api/collections', { method: 'POST', body: JSON.stringify(body) });
      closeModal('collAddModal');
      toast(__('collections.added'));
      state.kind = kind;
      await loadFolders();
      loadItems(true);
    } catch (e) { showErr('collAddError', e.message); }
    finally { if (btn) { btn.disabled = false; delete btn.dataset.busy; } }
  }

  // ============ VRCX 匿名模型搜索（迁移自孤儿 model-collections 模块） ============
  // 在添加收藏弹窗内直接搜索 VRChat Avatar，挑选后自动填入模型 ID。无需登录。
  async function searchModels() {
    const input = $('collSearchModels');
    const box = $('collSearchModelsResults');
    if (!input || !box) return;
    const q = input.value.trim();
    if (!q) { box.innerHTML = '<div class="coll-search-hint text-13 text-muted2">' + __('collections.search_enter') + '</div>'; return; }
    box.innerHTML = '<div class="coll-search-hint text-13 text-muted2">' + __('common.loading') + '</div>';
    try {
      // P3-1: 改用全局 api()，统一获得超时、no-store 缓存控制与错误兜底；与模块内其他请求一致
      //（api=window.apiJson 已把 Response 解析成对象返回，此处不可再调用 res.json()）
      const data = await api('/api/collections/search-models?q=' + encodeURIComponent(q) + '&n=12', { timeout: 20000 });
      const results = Array.isArray(data.results) ? data.results : [];
      if (!results.length) {
        const errMsg = errText(data);
        const err = errMsg ? ('：' + esc(errMsg)) : '';
        box.innerHTML = '<div class="coll-search-hint text-13 text-muted2">' + __('model_coll.search_empty') + err + '</div>';
        return;
      }
      box.innerHTML = results.map(r => `
        <div class="coll-search-result" data-id="${esc(r.id)}" data-name="${esc(r.name)}">
          <div class="coll-search-thumb" style="background-image:url(${escCssUrl(r.thumbnailImageUrl || r.imageUrl || (window.__defaultAvatar || ''))})"></div>
          <div class="coll-search-info">
            <div class="coll-search-name">${esc(r.name || r.id)}</div>
            <div class="coll-search-author">${esc(r.authorName || '')}</div>
            <div class="coll-search-id">${esc(r.id)}</div>
          </div>
          <button type="button" class="coll-search-pick btn btn-outline btn-sm" data-id="${esc(r.id)}">${__('common.select')}</button>
        </div>`).join('');
      qsa('.coll-search-result', box).forEach(el => {
        el.addEventListener('click', (e) => { if (e.target.closest('.coll-search-pick')) return; pickSearchModel(el.getAttribute('data-id')); });
      });
      qsa('.coll-search-pick', box).forEach(btn => {
        btn.addEventListener('click', (e) => { e.stopPropagation(); pickSearchModel(btn.getAttribute('data-id')); });
      });
    } catch (e) {
      box.innerHTML = '<div class="coll-search-hint text-13 text-red">' + __('common.load_failed') + '：' + esc(e.message || '') + '</div>';
    }
  }

  function pickSearchModel(id) {
    const target = $('collAddTarget');
    if (target) { target.value = id; target.focus(); }
    toast(__('model_coll.id_filled'));
  }

  // ============ 世界搜索 / 热门世界排行 ============
  const worldDiscoverState = { sort: 'popular', q: '' };

  async function openWorldDiscover() {
    openModal('collWorldDiscoverModal');
    worldDiscoverState.q = '';
    worldDiscoverState.sort = 'popular';
    const input = $('collWorldSearchInput'); if (input) input.value = '';
    qsa('#collWorldTabBar .coll-kind').forEach(b => b.classList.toggle('active', b.getAttribute('data-sort') === 'popular'));
    await loadWorldDiscover();
  }

  async function loadWorldDiscover() {
    const box = $('collWorldDiscoverResults');
    const err = $('collWorldDiscoverError');
    if (!box) return;
    if (err) hideErr('collWorldDiscoverError');
    box.innerHTML = '<div class="coll-search-hint text-13 text-muted2">' + __('common.loading') + '</div>';
    try {
      let data;
      if (worldDiscoverState.q) {
        // P3-1: 改用全局 api()，统一获得超时、no-store 缓存控制与错误兜底（api 已返回解析对象）
        const url = '/api/collections/search-worlds?q=' + encodeURIComponent(worldDiscoverState.q) + '&n=24';
        data = await api(url);
        if (data.success === false) throw new Error(errText(data));
        renderWorldResults(data.results || []);
      } else {
        const url = '/api/collections/popular-worlds?sort=' + encodeURIComponent(worldDiscoverState.sort) + '&n=24';
        data = await api(url);
        if (data.success === false) throw new Error(errText(data));
        renderWorldResults(data.results || []);
      }
    } catch (e) {
      box.innerHTML = '';
      if (err) { err.textContent = __('world_discover.load_failed') + '：' + (e.message || ''); err.classList.remove('d-none'); }
    }
  }

  function renderWorldResults(worlds) {
    const box = $('collWorldDiscoverResults');
    if (!box) return;
    if (!worlds.length) {
      box.innerHTML = '<div class="coll-search-hint text-13 text-muted2">' + __('world_discover.search_empty') + '</div>';
      return;
    }
    box.innerHTML = worlds.map(w => worldCardHtml(w)).join('');
    bindWorldCardEvents();
  }

  function worldCardHtml(w) {
    const thumb = w.thumbnailImageUrl || w.imageUrl || (window.__defaultAvatar || '');
    const release = w.releaseStatus === 'private' ? __('world_discover.release_private')
      : (w.releaseStatus === 'all' ? __('world_discover.release_all')
        : __('world_discover.release_public'));
    const tags = Array.isArray(w.tags) ? w.tags.slice(0, 4).map(t => `<span class="coll-card-tag">${esc(t)}</span>`).join('') : '';
    return `
      <div class="coll-card" data-wid="${esc(w.id)}">
        <div class="coll-card-thumb coll-card-thumb--landscape" style="background-image:url(${escCssUrl(thumb)})"></div>
        <div class="coll-card-body">
          <div class="coll-card-title">${esc(w.name || w.id)}</div>
          <div class="coll-card-sub">${esc(w.authorName || '')}</div>
          <div class="coll-card-meta">
            <span>👥 ${esc(String(w.occupants != null ? w.occupants : 0))}/${esc(String(w.capacity != null ? w.capacity : 0))}</span>
            <span>⭐ ${esc(String(w.favorites != null ? w.favorites : 0))}</span>
            <span>🔥 ${esc(String(w.heat != null ? w.heat : 0))}</span>
          </div>
          ${tags ? '<div class="coll-card-tags">' + tags + '</div>' : ''}
          <div class="coll-card-id">${esc(w.id)} · ${esc(release)}</div>
        </div>
      </div>`;
  }

  function bindWorldCardEvents() {
    qsa('#collWorldDiscoverResults .coll-card').forEach(card => {
      card.addEventListener('click', () => {
        const wid = card.getAttribute('data-wid');
        const target = $('collAddTarget');
        if (target) { target.value = wid; }
        closeModal('collWorldDiscoverModal');
        openAdd();
        toast(__('model_coll.id_filled'));
      });
    });
  }

  function bindWorldDiscover() {
    const openBtn = $('collWorldDiscoverBtn');
    if (openBtn) openBtn.addEventListener('click', openWorldDiscover);
    const searchBtn = $('collWorldSearchBtn');
    if (searchBtn) searchBtn.addEventListener('click', () => { worldDiscoverState.q = ($('collWorldSearchInput') || {}).value || ''; worldDiscoverState.q = worldDiscoverState.q.trim(); loadWorldDiscover(); });
    const searchInput = $('collWorldSearchInput');
    if (searchInput) searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); worldDiscoverState.q = searchInput.value.trim(); loadWorldDiscover(); } });
    qsa('#collWorldTabBar .coll-kind').forEach(b => {
      b.addEventListener('click', () => {
        qsa('#collWorldTabBar .coll-kind').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        worldDiscoverState.sort = b.getAttribute('data-sort');
        worldDiscoverState.q = '';
        const input = $('collWorldSearchInput'); if (input) input.value = '';
        loadWorldDiscover();
      });
    });
    const closeBtn = $('collWorldDiscoverModal');
    if (closeBtn) {
      qsa('#collWorldDiscoverModal .modal-close').forEach(b => b.addEventListener('click', () => closeModal('collWorldDiscoverModal')));
    }
  }

  // ============ 复检我的全部 ============
  async function scanMine() {
    if (!isLoggedIn()) return;
    try {
      toast(__('collections.scanning'));
      // scan 为慢操作：后端需逐条回源 VRChat 复检（最多 200 条，令牌桶限速下可能数分钟），
      // 前端默认 10s 超时必然中断，放宽至 240s。
      const d = await api('/api/collections/scan', { method: 'POST', timeout: 240000 });
      toast(__('collections.scan_done') + `：${d.checked} / ${d.newInvalid}`);
      loadItems(true);
    } catch (e) { toast(e.message, 'error'); }
  }

  // ============ 辅助 ============
  // V9.7: 与 core.js showModal/closeModal 对齐 —— 同时维护 .show class 与 inline display，
  // 解决「详情弹窗打开一次后再点打不开」：core.js 关闭（遮罩点击/全局委托）会把
  // style.display 置为 'none'，旧实现再打开只加 .show class，display 仍为 none 导致无响应。
  function openModal(id) {
    const m = $(id);
    if (!m) return;
    m.classList.add('show');
    m.style.display = 'flex';
    if (typeof lockBodyScroll === 'function') lockBodyScroll('modal:' + id);
  }
  function closeModal(id) {
    const m = $(id);
    if (!m) return;
    m.classList.remove('show');
    m.style.display = 'none';
    if (typeof unlockBodyScroll === 'function') unlockBodyScroll('modal:' + id);
  }
  function showErr(id, msg) { const e = $(id); if (e) { e.textContent = msg; e.classList.remove('d-none'); } }
  function hideErr(id) { const e = $(id); if (e) e.classList.add('d-none'); }
  function toast(msg, type) { if (window.__toast) window.__toast(msg, type); else console.log(msg); }
  // P2-1: 原实现固定 1500ms 后解禁按钮，不等待 api() 返回；接口耗时 >1.5s 时按钮提前恢复，
  // 可被重复点击导致 set-avatar/recheck 重复提交。改为返回「解禁函数」，由调用方在 finally 中释放。
  function btnBusy(btn) {
    if (!btn) return function () {};
    btn.disabled = true;
    return function () { btn.disabled = false; };
  }
  // esc() 统一走 core.js 全局（HTML 转义）
  // FE-2：危险 URL scheme（javascript:/data: 等）禁止进入 href，仅放行 http/https 或无 scheme 链接
  function safeHref(url) {
    if (typeof url !== 'string' || !url.trim()) return false;
    const schemeMatch = url.trim().match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
    if (!schemeMatch) return true;
    return /^(https?)$/i.test(schemeMatch[1]);
  }
  function safeParseTags(s) { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
  function platformLabel(p) { return ({ standalonewindows: 'PC', android: 'Android', ios: 'iOS' })[p] || p; }
  function worldTypeLabel(w) { return ({ lobby: 'Lobby', game: 'Game', social: 'Social', roleplay: 'Roleplay', horror: 'Horror', club: 'Club', hangout: 'Hangout', arena: 'Arena' })[w] || w; }
  function sizeLabel(s) { return ({ small: '<10MB', mid: '10-30MB', large: '>30MB' })[s] || s; }
  function statusText(s) { return ({ valid: '✅ ' + __('model_coll.status_valid'), invalid: '❌ ' + __('model_coll.status_invalid'), unknown: '❓ ' + __('model_coll.status_unknown') })[s] || s; }

  // ============ 事件绑定 ============
  function bindStatic() {
    if (window.__collStaticBound) return;
    window.__collStaticBound = true;
    qsa('.coll-kind', $('collKindBar')).forEach(b => b.addEventListener('click', () => {
      qsa('.coll-kind', $('collKindBar')).forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      state.kind = b.getAttribute('data-kind');
      loadItems(true);
    }));
    qsa('.coll-scope', $('collScopeBar')).forEach(b => b.addEventListener('click', () => {
      qsa('.coll-scope', $('collScopeBar')).forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      state.scope = b.getAttribute('data-scope');
      const mineOnly = ['collAddBtn','collScanMineBtn','collAddFolderBtn'];
      mineOnly.forEach(id => { const el = $(id); if (el) el.style.display = state.scope === 'public' ? 'none' : 'inline-flex'; });
      loadTags();
      loadItems(true);
      renderFolders();
    }));
    $('collSearch') && $('collSearch').addEventListener('input', debounce(() => {
      state.filters.search = $('collSearch').value.trim();
      loadItems(true);
    }, 350));
    ['Status', 'Platform', 'Category', 'Content'].forEach(k => {
      const el = $('coll' + k + 'Filter');
      el && el.addEventListener('change', () => {
        const map = { Status: 'status', Platform: 'platform', Category: 'category', Content: 'contentRating' };
        state.filters[map[k]] = el.value;
        loadItems(true);
      });
    });
    $('collSort') && $('collSort').addEventListener('change', () => { state.sort = $('collSort').value; loadItems(true); });
    $('collAddBtn') && $('collAddBtn').addEventListener('click', openAdd);
    $('collScanMineBtn') && $('collScanMineBtn').addEventListener('click', scanMine);
    $('collAddFolderBtn') && $('collAddFolderBtn').addEventListener('click', () => { $('collFolderName').value = ''; hideErr('collFolderError'); openModal('collFolderModal'); });
    $('collFolderConfirmBtn') && $('collFolderConfirmBtn').addEventListener('click', addFolder);
    $('collAddConfirmBtn') && $('collAddConfirmBtn').addEventListener('click', submitAdd);
    const collSearchBtn = $('collSearchModelsBtn');
    if (collSearchBtn) collSearchBtn.addEventListener('click', searchModels);
    const collSearchInput = $('collSearchModels');
    if (collSearchInput) collSearchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); searchModels(); } });
    qsa('.coll-modal-cancel').forEach(b => b.addEventListener('click', () => { closeModal('collAddModal'); closeModal('collFolderModal'); }));
    // 弹窗关闭
    qsa('#collDetailModal .modal-close, #collAddModal .modal-close, #collFolderModal .modal-close').forEach(b => b.addEventListener('click', () => {
      closeModal('collDetailModal'); closeModal('collAddModal'); closeModal('collFolderModal');
    }));
    if (!isAdmin()) { const a = document.querySelector('.admin-only'); if (a) a.style.display = 'none'; }
    bindWorldDiscover();
  }

  // debounce() 统一走 core.js 全局

  // ============ 入口 ============
  window.loadCollections = async function () {
    bindStatic();
    const mineOnly = ['collAddBtn','collScanMineBtn','collAddFolderBtn'];
    mineOnly.forEach(id => { const el = $(id); if (el) el.style.display = state.scope === 'public' ? 'none' : 'inline-flex'; });
    await loadFolders();
    loadTags();
    loadItems(true);
  };
})();
