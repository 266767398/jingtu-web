/**
 * 统计 / 公开统计 / 全局搜索 / 客户端配置（P2-4 第二步第二批）
 * 从 server.js 原地抽取为 /api 前缀路由；「在线」语义与降级行为保持不变。
 *
 * 守卫语义（round5-regressions）：
 * - /api/stats 与 /api/public/stats 的 online/onlineCount 必须取 wsService.onlineUsers.size
 *   （本站 WebSocket 实时名单），而不是 group_roster.is_online（VRChat 游戏内在线）。
 */
const express = require('express');
const { requireAuth } = require('../auth');
const wsService = require('../ws_service');
const { getPool, fail, safeError } = require('../utils');
const logger = require('../logger');

module.exports = function createStatsRouter() {
  const router = express.Router();

  // 前端运行环境配置：暴露可通过环境变量部署调整的客户端参数（如 WebSocket 地址）。
  // 前端 connectWebSocket 优先读取本接口返回的 wsUrl，否则按当前协议自动探测。
  router.get('/client-config', (req, res) => {
    const wsUrl = process.env.WS_URL || '';
    res.json({ wsUrl });
  });

  router.get('/stats', requireAuth, async (req, res) => {
    try {
      // 统计条上的「在线」点开是本站在线成员列表（WebSocket 实时名单），
      // 数字必须和它同源。原来这里查的是 group_roster.is_online —— 那是
      // VRChat 群组成员在游戏里的在线状态，语义完全不同；两个数写进同一个
      // #dashOnline，谁后到谁赢，用户看到的数字会来回跳。
      const onlineCount = wsService.onlineUsers.size;
      const [
        [memberRes], [photoRes], [eventRes], [postRes], [vrcOnlineRes],
        [memberGrowth], [eventSignRate], [postActivity], [checkinStats], [recentUsers]
      ] = await Promise.all([
        getPool().query('SELECT COUNT(*) as count FROM users WHERE deleted_at IS NULL AND approved = 1 AND banned = 0'),
        getPool().query('SELECT COUNT(*) as count FROM album_photo WHERE is_recycle=0'),
        getPool().query('SELECT COUNT(*) as count FROM event WHERE is_archive=0'),
        getPool().query('SELECT COUNT(*) as count FROM posts'),
        getPool().query('SELECT COUNT(*) as count FROM group_roster WHERE is_member=1 AND is_online=1'),
        getPool().query(`SELECT DATE(created_at) as date, COUNT(*) as count FROM users WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) GROUP BY DATE(created_at) ORDER BY date`),
        getPool().query(`SELECT e.id, e.title, e.event_time as eventTime, COUNT(es.id) as signCount, e.max_sign as maxSign FROM event e LEFT JOIN event_sign es ON e.id = es.event_id WHERE e.is_archive=0 GROUP BY e.id ORDER BY e.event_time DESC LIMIT 10`),
        getPool().query(`SELECT DATE(created_at) as date, COUNT(*) as posts, SUM(like_count) as likes, SUM(comment_count) as comments FROM posts WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) GROUP BY DATE(created_at) ORDER BY date`),
        getPool().query(`SELECT COUNT(*) as total FROM event_checkin`),
        getPool().query(`SELECT id, display_name, created_at FROM users ORDER BY created_at DESC LIMIT 10`)
      ]);

      res.json({
        members: memberRes[0].count,
        photos: photoRes[0].count,
        events: eventRes[0].count,
        posts: postRes[0].count,
        online: onlineCount,
        vrcOnline: vrcOnlineRes[0].count,
        checkins: checkinStats[0].total,
        memberGrowth: memberGrowth,
        eventSignRate: eventSignRate.map(e => ({
          id: e.id,
          title: e.title,
          eventTime: e.eventTime,
          signCount: e.signCount,
          maxSign: e.maxSign,
          rate: e.maxSign > 0 ? Math.round((e.signCount / e.maxSign) * 100) : 0
        })),
        postActivity: postActivity,
        recentUsers: recentUsers
      });
    } catch (e) { logger.error('[stats]', e.message, e.stack); fail(res, 500, safeError(e.message)); }
  });

  router.get('/public/stats', async (req, res) => {
    try {
      const [
        [memberRes], [photoRes], [eventRes], [postRes], [onlineRes]
      ] = await Promise.all([
        getPool().query('SELECT COUNT(*) as count FROM users WHERE deleted_at IS NULL AND approved = 1 AND banned = 0'),
        getPool().query('SELECT COUNT(*) as count FROM album_photo WHERE is_recycle=0'),
        getPool().query('SELECT COUNT(*) as count FROM event WHERE is_archive=0'),
        getPool().query('SELECT COUNT(*) as count FROM posts'),
        getPool().query('SELECT COUNT(*) as count FROM group_roster WHERE is_member=1 AND is_online=1')
      ]);

      res.json({
        totalUsers: memberRes[0].count,
        totalPhotos: photoRes[0].count,
        totalEvents: eventRes[0].count,
        totalPosts: postRes[0].count,
        // 与 /api/stats 保持同一语义：本站实时在线（WebSocket 名单），
        // 而不是 VRChat 群成员在游戏里的在线状态。
        onlineCount: wsService.onlineUsers.size,
        vrcOnlineCount: onlineRes[0].count
      });
    } catch (e) {
      logger.error('[public/stats]', e.message, e.stack);
      res.json({
        totalUsers: '-',
        totalPhotos: '-',
        totalEvents: '-',
        totalPosts: '-',
        onlineCount: 0
      });
    }
  });

  // ==================== 全局搜索 ====================
  router.get('/search', requireAuth, async (req, res) => {
    try {
      const q = (req.query.q || '').trim();
      if (q.length < 2) return res.json({ announcements: [], events: [], users: [] });
      const like = `%${q}%`;

      const [announcements] = await getPool().query(
        `SELECT id, title, content FROM announcement WHERE title LIKE ? OR content LIKE ? ORDER BY create_time DESC LIMIT 5`,
        [like, like]
      );

      const [events] = await getPool().query(
        `SELECT id, title, description FROM event WHERE (title LIKE ? OR description LIKE ?) AND is_archive=0 ORDER BY event_time DESC LIMIT 5`,
        [like, like]
      );

      const [users] = await getPool().query(
        `SELECT id, login_id AS loginId, display_name AS displayName FROM users WHERE deleted_at IS NULL AND approved=1 AND banned=0 AND (login_id LIKE ? OR display_name LIKE ?) LIMIT 5`,
        [like, like]
      );

      res.json({ announcements, events, users });
    } catch (e) {
      logger.error('[search]', e.message, e.stack);
      res.json({ announcements: [], events: [], users: [] });
    }
  });

  return router;
};
