/**
 * 境途同游 — 服务端共享工具模块
 * 集中管理 getPool、safeError、操作日志、通知群发等重复代码
 * 所有路由模块统一从此导入，消除7处重复定义
 */
const crypto = require('crypto');
const dbMod = require('./db');
const logger = require('./logger');
const fs = require('fs');

// ==================== 数据库连接 ====================
const getPool = () => dbMod.holder.pool;

// ==================== 错误处理 ====================
const IS_DEV = process.env.NODE_ENV !== 'production';
function safeError(msg) { return IS_DEV ? msg : '操作失败，请稍后重试'; }

const ErrorCodes = {
  BAD_REQUEST: 'BAD_REQUEST',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  BAD_GATEWAY: 'BAD_GATEWAY',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  DB_ERROR: 'DB_ERROR',
  VRCAT_ERROR: 'VRCAT_ERROR',
  RATE_LIMITED: 'RATE_LIMITED',
  NEED_BIND: 'NEED_BIND',
  // VRChat 上游相关：这些码必须与前端 core.js 的 VRC_BUSINESS_CODES 保持一致，
  // 否则前端会把 401 当成"本站会话过期"而强制登出并跳回登录页。
  VRC_SYSTEM_OFFLINE: 'VRC_SYSTEM_OFFLINE',
  VRC_COOKIE_EXPIRED: 'VRC_COOKIE_EXPIRED',
  VRC_NOT_LOGGED_IN: 'VRC_NOT_LOGGED_IN',
  VRC_UPSTREAM_ERROR: 'VRC_UPSTREAM_ERROR',
  VRC_FETCH_FAILED: 'VRC_FETCH_FAILED',
  VRC_RATE_LIMITED: 'VRC_RATE_LIMITED',
  VRC_2FA_REQUIRED: 'VRC_2FA_REQUIRED',
  // ==================== 社交模块（好友/关注/群聊/点赞） ====================
  ALREADY_FRIENDS: 'ALREADY_FRIENDS',
  FRIEND_REQUEST_EXISTS: 'FRIEND_REQUEST_EXISTS',
  FRIEND_NOT_FOUND: 'FRIEND_NOT_FOUND',
  SELF_FRIEND: 'SELF_FRIEND',
  ALREADY_BLOCKED: 'ALREADY_BLOCKED',
  ALREADY_FOLLOWING: 'ALREADY_FOLLOWING',
  NOT_FOLLOWING: 'NOT_FOLLOWING',
  SELF_FOLLOW: 'SELF_FOLLOW',
  BLOCKED: 'BLOCKED',
  NOT_GROUP_MEMBER: 'NOT_GROUP_MEMBER',
  NOT_GROUP_ADMIN: 'NOT_GROUP_ADMIN',
  NOT_GROUP_OWNER: 'NOT_GROUP_OWNER',
  ALREADY_IN_GROUP: 'ALREADY_IN_GROUP',
  INVALID_INVITE_CODE: 'INVALID_INVITE_CODE',
  CANNOT_LEAVE_OWNER: 'CANNOT_LEAVE_OWNER',
  INVALID_TARGET_TYPE: 'INVALID_TARGET_TYPE',
  TARGET_NOT_FOUND: 'TARGET_NOT_FOUND',
  // ==================== 境途联动（JTT） ====================
  JTT_SIGNATURE_INVALID: 'JTT_SIGNATURE_INVALID',
  JTT_TIMESTAMP_STALE: 'JTT_TIMESTAMP_STALE',
  JTT_ACCOUNT_REVOKED: 'JTT_ACCOUNT_REVOKED',
  JTT_ACCOUNT_EXPIRED: 'JTT_ACCOUNT_EXPIRED',
  JTT_ACCOUNT_EXISTS: 'JTT_ACCOUNT_EXISTS',
  JTT_ACCOUNT_NOT_FOUND: 'JTT_ACCOUNT_NOT_FOUND',
  JTT_GAME_INVALID: 'JTT_GAME_INVALID',
  DEEPLINK_TYPE_INVALID: 'DEEPLINK_TYPE_INVALID',
  JTT_BIND_CODE_INVALID: 'JTT_BIND_CODE_INVALID',
  JTT_BIND_CODE_USED: 'JTT_BIND_CODE_USED',
  JTT_BIND_CODE_EXPIRED: 'JTT_BIND_CODE_EXPIRED',
};

/**
 * 统一处理 VRChat 上游（api.vrchat.cloud）返回的非 200 响应。
 *
 * 背景：此前所有 VRChat 代理端点在上游失败时一律 `res.status(502).json({error:'xxx失败'})`。
 * 前端 api() 把所有 >=500 的响应统一 toast 成"服务器错误"，于是「VRChat 登录已过期」
 * 这个唯一有用的信息被完全吞掉 —— 表现为「群组同步点了没反应」「搜索世界服务器报错」。
 * 而上游 401 若直接透传成本站 401，前端又会误判为会话过期把用户踢回登录页。
 *
 * 因此这里按上游状态码分流，并始终带上 code 让前端能精确区分。
 *
 * @param {object} res       Express response
 * @param {object} upstream  { status, data } —— vrchatRequest / vrchatGetXxx 的返回
 * @param {string} action    人类可读的动作名，例如 '搜索世界'
 */
function sendVrcError(res, upstream, action) {
  const status = upstream?.status;
  const upstreamMsg = upstream?.data?.error?.message || upstream?.data?.error || '';

  if (status === 401) {
    // 区分「cookie 过期」与「需要 2FA 二次验证」：后者不应清 cookie，而应引导重登验证
    const msg = String(upstreamMsg || '').toLowerCase();
    const is2fa = msg.includes('two factor') || msg.includes('2fa') || msg.includes('requiresTwoFactorAuth');
    return res.status(401).json({
      error: is2fa ? 'VRChat 需要二次验证' : 'VRChat 登录已失效',
      detail: is2fa
        ? `${action}失败：VRChat 账号开启了两步验证，请重新登录并完成验证。`
        : `${action}失败：VRChat 会话已过期。请在管理面板的"系统 VRChat 账号"卡片中重新登录，或在个人中心重新绑定你的 VRChat 账号。`,
      code: is2fa ? ErrorCodes.VRC_2FA_REQUIRED : ErrorCodes.VRC_COOKIE_EXPIRED
    });
  }
  if (status === 403) {
    return res.status(403).json({
      error: `${action}失败：VRChat 拒绝了本次请求`,
      detail: upstreamMsg || '当前 VRChat 账号可能没有该群组的相应权限。',
      code: ErrorCodes.VRC_UPSTREAM_ERROR
    });
  }
  if (status === 429) {
    // 限流单独归类，前端据此静默退避（不弹错误红条、可重试），避免雪崩
    return res.status(429).json({
      error: `${action}失败：VRChat 接口限流`,
      detail: '请求过于频繁，请稍后再试。',
      code: ErrorCodes.VRC_RATE_LIMITED,
      retryAfter: 30
    });
  }
  // 其余情况（含超时 status=0 / 5xx）统一 502，但把真实原因带出去
  return res.status(502).json({
    error: `${action}失败`,
    detail: upstreamMsg || `VRChat 接口返回 ${status == null ? '无响应（超时或网络不可达）' : status}`,
    code: ErrorCodes.VRC_UPSTREAM_ERROR
  });
}

function sendError(res, status, code, message, detail) {
  const err = { success: false, error: { code, message } };
  if (detail && IS_DEV) err.error.detail = detail;
  res.status(status).json(err);
}

/**
 * 统一成功响应包络（P2-6 第一步）：输出与全站主流形状逐字节一致
 * fields 平铺在顶层（无 data 包装）；created()/201 全站暂无用例，留待后续批次
 */
function ok(res, fields) {
  return res.json(fields ? { success: true, ...fields } : { success: true });
}

/**
 * 统一错误发射器（扁平兼容形态）：fail(res, 状态码, 消息串, 附加字段对象?)，与 ok() 对偶。
 * - error 保持字符串：全站约 35 处页面脚本裸读 data.error，嵌套对象会渲染成 [object Object]；
 * - 附加字段（code/detail/retryAfter/expired/details/lockMinutes）平铺顶层：core.js 401/403 拦截
 *   依赖顶层 code 走 VRC_BUSINESS_CODES 路由，429/5xx 拦截与 group.js 依赖顶层 detail/retryAfter；
 * - 协议统一为所有 JSON 响应均带 success 布尔；嵌套形态 sendError 保留给已适配嵌套读取方的路由。
 */
function fail(res, status, message, extra) {
  return res.status(status).json(Object.assign({ success: false, error: message }, extra || {}));
}

/**
 * 统一错误响应
 * @param {object} res - Express response
 * @param {Error} e - 捕获的异常
 * @param {string} tag - 日志标签
 * @param {number} defaultStatus - 默认状态码
 */
function handleError(res, e, tag = 'utils', defaultStatus = 500) {
  logger.error(tag, e.message, e.stack);
  let status = e.statusCode || e.status || defaultStatus;
  // VRChat 限流排队超时（VRC_RATE_TIMEOUT）统一按 429 返回，而非 500：
  // 这是「上游限流/繁忙」而非「服务器内部错误」，前端对 429 有静默退避逻辑，不会弹红条误导用户。
  if (e.code === 'VRC_RATE_TIMEOUT' && status === 500) status = 429;
  const code = e.code || ErrorCodes.INTERNAL_ERROR;
  const message = IS_DEV ? e.message : getSafeMessage(code, status);
  res.status(status).json({ success: false, error: { code, message } });
}

function getSafeMessage(code, status) {
  const map = {
    400: '请求参数错误',
    401: '未授权，请重新登录',
    403: '无权限执行此操作',
    404: '资源不存在',
    409: '资源冲突',
    429: '请求过于频繁，请稍后重试',
    500: '服务器内部错误',
  };
  return map[status] || '操作失败，请稍后重试';
}

function createErr(code, message, statusCode) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  return err;
}

// ==================== 操作日志（仅写 DB，无 WebSocket） ====================
async function logOper(adminId, operType, content) {
  try {
    await getPool().query(
      `INSERT INTO sys_oper_log (admin_vrcid, oper_type, content) VALUES (?, ?, ?)`,
      [String(adminId), operType, content]
    );
  } catch (e) { logger.warn('[logOper]', '操作日志写入失败:', e.message); }
}

// ==================== VRChat Cookie 加解密 ====================
const CRYPTO_ALGO = 'aes-256-gcm';
const CRYPT_PREFIX = 'enc:';

/**
 * 使用 AES-256-GCM 加密 VRChat Cookie
 * @param {string} plaintext - 原始 Cookie 字符串
 * @returns {string|null} 加密后的字符串（enc:base64格式），失败返回 null
 */
function encryptCookie(plaintext) {
  if (!plaintext || typeof plaintext !== 'string') return null;
  try {
    const key = Buffer.from(process.env.ENCRYPT_KEY, 'hex');
    if (key.length !== 32) throw new Error('ENCRYPT_KEY 必须是 64 位十六进制（32 字节）');
    const iv = crypto.randomBytes(12); // GCM 推荐 12 字节 IV
    const cipher = crypto.createCipheriv(CRYPTO_ALGO, key, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'binary');
    encrypted += cipher.final('binary');
    const tag = cipher.getAuthTag();
    // 格式: iv(12) + tag(16) + ciphertext
    const buf = Buffer.concat([iv, tag, Buffer.from(encrypted, 'binary')]);
    return CRYPT_PREFIX + buf.toString('base64');
  } catch (e) {
    console.error('⚠️ VRChat Cookie 加密失败:', e.message);
    return null;
  }
}

/**
 * 解密 VRChat Cookie
 * @param {string} stored - 加密后的 Cookie 字符串（含 enc: 前缀）
 * @returns {string|null} 原始 Cookie 字符串
 */
function decryptCookie(stored) {
  if (!stored || typeof stored !== 'string') return null;
  // 兼容未加密的旧 Cookie（迁移过渡）
  if (!stored.startsWith(CRYPT_PREFIX)) return stored;
  try {
    const key = Buffer.from(process.env.ENCRYPT_KEY, 'hex');
    if (key.length !== 32) throw new Error('ENCRYPT_KEY 必须是 64 位十六进制（32 字节）');
    const buf = Buffer.from(stored.slice(CRYPT_PREFIX.length), 'base64');
    if (buf.length < 28) throw new Error('密文不完整');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ciphertext = buf.subarray(28);
    const decipher = crypto.createDecipheriv(CRYPTO_ALGO, key, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(ciphertext, 'binary', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    console.error('⚠️ VRChat Cookie 解密失败:', e.message);
    return null;
  }
}

function validateFields(updates, allowedFields) {
  const keys = Object.keys(updates);
  const invalid = keys.filter(k => !allowedFields.includes(k));
  if (invalid.length > 0) {
    throw new Error(`非法字段: ${invalid.join(', ')}`);
  }
  return updates;
}

// ==================== 文件上传白名单配置 ====================
const FileTypes = {
  IMAGE: {
    exts: ['.jpg', '.jpeg', '.png', '.gif', '.webp'],
    mime: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
    accept: 'image/jpeg,image/png,image/gif,image/webp',
    description: 'JPG/PNG/GIF/WEBP'
  },
  VIDEO: {
    exts: ['.mp4', '.mov', '.webm', '.avi', '.mkv'],
    mime: ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-msvideo', 'video/x-matroska'],
    accept: 'video/mp4,video/quicktime,video/webm,video/x-msvideo,video/x-matroska',
    description: 'MP4/MOV/WEBM/AVI/MKV'
  },
  AUDIO: {
    exts: ['.mp3', '.wav', '.ogg', '.m4a'],
    mime: ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4'],
    accept: 'audio/mpeg,audio/wav,audio/ogg,audio/mp4',
    description: 'MP3/WAV/OGG/M4A'
  },
  DOCUMENT: {
    exts: ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.md', '.json'],
    mime: ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
           'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
           'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
           'text/plain', 'text/markdown', 'application/json'],
    accept: 'application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,' +
            'application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,' +
            'application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,' +
            'text/plain,text/markdown,application/json',
    description: 'PDF/DOC/XLS/PPT/TXT/MD/JSON'
  },
  EXECUTABLE: {
    exts: ['.exe', '.msi'],
    mime: ['application/x-msdownload', 'application/octet-stream'],
    accept: 'application/x-msdownload,application/octet-stream',
    description: 'EXE/MSI'
  }
};

function getAllowedExts(typeList) {
  return typeList.flatMap(t => FileTypes[t]?.exts || []);
}

function getAllowedMime(typeList) {
  return typeList.flatMap(t => FileTypes[t]?.mime || []);
}

// 可执行扩展名黑名单：即使 MIME 伪造也拒绝（防止 PHP/HTML 等在 phpstudy 环境下被解析）
const FORBIDDEN_EXTENSIONS = ['.php', '.phtml', '.php5', '.php7', '.pht', '.phar',
  '.html', '.htm', '.exe', '.sh', '.bat', '.cmd', '.com', '.scr', '.msi',
  '.svg', '.js', '.jsp', '.asp', '.aspx', '.cgi', '.pl', '.py', '.rb'];

function validateFile(file, allowedTypes) {
  const allowedExts = getAllowedExts(allowedTypes);
  const allowedMimes = getAllowedMime(allowedTypes);
  const ext = require('path').extname(file.originalname).toLowerCase();
  // 显式黑名单优先（防止 shell.php 伪造 Content-Type: image/jpeg 绕过）
  if (FORBIDDEN_EXTENSIONS.includes(ext)) return false;
  // 扩展名 AND MIME 同时匹配，防止单独伪造其一绕过
  return allowedExts.includes(ext) && allowedMimes.includes(file.mimetype);
}

function createFileFilter(allowedTypes) {
  return (req, file, cb) => {
    if (validateFile(file, allowedTypes)) {
      cb(null, true);
    } else {
      const descriptions = allowedTypes.map(t => FileTypes[t]?.description || t).join('/');
      cb(new Error(`仅支持 ${descriptions} 格式`));
    }
  };
}

/**
 * 上传安全包装器：在 multer 落盘后做魔数/扩展名/大小校验，
 * 拦截“扩展名合法但内容不符”的伪装文件。校验失败会删除临时文件并返回 400。
 * 用法：secureUpload(photoUpload.single('photo')) 代替 photoUpload.single('photo')
 */
function secureUpload(multerMiddleware, opts = {}) {
  const maxSize = opts.maxSize || 200 * 1024 * 1024;
  return (req, res, next) => {
    // 惰性引入，避免与 security.js 形成模块加载期循环依赖
    const { validateUploadFile } = require('./middleware/security');
    multerMiddleware(req, res, async (err) => {
      if (err) return next(err);
      const files = [];
      if (req.file) files.push(req.file);
      if (Array.isArray(req.files)) files.push(...req.files);
      else if (req.files && typeof req.files === 'object') {
        for (const key of Object.keys(req.files)) {
          const arr = req.files[key];
          if (Array.isArray(arr)) files.push(...arr);
        }
      }
      for (const f of files) {
        const result = await validateUploadFile(f, maxSize);
        if (!result.valid) {
          try { if (f.path) fs.unlinkSync(f.path); } catch (e) {}
          return fail(res, 400, '文件校验失败：' + result.errors.join('；'));
        }
      }
      next();
    });
  };
}

function proxyVrcAvatar(url) {
  if (!url || typeof url !== 'string') return url;
  // 仅代理 VRChat CDN（带签名、会过期）；本站资源原样返回
  if (/^(https?:\/\/)?(api\.vrchat\.(cloud|com)|assets\.(amlcdn|vrchat)\.com)\//i.test(url)) {
    return '/api/avatar/proxy?u=' + encodeURIComponent(url);
  }
  return url;
}

function getAvatarUrl(user) {
  if (!user) return null;
  // §11.8.8: avatar_visible=0 时用户选择隐藏头像，全局返回 null（不展示任何头像）
  // 字段未选中（undefined）按默认可见处理，保持向后兼容
  if (user.avatar_visible === 0) return null;
  if (user.avatar_type === 'custom' && user.custom_avatar_path) {
    return user.custom_avatar_path;
  }
  if (user.vrchat_avatar_url) {
    return proxyVrcAvatar(user.vrchat_avatar_url);
  }
  return null;
}

module.exports = { getPool, IS_DEV, safeError, handleError, sendError, ok, fail, sendVrcError, ErrorCodes, createErr, logOper, encryptCookie, decryptCookie, getAvatarUrl, validateFields, logger, FileTypes, getAllowedExts, getAllowedMime, validateFile, createFileFilter, secureUpload, proxyVrcAvatar };
