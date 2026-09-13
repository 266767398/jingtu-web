// ==================== VRChat 收藏夹模块 ====================

let worldFavorites = [];
let avatarFavorites = [];
let avatarSearchResults = [];
let avatarSearching = false;
let favoritesActiveTab = 'worlds';

async function loadFavorites() {
  try {
    const [worldRes, avatarRes] = await Promise.all([
      api('/api/favorites/worlds', { method: 'GET' }),
      api('/api/favorites/avatars', { method: 'GET' })
    ]);
    if (worldRes.ok) { worldFavorites = (await worldRes.json()).favorites || []; }
    if (avatarRes.ok) { avatarFavorites = (await avatarRes.json()).favorites || []; }
    renderFavorites();
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('favorites.load_failed'), 'error');
  }
}

function renderFavorites() {
  const container = document.getElementById('favoritesContent');
  if (!container) return;
  
  if (favoritesActiveTab === 'worlds') {
    renderWorldFavorites();
  } else {
    renderAvatarFavorites();
  }
}

function renderWorldFavorites() {
  const container = document.getElementById('favoritesContent');
  if (!container) return;
  
  if (!worldFavorites || worldFavorites.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🌐</div>
        <div>${__('favorites.no_worlds')}</div>
        <button class="btn-primary mt-3" onclick="openWorldSearch('favorites')">${__('favorites.search_world')}</button>
      </div>`;
    return;
  }
  
  container.innerHTML = `
    <div class="favorites-grid">
      ${worldFavorites.map(w => `
        <div class="favorite-card" data-id="${w.id}" data-world-id="${w.world_id}">
          <div class="favorite-card-img">
            <img src="${escAttr(w.image_url || '/img/world-placeholder.png')}" alt="${escAttr(w.world_name)}" loading="lazy" onerror="this.src='/img/world-placeholder.png'">
            ${w.is_recommended ? '<span class="recommend-badge">⭐</span>' : ''}
          </div>
          <div class="favorite-card-info">
            <div class="favorite-card-name">${esc(w.world_name || __('unknown'))}</div>
            <div class="favorite-card-id">${w.world_id}</div>
          </div>
          <div class="favorite-card-actions">
            <button class="btn-icon" onclick="addWorldToVrc('${escJsStr(w.world_id)}')" data-i18n-tip="${__('favorites.add_to_vrc')}">🎮</button>
            <button class="btn-icon btn-danger" onclick="removeWorldFavorite(${w.id})" data-i18n-tip="${__('favorites.remove')}">🗑️</button>
          </div>
        </div>
      `).join('')}
    </div>`;
}

function renderAvatarFavorites() {
  const container = document.getElementById('favoritesContent');
  if (!container) return;
  
  if (!avatarFavorites || avatarFavorites.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🧑‍🦰</div>
        <div>${__('favorites.no_avatars')}</div>
        <button class="btn-primary mt-3" onclick="openAvatarSearch()">${__('favorites.search_avatar')}</button>
      </div>`;
    return;
  }
  
  container.innerHTML = `
    <div class="favorites-grid">
      ${avatarFavorites.map(a => `
        <div class="favorite-card" data-id="${a.id}" data-avatar-id="${a.avatar_id}">
          <div class="favorite-card-img">
            <img src="${escAttr(proxyAvatar(a.image_url) || '/img/avatar-placeholder.png')}" alt="${escAttr(a.avatar_name)}" loading="lazy" onerror="this.src='/img/avatar-placeholder.png'">
            ${a.is_recommended ? '<span class="recommend-badge">⭐</span>' : ''}
          </div>
          <div class="favorite-card-info">
            <div class="favorite-card-name">${esc(a.avatar_name || __('unknown'))}</div>
            <div class="favorite-card-id">${a.avatar_id}</div>
          </div>
          <div class="favorite-card-actions">
            <button class="btn-icon" onclick="switchToAvatar('${escJsStr(a.avatar_id)}')" data-i18n-tip="${__('favorites.switch_avatar')}">✨</button>
            <button class="btn-icon btn-danger" onclick="removeAvatarFavorite(${a.id})" data-i18n-tip="${__('favorites.remove')}">🗑️</button>
          </div>
        </div>
      `).join('')}
    </div>`;
}

function switchFavoritesTab(tab) {
  favoritesActiveTab = tab;
  document.getElementById('favoritesTabWorlds')?.classList.toggle('active', tab === 'worlds');
  document.getElementById('favoritesTabAvatars')?.classList.toggle('active', tab === 'avatars');
  renderFavorites();
}

async function addWorldToVrc(worldId) {
  const world = worldFavorites.find(w => w.world_id === worldId);
  if (!world) return;
  try {
    toast(__('favorites.launching') + world.world_name, 'info');
    window.open(`vrchat://launch?worldId=${worldId}`, '_blank');
  } catch (err) {
    toast(__('favorites.launch_failed'), 'error');
  }
}

async function switchToAvatar(avatarId) {
  const avatar = avatarFavorites.find(a => a.avatar_id === avatarId);
  if (!avatar) return;
  
  showConfirm(`${__('favorites.confirm_switch')} ${avatar.avatar_name}?`, async () => {
    try {
      const res = await api('/api/vrc/avatar/set', { method: 'POST', body: { avatarId } });
      if (res.ok) {
        toast(__('favorites.switch_success'), 'success');
      } else {
        const err = await res.json();
        toast(err.error || __('favorites.switch_failed'), 'error');
      }
    } catch (err) {
      if (isApiHandledError(err)) return;
      toast(__('favorites.switch_failed') + ': ' + err.message, 'error');
    }
  });
}

async function removeWorldFavorite(id) {
  try {
    const res = await api(`/api/favorites/worlds/${id}`, { method: 'DELETE' });
    if (res.ok) {
      worldFavorites = worldFavorites.filter(w => w.id !== id);
      renderWorldFavorites();
      toast(__('favorites.removed'), 'success');
    } else {
      const err = await res.json();
      toast(err.error || __('favorites.remove_failed'), 'error');
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('favorites.remove_failed') + ': ' + err.message, 'error');
  }
}

async function removeAvatarFavorite(id) {
  try {
    const res = await api(`/api/favorites/avatars/${id}`, { method: 'DELETE' });
    if (res.ok) {
      avatarFavorites = avatarFavorites.filter(a => a.id !== id);
      renderAvatarFavorites();
      toast(__('favorites.removed'), 'success');
    } else {
      const err = await res.json();
      toast(err.error || __('favorites.remove_failed'), 'error');
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('favorites.remove_failed') + ': ' + err.message, 'error');
  }
}

async function searchAvatars(query, limit = 10) {
  if (avatarSearching) return;
  avatarSearching = true;
  const container = document.getElementById('avatarSearchResults');
  if (container) container.innerHTML = '<div class="loading">' + __('vrc.searching') + '</div>';
  try {
    const res = await api(`/api/vrc/avatars/search?q=${encodeURIComponent(query)}&n=${limit}`, { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      avatarSearchResults = data.avatars || [];
      renderAvatarSearchResults(avatarSearchResults);
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('vrc.search_failed'), 'error');
  } finally {
    avatarSearching = false;
  }
}

function renderAvatarSearchResults(avatars) {
  const container = document.getElementById('avatarSearchResults');
  if (!container) return;
  if (!avatars || avatars.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">🧑‍🦰</div><div>' + __('vrc.no_results') + '</div></div>';
    return;
  }
  container.innerHTML = avatars.map(a => `
    <div class="world-search-item" onclick="selectAvatar('${escJsStr(a.id)}', '${escJsStr(a.name)}', '${escJsStr(a.imageUrl || '')}')">
      <img src="${escAttr(proxyAvatar(a.thumbnailImageUrl || a.imageUrl) || '/img/avatar-placeholder.png')}" class="world-search-thumb" alt="${escAttr(a.name)}" loading="lazy" onerror="this.src='/img/avatar-placeholder.png'">
      <div class="world-search-info">
        <div class="world-search-name">${esc(a.name)}</div>
        <div class="world-search-author">${__('vrc.by_author')} ${esc(a.authorName || __('unknown'))}</div>
        <div class="world-search-stats"><span>🔥 ${a.heat || 0}</span></div>
      </div>
    </div>
  `).join('');
}

async function selectAvatar(avatarId, avatarName, imageUrl) {
  try {
    const res = await api('/api/favorites/avatars', { method: 'POST', body: { avatarId, avatarName, imageUrl } });
    if (res.ok) {
      const data = await res.json();
      if (data.exists) {
        toast(__('favorites.already_exists'), 'info');
      } else {
        toast(__('favorites.added') + avatarName, 'success');
        avatarFavorites.unshift({ id: data.id, avatar_id: avatarId, avatar_name: avatarName, image_url: imageUrl, is_recommended: 0 });
        renderAvatarFavorites();
      }
    } else {
      const err = await res.json();
      toast(err.error || __('favorites.add_failed'), 'error');
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('favorites.add_failed') + ': ' + err.message, 'error');
  }
  closeModal('avatarSearchModal');
}

function openAvatarSearch() {
  const modal = document.getElementById('avatarSearchModal');
  if (modal) showModal('avatarSearchModal');
}

async function doAvatarSearch() {
  const q = document.getElementById('avatarSearchInput')?.value?.trim();
  if (!q) { toast(__('vrc.enter_keyword'), 'error'); return; }
  await searchAvatars(q);
}

function loadFavoritesPage() {
  switchFavoritesTab('worlds');
  loadFavorites();
}
