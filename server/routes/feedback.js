/**
 * 境途同游 V6.XX — 用户反馈/建议路由
 * 左下角悬浮按钮提交反馈；登录用户记录 user_id，未登录也允许提交（user_id NULL）。
 */
const express = require('express');
const { getPool, handleError, sendError, ErrorCodes } = require('../utils');

module.exports = function () {
  const router = express.Router();

  // POST /api/feedback — 提交反馈（无需登录，登录则记录用户）
  router.post('/', async (req, res) => {
    try {
      const content = String(req.body.content || '').trim();
      if (!content) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请输入反馈内容');
      }
      if (content.length > 2000) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '反馈内容不能超过2000字');
      }
      const contact = String(req.body.contact || '').trim().slice(0, 255) || null;
      const userId = (req.session && req.session.userId) || null;

      await getPool().query(
        `INSERT INTO feedback (user_id, content, contact) VALUES (?, ?, ?)`,
        [userId, content, contact]
      );
      res.json({ success: true, message: '反馈已提交，感谢您的建议！' });
    } catch (e) {
      handleError(res, e, '[feedback/submit]');
    }
  });

  return router;
};
