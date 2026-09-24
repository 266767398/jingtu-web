// ==================== 管理员 - VRChat 系统管理模块 ====================

function initVrcEventDelegates() {
  const container = document.getElementById('tab-admin');
  if (container && !container._vrcDelegateInit) {
    container._vrcDelegateInit = true;
    container.addEventListener('click', handleVrcAction);
  }
  const reviewList = document.getElementById('nameReviewList');
  if (reviewList && !reviewList._vrcDelegateInit) {
    reviewList._vrcDelegateInit = true;
    reviewList.addEventListener('click', handleVrcAction);
  }
}

function handleVrcAction(e) {
    const el = e.target.closest('[data-vrc-action], [data-action]');
    if (!el) return;
    
    if (el.hasAttribute('data-vrc-action')) {
      const action = el.dataset.vrcAction;
      const id = el.dataset.id;
      const value = el.dataset.value;
      
      switch (action) {
        case 'show-name-review':
          showNameReviewModal();
          break;
        case 'review-name':
          reviewNameChange(id, value);
          break;
        case 'hide-login':
          hideSystemVrcLogin();
          break;
        case 'do-logout':
          doSystemVrcLogout();
          break;
        case 'show-login':
          showSystemVrcLogin();
          break;
        case 'load-notifications':
          loadVrcNotifications();
          break;
      }
    } else if (el.hasAttribute('data-action')) {
      const action = el.dataset.action;
      const value = parseInt(el.dataset.value);
      
      switch (action) {
        case 'load-oper-log':
          loadOperLog(value);
          break;
      }
    }
}

// ========== 数据库管理权限检查（已移除） ==========
// checkDbPermission 删除：它只是 `if (typeof window.showDbSection === 'function')`
// 的空壳，而 showDbSection 只存在于从未被 index.html 引入的 admin-db.js，
// 判断永远为假 —— 也就是说 ui.js 里 switchTab('admin') 那行调用一直是个空操作。
// 数据库管理面板本来就没有对应的 HTML，接线时请一并恢复。

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
  initVrcEventDelegates();
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
    renderEmpty(container, { icon: '📝', text: __('admin_vrc.no_pending_requests') });
    return;
  }
  container.innerHTML = requests.map(r => `
    <div class="name-change-card">
      <div class="name-change-user">
        <img src="/api/avatar/default" class="name-change-avatar" alt="${esc(r.displayName || '')}" loading="lazy">
        <div>
          <div class="name-change-name">${esc(r.displayName || '')}</div>
          <div class="name-change-time">${__('admin_vrc.applied_at')} ${fmtDate(r.createTime)}</div>
        </div>
      </div>
      <div class="name-change-detail">
        <div>${__('admin_vrc.current_name')}<strong>${esc(r.oldName || '')}</strong></div>
        <div>${__('admin_vrc.requested_name')}<strong>${esc(r.newName || '')}</strong></div>
        ${r.reason ? `<div class="name-change-reason">${__('admin_vrc.reason')}${esc(r.reason)}</div>` : ''}
      </div>
      <div class="name-change-actions">
        <button class="btn btn-sm btn-accent" data-vrc-action="review-name" data-id="${escAttr(String(r.id))}" data-value="approve">${__('admin.approve')}</button>
        <button class="btn btn-sm btn-danger" data-vrc-action="review-name" data-id="${escAttr(String(r.id))}" data-value="reject">${__('admin.reject')}</button>
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
        updateNameReviewPreview();
        if (typeof loadAdminStats === 'function') loadAdminStats();
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
        preview.innerHTML = count > 0
          ? `<button type="button" class="btn btn-sm btn-accent" data-vrc-action="show-name-review">${esc(__('admin_vrc.pending_count', {n: count}))} →</button>`
          : `<p class="text-13 text-muted2">${esc(__('admin.no_pending_requests'))}</p>`;
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
  initVrcEventDelegates();
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
    const res = await api('/api/admin/oper-logs?' + params.toString(), { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      const logs = data.logs || [];
      if (!logs || logs.length === 0) {
        container.innerHTML = '<div class="text-muted text-13 p-8">' + __('admin_vrc.no_oper_log') + '</div>';
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
  } catch { container.innerHTML = '<div class="text-muted text-13 p-8">' + __('admin_vrc.load_failed') + '</div>'; }
}

function renderOperLogPagination(data) {
  const container = document.getElementById('operLogPagination');
  if (!container) return;
  if (!data || data.totalPages <= 1) { container.innerHTML = ''; return; }
  const current = data.page;
  const total = data.totalPages;
  let html = `<span class="text-12 text-muted2 mr-4">${__('admin_vrc.total_entries', {n: data.total})}</span>`;
  if (current > 1) {
    html += `<button class="btn btn-xs btn-outline" data-action="load-oper-log" data-value="1" title="${__('admin_vrc.first_page')}">&laquo;</button>`;
    html += `<button class="btn btn-xs btn-outline" data-action="load-oper-log" data-value="${current - 1}">&lsaquo;</button>`;
  }
  const start = Math.max(1, current - 2);
  const end = Math.min(total, current + 2);
  for (let i = start; i <= end; i++) {
    html += `<button class="btn btn-xs ${i === current ? 'btn-accent' : 'btn-outline'}" data-action="load-oper-log" data-value="${i}">${i}</button>`;
  }
  if (current < total) {
    html += `<button class="btn btn-xs btn-outline" data-action="load-oper-log" data-value="${current + 1}">&rsaquo;</button>`;
    html += `<button class="btn btn-xs btn-outline" data-action="load-oper-log" data-value="${total}" title="${__('admin_vrc.last_page')}">&raquo;</button>`;
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
        statusEl.innerHTML = '<span class="text-green">🟢 ' + __('admin_vrc.logged_in') + '</span>';
        if (actionsEl) actionsEl.innerHTML = '<button class="btn btn-sm btn-outline" data-vrc-action="hide-login">' + __('admin_vrc.refresh') + '</button><button class="btn btn-sm btn-danger ml-6" data-vrc-action="do-logout">' + __('admin_vrc.logout') + '</button>';
        // V8.2: 展示系统 VRChat cookie 软性过期设置与剩余有效期
        const wrap = document.getElementById('systemVrcExpireWrap');
        if (wrap) {
          const remain = data.vrcCookieExpiresAt
            ? new Date(data.vrcCookieExpiresAt).toLocaleString()
            : __('admin_vrc.never_expire');
          wrap.classList.remove('d-none');
          wrap.innerHTML =
            '<div class="vrc-expire-row">' +
              '<label class="vrc-expire-label">' + __('admin_vrc.cookie_expire_label') + '</label>' +
              '<select id="vrcCookieExpireSel" class="form-control form-control-sm">' +
                '<option value="0"' + (data.vrcCookieExpireDays === 0 ? ' selected' : '') + '>' + __('admin_vrc.expire_forever') + '</option>' +
                '<option value="7"' + (data.vrcCookieExpireDays === 7 ? ' selected' : '') + '>' + __('admin_vrc.expire_week') + '</option>' +
                '<option value="30"' + (data.vrcCookieExpireDays === 30 ? ' selected' : '') + '>' + __('admin_vrc.expire_month') + '</option>' +
                '<option value="90"' + (data.vrcCookieExpireDays === 90 ? ' selected' : '') + '>' + __('admin_vrc.expire_quarter') + '</option>' +
                '<option value="180"' + (data.vrcCookieExpireDays === 180 ? ' selected' : '') + '>' + __('admin_vrc.expire_half_year') + '</option>' +
                '<option value="365"' + (data.vrcCookieExpireDays === 365 ? ' selected' : '') + '>' + __('admin_vrc.expire_year') + '</option>' +
              '</select>' +
              '<button class="btn btn-sm btn-accent" onclick="saveVrcCookieExpire()">' + __('admin_vrc.save') + '</button>' +
            '</div>' +
            '<div class="vrc-expire-hint text-muted">' + __('admin_vrc.expire_remain', { t: remain }) + '</div>';
        }
      } else {
        const wrap = document.getElementById('systemVrcExpireWrap');
        if (wrap) wrap.classList.add('d-none');
        statusEl.innerHTML = '<span class="text-muted">🔴 ' + __('admin_vrc.not_logged_in') + '</span>';
        if (actionsEl) actionsEl.innerHTML = '<button class="btn btn-sm btn-accent" data-vrc-action="show-login">' + __('admin_vrc.login_vrc') + '</button>';
      }
    }
  } catch { document.getElementById('systemVrcStatus') && (document.getElementById('systemVrcStatus').innerHTML = '<span class="text-red">' + __('admin_vrc.check_failed') + '</span>'); }
}

function showSystemVrcLogin() {
  if (!currentUser || currentUser.role !== 'super_admin') {
    toast(__('admin_vrc.super_admin_only'), 'error');
    return;
  }
  document.getElementById('systemVrcLoginForm')?.classList.remove('d-none');
  document.getElementById('systemVrcError')?.classList.add('d-none');
}

// F-19: 拉取系统 VRChat 账号的官方通知列表（REST 兜底，与 pipeline WS 实时推送互补）
async function loadVrcNotifications() {
  if (!currentUser || (currentUser.role !== 'admin' && currentUser.role !== 'super_admin')) return;
  const listEl = document.getElementById('vrcNotifList');
  if (!listEl) return;
  listEl.innerHTML = '<p class="text-muted2 text-13">' + __('admin_vrc.notif_loading') + '</p>';
  try {
    const res = await api('/api/vrc-notifications?n=50');
    const data = await res.json();
    if (!res.ok) throw new Error(data?.message || __('admin_vrc.notif_fail'));
    const list = Array.isArray(data.notifications) ? data.notifications : [];
    if (!list.length) {
      listEl.innerHTML = '<p class="text-muted2 text-13">' + __('admin_vrc.notif_empty') + '</p>';
      return;
    }
    listEl.innerHTML = list.map(nt => {
      const time = nt.createdAt ? new Date(nt.createdAt).toLocaleString() : '';
      const msg = nt.message ? '<div class="text-13 text-muted">' + esc(String(nt.message).slice(0, 200)) + '</div>' : '';
      return '<div class="vrc-notif-item mb-8"><div class="text-13"><strong>' + esc(nt.title || nt.type || 'VRChat') + '</strong>' +
        (nt.senderUsername ? ' <span class="text-muted2">@' + esc(nt.senderUsername) + '</span>' : '') +
        (time ? ' <span class="text-muted2">· ' + time + '</span>' : '') + '</div>' + msg + '</div>';
    }).join('');
  } catch (e) {
    listEl.innerHTML = '<p class="text-red text-13">' + (e.message || __('admin_vrc.notif_fail')) + '</p>';
  }
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
        const methods = Array.isArray(data.methods) ? data.methods : [];
        const method = methods.includes('emailOtp')
          ? 'emailOtp'
          : (methods.includes('totp') ? 'totp' : 'otp');
        const form = document.getElementById('systemVrc2faForm');
        if (form) form.dataset.method = method;
        document.getElementById('systemVrc2faForm')?.classList.remove('d-none');
        const hint = document.getElementById('sysVrc2faHint');
        if (hint) hint.textContent = method === 'emailOtp' ? __('admin.enter_email_code') : __('admin.enter_auth_code');
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
      if (errEl) { errEl.textContent = errText(errData) || __('admin_vrc.login_failed'); errEl.classList.remove('d-none'); }
    }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('admin_vrc.login_failed_msg') + ': ' + err.message, 'error'); }
}

async function doSystemVrc2FA() {
  if (!currentUser || currentUser.role !== 'super_admin') {
    toast(__('admin_vrc.super_admin_only'), 'error');
    return;
  }
  const code = document.getElementById('sysVrc2faCode')?.value?.trim();
  const method = document.getElementById('systemVrc2faForm')?.dataset.method;
  if (!code || code.length < 4) { toast(__('admin_vrc.enter_full_code'), 'error'); return; }
  if (!method) { toast(__('admin_vrc.login_failed'), 'error'); return; }
  try {
    const res = await api('/api/2fa', {
      method: 'POST',
      body: { code, method }
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

// V8.2: 保存系统 VRChat cookie 软性过期时间
async function saveVrcCookieExpire() {
  if (!currentUser || currentUser.role !== 'super_admin') {
    toast(__('admin_vrc.super_admin_only'), 'error');
    return;
  }
  const sel = document.getElementById('vrcCookieExpireSel');
  if (!sel) return;
  const days = parseInt(sel.value, 10);
  try {
    const res = await api('/api/vrc-cookie-expire', { method: 'PUT', body: { expireDays: days } });
    if (res.ok) {
      toast(__('admin_vrc.expire_saved'), 'success');
      checkSystemVrcStatus();
    } else {
      const err = await res.json();
      toast(errText(err) || __('admin_vrc.save_failed'), 'error');
    }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('admin_vrc.save_failed') + ': ' + err.message, 'error'); }
}

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
      toast(errText(err) || __('admin_vrc.sync_err'), 'error');
    }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('admin_vrc.sync_failed') + ': ' + err.message, 'error'); }
  finally {
    if (btn) { btn.disabled = false; btn.textContent = __('admin_vrc.sync_group_btn'); }
  }
}

// ========== ⚙️ 系统设置 ==========
// F-5: 媒体镜像源 JSON ↔ 逐行文本（名称|URL模板|Referer(可选)）互转
function mirrorsToLines(jsonStr) {
  let arr;
  try { arr = JSON.parse(jsonStr || '[]'); } catch (e) { return ''; }
  if (!Array.isArray(arr)) return '';
  return arr.map(function (m) {
    if (!m || !m.urlTemplate) return '';
    return [m.name || '', m.urlTemplate, m.referer || ''].filter(function (p, i) { return i < 2 || p; }).join('|');
  }).filter(Boolean).join('\n');
}
function linesToMirrors(text) {
  return String(text || '').split(/\r?\n/).map(function (line) {
    line = line.trim();
    if (!line) return null;
    const parts = line.split('|').map(function (p) { return p.trim(); });
    const entry = { name: parts[0] || '', urlTemplate: parts[1] || '' };
    if (parts[2]) entry.referer = parts[2];
    return entry;
  }).filter(function (e) { return e && e.urlTemplate; });
}

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
      setVal('cfgHideForgot', cfg.hide_forgot_password);
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
      // 全局请求限制（超管可调）
      setVal('cfgReqMaxUpload', cfg.req_max_upload_mb);
      setVal('cfgReqMaxBody', cfg.req_max_body_mb);
      setVal('cfgReqMaxOther', cfg.req_max_other_mb);
      // F-5: 媒体代理源池（后端存 JSON，前端以「名称|URL模板|Referer」逐行编辑）
      setVal('cfgMediaMirrors', mirrorsToLines(cfg.media_provider_mirrors));
      setVal('cfgMediaMirrorFirst', cfg.media_provider_mirror_first);
      setVal('cfgMediaTimeout', cfg.media_provider_timeout_ms);
      if (cfg.hero_title) {
        const pt = document.getElementById('heroPreviewTitle');
        if (pt) pt.textContent = cfg.hero_title;
      }
      if (cfg.hero_bg_url) {
        const pi = document.getElementById('heroPreviewImg');
        if (pi) pi.src = cfg.hero_bg_url;
      }
    }
  } catch (err) { if (isApiHandledError(err)) return; toast(__('auto_admin_vrc_1'), 'error'); }
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
    hide_forgot_password: getVal('cfgHideForgot'),
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
    req_max_upload_mb: getVal('cfgReqMaxUpload'),
    req_max_body_mb: getVal('cfgReqMaxBody'),
    req_max_other_mb: getVal('cfgReqMaxOther'),
    media_provider_mirrors: JSON.stringify(linesToMirrors(getVal('cfgMediaMirrors'))),
    media_provider_mirror_first: getVal('cfgMediaMirrorFirst'),
    media_provider_timeout_ms: getVal('cfgMediaTimeout'),
  };
  if (!config.site_name) { toast(__('fill_required'), 'error'); return; }
  try {
    const res = await api('/api/admin/config', { method: 'PUT', body: { config } });
    if (res.ok) {
      toast(__('admin.settings_saved'), 'success');
      loadSystemConfig();
    } else {
      // 与同文件 vrcCookieExpire 一致：非 2xx 给明确失败提示，不再静默零反馈
      const err = await res.json().catch(() => ({}));
      toast(errText(err) || __('admin_vrc.save_failed'), 'error');
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

initVrcEventDelegates();
