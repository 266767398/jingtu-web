/**
 * 境途同游 — 玩家/头像审核（F-18）
 * 提交举报 + 管理员审核队列 + 通过/驳回。
 * 「通过」时按 target_type 执行远程 VRChat 动作：
 *   - player：屏蔽（block）+ 静音（mute）目标玩家（需管理员本人绑定 VRChat）
 *   - avatar：头像下架无 VRChat 官方写接口，仅站内本地落库
 * 远程动作全部 graceful：未绑定 / 目标无 VRChat ID / 远程失败 均不阻断本地审核落库。
 */
const express = require('express');
const {
  requireAuth, requireRole
} = require('../auth');
const { ok, getPool, logOper, handleError, sendError, ErrorCodes } = require('../utils');
const {
  vrchatBlockUser, vrchatMuteUser
} = require('../vrc');

const TARGET_TYPES = ['avatar', 'player'];
const RESOLUTIONS = ['approve', 'reject'];

/**
 * 执行远程 VRChat 审核动作（approve 时）。
 * @param {object} item - moderations 行（含 target_user_id / target_type）
 * @param {object} req - 请求（用于 getVRCCookieUserOnly 取管理员本人 Cookie）
 * @param {Function} getVRCCookieUserOnly - 仅取当前登录用户自己绑定的 VRChat cookie
 * @returns {Promise<object>} { targetType, remote, note }
 */
async function applyRemoteModeration(item, req, getVRCCookieUserOnly) {
  const result = { targetType: item.target_type, remote: null, note: '' };

  // 头像下架：VRChat 无「隐藏他人头像」官方写接口，仅站内处理
  if (item.target_type === 'avatar') {
    result.note = '头像审核为站内本地处理（VRChat 无对应写接口）';
    return result;
  }

  // 玩家封禁：查目标 VRChat ID + 管理员本人 Cookie
  const [targetRows] = await getPool().query(
    'SELECT id, vrchat_id FROM users WHERE id = ?',
    [item.target_user_id]
  );
  const vrchatId = targetRows[0] && targetRows[0].vrchat_id;
  if (!vrchatId) {
    result.note = '目标未绑定 VRChat 账号，跳过远程屏蔽/静音';
    return result;
  }
  const cookie = (typeof getVRCCookieUserOnly === 'function') ? getVRCCookieUserOnly(req) : null;
  if (!cookie) {
    result.note = '当前管理员未绑定 VRChat 账号，跳过远程屏蔽/静音';
    return result;
  }

  result.remote = { block: null, mute: null };
  try {
    const block = await vrchatBlockUser(vrchatId, cookie);
    result.remote.block = block.status;
  } catch (e) {
    result.remote.block = 'error:' + (e.message || 'unknown');
  }
  try {
    const mute = await vrchatMuteUser(vrchatId, cookie);
    result.remote.mute = mute.status;
  } catch (e) {
    result.remote.mute = 'error:' + (e.message || 'unknown');
  }
  return result;
}

module.exports = (getVRCCookieUserOnly) => {
  const router = express.Router();

  // ==================== 提交举报 ====================
  router.post('/', requireAuth, async (req, res) => {
    try {
      const { targetType, targetUserId, reason } = req.body;
      if (!TARGET_TYPES.includes(targetType)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'targetType 必须是 avatar 或 player');
      }
      const targetId = parseInt(targetUserId);
      if (!targetId || targetId <= 0) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '目标用户 ID 无效');
      }
      if (!reason || !reason.trim()) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '举报理由不能为空');
      }
      if (reason.length > 500) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '举报理由不能超过500字');
      }
      if (targetId === req.session.userId) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '不能举报自己');
      }
      // 同一举报人对同一目标的同类待处理举报去重，避免刷屏
      const [dup] = await getPool().query(
        'SELECT id FROM moderations WHERE reporter_id = ? AND target_user_id = ? AND target_type = ? AND status = ?',
        [req.session.userId, targetId, targetType, 'pending']
      );
      if (dup.length > 0) {
        return sendError(res, 409, ErrorCodes.CONFLICT, '你已经举报过该目标，等待审核中');
      }
      await getPool().query(
        'INSERT INTO moderations (reporter_id, target_user_id, target_type, reason, status, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
        [req.session.userId, targetId, targetType, reason.trim(), 'pending']
      );
      await logOper(req.session.userId, '提交审核举报', `目标用户: ${targetId}, 类型: ${targetType}`);
      ok(res);
    } catch (e) { handleError(res, e, '[moderations/submit]'); }
  });

  // ==================== 管理员：审核队列 ====================
  router.get('/', requireRole('admin'), async (req, res) => {
    try {
      const status = req.query.status || 'pending';
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const pageSize = Math.min(50, parseInt(req.query.pageSize) || 20);
      const offset = (page - 1) * pageSize;
      const where = [];
      const params = [];
      if (['pending', 'approved', 'rejected'].includes(status)) {
        where.push('m.status = ?');
        params.push(status);
      }
      const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const [rows] = await getPool().query(
        `SELECT m.id, m.target_type, m.reason, m.status, m.created_at, m.resolved_at, m.resolution_note,
                r.display_name AS reporter_name, t.display_name AS target_name
         FROM moderations m
         LEFT JOIN users r ON r.id = m.reporter_id
         LEFT JOIN users t ON t.id = m.target_user_id
         ${whereSql}
         ORDER BY m.created_at DESC
         LIMIT ? OFFSET ?`,
        [...params, pageSize, offset]
      );
      const [cnt] = await getPool().query(
        `SELECT COUNT(*) AS c FROM moderations m ${whereSql}`,
        params
      );
      res.json({
        items: rows.map(r => ({
          id: r.id,
          targetType: r.target_type,
          reason: r.reason,
          status: r.status,
          reporterName: r.reporter_name || '',
          targetName: r.target_name || '',
          resolutionNote: r.resolution_note || '',
          createdAt: r.created_at,
          resolvedAt: r.resolved_at
        })),
        total: cnt[0].c,
        page,
        pageSize
      });
    } catch (e) { handleError(res, e, '[moderations/list]'); }
  });

  // ==================== 管理员：通过/驳回 ====================
  router.post('/:id/resolve', requireRole('admin'), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { action, note } = req.body;
      if (!RESOLUTIONS.includes(action)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'action 必须是 approve 或 reject');
      }
      const [rows] = await getPool().query(
        'SELECT id, target_user_id, target_type, status FROM moderations WHERE id = ?',
        [id]
      );
      if (rows.length === 0) {
        return sendError(res, 404, ErrorCodes.NOT_FOUND, '审核项不存在');
      }
      if (rows[0].status !== 'pending') {
        return sendError(res, 409, ErrorCodes.CONFLICT, '该审核项已处理');
      }
      const status = action === 'approve' ? 'approved' : 'rejected';
      await getPool().query(
        'UPDATE moderations SET status = ?, resolved_by = ?, resolved_at = NOW(), resolution_note = ? WHERE id = ?',
        [status, req.session.userId, (note || '').slice(0, 500), id]
      );
      await logOper(req.session.userId, '处理审核举报', `审核项: ${id}, 结果: ${status}`);

      // F-18 远程动作：approve 时按 target_type 执行远程 VRChat 屏蔽/静音（graceful）
      let remote = null;
      if (status === 'approved') {
        const applied = await applyRemoteModeration(rows[0], req, getVRCCookieUserOnly);
        remote = applied.remote;
        if (applied.note) {
          await logOper(req.session.userId, '审核远程动作', `审核项: ${id}, ${applied.note}`);
        }
        if (applied.remote) {
          await logOper(req.session.userId, '审核远程动作', `审核项: ${id}, remote: ${JSON.stringify(applied.remote)}`);
        }
      }

      ok(res, {status, remote});
    } catch (e) { handleError(res, e, '[moderations/resolve]'); }
  });

  return router;
};
