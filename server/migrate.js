const fs = require('fs');
const path = require('path');
// P1-14：独立 CLI 必须先加载 .env 再 require ./db（db.js 不自行加载 dotenv，
// 只在 MYSQL_PASSWORD 上有文件回退），否则连的是空配置库。必须早于第 5 行 require。
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { holder, getPool } = require('./db');
const initDatabase = require('./db_init');

const ROOT_DIR = path.join(__dirname, '..');

// P1-14：旧实现 `const { pool } = require('./db')`——db.js 从未导出 pool，
// pool 恒为 undefined，每一次 pool.query 都抛 TypeError，又被各段 catch 一律
// 打印「⚠️ 迁移跳过」吞掉，最后无条件 🎉 + exit 0：所有数据一条都没迁、
// 且永远「成功」。现在用 getPool()（initDatabase 后连接池已重建，快照会失效），
// 逐条统计真实失败，任何失败都会反映在退出码上。
const migrationFailures = [];

async function migrate() {
  console.log('🔄 开始数据迁移...\n');
  await initDatabase();
  const pool = getPool();

  // 迁移管理员
  const adminFile = path.join(ROOT_DIR, 'admin.json');
  if (fs.existsSync(adminFile)) {
    try {
      const admins = JSON.parse(fs.readFileSync(adminFile, 'utf8'));
      let adminOk = 0;
      for (const admin of admins.admins || admins) {
        const id = admin.userId || admin.id;
        const name = admin.displayName || admin.name || id;
        if (id) {
          try {
            await pool.query(`INSERT IGNORE INTO sys_admin (vrchat_id, vrchat_name) VALUES (?, ?)`, [id, name]);
            adminOk++;
          } catch (e) { migrationFailures.push(`管理员 ${id}: ${e.message}`); }
        }
      }
      console.log(`✅ 管理员数据迁移完成（成功 ${adminOk} 条）`);
    } catch (e) { migrationFailures.push(`管理员文件处理: ${e.message}`); console.error('❌ 管理员迁移失败:', e.message); }
  }

  // 迁移公告
  const annFile = path.join(ROOT_DIR, 'announcements.json');
  if (fs.existsSync(annFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(annFile, 'utf8'));
      const items = data.announcements || data;
      let annOk = 0;
      for (const item of items) {
        try {
          await pool.query(
            `INSERT IGNORE INTO announcement (id, title, content, create_admin, create_time) VALUES (?, ?, ?, ?, ?)`,
            [item.id, item.title, item.content, item.createAdmin || item.admin || '', item.createTime || new Date().toISOString()]
          );
          annOk++;
        } catch (e) { migrationFailures.push(`公告 ${item.id}: ${e.message}`); }
      }
      console.log(`✅ 公告数据迁移完成（成功 ${annOk}/${items.length} 条）`);
    } catch (e) { migrationFailures.push(`公告文件处理: ${e.message}`); console.error('❌ 公告迁移失败:', e.message); }
  }

  // 迁移活动
  const evtFile = path.join(ROOT_DIR, 'events.json');
  if (fs.existsSync(evtFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(evtFile, 'utf8'));
      const items = data.events || data;
      let evtOk = 0;
      for (const item of items) {
        try {
          await pool.query(
            `INSERT IGNORE INTO event (id, title, place, event_time, description, create_admin, create_time) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [item.id, item.title, item.place || '', item.eventTime || item.time || new Date().toISOString(), item.description || item.desc || '', item.createAdmin || item.admin || '', item.createTime || new Date().toISOString()]
          );
          evtOk++;
        } catch (e) { migrationFailures.push(`活动 ${item.id}: ${e.message}`); }
      }
      console.log(`✅ 活动数据迁移完成（成功 ${evtOk}/${items.length} 条）`);
    } catch (e) { migrationFailures.push(`活动文件处理: ${e.message}`); console.error('❌ 活动迁移失败:', e.message); }
  }

  // 迁移相册
  const albFile = path.join(ROOT_DIR, 'album.json');
  if (fs.existsSync(albFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(albFile, 'utf8'));
      const items = data.photos || data;
      let albOk = 0;
      for (const item of items) {
        try {
          await pool.query(
            `INSERT IGNORE INTO album_photo (id, upload_vrcid, upload_name, photo_path, thumb_path, photo_desc, like_count, create_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [item.id, item.uploaderId || item.uploader || '', item.uploaderName || '', item.path || '', item.thumbPath || item.path || '', item.desc || item.description || '', item.likes || item.likeCount || 0, item.createTime || new Date().toISOString()]
          );
          albOk++;
        } catch (e) { migrationFailures.push(`相册 ${item.id}: ${e.message}`); }
      }
      console.log(`✅ 相册数据迁移完成（成功 ${albOk}/${items.length} 张）`);
    } catch (e) { migrationFailures.push(`相册文件处理: ${e.message}`); console.error('❌ 相册迁移失败:', e.message); }
  }

  // 优雅停机不变量：CLI 退出前必须先关闭连接池，否则 process.exit 会立即杀死
  // 底层 socket，等同于绕过优雅停机（与 server.js 的 shutdown 约定一致）。
  if (migrationFailures.length > 0) {
    console.error(`\n❌ 数据迁移未完全成功：${migrationFailures.length} 条失败`);
    migrationFailures.slice(0, 20).forEach((f) => console.error('   - ' + f));
    if (migrationFailures.length > 20) console.error(`   …另有 ${migrationFailures.length - 20} 条未列出`);
    try { await pool.end(); } catch (_) { /* 池可能已断开，忽略 */ }
    process.exit(1);
  }
  console.log('\n🎉 数据迁移完成！请手动删除根目录下的旧 JSON 文件');
  try { await pool.end(); } catch (_) { /* 池可能已断开，忽略 */ }
  process.exit(0);
}

migrate().catch(async err => {
  console.error('迁移失败:', err);
  try { if (holder.pool) await holder.pool.end(); } catch (_) { /* 池可能未建立，忽略 */ }
  process.exit(1);
});
