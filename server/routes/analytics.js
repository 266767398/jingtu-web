/**
 * 境途同游 — 数据分析路由
 * 
 * @swagger
 * tags:
 *   name: Analytics
 *   description: 数据分析相关接口
 */
const express = require('express');
const { getPool, handleError } = require('../utils');
const { requireAdminCompat } = require('../auth');
const { getStats: getMetricsStats } = require('../middleware/metrics');
const { getCacheStatus } = require('../cache_service');

const router = express.Router();

router.get('/admin/analytics/dashboard', requireAdminCompat, async (req, res) => {
  try {
    const pool = getPool();
    
    const [userCount] = await pool.query('SELECT COUNT(*) as count FROM users WHERE deleted_at IS NULL');
    const [activeUserCount] = await pool.query(
      "SELECT COUNT(DISTINCT user_id) as count FROM posts WHERE DATE(created_at) = CURDATE()"
    );
    const [postCount] = await pool.query('SELECT COUNT(*) as count FROM posts');
    const [eventCount] = await pool.query('SELECT COUNT(*) as count FROM event WHERE is_archive = 0');
    const [photoCount] = await pool.query('SELECT COUNT(*) as count FROM album_photo WHERE is_recycle = 0');
    const [onlineCount] = await pool.query(
      "SELECT COUNT(*) as count FROM group_roster WHERE is_member = 1 AND is_online = 1"
    );
    
    const metrics = getMetricsStats();
    const cache = await getCacheStatus();
    
    res.json({
      users: {
        total: userCount[0].count,
        activeToday: activeUserCount[0].count,
        online: onlineCount[0].count
      },
      content: {
        posts: postCount[0].count,
        events: eventCount[0].count,
        photos: photoCount[0].count
      },
      performance: {
        requests: metrics.requests.total,
        successRate: metrics.requests.successRate,
        avgResponseTime: metrics.latency.avg,
        maxResponseTime: metrics.latency.max,
        slowRequests: metrics.requests.slow
      },
      cache: {
        enabled: cache.enabled,
        keyCount: cache.keyCount,
        keysByType: cache.keysByType
      }
    });
  } catch (e) { handleError(res, e, '[analytics/dashboard]'); }
});

router.get('/admin/analytics/requests', requireAdminCompat, async (req, res) => {
  try {
    const metrics = getMetricsStats();
    res.json({
      total: metrics.requests.total,
      success: metrics.requests.success,
      errors: metrics.requests.error,
      successRate: metrics.requests.successRate,
      endpoints: metrics.endpoints,
      statusCodes: metrics.statusCodes,
      slowRequests: metrics.requests.slow
    });
  } catch (e) { handleError(res, e, '[analytics/requests]'); }
});

router.get('/admin/analytics/users', requireAdminCompat, async (req, res) => {
  try {
    const pool = getPool();
    const days = parseInt(req.query.days) || 7;
    
    const [dailyRegistrations] = await pool.query(`
      SELECT DATE(created_at) as date, COUNT(*) as count 
      FROM users 
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY) AND deleted_at IS NULL
      GROUP BY DATE(created_at)
      ORDER BY date
    `, [days]);
    
    const [topUsers] = await pool.query(`
      SELECT u.id, u.login_id as username, u.display_name,
             COUNT(DISTINCT p.id) as post_count,
             COUNT(DISTINCT pc.id) as comment_count
      FROM users u
      LEFT JOIN posts p ON u.id = p.user_id
      LEFT JOIN post_comment pc ON u.id = pc.user_id
      WHERE u.deleted_at IS NULL
      GROUP BY u.id
      ORDER BY post_count DESC
      LIMIT 10
    `);
    
    const [activityByHour] = await pool.query(`
      SELECT HOUR(created_at) as hour, COUNT(*) as count
      FROM posts
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
      GROUP BY HOUR(created_at)
      ORDER BY hour
    `);
    
    res.json({
      dailyRegistrations,
      topUsers,
      activityByHour
    });
  } catch (e) { handleError(res, e, '[analytics/users]'); }
});

router.get('/admin/analytics/content', requireAdminCompat, async (req, res) => {
  try {
    const pool = getPool();
    const days = parseInt(req.query.days) || 7;
    
    const [dailyPosts] = await pool.query(`
      SELECT DATE(created_at) as date, COUNT(*) as count
      FROM posts
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
      GROUP BY DATE(created_at)
      ORDER BY date
    `, [days]);
    
    const [dailyEvents] = await pool.query(`
      SELECT DATE(create_time) as date, COUNT(*) as count
      FROM event
      WHERE create_time >= DATE_SUB(NOW(), INTERVAL ? DAY) AND is_archive = 0
      GROUP BY DATE(create_time)
      ORDER BY date
    `, [days]);
    
    const [dailyPhotos] = await pool.query(`
      SELECT DATE(create_time) as date, COUNT(*) as count
      FROM album_photo
      WHERE create_time >= DATE_SUB(NOW(), INTERVAL ? DAY) AND is_recycle = 0
      GROUP BY DATE(create_time)
      ORDER BY date
    `, [days]);
    
    const [postsByUser] = await pool.query(`
      SELECT u.login_id as username, COUNT(p.id) as count
      FROM posts p
      JOIN users u ON p.user_id = u.id
      WHERE u.deleted_at IS NULL
      GROUP BY u.id
      ORDER BY count DESC
      LIMIT 10
    `);
    
    res.json({
      dailyPosts,
      dailyEvents,
      dailyPhotos,
      postsByUser
    });
  } catch (e) { handleError(res, e, '[analytics/content]'); }
});

router.get('/admin/analytics/system', requireAdminCompat, async (req, res) => {
  try {
    const os = require('os');
    
    const systemInfo = {
      platform: os.platform(),
      arch: os.arch(),
      hostname: os.hostname(),
      uptime: os.uptime(),
      uptimeFormatted: formatUptime(os.uptime()),
      cpu: {
        cores: os.cpus().length,
        model: os.cpus()[0]?.model || 'Unknown',
        load: os.loadavg()
      },
      memory: {
        total: formatBytes(os.totalmem()),
        free: formatBytes(os.freemem()),
        used: formatBytes(os.totalmem() - os.freemem()),
        usagePercent: ((os.totalmem() - os.freemem()) / os.totalmem() * 100).toFixed(1)
      },
      network: os.networkInterfaces()
    };
    
    const cache = await getCacheStatus();
    const metrics = getMetricsStats();
    
    res.json({
      system: systemInfo,
      cache,
      metrics: {
        totalRequests: metrics.totalRequests,
        avgLatency: metrics.avgLatency,
        uptime: metrics.uptime
      }
    });
  } catch (e) { handleError(res, e, '[analytics/system]'); }
});

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${days}天 ${hours}小时 ${minutes}分钟 ${secs}秒`;
}

module.exports = router;
