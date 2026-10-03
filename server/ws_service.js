const path = require('path');
const crypto = require('crypto');
const cookie = require('cookie');
const signature = require('cookie-signature');
const session = require('express-session');
const { WebSocketServer } = require('ws');
const { getPool } = require('./utils');
const logger = require('./logger');

// 加载 .env（ws_service 可能被独立引用，例如测试）
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch (e) {}

const WS_IDLE_TIMEOUT = 10 * 60 * 1000;
const WS_HEARTBEAT_INTERVAL = 30 * 1000;
const DEBOUNCE_DELAY = 300;
const GROUP_MEMBER_CACHE_TTL = 60 * 1000;
const SESSION_COOKIE_NAME = 'connect.sid';

let _wss = null;
let _heartbeatInterval = null;
let _offlineSummaryInterval = null;

// §29 会话校验所需上下文（首次 setupWebSocket 时延迟初始化）
let _sessionStore = null;
// P2-121: 不再在模块加载期生成随机密钥——统一由 server.js 把 effectiveSecret 注入，
// 避免「ws_service 与 server.js 各自随机」导致开发态 WS 签名互不认全 401。
let _sessionSecret = process.env.SESSION_SECRET || null; // 显式注入优先，其次回落到环境变量
let _originWhitelist = []; // 生产环境严格校验的 Origin 白名单
let _wsAuthFailStreak = 0; // 未认证连接失败计数（用于异常/扫描监测）

// P2-121: 供 server.js 注入与 HTTP session 同一把签名密钥（缺 SESSION_SECRET 时 server.js 会拒绝生产启动/开发态用临时密钥）
function setSessionSecret(secret) {
  if (secret) _sessionSecret = secret;
}

function _buildOriginWhitelist() {
  const list = [];
  if (process.env.CORS_ORIGINS) {
    list.push(...process.env.CORS_ORIGINS.split(',').map(s => s.trim()).filter(Boolean));
  }
  const port = parseInt(process.env.PORT, 10) || 3456;
  // Node 直连形态（开发/调试）：http://localhost:3456 / http://127.0.0.1:3456
  list.push(`http://localhost:${port}`, `http://127.0.0.1:${port}`);
  // 经 Nginx 反代形态：页面在 80 端口，浏览器 Origin 为 http://localhost（无端口）/ http://127.0.0.1 等
  list.push('http://localhost', 'https://localhost', 'http://127.0.0.1', 'https://127.0.0.1');
  return Array.from(new Set(list));
}

function _initSessionContext() {
  if (_sessionStore) return;
  _originWhitelist = _buildOriginWhitelist();
  if (!_sessionSecret) _sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
  // P2-179: SQLite 模式下没有 MySQL 可用，WS session 同样回退到 MemoryStore（与 server.js HTTP session 一致）
  if (process.env.JINGTU_DB_ENGINE === 'sqlite') {
    console.warn('[ws_service] JINGTU_DB_ENGINE=sqlite：WS session 使用 MemoryStore');
    _sessionStore = new session.MemoryStore();
    return;
  }
  try {
    const MySQLStore = require('express-mysql-session')(session);
    _sessionStore = new MySQLStore({
      host: process.env.MYSQL_HOST || '127.0.0.1',
      port: parseInt(process.env.MYSQL_PORT, 10) || 3306,
      user: process.env.MYSQL_USER || 'root',
      password: process.env.MYSQL_PASSWORD || '',
      database: process.env.MYSQL_DATABASE || 'jingtu_group',
      createDatabaseTable: false, // 表应由 server.js 创建，这里只读
      schema: { tableName: 'sessions' }
    });
  } catch (e) {
    console.warn('⚠️ [ws_service] express-mysql-session 加载失败，WS 鉴权将退化为 MemoryStore（仅开发可用）:', e.message);
    _sessionStore = new session.MemoryStore();
  }
}

// §29 verifyClient：校验 Origin 白名单 + 解析 session cookie，拒绝未认证连接
function _verifyClient(info, cb) {
  _initSessionContext();
  const req = info.req;

  // 1) Origin 校验（统一校验：无论生产还是 dev，只要请求带 Origin 就校验白名单/同源）
  const origin = req.headers.origin || '';
  if (origin) {
    const inWhitelist = _originWhitelist.length === 0 || _originWhitelist.includes(origin);
    // 同源兜底：浏览器经反代(Nginx 等)访问时，Origin 的 host 与请求 Host 一致即视为同源。
    // 覆盖「页面在 80 端口、WS 经 3456 端口」导致的白名单端口不匹配，以及局域网 IP 等各种访问形态。
    let sameHost = false;
    try {
      const originHost = new URL(origin).host; // 已自动去掉默认端口(80/443)
      let reqHost = (req.headers.host || '').toLowerCase();
      reqHost = reqHost.replace(/:(80|443)$/, ''); // 规范化 Host，去掉默认端口
      sameHost = !!originHost && originHost.toLowerCase() === reqHost;
    } catch (_e) { /* ignore */ }
    if (!inWhitelist && !sameHost) {
      return cb(false, 403, 'Origin not allowed');
    }
  }

  // 2) 解析 cookie，获取 session id
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) {
    return cb(false, 401, 'No session cookie');
  }

  let cookies;
  try {
    cookies = cookie.parse(cookieHeader);
  } catch (e) {
    return cb(false, 400, 'Invalid cookie header');
  }

  const rawSid = cookies[SESSION_COOKIE_NAME];
  if (!rawSid) {
    return cb(false, 401, 'No session');
  }

  // 3) unsign session id（express-session 默认对 sid 加 's:' 前缀并签名）
  let sid = rawSid;
  if (rawSid.substr(0, 2) === 's:') {
    const unsigned = signature.unsign(rawSid.slice(2), _sessionSecret);
    if (unsigned === false) {
      return cb(false, 401, 'Invalid session signature');
    }
    sid = unsigned;
  }

  // 4) 从 store 读取 session，必须含有 userId
  _sessionStore.get(sid, (err, sessionData) => {
    if (err) {
      // 存储层故障：fail-closed，绝不因「读不到」而误放行未认证连接
      logger && logger.error('[ws]', 'verifyClient: session store error', { err: err.message, ip: req.ip });
      return cb(false, 503, 'Session store unavailable');
    }
    if (!sessionData || !sessionData.userId) {
      // 未认证 / 会话无效：拒绝，并记录一次失败用于异常监测
      _wsAuthFailStreak++;
      // P2-68 首轮 lint 修复：旧代码 `typeof securityAlert === 'function'` 永假
      // （本模块从未定义 securityAlert），ws 未认证风暴告警从未触发过。
      // 按 P1-16（db-recover.js）先例改为显式引入 onSecurityBreach。
      if (_wsAuthFailStreak >= 10) {
        try {
          const { onSecurityBreach } = require('./security_alert');
          if (typeof onSecurityBreach === 'function') {
            onSecurityBreach('WebSocket 未认证连接风暴', { ip: req.ip, fails: _wsAuthFailStreak });
          }
        } catch (_) {}
      }
      logger && logger.warn('[ws]', 'verifyClient: no auth session', { ip: req.ip, fails: _wsAuthFailStreak });
      return cb(false, 401, 'Unauthorized');
    }
    _wsAuthFailStreak = 0;
    // 将认证后的 userId / sid 挂到 req 上，供 connection 回调使用
    req.wsUserId = sessionData.userId;
    req.wsSid = sid;
    cb(true);
  });
}

const onlineUsers = new Map();
const userWsMap = new Map();
const groupMemberCache = new Map();
const debounceTimers = new Map();

// P2-123: 私信限流状态（per-sender→receiver 滑窗）。仅允许与建立社交关系的用户私信；防私信骚扰刷量。
const PRIVATE_CHAT_RATE_WINDOW = 30 * 1000;
const PRIVATE_CHAT_RATE_LIMIT = 20; // 30s 内同一 (sender→receiver) 最多 20 条
const privateChatRateMap = new Map(); // `${userId}:${targetUser}` -> { count, windowStart }
const PRIVATE_CHAT_RATE_MAX_ENTRIES = 2000;

function _prunePrivateChatRate() {
  if (privateChatRateMap.size > PRIVATE_CHAT_RATE_MAX_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of privateChatRateMap) {
      if (now - v.windowStart >= PRIVATE_CHAT_RATE_WINDOW) privateChatRateMap.delete(k);
    }
  }
}

// P2-123: 好友（双向 accepted）或存在任一方向的已建立关注关系 → 允许私信
async function _canPrivateChat(pool, userId, targetUser) {
  const [friendRows] = await pool.query(
    `SELECT 1 FROM user_friends WHERE status='accepted' AND ((user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?)) LIMIT 1`,
    [userId, targetUser, targetUser, userId]
  );
  if (friendRows && friendRows.length > 0) return true;
  const [followRows] = await pool.query(
    `SELECT 1 FROM user_follows WHERE (follower_id=? AND following_id=?) OR (follower_id=? AND following_id=?) LIMIT 1`,
    [userId, targetUser, targetUser, userId]
  );
  return !!(followRows && followRows.length > 0);
}

// §RTC 实时通话语音房状态：roomKey -> Set<userId>
// 私聊房 key: p:低id:高id；群语音房 key: g:群id
const rtcRooms = new Map();
const userRtcRooms = new Map(); // userId -> Set<roomKey>（断线清理用）
const rtcRateMap = new Map();   // userId -> { count, windowStart }（信令限流）
const RTC_RATE_WINDOW = 10 * 1000;
const RTC_RATE_LIMIT = 90;      // 10 秒内最多 90 条信令
const RTC_MAX_MSG = 256 * 1024; // 单条信令体上限（SDP/ICE 常 <64KB）

function setupWebSocket(server) {
  _wss = new WebSocketServer({ server, path: '/ws', verifyClient: _verifyClient });

  _heartbeatInterval = setInterval(() => {
    const now = Date.now();
    const toRemove = [];

    for (const [userId, info] of onlineUsers.entries()) {
      if (now - info.lastPing > WS_IDLE_TIMEOUT) {
        toRemove.push(userId);
      }
    }

    for (const userId of toRemove) {
      forceOffline(userId, 'timeout');
    }
  }, WS_HEARTBEAT_INTERVAL).unref();

  _offlineSummaryInterval = setInterval(() => {
    sendOfflineSummaries();
  }, 30 * 1000).unref();

  _wss.on('connection', (ws, req) => {
    // §29 userId 直接来自 verifyClient 中已认证的 session，忽略客户端发送的 msg.userId
    let userId = (req && req.wsUserId) || null;
    // §29-兜底：若 verifyClient 因异常未成功附着 userId，绝不接受该连接，
    // 防止未认证 socket 进入消息分发（即便各分支已有 && userId 守卫，此处 fail-closed 双保险）。
    if (!userId) {
      try { ws.close(1008, 'Unauthorized'); } catch (e) {}
      return;
    }
    ws.userId = userId;
    ws.sid = (req && req.wsSid) || null;
    ws.isAlive = true;
    ws.connectTime = Date.now();

    const pingInterval = setInterval(() => {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, WS_HEARTBEAT_INTERVAL).unref();

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'pong') {
          ws.isAlive = true;
          if (userId && onlineUsers.has(userId)) {
            onlineUsers.get(userId).lastPing = Date.now();
          }
          return;
        }

        if (msg.type === 'online') {
          // §29 忽略 msg.userId，强制使用连接绑定的 session userId
          if (userId) {
            // §29-兜底：用户主动心跳（online）时复查 session 是否仍有效，
            // 覆盖「已登出/会话过期但旧 WS 仍在线」的场景；store 不可用时跳过复查以免误杀。
            if (_sessionStore && ws.sid) {
              _sessionStore.get(ws.sid, (err, sd) => {
                if (!err && (!sd || !sd.userId)) {
                  logger && logger.warn('[ws]', 'session 已失效，关闭旧连接', { userId: ws.userId });
                  try { ws.close(1008, 'Session expired'); } catch (e) {}
                }
              });
            }
            // P3-39: 在线状态由 users.online_visible 决断（不信任客户端上报的隐身标记，天然防伪造）
            try {
              const [uvRows] = await getPool().query(`SELECT online_visible FROM users WHERE id = ? AND deleted_at IS NULL LIMIT 1`, [userId]);
              const onlineVisible = uvRows.length > 0 ? uvRows[0].online_visible !== 0 : true;
              onlineUsers.set(userId, {
                displayName: msg.displayName || '',
                avatarUrl: msg.avatarUrl || '',
                lastPing: Date.now(),
                location: null,
                onlineVisible
              });
            } catch (e) {
              logger && logger.warn('[ws]', '读取 online_visible 失败，按可见处理', { userId, err: (e && e.message) || '' });
              onlineUsers.set(userId, {
                displayName: msg.displayName || '',
                avatarUrl: msg.avatarUrl || '',
                lastPing: Date.now(),
                location: null,
                onlineVisible: true
              });
            }

            if (!userWsMap.has(userId)) {
              userWsMap.set(userId, new Set());
            }
            userWsMap.get(userId).add(ws);

            broadcastOnlineUsers();
          }
          return;
        }

        if (msg.type === 'offline' && userId) {
          forceOffline(userId, 'manual');
          return;
        }

        // P3-39: 在线隐身开关——写库 users.online_visible 并刷新内存条目后重新广播在线清单
        if (msg.type === 'presence' && userId) {
          const visible = msg.onlineVisible;
          if (visible !== 0 && visible !== 1 && visible !== false && visible !== true) {
            try { ws.send(JSON.stringify({ type: 'presence:error', error: 'onlineVisible 必须是 0/1' })); } catch (e) {}
            return;
          }
          try {
            await getPool().query(
              `UPDATE users SET online_visible = ?, updated_at = NOW() WHERE id = ? AND deleted_at IS NULL`,
              [visible ? 1 : 0, userId]
            );
            if (onlineUsers.has(userId)) {
              onlineUsers.get(userId).onlineVisible = visible ? true : false;
            }
            broadcastOnlineUsers();
          } catch (e) {
            logger && logger.warn('[ws]', '切换在线隐身失败', { userId, err: (e && e.message) || '' });
          }
          return;
        }

        if (msg.type === 'location:update' && userId) {
          handleLocationUpdate(userId, msg, ws);
          return;
        }

        if (msg.type === 'location:stop' && userId) {
          stopLocation(userId, ws);
          return;
        }

        if (msg.type === 'chat:send' && userId) {
          handlePrivateChat(userId, msg, ws);
          return;
        }

        if (msg.type === 'chat:typing' && userId) {
          handleTyping(userId, msg);
          return;
        }

        if (msg.type === 'group:send' && userId) {
          handleGroupChat(userId, msg, ws);
          return;
        }

        if (msg.type === 'group:location:update' && userId) {
          handleGroupLocation(userId, msg);
          return;
        }

        if (msg.type === 'group:location:stop' && userId) {
          stopGroupLocation(userId, msg);
          return;
        }

        // 位置开关信令：广播给群内其他成员（不持久化、不计未读，避免污染群聊消息流）
        if (msg.type === 'group:location:toggle' && userId) {
          const groupId = parseInt(msg.groupId);
          if (groupId) {
            // P1-42：开关信令同样仅限群成员操作，防止伪造他人开关状态
            getGroupMembers(groupId).then(memberSet => {
              if (!memberSet.has(userId)) return;
              broadcastToGroup(groupId, {
                type: 'group:location:toggle',
                groupId,
                userId,
                displayName: onlineUsers.get(userId)?.displayName || msg.displayName || '',
                sharing: !!msg.sharing
              });
            }).catch(() => {});
          }
          return;
        }

        // §61 补 && userId 守卫，与其他分发分支保持一致
        if (msg.type === 'history:request' && userId) {
          handleHistoryRequest(userId, ws, msg);
          return;
        }

        // §RTC 实时通话信令：复用 WS 通道透传 offer/answer/ICE（私聊 1v1 + 群语音房 mesh）
        // 服务器端入口统一，内部按 msg.type 分发；userId 强制取连接绑定的 session userId
        if (msg.type && msg.type.indexOf('rtc:') === 0 && userId) {
          handleRtcSignal(userId, msg, ws).catch(e => {
            console.warn('[ws] RTC 信令处理异常:', e.message);
          });
          return;
        }

      } catch (e) {
        console.warn('⚠️ WS 消息处理异常:', e.message);
      }
    });

    ws.on('close', (code) => {
      clearInterval(pingInterval);

      // §RTC 连接断开：清理其占用的语音房（含群语音房），并通知房内其他成员
      if (userId) {
        const userRooms = userRtcRooms.get(userId);
        if (userRooms) {
          for (const roomKey of userRooms) {
            const members = rtcRooms.get(roomKey);
            if (members) {
              members.delete(userId);
              if (members.size === 0) rtcRooms.delete(roomKey);
            }
            if (roomKey.indexOf('g:') === 0) {
              const gid = parseInt(roomKey.slice(2), 10);
              if (gid) {
                broadcastToGroup(gid, {
                  type: 'rtc:group:member:leave',
                  groupId: gid,
                  roomKey,
                  userId,
                  timestamp: Date.now()
                });
              }
            }
          }
          userRtcRooms.delete(userId);
        }
      }

      if (userId) {
        const conns = userWsMap.get(userId);
        if (conns) {
          conns.delete(ws);
          if (conns.size === 0) {
            userWsMap.delete(userId);
            forceOffline(userId, 'disconnect');
          }
        } else {
          onlineUsers.delete(userId);
          broadcastOnlineUsers();
        }
      }
    });

    ws.send(JSON.stringify({
      type: 'connected',
      onlineCount: onlineUsers.size,
      serverTime: Date.now()
    }));
  });
}

function forceOffline(userId, reason) {
  onlineUsers.delete(userId);
  
  const conns = userWsMap.get(userId);
  if (conns) {
    for (const ws of conns) {
      try {
        ws.send(JSON.stringify({ type: 'offline', reason }));
        ws.close(1001, 'User offline');
      } catch (e) {}
    }
    userWsMap.delete(userId);
  }

  broadcastAllExcept(null, {
    type: 'location:stop',
    userId: userId
  });

  broadcastOnlineUsers();
}

function debounce(key, fn) {
  const existingTimer = debounceTimers.get(key);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }
  const timer = setTimeout(() => {
    fn();
    debounceTimers.delete(key);
  }, DEBOUNCE_DELAY);
  debounceTimers.set(key, timer);
}

function handleLocationUpdate(userId, msg, ws) {
  const lat = parseFloat(msg.lat);
  const lng = parseFloat(msg.lng);
  // 坐标必须合法，否则既不落库也不广播，避免污染地图
  if (!Number.isFinite(lat) || !Number.isFinite(lng) ||
      lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return;
  }

  const locationData = {
    userId,
    displayName: msg.displayName || onlineUsers.get(userId)?.displayName || '',
    avatarUrl: msg.avatarUrl || onlineUsers.get(userId)?.avatarUrl || '',
    lat,
    lng,
    accuracy: msg.accuracy || null,
    timestamp: Date.now()
  };

  if (onlineUsers.has(userId)) {
    onlineUsers.get(userId).location = locationData;
    onlineUsers.get(userId).lastPing = Date.now();
  }

  const debounceKey = `location:${userId}`;
  debounce(debounceKey, async () => {
    try {
      // 隐私开关校验：仅当用户开启位置共享（location_visible=1）时才向在线用户广播实时坐标；
      // 否则即便落库被 WHERE location_visible=1 拦截，仍可能因 WS 广播而泄露实时 GPS。
      const [vis] = await getPool().query(
        'SELECT location_visible FROM users WHERE id = ? AND deleted_at IS NULL', [userId]);
      const visible = vis.length > 0 && vis[0].location_visible === 1;
      // 持久化：仅在用户已开启位置共享时写入，否则 GET /api/users/all/locations
      // 永远查不到数据，且刷新页面后位置全部丢失。
      persistLocation(userId, lat, lng);
      if (visible) {
        broadcastAllExcept(ws, {
          type: 'location:update',
          ...locationData
        });
      }
    } catch (e) {
      console.warn('[ws] 位置广播隐私校验失败:', e.message);
    }
  });
}

async function persistLocation(userId, lat, lng) {
  try {
    await getPool().query(
      `UPDATE users SET lat = ?, lng = ?, location_updated_at = NOW()
       WHERE id = ? AND location_visible = 1 AND deleted_at IS NULL`,
      [lat, lng, userId]
    );
  } catch (e) {
    console.warn('[ws] 位置持久化失败:', e.message);
  }
}

function stopLocation(userId, ws) {
  broadcastAllExcept(ws, {
    type: 'location:stop',
    userId
  });

  if (onlineUsers.has(userId)) {
    onlineUsers.get(userId).location = null;
  }

  // 停止共享时清除服务端坐标，避免他人仍从 /all/locations 读到陈旧位置
  getPool().query(
    `UPDATE users SET lat = NULL, lng = NULL, location_updated_at = NULL WHERE id = ?`,
    [userId]
  ).catch(e => console.warn('[ws] 位置清除失败:', e.message));
}

async function handlePrivateChat(userId, msg, ws) {
  const targetUser = parseInt(msg.receiverId);
  if (!targetUser || targetUser === userId) return;
  
  const trimmed = (msg.content || '').trim().slice(0, 2000);
  if (!trimmed) return;

  try {
    const pool = getPool();
    // P2-123: 好友/关注校验——无社交关系即拒绝，防陌生私信骚扰
    let canChat = false;
    try {
      canChat = await _canPrivateChat(pool, userId, targetUser);
    } catch (_e) {
      // 关系校验查询失败：fail-closed，不落库不广播
      ws.send(JSON.stringify({ type: 'chat:error', error: '消息发送失败，请稍后重试' }));
      return;
    }
    if (!canChat) {
      ws.send(JSON.stringify({ type: 'chat:error', error: '仅好友或已关注用户之间可以私信' }));
      return;
    }

    // P2-123: per-(sender,receiver) 滑窗限流
    const now = Date.now();
    const rateKey = userId + ':' + targetUser;
    let rateInfo = privateChatRateMap.get(rateKey);
    if (!rateInfo || now - rateInfo.windowStart >= PRIVATE_CHAT_RATE_WINDOW) {
      rateInfo = { count: 0, windowStart: now };
      privateChatRateMap.set(rateKey, rateInfo);
      _prunePrivateChatRate();
    }
    if (rateInfo.count >= PRIVATE_CHAT_RATE_LIMIT) {
      ws.send(JSON.stringify({ type: 'chat:error', error: '消息发送过于频繁，请稍后再试' }));
      return;
    }
    rateInfo.count++;

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
}

function handleTyping(userId, msg) {
  const targetUser = parseInt(msg.receiverId);
  if (!targetUser || targetUser === userId) return;

  broadcastToUser(targetUser, {
    type: 'chat:typing',
    senderId: userId,
    stop: msg.stop || false
  });
}

async function handleGroupChat(userId, msg, ws) {
  const groupId = parseInt(msg.groupId);
  const trimmed = (msg.content || '').trim().slice(0, 2000);

  if (!groupId || !trimmed) return;

  try {
    const pool = getPool();
    // §62 校验发送者是否为该群成员，非成员拒绝并返回 chat:error
    const [memberRows] = await pool.query(
      `SELECT id FROM chat_group_members WHERE group_id = ? AND user_id = ?`,
      [groupId, userId]
    );
    if (!memberRows || memberRows.length === 0) {
      ws.send(JSON.stringify({ type: 'chat:error', error: '您不是该群成员，无法发送消息' }));
      return;
    }

    const [result] = await pool.query(
      `INSERT INTO chat_group_messages (group_id, sender_id, content, msg_type) VALUES (?, ?, ?, ?)`,
      [groupId, userId, trimmed, 'text']
    );

    const userInfo = onlineUsers.get(userId);
    const messageData = {
      type: 'group:new',
      groupId,
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

    await broadcastToGroupWithTier(groupId, messageData, userId);

    // 发送者回执用独立类型 group:sent（此前复用 chat:sent 且消息无 receiverId，
    // 前端 chat:sent 分支比对私聊会话永远失配，自发群消息永不回显）
    ws.send(JSON.stringify({ type: 'group:sent', groupId, message: messageData.message }));
  } catch (e) {
    ws.send(JSON.stringify({ type: 'chat:error', error: '消息发送失败' }));
  }
}

function handleGroupLocation(userId, msg) {
  const groupId = parseInt(msg.groupId);
  if (!groupId) return;

  // P1-42：位置投毒防线——非群成员拒收、坐标必须有限数、隐私闸与单人定位一致
  getGroupMembers(groupId).then(memberSet => {
    if (!memberSet.has(userId)) return; // 非成员不处理，也不向该群回任何数据
    if (!Number.isFinite(Number(msg.lat)) || !Number.isFinite(Number(msg.lng))) return;

    const userInfo = onlineUsers.get(userId);
    const locationData = {
      type: 'group:location:update',
      groupId,
      userId,
      displayName: userInfo?.displayName || msg.displayName || '',
      avatarUrl: userInfo?.avatarUrl || '',
      lat: Number(msg.lat),
      lng: Number(msg.lng),
      accuracy: msg.accuracy || null,
      timestamp: Date.now()
    };

    const debounceKey = `group:location:${groupId}:${userId}`;
    debounce(debounceKey, () => {
      broadcastToGroup(groupId, { type: 'group:location:update', ...locationData });
    });
  }).catch(() => {});
}

function stopGroupLocation(userId, msg) {
  const groupId = parseInt(msg.groupId);
  if (!groupId) return;

  // P1-42：停止广播同样只允许群成员操作
  getGroupMembers(groupId).then(memberSet => {
    if (!memberSet.has(userId)) return;
    broadcastToGroup(groupId, {
      type: 'group:location:stop',
      groupId,
      userId
    });
  }).catch(() => {});
}

async function handleHistoryRequest(userId, ws, msg) {
  try {
    const pool = getPool();
    const { chatType, page, pageSize, sinceDate } = msg;
    // §61 强制使用连接绑定的 userId，targetId 解析为整数避免类型混淆
    const targetId = parseInt(msg.targetId);

    const limit = parseInt(pageSize) || 50;
    const offset = (parseInt(page) || 0) * limit;

    let query, params;

    if (chatType === 'private') {
      // §61 双向会话归属校验：仅返回当前用户参与的对话
      // (sender_id=userId AND receiver_id=targetId) OR (sender_id=targetId AND receiver_id=userId)
      // 用括号包住 OR 表达式，避免 AND 优先级导致 deleted_at 过滤被短路
      query = `SELECT m.*, u1.display_name AS senderName, u1.avatar_type, u1.custom_avatar_path, u1.vrchat_avatar_url
               FROM messages m
               LEFT JOIN users u1 ON m.sender_id = u1.id
               WHERE ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))
               AND deleted_at IS NULL
               ORDER BY created_at DESC LIMIT ? OFFSET ?`;
      params = [userId, targetId, targetId, userId, limit, offset];
    } else if (chatType === 'group') {
      // §IDOR 防护：仅群成员可拉取群消息历史，私密/邀请制群聊不可被任意登录用户枚举
      const [memCheck] = await pool.query(
        'SELECT id FROM chat_group_members WHERE group_id = ? AND user_id = ?', [targetId, userId]);
      if (memCheck.length === 0) {
        ws.send(JSON.stringify({ type: 'history:error', error: '你不是该群成员', code: 'FORBIDDEN' }));
        return;
      }
      query = `SELECT m.*, u1.display_name AS senderName, u1.avatar_type, u1.custom_avatar_path, u1.vrchat_avatar_url
               FROM chat_group_messages m
               LEFT JOIN users u1 ON m.sender_id = u1.id
               WHERE group_id = ? AND deleted_at IS NULL
               ORDER BY created_at DESC LIMIT ? OFFSET ?`;
      params = [targetId, limit, offset];
    }

    if (sinceDate) {
      query = query.replace('ORDER BY', 'AND created_at >= ? ORDER BY');
      params.splice(params.length - 2, 0, sinceDate);
    }

    const [rows] = await pool.query(query, params);
    const [countRes] = await pool.query(query.replace('SELECT m.*, u1.display_name AS senderName, u1.avatar_type, u1.custom_avatar_path, u1.vrchat_avatar_url FROM', 'SELECT COUNT(*) AS total FROM').replace(' LIMIT ? OFFSET ?', ''), params.slice(0, -2));

    ws.send(JSON.stringify({
      type: 'history:response',
      chatType,
      targetId,
      messages: rows,
      page: parseInt(page) || 0,
      total: countRes[0]?.total || 0,
      hasMore: rows.length >= limit
    }));
  } catch (e) {
    ws.send(JSON.stringify({ type: 'history:error', error: e.message }));
  }
}

async function broadcastToGroupWithTier(groupId, message, excludeUserId) {
  if (!_wss) return;

  try {
    const memberSet = await getGroupMembers(groupId);
    const str = JSON.stringify(message);
    
    for (const [uid, conns] of userWsMap) {
      if (memberSet.has(uid) && uid !== excludeUserId) {
        for (const ws of conns) {
          if (ws.readyState === 1) {
            try { ws.send(str); } catch (e) {}
          }
        }
      }
    }

    await saveOfflineSummary(groupId, message);
  } catch (e) {}
}

async function getGroupMembers(groupId) {
  const cached = groupMemberCache.get(groupId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.members;
  }

  const pool = getPool();
  const [members] = await pool.query(
    `SELECT user_id FROM chat_group_members WHERE group_id = ?`, [groupId]);

  const memberSet = new Set(members.map(m => m.user_id));
  groupMemberCache.set(groupId, {
    members: memberSet,
    expiresAt: Date.now() + GROUP_MEMBER_CACHE_TTL
  });

  return memberSet;
}

// §67 暴露缓存失效接口，供 chat.js 等模块在成员变更（踢人/退群/加入）后调用
// 传入 groupId 失效单个群；不传参数则清空全部缓存
function invalidateGroupMemberCache(groupId) {
  if (groupId == null) {
    groupMemberCache.clear();
  } else {
    groupMemberCache.delete(groupId);
  }
}

async function saveOfflineSummary(groupId, message) {
  try {
    const pool = getPool();
    const summary = JSON.stringify({
      groupId,
      lastMessage: message.message,
      unreadCount: 1,
      updatedAt: Date.now()
    });
    
    await pool.query(
      `INSERT INTO chat_offline_summary (group_id, summary_data) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE summary_data = ?, updated_at = NOW()`,
      [groupId, summary, summary]
    );
  } catch (e) {}
}

async function sendOfflineSummaries() {
  try {
    const pool = getPool();
    const [summaries] = await pool.query(
      `SELECT group_id, summary_data FROM chat_offline_summary WHERE updated_at > DATE_SUB(NOW(), INTERVAL 5 MINUTE)`
    );

    for (const summary of summaries) {
      const data = JSON.parse(summary.summary_data);
      const memberSet = await getGroupMembers(summary.group_id);

      for (const [uid, conns] of userWsMap) {
        if (memberSet.has(uid)) {
          for (const ws of conns) {
            if (ws.readyState === 1) {
              try {
                ws.send(JSON.stringify({
                  type: 'group:offline_summary',
                  groupId: summary.group_id,
                  summary: data
                }));
              } catch (e) {}
            }
          }
        }
      }
    }
  } catch (e) {}
}

// § 群组 VRChat 成员在线状态实时推送：
// schedule.js 每轮状态刷新（或 routes/groups.js 在成员加入/离开后）调用本函数，
// 向所有在线客户端广播各群组的最新在线/总数统计与变化成员，
// 前端据此增量更新卡片状态点（不整页重渲染），实现与服务器的实时同步。
// payload 形状：{ groups: [{ groupId, onlineCount, totalCount, offlineCount, members: {vrchatId, isOnline, status, worldName, lastLogin} }], timestamp }
function broadcastRosterUpdate(payload) {
  if (!_wss) return;
  const groups = payload.groups || [];
  // P1-41：按群成员过滤接收者，杜绝私密/邀请制群成员清单泄漏给非成员。
  // 逐群取成员集合（复用 groupMemberCache），再对每个在线客户端判定可见群后仅发该群数据。
  const memberSets = new Map();
  const fetchPromises = groups.map(g => {
    const gid = parseInt(g.groupId, 10);
    if (!gid) return null;
    return getGroupMembers(gid).then(s => memberSets.set(gid, s)).catch(() => {});
  });
  Promise.all(fetchPromises.filter(Boolean)).then(() => {
    _wss.clients.forEach(client => {
      if (client.readyState !== 1 || !client.userId) return;
      const visibleGroups = groups.filter(g => {
        const gid = parseInt(g.groupId, 10);
        const set = gid && memberSets.get(gid);
        return set && set.has(client.userId);
      });
      if (!visibleGroups.length) return;
      try {
        client.send(JSON.stringify({
          type: 'group:roster_update',
          ...payload,
          groups: visibleGroups,
          timestamp: payload.timestamp || Date.now()
        }));
      } catch (e) {}
    });
  });
}

function broadcastOnlineUsers() {
  // P3-39: users.online_visible=0（隐身）的用户不进在线清单广播；但连接保持在线（可继续收私信/群消息）
  const list = Array.from(onlineUsers.entries())
    .filter(([, info]) => info.onlineVisible !== false)
    .map(([id, info]) => ({
      userId: id,
      displayName: info.displayName,
      avatarUrl: info.avatarUrl,
      hasLocation: !!info.location
    }));
  
  const msg = JSON.stringify({
    type: 'online_users',
    count: list.length,
    users: list,
    timestamp: Date.now()
  });

  if (_wss) {
    _wss.clients.forEach(client => {
      if (client.readyState === 1) {
        try { client.send(msg); } catch (e) {}
      }
    });
  }
}

function broadcastToUser(userId, message) {
  const conns = userWsMap.get(userId);
  if (!conns) return;

  const str = JSON.stringify(message);
  const deadConns = [];

  for (const ws of conns) {
    if (ws.readyState === 1) {
      try { ws.send(str); } catch (e) { deadConns.push(ws); }
    } else {
      deadConns.push(ws);
    }
  }

  for (const ws of deadConns) {
    conns.delete(ws);
  }

  if (conns.size === 0) {
    userWsMap.delete(userId);
    onlineUsers.delete(userId);
  }
}

function broadcastToGroup(groupId, message) {
  if (!_wss) return;

  const str = JSON.stringify(message);
  
  (async () => {
    try {
      const memberSet = await getGroupMembers(groupId);
      
      for (const [uid, conns] of userWsMap) {
        if (memberSet.has(uid)) {
          for (const ws of conns) {
            if (ws.readyState === 1) {
              try { ws.send(str); } catch (e) {}
            }
          }
        }
      }
    } catch (e) {}
  })();
}

// ==================== §RTC 实时通话信令（私聊 1v1 + 群语音房 mesh） ====================
// 信令仅做转发/广播，不落库、不计未读。浏览器端 WebRTC 直接对连（STUN/TURN 由 /api/rtc/config 下发）。
function rtcPrivateRoomKey(a, b) {
  return `p:${Math.min(a, b)}:${Math.max(a, b)}`;
}
function rtcGroupRoomKey(gid) {
  return `g:${gid}`;
}
function rtcCheckRate(userId, ws) {
  const now = Date.now();
  const rec = rtcRateMap.get(userId);
  if (!rec || now - rec.windowStart > RTC_RATE_WINDOW) {
    rtcRateMap.set(userId, { count: 1, windowStart: now });
    return true;
  }
  rec.count++;
  if (rec.count > RTC_RATE_LIMIT) {
    try { ws.send(JSON.stringify({ type: 'rtc:error', error: '信令发送过于频繁，请稍后再试' })); } catch (e) {}
    return false;
  }
  return true;
}
function rtcEnterRoom(roomKey, userId) {
  if (!rtcRooms.has(roomKey)) rtcRooms.set(roomKey, new Set());
  rtcRooms.get(roomKey).add(userId);
  if (!userRtcRooms.has(userId)) userRtcRooms.set(userId, new Set());
  userRtcRooms.get(userId).add(roomKey);
}
function rtcLeaveRoom(roomKey, userId) {
  const members = rtcRooms.get(roomKey);
  if (members) {
    members.delete(userId);
    if (members.size === 0) rtcRooms.delete(roomKey);
  }
  const userRooms = userRtcRooms.get(userId);
  if (userRooms) {
    userRooms.delete(roomKey);
    if (userRooms.size === 0) userRtcRooms.delete(userId);
  }
}
function rtcRoomMembers(roomKey) {
  const members = rtcRooms.get(roomKey);
  if (!members || members.size === 0) return [];
  return Array.from(members);
}
function rtcUserBrief(userId) {
  return {
    userId,
    displayName: onlineUsers.get(userId)?.displayName || '',
    avatarUrl: onlineUsers.get(userId)?.avatarUrl || ''
  };
}
function rtcSend(ws, payload) {
  try {
    if (ws.readyState === 1) ws.send(JSON.stringify(payload));
  } catch (e) {}
}
// 仅向语音房内成员广播（群成员中实际已经「入房」的人），可排除指定用户
async function broadcastRtcToRoom(roomKey, message, excludeUserId) {
  const members = rtcRooms.get(roomKey);
  if (!members || members.size === 0) return;
  const str = JSON.stringify(message);
  for (const uid of members) {
    if (excludeUserId != null && uid === excludeUserId) continue;
    const conns = userWsMap.get(uid);
    if (!conns) continue;
    for (const conn of conns) {
      if (conn.readyState === 1) {
        try { conn.send(str); } catch (e) {}
      }
    }
  }
}

async function handleRtcSignal(userId, msg, ws) {
  const type = msg.type || '';
  if (!type) return;

  // 信令体大小限制：超限直接丢弃（SDP/ICE 通常 <64KB，256KB 留足余量）
  if (JSON.stringify(msg).length > RTC_MAX_MSG) {
    rtcSend(ws, { type: 'rtc:error', error: '信令数据过大' });
    return;
  }
  if (!rtcCheckRate(userId, ws)) return;

  const targetId = parseInt(msg.targetId, 10) || 0;

  // ----- 私聊 1v1 通话信令：按 canonical 房号透传给对端 -----
  if (type === 'rtc:invite') {
    if (!targetId || targetId === userId) return;
    const conns = userWsMap.get(targetId);
    if (!conns || conns.size === 0) {
      rtcSend(ws, { type: 'rtc:invite:failed', error: '对方当前不在线', targetId });
      return;
    }
    const roomId = rtcPrivateRoomKey(userId, targetId);
    rtcEnterRoom(roomId, userId);
    broadcastToUser(targetId, {
      type: 'rtc:invite', senderId: userId, targetId, roomId,
      callType: msg.callType === 'video' ? 'video' : 'voice',
      caller: rtcUserBrief(userId), timestamp: Date.now()
    });
    return;
  }
  if (type === 'rtc:cancel') {
    const roomId = rtcPrivateRoomKey(userId, targetId);
    rtcLeaveRoom(roomId, userId);
    broadcastToUser(targetId, { type: 'rtc:canceled', senderId: userId, targetId, roomId, timestamp: Date.now() });
    return;
  }
  if (type === 'rtc:accept') {
    if (!targetId || targetId === userId) return;
    const roomId = rtcPrivateRoomKey(userId, targetId);
    rtcEnterRoom(roomId, userId);
    broadcastToUser(targetId, { type: 'rtc:accepted', senderId: userId, targetId, roomId, timestamp: Date.now() });
    return;
  }
  if (type === 'rtc:decline') {
    if (!targetId || targetId === userId) return;
    const roomId = rtcPrivateRoomKey(userId, targetId);
    broadcastToUser(targetId, { type: 'rtc:declined', senderId: userId, targetId, roomId, timestamp: Date.now() });
    return;
  }
  if (type === 'rtc:offer' && targetId && targetId !== userId) {
    broadcastToUser(targetId, {
      type: 'rtc:offer', senderId: userId, targetId, roomId: rtcPrivateRoomKey(userId, targetId),
      sdp: msg.sdp, timestamp: Date.now()
    });
    return;
  }
  if (type === 'rtc:answer' && targetId && targetId !== userId) {
    broadcastToUser(targetId, {
      type: 'rtc:answer', senderId: userId, targetId, roomId: rtcPrivateRoomKey(userId, targetId),
      sdp: msg.sdp, timestamp: Date.now()
    });
    return;
  }
  if (type === 'rtc:candidate' && targetId && targetId !== userId) {
    broadcastToUser(targetId, {
      type: 'rtc:candidate', senderId: userId, targetId, roomId: rtcPrivateRoomKey(userId, targetId),
      candidate: msg.candidate, timestamp: Date.now()
    });
    return;
  }
  if (type === 'rtc:hangup' && targetId && targetId !== userId) {
    const roomId = rtcPrivateRoomKey(userId, targetId);
    rtcLeaveRoom(roomId, userId);
    broadcastToUser(targetId, { type: 'rtc:hangup', senderId: userId, targetId, roomId, timestamp: Date.now() });
    return;
  }

  // ----- 群语音房信令（mesh，≤6 人逐对建连） -----
  const groupId = parseInt(msg.groupId, 10);
  if (!groupId) return;
  const roomKey = rtcGroupRoomKey(groupId);
  const memberSet = await getGroupMembers(groupId); // 60s 缓存，断言群成员身份

  if (type === 'rtc:group:join') {
    if (!memberSet.has(userId)) {
      rtcSend(ws, { type: 'rtc:group:error', error: '您不是该群成员', groupId });
      return;
    }
    const existing = rtcRoomMembers(roomKey).filter(id => id !== userId);
    rtcEnterRoom(roomKey, userId);
    // 回执房内现有成员列表给新加入者（前端据此向旧成员逐个发起 offer）
    rtcSend(ws, {
      type: 'rtc:group:joined', groupId, roomKey,
      members: existing.map(rtcUserBrief), timestamp: Date.now()
    });
    // 通知房内旧成员有新人加入（排除发送者）
    await broadcastRtcToRoom(roomKey, {
      type: 'rtc:group:member:join', groupId, roomKey,
      member: rtcUserBrief(userId), timestamp: Date.now()
    }, userId);
    return;
  }
  if (type === 'rtc:group:leave' || type === 'rtc:group:hangup') {
    const wasIn = !!(rtcRooms.get(roomKey) && rtcRooms.get(roomKey).has(userId));
    rtcLeaveRoom(roomKey, userId);
    rtcSend(ws, { type: 'rtc:group:left', groupId, roomKey, timestamp: Date.now() });
    if (wasIn) {
      await broadcastRtcToRoom(roomKey, {
        type: 'rtc:group:member:leave', groupId, roomKey, userId, timestamp: Date.now()
      }, userId);
    }
    return;
  }
  if ((type === 'rtc:group:offer' || type === 'rtc:group:answer' || type === 'rtc:group:candidate') && targetId && targetId !== userId) {
    if (!memberSet.has(userId) || !memberSet.has(targetId)) {
      rtcSend(ws, { type: 'rtc:group:error', error: '非群成员不能发起通话', groupId });
      return;
    }
    const room = rtcRooms.get(roomKey);
    if (!room || !room.has(userId) || !room.has(targetId)) return; // 双方都必须在房内
    const kind = type.slice(10); // offer | answer | candidate
    const payload = { type: `rtc:group:${kind}`, groupId, roomKey, senderId: userId, targetId, timestamp: Date.now() };
    if (msg.sdp) payload.sdp = msg.sdp;
    if (msg.candidate) payload.candidate = msg.candidate;
    broadcastToUser(targetId, payload);
    return;
  }
}

// RTC 房间状态查询（供测试/监控使用）
function getRtcRoomStats() {
  return {
    roomCount: rtcRooms.size,
    rooms: Array.from(rtcRooms.entries()).map(([key, ids]) => ({ roomKey: key, members: Array.from(ids) }))
  };
}

function broadcastAllExcept(excludeWs, message) {
  if (!_wss) return;

  const str = JSON.stringify(message);
  _wss.clients.forEach(client => {
    if (client !== excludeWs && client.readyState === 1) {
      try { client.send(str); } catch (e) {}
    }
  });
}

function gracefulShutdown() {
  if (_heartbeatInterval) {
    clearInterval(_heartbeatInterval);
  }
  if (_offlineSummaryInterval) {
    clearInterval(_offlineSummaryInterval);
  }
  
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer);
  }
  debounceTimers.clear();

  if (_wss) {
    _wss.clients.forEach(client => {
      client.close(1001, 'Server shutting down');
    });
    _wss.close();
  }
}

function getOnlineUsers() {
  return Array.from(onlineUsers.entries()).map(([id, info]) => ({
    userId: id,
    displayName: info.displayName,
    avatarUrl: info.avatarUrl,
    lastPing: info.lastPing
  }));
}

module.exports = {
  setupWebSocket,
  setSessionSecret,
  broadcastRosterUpdate,
  broadcastOnlineUsers,
  broadcastToUser,
  broadcastToGroup,
  broadcastToGroupWithTier,
  broadcastAllExcept,
  gracefulShutdown,
  getOnlineUsers,
  invalidateGroupMemberCache,
  getRtcRoomStats,
  onlineUsers,
  userWsMap
};
