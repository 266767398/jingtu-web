/**
 * 境途同游 V6.87 — 用户点赞系统
 * 每天每人只能给同一用户点赞一次
 * 用户可以查看收到的点赞数和点赞过的用户
 */

const express = require('express');
const { getPool, handleError , sendError, ErrorCodes } = require('../utils');
const { requireAuth } = require('../auth');

module.exports = function (notificationService) {
  const router = express.Router();

router.post('/:userId/like', requireAuth, async (req, res) => {
  try {
    const targetUserId = parseInt(req.params.userId);
    const currentUserId = req.session.userId;

    if (!targetUserId) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
    }

    if (targetUserId === currentUserId) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '不能给自己点赞');
    }

    const [targetUser] = await getPool().query(`SELECT id FROM users WHERE id = ? AND deleted_at IS NULL`, [targetUserId]);
    if (targetUser.length === 0) {
      return sendError(res, 404, ErrorCodes.NOT_FOUND, '用户不存在');
    }

    const today = new Date().toISOString().split('T')[0];

    const [existing] = await getPool().query(
      `SELECT 1 FROM user_like WHERE from_user_id = ? AND to_user_id = ? AND like_date = ?`,
      [currentUserId, targetUserId, today]
    );

    if (existing.length > 0) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '今天已经给该用户点过赞了，明天再来吧！');
    }

    await getPool().query(
      `INSERT INTO user_like (from_user_id, to_user_id, like_date) VALUES (?, ?, ?)`,
      [currentUserId, targetUserId, today]
    );

    const [[{ likeCount }]] = await getPool().query(
      `SELECT COUNT(*) as likeCount FROM user_like WHERE to_user_id = ?`,
      [targetUserId]
    );

    const [[{ todayLikes }]] = await getPool().query(
      `SELECT COUNT(*) as todayLikes FROM user_like WHERE from_user_id = ? AND like_date = ?`,
      [currentUserId, today]
    );

    const [fromUser] = await getPool().query(
      `SELECT display_name FROM users WHERE id = ?`,
      [currentUserId]
    );
    const fromUserName = fromUser[0]?.display_name || '用户';

    if (notificationService) {
      await notificationService.notifyUser(
        targetUserId,
        'like',
        '收到点赞！',
        `${fromUserName} 给你点赞了 ❤️`,
        { targetType: 'user', targetId: currentUserId }
      );
    }

    res.json({
      success: true,
      likeCount: likeCount,
      todayLikes: todayLikes,
      message: '点赞成功！'
    });
  } catch (e) {
    handleError(res, e, '[user-like/like]');
  }
});

router.get('/:userId/stats', requireAuth, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const currentUserId = req.session.userId;

    if (!userId) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
    }

    const today = new Date().toISOString().split('T')[0];

    const [likeCountResult] = await getPool().query(
      `SELECT COUNT(*) as totalLikes FROM user_like WHERE to_user_id = ?`,
      [userId]
    );
    const totalLikes = likeCountResult[0].totalLikes;

    const [todayLikeResult] = await getPool().query(
      `SELECT COUNT(*) as todayLikes FROM user_like WHERE to_user_id = ? AND like_date = ?`,
      [userId, today]
    );
    const todayLikes = todayLikeResult[0].todayLikes;

    const [givenTodayResult] = await getPool().query(
      `SELECT COUNT(*) as givenToday FROM user_like WHERE from_user_id = ? AND like_date = ?`,
      [currentUserId, today]
    );
    const givenToday = givenTodayResult[0].givenToday;

    const [hasLikedToday] = await getPool().query(
      `SELECT 1 FROM user_like WHERE from_user_id = ? AND to_user_id = ? AND like_date = ?`,
      [currentUserId, userId, today]
    );
    const likedToday = hasLikedToday.length > 0;

    res.json({
      userId,
      totalLikes,
      todayLikes,
      givenToday,
      likedToday,
      canLike: !likedToday && userId !== currentUserId
    });
  } catch (e) {
    handleError(res, e, '[user-like/stats]');
  }
});

router.get('/:userId/likers', requireAuth, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize) || 20));
    const offset = (page - 1) * pageSize;

    if (!userId) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
    }

    const [count] = await getPool().query(
      `SELECT COUNT(DISTINCT from_user_id) as total FROM user_like WHERE to_user_id = ?`,
      [userId]
    );
    const total = count[0].total;

    const [likers] = await getPool().query(
      `SELECT u.id, u.display_name, u.vrchat_name, u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url,
              COUNT(l.id) as likeCount, MAX(l.created_at) as lastLikeAt
       FROM user_like l
       JOIN users u ON l.from_user_id = u.id
       WHERE l.to_user_id = ? AND u.deleted_at IS NULL
       GROUP BY u.id, u.display_name, u.vrchat_name, u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url
       ORDER BY lastLikeAt DESC, likeCount DESC
       LIMIT ? OFFSET ?`,
      [userId, pageSize, offset]
    );

    const totalPages = Math.ceil(total / pageSize);
    const hasMore = offset + pageSize < total;

    res.json({
      likers,
      total,
      page,
      pageSize,
      totalPages,
      hasMore
    });
  } catch (e) {
    handleError(res, e, '[user-like/likers]');
  }
});

router.get('/me/given', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize) || 20));
    const offset = (page - 1) * pageSize;

    const [count] = await getPool().query(
      `SELECT COUNT(DISTINCT to_user_id) as total FROM user_like WHERE from_user_id = ?`,
      [userId]
    );
    const total = count[0].total;

    const [given] = await getPool().query(
      `SELECT u.id, u.display_name, u.vrchat_name, u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url,
              COUNT(l.id) as likeCount, MAX(l.created_at) as lastLikeAt
       FROM user_like l
       JOIN users u ON l.to_user_id = u.id
       WHERE l.from_user_id = ? AND u.deleted_at IS NULL
       GROUP BY u.id, u.display_name, u.vrchat_name, u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url
       ORDER BY lastLikeAt DESC, likeCount DESC
       LIMIT ? OFFSET ?`,
      [userId, pageSize, offset]
    );

    const totalPages = Math.ceil(total / pageSize);
    const hasMore = offset + pageSize < total;

    res.json({
      given,
      total,
      page,
      pageSize,
      totalPages,
      hasMore
    });
  } catch (e) {
    handleError(res, e, '[user-like/given]');
  }
});

router.get('/me/today-stats', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const today = new Date().toISOString().split('T')[0];

    const [givenTodayResult] = await getPool().query(
      `SELECT COUNT(*) as givenToday FROM user_like WHERE from_user_id = ? AND like_date = ?`,
      [userId, today]
    );
    const givenToday = givenTodayResult[0].givenToday;

    const [receivedTodayResult] = await getPool().query(
      `SELECT COUNT(*) as receivedToday FROM user_like WHERE to_user_id = ? AND like_date = ?`,
      [userId, today]
    );
    const receivedToday = receivedTodayResult[0].receivedToday;

    const [totalGivenResult] = await getPool().query(
      `SELECT COUNT(*) as totalGiven FROM user_like WHERE from_user_id = ?`,
      [userId]
    );
    const totalGiven = totalGivenResult[0].totalGiven;

    const [totalReceivedResult] = await getPool().query(
      `SELECT COUNT(*) as totalReceived FROM user_like WHERE to_user_id = ?`,
      [userId]
    );
    const totalReceived = totalReceivedResult[0].totalReceived;

    res.json({
      today: {
        given: givenToday,
        received: receivedToday
      },
      total: {
        given: totalGiven,
        received: totalReceived
      }
    });
  } catch (e) {
    handleError(res, e, '[user-like/today-stats]');
  }
});

router.get('/leaderboard', requireAuth, async (req, res) => {
  try {
    const period = req.query.period || 'all';
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize) || 20));
    const offset = (page - 1) * pageSize;

    let dateCondition = '';
    const now = new Date();
    
    if (period === 'today') {
      dateCondition = `AND l.like_date = '${now.toISOString().split('T')[0]}'`;
    } else if (period === 'week') {
      const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      dateCondition = `AND l.created_at >= '${oneWeekAgo.toISOString()}'`;
    } else if (period === 'month') {
      const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      dateCondition = `AND l.created_at >= '${oneMonthAgo.toISOString()}'`;
    }

    const [count] = await getPool().query(
      `SELECT COUNT(DISTINCT l.to_user_id) as total FROM user_like l
       JOIN users u ON l.to_user_id = u.id
       WHERE u.deleted_at IS NULL ${dateCondition}`
    );
    const total = count[0].total;

    const [leaderboard] = await getPool().query(
      `SELECT u.id, u.display_name, u.vrchat_name, u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url,
              COUNT(l.id) as likeCount
       FROM user_like l
       JOIN users u ON l.to_user_id = u.id
       WHERE u.deleted_at IS NULL ${dateCondition}
       GROUP BY u.id, u.display_name, u.vrchat_name, u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url
       ORDER BY likeCount DESC
       LIMIT ? OFFSET ?`,
      [pageSize, offset]
    );

    const totalPages = Math.ceil(total / pageSize);
    const hasMore = offset + pageSize < total;

    res.json({
      leaderboard: leaderboard.map((user, index) => ({
        ...user,
        rank: offset + index + 1
      })),
      period,
      total,
      page,
      pageSize,
      totalPages,
      hasMore
    });
  } catch (e) {
    handleError(res, e, '[user-like/leaderboard]');
  }
});

router.get('/mutual/:userId', requireAuth, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const currentUserId = req.session.userId;

    if (!userId || userId === currentUserId) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
    }

    const [mutualLikes] = await getPool().query(
      `SELECT l1.like_date as date
       FROM user_like l1
       JOIN user_like l2 ON l1.from_user_id = l2.to_user_id AND l1.to_user_id = l2.from_user_id AND l1.like_date = l2.like_date
       WHERE l1.from_user_id = ? AND l1.to_user_id = ?
       ORDER BY l1.like_date DESC`,
      [currentUserId, userId]
    );

    res.json({
      mutualDays: mutualLikes.length,
      history: mutualLikes
    });
  } catch (e) {
    handleError(res, e, '[user-like/mutual]');
  }
});

  return router;
};