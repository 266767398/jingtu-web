/**
 * 境途同游 V7.10 — 好友系统路由
 * 单向行 + status 表示 user_id 对 friend_id 的视角；
 *   accepted 写两条对称行便于双向查询；
 *   blocked 单向优先（私聊模块据此拦截，见 docs/10 §3 / §4.2）。
 * 接口契约（入参/出参/越权/错误码）严格遵循 docs/10 §3.3。
 */
const express = require('express');
const { ok,  getPool, getAvatarUrl, handleError, sendError, ErrorCodes, paginate  } = require('../utils');;
const { requireAuth } = require('../auth');

module.exports = function (notificationService) {
  const router = express.Router();

  // 用户摘要（JOIN users 后映射，复用 user_like 既有字段约定；users 无 bio 列）
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

  /**
   * 将一条 pending 申请转为双向 accepted 好友关系（事务）。
   * @param {object} pool  - mysql2 连接池
   * @param {number} pendingId - 待接受的 pending 行 id（user_id=发起方, friend_id=当前用户）
   * @param {number} requester - 发起方 user_id
   * @param {number} me       - 当前接受方 user_id
   */
  async function acceptFriendship(pool, pendingId, requester, me) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        `UPDATE user_friends SET status='accepted' WHERE id = ? AND friend_id = ? AND status='pending'`,
        [pendingId, me]
      );
      await conn.query(
        `INSERT IGNORE INTO user_friends (user_id, friend_id, status, requested_by)
         VALUES (?, ?, 'accepted', ?)`,
        [me, requester, requester]
      );
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }

  // ==================== POST /api/friends/request ====================
  router.post('/request', requireAuth, async (req, res) => {
    try {
      const me = req.session.userId;
      const targetUserId = parseInt(req.body.targetUserId);
      if (!targetUserId || isNaN(targetUserId)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      }
      if (targetUserId === me) {
        return sendError(res, 400, ErrorCodes.SELF_FRIEND, '不能添加自己为好友');
      }
      if (!(await userExists(targetUserId))) {
        return sendError(res, 404, ErrorCodes.NOT_FOUND, '用户不存在');
      }

      const pool = getPool();

      let conn;
      try {
        conn = await pool.getConnection();
        await conn.beginTransaction();

        // 对方已拉黑我 → 禁止互动（BLOCKED 403）
        const [blockedByThem] = await conn.query(
          `SELECT 1 FROM user_friends WHERE user_id = ? AND friend_id = ? AND status = 'blocked' FOR UPDATE`,
          [targetUserId, me]
        );
        if (blockedByThem.length) {
          await conn.rollback();
          return sendError(res, 403, ErrorCodes.BLOCKED, '已被对方拉黑，无法互动');
        }

        // 我 → 对方 现有关系（锁行，避免并发 check-then-insert 竞态）
        const [mine] = await conn.query(
          `SELECT status FROM user_friends WHERE user_id = ? AND friend_id = ? FOR UPDATE`,
          [me, targetUserId]
        );
        if (mine.length) {
          const st = mine[0].status;
          if (st === 'accepted') {
            await conn.rollback();
            return sendError(res, 409, ErrorCodes.ALREADY_FRIENDS, '你们已经是好友了');
          }
          if (st === 'pending') {
            await conn.rollback();
            return sendError(res, 409, ErrorCodes.FRIEND_REQUEST_EXISTS, '好友申请已发送，等待对方确认');
          }
          if (st === 'blocked') {
            await conn.rollback();
            return sendError(res, 409, ErrorCodes.ALREADY_BLOCKED, '你已拉黑该用户，请先解除拉黑');
          }
        }

        // 对方 → 我 已有 pending（对方先申请了我）：我的申请即视为接受（同一事务内原子完成）
        const [incoming] = await conn.query(
          `SELECT id, user_id AS requester FROM user_friends
           WHERE user_id = ? AND friend_id = ? AND status = 'pending' FOR UPDATE`,
          [targetUserId, me]
        );
        if (incoming.length) {
          await conn.query(
            `UPDATE user_friends SET status='accepted' WHERE id = ? AND friend_id = ? AND status='pending'`,
            [incoming[0].id, me]
          );
          await conn.query(
            `INSERT IGNORE INTO user_friends (user_id, friend_id, status, requested_by)
             VALUES (?, ?, 'accepted', ?)`,
            [me, incoming[0].requester, incoming[0].requester]
          );
          await conn.commit();
          if (notificationService) {
            const [meU] = await pool.query(`SELECT display_name FROM users WHERE id = ?`, [me]);
            const myName = meU[0]?.display_name || '用户';
            await notificationService.notifyUser(
              targetUserId, 'friend_accepted', '好友请求已通过',
              `${myName} 接受了你的好友请求`, { targetType: 'user', targetId: me }
            );
          }
          return ok(res, { status: 'accepted', friendship: { status: 'accepted' } });
        }

        // 新建 pending 申请（同向并发重复 → 唯一键冲突 → 409，避免 500）
        let insertId;
        try {
          const [r] = await conn.query(
            `INSERT INTO user_friends (user_id, friend_id, status, requested_by)
             VALUES (?, ?, 'pending', ?)`,
            [me, targetUserId, me]
          );
          insertId = r.insertId;
        } catch (e) {
          await conn.rollback();
          if (e && e.code === 'ER_DUP_ENTRY') {
            return sendError(res, 409, ErrorCodes.FRIEND_REQUEST_EXISTS, '好友申请已发送，等待对方确认');
          }
          throw e;
        }
        await conn.commit();
        if (notificationService) {
          const [meU] = await pool.query(`SELECT display_name FROM users WHERE id = ?`, [me]);
          const myName = meU[0]?.display_name || '用户';
          await notificationService.notifyUser(
            targetUserId, 'friend_request', '新的好友请求',
            `${myName} 想加你为好友`, { targetType: 'user', targetId: me }
          );
        }
        return ok(res, {
          status: 'pending',
          friendship: { id: insertId, status: 'pending', targetUserId }
        });
      } catch (e) {
        if (conn) await conn.rollback().catch(() => {});
        handleError(res, e, '[friends/request]');
      } finally {
        if (conn) conn.release();
      }
    } catch (e) {
      handleError(res, e, '[friends/request]');
    }
  });

  // ==================== POST /api/friends/respond ====================
  router.post('/respond', requireAuth, async (req, res) => {
    try {
      const me = req.session.userId;
      const requestId = parseInt(req.body.requestId);
      const action = req.body.action;
      if (!requestId || isNaN(requestId)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      }
      if (!['accept', 'reject'].includes(action)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '操作无效');
      }

      const pool = getPool();

      const [rows] = await pool.query(
        `SELECT * FROM user_friends WHERE id = ? AND status = 'pending'`,
        [requestId]
      );
      if (rows.length === 0) {
        return sendError(res, 404, ErrorCodes.FRIEND_NOT_FOUND, '好友申请不存在');
      }
      const row = rows[0];
      // 只能响应发给自己的申请，否则 FORBIDDEN
      if (row.friend_id !== me) {
        return sendError(res, 403, ErrorCodes.FORBIDDEN, '无权处理该好友申请');
      }

      if (action === 'reject') {
        // P3-53: 仅删除仍处于 pending 的关系——并发 accept 已改 accepted 并写对称行时，
        // 无条件 DELETE 会把主行删掉留下单向悬挂关系；受影响行数为 0 说明状态已变化，返回 409
        const [delResult] = await pool.query(
          `DELETE FROM user_friends WHERE id = ? AND status = 'pending'`,
          [requestId]
        );
        if (delResult.affectedRows === 0) {
          return sendError(res, 409, ErrorCodes.CONFLICT, '该好友申请状态已变化，请刷新后重试');
        }
        return ok(res, { status: 'rejected' });
      }

      // accept → 对称 accepted
      await acceptFriendship(pool, requestId, row.user_id, me);
      if (notificationService) {
        const [meU] = await pool.query(`SELECT display_name FROM users WHERE id = ?`, [me]);
        const myName = meU[0]?.display_name || '用户';
        await notificationService.notifyUser(
          row.user_id, 'friend_accepted', '好友请求已通过',
          `${myName} 接受了你的好友请求`, { targetType: 'user', targetId: me }
        );
      }
      return ok(res, { status: 'accepted' });
    } catch (e) {
      handleError(res, e, '[friends/respond]');
    }
  });

  // ==================== DELETE /api/friends/block/:targetUserId（先于 /:friendUserId 注册） ====================
  router.delete('/block/:targetUserId', requireAuth, async (req, res) => {
    try {
      const me = req.session.userId;
      const targetUserId = parseInt(req.params.targetUserId);
      if (!targetUserId || isNaN(targetUserId)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      }
      const pool = getPool();
      const [r] = await pool.query(
        `DELETE FROM user_friends WHERE user_id = ? AND friend_id = ? AND status = 'blocked'`,
        [me, targetUserId]
      );
      if (r.affectedRows === 0) {
        return sendError(res, 404, ErrorCodes.FRIEND_NOT_FOUND, '未拉黑该用户');
      }
      return ok(res, { ok: true });
    } catch (e) {
      handleError(res, e, '[friends/unblock]');
    }
  });

  // ==================== DELETE /api/friends/:friendUserId ====================
  router.delete('/:friendUserId', requireAuth, async (req, res) => {
    try {
      const me = req.session.userId;
      const otherId = parseInt(req.params.friendUserId);
      if (!otherId || isNaN(otherId)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      }
      const pool = getPool();
      // 双向清除（无论 accepted / pending / blocked 视角），非好友则 404
      const [r] = await pool.query(
        `DELETE FROM user_friends
         WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)`,
        [me, otherId, otherId, me]
      );
      if (r.affectedRows === 0) {
        return sendError(res, 404, ErrorCodes.FRIEND_NOT_FOUND, '好友关系不存在');
      }
      return ok(res, { ok: true });
    } catch (e) {
      handleError(res, e, '[friends/delete]');
    }
  });

  // ==================== POST /api/friends/block ====================
  router.post('/block', requireAuth, async (req, res) => {
    try {
      const me = req.session.userId;
      const targetUserId = parseInt(req.body.targetUserId);
      if (!targetUserId || isNaN(targetUserId)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      }
      if (targetUserId === me) {
        return sendError(res, 400, ErrorCodes.SELF_FRIEND, '不能拉黑自己');
      }
      if (!(await userExists(targetUserId))) {
        return sendError(res, 404, ErrorCodes.NOT_FOUND, '用户不存在');
      }

      const pool = getPool();
      const [existing] = await pool.query(
        `SELECT 1 FROM user_friends WHERE user_id = ? AND friend_id = ? AND status = 'blocked'`,
        [me, targetUserId]
      );
      if (existing.length) {
        return sendError(res, 409, ErrorCodes.ALREADY_BLOCKED, '你已经拉黑了该用户');
      }

      // 同一事务内：upsert 单向 blocked + 清除对称行 + 删除双方关注关系，
      // 保证「拉黑即解除关注/好友」原子生效，避免半途失败留下脏数据。
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await conn.query(
          `INSERT INTO user_friends (user_id, friend_id, status, requested_by)
           VALUES (?, ?, 'blocked', ?)
           ON DUPLICATE KEY UPDATE status = 'blocked', requested_by = VALUES(requested_by), updated_at = CURRENT_TIMESTAMP`,
          [me, targetUserId, me]
        );
        await conn.query(
          `DELETE FROM user_friends WHERE user_id = ? AND friend_id = ?`,
          [targetUserId, me]
        );
        // 拉黑同时解除双向关注
        await conn.query(
          `DELETE FROM user_follows WHERE (follower_id = ? AND following_id = ?) OR (follower_id = ? AND following_id = ?)`,
          [me, targetUserId, targetUserId, me]
        );
        await conn.commit();
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }
      return ok(res, { ok: true });
    } catch (e) {
      handleError(res, e, '[friends/block]');
    }
  });

  // ==================== GET /api/friends?status=accepted（当前用户视角列表） ====================
  router.get('/', requireAuth, async (req, res) => {
    try {
      const me = req.session.userId;
      const status = ['pending', 'accepted', 'blocked'].includes(req.query.status)
        ? req.query.status : 'accepted';
      const pool = getPool();

      const [rows] = await pool.query(
        `SELECT u.id, u.display_name, u.vrchat_name, u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url,
                f.status, f.created_at AS since, f.requested_by AS requestedBy
         FROM user_friends f
         JOIN users u ON u.id = f.friend_id
         WHERE f.user_id = ? AND f.status = ? AND u.deleted_at IS NULL
         ORDER BY f.updated_at DESC`,
        [me, status]
      );
      const list = rows.map(r => ({
        ...toUserSummary(r),
        status: r.status,
        since: r.since,
        requestedBy: r.requestedBy
      }));
      const [[{ total }]] = await pool.query(
        `SELECT COUNT(*) AS total FROM user_friends WHERE user_id = ? AND status = ?`,
        [me, status]
      );
      res.json({ list, total });
    } catch (e) {
      handleError(res, e, '[friends/list]');
    }
  });

  // ==================== GET /api/friends/requests（待处理 incoming/outgoing） ====================
  router.get('/requests', requireAuth, async (req, res) => {
    try {
      const me = req.session.userId;
      const pool = getPool();
      const [incoming] = await pool.query(
        `SELECT u.id, u.display_name, u.vrchat_name, u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url,
                f.id AS requestId, f.created_at AS requestedAt
         FROM user_friends f
         JOIN users u ON u.id = f.user_id
         WHERE f.friend_id = ? AND f.status = 'pending' AND u.deleted_at IS NULL
         ORDER BY f.created_at DESC`,
        [me]
      );
      const [outgoing] = await pool.query(
        `SELECT u.id, u.display_name, u.vrchat_name, u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url,
                f.id AS requestId, f.created_at AS requestedAt
         FROM user_friends f
         JOIN users u ON u.id = f.friend_id
         WHERE f.user_id = ? AND f.status = 'pending' AND u.deleted_at IS NULL
         ORDER BY f.created_at DESC`,
        [me]
      );
      res.json({
        incoming: incoming.map(r => ({
          ...toUserSummary(r), requestId: r.requestId, requestedAt: r.requestedAt
        })),
        outgoing: outgoing.map(r => ({
          ...toUserSummary(r), requestId: r.requestId, requestedAt: r.requestedAt
        }))
      });
    } catch (e) {
      handleError(res, e, '[friends/requests]');
    }
  });

  // ==================== GET /api/friends/status/:userId ====================
  router.get('/status/:userId', requireAuth, async (req, res) => {
    try {
      const me = req.session.userId;
      const target = parseInt(req.params.userId);
      if (!target || isNaN(target)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      }
      const pool = getPool();
      const [mine] = await pool.query(
        `SELECT status FROM user_friends WHERE user_id = ? AND friend_id = ?`,
        [me, target]
      );
      const [theirs] = await pool.query(
        `SELECT status FROM user_friends WHERE user_id = ? AND friend_id = ?`,
        [target, me]
      );
      const myStatus = mine.length ? mine[0].status : null;
      const theirStatus = theirs.length ? theirs[0].status : null;

      let status = 'none';
      let direction = null;
      let blockedByThem = false;
      if (myStatus === 'accepted') {
        status = 'accepted';
      } else if (myStatus === 'pending') {
        status = 'pending'; direction = 'out';
      } else if (myStatus === 'blocked') {
        status = 'blocked'; direction = 'out';
      } else if (theirStatus === 'pending') {
        status = 'pending'; direction = 'in';
      } else if (theirStatus === 'blocked') {
        status = 'blocked'; direction = 'in'; blockedByThem = true;
      }
      res.json({ status, direction, blockedByThem });
    } catch (e) {
      handleError(res, e, '[friends/status]');
    }
  });

  // ==================== F-11 共同好友（本地 user_friends 交集） ====================
  // 批量：当前用户每个「已接受好友」的共同好友数量（一次查询返回 { [friendId]: count }）
  router.get('/mutuals', requireAuth, async (req, res) => {
    try {
      const me = req.session.userId;
      const pool = getPool();
      const [rows] = await pool.query(
        `SELECT f2.user_id AS friendId, COUNT(*) AS mutualCount
         FROM user_friends f1
         JOIN user_friends f2 ON f1.friend_id = f2.friend_id
         WHERE f1.user_id = ? AND f1.status = 'accepted' AND f2.status = 'accepted'
           AND f1.friend_id != ? AND f1.friend_id != f2.user_id
         GROUP BY f2.user_id`,
        [me, me]
      );
      const counts = {};
      rows.forEach(r => { counts[r.friendId] = r.mutualCount; });
      res.json({ counts });
    } catch (e) {
      handleError(res, e, '[friends/mutuals]');
    }
  });

  // ==================== F-12 好友动态 Feed ====================
  // 聚合「已接受好友」近期内容动态（动态/活动报名/相册照片），按时间倒序分页。
  // 纯读聚合现有内容表，无需新增表；可见性沿用各表既有规则：
  //   动态：public / members_only（私密动态不外泄）
  //   活动报名：仅展示报名动作本身（event_sign.sign_time 非空）
  //   相册照片：public / members_only 且未回收
  router.get('/feed', requireAuth, async (req, res) => {
    try {
      const me = req.session.userId;
      const { page, pageSize, offset } = paginate(req, { defaultSize: 20, maxSize: 50 });
      const pool = getPool();

      // 取出已接受好友 id 列表（空则直接返回空 feed，避免 IN () 语法错误）
      const [friends] = await pool.query(
        `SELECT friend_id FROM user_friends WHERE user_id = ? AND status = 'accepted'`,
        [me]
      );
      const ids = friends.map(f => f.friend_id);
      if (!ids.length) {
        return res.json({ items: [], total: 0, page, pageSize });
      }
      const ph = ids.map(() => '?').join(',');

      // 三类动态分别查询（各自 LIMIT 保证足够候选，最终统一排序截断）
      // 1) 动态 posts
      const [posts] = await pool.query(
        `SELECT p.id, p.user_id, p.content, p.type, p.created_at, p.like_count, p.comment_count,
                u.display_name, u.vrchat_name, u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url
         FROM posts p JOIN users u ON u.id = p.user_id
         WHERE p.user_id IN (${ph}) AND p.visibility IN ('public','members_only')
           AND u.deleted_at IS NULL
         ORDER BY p.created_at DESC LIMIT ?`, [...ids, pageSize]
      );
      // 2) 活动报名 event_sign（仅已确认报名）
      const [signs] = await pool.query(
        `SELECT s.id, s.event_id, s.user_vrcid, s.user_name, s.sign_time,
                e.title AS event_title
         FROM event_sign s JOIN event e ON e.id = s.event_id
         WHERE s.user_vrcid IN (
           SELECT vrchat_name FROM users WHERE id IN (${ph}) AND vrchat_name IS NOT NULL AND vrchat_name != ''
         ) AND s.is_sign = 1 AND s.sign_time IS NOT NULL
         ORDER BY s.sign_time DESC LIMIT ?`, pageSize
      );
      // 3) 相册照片 album_photo
      const [photos] = await pool.query(
        `SELECT a.id, a.upload_vrcid, a.upload_name, a.photo_desc, a.photo_path, a.thumb_path,
                a.like_count, a.create_time
         FROM album_photo a
         WHERE a.upload_vrcid IN (
           SELECT vrchat_name FROM users WHERE id IN (${ph}) AND vrchat_name IS NOT NULL AND vrchat_name != ''
         ) AND a.visibility IN ('public','members_only') AND a.is_recycle = 0
         ORDER BY a.create_time DESC LIMIT ?`, pageSize
      );

      // 归一化为统一 feed item
      const items = [];
      posts.forEach(p => {
        items.push({
          kind: 'post',
          id: 'post_' + p.id,
          userId: p.user_id,
          userName: p.display_name || p.vrchat_name || '用户',
          avatarUrl: getAvatarUrl(p) || '/api/avatar/default',
          time: p.created_at,
          content: p.content || '',
          type: p.type,
          likeCount: p.like_count || 0,
          commentCount: p.comment_count || 0
        });
      });
      signs.forEach(s => {
        items.push({
          kind: 'event_sign',
          id: 'sign_' + s.id,
          userName: s.user_name || '用户',
          avatarUrl: '/api/avatar/default',
          time: s.sign_time,
          eventId: s.event_id,
          eventTitle: s.event_title || ''
        });
      });
      photos.forEach(a => {
        items.push({
          kind: 'photo',
          id: 'photo_' + a.id,
          userName: a.upload_name || '用户',
          avatarUrl: '/api/avatar/default',
          time: a.create_time,
          photoPath: a.photo_path,
          thumbPath: a.thumb_path,
          desc: a.photo_desc || '',
          likeCount: a.like_count || 0
        });
      });

      // 统一按时间倒序排序，截断到本页
      items.sort((x, y) => new Date(y.time) - new Date(x.time));
      const total = items.length;
      const pageItems = items.slice(offset, offset + pageSize);

      res.json({ items: pageItems, total, page, pageSize });
    } catch (e) {
      handleError(res, e, '[friends/feed]');
    }
  });

  // ==================== F-13 GET /api/friends/history/:userId ====================
  // 好友变更历史（改名/换头像/上下线/状态/世界），由定时任务写入 friend_log 表
  router.get('/history/:userId', requireAuth, async (req, res) => {
    try {
      const me = req.session.userId;
      const target = parseInt(req.params.userId);
      if (!target || isNaN(target)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      }
      const pool = getPool();

      // 校验 target 是本人或已接受好友，越权直接拒绝
      if (target !== me) {
        const [rel] = await pool.query(
          `SELECT id FROM user_friends WHERE user_id = ? AND friend_id = ? AND status = 'accepted'`,
          [me, target]
        );
        if (!rel.length) {
          return sendError(res, 403, ErrorCodes.FORBIDDEN, '无权查看该用户的好友变更历史');
        }
      }

      // 取目标用户 vrchat_id（好友变更历史以 vrchat_id 为键）
      const [urows] = await pool.query(
        `SELECT vrchat_name FROM users WHERE id = ? AND deleted_at IS NULL`, [target]
      );
      if (!urows.length || !urows[0].vrchat_name) {
        return res.json({ items: [], total: 0 });
      }
      const vrcid = urows[0].vrchat_name;

      const { page, pageSize, offset } = paginate(req, { defaultSize: 30, maxSize: 100 });

      const [cntRows] = await pool.query(
        `SELECT COUNT(*) AS c FROM friend_log WHERE vrchat_id = ?`, [vrcid]
      );
      const total = cntRows[0].c || 0;

      const [items] = await pool.query(
        `SELECT id, change_type, old_value, new_value, created_at
         FROM friend_log WHERE vrchat_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ? OFFSET ?`,
        [vrcid, pageSize, offset]
      );

      res.json({
        items: items.map(r => ({
          id: r.id,
          type: r.change_type,
          oldValue: r.old_value,
          newValue: r.new_value,
          time: r.created_at
        })),
        total, page, pageSize
      });
    } catch (e) {
      handleError(res, e, '[friends/history]');
    }
  });

  // ==================== F-14 GET /api/friends/world-history/:userId ====================
  // 世界访问足迹（进入过的世界 + 访问次数 + 首次/最近访问时间），由定时任务写入 world_visit_log 表。
  router.get('/world-history/:userId', requireAuth, async (req, res) => {
    try {
      const me = req.session.userId;
      const target = parseInt(req.params.userId);
      if (!target || isNaN(target)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      }
      const pool = getPool();

      // 校验 target 是本人或已接受好友（与 F-13 历史接口一致）
      if (target !== me) {
        const [rel] = await pool.query(
          `SELECT id FROM user_friends WHERE user_id = ? AND friend_id = ? AND status = 'accepted'`,
          [me, target]
        );
        if (!rel.length) {
          return sendError(res, 403, ErrorCodes.FORBIDDEN, '无权查看该用户的足迹');
        }
      }

      // 取目标用户 vrchat_id（世界访问历史以 vrchat_id 为键）
      const [urows] = await pool.query(
        `SELECT vrchat_name FROM users WHERE id = ? AND deleted_at IS NULL`, [target]
      );
      if (!urows.length || !urows[0].vrchat_name) {
        return res.json({ items: [], total: 0 });
      }
      const vrcid = urows[0].vrchat_name;

      // 足迹聚合：按 world_id 去重，返回访问次数与首次/最近访问时间，按最近访问倒序
      const [items] = await pool.query(
        `SELECT world_id, world_name, visit_count, first_visit_at, last_visit_at
         FROM world_visit_log WHERE vrchat_id = ?
         ORDER BY last_visit_at DESC, visit_count DESC
         LIMIT 100`,
        [vrcid]
      );

      const [cntRows] = await pool.query(
        `SELECT COUNT(*) AS c, COALESCE(SUM(visit_count),0) AS visits FROM world_visit_log WHERE vrchat_id = ?`,
        [vrcid]
      );

      res.json({
        items: items.map(r => ({
          worldId: r.world_id,
          worldName: r.world_name,
          visitCount: r.visit_count,
          firstVisitAt: r.first_visit_at,
          lastVisitAt: r.last_visit_at
        })),
        totalWorlds: cntRows[0].c || 0,
        totalVisits: cntRows[0].visits || 0
      });
    } catch (e) {
      handleError(res, e, '[friends/world-history]');
    }
  });

  // ==================== F-16 GET /api/friends/avatar-history/:userId ====================
  // 头像使用历史（使用过的头像 + 使用次数 + 首次/最近使用时间 + 最近观测缩略图），由定时任务写入 avatar_history_log 表。
  router.get('/avatar-history/:userId', requireAuth, async (req, res) => {
    try {
      const me = req.session.userId;
      const target = parseInt(req.params.userId);
      if (!target || isNaN(target)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      }
      const pool = getPool();

      // 校验 target 是本人或已接受好友（与 F-13/F-14 历史接口一致）
      if (target !== me) {
        const [rel] = await pool.query(
          `SELECT id FROM user_friends WHERE user_id = ? AND friend_id = ? AND status = 'accepted'`,
          [me, target]
        );
        if (!rel.length) {
          return sendError(res, 403, ErrorCodes.FORBIDDEN, '无权查看该用户的头像历史');
        }
      }

      // 取目标用户 vrchat_id（头像历史以 vrchat_id 为键）
      const [urows] = await pool.query(
        `SELECT vrchat_name FROM users WHERE id = ? AND deleted_at IS NULL`, [target]
      );
      if (!urows.length || !urows[0].vrchat_name) {
        return res.json({ items: [], total: 0 });
      }
      const vrcid = urows[0].vrchat_name;

      // 头像历史聚合：按 avatar_id 去重，返回使用次数与首次/最近使用时间，按最近使用倒序
      const [items] = await pool.query(
        `SELECT avatar_id, avatar_url, use_count, first_seen_at, last_seen_at
         FROM avatar_history_log WHERE vrchat_id = ?
         ORDER BY last_seen_at DESC, use_count DESC
         LIMIT 100`,
        [vrcid]
      );

      const [cntRows] = await pool.query(
        `SELECT COUNT(*) AS c, COALESCE(SUM(use_count),0) AS uses FROM avatar_history_log WHERE vrchat_id = ?`,
        [vrcid]
      );

      res.json({
        items: items.map(r => ({
          avatarId: r.avatar_id,
          avatarUrl: r.avatar_url,
          useCount: r.use_count,
          firstSeenAt: r.first_seen_at,
          lastSeenAt: r.last_seen_at
        })),
        totalAvatars: cntRows[0].c || 0,
        totalUses: cntRows[0].uses || 0
      });
    } catch (e) {
      handleError(res, e, '[friends/avatar-history]');
    }
  });

  // ==================== F-21 GET /api/friends/activity-sessions/:userId ====================
  // 在线活动时间轴：会话明细（开始/结束/时长/所在世界）+ 按天在线分钟聚合，
  // 由定时任务（schedule.js F-21 在线会话采样）写入 activity_sessions 表。
  // days 参数（默认 30，上限 90）限定时间范围；进行中会话始终返回（便于「当前在线」展示）。
  router.get('/activity-sessions/:userId', requireAuth, async (req, res) => {
    try {
      const me = req.session.userId;
      const target = parseInt(req.params.userId);
      if (!target || isNaN(target)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      }
      const days = Math.min(parseInt(req.query.days) || 30, 90);
      const pool = getPool();

      // 校验 target 是本人或已接受好友（与 F-13/F-14/F-16 历史接口一致，防社交图枚举）
      if (target !== me) {
        const [rel] = await pool.query(
          `SELECT id FROM user_friends WHERE user_id = ? AND friend_id = ? AND status = 'accepted'`,
          [me, target]
        );
        if (!rel.length) {
          return sendError(res, 403, ErrorCodes.FORBIDDEN, '无权查看该用户的在线活动');
        }
      }

      // 取目标用户 vrchat_id（会话以 vrchat_id 为键）
      const [urows] = await pool.query(
        `SELECT vrchat_name FROM users WHERE id = ? AND deleted_at IS NULL`, [target]
      );
      if (!urows.length || !urows[0].vrchat_name) {
        return res.json({ items: [], daily: [], totalMinutes: 0, onlineNow: false });
      }
      const vrcid = urows[0].vrchat_name;

      // 会话明细：时间范围内已封口会话 + 全部进行中会话（进行中即使 started_at 在范围外也返回）
      const [items] = await pool.query(
        `SELECT id, vrchat_id, started_at, ended_at, duration_minutes, world_id, world_name
         FROM activity_sessions WHERE vrchat_id = ?
         AND (started_at >= NOW() - INTERVAL ? DAY OR ended_at IS NULL)
         ORDER BY started_at DESC
         LIMIT 500`,
        [vrcid, days]
      );

      // 按天聚合在线分钟数（进行中会话按已持续分钟计入当天）
      const [dailyRows] = await pool.query(
        `SELECT DATE(started_at) AS day,
           SUM(CASE WHEN ended_at IS NOT NULL THEN duration_minutes
                    ELSE TIMESTAMPDIFF(MINUTE, started_at, NOW()) END) AS minutes
         FROM activity_sessions WHERE vrchat_id = ? AND started_at >= NOW() - INTERVAL ? DAY
         GROUP BY DATE(started_at) ORDER BY day DESC`,
        [vrcid, days]
      );

      // 当前是否在线（存在进行中会话）
      const [nowRows] = await pool.query(
        `SELECT id FROM activity_sessions WHERE vrchat_id = ? AND ended_at IS NULL LIMIT 1`,
        [vrcid]
      );

      res.json({
        items: items.map(r => ({
          id: r.id,
          startedAt: r.started_at,
          endedAt: r.ended_at,
          durationMinutes: r.duration_minutes,
          worldId: r.world_id,
          worldName: r.world_name,
          ongoing: !r.ended_at
        })),
        daily: dailyRows.map(r => ({
          day: r.day,
          minutes: Math.max(0, Math.round(r.minutes || 0))
        })),
        totalMinutes: Math.max(0, Math.round(dailyRows.reduce((s, r) => s + (r.minutes || 0), 0))),
        onlineNow: nowRows.length > 0
      });
    } catch (e) {
      handleError(res, e, '[friends/activity-sessions]');
    }
  });

  // 指定好友的共同好友列表（点开详情）
  router.get('/mutuals/:targetUserId', requireAuth, async (req, res) => {
    try {
      const me = req.session.userId;
      const target = parseInt(req.params.targetUserId);
      if (!target || isNaN(target) || target === me) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      }
      const pool = getPool();

      // 校验 target 必须是本人或已接受好友，否则拒绝（与 F-13 history 一致，防社交图枚举）
      if (target !== me) {
        const [rel] = await pool.query(
          `SELECT id FROM user_friends WHERE user_id = ? AND friend_id = ? AND status = 'accepted'`,
          [me, target]
        );
        if (!rel.length) {
          return sendError(res, 403, ErrorCodes.FORBIDDEN, '无权查看该用户的共同好友');
        }
      }

      const [rows] = await pool.query(
        `SELECT u.id, u.display_name, u.vrchat_name, u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url
         FROM user_friends f1
         JOIN user_friends f2 ON f1.friend_id = f2.friend_id
         JOIN users u ON u.id = f1.friend_id
         WHERE f1.user_id = ? AND f2.user_id = ? AND f1.status = 'accepted' AND f2.status = 'accepted'
           AND u.deleted_at IS NULL AND f1.friend_id != ? AND f1.friend_id != f2.user_id
         ORDER BY u.display_name`,
        [me, target, me]
      );
      res.json({
        targetId: target,
        count: rows.length,
        mutualFriends: rows.map(r => toUserSummary(r))
      });
    } catch (e) {
      handleError(res, e, '[friends/mutuals/target]');
    }
  });

  return router;
};
