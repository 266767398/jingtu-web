/**
 * @swagger
 * tags:
 *   name: Auth
 *   description: 用户认证相关接口
 */

/**
 * 境途同游 V5.2 — 认证路由
 * 本地密码登录 + VRChat 双轨登录 + /init 引导
 */
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const {
  hashPassword, verifyPassword, validatePasswordStrength,
  requireAuth, ROLE_LABELS
} = require('../auth');
const {
  VRC_API_KEY,
  vrchatRequest,
  vrchatBasicLogin,
  vrchatGetCurrentUserResult,
  vrchatGetUser,
  vrchatVerifyTwoFactor
} = require('../vrc');
const { getPool, safeError, encryptCookie, handleError, sendError, ErrorCodes, createErr, getAvatarUrl } = require('../utils');
const { passwordResetLimiter, createCustomLimiter } = require('../middleware/rate_limit');
const logger = require('../logger');
const mailer = require('../mailer');

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
    const encrypted = encryptCookie(vrchatCookie);
    if (!encrypted) throw new Error('cookie 加密失败');
    req.session.vrchatCookie = encrypted;
    req.session.vrcCookieSetAt = Date.now(); // V8.2: 记录 cookie 设置时间（用于软性过期判断）
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

/**
 * @swagger
 * /api/auth/init:
 *   get:
 *     summary: 检查系统初始化状态
 *     description: 检查是否已创建超级管理员，用于首次启动引导
 *     tags: [Auth]
 *     responses:
 *       200:
 *         description: 初始化状态
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 needInit:
 *                   type: boolean
 *                   description: 是否需要初始化
 *                 message:
 *                   type: string
 *                   description: 状态消息
 */
router.get('/init', async (req, res) => {
  try {
    const [rows] = await getPool().query(
      `SELECT COUNT(*) as cnt FROM users WHERE role = 'super_admin' AND deleted_at IS NULL`
    );
    const needInit = rows[0].cnt === 0;
    res.json({ needInit, message: needInit ? '尚未创建超级管理员，请初始化' : '系统已就绪' });
  } catch (e) {
    handleError(res, e, '[auth/check]');
  }
});

router.post('/init', async (req, res) => {
  try {
    const ENV_PATH = path.join(__dirname, '..', '..', '.env');
    // 先确认是否已有超级管理员：已存在则直接拒绝，且「绝不」在此生成/轮换 .env 的
    // SESSION_SECRET / ENCRYPT_KEY。否则当「数据库已初始化、但 .env 意外丢失」时，
    // 任意一次 /init 调用都会静默重生成加密密钥，导致现有会话全部失效、历史加密数据
    // （VRChat 令牌、加密 cookie 等）无法解密，站点实质性损坏。
    const [existing] = await getPool().query(
      `SELECT COUNT(*) as cnt FROM users WHERE role = 'super_admin' AND deleted_at IS NULL`
    );
    if (existing[0].cnt > 0) {
      // .env 缺失但超管已存在：属于「配置损坏」态，应交由建站引导（/api/setup）修复，
      // 而不是在 /init 里偷偷轮换密钥把站点搞坏。
      if (!fs.existsSync(ENV_PATH)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST,
          '系统已初始化，但站点配置文件(.env)缺失。请恢复 .env，或登录后重走建站引导修复，切勿重复初始化。');
      }
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '超级管理员已存在');
    }
    // 真正首次部署（无超管 + .env 缺失）才用当前运行连接池配置自动补全 .env；
    // 密码取自运行中连接池的实际配置，SESSION_SECRET / ENCRYPT_KEY 重新生成。
    if (!fs.existsSync(ENV_PATH)) {
      try {
        const { DB_CONFIG: activeDb, DB_NAME: activeDbName } = require('../db');
        const envLines = [
          '# 自动补全的最小配置（由 /api/auth/init 生成）',
          `MYSQL_HOST=${activeDb.host || '127.0.0.1'}`,
          `MYSQL_PORT=${activeDb.port || 3306}`,
          `MYSQL_USER=${activeDb.user || 'root'}`,
          `MYSQL_PASSWORD=${activeDb.password || ''}`,
          `MYSQL_DATABASE=${activeDbName || process.env.MYSQL_DATABASE || 'jingtu_group'}`,
          `SESSION_SECRET=${crypto.randomBytes(48).toString('hex')}`,
          `ENCRYPT_KEY=${crypto.randomBytes(48).toString('hex')}`,
          `RECOVERY_TOKEN=${crypto.randomBytes(32).toString('hex')}`,
          'NODE_ENV=production',
          'PORT=3456',
          'LOG_LEVEL=INFO'
        ].join('\n');
        fs.writeFileSync(ENV_PATH, envLines + '\n');
        console.log('[auth/init] .env 不存在，已用当前运行配置自动补全');
      } catch (ensureErr) {
        return handleError(res, ensureErr, '[auth/init-ensureEnv]');
      }
    }
    const { loginId, password, displayName } = req.body;
    if (!loginId || !password) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请输入登录ID和密码');
    if (!displayName) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请输入显示名');
    const strength = validatePasswordStrength(password);
    if (!strength.valid) return res.status(400).json({ error: '密码强度不足', details: strength.errors });
    const [dup] = await getPool().query(`SELECT id FROM users WHERE login_id = ?`, [loginId]);
    if (dup.length > 0) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '该登录ID已被使用');
    const pwdHash = await hashPassword(password);
    const [result] = await getPool().query(
      `INSERT INTO users (login_id, display_name, password_hash, role, avatar_type, approved)
       VALUES (?, ?, ?, 'super_admin', 'none', 1)`,
      [loginId, displayName, pwdHash]
    );
    await getPool().query(`INSERT INTO sys_oper_log (admin_vrcid, oper_type, content) VALUES (?, '系统初始化', ?)`, [loginId, `创建首个超管: ${loginId}`]);
    const user = { id: result.insertId, login_id: loginId, display_name: displayName, vrchat_id: null, vrchat_name: null, vrchat_verified: 0, role: 'super_admin', avatar_type: 'none', vrchat_avatar_url: null, custom_avatar_path: null };
    req.session.regenerate(async (err) => {
      if (err) { handleError(res, err, 'auth'); return; }
      await buildSession(req, user);
      await req.session.save();
      res.json({ success: true, user: sessionUser(req.session), message: '超级管理员创建成功' });
    });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return sendError(res, 400, ErrorCodes.CONFLICT, '该登录ID已被使用');
    handleError(res, e, '[auth/init]');
  }
});

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: 用户登录
 *     description: 使用登录ID和密码进行本地登录
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               loginId:
 *                 type: string
 *                 description: 登录ID或显示名
 *               password:
 *                 type: string
 *                 description: 用户密码
 *             required:
 *               - loginId
 *               - password
 *     responses:
 *       200:
 *         description: 登录成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 user:
 *                   type: object
 *                   description: 用户信息
 *       401:
 *         description: 登录失败
 *       423:
 *         description: 账户被锁定
 */
// ==================== 登录页账号头像预览（§11.8.3）====================
// 输入 loginId 后实时预览「本地头像 + VRChat 头像」两个小图，帮助用户在输密码前确认账号。
// 安全：① 不返回 found 布尔，账号不存在与「存在但无头像」均返默认图，避免账号枚举泄露；
//       ② 独立限流（15 分钟 40 次）防批量探测。密码验证逻辑完全不变。
const authPreviewLimiter = createCustomLimiter({
  max: 40,
  message: { error: '请求过于频繁，请稍后再试', retryAfter: 900 }
});

router.get('/preview', authPreviewLimiter, async (req, res) => {
  try {
    const raw = (req.query.loginId || '').toString().trim();
    if (!raw) return res.json({ avatarUrl: null, vrchatAvatarUrl: null });
    const key = raw.toLowerCase();
    const [rows] = await getPool().query(
      `SELECT id, avatar_type, custom_avatar_path, vrchat_avatar_url
       FROM users WHERE (LOWER(login_id) = ? OR LOWER(display_name) = ?) AND (deleted_at IS NULL OR deleted_at = '')`,
      [key, key]
    );
    // 账号不存在：返回默认（与「存在但无头像」不可区分，避免泄露枚举）
    if (rows.length === 0) return res.json({ avatarUrl: null, vrchatAvatarUrl: null });
    const u = rows[0];
    const avatarUrl = getAvatarUrl(u); // custom 路径 / 代理后的 vrchat URL / null
    const vrchatAvatarUrl = u.vrchat_avatar_url
      ? `/api/avatar/proxy?u=${encodeURIComponent(u.vrchat_avatar_url)}`
      : null;
    res.json({ avatarUrl: avatarUrl || null, vrchatAvatarUrl });
  } catch (e) { handleError(res, e, '[auth/preview]'); }
});

router.post('/login', async (req, res) => {
  try {
    const { loginId, password } = req.body;
    if (typeof loginId !== 'string' || typeof password !== 'string' || !loginId.trim() || !password) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请输入有效的登录ID和密码');
    }
    const normalizedLoginId = loginId.trim().toLowerCase();

    let users;
    try {
      [users] = await getPool().query(`SELECT * FROM users WHERE (LOWER(login_id) = ? OR LOWER(display_name) = ?) AND (deleted_at IS NULL OR deleted_at = '')`, [normalizedLoginId, normalizedLoginId]);
    } catch (e) {
      if (e.code === 'ER_BAD_FIELD_ERROR') {
        [users] = await getPool().query(`SELECT * FROM users WHERE LOWER(login_id) = ? OR LOWER(display_name) = ?`, [normalizedLoginId, normalizedLoginId]);
      } else {
        throw e;
      }
    }

    if (users.length === 0) return res.status(401).json({ error: '登录失败，请检查账号或昵称和密码', code: 'LOGIN_FAILED' });

    // 支持用「本地账户名字(display_name)」登录：大小写不敏感匹配。
    // 若存在同名账户，优先匹配 login_id 精确相等的记录；否则逐个校验密码以确定唯一账户。
    let user = users.find(u => String(u.login_id).toLowerCase() === normalizedLoginId) || null;
    if (!user) {
      for (const u of users) {
        try {
          if (await verifyPassword(password, u.password_hash)) { user = u; break; }
        } catch {}
      }
    }
    // 同名且密码均不匹配时，取首条走下方统一「密码错误」提示（避免泄露重名）
    if (!user) user = users[0];

    if (user.banned) return res.status(401).json({ error: '账户已被封禁', code: 'ACCOUNT_BANNED' });

    if (!user.approved || user.approved === 0) {
      return res.status(401).json({ error: '账户待审核，请联系管理员', code: 'ACCOUNT_PENDING' });
    }

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const lockMinutes = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      return res.status(423).json({ error: `账户已被锁定，请${lockMinutes}分钟后再试`, code: 'ACCOUNT_LOCKED', lockMinutes });
    }

    if (!user.password_hash) return res.status(401).json({ error: '该账号未设置密码，请联系管理员或使用初始化流程重新设置', code: 'NO_PASSWORD' });
    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      const newAttempts = (user.failed_login_attempts || 0) + 1;
      if (newAttempts >= 5) {
        try {
          await getPool().query(`UPDATE users SET failed_login_attempts = ?, locked_until = DATE_ADD(NOW(), INTERVAL 15 MINUTE) WHERE id = ?`, [newAttempts, user.id]);
        } catch {}
        logger.warn('auth', `[SEC] 账户 ${user.login_id} 已锁定（${newAttempts} 次失败）`);
        return res.status(423).json({ error: '登录失败次数过多，账户已被锁定15分钟', code: 'ACCOUNT_LOCKED', lockMinutes: 15 });
      }
      try {
        await getPool().query(`UPDATE users SET failed_login_attempts = ? WHERE id = ?`, [newAttempts, user.id]);
      } catch {}
      return res.status(401).json({ error: '登录失败，请检查登录ID和密码', code: 'LOGIN_FAILED' });
    }

    try {
      await getPool().query(`UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?`, [user.id]);
    } catch {}

    req.session.regenerate(async (err) => {
      if (err) { handleError(res, err, 'auth'); return; }
      await buildSession(req, user);
      await req.session.save();
      try {
        await getPool().query(`INSERT INTO sys_oper_log (admin_vrcid, oper_type, content) VALUES (?, '用户登录', ?)`, [user.login_id, `${user.display_name} 登录`]);
      } catch {}
      res.json({ success: true, user: sessionUser(req.session) });
    });
  } catch (e) { 
    handleError(res, e, '[auth/login]'); 
  }
});

// (游客登录已移除- 2026-06-22)

/**
 * @swagger
 * /api/auth/logout:
 *   post:
 *     summary: 用户登出
 *     description: 清除用户会话，退出登录
 *     tags: [Auth]
 *     responses:
 *       200:
 *         description: 登出成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 */
router.post('/logout', async (req, res) => {
  if (req.session) {
    req.session.destroy(err => {
      if (err) { handleError(res, err, 'auth'); return; }
      // 必须指定相同→path/httpOnly/sameSite 参数才能正确清除 cookie
      res.clearCookie('connect.sid', { path: '/', httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
      res.json({ success: true });
    });
  } else { res.json({ success: true }); }
});

/**
 * @swagger
 * /api/auth/session:
 *   get:
 *     summary: 获取当前会话信息
 *     description: 获取当前登录用户的会话信息
 *     tags: [Auth]
 *     responses:
 *       200:
 *         description: 会话信息
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 loggedIn:
 *                   type: boolean
 *                   description: 是否已登录
 *                 user:
 *                   type: object
 *                   description: 用户信息（未登录时为null）
 */
router.get('/session', (req, res) => {
  const user = sessionUser(req.session);
  res.json({ loggedIn: !!user, user });
});

// ==================== 修改密码 ====================
router.post('/change-password', passwordResetLimiter, requireAuth, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请输入旧密码和新密码');
    let users;
    try {
      [users] = await getPool().query(`SELECT password_hash FROM users WHERE id = ? AND deleted_at IS NULL`, [req.session.userId]);
    } catch (e) {
      if (e.code === 'ER_BAD_FIELD_ERROR') {
        [users] = await getPool().query(`SELECT password_hash FROM users WHERE id = ?`, [req.session.userId]);
      } else {
        throw e;
      }
    }
    if (users.length === 0) return sendError(res, 404, ErrorCodes.NOT_FOUND, '用户不存在');
    if (users[0].password_hash) {
      const valid = await verifyPassword(oldPassword, users[0].password_hash);
      if (!valid) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '旧密码错误');
    }
    const strength = validatePasswordStrength(newPassword);
    if (!strength.valid) return res.status(400).json({ error: '新密码强度不足', details: strength.errors });
    const newHash = await hashPassword(newPassword);
    await getPool().query(`UPDATE users SET password_hash = ? WHERE id = ?`, [newHash, req.session.userId]);
    // §44：改密后删除该用户所有其他 session 记录，强制其他会话失效
    // sessions 表由 express-mysql-session 创建，列为 session_id/expires/data（无 user_id）
    // data 列存储 JSON 序列化的 session 对象，userId 在其中，用 JSON_EXTRACT 查询
    try {
      await getPool().query(`DELETE FROM sessions WHERE JSON_UNQUOTE(JSON_EXTRACT(data, '$.userId')) = ?`, [String(req.session.userId)]);
    } catch (e) { logger.warn('auth', '[change-password] 清理其他会话失败:', e.message); }
    await getPool().query(`INSERT INTO sys_oper_log (admin_vrcid, oper_type, content) VALUES (?, '修改密码', ?)`, [req.session.userId, `用户 ${req.session.userId} 修改密码`]);
    res.json({ success: true, message: '密码修改成功' });
  } catch (e) { handleError(res, e, '[auth/change-password]'); }
});

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
        return res.status(400).json({ error: '登录会话已过期，请重新发送验证码', expired: true });
      }
      const { cookie, vrcUser, boundUser, methods } = state;
      if (!methods.includes(method)) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '双重验证方式无效，请重新登录');

      // 验证 2FA
      const vResult = await verifyVrc2fa(code, method, cookie);
      if (!vResult.success) {
        // 验证码错误不删除 token，允许重试
        return res.status(401).json({ error: vResult.error });
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
        res.json({ success: true, user: sessionUser(req.session), bindStatus: 'already_bound' });
      });
      return;
    }

    // ══════════ 模式 A：无 loginToken →第一步登录══════════
    if (!username || !password) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请输入VRChat用户名和密码');

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

    // 未绑定 → 明确引导用户先注册本地账号再绑定
    if (boundUsers.length === 0) {
      return res.status(401).json({
        needBind: true,
        error: '该VRChat账号未绑定本站账号，无法直接登录',
        message: '该VRChat账号未绑定本站账号，请先完成本地账号注册/登录，然后在个人中心绑定VRChat账号后再使用VRChat登录。',
        vrchatUser: { id: vrcUser.id, displayName: vrcUser.displayName }
      });
    }
    const boundUser = boundUsers[0];

    // 账户锁定检查
    if (boundUser.locked_until && new Date(boundUser.locked_until) > new Date()) {
      const lockMinutes = Math.ceil((new Date(boundUser.locked_until) - new Date()) / 60000);
      return res.status(423).json({ error: `账户已被锁定，请${lockMinutes}分钟后再试`, code: 'ACCOUNT_LOCKED', lockMinutes });
    }

    if (!boundUser.approved || boundUser.approved === 0) {
      return res.status(401).json({ error: '账户待审核，请联系管理员', code: 'ACCOUNT_PENDING' });
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
        res.json({ success: true, user: sessionUser(req.session), bindStatus: 'already_bound' });
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
      return res.status(400).json({ error: '登录会话已过期，请重新登录', expired: true });
    }
    const { cookie, vrcUser, boundUser, methods } = state;
    if (!methods.includes(method)) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '双重验证方式无效，请重新登录');

    const vResult = await verifyVrc2fa(code, method, cookie);
    if (!vResult.success) {
      return res.status(401).json({ error: vResult.error });
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
      res.json({ success: true, user: sessionUser(req.session) });
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
        return res.status(400).json({ error: '验证会话已过期，请重新输入账号密码', expired: true });
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
        return res.status(401).json({ error: vResult.error });
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
    if (existing.length > 0) return res.status(400).json({ error: `该VRChat账号已被用户 ${existing[0].login_id} 绑定` });

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

    res.json({
      success: true,
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
    res.json({ success: true, user: sessionUser(req.session), message: 'VRChat解绑成功' });
  } catch (e) { handleError(res, e, '[auth/vrchat-unbind]'); }
});

// ==================== 密码找回（忘记密码） ====================
const resetTokens = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [token, state] of resetTokens) {
    if (state.expireAt < now) resetTokens.delete(token);
  }
}, 60000).unref();

// §30：校验验证码并记录失败次数，超过 5 次删除 token
function consumeResetCode(token, code) {
  const state = resetTokens.get(token);
  if (!state || state.expireAt < Date.now()) {
    if (state) resetTokens.delete(token);
    return { expired: true };
  }
  if (state.code !== code.trim()) {
    state.attempts = (state.attempts || 0) + 1;
    if (state.attempts > 5) {
      resetTokens.delete(token);
      return { expired: true };
    }
    return { mismatch: true, attempts: state.attempts };
  }
  return { ok: true, state };
}

router.post('/forgot-password', passwordResetLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请输入邮箱地址');

    const [users] = await getPool().query(
      `SELECT id, display_name, login_id FROM users WHERE email = ? AND deleted_at IS NULL AND banned = 0`,
      [email]
    );
    if (users.length === 0) {
      return res.json({ success: true, message: '如果该邮箱已注册，验证码已发送到您的邮箱' });
    }

    const user = users[0];
    // §30：使用 crypto.randomInt 替代 Math.random 生成密码学安全验证码
    const code = crypto.randomInt(100000, 1000000).toString();
    const token = crypto.randomBytes(32).toString('hex');
    const expireAt = Date.now() + 15 * 60 * 1000;

    resetTokens.set(token, { userId: user.id, code, expireAt, attempts: 0 });

    try {
      const resetHtml = `<div style="max-width:600px;margin:0 auto;padding:20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
          <div style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white;padding:20px;border-radius:8px 8px 0 0;">
            <h1 style="margin:0;font-size:20px;">境途同游</h1>
          </div>
          <div style="border:1px solid #eee;border-top:none;padding:20px;">
            <h2 style="color:#333;margin:0 0 15px;">密码重置</h2>
            <p style="color:#666;line-height:1.6;">您好 ${user.display_name}，</p>
            <p style="color:#666;line-height:1.6;">您的密码重置验证码是：</p>
            <div style="background:#f8f9fa;border-radius:8px;padding:20px;text-align:center;margin:20px 0;">
              <span style="font-size:36px;font-weight:bold;color:#667eea;letter-spacing:8px;">${code}</span>
            </div>
            <p style="color:#666;line-height:1.6;">此验证码15分钟内有效，请尽快使用。</p>
            <p style="color:#666;line-height:1.6;">如果不是您本人操作，请忽略此邮件。</p>
          </div>
          <div style="text-align:center;color:#999;font-size:12px;padding:15px;border-top:1px solid #eee;">
            <p>这是一封自动发送的通知邮件，请勿回复。</p>
          </div>
        </div>`;
      const result = mailer.sendEmail(email, '【境途同游】密码重置验证码', resetHtml);
      if (!result.success) {
        logger.warn('auth', '⚠️ 发送验证码邮件失败:', result.error);
      }
    } catch (e) {
      logger.warn('auth', '⚠️ 发送验证码邮件失败:', e.message);
      handleError(res, e, 'auth');
      return;
    }

    res.json({ success: true, message: '验证码已发送到您的邮箱', token });
  } catch (e) {
    handleError(res, e, '[auth/forgot-password]');
  }
});

router.post('/verify-reset-code', passwordResetLimiter, async (req, res) => {
  try {
    const { token, code } = req.body;
    if (!token || !code) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');

    const result = consumeResetCode(token, code);
    if (result.expired) {
      return res.status(400).json({ error: '验证码已过期，请重新获取', expired: true });
    }
    if (result.mismatch) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '验证码错误');
    }

    res.json({ success: true, message: '验证通过' });
  } catch (e) {
    handleError(res, e, '[auth/verify-reset-code]');
  }
});

router.post('/reset-password', passwordResetLimiter, async (req, res) => {
  try {
    const { token, code, newPassword } = req.body;
    if (!token || !newPassword) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');

    const result = consumeResetCode(token, code);
    if (result.expired) {
      return res.status(400).json({ error: '链接已过期，请重新获取', expired: true });
    }
    if (result.mismatch) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '验证码错误');
    }
    const state = result.state;

    const strength = validatePasswordStrength(newPassword);
    if (!strength.valid) {
      return res.status(400).json({ error: '密码强度不足', details: strength.errors });
    }

    const pwdHash = await hashPassword(newPassword);
    await getPool().query(`UPDATE users SET password_hash = ?, updated_at = NOW() WHERE id = ?`, [pwdHash, state.userId]);
    // §44：重置密码后删除该用户所有 session 记录，强制其他会话失效
    try {
      await getPool().query(`DELETE FROM sessions WHERE JSON_UNQUOTE(JSON_EXTRACT(data, '$.userId')) = ?`, [String(state.userId)]);
    } catch (e) { logger.warn('auth', '[reset-password] 清理用户会话失败:', e.message); }

    resetTokens.delete(token);

    await getPool().query(`INSERT INTO sys_oper_log (admin_vrcid, oper_type, content) VALUES (?, '重置密码', ?)`,
      [state.userId, '通过邮箱验证重置密码']);

    res.json({ success: true, message: '密码重置成功，请使用新密码登录' });
  } catch (e) {
    handleError(res, e, '[auth/reset-password]');
  }
});

module.exports = router;
