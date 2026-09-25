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
const crypto = require('crypto');
const logger = require('./logger');
const wsService = require('./ws_service');
const VRCPipeline = require('./vrc_pipeline');
const schedule = require('./schedule');
const { getPool, encryptCookie, decryptCookie } = require('./utils');
const {
  vrchatBasicLogin,
  vrchatVerifyTwoFactor,
  vrchatGetCurrentUserResult
} = require('./vrc');

const SESSION_FILE = path.join(__dirname, 'session.json');

// ==================== RFC 6238 TOTP（Node 内置 crypto 实现，无第三方依赖） ====================
// 用于「系统账号会话被拒后自动重登」：管理员已配置 TOTP 密钥时，无需人工介入即可完成二次验证。
// 算法：HMAC-SHA1，30 秒步长，6 位数字动态码；密钥为 Base32 编码。
function base32Decode(str) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  const bytes = [];
  let buffer = 0;
  let bitsLeft = 0;
  for (const ch of clean) {
    const val = alphabet.indexOf(ch);
    if (val < 0) continue;
    buffer = (buffer << 5) | val;
    bitsLeft += 5;
    if (bitsLeft >= 8) {
      bytes.push((buffer >> (bitsLeft - 8)) & 0xff);
      bitsLeft -= 8;
    }
  }
  return Buffer.from(bytes);
}

function generateTOTP(secret, timeStep = 30, digits = 6) {
  try {
    const key = base32Decode(secret);
    if (!key.length) return null;
    const counter = Math.floor(Date.now() / (timeStep * 1000));
    const counterBuf = Buffer.alloc(8);
    counterBuf.writeBigUInt64BE(BigInt(counter), 0);
    const hmac = crypto.createHmac('sha1', key).update(counterBuf).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const binCode = ((hmac[offset] & 0x7f) << 24) |
                    ((hmac[offset + 1] & 0xff) << 16) |
                    ((hmac[offset + 2] & 0xff) << 8) |
                    (hmac[offset + 3] & 0xff);
    return String(binCode % (10 ** digits)).padStart(digits, '0');
  } catch (e) {
    logger.error('[vrc-session]', 'TOTP 生成失败:', e.message);
    return null;
  }
}

module.exports = function setupVrcAuth() {
  // ==================== 系统 VRChat 登录状态 ====================
  const authState = { loggedIn: false, cookie: null, userId: null, displayName: null, cookieSetAt: null };
  global.__getVrcAuthState = () => authState; // 供后台 VRC 监控读取最新鉴权状态

  // ==================== 自动重登凭据（加密存储，内存明文中转） ====================
  // 管理员在面板保存后写入 session.json（AES-256-GCM 加密）；仅在「会话被拒」时被 autoRelogin 读取，
  // 明文永不落盘。totpSecret 可选：未配置时若登录要求 TOTP，自动重登无法完成，需管理员手动介入。
  const vrcCred = { username: null, password: null, totpSecret: null };
  let _reloginPromise = null;

  // F-30: 自动重登熔断与退避（防封禁加固）。
  // 场景：出口 IP 长期 ≠ 签发 authToken 的 IP 时，「1006 → 重登成功 → 新 token 重连 → 再 1006 → 再重登」
  // 会形成高频重登循环。虽已受 vrc.js 全局令牌桶（≤40/min）约束不会打爆 API 限流，
  // 但「同一账号在极短时间内反复成功登录」本身就是 VRChat 风控的人工审查诱因，
  // 因此为自动重登叠加「最小间隔 + 连续失败指数退避」双护栏：
  //   - 任何两次自动重登至少间隔 60s（无论成败），杜绝循环退化为高频登录形态；
  //   - 连续失败按 5min/15min/30min 指数退避封顶，成功即清零；管理员重新保存凭据时立即重置。
  const RELOGIN_MIN_INTERVAL_MS = 60 * 1000;      // 两次自动重登最小间隔
  const RELOGIN_MAX_BACKOFF_MS = 30 * 60 * 1000;  // 连败退避封顶 30 分钟
  let _reloginFailStreak = 0;
  let _lastReloginAt = 0;
  let _reloginBackoffUntil = 0;
  let _lastReloginResult = null;

  function _reloginBackoffMs() {
    return Math.min(5 * 60 * 1000 * (3 ** Math.min(_reloginFailStreak - 1, 2)), RELOGIN_MAX_BACKOFF_MS);
  }

  function _resetReloginGuard() {
    _reloginFailStreak = 0;
    _lastReloginAt = 0;
    _reloginBackoffUntil = 0;
  }

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

  // ==================== F-29: 会话被拒自动重登 ====================
  // pipeline 已暂停重连风暴（见 vrc_pipeline._sessionRejected），这里承担「换新会话」的职责：
  // 用面板保存的系统账号凭据重新 Basic 登录（必要时以 TOTP 二次验证），拿到新 cookie 后
  // saveAuthState → updatePipelineAuth → setAuthToken → 自动解除暂停并重连。
  // 无法自动完成时（未配置凭据 / 需要人工 2FA / 登录失败）保持暂停，由管理员在面板处理。
  async function autoRelogin() {
    if (_reloginPromise) return _reloginPromise; // 同一时刻只允许一次重登
    _reloginPromise = (async () => {
      const now = Date.now();
      // F-30: 熔断检查 —— 指数退避窗口内不发请求；任何两次尝试至少间隔 60s（无论成败）
      if (now < _reloginBackoffUntil) {
        logger.warn('[vrc-auth]', `自动重登处于熔断退避中（连败 ${_reloginFailStreak} 次，约 ${Math.ceil((_reloginBackoffUntil - now) / 1000)} 秒后恢复），保持暂停`);
        return { ok: false, reason: 'BACKOFF', retryable: true };
      }
      if (now - _lastReloginAt < RELOGIN_MIN_INTERVAL_MS) {
        logger.warn('[vrc-auth]', '自动重登过于频繁（距上次尝试不足 60 秒），保持暂停');
        return { ok: false, reason: 'BACKOFF', retryable: true };
      }
      _lastReloginAt = now; // 一经尝试立即占据时间窗，防止并发触发绕过节流
      const result = await (async () => {
        if (!vrcCred.username || !vrcCred.password) {
          logger.warn('[vrc-auth]', '会话被拒，但没有已保存的自动重登凭据，保持暂停等待管理员处理');
          return { ok: false, reason: 'NO_CREDENTIALS' };
        }
        logger.info('[vrc-auth]', '会话被拒，尝试使用系统账号自动重登...');
        try {
          const login = await vrchatBasicLogin(vrcCred.username, vrcCred.password);
          if (login.status === 429) {
            logger.warn('[vrc-auth]', '登录接口限流（429），进入退避等待');
            return { ok: false, reason: 'RATE_LIMIT', retryable: true };
          }
          if (login.status < 200 || login.status >= 300) {
            const msg = (login.data && login.data.error && login.data.error.message) || `HTTP ${login.status}`;
            logger.error('[vrc-auth]', `自动重登失败: ${msg}`);
            return { ok: false, reason: 'LOGIN_FAILED' };
          }

          let cookie = login.cookie;
          // 2FA：totp 可自动完成；emailOtp/otp 需要人工介入，保持暂停
          if (login.needs2fa) {
            const methods = Array.isArray(login.data.requiresTwoFactorAuth) ? login.data.requiresTwoFactorAuth : [];
            if (methods.includes('totp') && vrcCred.totpSecret) {
              const totp = generateTOTP(vrcCred.totpSecret);
              if (!totp) {
                logger.error('[vrc-auth]', 'TOTP 密钥无效，无法生成验证码，请检查管理员保存的密钥');
                return { ok: false, reason: 'BAD_TOTP' };
              }
              const verify = await vrchatVerifyTwoFactor('totp', totp, cookie);
              if (verify.status < 200 || verify.status >= 300) {
                const msg = (verify.data && verify.data.error && verify.data.error.message) || `HTTP ${verify.status}`;
                logger.error('[vrc-auth]', `TOTP 验证失败: ${msg}`);
                return { ok: false, reason: 'TOTP_FAILED' };
              }
              cookie = verify.cookie || cookie;
            } else if (methods.includes('totp')) {
              logger.error('[vrc-auth]', '登录需要 TOTP 二次验证，但未保存 TOTP 密钥，保持暂停等待管理员处理');
              return { ok: false, reason: 'NEED_TOTP' };
            } else {
              logger.error('[vrc-auth]', `登录需要人工二次验证（${methods.join('/')}），无法自动完成，保持暂停等待管理员处理`);
              return { ok: false, reason: 'NEED_MANUAL_2FA' };
            }
          }

          // 验证新 cookie 可用并更新 authState
          const me = await vrchatGetCurrentUserResult(cookie);
          if (me.status < 200 || me.status >= 300) {
            logger.error('[vrc-auth]', `自动重登后校验新 cookie 失败（HTTP ${me.status}），保持暂停`);
            return { ok: false, reason: 'VERIFY_FAILED' };
          }
          const user = me.data || {};
          Object.assign(authState, {
            loggedIn: true,
            cookie,
            userId: user.id || authState.userId || null,
            displayName: user.displayName || authState.displayName || null,
            cookieSetAt: Date.now()
          });
          await saveAuthState();
          logger.info('[vrc-auth]', `自动重登成功: ${authState.displayName || authState.userId || ''}`);
          return { ok: true };
        } catch (e) {
          logger.error('[vrc-auth]', `自动重登异常: ${e.message}`);
          return { ok: false, reason: 'EXCEPTION' };
        }
      })();
      // F-30: 记录最近一次结果，并维护连败退避计数（BACKOFF/NO_CREDENTIALS 属被动状态，不递增退避）
      _lastReloginResult = { ok: result.ok, reason: result.reason, at: new Date().toISOString() };
      if (result.ok) {
        _reloginFailStreak = 0;
      } else if (result.reason && result.reason !== 'BACKOFF' && result.reason !== 'NO_CREDENTIALS') {
        _reloginFailStreak += 1;
        _reloginBackoffUntil = Date.now() + _reloginBackoffMs();
      }
      return result;
    })();
    _reloginPromise.catch(() => {}).finally(() => { setTimeout(() => { _reloginPromise = null; }, 0); });
    return _reloginPromise;
  }

  // F-30: 自动重登熔断状态（供 /api/health 与管理面板展示退避进度）
  function getAutoReloginStatus() {
    const now = Date.now();
    return {
      failStreak: _reloginFailStreak,
      backoffUntil: _reloginBackoffUntil || null,
      backoffRemainingSec: _reloginBackoffUntil > now ? Math.ceil((_reloginBackoffUntil - now) / 1000) : 0,
      lastResult: _lastReloginResult,
      minIntervalMs: RELOGIN_MIN_INTERVAL_MS,
      maxBackoffMs: RELOGIN_MAX_BACKOFF_MS
    };
  }

  vrcPipeline.on('session-rejected', (info) => {
    logger.error('[vrc-pipeline]', `会话被拒（${info.err}${info.ip ? `，IP ${info.ip}` : ''}），触发自动重登`);
    autoRelogin().catch((e) => logger.error('[vrc-auth]', `自动重登调度异常: ${e.message}`));
  });

  // 保存系统账号自动重登凭据（加密存储；返回是否含 TOTP 以便前端提示）
  async function saveVRCCredentials({ username, password, totpSecret }) {
    vrcCred.username = String(username || '').trim();
    vrcCred.password = String(password || '');
    vrcCred.totpSecret = totpSecret ? String(totpSecret).trim() : null;
    if (!vrcCred.username || !vrcCred.password) {
      throw new Error('用户名与密码不能为空');
    }
    _resetReloginGuard(); // F-30: 管理员重新保存凭据 = 明确人工介入，立即重置熔断/退避计数
    await saveAuthState();
    return { sent: true, hasTotp: !!vrcCred.totpSecret };
  }

  // 清除系统账号自动重登凭据
  async function clearVRCCredentials() {
    vrcCred.username = null;
    vrcCred.password = null;
    vrcCred.totpSecret = null;
    _resetReloginGuard(); // F-30: 凭据已清除，熔断状态一并归零（无凭据则不会触发自动重登）
    await saveAuthState();
    return { cleared: true };
  }

  function hasVRCCredentials() {
    return !!(vrcCred.username && vrcCred.password);
  }

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
      // F-29: 读取自动重登凭据（AES-256-GCM 加密，解密失败则忽略，等待管理员重新配置）
      if (saved && saved.credentials) {
        vrcCred.username = saved.credentials.username ? decryptCookie(saved.credentials.username) : null;
        vrcCred.password = saved.credentials.password ? decryptCookie(saved.credentials.password) : null;
        vrcCred.totpSecret = saved.credentials.totpSecret ? decryptCookie(saved.credentials.totpSecret) : null;
        if (!vrcCred.username || !vrcCred.password) {
          // F-30: 显式告警 —— 带 enc: 前缀却解密失败 = ENCRYPT_KEY 已变更或数据损坏。
          // 注意：只告警、不清除、不写回。凭据是用户数据，多环境/多进程（dev 与生产、PM2
          // 各实例）可能使用不同 ENCRYPT_KEY，擅自清除会让任一实例误删共享凭据；保留原加密
          // 串由管理员在面板重新保存覆盖即可。凭据置空后 autoRelogin 走 NO_CREDENTIALS 被动
          // 分支（不登录、不产生重登风暴），安全。
          const corrupt = (
            (saved.credentials.username && saved.credentials.username.startsWith('enc:') && !vrcCred.username) ||
            (saved.credentials.password && saved.credentials.password.startsWith('enc:') && !vrcCred.password)
          );
          if (corrupt) {
            logger.error('[vrc-auth]', '系统账号自动重登凭据解密失败（可能 ENCRYPT_KEY 已变更或数据损坏），自动重登已停用，请在管理面板重新保存账号密码覆盖修复');
          }
          vrcCred.username = vrcCred.password = vrcCred.totpSecret = null;
        } else if (saved.credentials.totpSecret && saved.credentials.totpSecret.startsWith('enc:') && !vrcCred.totpSecret) {
          // 仅 TOTP 密钥损坏：账号密码仍可用，但自动重登将无法完成 TOTP 二次验证
          logger.error('[vrc-auth]', 'TOTP 密钥解密失败（可能 ENCRYPT_KEY 已变更或数据损坏），自动重登将无法完成 TOTP 二次验证，请在管理面板重新保存 TOTP 密钥覆盖修复');
        }
      }
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
    const enc = (v) => (v ? encryptCookie(v) : null);
    const stateToSave = {
      ...authState,
      // cookie 加密后再写入文件
      cookie: authState.cookie ? encryptCookie(authState.cookie) : null,
      // F-29: 自动重登凭据同样 AES-256-GCM 加密后写入，明文永不落盘
      credentials: {
        username: enc(vrcCred.username),
        password: enc(vrcCred.password),
        totpSecret: enc(vrcCred.totpSecret)
      }
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
    setVRCCookieExpireDays,
    saveVRCCredentials,
    clearVRCCredentials,
    hasVRCCredentials,
    autoRelogin,
    // F-30: 主动清零自动重登连败熔断（人工登录/2FA 成功即视为成功，陈旧退避状态不再残留）
    resetReloginGuard: _resetReloginGuard,
    getAutoReloginStatus
  };
};
