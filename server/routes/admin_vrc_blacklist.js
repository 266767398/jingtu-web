/**
 * 境途同游 — VRChat 黑名单路由（超管维护）
 * 超管可在管理后台维护黑名单：用户名 / 用户URL / 做了什么（原因详情）。
 * 群组名册接口 LEFT JOIN 本表后，前端成员卡片展示黑名单徽标。
 */
const express = require('express');
const { ok, getPool, handleError, sendError, ErrorCodes, logOper } = require('../utils');
const { requireSuperAdmin } = require('../auth');

module.exports = function createAdminVrcBlacklistRouter() {
  const router = express.Router();

  // ==================== 黑名单列表（超管） ====================
  router.get('/admin/vrc-blacklist', requireSuperAdmin, async (req, res) => {
    try {
      const [rows] = await getPool().query(
        `SELECT b.id, b.vrchat_id AS vrchatId, b.username, b.url, b.reason,
                b.created_by AS createdBy, u.display_name AS createdByName, b.created_at AS createdAt
         FROM vrc_blacklist b
         LEFT JOIN users u ON b.created_by = u.id
         ORDER BY b.created_at DESC`
      );
      res.json({ items: rows });
    } catch (e) { handleError(res, e, '[admin/vrc-blacklist/list]'); }
  });

  // ==================== 添加黑名单（超管） ====================
  router.post('/admin/vrc-blacklist', requireSuperAdmin, async (req, res) => {
    try {
      const { vrchatId, username, url, reason } = req.body;
      const usernameTrim = String(username || '').trim();
      if (!usernameTrim) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请输入用户名');
      if (usernameTrim.length > 255) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '用户名不能超过255字');
      const urlTrim = String(url || '').trim();
      if (urlTrim.length > 2048) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '用户URL不能超过2048字');
      const reasonStr = String(reason || '').trim();
      if (reasonStr.length > 2000) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '原因描述不能超过2000字');
      // VRChat ID 可选：填写则按 ID 去重（同 ID 不可重复拉黑）；未填写时按用户名去重，避免重复录入噪音
      const vid = String(vrchatId || '').trim() || null;
      if (vid && !/^usr_[0-9a-fA-F-]+$/.test(vid)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'VRChat ID 格式不正确（应为 usr_ 开头）');
      }
      const [dup] = vid
        ? await getPool().query(`SELECT id FROM vrc_blacklist WHERE vrchat_id=?`, [vid])
        : await getPool().query(`SELECT id FROM vrc_blacklist WHERE vrchat_id IS NULL AND username=?`, [usernameTrim]);
      if (dup.length > 0) return sendError(res, 409, ErrorCodes.CONFLICT, '该用户已在黑名单中');
      await getPool().query(
        `INSERT INTO vrc_blacklist (vrchat_id, username, url, reason, created_by) VALUES (?, ?, ?, ?, ?)`,
        [vid, usernameTrim, urlTrim, reasonStr || null, req.session.userId]
      );
      await logOper(req.session.userId, '添加VRChat黑名单', `${usernameTrim}${vid ? ` (${vid})` : ''}`);
      ok(res, { message: '已加入黑名单' });
    } catch (e) { handleError(res, e, '[admin/vrc-blacklist/add]'); }
  });

  // ==================== 移除黑名单（超管） ====================
  router.delete('/admin/vrc-blacklist/:id', requireSuperAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id || Number.isNaN(id)) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      const [rows] = await getPool().query(`SELECT username FROM vrc_blacklist WHERE id=?`, [id]);
      if (rows.length === 0) return sendError(res, 404, ErrorCodes.NOT_FOUND, '黑名单记录不存在');
      await getPool().query(`DELETE FROM vrc_blacklist WHERE id=?`, [id]);
      await logOper(req.session.userId, '移除VRChat黑名单', rows[0].username);
      ok(res, { message: '已移除黑名单' });
    } catch (e) { handleError(res, e, '[admin/vrc-blacklist/remove]'); }
  });

  return router;
};