/**
 * 境途同游 — Node.js Express 服务端入口
 * MySQL 5.7 + express-session + CSRF + VRChat API
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// §兜底：若进程环境变量未注入（如 ServBay 以自身方式拉起 Node 而未 source .env），
// 则直接从 .env 文件补充缺失的键，避免 root@localhost 无密码连接数据库。
(function backfillEnvFromFile() {
  try {
    const fs = require('fs');
    const envPath = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(envPath)) return;
    const txt = fs.readFileSync(envPath, 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.substring(1, val.length - 1);
      }
      if (process.env[key] === undefined || process.env[key] === '') {
        process.env[key] = val;
      }
    }
  } catch (e) {
    // 忽略兜底失败，保留 dotenv 结果
  }
})();

const express = require('express');
const cors = require('cors');
const session = require('express-session');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const sharp = require('sharp');
const { rateLimit } = require('express-rate-limit');
const http = require('http');
const { WebSocketServer } = require('ws');
const compression = require('compression');
const dbMod = require('./db');
const wsService = require('./ws_service');
const { getPool, safeError, logOper, encryptCookie, decryptCookie, createFileFilter, sendError, ErrorCodes } = require('./utils');
const startSchedule = require('./schedule');
const {
  requireAuth, requireAdminCompat, requireRole,
  hashPassword, validatePasswordStrength,
  ROLE_LEVEL, getAvatarUrl
} = require('./auth');
const {
  vrchatRequest, vrchatBasicLogin, vrchatGetCurrentUser,
  vrchatGetGroupEvents,
  vrchatGetWorld, vrchatSearchWorlds, vrchatGetUser, vrchatGetGroupMembers, VRC_API_KEY
} = require('./vrc');
const {
  ddosLimiter, loginBruteForceLimiter,
  uploadLimiter, adminLimiter, searchLimiter,
  requestSizeLimiter, suspiciousRequestDetector
} = require('./middleware/security');
const notificationService = require('./notification-service');
const logger = require('./logger');
const { sharePathAllowed } = require('./share-auth-util');
const securityAlert = require('./security_alert');
const { apiVersionMiddleware } = require('./middleware/api_version');
const { enableWaf } = require('./middleware/waf');
const { metricsMiddleware } = require('./middleware/metrics');
const cache = require('./cache');
const cacheService = require('./cache_service');
const mailer = require('./mailer');
const tasks = require('./tasks');
const VRCPipeline = require('./vrc_pipeline');

// Swagger 文档不在此处静态引入：生产环境（NODE_ENV=production）不再加载，
// 因此部署生产时可安全使用 `npm ci --omit=dev`；仅在非生产环境按需 lazy 引入。

const app = express();

// ==================== 反向代理信任 ====================
// 经 Nginx / 宝塔 / Docker 反代后，req.ip、限流与登录失败告警都依赖此设置。
// - 显式设置 TRUST_PROXY 时优先采用（值可是数字/逗号列表/"loopback"/"unix"/"false"）。
// - 未设置时：生产环境默认信任第一跳（'1'），开发环境不信任。
// 若把 3456 直接暴露到公网、前面没有任何可信反代，请把 TRUST_PROXY 设为 false，
// 否则客户端可伪造 X-Forwarded-For 篡改限流与 IP 告警来源。
const trustProxyRaw = process.env.TRUST_PROXY;
let trustProxy;
if (trustProxyRaw === undefined || trustProxyRaw === '') {
  // 安全默认：未显式配置时一律不信任代理，防止伪造 X-Forwarded-For 绕过限流/登录告警。
  // 若经 Nginx/宝塔/Docker 反代部署，请在 .env 显式设置 TRUST_PROXY（如 1 或具体跳数）。
  trustProxy = false;
} else if (trustProxyRaw === 'false' || trustProxyRaw === '0') {
  trustProxy = false;
} else if (trustProxyRaw === 'true' || trustProxyRaw === '1') {
  trustProxy = 1;
} else {
  trustProxy = trustProxyRaw;
}
app.set('trust proxy', trustProxy);

// 关掉 Express 对 res.json()/res.send() 的自动 ETag。
// 动态 API 全部走 no-store，留着 ETag 只会让浏览器发条件请求换回 304，
// 而 304 会让前端的 res.ok 判断为假。静态文件走 express.static 自己的配置，不受影响。
app.set('etag', false);
const server = http.createServer(app);
const PORT = parseInt(process.env.PORT, 10) || 3456;

// ==================== 常量 ====================
const defaultGroupId = 'grp_7a45b436-159c-4d9c-8303-e186ec25fc35';
if (!process.env.GROUP_ID) {
  logger.warn('[server]', 'WARNING: GROUP_ID 未在 .env 中设置，使用默认值！请检查是否为正确的 VRChat 群组 ID');
}
const GROUP_ID = process.env.GROUP_ID || defaultGroupId;
const ROOT_DIR = path.join(__dirname, '..');
const SESSION_FILE = path.join(__dirname, 'session.json');
const ASSETS_DIR = path.join(ROOT_DIR, 'assets');
const ALBUM_DIR = path.join(ASSETS_DIR, 'album');
const PROFILE_PHOTOS_DIR = path.join(ROOT_DIR, 'uploads', 'profile', 'photos');
const PROFILE_VIDEOS_DIR = path.join(ROOT_DIR, 'uploads', 'profile', 'videos');
for (const d of [PROFILE_PHOTOS_DIR, PROFILE_VIDEOS_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}
const VRC_API = require('./vrc').VRC_API || 'https://api.vrchat.cloud/api/1';

// HTTP 服务器超时设置（防止空闲连接堆积）
server.timeout = 120000;       // 请求超时 2 分钟
server.keepAliveTimeout = 5000; // 空闲 Keep-Alive 5 秒
server.headersTimeout = 60000;  // 请求头部超时 1 分钟

const ROLE_CN_MAP = {
  'Group Owner': '群主', 'Owner': '群主', 'Admin': '管理员', 'Manager': '管理员',
  'Moderator': '协管', 'Mod': '协管', 'Member': '成员', 'Guest': '访客',
  'Recruiter': '招募官', 'Event Host': '活动主持', 'Event Coordinator': '活动协调',
  'Event Organizer': '活动组织者', 'Supporter': '支持者',
  'Contributor': '贡献者', 'Developer': '开发者', 'Artist': '画师',
  'Musician': '音乐人', 'Streamer': '主播', 'Tester': '测试员',
  'Bot': '机器人', 'Everyone': '所有人', 'Citizen': '公民', 'Resident': '居民',
};

// ==================== 通知辅助函数（使用 notification-service） ====================
async function createNotification(userId, type, title, message, relatedId, options = {}) {
  const target = typeof relatedId === 'object' ? relatedId : { relatedId, ...options };
  return notificationService.createNotification(userId, type, title, message, target);
}

// 通知所有成员（批量通知）
async function notifyAllMembers(type, title, message, relatedId, options = {}) {
  const target = typeof relatedId === 'object' ? relatedId : { relatedId, ...options };
  return notificationService.notifyAllMembers(type, title, message, target);
}

// ==================== 中间件 ====================
// 严格的 CORS 配置（生产环境应限定具体域名）
// 安全默认：未配置 CORS_ORIGINS 时，一律拒绝跨域（deny-all），杜绝开发态默认 allow-all 的隐患。
// 如需跨域，在 .env 用 CORS_ORIGINS=https://a.com,https://b.com 显式放行。
const CORS_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : [];
if (Array.isArray(CORS_ORIGINS) && CORS_ORIGINS.length === 0) {
  logger.warn('[server]', 'CORS_ORIGINS 未设置，将拒绝所有跨域请求（仅同源可用）。如需跨域请在 .env 限定具体域名。');
}
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true); // 同源/无 Origin 放行
    if (Array.isArray(CORS_ORIGINS) && CORS_ORIGINS.includes(origin)) return cb(null, true);
    return cb(null, false); // 拒绝未授权来源
  },
  credentials: true
}));

// 启用 Gzip/Brotli 压缩（对静态资源和API响应生效）
app.use(compression({
  level: 6,
  threshold: 1024,
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  }
}));

// ==================== 运维面板反向代理 ====================
// 站点管理后台「运维面板」入口经此访问：主站 /ops/* → 127.0.0.1:3457/*（剥离前缀）。
// 必须置于安全响应头（CSP/X-Frame-Options）之前，否则面板内联脚本会被主站 CSP 拦截；
// 面板自身的 Bearer Token 鉴权保持不变。
const PANEL_UPSTREAM = { host: '127.0.0.1', port: Number(process.env.PANEL_PORT || 3457) };
let panelSpawnPending = false;
function trySpawnPanelServer() {
  // 快速探测面板是否在监听；不可达则自动拉起（避免入口打不开），10s 内去重
  if (panelSpawnPending) return;
  panelSpawnPending = true;
  setTimeout(() => { panelSpawnPending = false; }, 10000);
  const probe = http.request({ host: PANEL_UPSTREAM.host, port: PANEL_UPSTREAM.port, path: '/api/bootstrap', method: 'GET', timeout: 1200 }, (r) => { r.resume(); });
  probe.on('timeout', () => { probe.destroy(); doSpawnPanel(); });
  probe.on('error', () => doSpawnPanel());
  probe.end();
}
function doSpawnPanel() {
  try {
    const cp = require('child_process');
    const panelPath = path.join(ROOT_DIR, 'panel', 'panel-server.js');
    if (!fs.existsSync(panelPath)) return;
    const child = cp.spawn(process.execPath, [panelPath], {
      cwd: path.join(ROOT_DIR, 'panel'),
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    console.log('[ops] 运维面板未运行，已自动拉起 panel-server.js (pid=' + child.pid + ')');
  } catch (e) {
    console.error('[ops] 自动拉起运维面板失败:', e.message);
  }
}
function proxyToPanel(req, res, isRetry) {
  const parsed = new URL(req.url, 'http://' + (req.headers.host || '127.0.0.1'));
  const upstreamPath = parsed.pathname.replace(/^\/ops/, '') || '/';
  const q = parsed.search || '';
  const proxyReq = http.request({
    host: PANEL_UPSTREAM.host,
    port: PANEL_UPSTREAM.port,
    path: upstreamPath + q,
    method: req.method,
    headers: Object.assign({}, req.headers, { host: '127.0.0.1:' + PANEL_UPSTREAM.port }),
    timeout: 8000
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('timeout', () => proxyReq.destroy());
  proxyReq.on('error', (e) => {
    if (!isRetry && (req.method === 'GET' || req.method === 'HEAD')) {
      // 首次失败：面板可能刚被杀/尚未启动，自动拉起后 3 秒重试一次（GET/HEAD 可安全重放）
      setTimeout(() => proxyToPanel(req, res, true), 3000);
    } else if (!res.headersSent) {
      res.status(502).json({ ok: false, message: '运维面板不可达，请确认 panel-server.js 已启动（' + e.message + '）' });
    } else {
      res.end();
    }
  });
  if (req.method === 'GET' || req.method === 'HEAD') proxyReq.end();
  else req.pipe(proxyReq);
}
// 运维面板反向代理：先过管理员鉴权，避免把仅监听 localhost 的管理面板经公网入口暴露给匿名用户
app.use('/ops', requireAdminCompat, (req, res) => {
  trySpawnPanelServer();
  proxyToPanel(req, res, false);
});
// ==================== 运维面板反向代理 END ====================

// 安全响应头（CSP + X-Frame-Options + HSTS + X-Content-Type-Options）
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  // Content-Security-Policy（已移除 unsafe-eval，保留 unsafe-inline 待后续 nonce 改造）
  // Leaflet 已本地化至 /vendor/leaflet，unpkg 仅作为兜底；script-src 与 style-src
  // 必须保持一致，否则脚本被拦而样式放行会导致地图静默失效。
  res.setHeader('Content-Security-Policy',
      "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline' https://unpkg.com; " +
      "style-src 'self' 'unsafe-inline' https://unpkg.com https://fonts.googleapis.com; " +
      "img-src 'self' data: blob: https:; " +
      "font-src 'self' https://fonts.gstatic.com; " +
      "connect-src 'self' ws: wss: https://api.vrchat.cloud; " +
      "frame-ancestors 'none'; " +
      "base-uri 'self'"
    );
  next();
});
// DDoS 防护（只对 API 路由生效，避免限制静态资源）
app.use('/api', ddosLimiter);

// API 响应一律不缓存。
// 此前 Express 默认的 ETag 会给每个 res.json() 加上 ETag，而 API 又没有任何
// Cache-Control，浏览器于是按启发式规则缓存并在下次访问时发条件请求，服务端返回
// 304 —— fetch 拿到的就是真真正正的 304，`res.ok` 为 false（ok 只在 200~299 成立）。
// 前端所有 `if (!res.ok) return;` 的分支因此在"第二次打开页面"时全部走空，
// 首页统计一直停在骨架屏的 "-" 就是这么来的。
// 顺带堵住另一个问题：登录后的私有数据本来可能被中间缓存留存。
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

app.use(suspiciousRequestDetector);
app.use(metricsMiddleware);
app.use(apiVersionMiddleware);
app.use(requestSizeLimiter);
app.use(express.json({ limit: '20mb' }));
// WAF 必须在 express.json() 之后注册，否则 req.body 尚未解析，POST/PUT 请求体中的注入/XSS 特征不会被扫描（纵深防御）。
enableWaf(app);

// 强制 UTF-8
app.use((req, res, next) => {
  const origSetHeader = res.setHeader.bind(res);
  res.setHeader = function(name, value) {
    if (name.toLowerCase() === 'content-type' && value.includes('text/') && !value.includes('charset')) {
      return origSetHeader(name, value + '; charset=utf-8');
    }
    return origSetHeader(name, value);
  };
  next();
});

// 静态文件
// P1 性能：启用 ETag 协商缓存。重复访问时浏览器带 If-None-Match，
// 未变动的资源返回 304（无响应体），省去全量重下。
// 注意：仅对静态资源启用 etag；API 仍保持 no-store（见上文 /api 中间件），
// 以免 304 误判破坏前端 res.ok 校验。
// 缓存策略双轨：
//  1) 带 ?v= 版本号的资源（JS/CSS/vendor，如 posts.js?v=20260822a）：
//     版本号变即 URL 变，可放心一年 immutable，浏览器直接本地命中、零网络请求，
//     这是 Web 端最接近 VRCX 桌面客户端"本地磁盘秒开"的手段。
//  2) 无版本号的资源（index.html、sw.js、images 等）：maxAge:0 + ETag 协商，
//     保证内容更新能即时拉取。
app.use('/assets', express.static(ASSETS_DIR, {
  maxAge: 0,
  etag: true,
  setHeaders: (res, filePath) => {
    if (res.req && /\?v=/.test(res.req.url)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }
}));
app.use(express.static(path.join(ROOT_DIR, 'public'), {
  maxAge: 0,
  etag: true,
  setHeaders: (res, filePath) => {
    if (res.req && /\?v=/.test(res.req.url)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }
}));

// 默认头像占位图（支持 ?name= 参数生成首字母/首汉字）
app.get('/api/avatar/default', (req, res) => {
  const name = (req.query.name || '').toString().trim();
  // 取首字母或首汉字：有中文取第一个字符，否则取第一个字母并大写
  let initial = '';
  if (name) {
    const first = name.charAt(0);
    initial = /[\u4e00-\u9fa5]/.test(first) ? first : first.toUpperCase();
  }
  const bg = initial ? 'var(--accent,#7c5cfc)' : '#e0e0e0';
  const fill = initial ? '#fff' : '#aaa';
  const fontSize = initial ? '28' : '24';
  const text = initial || '?';
  const safeText = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" fill="${bg}" rx="32"/><text x="32" y="37" text-anchor="middle" fill="${fill}" font-size="${fontSize}" font-family="sans-serif" font-weight="600" dy=".05em">${safeText}</text></svg>`;
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(svg);
});

// ==================== Session 配置 ====================
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    logger.error('[server] SESSION_SECRET 未设置，生产环境拒绝启动（避免会话密钥随机化导致全站登出/可被本地读取者解密）');
    process.exit(1);
  }
  logger.warn('[server]', 'SESSION_SECRET 未设置，使用临时密钥（仅适用于 setup 初始化）');
}
const effectiveSecret = SESSION_SECRET || require('crypto').randomBytes(32).toString('hex');

// 生产环境密钥强校验：SESSION_SECRET / ENCRYPT_KEY 缺失则启动失败（M2）
if (process.env.NODE_ENV === 'production') {
  const ENCRYPT_KEY_OK = process.env.ENCRYPT_KEY && process.env.ENCRYPT_KEY.length === 64;
  if (!ENCRYPT_KEY_OK) {
    logger.error('[server] ENCRYPT_KEY 未设置或长度不足 64 位十六进制，生产环境拒绝启动');
    process.exit(1);
  }
}

let sessionStore;
try {
  const MySQLStore = require('express-mysql-session')(session);
  sessionStore = new MySQLStore({
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: parseInt(process.env.MYSQL_PORT, 10) || 3306,
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'jingtu_group',
    createDatabaseTable: true,
    expiration: 7 * 24 * 60 * 60 * 1000,
    schema: { tableName: 'sessions' }
  });
} catch (e) { logger.warn('[session]', 'express-mysql-session 加载失败，回退到 MemoryStore:', e.message); logger.warn('[session]', '运行 npm install express-mysql-session 可启用 MySQL session 持久化'); }

app.use(session({
  secret: effectiveSecret,
  store: sessionStore || undefined,
  resave: false,
  saveUninitialized: false,
  rolling: true,               // 每次请求刷新 session 过期时间
  cookie: {
    // 'auto'：当请求经 HTTPS（req.secure，依赖上面的 trust proxy 解析 X-Forwarded-Proto）
    // 时自动给 Cookie 加 Secure；纯 HTTP 则不加。取代原先误把 MYSQL_HOST 当判据的逻辑。
    secure: 'auto',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    sameSite: 'lax'
  }
}));

// ==================== 上传目录鉴权 ====================
// /uploads 含用户上传的私人媒体，默认禁止匿名访问（避免被枚举/爬取）。
// 放行条件：① 已登录（任意登录用户）；② 携带有效且未过期的公开分享令牌 ?share=<code>。
// 分享链接由 routes/share.js 在返回内容时把 /uploads/... 改写为 /uploads/...?share=<code>，
// 从而让匿名分享查看者仍能加载其媒体，但不暴露其它用户的上传。
// 根据分享的 type/target_id 反查该分享内容关联的媒体路径集合（用于严格鉴权，防止用任一有效码访问全站私有媒体）
async function getShareAuthPaths(pool, type, targetId) {
  const paths = [];
  const push = (v) => {
    if (!v || typeof v !== 'string') return;
    if (/^https?:/i.test(v)) return; // 跳过外链
    paths.push(v.startsWith('/uploads/') ? v : '/uploads/' + v.replace(/^\/+/, ''));
  };
  if (type === 'album') {
    const [rows] = await pool.query('SELECT photo_path, thumb_path FROM album_photo WHERE id = ?', [targetId]);
    rows.forEach((r) => { push(r.photo_path); push(r.thumb_path); });
  } else if (type === 'post') {
    const [rows] = await pool.query('SELECT media_url, thumb_url FROM post_media WHERE post_id = ?', [targetId]);
    rows.forEach((r) => { push(r.media_url); push(r.thumb_url); });
  } else if (type === 'event') {
    const [rows] = await pool.query('SELECT world_image_url FROM event WHERE id = ?', [targetId]);
    if (rows[0]) push(rows[0].world_image_url);
  }
  return paths;
}

app.use('/uploads', async (req, res, next) => {
  // 头像为用户公开资料图，允许公开访问（无需登录/分享令牌），避免游客视图头像回退为占位图
  if (req.path.startsWith('/avatars/')) return next();
  if (req.session && req.session.userId) return next();
  const code = typeof req.query.share === 'string' ? req.query.share : '';
  if (code) {
    const pool = getPool();
    if (pool) {
      try {
        // P0 修复：分享令牌必须与具体资源绑定，禁止用任一有效码访问全站私有媒体
        const [links] = await pool.query(
          'SELECT type, target_id FROM share_links WHERE share_code = ? AND expires_at > NOW() LIMIT 1',
          [code]
        );
        if (links.length === 0) {
          return res.status(401).json({ error: '分享链接无效或已过期，需要登录后访问' });
        }
        const authPaths = await getShareAuthPaths(pool, links[0].type, links[0].target_id);
        // 严格边界匹配：精确相等，或为其子路径（防 /uploads/x.jpg 越权匹配 /uploads/x1.jpg）
        const allowed = sharePathAllowed(req.path, authPaths);
        if (allowed) return next();
        return res.status(401).json({ error: '分享链接无权访问该资源' });
      } catch (e) {
        return res.status(401).json({ error: '需要登录后才能访问该资源' });
      }
    }
  }
  res.status(401).json({ error: '需要登录后才能访问该资源' });
});
app.use('/uploads', express.static(path.join(ROOT_DIR, 'uploads')));

// Session 验证中间件 — 确保用户未被封禁且仍存在
app.use('/api', async (req, res, next) => {
  if (req.session?.userId) {
    try {
      const pool = getPool();
      if (pool) {
        const [rows] = await pool.query('SELECT banned FROM users WHERE id=? AND deleted_at IS NULL', [req.session.userId]);
        if (rows.length === 0 || rows[0].banned) {
          req.session.destroy(() => {});
          return res.status(401).json({ error: '账户已被禁用，请重新登录', code: 'ACCOUNT_DISABLED' });
        }
      }
    } catch (e) {
      // 封禁状态校验依赖数据库；查询失败时按 fail-closed 拒绝，避免被封禁用户绕过校验。
      console.error('[session] 封禁状态校验失败:', e.message);
      return res.status(503).json({ error: '服务暂时不可用，请稍后重试', code: 'SERVICE_UNAVAILABLE' });
    }
  }
  next();
});

// ==================== 速率限制 ====================
// 统一使用 ddosLimiter（定义在 security.js）

// 登录路由限流
app.use('/api/auth/login', loginBruteForceLimiter);
app.use('/api/auth/vrchat-login', loginBruteForceLimiter);
app.use('/api/login', loginBruteForceLimiter);

// 上传接口限流（每分钟10次）
app.use('/api/album/upload', uploadLimiter);
app.use('/api/profile/photos/upload', uploadLimiter);
app.use('/api/profile/videos/upload', uploadLimiter);
app.use('/api/admin/group-image', uploadLimiter);

// 管理后台接口限流（每分钟30次）
app.use('/api/admin', adminLimiter);
app.use('/api/database', adminLimiter);
app.use('/api/migration', adminLimiter);
app.use('/api/backups', adminLimiter);
app.use('/api/export', adminLimiter);
app.use('/api/files', adminLimiter);
app.use('/api/config', adminLimiter);

// 搜索接口限流（每30秒20次）
app.use('/api/search', searchLimiter);

// ==================== CSRF 保护 ====================
const csrfTokens = new Map();
const CSRF_EXPIRY = 60 * 60 * 1000;

function generateCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

// 检查是否已有用户（用于控制初始化流程）
app.get('/api/auth/check-init', async (req, res) => {
  try {
    let rows;
    try {
      [rows] = await getPool().query(`SELECT COUNT(*) AS count FROM users WHERE deleted_at IS NULL`);
    } catch (e) {
      if (e.code === 'ER_BAD_FIELD_ERROR') {
        [rows] = await getPool().query(`SELECT COUNT(*) AS count FROM users`);
      } else {
        throw e;
      }
    }
    res.json({ hasUser: rows[0].count > 0 });
  } catch (e) { logger.error('[server]', e.message, e.stack); res.status(500).json({ error: safeError(e.message) }); }
});

// 获取 CSRF Token（绑定到当前 session，防止 token 被跨用户复用）
app.get('/api/csrf-token', (req, res) => {
  const token = generateCsrfToken();
  const sid = req.sessionID || 'anon';
  csrfTokens.set(token, { sid, createdAt: Date.now() });
  // token 已在 csrfTokens Map 中绑定到当前 sessionID，校验时仅需验证 Map 中的 sid 匹配
  res.json({ csrfToken: token });
});

// 定时清理过期 CSRF Token（每15分钟）
const csrfCleanupInterval = setInterval(() => {
  const now = Date.now();
  const beforeSize = csrfTokens.size;
  for (const [token, record] of csrfTokens) {
    if (now - record.createdAt > CSRF_EXPIRY) csrfTokens.delete(token);
  }
  if (csrfTokens.size > 10000) {
    // 防内存泄漏：超过上限强制清理一半最旧的
    const sorted = [...csrfTokens.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
    const toDelete = Math.floor(sorted.length / 2);
    for (let i = 0; i < toDelete; i++) csrfTokens.delete(sorted[i][0]);
  }
}, 15 * 60 * 1000).unref();

// CSRF 中间件（豁免 GET/HEAD/OPTIONS + 登录/初始化路径）
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // ⚠️ Express app.use('/api', ...) 会裁剪 req.path，所以豁免路径使用相对于 /api 的路径
  const exemptPaths = ['/vrchat-login', '/init',
    '/auth/login', '/auth/init', '/csrf-token',
    '/auth/logout', '/auth/vrchat-login',
    '/auth/forgot-password', '/auth/verify-reset-code', '/auth/reset-password',
    '/setup/test-db', '/setup/test-email', '/setup/save',
    '/setup/state', '/setup/reset',
    '/system/db-recover'];
  if (exemptPaths.some(p => req.path === p)) return next();
  const token = req.headers['x-csrf-token'];
  if (!token || !csrfTokens.has(token)) return res.status(403).json({ error: 'CSRF token 无效' });
  const record = csrfTokens.get(token);
  if (Date.now() - record.createdAt > CSRF_EXPIRY) {
    csrfTokens.delete(token);
    return res.status(403).json({ error: 'CSRF token 已过期，请刷新页面' });
  }
  // session 绑定检查：校验 token 生成时所绑定的 sessionID 是否与当前请求一致
  // 防止 token 被跨用户/跨会话复用（例如 CSRF token 泄露后攻击者用自己的 session 使用）
  if (record.sid && record.sid !== 'anon' && record.sid !== req.sessionID) {
    csrfTokens.delete(token);
    return res.status(403).json({ error: 'CSRF token 与当前会话不匹配' });
  }
  // token 可重用：仅在过期（CSRF_EXPIRY）或会话不匹配时清除
  // 解决并发 POST 请求竞争（A 消费 token 后 B 仍可使用同一 token）
  next();
});

// ==================== 系统 VRChat 登录状态 ====================
let authState = { loggedIn: false, cookie: null, userId: null, displayName: null, cookieSetAt: null };
global.__getVrcAuthState = () => authState; // 供后台 VRC 监控读取最新鉴权状态

// V8.2: VRChat cookie 软性过期时间（天）。
// 0 = 永不过期（默认）；其它值 = 该 cookie 自设置起超过 N 天即视为过期，
// 让调用方自动降级/提示重新登录。单位：天；存于 system_config.vrc_cookie_expire_days。
let vrcCookieExpireDays = 0;
function getVRCCookieExpireDays() { return vrcCookieExpireDays; }
function setVRCCookieExpireDays(days) {
  const n = Math.max(0, parseInt(days, 10) || 0);
  vrcCookieExpireDays = n;
  return n;
}
// 判断某个 cookie（记录于 setAt 时间戳）是否已过配置的有效期
function isCookieExpired(setAt) {
  if (!vrcCookieExpireDays || !setAt) return false; // 永不过期或未记录设置时间 → 视为有效
  return (Date.now() - setAt) > vrcCookieExpireDays * 86400000;
}

// ==================== VRChat Pipeline WebSocket ====================
const vrcPipeline = new VRCPipeline();

function updatePipelineAuth() {
  if (authState.loggedIn && authState.cookie) {
    const authTokenMatch = authState.cookie.match(/authcookie_[^;]+/);
    if (authTokenMatch) {
      vrcPipeline.setAuthToken(authTokenMatch[0]);
      if (!vrcPipeline.isConnected) {
        vrcPipeline.connect();
      }
    }
  }
}

function broadcastGroupStats() {
  (async () => {
    try {
      const pool = getPool();
      if (!pool) return;
      const [onlineRes] = await pool.query(`SELECT COUNT(*) as count FROM group_roster WHERE is_member=1 AND is_online=1`);
      const [totalRes] = await pool.query(`SELECT COUNT(*) as count FROM group_roster WHERE is_member=1`);
      const [worldRes] = await pool.query(`SELECT world_name AS worldName, COUNT(*) as count FROM group_roster WHERE is_member=1 AND is_online=1 AND world_name IS NOT NULL AND world_name != '' GROUP BY world_name ORDER BY count DESC LIMIT 5`);
      
      const stats = {
        type: 'group_stats',
        onlineCount: onlineRes[0].count,
        totalMembers: totalRes[0].count,
        onlineRate: totalRes[0].count > 0 ? Math.round((onlineRes[0].count / totalRes[0].count) * 100) : 0,
        worldDistribution: worldRes.map(r => ({ worldName: r.worldName, count: r.count })),
        timestamp: Date.now()
      };
      
      wsService.broadcastAllExcept(null, stats);
    } catch (e) { /* 静默失败 */ }
  })();
}

vrcPipeline.on('connected', () => {
  logger.info('[vrc-pipeline]', '已连接到 VRChat Pipeline');
});

vrcPipeline.on('disconnected', (data) => {
  logger.info('[vrc-pipeline]', `断开连接: ${data.code}`);
});

vrcPipeline.on('error', (err) => {
  logger.error('[vrc-pipeline]', `错误: ${err.message}`);
});

vrcPipeline.on('notification', (notification) => {
  logger.info('[vrc-pipeline]', `新通知: ${notification.notificationType}`);
  
  wsService.broadcastAllExcept(null, {
    type: 'vrc_notification',
    notification: notification
  });
  
  if (notification.notificationType === 'group.announcement') {
    (async () => {
      try {
        const pool = getPool();
        await pool.query(
          `INSERT INTO announcement (title, content, create_admin, visibility) VALUES (?, ?, ?, 'members_only')`,
          [notification.title, notification.message, 'VRChat']
        );
      } catch (e) { logger.error('[announcement]', '群组公告存储失败:', e.message); }
    })();
  }
});

vrcPipeline.on('user', (msg) => {
  logger.debug('[VRC]', `用户事件: ${msg.type}`);
});

vrcPipeline.on('friend', (msg) => {
  logger.debug('[VRC]', `好友事件: ${msg.type}`);
  
  wsService.broadcastAllExcept(null, {
    type: 'friend_event',
    eventType: msg.type,
    timestamp: Date.now()
  });
});

// 从加密存储读取系统 Cookie
try {
  if (fs.existsSync(SESSION_FILE)) {
    const raw = fs.readFileSync(SESSION_FILE, 'utf8');
    const saved = JSON.parse(raw);
    if (saved && saved.cookie) {
      // 解密存储的 cookie（兼容旧版未加密的 cookie）
      const decrypted = decryptCookie(saved.cookie);
      if (decrypted) {
        authState = { ...saved, cookie: decrypted, loggedIn: true };
      } else {
        // 解密失败，尝试明文（旧版格式），重新加密存储
        authState = { ...saved, loggedIn: true };
        // 如果 cookie 没有 enc: 前缀，说明是旧明文，立即加密重写
        if (!saved.cookie.startsWith('enc:')) {
          const encrypted = encryptCookie(saved.cookie);
          if (encrypted) {
            authState.cookie = saved.cookie; // 保留内存中的明文
            saved.cookie = encrypted;
            const tmp = SESSION_FILE + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(saved, null, 2), 'utf8');
            fs.renameSync(tmp, SESSION_FILE);
          }
        }
      }
    }
  }
} catch (e) { logger.warn('[vrc-session]', '读取 VRChat session.json 失败（已损坏？），将重新登录:', e.message); }

// 初始化 Pipeline 连接
updatePipelineAuth();

// 保存系统 VRChat 状态到文件（Cookie 加密存储）
async function saveAuthState() {
  const stateToSave = {
    ...authState,
    // cookie 加密后再写入文件
    cookie: authState.cookie ? encryptCookie(authState.cookie) : null
  };
  const tmp = SESSION_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(stateToSave, null, 2), 'utf8');
  fs.renameSync(tmp, SESSION_FILE);
  updatePipelineAuth();
}

// 获取 VRChat cookie：优先用户绑定 -> 系统登录（自动解密用户 session 中的加密 cookie）
// V8.2: 任一候选 cookie 超过配置的有效期（vrc_cookie_expire_days）即视为过期，
// 自动跳过该候选（返回 null），让上游 vrcWithFallback 降级或提示重新登录。
function getVRCCookie(req) {
  // 用户 session cookie（加密存储，需解密）+ 记录的设置时间
  const sessionCookie = req?.session?.vrchatCookie || req?.session?.vrcCookie;
  const sessionSetAt = req?.session?.vrcCookieSetAt;
  if (sessionCookie && !isCookieExpired(sessionSetAt)) {
    return decryptCookie(sessionCookie) || sessionCookie;
  }
  // 系统 Cookie（内存中已是明文）+ 记录的设置时间
  if (authState?.cookie && !isCookieExpired(authState.cookieSetAt)) {
    return authState.cookie;
  }
  return null;
}

// 仅取「当前登录用户」自己绑定的 VRChat cookie，绝不回退到系统账号。
// 用于 /vrc/avatar/set 这类「代表当前用户」的写操作，
// 防止未绑定 VRChat 的会员拿到系统账号 cookie 去越权改写系统账号头像（系统 Cookie 降级风险）。
function getVRCCookieUserOnly(req) {
  const sessionCookie = req?.session?.vrchatCookie || req?.session?.vrcCookie;
  if (sessionCookie) return decryptCookie(sessionCookie) || sessionCookie;
  return null;
}

// 标记某个 VRChat cookie 已失效，使下一次 getVRCCookie 自动降级到下一个候选。
// 场景：用户在个人中心绑定 VRChat 时存进 session 的 cookie 会过期，
// 过期后所有 VRC 操作都会拿到这份死 cookie 而永远不会 fallback 到有效的系统账号 cookie，
// 表现为「管理面板显示已登录，点同步却报登录已过期」。
async function invalidateVRCCookie(req, deadCookie) {
  let cleared = false;
  if (req?.session) {
    for (const key of ['vrchatCookie', 'vrcCookie']) {
      const raw = req.session[key];
      if (!raw) continue;
      const plain = decryptCookie(raw) || raw;
      if (!deadCookie || plain === deadCookie) {
        req.session[key] = null;
        cleared = true;
      }
    }
    // 显式持久化：仅清内存不 save 的话，下一个请求 session 从存储重载会把死 cookie 恢复，
    // 用户永远"看似已绑定"却每次都吃 401 → 降级系统 cookie，重绑引导永不触发。
    if (cleared && typeof req.session.save === 'function') {
      try {
        await new Promise((resolve) => req.session.save((err) => {
          if (err) logger.error('session', '保存失效 cookie 清除失败', { error: err.message });
          resolve();
        }));
      } catch (e) {
        logger.error('session', '保存失效 cookie 清除异常', { error: e.message });
      }
    }
  }
  // 重要：系统级 VRChat cookie 的注销不再在此处理。
  // 原逻辑会在「用户未绑定 VRChat、getVRCCookie 回退到系统 cookie、且上游偶发 401」
  // 时把整个系统账号注销 —— VRChat 因 2FA 复查间歇返回 401 是官方常态，
  // 一次偶发 401 就会让全站实时同步 / 每日模型扫描 / 群组同步全部停摆且无人感知。
  // 系统账号的登录 / 登出由管理面板（vrc_system.js + saveAuthState）独占负责。
  return cleared;
}
// 挂在 getVRCCookie 上，供各路由模块（只接收 getVRCCookieFn）调用，避免改动 13 处调用签名
getVRCCookie.invalidate = invalidateVRCCookie;

// ==================== 权限路由 ====================
app.use('/api/auth', require('./routes/auth'));
app.use('/api/profile', require('./routes/profile'));

// 权限组系统路由
app.use('/api/permission-groups', require('./routes/permission_groups'));

// 权限查看接口（只读检视器：网站用户权限 + 群组用户权限，可单独调用）
app.use('/api/permissions-view', require('./routes/permissions'));

// V6.9: 动态/朋友圈系统路由（独立模块）
app.use('/api/posts', require('./routes/posts')(notificationService));

app.use('/api/users', require('./routes/users'));
app.use('/api/moderations', require('./routes/moderations')(getVRCCookieUserOnly));
app.use('/api/checkin', require('./routes/checkin'));
app.use('/api/achievements', require('./routes/achievements'));
app.use('/api/user-like', require('./routes/user_like')(notificationService));

// ==================== 聊天私信系统 V6.12 ====================
app.use('/api/chat', require('./routes/chat')(notificationService));

// ==================== 好友 / 关注系统 V7.10 ====================
app.use('/api/friends', require('./routes/friends')(notificationService));
app.use('/api/follows', require('./routes/follows')(notificationService));

// ==================== 直播系统 V6.14 ====================
app.use('/api/live', require('./routes/live')(notificationService));

// ==================== VRChat 路由（系统级） ====================
// 系统 VRChat 登录/2FA/登出 + 健康检查
const vrcSystemRouter = require('./routes/vrc_system')(authState, saveAuthState);
app.use('/api', vrcSystemRouter);

// 健康检查（返回系统 VRChat 登录状态）
app.get('/api/health', (req, res) => {
  // 会话保活：如果有用户则触 refreshing session
  if (req.session?.userId) {
    req.session.touch();
  }
  res.json({
    status: 'ok',
    systemVrcLogin: authState.loggedIn,
    systemVrcUser: authState.loggedIn ? { id: authState.userId, displayName: authState.displayName } : null,
    // V8.2: 系统 VRChat cookie 软性过期配置与剩余有效期（供管理面板展示）
    vrcCookieExpireDays: vrcCookieExpireDays,
    vrcCookieSetAt: authState.cookieSetAt || null,
    vrcCookieExpiresAt: (vrcCookieExpireDays && authState.cookieSetAt)
      ? new Date(authState.cookieSetAt + vrcCookieExpireDays * 86400000).toISOString()
      : null
  });
});

// 前端运行环境配置：暴露可通过环境变量部署调整的客户端参数（如 WebSocket 地址）。
// 前端 connectWebSocket 优先读取本接口返回的 wsUrl，否则按当前协议自动探测。
app.get('/api/client-config', (req, res) => {
  const wsUrl = process.env.WS_URL || '';
  res.json({ wsUrl });
});

app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    // 统计条上的「在线」点开是本站在线成员列表（WebSocket 实时名单），
    // 数字必须和它同源。原来这里查的是 group_roster.is_online —— 那是
    // VRChat 群组成员在游戏里的在线状态，语义完全不同；两个数写进同一个
    // #dashOnline，谁后到谁赢，用户看到的数字会来回跳。
    const onlineCount = wsService.onlineUsers.size;
    const [
      [memberRes], [photoRes], [eventRes], [postRes], [vrcOnlineRes],
      [memberGrowth], [eventSignRate], [postActivity], [checkinStats], [recentUsers]
    ] = await Promise.all([
      getPool().query('SELECT COUNT(*) as count FROM users WHERE deleted_at IS NULL AND approved = 1 AND banned = 0'),
      getPool().query('SELECT COUNT(*) as count FROM album_photo WHERE is_recycle=0'),
      getPool().query('SELECT COUNT(*) as count FROM event WHERE is_archive=0'),
      getPool().query('SELECT COUNT(*) as count FROM posts'),
      getPool().query('SELECT COUNT(*) as count FROM group_roster WHERE is_member=1 AND is_online=1'),
      getPool().query(`SELECT DATE(created_at) as date, COUNT(*) as count FROM users WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) GROUP BY DATE(created_at) ORDER BY date`),
      getPool().query(`SELECT e.id, e.title, e.event_time as eventTime, COUNT(es.id) as signCount, e.max_sign as maxSign FROM event e LEFT JOIN event_sign es ON e.id = es.event_id WHERE e.is_archive=0 GROUP BY e.id ORDER BY e.event_time DESC LIMIT 10`),
      getPool().query(`SELECT DATE(created_at) as date, COUNT(*) as posts, SUM(like_count) as likes, SUM(comment_count) as comments FROM posts WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) GROUP BY DATE(created_at) ORDER BY date`),
      getPool().query(`SELECT COUNT(*) as total FROM event_checkin`),
      getPool().query(`SELECT id, display_name, created_at FROM users ORDER BY created_at DESC LIMIT 10`)
    ]);

    res.json({
      members: memberRes[0].count,
      photos: photoRes[0].count,
      events: eventRes[0].count,
      posts: postRes[0].count,
      online: onlineCount,
      vrcOnline: vrcOnlineRes[0].count,
      checkins: checkinStats[0].total,
      memberGrowth: memberGrowth,
      eventSignRate: eventSignRate.map(e => ({
        id: e.id,
        title: e.title,
        eventTime: e.eventTime,
        signCount: e.signCount,
        maxSign: e.maxSign,
        rate: e.maxSign > 0 ? Math.round((e.signCount / e.maxSign) * 100) : 0
      })),
      postActivity: postActivity,
      recentUsers: recentUsers
    });
  } catch (e) { logger.error('[stats]', e.message, e.stack); res.status(500).json({ error: safeError(e.message) }); }
});

app.get('/api/public/stats', async (req, res) => {
  try {
    const [
      [memberRes], [photoRes], [eventRes], [postRes], [onlineRes]
    ] = await Promise.all([
      getPool().query('SELECT COUNT(*) as count FROM users WHERE deleted_at IS NULL AND approved = 1 AND banned = 0'),
      getPool().query('SELECT COUNT(*) as count FROM album_photo WHERE is_recycle=0'),
      getPool().query('SELECT COUNT(*) as count FROM event WHERE is_archive=0'),
      getPool().query('SELECT COUNT(*) as count FROM posts'),
      getPool().query('SELECT COUNT(*) as count FROM group_roster WHERE is_member=1 AND is_online=1')
    ]);

    res.json({
      totalUsers: memberRes[0].count,
      totalPhotos: photoRes[0].count,
      totalEvents: eventRes[0].count,
      totalPosts: postRes[0].count,
      // 与 /api/stats 保持同一语义：本站实时在线（WebSocket 名单），
      // 而不是 VRChat 群成员在游戏里的在线状态。
      onlineCount: wsService.onlineUsers.size,
      vrcOnlineCount: onlineRes[0].count
    });
  } catch (e) {
    logger.error('[public/stats]', e.message, e.stack);
    res.json({
      totalUsers: '-',
      totalPhotos: '-',
      totalEvents: '-',
      totalPosts: '-',
      onlineCount: 0
    });
  }
});

// ==================== 全局搜索 API ====================
app.get('/api/search', requireAuth, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json({ announcements: [], events: [], users: [] });
    const like = `%${q}%`;

    const [announcements] = await getPool().query(
      `SELECT id, title, content FROM announcement WHERE title LIKE ? OR content LIKE ? ORDER BY create_time DESC LIMIT 5`,
      [like, like]
    );

    const [events] = await getPool().query(
      `SELECT id, title, description FROM event WHERE (title LIKE ? OR description LIKE ?) AND is_archive=0 ORDER BY event_time DESC LIMIT 5`,
      [like, like]
    );

    const [users] = await getPool().query(
      `SELECT id, login_id AS loginId, display_name AS displayName FROM users WHERE deleted_at IS NULL AND approved=1 AND banned=0 AND (login_id LIKE ? OR display_name LIKE ?) LIMIT 5`,
      [like, like]
    );

    res.json({ announcements, events, users });
  } catch (e) {
    logger.error('[search]', e.message, e.stack);
    res.json({ announcements: [], events: [], users: [] });
  }
});

// ==================== VRChat 群组路由（已提取到独立模块） ====================
const groupsRouter = require('./routes/groups')(getVRCCookie, GROUP_ID, getVRCCookieUserOnly);
app.use('/api', groupsRouter);

// ==================== 公告 API ====================
app.use('/api/announcements', require('./routes/announcements')(notificationService));

// ==================== 活动 API（已提取到独立模块） ====================
const eventsRouter = require('./routes/events')(getVRCCookie, notificationService, GROUP_ID);
app.use('/api/events', eventsRouter);


// ==================== 管理 / 搜索 / 改名 / 权限路由（已提取到独立模块） ====================
const adminRouter = require('./routes/admin')(GROUP_ID, {
  getExpireDays: getVRCCookieExpireDays,
  setExpireDays: setVRCCookieExpireDays
});
app.use('/api', adminRouter);

// ==================== 相册 API（已提取到独立模块） ====================
const albumRouter = require('./routes/album')(authState, notificationService);
app.use('/api', albumRouter);

// ==================== 群组图片上传（type 白名单防路径穿越） ====================
const GROUP_IMG_TYPES = ['image', 'avatar', 'banner', 'logo', 'cover'];
const groupImgUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => { if (!fs.existsSync(ASSETS_DIR)) fs.mkdirSync(ASSETS_DIR, { recursive: true }); cb(null, ASSETS_DIR); },
    filename: (req, file, cb) => {
      const type = GROUP_IMG_TYPES.includes(req.body.type) ? req.body.type : 'image';
      cb(null, `group-${type}.png`);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: createFileFilter(['IMAGE'])
});

app.post('/api/admin/group-image', requireAdminCompat, groupImgUpload.single('image'), async (req, res) => {
  if (!req.file) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请选择图片');
  try {
    const type = GROUP_IMG_TYPES.includes(req.body.type) ? req.body.type : 'image';
    const targetFile = path.join(ASSETS_DIR, `group-${type}.png`);
    await sharp(req.file.path).resize(type === 'avatar' ? 512 : type === 'banner' ? 1200 : 1920).jpeg({ quality: 85 }).toFile(targetFile);
    // sharp 成功后删除临时文件
    try { fs.unlinkSync(req.file.path); } catch {}
    res.json({ success: true, url: `/assets/group-${type}.png?v=${Date.now()}` });
  } catch (e) {
    // sharp 处理异常时也要清理临时文件
    try { if (req.file && req.file.path) fs.unlinkSync(req.file.path); } catch {}
    sendError(res, 500, ErrorCodes.INTERNAL_ERROR, '图片处理失败，请稍后重试');
  }
});


// ==================== 通知系统 API（已提取到独立模块） ====================
const notificationsRouter = require('./routes/notifications')(authState, notificationService);
app.use('/api', notificationsRouter);
app.use('/api', require('./routes/logs'));
app.use('/api', require('./routes/security'));
app.use('/api', require('./routes/setup'));
app.use('/api/system', require('./routes/db-recover'));
app.use('/api/migration', require('./routes/migration'));
app.use('/api', require('./routes/health'));
app.use(require('./routes/sitemap'));
app.use('/api', require('./routes/config'));
app.use('/api', require('./routes/backups'));
app.use('/api', require('./routes/database'));
app.use('/api', require('./routes/files'));
app.use('/api', require('./routes/export'));
app.use('/api', require('./routes/analytics'));
app.use('/api', require('./routes/webhooks'));
app.use('/api/share', require('./routes/share')());
app.use('/api/avatar', require('./routes/avatar')());
// 统一收藏系统 (V8.2)：合并模型收藏馆与收藏夹（含由孤儿 model-collections 模块迁移而来的 VRCX 匿名搜索）
app.use('/api/collections', require('./routes/collections')(getVRCCookie));

app.use('/api/event-teams', require('./routes/event_teams'));

// 启动期路由冲突自检（P2-15 / B-3，只读）：扫描全部已注册路由，
// 报告「同方法同路径完全重复（死代码）」与「参数路由先注册截胡字面路由」两类隐患。
try {
  const { auditRouteConflicts } = require('./route_guard');
  const audit = auditRouteConflicts(app);
  if (audit.exact.length === 0 && audit.shadow.length === 0) {
    logger.info('[server]', '路由冲突自检通过（共 ' + audit.total + ' 条路由）');
  } else {
    for (const d of audit.exact) {
      logger.warn('[server]', '路由完全重复（后注册者死代码）: ' + d.key + '，先注册 seq=' + d.first.seq + '，重复 seq=' + d.dup.seq);
    }
    for (const s of audit.shadow) {
      logger.warn('[server]', '路由被截胡: ' + s.key + '（seq=' + s.seqSelf + '）被先注册的 ' + s.by + '（seq=' + s.seqFirst + '）形状兼容覆盖');
    }
    logger.warn('[server]', '路由冲突自检发现 ' + (audit.exact.length + audit.shadow.length) + ' 处冲突（共 ' + audit.total + ' 条路由），请核查挂载顺序');
  }
} catch (e) {
  logger.warn('[server]', '路由冲突自检失败（已跳过）：', e.message);
}

// /api 未匹配路由统一返回中文 JSON 404（避免 Express 默认 HTML "Cannot GET"）
app.use('/api', (req, res) => {
  res.status(404).json({ error: '请求的资源不存在' });
});

// Swagger 文档仅在非生产环境挂载（生产可省略 devDependencies）。
// 若仍需在生产查看 API 文档，请在反向代理层对 /api-docs 做鉴权或 IP 白名单。
if (process.env.NODE_ENV !== 'production') {
  try {
    const { setupSwagger } = require('./swagger');
    setupSwagger(app);
  } catch (e) {
    logger.warn('[server]', 'Swagger 加载失败（已跳过）：', e.message);
  }
}

// ==================== 全局错误处理 ====================
app.use((err, req, res, next) => {
  logger.error('[server]', '服务器错误:', err.message, err.stack);
  res.status(500).json({ error: process.env.NODE_ENV === 'development' ? err.message : '服务器内部错误' });
});

// ==================== WebSocket 在线状态 + 通知推送 ====================
wsService.setupWebSocket(server);
notificationService.setWSReferences(null, wsService.userWsMap);
securityAlert.setNotificationService(notificationService);

// ==================== 优雅关闭（防止句柄泄漏） ====================
async function gracefulShutdown(signal) {
  logger.info('[shutdown]', `收到 ${signal} 信号，开始优雅关闭...`);

  server.close(() => {
    logger.info('[shutdown]', 'HTTP 服务器已关闭');
  });

  clearInterval(csrfCleanupInterval);
  logger.info('[shutdown]', 'CSRF 清理定时器已清除');

  wsService.gracefulShutdown();
  logger.info('[shutdown]', 'WebSocket 服务器已关闭');

  const pool = dbMod.holder.pool;
  if (pool) {
    try {
      await pool.end();
      logger.info('[shutdown]', 'MySQL 连接池已关闭');
    } catch (e) {
      logger.error('[shutdown]', 'MySQL 关闭失败:', e.message);
    }
  }

  if (typeof startSchedule.gracefulShutdown === 'function') {
    startSchedule.gracefulShutdown();
    logger.info('[shutdown]', '定时任务已取消');
  }

  logger.info('[shutdown]', '优雅关闭完成');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));
// 未捕获异常 — 记录详细堆栈后退出（不阻塞不清理，因为状态可能已损坏）
process.on('uncaughtException', (err) => {
  logger.error('[uncaught]', '未捕获异常:', err.message, err.stack);
  try { if (dbMod.holder.pool) dbMod.holder.pool.end(); } catch {}
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.error('[rejection]', '未处理的 Promise 拒绝:', reason instanceof Error ? reason.message : reason);
  if (reason instanceof Error) logger.error('[rejection]', reason.stack);
});

// ==================== 初始化 ====================
(async function init() {
  try {
    const initDatabase = require('./db_init');
    await initDatabase();
    logger.info('[init]', '数据库统一初始化完成（含签到/成就/收藏/队伍系统）');

    // P2-2：启动期数据库连通性自检——initDatabase 只建表，不探活；
    // 这里显式 SELECT 1 验证连接池可用，连不上时打明确 error 而非等到首个请求才 500。
    try {
      const [probe] = await getPool().query('SELECT 1 AS ok');
      if (!probe || probe[0]?.ok !== 1) throw new Error('探活返回异常');
      logger.info('[init]', '数据库连通性自检通过（SELECT 1）');
    } catch (dbErr) {
      logger.error('[init]', '数据库连通性自检失败，请检查 MYSQL_* 配置与实例可达性:', dbErr.message);
    }

    // 把「请求大小限制」等运行时设置从 system_config 载入内存（超管后台可调，无需重启生效）
    try {
      const settings = require('./settings');
      await settings.refreshFromDb(getPool());
      logger.info('[init]', '运行时设置已载入内存（请求大小限制等）');
    } catch (se) { logger.warn('[init]', '载入运行时设置失败，使用默认值:', se.message); }

    // F-5: 媒体代理源池配置（镜像列表/链序/超时）同样启动载入，超管后台可调、无需重启
    try {
      const mediaProviders = require('./media_providers');
      await mediaProviders.refreshFromDb(getPool());
      logger.info('[init]', '媒体代理源池配置已载入内存');
    } catch (me) { logger.warn('[init]', '载入媒体代理源池配置失败，使用默认值:', me.message); }

    // V8.2: 从 system_config 载入 VRChat cookie 软性过期时间（天），超管后台可调、无需重启
    try {
      const [rows] = await getPool().query(
        `SELECT config_value FROM system_config WHERE config_key = 'vrc_cookie_expire_days'`
      );
      if (rows && rows[0]) {
        setVRCCookieExpireDays(rows[0].config_value);
        logger.info('[init]', `VRChat cookie 过期时间已载入: ${vrcCookieExpireDays} 天（0=永不过期）`);
      }
    } catch (ee) { logger.warn('[init]', '载入 VRChat cookie 过期时间失败，使用默认(永不过期):', ee.message); }

    startSchedule.setNotificationService(notificationService);
    startSchedule.setVRCCookieFn(getVRCCookie);
    startSchedule.setWsService(wsService);
    startSchedule();
  } catch (e) { 
    // 数据库初始化失败：明确报错（error 级），但继续启动 HTTP 服务，等待 setup 引导或运维修复。
    logger.error('[init]', '数据库初始化失败，服务将以降级模式启动（部分功能不可用）:', e.message); 
  }
  // 无论初始化是否成功，都启动 HTTP 服务
  server.listen(PORT, '0.0.0.0', () => {
    logger.info('[server]', `境途同游 V8.2 已启动: http://localhost:${PORT}`);
    logger.info('[server]', `局域网访问: http://<本机IP>:${PORT}`);

    // 启动后台子系统（均有环境守卫 / try-catch，缺失配置时安全跳过，不会拖垮主进程）
    cache.initCache().catch((e) => logger.warn('[init]', '缓存初始化异常:', e.message));
    mailer.initMailer();
    try { tasks.startTasks(); } catch (e) { logger.warn('[init]', '定时任务启动异常:', e.message); }
  });
})();
