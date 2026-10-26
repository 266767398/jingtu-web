/**
 * 境途同游 — 健康检查路由
 * 
 * @swagger
 * tags:
 *   name: Health
 *   description: 系统健康检查接口
 */
const express = require('express');
const os = require('os');
const path = require('path');
const { getPool } = require('../utils');
const { requireSuperAdmin } = require('../auth');

const router = express.Router();

// 版本以 server/package.json 为准，避免 health 端点硬编码与发布版本漂移
const PKG_VERSION = require(path.join(__dirname, '..', 'package.json')).version;

// SEC-2 修复：/health/detailed 返回 CPU/内存/loadavg 等系统信息，
// 与 database.js processlist 同口径收紧至 super_admin（普通 admin 不需要系统级运维数据）
router.get('/health/detailed', requireSuperAdmin, async (req, res) => {
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
      version: PKG_VERSION
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
