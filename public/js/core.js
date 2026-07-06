// ==================== State ====================
let currentUser = null;
let activeTab = 'home';
let currentPhotoIdx = null;
let albumPhotoList = [];
let membersCache = [];
let albumPage = 1;
let albumSilentLoad = false;
let albumScrollLock = new Set();
let signedEvents = new Set();
let csrfToken = null;

// ==================== 全局加载指示器 ====================
let _loadingCount = 0;

function showGlobalLoading() {
  _loadingCount++;
  let bar = document.getElementById('globalLoadBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'globalLoadBar';
    bar.style.cssText = 'position:fixed;top:0;left:0;width:0;height:3px;background:linear-gradient(90deg,var(--accent),var(--accent2));z-index:10000;transition:width .3s ease,opacity .3s ease;opacity:0';
    document.body.appendChild(bar);
  }
  if (_loadingCount === 1) {
    bar.style.opacity = '1';
    bar.style.width = '30%';
  }
}

function hideGlobalLoading() {
  _loadingCount = Math.max(0, _loadingCount - 1);
  const bar = document.getElementById('globalLoadBar');
  if (!bar) return;
  if (_loadingCount === 0) {
    bar.style.width = '100%';
    setTimeout(() => {
      bar.style.opacity = '0';
      setTimeout(() => { bar.style.width = '0'; }, 300);
    }, 200);
  }
}

// ==================== Toast ====================
const MAX_TOASTS = 3;

function toast(msg, type = 'info', duration) {
  // 根据类型自动分配持续时间
  if (duration === undefined) {
    const durationMap = { error: 5000, success: 2500, info: 3000 };
    duration = durationMap[type] || 3000;
  }
  const c = document.getElementById('toastContainer');
  if (!c) return;

  // 超过上限移除最旧的
  while (c.children.length >= MAX_TOASTS) {
    const first = c.firstElementChild;
    if (first) {
      first.classList.add('removing');
      setTimeout(() => first.remove(), 300);
    }
  }

  const d = document.createElement('div');
  d.className = `toast ${type}`;
  d.textContent = msg;
  c.appendChild(d);

  setTimeout(() => {
    d.classList.add('removing');
    setTimeout(() => d.remove(), 300);
  }, duration);
}

// ==================== CSRF Token ====================
let _csrfPromise = null; // 并发锁：防止多个 api() 同时请求 CSRF token

async function ensureCsrf() {
  if (csrfToken) return csrfToken;
  // 如果已有正在进行的 CSRF 请求，复用该 Promise（并发锁）
  if (_csrfPromise) return _csrfPromise;
  _csrfPromise = (async () => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const res = await fetch('/api/csrf-token', { credentials: 'include', signal: controller.signal });
      clearTimeout(timeoutId);
      const data = await res.json();
      csrfToken = data.csrfToken;
      return csrfToken;
    } catch {
      return null;
    } finally {
      _csrfPromise = null; // 重置锁，允许下次重新获取
    }
  })();
  return _csrfPromise;
}

// ==================== URL 安全编码 ====================
function safeUrl(path, params = {}) {
  // 先把已嵌入 path 中的查询字符串剥离出来，避免 encodeURIComponent 破坏 ? 和 &
  const qIdx = path.indexOf('?');
  let basePath = path;
  let existingQs = '';
  if (qIdx !== -1) {
    basePath = path.substring(0, qIdx);
    existingQs = path.substring(qIdx); // 包含开头的 ?
  }
  // 只编码路径部分（不包含查询字符串）
  const segs = basePath.split('/').map(s => {
    if (s.startsWith(':')) return s;
    return encodeURIComponent(decodeURIComponent(s));
  }).join('/');
  // 合并已存在的和新传入的查询参数
  const newQs = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  if (newQs) {
    return segs + (existingQs ? existingQs + '&' + newQs : '?' + newQs);
  }
  return segs + (existingQs || '');
}

// ==================== API 请求封装 ====================
async function api(path, opt = {}) {
  showGlobalLoading();
  await ensureCsrf();
  // 支持 opt.params 传递额外查询参数
  const url = safeUrl(path, opt.params || {});
  const defaultHeaders = {
    'Content-Type': 'application/json',
    'X-CSRF-Token': csrfToken || '',
  };
  const options = { credentials: 'include', headers: defaultHeaders, ...opt };
  if (options.body && typeof options.body === 'object') options.body = JSON.stringify(options.body);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);
  options.signal = controller.signal;

  try {
    const res = await fetch(url, options);
    clearTimeout(timeoutId);
    hideGlobalLoading();

    if (res.status === 401) {
      csrfToken = null; // CSRF 中间件已消费 token，清除避免下次复用无效 token
      // 区分真正的会话过期 vs 业务上的"未授权"（如VRChat系统未登录）
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        try {
          const errData = await res.clone().json();
          // 如果返回了特定错误码则不是会话过期
          if (errData.code === 'VRC_SYSTEM_OFFLINE' || errData.code === 'VRC_NOT_LOGGED_IN') {
            return res;
          }
        } catch {}
      }
      if (currentUser) {
        toast(__('session_expired'), 'error');
        setTimeout(() => logout(true, true), 1500);
      }
      throw new Error('UNAUTHORIZED');
    }
    if (res.status === 403) {
      csrfToken = null; // CSRF token 单次消费，403 时一并清除避免复用无效 token
      try { const errData = await res.clone().json(); toast(errData.error || __('permission_denied'), 'error'); } catch(e) { toast(__('permission_denied'), 'error'); }
      throw new Error('FORBIDDEN');
    }
    if (res.status === 429) {
      csrfToken = null;
      if (!window._lastRateLimitToast || Date.now() - window._lastRateLimitToast > 30000) {
        window._lastRateLimitToast = Date.now();
        toast(__('rate_limited'), 'error');
      }
      throw new Error('RATE_LIMITED');
    }
    if (res.status >= 500) { csrfToken = null; toast(__('server_error'), 'error'); throw new Error('SERVER_ERROR'); }
    // CSRF token 单次消费，请求成功后清除并触发下次请求前重新获取
    if (!['GET', 'HEAD', 'OPTIONS'].includes(options.method || 'GET')) {
      csrfToken = null;
    }
    return res;
  } catch (err) {
    clearTimeout(timeoutId);
    hideGlobalLoading();
    if (err.name === 'AbortError') { toast(__('request_timeout'), 'error'); throw new Error('TIMEOUT'); }
    throw err;
  }
}

async function apiForm(path, formData, opt = {}) {
  showGlobalLoading();
  await ensureCsrf();
  const url = safeUrl(path);
  const options = { credentials: 'include', method: 'POST', body: formData, headers: { 'X-CSRF-Token': csrfToken || '' }, ...opt };
  delete options.headers['Content-Type'];
  let res;
  try {
    res = await fetch(url, options);
  } finally {
    hideGlobalLoading();
  }
  if (res.status === 401) {
    csrfToken = null; // CSRF 中间件已消费 token
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      try {
        const errData = await res.clone().json();
        if (errData.code === 'VRC_SYSTEM_OFFLINE' || errData.code === 'VRC_NOT_LOGGED_IN') return res;
      } catch {}
    }
    if (currentUser) {
      toast(__('session_expired'), 'error');
      setTimeout(() => logout(true, true), 1500);
    }
    throw new Error('UNAUTHORIZED');
  }
  if (res.status === 403) { csrfToken = null; try { const errData = await res.clone().json(); toast(errData.error || __('permission_denied'), 'error'); } catch(e) { toast(__('permission_denied'), 'error'); } throw new Error('FORBIDDEN'); }
  if (res.status === 429) { csrfToken = null; toast(__('rate_limited'), 'error'); throw new Error('RATE_LIMITED'); }
  if (res.status >= 500) { csrfToken = null; toast(__('server_error'), 'error'); throw new Error('SERVER_ERROR'); }
  // CSRF token 单次消费，请求成功后清除
  csrfToken = null;
  return res;
}

// ==================== API 错误处理辅助 ====================
// 如果 api() 已经处理过错误（toast + 抛出特定 Error），返回 true 让调用方跳过二次 toast
function isApiHandledError(err) {
  return err.message === 'FORBIDDEN' || err.message === 'UNAUTHORIZED' || err.message === 'RATE_LIMITED' || err.message === 'SERVER_ERROR' || err.message === 'TIMEOUT';
}

// ==================== XHR 文件上传（带进度条） ====================
/**
 * 使用 XMLHttpRequest 上传文件，支持实时进度回调
 * @param {string} url - 上传 API 路径
 * @param {FormData} formData - 表单数据
 * @param {function} onProgress - 进度回调 (percent: number, loaded: number, total: number)
 * @returns {Promise<Response>} - 标准 Response 对象
 */
function uploadWithProgress(url, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100), e.loaded, e.total);
      }
    });

    xhr.addEventListener('load', () => {
      const res = new Response(xhr.responseText, {
        status: xhr.status,
        statusText: xhr.statusText,
        headers: { 'Content-Type': 'application/json' }
      });
      if (xhr.status === 401) {
        csrfToken = null;
        if (currentUser) {
          toast(__('session_expired'), 'error');
          setTimeout(() => logout(true, true), 1500);
        }
        reject(new Error('UNAUTHORIZED'));
        return;
      }
      if (xhr.status === 403) { csrfToken = null; reject(new Error('FORBIDDEN')); return; }
      if (xhr.status === 429) { csrfToken = null; toast(__('rate_limited'), 'error'); reject(new Error('RATE_LIMITED')); return; }
      if (xhr.status >= 500) { csrfToken = null; toast(__('server_error'), 'error'); reject(new Error('SERVER_ERROR')); return; }
      csrfToken = null;
      resolve(res);
    });

    xhr.addEventListener('error', () => {
      csrfToken = null;
      toast(__('network_error'), 'error');
      reject(new Error('NETWORK_ERROR'));
    });

    xhr.addEventListener('abort', () => {
      csrfToken = null;
      toast(__('upload_cancelled'), 'error');
      reject(new Error('ABORT'));
    });

    xhr.timeout = 300000; // 5 分钟超时
    xhr.ontimeout = () => {
      csrfToken = null;
      toast(__('upload_timeout'), 'error');
      reject(new Error('TIMEOUT'));
    };

    xhr.open('POST', url);
    xhr.setRequestHeader('X-CSRF-Token', csrfToken || '');
    xhr.withCredentials = true;
    xhr.send(formData);
  });
}

// ==================== 通用工具函数 ====================
function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 转义 HTML 属性值（替换所有危险字符） */
function escAttr(str) {
  if (!str) return '';
  return esc(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * 转义 JS 字符串字面量（用于内联 onclick/onerror 中的单引号字符串）
 * 注意: esc()/escAttr() 在 onclick 中无效，因为 HTML 实体会先被浏览器解码
 */
function escJsStr(str) {
  if (!str) return '';
  return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

/** 转义 CSS url() 中的值 */
function escCssUrl(str) {
  if (!str) return "''";
  return "'" + String(str).replace(/[\\()'"\n\r]/g, '') + "'";
}

function fmtDate(iso) {
  if (!iso) return __('unknown');
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function fmtTime(iso) {
  if (!iso) return __('unknown');
  const d = new Date(iso);
  return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

/**
 * 将文本转义为安全的 HTML，并保留换行
 */
function escapeNewlines(str) {
  if (!str) return '';
  return esc(str).replace(/\n/g, '<br>');
}

// ==================== 弹窗管理 ====================
function closeAllModals() {
  document.querySelectorAll('.modal').forEach(modal => {
    modal.classList.remove('show');
    modal.style.display = 'none';
  });
}
function showModal(id) {
  closeAllModals();
  const modal = document.getElementById(id);
  if (modal) {
    modal.style.display = 'flex';
    requestAnimationFrame(() => requestAnimationFrame(() => modal.classList.add('show')));
    // 焦点管理：移动到弹窗内第一个可聚焦元素
    const focusable = modal.querySelector('input, button, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (focusable) setTimeout(() => focusable.focus(), 100);
  }
}
function closeModal(id) {
  const modal = document.getElementById(id);
  if (modal) {
    modal.classList.remove('show');
    setTimeout(() => { modal.style.display = 'none'; }, 300);
  }
}

// ==================== 确认弹窗（使用 HTML 中已定义的 confirmModal，回退到动态创建） ====================
function showConfirm(msg, callbackYes, callbackNo) {
  const modal = document.getElementById('confirmModal');
  const msgEl = document.getElementById('confirmMsg');
  const okBtn = document.getElementById('confirmOkBtn');
  if (!modal || !msgEl || !okBtn) {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-dialog">
        <div class="confirm-msg">${esc(msg)}</div>
        <div class="confirm-actions">
          <button class="btn btn-accent btn-sm" id="confirmYesBtnFallback">${__('core.confirm_btn')}</button>
          <button class="btn btn-outline btn-sm" id="confirmNoBtnFallback">${__('core.cancel_btn')}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    document.getElementById('confirmYesBtnFallback').onclick = () => { overlay.remove(); if (callbackYes) callbackYes(); };
    document.getElementById('confirmNoBtnFallback').onclick = () => { overlay.remove(); if (callbackNo) callbackNo(); };
    overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); if (callbackNo) callbackNo(); } };
    return;
  }
  msgEl.textContent = msg;
  window._confirmCallback = callbackYes;
  window._cancelCallback = callbackNo;
  okBtn.onclick = function() {
    closeModal('confirmModal');
    const cb = window._confirmCallback;
    window._confirmCallback = null;
    window._cancelCallback = null;
    if (cb) cb();
  };
  const cancelBtn = modal.querySelector('#confirmCancelBtn');
  if (cancelBtn) {
    cancelBtn.onclick = function() {
      closeModal('confirmModal');
      const cb = window._cancelCallback;
      window._confirmCallback = null;
      window._cancelCallback = null;
      if (cb) cb();
    };
  }
  const closeX = modal.querySelector('.modal-close');
  if (closeX) {
    closeX.onclick = function() {
      closeModal('confirmModal');
      const cb = window._cancelCallback;
      window._confirmCallback = null;
      window._cancelCallback = null;
      if (cb) cb();
    };
  }
  showModal('confirmModal');
}

// ==================== 输入弹窗（替代原生 prompt） ====================
function showInput(question, defaultValue, callback) {
  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay';
  overlay.innerHTML = `
    <div class="confirm-dialog">
      <div class="confirm-msg">${esc(question)}</div>
      <input type="text" class="input" id="inputPromptField" value="${esc(defaultValue || '')}" style="width:100%;margin-top:8px;box-sizing:border-box">
      <div class="confirm-actions" style="margin-top:12px">
        <button class="btn btn-accent btn-sm" id="inputOkBtn">${__('core.confirm_btn')}</button>
        <button class="btn btn-outline btn-sm" id="inputCancelBtn">${__('core.cancel_btn')}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const input = overlay.querySelector('#inputPromptField');
  input.focus();
  input.select();
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { overlay.remove(); callback(input.value); }
    if (e.key === 'Escape') { overlay.remove(); callback(null); }
  });
  overlay.querySelector('#inputOkBtn').onclick = function() { overlay.remove(); callback(input.value); };
  overlay.querySelector('#inputCancelBtn').onclick = function() { overlay.remove(); callback(null); };
  overlay.onclick = function(e) { if (e.target === overlay) { overlay.remove(); callback(null); } };
}
