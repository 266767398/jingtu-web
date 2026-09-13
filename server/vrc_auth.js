/**
 * 系统 VRChat 登录状态 / Cookie 加密会话 / Pipeline WebSocket（P2-4 第二步第二批）
 * 从 server.js 原地抽取为 setup 工厂；authState 生命周期、失效语义与挂载顺序保持不变。
 *
 * 设计要点：
 * - authState 一经创建引用不变：session.json 载入用 Object.assign 就地改写，
 *   保证 vrc_system / album / notifications 等工厂与 global.__getVrcAuthState 拿到同一引用。
 * - invalidateVRCCookie 挂在 getVRCCookie 上（getVRCCookie.invalidate），
 *   供只接收 getVRCCookieFn 的路由模块调用，不改 13 处调用签名。
 */
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const wsService = require('./ws_service');
const VRCPipeline = require('./vrc_pipeline');
const { getPool, encryptCookie, decryptCookie } = require('./utils');

const SESSION_FILE = path.join(__dirname, 'session.json');

module.exports = function setupVrcAuth() {
  // ==================== 系统 VRChat 登录状态 ====================
  const authState = { loggedIn: false, cookie: null, userId: null, displayName: null, cookieSetAt: null };
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

  // F-10: 发给「系统 VRChat 账号」的实例邀请（含对方接受/拒绝回执）实时广播。
  // pipeline 归属系统账号，因此这里只反映系统账号收到的邀请，与普通用户
  // 通过 /api/vrc-invites 发出的邀请无关；前端按 F-19 语义仅对管理员提示。
  vrcPipeline.on('invite', (notification) => {
    logger.info('[vrc-pipeline]', `收到实例邀请: ${notification.senderUsername || notification.message}`);
    wsService.broadcastAllExcept(null, {
      type: 'vrc_invite',
      notification
    });
  });

  // F-10: 发给「系统 VRChat 账号」的好友申请实时广播（管理员可见，语义同上）
  vrcPipeline.on('friend_request', (notification) => {
    logger.info('[vrc-pipeline]', `收到好友申请: ${notification.senderUsername || ''}`);
    wsService.broadcastAllExcept(null, {
      type: 'vrc_friend_request',
      notification
    });
  });

  // 从加密存储读取系统 Cookie
  // 注意：原 server.js 版本此处对 authState 做变量重赋值；抽取后改用 Object.assign
  // 就地改写同一对象，保证下游工厂（vrc_system/album/notifications）引用不失效。
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const raw = fs.readFileSync(SESSION_FILE, 'utf8');
      const saved = JSON.parse(raw);
      if (saved && saved.cookie) {
        // 解密存储的 cookie（兼容旧版未加密的 cookie）
        const decrypted = decryptCookie(saved.cookie);
        if (decrypted) {
          Object.assign(authState, saved, { cookie: decrypted, loggedIn: true });
        } else {
          // 解密失败，尝试明文（旧版格式），重新加密存储
          Object.assign(authState, saved, { loggedIn: true });
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

  return {
    authState,
    saveAuthState,
    getVRCCookie,
    getVRCCookieUserOnly,
    getVRCCookieExpireDays,
    setVRCCookieExpireDays
  };
};
