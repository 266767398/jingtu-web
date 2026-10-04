const { CronJob } = require('cron');
const { getPool } = require('./utils');
const fs = require('fs');
const path = require('path');
const { sendSystemAlert } = require('./mailer');
const cache = require('./cache');
const logger = require('./logger');
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

// P3-47: 计算北京时间「次日」日期字符串，用于范围查询上界
function nextDayBeijing(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split('T')[0];
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
      logger.info('tasks', `[task] 清理过期会话: ${result.affectedRows} 条`);
    }
  } catch (e) {
    logger.error('tasks', '[task] 清理过期会话失败:', e);
    await alertThrottled('cleanupExpiredSessions', '任务执行失败', `清理过期会话失败: ${e.message}`);
  }
}

// P1-11：只清扫临时目录（uploads/tmp、uploads/temp）。
// 旧实现对整个 uploads/ 递归按 mtime 盲删，会误删聊天图片、头像、动态配图、
// 直播封面等「DB 仍引用但长期未被访问」的永久文件（mtime 早于阈值 ≠ 可删除）。
// §P3-91: 递归深度/扫描文件数上限（防深层目录栈风险与耗时不可控）；
// unlink 失败不再静默吞——计数并节流告警。
const MAX_CLEAN_DEPTH = 8;
const MAX_CLEAN_FILES = 50000;
async function cleanupExpiredFiles() {
  try {
    const uploadsDir = path.join(__dirname, '..', 'uploads');
    const tmpDirs = ['tmp', 'temp'].map((d) => path.join(uploadsDir, d));
    let deleted = 0;
    let failed = 0;
    let scanned = 0;

    const daysToKeep = parseInt(process.env.FILE_RETENTION_DAYS) || 90;
    const threshold = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;

    const cleanupDir = (dir, depth) => {
      if (depth > MAX_CLEAN_DEPTH) {
        logger.warn('tasks', `[task] 临时目录递归深度超限（>${MAX_CLEAN_DEPTH}），跳过 ${dir}`);
        return;
      }
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (scanned >= MAX_CLEAN_FILES) {
          logger.warn('tasks', `[task] 临时文件扫描数达上限（${MAX_CLEAN_FILES}），中止剩余清理`);
          return;
        }
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          cleanupDir(fullPath, depth + 1);
        } else {
          scanned++;
          try {
            const stat = fs.statSync(fullPath);
            if (stat.mtime.getTime() < threshold) {
              fs.unlinkSync(fullPath);
              deleted++;
            }
          } catch (_) {
            failed++;
          }
        }
      }
    };

    for (const dir of tmpDirs) {
      if (fs.existsSync(dir)) {
        cleanupDir(dir, 0);
      }
    }

    if (deleted > 0 || failed > 0) {
      logger.info('tasks', `[task] 清理过期临时文件: 删除 ${deleted} 个` + (failed ? `，失败 ${failed} 个` : ''));
    }
    if (failed > 0) {
      await alertThrottled('cleanupExpiredFilesPartial', '临时文件清理部分失败', `临时文件删除失败 ${failed} 个，请检查文件权限/占用`);
    }
  } catch (e) {
    logger.error('tasks', '[task] 清理过期文件失败:', e);
    await alertThrottled('cleanupExpiredFiles', '任务执行失败', `清理过期文件失败: ${e.message}`);
  }
}

async function generateDailyStats() {
  try {
    const pool = getPool();
    const today = todayBeijing();
    const nextDay = nextDayBeijing(today);

    // P3-47: DATE() 包裹列会使索引失效（users/posts/event 全表扫），改为范围查询（含下界、开上界）
    const [newUsers] = await pool.query(
      "SELECT COUNT(*) as count FROM users WHERE created_at >= ? AND created_at < ?",
      [today, nextDay]
    );

    const [newPosts] = await pool.query(
      "SELECT COUNT(*) as count FROM posts WHERE created_at >= ? AND created_at < ?",
      [today, nextDay]
    );

    const [newEvents] = await pool.query(
      "SELECT COUNT(*) as count FROM event WHERE create_time >= ? AND create_time < ?",
      [today, nextDay]
    );

    const [activeUsers] = await pool.query(
      "SELECT COUNT(DISTINCT user_id) as count FROM posts WHERE created_at >= ? AND created_at < ?",
      [today, nextDay]
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

    logger.info('tasks', `[task] 生成日报统计: ${JSON.stringify(stats)}`);

    await sendSystemAlert('日报统计',
      `📊 今日统计\n用户注册: ${stats.newUsers}\n动态发布: ${stats.newPosts}\n活动创建: ${stats.newEvents}\n活跃用户: ${stats.activeUsers}`
    );
  } catch (e) {
    logger.error('tasks', '[task] 生成日报统计失败:', e);
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
      logger.info('tasks', `[task] 清理过期通知: ${result.affectedRows} 条`);
    }
  } catch (e) {
    logger.error('tasks', '[task] 清理过期通知失败:', e);
    await alertThrottled('cleanupExpiredNotifications', '任务执行失败', `清理过期通知失败: ${e.message}`);
  }
}

// P1-12：每日自动备份（写库快照，prefix=auto_ 以便与手动备份区分治理）
async function runAutoBackup() {
  try {
    const info = await createBackup({ prefix: 'auto_' });
    logger.info('tasks', `[task] 自动备份完成: ${info.filename} (${info.sizeFormatted})`);
  } catch (e) {
    logger.error('tasks', '[task] 自动备份失败:', e);
    await alertThrottled('runAutoBackup', '自动备份失败', `自动数据库备份失败: ${e.message}`);
  }
}

// P2-75：保留策略只作用于 auto_ 前缀的自动备份；手动备份永不自动删除
async function cleanupExpiredBackups() {
  try {
    const daysToKeep = parseInt(process.env.BACKUP_RETENTION_DAYS) || 7;
    const deleted = cleanupAutoBackups(daysToKeep);
    if (deleted > 0) {
      logger.info('tasks', `[task] 清理过期自动备份: ${deleted} 个`);
    }
  } catch (e) {
    logger.error('tasks', '[task] 清理过期备份失败:', e);
    await alertThrottled('cleanupExpiredBackups', '任务执行失败', `清理过期备份失败: ${e.message}`);
  }
}

// P3-51：清理过期分享链接（share_links 7 天过期，此前仅有 INSERT/SELECT 无 DELETE 路径，过期行无限累积）
// NOW()/expires_at 比较双引擎通用（db.js SQLite 层将 NOW() 翻译为 datetime('now','localtime')）
async function cleanupExpiredShareLinks() {
  try {
    const pool = getPool();
    const [result] = await pool.query('DELETE FROM share_links WHERE expires_at < NOW()');
    if (result.affectedRows > 0) {
      logger.info('tasks', `[task] 清理过期分享链接: ${result.affectedRows} 条`);
    }
  } catch (e) {
    logger.error('tasks', '[task] 清理过期分享链接失败:', e);
    await alertThrottled('cleanupExpiredShareLinks', '任务执行失败', `清理过期分享链接失败: ${e.message}`);
  }
}

function startTasks() {
  // §P3-90: 幂等——二次调用先停止并清空已注册任务，避免全部 CronJob 重复注册任务翻倍
  stopTasks();
  // §P3-90: 防重入——任务执行超过调度间隔时跳过下一次重叠触发（避免重复备份/重复删除）
  const running = new Set();
  const guard = (key, fn) => async () => {
    if (running.has(key)) {
      logger.warn('tasks', `[task] ${key} 上一次执行尚未结束，跳过本轮重叠触发`);
      return;
    }
    running.add(key);
    try {
      await fn();
    } finally {
      running.delete(key);
    }
  };

  // P2-71：显式指定 Asia/Shanghai 时区，避免服务器时区不同导致「每天 0 点」漂移
  jobs.push(new CronJob('0 * * * *', guard('cleanupExpiredSessions', cleanupExpiredSessions), null, true, 'Asia/Shanghai'));
  jobs.push(new CronJob('0 2 * * *', guard('cleanupExpiredFiles', cleanupExpiredFiles), null, true, 'Asia/Shanghai'));
  jobs.push(new CronJob('0 2 * * *', guard('cleanupExpiredNotifications', cleanupExpiredNotifications), null, true, 'Asia/Shanghai'));
  jobs.push(new CronJob('30 2 * * *', guard('runAutoBackup', runAutoBackup), null, true, 'Asia/Shanghai'));
  jobs.push(new CronJob('0 3 * * *', guard('cleanupExpiredBackups', cleanupExpiredBackups), null, true, 'Asia/Shanghai'));
  jobs.push(new CronJob('0 3 * * *', guard('cleanupExpiredShareLinks', cleanupExpiredShareLinks), null, true, 'Asia/Shanghai'));
  jobs.push(new CronJob('0 0 * * *', guard('generateDailyStats', generateDailyStats), null, true, 'Asia/Shanghai'));

  for (const job of jobs) {
    job.start();
  }

  logger.info('tasks', '[task] 定时任务系统已启动');
}

function stopTasks() {
  for (const job of jobs) {
    try { job.stop(); } catch (_) {}
  }
  jobs.length = 0; 
  logger.info('tasks', '[task] 定时任务系统已停止');
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
  cleanupExpiredShareLinks,
  runAutoBackup
};
