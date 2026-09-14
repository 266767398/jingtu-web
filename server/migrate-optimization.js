require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');
const { DB_CONFIG } = require('./db');

async function runMigration() {
  console.log('🚀 开始数据库优化迁移...');

  // P2-77：旧实现在连接池上执行 `SET FOREIGN_KEY_CHECKS = 0`——池级 query 只落在
  // 某一条连接上且状态随归还污染后续业务，属无效「表演」。本脚本全部是
  // ADD INDEX 类 DDL，不触碰外键约束，直接删除该逻辑并改用专用连接执行。
  let conn = null;
  let failCount = 0;
  try {
    conn = await mysql.createConnection({ ...DB_CONFIG, connectTimeout: 10000 });

    const migrations = [];

    // ==================== 索引优化 ====================
    console.log('\n📌 阶段1: 添加复合索引');

    // 聊天消息表复合索引
    migrations.push(`ALTER TABLE messages ADD INDEX idx_conv_read (sender_id, receiver_id, is_read)`);
    migrations.push(`ALTER TABLE messages ADD INDEX idx_msg_time (created_at, deleted_at)`);
    
    // 群聊消息表复合索引
    migrations.push(`ALTER TABLE chat_group_messages ADD INDEX idx_group_time (group_id, created_at, deleted_at)`);
    migrations.push(`ALTER TABLE chat_group_messages ADD INDEX idx_sender_group (sender_id, group_id)`);
    
    // 动态表复合索引
    migrations.push(`ALTER TABLE posts ADD INDEX idx_post_user_time (user_id, created_at)`);
    migrations.push(`ALTER TABLE posts ADD INDEX idx_post_visibility (visibility, created_at)`);
    
    // 动态评论表复合索引
    migrations.push(`ALTER TABLE post_comment ADD INDEX idx_comment_post_time (post_id, created_at)`);
    migrations.push(`ALTER TABLE post_comment ADD INDEX idx_comment_user (user_id, post_id)`);
    
    // 活动表复合索引
    migrations.push(`ALTER TABLE event ADD INDEX idx_event_archive_time (is_archive, event_time)`);
    migrations.push(`ALTER TABLE event ADD INDEX idx_event_visibility (visibility, event_time)`);
    
    // 活动评论表复合索引
    migrations.push(`ALTER TABLE event_comment ADD INDEX idx_ecomment_event_time (event_id, created_at)`);
    migrations.push(`ALTER TABLE event_comment ADD INDEX idx_ecomment_user (user_id, event_id)`);
    
    // 活动报名表复合索引
    migrations.push(`ALTER TABLE event_sign ADD INDEX idx_sign_event_user (event_id, user_vrcid)`);
    migrations.push(`ALTER TABLE event_sign ADD INDEX idx_sign_status (event_id, is_sign)`);
    
    // 相册照片表复合索引
    migrations.push(`ALTER TABLE album_photo ADD INDEX idx_photo_cate_time (cate_id, create_time)`);
    migrations.push(`ALTER TABLE album_photo ADD INDEX idx_photo_recycle (is_recycle, create_time)`);
    migrations.push(`ALTER TABLE album_photo ADD INDEX idx_photo_event (event_id, visibility)`);
    
    // 相册点赞表复合索引
    migrations.push(`ALTER TABLE album_like ADD INDEX idx_alike_user (user_vrcid, photo_id)`);
    
    // 相册评论表复合索引
    migrations.push(`ALTER TABLE album_comment ADD INDEX idx_acomment_user (user_vrcid, photo_id)`);
    
    // 用户标签相关索引
    migrations.push(`ALTER TABLE user_like ADD INDEX idx_ulike_date (to_user_id, like_date)`);
    
    // VRC同步日志索引
    migrations.push(`ALTER TABLE group_sync_log ADD INDEX idx_sync_type_time (sync_type, created_at)`);
    
    // 用户表复合索引
    migrations.push(`ALTER TABLE users ADD INDEX idx_user_role_deleted (role, deleted_at)`);
    migrations.push(`ALTER TABLE users ADD INDEX idx_user_vrcid (vrchat_id, deleted_at)`);
    
    // 群聊成员表复合索引
    migrations.push(`ALTER TABLE chat_group_members ADD INDEX idx_gmember_user (user_id, group_id)`);
    
    // 通知表复合索引
    migrations.push(`ALTER TABLE notifications ADD INDEX idx_notify_user_read (user_id, is_read, created_at)`);
    
    // 用户照片/视频复合索引
    migrations.push(`ALTER TABLE user_photos ADD INDEX idx_up_user_time (user_id, created_at)`);
    migrations.push(`ALTER TABLE user_videos ADD INDEX idx_uv_user_time (user_id, created_at)`);

    // ==================== 外键约束 ====================
    console.log('\n📌 阶段2: 添加外键约束');

    // users 表关联
    migrations.push(`ALTER TABLE user_profile ADD CONSTRAINT fk_profile_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`);
    migrations.push(`ALTER TABLE permissions ADD CONSTRAINT fk_perm_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`);
    migrations.push(`ALTER TABLE name_change_requests ADD CONSTRAINT fk_ncr_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`);
    migrations.push(`ALTER TABLE name_change_requests ADD CONSTRAINT fk_ncr_reviewer FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL`);

    // 聊天相关外键
    migrations.push(`ALTER TABLE messages ADD CONSTRAINT fk_msg_sender FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE`);
    migrations.push(`ALTER TABLE messages ADD CONSTRAINT fk_msg_receiver FOREIGN KEY (receiver_id) REFERENCES users(id) ON DELETE CASCADE`);
    migrations.push(`ALTER TABLE chat_groups ADD CONSTRAINT fk_chat_creator FOREIGN KEY (creator_id) REFERENCES users(id) ON DELETE CASCADE`);
    migrations.push(`ALTER TABLE chat_group_members ADD CONSTRAINT fk_gmember_group FOREIGN KEY (group_id) REFERENCES chat_groups(id) ON DELETE CASCADE`);
    migrations.push(`ALTER TABLE chat_group_members ADD CONSTRAINT fk_gmember_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`);
    migrations.push(`ALTER TABLE chat_group_messages ADD CONSTRAINT fk_gmsg_group FOREIGN KEY (group_id) REFERENCES chat_groups(id) ON DELETE CASCADE`);
    migrations.push(`ALTER TABLE chat_group_messages ADD CONSTRAINT fk_gmsg_sender FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE`);
    migrations.push(`ALTER TABLE chat_group_message_reads ADD CONSTRAINT fk_gread_group FOREIGN KEY (group_id) REFERENCES chat_groups(id) ON DELETE CASCADE`);
    migrations.push(`ALTER TABLE chat_group_message_reads ADD CONSTRAINT fk_gread_message FOREIGN KEY (message_id) REFERENCES chat_group_messages(id) ON DELETE CASCADE`);
    migrations.push(`ALTER TABLE chat_group_message_reads ADD CONSTRAINT fk_gread_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`);

    // 动态相关外键
    migrations.push(`ALTER TABLE posts ADD CONSTRAINT fk_post_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`);
    migrations.push(`ALTER TABLE post_media ADD CONSTRAINT fk_pmedia_post FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE`);
    migrations.push(`ALTER TABLE post_like ADD CONSTRAINT fk_plike_post FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE`);
    migrations.push(`ALTER TABLE post_like ADD CONSTRAINT fk_plike_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`);
    migrations.push(`ALTER TABLE post_comment ADD CONSTRAINT fk_pcomment_post FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE`);
    migrations.push(`ALTER TABLE post_comment ADD CONSTRAINT fk_pcomment_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`);

    // 活动相关外键
    migrations.push(`ALTER TABLE event_sign ADD CONSTRAINT fk_esign_event FOREIGN KEY (event_id) REFERENCES event(id) ON DELETE CASCADE`);
    migrations.push(`ALTER TABLE event_checkin ADD CONSTRAINT fk_echeckin_event FOREIGN KEY (event_id) REFERENCES event(id) ON DELETE CASCADE`);
    migrations.push(`ALTER TABLE event_checkin ADD CONSTRAINT fk_echeckin_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`);
    migrations.push(`ALTER TABLE event_comment ADD CONSTRAINT fk_ecomment_event FOREIGN KEY (event_id) REFERENCES event(id) ON DELETE CASCADE`);
    migrations.push(`ALTER TABLE event_comment ADD CONSTRAINT fk_ecomment_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`);

    // 相册相关外键
    migrations.push(`ALTER TABLE album_photo ADD CONSTRAINT fk_photo_cate FOREIGN KEY (cate_id) REFERENCES album_cate(id) ON DELETE SET DEFAULT`);
    migrations.push(`ALTER TABLE album_like ADD CONSTRAINT fk_alike_photo FOREIGN KEY (photo_id) REFERENCES album_photo(id) ON DELETE CASCADE`);
    migrations.push(`ALTER TABLE album_comment ADD CONSTRAINT fk_acomment_photo FOREIGN KEY (photo_id) REFERENCES album_photo(id) ON DELETE CASCADE`);

    // 用户照片/视频外键
    migrations.push(`ALTER TABLE user_albums ADD CONSTRAINT fk_ualbum_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`);
    migrations.push(`ALTER TABLE user_photos ADD CONSTRAINT fk_up_album FOREIGN KEY (album_id) REFERENCES user_albums(id) ON DELETE CASCADE`);
    migrations.push(`ALTER TABLE user_photos ADD CONSTRAINT fk_up_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`);
    migrations.push(`ALTER TABLE user_videos ADD CONSTRAINT fk_uv_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`);

    // 通知外键
    migrations.push(`ALTER TABLE notifications ADD CONSTRAINT fk_notify_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`);

    // 权限组外键
    migrations.push(`ALTER TABLE group_permission_entries ADD CONSTRAINT fk_gpe_group FOREIGN KEY (group_id) REFERENCES permission_groups(id) ON DELETE CASCADE`);

    // 用户点赞外键（已存在，跳过）

    // ==================== 冷热数据分表 ====================
    console.log('\n📌 阶段3: 创建归档表');

    // 聊天消息归档表
    migrations.push(`CREATE TABLE IF NOT EXISTS messages_archive LIKE messages`);
    migrations.push(`ALTER TABLE messages_archive ADD COLUMN archived_at DATETIME DEFAULT CURRENT_TIMESTAMP`);
    
    // 群聊消息归档表
    migrations.push(`CREATE TABLE IF NOT EXISTS chat_group_messages_archive LIKE chat_group_messages`);
    migrations.push(`ALTER TABLE chat_group_messages_archive ADD COLUMN archived_at DATETIME DEFAULT CURRENT_TIMESTAMP`);
    
    // 动态归档表
    migrations.push(`CREATE TABLE IF NOT EXISTS posts_archive LIKE posts`);
    migrations.push(`ALTER TABLE posts_archive ADD COLUMN archived_at DATETIME DEFAULT CURRENT_TIMESTAMP`);
    
    // 活动归档表
    migrations.push(`CREATE TABLE IF NOT EXISTS event_archive LIKE event`);
    migrations.push(`ALTER TABLE event_archive ADD COLUMN archived_at DATETIME DEFAULT CURRENT_TIMESTAMP`);
    
    // VRC同步日志归档表
    migrations.push(`CREATE TABLE IF NOT EXISTS group_sync_log_archive LIKE group_sync_log`);
    migrations.push(`ALTER TABLE group_sync_log_archive ADD COLUMN archived_at DATETIME DEFAULT CURRENT_TIMESTAMP`);

    // ==================== 新功能表结构 ====================
    console.log('\n📌 阶段4: 创建新功能表');

    // VRC世界收藏夹
    migrations.push(`CREATE TABLE IF NOT EXISTS world_favorites (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      world_id VARCHAR(64) NOT NULL,
      world_name VARCHAR(255) DEFAULT '',
      image_url VARCHAR(512) DEFAULT '',
      is_recommended TINYINT DEFAULT 0,
      recommended_by INT DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_wf_user (user_id),
      INDEX idx_wf_world (world_id),
      INDEX idx_wf_recommended (is_recommended)
    )`);

    // VRC模型收藏夹
    migrations.push(`CREATE TABLE IF NOT EXISTS avatar_favorites (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      avatar_id VARCHAR(64) NOT NULL,
      avatar_name VARCHAR(255) DEFAULT '',
      image_url VARCHAR(512) DEFAULT '',
      is_recommended TINYINT DEFAULT 0,
      recommended_by INT DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_af_user (user_id),
      INDEX idx_af_avatar (avatar_id),
      INDEX idx_af_recommended (is_recommended)
    )`);

    // 活动组队表
    migrations.push(`CREATE TABLE IF NOT EXISTS event_teams (
      id INT AUTO_INCREMENT PRIMARY KEY,
      event_id INT NOT NULL,
      name VARCHAR(100) NOT NULL,
      leader_id INT NOT NULL,
      max_members INT DEFAULT 5,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_et_event (event_id),
      INDEX idx_et_leader (leader_id)
    )`);

    // 活动组队成员表
    migrations.push(`CREATE TABLE IF NOT EXISTS event_team_members (
      id INT AUTO_INCREMENT PRIMARY KEY,
      team_id INT NOT NULL,
      user_id INT NOT NULL,
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_etm_team (team_id),
      INDEX idx_etm_user (user_id)
    )`);

    // 群聊离线摘要表
    migrations.push(`CREATE TABLE IF NOT EXISTS chat_offline_summary (
      id INT AUTO_INCREMENT PRIMARY KEY,
      group_id INT NOT NULL,
      summary_data TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_cos_group (group_id),
      INDEX idx_cos_updated (updated_at)
    )`);

    // 新功能外键约束
    migrations.push(`ALTER TABLE world_favorites ADD CONSTRAINT fk_wf_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`);
    migrations.push(`ALTER TABLE world_favorites ADD CONSTRAINT fk_wf_recommender FOREIGN KEY (recommended_by) REFERENCES users(id) ON DELETE SET NULL`);
    migrations.push(`ALTER TABLE avatar_favorites ADD CONSTRAINT fk_af_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`);
    migrations.push(`ALTER TABLE avatar_favorites ADD CONSTRAINT fk_af_recommender FOREIGN KEY (recommended_by) REFERENCES users(id) ON DELETE SET NULL`);
    migrations.push(`ALTER TABLE event_teams ADD CONSTRAINT fk_et_event FOREIGN KEY (event_id) REFERENCES event(id) ON DELETE CASCADE`);
    migrations.push(`ALTER TABLE event_teams ADD CONSTRAINT fk_et_leader FOREIGN KEY (leader_id) REFERENCES users(id) ON DELETE CASCADE`);
    migrations.push(`ALTER TABLE event_team_members ADD CONSTRAINT fk_etm_team FOREIGN KEY (team_id) REFERENCES event_teams(id) ON DELETE CASCADE`);
    migrations.push(`ALTER TABLE event_team_members ADD CONSTRAINT fk_etm_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`);
    migrations.push(`ALTER TABLE chat_offline_summary ADD CONSTRAINT fk_cos_group FOREIGN KEY (group_id) REFERENCES chat_groups(id) ON DELETE CASCADE`);

    // ==================== 执行迁移 ====================
    let successCount = 0;
    let skipCount = 0;

    for (const sql of migrations) {
      try {
        await conn.query(sql);
        successCount++;
        console.log(`  ✓ ${sql.substring(0, 80)}${sql.length > 80 ? '...' : ''}`);
      } catch (e) {
        if (e.errno === 1061 || e.code === 'ER_DUP_KEYNAME' || 
            e.errno === 1022 || e.code === 'ER_DUP_FK' ||
            e.errno === 1050 || e.code === 'ER_TABLE_EXISTS_ERROR') {
          skipCount++;
          console.log(`  ⚠️ 已存在，跳过: ${sql.substring(0, 60)}...`);
        } else {
          failCount++;
          console.log(`  ✗ 失败: ${sql.substring(0, 60)}... - ${e.message}`);
        }
      }
    }

    console.log('\n🔒 外键约束保持默认开启（本迁移不涉及外键变更）');

    console.log(`\n=================== 迁移结果 ====================`);
    console.log(`成功: ${successCount}`);
    console.log(`跳过（已存在）: ${skipCount}`);
    console.log(`失败: ${failCount}`);

    if (failCount === 0) {
      console.log('\n✅ 数据库优化迁移完成！');
    } else {
      console.log(`\n⚠️ 迁移完成，但有 ${failCount} 项失败，请检查日志`);
    }

  } catch (e) {
    console.error('❌ 迁移过程出错:', e.message);
    failCount++;
  } finally {
    if (conn) { try { await conn.end(); } catch (_) {} }
  }
  // P2-77：存在失败项时以非零码退出，供 CI / shell 链路感知；同时关闭连接让进程可退出。
  process.exit(failCount === 0 ? 0 : 1);
}

runMigration();
