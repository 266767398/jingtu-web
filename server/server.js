/**
 * 境途同游 — Node.js Express 服务端入口
 * MySQL 5.7 + express-session + CSRF + VRChat API
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// §兜底：若进程环境变量未注入（如 ServBay 以自身方式拉起 Node 而未 source .env），
// 则直接从 .env 文件补充缺失的键，避免 root@localhost 无密码连接数据库。
// H-3: 生产环境禁用兜底——.env 若被篡改/权限过宽，兜底会把它当作可信配置注入进程
//（SESSION_SECRET/ENCRYPT_KEY/MYSQL_PASSWORD 等敏感键会被覆盖），构成配置投毒风险。
(function backfillEnvFromFile() {
  if (process.env.NODE_ENV === 'production') return;
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
const multer = require('multer');
const sharp = require('sharp');
const { rateLimit } = require('express-rate-limit');
const http = require('http');
const { WebSocketServer } = require('ws');
const compression = require('compression');
const dbMod = require('./db');
const wsService = require('./ws_service');
const { fail, getPool, createFileFilter, sendError, ErrorCodes, ok } = require('./utils');
const startSchedule = require('./schedule');
const { requireAdminCompat, requireSuperAdmin } = require('./auth');
const {
  ddosLimiter, loginBruteForceLimiter,
  uploadLimiter, adminLimiter, searchLimiter, jttLimiter,
  requestSizeLimiter, suspiciousRequestDetector
} = require('./middleware/security');
const notificationService = require('./notification-service');
const logger = require('./logger');
const securityAlert = require('./security_alert');
const { apiVersionMiddleware } = require('./middleware/api_version');
const { enableWaf } = require('./middleware/waf');
const { metricsMiddleware } = require('./middleware/metrics');
const { setupPanelProxy, setupPanelLifecycle } = require('./panel_proxy');
const { setupUploadsAuth, setupAssetsAlbumAuth } = require('./middleware/uploads_auth');
const { uploadsStaticLimiter } = require('./middleware/rate_limit');
const { setupCsrf } = require('./middleware/csrf');
const cache = require('./cache');
const cacheService = require('./cache_service');
const mailer = require('./mailer');
const tasks = require('./tasks');
const setupVrcAuth = require('./vrc_auth');
const createStatsRouter = require('./routes/stats');

// Swagger 文档不在此处静态引入：默认任何环境均不加载，仅在显式设置
// ENABLE_SWAGGER=1 时按需 lazy 引入（见文件尾部挂载点），部署生产可安全使用
// `npm ci --omit=dev`。

const app = express();

// ==================== 反向代理信任 ====================
// 经 Nginx / 宝塔 / Docker 反代后，req.ip、限流与登录失败告警都依赖此设置。
// - 显式设置 TRUST_PROXY 时优先采用（值可是数字/逗号列表/"loopback"/"unix"/"false"）。
// - 未设置/留空时：一律不信任代理（安全默认）——防止端口直接暴露公网时伪造 X-Forwarded-For。
//   经 Nginx/宝塔/Docker 反代的部署请务必显式设置 TRUST_PROXY（如 1 或具体跳数）。
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
// P3-79: GROUP_ID 必须显式配置——未配置时生产环境拒绝启动（防止误同步到无关 VRChat 群组）；
// 仅测试/开发（NODE_ENV=test 或 SQLite 引擎）环境保留默认值便于本地运行与测试加载。
const defaultGroupId = 'grp_7a45b436-159c-4d9c-8303-e186ec25fc35';
if (!process.env.GROUP_ID) {
  const isTestOrSqlite = process.env.NODE_ENV === 'test' || process.env.JINGTU_DB_ENGINE === 'sqlite';
  if (process.env.NODE_ENV === 'production' && !isTestOrSqlite) {
    logger.error('[server]', 'GROUP_ID 未在 .env 中配置。为防止误同步到无关 VRChat 群组，服务拒绝启动。请将 GROUP_ID 配置为你的 VRChat 群组 ID 后重试。');
    process.exit(1);
  }
  logger.error('[server]', 'GROUP_ID 未在 .env 中配置，使用默认群组 ID（仅限开发/测试环境）。生产环境必须显式配置 GROUP_ID 指向你的 VRChat 群组。');
}
const GROUP_ID = process.env.GROUP_ID || defaultGroupId;
const ROOT_DIR = path.join(__dirname, '..');
const ASSETS_DIR = path.join(ROOT_DIR, 'assets');
const ALBUM_DIR = path.join(ASSETS_DIR, 'album');
const PROFILE_PHOTOS_DIR = path.join(ROOT_DIR, 'uploads', 'profile', 'photos');
const PROFILE_VIDEOS_DIR = path.join(ROOT_DIR, 'uploads', 'profile', 'videos');
for (const d of [PROFILE_PHOTOS_DIR, PROFILE_VIDEOS_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}
// HTTP 服务器超时设置（防止空闲连接堆积）
server.timeout = 120000;       
server.keepAliveTimeout = 5000; 
server.headersTimeout = 60000;  

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
    if (!origin) return cb(null, true); 
    if (Array.isArray(CORS_ORIGINS) && CORS_ORIGINS.includes(origin)) return cb(null, true);
    return cb(null, false); 
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
// 探测/自动拉起/代理/重试逻辑已抽至 panel_proxy.js；
// P2-154：入口鉴权从 requireAdminCompat（admin 级可穿透）提升为 requireSuperAdmin——
// 面板凭共享密码即可重置超管密码/清空用户数据/停杀服务/导出含 PII 站点包，
// 普通管理员（可能仅获局部数据面权限）不得触及机器级运维面。
setupPanelProxy(app, { ROOT_DIR, requireSuperAdmin });
// ==================== 运维面板反向代理 END ====================

// 安全响应头（CSP + X-Frame-Options + HSTS + X-Content-Type-Options）
// S-1: script-src 移除 'unsafe-inline'，改为每响应一次性 nonce。
// 实现要点：
//   ① nonce 由本中间件按请求生成，注入 CSP 头并同步打进 HTML 内联 <script>；
//      XSS 注入的无 nonce 内联脚本一律被拒；
//   ② HTML 改写发生在明文流上——本中间件注册在 compression 之后，压缩层位于内层，
//      下游写入的明文先被此处捕获，重写后交给 compression 压缩输出；
//   ③ /ops 运维面板由面板进程渲染 HTML，内联脚本无法打 nonce，维持 unsafe-inline 兜底。
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  const isOps = String(req.path || '').startsWith('/ops');
  if (isOps) {
    // 运维面板：内联脚本无法打 nonce，保留 unsafe-inline（Leaflet 兜底 unpkg 一并保留）
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
    return next();
  }
  const nonce = require('crypto').randomBytes(16).toString('base64url');
  res.locals.cspNonce = nonce;
  // Content-Security-Policy（已移除 unsafe-eval 与 script-src 的 unsafe-inline）
  // Leaflet 已本地化至 /vendor/leaflet，unpkg 仅作为兜底；style-src 保留 unsafe-inline
  // 以兼容主题系统/内联样式，script 侧由 nonce 严格管控。
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    `script-src 'self' 'nonce-${nonce}' https://unpkg.com; ` +
    "style-src 'self' 'unsafe-inline' https://unpkg.com https://fonts.googleapis.com; " +
    "img-src 'self' data: blob: https:; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    "connect-src 'self' ws: wss: https://api.vrchat.cloud; " +
    "frame-ancestors 'none'; " +
    "base-uri 'self'"
  );
  const write = res.write.bind(res);
  const end = res.end.bind(res);
  let body = null;
  const isHtml = () => {
    const ct = res.getHeader('content-type');
    return typeof ct === 'string' && ct.toLowerCase().includes('text/html');
  };
  res.write = (chunk, enc, cb) => {
    if (!res.headersSent && isHtml()) {
      body = body || [];
      body.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), enc || 'utf8'));
      if (typeof cb === 'function') cb();
      return true;
    }
    return write(chunk, enc, cb);
  };
  res.end = (chunk, enc, cb) => {
    if (chunk && !res.headersSent && isHtml()) {
      body = body || [];
      body.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), enc || 'utf8'));
    }
    if (body && body.length) {
      const html = Buffer.concat(body).toString('utf8');
      // 仅给「无 src 属性」的内联 <script> 打 nonce（外链脚本走 'self'，无需 nonce）
      const patched = html.replace(/<script(?![^>]*\s(?:src|nonce)=)[^>]*>/gi, (tag) => {
        const clean = tag.replace(/\s*\/\s*>$/, '>');
        return clean.replace(/>$/, ` nonce="${nonce}">`);
      });
      const out = Buffer.from(patched);
      res.setHeader('Content-Length', out.length);
      write(out);
      return end();
    }
    if (chunk !== undefined) return end(chunk, enc, cb);
    return end(enc, cb);
  };
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
// P1-53: 相册媒体鉴权（登录或分享令牌放行，游客直接访问 401）——
// 必须在 /assets 静态挂载之前注册，否则 express.static 会先接管
setupAssetsAlbumAuth(app);
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
// M-1：自带限流（防 DoS/SVG 探测）+ name 长度与字符过滤（防注入）+ Content-Disposition（防当 HTML 解析）
const avatarDefaultLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'RATE_LIMITED', msg: '请求过于频繁' }
});
app.get('/api/avatar/default', avatarDefaultLimiter, (req, res) => {
  const rawName = (req.query.name || '').toString().trim();
  // 长度 ≤16 且仅允许中文/字母/数字，从源头阻断 <script> 等注入字符
  const name = rawName.slice(0, 16).replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
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
  res.setHeader('Content-Disposition', 'inline; filename=default.svg');
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
// P2-121: 把同一把签名密钥注入 ws_service，避免两个模块各自随机导致开发态 WS 全部 401
wsService.setSessionSecret(effectiveSecret);

// 生产环境密钥强校验：SESSION_SECRET / ENCRYPT_KEY 缺失则启动失败（M2）
if (process.env.NODE_ENV === 'production') {
  const ENCRYPT_KEY_OK = process.env.ENCRYPT_KEY && process.env.ENCRYPT_KEY.length === 64;
  if (!ENCRYPT_KEY_OK) {
    logger.error('[server] ENCRYPT_KEY 未设置或长度不足 64 位十六进制，生产环境拒绝启动');
    process.exit(1);
  }
}

let sessionStore;
if (process.env.NODE_ENV === 'test' || process.env.JINGTU_DB_ENGINE === 'sqlite') {
  // P2-1：集成测试（supertest require 本模块）不依赖 MySQL；且 express-mysql-session
  // 构造时会启动未 unref 的过期清理定时器，会挂住 Jest worker 进程，故测试环境直接用 MemoryStore。
  // SQLite 模式下没有 MySQL 可用，session 同样回退到 MemoryStore。
  logger.warn('[session]', 'NODE_ENV=test 或 JINGTU_DB_ENGINE=sqlite：session 使用 MemoryStore');
} else {
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
}

app.use(session({
  secret: effectiveSecret,
  store: sessionStore || undefined,
  resave: false,
  saveUninitialized: false,
  rolling: true,               
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
// 鉴权逻辑已抽至 middleware/uploads_auth.js（分享令牌绑定具体资源 + 严格路径匹配）。
// P3-140：/uploads 静态媒体按 IP 限流（上限 1000/15min，见 rate_limit.js），
// 防有效分享码拼不同路径放大 DB 查询——必须在鉴权之前挂载，使未登录刷量同样受限。
app.use('/uploads', uploadsStaticLimiter);
setupUploadsAuth(app);
app.use('/uploads', express.static(path.join(ROOT_DIR, 'uploads'), {
  maxAge: 0,
  etag: true,
  setHeaders: (res, filePath) => {
    // 私人媒体（相册/帖子图等）：允许浏览器私有缓存以省重复下载，
    // 但禁止共享缓存（代理/CDN）留存，防止把 A 用户的照片推给 B 用户；
    // 头像本来就是公开资料图，可放宽为 public。
    const isPublic = /(^|[\\/])avatars[\\/]/.test(filePath);
    res.setHeader('Cache-Control', isPublic ? 'public, max-age=86400' : 'private, max-age=3600');
  }
}));

// Session 验证中间件 — 确保用户未被封禁且仍存在
// P2-122: banned 校验结果在 session 上短缓存 30s（bannedCheckedAt），避免每请求查库使 DB QPS 翻倍；
// 30s 内新封禁用户最多延迟 30s 生效（安全起见 30s 后立即重查）。
// M-3: 敏感操作（删除/撤销/改密/重置/上传等写路径）强制跳过缓存实时查库，
// 封禁即刻生效，避免紧急封禁的 30s 窗口内继续造成数据外泄。
const BANNED_CHECK_TTL = 30 * 1000;
const SENSITIVE_BANNED_CHECK_RE = /\/delete|\/revoke|\/remove|\/change-password|\/reset-password|\/upload|\/ban|\/clear/i;
app.use('/api', async (req, res, next) => {
  if (req.session?.userId) {
    const now = Date.now();
    const checkedAt = req.session.bannedCheckedAt || 0;
    const needsFreshCheck = req.method === 'DELETE' || SENSITIVE_BANNED_CHECK_RE.test(req.path);
    if (needsFreshCheck || now - checkedAt > BANNED_CHECK_TTL) {
      try {
        const pool = getPool();
        if (pool) {
          const [rows] = await pool.query('SELECT banned FROM users WHERE id=? AND deleted_at IS NULL', [req.session.userId]);
          if (rows.length === 0 || rows[0].banned) {
            req.session.destroy(() => {});
            return fail(res, 401, '账户已被禁用，请重新登录', { code: 'ACCOUNT_DISABLED' });
          }
          req.session.bannedCheckedAt = now;
        }
      } catch (e) {
        // 封禁状态校验依赖数据库；查询失败时按 fail-closed 拒绝，避免被封禁用户绕过校验。
        logger.error('server', '[session] 封禁状态校验失败:', e.message);
        return fail(res, 503, '服务暂时不可用，请稍后重试', { code: 'SERVICE_UNAVAILABLE' });
      }
    }
  }
  next();
});

// P1-48: 数据库恢复期间全局只读（holder.restoring 由 backup-core 置位）——
// 拦截非读请求，避免恢复过程中业务写入与 DROP/INSERT 交错留下半恢复状态
app.use('/api', (req, res, next) => {
  if (dbMod.holder.restoring && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return fail(res, 503, '数据库维护中（正在恢复备份），请稍后重试', { code: 'MAINTENANCE' });
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
// CSRF token 签发/校验、/api/auth/check-init 与 /api/csrf-token 路由、过期清理定时器
// 已抽至 middleware/csrf.js；中间件链位置必须保持在 auth/migration/database 等特权路由挂载之前。
const { csrfCleanupInterval } = setupCsrf(app);

// ==================== 运维面板生命周期 API ====================
// /api/ops/start、/api/ops/status + 空闲自动关闭定时器：
// 管理后台「运维面板」按钮先确保启动再打开；面板空闲超过 PANEL_IDLE_MINUTES（默认 20 分钟）
// 自动关闭进程，下次点击再拉起（见 panel_proxy.js 顶部策略说明）。
// 须挂载在 setupCsrf 之后：POST /api/ops/start 是状态变更端点，须与其余 /api POST 一样
// 接受 CSRF 校验（前端 api() 会自动携带 X-CSRF-Token）；/ops/ 代理入口则不受影响（在其之前）。
setupPanelLifecycle(app, { ROOT_DIR, requireSuperAdmin });

// ==================== 系统 VRChat 登录状态 / Cookie 会话 / Pipeline ====================
// 状态生命周期、session.json 加密读写、失效降级语义与 Pipeline 事件处理
// 已抽至 vrc_auth.js（P2-4 第二步第二批）；此处仅取各工厂与路由所需的引用。
const {
  authState, saveAuthState,
  getVRCCookie, getVRCCookieUserOnly,
  getVRCCookieExpireDays, setVRCCookieExpireDays,
  saveVRCCredentials, clearVRCCredentials,
  hasVRCCredentials, resetReloginGuard, getAutoReloginStatus
} = setupVrcAuth();

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
// P1-5 收尾（2026-09-12）：/api/live 不再挂载。前端入口早已通过
// loader.js DISABLED_FEATURES 下线，缺的是外部 RTMP/HLS 转码管线（基础设施缺口）。
// 此前"前端隐藏、后端裸露"导致未鉴权的直播列表/详情接口仍可达，现统一收到
// 全局 404 JSON 兜底。代码资产保留在 routes/_archive/live.js，复活方式见该文件头注释。

// ==================== VRChat 路由（系统级） ====================
// 系统 VRChat 登录/2FA/登出 + 健康检查
const vrcSystemRouter = require('./routes/vrc_system')(authState, saveAuthState, {
  saveVRCCredentials,
  clearVRCCredentials,
  hasVRCCredentials,
  resetReloginGuard,
  getAutoReloginStatus
});
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
    vrcCookieExpireDays: getVRCCookieExpireDays(),
    vrcCookieSetAt: authState.cookieSetAt || null,
    vrcCookieExpiresAt: (getVRCCookieExpireDays() && authState.cookieSetAt)
      ? new Date(authState.cookieSetAt + getVRCCookieExpireDays() * 86400000).toISOString()
      : null,
    // F-28: Pipeline 实时连接状态 + 最近一次服务端拒绝原因（诊断 1006 重连循环）
    pipeline: typeof global.__getVrcPipelineStatus === 'function' ? global.__getVrcPipelineStatus() : null,
    // F-29: 自动重登凭据是否已配置（前端据此渲染「保存/清除凭据」按钮状态）
    vrcAutoReloginConfigured: hasVRCCredentials(),
    // F-30: 自动重登熔断/退避状态（前端据此展示防封禁退避横幅）
    vrcAutoRelogin: getAutoReloginStatus()
  });
});

// ==================== 客户端配置 / 统计 / 搜索路由 ====================
// /api/client-config、/api/stats、/api/public/stats、/api/search 四条内联路由
// 已抽至 routes/stats.js（P2-4 第二步第二批）。
// 注意：/api/search 的路径级限流（上方 app.use('/api/search', searchLimiter)）
// 在挂载点之前生效，仍覆盖 router 内部路由。
app.use('/api', createStatsRouter());

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

// ==================== 在线更新路由（超管专属，GIT 拉取 + 自动重启） ====================
app.use('/api', require('./routes/git_update'));

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
    ok(res, { url: `/assets/group-${type}.png?v=${Date.now()}` });
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
app.use('/api/avatar', require('./routes/avatar')(authState));
// 统一收藏系统 (V8.2)：合并模型收藏馆与收藏夹（含由孤儿 model-collections 模块迁移而来的 VRCX 匿名搜索）
app.use('/api/collections', require('./routes/collections')(getVRCCookie));

// F-20 VRChat 官方收藏（与站内收藏系统并存，直接操作 VRChat 账号内的官方收藏）
app.use('/api/vrc-favorites', require('./routes/vrc_favorites')(getVRCCookie, getVRCCookieUserOnly));

// F-10 VRChat 官方实例邀请 / 好友申请（写侧严格用户本人 cookie，未绑定直接引导绑定）
app.use('/api/vrc-invites', require('./routes/vrc_invites')(getVRCCookieUserOnly));

// F-16 头像标签（私有标签，owner 为当前登录用户）
app.use('/api/avatar-tags', require('./routes/avatar_tags'));

// F-17 世界标签（与头像标签同模式，私有标签）
app.use('/api/world-tags', require('./routes/world_tags'));

app.use('/api/event-teams', require('./routes/event_teams'));

// 境途 × 境途同游 联动接口（/api/jtt，骨架阶段，契约 04-jingtu-web-integration.md）
// P3-13：专属 per-IP 限流 60/min（全局 ddosLimiter 600/min 对单接口过宽）
app.use('/api/jtt', jttLimiter, require('./routes/jtt'));

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
  fail(res, 404, '请求的资源不存在');
});

// P2-169：Swagger 文档默认不挂载——原逻辑仅靠 NODE_ENV!=='production' 判断，
// 生产环境未配置 NODE_ENV 时（phpstudy/pm2/forever 常见漏配）会把 /api-docs 无鉴权
// 暴露到公网。改为显式开关 ENABLE_SWAGGER=1 才挂载，且文档访问自身叠加
// requireSuperAdmin 鉴权（见 swagger.js），双保险杜绝无鉴权 API 文档公开。
if (process.env.ENABLE_SWAGGER === '1') {
  try {
    const { setupSwagger } = require('./swagger');
    setupSwagger(app, { requireSuperAdmin });
  } catch (e) {
    logger.warn('[server]', 'Swagger 加载失败（已跳过）：', e.message);
  }
}

// 非 API 路径的全局兜底：路由与静态资源均未命中时返回中文 404 页面（P2-4）
// 必须位于 Swagger 挂载之后，避免截胡 /api-docs
app.use((req, res) => {
  res.status(404).type('html').send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>404 - 页面不存在 | 境途同游</title>
  <style>
    body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
           font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Microsoft YaHei',sans-serif;
           background:#f5f6fa; color:#333; }
    .box { text-align:center; padding:40px 20px; }
    .code { font-size:72px; font-weight:bold; color:#667eea; margin:0; }
    .msg { font-size:18px; color:#666; margin:12px 0 24px; }
    .btn { display:inline-block; padding:10px 28px; background:#667eea; color:#fff;
           border-radius:6px; text-decoration:none; font-size:15px; }
  </style>
</head>
<body>
  <div class="box">
    <p class="code">404</p>
    <p class="msg">抱歉，您访问的页面不存在或已被移除</p>
    <a class="btn" href="/">返回首页</a>
  </div>
</body>
</html>`);
});

// ==================== 全局错误处理 ====================
app.use((err, req, res, next) => {
  // 客户端输入问题不该记成 500，也不该把「服务器内部错误」误导给用户：
  //   ① multer 文件超限（routes 里多为 10MB）→ 413；
  //   ② body-parser JSON 请求体超限（express.json limit 20mb）→ 413；
  //   ③ JSON 格式错误（SyntaxError: Unexpected token ...）→ 400；
  //   ④ CSRF 校验失败 → 403（fail 已统一 JSON，保持可解析）。
  if (err && (err.code === 'LIMIT_FILE_SIZE' || err.code === 'LIMIT_UNEXPECTED_FILE' ||
      err.type === 'entity.too.large' || err.statusCode === 413)) {
    return fail(res, 413, err.code === 'LIMIT_UNEXPECTED_FILE' ? '上传字段不符合要求' : '内容超过大小限制，请压缩后重试');
  }
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return fail(res, 400, '请求体不是合法的 JSON');
  }
  if (err && err.code === 'EBADCSRFTOKEN') {
    return fail(res, 403, '安全校验失败，请刷新页面后重试');
  }
  logger.error('[server]', '服务器错误:', err.message, err.stack);
  fail(res, 500, process.env.NODE_ENV === 'development' ? err.message : '服务器内部错误');
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

  try {
    await cache.closeCache();
    logger.info('[shutdown]', 'Redis 连接已释放');
  } catch (e) {
    logger.error('[shutdown]', 'Redis 关闭失败:', e.message);
  }

  logger.info('[shutdown]', '优雅关闭完成');
  process.exit(0);
}

// ==================== 启动入口（P2-1 可测试化） ====================
// require('./server')（supertest 集成测试）只拿到配置好的 app；
// 端口监听、进程信号接管仅在 node server.js 直跑时注册，避免测试进程被占用/被信号退出。
if (require.main === module) {
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
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.error('[rejection]', '未处理的 Promise 拒绝:', err.message);
    if (err.stack) logger.error('[rejection]', err.stack);
    // M-6：区分致命与可恢复——连接/资源类错误（连接池损坏、DB 连接丢失、事务悬挂）
    // 进程状态可能已损坏且无法自愈，退出由 PM2/容器/守护进程重启；其余业务性
    // Promise 拒绝仅记录（避免一次瞬态错误误杀仍在服务的进程）。
    const msg = err.message || '';
    if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|PROTOCOL_CONNECTION_LOST|Pool is closed|Connection is closed|ER_CON_COUNT_ERROR/i.test(msg)) {
      logger.error('[rejection]', '致命连接类错误，进程退出以触发自愈重启');
      try { if (dbMod.holder.pool) dbMod.holder.pool.end(); } catch {}
      process.exit(1);
    }
  });
}

// ==================== 初始化 ====================
async function init() {
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
        logger.info('[init]', `VRChat cookie 过期时间已载入: ${getVRCCookieExpireDays()} 天（0=永不过期）`);
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
}

module.exports = app;

// 直跑才启动初始化（置于导出之后：require 本模块时绝不触发端口监听与启动初始化）
if (require.main === module) {
  init();
}
