/**
 * 境途同游 V6.14 — 群组邀请管理路由
 * 批量邀请 / 邀请列表 / 接受 / 拒绝 / 我的邀请
 *
 * P2-66：自 groups.js 按域拆出（原 L1403–1530），行为逐字保留。
 *
 * @swagger
 * tags:
 *   name: GroupsInvites
 *   description: 群组邀请批量管理接口
 */
const express = require('express');
const { ok, getPool, handleError, sendError, ErrorCodes, logOper } = require('../utils');
const { requireAuth, requireAdminCompat } = require('../auth');
const { vrchatRequest, VRC_API_KEY } = require('../vrc');
const { sleep } = require('./groups_helpers');

module.exports = function (getVRCCookieFn, GROUP_ID, getUserVRCCookieFn) {
  const router = express.Router();

  // ==================== 批量邀请功能 ====================
  router.post('/group/invites/batch', requireAdminCompat, async (req, res) => {
    try {
      const { vrchatIds, message } = req.body;
      if (!Array.isArray(vrchatIds) || vrchatIds.length === 0) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '缺少VRChat ID列表');
      
      const vrcCookie = getVRCCookieFn(req);
      if (!vrcCookie) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, 'VRChat系统账号未登录');
      
      const inviterId = req.session.userId;
      const inviterName = req.session.displayName || '管理员';
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const results = [];
      
      for (const vrchatId of vrchatIds.slice(0, 100)) {
          await sleep(200);
        try {
          const [existingMember] = await getPool().query(`SELECT id FROM group_roster WHERE vrchat_id=? AND is_member=1`, [vrchatId]);
          if (existingMember.length > 0) {
            results.push({ vrchatId, status: 'already_member', message: '已是群成员' });
            continue;
          }
          
          const [existingInvite] = await getPool().query(`SELECT id FROM group_invites WHERE vrchat_id=? AND status='pending'`, [vrchatId]);
          if (existingInvite.length > 0) {
            results.push({ vrchatId, status: 'pending_invite', message: '已有待处理邀请' });
            continue;
          }
          
          const userRes = await vrchatRequest('GET', `/users/${vrchatId}?apiKey=${VRC_API_KEY}`, null, vrcCookie);
          const vrchatName = userRes.status === 200 ? userRes.data.displayName || '' : '';
          
          await getPool().query(
            'INSERT INTO group_invites (vrchat_id, vrchat_name, inviter_id, inviter_name, status, message, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [vrchatId, vrchatName, inviterId, inviterName, 'pending', message || '', expiresAt]
          );
          
          results.push({ vrchatId, status: 'invited', message: '邀请已发送' });
        } catch (e) {
          results.push({ vrchatId, status: 'error', message: e.message });
        }
      }
      
      await logOper(req.session.userId, '批量邀请', `邀请人数: ${vrchatIds.length}`);
      ok(res, { results });
    } catch (e) { handleError(res, e, 'groups/batch-invite'); }
  });

  router.get('/group/invites', requireAdminCompat, async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const pageSize = parseInt(req.query.pageSize) || 20;
      const offset = (page - 1) * pageSize;
      const statusFilter = req.query.status ? req.query.status.trim() : '';
      
      let where = '1=1';
      const params = [];
      if (statusFilter) {
        where += ' AND status = ?';
        params.push(statusFilter);
      }
      params.push(pageSize, offset);
      
      const [rows] = await getPool().query(
        `SELECT id, vrchat_id AS vrchatId, vrchat_name AS vrchatName, inviter_id AS inviterId, inviter_name AS inviterName, status, message, expires_at AS expiresAt, created_at AS createdAt, responded_at AS respondedAt FROM group_invites WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        params
      );
      const [count] = await getPool().query(`SELECT COUNT(*) as total FROM group_invites WHERE ${where}`, params.slice(0, -2));
      
      res.json({ invites: rows, total: count[0].total, page, pageSize });
    } catch (e) { handleError(res, e, 'groups/invites-list'); }
  });

  router.post('/group/invites/:id/accept', async (req, res) => {
    try {
      const uid = req.session?.userId;
      if (!uid) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, '请先登录');
      
      const [invite] = await getPool().query(`SELECT * FROM group_invites WHERE id = ? AND status = 'pending' AND expires_at > NOW()`, [req.params.id]);
      if (invite.length === 0) return sendError(res, 404, ErrorCodes.NOT_FOUND, '邀请不存在或已过期');
      
      const vrcId = req.session.vrchat_id;
      if (!vrcId || vrcId !== invite[0].vrchat_id) return sendError(res, 403, ErrorCodes.FORBIDDEN, '无权接受此邀请');
      
      await getPool().query(`UPDATE group_invites SET status = 'accepted', responded_at = NOW() WHERE id = ?`, [req.params.id]);
      
      await getPool().query(
        `INSERT IGNORE INTO group_roster (vrchat_id, vrchat_name, is_member, joined_at) VALUES (?, ?, 1, NOW())`,
        [invite[0].vrchat_id, invite[0].vrchat_name]
      );
      
      ok(res);
    } catch (e) { handleError(res, e, 'groups/invite-accept'); }
  });

  router.post('/group/invites/:id/reject', async (req, res) => {
    try {
      const uid = req.session?.userId;
      if (!uid) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, '请先登录');
      
      const [invite] = await getPool().query(`SELECT * FROM group_invites WHERE id = ? AND status = 'pending' AND expires_at > NOW()`, [req.params.id]);
      if (invite.length === 0) return sendError(res, 404, ErrorCodes.NOT_FOUND, '邀请不存在或已过期');
      
      const vrcId = req.session.vrchat_id;
      if (!vrcId || vrcId !== invite[0].vrchat_id) return sendError(res, 403, ErrorCodes.FORBIDDEN, '无权拒绝此邀请');
      
      await getPool().query(`UPDATE group_invites SET status = 'rejected', responded_at = NOW() WHERE id = ?`, [req.params.id]);
      ok(res);
    } catch (e) { handleError(res, e, 'groups/invite-reject'); }
  });

  router.get('/group/invites/my', requireAuth, async (req, res) => {
    try {
      const uid = req.session?.userId;
      if (!uid) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, '请先登录');

      const vrcId = req.session.vrchat_id;
      if (!vrcId) return res.json({ invites: [] });

      const [rows] = await getPool().query(
        `SELECT id, vrchat_id AS vrchatId, vrchat_name AS vrchatName, inviter_id AS inviterId, inviter_name AS inviterName, status, message, expires_at AS expiresAt, created_at AS createdAt FROM group_invites WHERE vrchat_id = ? AND status = 'pending' ORDER BY created_at DESC`,
        [vrcId]
      );

      res.json({ invites: rows });
    } catch (e) { handleError(res, e, 'groups/my-invites'); }
  });

  return router;
};
