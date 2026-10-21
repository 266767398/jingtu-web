/**
 * 境途同游 V5.2 — 安全中间件
 * DDoS防护 + 暴力破解防护 + 请求大小限制 + 可疑请求检测 + 接口限流精细化
 */
const rateLimit = require('express-rate-limit');
const logger = require('../logger');
const { onRateLimitTriggered, onSuspiciousRequest } = require('../security_alert');
const { getLimits } = require('../settings');
const { hybridStore } = require('./rate_limit_store');
const { fail } = require('../utils');
// M7：上传文件魔数/扩展名校验已下沉到零依赖 upload_validation.js（解除 utils↔security 延迟 require 环）
const { validateUploadFile, verifyFileSignature, isSafeFile } = require('../upload_validation');

const ddosLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  // 同 rate_limit.js：trust proxy 未开启时忽略 X-Forwarded-For 头（防 ERR_ERL_UNEXPECTED_X_FORWARDED_FOR 500）
  validate: { xForwardedForHeader: false },
  store: hybridStore('security-ddos'),
  message: { error: '请求过于频繁，请稍后再试' },
  skip: (req) => {
    if (req.method === 'OPTIONS') return true;
    // 头像代理/占位图为图片流量（走本地磁盘缓存 + routes/avatar.js 自有双重限速）。
    // 群组/好友一屏上百张头像会瞬间打满全局 600/min API 限流，被误判为 429（线上实锤）。
    // 图片请求不计入 DDoS 限流；防刷由 avatar.js 的 per-IP 1000/min + CDN 全局 200/min 令牌桶兜底。
    // /avatar/user 同属头像图片流量：内部已按 ID 每 IP 60/min 自限速 + 10min 缓存优先，
    // 成员页整屏缺头像时集中回退到该接口，若不豁免会先被全局 600/min 卡成占位图。
    // 注：app.use('/api', ...) 会裁剪 req.path，故此处为相对 /api 的路径。
    if (req.path === '/avatar/proxy' || req.path === '/avatar/default' || req.path === '/avatar/user') return true;
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
  validate: { xForwardedForHeader: false },
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

// V-06/T-18: 纯 IP 维度的登录辅助桶——与「IP+用户名」分桶叠加，封堵同一 IP 遍历用户名喷洒
// （总尝试量由 ddosLimiter 600/min 兜底，此桶把单 IP 爆破面再压一档）
const loginIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  validate: { xForwardedForHeader: false },
  store: hybridStore('security-login-ip'),
  message: { error: '登录尝试次数过多，请15分钟后再试' },
  skipSuccessfulRequests: true,
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
  validate: { xForwardedForHeader: false },
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
  validate: { xForwardedForHeader: false },
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
  validate: { xForwardedForHeader: false },
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
  validate: { xForwardedForHeader: false },
  store: hybridStore('security-jtt'),
  message: { error: '联动请求过于频繁，请稍后再试', retryAfter: 60 },
  handler: (req, res) => {
    onRateLimitTriggered(req.ip, req.path);
    fail(res, 429, '联动请求过于频繁，请稍后再试', { retryAfter: 60 });
  }
});

// P3-L5（质检）：VRChat 官方写操作（世界邀请/好友申请/备注/Boop）每用户限流。
// 这些端点会直连 VRChat 上游写接口，全局 ddosLimiter 600/min 对单账号过于宽松，
// 单账号可在 1 分钟内打空上游配额。按用户分桶（未登录回退 IP）；失败请求同样计数，
// 因为上游调用已发生、同样消耗配额。10/min 对正常用户（好友间低频互动）非常宽裕。
const vrcWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  store: hybridStore('security-vrc-write'),
  keyGenerator: (req) => `${rateLimit.ipKeyGenerator(req.ip)}:u${req.session?.userId || 'anon'}`,
  // 单测里 requireAuth 被 mock 成固定 userId、同一 IP，多用例共用同一桶会互相 429；
  // 限流行为本身由中间件库保证，测试无需重复验证，故测试环境跳过（生产仍全量生效）。
  skip: () => process.env.NODE_ENV === 'test',
  message: { error: 'VRChat 操作过于频繁，请稍后再试', retryAfter: 60 },
  handler: (req, res) => {
    onRateLimitTriggered(req.ip, req.path);
    fail(res, 429, 'VRChat 操作过于频繁，请稍后再试', { retryAfter: 60 });
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
    // 内部存活/就绪探针（pm2/Docker HEALTHCHECK/监控脚本）几乎都不带 User-Agent，
    // /api/health/* 属合法无 UA 流量，不记 security 告警——否则每 30s 刷一条刷屏。
    // 真正的异常由下方根路径/.env/.git 探测拦截承载，无 UA 本身不是攻击信号。
    if (!/^\/api\/health\//.test(req.path)) {
      logger.info('security', `[SEC] No User-Agent from ${req.ip}: ${req.method} ${req.path}`);
    }
  }
  // 仅取路径部分（去掉 query），统一小写
  const urlPath = (req.url.split('?')[0] || '').toLowerCase();
  // 根路径段拦截：扫描器/利用探测几乎都打在根路径（/wp-admin、/phpmyadmin、/system…），
  // 仅当命中"第一段"时才拦截，避免误伤应用自身嵌套路由（如 /api/admin/analytics/system）。
  // M-5：镜像 .htaccess 的禁止目录（/server//node_modules//docs/），并补充 logs/runtime 等运行面，
  // 使直连 3456/Nginx 反代场景下同样拒绝——不依赖 Apache 反代的 RedirectMatch。
  const rootBlocked = ['wp-admin', 'wp-login', 'phpmyadmin', 'adminer', 'xmlrpc.php', 'actuator', 'shell', 'cmd', 'exec', 'system', 'server', 'node_modules', 'docs', 'logs', 'runtime'];
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
  loginIpLimiter,
  uploadLimiter,
  adminLimiter,
  searchLimiter,
  jttLimiter,
  vrcWriteLimiter,
  requestSizeLimiter, 
  suspiciousRequestDetector,
  validateUploadFile,
  verifyFileSignature,
  isSafeFile
};
