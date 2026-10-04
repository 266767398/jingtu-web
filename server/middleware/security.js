/**
 * 境途同游 V5.2 — 安全中间件
 * DDoS防护 + 暴力破解防护 + 请求大小限制 + 可疑请求检测 + 接口限流精细化
 */
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const logger = require('../logger');
const { onRateLimitTriggered, onSuspiciousRequest } = require('../security_alert');
const { getLimits } = require('../settings');
const { hybridStore } = require('./rate_limit_store');
const { fail } = require('../utils');

// 魔数表：值为首字节起逐字节比对，null 表示该字节位置通配（跳过比对）。
// ISO-BMFF 容器（mp4/mov/m4a）前 4 字节是可变的 atom size、第 4-8 字节才是 'ftyp'，
// 故用 [null×4, ftyp] 表达，避免旧写法 [0,0,0,0x14,ftyp] 只匹配 size=20 文件的漏判。
const FILE_SIGNATURES = {
  'image/jpeg': [0xFF, 0xD8, 0xFF],
  'image/png': [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A],
  'image/gif': [0x47, 0x49, 0x46, 0x38],
  'image/webp': [0x52, 0x49, 0x46, 0x46],
  'video/mp4': [null, null, null, null, 0x66, 0x74, 0x79, 0x70],
  'video/quicktime': [null, null, null, null, 0x66, 0x74, 0x79, 0x70],
  'audio/mp4': [null, null, null, null, 0x66, 0x74, 0x79, 0x70],
  'video/webm': [0x1A, 0x45, 0xDF, 0xA3],
  'video/x-matroska': [0x1A, 0x45, 0xDF, 0xA3],
  'video/ogg': [0x4F, 0x67, 0x67, 0x53],
  'audio/wav': [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x41, 0x56, 0x45],
  'video/x-msvideo': [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x41, 0x56, 0x49, 0x20]
};

const DANGEROUS_EXTENSIONS = ['exe', 'bat', 'sh', 'cmd', 'com', 'scr', 'pif', 'msi', 'dll', 'sys', 'ps1', 'jar', 'php', 'py', 'pl', 'rb', 'asp', 'aspx', 'jsp', 'jspx', 'html', 'htm', 'js', 'vbs', 'hta', 'wsf', 'cpl', 'lnk', 'url', 'hta'];

const SAFE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'mov', 'webm', 'mkv', 'avi', 'ogg', 'mp3', 'wav', 'm4a', 'pdf', 'zip', 'rar', '7z', 'txt', 'json'];

function verifyFileSignature(filePath, mimeType) {
  const expected = FILE_SIGNATURES[mimeType];
  if (!expected) return true;

  // 按签名长度读取头部字节（最长 RIFF 子格式需 12 字节），避免整文件读入内存。
  const len = expected.length;
  const buf = Buffer.alloc(len);
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, len, 0);
  } catch (e) {
    return false;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }

  for (let i = 0; i < len; i++) {
    if (expected[i] === null) continue; 
    if (buf[i] !== expected[i]) {
      return false;
    }
  }
  return true;
}

function isSafeFile(filename) {
  if (!filename) return false;
  const ext = filename.split('.').pop().toLowerCase();
  return SAFE_EXTENSIONS.includes(ext) && !DANGEROUS_EXTENSIONS.includes(ext);
}

async function validateUploadFile(file, maxSize = 200 * 1024 * 1024) {
  const errors = [];
  
  if (!file) {
    errors.push('未选择文件');
    return { valid: false, errors };
  }
  
  if (file.size > maxSize) {
    errors.push(`文件大小超过限制（最大 ${maxSize / 1024 / 1024}MB）`);
    return { valid: false, errors };
  }
  
  if (!isSafeFile(file.originalname)) {
    errors.push('不支持的文件类型');
    return { valid: false, errors };
  }
  
  const ext = file.originalname.split('.').pop().toLowerCase();
  let expectedMimeType = '';
  
  if (['jpg', 'jpeg'].includes(ext)) expectedMimeType = 'image/jpeg';
  else if (ext === 'png') expectedMimeType = 'image/png';
  else if (ext === 'gif') expectedMimeType = 'image/gif';
  else if (ext === 'webp') expectedMimeType = 'image/webp';
  else if (ext === 'mp4') expectedMimeType = 'video/mp4';
  else if (ext === 'mov') expectedMimeType = 'video/quicktime';
  else if (ext === 'm4a') expectedMimeType = 'audio/mp4';
  else if (ext === 'webm') expectedMimeType = 'video/webm';
  else if (ext === 'mkv') expectedMimeType = 'video/x-matroska';
  else if (ext === 'avi') expectedMimeType = 'video/x-msvideo';
  else if (ext === 'ogg') expectedMimeType = 'video/ogg';
  else if (ext === 'wav') expectedMimeType = 'audio/wav';
  // mp3 不设魔数闸：文件可能以 ID3 标签或裸帧同步字（0xFF Ex/Fx）开头，单一签名会误杀合法音频
  
  if (expectedMimeType && !verifyFileSignature(file.path, expectedMimeType)) {
    errors.push('文件内容与扩展名不匹配');
    return { valid: false, errors };
  }
  
  return { valid: true, errors };
}

const ddosLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  store: hybridStore('security-ddos'),
  message: { error: '请求过于频繁，请稍后再试' },
  skip: (req) => {
    if (req.method === 'OPTIONS') return true;
    // 头像代理/占位图为图片流量（走本地磁盘缓存 + routes/avatar.js 自有双重限速）。
    // 群组/好友一屏上百张头像会瞬间打满全局 600/min API 限流，被误判为 429（线上实锤）。
    // 图片请求不计入 DDoS 限流；防刷由 avatar.js 的 per-IP 1000/min + CDN 全局 200/min 令牌桶兜底。
    // 注：app.use('/api', ...) 会裁剪 req.path，故此处为相对 /api 的路径。
    if (req.path === '/avatar/proxy' || req.path === '/avatar/default') return true;
    return false;
  },
  handler: (req, res) => {
    onRateLimitTriggered(req.ip, req.path);
    fail(res, 429, '请求过于频繁，请稍后再试');
  }
});

const loginBruteForceLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  store: hybridStore('security-login-bruteforce'),
  message: { error: '登录尝试次数过多，请15分钟后再试' },
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const identity = String(req.body?.loginId || req.body?.username || 'unknown').trim().toLowerCase();
    return `${rateLimit.ipKeyGenerator(req.ip)}:${identity}`;
  },
  handler: (req, res) => {
    onRateLimitTriggered(req.ip, req.path);
    fail(res, 429, '登录尝试次数过多，请15分钟后再试');
  }
});

const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: hybridStore('security-upload'),
  message: { error: '上传请求过于频繁，请稍后再试', retryAfter: 60 },
  handler: (req, res) => {
    onRateLimitTriggered(req.ip, req.path);
    fail(res, 429, '上传请求过于频繁，请稍后再试', { retryAfter: 60 });
  }
});

const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  store: hybridStore('security-admin'),
  message: { error: '管理后台请求过于频繁，请稍后再试', retryAfter: 60 },
  handler: (req, res) => {
    onRateLimitTriggered(req.ip, req.path);
    fail(res, 429, '管理后台请求过于频繁，请稍后再试', { retryAfter: 60 });
  }
});

const searchLimiter = rateLimit({
  windowMs: 30 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  store: hybridStore('security-search'),
  message: { error: '搜索请求过于频繁，请稍后再试', retryAfter: 30 },
  handler: (req, res) => {
    onRateLimitTriggered(req.ip, req.path);
    fail(res, 429, '搜索请求过于频繁，请稍后再试', { retryAfter: 30 });
  }
});

// P3-13：/api/jtt 联动接口专属限流。虽有 24bit 随机码 + ED25519 签名 + ±300s 时间窗 + nonce
// 防重放使爆破不现实，但全局 ddosLimiter 600/min 对单客户端过于宽松；60/min 足够正常轮询，
// 超额即拒（不设 skipSuccessfulRequests：verify 失败本就不计数会削弱防护，统一计数更稳）。
const jttLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  store: hybridStore('security-jtt'),
  message: { error: '联动请求过于频繁，请稍后再试', retryAfter: 60 },
  handler: (req, res) => {
    onRateLimitTriggered(req.ip, req.path);
    fail(res, 429, '联动请求过于频繁，请稍后再试', { retryAfter: 60 });
  }
});

function requestSizeLimiter(req, res, next) {
  // 阈值由超级管理员在后台「系统设置」可调（持久化于 system_config，启动时载入内存）。
  const { uploadMaxBytes, bodyMaxBytes, otherMaxBytes } = getLimits();
  const contentLength = parseInt(req.headers['content-length'] || 0);
  // 上传类路径（含 /upload、/photos、/videos）交由各路由 multer 的 limits.fileSize 精确限制，
  // 此处仅保留一个安全闸，避免无限大 body 进入流式解析。
  // 历史坑：原先顶层 `>20MB` 卡口对所有请求（含 /api/album/upload）生效，导致主相册 500MB 配置形同虚设。
  const isUpload = req.path.includes('/upload') || req.path.includes('/photos') || req.path.includes('/videos');
  if (isUpload) {
    if (contentLength > uploadMaxBytes) {
      return fail(res, 413, '请求体过大');
    }
    return next();
  }
  if (contentLength > bodyMaxBytes) {
    return fail(res, 413, '请求体过大');
  }
  if (req.method === 'POST' || req.method === 'PUT') {
    if (contentLength > otherMaxBytes) {
      return fail(res, 413, '请求体过大');
    }
  }
  next();
}

function suspiciousRequestDetector(req, res, next) {
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  if (!ua && req.method !== 'OPTIONS') {
    logger.info('security', `[SEC] No User-Agent from ${req.ip}: ${req.method} ${req.path}`);
  }
  // 仅取路径部分（去掉 query），统一小写
  const urlPath = (req.url.split('?')[0] || '').toLowerCase();
  // 根路径段拦截：扫描器/利用探测几乎都打在根路径（/wp-admin、/phpmyadmin、/system…），
  // 仅当命中“第一段”时才拦截，避免误伤应用自身嵌套路由（如 /api/admin/analytics/system）。
  const rootBlocked = ['wp-admin', 'wp-login', 'phpmyadmin', 'adminer', 'xmlrpc.php', 'actuator', 'shell', 'cmd', 'exec', 'system'];
  const firstSegment = urlPath.split('/').filter(Boolean)[0] || '';
  if (rootBlocked.includes(firstSegment)) {
    logger.info('security', `[SEC] Blocked suspicious request: ${req.method} ${req.url} from ${req.ip}`);
    onSuspiciousRequest(req.ip, `访问被阻止路径: /${firstSegment}`, req.path);
    return fail(res, 404, '资源不存在');
  }
  // 文件类探测（.env/.git）：应用不存在此类路由，无论嵌套都拦截
  if (urlPath.includes('/.env') || urlPath.includes('/.git')) {
    logger.info('security', `[SEC] Blocked suspicious request: ${req.method} ${req.url} from ${req.ip}`);
    onSuspiciousRequest(req.ip, '访问被阻止路径: 配置文件/目录探测', req.path);
    return fail(res, 404, '资源不存在');
  }
  next();
}

module.exports = { 
  ddosLimiter, 
  loginBruteForceLimiter, 
  uploadLimiter,
  adminLimiter,
  searchLimiter,
  jttLimiter,
  requestSizeLimiter, 
  suspiciousRequestDetector,
  validateUploadFile,
  verifyFileSignature,
  isSafeFile
};
