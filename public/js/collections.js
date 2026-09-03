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

  // 全局状态
  const state = {
    kind: 'avatar_model',
    scope: 'mine',
    folder: 'all',
    filters: { search: '', status: '', platform: '', category: '', contentRating: '' },
    sort: 'heat',
    page: 1,
    pageSize: 24,
    total: 0,
    totalPages: 1,
    loading: false,
    items: [],
    folders: [],
    tags: []
  };

  const KIND_LABEL = {
    avatar_model: '🎭 ' + __('nav.modelcoll', __('auto_collections_1')),
    world: '🌐 ' + __('nav.worlds', __('auto_collections_2')),
    avatar_favorite: '🧑‍🦰 ' + __('nav.avatars', __('auto_collections_3'))
  };

  function $(id) { return document.getElementById(id); }
  function qsa(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  function isLoggedIn() { return !!window.__isLoggedIn && window.__isLoggedIn(); }
  function getUserId() { return (window.__user && window.__user.id) || null; }
  function isAdmin() { return window.__isAdmin && window.__isAdmin(); }

  async function api(path, opts) {
    opts = opts || {};
    const res = await fetch(path, Object.assign({ credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } }, opts));
    let data;
    try { data = await res.json(); } catch (e) { data = {}; }
    if (!res.ok || data.success === false) {
      throw new Error((data.error && data.error.message) || ('HTTP ' + res.status));
    }
    return data;
  }

  // ============ 数据加载 ============
  async function loadItems(reset) {
    if (state.loading) return;
    if (reset) { state.page = 1; state.items = []; }
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
      if (state.scope === 'mine' && state.folder !== 'all') params.set('folderId', state.folder === 'none' ? '' : state.folder);
      if (state.folder === 'none') params.set('folderId', '0');
      if (state.filters.search) params.set('search', state.filters.search);
      if (state.filters.status) params.set('status', state.filters.status);
      if (state.filters.platform) params.set('platform', state.filters.platform);
      if (state.filters.category) params.set('category', state.filters.category);
      if (state.filters.contentRating) params.set('contentRating', state.filters.contentRating);
      const endpoint = state.scope === 'public' ? '/api/collections/discover' : '/api/collections';
      const data = await api(endpoint + '?' + params.toString());
      state.items = data.items || [];
      state.total = data.total || 0;
      state.totalPages = data.totalPages || 1;
      renderItems();
      renderLoadMore();
    } catch (e) {
      if (list) renderEmpty(list, { icon: '⚠️', text: __('common.load_failed', __('auto_collections_4')) + (e.message ? '：' + e.message : '') });
    } finally {
      state.loading = false;
    }
  }

  function renderItems() {
    const list = $('collList');
    if (!list) return;
    if (!state.items.length) {
      renderEmpty(list, { icon: '📭', text: __('collections.empty', __('auto_collections_5')) });
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
        it.category === 'functional' ? __('model_coll.functional', __('auto_collections_6')) : __('model_coll.white', __('auto_collections_7'))
      ].filter(Boolean).join(' · ');
      const tagHtml = tags.slice(0, 4).map(t => `<span class="coll-card-tag">${esc(t)}</span>`).join('');
      meta += tagHtml ? '<div class="coll-card-tags">' + tagHtml + '</div>' : '';
    } else if (it.kind === 'world') {
      meta = it.world_type ? (worldTypeLabel(it.world_type)) : '';
      if (it.content_rating === '18+') meta += ' · 18+';
    }
    const pubBadges = it.visibility === 'public'
      ? `<span class="coll-badge public">🌐 ${__('collections.public', __('auto_collections_8'))}</span>` +
        ((state.scope === 'public' && it.show_author) ? `<span class="coll-badge pubby">👤 ${esc(it.owner_name || '')}</span>` : '')
      : '';
    const ratingHtml = it.kind === 'avatar_model'
      ? `<span class="coll-card-rating">⭐ ${Number(it.rating_avg || 0).toFixed(1)} (${it.rating_count || 0})</span>`
      : '';
    const isMine = state.scope !== 'public';
    const actionBtns = [];
    if (isMine) {
      if (it.kind === 'avatar_model') {
        actionBtns.push(`<button class="coll-card-btn" data-act="detail" data-id="${it.id}">📋 ${__('collections.detail', __('auto_collections_9'))}</button>`);
        actionBtns.push(`<button class="coll-card-btn" data-act="check" data-id="${it.id}">🔄 ${__('model_coll.recheck', __('auto_collections_10'))}</button>`);
        actionBtns.push(`<button class="coll-card-btn" data-act="setavatar" data-id="${it.id}">🎭 ${__('model_coll.copy', __('auto_collections_11'))}</button>`);
      } else {
        actionBtns.push(`<button class="coll-card-btn" data-act="detail" data-id="${it.id}">📋 ${__('collections.detail', __('auto_collections_12'))}</button>`);
      }
      actionBtns.push(`<button class="coll-card-btn danger" data-act="remove" data-id="${it.id}">🗑 ${__('common.delete', __('auto_collections_13'))}</button>`);
    } else {
      actionBtns.push(`<button class="coll-card-btn" data-act="detail" data-id="${it.id}">📋 ${__('collections.detail', __('auto_collections_14'))}</button>`);
      if (it.kind === 'avatar_model') {
        actionBtns.push(`<button class="coll-card-btn" data-act="setavatar" data-id="${it.id}">🎭 ${__('model_coll.copy', __('auto_collections_15'))}</button>`);
      }
      actionBtns.push(`<button class="coll-card-btn" data-act="copyid" data-id="${esc(it.target_id)}">📄 ${__('common.copy', __('auto_collections_16'))}</button>`);
    }

    return `<div class="coll-card status-${statusClass}" data-id="${it.id}">
      <div class="coll-card-thumb" style="background-image:url('${esc(thumb)}')"></div>
      <div class="coll-card-body">
        <div class="coll-card-title">${esc(it.name || it.target_id)}</div>
        <div class="coll-card-author">${esc(it.author || '')}</div>
        ${meta ? `<div class="coll-card-meta">${meta}</div>` : ''}
        <div class="coll-card-foot flex-row justify-between align-center">
          <div class="flex-row gap-4 align-center">${ratingHtml}${pubBadges}</div>
        </div>
        <div class="coll-card-actions flex-row gap-4 flex-wrap mt-4">${actionBtns.join('')}</div>
      </div>
    </div>`;
  }

  function bindCardEvents() {
    qsa('.coll-card', $('collList')).forEach(card => {
      const id = card.getAttribute('data-id');
      qsa('[data-act]', card).forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const act = btn.getAttribute('data-act');
          handleCardAction(act, id);
        });
      });
      card.addEventListener('click', () => openDetail(id));
    });
  }

  async function handleCardAction(act, id) {
    if (act === 'detail') return openDetail(id);
    if (act === 'copyid') {
      try {
        await navigator.clipboard.writeText(id);
        toast(__('common.operation_success', __('auto_collections_17')));
      } catch (e) { toast(e.message, 'error'); }
      return;
    }
    if (act === 'remove') {
      if (!confirm(__('collections.confirm_remove', __('auto_collections_18')))) return;
      try {
        await api('/api/collections/' + id, { method: 'DELETE' });
        toast(__('collections.removed', __('auto_collections_19')));
        await loadFolders();
        loadItems(true);
      } catch (e) { toast(e.message, 'error'); }
      return;
    }
    if (act === 'check') {
      try {
        btnBusy(event.target);
        const d = await api('/api/collections/' + id + '/check', { method: 'POST' });
        toast(d.status === 'valid' ? __('model_coll.valid', __('auto_collections_20')) : __('model_coll.invalid', __('auto_collections_21')) + (d.invalidReason || ''));
        loadItems(true);
      } catch (e) { toast(e.message, 'error'); }
      return;
    }
    if (act === 'setavatar') {
      if (!confirm(__('model_coll.confirm_copy', __('auto_collections_22')))) return;
      try {
        btnBusy(event.target);
        await api('/api/collections/' + id + '/set-avatar', { method: 'POST' });
        toast(__('model_coll.copied', __('auto_collections_23')));
      } catch (e) { toast(e.message, 'error'); }
      return;
    }
  }

  // ============ 加载更多 ============
  function renderLoadMore() {
    const wrap = $('collLoadMore');
    if (!wrap) return;
    if (state.page < state.totalPages) {
      wrap.innerHTML = `<button id="collLoadMoreBtn" class="btn btn-outline">${__('ui.load_more', __('auto_collections_24'))} (${state.page}/${state.totalPages})</button>`;
      $('collLoadMoreBtn').addEventListener('click', () => {
        state.page++;
        appendPage();
      });
    } else {
      wrap.innerHTML = state.total ? `<div class="text-center text-gray text-13 py-4">— ${__('collections.end', __('auto_collections_25'))} —</div>` : '';
    }
  }

  async function appendPage() {
    state.loading = true;
    try {
      const params = buildParams();
      const endpoint = state.scope === 'public' ? '/api/collections/discover' : '/api/collections';
      const data = await api(endpoint + '?' + params.toString());
      state.items = state.items.concat(data.items || []);
      const list = $('collList');
      const cur = list.innerHTML;
      const more = data.items.map(cardHtml).join('');
      list.innerHTML = cur + more;
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
    if (state.scope === 'public') { ul.innerHTML = '<li class="coll-folder public-hint">🌐 ' + __('collections.discover', __('auto_collections_26')) + '</li>'; return; }
    const base = `<li class="coll-folder ${state.folder === 'all' ? 'active' : ''}" data-folder="all"><span>${__('collections.all', __('auto_collections_27'))}</span><span class="coll-folder-count" id="collCountAll">0</span></li>
      <li class="coll-folder ${state.folder === 'none' ? 'active' : ''}" data-folder="none"><span>${__('collections.ungrouped', __('auto_collections_28'))}</span><span class="coll-folder-count" id="collCountNone">0</span></li>`;
    const items = state.folders.map(f => `<li class="coll-folder ${String(state.folder) === String(f.id) ? 'active' : ''}" data-folder="${f.id}"><span class="coll-folder-name">${esc(f.name)}</span><span class="coll-folder-count">${f.item_count || 0}</span><span class="coll-folder-del" data-del="${f.id}" title=__('auto_collections_29')>×</span></li>`).join('');
    ul.innerHTML = base + items;
    qsa('.coll-folder', ul).forEach(li => {
      li.addEventListener('click', (e) => {
        if (e.target.getAttribute('data-del')) {
          e.stopPropagation();
          const fid = e.target.getAttribute('data-del');
          if (confirm(__('collections.confirm_del_folder', __('auto_collections_30')))) deleteFolder(fid);
          return;
        }
        state.folder = li.getAttribute('data-folder');
        renderFolders();
        if (state.scope === 'mine') loadItems(true);
      });
    });
  }

  async function deleteFolder(fid) {
    try {
      await api('/api/collections/folders/' + fid, { method: 'DELETE' });
      toast(__('collections.folder_deleted', __('auto_collections_31')));
      await loadFolders();
      if (String(state.folder) === String(fid)) state.folder = 'all';
      loadItems(true);
    } catch (e) { toast(e.message, 'error'); }
  }

  async function addFolder() {
    const name = ($('collFolderName').value || '').trim();
    if (!name) { showErr('collFolderError', __('collections.folder_name_required', __('auto_collections_32'))); return; }
    try {
      await api('/api/collections/folders', { method: 'POST', body: JSON.stringify({ name }) });
      $('collFolderName').value = '';
      closeModal('collFolderModal');
      toast(__('collections.folder_added', __('auto_collections_33')));
      await loadFolders();
    } catch (e) { showErr('collFolderError', e.message); }
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
      if (!item) { toast(__('collections.not_found', __('auto_collections_34')), 'error'); return; }
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
    rows.push([__('auto_collections_35'), KIND_LABEL[it.kind] || it.kind]);
    rows.push([__('auto_collections_36'), it.author || '-']);
    rows.push([__('auto_collections_37'), statusText(it.status)]);
    if (it.kind === 'avatar_model') {
      rows.push([__('auto_collections_38'), it.platform ? platformLabel(it.platform) : '-']);
      rows.push([__('auto_collections_39'), it.size_category ? sizeLabel(it.size_category) : '-']);
      rows.push([__('auto_collections_40'), it.category === 'functional' ? __('model_coll.functional', __('auto_collections_41')) : __('model_coll.white', __('auto_collections_42'))]);
      rows.push([__('auto_collections_43'), it.content_rating === '18+' ? '18+' : __('auto_collections_44')]);
      rows.push([__('auto_collections_45'), String(it.heat || 0)]);
      rows.push([__('auto_collections_46'), String(it.favorite_count || 0)]);
      rows.push([__('auto_collections_47'), Number(it.rating_avg || 0).toFixed(1) + ' (' + (it.rating_count || 0) + ')']);
      if (it.booth_url) rows.push(['BOOTH', `<a href="${esc(it.booth_url)}" target="_blank" rel="noopener">${esc(it.booth_url)}</a>`]);
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
          <button class="btn btn-accent" id="collDetailSetAvatar">🎭 ${__('model_coll.copy', __('auto_collections_50'))}</button>
          <button class="btn btn-outline" id="collDetailCheck">🔄 ${__('model_coll.recheck', __('auto_collections_51'))}</button>
          ${pub.html}
        </div>`;
      } else {
        actions = `<div class="coll-detail-actions mt-8">${pub.html}</div>`;
      }
    } else {
      if (it.kind === 'avatar_model') {
        actions = `<div class="coll-detail-actions mt-8">
          <button class="btn btn-accent" id="collDetailSetAvatar">🎭 ${__('model_coll.copy', __('auto_collections_52'))}</button>
          <button class="btn btn-outline" id="collDetailCopyId">📄 ${__('common.copy', __('auto_collections_53'))}</button>
        </div>`;
      } else {
        actions = `<div class="coll-detail-actions mt-8">
          <button class="btn btn-outline" id="collDetailCopyId">📄 ${__('common.copy', __('auto_collections_54'))}</button>
        </div>`;
      }
    }
    const pubHintHtml = pub.hint ? `<div class="coll-detail-hint text-13 text-muted2 mt-4">⚠️ ${pub.hint}</div>` : '';
    const pubInfoHtml = (state.scope === 'public')
      ? `<div class="coll-detail-pubinfo mt-8">${it.show_author ? ('🌟 ' + __('collections.pub_by', __('auto_collections_55')) + ' <b>' + esc(it.owner_name || __('collections.anon', __('auto_collections_56'))) + '</b> ' + __('collections.pub_by_suffix', __('auto_collections_57'))) : '🕶️ ' + __('collections.pub_anon', __('auto_collections_58'))}</div>`
      : '';
    const folderSel = isMineDetail ? `<div class="mt-8"><label>${__('collections.folder', __('auto_collections_59'))}</label>
      <select id="collDetailFolder" class="search-box">${folderOptions(it.folder_id)}</select></div>` : '';
    const notesEl = isMineDetail ? `<div class="mt-8"><label>${__('collections.notes', __('auto_collections_60'))}</label>
      <textarea id="collDetailNotes" class="search-box" rows="2">${esc(it.notes || '')}</textarea>
      <button class="btn btn-outline mt-4" id="collDetailSaveNotes">${__('common.save', __('auto_collections_61'))}</button></div>` : '';

    body.innerHTML = `
      <div class="coll-detail flex-row gap-12">
        <div class="coll-detail-thumb" style="background-image:url('${esc(it.thumbnail || (window.__defaultAvatar || ''))}')"></div>
        <div class="coll-detail-info flex-1">
          <table class="coll-detail-table">${rows.map(r => `<tr><th>${esc(r[0])}</th><td>${r[1]}</td></tr>`).join('')}</table>
          ${tagHtml}
          <div class="mt-8"><label>${__('collections.description', __('auto_collections_62'))}</label><div class="coll-detail-desc">${esc(it.description || '-')}</div></div>
          ${pubInfoHtml}
          ${folderSel}
          ${notesEl}
          ${actions}
          ${pubHintHtml}
        </div>
      </div>`;
    // 绑定详情内操作
    const setBtn = $('collDetailSetAvatar');
    if (setBtn) setBtn.addEventListener('click', async () => {
      if (!confirm(__('model_coll.confirm_copy', __('auto_collections_63')))) return;
      try { await api('/api/collections/' + it.id + '/set-avatar', { method: 'POST' }); toast(__('model_coll.copied', __('auto_collections_64'))); } catch (e) { toast(e.message, 'error'); }
    });
    const checkBtn = $('collDetailCheck');
    if (checkBtn) checkBtn.addEventListener('click', async () => {
      try { const r = await api('/api/collections/' + it.id + '/check', { method: 'POST' }); toast(r.status === 'valid' ? __('model_coll.valid', __('auto_collections_65')) : __('model_coll.invalid', __('auto_collections_66'))); openDetail(it.id); } catch (e) { toast(e.message, 'error'); }
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
      try { await api('/api/collections/' + it.id, { method: 'PUT', body: JSON.stringify(body) }); toast(vis === 'public' ? __('collections.now_public', __('auto_collections_67')) : __('collections.now_private', __('auto_collections_68'))); openDetail(it.id); loadItems(false); } catch (e) { toast(e.message, 'error'); }
    });
    const saToggle = $('collDetailShowAuthor');
    if (saToggle) saToggle.addEventListener('change', async () => {
      try { await api('/api/collections/' + it.id, { method: 'PUT', body: JSON.stringify({ show_author: saToggle.checked }) }); toast(saToggle.checked ? __('collections.signed_on', __('auto_collections_69')) : __('collections.anon_on', __('auto_collections_70'))); openDetail(it.id); } catch (e) { toast(e.message, 'error'); }
    });
    const copyIdBtn = $('collDetailCopyId');
    if (copyIdBtn) copyIdBtn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(it.target_id); toast(__('common.operation_success', __('auto_collections_71'))); } catch (e) { toast(e.message, 'error'); }
    });
    const folderSelEl = $('collDetailFolder');
    if (folderSelEl) folderSelEl.addEventListener('change', async () => {
      try { await api('/api/collections/' + it.id, { method: 'PUT', body: JSON.stringify({ folder_id: folderSelEl.value || null }) }); toast(__('collections.saved', __('auto_collections_72'))); await loadFolders(); } catch (e) { toast(e.message, 'error'); }
    });
    const saveNotes = $('collDetailSaveNotes');
    if (saveNotes) saveNotes.addEventListener('click', async () => {
      try { await api('/api/collections/' + it.id, { method: 'PUT', body: JSON.stringify({ notes: $('collDetailNotes').value }) }); toast(__('collections.saved', __('auto_collections_73'))); } catch (e) { toast(e.message, 'error'); }
    });
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
        ? `<span class="coll-pub-by">🌟 ${__('collections.pub_by', __('auto_collections_78'))} ${esc(authorName)} ${__('collections.pub_by_suffix', __('auto_collections_79'))}</span>`
        : `<span class="coll-pub-by muted">🕶️ ${__('collections.pub_anon', __('auto_collections_80'))}</span>`;
      return {
        html: `<button class="btn btn-accent is-public-on" id="collDetailPublic" title=__('auto_collections_81')>🌐 ${__('collections.public_on_click_private')}</button>
               <label class="coll-pub-author-toggle"><input type="checkbox" id="collDetailShowAuthor" ${saChk}/> ${__('collections.show_my_name', __('auto_collections_82'))}</label>
               ${byLine}`,
        hint: ''
      };
    }
    if (blocked) {
      return {
        html: `<button class="btn btn-outline" id="collDetailPublic" disabled title=__('auto_collections_83')>🌐 ${__('collections.public_share_has_copy')}</button>`,
        hint: __('auto_collections_84')
      };
    }
    return {
      html: `<label class="coll-pub-author-toggle"><input type="checkbox" id="collDetailShowAuthor" checked/> ${__('collections.sign_public', __('auto_collections_85'))}</label>
             <button class="btn btn-outline" id="collDetailPublic" title=__('auto_collections_86')>🌐 公开分享</button>`,
      hint: ''
    };
  }

  function folderOptions(selectedId) {
    let html = '<option value="">' + __('collections.ungrouped', __('auto_collections_87')) + '</option>';
    state.folders.forEach(f => {
      html += `<option value="${f.id}" ${String(f.id) === String(selectedId) ? 'selected' : ''}>${esc(f.name)}</option>`;
    });
    return html;
  }

  // ============ 添加收藏 ============
  async function openAdd() {
    if (!isLoggedIn()) { toast(__('collections.login_required', __('auto_collections_88')), 'error'); return; }
    await loadFolders();
    // 预填分组下拉
    const sel = $('collAddFolder');
    sel.innerHTML = '<option value="">' + __('collections.ungrouped', __('auto_collections_89')) + '</option>' + state.folders.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('');
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
    if (!target_id) { showErr('collAddError', __('collections.id_required', __('auto_collections_90'))); return; }
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
      toast(__('collections.added', __('auto_collections_91')));
      state.kind = kind;
      await loadFolders();
      loadItems(true);
    } catch (e) { showErr('collAddError', e.message); }
  }

  // ============ VRCX 匿名模型搜索（迁移自孤儿 model-collections 模块） ============
  // 在添加收藏弹窗内直接搜索 VRChat Avatar，挑选后自动填入模型 ID。无需登录。
  async function searchModels() {
    const input = $('collSearchModels');
    const box = $('collSearchModelsResults');
    if (!input || !box) return;
    const q = input.value.trim();
    if (!q) { box.innerHTML = '<div class="coll-search-hint text-13 text-muted2">' + __('collections.search_enter', __('auto_collections_92')) + '</div>'; return; }
    box.innerHTML = '<div class="coll-search-hint text-13 text-muted2">' + __('common.loading', __('auto_collections_93')) + '</div>';
    try {
      const res = await fetch('/api/collections/search-models?q=' + encodeURIComponent(q) + '&n=12', { credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      const results = Array.isArray(data.results) ? data.results : [];
      if (!results.length) {
        const err = data.error ? ('：' + data.error) : '';
        box.innerHTML = '<div class="coll-search-hint text-13 text-muted2">' + __('model_coll.search_empty', __('auto_collections_94')) + err + '</div>';
        return;
      }
      box.innerHTML = results.map(r => `
        <div class="coll-search-result" data-id="${esc(r.id)}" data-name="${esc(r.name)}">
          <div class="coll-search-thumb" style="background-image:url('${esc(r.thumbnailImageUrl || r.imageUrl || (window.__defaultAvatar || ''))}')"></div>
          <div class="coll-search-info">
            <div class="coll-search-name">${esc(r.name || r.id)}</div>
            <div class="coll-search-author">${esc(r.authorName || '')}</div>
            <div class="coll-search-id">${esc(r.id)}</div>
          </div>
          <button type="button" class="coll-search-pick btn btn-outline btn-sm" data-id="${esc(r.id)}">${__('common.select', __('auto_collections_95'))}</button>
        </div>`).join('');
      qsa('.coll-search-result', box).forEach(el => {
        el.addEventListener('click', (e) => { if (e.target.closest('.coll-search-pick')) return; pickSearchModel(el.getAttribute('data-id')); });
      });
      qsa('.coll-search-pick', box).forEach(btn => {
        btn.addEventListener('click', (e) => { e.stopPropagation(); pickSearchModel(btn.getAttribute('data-id')); });
      });
    } catch (e) {
      box.innerHTML = '<div class="coll-search-hint text-13 text-red">' + __('common.load_failed', __('auto_collections_96')) + '：' + (e.message || '') + '</div>';
    }
  }

  function pickSearchModel(id) {
    const target = $('collAddTarget');
    if (target) { target.value = id; target.focus(); }
    toast(__('model_coll.id_filled', __('auto_collections_97')));
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
    box.innerHTML = '<div class="coll-search-hint text-13 text-muted2">' + __('common.loading', __('auto_collections_93')) + '</div>';
    try {
      let url, data;
      if (worldDiscoverState.q) {
        url = '/api/collections/search-worlds?q=' + encodeURIComponent(worldDiscoverState.q) + '&n=24';
        const res = await fetch(url, { credentials: 'same-origin' });
        data = await res.json().catch(() => ({}));
        if (!res.ok || data.success === false) throw new Error((data.error && data.error.message) || ('HTTP ' + res.status));
        renderWorldResults(data.results || []);
      } else {
        url = '/api/collections/popular-worlds?sort=' + encodeURIComponent(worldDiscoverState.sort) + '&n=24';
        const res = await fetch(url, { credentials: 'same-origin' });
        data = await res.json().catch(() => ({}));
        if (!res.ok || data.success === false) throw new Error((data.error && data.error.message) || ('HTTP ' + res.status));
        renderWorldResults(data.results || []);
      }
    } catch (e) {
      box.innerHTML = '';
      if (err) { err.textContent = __('world_discover.load_failed', '加载失败') + '：' + (e.message || ''); err.classList.remove('d-none'); }
    }
  }

  function renderWorldResults(worlds) {
    const box = $('collWorldDiscoverResults');
    if (!box) return;
    if (!worlds.length) {
      box.innerHTML = '<div class="coll-search-hint text-13 text-muted2">' + __('world_discover.search_empty', '未找到匹配的世界') + '</div>';
      return;
    }
    box.innerHTML = worlds.map(w => worldCardHtml(w)).join('');
    bindWorldCardEvents();
  }

  function worldCardHtml(w) {
    const thumb = w.thumbnailImageUrl || w.imageUrl || (window.__defaultAvatar || '');
    const release = w.releaseStatus === 'private' ? __('world_discover.release_private', '私有')
      : (w.releaseStatus === 'all' ? __('world_discover.release_all', '全部')
        : __('world_discover.release_public', '公开'));
    const tags = Array.isArray(w.tags) ? w.tags.slice(0, 4).map(t => `<span class="coll-card-tag">${esc(t)}</span>`).join('') : '';
    return `
      <div class="coll-card" data-wid="${esc(w.id)}">
        <div class="coll-card-thumb" style="background-image:url('${esc(thumb)}')"></div>
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
        toast(__('model_coll.id_filled', __('auto_collections_97')));
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
      toast(__('collections.scanning', __('auto_collections_98')));
      const d = await api('/api/collections/scan', { method: 'POST' });
      toast(__('collections.scan_done', __('auto_collections_99')) + `：${d.checked} / ${d.newInvalid}`);
      loadItems(true);
    } catch (e) { toast(e.message, 'error'); }
  }

  // ============ 辅助 ============
  function openModal(id) { const m = $(id); if (m) m.classList.add('show'); }
  function closeModal(id) { const m = $(id); if (m) m.classList.remove('show'); }
  function showErr(id, msg) { const e = $(id); if (e) { e.textContent = msg; e.classList.remove('d-none'); } }
  function hideErr(id) { const e = $(id); if (e) e.classList.add('d-none'); }
  function toast(msg, type) { if (window.__toast) window.__toast(msg, type); else console.log(msg); }
  function btnBusy(btn) { if (btn) { btn.disabled = true; setTimeout(() => btn.disabled = false, 1500); } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function safeParseTags(s) { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
  function platformLabel(p) { return ({ standalonewindows: 'PC', android: 'Android', ios: 'iOS' })[p] || p; }
  function worldTypeLabel(w) { return ({ lobby: 'Lobby', game: 'Game', social: 'Social', roleplay: 'Roleplay', horror: 'Horror', club: 'Club', hangout: 'Hangout', arena: 'Arena' })[w] || w; }
  function sizeLabel(s) { return ({ small: '<10MB', mid: '10-30MB', large: '>30MB' })[s] || s; }
  function statusText(s) { return ({ valid: '✅ ' + __('model_coll.status_valid', __('auto_collections_100')), invalid: '❌ ' + __('model_coll.status_invalid', __('auto_collections_101')), unknown: '❓ ' + __('model_coll.status_unknown', __('auto_collections_102')) })[s] || s; }

  // ============ 事件绑定 ============
  function bindStatic() {
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

  function debounce(fn, ms) { let t; return function () { clearTimeout(t); t = setTimeout(() => fn.apply(this, arguments), ms); }; }

  // ============ 入口 ============
  window.loadCollections = async function () {
    bindStatic();
    const mineOnly = ['collAddBtn','collScanMineBtn','collAddFolderBtn'];
    mineOnly.forEach(id => { const el = $(id); if (el) el.style.display = state.scope === 'public' ? 'none' : 'inline-flex'; });
    await loadFolders();
    loadTags();
    loadItems(true);
  };

  window.__collApi = { loadItems, loadFolders, openAdd, scanMine };
})();
