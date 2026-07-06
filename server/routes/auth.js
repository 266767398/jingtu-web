/**
 * 境途同→V5.2 →认证路由
 * 本地密码登录 + VRChat 双轨登录 + /init 引导
 */
const express = require('express');
const router = express.Router();
const {
  hashPassword, verifyPassword, validatePasswordStrength,
  requireAuth, ROLE_LABELS
} = require('../auth');
const { VRC_API, VRC_API_KEY, vrchatRequest, vrchatBasicLogin, vrchatGetCurrentUser } = require('../vrc');
const { getPool, safeError, encryptCookie } = require('../utils');

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
}, 60000); // 每分钟清理过期token

/**
 * 统一 VRChat 2FA 验证（消除三重复代码）
 * @param {string} code 用户输入的验证码
 * @param {string} cookie VRChat cookie
 * @param {object} [opts]
 * @param {boolean} [opts.refreshUser=true] 是否在验证后获取最新用户信息
 * @returns {{ success: boolean, cookie: string, user?: object, error?: string }}
 */
async function verifyVrc2fa(code, cookie, opts = {}) {
  const { refreshUser = true } = opts;
  let twoFaRes = await vrchatRequest('POST', `/auth/twofactorauth/totp/verify?apiKey=${VRC_API_KEY}`, { code: code.trim() }, cookie);
  if (twoFaRes.status !== 200) {
    twoFaRes = await vrchatRequest('POST', `/auth/twofactorauth/emailotp/verify?apiKey=${VRC_API_KEY}`, { code: code.trim() }, cookie);
  }
  if (twoFaRes.status !== 200) return { success: false, error: '验证码错误' };
  let finalCookie = cookie;
  if (twoFaRes.setCookie?.length > 0) finalCookie = twoFaRes.setCookie.join('; ');
  let user = null;
  if (refreshUser) {
    try { user = await vrchatGetCurrentUser(finalCookie); } catch (e) { console.warn('[verifyVrc2fa] 获取用户信息失败:', e.message); }
  }
  return { success: true, cookie: finalCookie, user };
}

// 从用户记录构建session
function buildSession(req, user, vrchatCookie) {
  req.session.loggedIn = true;
  req.session.userId = user.id;
  req.session.loginId = user.login_id;
  req.session.displayName = user.display_name;
  req.session.vrchatId = user.vrchat_id || null;
  req.session.vrchatName = user.vrchat_name || null;
  req.session.vrchatVerified = !!user.vrchat_verified;
  req.session.vrchatAvatarUrl = user.vrchat_avatar_url || null;
  req.session.role = user.role;
  req.session.avatarType = user.avatar_type || 'none';
  req.session.avatarUrl = user.avatar_type === 'custom'
    ? user.custom_avatar_path
    : (user.vrchat_avatar_url || null);
  if (vrchatCookie) {
    req.session.vrchatCookie = encryptCookie(vrchatCookie) || vrchatCookie;
  }
}

function sessionUser(session) {
  if (!session || (session.userId === undefined)) return null;
  return {
    id: session.userId,
    loginId: session.loginId,
    displayName: session.displayName,
    vrchatId: session.vrchatId,
    vrchatName: session.vrchatName,
    vrchatVerified: !!session.vrchatVerified,
    vrchatAvatarUrl: session.vrchatAvatarUrl || null,
    role: session.role,
    roleLabel: ROLE_LABELS[session.role] || '未知',
    avatarType: session.avatarType,
    avatarUrl: session.avatarUrl
  };
}

// ==================== /init 首次启动引导 ====================
router.get('/init', async (req, res) => {
  try {
    const [rows] = await getPool().query(
      `SELECT COUNT(*) as cnt FROM users WHERE role = 'super_admin' AND deleted_at IS NULL`
    );
    const needInit = rows[0].cnt === 0;
    res.json({ needInit, message: needInit ? '尚未创建超级管理员，请初始化' : '系统已就绪' });
  } catch (e) {
    res.status(500).json({ error: safeError(e.message) });
  }
});

router.post('/init', async (req, res) => {
  try {
    const [existing] = await getPool().query(
      `SELECT COUNT(*) as cnt FROM users WHERE role = 'super_admin' AND deleted_at IS NULL`
    );
    if (existing[0].cnt > 0) {
      return res.status(400).json({ error: '超级管理员已存在' });
    }
    const { loginId, password, displayName } = req.body;
    if (!loginId || !password) return res.status(400).json({ error: '请输入登录ID和密码' });
    if (!displayName) return res.status(400).json({ error: '请输入显示名' });
    const strength = validatePasswordStrength(password);
    if (!strength.valid) return res.status(400).json({ error: '密码强度不足', details: strength.errors });
    const [dup] = await getPool().query(`SELECT id FROM users WHERE login_id = ?`, [loginId]);
    if (dup.length > 0) return res.status(400).json({ error: '该登录ID已被使用' });
    const pwdHash = await hashPassword(password);
    const [result] = await getPool().query(
      `INSERT INTO users (login_id, display_name, password_hash, role, avatar_type) VALUES (?, ?, ?, 'super_admin', 'none')`,
      [loginId, displayName, pwdHash]
    );
    await getPool().query(`INSERT INTO sys_oper_log (admin_vrcid, oper_type, content) VALUES (?, '系统初始化', ?)`, [loginId, `创建首个超管: ${loginId}`]);
    const user = { id: result.insertId, login_id: loginId, display_name: displayName, vrchat_id: null, vrchat_name: null, vrchat_verified: 0, role: 'super_admin', avatar_type: 'none', vrchat_avatar_url: null, custom_avatar_path: null };
    req.session.regenerate(async (err) => {
      if (err) return res.status(500).json({ error: '初始化失败' });
      await buildSession(req, user);
      await req.session.save();
      res.json({ success: true, user: sessionUser(req.session), message: '超级管理员创建成功' });
    });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: '该登录ID已被使用' });
    res.status(500).json({ error: safeError(e.message) });
  }
});

// ==================== 本地密码登录 ====================
router.post('/login', async (req, res) => {
  try {
    const { loginId, password } = req.body;
    if (!loginId || !password) return res.status(400).json({ error: '请输入登录ID和密码' });
    const [users] = await getPool().query(`SELECT * FROM users WHERE (login_id = ? OR display_name = ?) AND deleted_at IS NULL AND banned = 0`, [loginId, loginId]);
    if (users.length === 0) return res.status(401).json({ error: '登录失败，请检查登录ID和密码', code: 'LOGIN_FAILED' });
    const user = users[0];

    // 账户锁定检查
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const lockMinutes = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      return res.status(423).json({ error: `账户已被锁定，请${lockMinutes}分钟后再试`, code: 'ACCOUNT_LOCKED', lockMinutes });
    }

    if (!user.password_hash) return res.status(401).json({ error: '该账号未设置密码，请使用VRChat登录' });
    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      // 登录失败 → 递增失败计数并可能锁定
      const newAttempts = (user.failed_login_attempts || 0) + 1;
      if (newAttempts >= 5) {
        await getPool().query(`UPDATE users SET failed_login_attempts = ?, locked_until = DATE_ADD(NOW(), INTERVAL 15 MINUTE) WHERE id = ?`, [newAttempts, user.id]);
        console.warn(`[SEC] 账户 ${user.login_id} 已锁定（${newAttempts} 次失败）`);
        return res.status(423).json({ error: '登录失败次数过多，账户已被锁定15分钟', code: 'ACCOUNT_LOCKED', lockMinutes: 15 });
      }
      await getPool().query(`UPDATE users SET failed_login_attempts = ? WHERE id = ?`, [newAttempts, user.id]);
      return res.status(401).json({ error: '登录失败，请检查登录ID和密码', code: 'LOGIN_FAILED' });
    }

    // 登录成功 → 重置失败计数和锁定
    await getPool().query(`UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?`, [user.id]);

    // 重新生成session防止session固定攻击
    req.session.regenerate(async (err) => {
      if (err) return res.status(500).json({ error: '登录失败' });
      await buildSession(req, user);
      await req.session.save();
      await getPool().query(`INSERT INTO sys_oper_log (admin_vrcid, oper_type, content) VALUES (?, '用户登录', ?)`, [user.login_id, `${user.display_name} 登录`]);
      res.json({ success: true, user: sessionUser(req.session) });
    });
  } catch (e) { console.error('[login]', e); res.status(500).json({ error: safeError('登录失败: ' + e.message) }); }
});

// (游客登录已移除- 2026-06-22)

// ==================== 退出登录====================
router.post('/logout', async (req, res) => {
  if (req.session) {
    req.session.destroy(err => {
      if (err) return res.status(500).json({ error: '退出失败' });
      // 必须指定相同→path/httpOnly/sameSite 参数才能正确清除 cookie
      res.clearCookie('connect.sid', { path: '/', httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
      res.json({ success: true });
    });
  } else { res.json({ success: true }); }
});

// ==================== 获取当前会话 ====================
router.get('/session', (req, res) => {
  const user = sessionUser(req.session);
  res.json({ loggedIn: !!user, user });
});

// ==================== 修改密码 ====================
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) return res.status(400).json({ error: '请输入旧密码和新密码' });
    const [users] = await getPool().query(`SELECT password_hash FROM users WHERE id = ? AND deleted_at IS NULL`, [req.session.userId]);
    if (users.length === 0) return res.status(404).json({ error: '用户不存在' });
    if (users[0].password_hash) {
      const valid = await verifyPassword(oldPassword, users[0].password_hash);
      if (!valid) return res.status(400).json({ error: '旧密码错误' });
    }
    const strength = validatePasswordStrength(newPassword);
    if (!strength.valid) return res.status(400).json({ error: '新密码强度不足', details: strength.errors });
    const newHash = await hashPassword(newPassword);
    await getPool().query(`UPDATE users SET password_hash = ? WHERE id = ?`, [newHash, req.session.userId]);
    await getPool().query(`INSERT INTO sys_oper_log (admin_vrcid, oper_type, content) VALUES (?, '修改密码', ?)`, [req.session.userId, `用户 ${req.session.userId} 修改密码`]);
    res.json({ success: true, message: '密码修改成功' });
  } catch (e) { console.error('[change-password]', e); res.status(500).json({ error: safeError(e.message) }); }
});

// ==================== VRChat 登录（两步内联流程） ====================
// 第一→ POST { username, password } →需要验证码时返回{ need2fa, loginToken }
// 第二→ POST { code, loginToken } →验证码验证+ 完成登录
router.post('/vrchat-login', async (req, res) => {
  try {
    const { username, password, code, loginToken } = req.body;

    // ══════════ 模式 B：有 loginToken + code →第二步验证══════════
    if (loginToken && code) {
      const state = loginTokens.get(loginToken);
      if (!state || state.expireAt < Date.now()) {
        if (state) loginTokens.delete(loginToken);
        return res.status(400).json({ error: '登录会话已过期，请重新发送验证码', expired: true });
      }
      const { cookie, vrcUser, boundUser } = state;

      // 验证 2FA
      const vResult = await verifyVrc2fa(code, cookie);
      if (!vResult.success) {
        // 验证码错误不删除 token，允许重试        return res.status(401).json({ error: vResult.error });
      }
      loginTokens.delete(loginToken);

      const finalCookie = vResult.cookie;
      const finalVrcId = vResult.user?.id || vrcUser.id;
      let avatarUrl = vrcUser.currentAvatarThumbnailImageUrl || vrcUser.userIcon || '';
      if (vResult.user) {
        avatarUrl = vResult.user.currentAvatarThumbnailImageUrl || vResult.user.userIcon || avatarUrl;
        vrcUser.displayName = vResult.user.displayName;
      }

      // 更新用户信息
      await getPool().query(`UPDATE users SET vrchat_name = ?, vrchat_avatar_url = ?, failed_login_attempts = 0, locked_until = NULL, updated_at = NOW() WHERE id = ?`, [vrcUser.displayName, avatarUrl, boundUser.id]);
      boundUser.vrchat_name = vrcUser.displayName;
      boundUser.vrchat_avatar_url = avatarUrl;

      req.session.regenerate(async (err) => {
        if (err) return res.status(500).json({ error: '登录失败' });
        await buildSession(req, boundUser, finalCookie);
        await req.session.save();
        await getPool().query(`INSERT INTO sys_oper_log (admin_vrcid, oper_type, content) VALUES (?, 'VRC登录', ?)`, [boundUser.login_id, `${boundUser.display_name} VRChat登录`]);
        res.json({ success: true, user: sessionUser(req.session), bindStatus: 'already_bound' });
      });
      return;
    }

    // ══════════ 模式 A：无 loginToken →第一步登录══════════
    if (!username || !password) return res.status(400).json({ error: '请输入VRChat用户名和密码' });

    const login = await vrchatBasicLogin(username, password);
    if (login.status !== 200) {
      return res.status(401).json({ error: login.data?.error?.message || 'VRChat登录失败' });
    }
    const vrcUser = login.data;
    let cookie = login.cookie;
    const needs2fa = login.needs2fa;

    // 按 VRChat ID 查绑定
    const [boundUsers] = await getPool().query(
      `SELECT * FROM users WHERE vrchat_id = ? AND deleted_at IS NULL AND banned = 0`,
      [vrcUser.id]
    );

    // 未绑定 → 告知用户先绑定
    if (boundUsers.length === 0) {
      return res.json({
        needBind: true,
        message: '该 VRChat 账号未绑定到本站账号，请先在个人中心绑定后再登录',
        vrchatUser: { id: vrcUser.id, displayName: vrcUser.displayName }
      });
    }
    const boundUser = boundUsers[0];

    // 账户锁定检查
    if (boundUser.locked_until && new Date(boundUser.locked_until) > new Date()) {
      const lockMinutes = Math.ceil((new Date(boundUser.locked_until) - new Date()) / 60000);
      return res.status(423).json({ error: `账户已被锁定，请${lockMinutes}分钟后再试`, code: 'ACCOUNT_LOCKED', lockMinutes });
    }

    // 不需要2FA →直接登录
    if (!needs2fa) {
      let avatarUrl = vrcUser.currentAvatarThumbnailImageUrl || vrcUser.userIcon || '';
      try {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 10000);
        try {
          const res2 = await fetch(`${VRC_API}/users/${vrcUser.id}?apiKey=${VRC_API_KEY}`, { headers: { 'User-Agent': 'JingTuWeb/5.2', 'Cookie': cookie }, signal: ac.signal });
          if (res2.ok) { const profile = await res2.json(); avatarUrl = profile.currentAvatarThumbnailImageUrl || profile.userIcon || avatarUrl; }
        } finally { clearTimeout(t); }
      } catch (e) { console.warn('[vrchat-login] 获取头像失败:', e.message); }

      await getPool().query(`UPDATE users SET vrchat_name = ?, vrchat_avatar_url = ?, failed_login_attempts = 0, locked_until = NULL, updated_at = NOW() WHERE id = ?`, [vrcUser.displayName, avatarUrl, boundUser.id]);
      boundUser.vrchat_name = vrcUser.displayName;
      boundUser.vrchat_avatar_url = avatarUrl;
      req.session.regenerate(async (err) => {
        if (err) return res.status(500).json({ error: '登录失败' });
        await buildSession(req, boundUser, cookie);
        await req.session.save();
        await getPool().query(`INSERT INTO sys_oper_log (admin_vrcid, oper_type, content) VALUES (?, 'VRC登录', ?)`, [boundUser.login_id, `${boundUser.display_name} VRChat登录`]);
        res.json({ success: true, user: sessionUser(req.session), bindStatus: 'already_bound' });
      });
      return;
    }

    // 需要2FA →生成 loginToken，触发邮件验证码，保存中间状态    const token = require('crypto').randomBytes(24).toString('hex');
    loginTokens.set(token, {
      cookie,
      vrcUser,
      boundUser,
      expireAt: Date.now() + 5 * 60 * 1000 // 5 分钟有效
    });

    // 触发发送邮件验证码
    if (vrcUser.requiresTwoFactorAuth.includes('emailOtp')) {
      try {
        await vrchatRequest('POST', `/auth/twofactorauth/emailotp?apiKey=${VRC_API_KEY}`, {}, cookie);
      } catch(e) {
        console.warn('[vrchat-login] 触发邮件验证码失败', e.message);
      }
    }

    return res.json({
      need2fa: true,
      loginToken: token,
      methods: vrcUser.requiresTwoFactorAuth,
      message: vrcUser.requiresTwoFactorAuth.includes('emailOtp') ? '验证码已发送到您的邮箱，请输入验证码' : '请输入 Authenticator 验证码'
    });
  } catch (e) { console.error('[vrchat-login]', e); res.status(500).json({ error: safeError('VRChat登录失败: ' + e.message) }); }
});

// ==================== VRChat 绑定（密码验证） ====================
router.post('/vrchat-bind-verify', requireAuth, async (req, res) => {
  try {
    const { username, password, code, bindToken } = req.body;
    let vrcUser, cookie;

    // 模式 A：有 bindToken → token 映射表恢复中间状态（2FA 第二步）
    if (bindToken) {
      const state = bindTokens.get(bindToken);
      if (!state || state.expireAt < Date.now()) {
        if (state) bindTokens.delete(bindToken);
        return res.status(400).json({ error: '验证会话已过期，请重新输入账号密码', expired: true });
      }
      // 安全检验：确保是同一个用户
      if (state.userId !== req.session.userId) {
        bindTokens.delete(bindToken);
        return res.status(403).json({ error: '验证会话不属于当前用户' });
      }
      cookie = state.cookie;
      vrcUser = state.vrcUser;
    }
    // 模式 B：无 bindToken → 首次登录 2FA 第一步（或无需 2FA）
    else {
      if (!username || !password) return res.status(400).json({ error: '请输入VRChat用户名和密码' });
      const login = await vrchatBasicLogin(username, password);
      if (login.status !== 200) {
        return res.status(401).json({ error: login.data?.error?.message || 'VRChat 验证失败，请检查用户名和密码' });
      }
      vrcUser = login.data;
      cookie = login.cookie;
    }

    const needs2fa = Array.isArray(vrcUser?.requiresTwoFactorAuth) && vrcUser.requiresTwoFactorAuth.length > 0;

    // 🚨 V6.12 安全检查：有 bindToken 但没 code → 拒绝（防止绕过 2FA）
    if (needs2fa && !code && bindToken) {
      bindTokens.delete(bindToken);
      return res.status(400).json({ error: '请输入验证码以完成两步验证', expired: true });
    }

    // 需要2FA 且还没有验证码→发邮件+ 返回 bindToken
    if (needs2fa && !code && !bindToken) {
      // 生成临时 token（5 分钟有效）      const token = require('crypto').randomBytes(24).toString('hex');
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
          console.warn('[vrchat-bind-verify] 触发邮件验证码失败', e.message);
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
      const vResult = await verifyVrc2fa(code, cookie);
      if (!vResult.success) {
        if (bindToken) bindTokens.delete(bindToken);
        return res.status(401).json({ error: vResult.error });
      }
      cookie = vResult.cookie;
      if (vResult.user) Object.assign(vrcUser, vResult.user);
      // 2FA 验证成功，清除token
      if (bindToken) bindTokens.delete(bindToken);
    }

    const vrchatId = vrcUser.id;
    const vrchatName = vrcUser.displayName || (username || '');
    const avatarUrl = vrcUser.currentAvatarThumbnailImageUrl || vrcUser.userIcon || '';

    // 检查该 VRChat ID 是否已被其他人绑定    const [existing] = await getPool().query(`SELECT id, login_id FROM users WHERE vrchat_id = ? AND id != ? AND deleted_at IS NULL`, [vrchatId, req.session.userId]);
    if (existing.length > 0) return res.status(400).json({ error: `该VRChat账号已被用户 ${existing[0].login_id} 绑定` });

    // 检查当前用户是否已绑定其他 VRChat
    const [self] = await getPool().query(`SELECT vrchat_id FROM users WHERE id = ? AND deleted_at IS NULL`, [req.session.userId]);
    if (self.length > 0 && self[0].vrchat_id && self[0].vrchat_id !== vrchatId) return res.status(400).json({ error: '您已绑定其他VRChat账号，请先解绑' });

    // 更新绑定信息
    await getPool().query(
      `UPDATE users SET vrchat_id=?, vrchat_name=?, vrchat_avatar_url=?, avatar_type=?, updated_at=NOW() WHERE id=?`,
      [vrchatId, vrchatName, avatarUrl, avatarUrl ? 'vrchat' : 'none', req.session.userId]
    );

    // 存储 VRChat cookie →session（加密存储）
    req.session.vrcCookie = encryptCookie(cookie) || cookie;
    req.session.vrcId = vrchatId;
    req.session.vrcName = vrchatName;

    // 检查群组成员身份    let verified = false;
    try {
      const [roster] = await getPool().query(`SELECT 1 FROM group_roster WHERE vrchat_id = ? AND is_member = 1`, [vrchatId]);
      verified = roster.length > 0;
      if (verified) await getPool().query(`UPDATE users SET vrchat_verified = 1 WHERE id = ?`, [req.session.userId]);
    } catch(e) { console.warn('[vrchat-bind-verify] 群组验证失败:', e.message); }

    // 更新 session
    req.session.vrchatId = vrchatId;
    req.session.vrchatName = vrchatName;
    req.session.vrchatVerified = verified;
    req.session.vrchatAvatarUrl = avatarUrl;
    if (avatarUrl) { req.session.avatarType = 'vrchat'; req.session.avatarUrl = avatarUrl; }

    // 💡 关键：显式保存session，确保cookie 被持久化
    await new Promise((resolve, reject) => {
      req.session.save((err) => {
        if (err) { console.error('[vrchat-bind-verify] session.save 失败:', err); reject(err); }
        else resolve();
      });
    });

    await getPool().query(`INSERT INTO sys_oper_log (admin_vrcid, oper_type, content) VALUES (?, '密码绑定VRChat', ?)`,
      [req.session.loginId, `密码验证绑定: ${vrchatName}${verified ? ' (已验证群成员)' : ''}`]);

    res.json({
      success: true,
      user: sessionUser(req.session),
      message: verified ? '🎉 绑定成功！已通过群组验证' : '🎉 绑定成功'
    });
  } catch (e) { console.error('[vrchat-bind-verify]', e); res.status(500).json({ error: safeError('绑定失败: ' + e.message) }); }
});

// ==================== VRChat 解绑 ====================
router.post('/vrchat-unbind', requireAuth, async (req, res) => {
  try {
    const [users] = await getPool().query(`SELECT vrchat_id FROM users WHERE id = ? AND deleted_at IS NULL`, [req.session.userId]);
    if (users.length === 0 || !users[0].vrchat_id) return res.status(400).json({ error: '未绑定VRChat账号' });
    await getPool().query(`UPDATE users SET vrchat_id = NULL, vrchat_name = NULL, vrchat_avatar_url = NULL, vrchat_verified = 0, updated_at = NOW() WHERE id = ?`, [req.session.userId]);
    req.session.vrchatId = null;
    req.session.vrchatName = null;
    req.session.vrchatVerified = false;
    req.session.vrchatCookie = null;
    if (req.session.avatarType === 'vrchat') { req.session.avatarType = 'none'; req.session.avatarUrl = null; }
    await req.session.save();
    await getPool().query(`INSERT INTO sys_oper_log (admin_vrcid, oper_type, content) VALUES (?, '解绑VRChat', ?)`, [req.session.loginId, '解绑VRChat']);
    res.json({ success: true, user: sessionUser(req.session), message: 'VRChat解绑成功' });
  } catch (e) { console.error('[vrchat-unbind]', e); res.status(500).json({ error: safeError('解绑失败: ' + e.message) }); }
});

module.exports = router;
