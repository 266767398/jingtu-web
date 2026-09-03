const { CronJob } = require('cron');
const { getPool } = require('./utils');
const fs = require('fs');
const path = require('path');
const { sendSystemAlert } = require('./mailer');
const cache = require('./cache');

const jobs = [];

async function cleanupExpiredSessions() {
  try {
    const pool = getPool();
    const [result] = await pool.query(
      'DELETE FROM sessions WHERE expires_at < NOW()'
    );
    if (result.affectedRows > 0) {
      console.log(`[task] 清理过期会话: ${result.affectedRows} 条`);
    }
  } catch (e) {
    console.error('[task] 清理过期会话失败:', e);
    await sendSystemAlert('任务执行失败', `清理过期会话失败: ${e.message}`);
  }
}

async function cleanupExpiredFiles() {
  try {
    const uploadsDir = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(uploadsDir)) return;
    
    const daysToKeep = parseInt(process.env.FILE_RETENTION_DAYS) || 90;
    const threshold = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;
    let deleted = 0;
    
    const cleanupDir = (dir) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          cleanupDir(fullPath);
        } else {
          const stat = fs.statSync(fullPath);
          if (stat.mtime.getTime() < threshold) {
            fs.unlinkSync(fullPath);
            deleted++;
          }
        }
      }
    };
    
    cleanupDir(uploadsDir);
    if (deleted > 0) {
      console.log(`[task] 清理过期文件: ${deleted} 个`);
    }
  } catch (e) {
    console.error('[task] 清理过期文件失败:', e);
    await sendSystemAlert('任务执行失败', `清理过期文件失败: ${e.message}`);
  }
}

async function generateDailyStats() {
  try {
    const pool = getPool();
    const today = new Date().toISOString().split('T')[0];
    
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
    await sendSystemAlert('任务执行失败', `生成日报统计失败: ${e.message}`);
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
    await sendSystemAlert('任务执行失败', `清理过期通知失败: ${e.message}`);
  }
}

async function cleanupExpiredBackups() {
  try {
    const backupDir = path.join(__dirname, '..', 'backups');
    if (!fs.existsSync(backupDir)) return;
    
    const daysToKeep = parseInt(process.env.BACKUP_RETENTION_DAYS) || 7;
    const threshold = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;
    let deleted = 0;
    
    fs.readdirSync(backupDir)
      .filter(f => f.endsWith('.sql'))
      .forEach(f => {
        const fullPath = path.join(backupDir, f);
        if (fs.statSync(fullPath).birthtime.getTime() < threshold) {
          fs.unlinkSync(fullPath);
          deleted++;
        }
      });
    
    if (deleted > 0) {
      console.log(`[task] 清理过期备份: ${deleted} 个`);
    }
  } catch (e) {
    console.error('[task] 清理过期备份失败:', e);
    await sendSystemAlert('任务执行失败', `清理过期备份失败: ${e.message}`);
  }
}

function startTasks() {
  jobs.push(new CronJob('0 * * * *', cleanupExpiredSessions));
  jobs.push(new CronJob('0 2 * * *', cleanupExpiredFiles));
  jobs.push(new CronJob('0 2 * * *', cleanupExpiredNotifications));
  jobs.push(new CronJob('0 3 * * *', cleanupExpiredBackups));
  jobs.push(new CronJob('0 0 * * *', generateDailyStats));
  
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
  cleanupExpiredBackups
};
