/**
 * 境途同游 V5.2 — Node.js Express 服务端入口
 * MySQL 5.7 + express-session + CSRF + VRChat API
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
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
const dbMod = require('./db');
const { getPool, safeError, logOper, encryptCookie, decryptCookie } = require('./utils');
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
  requestSizeLimiter, suspiciousRequestDetector
} = require('./middleware/security');

const app = express();
const server = http.createServer(app);
const PORT = parseInt(process.env.PORT, 10) || 3456;

// ==================== 常量 ====================
const defaultGroupId = 'grp_7a45b436-159c-4d9c-8303-e186ec25fc35';
if (!process.env.GROUP_ID) {
  console.warn('⚠️ WARNING: GROUP_ID 未在 .env 中设置，使用默认值！请检查是否为正确的 VRChat 群组 ID');
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
  'Event Organizer': '活动组织者', 'VIP': '贵宾', 'Supporter': '支持者',
  'Contributor': '贡献者', 'Developer': '开发者', 'Artist': '画师',
  'Musician': '音乐人', 'Streamer': '主播', 'Tester': '测试员',
  'Bot': '机器人', 'Everyone': '所有人', 'Citizen': '公民', 'Resident': '居民',
};

// ==================== 通知辅助函数 ====================
async function createNotification(userId, type, title, message, relatedId) {
  try {
    const [result] = await getPool().query(
      `INSERT INTO notifications (user_id, type, title, message, related_id) VALUES (?, ?, ?, ?, ?)`,
      [userId, type, title, message, relatedId || null]
    );
    // 通过 WebSocket 实时推送通知到客户端
    broadcastToUser(userId, {
      type: 'new_notification',
      notification: {
        id: result.insertId,
        type, title, message,
        relatedId: relatedId || null,
        isRead: false,
        createdAt: new Date().toISOString()
      }
    });
  } catch (e) { console.warn('⚠️ 发送通知失败:', e.message); }
}

// 通知所有成员（批量通知）
async function notifyAllMembers(type, title, message, relatedId) {
  try {
    const [users] = await getPool().query(`SELECT id FROM users WHERE deleted_at IS NULL AND banned = 0`);
    for (const u of users) {
      await createNotification(u.id, type, title, message, relatedId);
    }
  } catch (e) { console.warn('⚠️ 群发通知失败:', e.message); }
}

// ==================== 中间件 ====================
// 严格的 CORS 配置（生产环境应限定具体域名）
const CORS_ORIGINS = process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : true;
app.use(cors({
  origin: CORS_ORIGINS,
  credentials: true
}));

// 安全响应头（CSP + X-Frame-Options + HSTS + X-Content-Type-Options）
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  // Content-Security-Policy（宽松策略，可根据需要收紧）
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://unpkg.com https://*.tile.openstreetmap.org; " +
    "style-src 'self' 'unsafe-inline' https://unpkg.com https://fonts.googleapis.com; " +
    "img-src 'self' data: blob: https: https://*.tile.openstreetmap.org; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    "connect-src 'self' ws: wss: https://api.vrchat.cloud; " +
    "frame-ancestors 'none'; " +
    "base-uri 'self'"
  );
  next();
});
// DDoS 防护（只对 API 路由生效，避免限制静态资源）
app.use('/api', ddosLimiter);
app.use(suspiciousRequestDetector);
app.use(requestSizeLimiter);
app.use(express.json({ limit: '20mb' }));

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
app.use('/uploads', express.static(path.join(ROOT_DIR, 'uploads')));
app.use('/assets', express.static(ASSETS_DIR));
app.use(express.static(path.join(ROOT_DIR, 'public')));

// 默认头像占位图
app.get('/api/avatar/default', (req, res) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" fill="#e0e0e0" rx="32"/><text x="32" y="36" text-anchor="middle" fill="#aaa" font-size="24" font-family="sans-serif">?</text></svg>`;
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(svg);
});

// ==================== Session 配置 ====================
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

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
} catch (e) {
  console.warn('⚠️ express-mysql-session 加载失败，回退到 MemoryStore:', e.message);
  console.warn('   运行 npm install express-mysql-session 可启用 MySQL session 持久化');
}

app.use(session({
  secret: SESSION_SECRET,
  store: sessionStore || undefined,
  resave: false,
  saveUninitialized: false,
  rolling: true,               // 每次请求刷新 session 过期时间
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    sameSite: 'lax'
  }
}));

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
    } catch (e) { /* 数据库查询失败，放行当前请求 */ }
  }
  next();
});

// ==================== 速率限制 ====================
// 统一使用 ddosLimiter（定义在 security.js）

// 登录路由限流
app.use('/api/auth/login', loginBruteForceLimiter);
app.use('/api/auth/vrchat-login', loginBruteForceLimiter);
app.use('/api/login', loginBruteForceLimiter);

// ==================== CSRF 保护 ====================
const csrfTokens = new Map();
const CSRF_EXPIRY = 60 * 60 * 1000;

function generateCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

// 检查是否已有用户（用于控制初始化流程）
app.get('/api/auth/check-init', async (req, res) => {
  try {
    const [rows] = await getPool().query(`SELECT COUNT(*) AS count FROM users WHERE deleted_at IS NULL`);
    res.json({ hasUser: rows[0].count > 0 });
  } catch (e) { console.error('[server]', e); res.status(500).json({ error: safeError(e.message) }); }
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
}, 15 * 60 * 1000);

// CSRF 中间件（豁免 GET/HEAD/OPTIONS + 登录/初始化路径）
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // ⚠️ Express app.use('/api', ...) 会裁剪 req.path，所以豁免路径使用相对于 /api 的路径
  const exemptPaths = ['/login', '/vrchat-login', '/init', '/2fa',
    '/auth/login', '/auth/init', '/csrf-token',
    '/logout', '/auth/logout', '/auth/vrchat-login'];
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
  // 使用后立即删除 token（单次消费），防止 token 被重复利用
  csrfTokens.delete(token);
  next();
});

// ==================== 系统 VRChat 登录状态 ====================
let authState = { loggedIn: false, cookie: null, userId: null, displayName: null };

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
} catch (e) {
  console.warn('⚠️ 读取 VRChat session.json 失败（已损坏？），将重新登录:', e.message);
}

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
}

// 获取 VRChat cookie：优先用户绑定 -> 系统登录（自动解密用户 session 中的加密 cookie）
function getVRCCookie(req) {
  // 用户 session cookie（加密存储，需解密）
  const sessionCookie = req?.session?.vrchatCookie || req?.session?.vrcCookie;
  if (sessionCookie) return decryptCookie(sessionCookie) || sessionCookie;
  // 系统 Cookie（内存中已是明文）
  if (authState?.cookie) return authState.cookie;
  return null;
}

// ==================== 权限路由 ====================
app.use('/api/auth', require('./routes/auth'));
app.use('/api/profile', require('./routes/profile'));

// 权限组系统路由
app.use('/api/permission-groups', require('./routes/permission_groups'));

// V6.9: 动态/朋友圈系统路由（独立模块）
app.use('/api/posts', require('./routes/posts'));

// 公开成员列表（需在 /api/users 通配路由之前定义）
app.get('/api/users/list', async (req, res) => {
  try {
    const [rows] = await getPool().query(
      `SELECT id, login_id AS loginId, display_name AS displayName, role,
              avatar_type, custom_avatar_path, vrchat_avatar_url,
              location, lat, lng, location_visible AS locationVisible
       FROM users WHERE deleted_at IS NULL
       ORDER BY FIELD(role, 'super_admin', 'admin', 'member'), id ASC`
    );
    const users = rows.map(u => ({
      id: u.id, loginId: u.loginId, displayName: u.displayName,
      role: u.role,
      avatarUrl: getAvatarUrl(u),
      location: u.locationVisible ? u.location : null,
      lat: u.locationVisible ? parseFloat(u.lat) : null,
      lng: u.locationVisible ? parseFloat(u.lng) : null,
      locationVisible: !!u.locationVisible
    }));
    res.json({ users });
  } catch (e) { console.error('[server]', e); res.status(500).json({ error: safeError(e.message) }); }
});

app.use('/api/users', require('./routes/users'));

// ==================== 实时位置共享 API（高德地图定位） V6.11 ====================

// 更新自己的实时位置（GPS 经纬度）
app.post('/api/users/me/location', requireAuth, async (req, res) => {
  try {
    const { lat, lng, accuracy } = req.body;
    if (lat === undefined || lng === undefined) {
      return res.status(400).json({ error: '缺少 lat/lng 参数' });
    }
    const latNum = parseFloat(lat);
    const lngNum = parseFloat(lng);
    if (isNaN(latNum) || isNaN(lngNum) || latNum < -90 || latNum > 90 || lngNum < -180 || lngNum > 180) {
      return res.status(400).json({ error: '经纬度格式无效' });
    }
    await getPool().query(
      `UPDATE users SET lat = ?, lng = ?, location_updated_at = NOW() WHERE id = ?`,
      [latNum, lngNum, req.session.userId]
    );
    res.json({ ok: true });
  } catch (e) { console.error('[location]', e); res.status(500).json({ error: safeError(e.message) }); }
});

// 获取所有开启了位置可见的用户实时位置
app.get('/api/users/locations', requireAuth, async (req, res) => {
  try {
    const [rows] = await getPool().query(
      `SELECT id, login_id AS loginId, display_name AS displayName, role,
              avatar_type, custom_avatar_path, vrchat_avatar_url,
              location, lat, lng, location_visible AS locationVisible,
              location_updated_at AS locationUpdatedAt
       FROM users WHERE deleted_at IS NULL AND location_visible = 1 AND lat IS NOT NULL AND lng IS NOT NULL
       ORDER BY location_updated_at DESC`
    );
    const users = rows.map(u => ({
      id: u.id, loginId: u.loginId, displayName: u.displayName,
      role: u.role,
      avatarUrl: getAvatarUrl(u),
      location: u.location || null,
      lat: parseFloat(u.lat),
      lng: parseFloat(u.lng),
      locationVisible: true,
      locationUpdatedAt: u.locationUpdatedAt || null
    }));
    res.json({ users });
  } catch (e) { console.error('[locations]', e); res.status(500).json({ error: safeError(e.message) }); }
});

// ==================== 聊天私信系统 V6.12 ====================
app.use('/api/chat', require('./routes/chat'));

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
    systemVrcUser: authState.loggedIn ? { id: authState.userId, displayName: authState.displayName } : null
  });
});

// ==================== VRChat 群组路由（已提取到独立模块） ====================
const groupsRouter = require('./routes/groups')(getVRCCookie);
app.use('/api', groupsRouter);

// ==================== 公告 API ====================
app.use('/api/announcements', require('./routes/announcements'));

// ==================== 活动 API（已提取到独立模块） ====================
const eventsRouter = require('./routes/events')(getVRCCookie, notifyAllMembers);
app.use('/api/events', eventsRouter);


// ==================== 管理 / 搜索 / 改名 / 权限路由（已提取到独立模块） ====================
const adminRouter = require('./routes/admin')(GROUP_ID);
app.use('/api', adminRouter);

// ==================== 相册 API（已提取到独立模块） ====================
const albumRouter = require('./routes/album')(authState);
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
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith('image/'))
});

app.post('/api/admin/group-image', requireAdminCompat, groupImgUpload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请选择图片' });
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
    res.status(500).json({ error: e.message });
  }
});


// ==================== 通知系统 API（已提取到独立模块） ====================
const notificationsRouter = require('./routes/notifications')(authState);
app.use('/api', notificationsRouter);

// ==================== 全局错误处理 ====================
app.use((err, req, res, next) => {
  console.error('❌ 服务器错误:', err);
  res.status(500).json({ error: process.env.NODE_ENV === 'development' ? err.message : '服务器内部错误' });
});

// ==================== WebSocket 在线状态 + 通知推送 ====================
const onlineUsers = new Map();
const userWsMap = new Map(); // userId → Set<WebSocket> 支持多标签页
const WS_HEARTBEAT_INTERVAL = 30000;
const WS_TIMEOUT = 70000;

let _wss = null;
let wsHeartbeatInterval = null;

function setupWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  _wss = wss;

  // 定时清理离线用户
  wsHeartbeatInterval = setInterval(() => {
    const now = Date.now();
    for (const [userId, info] of onlineUsers.entries()) {
      if (now - info.lastPing > WS_TIMEOUT) {
        onlineUsers.delete(userId);
        userWsMap.delete(userId);
        broadcastOnlineUsers();
      }
    }
  }, WS_HEARTBEAT_INTERVAL);

  wss.on('connection', (ws) => {
    let userId = null;
    ws.isAlive = true;

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'ping') { ws.isAlive = true; ws.send(JSON.stringify({ type: 'pong' })); }
        if (msg.type === 'online') {
          userId = msg.userId;
          if (userId) {
            onlineUsers.set(userId, { displayName: msg.displayName || '', avatarUrl: msg.avatarUrl || '', lastPing: Date.now() });
            // 注册 WS 到用户连接映射
            if (!userWsMap.has(userId)) userWsMap.set(userId, new Set());
            userWsMap.get(userId).add(ws);
            broadcastOnlineUsers();
          }
        }
        if (msg.type === 'offline' && userId) {
          onlineUsers.delete(userId);
          userWsMap.delete(userId);
          // 广播位置下线（对方离开了页面）
          broadcastAllExcept(ws, {
            type: 'location:stop',
            userId: userId
          });
          broadcastOnlineUsers();
        }
        // V6.11: 实时位置共享
        if (msg.type === 'location:update' && userId) {
          // 更新在线列表中的 ping
          if (onlineUsers.has(userId)) {
            onlineUsers.get(userId).lastPing = Date.now();
          }
          broadcastAllExcept(ws, {
            type: 'location:update',
            userId: userId,
            displayName: msg.displayName || '',
            avatarUrl: msg.avatarUrl || '',
            lat: msg.lat,
            lng: msg.lng,
            accuracy: msg.accuracy || null,
            timestamp: Date.now()
          });
        }
        if (msg.type === 'location:stop' && userId) {
          broadcastAllExcept(ws, {
            type: 'location:stop',
            userId: userId
          });
        }
        // V6.12: 聊天实时推送
        if (msg.type === 'chat:send' && userId) {
          const targetUser = parseInt(msg.receiverId);
          if (targetUser && targetUser !== userId) {
            const trimmed = (msg.content || '').trim().slice(0, 2000);
            if (trimmed) {
              (async () => {
                try {
                  const pool = getPool();
                  const [result] = await pool.query(
                    `INSERT INTO messages (sender_id, receiver_id, content) VALUES (?, ?, ?)`,
                    [userId, targetUser, trimmed]
                  );
                  const messageData = {
                    type: 'chat:new',
                    message: {
                      id: result.insertId,
                      senderId: userId,
                      receiverId: targetUser,
                      content: trimmed,
                      isRead: 0,
                      createdAt: new Date().toISOString()
                    }
                  };
                  broadcastToUser(targetUser, messageData);
                  ws.send(JSON.stringify({ ...messageData, type: 'chat:sent' }));
                } catch (e) {
                  ws.send(JSON.stringify({ type: 'chat:error', error: '消息发送失败' }));
                }
              })();
            }
          }
        }
        // V6.13: 群聊消息推送
        if (msg.type === 'group:send' && userId) {
          const groupId = parseInt(msg.groupId);
          const trimmed = (msg.content || '').trim().slice(0, 2000);
          if (groupId && trimmed) {
            (async () => {
              try {
                const pool = getPool();
                const [result] = await pool.query(
                  `INSERT INTO chat_group_messages (group_id, sender_id, content, msg_type) VALUES (?, ?, ?, ?)`,
                  [groupId, userId, trimmed, 'text']
                );
                // 获取发送者信息
                const userInfo = onlineUsers.get(userId);
                const messageData = {
                  type: 'group:new',
                  groupId: groupId,
                  message: {
                    id: result.insertId,
                    senderId: userId,
                    senderName: userInfo?.displayName || msg.displayName || '',
                    senderAvatar: userInfo?.avatarUrl || '',
                    content: trimmed,
                    msgType: 'text',
                    createdAt: new Date().toISOString()
                  }
                };
                // 广播给群所有在线成员
                broadcastToGroup(groupId, messageData);
              } catch (e) {
                ws.send(JSON.stringify({ type: 'chat:error', error: '消息发送失败' }));
              }
            })();
          }
        }
        // V6.13: 群聊实时位置共享（仅群内可见，不存DB）
        if (msg.type === 'group:location:update' && userId) {
          const groupId = parseInt(msg.groupId);
          if (groupId) {
            const userInfo = onlineUsers.get(userId);
            broadcastToGroup(groupId, {
              type: 'group:location:update',
              groupId: groupId,
              userId: userId,
              displayName: userInfo?.displayName || msg.displayName || '',
              avatarUrl: userInfo?.avatarUrl || '',
              lat: msg.lat,
              lng: msg.lng,
              accuracy: msg.accuracy || null,
              timestamp: Date.now()
            });
          }
        }
        if (msg.type === 'group:location:stop' && userId) {
          const groupId = parseInt(msg.groupId);
          if (groupId) {
            broadcastToGroup(groupId, {
              type: 'group:location:stop',
              groupId: groupId,
              userId: userId
            });
          }
        }
      } catch (e) { console.warn('⚠️ WS 消息处理异常:', e.message); }
    });

    ws.on('close', () => {
      if (userId) {
        // 从 userWsMap 中移除该连接
        const conns = userWsMap.get(userId);
        if (conns) {
          conns.delete(ws);
          if (conns.size === 0) {
            // 所有标签页都已关闭，才从在线列表移除
            userWsMap.delete(userId);
            onlineUsers.delete(userId);
            broadcastOnlineUsers();
          }
          // 否则用户还有其他标签页在线，不删除
        } else {
          // 没有连接记录，直接清理
          onlineUsers.delete(userId);
          broadcastOnlineUsers();
        }
      }
    });

    ws.send(JSON.stringify({ type: 'connected', onlineCount: onlineUsers.size }));
  });
}

function broadcastOnlineUsers() {
  const list = Array.from(onlineUsers.entries()).map(([id, info]) => ({ userId: id, displayName: info.displayName, avatarUrl: info.avatarUrl }));
  const msg = JSON.stringify({ type: 'online_users', count: list.length, users: list });
  if (_wss) {
    _wss.clients.forEach(client => { if (client.readyState === 1) client.send(msg); });
  }
}

/**
 * 向指定用户推送 WebSocket 消息（支持多标签页）
 */
function broadcastToUser(userId, message) {
  const conns = userWsMap.get(userId);
  if (!conns) return;
  const str = JSON.stringify(message);
  for (const ws of conns) {
    if (ws.readyState === 1) {
      try { ws.send(str); } catch (e) { /* 客户端断连忽略 */ }
    }
  }
}

/**
 * 向群聊所有在线成员广播（带成员缓存）
 */
const _groupMemberCache = new Map(); // groupId -> { members: Set, expiresAt: number }
const GROUP_MEMBER_CACHE_TTL = 60000; // 1 分钟缓存

function broadcastToGroup(groupId, message) {
  if (!_wss) return;
  const str = JSON.stringify(message);
  (async () => {
    try {
      // 查询群成员，优先使用缓存
      let memberSet;
      const cached = _groupMemberCache.get(groupId);
      if (cached && cached.expiresAt > Date.now()) {
        memberSet = cached.members;
      } else {
        const pool = getPool();
        const [members] = await pool.query(
          `SELECT user_id FROM chat_group_members WHERE group_id = ?`, [groupId]);
        memberSet = new Set(members.map(m => m.user_id));
        _groupMemberCache.set(groupId, { members: memberSet, expiresAt: Date.now() + GROUP_MEMBER_CACHE_TTL });
      }
      // 只发给在线的群成员
      for (const [uid, conns] of userWsMap) {
        if (memberSet.has(uid)) {
          for (const ws of conns) {
            if (ws.readyState === 1) {
              try { ws.send(str); } catch (e) { /* 忽略 */ }
            }
          }
        }
      }
    } catch (e) { /* 静默失败，不中断 WS */ }
  })();
}

/**
 * 向除指定 WS 外的所有客户端广播
 */
function broadcastAllExcept(excludeWs, message) {
  if (!_wss) return;
  const str = JSON.stringify(message);
  _wss.clients.forEach(client => {
    if (client !== excludeWs && client.readyState === 1) {
      try { client.send(str); } catch (e) { /* 忽略 */ }
    }
  });
}

setupWebSocket(server);

// ==================== 优雅关闭（防止句柄泄漏） ====================
async function gracefulShutdown(signal) {
  console.log(`\n⚠️ 收到 ${signal} 信号，开始优雅关闭...`);

  // 1. 停止接受新连接
  server.close(() => {
    console.log('  ✓ HTTP 服务器已关闭');
  });

  // 2. 清除定时器
  clearInterval(csrfCleanupInterval);
  console.log('  ✓ CSRF 清理定时器已清除');
  if (wsHeartbeatInterval) {
    clearInterval(wsHeartbeatInterval);
    console.log('  ✓ WebSocket 心跳定时器已清除');
  }

  // 3. 关闭 WebSocket 服务器
  if (_wss) {
    _wss.clients.forEach(client => client.close(1001, 'Server shutting down'));
    _wss.close();
    console.log('  ✓ WebSocket 服务器已关闭');
  }

  // 4. 关闭 MySQL 连接池
  const pool = dbMod.holder.pool;
  if (pool) {
    try {
      await pool.end();
      console.log('  ✓ MySQL 连接池已关闭');
    } catch (e) {
      console.error('  ✗ MySQL 关闭失败:', e.message);
    }
  }

  // 5. 取消定时任务
  if (typeof startSchedule.gracefulShutdown === 'function') {
    startSchedule.gracefulShutdown();
    console.log('  ✓ 定时任务已取消');
  }

  console.log('✅ 优雅关闭完成');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));
// 未捕获异常 — 记录详细堆栈后退出（不阻塞不清理，因为状态可能已损坏）
process.on('uncaughtException', (err) => {
  console.error('❌ 未捕获异常:', err.message);
  console.error(err.stack);
  // 尝试清理关键资源
  try { if (dbMod.holder.pool) dbMod.holder.pool.end(); } catch {}
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('❌ 未处理的 Promise 拒绝:', reason instanceof Error ? reason.message : reason);
  if (reason instanceof Error) console.error(reason.stack);
});

// ==================== 初始化 ====================
(async function init() {
  try {
    const initDatabase = require('./db_init');
    await initDatabase();
  } catch (e) { console.error('❌ 数据库初始化出错:', e.message); }

  startSchedule();

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 境途同游 V5.2 已启动: http://localhost:${PORT}`);
    console.log(`📡 局域网访问: http://<本机IP>:${PORT}`);
  });
})();
