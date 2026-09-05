/**
 * 境途同游 V5.2 — VRChat 认证业务层（auth.js 按域拆分）
 * 处理器收 (req, res)，随实现整体下沉：路由注册、限流/鉴权中间件与
 * 业务实现同文件维护，新增 VRChat 端点只改本文件。
 * routes/auth.js 通过 registerVrcRoutes(router) 原位委托注册。
 */
const {
  VRC_API_KEY,
  vrchatRequest,
  vrchatBasicLogin,
  vrchatGetCurrentUserResult,
  vrchatGetUser,
  vrchatVerifyTwoFactor
} = require('./vrc');
const { fail, ok, getPool, encryptCookie, handleError, sendError, ErrorCodes } = require('./utils');
const { passwordResetLimiter } = require('./middleware/rate_limit');
const { requireAuth } = require('./auth');
const logger = require('./logger');
const { buildSession, sessionUser } = require('./auth_session');

// ==================== VRChat 临时状态存储（绑定 + 登录）====================
// bindTokens: token →{ cookie, vrcUser, userId, expireAt }
// loginTokens: token →{ cookie, vrcUser, boundUser, expireAt }
// →token 替代 session 存储，避免session 持久化不可靠问题
const bindTokens = new Map();
const loginTokens = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [token, state] of bindTokens) {
    if (state.expireAt < now) bindTokens.delete(token);
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

// 路由注册委托：routes/auth.js 原位调用，四个端点连中间件一并注册
function registerVrcRoutes(router) {
// ==================== VRChat 登录（两步内联流程） ====================
// 第一→ POST { username, password } →需要验证码时返回{ need2fa, loginToken }
// 第二→ POST { code, loginToken } →验证码验证+ 完成登录
router.post('/vrchat-login', async (req, res) => {
  try {
    const { username, password, code, method, loginToken } = req.body;

    // ══════════ 模式 B：有 loginToken + code →第二步验证══════════
    if (loginToken && code) {
      const state = loginTokens.get(loginToken);
      if (!state || state.expireAt < Date.now()) {
        if (state) loginTokens.delete(loginToken);
        return fail(res, 400, '登录会话已过期，请重新发送验证码', { expired: true });
      }
      const { cookie, vrcUser, boundUser, methods } = state;
      if (!methods.includes(method)) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '双重验证方式无效，请重新登录');

      // 验证 2FA
      const vResult = await verifyVrc2fa(code, method, cookie);
      if (!vResult.success) {
        // 验证码错误不删除 token，允许重试
        return fail(res, 401, vResult.error);
      }
      loginTokens.delete(loginToken);

      const finalCookie = vResult.cookie;
      let avatarUrl = vrcUser.currentAvatarThumbnailImageUrl || vrcUser.userIcon || '';
      if (vResult.user) {
        avatarUrl = vResult.user.currentAvatarThumbnailImageUrl || vResult.user.userIcon || avatarUrl;
        // 只在真的拿到新名字时才覆盖：2FA 待验证阶段的响应体不含 displayName，
        // 无条件赋值会把已有的名字冲成 undefined，进而把 vrchat_name 写成 NULL。
        if (vResult.user.displayName) vrcUser.displayName = vResult.user.displayName;
      }
      // 同理，displayName 仍可能为空（上游没返回），此时保留库里的旧名字而不是清空。
      const finalVrcName = vrcUser.displayName || boundUser.vrchat_name || '';

      // 更新用户信息
      await getPool().query(`UPDATE users SET vrchat_name = ?, vrchat_avatar_url = ?, failed_login_attempts = 0, locked_until = NULL, updated_at = NOW() WHERE id = ?`, [finalVrcName, avatarUrl, boundUser.id]);
      boundUser.vrchat_name = finalVrcName;
      boundUser.vrchat_avatar_url = avatarUrl;

      req.session.regenerate(async (err) => {
        if (err) { handleError(res, err, 'auth'); return; }
        await buildSession(req, boundUser, finalCookie);
        await req.session.save();
        await getPool().query(`INSERT INTO sys_oper_log (admin_vrcid, oper_type, content) VALUES (?, 'VRC登录', ?)`, [boundUser.login_id, `${boundUser.display_name} VRChat登录`]);
        ok(res, { user: sessionUser(req.session), bindStatus: 'already_bound' });
      });
      return;
    }

    // ══════════ 模式 A：无 loginToken →第一步登录══════════
    if (!username || !password) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请输入VRChat用户名和密码');

    const login = await vrchatBasicLogin(username, password);
    if (login.status !== 200) {
      return fail(res, 401, login.data?.error?.message || 'VRChat登录失败');
    }
    const vrcUser = login.data;
    let cookie = login.cookie;
    const needs2fa = login.needs2fa;

    // 按 VRChat ID 查绑定
    const [boundUsers] = await getPool().query(
      `SELECT * FROM users WHERE vrchat_id = ? AND deleted_at IS NULL AND banned = 0`,
      [vrcUser.id]
    );

    // 未绑定 → 明确引导用户先注册本地账号再绑定
    if (boundUsers.length === 0) {
      return fail(res, 401, '该VRChat账号未绑定本站账号，无法直接登录', { needBind: true, message: '该VRChat账号未绑定本站账号，请先完成本地账号注册/登录，然后在个人中心绑定VRChat账号后再使用VRChat登录。', vrchatUser: { id: vrcUser.id, displayName: vrcUser.displayName } });
    }
    const boundUser = boundUsers[0];

    // 账户锁定检查
    if (boundUser.locked_until && new Date(boundUser.locked_until) > new Date()) {
      const lockMinutes = Math.ceil((new Date(boundUser.locked_until) - new Date()) / 60000);
      return fail(res, 423, `账户已被锁定，请${lockMinutes}分钟后再试`, { code: 'ACCOUNT_LOCKED', lockMinutes });
    }

    if (!boundUser.approved || boundUser.approved === 0) {
      return fail(res, 401, '账户待审核，请联系管理员', { code: 'ACCOUNT_PENDING' });
    }

    // 不需要2FA →直接登录
    if (!needs2fa) {
      let avatarUrl = vrcUser.currentAvatarThumbnailImageUrl || vrcUser.userIcon || '';
      try {
        const profileRes = await vrchatGetUser(vrcUser.id, cookie);
        if (profileRes.status === 200) {
          const profile = profileRes.data;
          avatarUrl = profile.currentAvatarThumbnailImageUrl || profile.userIcon || avatarUrl;
        }
      } catch (e) { logger.warn('auth', '[vrchat-login] 获取头像失败:', e.message); }

      const finalVrcName = vrcUser.displayName || boundUser.vrchat_name || '';
      await getPool().query(`UPDATE users SET vrchat_name = ?, vrchat_avatar_url = ?, failed_login_attempts = 0, locked_until = NULL, updated_at = NOW() WHERE id = ?`, [finalVrcName, avatarUrl, boundUser.id]);
      boundUser.vrchat_name = finalVrcName;
      boundUser.vrchat_avatar_url = avatarUrl;
      req.session.regenerate(async (err) => {
        if (err) { handleError(res, err, 'auth'); return; }
        await buildSession(req, boundUser, cookie);
        await req.session.save();
        await getPool().query(`INSERT INTO sys_oper_log (admin_vrcid, oper_type, content) VALUES (?, 'VRC登录', ?)`, [boundUser.login_id, `${boundUser.display_name} VRChat登录`]);
        ok(res, { user: sessionUser(req.session), bindStatus: 'already_bound' });
      });
      return;
    }

    // 需要2FA →生成 loginToken，触发邮件验证码，保存中间状态
    const token = require('crypto').randomBytes(24).toString('hex');
    loginTokens.set(token, {
      cookie,
      vrcUser,
      boundUser,
      methods: vrcUser.requiresTwoFactorAuth,
      expireAt: Date.now() + 5 * 60 * 1000 // 5 分钟有效
    });

    // 触发发送邮件验证码
    if (vrcUser.requiresTwoFactorAuth.includes('emailOtp')) {
      try {
        await vrchatRequest('POST', `/auth/twofactorauth/emailotp?apiKey=${VRC_API_KEY}`, {}, cookie);
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
  } catch (e) { handleError(res, e, '[auth/vrchat-login]'); }
});

// ==================== VRChat 独立 2FA 验证 ====================
router.post('/vrchat-2fa', async (req, res) => {
  try {
    const { code, method, loginToken } = req.body;
    if (!code || code.length < 4) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请输入有效的验证码');
    if (!loginToken) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '缺少登录令牌，请重新登录');

    const state = loginTokens.get(loginToken);
    if (!state || state.expireAt < Date.now()) {
      if (state) loginTokens.delete(loginToken);
      return fail(res, 400, '登录会话已过期，请重新登录', { expired: true });
    }
    const { cookie, vrcUser, boundUser, methods } = state;
    if (!methods.includes(method)) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '双重验证方式无效，请重新登录');

    const vResult = await verifyVrc2fa(code, method, cookie);
    if (!vResult.success) {
      return fail(res, 401, vResult.error);
    }
    loginTokens.delete(loginToken);

    const finalCookie = vResult.cookie;
    let avatarUrl = vrcUser.currentAvatarThumbnailImageUrl || vrcUser.userIcon || '';
    if (vResult.user) {
      avatarUrl = vResult.user.currentAvatarThumbnailImageUrl || vResult.user.userIcon || avatarUrl;
      // 同上：只在拿到新名字时才覆盖，否则会把已有名字冲成 undefined → 库里写成 NULL。
      if (vResult.user.displayName) vrcUser.displayName = vResult.user.displayName;
    }
    const finalVrcName = vrcUser.displayName || boundUser.vrchat_name || '';

    await getPool().query(`UPDATE users SET vrchat_name = ?, vrchat_avatar_url = ?, failed_login_attempts = 0, locked_until = NULL, updated_at = NOW() WHERE id = ?`, [finalVrcName, avatarUrl, boundUser.id]);
    boundUser.vrchat_name = finalVrcName;

    req.session.regenerate(async (err) => {
      if (err) { handleError(res, err, 'auth'); return; }
      await buildSession(req, boundUser, finalCookie);
      await req.session.save();
      await getPool().query(`INSERT INTO sys_oper_log (admin_vrcid, oper_type, content) VALUES (?, 'VRC登录', ?)`, [boundUser.login_id, `${boundUser.display_name} VRChat登录`]);
      ok(res, { user: sessionUser(req.session) });
    });
  } catch (e) { handleError(res, e, '[auth/vrchat-2fa]'); }
});

// ==================== VRChat 绑定（密码验证） ====================
router.post('/vrchat-bind-verify', passwordResetLimiter, requireAuth, async (req, res) => {
  try {
    const { username, password, code, method, bindToken } = req.body;
    let vrcUser, cookie;

    // 模式 A：有 bindToken → token 映射表恢复中间状态（2FA 第二步）
    if (bindToken) {
      const state = bindTokens.get(bindToken);
      if (!state || state.expireAt < Date.now()) {
        if (state) bindTokens.delete(bindToken);
        return fail(res, 400, '验证会话已过期，请重新输入账号密码', { expired: true });
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
        return fail(res, 401, login.data?.error?.message || 'VRChat 验证失败，请检查用户名和密码');
      }
      vrcUser = login.data;
      cookie = login.cookie;
    }

    const needs2fa = Array.isArray(vrcUser?.requiresTwoFactorAuth) && vrcUser.requiresTwoFactorAuth.length > 0;

    // 🚨 V6.12 安全检查：有 bindToken 但没 code → 拒绝（防止绕过 2FA）
    if (needs2fa && !code && bindToken) {
      bindTokens.delete(bindToken);
      return fail(res, 400, '请输入验证码以完成两步验证', { expired: true });
    }

    // 需要2FA 且还没有验证码→发邮件+ 返回 bindToken
    if (needs2fa && !code && !bindToken) {
      // 生成临时 token（5 分钟有效）
      const token = require('crypto').randomBytes(24).toString('hex');
      bindTokens.set(token, {
        cookie,
        vrcUser,
        userId: req.session.userId,
        expireAt: Date.now() + 5 * 60 * 1000
      });

      // 触发发送邮件验证码
      if (vrcUser.requiresTwoFactorAuth.includes('emailOtp')) {
        try {
          await vrchatRequest('POST', `/auth/twofactorauth/emailotp?apiKey=${VRC_API_KEY}`, {}, cookie);
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
        return fail(res, 401, vResult.error);
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
    const avatarUrl = vrcUser.currentAvatarThumbnailImageUrl || vrcUser.userIcon || '';

    // 检查该 VRChat ID 是否已被其他人绑定
    const [existing] = await getPool().query(`SELECT id, login_id FROM users WHERE vrchat_id = ? AND id != ? AND deleted_at IS NULL`, [vrchatId, req.session.userId]);
    if (existing.length > 0) return fail(res, 400, `该VRChat账号已被用户 ${existing[0].login_id} 绑定`);

    // 检查当前用户是否已绑定其他 VRChat
    const [self] = await getPool().query(`SELECT vrchat_id FROM users WHERE id = ? AND deleted_at IS NULL`, [req.session.userId]);
    if (self.length > 0 && self[0].vrchat_id && self[0].vrchat_id !== vrchatId) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '您已绑定其他VRChat账号，请先解绑');

    // 更新绑定信息
    await getPool().query(
      `UPDATE users SET vrchat_id=?, vrchat_name=?, vrchat_avatar_url=?, avatar_type=?, updated_at=NOW() WHERE id=?`,
      [vrchatId, vrchatName, avatarUrl, avatarUrl ? 'vrchat' : 'none', req.session.userId]
    );

    // 存储 VRChat cookie →session（加密存储）
    req.session.vrcCookie = encryptCookie(cookie) || cookie;
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
  } catch (e) { handleError(res, e, '[auth/vrchat-bind-verify]'); }
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

module.exports = { registerVrcRoutes };
