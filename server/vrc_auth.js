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
const schedule = require('./schedule');
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

  // F-28: 服务端 err 帧（如 "authToken doesn't correspond with an active session"）。
  // 多为「连接出口 IP ≠ 签发 authToken 的 IP」（代理/VPN/家宽出口漂移），无论重连多少次都会被拒。
  // 记录原因并暴露到 /api/health，供运维定位而非盲目重试。
  global.__getVrcPipelineStatus = () => vrcPipeline.getStatus();
  vrcPipeline.on('session-error', (info) => {
    logger.error('[vrc-pipeline]', `服务端拒绝会话: ${info.err}` + (info.ip ? `（IP ${info.ip}）` : ''));
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

  // ==================== Pipeline 好友事件实时快速路径（VRCX 同源低延迟） ====================
  // Pipeline 直连 VRChat 事件总线，好友上下线/位置/状态变更即时可达：
  //  - 无需等待 cron 的 30s+ 稳定窗口，也无需消耗 /auth/user/friends 的 API 令牌桶配额；
  //  - 落库信任等级与 cron 的 TRUST_FRIEND(2) 同级，事件即系统账号好友的权威实时状态；
  //  - 隐私/过渡占位符（offline/traveling/private/web）不写入 world_name，保护状态不被占位值污染。
  // 处理策略：
  //  - 先读当前行对比，仅在实际状态变化时 UPDATE + 广播（内容级去重，避免高频事件写风暴）；
  //  - 同一用户串行处理（per-user promise 链），防止并发事件读改写竞态；
  //  - 直写 is_online 并清空 status_candidate，绕过稳定窗口 = 即时生效（VRCX 同款行为）。
  const PIPE_TRUST_FRIEND = 2;
  const PIPE_LOC_PLACEHOLDER = new Set(['offline', 'traveling', 'private', 'web']);
  const _friendPipeQueues = new Map();

  function serializeFriendEvent(userId, task) {
    const prev = _friendPipeQueues.get(userId) || Promise.resolve();
    const run = prev.then(task);
    const guard = run.catch(() => {});
    _friendPipeQueues.set(userId, guard);
    guard.finally(() => {
      if (_friendPipeQueues.get(userId) === guard) _friendPipeQueues.delete(userId);
    });
    return run;
  }

  async function handleFriendPipelineEvent(msg) {
    const userId = msg.userId || msg.userid || msg.id || (msg.user && (msg.user.id || msg.user.userId));
    if (!userId) return;
    const pool = getPool();

    // friend-add / friend-remove：仅登记好友关系，不触碰在线/位置状态（载荷通常不含位置信息）
    if (msg.type === 'friend-add' || msg.type === 'friend-remove') {
      const isFriend = msg.type === 'friend-add';
      const [rows] = await pool.query(
        `SELECT vrchat_id, is_friend, is_member FROM group_roster WHERE vrchat_id = ? LIMIT 1`,
        [userId]
      );
      if (!rows.length) return; // 未在 roster 跟踪名单中（既非群组成员也非好友），无需处理
      if ((rows[0].is_friend === 1) === isFriend) return; // 无变化
      await pool.query(
        `UPDATE group_roster SET is_friend = ?, synced_at = NOW() WHERE vrchat_id = ?`,
        [isFriend ? 1 : 0, userId]
      );
      logger.debug('[VRC]', `好友关系事件: ${msg.type} ${userId} → is_friend=${isFriend}`);
      if (isFriend && rows[0].is_member === 1) {
        const groups = await schedule.getGroupStatsSnapshot(pool);
        wsService.broadcastRosterUpdate({ groups, members: [{ vrchatId: userId, isFriend: true }] });
      }
      return;
    }

    // 在线/位置类事件（friend-online/offline/active/location/update）
    const userObj = (msg.user && typeof msg.user === 'object') ? msg.user : {};
    const location = String(msg.location || userObj.location || '').trim();
    const worldId = String(msg.worldId || userObj.worldId || '').trim();
    const isOnline = msg.type !== 'friend-offline' && location !== 'offline';
    // 在线且 location 非空/非 web/非 offline 即视为游戏内（与 schedule.js 判定一致；traveling 属游戏内过渡态）
    const isInGame = isOnline && location !== '' && location !== 'web' && location !== 'offline';
    const status = String(msg.status || userObj.status || (isOnline ? 'active' : 'offline'));
    const statusDescription = String(msg.statusDescription != null ? msg.statusDescription : (userObj.statusDescription != null ? userObj.statusDescription : ''));

    // 隐私/过渡占位符不写入 world_name；在线但位置未知（private/traveling/web）时保留上一已知世界名
    let worldName = '';
    if (!isOnline) {
      worldName = '';
    } else if (location && !PIPE_LOC_PLACEHOLDER.has(location)) {
      worldName = worldId || location.split(':')[0] || '';
    } else if (worldId && !PIPE_LOC_PLACEHOLDER.has(worldId)) {
      worldName = worldId;
    }

    const [rows] = await pool.query(
      `SELECT vrchat_id, is_online, is_in_game, vrchat_status, status_description, world_name, is_friend, is_member,
              display_name, avatar_url
       FROM group_roster WHERE vrchat_id = ? LIMIT 1`,
      [userId]
    );
    if (!rows.length) return;
    const row = rows[0];

    const avatarUrl = userObj.currentAvatarThumbnailImageUrl || userObj.profilePicOverrideThumbnail || row.avatar_url || '';
    const displayName = userObj.displayName || row.display_name || '';
    const worldNameFinal = worldName || row.world_name || '';

    // 内容级去重：任一关键字段变化才落库广播，避免同值高频事件（如活跃事件刷屏）打爆 DB
    if (row.is_friend === 1 &&
        (row.is_online === 1) === isOnline &&
        (row.is_in_game === 1) === isInGame &&
        (row.vrchat_status || '') === status &&
        (row.status_description || '') === statusDescription &&
        (row.world_name || '') === worldNameFinal &&
        (row.avatar_url || '') === avatarUrl &&
        (row.display_name || '') === displayName) {
      return;
    }

    await pool.query(
      `UPDATE group_roster SET display_name = ?, avatar_url = ?, is_online = ?, is_in_game = ?, vrchat_status = ?,
              status_description = ?, world_name = ?, is_friend = 1,
              status_trust = ?, status_candidate = NULL, status_changed_at = NULL,
              last_seen = NOW(), synced_at = NOW()
       WHERE vrchat_id = ?`,
      [displayName, avatarUrl, isOnline ? 1 : 0, isInGame ? 1 : 0, status, statusDescription, worldNameFinal,
       PIPE_TRUST_FRIEND, userId]
    );
    logger.debug('[VRC]', `好友事件快速路径: ${msg.type} ${userId} 在线=${isOnline} 游戏内=${isInGame} 状态=${status} 位置=${worldNameFinal}`);

    // 仅群组成员广播增量（前端网格只渲染 is_member=1 的卡片；非成员无卡片可更新）
    if (row.is_member === 1) {
      const groups = await schedule.getGroupStatsSnapshot(pool);
      wsService.broadcastRosterUpdate({
        groups,
        members: [{
          vrchatId: userId,
          isOnline,
          isInGame,
          isFriend: true,
          status,
          statusDescription,
          worldName: worldNameFinal
        }]
      });
    }
  }

  vrcPipeline.on('friend', (msg) => {
    logger.debug('[VRC]', `好友事件: ${msg.type}`);
    const userId = msg.userId || msg.userid || msg.id || (msg.user && (msg.user.id || msg.user.userId));
    if (!userId) return;
    serializeFriendEvent(userId, () => handleFriendPipelineEvent(msg)).catch((e) => {
      logger.error('[vrc-pipeline]', `好友事件快速路径处理失败(${msg.type}): ${e.message}`);
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
