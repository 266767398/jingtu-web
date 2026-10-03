// ==================== VRChat World 搜索 V5.6 ====================
let worldSearchResults = [];
let worldSearching = false;

async function searchWorlds(query, limit = 10) {
  if (worldSearching) return;
  worldSearching = true;
  const container = document.getElementById('worldSearchResults');
  if (container) container.innerHTML = '<div class="loading">' + __('vrc.searching') + '</div>';
  try {
    const res = await api(`/api/vrc/worlds/search?q=${encodeURIComponent(query)}&n=${limit}`, { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      worldSearchResults = data.worlds || [];
      renderWorldSearchResults(worldSearchResults);
    }
  } catch (err) {
    if (isApiHandledError(err)) return;
    toast(__('vrc.search_failed'), 'error');
  } finally {
    worldSearching = false;
  }
}

function renderWorldSearchResults(worlds) {
  const container = document.getElementById('worldSearchResults');
  if (!container) return;
  if (!worlds || worlds.length === 0) { renderEmpty(container, { icon: '🌐', text: __('vrc.no_results') }); return; }
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

async function selectWorld(worldId, worldName, worldImageUrl, context) {
  const prefix = context || 'evt';
  const idEl = document.getElementById(`${prefix}WorldId`);
  // P3-66: WorldId 输入框缺失说明表单不在当前页面，直接忽略，避免误报"已选择"
  if (!idEl) return;
  idEl.value = worldId;
  const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  setVal(`${prefix}WorldName`, worldName);
  setVal(`${prefix}WorldImageUrl`, worldImageUrl);
  const preview = document.getElementById(`${prefix}WorldPreview`);
  if (preview) {
    showEl(preview);
    const thumb = document.getElementById(`${prefix}WorldThumb`);
    if (thumb) thumb.src = worldImageUrl || '';
    const name = document.getElementById(`${prefix}WorldNameDisplay`);
    if (name) name.textContent = worldName;
  }
  closeModal('worldSearchModal');
  toast(__('vrc.world_selected') + worldName, 'success');
}

function openWorldSearch(context) {
  const modal = document.getElementById('worldSearchModal');
  if (!modal) return;
  const parentModal = Array.from(document.querySelectorAll('.modal'))
    .find(candidate => candidate.id !== modal.id && getComputedStyle(candidate).display !== 'none');
  if (parentModal) modal.dataset.returnToModal = parentModal.id;
  else delete modal.dataset.returnToModal;
  modal.dataset.context = context;
  showModal('worldSearchModal');
}
function clearWorld(prefix) {
  prefix = prefix || 'evt';
  const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  setVal(`${prefix}WorldId`, '');
  setVal(`${prefix}WorldName`, '');
  setVal(`${prefix}WorldImageUrl`, '');
  const preview = document.getElementById(`${prefix}WorldPreview`);
  if (preview) hideEl(preview);
}
async function doWorldSearch() { const q = document.getElementById('worldSearchInput')?.value?.trim(); if (!q) { toast(__('vrc.enter_keyword'), 'error'); return; } await searchWorlds(q); }

// ==================== VRChat 2FA 弹窗 ====================
let _vrc2faToken = null;
function showVrc2faModal(hint, loginToken) {
  _vrc2faToken = loginToken || null;
  const modal = document.getElementById('vrc2faModal');
  if (modal) {
    const hintEl = document.getElementById('vrc2faHint');
    if (hintEl && hint) hintEl.textContent = hint;
    document.getElementById('vrc2faError')?.classList.add('d-none');
    document.getElementById('vrc2faCode')?.focus();
  }
  showModal('vrc2faModal');
}
function closeVrc2faModal() { closeModal('vrc2faModal'); const el = document.getElementById('vrc2faCode'); if (el) el.value = ''; _vrc2faToken = null; }
async function submitVrc2fa() {
  const code = document.getElementById('vrc2faCode')?.value?.trim();
  if (!code || code.length < 4) { toast(__('vrc.enter_code'), 'error'); return; }
  if (!_vrc2faToken) { toast(__('vrc.send_code_first'), 'error'); return; }
  try {
    const res = await api('/api/auth/vrchat-2fa', { method: 'POST', body: { code, loginToken: _vrc2faToken } });
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
      document.getElementById('vrc2faError').textContent = errText(err) || __('vrc.code_error');
      document.getElementById('vrc2faError').classList.remove('d-none');
    }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('vrc.verify_failed'), 'error'); }
}
