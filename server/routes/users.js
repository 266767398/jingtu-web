/**
 * 境途同游 V5.2 — 用户管理与资料路由
 * 
 * @swagger
 * tags:
 *   name: Users
 *   description: 用户管理相关接口
 */
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const sharp = require('sharp');
const {
  hashPassword, verifyPassword, validatePasswordStrength,
  encryptAES, decryptAES, requireAuth, requireRole,
  requireAdminCompat, getAvatarUrl
} = require('../auth');
const { getPool, safeError, validateFields, handleError, sendError, ErrorCodes, createErr, createFileFilter, secureUpload } = require('../utils');
const { VRC_API, VRC_API_KEY } = require('../vrc');
const logger = require('../logger');

// B-2/P2-14：敏感操作（重置密码/改角色）要求当前管理员二次密码确认
async function verifySelfPassword(uid, plain) {
  if (!plain) return false;
  const [rows] = await getPool().query(
    'SELECT password_hash FROM users WHERE id = ? AND deleted_at IS NULL',
    [uid]
  );
  if (!rows.length) return false;
  try { return verifyPassword(plain, rows[0].password_hash); } catch (_) { return false; }
}
const ROOT_DIR = path.join(__dirname, '..', '..');
const AVATAR_DIR = path.join(ROOT_DIR, 'uploads', 'avatars');

// 确保头像目录存在
if (!fs.existsSync(AVATAR_DIR)) fs.mkdirSync(AVATAR_DIR, { recursive: true });

// 清理某用户的旧头像文件（best-effort，忽略锁定/不存在错误）
// keep1/keep2 为本次新生成的文件名，必须保留
function cleanupOldAvatars(userId, keep1, keep2) {
  try {
    const files = fs.readdirSync(AVATAR_DIR);
    const id = String(userId);
    for (const f of files) {
      const full = path.join(AVATAR_DIR, f);
      if (f === keep1 || f === keep2) continue;
      // 匹配旧命名：{id}.jpg / {id}_256.jpg / {id}_64.jpg / {id}_{ts}.jpg / {id}_{ts}_64.jpg / .tmp_*
      const isOld = f === `${id}.jpg` || f === `${id}_256.jpg` || f === `${id}_64.jpg`
        || (f.startsWith(`${id}_`) && (f.endsWith('.jpg') || f.endsWith('.png')))
        || f.startsWith('.tmp_');
      if (isOld) { try { fs.unlinkSync(full); } catch {} }
    }
  } catch {}
}

// 头像上传配置
const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, AVATAR_DIR),
  filename: (req, file, cb) => {
    cb(null, `avatar_${req.session.userId}_${Date.now()}${path.extname(file.originalname)}`);
  }
});
const avatarUpload = multer({
  storage: avatarStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: createFileFilter(['IMAGE'])
});

// 脱敏用户记录（去除敏感字段）
function sanitizeUser(u) {
  return {
    id: u.id,
    loginId: u.login_id,
    displayName: u.display_name,
    vrchatId: u.vrchat_id,
    vrchatName: u.vrchat_name,
    vrchatAvatarUrl: u.vrchat_avatar_url || null,
    role: u.role,
    avatarType: u.avatar_type,
    avatarUrl: getAvatarUrl(u),
    birthday: u.birthday,
    location: u.location_visible ? u.location : null,
    lat: u.location_visible ? u.lat : null,
    lng: u.location_visible ? u.lng : null,
    preferences: u.preferences,
    createdAt: u.created_at,
    updatedAt: u.updated_at
  };
}

/**
 * @swagger
 * /api/users/list:
 *   get:
 *     summary: 获取成员列表（公开接口）
 *     description: 获取所有已审核成员列表，用于成员页、群聊创建等场景
 *     tags: [Users]
 *     parameters:
 *       - name: page
 *         in: query
 *         type: integer
 *         description: 页码
 *       - name: pageSize
 *         in: query
 *         type: integer
 *         description: 每页数量
 *     responses:
 *       200:
 *         description: 成员列表
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 users:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: integer
 *                       loginId:
 *                         type: string
 *                       displayName:
 *                         type: string
 *                       role:
 *                         type: string
 *                 total:
 *                   type: integer
 */
router.get('/list', requireAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.pageSize) || 100;
    const offset = (page - 1) * pageSize;

    const [count] = await getPool().query(
      `SELECT COUNT(*) as total FROM users WHERE deleted_at IS NULL AND approved = 1 AND banned = 0`
    );
    const [rows] = await getPool().query(
      `SELECT u.id, u.login_id AS loginId, u.display_name, u.vrchat_id, u.vrchat_name, u.role, u.avatar_type,
              u.custom_avatar_path, u.vrchat_avatar_url,
              u.location, u.lat, u.lng, u.location_visible AS locationVisible,
              COALESCE(l.likeCount, 0) AS likeCount
       FROM users u
       LEFT JOIN (SELECT to_user_id, COUNT(*) AS likeCount FROM user_like GROUP BY to_user_id) l
         ON u.id = l.to_user_id
       WHERE u.deleted_at IS NULL AND u.approved = 1 AND u.banned = 0
       ORDER BY FIELD(u.role, 'super_admin', 'admin', 'member'), u.id ASC
       LIMIT ? OFFSET ?`,
      [pageSize, offset]
    );

    const users = rows.map(u => ({
      id: u.id,
      loginId: u.loginId,
      displayName: u.display_name,
      vrchatId: u.vrchat_id,
      vrchatName: u.vrchat_name,
      role: u.role,
      avatarType: u.avatar_type,
      avatarUrl: getAvatarUrl(u),
      location: u.locationVisible ? u.location : null,
      lat: u.locationVisible ? parseFloat(u.lat) : null,
      lng: u.locationVisible ? parseFloat(u.lng) : null,
      locationVisible: !!u.locationVisible,
      likeCount: parseInt(u.likeCount) || 0
    }));

    res.json({ users, total: count[0].total, page, pageSize });
  } catch (e) { handleError(res, e, '[users/list]'); }
});

/**
 * @swagger
 * /api/users:
 *   get:
 *     summary: 获取用户列表
 *     description: 获取所有用户列表（管理员权限）
 *     tags: [Users]
 *     parameters:
 *       - name: page
 *         in: query
 *         type: integer
 *         description: 页码
 *       - name: pageSize
 *         in: query
 *         type: integer
 *         description: 每页数量
 *     responses:
 *       200:
 *         description: 用户列表
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 users:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: integer
 *                       loginId:
 *                         type: string
 *                       displayName:
 *                         type: string
 *                       role:
 *                         type: string
 *                 total:
 *                   type: integer
 *       403:
 *         description: 权限不足
 */
router.get('/', requireRole('admin'), async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.pageSize) || 20;
    const offset = (page - 1) * pageSize;

    const [count] = await getPool().query(
      `SELECT COUNT(*) as total FROM users WHERE deleted_at IS NULL`
    );
    const [rows] = await getPool().query(
      `SELECT id, login_id, display_name, vrchat_id, vrchat_name, role, avatar_type,
              custom_avatar_path, vrchat_avatar_url, location_visible, created_at, updated_at
       FROM users WHERE deleted_at IS NULL
       ORDER BY FIELD(role, 'super_admin', 'admin', 'member'), id ASC
       LIMIT ? OFFSET ?`,
      [pageSize, offset]
    );

    const users = rows.map(u => ({
      id: u.id,
      loginId: u.login_id,
      displayName: u.display_name,
      vrchatId: u.vrchat_id,
      vrchatName: u.vrchat_name,
      role: u.role,
      avatarType: u.avatar_type,
      avatarUrl: getAvatarUrl(u),
      locationVisible: !!u.location_visible,
      createdAt: u.created_at,
      updatedAt: u.updated_at
    }));

    res.json({ users, total: count[0].total, page, pageSize });
  } catch (e) { handleError(res, e, '[users/list]'); }
});

/**
 * @swagger
 * /api/users:
 *   post:
 *     summary: 创建用户
 *     description: 创建新用户（超级管理员权限）
 *     tags: [Users]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               loginId:
 *                 type: string
 *                 description: 登录ID
 *               password:
 *                 type: string
 *                 description: 密码
 *               displayName:
 *                 type: string
 *                 description: 显示名
 *               role:
 *                 type: string
 *                 description: 角色 (super_admin/admin/member)
 *               email:
 *                 type: string
 *                 description: 邮箱
 *             required:
 *               - loginId
 *               - password
 *               - displayName
 *     responses:
 *       200:
 *         description: 创建成功
 *       400:
 *         description: 参数错误或登录ID已存在
 *       403:
 *         description: 权限不足
 */
router.post('/', requireRole('super_admin'), async (req, res) => {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();

    const { loginId, password, displayName, role, email } = req.body;
    if (!loginId || !password) {
      await conn.rollback();
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '登录ID和密码不能为空');
    }
    if (!displayName) {
      await conn.rollback();
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '显示名不能为空');
    }

    const strength = validatePasswordStrength(password);
    if (!strength.valid) {
      await conn.rollback();
      return res.status(400).json({ error: '密码强度不足', details: strength.errors });
    }

    const validRoles = ['super_admin', 'admin', 'member'];
    const userRole = validRoles.includes(role) ? role : 'member';

    const [dup] = await conn.query(`SELECT id FROM users WHERE login_id = ?`, [loginId]);
    if (dup.length > 0) {
      await conn.rollback();
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '该登录ID已被使用');
    }

    const pwdHash = await hashPassword(password);
    const [result] = await conn.query(
      `INSERT INTO users (login_id, display_name, password_hash, role, avatar_type, approved, email) VALUES (?, ?, ?, ?, 'none', 1, ?)`,
      [loginId, displayName, pwdHash, userRole, email || null]
    );

    const userId = result.insertId;

    let groupId = 3;
    if (userRole === 'super_admin') groupId = 1;
    else if (userRole === 'admin') groupId = 2;
    await conn.query(
      `INSERT IGNORE INTO user_group_membership (user_id, group_id) VALUES (?, ?)`,
      [userId, groupId]
    );

    await conn.query(
      `INSERT INTO sys_oper_log (admin_vrcid, oper_type, content) VALUES (?, '创建用户', ?)`,
      [req.session.loginId, `创建用户 ${displayName} (${loginId}) 角色: ${userRole}`]
    );

    await conn.commit();
    res.json({ success: true, id: userId, message: '用户创建成功' });
  } catch (e) {
    await conn.rollback();
    if (e.code === 'ER_DUP_ENTRY') {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '该登录ID已被使用');
    }
    logger.error('users', '[users-create]', e);
    handleError(res, e, '[users]');
  } finally {
    conn.release();
  }
});

/**
 * @swagger
 * /api/users/birthdays:
 *   get:
 *     summary: 获取生日列表
 *     description: 获取所有用户的生日列表，包含今日寿星
 *     tags: [Users]
 *     responses:
 *       200:
 *         description: 生日列表
 *       401:
 *         description: 未登录
 */
// ==================== 生日列表（需要放在 /:id 通配路由之前） ====================
router.get('/birthdays', requireAuth, async (req, res) => {
  try {
    const now = new Date();
    const month = now.getMonth() + 1;
    const day = now.getDate();

    const [rows] = await getPool().query(
      `SELECT id, display_name AS displayName, birthday,
              COALESCE(custom_avatar_path, vrchat_avatar_url) AS avatarUrl
       FROM users
       WHERE birthday IS NOT NULL AND deleted_at IS NULL
       ORDER BY MONTH(birthday), DAY(birthday)`
    );

    const todayBirthdays = rows.filter(r => {
      if (!r.birthday) return false;
      const b = new Date(r.birthday);
      return b.getMonth() + 1 === month && b.getDate() === day;
    });

    res.json({ birthdays: rows, todayCount: todayBirthdays.length, todayBirthdays });
  } catch (e) { handleError(res, e, '[users]'); }
});

/**
 * @swagger
 * /api/users/all/locations:
 *   get:
 *     summary: 获取全员位置
 *     description: 获取所有开启位置共享的用户位置信息
 *     tags: [Users]
 *     responses:
 *       200:
 *         description: 位置标记列表
 *       401:
 *         description: 未登录
 */
// ==================== 全员位置（需要放在 /:id 通配路由之前） ====================
router.get('/all/locations', requireAuth, async (req, res) => {
  try {
    const [rows] = await getPool().query(
      `SELECT id, display_name, avatar_type, custom_avatar_path, vrchat_avatar_url,
              location, lat, lng, location_updated_at
       FROM users
       WHERE location_visible = 1 AND lat IS NOT NULL AND lng IS NOT NULL AND deleted_at IS NULL`
    );

    const markers = rows.map(u => ({
      id: u.id,
      // displayName 与全站命名保持一致；保留 name 兼容旧前端缓存
      displayName: u.display_name,
      name: u.display_name,
      avatarUrl: getAvatarUrl(u),
      location: u.location,
      lat: parseFloat(u.lat),
      lng: parseFloat(u.lng),
      locationUpdatedAt: u.location_updated_at,
      timestamp: u.location_updated_at ? new Date(u.location_updated_at).getTime() : null
    }));

    res.json({ markers, count: markers.length });
  } catch (e) {
    handleError(res, e, '[users]');
  }
});

router.get('/search', requireAuth, async (req, res) => {
  try {
    const q = req.query.q ? req.query.q.trim() : '';
    if (!q || q.length < 2) return res.json({ users: [], total: 0 });
    const like = '%' + q + '%';
    const [rows] = await getPool().query(
      'SELECT id, display_name, vrchat_id, vrchat_name, vrchat_avatar_url, avatar_type, custom_avatar_path, role FROM users WHERE deleted_at IS NULL AND banned = 0 AND approved = 1 AND (display_name LIKE ? OR vrchat_name LIKE ?) ORDER BY display_name ASC LIMIT 20',
      [like, like]
    );
    const users = rows.map(u => ({
      id: u.id,
      displayName: u.display_name,
      vrchatId: u.vrchat_id,
      vrchatName: u.vrchat_name,
      avatarUrl: getAvatarUrl(u),
      role: u.role
    }));
    res.json({ users, total: users.length });
  } catch (e) {
    handleError(res, e, '[users/search]');
  }
});

// ==================== F-4 用户级数据导出/导入（需放在 /:id 之前） ====================
// 复用共享模块 user-data-helper.js：个人自助与管理面板按用户/批量导入导出共用同一套逻辑
const {
  csvField,
  collectUserData,
  importUserData
} = require('./user-data-helper');

// GET /me/export?format=json|csv — 导出当前用户数据
router.get('/me/export', requireAuth, async (req, res) => {
  try {
    const format = (req.query.format || 'json').toLowerCase();
    const data = await collectUserData(req.session.userId);
    if (!data) return sendError(res, 404, ErrorCodes.NOT_FOUND, '用户不存在');

    if (format === 'csv') {
      // VRCX 好友导出格式：UserID,DisplayName,Memo
      const lines = ['UserID,DisplayName,Memo'];
      for (const f of data.friends) {
        const id = f.vrchatId || (f.userId ? 'usr_' + f.userId : '');
        const name = f.vrchatName || f.displayName || '';
        lines.push([csvField(id), csvField(name), csvField('')].join(','));
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="friends.csv"');
      return res.send('\uFEFF' + lines.join('\r\n'));
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="jingtu-backup.json"');
    res.json(data);
  } catch (e) {
    handleError(res, e, '[users/export]');
  }
});

// POST /me/import — 导入 JSON 数据（好友备注/标签/收藏/分组等）
router.post('/me/import', requireAuth, async (req, res) => {
  try {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '导入数据格式不正确');
    }
    const { imported } = await importUserData(req.session.userId, body);
    res.json({ success: true, imported });
  } catch (e) {
    if (e && e.statusCode === 404) {
      return sendError(res, 404, ErrorCodes.NOT_FOUND, '用户不存在');
    }
    handleError(res, e, '[users/import]');
  }
});

// ==================== 获取单个用户 ====================
router.get('/:id', requireRole('admin'), async (req, res) => {
  try {
    const [rows] = await getPool().query(
      `SELECT * FROM users WHERE id = ? AND deleted_at IS NULL`,
      [req.params.id]
    );
    if (rows.length === 0) {
      return sendError(res, 404, ErrorCodes.NOT_FOUND, '用户不存在');
    }
    res.json(sanitizeUser(rows[0]));
  } catch (e) {
    handleError(res, e, '[users]');
  }
});

// 角色 → 基础权限组同步：保证 user_group_membership 中的基础组(1/2/3)与角色一致，
// 自定义组(非 1/2/3)不受影响。修复"改角色后权限组不跟随"的一致性问题。
async function syncUserBaseGroup(userId, role) {
  const baseGroupId = role === 'super_admin' ? 1 : role === 'admin' ? 2 : 3;
  const pool = getPool();
  // 确保用户在新基础组中（已存在则忽略）
  await pool.query(
    'INSERT IGNORE INTO user_group_membership (user_id, group_id) VALUES (?, ?)',
    [userId, baseGroupId]
  );
  // 移除其它基础组（1/2/3 中不是新的那个），保留自定义组
  await pool.query(
    'DELETE FROM user_group_membership WHERE user_id = ? AND group_id IN (1,2,3) AND group_id <> ?',
    [userId, baseGroupId]
  );
}

// ==================== 更新用户（admin+） ====================
router.put('/:id', requireRole('admin'), async (req, res) => {
  try {
    const { displayName, role, email } = req.body;
    const updates = {};
    if (displayName) updates.display_name = displayName;
    if (email !== undefined) {
      if (email && typeof email === 'string' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '邮箱格式不正确');
      }
      updates.email = email ? email : null;
    }
    if (role) {
      const validRoles = ['super_admin', 'admin', 'member'];
      if (!validRoles.includes(role)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '无效的角色');
      }
      // 不能给自己降级
      if (parseInt(req.params.id) === req.session.userId && role !== req.session.role) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '不能修改自己的角色');
      }
      // 普通 admin 不能提 super_admin
      if (role === 'super_admin' && req.session.role !== 'super_admin') {
        return sendError(res, 403, ErrorCodes.FORBIDDEN, '只有超级管理员可以提拔超级管理员');
      }
      // B-2/P2-14：仅当角色「实际变更」时才要求当前管理员二次密码确认，
      // 避免纯改 displayName/email 等非敏感字段也被拦截（破坏正常编辑）。
      const [curRoleRows] = await getPool().query(
        'SELECT role FROM users WHERE id = ? AND deleted_at IS NULL',
        [req.params.id]
      );
      const roleChanged = curRoleRows.length && curRoleRows[0].role !== role;
      if (roleChanged) {
        const selfOk = await verifySelfPassword(req.session.userId, req.body.confirmPassword);
        if (!selfOk) return sendError(res, 403, ErrorCodes.FORBIDDEN, '管理员密码验证失败，敏感操作已拒绝');
      }
      updates.role = role;
    }

    validateFields(updates, ['display_name', 'role', 'email']);

    if (Object.keys(updates).length === 0) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '没有需要更新的字段');
    }

    const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const values = Object.values(updates);
    values.push(req.params.id);

    const [result] = await getPool().query(
      `UPDATE users SET ${fields}, updated_at = NOW() WHERE id = ? AND deleted_at IS NULL`,
      values
    );

    if (result.affectedRows === 0) {
      return sendError(res, 404, ErrorCodes.NOT_FOUND, '用户不存在');
    }

    // 角色变更 → 同步基础权限组（修复权限组与角色脱节）
    if (updates.role) {
      await syncUserBaseGroup(parseInt(req.params.id, 10), updates.role);
    }

    await getPool().query(
      `INSERT INTO sys_oper_log (admin_vrcid, oper_type, content) VALUES (?, '更新用户', ?)`,
      [req.session.loginId, `更新用户 ID:${req.params.id}`]
    );

    res.json({ success: true, message: '更新成功' });
  } catch (e) {
    handleError(res, e, '[users]');
  }
});

// ==================== 软删除用户（admin+） ====================
router.delete('/:id', requireRole('admin'), async (req, res) => {
  try {
    if (parseInt(req.params.id) === req.session.userId) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '不能删除自己');
    }

    // 超管不能被删除
    const [target] = await getPool().query(
      `SELECT role FROM users WHERE id = ? AND deleted_at IS NULL`,
      [req.params.id]
    );
    if (target.length === 0) {
      return sendError(res, 404, ErrorCodes.NOT_FOUND, '用户不存在');
    }
    if (target[0].role === 'super_admin') {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '不能删除超级管理员');
    }

    const [result] = await getPool().query(
      `UPDATE users SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL`,
      [req.params.id]
    );

    await getPool().query(
      `DELETE FROM notifications WHERE user_id = ?`,
      [req.params.id]
    );

    await getPool().query(
      `INSERT INTO sys_oper_log (admin_vrcid, oper_type, content) VALUES (?, '删除用户', ?)`,
      [req.session.loginId, `软删除用户 ID:${req.params.id}`]
    );

    res.json({ success: true, message: '用户已删除' });
  } catch (e) {
    handleError(res, e, '[users]');
  }
});

// ==================== 重置密码（admin+） ====================
router.post('/:id/reset-password', requireRole('admin'), async (req, res) => {
  try {
    const { newPassword, confirmPassword } = req.body;
    if (!newPassword) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请输入新密码');
    }
    const selfOk = await verifySelfPassword(req.session.userId, confirmPassword);
    if (!selfOk) return sendError(res, 403, ErrorCodes.FORBIDDEN, '管理员密码验证失败，敏感操作已拒绝');

    const strength = validatePasswordStrength(newPassword);
    if (!strength.valid) {
      return res.status(400).json({ error: '密码强度不足', details: strength.errors });
    }

    const [target] = await getPool().query(
      `SELECT id FROM users WHERE id = ? AND deleted_at IS NULL`,
      [req.params.id]
    );
    if (target.length === 0) {
      return sendError(res, 404, ErrorCodes.NOT_FOUND, '用户不存在');
    }

    const pwdHash = await hashPassword(newPassword);
    await getPool().query(`UPDATE users SET password_hash = ? WHERE id = ?`, [pwdHash, req.params.id]);
    // §44：管理员重置密码后删除该用户所有 session 记录，强制其他会话失效
    try {
      await getPool().query(`DELETE FROM sessions WHERE JSON_UNQUOTE(JSON_EXTRACT(data, '$.userId')) = ?`, [String(req.params.id)]);
    } catch (e) { logger.warn('users', '[admin-reset-password] 清理用户会话失败:', e.message); }

    await getPool().query(
      `INSERT INTO sys_oper_log (admin_vrcid, oper_type, content) VALUES (?, '重置密码', ?)`,
      [req.session.loginId, `重置用户 ${req.params.id} 密码`]
    );

    res.json({ success: true, message: '密码已重置' });
  } catch (e) {
    handleError(res, e, '[users]');
  }
});

// ==================== 我的资料 ====================
router.get('/me/profile', requireAuth, async (req, res) => {
  try {
    let rows;
    try {
      [rows] = await getPool().query(
        `SELECT id, login_id, display_name, vrchat_id, vrchat_name, vrchat_verified, role, banned, avatar_type,
                custom_avatar_path, vrchat_avatar_url, avatar_visible, qq_number_enc, birthday, email, last_login,
                location, lat, lng, location_visible, preferences, created_at, updated_at
         FROM users WHERE id = ? AND deleted_at IS NULL`,
        [req.session.userId]
      );
    } catch (e) {
      if (e.code === 'ER_BAD_FIELD_ERROR') {
        [rows] = await getPool().query(
          `SELECT id, login_id, display_name, vrchat_id, vrchat_name, vrchat_verified, role, banned, avatar_type,
                  custom_avatar_path, vrchat_avatar_url, avatar_visible, qq_number_enc, birthday,
                  location, lat, lng, location_visible, preferences, created_at, updated_at
           FROM users WHERE id = ?`,
          [req.session.userId]
        );
      } else {
        throw e;
      }
    }
    if (rows.length === 0) {
      return sendError(res, 404, ErrorCodes.NOT_FOUND, '用户不存在');
    }
    const u = rows[0];
    res.json({
      id: u.id,
      loginId: u.login_id,
      displayName: u.display_name,
      vrchatId: u.vrchat_id,
      vrchatName: u.vrchat_name,
      vrchatAvatarUrl: u.vrchat_avatar_url || null,
      vrchatVerified: !!u.vrchat_verified,
      role: u.role,
      banned: !!u.banned,
      avatarType: u.avatar_type,
      avatarVisible: u.avatar_visible === 0 ? false : true,
      customAvatarPath: u.custom_avatar_path || null,
      avatarUrl: getAvatarUrl(u),
      qq: decryptAES(u.qq_number_enc),
      birthday: u.birthday,
      location: u.location,
      lat: u.lat,
      lng: u.lng,
      locationVisible: !!u.location_visible,
      preferences: u.preferences,
      bio: u.preferences?.bio || '',
      motto: u.preferences?.motto || '',
      website: u.preferences?.website || '',
      socialLinks: u.preferences?.social_links || null,
      createdAt: u.created_at,
      updatedAt: u.updated_at,
      email: u.email || null,
      lastLoginTime: u.last_login || null,
      createTime: u.created_at
    });
  } catch (e) {
    handleError(res, e, '[users]');
  }
});

// ==================== 更新我的资料 ====================
router.put('/me/profile', requireAuth, async (req, res) => {
  try {
    if (req.session.userId === 0) {
      return sendError(res, 403, ErrorCodes.FORBIDDEN, '游客不能修改资料');
    }
    const { displayName, qq, birthday, location, preferences, bio, motto, website, socialLinks } = req.body;
    const updates = {};

    if (displayName !== undefined) {
      if (typeof displayName !== 'string' || displayName.length > 50) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '显示名不能超过50字');
      updates.display_name = displayName;
    }
    if (qq !== undefined) {
      if (typeof qq !== 'string' || qq.length > 50) return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'QQ号过长');
      updates.qq_number_enc = qq ? encryptAES(qq) : null;
    }
    if (birthday !== undefined) updates.birthday = birthday || null;
    if (location !== undefined) {
      if (typeof location !== 'string' || location.length > 200) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '所在地过长');
      updates.location = location || null;
    }

    // V6.10: socialLinks — 存入 preferences.social_links
    // bio 和 motto 存到 preferences JSON 字段 — 始终合并已有字段
    let prefsObj = {};
    try {
      const [current] = await getPool().query(`SELECT preferences FROM users WHERE id = ?`, [req.session.userId]);
      if (current.length > 0 && current[0].preferences) {
        prefsObj = typeof current[0].preferences === 'string' ? JSON.parse(current[0].preferences) : current[0].preferences;
      }
    } catch { prefsObj = {}; }

    // preferences 参数覆盖（如果前端传了完整的 preferences 对象）
    if (preferences !== undefined) {
      const incoming = typeof preferences === 'string' ? JSON.parse(preferences) : preferences;
      Object.assign(prefsObj, incoming);
    }
    if (bio !== undefined) prefsObj.bio = bio;
    if (motto !== undefined) prefsObj.motto = motto;
    // V6.10: website 存到 preferences.website
    if (website !== undefined) prefsObj.website = website;
    // V6.10: socialLinks 存到 preferences.social_links
    if (socialLinks !== undefined) {
      if (typeof socialLinks === 'string') prefsObj.social_links = JSON.parse(socialLinks);
      else prefsObj.social_links = socialLinks;
    }
    updates.preferences = JSON.stringify(prefsObj);

    validateFields(updates, ['display_name', 'qq_number_enc', 'birthday', 'location', 'preferences']);

    if (Object.keys(updates).length === 0) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '没有需要更新的字段');
    }

    const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const values = Object.values(updates);
    values.push(req.session.userId);

    await getPool().query(
      `UPDATE users SET ${fields}, updated_at = NOW() WHERE id = ? AND deleted_at IS NULL`,
      values
    );

    // 更新 session displayName
    if (displayName !== undefined) {
      req.session.displayName = displayName;
      await req.session.save();
    }

    // 操作日志
    const changedFields = Object.keys(updates).join(', ');
    await getPool().query(`INSERT INTO sys_oper_log (admin_vrcid, oper_type, content) VALUES (?, '更新个人资料', ?)`,
      [req.session.userId, `更新字段: ${changedFields}`]);

    res.json({ success: true, message: '资料更新成功' });
  } catch (e) {
    handleError(res, e, '[users]');
  }
});

// ==================== 上传自定义头像 ====================
router.post('/me/avatar', requireAuth, secureUpload(avatarUpload.single('avatar')), async (req, res) => {
  if (!req.file) {
    return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请选择头像图片');
  }
  try {
    // 每次上传使用时间戳唯一文件名，避免 Windows 下覆盖正在被读取的旧文件导致
    // sharp.toFile 报 "Permission denied / Invalid argument"（原地覆盖写锁冲突）。
    const ts = Date.now();
    const finalName = `${req.session.userId}_${ts}.jpg`;
    const thumbName = `${req.session.userId}_${ts}_64.jpg`;
    const finalPath = path.join(AVATAR_DIR, finalName);
    const thumbPath64 = path.join(AVATAR_DIR, thumbName);

    // 用 sharp 处理成 256x256 jpg（始终写入新文件，不存在覆盖锁冲突）
    await sharp(req.file.path)
      .resize(256, 256, { fit: 'cover' })
      .jpeg({ quality: 85 })
      .toFile(finalPath);

    // 生成缩略图
    await sharp(finalPath).resize(64, 64, { fit: 'cover' }).jpeg({ quality: 75 }).toFile(thumbPath64);

    // 删除上传临时文件
    try { fs.unlinkSync(req.file.path); } catch {}

    // 清理该用户旧头像文件（best-effort，忽略锁定/不存在）
    cleanupOldAvatars(req.session.userId, finalName, thumbName);

    const url = `/uploads/avatars/${finalName}`;
    const thumbUrl = `/uploads/avatars/${thumbName}`;

    await getPool().query(
      `UPDATE users SET avatar_type = 'custom', custom_avatar_path = ?, avatar_visible = 1, updated_at = NOW() WHERE id = ?`,
      [url, req.session.userId]
    );

    // 更新 session
    req.session.avatarType = 'custom';
    req.session.avatarUrl = url;
    await req.session.save();

    res.json({ success: true, avatarUrl: url, thumbUrl, message: '头像上传成功' });
    // 操作日志
    await getPool().query(`INSERT INTO sys_oper_log (admin_vrcid, oper_type, content) VALUES (?, '上传头像', ?)`,
      [req.session.userId, `上传自定义头像: ${req.file.originalname}`]);
  } catch (e) { handleError(res, e, '[users/avatar]'); }
});

// ==================== 切换到 VRChat 头像 ====================
router.post('/me/avatar-vrchat', requireAuth, async (req, res) => {
  try {
    const [users] = await getPool().query(
      `SELECT vrchat_id, vrchat_avatar_url FROM users WHERE id = ? AND deleted_at IS NULL`,
      [req.session.userId]
    );
    if (users.length === 0) {
      return sendError(res, 404, ErrorCodes.NOT_FOUND, '用户不存在');
    }
    if (!users[0].vrchat_id) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '未绑定VRChat账号');
    }

    // 尝试刷新 VRChat 头像
    let avatarUrl = users[0].vrchat_avatar_url;
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 10000);
      try {
        const profileRes = await fetch(
          `${VRC_API}/users/${users[0].vrchat_id}?apiKey=${VRC_API_KEY}`,
          { headers: { 'User-Agent': 'JingTuWeb/5.2' }, signal: ac.signal }
        );
        if (profileRes.ok) {
          const profile = await profileRes.json();
          avatarUrl = profile.currentAvatarThumbnailImageUrl || profile.userIcon || avatarUrl;
        }
      } finally { clearTimeout(t); }
    } catch (e) { logger.warn('users', '⚠️ 刷新 VRChat 头像失败:', e.message); }

    await getPool().query(
      `UPDATE users SET avatar_type = 'vrchat', vrchat_avatar_url = ?, avatar_visible = 1, updated_at = NOW() WHERE id = ?`,
      [avatarUrl, req.session.userId]
    );

    req.session.avatarType = 'vrchat';
    req.session.avatarUrl = avatarUrl;
    await req.session.save();

    res.json({ success: true, avatarUrl, message: '已切换为VRChat头像' });
    // 操作日志
    await getPool().query(`INSERT INTO sys_oper_log (admin_vrcid, oper_type, content) VALUES (?, '切换头像', ?)`,
      [req.session.userId, '切换为VRChat头像']);
  } catch (e) {
    handleError(res, e, '[users]');
  }
});

// ==================== 移除自定义头像 ====================
router.delete('/me/avatar', requireAuth, async (req, res) => {
  try {
    // 先查出当前存储的头像路径，确保唯一文件名也能被清理
    let currentPath = null;
    try {
      const [rows] = await getPool().query(`SELECT custom_avatar_path FROM users WHERE id = ?`, [req.session.userId]);
      if (rows && rows[0] && rows[0].custom_avatar_path) currentPath = rows[0].custom_avatar_path;
    } catch {}

    cleanupOldAvatars(req.session.userId, null, null);
    // 若 DB 中存的是唯一文件名（如 /uploads/avatars/4_123.jpg），额外精准删除
    if (currentPath) {
      const base = path.basename(currentPath);
      const full = path.join(AVATAR_DIR, base);
      try { if (fs.existsSync(full)) fs.unlinkSync(full); } catch {}
      const thumbFull = path.join(AVATAR_DIR, base.replace(/\.jpg$/, '_64.jpg'));
      try { if (fs.existsSync(thumbFull)) fs.unlinkSync(thumbFull); } catch {}
    }

    await getPool().query(
      `UPDATE users SET avatar_type = 'none', custom_avatar_path = NULL, vrchat_avatar_url = NULL, updated_at = NOW() WHERE id = ?`,
      [req.session.userId]
    );

    req.session.avatarType = 'none';
    req.session.avatarUrl = null;
    await req.session.save();

    res.json({ success: true, message: '头像已移除' });
    // 操作日志
    await getPool().query(`INSERT INTO sys_oper_log (admin_vrcid, oper_type, content) VALUES (?, '移除头像', ?)`,
      [req.session.userId, '移除自定义头像']);
  } catch (e) {
    handleError(res, e, '[users]');
  }
});

// ==================== 头像显示偏好（是否显示 + 显示哪种） §11.8.8 ====================
// 与原头像上传/切换接口解耦：本接口只改「显示开关」和「选用哪种头像」，
// 不动 custom_avatar_path / vrchat_avatar_url 本身。
router.post('/me/avatar-pref', requireAuth, async (req, res) => {
  try {
    const uid = req.session.userId;
    const { avatarVisible, avatarType } = req.body || {};
    const updates = [];
    const values = [];

    if (avatarVisible !== undefined) {
      if (avatarVisible !== 0 && avatarVisible !== 1 && avatarVisible !== false && avatarVisible !== true) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'avatarVisible 必须是 0/1');
      }
      updates.push('avatar_visible = ?');
      values.push(avatarVisible ? 1 : 0);
    }

    if (avatarType !== undefined) {
      if (!['custom', 'vrchat'].includes(avatarType)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'avatarType 必须是 custom 或 vrchat');
      }
      // 校验所选头像确实存在，避免选了一个不存在的头像类型导致全站显示空白
      const [rows] = await getPool().query(
        `SELECT avatar_type, custom_avatar_path, vrchat_avatar_url FROM users WHERE id = ?`,
        [uid]
      );
      if (rows.length === 0) return sendError(res, 404, ErrorCodes.NOT_FOUND, '用户不存在');
      const u = rows[0];
      if (avatarType === 'custom' && !u.custom_avatar_path) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '尚未设置本地头像，无法选用');
      }
      if (avatarType === 'vrchat' && !u.vrchat_avatar_url) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '尚未绑定 VRChat 头像，无法选用');
      }
      updates.push('avatar_type = ?');
      values.push(avatarType);
    }

    if (updates.length === 0) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '没有任何要更新的字段');
    }

    values.push(uid);
    await getPool().query(
      `UPDATE users SET ${updates.join(', ')}, updated_at = NOW() WHERE id = ?`,
      values
    );

    // 同步 session（头像显示/选用变化后，依赖 session.avatarUrl 的即时渲染保持一致）
    if (avatarVisible !== undefined) req.session.avatarVisible = avatarVisible ? 1 : 0;
    if (avatarType !== undefined) req.session.avatarType = avatarType;
    const [su] = await getPool().query(`SELECT avatar_type, custom_avatar_path, vrchat_avatar_url, avatar_visible FROM users WHERE id = ?`, [uid]);
    if (su.length) {
      const s = su[0];
      req.session.avatarUrl = s.avatar_visible === 0 ? null : getAvatarUrl(s);
    }
    await req.session.save();

    const [rows] = await getPool().query(`SELECT avatar_type, avatar_visible FROM users WHERE id = ?`, [uid]);
    const u = rows[0];
    res.json({
      success: true,
      avatarType: u.avatar_type,
      avatarVisible: u.avatar_visible === 0 ? false : true,
      avatarUrl: getAvatarUrl(u),
      message: '头像显示设置已更新'
    });
  } catch (e) {
    handleError(res, e, '[users/avatar-pref]');
  }
});

// ==================== 更新个人位置（静态手动更新） V6.13 ====================
// 用户手动点"更新位置"时保存 GPS 到服务器
router.put('/me/location', requireAuth, async (req, res) => {
  try {
    const { lat, lng, location, visible } = req.body;
    const updates = {};
    if (lat !== undefined) {
      const v = parseFloat(lat);
      // 坐标必须合法，否则会写入 NaN/越界值并污染地图标记
      if (!Number.isFinite(v) || v < -90 || v > 90) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '纬度无效');
      }
      updates.lat = v;
    }
    if (lng !== undefined) {
      const v = parseFloat(lng);
      if (!Number.isFinite(v) || v < -180 || v > 180) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '经度无效');
      }
      updates.lng = v;
    }
    if (location !== undefined) updates.location = location;
    if (visible !== undefined) updates.location_visible = visible ? 1 : 0;
    // 记录位置时间戳，否则地图气泡的"更新时间"永远为空
    if (updates.lat !== undefined || updates.lng !== undefined) {
      updates.location_updated_at = new Date();
    }
    // V6.13: 如果关掉位置可见，删除服务器上的 lat/lng
    if (visible !== undefined && !visible) {
      updates.lat = null;
      updates.lng = null;
      updates.location_updated_at = null;
    }
    validateFields(updates, ['lat', 'lng', 'location', 'location_visible', 'location_updated_at']);
    if (Object.keys(updates).length === 0) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '无更新字段');
    const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const vals = Object.values(updates);
    vals.push(req.session.userId);
    await getPool().query(`UPDATE users SET ${fields}, updated_at = NOW() WHERE id = ?`, vals);
    res.json({ success: true, message: '位置更新成功' });
  } catch (e) {
    handleError(res, e, '[users]');
  }
});

// ==================== 用户公开名片（按ID） ====================
router.get('/:id/card', requireAuth, async (req, res, next) => {
  // 跳过 /me/* 路由，避免和 /me/events 等冲突
  if (req.params.id === 'me') return next('route');
  try {
    const id = parseInt(req.params.id);
    if (!id) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');

    const [rows] = await getPool().query(
      `SELECT u.id, u.login_id, u.display_name, u.vrchat_id, u.vrchat_name,
              u.role, u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url,
              u.birthday, u.location, u.location_visible, u.preferences,
              u.created_at
       FROM users u
       WHERE u.id = ? AND u.deleted_at IS NULL`,
      [id]
    );
    if (rows.length === 0) return sendError(res, 404, ErrorCodes.NOT_FOUND, '用户不存在');

    const u = rows[0];
    const prefs = typeof u.preferences === 'string' ? JSON.parse(u.preferences) : (u.preferences || {});
    // 获取该用户报名的活动数和照片数
    const [[{ evtCount }]] = await getPool().query(
      `SELECT COUNT(*) AS evtCount FROM event_sign WHERE user_vrcid = ?`, [u.id]
    );
    const [[{ photoCount }]] = await getPool().query(
      `SELECT COUNT(*) AS photoCount FROM user_photos WHERE user_id = ?`, [u.id]
    );
    res.json({
      id: u.id,
      loginId: u.login_id,
      displayName: u.display_name,
      vrchatName: u.vrchat_name,
      role: u.role,
      roleLabel: u.role === 'super_admin' ? '超级管理员' : u.role === 'admin' ? '管理员' : u.role === 'member' ? '成员' : '访客',
      avatarUrl: getAvatarUrl(u),
      birthday: u.birthday,
      location: u.location,
      locationVisible: !!u.location_visible,
      motto: prefs.motto || '',
      bio: prefs.bio || '',
      joinedAt: u.created_at,
      evtCount,
      photoCount
    });
  } catch (e) {
    handleError(res, e, '[users]');
  }
});

// 获取当前用户报名过的活动
router.get('/me/events', requireAuth, async (req, res) => {
  try {
    const [rows] = await getPool().query(
      `SELECT e.id, e.title, e.event_time AS eventTime, e.ends_at AS endsAt, e.place,
              e.description, e.event_type AS eventType, e.visibility,
              e.world_name AS worldName, e.world_image_url AS worldImageUrl,
              es.sign_time AS signTime, es.is_sign AS isSign
       FROM event_sign es
       JOIN event e ON es.event_id = e.id
       WHERE es.user_vrcid = ?
       ORDER BY e.event_time DESC`,
      [req.session.userId]
    );
    res.json({ events: rows });
  } catch (e) { handleError(res, e, '[users]'); }
});

// 获取指定用户报名过的活动
router.get('/:userId/events', requireAuth, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    if (!userId) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
    const [rows] = await getPool().query(
      `SELECT e.id, e.title, e.event_time AS eventTime, e.ends_at AS endsAt, e.place,
              e.description, e.event_type AS eventType, e.visibility,
              e.world_name AS worldName, e.world_image_url AS worldImageUrl,
              es.sign_time AS signTime
       FROM event_sign es
       JOIN event e ON es.event_id = e.id
       WHERE es.user_vrcid = ?
       ORDER BY e.event_time DESC`,
      [userId]
    );
    res.json({ events: rows });
  } catch (e) { handleError(res, e, '[users]'); }
});

// 获取指定用户上传的照片
router.get('/:userId/photos', requireAuth, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    if (!userId) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
    const [rows] = await getPool().query(
      `SELECT ap.id, ap.photo_path AS url, ap.thumb_path AS thumbnail,
              ap.photo_desc AS caption, ap.create_time AS createdAt,
              ap.like_count AS likeCount
       FROM album_photo ap
       WHERE ap.upload_vrcid = ? AND ap.is_recycle = 0
       ORDER BY ap.create_time DESC`,
      [String(userId)]
    );
    res.json({ photos: rows });
  } catch (e) { handleError(res, e, '[users]'); }
});



// ==================== 用户标签 API ====================
router.get('/tags/list', requireAdminCompat, async (req, res) => {
  try {
    const [rows] = await getPool().query(
      'SELECT tag_name AS name, COUNT(*) AS count FROM user_tags GROUP BY tag_name ORDER BY count DESC LIMIT 20'
    );
    res.json({ tags: rows });
  } catch (e) { handleError(res, e, '[users/tags]'); }
});

router.get('/:userId/tags', requireAdminCompat, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const [rows] = await getPool().query(
      'SELECT id, tag_name AS name, color, create_time AS createTime FROM user_tags WHERE user_id = ? ORDER BY create_time DESC',
      [userId]
    );
    res.json({ tags: rows });
  } catch (e) { handleError(res, e, '[users/tag-get]'); }
});

router.post('/:userId/tags', requireAdminCompat, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const { name, color } = req.body;
    if (!name || !name.trim()) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '标签名称不能为空');
    if (name.length > 50) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '标签名称不能超过50字');
    await getPool().query(
      'INSERT INTO user_tags (user_id, tag_name, color) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE color = ?',
      [userId, name.trim(), color || '#1890ff', color || '#1890ff']
    );
    await logOper(req.session.userId, '添加用户标签', `用户ID: ${userId}, 标签: ${name}`);
    res.json({ success: true });
  } catch (e) { handleError(res, e, '[users/tag-add]'); }
});

router.delete('/:userId/tags/:tagId', requireAdminCompat, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const tagId = parseInt(req.params.tagId);
    await getPool().query('DELETE FROM user_tags WHERE id = ? AND user_id = ?', [tagId, userId]);
    await logOper(req.session.userId, '删除用户标签', `用户ID: ${userId}, 标签ID: ${tagId}`);
    res.json({ success: true });
  } catch (e) { handleError(res, e, '[users/tag-delete]'); }
});

// ==================== 用户备注 API ====================
router.get('/:userId/notes', requireAuth, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const [rows] = await getPool().query(
      'SELECT id, target_id, note_text, note_color, note_tags, update_time AS updateTime FROM member_note WHERE owner_id = ? AND target_id = ?',
      [req.session.userId, userId]
    );
    if (rows.length > 0) {
      const r = rows[0];
      res.json({
        note: {
          id: r.id,
          noteText: r.note_text,
          noteColor: r.note_color || '',
          noteTags: r.note_tags ? r.note_tags.split(',').filter(Boolean) : [],
          updateTime: r.updateTime
        }
      });
    } else {
      res.json({ note: null });
    }
  } catch (e) { handleError(res, e, '[users/notes-get]'); }
});

const NOTE_COLORS = ['', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'gray'];
router.post('/:userId/notes', requireAuth, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const { noteText, noteColor, noteTags } = req.body;
    if (!noteText) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '备注内容不能为空');
    if (noteText.length > 200) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '备注内容不能超过200字');
    const color = NOTE_COLORS.includes(noteColor) ? noteColor : '';
    let tagsStr = '';
    if (Array.isArray(noteTags)) tagsStr = noteTags.slice(0, 8).map(String).join(',').slice(0, 255);
    else if (typeof noteTags === 'string') tagsStr = noteTags.slice(0, 255);
    await getPool().query(
      'INSERT INTO member_note (owner_id, target_id, note_text, note_color, note_tags) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE note_text = ?, note_color = ?, note_tags = ?, update_time = NOW()',
      [req.session.userId, userId, noteText, color, tagsStr, noteText, color, tagsStr]
    );
    await logOper(req.session.userId, '设置用户备注', `用户ID: ${userId}, 备注: ${noteText}`);
    res.json({ success: true });
  } catch (e) { handleError(res, e, '[users/notes-set]'); }
});

router.delete('/:userId/notes', requireAuth, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    await getPool().query('DELETE FROM member_note WHERE owner_id = ? AND target_id = ?', [req.session.userId, userId]);
    await logOper(req.session.userId, '删除用户备注', `用户ID: ${userId}`);
    res.json({ success: true });
  } catch (e) { handleError(res, e, '[users/notes-delete]'); }
});

router.post('/me/change-password', requireAuth, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请输入旧密码和新密码');
    let users;
    try {
      [users] = await getPool().query('SELECT password_hash FROM users WHERE id = ? AND deleted_at IS NULL', [req.session.userId]);
    } catch (e) {
      if (e.code === 'ER_BAD_FIELD_ERROR') {
        [users] = await getPool().query('SELECT password_hash FROM users WHERE id = ?', [req.session.userId]);
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
    await getPool().query('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, req.session.userId]);
    await logOper(req.session.userId, '修改密码', '用户修改了密码');
    res.json({ success: true, message: '密码修改成功' });
  } catch (e) { handleError(res, e, '[users/change-password]'); }
});

router.post('/me/logout-all', requireAuth, async (req, res) => {
  try {
    const uid = req.session.userId;
    const pool = getPool();
    // 真正登出该用户所有设备/浏览器会话：express-mysql-session 将 session 对象
    // 序列化为 JSON 存入 sessions.data 列（含 "userId":<id>），按 userId 清除全部行。
    try {
      await pool.query(`DELETE FROM sessions WHERE data LIKE ?`, ['%"userId":' + uid + '%']);
    } catch (e) { logger.error('users', '[logout-all] clear sessions', e); }
    req.session.destroy(() => {
      res.clearCookie('connect.sid');
      res.json({ success: true, message: '已退出所有会话' });
    });
  } catch (e) { logger.error('users', '[logout-all]', e); handleError(res, e, '[users]'); }
});

module.exports = router;
