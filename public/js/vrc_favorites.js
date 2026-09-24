// F-20 VRChat 官方收藏管理 — 与站内收藏库（collections.js）并存
// 直接操作 VRChat 账号内的官方收藏：分组列表 / 重命名 / 清空 + 条目增删
// 数据归属 VRChat 官方，游戏内同样可见；写操作要求用户已绑定自己的 VRChat 账号
(function () {
  'use strict';
  if (window.__vrcfavLoaded) return;
  window.__vrcfavLoaded = true;

  function ensureI18n() {
    if (typeof window.__ !== 'undefined') return window.__;
    return function (k, d) { return d !== undefined ? d : k; };
  }
  const __ = ensureI18n();

  const KIND_LABEL = {
    world: '🌐 ' + __('nav.worlds', '世界'),
    avatar: '🎭 ' + __('nav.avatars', '头像'),
    friend: '🧑‍🦰 ' + __('friends.title', '好友')
  };
  const KIND_PREFIX = { world: 'wrld_', avatar: 'avtr_', friend: 'usr_' };
  // 官方收藏类型 → 本站本地收藏 kind（/api/collections）
  const LOCAL_KIND = { world: 'world', avatar: 'avatar_model', friend: 'avatar_favorite' };

  const state = {
    kind: 'world',
    group: '',            // 当前分组名（'' = 全部）
    groups: [],           // 全部分组（后端混合返回）
    items: [],
    loading: false,
    staticBound: false
  };

  function $(id) { return document.getElementById(id); }
  function qsa(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  // 统一走全局 window.api()：自动带 credentials / CSRF 令牌 / 超时；这里只做 JSON 解析与错误剥离
  async function api(path, opts) {
    opts = opts || {};
    const res = await window.api(path, opts);
    let data;
    try { data = await res.json(); } catch (e) { data = {}; }
    if (!res.ok || data.success === false) {
      throw new Error(errText(data) || ('HTTP ' + res.status));
    }
    return data;
  }

  // ============ 分组 ============
  async function loadGroups() {
    try {
      const d = await api('/api/vrc-favorites/groups?n=100');
      state.groups = d.groups || [];
      renderGroups();
    } catch (e) {
      toast(__('vrcfav.load_groups_fail', '收藏分组加载失败：') + e.message, 'error');
    }
  }

  function groupsOfKind() {
    return state.groups.filter(g => g.type === state.kind);
  }

  function renderGroups() {
    const ul = $('vrcfavGroupList');
    if (!ul) return;
    const list = [{ name: '', displayName: '', type: state.kind, count: null }, ...groupsOfKind()];
    ul.innerHTML = list.map(g => {
      const label = g.name ? `${esc(g.displayName || g.name)}` : `<span>${__('collections.all', '全部')}</span>`;
      const count = g.count != null ? `<span class="coll-folder-count">${g.count}</span>` : '';
      return `<li class="coll-folder ${String(state.group) === String(g.name) ? 'active' : ''}" data-group="${escAttr(g.name || '')}" data-type="${escAttr(g.type || state.kind)}" title="${escAttr(g.name || '全部')}">${label}${count}</li>`;
    }).join('');
    qsa('.coll-folder', ul).forEach(li => {
      li.addEventListener('click', () => {
        state.group = li.dataset.group || '';
        if (state.group) {
          const g = state.groups.find(x => x.name === state.group && x.type === state.kind);
          if (g && g.type) state.kind = g.type;
        }
        renderGroups();
        loadItems(true);
      });
    });
  }

  // ============ 条目 ============
  async function loadItems(reset) {
    if (state.loading) return;
    state.loading = true;
    const list = $('vrcfavList');
    if (reset && list) list.innerHTML = '<div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div>';
    try {
      const params = new URLSearchParams();
      params.set('type', state.kind);
      params.set('n', '50');
      if (state.group) params.set('tag', state.group);
      // 后端对收藏条目做名字/缩略图回源富化，冷启动耗时更高，放宽超时
      const d = await api('/api/vrc-favorites/items?' + params.toString(), { timeout: 20000 });
      state.items = d.items || [];
      renderItems();
    } catch (e) {
      if (list) list.innerHTML = `<div class="text-muted2">${esc(e.message)}</div>`;
    } finally {
      state.loading = false;
    }
  }

  function renderItems() {
    const list = $('vrcfavList');
    const more = $('vrcfavLoadMore');
    if (!list) return;
    if (!state.items.length) {
      list.innerHTML = `<div class="text-muted2">${__('vrcfav.empty', '该分类暂无官方收藏')}</div>`;
      if (more) more.innerHTML = '';
      return;
    }
    list.innerHTML = state.items.map(it => {
      const target = it.favoriteId || '';
      const kind = KIND_LABEL[it.type] || it.type || '';
      const tag = Array.isArray(it.tags) && it.tags.length ? it.tags[0] : '';
      const thumb = it.thumbnailImageUrl || '';
      const localKind = LOCAL_KIND[it.type] || '';
      const collectBtn = (target && localKind)
        ? `<button class="coll-card-btn" data-act="collect" data-kind="${escAttr(localKind)}" data-id="${escAttr(target)}">⭐ ${__('vrcfav.collect', '收藏到本站')}</button>`
        : '';
      return `
        <div class="coll-card" data-fvrt="${escAttr(it.id || '')}">
          <div class="coll-card-thumb" style="background-image:url('${escAttr(thumb)}')"></div>
          <div class="coll-card-body">
            <div class="coll-card-title">${esc(it.name || target || it.id || '')}</div>
            <div class="coll-card-author">${it.authorName ? esc(it.authorName) + ' · ' : ''}${esc(kind)}${tag ? ' · ' + esc(tag) : ''}</div>
            <div class="coll-card-actions flex-row gap-6 mt-8">
              ${collectBtn}
              <button class="coll-card-btn" data-act="copyid" data-id="${escAttr(target)}">📄 ${__('common.copy', '复制')}</button>
              <button class="coll-card-btn" data-act="remove" data-id="${escAttr(it.id || '')}">🗑️ ${__('vrcfav.remove', '移除')}</button>
            </div>
          </div>
        </div>`;
    }).join('');
    if (more) more.innerHTML = '';
  }

  // ============ 操作 ============
  async function addFavorite() {
    const input = $('vrcfavAddId');
    const raw = (input?.value || '').trim();
    if (!raw) { toast(__('vrcfav.need_id', '请输入要收藏的 ID'), 'warn'); return; }
    if (!state.group) { toast(__('vrcfav.need_group', '请先在左侧选择一个收藏分组'), 'warn'); return; }
    try {
      await api('/api/vrc-favorites/items', {
        method: 'POST',
        body: JSON.stringify({ type: state.kind, favoriteId: raw, tag: state.group })
      });
      if (input) input.value = '';
      toast(__('vrcfav.add_ok', '已加入官方收藏'), 'success');
      loadGroups();
      loadItems(true);
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function removeFavorite(fvrtId) {
    if (!fvrtId || !confirm(__('vrcfav.remove_confirm', '确定从官方收藏中移除吗？'))) return;
    try {
      await api('/api/vrc-favorites/items/' + encodeURIComponent(fvrtId), { method: 'DELETE' });
      toast(__('vrcfav.remove_ok', '已移除'), 'success');
      loadItems(true);
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  // 官方收藏条目一键收进本站本地收藏库（/api/collections），默认私密
  async function collectToLocal(btn) {
    const target = btn.dataset.id || '';
    const kind = btn.dataset.kind || '';
    if (!target || !kind || btn.dataset.busy) return;
    btn.dataset.busy = '1';
    try {
      await api('/api/collections', {
        method: 'POST',
        body: JSON.stringify({ kind, target_id: target, visibility: 'private' })
      });
      toast(__('vrcfav.collect_ok', '已收藏到本站'), 'success');
    } catch (e) {
      const msg = e.message || '';
      if (/已在收藏中|已收藏|已存在|already/i.test(msg)) toast(__('vrcfav.collected', '该内容已在本站收藏中'), 'info');
      else toast(msg || __('vrcfav.collect_fail', '收藏到本站失败'), 'error');
    } finally {
      delete btn.dataset.busy;
    }
  }

  async function renameGroup() {
    const g = state.groups.find(x => x.name === state.group && x.type === state.kind);
    if (!g) { toast(__('vrcfav.need_group_select', '请先选择一个具体分组（不能是"全部"）'), 'warn'); return; }
    const input = $('vrcfavRenameInput');
    const displayName = (input?.value || '').trim();
    if (!displayName) { toast(__('vrcfav.need_name', '请输入新分组显示名'), 'warn'); return; }
    try {
      await api(`/api/vrc-favorites/groups/${encodeURIComponent(g.type)}/${encodeURIComponent(g.name)}`, {
        method: 'PUT',
        body: JSON.stringify({ displayName, ownerUserId: g.ownerUserId || '' })
      });
      if (input) input.value = '';
      toast(__('vrcfav.rename_ok', '分组已重命名'), 'success');
      loadGroups();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function clearGroup() {
    const g = state.groups.find(x => x.name === state.group && x.type === state.kind);
    if (!g) { toast(__('vrcfav.need_group_select', '请先选择一个具体分组（不能是"全部"）'), 'warn'); return; }
    if (!confirm(__('vrcfav.clear_confirm', '确定清空该分组下的全部官方收藏吗？此操作不可撤销。'))) return;
    try {
      await api(`/api/vrc-favorites/groups/${encodeURIComponent(g.type)}/${encodeURIComponent(g.name)}?ownerUserId=${encodeURIComponent(g.ownerUserId || '')}`, { method: 'DELETE' });
      toast(__('vrcfav.clear_ok', '分组已清空'), 'success');
      loadGroups();
      loadItems(true);
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  // ============ 事件绑定（仅一次） ============
  function bindStatic() {
    if (state.staticBound) return;
    state.staticBound = true;

    const kindBar = $('vrcfavKindBar');
    if (kindBar) {
      kindBar.addEventListener('click', (ev) => {
        const btn = ev.target.closest('.coll-kind');
        if (!btn) return;
        state.kind = btn.dataset.kind || 'world';
        state.group = '';
        qsa('.coll-kind', kindBar).forEach(b => b.classList.toggle('active', b === btn));
        renderGroups();
        loadItems(true);
      });
    }

    const addBtn = $('vrcfavAddBtn');
    if (addBtn) addBtn.addEventListener('click', addFavorite);
    const addInput = $('vrcfavAddId');
    if (addInput) addInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') addFavorite(); });

    const refreshBtn = $('vrcfavRefreshBtn');
    if (refreshBtn) refreshBtn.addEventListener('click', () => { loadGroups(); loadItems(true); });
    const refreshGroupsBtn = $('vrcfavRefreshGroupsBtn');
    if (refreshGroupsBtn) refreshGroupsBtn.addEventListener('click', loadGroups);

    const renameBtn = $('vrcfavRenameBtn');
    if (renameBtn) renameBtn.addEventListener('click', renameGroup);
    const clearBtn = $('vrcfavClearBtn');
    if (clearBtn) clearBtn.addEventListener('click', clearGroup);

    const list = $('vrcfavList');
    if (list) {
      list.addEventListener('click', (ev) => {
        const btn = ev.target.closest('.coll-card-btn');
        if (!btn) return;
        if (btn.dataset.act === 'remove') removeFavorite(btn.dataset.id);
        if (btn.dataset.act === 'collect') collectToLocal(btn);
        if (btn.dataset.act === 'copyid' && btn.dataset.id) {
          const text = btn.dataset.id;
          if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => toast(__('common.copied', '已复制'), 'success'));
          else toast(text, 'info');
        }
      });
    }
  }

  // ============ 入口 ============
  window.loadVrcFavorites = function () {
    bindStatic();
    loadGroups();
    loadItems(true);
  };
})();
