// ==================== P1 性能：懒加载模块 DOMContentLoaded 垫片 ====================
// 路由模块改为按需/空闲加载后，可能在 DOMContentLoaded 已触发后才注入。
// 这些模块用 document.addEventListener('DOMContentLoaded', cb) 做自初始化，
// 若不加垫片，cb 永远不会执行。此垫片在页面已加载完成后，将此类监听立即以
// 微任务触发；初始解析阶段（readyState==='loading'）仍走原生行为，不受影响。
(function () {
  var _origAdd = document.addEventListener.bind(document);
  document.addEventListener = function (type, listener, opts) {
    if (type === 'DOMContentLoaded' && document.readyState !== 'loading') {
      queueMicrotask(function () {
        try { listener.call(document, { type: 'DOMContentLoaded' }); }
        catch (e) { console.error('[DOMContentLoaded shim]', e); }
      });
      return;
    }
    return _origAdd(type, listener, opts);
  };
})();

// ==================== 全局工具：防抖 ====================
// 提到始终加载的核心脚本，确保懒加载模块（follows/friends/model-coll 等）
// 调用 debounce 时始终可用，避免 P1 模块懒加载后加载顺序导致的
// "debounce is not defined" 运行时错误。
function debounce(fn, ms) {
  let t;
  return function () {
    clearTimeout(t);
    const args = arguments, ctx = this;
    t = setTimeout(() => fn.apply(ctx, args), ms);
  };
}

// ==================== 全局图片加载失败兜底（图片问题 6 / P2-20） ====================
// 统一为中性占位，避免裂图。error 事件不冒泡，用捕获阶段在 document 上拦截；
// 用 data-URI 占位（无网络请求、不会二次触发 error），dataset 标记防止死循环。
(function () {
  var PLACEHOLDER = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="120" height="120"%3E%3Crect width="100%25" height="100%25" fill="%23e5e7eb"/%3E%3Ctext x="50%25" y="54%25" font-size="44" text-anchor="middle" dominant-baseline="central"%3E%F0%9F%96%BC%EF%B8%8F%3C/text%3E%3C/svg%3E';
  document.addEventListener('error', function (e) {
    var t = e.target;
    if (!t || t.tagName !== 'IMG' || t.dataset.imgFb) return;
    t.dataset.imgFb = '1';
    t.src = PLACEHOLDER;
  }, true);
})();

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
  // index.html 顶部已内置 <div id="globalLoadBar">，正常情况直接复用；
  // 若在某些场景下缺失（例如该节点被意外移除），则安全地补建一个，
  // 避免后续操作其 style 时报错。if (!bar) 已保证不会重复创建。
  let bar = document.getElementById('globalLoadBar');
  if (!bar) {
    if (!document.body) return;
    bar = document.createElement('div');
    bar.id = 'globalLoadBar';
    bar.setAttribute('aria-hidden', 'true');
    bar.style.cssText = 'position:fixed;top:0;left:0;width:0;height:3px;background:linear-gradient(90deg,var(--accent),var(--accent2));z-index:10000;transition:width .3s ease,opacity .3s ease;opacity:0;pointer-events:none';
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
  // Token 池模式：每次调用都获取新 token，不缓存（避免并发 POST 共享同一已被消费的 token 导致竞争）
  // 仅对同一 tick 内的并发调用通过 _csrfPromise 去重（共享一次 fetch），服务端 token 可重用
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
// VRChat 上游相关的业务错误码。这些错误虽然用了 401/403 状态码，但含义是
// "VRChat 那边的登录/权限有问题"，而不是"本站会话过期/权限不足"。
// 必须与后端 server/utils.js 的 ErrorCodes 保持一致，否则用户点一下群组同步
// 就会被误判为会话过期、强制登出并跳回登录页。
const VRC_BUSINESS_CODES = new Set([
  'VRC_SYSTEM_OFFLINE',
  'VRC_NOT_LOGGED_IN',
  'VRC_COOKIE_EXPIRED',
  'VRC_UPSTREAM_ERROR',
  'VRC_2FA_REQUIRED',   // 401 但需两步验证：不踢本站会话，引导重登验证
  'VRC_RATE_LIMITED',   // 429 限流：静默退避，不视为本站故障
  'VRC_FETCH_FAILED',   // groups.js / model-collection-service 已使用，需登记以免被误判为会话失效
]);

async function api(path, opt = {}) {
  showGlobalLoading();
  const method = (opt.method || 'GET').toUpperCase();
  const url = safeUrl(path, opt.params || {});
  const defaultHeaders = {
    'Content-Type': 'application/json',
  };
  const options = { credentials: 'include', headers: defaultHeaders, ...opt };
  // 关键修复（数据审核/管理类列表前后状态同步）：默认禁止浏览器对 GET 请求做
  // 启发式/磁盘缓存。否则"删除/审核/封禁"等写操作后的列表重载会命中旧缓存，
  // 导致已删除的条目仍残留在列表中、并沿用旧的审核状态（如仍显示"待审核"），
  // 与后端真实状态不一致。
  if (method === 'GET') options.cache = 'no-store';
  if (options.body && typeof options.body === 'object') options.body = JSON.stringify(options.body);
  // opt.timeout 不是 fetch 的参数，透传给 fetch 会被忽略，但留在对象里没有意义，摘掉更干净
  delete options.timeout;

  // 默认 10 秒。但像"同步群组成员"这种要串行拉多页 VRChat 数据的批量操作，
  // 真实耗时几十秒是常态；10 秒就 abort 会让用户看到"请求超时"，
  // 以为点了没反应而反复点击，服务端却还在跑 —— 这正是"点同步网页卡住"的由来。
  const controller = new AbortController();
  const timeoutMs = Number(opt.timeout) > 0 ? Number(opt.timeout) : 10000;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  options.signal = controller.signal;

  try {
    // 安全提取后端错误文案：兼容扁平 {error:'字符串'} 与嵌套 {error:{code,message}} 两种包络，
    // 避免把对象渲染成 "[object Object]"（非中文界面会暴露此 bug）。
    const safeErrMsg = (d) => {
      if (!d) return '';
      if (typeof d.error === 'string') return d.error;
      if (d.error && typeof d.error === 'object') {
        // 优先按 code 取语言包（error.* 命名空间，见 docs/09 第十五轮 B1 方案 / docs/10 §2.1）；
        // 未命中（__ 返回 key 本身）时回退到后端中文 message，保证旧错误码不破版。
        const code = d.error.code;
        if (code) {
          const translated = __('error.' + code);
          if (translated && translated !== 'error.' + code) return translated;
        }
        return d.error.message || code || '';
      }
      return '';
    };
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      await ensureCsrf();
      options.headers['X-CSRF-Token'] = csrfToken || '';
    }
    const res = await fetch(url, options);
    clearTimeout(timeoutId);
    hideGlobalLoading();

    if (res.status === 401) {
      csrfToken = null; // CSRF 中间件已消费 token，清除避免下次复用无效 token
      // 区分真正的会话过期 vs 业务上的"未授权"（如VRChat系统未登录/VRChat cookie 过期）。
      // 这些 code 必须与后端 utils.js 的 ErrorCodes 保持一致，否则用户会被莫名踢回登录页。
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        try {
          const errData = await res.clone().json();
          if (VRC_BUSINESS_CODES.has(errData.code)) {
            // 登录过期 / 需两步验证 / 未登录 → 弹窗引导玩家重新登录（30s 内不重复弹）
            if (errData.code === 'VRC_COOKIE_EXPIRED' || errData.code === 'VRC_2FA_REQUIRED' || errData.code === 'VRC_NOT_LOGGED_IN') {
              promptVrcReLogin(errData.detail || safeErrMsg(errData) || __('vrc.session_invalid'));
            } else {
              toast(errData.detail || safeErrMsg(errData) || __('vrc.session_invalid'), 'error');
            }
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
      try {
        const errData = await res.clone().json();
        // VRChat 上游 403 是业务错误，不是本站权限不足，交给调用方自行处理
        if (VRC_BUSINESS_CODES.has(errData.code)) {
          if (errData.code === 'VRC_COOKIE_EXPIRED' || errData.code === 'VRC_2FA_REQUIRED' || errData.code === 'VRC_NOT_LOGGED_IN') {
            promptVrcReLogin(errData.detail || safeErrMsg(errData) || __('vrc.session_invalid'));
          } else {
            toast(errData.detail || safeErrMsg(errData), 'error');
          }
          return res;
        }
        toast(safeErrMsg(errData) || __('permission_denied'), 'error');
      } catch(e) { toast(__('permission_denied'), 'error'); }
      throw new Error('FORBIDDEN');
    }
    if (res.status === 429) {
      csrfToken = null;
      // 限流：全局 30s 内只轻提示一次，不刷错误红条、不视为本站故障（避免雪崩）
      if (!window._lastRateLimitToast || Date.now() - window._lastRateLimitToast > 30000) {
        window._lastRateLimitToast = Date.now();
        let msg = __('rate_limited') || 'VRChat 接口限流，稍后自动重试';
        let retryAfter = 30;
        try {
          const d = await res.clone().json();
          if (d.detail) msg = d.detail;
          if (d.retryAfter) retryAfter = Number(d.retryAfter) || 30;
        } catch {}
        toast(msg, 'info');
        window._vrcRateLimitRetryAfter = retryAfter; // 供轮询任务指数退避读取
        window._vrcRateLimitedUntil = Date.now() + retryAfter * 1000; // 标记限流窗口结束时刻
      }
      const e = new Error('VRC_RATE_LIMITED');
      e.code = 'VRC_RATE_LIMITED';
      e.retryAfter = window._vrcRateLimitRetryAfter || 30;
      throw e;
    }
    if (res.status >= 500) {
      csrfToken = null;
      // 之前这里无条件 toast 通用的"服务器错误"，把后端精心区分出来的真实原因
      // （例如 502 + "搜索世界失败：VRChat 会话已过期"）整个吞掉，
      // 用户只能看到一句无信息量的"服务器错误"。改为优先展示后端给的说明。
      let msg = __('server_error');
      try {
        const d = await res.clone().json();
        const detail = d.detail || safeErrMsg(d) || '';
        if (detail) msg = detail;
      } catch {}
      toast(msg, 'error');
      throw new Error('SERVER_ERROR');
    }
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
  const url = safeUrl(path);
  let res;
  try {
    await ensureCsrf();
    const options = { credentials: 'include', method: 'POST', body: formData, headers: { 'X-CSRF-Token': csrfToken || '' }, ...opt };
    delete options.headers['Content-Type'];
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
async function uploadWithProgress(url, formData, onProgress) {
  await ensureCsrf();
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
      if (xhr.status === 403) {
        csrfToken = null;
        try {
          const data = JSON.parse(xhr.responseText);
          toast(data.error || __('permission_denied'), 'error');
        } catch {
          toast(__('permission_denied'), 'error');
        }
        reject(new Error('FORBIDDEN'));
        return;
      }
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

const HapticFeedback = {
  impact(style = 'light') {
    try {
      if (navigator.vibrate) {
        const map = { light: 10, medium: 20, heavy: 30, selection: 5, success: [20, 40, 20], warning: [30, 40, 30], error: [50, 50, 50] };
        const v = map[style] || 15;
        navigator.vibrate(v);
      }
    } catch (e) {}
  },
  notification(type = 'success') { this.impact(type); },
  selection() { this.impact('selection'); }
};

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
  const value = String(str).trim();
  if (!/^(?:https?:\/\/|\/)/i.test(value)) return "''";
  return "'" + value.replace(/[\\()'"\n\r]/g, '') + "'";
}

// 通用图片兜底：普通图片（相册/媒体等）加载失败时回退占位，避免裂图
// 与头像专用的 window.__avatarFail 区分：此处不写失败缓存，仅做一次兜底
window.__imgFail = function (img) {
  if (!img || img.dataset.imgFailApplied) return;
  img.dataset.imgFailApplied = '1';
  img.onerror = null;
  img.src = "data:image/svg+xml;charset=utf8,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='100'%20height='100'%3E%3Crect%20width='100%25'%20height='100%25'%20fill='%23e8e8e8'/%3E%3Cpath%20d='M30%2040h40v30H30z'%20fill='%23bdbdbd'/%3E%3Ccircle%20cx='42'%20cy='48'%20r='6'%20fill='%23bdbdbd'/%3E%3C/svg%3E";
};

/**
 * 生成带统一兜底的 <img> 字符串（普通图片用）。
 * @param {string} src 图片地址
 * @param {string} cls CSS 类
 * @param {string} alt alt 文本
 */
function imgWithFallback(src, cls, alt) {
  return '<img src="' + escAttr(src) + '" class="' + (cls || '') + '" alt="' + escAttr(alt || '') + '" loading="lazy" onerror="window.__imgFail(this)">';
}
window.imgWithFallback = imgWithFallback;

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

// ==================== 显示 / 隐藏工具 ====================
// .d-none 的规则是 `display:none !important`，内联的 element.style.display 打不过它。
// 所以凡是 HTML 里初始带 d-none 的元素，都必须用 class 来控制显隐，不能用 style.display
// —— 否则代码看着在"显示"，实际元素永远不出现（用户菜单点了没反应就是这么来的）。
function showEl(el, display) {
  const node = typeof el === 'string' ? document.getElementById(el) : el;
  if (!node) return null;
  node.classList.remove('d-none');
  // 只有需要非默认 display（如 flex/inline）时才写内联值
  if (display) node.style.display = display;
  else node.style.removeProperty('display');
  return node;
}
function hideEl(el) {
  const node = typeof el === 'string' ? document.getElementById(el) : el;
  if (!node) return null;
  node.classList.add('d-none');
  node.style.removeProperty('display');
  return node;
}
function isElVisible(el) {
  const node = typeof el === 'string' ? document.getElementById(el) : el;
  return !!node && !node.classList.contains('d-none');
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
    // 锁定背景滚动，避免弹窗背后内容滚动露底
    if (!document.body._modalScrollLocks) document.body._modalScrollLocks = 0;
    document.body._modalScrollLocks++;
    document.body.style.overflow = 'hidden';
    // 焦点管理：移动到弹窗内第一个可聚焦元素
    const focusable = modal.querySelector('input, button, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (focusable) setTimeout(() => focusable.focus(), 100);
  }
}
function closeModal(id) {
  const modal = document.getElementById(id);
  if (modal) {
    const returnToModalId = modal.dataset.returnToModal;
    delete modal.dataset.returnToModal;
    modal.classList.remove('show');
    modal.style.display = 'none';
    if (document.body._modalScrollLocks) {
      document.body._modalScrollLocks--;
      if (document.body._modalScrollLocks <= 0) {
        document.body._modalScrollLocks = 0;
        document.body.style.overflow = '';
      }
    }
    if (returnToModalId && !document.querySelector('.modal.show')) {
      showModal(returnToModalId);
    }
  }
}

// ==================== 通用弹窗「归属防串台」守卫 ====================
// 提取自 VRChat 名片 / 站内用户名片 / 动态详情三处重复的 token 机制：
// 快速连点不同条目时，迟到的旧异步响应不应覆盖当前弹窗。
// 用法：
//   const opener = createFastModal('postDetail');
//   const token = opener.begin(id);          // 打开瞬间锁定归属
//   api(...).then(d => { if (opener.stale(token)) return; /* 丢弃过期 */ paint(d); });
// 注：仅封装「归属判定」这一公共逻辑；各弹窗的缓存/打开/渲染差异较大，保留原样。
const __fastModalTokens = {};
function createFastModal(name) {
  __fastModalTokens[name] = null;
  return {
    begin(id) {
      const token = String(id);
      __fastModalTokens[name] = token;
      return token;
    },
    stale(token) {
      return token !== __fastModalTokens[name];
    }
  };
}

function initModalCloseActions() {
  if (document._modalCloseActionsInit) return;
  document._modalCloseActionsInit = true;
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-modal-close]');
    if (!button) return;
    event.preventDefault();
    closeModal(button.dataset.modalClose);
  });
  // 点击遮罩层关闭弹窗，但复制文字时从弹窗内拖到外部再松开不应关闭
  let _modalMouseDownInside = false;
  document.addEventListener('mousedown', (e) => {
    _modalMouseDownInside = !!e.target.closest('.modal-content');
  });
  document.addEventListener('click', (e) => {
    const modal = e.target.closest('.modal');
    if (!modal || !modal.classList.contains('show')) return;
    if (modal.contains(e.target) && e.target !== modal) return; // 点击内容区不关闭
    if (_modalMouseDownInside) return; // 从内容区拖出去松开的，不关闭
    closeModal(modal.id);
  });
}

initModalCloseActions();

function ensureModal(id, title) {
  let modal = document.getElementById(id);
  if (!modal) {
    modal = document.createElement('div');
    modal.id = id;
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h3>${esc(title || '')}</h3>
          <button class="modal-close" onclick="closeModal('${id}')" aria-label="${__('ui.close')}">&times;</button>
        </div>
        <div class="modal-body" id="${id}Body"></div>
      </div>
    `;
    document.body.appendChild(modal);
  }
  return modal.querySelector('.modal-body') || modal;
}

function hideModal(id) {
  closeModal(id);
}

// ==================== 通用弹窗工厂 ====================
function createOverlayDialog(contentHtml, onConfirm, onCancel) {
  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay';
  overlay.innerHTML = contentHtml;
  document.body.appendChild(overlay);
  const cleanup = function(result) {
    overlay.remove();
    if (result === 'confirm' && onConfirm) onConfirm();
    if (result === 'cancel' && onCancel) onCancel();
  };
  const okBtn = overlay.querySelector('[data-action="confirm"]') || overlay.querySelector('.btn-accent');
  const cancelBtn = overlay.querySelector('[data-action="cancel"]') || overlay.querySelector('.btn-outline');
  if (okBtn) okBtn.onclick = () => cleanup('confirm');
  if (cancelBtn) cancelBtn.onclick = () => cleanup('cancel');
  overlay.onclick = (e) => { if (e.target === overlay) cleanup('cancel'); };
  return overlay;
}

// ==================== VRChat 登录过期 → 弹窗引导重新登录 ====================
// 捕获到 VRC_COOKIE_EXPIRED / VRC_2FA_REQUIRED / VRC_NOT_LOGGED_IN 时弹出，
// 点「重新登录」跳转个人中心 VRChat 绑定区；30s 内不重复弹，避免请求风暴。
let _vrcReloginPromptAt = 0;
function promptVrcReLogin(detail) {
  const now = Date.now();
  if (now - _vrcReloginPromptAt < 30000) return;
  _vrcReloginPromptAt = now;
  const msg = detail || __('vrc.session_invalid');
  createOverlayDialog(`
    <div class="confirm-dialog">
      <div class="confirm-msg"><b style="color:#f87171">${esc(__('vrc.relogin_title'))}</b><br><br>${esc(msg)}</div>
      <div class="confirm-actions" style="margin-top:12px">
        <button class="btn btn-accent btn-sm" data-action="confirm">${esc(__('vrc.relogin_btn'))}</button>
        <button class="btn btn-outline btn-sm" data-action="cancel">${esc(__('core.cancel_btn'))}</button>
      </div>
    </div>`, function () {
      // 跳转个人中心并滚动到 VRChat 绑定 / 状态区
      if (typeof window.switchTab === 'function') window.switchTab('me', true);
      setTimeout(function () {
        const el = document.getElementById('vrchatBindForm') || document.getElementById('vrchatBoundStatus');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 350);
    });
}

// ==================== 确认弹窗（使用 HTML 中已定义的 confirmModal，回退到动态创建） ====================
function showConfirm(msg, callbackYes, callbackNo) {
  const modal = document.getElementById('confirmModal');
  const msgEl = document.getElementById('confirmMsg');
  const okBtn = document.getElementById('confirmOkBtn');
  if (!modal || !msgEl || !okBtn) {
    createOverlayDialog(`
      <div class="confirm-dialog">
        <div class="confirm-msg">${esc(msg)}</div>
        <div class="confirm-actions">
          <button class="btn btn-accent btn-sm" data-action="confirm">${__('core.confirm_btn')}</button>
          <button class="btn btn-outline btn-sm" data-action="cancel">${__('core.cancel_btn')}</button>
        </div>
      </div>`, callbackYes, callbackNo);
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
  const overlay = createOverlayDialog(`
    <div class="confirm-dialog">
      <div class="confirm-msg">${esc(question)}</div>
      <input type="text" class="input" id="inputPromptField" value="${esc(defaultValue || '')}" style="width:100%;margin-top:8px;box-sizing:border-box">
      <div class="confirm-actions" style="margin-top:12px">
        <button class="btn btn-accent btn-sm" data-action="confirm">${__('core.confirm_btn')}</button>
        <button class="btn btn-outline btn-sm" data-action="cancel">${__('core.cancel_btn')}</button>
      </div>
    </div>`, null, null);
  const input = overlay.querySelector('#inputPromptField');
  input.focus();
  input.select();
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { const val = input.value; overlay.remove(); callback(val); }
    if (e.key === 'Escape') { overlay.remove(); callback(null); }
  });
  const okBtn = overlay.querySelector('[data-action="confirm"]');
  const cancelBtn = overlay.querySelector('[data-action="cancel"]');
  okBtn.onclick = function() { const val = input.value; overlay.remove(); callback(val); };
  cancelBtn.onclick = function() { overlay.remove(); callback(null); };
}

// ==================== 地理定位可用性 ====================
//
// 浏览器的 Geolocation 是**安全上下文限定**能力。在 http:// + 非 localhost
// （典型是局域网 IP，如 http://192.168.x.x:3456）下：
//   - navigator.geolocation 对象**照样存在**，所以 `if (!navigator.geolocation)` 拦不住；
//   - 但一调用就立刻回调 error，code = 1 (PERMISSION_DENIED)，
//     message 是 "Only secure origins are allowed"，且**完全不弹权限请求框**。
// 由于 code 同样是 1，代码若只看 code 就会误判成"用户拒绝了授权"，
// 提示"请开启定位权限" —— 而用户根本没见过任何弹窗，无从授权，死循环。
//
// 实测（本项目）：
//   http://127.0.0.1:3456    isSecureContext=true   → "User denied Geolocation"
//   http://192.168.2.104:3456 isSecureContext=false → "Only secure origins are allowed"

function geoAvailability() {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    return { ok: false, reason: 'unsupported' };
  }
  // isSecureContext 覆盖 https、localhost、127.0.0.1、file:// 等所有安全来源，
  // 比手写 protocol/hostname 判断可靠。
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    return { ok: false, reason: 'insecure' };
  }
  return { ok: true, reason: null };
}

// 调用定位前的统一守卫：不可用时给出**可操作**的提示并返回 false。
function ensureGeolocation() {
  const a = geoAvailability();
  if (a.ok) return true;
  if (a.reason === 'insecure') {
    toast(__('geo.insecure_context', { origin: location.origin }), 'error', 8000);
  } else {
    toast(__('geo.unsupported'), 'error');
  }
  return false;
}

// 把 GeolocationPositionError 翻译成正确的提示 key。
// 关键：非安全上下文下 code 也是 1，必须先排除它再谈"用户拒绝"。
function geoErrorKey(err) {
  if (window.isSecureContext === false) return 'geo.insecure_context';
  if (!err) return 'geo.failed';
  if (err.code === 1) return 'geo.permission_denied';
  if (err.code === 2) return 'geo.unavailable';
  if (err.code === 3) return 'geo.timeout';
  return 'geo.failed';
}

function toastGeoError(err) {
  const key = geoErrorKey(err);
  toast(__(key, { origin: location.origin }), 'error', key === 'geo.insecure_context' ? 8000 : 4000);
}

// ==================== 全局错误兜底（健壮性） ====================
// 捕获未处理异常与 Promise rejection，避免静默丢失、便于排查。
// 仅记录到控制台，不重复弹 toast（api() 已对已知业务错误统一提示），避免噪音。
window.addEventListener('error', (e) => {
  // 忽略资源加载错误（img/script/css 404 等），只处理脚本运行时错误
  if (e && e.target && e.target !== window && (e.target.src || e.target.href)) return;
  console.error('[global error]', e.message, e.error || '');
});
window.addEventListener('unhandledrejection', (e) => {
  const reason = e && e.reason ? e.reason : '未知错误';
  console.error('[unhandledrejection]', reason && reason.message ? reason.message : reason);
});
