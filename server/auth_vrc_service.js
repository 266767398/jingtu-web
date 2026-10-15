/**
 * 境途同游 V5.2 — VRChat 认证业务层（auth.js 按域拆分）
 * 处理器收 (req, res)，随实现整体下沉：路由注册、限流/鉴权中间件与
 * 业务实现同文件维护，新增 VRChat 端点只改本文件。
 * routes/auth_routes.js 通过 registerVrcRoutes(router) 原位委托注册。
 */
const {
  vrchatBasicLogin,
  vrchatGetCurrentUserResult,
  vrchatGetUser,
  vrchatVerifyTwoFactor,
  triggerVrcEmailOtp
} = require('./vrc');
const { fail, ok, getPool, encryptCookie, handleError, sendError, ErrorCodes } = require('./utils');
const { createCustomLimiter } = require('./middleware/rate_limit');
const { requireAuth } = require('./auth');
const logger = require('./logger');
const securityAlert = require('./security_alert');
const { buildSession, sessionUser } = require('./auth_session');

// P3-70: 2FA 验证码每 token 失败次数上限——≥MAX 即删除登录会话并触发安全告警
const MAX_2FA_ATTEMPTS = 5;

// S-6: VRChat 登录审计写入 login_history（provider=vrc）；记录失败不影响登录主流程
async function insertVrcLoginHistory(req, user, reason = 'VRChat登录') {
  try {
    const cf = req.headers['x-forwarded-for'];
    const ip = String(cf ? String(cf).split(',')[0].trim() : (req.socket && req.socket.remoteAddress) || '').slice(0, 64);
    const ua = String(req.headers['user-agent'] || '').slice(0, 500);
    await getPool().query(
      `INSERT INTO login_history (user_id, login_id, provider, success, ip, user_agent, reason)
       VALUES (?, ?, 'vrc', 1, ?, ?, ?)`,
      [user.id, user.login_id, ip, ua, String(reason).slice(0, 100)]
    );
  } catch (e) {
    logger.warn('auth-vrc', `[login_history] 写入失败: ${e.message}`);
  }
}

// ==================== VRChat 临时状态存储（绑定 + 登录）====================
// bindTokens: token →{ cookie, vrcUser, userId, expireAt }
// loginTokens: token →{ cookie, vrcUser, boundUser, expireAt }
// →token 替代 session 存储，避免session 持久化不可靠问题
const bindTokens = new Map();
const loginTokens = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [token, state] of bindTokens) {
    // P2: 绑定 token 现带 24h 有效期（历史遗留的 expireAt=null 项仅清理）
    if (state.expireAt && state.expireAt < now) bindTokens.delete(token);
  }
  for (const [token, state] of loginTokens) {
    if (state.expireAt < now) loginTokens.delete(token);
  }
}, 60000).unref(); // 每分钟清理过期token

/**
 * 统一 VRChat 2FA 验证（消除三重复代码）
 * @param {string} code 用户输入的验证码
 * @param {string} cookie VRChat cookie
 * @param {object} [opts]
 * @param {boolean} [opts.refreshUser=true] 是否在验证后获取最新用户信息
 * @returns {{ success: boolean, cookie: string, user?: object, error?: string }}
 */
async function verifyVrc2fa(code, method, cookie, opts = {}) {
  const { refreshUser = true } = opts;
  const normalizedCode = method === 'otp'
    ? code.trim().replace(/^(\d{4})(\d{4})$/, '$1-$2')
    : code.trim();
  const twoFaRes = await vrchatVerifyTwoFactor(method, normalizedCode, cookie);
  if (twoFaRes.status !== 200 || twoFaRes.data?.verified !== true) {
    return { success: false, error: twoFaRes.data?.error?.message || '验证码错误' };
  }
  const finalCookie = twoFaRes.cookie;
  let user = null;
  let userError = null;
  if (refreshUser) {
    try {
      const currentUserRes = await vrchatGetCurrentUserResult(finalCookie);
      user = currentUserRes.status === 200 ? currentUserRes.data : null;
      if (!user?.id) userError = 'VRChat 未返回账号信息';
    } catch (e) {
      logger.warn('auth', '[verifyVrc2fa] 获取用户信息失败:', e.message);
      userError = e.message;
    }
  }
  return { success: true, cookie: finalCookie, user, userError };
}

// P4: 登录成功统一收尾（消除模式A/模式B/独立2FA 三处重复的
// UPDATE + session.regenerate + buildSession + 审计 代码块）
// 调用前需在 boundUser 上写入最终 vrchat_name / vrchat_avatar_url。
// @param {object} [opts.bindStatus=false] 响应是否携带 bindStatus:'already_bound'
function completeVrcLogin(req, res, boundUser, cookie, reason, opts = {}) {
  getPool().query(
    `UPDATE users SET vrchat_name = ?, vrchat_avatar_url = ?, failed_login_attempts = 0, locked_until = NULL, updated_at = NOW() WHERE id = ?`,
    [boundUser.vrchat_name, boundUser.vrchat_avatar_url, boundUser.id]
  ).catch((e) => logger.error('auth-vrc', `[completeVrcLogin] 更新用户信息失败: ${e.message}`));
  req.session.regenerate(async (err) => {
    if (err) { handleError(res, err, 'auth'); return; }
    try {
      await buildSession(req, boundUser, cookie);
      await req.session.save();
      await getPool().query(
        `INSERT INTO sys_oper_log (admin_vrcid, oper_type, content) VALUES (?, 'VRC登录', ?)`,
        [boundUser.login_id, `${boundUser.display_name} VRChat登录`]
      );
      await insertVrcLoginHistory(req, boundUser, reason);
      const payload = { user: sessionUser(req.session) };
      if (opts.bindStatus) payload.bindStatus = 'already_bound';
      ok(res, payload);
    } catch (e) { handleError(res, e, 'auth'); }
  });
}

// P3-70: 2FA 验证失败计数——每 token 累计，≥MAX_2FA_ATTEMPTS 删除会话并触发安全告警。
// 返回 true 表示本次失败后会话已被锁定删除，调用方应返回锁定错误。
function _register2faFailure(loginToken, state) {
  state.failCount = (state.failCount || 0) + 1;
  if (state.failCount >= MAX_2FA_ATTEMPTS) {
    loginTokens.delete(loginToken);
    logger.warn('auth', `[2FA] 登录会话 ${String(loginToken).slice(-8)} 验证码失败 ${state.failCount} 次，会话已失效`);
    securityAlert.onSecurityBreach('VRChat2FA验证码爆破', {
      tokenTail: String(loginToken).slice(-8),
      attempts: state.failCount,
      methods: Array.isArray(state.methods) ? state.methods.join(',') : ''
    });
    return true;
  }
  return false;
}

// 路由注册委托：routes/auth_routes.js 原位调用，四个端点连中间件一并注册
function registerVrcRoutes(router) {
// AUTH-5：VRChat 登录第一步（模式 A）可用任意 VRChat 用户名+密码触发邮箱 OTP →
// 骚扰 + 上游 API 配额消耗（VRChat 限额约 10 次/15min/IP）。收紧该端点限流：
// 15 分钟 10 次/IP（含 mode A 与会话失效后的重试），阻断轮换刷 OTP。
const vrcLoginLimiter = createCustomLimiter({
  name: 'vrc-login',
  max: 10,
  message: { error: 'VRChat 登录请求过于频繁，请稍后再试', retryAfter: 900 }
});
// ==================== VRChat 登录（两步内联流程） ====================
// 第一→ POST { username, password } →需要验证码时返回{ need2fa, loginToken }
// 第二→ POST { code, loginToken } →验证码验证+ 完成登录
router.post('/vrchat-login', vrcLoginLimiter, async (req, res) => {
  try {
    const { username, password, code, method, loginToken } = req.body;

    // ══════════ 模式 B：有 loginToken + code →第二步验证══════════
    if (loginToken && code) {
      const state = loginTokens.get(loginToken);
      if (!state || state.expireAt < Date.now()) {
        if (state) loginTokens.delete(loginToken);
        return fail(res, 400, '登录会话已过期，请重新发送验证码', { expired: true });
      }
      const { cookie, methods } = state;
      if (!methods.includes(method)) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '双重验证方式无效，请重新登录');

      // 验证 2FA
      const vResult = await verifyVrc2fa(code, method, cookie);
      if (!vResult.success) {
        // P3-70: 每 token 累计失败次数，≥MAX_2FA_ATTEMPTS 删除会话并告警，防验证码爆破
        const locked = _register2faFailure(loginToken, state);
        if (locked) {
          return fail(res, 429, '验证码错误次数过多，登录会话已失效，请重新登录', { code: '2FA_LOCKED', locked: true });
        }
        return fail(res, 401, vResult.error, { code: ErrorCodes.VRC_AUTH_FAILED, remaining: MAX_2FA_ATTEMPTS - state.failCount });
      }
      loginTokens.delete(loginToken);

      // 🔴 P1 修复（docs/12）：VRChat /auth/user 在 2FA 待验证阶段不返回 id，
      // 第一步（模式 A）无法据此查绑定。绑定只能等 2FA 验证通过、拿到真实 id 后再查，
      // 否则已绑定 + 开启 2FA 的用户会被误判"未绑定"而永远无法登录。
      if (!vResult.user || !vResult.user.id) {
        return fail(res, 401, '2FA 验证通过后 VRChat 未返回账号信息，请稍后重试', { code: ErrorCodes.VRC_AUTH_FAILED });
      }
      const [boundUsers] = await getPool().query(
        `SELECT * FROM users WHERE vrchat_id = ? AND deleted_at IS NULL AND banned = 0`,
        [vResult.user.id]
      );
      if (boundUsers.length === 0) {
        return fail(res, 401, '该VRChat账号未绑定本站账号，无法直接登录', { code: ErrorCodes.VRC_AUTH_FAILED, needBind: true, message: '该VRChat账号未绑定本站账号，请先完成本地账号注册/登录，然后在个人中心绑定VRChat账号后再使用VRChat登录。', vrchatUser: { id: vResult.user.id, displayName: vResult.user.displayName } });
      }
      const boundUser = boundUsers[0];

      if (boundUser.locked_until && new Date(boundUser.locked_until) > new Date()) {
        const lockMinutes = Math.ceil((new Date(boundUser.locked_until) - new Date()) / 60000);
        return fail(res, 423, `账户已被锁定，请${lockMinutes}分钟后再试`, { code: 'ACCOUNT_LOCKED', lockMinutes });
      }
      if (!boundUser.approved || boundUser.approved === 0) {
        return fail(res, 401, '账户待审核，请联系管理员', { code: ErrorCodes.ACCOUNT_PENDING });
      }

      const finalVrcName = vResult.user.displayName || boundUser.vrchat_name || '';
      boundUser.vrchat_name = finalVrcName;
      boundUser.vrchat_avatar_url = vResult.user.currentAvatarThumbnailImageUrl || vResult.user.userIcon || vResult.user.iconUrl || boundUser.vrchat_avatar_url || '';
      completeVrcLogin(req, res, boundUser, vResult.cookie, 'VRChat登录（已绑定快捷登录）', { bindStatus: true });
      return;
    }

    // ══════════ 模式 C：有 loginToken、无 code → 重发验证码══════════
    // 复用第一步（模式 A）建立的 2FA 会话，免重新输入账号密码；
    // 仅邮箱类验证（emailOtp/otp）可重发，TOTP 身份验证器不产生邮件验证码。
    if (loginToken && !code) {
      const state = loginTokens.get(loginToken);
      if (!state || state.expireAt < Date.now()) {
        if (state) loginTokens.delete(loginToken);
        return fail(res, 400, '登录会话已过期，请重新登录', { expired: true });
      }
      const emailMethods = (state.methods || []).filter((m) => m === 'emailOtp' || m === 'otp');
      if (emailMethods.length === 0) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '当前验证方式无需重发验证码');
      }
      try {
        await triggerVrcEmailOtp(state.cookie);
      } catch (e) {
        logger.warn('auth', '[vrchat-login] 重发邮件验证码失败', e.message);
      }
      // 顺延会话有效期，给用户完整输入窗口
      state.expireAt = Date.now() + 5 * 60 * 1000;
      return res.json({
        need2fa: true,
        loginToken,
        methods: state.methods,
        message: '验证码已重新发送到您的邮箱，请输入验证码'
      });
    }

    // ══════════ 模式 A：无 loginToken →第一步登录══════════
    if (!username || !password) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请输入VRChat用户名和密码');

    const login = await vrchatBasicLogin(username, password);
    if (login.status !== 200) {
      return fail(res, 401, login.data?.error?.message || 'VRChat登录失败', { code: ErrorCodes.VRC_AUTH_FAILED });
    }
    const vrcUser = login.data;
    const cookie = login.cookie;
    const needs2fa = login.needs2fa;

    // 🔴 P1 修复（docs/12）：VRChat /auth/user 在 2FA 待验证阶段不返回 id，
    // 此时查绑定必然查不到而误报"未绑定"。需要 2FA 的账号先进入 2FA 流程，
    // 验证通过拿到真实 id 后再查绑定（模式 B 已同步处理）。
    if (needs2fa) {
      const token = require('crypto').randomBytes(24).toString('hex');
      loginTokens.set(token, {
        cookie,
        vrcUser,
        methods: vrcUser.requiresTwoFactorAuth,
        expireAt: Date.now() + 5 * 60 * 1000, // 5 分钟有效
        failCount: 0 // P3-70: 2FA 验证码失败计数（≥MAX_2FA_ATTEMPTS 删除会话）
      });

      // 触发发送邮件验证码
      if (vrcUser.requiresTwoFactorAuth.includes('emailOtp')) {
        try {
          await triggerVrcEmailOtp(cookie);
        } catch(e) {
          logger.warn('auth', '[vrchat-login] 触发邮件验证码失败', e.message);
        }
      }

      return res.json({
        need2fa: true,
        loginToken: token,
        methods: vrcUser.requiresTwoFactorAuth,
        message: vrcUser.requiresTwoFactorAuth.includes('emailOtp') ? '验证码已发送到您的邮箱，请输入验证码' : '请输入 Authenticator 验证码'
      });
    }

    // 无 2FA → 按 VRChat ID 查绑定（此时 vrcUser.id 真实有效）
    const [boundUsers] = await getPool().query(
      `SELECT * FROM users WHERE vrchat_id = ? AND deleted_at IS NULL AND banned = 0`,
      [vrcUser.id]
    );

    // 未绑定 → 明确引导用户先注册本地账号再绑定
    if (boundUsers.length === 0) {
      return fail(res, 401, '该VRChat账号未绑定本站账号，无法直接登录', { code: ErrorCodes.VRC_AUTH_FAILED, needBind: true, message: '该VRChat账号未绑定本站账号，请先完成本地账号注册/登录，然后在个人中心绑定VRChat账号后再使用VRChat登录。', vrchatUser: { id: vrcUser.id, displayName: vrcUser.displayName } });
    }
    const boundUser = boundUsers[0];

    // 账户锁定检查
    if (boundUser.locked_until && new Date(boundUser.locked_until) > new Date()) {
      const lockMinutes = Math.ceil((new Date(boundUser.locked_until) - new Date()) / 60000);
      return fail(res, 423, `账户已被锁定，请${lockMinutes}分钟后再试`, { code: 'ACCOUNT_LOCKED', lockMinutes });
    }

    if (!boundUser.approved || boundUser.approved === 0) {
      return fail(res, 401, '账户待审核，请联系管理员', { code: ErrorCodes.ACCOUNT_PENDING });
    }

    // 不需要2FA →直接登录
    let avatarUrl = vrcUser.currentAvatarThumbnailImageUrl || vrcUser.userIcon || vrcUser.iconUrl || '';
    try {
      const profileRes = await vrchatGetUser(vrcUser.id, cookie);
      if (profileRes.status === 200) {
        const profile = profileRes.data;
        avatarUrl = profile.currentAvatarThumbnailImageUrl || profile.userIcon || profile.iconUrl || avatarUrl;
      }
    } catch (e) { logger.warn('auth', '[vrchat-login] 获取头像失败:', e.message); }

    const finalVrcName = vrcUser.displayName || boundUser.vrchat_name || '';
    boundUser.vrchat_name = finalVrcName;
    boundUser.vrchat_avatar_url = avatarUrl;
    completeVrcLogin(req, res, boundUser, cookie, 'VRChat登录（已绑定快捷登录）', { bindStatus: true });
  } catch (e) { handleError(res, e, '[auth/vrchat-login]'); }
});

// ==================== VRChat 独立 2FA 验证 ====================
// S2 修复：该端点此前只有 per-token 失败计数、无 per-IP 限流，
// 攻击者可用不同 loginToken 反复爆破验证码。按 IP 收紧到 15 分钟 10 次（对齐 vrc-login）。
const vrc2faLimiter = createCustomLimiter({
  name: 'vrc-2fa',
  max: 10,
  message: { error: '两步验证请求过于频繁，请稍后再试', retryAfter: 900 }
});
router.post('/vrchat-2fa', vrc2faLimiter, async (req, res) => {
  try {
    const { code, method, loginToken } = req.body;
    if (!code || code.length < 4) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请输入有效的验证码');
    if (!loginToken) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '缺少登录令牌，请重新登录');

    const state = loginTokens.get(loginToken);
    if (!state || state.expireAt < Date.now()) {
      if (state) loginTokens.delete(loginToken);
      return fail(res, 400, '登录会话已过期，请重新登录', { expired: true });
    }
    const { cookie, methods } = state;
    if (!methods.includes(method)) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '双重验证方式无效，请重新登录');

    const vResult = await verifyVrc2fa(code, method, cookie);
    if (!vResult.success) {
      // P3-70: 与 /vrchat-login 第二步同口径——每 token 累计失败，≥MAX 删除会话并告警
      const locked = _register2faFailure(loginToken, state);
      if (locked) {
        return fail(res, 429, '验证码错误次数过多，登录会话已失效，请重新登录', { code: '2FA_LOCKED', locked: true });
      }
      return fail(res, 401, vResult.error, { code: ErrorCodes.VRC_AUTH_FAILED, remaining: MAX_2FA_ATTEMPTS - state.failCount });
    }
    loginTokens.delete(loginToken);

    // 🔴 P1 修复（docs/12）：同上——2FA 验证通过拿到真实 id 后再查绑定
    if (!vResult.user || !vResult.user.id) {
      return fail(res, 401, '2FA 验证通过后 VRChat 未返回账号信息，请稍后重试', { code: ErrorCodes.VRC_AUTH_FAILED });
    }
    const [boundUsers] = await getPool().query(
      `SELECT * FROM users WHERE vrchat_id = ? AND deleted_at IS NULL AND banned = 0`,
      [vResult.user.id]
    );
    if (boundUsers.length === 0) {
      return fail(res, 401, '该VRChat账号未绑定本站账号，无法直接登录', { code: ErrorCodes.VRC_AUTH_FAILED, needBind: true, message: '该VRChat账号未绑定本站账号，请先完成本地账号注册/登录，然后在个人中心绑定VRChat账号后再使用VRChat登录。', vrchatUser: { id: vResult.user.id, displayName: vResult.user.displayName } });
    }
    const boundUser = boundUsers[0];

    if (boundUser.locked_until && new Date(boundUser.locked_until) > new Date()) {
      const lockMinutes = Math.ceil((new Date(boundUser.locked_until) - new Date()) / 60000);
      return fail(res, 423, `账户已被锁定，请${lockMinutes}分钟后再试`, { code: 'ACCOUNT_LOCKED', lockMinutes });
    }
    if (!boundUser.approved || boundUser.approved === 0) {
      return fail(res, 401, '账户待审核，请联系管理员', { code: ErrorCodes.ACCOUNT_PENDING });
    }

    const finalVrcName = vResult.user.displayName || boundUser.vrchat_name || '';
    boundUser.vrchat_name = finalVrcName;
    boundUser.vrchat_avatar_url = vResult.user.currentAvatarThumbnailImageUrl || vResult.user.userIcon || vResult.user.iconUrl || boundUser.vrchat_avatar_url || '';
    completeVrcLogin(req, res, boundUser, vResult.cookie, 'VRChat 2FA登录');
  } catch (e) { handleError(res, e, '[auth/vrchat-2fa]'); }
});

// ==================== VRChat 绑定（密码验证） ====================
// 绑定端点独立限流：密码验证 + 验证码确认 + 验证码重发三步都会打到本端点，
// passwordResetLimiter(15min/5次) 会误伤"重发验证码"等正常高频操作；
// 放宽到 15 分钟 30 次（需登录 + 上游 VRChat 自带限流兜底，防刷能力仍在）
const vrcBindLimiter = createCustomLimiter({
  name: 'vrc-bind',
  max: 30,
  message: { error: 'VRChat 绑定操作过于频繁，请稍后再试', retryAfter: 900 }
});
router.post('/vrchat-bind-verify', vrcBindLimiter, requireAuth, async (req, res) => {
  try {
    const { username, password, code, method, bindToken, resend } = req.body;
    let vrcUser, cookie;

    // 模式 A：有 bindToken → token 映射表恢复中间状态（2FA 第二步 / 重发验证码）
    if (bindToken) {
      const state = bindTokens.get(bindToken);
      if (!state) {
        return fail(res, 400, '验证会话已失效，请重新输入账号密码', { expired: true });
      }
      // 安全检验：确保是同一个用户
      if (state.userId !== req.session.userId) {
        bindTokens.delete(bindToken);
        return sendError(res, 403, ErrorCodes.FORBIDDEN, '验证会话不属于当前用户');
      }
      cookie = state.cookie;
      vrcUser = state.vrcUser;
    }
    // 模式 B：无 bindToken → 首次登录 2FA 第一步（或无需 2FA）
    else {
      if (!username || !password) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请输入VRChat用户名和密码');
      const login = await vrchatBasicLogin(username, password);
      if (login.status !== 200) {
        return fail(res, 401, login.data?.error?.message || 'VRChat 验证失败，请检查用户名和密码', { code: ErrorCodes.VRC_AUTH_FAILED });
      }
      vrcUser = login.data;
      cookie = login.cookie;
    }

    const needs2fa = Array.isArray(vrcUser?.requiresTwoFactorAuth) && vrcUser.requiresTwoFactorAuth.length > 0;

    // 🚨 V6.12 安全检查：有 bindToken 但没 code 且非重发 → 拒绝（防止绕过 2FA）
    if (needs2fa && !code && bindToken && !resend) {
      bindTokens.delete(bindToken);
      return fail(res, 400, '请输入验证码以完成两步验证', { expired: true });
    }

    // 重发验证码：已有 bindToken + resend 标记 → 重新触发邮件验证码（绑定不设时间限制）
    if (needs2fa && !code && bindToken && resend) {
      if (vrcUser.requiresTwoFactorAuth.includes('emailOtp')) {
        try {
          await triggerVrcEmailOtp(cookie);
        } catch(e) {
          logger.warn('auth', '[vrchat-bind-verify] 重发邮件验证码失败', e.message);
        }
        return res.json({
          need2fa: true,
          bindToken,
          methods: vrcUser.requiresTwoFactorAuth,
          message: '验证码已重新发送到您的邮箱，请输入验证码'
        });
      }
      // totp/otp 由验证器本地生成、定时轮换，无需重发
      return res.json({
        need2fa: true,
        bindToken,
        methods: vrcUser.requiresTwoFactorAuth,
        message: '请输入 Authenticator 验证码'
      });
    }

    // 需要2FA 且还没有验证码→发邮件+ 返回 bindToken
    if (needs2fa && !code && !bindToken) {
      // 生成临时 token（P2 修复：原 expireAt=null 永不过期，用户放弃流程会残留
      // token 致内存增长；现设 24h 有效期，清理循环按 expireAt 统一回收）
      const token = require('crypto').randomBytes(24).toString('hex');
      bindTokens.set(token, {
        cookie,
        vrcUser,
        userId: req.session.userId,
        expireAt: Date.now() + 24 * 60 * 60 * 1000 // 24 小时有效
      });

      // 触发发送邮件验证码
      if (vrcUser.requiresTwoFactorAuth.includes('emailOtp')) {
        try {
          await triggerVrcEmailOtp(cookie);
        } catch(e) {
          logger.warn('auth', '[vrchat-bind-verify] 触发邮件验证码失败', e.message);
        }
      }

      return res.json({
        need2fa: true,
        bindToken: token,
        methods: vrcUser.requiresTwoFactorAuth,
        message: vrcUser.requiresTwoFactorAuth.includes('emailOtp') ? '验证码已发送到您的邮箱，请输入验证码' : '请输入 Authenticator 验证码'
      });
    }

    // 有验证码 + bindToken → 验证 2FA
    if (needs2fa && code) {
      if (!vrcUser.requiresTwoFactorAuth.includes(method)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '双重验证方式无效，请重新验证');
      }
      const vResult = await verifyVrc2fa(code, method, cookie);
      if (!vResult.success) {
        if (bindToken) bindTokens.delete(bindToken);
        return fail(res, 401, vResult.error, { code: ErrorCodes.VRC_AUTH_FAILED });
      }
      cookie = vResult.cookie;
      if (vResult.user) Object.assign(vrcUser, vResult.user);
      // 2FA 验证成功，清除token
      if (bindToken) bindTokens.delete(bindToken);
    }

    const vrchatId = vrcUser.id;
    // VRChat 的 /auth/user 在需要 2FA 时返回的是 { requiresTwoFactorAuth:[...] }，
    // 响应体里没有 id / displayName —— 这些要等 2FA 通过后再调 /auth/user 拿。
    // 而 verifyVrc2fa 内部的 vrchatGetCurrentUser 失败时只 warn 并返回 null，
    // 于是 Object.assign(vrcUser, null) 静默无操作，vrcUser.id 依旧是 undefined。
    // 以前这里不做校验就直接 UPDATE，结果写进去 vrchat_id=NULL、vrchat_name=''，
    // 接口还回 success:true 说"绑定成功"，用户刷新后又被提示需要绑定。
    // 拿不到 ID 就必须失败，绝不能写库还报成功。
    if (!vrchatId) {
      logger.error('auth', '[vrchat-bind-verify] 未能获取 VRChat 用户 ID，中止绑定', {
        userId: req.session.userId,
        needs2fa,
        hasCode: !!code,
        vrcUserKeys: Object.keys(vrcUser || {}),
      });
      return sendError(res, 502, ErrorCodes.VRC_UPSTREAM_ERROR,
        '未能从 VRChat 获取账号信息，绑定未完成，请稍后重试');
    }

    const vrchatName = vrcUser.displayName || (username || '');
    const avatarUrl = vrcUser.currentAvatarThumbnailImageUrl || vrcUser.userIcon || vrcUser.iconUrl || '';

    // 检查该 VRChat ID 是否已被其他人绑定（含软删除用户——vrchat_id 带 UNIQUE 索引，
    // 软删除用户若未释放绑定仍会占住索引，导致下方 UPDATE 撞唯一键返回 500"服务器内部错误"）
    const [existing] = await getPool().query(
      `SELECT id, deleted_at FROM users WHERE vrchat_id = ? AND id != ?`,
      [vrchatId, req.session.userId]
    );
    if (existing.length > 0) {
      // 占用者是软删除（已注销）账号 → 该 VRChat ID 视为可继承，先行释放绑定再继续；
      // 只有活跃用户占用才真正拒绝绑定
      const released = [];
      const blockers = [];
      for (const row of existing) {
        if (row.deleted_at) released.push(row.id);
        else blockers.push(row.id);
      }
      if (released.length > 0) {
        await getPool().query(
          `UPDATE users SET vrchat_id = NULL, vrchat_name = NULL, vrchat_avatar_url = NULL, vrchat_verified = 0, updated_at = NOW() WHERE id IN (?)`,
          [released]
        );
        logger.info('auth', `[vrchat-bind-verify] 释放软删除用户占用的 VRChat 绑定: ${vrchatId} → user#${released.join(',')}`);
      }
      if (blockers.length > 0) return fail(res, 400, '该 VRChat 账号已被其他用户绑定');
    }

    // 检查当前用户是否已绑定其他 VRChat
    const [self] = await getPool().query(`SELECT vrchat_id FROM users WHERE id = ? AND deleted_at IS NULL`, [req.session.userId]);
    if (self.length > 0 && self[0].vrchat_id && self[0].vrchat_id !== vrchatId) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '您已绑定其他VRChat账号，请先解绑');

    // 加密 VRChat cookie → session（加密存储）；加密失败先于落库中止，绝不回退明文（与 auth_session buildSession 一致）
    const encryptedCookie = encryptCookie(cookie);
    if (!encryptedCookie) {
      return sendError(res, 500, ErrorCodes.INTERNAL_ERROR, 'VRChat Cookie 加密失败，请管理员检查 ENCRYPT_KEY 配置后重试');
    }

    // 更新绑定信息
    await getPool().query(
      `UPDATE users SET vrchat_id=?, vrchat_name=?, vrchat_avatar_url=?, avatar_type=?, updated_at=NOW() WHERE id=?`,
      [vrchatId, vrchatName, avatarUrl, avatarUrl ? 'vrchat' : 'none', req.session.userId]
    );

    // P3 修复：写入统一为 vrchatCookie（与 auth_session.buildSession 同字段；
    // 旧 vrcCookie 读取端仍兼容，见 vrc_auth.js `vrchatCookie || vrcCookie`）
    req.session.vrchatCookie = encryptedCookie;
    req.session.vrcCookieSetAt = Date.now(); // V8.2: 记录 cookie 设置时间（用于软性过期判断）
    req.session.vrcId = vrchatId;
    req.session.vrcName = vrchatName;

    // 检查群组成员身份
    let verified = false;
    try {
      const [roster] = await getPool().query(`SELECT 1 FROM group_roster WHERE vrchat_id = ? AND is_member = 1`, [vrchatId]);
      verified = roster.length > 0;
      if (verified) await getPool().query(`UPDATE users SET vrchat_verified = 1 WHERE id = ?`, [req.session.userId]);
    } catch(e) { logger.warn('auth', '[vrchat-bind-verify] 群组验证失败:', e.message); }

    // 更新 session
    req.session.vrchatId = vrchatId;
    req.session.vrchatName = vrchatName;
    req.session.vrchatVerified = verified;
    req.session.vrchatAvatarUrl = avatarUrl;
    if (avatarUrl) { req.session.avatarType = 'vrchat'; req.session.avatarUrl = avatarUrl; }

    // 💡 关键：显式保存session，确保cookie 被持久化
    await new Promise((resolve, reject) => {
      req.session.save((err) => {
        if (err) { logger.error('auth', '[vrchat-bind-verify] session.save 失败:', err); reject(err); }
        else resolve();
      });
    });

    await getPool().query(`INSERT INTO sys_oper_log (admin_vrcid, oper_type, content) VALUES (?, '密码绑定VRChat', ?)`,
      [req.session.loginId, `密码验证绑定: ${vrchatName}${verified ? ' (已验证群成员)' : ''}`]);

    ok(res, {
      user: sessionUser(req.session),
      message: verified ? '🎉 绑定成功！已通过群组验证' : '🎉 绑定成功'
    });
  } catch (e) {
    // M17 修复：并发场景下查重与 UPDATE 之间的竞态仍可能撞 vrchat_id 唯一键（errno 1062），
    // 捕获后返回友好的 409 提示，不再落入 500「服务器内部错误」
    if (e && (e.code === 'ER_DUP_ENTRY' || e.errno === 1062)) {
      logger.warn('auth', `[vrchat-bind-verify] VRChat 绑定唯一键冲突: ${e.message}`);
      return fail(res, 409, '该 VRChat 账号已被其他用户绑定', { code: 'VRC_ACCOUNT_BOUND' });
    }
    handleError(res, e, '[auth/vrchat-bind-verify]');
  }
});

// ==================== VRChat 解绑 ====================
router.post('/vrchat-unbind', requireAuth, async (req, res) => {
  try {
    const [users] = await getPool().query(`SELECT vrchat_id FROM users WHERE id = ? AND deleted_at IS NULL`, [req.session.userId]);
    if (users.length === 0 || !users[0].vrchat_id) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '未绑定VRChat账号');
    await getPool().query(`UPDATE users SET vrchat_id = NULL, vrchat_name = NULL, vrchat_avatar_url = NULL, vrchat_verified = 0, updated_at = NOW() WHERE id = ?`, [req.session.userId]);
    req.session.vrchatId = null;
    req.session.vrchatName = null;
    req.session.vrchatVerified = false;
    req.session.vrchatCookie = null;
    req.session.vrcCookie = null;
    req.session.vrcCookieSetAt = null;
    req.session.vrcId = null;
    req.session.vrcName = null;
    if (req.session.avatarType === 'vrchat') { req.session.avatarType = 'none'; req.session.avatarUrl = null; }
    await req.session.save();
    await getPool().query(`INSERT INTO sys_oper_log (admin_vrcid, oper_type, content) VALUES (?, '解绑VRChat', ?)`, [req.session.loginId, '解绑VRChat']);
    ok(res, { user: sessionUser(req.session), message: 'VRChat解绑成功' });
  } catch (e) { handleError(res, e, '[auth/vrchat-unbind]'); }
});
}

// §P2-148: verifyVrc2fa 导出（测试专用）——2FA 规范化/刷新分支此前零测试
module.exports = { registerVrcRoutes, verifyVrc2fa };
