/**
 * 境途同游 V6.15 — 通知系统路由
 * 
 * @swagger
 * tags:
 *   name: Notifications
 *   description: 通知系统相关接口
 */
const express = require('express');
const { ok, getPool, handleError , sendError, ErrorCodes } = require('../utils');
const { requireAuth } = require('../auth');

module.exports = function (authStateRef, notificationService) {
  const router = express.Router();

  router.get('/notifications', async (req, res) => {
    const uid = req.session?.userId || null;
    if (!uid) return res.json({ notifications: [], unread: 0, page: 1, totalPages: 0, total: 0 });
    try {
      const type = req.query.type;        // 按类型过滤：system/event/comment/announcement/... 或 'unread' 仅未读
      const onlyUnread = type === 'unread';
      const pageSize = Math.min(parseInt(req.query.pageSize) || 30, 100);
      const page = Math.max(parseInt(req.query.page) || 1, 1);
      const offset = (page - 1) * pageSize;

      const where = ['user_id = ?'];
      const params = [uid];
      if (onlyUnread) where.push('is_read = 0');
      else if (type && type !== 'all') { where.push('type = ?'); params.push(type); }
      const whereSql = 'WHERE ' + where.join(' AND ');

      const [unreadCount] = await getPool().query(`SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND is_archived = 0 AND is_read = 0`, [uid]);
      const [totalRow] = await getPool().query(`SELECT COUNT(*) as c FROM notifications ${whereSql}`, params);
      const total = totalRow[0].c;
      const totalPages = Math.max(Math.ceil(total / pageSize), 1);

      const [rows] = await getPool().query(
        `SELECT id, type, title, message, related_id AS relatedId,
                target_type AS targetType, target_id AS targetId, post_id AS postId,
                is_read AS isRead, created_at AS createdAt
         FROM notifications ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        params.concat([pageSize, offset])
      );
      res.json({ notifications: rows, unread: unreadCount[0].c, page, pageSize, totalPages, total });
    } catch (e) { handleError(res, e, '[notifications]'); }
  });

  router.get('/notifications/unread', async (req, res) => {
    const uid = req.session?.userId || null;
    if (!uid) return res.json({ count: 0 });
    try {
      const [rows] = await getPool().query('SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND is_archived = 0 AND is_read = 0', [uid]);
      res.json({ count: rows[0].c });
    } catch (e) { handleError(res, e, '[notifications/unread]'); }
  });

  router.post('/notifications/read', async (req, res) => {
    const uid = req.session?.userId || null;
    if (!uid) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, '请先登录');
    try {
      await getPool().query(`UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0`, [uid]);
      ok(res);
    } catch (e) { handleError(res, e, '[notifications/read]'); }
  });

  router.post('/notifications/read-all', async (req, res) => {
    const uid = req.session?.userId || null;
    if (!uid) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, '请先登录');
    try {
      await getPool().query(`UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0`, [uid]);
      ok(res);
    } catch (e) { handleError(res, e, '[notifications/read-all]'); }
  });

  router.post('/notifications/archive-all', async (req, res) => {
    const uid = req.session?.userId || null;
    if (!uid) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, '请先登录');
    try {
      await getPool().query('UPDATE notifications SET is_archived = 1 WHERE user_id = ?', [uid]);
      ok(res);
    } catch (e) { handleError(res, e, '[notifications/archive-all]'); }
  });

  router.get('/notifications/settings', requireAuth, async (req, res) => {
    try {
      const [rows] = await getPool().query(`SELECT notification_settings FROM users WHERE id = ?`, [req.session.userId]);
      if (rows.length === 0) {
        return res.json({ email: false, browser: true, sound: true });
      }
      const settings = rows[0].notification_settings ? JSON.parse(rows[0].notification_settings) : {};
      res.json({
        email: settings.email || false,
        browser: settings.browser !== false,
        sound: settings.sound !== false
      });
    } catch (e) { handleError(res, e, '[notifications/settings]'); }
  });

  router.post('/notifications/settings', requireAuth, async (req, res) => {
    try {
      const { email, browser, sound } = req.body;
      const settings = { email: !!email, browser: !!browser, sound: !!sound };
      await getPool().query(
        `UPDATE users SET notification_settings = ? WHERE id = ?`,
        [JSON.stringify(settings), req.session.userId]
      );
      if (notificationService) notificationService.invalidateSettingsCache(req.session.userId);
      ok(res, {settings});
    } catch (e) { handleError(res, e, '[notifications/settings]'); }
  });

  router.delete('/notifications', async (req, res) => {
    const uid = req.session?.userId || null;
    if (!uid) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, '请先登录');
    try {
      await getPool().query(`DELETE FROM notifications WHERE user_id = ?`, [uid]);
      ok(res);
    } catch (e) { handleError(res, e, '[notifications/delete]'); }
  });

  router.post('/notifications/:id/read', async (req, res) => {
    const uid = req.session?.userId || null;
    if (!uid) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, '请先登录');
    try {
      await getPool().query(`UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?`, [req.params.id, uid]);
      ok(res);
    } catch (e) { handleError(res, e, '[notifications/:id/read]'); }
  });

  router.put('/notifications/:id/archive', async (req, res) => {
    const uid = req.session?.userId || null;
    if (!uid) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, '请先登录');
    try {
      const { archived } = req.body;
      await getPool().query('UPDATE notifications SET is_archived = ? WHERE id = ? AND user_id = ?', [archived ? 1 : 0, req.params.id, uid]);
      ok(res, {archived: !!archived});
    } catch (e) { handleError(res, e, '[notifications/:id/archive]'); }
  });

  router.delete('/notifications/:id', async (req, res) => {
    const uid = req.session?.userId;
    if (!uid) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, '请先登录');
    try {
      await getPool().query(`DELETE FROM notifications WHERE id = ? AND user_id = ?`, [req.params.id, uid]);
      ok(res);
    } catch (e) { handleError(res, e, '[notifications/:id]'); }
  });

  return router;
};
