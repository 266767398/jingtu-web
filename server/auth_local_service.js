/**
 * 境途同游 V5.2 — 本地认证业务层（auth.js 按域拆分）
 * 覆盖 /init 引导、/preview 登录头像预览、/login 本地登录、/logout、
 * /session 会话查询、/change-password 修改密码。路由注册、限流/鉴权
 * 中间件与业务实现同文件维护，新增本地认证端点只改本文件。
 * routes/auth.js 通过 registerLocalRoutes(router) 原位委托注册。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { fail, ok, getPool, handleError, sendError, ErrorCodes, getAvatarUrl } = require('./utils');
const { passwordResetLimiter, registerLimiter, createCustomLimiter } = require('./middleware/rate_limit');
const { hashPassword, verifyPassword, validatePasswordStrength, requireAuth } = require('./auth');
const logger = require('./logger');
const { buildSession, sessionUser } = require('./auth_session');
const activationCodes = require('./activation_code_service');

// 路由注册委托：routes/auth.js 原位调用，六个端点连中间件一并注册
function registerLocalRoutes(router) {
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
    const ENV_PATH = path.join(__dirname, '..', '.env');
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
        const { DB_CONFIG: activeDb, DB_NAME: activeDbName } = require('./db');
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
        logger.info('auth-local', '[auth/init] .env 不存在，已用当前运行配置自动补全');
      } catch (ensureErr) {
        return handleError(res, ensureErr, '[auth/init-ensureEnv]');
      }
    }
    const { loginId, password, displayName } = req.body;
    if (!loginId || !password) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请输入登录ID和密码');
    if (!displayName) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请输入显示名');
    const strength = validatePasswordStrength(password);
    if (!strength.valid) return fail(res, 400, '密码强度不足', { details: strength.errors });
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
      ok(res, { user: sessionUser(req.session), message: '超级管理员创建成功' });
    });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return sendError(res, 400, ErrorCodes.CONFLICT, '该登录ID已被使用');
    handleError(res, e, '[auth/init]');
  }
});

// ==================== 激活码自助注册 ====================
// 普通用户凭「用户名 + 密码 + 激活码」注册：激活码由超管后台或离线工具预先生成，
// 存于 server/data/activation-codes.json。校验+消耗在文件锁内原子完成，一码一号。
router.post('/register', registerLimiter, async (req, res) => {
  try {
    const { username, password, activationCode } = req.body;
    if (typeof username !== 'string' || !username.trim()) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请输入用户名');
    if (typeof password !== 'string' || !password) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请输入密码');
    if (typeof activationCode !== 'string' || !activationCode.trim()) return fail(res, 400, '请输入激活码', { code: 'ACTIVATION_CODE_REQUIRED' });
    const trimmedUsername = username.trim();
    const trimmedCode = activationCode.trim();
    if (trimmedUsername.length < 2 || trimmedUsername.length > 32) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '用户名长度需在 2-32 字符之间');
    }
    const strength = validatePasswordStrength(password);
    if (!strength.valid) return fail(res, 400, '密码强度不足', { details: strength.errors });

    // 建号前先查重名：失败早返回，避免白白消耗激活码
    const [dup] = await getPool().query(
      `SELECT id FROM users WHERE LOWER(login_id) = ? AND (deleted_at IS NULL OR deleted_at = '')`,
      [trimmedUsername.toLowerCase()]
    );
    if (dup.length > 0) return sendError(res, 400, ErrorCodes.CONFLICT, '该用户名已被使用');

    // 用户创建放在激活码标记之前（文件锁内）：任一环节失败激活码都不会被消耗
    let createdUserId = null;
    let consume;
    try {
      consume = await activationCodes.validateAndConsume(trimmedCode, trimmedUsername, async () => {
        const [dupInLock] = await getPool().query(
          `SELECT id FROM users WHERE LOWER(login_id) = ? AND (deleted_at IS NULL OR deleted_at = '')`,
          [trimmedUsername.toLowerCase()]
        );
        if (dupInLock.length > 0) {
          const err = new Error('该用户名已被使用');
          err.abortCode = 'USERNAME_TAKEN';
          throw err;
        }
        const pwdHash = await hashPassword(password);
        const [result] = await getPool().query(
          `INSERT INTO users (login_id, display_name, password_hash, role, avatar_type, approved)
           VALUES (?, ?, ?, 'member', 'none', 1)`,
          [trimmedUsername, trimmedUsername, pwdHash]
        );
        createdUserId = result.insertId;
        await getPool().query(
          `INSERT IGNORE INTO user_group_membership (user_id, group_id) VALUES (?, 3)`,
          [createdUserId]
        );
      });
    } catch (e) {
      if (e instanceof activationCodes.ActivationCodeError) {
        return fail(res, e.reason === 'LOCK_TIMEOUT' ? 503 : 500, e.message, { code: e.reason });
      }
      throw e;
    }

    if (!consume.ok) {
      // 建号成功但激活码文件写回失败：补偿删除刚建的账号，保证「码未消耗 ↔ 账号不存在」一致
      // 删除带重试：瞬时连接抖动时不留「账号已建但码未消耗」的悬挂状态
      if (createdUserId && consume.reason === 'WRITE_FAILED') {
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            await getPool().query(`DELETE FROM user_group_membership WHERE user_id = ?`, [createdUserId]);
            await getPool().query(`DELETE FROM users WHERE id = ?`, [createdUserId]);
            break;
          } catch (e) {
            if (attempt === 3) {
              logger.error('auth/register', `[SEC] 激活码写回失败且补偿删除账号 #${createdUserId} 三次均失败: ${e.message}`);
            } else {
              await new Promise(r => setTimeout(r, 120 * attempt));
            }
          }
        }
        createdUserId = null;
      }
      const hookErr = consume.error;
      if (hookErr && hookErr.abortCode === 'USERNAME_TAKEN') {
        return sendError(res, 400, ErrorCodes.CONFLICT, '该用户名已被使用');
      }
      const msgMap = {
        INVALID_FORMAT: '激活码格式不正确',
        NOT_FOUND: '激活码无效',
        ALREADY_USED: '激活码已被使用',
        REVOKED: '激活码已被作废，请联系管理员',
        EXPIRED: '激活码已过期，请联系管理员',
        WRITE_FAILED: '注册失败，请稍后重试'
      };
      return fail(res, 400, msgMap[consume.reason] || '注册失败，请稍后重试', { code: consume.reason || 'REGISTER_FAILED' });
    }

    // 建号 + 激活码消耗均成功：写操作日志（保留激活码原文，已作废仅作排查留痕）
    const user = { id: createdUserId, login_id: trimmedUsername, display_name: trimmedUsername, vrchat_id: null, vrchat_name: null, vrchat_verified: 0, role: 'member', avatar_type: 'none', vrchat_avatar_url: null, custom_avatar_path: null };
    try {
      await getPool().query(`INSERT INTO sys_oper_log (admin_vrcid, oper_type, content) VALUES (?, '用户注册', ?)`,
        [trimmedUsername, `激活码注册: ${trimmedUsername}，激活码 ${consume.code} 已消耗作废`]);
    } catch {}
    req.session.regenerate(async (err) => {
      if (err) { handleError(res, err, 'auth'); return; }
      await buildSession(req, user);
      await req.session.save();
      ok(res, { user: sessionUser(req.session), message: '注册成功' });
    });
  } catch (e) {
    handleError(res, e, '[auth/register]');
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
  name: 'auth-preview',
  max: 40,
  message: { error: '请求过于频繁，请稍后再试', retryAfter: 900 }
});

router.get('/preview', authPreviewLimiter, async (req, res) => {
  try {
    // M-2：仅登录用户可用——匿名请求统一返回 null，消除「按头像是否存在」的账户枚举 oracle；
    // 前端对 null 已有默认头像兜底（auth.js previewLoginAvatar），不影响登录流程
    if (!req.session || !req.session.userId) {
      return res.json({ avatarUrl: null, vrchatAvatarUrl: null });
    }
    const raw = (req.query.loginId || '').toString().trim().slice(0, 64);
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
    const avatarUrl = getAvatarUrl(u); 
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

    if (users.length === 0) return fail(res, 401, '登录失败，请检查账号和密码', { code: 'LOGIN_FAILED' });

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

    if (user.banned) return fail(res, 401, '账户已被封禁', { code: 'ACCOUNT_BANNED' });

    if (!user.approved || user.approved === 0) {
      return fail(res, 401, '账户待审核，请联系管理员', { code: 'ACCOUNT_PENDING' });
    }

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const lockMinutes = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      return fail(res, 423, `账户已被锁定，请${lockMinutes}分钟后再试`, { code: 'ACCOUNT_LOCKED', lockMinutes });
    }

    if (!user.password_hash) return fail(res, 401, '该账号未设置密码，请联系管理员或使用初始化流程重新设置', { code: 'NO_PASSWORD' });
    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      // AUTH-1: 原子递增失败计数（failed_login_attempts = failed_login_attempts + 1），
      // 杜绝并发请求读到同一快照导致计数器不累计、锁账户失效的竞态。
      try {
        await getPool().query(`UPDATE users SET failed_login_attempts = failed_login_attempts + 1 WHERE id = ?`, [user.id]);
        const [after] = await getPool().query(`SELECT failed_login_attempts FROM users WHERE id = ?`, [user.id]);
        const newAttempts = (after && after.length && after[0].failed_login_attempts) || 1;
        if (newAttempts >= 5) {
          await getPool().query(`UPDATE users SET locked_until = DATE_ADD(NOW(), INTERVAL 15 MINUTE) WHERE id = ?`, [user.id]);
          logger.warn('auth', `[SEC] 账户 ${user.login_id} 已锁定（${newAttempts} 次失败）`);
          return fail(res, 423, '登录失败次数过多，账户已被锁定15分钟', { code: 'ACCOUNT_LOCKED', lockMinutes: 15 });
        }
      } catch {}
      return fail(res, 401, '登录失败，请检查账号和密码', { code: 'LOGIN_FAILED' });
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
      ok(res, { user: sessionUser(req.session) });
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
      ok(res);
    });
  } else { ok(res); }
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
    // AUTH-7：未设置密码（password_hash=NULL）时拒绝免旧密码设密——统一走邮箱重置流程，
    // 防攻击者持无密码账号会话直接声明任意密码
    if (!users[0].password_hash) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '该账号未设置密码，请通过邮箱重置密码后再修改');
    }
    const valid = await verifyPassword(oldPassword, users[0].password_hash);
    if (!valid) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '旧密码错误');
    const strength = validatePasswordStrength(newPassword);
    if (!strength.valid) return fail(res, 400, '新密码强度不足', { details: strength.errors });
    const newHash = await hashPassword(newPassword);
    await getPool().query(`UPDATE users SET password_hash = ? WHERE id = ?`, [newHash, req.session.userId]);
    // §44：改密后删除该用户所有其他 session 记录，强制其他会话失效
    // sessions 表由 express-mysql-session创建，列为 session_id/expires/data（无 user_id）
    // data 列存储 JSON 序列化的 session 对象，userId 在其中，用 JSON_EXTRACT 查询
    try {
      await getPool().query(`DELETE FROM sessions WHERE JSON_UNQUOTE(JSON_EXTRACT(data, '$.userId')) = ?`, [String(req.session.userId)]);
    } catch (e) { logger.warn('auth', '[change-password] 清理其他会话失败:', e.message); }
    await getPool().query(`INSERT INTO sys_oper_log (admin_vrcid, oper_type, content) VALUES (?, '修改密码', ?)`, [req.session.userId, `用户 ${req.session.userId} 修改密码`]);
    ok(res, { message: '密码修改成功' });
  } catch (e) { handleError(res, e, '[auth/change-password]'); }
});
}

module.exports = { registerLocalRoutes };
