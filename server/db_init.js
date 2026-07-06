require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');
const { holder, DB_NAME, DB_CONFIG, recreatePool } = require('./db');

async function initDatabase() {
  // 第一步：用不带 database 的临时连接建库
  let tempConn;
  try {
    tempConn = await mysql.createConnection(DB_CONFIG);
    await tempConn.query(
      `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    console.log(`✅ 数据库 ${DB_NAME} 已就绪`);
  } catch (err) {
    console.error('❌ 建库失败:', err.message);
    throw err;
  } finally {
    if (tempConn) await tempConn.end();
  }

  // 第二步：重建连接池（带 database），然后通过 holder.pool 建表
  recreatePool();

  try {
    const tables = [
      // 管理员表
      `CREATE TABLE IF NOT EXISTS sys_admin (
        id INT AUTO_INCREMENT PRIMARY KEY,
        vrchat_id VARCHAR(100) NOT NULL UNIQUE,
        vrchat_name VARCHAR(100) NOT NULL,
        create_time DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // 操作日志表
      `CREATE TABLE IF NOT EXISTS sys_oper_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        admin_vrcid VARCHAR(100),
        oper_type VARCHAR(50) NOT NULL,
        content TEXT,
        create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_time(create_time)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // 公告表
      `CREATE TABLE IF NOT EXISTS announcement (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        content TEXT NOT NULL,
        create_admin VARCHAR(100),
        is_pinned TINYINT DEFAULT 0,
        visibility ENUM('public','members_only') DEFAULT 'public',
        create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_time(create_time)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // 活动表 V5.3 — 支持活动三态 + 生日派对
      // V5.6 — 增加 world_id/world_name/world_image_url 支持活动关联 VRChat World
      `CREATE TABLE IF NOT EXISTS event (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        place VARCHAR(255),
        event_time DATETIME NOT NULL,
        description TEXT,
        max_sign INT DEFAULT 0 COMMENT '0=不限制人数',
        event_type ENUM('activity','birthday') DEFAULT 'activity' COMMENT '活动类型',
        vrchat_event_id VARCHAR(100) NULL UNIQUE COMMENT 'VRChat日历事件ID',
        ends_at DATETIME NULL COMMENT '活动结束时间（用于状态判断）',
        create_admin VARCHAR(100),
        is_archive TINYINT DEFAULT 0,
        visibility ENUM('public','members_only') DEFAULT 'public',
        source ENUM('manual','vrchat') DEFAULT 'manual' COMMENT '活动来源',
        world_id VARCHAR(100) NULL COMMENT 'VRChat World ID',
        world_name VARCHAR(255) NULL COMMENT 'VRChat World 名称',
        world_image_url VARCHAR(500) NULL COMMENT 'VRChat World 缩略图URL',
        create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_time(event_time),
        INDEX idx_ends_at(ends_at),
        INDEX idx_archive(is_archive),
        INDEX idx_event_type(event_type),
        INDEX idx_source(source),
        INDEX idx_world_id(world_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // 活动报名表
      `CREATE TABLE IF NOT EXISTS event_sign (
        id INT AUTO_INCREMENT PRIMARY KEY,
        event_id INT NOT NULL,
        user_vrcid VARCHAR(100) NOT NULL,
        user_name VARCHAR(100) NOT NULL,
        is_sign TINYINT DEFAULT 0,
        sign_time DATETIME NULL,
        create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_event_user(event_id, user_vrcid),
        INDEX idx_event(event_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // 相册分类表
      `CREATE TABLE IF NOT EXISTS album_cate (
        id INT AUTO_INCREMENT PRIMARY KEY,
        cate_name VARCHAR(100) NOT NULL UNIQUE,
        sort INT DEFAULT 0,
        create_time DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // 相册照片表
      `CREATE TABLE IF NOT EXISTS album_photo (
        id INT AUTO_INCREMENT PRIMARY KEY,
        cate_id INT DEFAULT 1,
        event_id INT NULL COMMENT '关联活动ID',
        upload_vrcid VARCHAR(100) NOT NULL,
        upload_name VARCHAR(100) NOT NULL,
        photo_path VARCHAR(255) NOT NULL,
        thumb_path VARCHAR(255) NOT NULL,
        photo_desc TEXT,
        like_count INT DEFAULT 0,
        visibility ENUM('public','members_only') DEFAULT 'public',
        is_recycle TINYINT DEFAULT 0,
        recycle_time DATETIME NULL,
        create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_cate(cate_id),
        INDEX idx_event(event_id),
        INDEX idx_recycle(is_recycle),
        INDEX idx_time(create_time)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // 相册点赞表
      `CREATE TABLE IF NOT EXISTS album_like (
        id INT AUTO_INCREMENT PRIMARY KEY,
        photo_id INT NOT NULL,
        user_vrcid VARCHAR(100) NOT NULL,
        create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_photo_user(photo_id, user_vrcid),
        INDEX idx_photo(photo_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // 相册评论表
      `CREATE TABLE IF NOT EXISTS album_comment (
        id INT AUTO_INCREMENT PRIMARY KEY,
        photo_id INT NOT NULL,
        user_vrcid VARCHAR(100) NOT NULL,
        user_name VARCHAR(100) NOT NULL,
        comment TEXT NOT NULL,
        create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_photo(photo_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // 用户资料表 V6.6 — 基于 user_id 的完整个人资料
      `CREATE TABLE IF NOT EXISTS user_profile (
        user_id INT NOT NULL UNIQUE,
        motto VARCHAR(200) DEFAULT '' COMMENT '个性签名',
        bio TEXT COMMENT '个人简介',
        cover_image VARCHAR(500) DEFAULT '' COMMENT '主页封面图',
        location VARCHAR(200) DEFAULT '' COMMENT '所在地',
        website VARCHAR(500) DEFAULT '' COMMENT '个人网站',
        social_links JSON COMMENT '社交链接JSON',
        privacy_settings JSON COMMENT '隐私设置JSON',
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY idx_user_id (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // 用户表 V5.2 — 论坛化账号体系
      `CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        login_id VARCHAR(50) NOT NULL UNIQUE COMMENT '登录ID（不可改）',
        display_name VARCHAR(100) NOT NULL COMMENT '显示名（超管可改）',
        vrchat_id VARCHAR(100) UNIQUE COMMENT 'VRChat用户ID（一对一绑定）',
        vrchat_name VARCHAR(100) COMMENT 'VRChat显示名（hover展示）',
        password_hash VARCHAR(255) COMMENT 'bcrypt密码哈希',
        role ENUM('super_admin','admin','member') DEFAULT 'member' COMMENT '权限角色',
        vrchat_verified TINYINT DEFAULT 0 COMMENT '是否通过群组成员验证',
        avatar_type ENUM('vrchat','custom','none') DEFAULT 'none' COMMENT '头像类型',
        custom_avatar_path VARCHAR(255) COMMENT '自定义头像路径',
        vrchat_avatar_url VARCHAR(500) COMMENT 'VRChat头像URL（currentAvatarThumbnailImageUrl）',
        qq_number_enc VARCHAR(500) COMMENT 'QQ号 AES-256-CBC加密',
        birthday DATE NULL COMMENT '生日（自愿填写）',
        location VARCHAR(200) COMMENT '所在地（自愿填写）',
        lat DECIMAL(10,7) COMMENT '纬度',
        lng DECIMAL(10,7) COMMENT '经度',
        location_visible TINYINT DEFAULT 0 COMMENT '位置可见开关',
        preferences JSON COMMENT '偏好设置JSON',
        vrchat_token_enc VARCHAR(1000) COMMENT 'VRChat token AES加密（双轨登录用）',
        deleted_at DATETIME NULL COMMENT '软删除时间',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_role(role),
        INDEX idx_deleted(deleted_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // 群组成员名单（从 VRChat 同步）V6.5 — 增强在线状态追踪
      `CREATE TABLE IF NOT EXISTS group_roster (
        id INT AUTO_INCREMENT PRIMARY KEY,
        vrchat_id VARCHAR(100) NOT NULL UNIQUE,
        vrchat_name VARCHAR(100) NOT NULL,
        display_name VARCHAR(255) DEFAULT '',
        avatar_url TEXT,
        is_member TINYINT DEFAULT 1,
        is_online TINYINT DEFAULT 0,
        vrchat_status VARCHAR(50) DEFAULT 'offline',
        location VARCHAR(500) DEFAULT '',
        world_name VARCHAR(255) DEFAULT '',
        last_login DATETIME,
        last_seen DATETIME,
        joined_at DATETIME,
        left_at DATETIME,
        role_ids VARCHAR(500) DEFAULT '',
        membership_status VARCHAR(50) DEFAULT 'member',
        synced_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_online(is_online),
        INDEX idx_last_seen(last_seen),
        INDEX idx_member(is_member)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // 群组成员变更记录表 (V6.5)
      `CREATE TABLE IF NOT EXISTS group_member_changes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        vrchat_id VARCHAR(100) NOT NULL,
        vrchat_name VARCHAR(255) NOT NULL,
        change_type VARCHAR(20) NOT NULL COMMENT 'joined|left|status_change|role_change',
        old_status VARCHAR(50),
        new_status VARCHAR(50),
        detail TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_vrchat_id(vrchat_id),
        INDEX idx_type(change_type),
        INDEX idx_time(created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // 群组同步日志表 (V6.5)
      `CREATE TABLE IF NOT EXISTS group_sync_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        sync_type VARCHAR(50) NOT NULL COMMENT 'full|status|manual',
        total_members INT DEFAULT 0,
        online_count INT DEFAULT 0,
        joined_count INT DEFAULT 0,
        left_count INT DEFAULT 0,
        success TINYINT DEFAULT 1,
        error_msg TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_time(created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // 用户相册表 V6.6
      `CREATE TABLE IF NOT EXISTS user_albums (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        name VARCHAR(200) NOT NULL,
        description TEXT,
        cover_photo VARCHAR(500) DEFAULT '',
        sort INT DEFAULT 0,
        privacy ENUM('public','members_only','private') DEFAULT 'public',
        photo_count INT DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_user(user_id),
        INDEX idx_privacy(privacy)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // 用户照片表 V6.6
      `CREATE TABLE IF NOT EXISTS user_photos (
        id INT AUTO_INCREMENT PRIMARY KEY,
        album_id INT NOT NULL,
        user_id INT NOT NULL,
        photo_path VARCHAR(500) NOT NULL,
        thumb_path VARCHAR(500) DEFAULT '',
        description TEXT,
        sort INT DEFAULT 0,
        like_count INT DEFAULT 0,
        comment_count INT DEFAULT 0,
        media_type ENUM('image','video') DEFAULT 'image' COMMENT '媒体类型',
        file_size BIGINT DEFAULT 0 COMMENT '文件大小(字节)',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_album(album_id),
        INDEX idx_user(user_id),
        INDEX idx_time(created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // 用户视频表 V6.6
      `CREATE TABLE IF NOT EXISTS user_videos (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        title VARCHAR(200) NOT NULL,
        description TEXT,
        video_path VARCHAR(500) NOT NULL,
        thumb_path VARCHAR(500) DEFAULT '',
        duration INT DEFAULT 0 COMMENT '视频时长（秒）',
        file_size BIGINT DEFAULT 0 COMMENT '文件大小（字节）',
        privacy ENUM('public','members_only','private') DEFAULT 'public',
        view_count INT DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user(user_id),
        INDEX idx_privacy(privacy),
        INDEX idx_time(created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // 成员备注表
      `CREATE TABLE IF NOT EXISTS member_note (
        id INT AUTO_INCREMENT PRIMARY KEY,
        owner_vrcid VARCHAR(100) NOT NULL,
        target_vrcid VARCHAR(100) NOT NULL,
        note_text VARCHAR(200),
        update_time DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_owner_target(owner_vrcid, target_vrcid)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // 改名申请表 (V5.3)
      `CREATE TABLE IF NOT EXISTS name_change_requests (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        old_name VARCHAR(100) NOT NULL,
        new_name VARCHAR(100) NOT NULL,
        reason VARCHAR(500) DEFAULT '',
        status ENUM('pending','approved','rejected') DEFAULT 'pending',
        reviewed_by INT DEFAULT NULL,
        review_comment VARCHAR(200) DEFAULT '',
        create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        review_time DATETIME DEFAULT NULL,
        KEY idx_user_id (user_id),
        KEY idx_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

      // 权限开关表 (V5.3)
      `CREATE TABLE IF NOT EXISTS permissions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL UNIQUE,
        can_manage_announcements TINYINT(1) DEFAULT 0,
        can_manage_events TINYINT(1) DEFAULT 0,
        can_manage_album TINYINT(1) DEFAULT 0,
        can_manage_users TINYINT(1) DEFAULT 0,
        can_sync_vrchat TINYINT(1) DEFAULT 0,
        can_manage_group_images TINYINT(1) DEFAULT 0,
        can_manage_rosters TINYINT(1) DEFAULT 0,
        can_view_logs TINYINT(1) DEFAULT 0,
        can_manage_permissions TINYINT(1) DEFAULT 0,
        can_review_names TINYINT(1) DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY idx_user_id (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

      // 活动签到表 (V5.5)
      `CREATE TABLE IF NOT EXISTS event_checkin (
        id INT AUTO_INCREMENT PRIMARY KEY,
        event_id INT NOT NULL,
        user_id INT NOT NULL,
        user_name VARCHAR(100) NOT NULL,
        checkin_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_event_user (event_id, user_id),
        INDEX idx_event (event_id),
        INDEX idx_time (checkin_time)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

      // 活动评论表 (V5.4)
      `CREATE TABLE IF NOT EXISTS event_comment (
        id INT AUTO_INCREMENT PRIMARY KEY,
        event_id INT NOT NULL,
        user_id INT NOT NULL,
        user_name VARCHAR(100) NOT NULL,
        content TEXT NOT NULL,
        create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_event (event_id),
        INDEX idx_time (create_time)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

      // VRChat World 缓存表 (V5.6)
      `CREATE TABLE IF NOT EXISTS vrc_worlds_cache (
        world_id VARCHAR(100) PRIMARY KEY,
        world_name VARCHAR(255) NOT NULL,
        description TEXT,
        image_url VARCHAR(500),
        author_name VARCHAR(100),
        capacity INT DEFAULT 0,
        tags JSON,
        release_status VARCHAR(50),
        cached_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // 通知表 (V6.0)
      `CREATE TABLE IF NOT EXISTS notifications (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        type VARCHAR(50) NOT NULL DEFAULT 'system',
        title VARCHAR(255) NOT NULL,
        message TEXT,
        related_id INT DEFAULT NULL,
        is_read TINYINT(1) DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user (user_id),
        INDEX idx_user_read (user_id, is_read),
        INDEX idx_time (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // 聊天消息表 (V6.12)
      `CREATE TABLE IF NOT EXISTS messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        sender_id INT NOT NULL COMMENT '发送者用户ID',
        receiver_id INT NOT NULL COMMENT '接收者用户ID',
        content TEXT NOT NULL COMMENT '消息内容',
        is_read TINYINT(1) DEFAULT 0 COMMENT '是否已读',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        read_at DATETIME NULL COMMENT '阅读时间',
        INDEX idx_sender (sender_id),
        INDEX idx_receiver (receiver_id),
        INDEX idx_conversation (sender_id, receiver_id),
        INDEX idx_time (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // 群聊表 (V6.13)
      `CREATE TABLE IF NOT EXISTS chat_groups (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL COMMENT '群聊名称',
        creator_id INT NOT NULL COMMENT '创建者用户ID',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_creator (creator_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // 群聊成员表 (V6.13)
      `CREATE TABLE IF NOT EXISTS chat_group_members (
        id INT AUTO_INCREMENT PRIMARY KEY,
        group_id INT NOT NULL COMMENT '群聊ID',
        user_id INT NOT NULL COMMENT '用户ID',
        joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_group_user (group_id, user_id),
        INDEX idx_group (group_id),
        INDEX idx_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // 群聊消息表 (V6.13)
      `CREATE TABLE IF NOT EXISTS chat_group_messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        group_id INT NOT NULL COMMENT '群聊ID',
        sender_id INT NOT NULL COMMENT '发送者用户ID',
        content TEXT NOT NULL COMMENT '消息内容',
        msg_type VARCHAR(20) DEFAULT 'text' COMMENT '消息类型(text/location)',
        lat DECIMAL(10,7) NULL COMMENT '位置纬度',
        lng DECIMAL(10,7) NULL COMMENT '位置经度',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_group (group_id),
        INDEX idx_time (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // ==================== 权限组系统 (V6.2) ====================

      // 权限组表
      `CREATE TABLE IF NOT EXISTS permission_groups (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE,
        description VARCHAR(500) DEFAULT '',
        parent_id INT NULL,
        is_default TINYINT(1) DEFAULT 0 COMMENT '默认用户组（新用户自动加入）',
        is_system TINYINT(1) DEFAULT 0 COMMENT '系统内置组（不可删除）',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_parent (parent_id),
        INDEX idx_default (is_default)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // 权限组-权限条目表（扩展权限列表）
      `CREATE TABLE IF NOT EXISTS group_permission_entries (
        id INT AUTO_INCREMENT PRIMARY KEY,
        group_id INT NOT NULL,
        permission_key VARCHAR(100) NOT NULL COMMENT '权限键名',
        permission_value TINYINT(1) DEFAULT 0 COMMENT '0=禁止 1=允许',
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_group_perm (group_id, permission_key),
        INDEX idx_group (group_id),
        INDEX idx_key (permission_key)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // 用户-权限组归属表（多对多）
      `CREATE TABLE IF NOT EXISTS user_group_membership (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        group_id INT NOT NULL,
        joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_user_group (user_id, group_id),
        INDEX idx_user (user_id),
        INDEX idx_group (group_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (group_id) REFERENCES permission_groups(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // V6.8: 系统配置表
      `CREATE TABLE IF NOT EXISTS system_config (
        config_key VARCHAR(64) PRIMARY KEY,
        config_value TEXT,
        updated_by INT DEFAULT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // V6.9: 动态/朋友圈表
      `CREATE TABLE IF NOT EXISTS posts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        content TEXT COMMENT '文字内容',
        type ENUM('text','image','video','mixed') DEFAULT 'text' COMMENT '动态类型',
        like_count INT DEFAULT 0,
        comment_count INT DEFAULT 0,
        is_pinned TINYINT DEFAULT 0 COMMENT '是否置顶',
        visibility ENUM('public','members_only','private') DEFAULT 'members_only',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_user(user_id),
        INDEX idx_time(created_at),
        INDEX idx_visibility(visibility)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // V6.9: 动态媒体表（图片/视频）
      `CREATE TABLE IF NOT EXISTS post_media (
        id INT AUTO_INCREMENT PRIMARY KEY,
        post_id INT NOT NULL,
        user_id INT NOT NULL,
        media_type ENUM('image','video') NOT NULL,
        media_url VARCHAR(500) NOT NULL,
        thumb_url VARCHAR(500) DEFAULT '' COMMENT '视频缩略图/图片缩略图',
        width INT DEFAULT 0,
        height INT DEFAULT 0,
        file_size INT DEFAULT 0,
        sort INT DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_post(post_id),
        INDEX idx_user(user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // V6.9: 动态点赞表
      `CREATE TABLE IF NOT EXISTS post_like (
        id INT AUTO_INCREMENT PRIMARY KEY,
        post_id INT NOT NULL,
        user_id INT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_post_user(post_id, user_id),
        INDEX idx_post(post_id),
        INDEX idx_user(user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // V6.9: 动态评论表
      `CREATE TABLE IF NOT EXISTS post_comment (
        id INT AUTO_INCREMENT PRIMARY KEY,
        post_id INT NOT NULL,
        user_id INT NOT NULL,
        parent_id INT DEFAULT 0 COMMENT '回复评论ID（0=顶级评论）',
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_post(post_id),
        INDEX idx_user(user_id),
        INDEX idx_parent(parent_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    ];

    for (const sql of tables) {
      await holder.pool.query(sql);
    }

    // V6.5: 为现有 group_roster 表添加新列（兼容旧表）
    const rosterCols = [
      `ALTER TABLE group_roster ADD COLUMN display_name VARCHAR(255) DEFAULT ''`,
      `ALTER TABLE group_roster ADD COLUMN avatar_url TEXT`,
      `ALTER TABLE group_roster ADD COLUMN is_online TINYINT DEFAULT 0`,
      `ALTER TABLE group_roster ADD COLUMN vrchat_status VARCHAR(50) DEFAULT 'offline'`,
      `ALTER TABLE group_roster ADD COLUMN location VARCHAR(500) DEFAULT ''`,
      `ALTER TABLE group_roster ADD COLUMN world_name VARCHAR(255) DEFAULT ''`,
      `ALTER TABLE group_roster ADD COLUMN last_login DATETIME`,
      `ALTER TABLE group_roster ADD COLUMN last_seen DATETIME`,
      `ALTER TABLE group_roster ADD COLUMN joined_at DATETIME`,
      `ALTER TABLE group_roster ADD COLUMN left_at DATETIME`,
      `ALTER TABLE group_roster ADD COLUMN role_ids VARCHAR(500) DEFAULT ''`,
      `ALTER TABLE group_roster ADD COLUMN membership_status VARCHAR(50) DEFAULT 'member'`,
    ];
    // MySQL 5.7 不支持 ADD COLUMN IF NOT EXISTS，用 try/catch 忽略已存在错误
    for (const sql of rosterCols) {
      try { await holder.pool.query(sql); } catch (e) {
        if (e.errno === 1060 || e.code === 'ER_DUP_FIELDNAME') { /* column exists */ }
        else { console.warn('  ⚠️ roster migration:', e.message); }
      }
    }
    // Add indexes if missing (MySQL 5.7)
    const rosterIndexes = [
      `ALTER TABLE group_roster ADD INDEX idx_online(is_online)`,
      `ALTER TABLE group_roster ADD INDEX idx_last_seen(last_seen)`,
      `ALTER TABLE group_roster ADD INDEX idx_member(is_member)`,
    ];
    for (const sql of rosterIndexes) {
      try { await holder.pool.query(sql); } catch (e) {
        if (e.errno === 1061 || e.code === 'ER_DUP_KEYNAME') { /* index exists */ }
        else { console.warn('  ⚠️ roster index:', e.message); }
      }
    }

    // V6.6: 为 users 表添加安全列（使用 try/catch 兼容 MySQL 5.7）
    const usersSecurityCols = [
      `ALTER TABLE users ADD COLUMN approved TINYINT DEFAULT 0`,
      `ALTER TABLE users ADD COLUMN banned TINYINT DEFAULT 0`,
      `ALTER TABLE users ADD COLUMN failed_login_attempts INT DEFAULT 0`,
      `ALTER TABLE users ADD COLUMN locked_until DATETIME NULL`,
    ];
    for (const sql of usersSecurityCols) {
      try { await holder.pool.query(sql); } catch (e) {
        if (e.errno === 1060 || e.code === 'ER_DUP_FIELDNAME') { /* column exists */ }
        else { console.warn('  ⚠️ users security migration:', e.message); }
      }
    }

    // 插入默认相册分类
    await holder.pool.query(`INSERT IGNORE INTO album_cate (id, cate_name, sort) VALUES (1, '默认相册', 0)`);

    // ==================== 初始化默认权限组 ====================
    // 超级管理员组（系统内置，不可删除）
    await holder.pool.query(
      `INSERT IGNORE INTO permission_groups (id, name, description, parent_id, is_default, is_system) VALUES (1, '超级管理员', '拥有全部权限', NULL, 0, 1)`
    );
    // 管理员组（系统内置，不可删除）
    await holder.pool.query(
      `INSERT IGNORE INTO permission_groups (id, name, description, parent_id, is_default, is_system) VALUES (2, '管理员', '常规管理权限', 1, 0, 1)`
    );
    // 成员组（默认用户组，新注册用户自动加入）
    await holder.pool.query(
      `INSERT IGNORE INTO permission_groups (id, name, description, parent_id, is_default, is_system) VALUES (3, '成员', '普通成员基本权限', 2, 1, 1)`
    );

    // 插入默认权限条目
    const allPermissions = [
      'can_create_album', 'can_create_photo', 'can_delete_photo',
      'can_create_announcement', 'can_edit_announcement', 'can_delete_announcement',
      'can_create_event', 'can_edit_event', 'can_delete_event',
      'can_sign_event', 'can_comment_event',
      'can_manage_users', 'can_manage_roles',
      'can_review_names', 'can_manage_permissions',
      'can_sync_vrchat', 'can_manage_rosters',
      'can_view_logs', 'can_upload_group_image',
      'can_edit_profile', 'can_change_password',
      'can_view_members', 'can_view_map',
      'can_view_album', 'can_view_events',
      'can_create_album_category',
      // V6.9: 动态/朋友圈权限
      'can_create_post', 'can_delete_post', 'can_comment_post', 'can_like_post'
    ];

    // 超级管理员组 = 全部允许
    for (const key of allPermissions) {
      await holder.pool.query(
        `INSERT IGNORE INTO group_permission_entries (group_id, permission_key, permission_value) VALUES (1, ?, 1)`, [key]
      );
    }

    // 管理员组 = 大部分允许（除超管专属）
    const adminPerms = allPermissions.filter(k => !['can_manage_permissions', 'can_manage_roles'].includes(k));
    for (const key of adminPerms) {
      await holder.pool.query(
        `INSERT IGNORE INTO group_permission_entries (group_id, permission_key, permission_value) VALUES (2, ?, 1)`, [key]
      );
    }

    // 成员组 = 基础权限
    const memberPerms = ['can_create_photo', 'can_sign_event', 'can_comment_event',
      'can_edit_profile', 'can_change_password', 'can_view_members', 'can_view_map',
      'can_view_album', 'can_view_events', 'can_create_album',
      'can_create_post', 'can_comment_post', 'can_like_post'];
    for (const key of memberPerms) {
      await holder.pool.query(
        `INSERT IGNORE INTO group_permission_entries (group_id, permission_key, permission_value) VALUES (3, ?, 1)`, [key]
      );
    }

    // 检查已有用户并自动加入默认组
    const [existingMembers] = await holder.pool.query(
      `SELECT id FROM users WHERE deleted_at IS NULL AND id NOT IN (SELECT user_id FROM user_group_membership)`
    );
    for (const u of existingMembers) {
      // 超级管理员加入组1，管理员加入组2，普通用户加入组3
      const [roleCheck] = await holder.pool.query(`SELECT role FROM users WHERE id = ?`, [u.id]);
      let gid = 3; // 默认成员组
      if (roleCheck.length > 0) {
        if (roleCheck[0].role === 'super_admin') gid = 1;
        else if (roleCheck[0].role === 'admin') gid = 2;
      }
      await holder.pool.query(
        `INSERT IGNORE INTO user_group_membership (user_id, group_id) VALUES (?, ?)`, [u.id, gid]
      );
    }

    // V6.9.1: album_photo 表加 video 支持字段
    const albumPhotoVideoCols = [
      `ALTER TABLE album_photo ADD COLUMN media_type ENUM('image','video') DEFAULT 'image' COMMENT '媒体类型'`,
      `ALTER TABLE album_photo ADD COLUMN file_size BIGINT DEFAULT 0 COMMENT '文件大小(字节)'`,
    ];
    for (const sql of albumPhotoVideoCols) {
      try { await holder.pool.query(sql); } catch (e) {
        if (e.errno === 1060 || e.code === 'ER_DUP_FIELDNAME') { /* column exists */ }
        else { console.warn('  ⚠️ album_photo video migration:', e.message); }
      }
    }

    // V6.10: user_photos 表加 video 支持字段（个人主页相册混合上传）
    const userPhotosVideoCols = [
      `ALTER TABLE user_photos ADD COLUMN media_type ENUM('image','video') DEFAULT 'image' COMMENT '媒体类型'`,
      `ALTER TABLE user_photos ADD COLUMN file_size BIGINT DEFAULT 0 COMMENT '文件大小(字节)'`,
    ];
    for (const sql of userPhotosVideoCols) {
      try { await holder.pool.query(sql); } catch (e) {
        if (e.errno === 1060 || e.code === 'ER_DUP_FIELDNAME') { /* column exists */ }
        else { console.warn('  ⚠️ user_photos video migration:', e.message); }
      }
    }

    // V6.11: users 表加 location_updated_at 列（实时位置追踪时间戳）
    const userLocationCols = [
      `ALTER TABLE users ADD COLUMN location_updated_at DATETIME NULL COMMENT '位置最后更新时间'`,
    ];
    for (const sql of userLocationCols) {
      try { await holder.pool.query(sql); } catch (e) {
        if (e.errno === 1060 || e.code === 'ER_DUP_FIELDNAME') { /* column exists */ }
        else { console.warn('  ⚠️ user location migration:', e.message); }
      }
    }

    // V6.8: 插入默认系统配置
    const defaultConfigs = [
      ['site_name', '境途同游'],
      ['allow_register', '1'],
      ['allow_guest_view', '1'],
      ['require_approval', '1'],
      ['site_notice', ''],
      ['contact_email', ''],
      ['max_photo_upload', '10'],
      ['max_video_size_mb', '200'],
      // V6.8: Hero 装修配置
      ['hero_title', '境途同游'],
      ['hero_subtitle', 'JingTu Travel · VRChat Group'],
      ['hero_description', '在虚拟世界相遇，在现实世界同行'],
      ['hero_bg_url', '/assets/group-hero.png'],
      // V6.9: 更多 Hero 自定义
      ['hero_bg_color', '#0a0a1a'],
      ['hero_bg_overlay_opacity', '0.6'],
      ['hero_accent_color', '#7c5cfc'],
      ['hero_show_stats', '1'],
      ['hero_show_badge', '1'],
      ['hero_badge_text', '🌐 VRChat Group'],
      ['hero_animation', 'fade-in'],
      ['posts_per_page', '20'],
      ['post_max_images', '9'],
      ['post_max_videos', '3'],
      ['post_video_max_size_mb', '200'],
    ];
    for (const [key, val] of defaultConfigs) {
      await holder.pool.query(
        `INSERT IGNORE INTO system_config (config_key, config_value) VALUES (?, ?)`, [key, val]
      );
    }

    console.log('✅ 数据库初始化完成（21张表 + 默认数据）');
  } catch (err) {
    console.error('❌ 建表失败:', err.message);
    throw err;
  }
}

module.exports = initDatabase;
