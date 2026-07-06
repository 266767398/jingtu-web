// ==================== VRChat World 搜索 V5.6 ====================
let worldSearchResults = [];

async function searchWorlds(query, limit = 10) {
  try {
    const res = await api(`/api/vrc/worlds/search?q=${encodeURIComponent(query)}&n=${limit}`, { method: 'GET' });
    if (res.ok) { const data = await res.json(); worldSearchResults = data.worlds || []; renderWorldSearchResults(worldSearchResults); }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('vrc.search_failed'), 'error'); }
}

function renderWorldSearchResults(worlds) {
  const container = document.getElementById('worldSearchResults');
  if (!container) return;
  if (!worlds || worlds.length === 0) { container.innerHTML = '<div class="empty-state"><div class="empty-icon">🌐</div><div>${__('vrc.no_results')}</div></div>'; return; }
  container.innerHTML = worlds.map(w => `
    <div class="world-search-item" onclick="selectWorld('${escJsStr(w.id)}', '${escJsStr(w.name)}', '${escJsStr(w.imageUrl || '')}', document.getElementById('worldSearchModal')?.dataset?.context || 'evt')">
      <img src="${escAttr(w.thumbnailImageUrl || w.imageUrl || '/img/world-placeholder.png')}" class="world-search-thumb" alt="${escAttr(w.name)}" loading="lazy" onerror="this.src='/img/world-placeholder.png'">
      <div class="world-search-info">
        <div class="world-search-name">${esc(w.name)}</div>
        <div class="world-search-author">${__('vrc.by_author')} ${esc(w.authorName || __('unknown'))}</div>
        <div class="world-search-stats"><span>👥 ${__('vrc.players', {n: w.capacity || 0})}</span><span>🔥 ${w.heat || 0}</span></div>
      </div>
    </div>
  `).join('');
}

function selectWorld(worldId, worldName, worldImageUrl, context) {
  const prefix = context || 'evt';
  document.getElementById(`${prefix}WorldId`).value = worldId;
  document.getElementById(`${prefix}WorldName`).value = worldName;
  document.getElementById(`${prefix}WorldImageUrl`).value = worldImageUrl;
  const preview = document.getElementById(`${prefix}WorldPreview`);
  if (preview) {
    preview.style.display = 'flex';
    const thumb = document.getElementById(`${prefix}WorldThumb`);
    if (thumb) thumb.src = worldImageUrl || '';
    const name = document.getElementById(`${prefix}WorldNameDisplay`);
    if (name) name.textContent = worldName;
  }
  closeModal('worldSearchModal');
  toast(__('vrc.world_selected') + worldName, 'success');
}

function openWorldSearch(context) { const modal = document.getElementById('worldSearchModal'); if (modal) { modal.dataset.context = context; showModal('worldSearchModal'); } }
function clearWorld(prefix) {
  prefix = prefix || 'evt';
  document.getElementById(`${prefix}WorldId`).value = '';
  document.getElementById(`${prefix}WorldName`).value = '';
  document.getElementById(`${prefix}WorldImageUrl`).value = '';
  const preview = document.getElementById(`${prefix}WorldPreview`);
  if (preview) preview.style.display = 'none';
}
async function doWorldSearch() { const q = document.getElementById('worldSearchInput')?.value?.trim(); if (!q) { toast(__('vrc.enter_keyword'), 'error'); return; } await searchWorlds(q); }

// ==================== VRChat 2FA 弹窗 ====================
function showVrc2faModal(hint) {
  const modal = document.getElementById('vrc2faModal');
  if (modal) {
    const hintEl = document.getElementById('vrc2faHint');
    if (hintEl && hint) hintEl.textContent = hint;
    document.getElementById('vrc2faError')?.classList.add('d-none');
    document.getElementById('vrc2faCode')?.focus();
  }
  showModal('vrc2faModal');
}
function closeVrc2faModal() { closeModal('vrc2faModal'); const el = document.getElementById('vrc2faCode'); if (el) el.value = ''; }
async function submitVrc2fa() {
  const code = document.getElementById('vrc2faCode')?.value?.trim();
  if (!code || code.length < 4) { toast(__('vrc.enter_code'), 'error'); return; }
  try {
    const res = await api('/api/auth/vrchat-2fa', { method: 'POST', body: { code } });
    if (res.ok) {
      const data = await res.json();
      if (data.success) {
        currentUser = data.user;
        toast(__('vrc.login_success'), 'success');
        showApp();
        closeVrc2faModal();
      } else if (data.needBind) {
        toast(__('vrc.not_bound'), 'error');
        closeVrc2faModal();
      }
    } else {
      const err = await res.json();
      document.getElementById('vrc2faError').textContent = err.error || __('vrc.code_error');
      document.getElementById('vrc2faError').classList.remove('d-none');
    }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('vrc.verify_failed'), 'error'); }
}
