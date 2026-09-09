/**
 * 境途同游 — 管理后台用户管理路由（P2-4 第三批：自 admin.js 按域拆出）
 * 行为逐字保留：/admin/users 增删查改，敏感操作要求当前管理员二次密码确认（B-2/P2-14）。
 *
 * @swagger
 * tags:
 *   name: AdminUsers
 *   description: 管理后台用户管理接口
 */
const express = require('express');
const { fail, ok, getPool, handleError, logOper, sendError, ErrorCodes } = require('../utils');
const {
  requireAdminCompat, requireRole,
  hashPassword, validatePasswordStrength, verifyPassword,
  getAvatarUrl, ROLE_LEVEL
} = require('../auth');
const activationCodes = require('../activation_code_service');

module.exports = function createAdminUsersRouter() {
  const router = express.Router();

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

  // 校验当前用户是否有权变更目标用户账户（防止 admin 操作 super_admin 等高权限账户）
  // 返回 { ok, targetUser } 或 { ok:false, status, code, message }
  async function assertCanModifyTarget(req, res, targetId) {
    const [rows] = await getPool().query('SELECT id, display_name, role FROM users WHERE id = ?', [targetId]);
    if (rows.length === 0) {
      sendError(res, 404, ErrorCodes.NOT_FOUND, '用户不存在');
      return { ok: false };
    }
    const targetUser = rows[0];
    const currentLevel = ROLE_LEVEL[req.session.role] || 0;
    const targetLevel = ROLE_LEVEL[targetUser.role] || 0;
    // 目标为 super_admin 时必须本人为 super_admin；且禁止操作比自己角色更高的账户
    if (targetUser.role === 'super_admin' && req.session.role !== 'super_admin') {
      sendError(res, 403, ErrorCodes.FORBIDDEN, '无权操作超级管理员账户');
      return { ok: false };
    }
    if (targetLevel > currentLevel) {
      sendError(res, 403, ErrorCodes.FORBIDDEN, '无权操作比自身角色更高的账户');
      return { ok: false };
    }
    return { ok: true, targetUser };
  }

  // ==================== 管理员用户管理 CRUD ====================
  router.get('/admin/users', requireAdminCompat, async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const pageSize = parseInt(req.query.pageSize) || 20;
      const offset = (page - 1) * pageSize;
      const search = req.query.search ? req.query.search.trim() : '';
      const roleFilter = req.query.role ? req.query.role.trim() : '';
      const statusFilter = req.query.status ? req.query.status.trim() : '';
      let where = ['u.deleted_at IS NULL'];
      const params = [];
      if (search) { where.push('(u.login_id LIKE ? OR u.display_name LIKE ? OR u.vrchat_name LIKE ?)'); params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
      if (roleFilter) { where.push('u.role = ?'); params.push(roleFilter); }
      if (statusFilter === 'banned') { where.push('u.banned = 1'); }
      else if (statusFilter === 'pending') { where.push('u.approved = 0 AND u.banned = 0'); }
      else if (statusFilter === 'active') { where.push('u.banned = 0'); }
      const w = where.join(' AND ');
      const [count] = await getPool().query(`SELECT COUNT(*) as total FROM users u WHERE ${w}`, params);
      const [rows] = await getPool().query(
        `SELECT u.id, u.login_id AS loginId, u.display_name AS displayName, u.role, u.banned, u.approved,
                u.vrchat_name AS vrchatName, u.vrchat_id AS vrchatId, u.created_at AS createTime,
                u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url,
                u.email, u.birthday, u.preferences
         FROM users u WHERE ${w} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`, [...params, pageSize, offset]
      );
      const mapped = rows.map(u => ({ ...u, avatarUrl: getAvatarUrl(u) }));
      res.json({ users: mapped, total: count[0].total, page, pageSize, totalPages: Math.ceil(count[0].total / pageSize) });
    } catch (e) { handleError(res, e, '[admin/users]'); }
  });

  router.post('/admin/users', requireRole('super_admin'), async (req, res) => {
    const { loginId, displayName, password, role, email } = req.body;
    if (!loginId || !password) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '用户名和密码不能为空');
    const pwCheck = validatePasswordStrength(password);
    if (!pwCheck.valid) return fail(res, 400, pwCheck.errors.join('; '));
    try {
      const [dup] = await getPool().query(`SELECT id FROM users WHERE login_id = ?`, [loginId]);
      if (dup.length > 0) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '用户名已存在');
      const hashedPw = await hashPassword(password);
      const userRole = role && ['super_admin', 'admin', 'member'].includes(role) ? role : 'member';
      const [result] = await getPool().query(
        `INSERT INTO users (login_id, display_name, password_hash, role, approved, email) VALUES (?, ?, ?, ?, 1, ?)`,
        [loginId, displayName || loginId, hashedPw, userRole, email || null]
      );
      const userId = result.insertId;
      let groupId = 3;
      if (userRole === 'super_admin') groupId = 1;
      else if (userRole === 'admin') groupId = 2;
      await getPool().query(
        `INSERT IGNORE INTO user_group_membership (user_id, group_id) VALUES (?, ?)`,
        [userId, groupId]
      );
      await logOper(req.session.userId, '创建用户', `创建用户 ${displayName || loginId} (${loginId}) 角色: ${userRole}`);
      ok(res, { id: userId });
    } catch (e) { handleError(res, e, '[admin/users/post]'); }
  });

  router.post('/admin/users/:id/approve', requireAdminCompat, async (req, res) => {
    try { await getPool().query(`UPDATE users SET approved=1 WHERE id=?`, [req.params.id]); await logOper(req.session.userId, '批准用户', `批准用户 #${req.params.id}`); ok(res); }
    catch (e) { handleError(res, e, '[admin/users/approve]'); }
  });
  router.post('/admin/users/:id/ban', requireAdminCompat, async (req, res) => {
    try {
      const guard = await assertCanModifyTarget(req, res, req.params.id);
      if (!guard.ok) return;
      await getPool().query(`UPDATE users SET banned=1 WHERE id=?`, [req.params.id]);
      await getPool().query(`DELETE FROM notifications WHERE user_id = ?`, [req.params.id]);
      await logOper(req.session.userId, '封禁用户', `封禁用户 ${guard.targetUser.display_name} (#${req.params.id})`);
      ok(res);
    }
    catch (e) { handleError(res, e, '[admin/users/ban]'); }
  });
  router.post('/admin/users/:id/unban', requireAdminCompat, async (req, res) => {
    try {
      const guard = await assertCanModifyTarget(req, res, req.params.id);
      if (!guard.ok) return;
      await getPool().query(`UPDATE users SET banned=0 WHERE id=?`, [req.params.id]);
      await logOper(req.session.userId, '解封用户', `解封用户 ${guard.targetUser.display_name} (#${req.params.id})`);
      ok(res);
    }
    catch (e) { handleError(res, e, '[admin/users/unban]'); }
  });
  router.delete('/admin/users/:id', requireAdminCompat, async (req, res) => {
    try {
      const guard = await assertCanModifyTarget(req, res, req.params.id);
      if (!guard.ok) return;
      await getPool().query(`UPDATE users SET deleted_at=NOW() WHERE id=?`, [req.params.id]);
      await logOper(req.session.userId, '删除用户', `删除用户 ${guard.targetUser.display_name} (#${req.params.id})`);
      ok(res);
    }
    catch (e) { handleError(res, e, '[admin/users/delete]'); }
  });
  router.post('/admin/users/:id/reset-password', requireAdminCompat, async (req, res) => {
    try {
      const { newPassword, confirmPassword } = req.body;
      if (!newPassword) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请提供新密码');
      const selfOk = await verifySelfPassword(req.session.userId, confirmPassword);
      if (!selfOk) return sendError(res, 403, ErrorCodes.FORBIDDEN, '管理员密码验证失败，敏感操作已拒绝');
      const pwCheck = validatePasswordStrength(newPassword);
      if (!pwCheck.valid) return fail(res, 400, pwCheck.errors.join('; '));
      const guard = await assertCanModifyTarget(req, res, req.params.id);
      if (!guard.ok) return;
      const hashed = await hashPassword(newPassword);
      await getPool().query(`UPDATE users SET password_hash=? WHERE id=?`, [hashed, req.params.id]);
      await logOper(req.session.userId, '重置密码', `管理员 ${req.session.displayName} 重置了用户 ${guard.targetUser.display_name} (#${req.params.id}) 的密码`);
      ok(res);
    }
    catch (e) { handleError(res, e, '[admin/users/reset-password]'); }
  });

  // ==================== 激活码管理（仅超管） ====================
  // 网页后台生成激活码：写入本地 JSON 文件，与离线工具共用文件锁
  router.post('/admin/activation-codes/generate', requireRole('super_admin'), async (req, res) => {
    try {
      const count = parseInt(req.body?.count, 10) || 1;
      const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 100) : '';
      const operator = req.session.displayName || req.session.loginId || String(req.session.userId || 'super_admin');
      const created = await activationCodes.generateCodes(count, operator, note);
      await logOper(req.session.userId, '生成激活码', `生成 ${created.length} 个激活码（${created.map(c => c.code).join(', ')}）`);
      ok(res, { codes: created.map(c => c.code), count: created.length, message: `已生成 ${created.length} 个激活码` });
    } catch (e) {
      if (e instanceof activationCodes.ActivationCodeError) return fail(res, 500, e.message, { code: e.reason });
      handleError(res, e, '[admin/activation-codes/generate]');
    }
  });

  // 激活码列表（含已用状态，便于超管排查）
  router.get('/admin/activation-codes', requireRole('super_admin'), async (req, res) => {
    try {
      const list = await activationCodes.listCodes();
      ok(res, { total: list.total, used: list.used, unused: list.unused, revoked: list.revoked, codes: list.codes });
    } catch (e) {
      if (e instanceof activationCodes.ActivationCodeError) return fail(res, 500, e.message, { code: e.reason });
      handleError(res, e, '[admin/activation-codes/list]');
    }
  });

  // 本地软件启动时推送激活码（超管会话认证；幂等合并：已存在码原样跳过）
  router.post('/admin/activation-codes/sync', requireRole('super_admin'), async (req, res) => {
    try {
      const codes = Array.isArray(req.body?.codes) ? req.body.codes : null;
      if (!codes || codes.length === 0) return fail(res, 400, 'codes 为空或格式非法', { code: 'EMPTY_BATCH' });
      const result = await activationCodes.importCodes(codes, 'p2p-sync');
      if (!result.ok) return fail(res, 400, '激活码导入失败', { code: result.reason, invalid: result.invalid });
      await logOper(req.session.userId, '推送激活码（本地）',
        `导入 ${result.imported.length} 个，跳过 ${result.skipped.length} 个，无效 ${result.invalid.length} 个`);
      ok(res, { imported: result.imported, skipped: result.skipped, invalid: result.invalid, alreadySynced: result.imported.length === 0 });
    } catch (e) {
      if (e instanceof activationCodes.ActivationCodeError) return fail(res, 500, e.message, { code: e.reason });
      handleError(res, e, '[admin/activation-codes/sync]');
    }
  });

  // 作废激活码（未使用且未作废的码才可作废，作废后永久失效）
  router.post('/admin/activation-codes/revoke', requireRole('super_admin'), async (req, res) => {
    try {
      const code = typeof req.body?.code === 'string' ? req.body.code : '';
      const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 200) : '';
      if (!code) return fail(res, 400, '请提供要作废的激活码', { code: 'EMPTY_CODE' });
      const operator = req.session.displayName || req.session.loginId || String(req.session.userId || 'super_admin');
      const result = await activationCodes.revokeCode(code, operator, reason);
      if (!result.ok) {
        const msgs = {
          INVALID_FORMAT: '激活码格式不正确',
          NOT_FOUND: '激活码不存在',
          ALREADY_USED: '该激活码已被使用，无法作废',
          ALREADY_REVOKED: '该激活码已作废，无需重复操作'
        };
        return fail(res, 400, msgs[result.reason] || '作废失败', { code: result.reason, used_by: result.used_by, used_at: result.used_at });
      }
      await logOper(req.session.userId, '作废激活码', `作废激活码 ${result.entry.code}${reason ? `（原因：${reason}）` : ''}`);
      ok(res, { code: result.entry.code, revoked_at: result.entry.revoked_at, message: `已作废 ${result.entry.code}` });
    } catch (e) {
      if (e instanceof activationCodes.ActivationCodeError) return fail(res, 500, e.message, { code: e.reason });
      handleError(res, e, '[admin/activation-codes/revoke]');
    }
  });

  return router;
};
