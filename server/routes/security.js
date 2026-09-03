/**
 * 境途同游 — 安全告警路由
 * 
 * @swagger
 * tags:
 *   name: Security
 *   description: 安全告警相关接口
 */
const express = require('express');
const { getStats } = require('../security_alert');
const { requireAdminCompat } = require('../auth');
const { handleError } = require('../utils');

const router = express.Router();

router.get('/admin/security/alerts/stats', requireAdminCompat, (req, res) => {
  try {
    const stats = getStats();
    res.json({ success: true, stats });
  } catch (e) {
    handleError(res, e, '[security]');
  }
});

module.exports = router;
