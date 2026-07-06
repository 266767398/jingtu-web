const fs = require('fs');
const path = require('path');
const { pool } = require('./db');
const initDatabase = require('./db_init');

const ROOT_DIR = path.join(__dirname, '..');

async function migrate() {
  console.log('🔄 开始数据迁移...\n');
  await initDatabase();

  // 迁移管理员
  const adminFile = path.join(ROOT_DIR, 'admin.json');
  if (fs.existsSync(adminFile)) {
    try {
      const admins = JSON.parse(fs.readFileSync(adminFile, 'utf8'));
      for (const admin of admins.admins || admins) {
        const id = admin.userId || admin.id;
        const name = admin.displayName || admin.name || id;
        if (id) {
          await pool.query(`INSERT IGNORE INTO sys_admin (vrchat_id, vrchat_name) VALUES (?, ?)`, [id, name]);
        }
      }
      console.log('✅ 管理员数据迁移完成');
    } catch (e) { console.log('⚠️ 管理员迁移跳过:', e.message); }
  }

  // 迁移公告
  const annFile = path.join(ROOT_DIR, 'announcements.json');
  if (fs.existsSync(annFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(annFile, 'utf8'));
      const items = data.announcements || data;
      for (const item of items) {
        await pool.query(
          `INSERT IGNORE INTO announcement (id, title, content, create_admin, create_time) VALUES (?, ?, ?, ?, ?)`,
          [item.id, item.title, item.content, item.createAdmin || item.admin || '', item.createTime || new Date().toISOString()]
        );
      }
      console.log(`✅ 公告数据迁移完成（${items.length} 条）`);
    } catch (e) { console.log('⚠️ 公告迁移跳过:', e.message); }
  }

  // 迁移活动
  const evtFile = path.join(ROOT_DIR, 'events.json');
  if (fs.existsSync(evtFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(evtFile, 'utf8'));
      const items = data.events || data;
      for (const item of items) {
        await pool.query(
          `INSERT IGNORE INTO event (id, title, place, event_time, description, create_admin, create_time) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [item.id, item.title, item.place || '', item.eventTime || item.time || new Date().toISOString(), item.description || item.desc || '', item.createAdmin || item.admin || '', item.createTime || new Date().toISOString()]
        );
      }
      console.log(`✅ 活动数据迁移完成（${items.length} 条）`);
    } catch (e) { console.log('⚠️ 活动迁移跳过:', e.message); }
  }

  // 迁移相册
  const albFile = path.join(ROOT_DIR, 'album.json');
  if (fs.existsSync(albFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(albFile, 'utf8'));
      const items = data.photos || data;
      for (const item of items) {
        await pool.query(
          `INSERT IGNORE INTO album_photo (id, upload_vrcid, upload_name, photo_path, thumb_path, photo_desc, like_count, create_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [item.id, item.uploaderId || item.uploader || '', item.uploaderName || '', item.path || '', item.thumbPath || item.path || '', item.desc || item.description || '', item.likes || item.likeCount || 0, item.createTime || new Date().toISOString()]
        );
      }
      console.log(`✅ 相册数据迁移完成（${items.length} 张）`);
    } catch (e) { console.log('⚠️ 相册迁移跳过:', e.message); }
  }

  console.log('\n🎉 数据迁移完成！请手动删除根目录下的旧 JSON 文件');
  process.exit(0);
}

migrate().catch(err => { console.error('迁移失败:', err); process.exit(1); });
