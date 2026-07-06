/**
 * 境途同游 V6.14 — 管理 / 搜索 / 改名 / 权限系统路由
 */
const express = require('express');
const { getPool, safeError, logOper } = require('../utils');
const {
  requireAuth, requireAdminCompat, requireRole,
  hashPassword, validatePasswordStrength,
  getAvatarUrl
} = require('../auth');

module.exports = function (groupId) {
  const router = express.Router();

  // ==================== 公共统计数据 API（Hero 封面用） ====================
  router.get('/public/stats', async (req, res) => {
    try {
      const [[{ totalUsers }]] = await getPool().query(`SELECT COUNT(*) AS totalUsers FROM users WHERE deleted_at IS NULL AND approved=1`);
      const [[{ totalPhotos }]] = await getPool().query(`SELECT COUNT(*) AS totalPhotos FROM album_photo WHERE is_recycle=0`);
      const [heroConfigRows] = await getPool().query(
        `SELECT config_key, config_value FROM system_config WHERE config_key LIKE 'hero_%' OR config_key IN ('site_name','posts_per_page','post_max_images','post_max_videos','post_video_max_size_mb')`
      );
      const heroConfig = {};
      for (const row of heroConfigRows) heroConfig[row.config_key] = row.config_value;
      res.json({ totalUsers, totalPhotos, heroConfig });
    } catch (e) { console.error('[admin]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

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
    } catch (e) { console.error('[admin]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  // ==================== 系统配置 ====================
  router.get('/admin/config', requireAdminCompat, async (req, res) => {
    try {
      const [rows] = await getPool().query(`SELECT config_key AS configKey, config_value AS configValue FROM system_config`);
      const config = { groupId };
      for (const row of rows) config[row.configKey] = row.configValue;
      res.json(config);
    } catch (e) { console.error('[admin]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  router.put('/admin/config', requireRole('super_admin'), async (req, res) => {
    try {
      const allowedKeys = ['site_name', 'hero_title', 'hero_subtitle', 'hero_description', 'hero_bg_url', 'hero_bg_color', 'hero_bg_overlay_opacity', 'hero_accent_color', 'hero_badge_text', 'hero_show_stats', 'hero_show_badge', 'hero_animation', 'posts_per_page', 'post_max_images', 'post_max_videos', 'post_video_max_size_mb'];
      for (const key of allowedKeys) {
        if (req.body[key] !== undefined) {
          const val = typeof req.body[key] === 'string' ? req.body[key] : String(req.body[key]);
          await getPool().query(`INSERT INTO system_config (config_key, config_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE config_value = ?`, [key, val, val]);
        }
      }
      await logOper(req.session.userId, '更新系统配置', JSON.stringify(Object.keys(req.body)));
      res.json({ success: true });
    } catch (e) { console.error('[admin]', e); res.status(500).json({ error: safeError(e.message) }); }
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
                u.vrchat_name AS vrchatName, u.vrchat_id AS vrchatId, u.create_time AS createTime,
                u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url,
                u.email, u.birthday, u.preferences
         FROM users u WHERE ${w} ORDER BY u.create_time DESC LIMIT ? OFFSET ?`, [...params, pageSize, offset]
      );
      const mapped = rows.map(u => ({ ...u, avatarUrl: getAvatarUrl(u) }));
      res.json({ users: mapped, total: count[0].total, page, pageSize, totalPages: Math.ceil(count[0].total / pageSize) });
    } catch (e) { console.error('[admin]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  router.post('/admin/users', requireRole('super_admin'), async (req, res) => {
    const { loginId, displayName, password, role } = req.body;
    if (!loginId || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
    const pwCheck = validatePasswordStrength(password);
    if (!pwCheck.valid) return res.status(400).json({ error: pwCheck.errors.join('; ') });
    try {
      const [dup] = await getPool().query(`SELECT id FROM users WHERE login_id = ?`, [loginId]);
      if (dup.length > 0) return res.status(400).json({ error: '用户名已存在' });
      const hashedPw = await hashPassword(password);
      const [result] = await getPool().query(
        `INSERT INTO users (login_id, display_name, password_hash, role, approved) VALUES (?, ?, ?, ?, 1)`,
        [loginId, displayName || loginId, hashedPw, role || 'member']
      );
      await logOper(req.session.userId, '创建用户', `创建用户 ${displayName || loginId} (${loginId})`);
      res.json({ success: true, id: result.insertId });
    } catch (e) { console.error('[admin]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  router.post('/admin/users/:id/approve', requireAdminCompat, async (req, res) => {
    try { await getPool().query(`UPDATE users SET approved=1 WHERE id=?`, [req.params.id]); await logOper(req.session.userId, '批准用户', `批准用户 #${req.params.id}`); res.json({ success: true }); }
    catch (e) { console.error('[admin]', e); res.status(500).json({ error: safeError(e.message) }); }
  });
  router.post('/admin/users/:id/ban', requireAdminCompat, async (req, res) => {
    try { await getPool().query(`UPDATE users SET banned=1 WHERE id=?`, [req.params.id]); await logOper(req.session.userId, '封禁用户', `封禁用户 #${req.params.id}`); res.json({ success: true }); }
    catch (e) { console.error('[admin]', e); res.status(500).json({ error: safeError(e.message) }); }
  });
  router.post('/admin/users/:id/unban', requireAdminCompat, async (req, res) => {
    try { await getPool().query(`UPDATE users SET banned=0 WHERE id=?`, [req.params.id]); await logOper(req.session.userId, '解封用户', `解封用户 #${req.params.id}`); res.json({ success: true }); }
    catch (e) { console.error('[admin]', e); res.status(500).json({ error: safeError(e.message) }); }
  });
  router.delete('/admin/users/:id', requireAdminCompat, async (req, res) => {
    try { await getPool().query(`UPDATE users SET deleted_at=NOW() WHERE id=?`, [req.params.id]); await logOper(req.session.userId, '删除用户', `删除用户 #${req.params.id}`); res.json({ success: true }); }
    catch (e) { console.error('[admin]', e); res.status(500).json({ error: safeError(e.message) }); }
  });
  router.post('/admin/users/:id/reset-password', requireAdminCompat, async (req, res) => {
    try { const { newPassword } = req.body; if (!newPassword) return res.status(400).json({ error: '请提供新密码' }); const pwCheck = validatePasswordStrength(newPassword); if (!pwCheck.valid) return res.status(400).json({ error: pwCheck.errors.join('; ') }); const hashed = await hashPassword(newPassword); const [targetUser] = await getPool().query(`SELECT id, display_name FROM users WHERE id=?`, [req.params.id]); if (targetUser.length === 0) return res.status(404).json({ error: '用户不存在' }); await getPool().query(`UPDATE users SET password_hash=? WHERE id=?`, [hashed, req.params.id]); await logOper(req.session.userId, '重置密码', `管理员 ${req.session.displayName} 重置了用户 ${targetUser[0].display_name} (#${req.params.id}) 的密码`); res.json({ success: true }); }
    catch (e) { console.error('[admin]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  // ==================== 全局搜索 ====================
  router.get('/search', async (req, res) => {
    try {
      const q = req.query.q ? req.query.q.trim() : '';
      if (!q || q.length < 2) return res.json({ users: [], events: [], announcements: [] });
      const like = `%${q}%`;
      const [users] = await getPool().query(
        `SELECT id, login_id AS loginId, display_name AS displayName, role, avatar_type, custom_avatar_path, vrchat_avatar_url FROM users WHERE deleted_at IS NULL AND (login_id LIKE ? OR display_name LIKE ?) LIMIT 10`,
        [like, like]
      );
      const [events] = await getPool().query(`SELECT id, title, event_time AS eventTime, event_type AS eventType FROM event WHERE title LIKE ? AND is_archive=0 LIMIT 10`, [like]);
      const [announcements] = await getPool().query(`SELECT id, title FROM announcement WHERE title LIKE ? LIMIT 10`, [like]);
      res.json({ users, events, announcements });
    } catch (e) { console.error('[admin]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  // ==================== VRChat 改名系统 ====================
  router.post('/name-change/request', requireAuth, async (req, res) => {
    try {
      const { newName } = req.body;
      if (!newName || !newName.trim()) return res.status(400).json({ error: '请输入新显示名' });
      const newNameTrim = newName.trim();
      if (newNameTrim.length > 50) return res.status(400).json({ error: '显示名不能超过50字' });
      const [existing] = await getPool().query(`SELECT id FROM users WHERE display_name=?`, [newNameTrim]);
      if (existing.length > 0) return res.status(400).json({ error: '该显示名已被使用' });
      const [pendings] = await getPool().query(`SELECT id FROM name_change_requests WHERE user_id=? AND status='pending'`, [req.session.userId]);
      if (pendings.length > 0) return res.status(400).json({ error: '您已有待审核的改名申请' });
      await getPool().query(`INSERT INTO name_change_requests (user_id, old_name, new_name) VALUES (?, ?, ?)`,
        [req.session.userId, req.session.displayName || '用户', newNameTrim]);
      await logOper(req.session.userId, '提交改名申请', `${req.session.displayName} → ${newNameTrim}`);
      res.json({ success: true, message: '改名申请已提交，等待管理员审核' });
    } catch (e) { console.error('[admin]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  router.get('/name-change/my-requests', requireAuth, async (req, res) => {
    try {
      const [rows] = await getPool().query(
        `SELECT id, old_name AS oldName, new_name AS newName, status, review_comment AS reviewerComment, create_time AS createTime, review_time AS reviewTime FROM name_change_requests WHERE user_id=? ORDER BY create_time DESC LIMIT 20`,
        [req.session.userId]
      );
      res.json({ requests: rows });
    } catch (e) { console.error('[admin]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  router.get('/name-change/pending', requireAdminCompat, async (req, res) => {
    try {
      const [rows] = await getPool().query(
        `SELECT nc.id, nc.old_name AS oldName, nc.new_name AS newName, nc.user_id AS userId, u.display_name AS displayName, nc.create_time AS createTime FROM name_change_requests nc LEFT JOIN users u ON nc.user_id = u.id WHERE nc.status='pending' ORDER BY nc.create_time ASC`
      );
      res.json({ requests: rows });
    } catch (e) { console.error('[admin]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  router.get('/name-change/all', requireAdminCompat, async (req, res) => {
    try {
      const [rows] = await getPool().query(
        `SELECT nc.id, nc.old_name AS oldName, nc.new_name AS newName, nc.user_id AS userId, u.display_name AS displayName, nc.status, nc.review_comment AS reviewerComment, nc.create_time AS createTime, nc.review_time AS reviewTime FROM name_change_requests nc LEFT JOIN users u ON nc.user_id = u.id ORDER BY nc.create_time DESC LIMIT 50`
      );
      res.json({ requests: rows });
    } catch (e) { console.error('[admin]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  router.post('/name-change/review', requireAdminCompat, async (req, res) => {
    try {
      const { id, action, comment } = req.body;
      if (!id || !action || !['approve', 'reject'].includes(action)) return res.status(400).json({ error: '参数错误' });
      const [reqs] = await getPool().query(`SELECT user_id, old_name, new_name, status FROM name_change_requests WHERE id=?`, [id]);
      if (reqs.length === 0) return res.status(404).json({ error: '申请不存在' });
      if (reqs[0].status !== 'pending') return res.status(400).json({ error: '该申请已审核' });
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
    } catch (e) { console.error('[admin]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  // ==================== 权限系统 API（旧版） ====================
  router.get('/permissions', requireAdminCompat, async (req, res) => {
    try {
      const [rows] = await getPool().query(
        `SELECT p.id, p.user_id AS userId, p.permission AS permissionKey, p.granted, p.granted_by AS grantedBy, p.created_at AS createdAt,
                u.display_name AS displayName FROM user_permissions p LEFT JOIN users u ON p.user_id = u.id ORDER BY u.display_name, p.permission`
      );
      const byUser = {};
      for (const r of rows) {
        if (!byUser[r.userId]) byUser[r.userId] = { userId: r.userId, displayName: r.displayName, perms: {} };
        byUser[r.userId].perms[r.permissionKey] = r.granted === 1 || r.granted === true;
      }
      res.json({ userPermissions: Object.values(byUser) });
    } catch (e) { console.error('[admin]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  router.get('/permissions/me', async (req, res) => {
    try {
      if (!req.session || !req.session.userId) return res.json({ grants: {} });
      const [rows] = await getPool().query(`SELECT permission, granted FROM user_permissions WHERE user_id=?`, [req.session.userId]);
      const grants = {};
      for (const r of rows) grants[r.permission] = r.granted === 1;
      grants.can_create_post = true;
      grants.can_delete_post = true;
      grants.can_comment_post = true;
      grants.can_like_post = true;
      res.json({ grants });
    } catch (e) { console.error('[admin]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  router.post('/permissions/set', requireAdminCompat, async (req, res) => {
    try {
      const { userId, permission, granted } = req.body;
      if (!userId || !permission) return res.status(400).json({ error: '参数错误' });
      await getPool().query(
        `INSERT INTO user_permissions (user_id, permission, granted, granted_by) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE granted=?, granted_by=?`,
        [userId, permission, granted ? 1 : 0, req.session.userId, granted ? 1 : 0, req.session.userId]
      );
      res.json({ success: true });
    } catch (e) { console.error('[admin]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  // ==================== 操作日志 API ====================
  router.get('/admin/logs', requireAdminCompat, async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const pageSize = parseInt(req.query.pageSize) || 20;
      const offset = (page - 1) * pageSize;
      const operType = req.query.type ? req.query.type.trim() : '';
      const searchUser = req.query.user ? req.query.user.trim() : '';
      const conditions = [`1=1`];
      const params = [];
      if (operType) {
        conditions.push(`oper_type = ?`);
        params.push(operType);
      }
      if (searchUser) {
        conditions.push(`admin_vrcid LIKE ?`);
        params.push(`%${searchUser}%`);
      }
      const where = conditions.join(' AND ');
      const [count] = await getPool().query(`SELECT COUNT(*) as total FROM sys_oper_log WHERE ${where}`, params);
      const [rows] = await getPool().query(
        `SELECT admin_vrcid AS adminVrcId, oper_type AS operType, content, create_time AS createTime FROM sys_oper_log WHERE ${where} ORDER BY create_time DESC LIMIT ? OFFSET ?`,
        [...params, pageSize, offset]
      );
      const totalPages = Math.ceil(count[0].total / pageSize);
      res.json({ logs: rows, total: count[0].total, page, pageSize, totalPages });
    } catch (e) { console.error('[admin]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  return router;
};
