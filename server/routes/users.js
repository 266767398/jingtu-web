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
const { fail, ok,  getPool, safeError, validateFields, handleError, sendError, ErrorCodes, createErr, createFileFilter, secureUpload, paginate, logOper, escapeLike  } = require('../utils');;
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
    const { page, pageSize, offset } = paginate(req, { defaultSize: 100 });

    const [count] = await getPool().query(
      `SELECT COUNT(*) as total FROM users WHERE deleted_at IS NULL AND approved = 1 AND banned = 0`
    );
    // F-7: 关联 group_roster 的信任等级（schedule 定时任务已同步），取该用户在所有群组中
    // 信任阶最高的一个作为列表徽章展示值，避免 VRChat API 逐个查询的开销。
    // MySQL 5.7 无窗口函数，用 FIELD() 求最高阶 + MIN() 聚合兼容 ONLY_FULL_GROUP_BY。
    const TRUST_ORDER = `'legend','veteran','vetted','trusted','known','user','new','visitor','negative'`;
    const [rows] = await getPool().query(
      `SELECT u.id, u.login_id AS loginId, u.display_name, u.vrchat_id, u.vrchat_name, u.role, u.avatar_type,
              u.custom_avatar_path, u.vrchat_avatar_url,
              u.location, u.lat, u.lng, u.location_visible AS locationVisible,
              COALESCE(l.likeCount, 0) AS likeCount,
              tr.trust_level AS trustLevel, tr.trust_level_cn AS trustLevelCn
       FROM users u
       LEFT JOIN (SELECT to_user_id, COUNT(*) AS likeCount FROM user_like GROUP BY to_user_id) l
         ON u.id = l.to_user_id
       LEFT JOIN (
         SELECT g.vrchat_id, MIN(g.trust_level) AS trust_level, MIN(g.trust_level_cn) AS trust_level_cn
         FROM group_roster g
         JOIN (
           SELECT vrchat_id, MAX(FIELD(trust_level, ${TRUST_ORDER})) AS maxrk
           FROM group_roster
           WHERE trust_level IS NOT NULL AND trust_level <> ''
           GROUP BY vrchat_id
         ) m ON m.vrchat_id = g.vrchat_id
         WHERE g.trust_level IS NOT NULL AND g.trust_level <> ''
           AND FIELD(g.trust_level, ${TRUST_ORDER}) = m.maxrk
         GROUP BY g.vrchat_id
       ) tr ON tr.vrchat_id = u.vrchat_id
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
      likeCount: parseInt(u.likeCount) || 0,
      trustLevel: u.trustLevel || '',
      trustLevelCn: u.trustLevelCn || ''
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
    const { page, pageSize, offset } = paginate(req, { defaultSize: 20 });

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
      return fail(res, 400, '密码强度不足', { details: strength.errors });
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
    ok(res, { id: userId, message: '用户创建成功' });
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
    const like = '%' + escapeLike(q) + '%';
    const [rows] = await getPool().query(
      'SELECT id, display_name, vrchat_id, vrchat_name, vrchat_avatar_url, avatar_type, custom_avatar_path, role FROM users WHERE deleted_at IS NULL AND banned = 0 AND approved = 1 AND (display_name LIKE ? ESCAPE \'!\' OR vrchat_name LIKE ? ESCAPE \'!\') ORDER BY display_name ASC LIMIT 20',
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
    ok(res, { imported });
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
    // P3-122：与 PUT /me/profile、admin 改名同一口径——display_name ≤50 且非空、禁控制字符
    if (displayName !== undefined && displayName !== null && String(displayName).trim() !== '') {
      const nm = String(displayName).trim();
      if (nm.length > 50) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '显示名不能超过50字');
      // eslint-disable-next-line no-control-regex
      if (/[<>\u0000-\u001f\u007f]/.test(nm)) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '显示名包含不允许的字符');
      updates.display_name = nm;
    }
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
        const curRole = curRoleRows[0].role || 'member';
        // P1-52: 禁止非超管操作任何超管账号的角色（防止把唯一超管降级造成权限真空/接管）
        if (curRole === 'super_admin' && req.session.role !== 'super_admin') {
          return sendError(res, 403, ErrorCodes.FORBIDDEN, '只有超级管理员可以修改超级管理员的角色');
        }
        // P1-52: 普通 admin 不能修改其他管理员（admin/super_admin）的角色
        if (req.session.role !== 'super_admin' && curRole !== 'member' && parseInt(req.params.id) !== req.session.userId) {
          return sendError(res, 403, ErrorCodes.FORBIDDEN, '普通管理员不能修改其他管理员的角色');
        }
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

    ok(res, { message: '更新成功' });
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

    ok(res, { message: '用户已删除' });
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
      return fail(res, 400, '密码强度不足', { details: strength.errors });
    }

    const [target] = await getPool().query(
      `SELECT id, role FROM users WHERE id = ? AND deleted_at IS NULL`,
      [req.params.id]
    );
    if (target.length === 0) {
      return sendError(res, 404, ErrorCodes.NOT_FOUND, '用户不存在');
    }
    // P1-51: 目标为 super_admin 时仅超管可重置；普通 admin 不能重置其他管理员的密码（防直接提权）
    const targetRole = target[0].role || 'member';
    if (targetRole === 'super_admin' && req.session.role !== 'super_admin') {
      return sendError(res, 403, ErrorCodes.FORBIDDEN, '只有超级管理员可以重置超级管理员的密码');
    }
    if (req.session.role !== 'super_admin' && targetRole !== 'member') {
      return sendError(res, 403, ErrorCodes.FORBIDDEN, '普通管理员不能重置其他管理员的密码');
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

    ok(res, { message: '密码已重置' });
  } catch (e) {
    handleError(res, e, '[users]');
  }
});

// ==================== 按域拆出的子路由（P2-66 god-route 拆分） ====================
// 在原代码块所在位置透传挂载：route_guard 的 collectRoutes 会递归进入子 router，
// /api/users 的路由总数（32）与各路径注册顺序完全不变。
router.use(require('./users_profile'));

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
      // P2-163: location 脱敏口径与 /list 一致——location_visible 未开启时返回 null
      location: u.location_visible ? u.location : null,
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
    // P2-163: 按 visibility 过滤——private 活动仅本人（被查者=自己）或管理员可见；
    // 同时过滤 is_archive，避免遍历 userId 枚举他人私密活动报名列表
    const isSelf = req.session.userId === userId;
    const isAdminView = req.session.role === 'super_admin' || req.session.role === 'admin';
    const [rows] = await getPool().query(
      `SELECT e.id, e.title, e.event_time AS eventTime, e.ends_at AS endsAt, e.place,
              e.description, e.event_type AS eventType, e.visibility,
              e.world_name AS worldName, e.world_image_url AS worldImageUrl,
              es.sign_time AS signTime
       FROM event_sign es
       JOIN event e ON es.event_id = e.id
       WHERE es.user_vrcid = ?
         AND e.is_archive = 0
         AND (e.visibility IN ('public','members_only')
              OR (e.visibility = 'private' AND ? = 1)
              OR (e.visibility = 'private' AND ? = 1))
       ORDER BY e.event_time DESC`,
      [userId, isSelf ? 1 : 0, isAdminView ? 1 : 0]
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



// ==================== 按域拆出的子路由（P2-66 god-route 拆分）：标签 / 备注 ====================
router.use(require('./users_tags_notes'));

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
    if (!strength.valid) return fail(res, 400, '新密码强度不足', { details: strength.errors });
    const newHash = await hashPassword(newPassword);
    await getPool().query('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, req.session.userId]);
    await logOper(req.session.userId, '修改密码', '用户修改了密码');
    ok(res, { message: '密码修改成功' });
  } catch (e) { handleError(res, e, '[users/change-password]'); }
});

router.post('/me/logout-all', requireAuth, async (req, res) => {
  try {
    const uid = req.session.userId;
    const pool = getPool();
    // 真正登出该用户所有设备/浏览器会话：express-mysql-session 将 session 对象
    // 序列化为 JSON 存入 sessions.data 列（含 "userId":<id>），按 userId 清除全部行。
    // P1-10 关联修复：旧 `data LIKE '%"userId":1%'` 会把 userId 12/100/123… 的会话
    // 一并删除（前缀匹配），改为 JSON_EXTRACT 精确等值比较。
    try {
      await pool.query(
        `DELETE FROM sessions WHERE JSON_UNQUOTE(JSON_EXTRACT(data,'$.userId')) = ?`,
        [String(uid)]
      );
    } catch (e) { logger.error('users', '[logout-all] clear sessions', e); }
    req.session.destroy(() => {
      res.clearCookie('connect.sid');
      ok(res, { message: '已退出所有会话' });
    });
  } catch (e) { logger.error('users', '[logout-all]', e); handleError(res, e, '[users]'); }
});

module.exports = router;
