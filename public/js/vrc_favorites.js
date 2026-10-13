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

  function platformLabel(p) { return ({ standalonewindows: 'PC', android: 'Android', ios: 'iOS' })[p] || p || '-'; }
  function worldTypeLabel(w) { return ({ lobby: 'Lobby', game: 'Game', social: 'Social', roleplay: 'Roleplay', horror: 'Horror', club: 'Club', hangout: 'Hangout', arena: 'Arena' })[w] || w || '-'; }

  const state = {
    kind: 'world',
    group: '',            // 当前分组名（'' = 全部）
    groups: [],           // 全部分组（后端混合返回）
    items: [],
    offset:0,            // 已加载条目数，作为下一次请求的 offset
    fillOffset:0,        // J7: 当前补全目标页的起点偏移——fill 只替换该页切片，不整体覆盖已加载的分页
    pageSize:50,         // 每页条数（后端 n 最大 100）
    hasMore:false,       // 是否还有更多条目可加载
    loading: false,
    loadingMore: false,
    loadSeq: 0,           // P3-63: 最新请求优先标记，旧请求返回后不覆盖新结果
    fillSeq: 0,           // F1-45: 补全轮次独立版本号——加载更多/停止补全时作废在途 fill 轮次
    staticBound: false
  };

  function $(id) { return document.getElementById(id); }
  function qsa(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  // 统一走 core.js 全局 apiJson：window.api 自动带 credentials / CSRF 令牌 / 超时，apiJson 再做 JSON 解析与错误剥离
  function api(path, opts) { return window.apiJson(path, opts); }

  // ============ 分组 ============
  // P5-56: 1 秒防连点——快速切换 Kind/分组时吸收中间点击，只加载最后一次
  //（玩家正在看的那个页面），避免把请求连续塞进 VRChat 全站令牌桶排队到 12s 超时。
  let _reloadTimer = null;
  function scheduleReload(reset) {
    if (_reloadTimer) clearTimeout(_reloadTimer);
    _reloadTimer = setTimeout(() => {
      _reloadTimer = null;
      loadGroups();
      loadItems(reset);
    }, 1000);
  }

  async function loadGroups(force) {
    try {
      const d = await api('/api/vrc-favorites/groups?n=100' + (force ? '&refresh=1' : ''));
      state.groups = d.groups || [];
      renderGroups();
      if (force) showCachedHint(d.cached, false);
    } catch (e) {
      const msg = String((e && e.message) || '');
      if (e && (e.code === 'VRC_RATE_LIMITED' || e.code === 'VRC_RATE_TIMEOUT' || /rate[_ ]?limit|429|too many|排队/i.test(msg))) {
        toast(__('vrcfav.rate_queue', 'VRChat 限流排队中，稍后自动重试'), 'info');
        return;
      }
      toast(__('vrcfav.load_groups_fail', '收藏分组加载失败：') + msg, 'error');
    }
  }

  // 快照缓存命中提示：本地已同步的数据秒开展示，提示用户可点「刷新」获取最新
  function showCachedHint(cached, isItems) {
    let el = $('vrcfavCacheHint');
    const list = $(isItems ? 'vrcfavList' : 'vrcfavGroupList');
    if (!list) return;
    if (!el) {
      el = document.createElement('div');
      el.id = 'vrcfavCacheHint';
      list.parentNode.insertBefore(el, list.nextSibling);
    }
    if (!cached) { el.style.display = 'none'; return; }
    el.innerHTML = `<div class="text-gray text-13 py-2" style="opacity:.85">⚡ ${esc(__('vrcfav.cached_hint', '已加载本地同步数据（快速秒开）· 点击右上角「刷新」可获取 VRChat 最新'))}</div>`;
    el.style.display = '';
  }

  function groupsOfKind() {
    return state.groups.filter(g => g.type === state.kind);
  }

  function renderGroups() {
    const ul = $('vrcfavGroupList');
    if (!ul) return;
    const list = [{ name: '', displayName: __('collections.all'), type: state.kind, count: null }, ...groupsOfKind()];
    ul.innerHTML = list.map(g => {
      const label = g.name ? `${esc(g.displayName || g.name)}` : `<span>${__('collections.all', '全部')}</span>`;
      const count = g.count != null ? `<span class="coll-folder-count">${g.count}</span>` : '';
      return `<li class="coll-folder ${String(state.group) === String(g.name) ? 'active' : ''}" data-group="${escAttr(g.name || '')}" data-type="${escAttr(g.type || state.kind)}" title="${escAttr(g.name || __('collections.all'))}">${label}${count}</li>`;
    }).join('');
    qsa('.coll-folder', ul).forEach(li => {
      li.addEventListener('click', () => {
        state.group = li.dataset.group || '';
        if (state.group) {
          const g = state.groups.find(x => x.name === state.group && x.type === state.kind);
          if (g && g.type) state.kind = g.type;
        }
        renderGroups();
        scheduleReload(true);
      });
    });
  }

  // ============ 条目 ============
function cardHtml(it) {
  const target = it.favoriteId || '';
  const kind = KIND_LABEL[it.type] || it.type || '';
  const tag = Array.isArray(it.tags) && it.tags.length ? it.tags[0] : '';
  const thumb = it.thumbnailImageUrl || (window.__defaultAvatar || '');
  const localKind = LOCAL_KIND[it.type] || '';
  const thumbCls = it.type === 'world' ? ' coll-card-thumb--landscape' : '';
  const collectBtn = (target && localKind)
    ? `<button class="coll-card-btn" data-act="collect" data-kind="${escAttr(localKind)}" data-id="${escAttr(target)}">⭐ ${__('vrcfav.collect', '收藏到本站')}</button>`
    : '';
  return `
    <div class="coll-card" data-fvrt="${escAttr(it.id || '')}">
      <div class="coll-card-thumb${thumbCls}" style="background-image:url(${escCssUrl(thumb)})"></div>
      <div class="coll-card-body">
        <div class="coll-card-title">${esc(it.name || target || it.id || '')}</div>
        <div class="coll-card-author">${it.authorName ? esc(it.authorName) + ' · ' : ''}${esc(kind)}${tag ? ' · ' + esc(tag) : ''}</div>
        <div class="coll-card-actions flex-row gap-6 mt-8">
          ${collectBtn}
          <button class="coll-card-btn" data-act="detail" data-id="${escAttr(target)}">📋 ${__('vrcfav.detail', '详情')}</button>
          ${it.type === 'avatar' ? `<button class="coll-card-btn" data-act="setavatar" data-id="${escAttr(target)}">🎭 ${__('model_coll.copy', '切换')}</button>` : ''}
          <button class="coll-card-btn" data-act="copyid" data-id="${escAttr(target)}">📄 ${__('common.copy', '复制')}</button>
          <button class="coll-card-btn" data-act="remove" data-id="${escAttr(it.id || '')}">🗑️ ${__('vrcfav.remove', '移除')}</button>
        </div>
      </div>
    </div>`;
}

function appendItems(items) {
  const list = $('vrcfavList');
  if (!list) return;
  list.innerHTML += items.map(cardHtml).join('');
}

async function loadItems(reset, force) {
    // P3-63: 「最新请求优先」——快速切换 kind/分组时不再直接丢弃二次加载，
    // 而是用请求序号确保只有最新请求的结果能渲染/落库
    const my = ++state.loadSeq;
    stopFill();
    state.loading = true;
    if (reset) { state.offset = 0; state.items = []; state.hasMore = false; }
    const list = $('vrcfavList');
    if (reset && list) list.innerHTML = '<div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div><div class="skeleton-card"></div>';
    try {
      const params = new URLSearchParams();
      params.set('type', state.kind);
      params.set('n', String(state.pageSize));
      params.set('offset', String(state.offset));
      if (state.group) params.set('tag', state.group);
      if (force) params.set('refresh', '1');
      // 后端对收藏条目做名字/缩略图回源富化，冷启动耗时更高，放宽超时
      const d = await api('/api/vrc-favorites/items?' + params.toString(), { timeout: 20000 });
      if (my !== state.loadSeq) return; // 已有更新的请求发出，丢弃本次陈旧结果
      state.items = d.items || [];
      state.fillOffset = reset ? 0 : state.offset; // J7: 补全目标页固定为当前展示列表的起点页
      state.hasMore = (d.items || []).length >= state.pageSize;
      showCachedHint(d.cached, true);
      renderItems();
      renderLoadMore();
      scheduleFillIncomplete();
    } catch (e) {
      if (my !== state.loadSeq) return;
      const msg = String((e && e.message) || '');
      if (e && (e.code === 'VRC_RATE_LIMITED' || e.code === 'VRC_RATE_TIMEOUT' || /rate[_ ]?limit|429|too many|排队/i.test(msg))) {
        if (list) list.innerHTML = `<div class="text-muted2">⚠️ ${esc(__('vrcfav.rate_queue', 'VRChat 限流排队中，稍后自动重试'))}</div>`;
        if (reset) renderLoadMore();
        return;
      }
      if (list) list.innerHTML = `<div class="text-muted2">${esc(msg || e)}</div>`;
      if (reset) renderLoadMore();
    } finally {
      if (my === state.loadSeq) state.loading = false;
    }
  }

  function renderItems() {
    const list = $('vrcfavList');
    const more = $('vrcfavLoadMore');
    if (!list) return;
    if (!state.items.length) {
      list.innerHTML = `<div class="text-muted2">${__('vrcfav.empty', '该分类暂无官方收藏')}</div>`;
      renderLoadMore();
      return;
    }
    list.innerHTML = state.items.map(cardHtml).join('');
    renderLoadMore();
  }

  // V9.9 + P5-54: VRChat favorites 每条需逐条回源、且受全站 40/min 令牌桶限制，
  // 单次请求内未必能补全整页。渲染后若仍有缺名字的条目，自动重拉当前页：
  // 缓存随每次回源填充，重拉命中即补齐；遇限流（VRC_RATE_LIMITED / 429）时读取
  // core.js 写下的 _vrcRateLimitedUntil 冷却窗口，冷却到期后再拉（与后端负缓存对齐），
  // 自动轮次耗尽后提供手动「重试补全」按钮兜底。切换分组/加载更多时自动取消。
  const FILL_ROUNDS_CAP = 12;
  const FILL_DELAYS = [2500, 4000, 6000, 8000, 10000, 15000, 20000, 30000];

  function missingCount() { return state.items.filter(i => i && !i.name).length; }

  function stopFill() {
    state.fillSeq++; // F1-45: 作废所有在途补全轮次（含已排程与执行中的）
    state.fillRounds = 0;
    state.fillPending = false;
    state.fillRateLimited = false;
    if (state.fillTimer) { clearTimeout(state.fillTimer); state.fillTimer = null; }
    hideFillHint();
  }

  function fillDelayMs() {
    // 限流窗口内：以 core.js 记录的全局冷却时刻为准，到期后 +500ms 再拉
    const until = window._vrcRateLimitedUntil || 0;
    if (until > Date.now()) return Math.min(until - Date.now() + 500, 45000);
    // 上一轮仍在限流但窗口已过，保守退避 30s
    if (state.fillRateLimited) return 30000;
    return FILL_DELAYS[Math.min(state.fillRounds, FILL_DELAYS.length - 1)];
  }

  function scheduleFillIncomplete() {
    if (state.fillPending || !state.items.length) return;
    if (missingCount() === 0) { stopFill(); return; }
    if (state.fillRounds >= FILL_ROUNDS_CAP) { showFillHint(); return; }
    state.fillPending = true;
    const my = state.loadSeq;
    const myFill = state.fillSeq;
    const delay = fillDelayMs();
    state.fillTimer = setTimeout(() => runFillRound(my, myFill), delay);
  }

  async function runFillRound(my, myFill) {
    state.fillPending = false;
    state.fillTimer = null;
    if (myFill !== state.fillSeq) { stopFill(); return; }
    if (my !== state.loadSeq) { stopFill(); return; }
    if (missingCount() === 0) { stopFill(); return; }
    state.fillRounds++;
    const params = new URLSearchParams();
    params.set('type', state.kind);
    params.set('n', String(state.pageSize));
    params.set('offset', String(state.fillOffset)); // J7: 补全请求锚定在 fillOffset（当前补全页），不再把「已加载总数」当补全起点
    if (state.group) params.set('tag', state.group);
    try {
      const d = await api('/api/vrc-favorites/items?' + params.toString(), { timeout: 20000 });
      if (myFill !== state.fillSeq) { stopFill(); return; }
      if (my !== state.loadSeq) return;
      state.fillRateLimited = false;
      // J7: 只替换当前补全页切片，避免覆盖已加载的其他页
      const incoming = d.items || [];
      state.items.splice(state.fillOffset, state.pageSize, ...incoming);
      // J7: 切片替换后按「目标页起点+实际返回条数」规整长度，残留异常残页也归一
      state.items = state.items.slice(0, Math.max(state.items.length, state.fillOffset + incoming.length));
      // J7: 当前补全页已齐、但整体仍有缺失时，前进到下一页继续补全
      const slice = state.items.slice(state.fillOffset, state.fillOffset + state.pageSize);
      const sliceMissing = slice.filter(i => i && !i.name).length;
      if (sliceMissing === 0 && missingCount() > 0) state.fillOffset += state.pageSize;
      renderItems();
      renderLoadMore();
    } catch (e) {
      if (my !== state.loadSeq) return;
      // 限流：沿用 core.js 的全局冷却窗口，等冷却到期后再拉（不再重复弹提示）
      const msg = String((e && e.message) || '');
      if (e && (e.code === 'VRC_RATE_LIMITED' || /rate[_ ]?limit|429|too many/i.test(msg))) {
        state.fillRateLimited = true;
        if (e.retryAfter && (!window._vrcRateLimitedUntil || window._vrcRateLimitedUntil < Date.now())) {
          window._vrcRateLimitedUntil = Date.now() + e.retryAfter * 1000;
        }
      }
    }
    scheduleFillIncomplete();
  }

  function showFillHint() {
    let el = $('vrcfavFillHint');
    const list = $('vrcfavList');
    if (!list) return;
    if (!el) {
      el = document.createElement('div');
      el.id = 'vrcfavFillHint';
      list.parentNode.insertBefore(el, list.nextSibling);
    }
    el.innerHTML = `
      <div class="text-center text-gray text-13 py-2">${esc(__('vrcfav.fill_hint', '部分条目尚未加载完成（VRChat 限流或网络波动），稍后可自动重试'))}</div>
      <div class="text-center py-2"><button type="button" id="vrcfavFillRetryBtn" class="btn btn-xs btn-outline">🔄 ${esc(__('vrcfav.fill_retry', '重试补全'))}</button></div>`;
    el.style.display = '';
    const btn = $('vrcfavFillRetryBtn');
    if (btn) btn.addEventListener('click', () => { stopFill(); loadItems(true); });
  }

  function hideFillHint() {
    const el = $('vrcfavFillHint');
    if (el) el.style.display = 'none';
  }

  // ============ 加载更多 ============
  function renderLoadMore() {
    const wrap = $('vrcfavLoadMore');
    if (!wrap) return;
    if (!state.items.length || !state.hasMore) {
      if (state.items.length) {
        wrap.innerHTML = `<div class="text-center text-gray text-13 py-4">— ${__('collections.end', '没有更多了')} —</div>`;
      } else {
        wrap.innerHTML = '';
      }
      return;
    }
    wrap.innerHTML = `<button id="vrcfavLoadMoreBtn" class="btn btn-outline">${__('ui.load_more', '加载更多')}</button>`;
    const btn = $('vrcfavLoadMoreBtn');
    if (btn) {
      btn.disabled = !!state.loadingMore;
      btn.addEventListener('click', loadMore);
    }
  }

  async function loadMore() {
    if (state.loading || state.loadingMore || !state.hasMore) return;
    stopFill();
    state.loadingMore = true;
    renderLoadMore();
    const my = state.loadSeq;
    const pageOffset = state.items.length; // J7: 下一页起点 = 当前已加载总数，与补全目标页 fillOffset 解耦
    try {
      const params = new URLSearchParams();
      params.set('type', state.kind);
      params.set('n', String(state.pageSize));
      params.set('offset', String(pageOffset));
      if (state.group) params.set('tag', state.group);
      const d = await api('/api/vrc-favorites/items?' + params.toString(), { timeout: 20000 });
      if (my !== state.loadSeq) return;
      const incoming = d.items || [];
      state.items = state.items.concat(incoming);
      state.offset = state.items.length; // F1-45: 同步 offset，作为下次 loadMore 起点
      // J7: 固定 fillOffset——加载更多只追加新页，不改动当前正在补全的目标页
      state.hasMore = incoming.length >= state.pageSize;
      appendItems(incoming);
      renderLoadMore();
    } catch (e) {
      if (my !== state.loadSeq) return;
      const msg = String((e && e.message) || '');
      if (e && (e.code === 'VRC_RATE_LIMITED' || e.code === 'VRC_RATE_TIMEOUT' || /rate[_ ]?limit|429|too many|排队/i.test(msg))) {
        toast(__('vrcfav.rate_queue', 'VRChat 限流排队中，稍后自动重试'), 'info');
      } else {
        toast(msg || __('vrcfav.load_more_fail', '加载更多失败'), 'error');
      }
      renderLoadMore();
    } finally {
      if (my === state.loadSeq) state.loadingMore = false;
    }
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
    // 官方列表接口已对条目回源富化（name/authorName/thumbnailImageUrl），一并携带入库，
    // 后端收到 name+thumbnail 后不再回源 VRChat（省流量，收藏后立即可见）
    const it = state.items.find(x => String(x.favoriteId) === String(target)) || {};
    try {
      await api('/api/collections', {
        method: 'POST',
        body: JSON.stringify({
          kind,
          target_id: target,
          visibility: 'private',
          name: it.name || '',
          author: it.authorName || '',
          thumbnail: it.thumbnailImageUrl || ''
        })
      });
      toast(__('vrcfav.collect_ok', '已收藏到本站'), 'success');
      // 收藏进本地库后自动切到「📚 收藏」子视图并刷新列表，避免用户以为没存上
      if (typeof window.switchVrcView === 'function') window.switchVrcView('collections');
    } catch (e) {
      const msg = e.message || '';
      if (/已在收藏中|已收藏|已存在|already/i.test(msg)) toast(__('vrcfav.collected', '该内容已在本站收藏中'), 'info');
      else toast(msg || __('vrcfav.collect_fail', '收藏到本站失败'), 'error');
    } finally {
      delete btn.dataset.busy;
    }
  }

  // 直接切换穿戴该官方收藏模型（代表当前用户，仅 avatar 类型可切换）
  async function setVrcAvatar(id) {
    if (!id) return;
    showConfirm(__('model_coll.confirm_copy', '确定切换为该模型吗？'), async function () {
      try {
        await api('/api/groups/vrc/avatar/set', {
          method: 'POST',
          body: JSON.stringify({ avatarId: id })
        });
        toast(__('model_coll.copied', '已切换'), 'success');
      } catch (e) {
        toast(e.message || __('vrcfav.switch_fail', '切换失败'), 'error');
      }
    });
  }

  // P5-56: 官方收藏目标详情——先把列表富化数据秒开渲染，再异步调 /detail/:type/:id
  // 补齐完整字段（描述/平台/世界类型/容量等），渲染复用本地收藏详情样式（coll-detail-*）。
  async function showVrcDetail(target) {
    if (!target) return;
    const it = state.items.find(x => String(x.favoriteId) === String(target)) || {};
    const type = it.type || (target.indexOf('wrld_') === 0 ? 'world' : target.indexOf('avtr_') === 0 ? 'avatar' : 'friend');
    const modalId = 'vrcFavDetailModal';
    if (typeof ensureModal === 'function') ensureModal(modalId, it.name || target || __('vrcfav.detail', '详情'));
    const body = $(modalId + 'Body');
    if (!body) return;
    renderVrcDetailHtml(body, {
      type, id: target,
      name: it.name || target,
      thumbnailImageUrl: it.thumbnailImageUrl || '',
      authorName: it.authorName || ''
    });
    if (typeof showModal === 'function') showModal(modalId);
    try {
      const d = await api('/api/vrc-favorites/detail/' + encodeURIComponent(type) + '/' + encodeURIComponent(target), { timeout: 20000 });
      if ($(modalId + 'Body') !== body) return; // 弹窗已被关闭或切换
      renderVrcDetailHtml(body, d.item || {});
    } catch (e) {
      if ($(modalId + 'Body') !== body) return;
      const msg = String((e && e.message) || '');
      const hint = body.querySelector('.coll-detail-desc-hint');
      if (e && (e.code === 'VRC_RATE_LIMITED' || e.code === 'VRC_RATE_TIMEOUT' || /rate[_ ]?limit|429|too many|排队/i.test(msg))) {
        if (e.retryAfter && (!window._vrcRateLimitedUntil || window._vrcRateLimitedUntil < Date.now())) {
          window._vrcRateLimitedUntil = Date.now() + e.retryAfter * 1000;
        }
        if (hint) hint.textContent = '⚠️ ' + __('vrcfav.detail_queue', 'VRChat 限流排队中，稍后自动重试');
        return;
      }
      if (msg && hint) hint.textContent = '⚠️ ' + __('vrcfav.detail_fail', '完整信息加载失败') + '：' + msg;
    }
  }

  function renderVrcDetailHtml(body, it) {
    const rows = [];
    rows.push(['ID', it.id || it.targetId || '-']);
    rows.push([__('auto_collections_35', '类型'), KIND_LABEL[it.type] || it.type || '-']);
    rows.push([__('auto_collections_36', '作者'), it.authorName || it.authorId || '-']);
    if (it.type === 'avatar') {
      rows.push([__('model_coll.unity_version', 'Unity 版本'), it.unityVersion || '-']);
      rows.push([__('auto_collections_38', '平台'), platformLabel(it.platform)]);
      rows.push([__('auto_collections_37', '状态'), it.releaseStatus || '-']);
    } else if (it.type === 'world') {
      rows.push([__('auto_collections_48', '世界类型'), worldTypeLabel(it.worldType)]);
      rows.push([__('auto_collections_37', '状态'), it.releaseStatus || '-']);
      rows.push(['容量', it.capacity ? it.capacity + ' 人' : '-']);
      rows.push([__('auto_collections_38', '平台'), platformLabel(it.platform)]);
    } else if (it.type === 'friend') {
      rows.push([__('auto_collections_37', '状态'), it.status || '-']);
    }
    const tags = Array.isArray(it.tags) && it.tags.length ? it.tags : [];
    const tagHtml = tags.length ? `<div class="coll-detail-tags">${tags.map(t => `<span class="coll-card-tag">${esc(t)}</span>`).join('')}</div>` : '';
    const desc = it.description || it.bio || '';
    body.innerHTML = `
      <div class="coll-detail flex-row gap-12">
        <div class="coll-detail-thumb" style="background-image:url('${escCssUrl(it.thumbnailImageUrl || (window.__defaultAvatar || ''))}')"></div>
        <div class="coll-detail-info flex-1">
          <table class="coll-detail-table">${rows.map(r => `<tr><th>${esc(r[0])}</th><td>${esc(r[1])}</td></tr>`).join('')}</table>
          ${tagHtml}
          <div class="mt-8"><label>${__('collections.description', '描述')}</label><div class="coll-detail-desc">${esc(desc || '-')}</div></div>
          <div class="coll-detail-desc-hint text-13 text-muted2 mt-4"></div>
        </div>
      </div>`;
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
    showConfirm(__('vrcfav.clear_confirm', '确定清空该分组下的全部官方收藏吗？此操作不可撤销。'), async function () {
      try {
        await api(`/api/vrc-favorites/groups/${encodeURIComponent(g.type)}/${encodeURIComponent(g.name)}?ownerUserId=${encodeURIComponent(g.ownerUserId || '')}`, { method: 'DELETE' });
        toast(__('vrcfav.clear_ok', '分组已清空'), 'success');
        loadGroups();
        loadItems(true);
      } catch (e) {
        toast(e.message, 'error');
      }
    });
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
        scheduleReload(true);
      });
    }

    const addBtn = $('vrcfavAddBtn');
    if (addBtn) addBtn.addEventListener('click', addFavorite);
    const addInput = $('vrcfavAddId');
    if (addInput) addInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') addFavorite(); });

    const refreshBtn = $('vrcfavRefreshBtn');
    if (refreshBtn) refreshBtn.addEventListener('click', () => {
      // 手动刷新：绕过本地快照回源 VRChat 实时拉取，并同时触发后台同步作业，
      // 让后续访问/其他页面也命中最新快照（省 API、秒开）
      if (typeof window.vrcSync !== 'undefined' && window.vrcSync.startFavSync) {
        window.vrcSync.startFavSync({ startMsg: __('vrcsync.resyncing') });
      }
      loadGroups(true);
      loadItems(true, true);
    });
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
        if (btn.dataset.act === 'setavatar') setVrcAvatar(btn.dataset.id);
        if (btn.dataset.act === 'detail') showVrcDetail(btn.dataset.id);
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
