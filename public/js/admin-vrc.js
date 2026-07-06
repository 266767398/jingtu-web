// ==================== 管理员 - VRChat 系统管理模块 ====================

// ========== 系统状态统计 ==========
async function loadAdminStats() {
  try {
    const res = await api('/api/admin/stats', { method: 'GET' });
    if (res.ok) {
      const d = await res.json();
      const fields = ['statTotalUsers', 'statBannedUsers', 'statPendingReviews', 'statLiveEvents', 'statTotalPhotos', 'statTotalAnnouncements'];
      const values = [d.totalUsers, d.totalBanned, d.pendingApproval, d.totalEvents, d.totalPhotos, d.totalAnnouncements || 0];
      fields.forEach((id, i) => {
        const el = document.getElementById(id);
        if (el) {
          el.textContent = values[i] ?? '-';
          el.classList.remove('skeleton-stat');
        }
      });
    }
  } catch {}
}

// ========== VRChat 日历同步 ==========
async function syncVRChatEvents() {
  if (!currentUser || currentUser.role !== 'super_admin') {
    toast(__('permission_denied'), 'error');
    return;
  }
  try {
    toast(__('admin.vrc_syncing'), 'info');
    const res = await api('/api/events/sync-vrchat', { method: 'POST' });
    if (res.ok) {
      const data = await res.json();
      toast(__('admin_vrc.synced_events', {n: data.added || 0}), 'success');
      if (typeof loadEvents === 'function') loadEvents(currentEvtStatus);
    }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('admin_vrc.sync_failed') + ': ' + err.message, 'error'); }
}

// ========== 改名审核 ==========
function showNameReviewModal() {
  showModal('nameReviewModal');
  loadNameChangeRequests();
}

async function loadNameChangeRequests() {
  if (!currentUser || currentUser.role !== 'super_admin') {
    toast(__('admin_vrc.name_review_denied'), 'error');
    return;
  }
  try {
    const res = await api('/api/name-change/pending', { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      renderNameChangeRequests(data.requests || []);
    }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('admin_vrc.load_name_failed') + ': ' + err.message, 'error'); }
}

function renderNameChangeRequests(requests) {
  const container = document.getElementById('nameReviewList');
  if (!container) return;
  if (!requests || requests.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">📝</div><div>${__('admin_vrc.no_pending_requests')}</div></div>';
    return;
  }
  container.innerHTML = requests.map(r => `
    <div class="name-change-card">
      <div class="name-change-user">
        <img src="${escAttr(r.userAvatar || '/api/avatar/default')}" class="name-change-avatar" alt="${esc(r.userName || '')}" loading="lazy">
        <div>
          <div class="name-change-name">${esc(r.userName || '')}</div>
          <div class="name-change-time">${__('admin_vrc.applied_at')} ${fmtDate(r.createdAt)}</div>
        </div>
      </div>
      <div class="name-change-detail">
        <div>${__('admin_vrc.current_name')}<strong>${esc(r.currentName || '')}</strong></div>
        <div>${__('admin_vrc.requested_name')}<strong>${esc(r.requestedName || '')}</strong></div>
        ${r.reason ? `<div class="name-change-reason">${__('admin_vrc.reason')}${esc(r.reason)}</div>` : ''}
      </div>
      <div class="name-change-actions">
        <button class="btn btn-sm btn-accent" onclick="reviewNameChange('${escJsStr(String(r.id))}', 'approve')">${__('admin.approve')}</button>
        <button class="btn btn-sm btn-danger" onclick="reviewNameChange('${escJsStr(String(r.id))}', 'reject')">${__('admin.reject')}</button>
      </div>
    </div>
  `).join('');
}

async function reviewNameChange(requestId, action) {
  showConfirm(action === 'approve' ? __('admin_vrc.confirm_approve') : __('admin_vrc.confirm_reject'), async () => {
    try {
      const res = await api('/api/name-change/review', {
        method: 'POST',
        body: { id: requestId, action }
      });
      if (res.ok) {
        toast(action === 'approve' ? __('admin_vrc.approved') : __('admin_vrc.rejected'), 'success');
        loadNameChangeRequests();
      }
    } catch (err) { if (isApiHandledError(err)) return; toast(__('admin_vrc.op_failed') + ': ' + err.message, 'error'); }
  });
}

async function updateNameReviewPreview() {
  if (!currentUser || currentUser.role !== 'super_admin') return;
  try {
    const res = await api('/api/name-change/pending', { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      const count = (data.requests || []).length;
      const preview = document.getElementById('nameChangeList');
      if (preview) {
        preview.textContent = count > 0 ? __('admin_vrc.pending_count', {n: count}) : __('admin.no_pending_requests');
        preview.className = count > 0 ? 'text-13 text-accent font-600' : 'text-13 text-muted2';
      }
    }
  } catch {}
}

// ========== 操作日志（增强版） ==========
let operLogSearchTimer = null;
let operLogCurrentPage = 1;

function showAdminOperLog() {
  const el = document.getElementById('operLog');
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function onOperLogSearch(value) {
  clearTimeout(operLogSearchTimer);
  operLogSearchTimer = setTimeout(() => loadOperLog(1), 300);
}

function onOperLogFilter() {
  loadOperLog(1);
}

async function loadOperLog(page) {
  const container = document.getElementById('operLog');
  if (!container) return;
  operLogCurrentPage = page || 1;
  container.innerHTML = '<div class="skeleton-card-list" style="margin:4px"></div><div class="skeleton-card-list" style="margin:4px"></div>';
  try {
    const params = new URLSearchParams();
    params.set('page', operLogCurrentPage);
    params.set('pageSize', '20');
    const type = document.getElementById('operLogTypeFilter')?.value || '';
    const user = document.getElementById('operLogUserSearch')?.value?.trim() || '';
    if (type) params.set('type', type);
    if (user) params.set('user', user);
    const res = await api('/api/admin/logs?' + params.toString(), { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      const logs = data.logs || [];
      if (!logs || logs.length === 0) {
        container.innerHTML = '<div class="text-muted text-13 p-8">${__('admin_vrc.no_oper_log')}</div>';
        document.getElementById('operLogPagination').innerHTML = '';
        return;
      }
      container.innerHTML = logs.map(l =>
        `<div class="admin-log-item">
          <span class="text-muted2 text-11">${esc(l.adminVrcId || '')} · ${fmtDate(l.createTime)}</span>
          <div class="text-13 mt-2"><span class="admin-log-type">${esc(l.operType || '')}</span>${l.content ? '：' + esc(l.content) : ''}</div>
        </div>`
      ).join('');
      renderOperLogPagination(data);
    }
  } catch { container.innerHTML = '<div class="text-muted text-13 p-8">${__('admin_vrc.load_failed')}</div>'; }
}

function renderOperLogPagination(data) {
  const container = document.getElementById('operLogPagination');
  if (!container) return;
  if (!data || data.totalPages <= 1) { container.innerHTML = ''; return; }
  const current = data.page;
  const total = data.totalPages;
  let html = `<span class="text-12 text-muted2 mr-4">${__('admin_vrc.total_entries', {n: data.total})}</span>`;
  if (current > 1) {
    html += `<button class="btn btn-xs btn-outline" onclick="loadOperLog(1)" title="${__('admin_vrc.first_page')}">&laquo;</button>`;
    html += `<button class="btn btn-xs btn-outline" onclick="loadOperLog(${current - 1})">&lsaquo;</button>`;
  }
  const start = Math.max(1, current - 2);
  const end = Math.min(total, current + 2);
  for (let i = start; i <= end; i++) {
    html += `<button class="btn btn-xs ${i === current ? 'btn-accent' : 'btn-outline'}" onclick="loadOperLog(${i})">${i}</button>`;
  }
  if (current < total) {
    html += `<button class="btn btn-xs btn-outline" onclick="loadOperLog(${current + 1})">&rsaquo;</button>`;
    html += `<button class="btn btn-xs btn-outline" onclick="loadOperLog(${total})" title="${__('admin_vrc.last_page')}">&raquo;</button>`;
  }
  container.innerHTML = html;
}

// ========== 系统 VRChat 登录 ==========
async function checkSystemVrcStatus() {
  if (!currentUser || currentUser.role !== 'super_admin') return;
  try {
    const res = await api('/api/health', { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      const statusEl = document.getElementById('systemVrcStatus');
      const actionsEl = document.getElementById('systemVrcActions');
      if (!statusEl) return;
      if (data.systemVrcLogin) {
        statusEl.innerHTML = '<span class="text-green">🟢 ${__('admin_vrc.logged_in')}</span>';
        if (actionsEl) actionsEl.innerHTML = '<button class="btn btn-sm btn-outline" onclick="hideSystemVrcLogin()">${__('admin_vrc.refresh')}</button><button class="btn btn-sm btn-danger ml-6" onclick="doSystemVrcLogout()">${__('admin_vrc.logout')}</button>';
      } else {
        statusEl.innerHTML = '<span class="text-muted">🔴 ${__('admin_vrc.not_logged_in')}</span>';
        if (actionsEl) actionsEl.innerHTML = '<button class="btn btn-sm btn-accent" onclick="showSystemVrcLogin()">${__('admin_vrc.login_vrc')}</button>';
      }
    }
  } catch { document.getElementById('systemVrcStatus') && (document.getElementById('systemVrcStatus').innerHTML = '<span class="text-red">${__('admin_vrc.check_failed')}</span>'); }
}

function showSystemVrcLogin() {
  if (!currentUser || currentUser.role !== 'super_admin') {
    toast(__('admin_vrc.super_admin_only'), 'error');
    return;
  }
  document.getElementById('systemVrcLoginForm')?.classList.remove('d-none');
  document.getElementById('systemVrcError')?.classList.add('d-none');
}

function hideSystemVrcLogin() {
  document.getElementById('systemVrcLoginForm')?.classList.add('d-none');
  document.getElementById('systemVrc2faForm')?.classList.add('d-none');
}

async function doSystemVrcLogin() {
  if (!currentUser || currentUser.role !== 'super_admin') {
    toast(__('admin_vrc.super_admin_only'), 'error');
    return;
  }
  const username = document.getElementById('sysVrcUser')?.value?.trim();
  const password = document.getElementById('sysVrcPass')?.value;
  if (!username || !password) { toast(__('admin.fill_vrc_account'), 'error'); return; }
  try {
    const res = await api('/api/login', {
      method: 'POST',
      body: { username, password }
    });
    if (res.ok) {
      const data = await res.json();
      if (data.need2fa) {
        document.getElementById('systemVrc2faForm')?.classList.remove('d-none');
        const hint = document.getElementById('sysVrc2faHint');
        if (hint) hint.textContent = data.methods?.includes('emailOtp') ? __('admin.enter_email_code') : __('admin.enter_auth_code');
        toast(__('admin_vrc.need_2fa'), 'info');
        document.getElementById('sysVrc2faCode')?.focus();
        return;
      }
      toast(__('admin_vrc.login_ok_vrc'), 'success');
      hideSystemVrcLogin();
      checkSystemVrcStatus();
    } else {
      const errData = await res.json();
      const errEl = document.getElementById('systemVrcError');
      if (errEl) { errEl.textContent = errData.error || __('admin_vrc.login_failed'); errEl.classList.remove('d-none'); }
    }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('admin_vrc.login_failed_msg') + ': ' + err.message, 'error'); }
}

async function doSystemVrc2FA() {
  if (!currentUser || currentUser.role !== 'super_admin') {
    toast(__('admin_vrc.super_admin_only'), 'error');
    return;
  }
  const code = document.getElementById('sysVrc2faCode')?.value?.trim();
  if (!code || code.length < 4) { toast(__('admin_vrc.enter_full_code'), 'error'); return; }
  try {
    const res = await api('/api/2fa', {
      method: 'POST',
      body: { code }
    });
    if (res.ok) {
      const data = await res.json();
      if (data.success) {
        toast(__('admin_vrc.login_ok_excl'), 'success');
        hideSystemVrcLogin();
        checkSystemVrcStatus();
      }
    } else {
      const errEl2 = document.getElementById('systemVrc2faError');
      if (errEl2) { errEl2.textContent = __('admin_vrc.wrong_code'); errEl2.classList.remove('d-none'); }
    }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('admin_vrc.fa_failed'), 'error'); }
}

function cancelSystemVrc2FA() { hideSystemVrcLogin(); }

// ========== 群组同步 ==========
async function adminSyncGroupMembers() {
  if (!currentUser || (currentUser.role !== 'admin' && currentUser.role !== 'super_admin')) {
    toast(__('permission_denied'), 'error');
    return;
  }
  const btn = document.getElementById('btnSyncGroup');
  if (btn) { btn.disabled = true; btn.textContent = __('admin_vrc.syncing'); }
  try {
    toast(__('admin_vrc.syncing_group'), 'info');
    const res = await api('/api/group/members/sync', { method: 'POST' });
    if (res.ok) {
      const data = await res.json();
      toast(__('admin_vrc.synced_members', {n: data.total || 0}), 'success');
    } else {
      const err = await res.json();
      toast(err.error || __('admin_vrc.sync_err'), 'error');
    }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('admin_vrc.sync_failed') + ': ' + err.message, 'error'); }
  finally {
    if (btn) { btn.disabled = false; btn.textContent = __('admin_vrc.sync_group_btn'); }
  }
}

// ========== ⚙️ 系统设置 ==========
async function loadSystemConfig() {
  const contentEl = document.getElementById('adminSettingsContent');
  if (!contentEl) return;
  try {
    const res = await api('/api/admin/config', { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      const cfg = data || {};
      const setVal = (id, val) => {
        const el = document.getElementById(id);
        if (el) {
          if (el.type === 'checkbox') el.checked = val === '1' || val === true;
          else el.value = val || '';
        }
      };
      setVal('cfgSiteName', cfg.site_name);
      setVal('cfgAllowRegister', cfg.allow_register);
      setVal('cfgRequireApproval', cfg.require_approval);
      setVal('cfgSiteNotice', cfg.site_notice);
      setVal('cfgContactEmail', cfg.contact_email);
      setVal('cfgMaxPhotoUpload', cfg.max_photo_upload);
      setVal('cfgMaxVideoSize', cfg.max_video_size_mb);
      // Hero 装修
      setVal('cfgHeroTitle', cfg.hero_title);
      setVal('cfgHeroSubtitle', cfg.hero_subtitle);
      setVal('cfgHeroDescription', cfg.hero_description);
      setVal('cfgHeroBgUrl', cfg.hero_bg_url);
      setVal('cfgHeroBgColor', cfg.hero_bg_color);
      setVal('cfgHeroOverlayOpacity', cfg.hero_bg_overlay_opacity);
      setVal('cfgHeroAccentColor', cfg.hero_accent_color);
      setVal('cfgHeroShowStats', cfg.hero_show_stats);
      setVal('cfgHeroShowBadge', cfg.hero_show_badge);
      setVal('cfgHeroBadgeText', cfg.hero_badge_text);
      setVal('cfgHeroAnimation', cfg.hero_animation);
      setVal('cfgPostsPerPage', cfg.posts_per_page);
      setVal('cfgPostMaxImages', cfg.post_max_images);
      setVal('cfgPostMaxVideos', cfg.post_max_videos);
      setVal('cfgPostVideoMaxSize', cfg.post_video_max_size_mb);
      if (cfg.hero_title) {
        const pt = document.getElementById('heroPreviewTitle');
        if (pt) pt.textContent = cfg.hero_title;
      }
      if (cfg.hero_bg_url) {
        const pi = document.getElementById('heroPreviewImg');
        if (pi) pi.src = cfg.hero_bg_url;
      }
    }
  } catch (err) { if (isApiHandledError(err)) return; /* 静默失败 */ }
}

// Hero 背景 URL 预览实时更新
function previewHeroBg() {
  const url = document.getElementById('cfgHeroBgUrl')?.value?.trim();
  const pi = document.getElementById('heroPreviewImg');
  const pt = document.getElementById('heroPreviewTitle');
  if (url && pi) pi.src = url;
  if (pt) pt.textContent = document.getElementById('cfgHeroTitle')?.value?.trim() || __('app.title');
}

// 绑定 Hero 预览事件 — 在 loadSystemConfig 中不会覆盖，需在 admin tab 初始化时绑定一次
function bindHeroPreviewEvents() {
  ['cfgHeroBgUrl', 'cfgHeroTitle'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.removeEventListener('input', previewHeroBg);
      el.addEventListener('input', previewHeroBg);
    }
  });
}

async function saveSystemConfig() {
  if (!currentUser || currentUser.role !== 'super_admin') {
    toast(__('admin_vrc.super_admin_setting'), 'error');
    return;
  }
  const getVal = (id) => {
    const el = document.getElementById(id);
    if (!el) return '';
    return el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value.trim();
  };
  const config = {
    site_name: getVal('cfgSiteName'),
    allow_register: getVal('cfgAllowRegister'),
    require_approval: getVal('cfgRequireApproval'),
    site_notice: getVal('cfgSiteNotice'),
    contact_email: getVal('cfgContactEmail'),
    max_photo_upload: getVal('cfgMaxPhotoUpload'),
    max_video_size_mb: getVal('cfgMaxVideoSize'),
    hero_title: getVal('cfgHeroTitle'),
    hero_subtitle: getVal('cfgHeroSubtitle'),
    hero_description: getVal('cfgHeroDescription'),
    hero_bg_url: getVal('cfgHeroBgUrl'),
    hero_bg_color: getVal('cfgHeroBgColor'),
    hero_bg_overlay_opacity: getVal('cfgHeroOverlayOpacity'),
    hero_accent_color: getVal('cfgHeroAccentColor'),
    hero_show_stats: getVal('cfgHeroShowStats'),
    hero_show_badge: getVal('cfgHeroShowBadge'),
    hero_badge_text: getVal('cfgHeroBadgeText'),
    hero_animation: getVal('cfgHeroAnimation'),
    posts_per_page: getVal('cfgPostsPerPage'),
    post_max_images: getVal('cfgPostMaxImages'),
    post_max_videos: getVal('cfgPostMaxVideos'),
    post_video_max_size_mb: getVal('cfgPostVideoMaxSize'),
  };
  if (!config.site_name) { toast(__('fill_required'), 'error'); return; }
  try {
    const res = await api('/api/admin/config', { method: 'PUT', body: { config } });
    if (res.ok) {
      toast(__('admin.settings_saved'), 'success');
      loadSystemConfig();
    }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('admin_vrc.save_failed') + ': ' + err.message, 'error'); }
}

async function doSystemVrcLogout() {
  if (!currentUser || currentUser.role !== 'super_admin') {
    toast(__('admin_vrc.super_admin_feature'), 'error');
    return;
  }
  showConfirm(__('admin_vrc.confirm_logout_vrc'), async () => {
    try {
      const res = await api('/api/logout', { method: 'POST' });
      if (res.ok) {
        toast(__('admin_vrc.logged_out_vrc'), 'info');
        checkSystemVrcStatus();
      }
    } catch {}
  });
}
