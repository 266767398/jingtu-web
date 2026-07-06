/**
 * 境途同游 V6.14 — 通知系统路由
 */
const express = require('express');
const { getPool, safeError } = require('../utils');

module.exports = function (authStateRef) {
  const router = express.Router();

  router.get('/notifications', async (req, res) => {
    const uid = req.session?.userId || (authStateRef.loggedIn ? authStateRef.userId : null);
    if (!uid) return res.json({ notifications: [], unread: 0 });
    try {
      const [unreadCount] = await getPool().query(`SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND is_read = 0`, [uid]);
      const [rows] = await getPool().query(
        `SELECT id, type, title, message, related_id AS relatedId, is_read AS isRead, created_at AS createdAt
         FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 30`, [uid]
      );
      res.json({ notifications: rows, unread: unreadCount[0].c });
    } catch (e) { console.error('[notifications]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  router.post('/notifications/:id/read', async (req, res) => {
    const uid = req.session?.userId || (authStateRef.loggedIn ? authStateRef.userId : null);
    if (!uid) return res.status(401).json({ error: '请先登录' });
    try {
      await getPool().query(`UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?`, [req.params.id, uid]);
      res.json({ success: true });
    } catch (e) { console.error('[notifications]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  router.post('/notifications/read-all', async (req, res) => {
    const uid = req.session?.userId || (authStateRef.loggedIn ? authStateRef.userId : null);
    if (!uid) return res.status(401).json({ error: '请先登录' });
    try {
      await getPool().query(`UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0`, [uid]);
      res.json({ success: true });
    } catch (e) { console.error('[notifications]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  // 删除单条通知
  router.delete('/notifications/:id', async (req, res) => {
    const uid = req.session?.userId;
    if (!uid) return res.status(401).json({ error: '请先登录' });
    try {
      await getPool().query(`DELETE FROM notifications WHERE id = ? AND user_id = ?`, [req.params.id, uid]);
      res.json({ success: true });
    } catch (e) { console.error('[notifications]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  // 清空所有通知
  router.delete('/notifications', async (req, res) => {
    const uid = req.session?.userId;
    if (!uid) return res.status(401).json({ error: '请先登录' });
    try {
      await getPool().query(`DELETE FROM notifications WHERE user_id = ?`, [uid]);
      res.json({ success: true });
    } catch (e) { console.error('[notifications]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  return router;
};
