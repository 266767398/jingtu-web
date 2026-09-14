/**
 * 境途同游 V7.10 — 关注系统路由
 * 单向关注；UNIQUE(follower_id, following_id) 防重复；关注幂等（已关注直接返回成功）。
 * 接口契约（入参/出参/越权/错误码）严格遵循 docs/10 §6.3。
 */
const express = require('express');
const { ok, getPool, getAvatarUrl, handleError, sendError, ErrorCodes, paginate } = require('../utils');
const { requireAuth } = require('../auth');

module.exports = function (notificationService) {
  const router = express.Router();

  // 用户摘要（JOIN users 后映射；users 无 bio 列）
  function toUserSummary(u) {
    if (!u) return null;
    return {
      id: u.id,
      displayName: u.display_name || '',
      vrchatName: u.vrchat_name || '',
      avatarUrl: getAvatarUrl(u) || '/api/avatar/default'
    };
  }

  async function userExists(id) {
    const [rows] = await getPool().query(
      `SELECT id FROM users WHERE id = ? AND deleted_at IS NULL`, [id]
    );
    return rows.length > 0;
  }

  // ==================== POST /api/follows ====================
  router.post('/', requireAuth, async (req, res) => {
    try {
      const me = req.session.userId;
      const targetUserId = parseInt(req.body.targetUserId);
      if (!targetUserId || isNaN(targetUserId)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      }
      if (targetUserId === me) {
        return sendError(res, 400, ErrorCodes.SELF_FOLLOW, '不能关注自己');
      }
      if (!(await userExists(targetUserId))) {
        return sendError(res, 404, ErrorCodes.NOT_FOUND, '用户不存在');
      }

      const pool = getPool();
      const [existing] = await pool.query(
        `SELECT 1 FROM user_follows WHERE follower_id = ? AND following_id = ?`,
        [me, targetUserId]
      );
      // 幂等：已关注直接返回成功（docs/10 §6.3）
      if (existing.length) {
        return ok(res, {ok: true, following: true});
      }

      // 拉黑双向校验：任一方 blocked 即禁止建立关注
      const [blockRel] = await pool.query(
        `SELECT 1 FROM user_friends WHERE status = 'blocked' AND ((user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?))`,
        [me, targetUserId, targetUserId, me]
      );
      if (blockRel.length) {
        return sendError(res, 403, ErrorCodes.BLOCKED, '存在拉黑关系，无法关注');
      }

      await pool.query(
        `INSERT INTO user_follows (follower_id, following_id) VALUES (?, ?)`,
        [me, targetUserId]
      );
      if (notificationService) {
        const [meU] = await pool.query(`SELECT display_name FROM users WHERE id = ?`, [me]);
        const myName = meU[0]?.display_name || '用户';
        await notificationService.notifyUser(
          targetUserId, 'follow', '新的关注',
          `${myName} 关注了你`, { targetType: 'user', targetId: me }
        );
      }
      return ok(res, {ok: true, following: true});
    } catch (e) {
      handleError(res, e, '[follows/follow]');
    }
  });

  // ==================== DELETE /api/follows/:targetUserId ====================
  router.delete('/:targetUserId', requireAuth, async (req, res) => {
    try {
      const me = req.session.userId;
      const targetUserId = parseInt(req.params.targetUserId);
      if (!targetUserId || isNaN(targetUserId)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      }
      const pool = getPool();
      const [r] = await pool.query(
        `DELETE FROM user_follows WHERE follower_id = ? AND following_id = ?`,
        [me, targetUserId]
      );
      if (r.affectedRows === 0) {
        return sendError(res, 404, ErrorCodes.NOT_FOLLOWING, '你还没有关注该用户');
      }
      return ok(res, {ok: true, following: false});
    } catch (e) {
      handleError(res, e, '[follows/unfollow]');
    }
  });

  // ==================== GET /api/follows/following?userId&page ====================
  router.get('/following', requireAuth, async (req, res) => {
    try {
      const me = req.session.userId;
      const userId = parseInt(req.query.userId) || me;
      const { page, pageSize, offset } = paginate(req, { defaultSize: 20, maxSize: 100 });
      const pool = getPool();

      const [count] = await pool.query(
        `SELECT COUNT(*) AS total FROM user_follows WHERE follower_id = ?`, [userId]
      );
      const total = count[0].total;

      const [rows] = await pool.query(
        `SELECT u.id, u.display_name, u.vrchat_name, u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url,
                f.created_at AS followedAt
         FROM user_follows f
         JOIN users u ON u.id = f.following_id
         WHERE f.follower_id = ? AND u.deleted_at IS NULL
         ORDER BY f.created_at DESC
         LIMIT ? OFFSET ?`,
        [userId, pageSize, offset]
      );
      const list = rows.map(r => ({ ...toUserSummary(r), followedAt: r.followedAt }));
      res.json({ list, page, pageSize, total });
    } catch (e) {
      handleError(res, e, '[follows/following]');
    }
  });

  // ==================== GET /api/follows/followers?userId&page ====================
  router.get('/followers', requireAuth, async (req, res) => {
    try {
      const me = req.session.userId;
      const userId = parseInt(req.query.userId) || me;
      const { page, pageSize, offset } = paginate(req, { defaultSize: 20, maxSize: 100 });
      const pool = getPool();

      const [count] = await pool.query(
        `SELECT COUNT(*) AS total FROM user_follows WHERE following_id = ?`, [userId]
      );
      const total = count[0].total;

      const [rows] = await pool.query(
        `SELECT u.id, u.display_name, u.vrchat_name, u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url,
                f.created_at AS followedAt
         FROM user_follows f
         JOIN users u ON u.id = f.follower_id
         WHERE f.following_id = ? AND u.deleted_at IS NULL
         ORDER BY f.created_at DESC
         LIMIT ? OFFSET ?`,
        [userId, pageSize, offset]
      );
      const list = rows.map(r => ({ ...toUserSummary(r), followedAt: r.followedAt }));
      res.json({ list, page, pageSize, total });
    } catch (e) {
      handleError(res, e, '[follows/followers]');
    }
  });

  // ==================== GET /api/follows/status/:userId ====================
  router.get('/status/:userId', requireAuth, async (req, res) => {
    try {
      const me = req.session.userId;
      const target = parseInt(req.params.userId);
      if (!target || isNaN(target)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      }
      const pool = getPool();
      const [f1] = await pool.query(
        `SELECT 1 FROM user_follows WHERE follower_id = ? AND following_id = ?`,
        [me, target]
      );
      const [f2] = await pool.query(
        `SELECT 1 FROM user_follows WHERE follower_id = ? AND following_id = ?`,
        [target, me]
      );
      res.json({ following: f1.length > 0, followedBy: f2.length > 0 });
    } catch (e) {
      handleError(res, e, '[follows/status]');
    }
  });

  // ==================== GET /api/follows/counts/:userId ====================
  router.get('/counts/:userId', requireAuth, async (req, res) => {
    try {
      const userId = parseInt(req.params.userId);
      if (!userId || isNaN(userId)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      }
      const pool = getPool();
      const [c1] = await pool.query(
        `SELECT COUNT(*) AS following FROM user_follows WHERE follower_id = ?`, [userId]
      );
      const [c2] = await pool.query(
        `SELECT COUNT(*) AS followers FROM user_follows WHERE following_id = ?`, [userId]
      );
      res.json({ following: c1[0].following, followers: c2[0].followers });
    } catch (e) {
      handleError(res, e, '[follows/counts]');
    }
  });

  return router;
};
