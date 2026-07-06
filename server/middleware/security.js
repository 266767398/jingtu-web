/**
 * 境途同游 V5.2 — 安全中间件
 * DDoS防护 + 暴力破解防护 + 请求大小限制 + 可疑请求检测
 */
const rateLimit = require('express-rate-limit');

// DDoS 防护 — 每1分钟最多600个请求（仅限API）
const ddosLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '请求过于频繁，请稍后再试' },
  skip: (req) => {
    // 跳过静态文件和OPTIONS请求
    if (req.method === 'OPTIONS') return true;
    return false;
  }
});

// 登录暴力破解保护 — 每15分钟5次
const loginBruteForceLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  message: { error: '登录尝试次数过多，请15分钟后再试' },
  skipSuccessfulRequests: true,
});

// 请求大小验证中间件
function requestSizeLimiter(req, res, next) {
  const contentLength = parseInt(req.headers['content-length'] || 0);
  if (contentLength > 20 * 1024 * 1024) {
    return res.status(413).json({ error: '请求体过大' });
  }
  if (req.path.includes('/upload') || req.path.includes('/photos') || req.path.includes('/videos')) {
    return next();
  }
  if (req.method === 'POST' || req.method === 'PUT') {
    if (contentLength > 5 * 1024 * 1024) {
      return res.status(413).json({ error: '请求体过大' });
    }
  }
  next();
}

// 可疑请求检测
function suspiciousRequestDetector(req, res, next) {
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  if (!ua && req.method !== 'OPTIONS') {
    console.log(`[SEC] No User-Agent from ${req.ip}: ${req.method} ${req.path}`);
  }
  const url = req.url.toLowerCase();
  const blockedPatterns = ['/wp-admin', '/wp-login', '/.env', '/.git', '/phpmyadmin', '/adminer', '/xmlrpc.php', '/actuator'];
  for (const p of blockedPatterns) {
    if (url.includes(p)) {
      console.log(`[SEC] Blocked suspicious request: ${req.method} ${req.url} from ${req.ip}`);
      return res.status(404).json({ error: 'Not Found' });
    }
  }
  next();
}

module.exports = { ddosLimiter, loginBruteForceLimiter, requestSizeLimiter, suspiciousRequestDetector };
