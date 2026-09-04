/**
 * 境途同游 — 日志系统路由
 * 
 * @swagger
 * tags:
 *   name: Logs
 *   description: 系统日志相关接口
 */
const express = require('express');
const { getLogs, getRecentLogs, getLogFiles, deleteLogFile } = require('../logger');
const { requireAdminCompat } = require('../auth');
const { ok, handleError } = require('../utils');

const router = express.Router();

router.get('/admin/logs/recent', requireAdminCompat, (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const result = getRecentLogs(limit);
    res.json(result);
  } catch (e) { handleError(res, e, '[logs/recent]'); }
});

router.get('/admin/logs/files', requireAdminCompat, (req, res) => {
  try {
    const result = getLogFiles();
    res.json(result);
  } catch (e) { handleError(res, e, '[logs/files]'); }
});

router.get('/admin/logs', requireAdminCompat, (req, res) => {
  try {
    const date = req.query.date || '';
    const page = parseInt(req.query.page) || 1;
    const pageSize = parseInt(req.query.pageSize) || 100;
    const result = getLogs(date, page, pageSize);
    res.json(result);
  } catch (e) { handleError(res, e, '[logs/list]'); }
});

router.delete('/admin/logs/:filename', requireAdminCompat, (req, res) => {
  try {
    const result = deleteLogFile(req.params.filename);
    if (result.success) {
      ok(res);
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (e) { handleError(res, e, '[logs/delete]'); }
});

module.exports = router;
