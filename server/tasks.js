const { CronJob } = require('cron');
const { getPool } = require('./utils');
const fs = require('fs');
const path = require('path');
const { sendSystemAlert } = require('./mailer');
const cache = require('./cache');
const { createBackup, cleanupAutoBackups } = require('./backup-core');

const jobs = [];

// P1-10 配套：任务失败告警节流（同一 key 6 小时内只发一封，避免小时级任务
// 在持续故障时把管理员邮箱刷爆）
const ALERT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const lastAlertAt = new Map();
async function alertThrottled(key, subject, message) {
  const now = Date.now();
  const last = lastAlertAt.get(key) || 0;
  if (now - last < ALERT_INTERVAL_MS) return;
  lastAlertAt.set(key, now);
  try {
    await sendSystemAlert(subject, message);
  } catch (_) {}
}

// P2-71：所有任务统一按北京时间判定「今天」，避免 UTC 与 +08:00 双时钟错位
function todayBeijing() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

async function cleanupExpiredSessions() {
  try {
    const pool = getPool();
    // P1-10：express-mysql-session 的真实表结构为 sessions(session_id, expires, data)，
    // expires 是「秒级 Unix 时间戳」的 int 列（无 expires_at / 无 NOW() 可比较）。
    // 旧 SQL `expires_at < NOW()` 引用不存在的列，每小时抛 unknown column → 清理从未生效，
    // 且失败告警邮件刷屏。
    const [result] = await pool.query(
      'DELETE FROM sessions WHERE expires < UNIX_TIMESTAMP()'
    );
    if (result.affectedRows > 0) {
      console.log(`[task] 清理过期会话: ${result.affectedRows} 条`);
    }
  } catch (e) {
    console.error('[task] 清理过期会话失败:', e);
    await alertThrottled('cleanupExpiredSessions', '任务执行失败', `清理过期会话失败: ${e.message}`);
  }
}

// P1-11：只清扫临时目录（uploads/tmp、uploads/temp）。
// 旧实现对整个 uploads/ 递归按 mtime 盲删，会误删聊天图片、头像、动态配图、
// 直播封面等「DB 仍引用但长期未被访问」的永久文件（mtime 早于阈值 ≠ 可删除）。
async function cleanupExpiredFiles() {
  try {
    const uploadsDir = path.join(__dirname, '..', 'uploads');
    const tmpDirs = ['tmp', 'temp'].map((d) => path.join(uploadsDir, d));
    let deleted = 0;

    const daysToKeep = parseInt(process.env.FILE_RETENTION_DAYS) || 90;
    const threshold = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;

    const cleanupDir = (dir) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          cleanupDir(fullPath);
        } else {
          try {
            const stat = fs.statSync(fullPath);
            if (stat.mtime.getTime() < threshold) {
              fs.unlinkSync(fullPath);
              deleted++;
            }
          } catch (_) {}
        }
      }
    };

    for (const dir of tmpDirs) {
      if (fs.existsSync(dir)) {
        cleanupDir(dir);
      }
    }

    if (deleted > 0) {
      console.log(`[task] 清理过期临时文件: ${deleted} 个`);
    }
  } catch (e) {
    console.error('[task] 清理过期文件失败:', e);
    await alertThrottled('cleanupExpiredFiles', '任务执行失败', `清理过期文件失败: ${e.message}`);
  }
}

async function generateDailyStats() {
  try {
    const pool = getPool();
    const today = todayBeijing();

    const [newUsers] = await pool.query(
      "SELECT COUNT(*) as count FROM users WHERE DATE(created_at) = ?",
      [today]
    );

    const [newPosts] = await pool.query(
      "SELECT COUNT(*) as count FROM posts WHERE DATE(created_at) = ?",
      [today]
    );

    const [newEvents] = await pool.query(
      "SELECT COUNT(*) as count FROM event WHERE DATE(create_time) = ?",
      [today]
    );

    const [activeUsers] = await pool.query(
      "SELECT COUNT(DISTINCT user_id) as count FROM posts WHERE DATE(created_at) = ?",
      [today]
    );

    const stats = {
      date: today,
      newUsers: newUsers[0].count,
      newPosts: newPosts[0].count,
      newEvents: newEvents[0].count,
      activeUsers: activeUsers[0].count,
      timestamp: Date.now()
    };

    await cache.set(`stats:daily:${today}`, stats, 7 * 24 * 60 * 60);

    console.log(`[task] 生成日报统计: ${JSON.stringify(stats)}`);

    await sendSystemAlert('日报统计',
      `📊 今日统计\n用户注册: ${stats.newUsers}\n动态发布: ${stats.newPosts}\n活动创建: ${stats.newEvents}\n活跃用户: ${stats.activeUsers}`
    );
  } catch (e) {
    console.error('[task] 生成日报统计失败:', e);
    await alertThrottled('generateDailyStats', '任务执行失败', `生成日报统计失败: ${e.message}`);
  }
}

async function cleanupExpiredNotifications() {
  try {
    const pool = getPool();
    const daysToKeep = parseInt(process.env.NOTIFICATION_RETENTION_DAYS) || 30;
    const [result] = await pool.query(
      'DELETE FROM notifications WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)',
      [daysToKeep]
    );
    if (result.affectedRows > 0) {
      console.log(`[task] 清理过期通知: ${result.affectedRows} 条`);
    }
  } catch (e) {
    console.error('[task] 清理过期通知失败:', e);
    await alertThrottled('cleanupExpiredNotifications', '任务执行失败', `清理过期通知失败: ${e.message}`);
  }
}

// P1-12：每日自动备份（写库快照，prefix=auto_ 以便与手动备份区分治理）
async function runAutoBackup() {
  try {
    const info = await createBackup({ prefix: 'auto_' });
    console.log(`[task] 自动备份完成: ${info.filename} (${info.sizeFormatted})`);
  } catch (e) {
    console.error('[task] 自动备份失败:', e);
    await alertThrottled('runAutoBackup', '自动备份失败', `自动数据库备份失败: ${e.message}`);
  }
}

// P2-75：保留策略只作用于 auto_ 前缀的自动备份；手动备份永不自动删除
async function cleanupExpiredBackups() {
  try {
    const daysToKeep = parseInt(process.env.BACKUP_RETENTION_DAYS) || 7;
    const deleted = cleanupAutoBackups(daysToKeep);
    if (deleted > 0) {
      console.log(`[task] 清理过期自动备份: ${deleted} 个`);
    }
  } catch (e) {
    console.error('[task] 清理过期备份失败:', e);
    await alertThrottled('cleanupExpiredBackups', '任务执行失败', `清理过期备份失败: ${e.message}`);
  }
}

function startTasks() {
  // P2-71：显式指定 Asia/Shanghai 时区，避免服务器时区不同导致「每天 0 点」漂移
  jobs.push(new CronJob('0 * * * *', cleanupExpiredSessions, null, true, 'Asia/Shanghai'));
  jobs.push(new CronJob('0 2 * * *', cleanupExpiredFiles, null, true, 'Asia/Shanghai'));
  jobs.push(new CronJob('0 2 * * *', cleanupExpiredNotifications, null, true, 'Asia/Shanghai'));
  jobs.push(new CronJob('30 2 * * *', runAutoBackup, null, true, 'Asia/Shanghai'));
  jobs.push(new CronJob('0 3 * * *', cleanupExpiredBackups, null, true, 'Asia/Shanghai'));
  jobs.push(new CronJob('0 0 * * *', generateDailyStats, null, true, 'Asia/Shanghai'));

  for (const job of jobs) {
    job.start();
  }

  console.log('[task] 定时任务系统已启动');
}

function stopTasks() {
  for (const job of jobs) {
    job.stop();
  }
  console.log('[task] 定时任务系统已停止');
}

function getTaskStatus() {
  return jobs.map((job, index) => ({
    id: index,
    running: job.running,
    nextDate: job.nextDate()?.toLocaleString()
  }));
}

module.exports = {
  startTasks,
  stopTasks,
  getTaskStatus,
  cleanupExpiredSessions,
  cleanupExpiredFiles,
  generateDailyStats,
  cleanupExpiredNotifications,
  cleanupExpiredBackups,
  runAutoBackup
};
