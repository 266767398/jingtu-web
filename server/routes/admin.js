/**
 * 境途同游 V6.14 — 管理 / 搜索 / 改名 / 权限系统路由
 * 
 * @swagger
 * tags:
 *   name: Admin
 *   description: 管理后台相关接口
 */
const express = require('express');
const { getPool, handleError, logOper , sendError, ErrorCodes } = require('../utils');
const {
  requireAuth, requireAdminCompat, requireRole,
  hashPassword, validatePasswordStrength, verifyPassword,
  getAvatarUrl, ROLE_LEVEL
} = require('../auth');
const logger = require('../logger');
const settings = require('../settings');
const {
  csvField,
  collectUserData,
  importUserData
} = require('./user-data-helper');

module.exports = function (groupId, vrcCookieCfg) {
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

  // V8.2: 读取/设置 VRChat cookie 软性过期时间（天）。0=永不过期。
  const VALID_EXPIRE = [0, 7, 30, 90, 180, 365];
  router.get('/vrc-cookie-expire', requireAdminCompat, async (req, res) => {
    try {
      const days = (vrcCookieCfg && typeof vrcCookieCfg.getExpireDays === 'function')
        ? vrcCookieCfg.getExpireDays()
        : 0;
      res.json({ expireDays: days, options: VALID_EXPIRE });
    } catch (e) { handleError(res, e, '[admin/vrc-cookie-expire:get]'); }
  });
  router.put('/vrc-cookie-expire', requireAdminCompat, async (req, res) => {
    try {
      const days = parseInt(req.body.expireDays, 10);
      if (!VALID_EXPIRE.includes(days)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '无效的过期时间选项');
      }
      const pool = getPool();
      await pool.query(
        `INSERT INTO system_config (config_key, config_value, updated_by) VALUES ('vrc_cookie_expire_days', ?, ?)
         ON DUPLICATE KEY UPDATE config_value = VALUES(config_value), updated_by = VALUES(updated_by)`,
        [String(days), req.session?.userId || null]
      );
      if (vrcCookieCfg && typeof vrcCookieCfg.setExpireDays === 'function') {
        vrcCookieCfg.setExpireDays(days);
      }
      res.json({ success: true, expireDays: days });
    } catch (e) { handleError(res, e, '[admin/vrc-cookie-expire:put]'); }
  });

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

  // ==================== 管理员面板统计数据 ====================
  router.get('/admin/stats', requireAdminCompat, async (req, res) => {
    try {
      const [[{ totalUsers }]] = await getPool().query(`SELECT COUNT(*) AS totalUsers FROM users WHERE deleted_at IS NULL`);
      const [[{ pendingApproval }]] = await getPool().query(`SELECT COUNT(*) AS pendingApproval FROM users WHERE deleted_at IS NULL AND approved=0 AND role='member'`);
      const [[{ totalBanned }]] = await getPool().query(`SELECT COUNT(*) AS totalBanned FROM users WHERE deleted_at IS NULL AND banned=1`);
      const [[{ totalPhotos }]] = await getPool().query(`SELECT COUNT(*) AS totalPhotos FROM album_photo WHERE is_recycle=0`);
      const [[{ totalEvents }]] = await getPool().query(`SELECT COUNT(*) AS totalEvents FROM event WHERE is_archive=0`);
      const [[{ totalOnline }]] = await getPool().query(`SELECT COUNT(*) AS totalOnline FROM group_roster WHERE is_member=1 AND is_online=1`);
      const [[{ totalGroupMembers }]] = await getPool().query(`SELECT COUNT(*) AS totalGroupMembers FROM group_roster WHERE is_member=1`);
      const [[{ totalAnnouncements }]] = await getPool().query(`SELECT COUNT(*) AS totalAnnouncements FROM announcement`);
      res.json({ totalUsers, pendingApproval, totalBanned, totalPhotos, totalEvents, totalOnline, totalGroupMembers, totalAnnouncements });
    } catch (e) { handleError(res, e, '[admin/stats]'); }
  });

  // ==================== 操作日志（sys_oper_log 表） ====================
  // 说明：`/api/admin/logs` 返回的是文件系统里的应用日志（logger.js），
  // 字段结构完全不同。管理面板的"操作日志"面板此前误调那个端点，
  // 拿到的每条记录都没有 adminVrcId/operType/content，于是全部渲染成空白与
  // "unknown"。sys_oper_log 表被 20 处代码写入，却从来没有任何接口读取过。
  router.get('/admin/oper-logs', requireAdminCompat, async (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
      const type = (req.query.type || '').trim();
      const user = (req.query.user || '').trim();

      const where = [];
      const params = [];
      if (type) { where.push('l.oper_type = ?'); params.push(type); }
      if (user) {
        // admin_vrcid 列历史上混存了 login_id、数字用户 ID 和 VRChat ID 三种值，
        // 所以模糊匹配要同时覆盖原始列和 JOIN 出来的显示名。
        where.push('(l.admin_vrcid LIKE ? OR u1.display_name LIKE ? OR u2.display_name LIKE ?)');
        const like = `%${user}%`;
        params.push(like, like, like);
      }
      const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

      // 两个 LEFT JOIN 分别按 login_id 和数字主键回查，兼容历史脏数据
      const joinSql = `
        LEFT JOIN users u1 ON u1.login_id = l.admin_vrcid
        LEFT JOIN users u2 ON u2.id = (CASE WHEN l.admin_vrcid REGEXP '^[0-9]+$' THEN CAST(l.admin_vrcid AS UNSIGNED) ELSE NULL END)`;

      const [[{ total }]] = await getPool().query(
        `SELECT COUNT(*) AS total FROM sys_oper_log l ${joinSql} ${whereSql}`, params
      );
      const [rows] = await getPool().query(
        `SELECT l.id, l.admin_vrcid, l.oper_type, l.content, l.create_time,
                COALESCE(u1.display_name, u2.display_name) AS display_name
         FROM sys_oper_log l ${joinSql} ${whereSql}
         ORDER BY l.create_time DESC, l.id DESC
         LIMIT ? OFFSET ?`,
        [...params, pageSize, (page - 1) * pageSize]
      );

      res.json({
        logs: rows.map(r => ({
          id: r.id,
          // 优先显示可读昵称，回退到原始标识；两者都没有才算未知
          adminVrcId: r.display_name || r.admin_vrcid || '',
          operType: r.oper_type || '',
          content: r.content || '',
          createTime: r.create_time
        })),
        total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(total / pageSize))
      });
    } catch (e) { handleError(res, e, '[admin/oper-logs]'); }
  });

  // 操作类型下拉框的可选值，避免前端硬编码
  router.get('/admin/oper-log-types', requireAdminCompat, async (req, res) => {
    try {
      const [rows] = await getPool().query(
        `SELECT oper_type, COUNT(*) AS n FROM sys_oper_log GROUP BY oper_type ORDER BY n DESC LIMIT 50`
      );
      res.json({ types: rows.map(r => r.oper_type).filter(Boolean) });
    } catch (e) { handleError(res, e, '[admin/oper-log-types]'); }
  });

  // ==================== 社交链接（公开接口） ====================
  router.get('/social-links', async (req, res) => {
    try {
      const [rows] = await getPool().query(
        `SELECT config_key, config_value FROM system_config WHERE config_key IN ('vrcGroupUrl', 'kookUrl', 'oopzUrl')`
      );
      const links = {};
      for (const row of rows) {
        links[row.config_key] = row.config_value || '';
      }
      res.json({
        vrcGroupUrl: links.vrcGroupUrl || '',
        kookUrl: links.kookUrl || '',
        oopzUrl: links.oopzUrl || ''
      });
    } catch (e) { logger.error('admin', '[social-links]', e); res.json({ vrcGroupUrl: '', kookUrl: '', oopzUrl: '' }); }
  });

  // ==================== 系统配置 ====================
  router.get('/admin/config', requireAdminCompat, async (req, res) => {
    try {
      const [rows] = await getPool().query(`SELECT config_key AS configKey, config_value AS configValue FROM system_config`);
      const config = { groupId };
      for (const row of rows) config[row.configKey] = row.configValue;
      res.json(config);
    } catch (e) { handleError(res, e, '[admin/config]'); }
  });

  router.put('/admin/config', requireRole('super_admin'), async (req, res) => {
    try {
      // 前端 saveSystemConfig 发送的是 { config: {...} }，兼容顶层直传两种形态，
      // 否则历史上会静默变成 no-op（改了不入库）。
      const incoming = (req.body && req.body.config && typeof req.body.config === 'object') ? req.body.config : req.body;
      const allowedKeys = ['site_name', 'hero_title', 'hero_subtitle', 'hero_description', 'hero_bg_url', 'hero_bg_color', 'hero_bg_overlay_opacity', 'hero_accent_color', 'hero_badge_text', 'hero_show_stats', 'hero_show_badge', 'hero_animation', 'posts_per_page', 'post_max_images', 'post_max_videos', 'post_video_max_size_mb', 'vrcGroupUrl', 'kookUrl', 'oopzUrl', 'req_max_upload_mb', 'req_max_body_mb', 'req_max_other_mb'];
      for (const key of allowedKeys) {
        if (incoming[key] !== undefined) {
          const val = typeof incoming[key] === 'string' ? incoming[key] : String(incoming[key]);
          await getPool().query(`INSERT INTO system_config (config_key, config_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE config_value = ?`, [key, val, val]);
        }
      }
      // 立即把请求大小限制同步到内存，无需重启即生效
      settings.applyConfig(incoming);
      await logOper(req.session.userId, '更新系统配置', JSON.stringify(Object.keys(incoming)));
      res.json({ success: true });
    } catch (e) { handleError(res, e, '[admin/config/put]'); }
  });

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
    if (!pwCheck.valid) return res.status(400).json({ error: pwCheck.errors.join('; ') });
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
      res.json({ success: true, id: userId });
    } catch (e) { handleError(res, e, '[admin/users/post]'); }
  });

  router.post('/admin/users/:id/approve', requireAdminCompat, async (req, res) => {
    try { await getPool().query(`UPDATE users SET approved=1 WHERE id=?`, [req.params.id]); await logOper(req.session.userId, '批准用户', `批准用户 #${req.params.id}`); res.json({ success: true }); }
    catch (e) { handleError(res, e, '[admin/users/approve]'); }
  });
  router.post('/admin/users/:id/ban', requireAdminCompat, async (req, res) => {
    try {
      const guard = await assertCanModifyTarget(req, res, req.params.id);
      if (!guard.ok) return;
      await getPool().query(`UPDATE users SET banned=1 WHERE id=?`, [req.params.id]);
      await getPool().query(`DELETE FROM notifications WHERE user_id = ?`, [req.params.id]);
      await logOper(req.session.userId, '封禁用户', `封禁用户 ${guard.targetUser.display_name} (#${req.params.id})`);
      res.json({ success: true });
    }
    catch (e) { handleError(res, e, '[admin/users/ban]'); }
  });
  router.post('/admin/users/:id/unban', requireAdminCompat, async (req, res) => {
    try {
      const guard = await assertCanModifyTarget(req, res, req.params.id);
      if (!guard.ok) return;
      await getPool().query(`UPDATE users SET banned=0 WHERE id=?`, [req.params.id]);
      await logOper(req.session.userId, '解封用户', `解封用户 ${guard.targetUser.display_name} (#${req.params.id})`);
      res.json({ success: true });
    }
    catch (e) { handleError(res, e, '[admin/users/unban]'); }
  });
  router.delete('/admin/users/:id', requireAdminCompat, async (req, res) => {
    try {
      const guard = await assertCanModifyTarget(req, res, req.params.id);
      if (!guard.ok) return;
      await getPool().query(`UPDATE users SET deleted_at=NOW() WHERE id=?`, [req.params.id]);
      await logOper(req.session.userId, '删除用户', `删除用户 ${guard.targetUser.display_name} (#${req.params.id})`);
      res.json({ success: true });
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
      if (!pwCheck.valid) return res.status(400).json({ error: pwCheck.errors.join('; ') });
      const guard = await assertCanModifyTarget(req, res, req.params.id);
      if (!guard.ok) return;
      const hashed = await hashPassword(newPassword);
      await getPool().query(`UPDATE users SET password_hash=? WHERE id=?`, [hashed, req.params.id]);
      await logOper(req.session.userId, '重置密码', `管理员 ${req.session.displayName} 重置了用户 ${guard.targetUser.display_name} (#${req.params.id}) 的密码`);
      res.json({ success: true });
    }
    catch (e) { handleError(res, e, '[admin/users/reset-password]'); }
  });

  // ==================== 全局搜索 ====================
  router.get('/search', requireAuth, async (req, res) => {
    try {
      const q = req.query.q ? req.query.q.trim() : '';
      if (!q || q.length < 2) return res.json({ users: [], events: [], announcements: [] });
      const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
      const [users] = await getPool().query(
        `SELECT id, login_id AS loginId, display_name AS displayName, role, avatar_type, custom_avatar_path, vrchat_avatar_url FROM users WHERE deleted_at IS NULL AND (login_id LIKE ? OR display_name LIKE ?) LIMIT 10`,
        [like, like]
      );
      const [events] = await getPool().query(`SELECT id, title, event_time AS eventTime, event_type AS eventType FROM event WHERE title LIKE ? AND is_archive=0 LIMIT 10`, [like]);
      const [announcements] = await getPool().query(`SELECT id, title FROM announcement WHERE title LIKE ? LIMIT 10`, [like]);
      res.json({ users, events, announcements });
    } catch (e) { handleError(res, e, '[admin/search]'); }
  });

  // ==================== VRChat 改名系统 ====================
  router.post('/name-change/request', requireAuth, async (req, res) => {
    try {
      const { newName, reason } = req.body;
      if (!newName || !newName.trim()) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请输入新显示名');
      const newNameTrim = newName.trim();
      if (newNameTrim.length > 50) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '显示名不能超过50字');
      if (/[<>\u0000-\u001f\u007f]/.test(newNameTrim)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '显示名包含不允许的字符');
      }
      const [existing] = await getPool().query(`SELECT id FROM users WHERE display_name=?`, [newNameTrim]);
      if (existing.length > 0) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '该显示名已被使用');
      const [pendings] = await getPool().query(`SELECT id FROM name_change_requests WHERE user_id=? AND status='pending'`, [req.session.userId]);
      if (pendings.length > 0) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '您已有待审核的改名申请');
      await getPool().query(`INSERT INTO name_change_requests (user_id, old_name, new_name, reason) VALUES (?, ?, ?, ?)`,
        [req.session.userId, req.session.displayName || '用户', newNameTrim, reason ? String(reason).slice(0, 500) : null]);
      await logOper(req.session.userId, '提交改名申请', `${req.session.displayName} → ${newNameTrim}`);
      res.json({ success: true, message: '改名申请已提交，等待管理员审核' });
    } catch (e) { handleError(res, e, '[admin/name-change/request]'); }
  });

  router.get('/name-change/my-requests', requireAuth, async (req, res) => {
    try {
      const [rows] = await getPool().query(
        `SELECT id, old_name AS oldName, new_name AS newName, reason, status, review_comment AS reviewerComment, create_time AS createTime, review_time AS reviewTime FROM name_change_requests WHERE user_id=? ORDER BY create_time DESC LIMIT 20`,
        [req.session.userId]
      );
      res.json({ requests: rows });
    } catch (e) { handleError(res, e, '[admin/name-change/my-requests]'); }
  });

  router.get('/name-change/pending', requireAdminCompat, async (req, res) => {
    try {
      const [rows] = await getPool().query(
        `SELECT nc.id, nc.old_name AS oldName, nc.new_name AS newName, nc.reason AS reason, nc.user_id AS userId, u.display_name AS displayName, nc.create_time AS createTime FROM name_change_requests nc LEFT JOIN users u ON nc.user_id = u.id WHERE nc.status='pending' ORDER BY nc.create_time ASC`
      );
      res.json({ requests: rows });
    } catch (e) { handleError(res, e, '[admin/name-change/pending]'); }
  });

  router.get('/name-change/all', requireAdminCompat, async (req, res) => {
    try {
      const [rows] = await getPool().query(
        `SELECT nc.id, nc.old_name AS oldName, nc.new_name AS newName, nc.reason AS reason, nc.user_id AS userId, u.display_name AS displayName, nc.status, nc.review_comment AS reviewerComment, nc.create_time AS createTime, nc.review_time AS reviewTime FROM name_change_requests nc LEFT JOIN users u ON nc.user_id = u.id ORDER BY nc.create_time DESC LIMIT 50`
      );
      res.json({ requests: rows });
    } catch (e) { handleError(res, e, '[admin/name-change/all]'); }
  });

  router.post('/name-change/review', requireAdminCompat, async (req, res) => {
    try {
      const { id, action, comment } = req.body;
      if (!id || !action || !['approve', 'reject'].includes(action)) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      const [reqs] = await getPool().query(`SELECT user_id, old_name, new_name, status FROM name_change_requests WHERE id=?`, [id]);
      if (reqs.length === 0) return sendError(res, 404, ErrorCodes.NOT_FOUND, '申请不存在');
      if (reqs[0].status !== 'pending') return sendError(res, 400, ErrorCodes.BAD_REQUEST, '该申请已审核');
      const reviewerId = req.session.userId;
      const reviewerName = req.session.displayName || '管理员';
      if (action === 'approve') {
        await getPool().query(`UPDATE users SET display_name=? WHERE id=?`, [reqs[0].new_name, reqs[0].user_id]);
        await getPool().query(`UPDATE name_change_requests SET status='approved', reviewed_by=?, review_comment=?, review_time=NOW() WHERE id=?`, [reviewerId, comment || null, id]);
        await logOper(reviewerId, '通过改名', `${reqs[0].old_name} → ${reqs[0].new_name}`);
      } else {
        await getPool().query(`UPDATE name_change_requests SET status='rejected', reviewed_by=?, review_comment=?, review_time=NOW() WHERE id=?`, [reviewerId, comment || null, id]);
        await logOper(reviewerId, '拒绝改名', `${reqs[0].old_name} → ${reqs[0].new_name}: ${comment || ''}`);
      }
      res.json({ success: true });
    } catch (e) { handleError(res, e, '[admin/name-change/review]'); }
  });

  // ==================== 权限系统 API（旧版） ====================
  router.get('/permissions', requireAdminCompat, async (req, res) => {
    try {
      // 以管理员用户为基准左连接权限记录：若只查 user_permissions，
      // 在尚无任何授权记录时列表为空，管理员将永远无法授予第一个权限。
      const [rows] = await getPool().query(
        `SELECT u.id AS userId, u.display_name AS displayName, u.login_id AS loginId, u.role,
                p.permission AS permissionKey, p.granted
         FROM users u
         LEFT JOIN user_permissions p ON p.user_id = u.id
         WHERE u.deleted_at IS NULL AND u.banned = 0 AND u.role IN ('admin', 'super_admin')
         ORDER BY u.display_name, p.permission`
      );
      const byUser = {};
      for (const r of rows) {
        if (!byUser[r.userId]) {
          byUser[r.userId] = { userId: r.userId, displayName: r.displayName, loginId: r.loginId, role: r.role, perms: {} };
        }
        if (r.permissionKey) {
          byUser[r.userId].perms[r.permissionKey] = r.granted === 1 || r.granted === true;
        }
      }
      res.json({ userPermissions: Object.values(byUser) });
    } catch (e) { handleError(res, e, '[admin/permissions]'); }
  });

  router.get('/permissions/me', requireAuth, async (req, res) => {
    try {
      const [rows] = await getPool().query(`SELECT permission, granted FROM user_permissions WHERE user_id=?`, [req.session.userId]);
      const grants = {};
      for (const r of rows) grants[r.permission] = r.granted === 1;
      res.json({ grants });
    } catch (e) { handleError(res, e, '[admin/permissions/me]'); }
  });

  router.post('/permissions/set', requireAdminCompat, async (req, res) => {
    try {
      const { userId, permission, granted } = req.body;
      if (!userId || !permission) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      await getPool().query(
        `INSERT INTO user_permissions (user_id, permission, granted, granted_by) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE granted=?, granted_by=?`,
        [userId, permission, granted ? 1 : 0, req.session.userId, granted ? 1 : 0, req.session.userId]
      );
      res.json({ success: true });
    } catch (e) { handleError(res, e, '[admin/permissions/set]'); }
  });

  // ==================== 权限组排序 API ====================
  router.get('/admin/groups', requireAdminCompat, async (req, res) => {
    try {
      const [rows] = await getPool().query(
        'SELECT id, name, description, parent_id AS parentId, is_default AS isDefault, is_system AS isSystem, created_at AS createdAt, updated_at AS updatedAt FROM permission_groups ORDER BY id ASC'
      );
      res.json({ groups: rows });
    } catch (e) { handleError(res, e, '[admin/groups]'); }
  });

  router.put('/admin/groups/sort', requireAdminCompat, async (req, res) => {
    try {
      const { groupIds } = req.body;
      if (!Array.isArray(groupIds)) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      for (let i = 0; i < groupIds.length; i++) {
        await getPool().query('UPDATE permission_groups SET sort = ? WHERE id = ?', [i, groupIds[i]]);
      }
      await logOper(req.session.userId, '调整权限组排序', `排序: ${groupIds.join(',')}`);
      res.json({ success: true });
    } catch (e) { handleError(res, e, '[admin/groups/sort]'); }
  });

  // ==================== 直播管理（管理员监管） ====================
  router.get('/admin/live', requireAdminCompat, async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const pageSize = parseInt(req.query.pageSize) || 20;
      const offset = (page - 1) * pageSize;
      const status = req.query.status === 'live' ? 'live' : (req.query.status === 'ended' ? 'ended' : '');
      const kw = req.query.kw ? req.query.kw.trim() : '';
      const where = [];
      const params = [];
      if (status) { where.push('l.status = ?'); params.push(status); }
      if (kw) { where.push('(l.title LIKE ? OR u.display_name LIKE ? OR u.login_id LIKE ?)'); params.push('%' + kw + '%', '%' + kw + '%', '%' + kw + '%'); }
      const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const [{ 0: count }] = await getPool().query(`SELECT COUNT(*) AS c FROM live_streams l LEFT JOIN users u ON u.id = l.user_id ${whereSql}`, params);
      const [list] = await getPool().query(
        `SELECT l.id, l.user_id AS userId, l.title, l.status, l.created_at AS startedAt, l.ended_at AS endedAt,
                u.display_name AS displayName, u.login_id AS loginId
         FROM live_streams l LEFT JOIN users u ON u.id = l.user_id
         ${whereSql} ORDER BY (l.status='live') DESC, l.created_at DESC LIMIT ? OFFSET ?`,
        params.concat([pageSize, offset])
      );
      const totalPages = Math.max(1, Math.ceil(count.c / pageSize));
      res.json({ list, page, totalPages, total: count.c });
    } catch (e) { handleError(res, e, '[admin/live:get]'); }
  });

  router.post('/admin/live/:id/end', requireAdminCompat, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!id) return res.status(400).json({ error: 'invalid id' });
      await getPool().query(`UPDATE live_streams SET status = 'ended', ended_at = NOW() WHERE id = ?`, [id]);
      await logOper(req.session.userId, '强制结束直播', '直播ID: ' + id);
      res.json({ success: true });
    } catch (e) { handleError(res, e, '[admin/live:end]'); }
  });

  router.delete('/admin/live/:id', requireAdminCompat, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!id) return res.status(400).json({ error: 'invalid id' });
      await getPool().query(`DELETE FROM live_streams WHERE id = ?`, [id]);
      await logOper(req.session.userId, '删除直播', '直播ID: ' + id);
      res.json({ success: true });
    } catch (e) { handleError(res, e, '[admin/live:delete]'); }
  });

  // ==================== 内容管理（动态/公告/活动/相册） ====================
  const CONTENT_TYPES = {
    posts: { table: 'posts', id: 'id', author: 'user_id', title: 'content', q: ['content'] },
    // 公告表无 author_id，作者存 create_admin 文本字段，author 配 create_admin 使其按 authorId 返回文本
    // 公告表无 author_id，作者存 create_admin 文本字段；textAuthor=true 时 authorId 直接当文本展示、不查 users 表
    announcements: { table: 'announcement', id: 'id', author: 'create_admin', title: 'title', q: ['title', 'content'], textAuthor: true },
    events: {
      table: 'event', id: 'id', author: 'create_user_id', title: 'title', q: ['title', 'description'],
      // 活动表字段更丰富：补充类型/时间/归档/创建者文本/参与人数，便于后台管理页展示
      extra: 'event_type AS eventType, event_time AS eventTime, ends_at AS endsAt, is_archive AS isArchive, create_admin AS createAdmin',
      signJoin: 'LEFT JOIN (SELECT event_id, COUNT(*) AS signCount FROM event_sign GROUP BY event_id) es ON es.event_id = event.id',
      signCount: 'es.signCount AS signCount'
    },
    // album_photo 表无 user_id/caption：上传者为 upload_name 文本，描述为 photo_desc；extra 带回缩略图/原图路径供后台展示
    album: {
      table: 'album_photo', id: 'id', author: 'upload_name', title: 'photo_desc', q: ['photo_desc', 'upload_name'], textAuthor: true,
      extra: 'thumb_path AS thumbPath, photo_path AS photoPath, media_type AS mediaType'
    }
  };

  router.get('/admin/content', requireAdminCompat, async (req, res) => {
    try {
      const type = CONTENT_TYPES[req.query.type] ? req.query.type : 'posts';
      const cfg = CONTENT_TYPES[type];
      const page = parseInt(req.query.page) || 1;
      const pageSize = parseInt(req.query.pageSize) || 20;
      const offset = (page - 1) * pageSize;
      const kw = req.query.kw ? req.query.kw.trim() : '';
      const where = [];
      const params = [];
      if (kw && cfg.q.length) {
        where.push('(' + cfg.q.map(function (c) { return c + ' LIKE ?'; }).join(' OR ') + ')');
        cfg.q.forEach(function () { params.push('%' + kw + '%'); });
      }
      // 活动列表支持按类型 / 归档状态筛选
      if (type === 'events') {
        const etype = req.query.eventType;
        if (etype === 'activity' || etype === 'birthday') {
          where.push('event_type = ?');
          params.push(etype);
        }
        const arch = req.query.archived;
        if (arch === '1') { where.push('is_archive = 1'); }
        else if (arch === '0') { where.push('is_archive = 0'); }
      }
      const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const [{ 0: count }] = await getPool().query(`SELECT COUNT(*) AS c FROM ${cfg.table} ${whereSql}`, params);
      // 组装 SELECT 字段：通用字段 + 活动专属字段 + 参与人数
      let selectCols = `${cfg.id} AS id, ${cfg.author} AS authorId, ${cfg.title} AS content`;
      let joins = '';
      if (cfg.extra) selectCols += ', ' + cfg.extra;
      if (type === 'events') {
        if (cfg.signCount) selectCols += ', ' + cfg.signCount;
        if (cfg.signJoin) joins = ' ' + cfg.signJoin;
      }
      const [list] = await getPool().query(
        `SELECT ${selectCols} FROM ${cfg.table}${joins} ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`,
        params.concat([pageSize, offset])
      );
      // 补作者名（textAuthor 类型：authorId 即文本作者名，不查 users 表；活动表 create_user_id 可能为 NULL，回退 create_admin 文本）
      const isTextAuthor = cfg.textAuthor === true;
      const ids = isTextAuthor ? [] : list.map(function (it) { return it.authorId; }).filter(Boolean);
      let nameMap = {};
      if (ids.length) {
        const [us] = await getPool().query(`SELECT id, display_name FROM users WHERE id IN (?)`, [ids]);
        us.forEach(function (u) { nameMap[u.id] = u.display_name; });
      }
      list.forEach(function (it) {
        it.displayName = isTextAuthor ? (it.authorId || '-') : (nameMap[it.authorId] || it.createAdmin || '-');
        if (it.signCount === undefined) it.signCount = 0;
      });
      const totalPages = Math.max(1, Math.ceil(count.c / pageSize));
      res.json({ list, page, totalPages, total: count.c });
    } catch (e) { handleError(res, e, '[admin/content:get]'); }
  });

  router.delete('/admin/content/:type/:id', requireAdminCompat, async (req, res) => {
    try {
      const cfg = CONTENT_TYPES[req.params.type];
      if (!cfg) return res.status(400).json({ error: 'invalid type' });
      const id = parseInt(req.params.id);
      if (!id) return res.status(400).json({ error: 'invalid id' });
      if (req.params.type === 'events') {
        // 级联清理活动关联数据，避免孤儿记录（与 /api/events/:id 删除逻辑一致）
        await getPool().query(`UPDATE album_photo SET is_recycle=1, recycle_time=NOW() WHERE event_id=?`, [id]);
        await getPool().query(`DELETE FROM event_checkin WHERE event_id=?`, [id]);
        await getPool().query(`DELETE FROM event_sign WHERE event_id=?`, [id]);
        await getPool().query(`DELETE FROM event_comment WHERE event_id=?`, [id]);
        await getPool().query(`DELETE FROM notifications WHERE target_type='event' AND target_id=?`, [id]);
      }
      await getPool().query(`DELETE FROM ${cfg.table} WHERE ${cfg.id} = ?`, [id]);
      await logOper(req.session.userId, '删除内容(' + req.params.type + ')', 'ID: ' + id);
      res.json({ success: true });
    } catch (e) { handleError(res, e, '[admin/content:delete]'); }
  });

  router.post('/admin/content/batch', requireAdminCompat, async (req, res) => {
    try {
      const cfg = CONTENT_TYPES[req.body.type];
      if (!cfg) return res.status(400).json({ error: 'invalid type' });
      const ids = Array.isArray(req.body.ids) ? req.body.ids.map(function (x) { return parseInt(x); }).filter(function (x) { return x; }) : [];
      if (!ids.length) return res.status(400).json({ error: 'empty ids' });
      await getPool().query(`DELETE FROM ${cfg.table} WHERE ${cfg.id} IN (?)`, [ids]);
      await logOper(req.session.userId, '批量删除内容(' + req.body.type + ')', 'IDs: ' + ids.join(','));
      res.json({ success: true, deleted: ids.length });
    } catch (e) { handleError(res, e, '[admin/content:batch]'); }
  });

  // ==================== VRC 状态监控 ====================
  router.get('/vrc-monitor', requireAdminCompat, async (req, res) => {
    try {
      // 复用 server.js 暴露的全局 VRChat 鉴权状态
      const g = (typeof global !== 'undefined' && typeof global.__getVrcAuthState === 'function') ? global.__getVrcAuthState() : null;
      let online = false, friendCount = null, lastSync = null, health = 'unknown';
      if (g) {
        online = !!g.loggedIn;
        lastSync = g.lastSyncAt ? new Date(g.lastSyncAt).toISOString() : null;
      }
      // 好友数（如系统账号 cookie 可用，调用 VRChat friends 接口）
      try {
        const vrc = require('../vrc');
        if (g && g.cookie && typeof vrc.vrchatGetAllFriends === 'function') {
          const friends = await vrc.vrchatGetAllFriends(g.cookie);
          friendCount = Array.isArray(friends) ? friends.length : null;
          health = 'ok';
        } else {
          health = g && g.loggedIn ? 'no-cookie-api' : 'offline';
        }
      } catch (e) {
        health = 'error: ' + (e && e.message ? e.message : 'unknown');
      }
      res.json({ online, friendCount, lastSync, health, note: online ? '系统账号已登录 VRChat，可正常抓取数据。' : '系统 VRChat 账号未登录，部分在线状态与好友数据不可用。' });
    } catch (e) { handleError(res, e, '[vrc-monitor:get]'); }
  });

  // ==================== 用户数据导出/导入/备份还原（管理员，按用户 + 批量） ====================

  // GET /admin/user-data/export/:id — 导出单个用户数据（JSON 下载）
  router.get('/admin/user-data/export/:id', requireAdminCompat, async (req, res) => {
    try {
      const userId = parseInt(req.params.id, 10);
      if (!userId) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '无效的用户 ID');
      const data = await collectUserData(userId);
      if (!data) return sendError(res, 404, ErrorCodes.NOT_FOUND, '用户不存在');
      const name = (data.meta.user.display_name || data.meta.user.login_id || 'user').replace(/[\\/:*?"<>|]/g, '_');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="user-${userId}-${encodeURIComponent(name)}.json"`);
      res.json(data);
      await logOper(req.session.userId, '导出用户数据', '用户ID: ' + userId);
    } catch (e) { handleError(res, e, '[admin/user-data/export]'); }
  });

  // POST /admin/user-data/import/:id — 导入 JSON 数据到指定用户
  router.post('/admin/user-data/import/:id', requireAdminCompat, async (req, res) => {
    try {
      const userId = parseInt(req.params.id, 10);
      if (!userId) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '无效的用户 ID');
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '导入数据格式不正确');
      }
      const { imported } = await importUserData(userId, body);
      await logOper(req.session.userId, '导入用户数据', '用户ID: ' + userId);
      res.json({ success: true, imported });
    } catch (e) {
      if (e && e.statusCode === 404) return sendError(res, 404, ErrorCodes.NOT_FOUND, '用户不存在');
      handleError(res, e, '[admin/user-data/import]');
    }
  });

  // POST /admin/user-data/batch-export — 批量导出（body.ids 为用户 ID 数组），返回包含多个用户的 JSON 下载
  router.post('/admin/user-data/batch-export', requireAdminCompat, async (req, res) => {
    try {
      const ids = Array.isArray(req.body.ids) ? req.body.ids.map(x => parseInt(x, 10)).filter(Boolean) : [];
      if (!ids.length) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '未指定要导出的用户');
      const result = { exported_at: new Date().toISOString(), version: 1, users: {} };
      const skipped = [];
      for (const id of ids) {
        const data = await collectUserData(id);
        if (data) result.users[id] = data;
        else skipped.push(id);
      }
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="jingtu-batch-backup.json"');
      res.json({ ...result, skipped });
      await logOper(req.session.userId, '批量导出用户数据', 'IDs: ' + ids.join(','));
    } catch (e) { handleError(res, e, '[admin/user-data/batch-export]'); }
  });

  // POST /admin/user-data/batch-import — 批量导入（body.users 为 { userId: data } 映射）
  router.post('/admin/user-data/batch-import', requireAdminCompat, async (req, res) => {
    try {
      const users = req.body && req.body.users;
      if (!users || typeof users !== 'object' || Array.isArray(users)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '批量导入数据格式不正确');
      }
      const summary = [];
      const failed = {};
      for (const key of Object.keys(users)) {
        const userId = parseInt(key, 10);
        const data = users[key];
        if (!userId || !data || typeof data !== 'object') { failed[key] = '无效的用户 ID 或数据'; continue; }
        try {
          const { imported } = await importUserData(userId, data);
          summary.push({ userId, imported });
        } catch (e) {
          failed[key] = (e && e.message) || '导入失败';
        }
      }
      await logOper(req.session.userId, '批量导入用户数据', '用户数: ' + summary.length);
      res.json({ success: true, imported: summary, failed });
    } catch (e) { handleError(res, e, '[admin/user-data/batch-import]'); }
  });

  return router;
};
