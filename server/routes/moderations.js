/**
 * 境途同游 — 玩家/头像审核（F-18）
 * 提交举报 + 管理员审核队列 + 通过/驳回 + 撤销远程屏蔽/静音。
 * 「通过」时按 target_type 执行远程 VRChat 动作：
 *   - player：屏蔽（block）+ 静音（mute）目标玩家（需管理员本人绑定 VRChat）
 *   - avatar：头像下架无 VRChat 官方写接口，仅站内本地落库
 * 远程动作全部 graceful：未绑定 / 目标无 VRChat ID / 远程失败 均不阻断本地审核落库。
 * 远程结果写入 moderations.remote_result，已通过项可再次撤销（unblock/unmute）。
 */
const express = require('express');
const {
  requireAuth, requireRole
} = require('../auth');
const { ok, getPool, logOper, handleError, sendError, ErrorCodes, paginate } = require('../utils');
const {
  vrchatBlockUser, vrchatMuteUser, vrchatUnblockUser, vrchatUnmuteUser
} = require('../vrc');

const TARGET_TYPES = ['avatar', 'player'];
const RESOLUTIONS = ['approve', 'reject'];

/**
 * 执行远程 VRChat 审核动作（approve 时）。
 * @param {object} item - moderations 行（含 target_user_id / target_type）
 * @param {object} req - 请求（用于 getVRCCookieUserOnly 取管理员本人 Cookie）
 * @param {Function} getVRCCookieUserOnly - 仅取当前登录用户自己绑定的 VRChat cookie
 * @returns {Promise<object>} { targetType, remote, note, remoteResult }
 *   remoteResult 为 JSON 字符串，供 resolve 写入 moderations.remote_result
 */
async function applyRemoteModeration(item, req, getVRCCookieUserOnly) {
  const result = { targetType: item.target_type, remote: null, note: '', remoteResult: '' };

  // 头像下架：VRChat 无「隐藏他人头像」官方写接口，仅站内处理
  if (item.target_type === 'avatar') {
    result.note = '头像审核为站内本地处理（VRChat 无对应写接口）';
    result.remoteResult = JSON.stringify({ applied: false, reason: 'avatar-local' });
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
    result.remoteResult = JSON.stringify({ applied: false, reason: 'no-vrchat-id' });
    return result;
  }
  const cookie = (typeof getVRCCookieUserOnly === 'function') ? getVRCCookieUserOnly(req) : null;
  if (!cookie) {
    result.note = '当前管理员未绑定 VRChat 账号，跳过远程屏蔽/静音';
    result.remoteResult = JSON.stringify({ applied: false, reason: 'no-admin-cookie' });
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
  result.remoteResult = JSON.stringify({ applied: true, block: result.remote.block, mute: result.remote.mute });
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
      const { page, pageSize, offset } = paginate(req, { defaultSize: 20, maxSize: 50 });
      const where = [];
      const params = [];
      if (['pending', 'approved', 'rejected'].includes(status)) {
        where.push('m.status = ?');
        params.push(status);
      }
      const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const [rows] = await getPool().query(
        `SELECT m.id, m.target_type, m.reason, m.status, m.created_at, m.resolved_at, m.resolution_note, m.remote_result,
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
          remoteResult: r.remote_result || '',
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
      const status = action === 'approve' ? 'approved' : 'rejected';
      // P3-121：状态翻转改为条件更新「WHERE status='pending'」，以 affectedRows 判定
      // 处理权——两个管理员并发处理同一审核项时，仅一个能翻转成功，另者得到 0 → 409，
      // 不再出现双方都通过检查并各自执行远程 block/mute 的竞态
      const [upd] = await getPool().query(
        'UPDATE moderations SET status = ?, resolved_by = ?, resolved_at = NOW(), resolution_note = ? WHERE id = ? AND status = ?',
        [status, req.session.userId, (note || '').slice(0, 500), id, 'pending']
      );
      if (upd.affectedRows === 0) {
        return sendError(res, 409, ErrorCodes.CONFLICT, '该审核项已处理');
      }
      await logOper(req.session.userId, '处理审核举报', `审核项: ${id}, 结果: ${status}`);

      // F-18 远程动作：approve 时按 target_type 执行远程 VRChat 屏蔽/静音（graceful）
      let remote = null;
      if (status === 'approved') {
        const applied = await applyRemoteModeration(rows[0], req, getVRCCookieUserOnly);
        remote = applied.remote;
        // 远程结果落库，供审核队列回显 block/mute 状态、支持后续撤销
        await getPool().query(
          'UPDATE moderations SET remote_result = ? WHERE id = ?',
          [applied.remoteResult || '', id]
        );
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

  // ==================== 管理员：撤销远程屏蔽/静音（unblock/unmute） ====================
  router.post('/:id/revert', requireRole('admin'), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const [rows] = await getPool().query(
        'SELECT id, target_user_id, target_type, status, remote_result FROM moderations WHERE id = ?',
        [id]
      );
      if (rows.length === 0) {
        return sendError(res, 404, ErrorCodes.NOT_FOUND, '审核项不存在');
      }
      const item = rows[0];
      if (item.status !== 'approved') {
        return sendError(res, 409, ErrorCodes.CONFLICT, '仅已通过的审核项可撤销远程动作');
      }
      const prevResult = (() => {
        try { return JSON.parse(item.remote_result || '{}') || {}; } catch (e) { return {}; }
      })();

      // 头像审核无远程动作，仅标记已撤销
      if (item.target_type === 'avatar') {
        prevResult.revoked = true;
        prevResult.revokeNote = '头像审核为站内处理，无远程动作可撤销';
        await getPool().query(
          'UPDATE moderations SET remote_result = ? WHERE id = ?',
          [JSON.stringify(prevResult), id]
        );
        await logOper(req.session.userId, '撤销审核远程动作', `审核项: ${id}, 头像无远程动作`);
        return ok(res, { remote: null, revoked: true });
      }

      // 玩家：查目标 VRChat ID + 管理员本人 Cookie
      const [targetRows] = await getPool().query(
        'SELECT id, vrchat_id FROM users WHERE id = ?',
        [item.target_user_id]
      );
      const vrchatId = targetRows[0] && targetRows[0].vrchat_id;
      const cookie = (typeof getVRCCookieUserOnly === 'function') ? getVRCCookieUserOnly(req) : null;

      const remote = { unblock: null, unmute: null };
      if (!vrchatId) {
        remote.unblock = 'skipped:no-vrchat-id';
        remote.unmute = 'skipped:no-vrchat-id';
      } else if (!cookie) {
        remote.unblock = 'skipped:no-admin-cookie';
        remote.unmute = 'skipped:no-admin-cookie';
      } else {
        try {
          const unblock = await vrchatUnblockUser(vrchatId, cookie);
          remote.unblock = unblock.status;
        } catch (e) {
          remote.unblock = 'error:' + (e.message || 'unknown');
        }
        try {
          const unmute = await vrchatUnmuteUser(vrchatId, cookie);
          remote.unmute = unmute.status;
        } catch (e) {
          remote.unmute = 'error:' + (e.message || 'unknown');
        }
      }

      prevResult.revoked = true;
      prevResult.unblock = remote.unblock;
      prevResult.unmute = remote.unmute;
      await getPool().query(
        'UPDATE moderations SET remote_result = ? WHERE id = ?',
        [JSON.stringify(prevResult), id]
      );
      await logOper(req.session.userId, '撤销审核远程动作', `审核项: ${id}, remote: ${JSON.stringify(remote)}`);
      ok(res, { remote, revoked: true });
    } catch (e) { handleError(res, e, '[moderations/revert]'); }
  });

  return router;
};
