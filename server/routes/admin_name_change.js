/**
 * 境途同游 — VRChat 改名系统路由（P2-4 第三批：自 admin.js 按域拆出）
 * 行为逐字保留：用户自助申请改名（requireAuth）+ 管理员审核（requireAdminCompat）。
 */
const express = require('express');
const { ok, getPool, handleError, logOper, sendError, ErrorCodes } = require('../utils');
const { requireAuth, requireAdminCompat } = require('../auth');

module.exports = function createAdminNameChangeRouter() {
  const router = express.Router();

  // ==================== VRChat 改名系统 ====================
  router.post('/name-change/request', requireAuth, async (req, res) => {
    try {
      const { newName, reason } = req.body;
      if (!newName || !newName.trim()) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请输入新显示名');
      const newNameTrim = newName.trim();
      if (newNameTrim.length > 50) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '显示名不能超过50字');
      // 控制字符黑名单是显示名校验的本意，no-control-regex 在此为误报
      // eslint-disable-next-line no-control-regex
      if (/[<>\u0000-\u001f\u007f]/.test(newNameTrim)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '显示名包含不允许的字符');
      }
      const [existing] = await getPool().query(`SELECT id FROM users WHERE display_name=?`, [newNameTrim]);
      if (existing.length > 0) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '该显示名已被使用');
      // P3-118：并发去重竞态——事务内对「该用户待审申请」行加锁后再判定/插入，
      // 使同用户并发提交串行通过（MySQL FOR UPDATE；SQLite 下 transformSQL 剥离但靠 BEGIN 写锁双保险）
      const conn = await getPool().getConnection();
      try {
        await conn.beginTransaction();
        const [pendings] = await conn.query(
          `SELECT id FROM name_change_requests WHERE user_id=? AND status='pending' FOR UPDATE`,
          [req.session.userId]
        );
        if (pendings.length > 0) {
          await conn.rollback();
          return sendError(res, 400, ErrorCodes.BAD_REQUEST, '您已有待审核的改名申请');
        }
        await conn.query(`INSERT INTO name_change_requests (user_id, old_name, new_name, reason) VALUES (?, ?, ?, ?)`,
          [req.session.userId, req.session.displayName || '用户', newNameTrim, reason ? String(reason).slice(0, 500) : null]);
        await conn.commit();
      } catch (e) {
        await conn.rollback();
        throw e;
      } finally {
        conn.release();
      }
      await logOper(req.session.userId, '提交改名申请', `${req.session.displayName} → ${newNameTrim}`);
      ok(res, { message: '改名申请已提交，等待管理员审核' });
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
      if (action === 'approve') {
        // P3-118：申请→审核之间该名字可能已被他人抢注/含非法字符，逐项复查后再落库，
        // 失败则拒绝申请并留痕，避免覆盖他人显示名造成撞名
        const nm = String(reqs[0].new_name || '').trim();
        // eslint-disable-next-line no-control-regex
        if (!nm || nm.length > 50 || /[<>\u0000-\u001f\u007f]/.test(nm)) {
          await getPool().query(
            `UPDATE name_change_requests SET status='rejected', reviewed_by=?, review_comment=?, review_time=NOW() WHERE id=? AND status='pending'`,
            [reviewerId, '目标显示名不合法（超长或含非法字符），已拒绝', id]
          );
          return sendError(res, 400, ErrorCodes.BAD_REQUEST, '目标显示名不合法，已拒绝该申请');
        }
        const [occupied] = await getPool().query(`SELECT id FROM users WHERE display_name=? AND id<>?`, [nm, reqs[0].user_id]);
        if (occupied.length > 0) {
          await getPool().query(
            `UPDATE name_change_requests SET status='rejected', reviewed_by=?, review_comment=?, review_time=NOW() WHERE id=? AND status='pending'`,
            [reviewerId, '目标显示名已被他人占用，已拒绝', id]
          );
          return sendError(res, 409, ErrorCodes.CONFLICT, '目标显示名已被占用，已拒绝该申请');
        }
        await getPool().query(`UPDATE users SET display_name=? WHERE id=?`, [nm, reqs[0].user_id]);
        await getPool().query(`UPDATE name_change_requests SET status='approved', reviewed_by=?, review_comment=?, review_time=NOW() WHERE id=? AND status='pending'`, [reviewerId, comment || null, id]);
        await logOper(reviewerId, '通过改名', `${reqs[0].old_name} → ${nm}`);
      } else {
        await getPool().query(`UPDATE name_change_requests SET status='rejected', reviewed_by=?, review_comment=?, review_time=NOW() WHERE id=? AND status='pending'`, [reviewerId, comment || null, id]);
        await logOper(reviewerId, '拒绝改名', `${reqs[0].old_name} → ${reqs[0].new_name}: ${comment || ''}`);
      }
      ok(res);
    } catch (e) { handleError(res, e, '[admin/name-change/review]'); }
  });

  return router;
};
