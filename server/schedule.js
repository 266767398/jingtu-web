const schedule = require('node-schedule');
const fs = require('fs');
const path = require('path');
const dbMod = require('./db');

const jobs = [];

function startSchedule() {
  // 每天凌晨 2:00 — 清理超过 7 天的回收站图片
  jobs.push(schedule.scheduleJob('0 0 2 * * *', async () => {
    console.log('🔄 [定时任务] 开始清理过期回收站图片...');
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const [rows] = await dbMod.holder.pool.query(
        `SELECT id, photo_path, thumb_path FROM album_photo WHERE is_recycle = 1 AND recycle_time < ?`,
        [sevenDaysAgo]
      );

      for (const row of rows) {
        try {
          const pp = path.join(__dirname, '..', row.photo_path);
          const tp = path.join(__dirname, '..', row.thumb_path);
          if (fs.existsSync(pp)) fs.unlinkSync(pp);
          if (tp !== pp && fs.existsSync(tp)) fs.unlinkSync(tp);
        } catch (e) { /* 文件删除失败忽略 */ }

        await dbMod.holder.pool.query(`DELETE FROM album_like WHERE photo_id = ?`, [row.id]);
        await dbMod.holder.pool.query(`DELETE FROM album_comment WHERE photo_id = ?`, [row.id]);
        await dbMod.holder.pool.query(`DELETE FROM album_photo WHERE id = ?`, [row.id]);
      }
      console.log(`✅ [定时任务] 清理完成，删除 ${rows.length} 张过期图片`);
    } catch (e) {
      console.error('❌ [定时任务] 回收站清理失败:', e.message);
    }
  }));

  // 每天凌晨 3:00 — 自动归档过期活动
  jobs.push(schedule.scheduleJob('0 0 3 * * *', async () => {
    console.log('🔄 [定时任务] 归档过期活动...');
    try {
      const [result] = await dbMod.holder.pool.query(
        `UPDATE event SET is_archive = 1 WHERE event_time < NOW() AND is_archive = 0`
      );
      console.log(`✅ [定时任务] 归档完成，共 ${result.affectedRows} 个活动`);
    } catch (e) {
      console.error('❌ [定时任务] 活动归档失败:', e.message);
    }
  }));

  // 每天中午 12:00 — VRChat 系统账号 Token 验证提醒
  jobs.push(schedule.scheduleJob('0 0 12 * * *', () => {
    console.log('🔔 [定时任务] VRChat 系统账号 Token 验证提醒 — 请确认群组数据拉取正常');
  }));

  console.log('⏰ 定时任务已启动（回收站清理: 每天 2:00 / 活动归档: 每天 3:00 / Token提醒: 每天 12:00）');
}

function gracefulShutdown() {
  for (const job of jobs) {
    try { job.cancel(); } catch {}
  }
  jobs.length = 0;
  console.log('  ✓ 定时任务已取消');
}

module.exports = startSchedule;
module.exports.gracefulShutdown = gracefulShutdown;
