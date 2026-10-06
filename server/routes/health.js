/**
 * 境途同游 — 健康检查路由
 * 
 * @swagger
 * tags:
 *   name: Health
 *   description: 系统健康检查接口
 */
const express = require('express');
const { getPool } = require('../utils');
const { requireAdminCompat } = require('../auth');
const os = require('os');

const router = express.Router();

router.get('/health/detailed', requireAdminCompat, async (req, res) => {
  const startTime = Date.now();

  try {
    const pool = getPool();
    await pool.query('SELECT 1 AS db_check');
    const dbLatency = Date.now() - startTime;

    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: {
        status: 'connected',
        latency: `${dbLatency}ms`
      },
      system: {
        cpu: os.cpus().length,
        memory: {
          total: `${(os.totalmem() / 1024 / 1024).toFixed(2)}MB`,
          free: `${(os.freemem() / 1024 / 1024).toFixed(2)}MB`,
          usage: `${((1 - os.freemem() / os.totalmem()) * 100).toFixed(1)}%`
        },
        load: os.loadavg()
      },
      version: 'V8.2'
    });
  } catch (e) {
    // 不回显数据库原始错误，避免泄露连接串/主机名
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString()
    });
  }
});

router.get('/health/live', (req, res) => {
  res.json({ status: 'alive' });
});

router.get('/health/ready', async (req, res) => {
  try {
    const pool = getPool();
    await pool.query('SELECT 1');
    res.json({ status: 'ready' });
  } catch (e) {
    // 失败时仅返回状态，不回显 e.message
    res.status(503).json({ status: 'not_ready' });
  }
});

module.exports = router;
