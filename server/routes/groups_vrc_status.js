/**
 * 境途同游 V6.14 — VRChat 账号状态检测路由
 * 单个检测 / 批量检测 / 状态清单
 *
 * P2-66：自 groups.js 按域拆出（原 L1291–1402），行为逐字保留。
 *
 * @swagger
 * tags:
 *   name: GroupsVrcStatus
 *   description: VRChat账号在线状态检测接口
 */
const express = require('express');
const { ok, getPool, handleError, sendError, ErrorCodes, paginate } = require('../utils');
const { requireAdminCompat } = require('../auth');
const { vrchatRequest, VRC_API_KEY } = require('../vrc');
const { sleep } = require('./groups_helpers');

// P3-56：与 vrc_invites.js 一致的 VRChat 用户 ID 白名单——校验通过才允许拼进
// /users/{id} 上游 URL，防止含 ?/&/#/路径片段的恶意值改变请求参数或路径。
const VRC_USER_ID_PATTERN = /^usr_[0-9a-fA-F-]{30,50}$/;

module.exports = function (getVRCCookieFn, GROUP_ID, getUserVRCCookieFn) {
  const router = express.Router();

  // ==================== VRChat账号状态检测 ====================
  router.post('/vrc/status/check', requireAdminCompat, async (req, res) => {
    try {
      const { vrchatId } = req.body;
      if (!vrchatId) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '缺少VRChat ID');
      if (!VRC_USER_ID_PATTERN.test(String(vrchatId))) return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'VRChat ID格式不合法');
      
      const vrcCookie = getVRCCookieFn(req);
      if (!vrcCookie) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, 'VRChat系统账号未登录');
      
      const userRes = await vrchatRequest('GET', `/users/${vrchatId}?apiKey=${VRC_API_KEY}`, null, vrcCookie);
      let status = 'unknown';
      let errorMsg = '';
      
      if (userRes.status === 200) {
        const user = userRes.data;
        if (user.isBanned) {
          status = 'banned';
          errorMsg = '账号已被封禁';
        } else if (user.currentInstance === null && user.last_login) {
          status = 'offline';
        } else {
          status = 'valid';
        }
        await getPool().query(
          'INSERT INTO vrc_account_status (vrchat_id, display_name, status, last_check, error_msg) VALUES (?, ?, ?, NOW(), ?) ON DUPLICATE KEY UPDATE display_name=?, status=?, last_check=NOW(), error_msg=?',
          [vrchatId, user.displayName || '', status, errorMsg, user.displayName || '', status, errorMsg]
        );
      } else {
        status = 'invalid';
        errorMsg = '账号不存在或无法访问';
        await getPool().query(
          'INSERT INTO vrc_account_status (vrchat_id, display_name, status, last_check, error_msg) VALUES (?, ?, ?, NOW(), ?) ON DUPLICATE KEY UPDATE status=?, last_check=NOW(), error_msg=?',
          [vrchatId, '', status, errorMsg, status, errorMsg]
        );
      }
      
      ok(res, { vrchatId, status, errorMsg });
    } catch (e) { handleError(res, e, 'groups/status-check'); }
  });

  router.post('/vrc/status/batch-check', requireAdminCompat, async (req, res) => {
    try {
      const { vrchatIds } = req.body;
      if (!Array.isArray(vrchatIds) || vrchatIds.length === 0) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '缺少VRChat ID列表');
      
      const vrcCookie = getVRCCookieFn(req);
      if (!vrcCookie) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, 'VRChat系统账号未登录');
      
      const results = [];
      for (const rawVrchatId of vrchatIds.slice(0, 50)) {
        // P3-56：白名单校验不通过的 ID 直接标记，不发起无意义的上游请求
        if (!VRC_USER_ID_PATTERN.test(String(rawVrchatId))) {
          results.push({ vrchatId: rawVrchatId, status: 'invalid', errorMsg: 'VRChat ID格式不合法' });
          continue;
        }
        const vrchatId = String(rawVrchatId);
        await sleep(200);
        try {
          const userRes = await vrchatRequest('GET', `/users/${vrchatId}?apiKey=${VRC_API_KEY}`, null, vrcCookie);
          let status = 'unknown';
          let errorMsg = '';
          
          if (userRes.status === 200) {
            const user = userRes.data;
            if (user.isBanned) {
              status = 'banned';
              errorMsg = '账号已被封禁';
            } else {
              status = 'valid';
            }
            await getPool().query(
              'INSERT INTO vrc_account_status (vrchat_id, display_name, status, last_check, error_msg) VALUES (?, ?, ?, NOW(), ?) ON DUPLICATE KEY UPDATE display_name=?, status=?, last_check=NOW(), error_msg=?',
              [vrchatId, user.displayName || '', status, errorMsg, user.displayName || '', status, errorMsg]
            );
          } else {
            status = 'invalid';
            errorMsg = '账号不存在';
            await getPool().query(
              'INSERT INTO vrc_account_status (vrchat_id, display_name, status, last_check, error_msg) VALUES (?, ?, ?, NOW(), ?) ON DUPLICATE KEY UPDATE status=?, last_check=NOW(), error_msg=?',
              [vrchatId, '', status, errorMsg, status, errorMsg]
            );
          }
          results.push({ vrchatId, status, errorMsg });
        } catch (e) {
          results.push({ vrchatId, status: 'error', errorMsg: e.message });
        }
      }
      
      ok(res, { results });
    } catch (e) { handleError(res, e, 'groups/batch-status'); }
  });

  router.get('/vrc/status/list', requireAdminCompat, async (req, res) => {
    try {
      const { page, pageSize, offset } = paginate(req, { defaultSize: 20 });
      const statusFilter = req.query.status ? req.query.status.trim() : '';
      
      let where = '1=1';
      const params = [];
      if (statusFilter) {
        where += ' AND status = ?';
        params.push(statusFilter);
      }
      params.push(pageSize, offset);
      
      const [rows] = await getPool().query(
        `SELECT vrchat_id AS vrchatId, display_name AS displayName, status, last_check AS lastCheck, error_msg AS errorMsg FROM vrc_account_status WHERE ${where} ORDER BY last_check DESC LIMIT ? OFFSET ?`,
        params
      );
      const [count] = await getPool().query(`SELECT COUNT(*) as total FROM vrc_account_status WHERE ${where}`, params.slice(0, -2));
      
      res.json({ statuses: rows, total: count[0].total, page, pageSize });
    } catch (e) { handleError(res, e, 'groups/status-list'); }
  });


  return router;
};
