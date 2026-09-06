const mysql = require('mysql2/promise');
const path = require('path');
const { holder, DB_NAME, DB_CONFIG, recreatePool } = require('./db');

async function initDatabase() {
  // 第一步：用不带 database 的临时连接建库
  let tempConn;
  const maxRetries = 3;
  let lastError = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      tempConn = await mysql.createConnection({
        ...DB_CONFIG,
        connectTimeout: 10000
      });
      await tempConn.query(
        `CREATE DATABASE IF NOT EXISTS \`${holder.dbName}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
      );
      console.log(`✅ 数据库 ${holder.dbName} 已就绪`);
      if (tempConn) await tempConn.end();
      break;
    } catch (err) {
      lastError = err;
      if (tempConn) {
        try { await tempConn.end(); } catch (e) { console.warn('  关闭临时连接失败:', e.message); }
      }
      console.warn(`⚠️ 数据库连接尝试 ${attempt}/${maxRetries} 失败: ${err.message}`);
      if (attempt < maxRetries) {
        console.log(`⏳ 等待 ${attempt * 2} 秒后重试...`);
        await new Promise(r => setTimeout(r, attempt * 2000));
      }
    }
  }
  
  if (lastError && !tempConn) {
    console.error('❌ 建库失败:', lastError.message);
    console.error('   请检查 .env 文件中的数据库配置是否正确：');
    console.error('   MYSQL_HOST:', DB_CONFIG.host);
    console.error('   MYSQL_USER:', DB_CONFIG.user);
    console.error('   MYSQL_DATABASE:', DB_NAME);
    console.error('   错误类型:', lastError.code || 'UNKNOWN');
    throw lastError;
  }

  // 第二步：重建连接池（带 database），然后通过 holder.pool 建表
  recreatePool();

  try {
    await holder.pool.query(`SET FOREIGN_KEY_CHECKS = 0`);
    console.log('🔓 已临时禁用外键约束检查');

    const tables = [
      // 密码重置token表
      `CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id INT AUTO_INCREMENT PRIMARY KEY,
        token VARCHAR(64) NOT NULL UNIQUE,
        user_id INT NOT NULL,
        code VARCHAR(6) NOT NULL,
        expire_at DATETIME NOT NULL,
        used TINYINT(1) DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_token(token),
        INDEX idx_user_id(user_id),
        INDEX idx_expire_at(expire_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

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

      // 公告附件表
      `CREATE TABLE IF NOT EXISTS announcement_attachments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        announcement_id INT NOT NULL,
        filename VARCHAR(255) NOT NULL,
        url VARCHAR(500) NOT NULL,
        file_size INT DEFAULT 0,
        mime_type VARCHAR(100) DEFAULT '',
        create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_announcement(announcement_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // 公告历史版本表
      `CREATE TABLE IF NOT EXISTS announcement_history (
        id INT AUTO_INCREMENT PRIMARY KEY,
        announcement_id INT NOT NULL,
        version INT NOT NULL,
        title VARCHAR(255) NOT NULL,
        content TEXT NOT NULL,
        create_admin VARCHAR(100),
        create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_announcement(announcement_id),
        UNIQUE KEY uk_announcement_version(announcement_id, version)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // 活动表 V5.3 — 支持活动三态 + 生日派对
      // V5.6 — 增加 world_id/world_name/world_image_url 支持活动关联 VRChat World
      // V6.37 — 增加 instance_id 支持事件与实例关联
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
        instance_id VARCHAR(200) NULL COMMENT 'VRChat实例ID（事件与实例关联）',
        instance_type VARCHAR(50) NULL COMMENT '实例类型: public/private/group',
        create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_time(event_time),
        INDEX idx_ends_at(ends_at),
        INDEX idx_archive(is_archive),
        INDEX idx_event_type(event_type),
        INDEX idx_source(source),
        INDEX idx_world_id(world_id),
        INDEX idx_visibility(visibility),
        INDEX idx_create_admin(create_admin),
        INDEX idx_instance(instance_id)
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
        avatar_type ENUM('vrchat','custom','none') DEFAULT 'none' COMMENT '头像类型（选哪种：VRChat/本地/无）',
        custom_avatar_path VARCHAR(255) COMMENT '自定义头像路径',
        vrchat_avatar_url VARCHAR(500) COMMENT 'VRChat头像URL（currentAvatarThumbnailImageUrl）',
        avatar_visible TINYINT DEFAULT 1 COMMENT '头像是否显示（1=显示，0=隐藏；与 avatar_type 选哪种解耦）',
        qq_number_enc VARCHAR(500) COMMENT 'QQ号 AES-256-CBC加密',
        birthday DATE NULL COMMENT '生日（自愿填写）',
        location VARCHAR(200) COMMENT '所在地（自愿填写）',
        lat DECIMAL(10,7) COMMENT '纬度',
        lng DECIMAL(10,7) COMMENT '经度',
        location_visible TINYINT DEFAULT 0 COMMENT '位置可见开关',
        preferences JSON COMMENT '偏好设置JSON',
        vrchat_token_enc VARCHAR(1000) COMMENT 'VRChat token AES加密（双轨登录用）',
        notification_settings JSON COMMENT '通知设置JSON（email/browser/sound）',
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
        avatar_id VARCHAR(100) DEFAULT '' COMMENT 'VRChat Avatar ID（avtr_xxx），F-16 头像历史键',
        is_member TINYINT DEFAULT 1,
        is_friend TINYINT DEFAULT 0 COMMENT '是否有可信（好友视角）的在线状态来源：系统账号好友，或群友共享上报',
        is_online TINYINT DEFAULT 0 COMMENT '账号是否在线（含网页端登录 + 客户端游戏内）',
        is_in_game TINYINT DEFAULT 0 COMMENT '是否客户端游戏世界内在线（location 非 "web"/空 时为 1）；网页端登录但不在游戏内为 0',
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

      // 群组成员 VRChat 资料缓存（详情秒开）—— 把阶段2 实时拉取的 VRChat 用户资料
      // （简介 bio/徽章/公开模型等）缓存到 DB，玩家点开详情先返回缓存、后台再刷新，
      // 避免每次都等 VRChat API（15~30s）。routes/groups.js 的 /members/:vrchatId/detail 与 /vrchat 依赖此表。
      `CREATE TABLE IF NOT EXISTS group_member_vrc_cache (
        vrchat_id VARCHAR(100) NOT NULL PRIMARY KEY,
        data MEDIUMTEXT COMMENT '完整 vrcData JSON（bio/bioLinks/badges/languages/publicModels 等）',
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_updated(updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // 方案 B：群友互助在线状态共享表 (V6.5b)
      // 已登录且绑定 VRChat 的用户，在查看群组时把自己的好友视角上报到这里，
      // 补充系统账号因 VRChat 隐私墙看不到的非好友成员的真实在线状态。
      `CREATE TABLE IF NOT EXISTS group_presence_share (
        vrchat_id VARCHAR(100) NOT NULL PRIMARY KEY,
        is_online TINYINT DEFAULT 0,
        vrchat_status VARCHAR(50) DEFAULT 'offline',
        world_name VARCHAR(255) DEFAULT '',
        location VARCHAR(500) DEFAULT '',
        last_login DATETIME,
        source_vrchat_id VARCHAR(100),
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_updated (updated_at)
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

      // F-13 好友变更历史：当前态快照表（friend_log_current）+ 历史流水表（friend_log）
      // 定时任务对 group_roster 好友（is_friend=1）做 Diff，把改名/换头像/上下线/状态/世界变化写历史流水。
      // 当前态表用于跨轮次比较；历史表供前端「好友历史」查看。
      `CREATE TABLE IF NOT EXISTS friend_log_current (
        vrchat_id VARCHAR(100) NOT NULL PRIMARY KEY,
        display_name VARCHAR(255) DEFAULT '',
        avatar_url TEXT,
        is_online TINYINT DEFAULT 0,
        vrchat_status VARCHAR(50) DEFAULT 'offline',
        world_name VARCHAR(255) DEFAULT '',
        synced_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS friend_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        vrchat_id VARCHAR(100) NOT NULL,
        change_type VARCHAR(20) NOT NULL COMMENT 'name|avatar|online|offline|status|world',
        old_value VARCHAR(500),
        new_value VARCHAR(500),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_vrchat_id(vrchat_id),
        INDEX idx_type(change_type),
        INDEX idx_time(created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // F-14 世界访问历史：当前态表（world_visit_current，跨轮次比较世界变化）+ 流水表（world_visit_log，进入新世界的访问事件）
      // 定时任务对 group_roster 好友（is_friend=1）Diff world_name，检测到世界变化且新世界非空时写一条访问事件。
      // world_id 存 VRCX location 的 worldId 部分（如 wrld_xxx）；world_name 冗余存世界名便于展示。
      `CREATE TABLE IF NOT EXISTS world_visit_current (
        vrchat_id VARCHAR(100) NOT NULL PRIMARY KEY,
        world_id VARCHAR(100) DEFAULT '',
        world_name VARCHAR(255) DEFAULT '',
        synced_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS world_visit_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        vrchat_id VARCHAR(100) NOT NULL,
        world_id VARCHAR(100) DEFAULT '' COMMENT 'VRChat World ID（location 的 worldId 部分）',
        world_name VARCHAR(255) DEFAULT '',
        visit_count INT DEFAULT 1 COMMENT '累计进入该世界的次数（冗余聚合，便于足迹排序）',
        first_visit_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_visit_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_vrc_world(vrchat_id, world_id),
        INDEX idx_vrchat_id(vrchat_id),
        INDEX idx_time(created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // F-16 头像使用历史：当前态表（avatar_history_current，跨轮次比较头像变化）+ 流水表（avatar_history_log，头像使用记录聚合）
      // 定时任务对 group_roster 好友（is_friend=1）Diff avatar_id，检测到头像变化且新头像非空时 UPSERT 使用次数。
      // avatar_id 存 VRChat Avatar ID（avtr_xxx）；avatar_url 冗余存该头像的缩略图 URL 便于展示。
      `CREATE TABLE IF NOT EXISTS avatar_history_current (
        vrchat_id VARCHAR(100) NOT NULL PRIMARY KEY,
        avatar_id VARCHAR(100) DEFAULT '' COMMENT 'VRChat Avatar ID（avtr_xxx）',
        avatar_url TEXT COMMENT '该头像的缩略图 URL',
        synced_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS avatar_history_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        vrchat_id VARCHAR(100) NOT NULL,
        avatar_id VARCHAR(100) DEFAULT '' COMMENT 'VRChat Avatar ID（avtr_xxx）',
        avatar_url TEXT COMMENT '该头像的缩略图 URL（展示用，取最近一次观测值）',
        use_count INT DEFAULT 1 COMMENT '累计采样到使用该头像的轮次数（冗余聚合，便于历史排序）',
        first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_vrc_avatar(vrchat_id, avatar_id),
        INDEX idx_vrchat_id(vrchat_id),
        INDEX idx_time(created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // F-16 头像标签：私有标签（owner_id 为本站用户），一个头像可打多个标签，同一 (owner, avatar, tag) 唯一。
      // 与 member_note 的私有语义一致：标签仅对打标签者自己可见。
      `CREATE TABLE IF NOT EXISTS avatar_tags (
        id INT AUTO_INCREMENT PRIMARY KEY,
        owner_id INT NOT NULL COMMENT '标签所有者（本站用户 id，标签私有）',
        avatar_id VARCHAR(100) NOT NULL COMMENT 'VRChat Avatar ID（avtr_xxx）',
        tag VARCHAR(50) NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_owner_avatar_tag(owner_id, avatar_id, tag),
        INDEX idx_owner(owner_id),
        INDEX idx_avatar(avatar_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // F-17 世界标签：与 avatar_tags 同模式，私有标签（owner_id 为本站用户），
      // 一个世界可打多个标签，同一 (owner, world_id, tag) 唯一。
      `CREATE TABLE IF NOT EXISTS world_tags (
        id INT AUTO_INCREMENT PRIMARY KEY,
        owner_id INT NOT NULL COMMENT '标签所有者（本站用户 id，标签私有）',
        world_id VARCHAR(100) NOT NULL COMMENT 'VRChat World ID（wrld_xxx）',
        tag VARCHAR(50) NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_owner_world_tag(owner_id, world_id, tag),
        INDEX idx_owner(owner_id),
        INDEX idx_world(world_id)
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

      // VRChat 账号有效性检查结果表 — routes/groups.js 的 /vrc/status/check、/vrc/status/batch-check、/vrc/status/list 依赖此表。
      // 此前从未在初始化中创建，导致 /api/vrc/status/list 直接 500 (ER_NO_SUCH_TABLE)。
      `CREATE TABLE IF NOT EXISTS vrc_account_status (
        id INT AUTO_INCREMENT PRIMARY KEY,
        vrchat_id VARCHAR(100) NOT NULL COMMENT 'VRChat 用户 ID',
        display_name VARCHAR(255) DEFAULT '',
        status VARCHAR(20) NOT NULL DEFAULT 'unknown' COMMENT 'valid|invalid|offline|unknown',
        last_check DATETIME DEFAULT CURRENT_TIMESTAMP,
        error_msg TEXT,
        UNIQUE KEY uk_vrchat_id(vrchat_id),
        INDEX idx_status(status),
        INDEX idx_last_check(last_check)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // 用户标签表 — routes/users.js 的 /tags 系列接口依赖此表（同样从未创建过）。
      // ON DUPLICATE KEY UPDATE color 依赖 (user_id, tag_name) 唯一键。
      `CREATE TABLE IF NOT EXISTS user_tags (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        tag_name VARCHAR(50) NOT NULL,
        color VARCHAR(20) DEFAULT '',
        create_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_user_tag(user_id, tag_name),
        INDEX idx_tag_name(tag_name)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // 群聊离线摘要表 — ws_service.js 依赖。此前只在 migrate-optimization.js 里创建，
      // 而该迁移脚本并不在常规启动流程中执行，导致离线摘要写入静默失败。
      `CREATE TABLE IF NOT EXISTS chat_offline_summary (
        id INT AUTO_INCREMENT PRIMARY KEY,
        group_id INT NOT NULL,
        summary_data TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_cos_group(group_id),
        INDEX idx_cos_updated(updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // V7.00: 群组邀请表 — 与 schedule.js 定时任务及 routes/groups.js 邀请逻辑对齐
      `CREATE TABLE IF NOT EXISTS group_invites (
        id INT AUTO_INCREMENT PRIMARY KEY,
        vrchat_id VARCHAR(100) NOT NULL COMMENT '被邀请人 VRChat ID',
        vrchat_name VARCHAR(100) COMMENT '被邀请人 VRChat 显示名',
        inviter_id VARCHAR(100) NOT NULL COMMENT '邀请人 VRChat ID',
        inviter_name VARCHAR(100) COMMENT '邀请人 VRChat 显示名',
        status ENUM('pending','accepted','rejected','expired') DEFAULT 'pending' COMMENT '邀请状态',
        message TEXT COMMENT '邀请留言',
        expires_at DATETIME NOT NULL COMMENT '过期时间',
        responded_at DATETIME NULL COMMENT '响应时间（接受/拒绝/自动过期时写入）',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_vrchat_id(vrchat_id),
        INDEX idx_inviter_id(inviter_id),
        INDEX idx_status(status),
        INDEX idx_expires_at(expires_at),
        INDEX idx_status_expires(status, expires_at)
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
        note_color VARCHAR(16) DEFAULT NULL,
        note_tags VARCHAR(255) DEFAULT NULL,
        update_time DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_owner_target(owner_vrcid, target_vrcid)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // 玩家/头像审核队列 (F-18)
      `CREATE TABLE IF NOT EXISTS moderations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        reporter_id INT NOT NULL,
        target_user_id INT NOT NULL,
        target_type ENUM('avatar','player') NOT NULL,
        reason VARCHAR(500) DEFAULT '',
        status ENUM('pending','approved','rejected') DEFAULT 'pending',
        resolved_by INT DEFAULT NULL,
        resolved_at DATETIME DEFAULT NULL,
        resolution_note VARCHAR(500) DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_status(status),
        INDEX idx_target(target_user_id)
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

      // (已移除) 原 permissions 表 (V5.3) 为死表：server/ 中无任何路由读写它，
      // 精细 RBAC 改用 group_permission_entries + user_group_membership + user_permissions(V6.14)。
      // 仅 CREATE TABLE IF NOT EXISTS 不会清理已有库；若旧库仍含该表可手动 `DROP TABLE IF EXISTS permissions;`。

      // 用户权限键值表 (V6.14，P2-3 起转为只读历史快照)
      // 旧写入路由 /permissions、/permissions/me、/permissions/set 已于 2026-09-04 从 admin.js 下线；
      // 精细 RBAC 写侧统一走权限组接口（permission_groups.js），该表仅被 /api/permissions-view
      // 的 legacy 透明展示读取。若要 DROP 此表，需先移除 routes/permissions.js 的 legacy 展示块。
      `CREATE TABLE IF NOT EXISTS user_permissions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        permission VARCHAR(64) NOT NULL,
        granted TINYINT(1) DEFAULT 0,
        granted_by INT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_user_permission (user_id, permission),
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

      // 通知表 (V6.0 → V6.14)
      `CREATE TABLE IF NOT EXISTS notifications (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        type VARCHAR(50) NOT NULL DEFAULT 'system',
        title VARCHAR(255) NOT NULL,
        message TEXT,
        related_id INT DEFAULT NULL,
        target_type VARCHAR(20) DEFAULT NULL COMMENT '目标类型: announcement/post/comment/event/chat/group',
        target_id INT DEFAULT NULL COMMENT '目标对象ID',
        post_id INT DEFAULT NULL COMMENT '关联帖子ID（用于跳转）',
        is_read TINYINT(1) DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user (user_id),
        INDEX idx_user_read (user_id, is_read),
        INDEX idx_time (created_at),
        INDEX idx_target (target_type, target_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // 聊天消息表 (V6.12)
      `CREATE TABLE IF NOT EXISTS messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        sender_id INT NOT NULL COMMENT '发送者用户ID',
        receiver_id INT NOT NULL COMMENT '接收者用户ID',
        content TEXT NOT NULL COMMENT '消息内容',
        is_read TINYINT(1) DEFAULT 0 COMMENT '是否已读',
        media_url VARCHAR(500) DEFAULT NULL COMMENT '媒体文件相对路径',
        media_type VARCHAR(20) DEFAULT NULL COMMENT 'image/video/audio',
        file_size INT DEFAULT NULL COMMENT '媒体文件字节数',
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
        is_public TINYINT(1) DEFAULT 1 COMMENT '是否公开群（1=任何人可加入，0=需邀请码）',
        invite_code VARCHAR(32) DEFAULT NULL COMMENT '加群邀请码（is_public=0 时必填）',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_creator (creator_id),
        INDEX idx_is_public (is_public)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // 群聊成员表 (V6.13)
      `CREATE TABLE IF NOT EXISTS chat_group_members (
        id INT AUTO_INCREMENT PRIMARY KEY,
        group_id INT NOT NULL COMMENT '群聊ID',
        user_id INT NOT NULL COMMENT '用户ID',
        is_admin TINYINT(1) DEFAULT 0 COMMENT '是否管理员',
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
        media_url VARCHAR(500) DEFAULT NULL COMMENT '媒体文件相对路径',
        media_type VARCHAR(20) DEFAULT NULL COMMENT 'image/video/audio',
        file_size INT DEFAULT NULL COMMENT '媒体文件字节数',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_group (group_id),
        INDEX idx_time (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS chat_group_message_reads (
        id INT AUTO_INCREMENT PRIMARY KEY,
        group_id INT NOT NULL COMMENT '群聊ID',
        message_id INT NOT NULL COMMENT '消息ID',
        user_id INT NOT NULL COMMENT '用户ID',
        read_at DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '阅读时间',
        UNIQUE KEY uk_group_msg_user (group_id, message_id, user_id),
        INDEX idx_group (group_id),
        INDEX idx_message (message_id),
        INDEX idx_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // 直播表 (V6.14)
      `CREATE TABLE IF NOT EXISTS live_streams (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL COMMENT '主播用户ID',
        title VARCHAR(200) NOT NULL COMMENT '直播标题',
        description TEXT COMMENT '直播描述',
        stream_url VARCHAR(500) COMMENT '直播流地址',
        rtmp_url VARCHAR(500) COMMENT '推流地址（完整 rtmp:// 地址）',
        stream_key VARCHAR(64) COMMENT 'OBS 推流码，随机生成，不使用自增ID避免被顶替',
        thumbnail_url VARCHAR(500) COMMENT '封面图片',
        status ENUM('live','ended','pending') DEFAULT 'pending' COMMENT '直播状态',
        viewer_count INT DEFAULT 0 COMMENT '当前观众数',
        max_viewers INT DEFAULT 0 COMMENT '最高观众数',
        is_public TINYINT(1) DEFAULT 1 COMMENT '是否公开',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        ended_at DATETIME COMMENT '结束时间',
        INDEX idx_user (user_id),
        INDEX idx_status (status),
        INDEX idx_time (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // 直播观众表 (V6.14)
      `CREATE TABLE IF NOT EXISTS live_viewers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        stream_id INT NOT NULL COMMENT '直播ID',
        user_id INT NOT NULL COMMENT '观众用户ID',
        joined_at DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '进入时间',
        left_at DATETIME COMMENT '离开时间',
        UNIQUE KEY uk_stream_user (stream_id, user_id),
        INDEX idx_stream (stream_id),
        INDEX idx_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // 直播弹幕表 (V6.14)
      `CREATE TABLE IF NOT EXISTS live_comments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        stream_id INT NOT NULL COMMENT '直播ID',
        user_id INT NOT NULL COMMENT '发送者用户ID',
        content TEXT NOT NULL COMMENT '弹幕内容',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_stream (stream_id),
        INDEX idx_user (user_id),
        INDEX idx_time (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // 直播点赞表 (V6.14)
      `CREATE TABLE IF NOT EXISTS live_likes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        stream_id INT NOT NULL COMMENT '直播ID',
        user_id INT NOT NULL COMMENT '点赞用户ID',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_stream_like_user (stream_id, user_id),
        INDEX idx_stream (stream_id),
        INDEX idx_user (user_id)
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

      // V6.18: 分享链接
      `CREATE TABLE IF NOT EXISTS share_links (
        id INT AUTO_INCREMENT PRIMARY KEY,
        share_code VARCHAR(32) NOT NULL,
        type ENUM('post','event','album') NOT NULL,
        target_id INT NOT NULL,
        creator_id INT NOT NULL,
        expires_at DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_share_code(share_code),
        INDEX idx_creator(creator_id),
        INDEX idx_target(type, target_id),
        INDEX idx_expires(expires_at)
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      // V6.34: Webhook表
      `CREATE TABLE IF NOT EXISTS webhooks (
        id INT AUTO_INCREMENT PRIMARY KEY,
        url VARCHAR(500) NOT NULL,
        events TEXT NOT NULL,
        secret VARCHAR(255) DEFAULT '',
        enabled TINYINT(1) DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_webhooks_enabled (enabled)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // V6.87: 用户点赞表（每天每人只能给同一用户点赞一次）
      `CREATE TABLE IF NOT EXISTS user_like (
        id INT AUTO_INCREMENT PRIMARY KEY,
        from_user_id INT NOT NULL COMMENT '点赞者用户ID',
        to_user_id INT NOT NULL COMMENT '被点赞者用户ID',
        like_date DATE NOT NULL COMMENT '点赞日期（用于限制每天一次）',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_user_date(from_user_id, to_user_id, like_date),
        INDEX idx_from_user(from_user_id),
        INDEX idx_to_user(to_user_id),
        INDEX idx_like_date(like_date),
        FOREIGN KEY (from_user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (to_user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // ==================== 好友系统 (V7.10) ====================
      // 单向行 + status 表示 user_id 对 friend_id 的视角；accepted 写两条对称行便于双向查询
      `CREATE TABLE IF NOT EXISTS user_friends (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL COMMENT '关系主体',
        friend_id INT NOT NULL COMMENT '关系客体',
        status ENUM('pending','accepted','blocked') NOT NULL DEFAULT 'pending',
        requested_by INT NOT NULL COMMENT '发起方 user_id',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_pair (user_id, friend_id),
        INDEX idx_friend (friend_id),
        INDEX idx_status (status),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (friend_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // ==================== 关注系统 (V7.10) ====================
      // 单向关注；UNIQUE(follower,following) 防重复
      `CREATE TABLE IF NOT EXISTS user_follows (
        id INT AUTO_INCREMENT PRIMARY KEY,
        follower_id INT NOT NULL COMMENT '关注者',
        following_id INT NOT NULL COMMENT '被关注者',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_follow (follower_id, following_id),
        INDEX idx_following (following_id),
        FOREIGN KEY (follower_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (following_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // ==================== 收藏夹系统 (V7.00) ====================

      // 世界收藏表
      `CREATE TABLE IF NOT EXISTS world_favorites (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL COMMENT '用户ID',
        world_id VARCHAR(100) NOT NULL COMMENT 'VRChat World ID',
        world_name VARCHAR(255) DEFAULT '' COMMENT 'World名称',
        image_url VARCHAR(500) DEFAULT '' COMMENT 'World缩略图',
        is_recommended TINYINT(1) DEFAULT 0 COMMENT '是否管理员推荐',
        recommended_by INT NULL COMMENT '推荐者用户ID',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_user_world(user_id, world_id),
        INDEX idx_user(user_id),
        INDEX idx_recommended(is_recommended)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // 头像收藏表
      `CREATE TABLE IF NOT EXISTS avatar_favorites (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL COMMENT '用户ID',
        avatar_id VARCHAR(100) NOT NULL COMMENT 'VRChat Avatar ID',
        avatar_name VARCHAR(255) DEFAULT '' COMMENT 'Avatar名称',
        image_url VARCHAR(500) DEFAULT '' COMMENT 'Avatar缩略图',
        is_recommended TINYINT(1) DEFAULT 0 COMMENT '是否管理员推荐',
        recommended_by INT NULL COMMENT '推荐者用户ID',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_user_avatar(user_id, avatar_id),
        INDEX idx_user(user_id),
        INDEX idx_recommended(is_recommended)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // ==================== 模型收藏馆 (V7.x) ====================
      // 服务器端玩家 VRChat 模型（Avatar）收藏：突破客户端收藏数量限制，
      // 支持模型详情缓存、失效检测（status）与管理员推荐。
      `CREATE TABLE IF NOT EXISTS model_collections (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL COMMENT '收藏者用户ID',
        model_id VARCHAR(64) NOT NULL COMMENT 'VRChat Avatar ID (avtr_xxx)',
        model_name VARCHAR(255) DEFAULT '' COMMENT '模型名称',
        author_id VARCHAR(64) DEFAULT '' COMMENT '作者 VRChat ID (usr_xxx)',
        author_name VARCHAR(255) DEFAULT '' COMMENT '作者名称',
        thumbnail_url VARCHAR(1024) DEFAULT '' COMMENT '缩略图URL',
        description TEXT COMMENT '模型描述',
        unity_version VARCHAR(64) DEFAULT '' COMMENT 'Unity 版本',
        asset_url VARCHAR(1024) DEFAULT '' COMMENT '资源包URL',
        asset_version VARCHAR(32) DEFAULT '' COMMENT '资源版本',
        platform VARCHAR(32) DEFAULT '' COMMENT '支持平台 (standalonewindows 等)',
        status ENUM('unknown','valid','invalid') NOT NULL DEFAULT 'unknown' COMMENT '有效性: unknown=未检测 valid=有效 invalid=已失效',
        invalid_reason VARCHAR(255) DEFAULT '' COMMENT '失效原因 (如 404/已删除/已封禁)',
        last_checked_at DATETIME DEFAULT NULL COMMENT '最近一次有效性检测时间',
        is_recommended TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否管理员推荐',
        recommended_by INT NULL COMMENT '推荐者用户ID',
        is_public TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否公开',
        notes TEXT COMMENT '用户备注',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        -- 模型详情增强字段 (V8 模型收藏馆扩展)
        version VARCHAR(32) DEFAULT '' COMMENT '模型版本号 (assetVersion)',
        favorite_count INT NOT NULL DEFAULT 0 COMMENT '收藏数 (VRChat favoriteCount，作为热度/下载量近似指标)',
        performance_rating VARCHAR(16) DEFAULT '' COMMENT '性能负载 (Excellent/Good/Medium/Poor/VeryPoor)',
        size_bytes BIGINT NOT NULL DEFAULT 0 COMMENT '模型资源包大小 (字节，HEAD assetUrl 获取)',
        content_rating ENUM('all','18+') NOT NULL DEFAULT 'all' COMMENT '内容分级 (VRChat tags 推断: content_sex 等标记为 18+)',
        category ENUM('white','functional') NOT NULL DEFAULT 'white' COMMENT '模型定位 (white=白模 functional=功能模型)',
        tags_snapshot TEXT COMMENT '标签快照 (JSON 数组，缓存 VRChat tags)',
        created_at_vrc DATETIME DEFAULT NULL COMMENT '模型在 VRChat 的发布时间',
        rating_avg DECIMAL(3,2) NOT NULL DEFAULT 0.00 COMMENT '社区平均评分 (1-5)',
        rating_count INT NOT NULL DEFAULT 0 COMMENT '社区评分人数',
        UNIQUE KEY uk_user_model (user_id, model_id),
        INDEX idx_user (user_id),
        INDEX idx_model_id (model_id),
        INDEX idx_status (status),
        INDEX idx_public (is_public),
        INDEX idx_category (category),
        INDEX idx_content_rating (content_rating),
        INDEX idx_performance (performance_rating)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // ==================== 模型社区评分 (V8 模型收藏馆扩展) ====================
      `CREATE TABLE IF NOT EXISTS model_ratings (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        model_collection_id BIGINT NOT NULL COMMENT '关联 model_collections.id',
        user_id INT NOT NULL COMMENT '评分用户ID',
        rating TINYINT NOT NULL COMMENT '评分 1-5',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_model_user (model_collection_id, user_id),
        INDEX idx_model (model_collection_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // ==================== 模型标签字典 (V8 模型收藏馆扩展) ====================
      `CREATE TABLE IF NOT EXISTS model_tag_dict (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tag VARCHAR(64) NOT NULL COMMENT '标签名 (来自 VRChat tags)',
        category VARCHAR(32) DEFAULT 'general' COMMENT '标签类别 (author/feature/system 等)',
        COUNT INT NOT NULL DEFAULT 0 COMMENT '使用该标签的公开模型数',
        UNIQUE KEY uk_tag (tag)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // ==================== 签到系统 (V7.00) ====================

      // 用户签到记录表
      `CREATE TABLE IF NOT EXISTS user_checkin (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        checkin_date DATE NOT NULL,
        checkin_time DATETIME NOT NULL,
        streak INT DEFAULT 1 COMMENT '连续签到天数',
        points INT DEFAULT 10 COMMENT '本次签到获得积分',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_user_date(user_id, checkin_date),
        INDEX idx_user(user_id),
        INDEX idx_date(checkin_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // 签到奖励配置表
      `CREATE TABLE IF NOT EXISTS checkin_rewards (
        id INT AUTO_INCREMENT PRIMARY KEY,
        streak INT NOT NULL UNIQUE COMMENT '连续签到天数',
        points INT NOT NULL COMMENT '奖励积分',
        badge VARCHAR(50) COMMENT '关联成就徽章',
        description VARCHAR(200) COMMENT '奖励描述',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // ==================== 成就系统 (V7.00) ====================

      // 成就定义表
      `CREATE TABLE IF NOT EXISTS achievements (
        id INT AUTO_INCREMENT PRIMARY KEY,
        key_name VARCHAR(50) NOT NULL UNIQUE COMMENT '成就键名',
        name VARCHAR(100) NOT NULL COMMENT '成就名称',
        description VARCHAR(500) COMMENT '成就描述',
        icon VARCHAR(100) COMMENT '成就图标',
        type VARCHAR(20) DEFAULT 'checkin' COMMENT '类型: checkin/post/like/comment/event/chat/album/member/vrc',
        condition_type VARCHAR(20) DEFAULT 'count' COMMENT '条件类型: count/streak/total/days',
        condition_value INT DEFAULT 1 COMMENT '条件阈值',
        points INT DEFAULT 0 COMMENT '成就积分奖励',
        rarity VARCHAR(20) DEFAULT 'common' COMMENT '稀有度: common/rare/epic/legendary',
        is_active TINYINT DEFAULT 1 COMMENT '是否启用',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_type(type),
        INDEX idx_rarity(rarity),
        INDEX idx_active(is_active)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // 用户成就表
      `CREATE TABLE IF NOT EXISTS user_achievements (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        achievement_id INT NOT NULL,
        progress INT DEFAULT 0 COMMENT '当前进度',
        is_unlocked TINYINT DEFAULT 0 COMMENT '是否已解锁',
        unlocked_at DATETIME NULL COMMENT '解锁时间',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_user_achievement(user_id, achievement_id),
        INDEX idx_user(user_id),
        INDEX idx_achievement(achievement_id),
        INDEX idx_unlocked(is_unlocked)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // ==================== 活动队伍系统 (V7.00) ====================

      // 活动队伍表
      `CREATE TABLE IF NOT EXISTS event_teams (
        id INT AUTO_INCREMENT PRIMARY KEY,
        event_id INT NOT NULL COMMENT '活动ID',
        name VARCHAR(100) NOT NULL COMMENT '队伍名称',
        leader_id INT NOT NULL COMMENT '队长用户ID',
        max_members INT DEFAULT 5 COMMENT '最大成员数',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_event(event_id),
        INDEX idx_leader(leader_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // 活动队伍成员表
      `CREATE TABLE IF NOT EXISTS event_team_members (
        id INT AUTO_INCREMENT PRIMARY KEY,
        team_id INT NOT NULL COMMENT '队伍ID',
        user_id INT NOT NULL COMMENT '用户ID',
        joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_team_user(team_id, user_id),
        INDEX idx_team(team_id),
        INDEX idx_user(user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // ==================== 境途联动（JTT） ====================

      // 境途账号文件签发记录表（契约 04-jingtu-web-integration.md §2.1）
      `CREATE TABLE IF NOT EXISTS jtt_accounts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL COMMENT '站内用户ID(users.id)',
        account_id VARCHAR(64) NOT NULL COMMENT '境途账号ID(jt_前缀+32位hex)',
        display_name VARCHAR(100) NOT NULL COMMENT '签发时快照的显示名',
        role VARCHAR(20) DEFAULT 'member' COMMENT '境途侧角色',
        public_key TEXT NOT NULL COMMENT '客户端生成的ED25519公钥(Base64)',
        permissions JSON NULL COMMENT '境途权限列表',
        allowed_rooms JSON NULL COMMENT '允许进入的房间/会话白名单',
        fingerprint VARCHAR(64) NOT NULL COMMENT '账号文件指纹(公钥哈希)',
        issued_by INT NULL COMMENT '签发人(users.id)',
        issued_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NULL COMMENT '过期时间(NULL=长期有效)',
        revoked TINYINT(1) DEFAULT 0,
        revoked_at DATETIME NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_account_id(account_id),
        UNIQUE KEY uk_fingerprint(fingerprint),
        INDEX idx_user(user_id),
        INDEX idx_revoked(revoked),
        INDEX idx_expires(expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // 境途游戏状态表（契约 04 §2.2，每用户一条当前状态）
      `CREATE TABLE IF NOT EXISTS jtt_game_states (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL COMMENT '站内用户ID(users.id)',
        game_key VARCHAR(64) NOT NULL,
        game_name VARCHAR(100) NOT NULL,
        started_at DATETIME NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        source VARCHAR(20) DEFAULT 'client' COMMENT 'client=客户端识别/manual=后台手工标记',
        visibility ENUM('public','members_only','private') DEFAULT 'public',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_user(user_id),
        INDEX idx_game_key(game_key),
        INDEX idx_updated(updated_at),
        INDEX idx_visibility(visibility)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      // 境途绑定码表（契约 04 §2.3，方向④：客户端账号注册联动；原始码仅生成时返回一次，库中存哈希）
      `CREATE TABLE IF NOT EXISTS jtt_bind_codes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        code_hash VARCHAR(64) NOT NULL COMMENT '绑定码SHA-256哈希',
        user_id INT NOT NULL COMMENT '目标站内用户ID(users.id)',
        display_name VARCHAR(100) NOT NULL COMMENT '注册时快照的显示名',
        role VARCHAR(20) DEFAULT 'member' COMMENT '注册后境途侧角色',
        expires_at DATETIME NOT NULL COMMENT '过期时间(默认7天)',
        used_at DATETIME NULL COMMENT '使用时间(NULL=未使用)',
        used_by VARCHAR(64) NULL COMMENT '使用方账号ID(jt_前缀)',
        created_by INT NOT NULL COMMENT '生成人(users.id)',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_code_hash(code_hash),
        INDEX idx_user(user_id),
        INDEX idx_expires(expires_at),
        INDEX idx_used(used_at)
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
      `ALTER TABLE group_roster ADD COLUMN is_friend TINYINT DEFAULT 0`,
      // V8.2: 用户社交/认证标识
      `ALTER TABLE group_roster ADD COLUMN is_vrc_plus TINYINT DEFAULT 0`,
      `ALTER TABLE group_roster ADD COLUMN age_verified TINYINT DEFAULT 0`,
      `ALTER TABLE group_roster ADD COLUMN age_verification_status VARCHAR(20) DEFAULT ''`,
      `ALTER TABLE group_roster ADD COLUMN profile_pic_override_thumbnail TEXT`,
      `ALTER TABLE group_roster ADD COLUMN user_icon TEXT`,
      // V8.3: 状态稳定化（消除"状态窜动"）
      // status_candidate: 最近一次刷新探测到、但尚在"确认窗口"内的候选状态，未正式生效
      // status_changed_at: 候选状态首次出现的时刻；只有持续 ≥ 阈值才翻转正式 is_online
      // status_trust: 该成员当前正式状态的可信度来源 3=群友共享 2=系统账号好友 1=非好友回退 0=未知
      `ALTER TABLE group_roster ADD COLUMN status_candidate TINYINT DEFAULT NULL`,
      `ALTER TABLE group_roster ADD COLUMN status_changed_at DATETIME DEFAULT NULL`,
      `ALTER TABLE group_roster ADD COLUMN status_trust TINYINT DEFAULT 0`,
      // V8.3: 信任等级（Trust Rank）持久化，供群组成员列表卡片直接展示信誉，无需逐个点击名片
      `ALTER TABLE group_roster ADD COLUMN trust_level VARCHAR(50) DEFAULT ''`,
      `ALTER TABLE group_roster ADD COLUMN trust_level_cn VARCHAR(50) DEFAULT ''`,
      // V9.1: 最近一次尝试补充信任等级的时间。隐私墙成员（非好友）永远查不到 trustLevel，
      // 若无此标记会被每轮重复查询占满 20 个名额，导致真正能查到的好友永远轮不上。
      `ALTER TABLE group_roster ADD COLUMN trust_checked_at DATETIME DEFAULT NULL`,
      // V8.6: VRChat 用户自定义状态文字（statusDescription），VRCX 状态列显示的就是这个自由文本
      // vrchat_status 存枚举值(active/join me/ask me/busy/offline)用于颜色判定
      // status_description 存用户写的自由文字("オーラス"/"35天前我生日"等)用于显示
      `ALTER TABLE group_roster ADD COLUMN status_description VARCHAR(500) DEFAULT ''`,
      // V9.2: 玩家加入当前实例的时刻（仅当 is_in_game=1 才有意义）
      // 与 joined_at(VRC 账号加入群组的时刻) 含义不同，故独立字段避免歧义
      `ALTER TABLE group_roster ADD COLUMN joined_instance_at DATETIME DEFAULT NULL`,
      // V9.3: VRChat Avatar ID（avtr_xxx）——F-16 头像使用历史以 avatar_id 为键
      // 定时任务主采样把 currentAvatar 写回本列，F-16 cron 再据此 diff 头像变化
      `ALTER TABLE group_roster ADD COLUMN avatar_id VARCHAR(100) DEFAULT ''`,
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
      `ALTER TABLE group_roster ADD INDEX idx_in_game(is_in_game)`,
      `ALTER TABLE group_roster ADD INDEX idx_last_seen(last_seen)`,
      `ALTER TABLE group_roster ADD INDEX idx_member(is_member)`,
    ];
    for (const sql of rosterIndexes) {
      try { await holder.pool.query(sql); } catch (e) {
        if (e.errno === 1061 || e.code === 'ER_DUP_KEYNAME') { /* index exists */ }
        else { console.warn('  ⚠️ roster index:', e.message); }
      }
    }

    // V9.4: F-17 世界详情缓存补列（world_cache 服务需要完整信息以支撑前端详情展示、减少回源）
    // vrc_worlds_cache 原表仅有展示基础字段，缺少 author_id/world_type/unity_package_url/asset_url/platform
    const worldCacheCols = [
      `ALTER TABLE vrc_worlds_cache ADD COLUMN author_id VARCHAR(100) DEFAULT ''`,
      `ALTER TABLE vrc_worlds_cache ADD COLUMN world_type VARCHAR(50) DEFAULT ''`,
      `ALTER TABLE vrc_worlds_cache ADD COLUMN unity_package_url VARCHAR(500) DEFAULT ''`,
      `ALTER TABLE vrc_worlds_cache ADD COLUMN asset_url VARCHAR(500) DEFAULT ''`,
      `ALTER TABLE vrc_worlds_cache ADD COLUMN platform VARCHAR(50) DEFAULT ''`,
    ];
    for (const sql of worldCacheCols) {
      try { await holder.pool.query(sql); } catch (e) {
        if (e.errno === 1060 || e.code === 'ER_DUP_FIELDNAME') { /* column exists */ }
        else { console.warn('  ⚠️ world cache migration:', e.message); }
      }
    }

    // V9.5: F-18 审核远程动作结果落库（供审核队列回显 block/mute 是否成功、支持撤销）
    const moderationCols = [
      `ALTER TABLE moderations ADD COLUMN remote_result VARCHAR(500) DEFAULT ''`,
    ];
    for (const sql of moderationCols) {
      try { await holder.pool.query(sql); } catch (e) {
        if (e.errno === 1060 || e.code === 'ER_DUP_FIELDNAME') { /* column exists */ }
        else { console.warn('  ⚠️ moderation migration:', e.message); }
      }
    }

    // V6.6: 为 users 表添加安全列（使用 try/catch 兼容 MySQL 5.7）
    const usersSecurityCols = [
      `ALTER TABLE users ADD COLUMN approved TINYINT DEFAULT 0`,
      `ALTER TABLE users ADD COLUMN banned TINYINT DEFAULT 0`,
      `ALTER TABLE users ADD COLUMN failed_login_attempts INT DEFAULT 0`,
      `ALTER TABLE users ADD COLUMN locked_until DATETIME NULL`,
      `ALTER TABLE users ADD COLUMN location_updated_at DATETIME NULL`,
      `ALTER TABLE users ADD COLUMN notification_settings JSON COMMENT '通知设置JSON（email/browser/sound）'`,
      `ALTER TABLE users ADD COLUMN email VARCHAR(255) NULL COMMENT '用户邮箱（用于通知）'`,
      // V9.2: VRCX 借鉴字段
      // pronouns: VRChat API 字段（he/him, she/her, they/them, ask me, 其他自定义）
      //   仅显示偏好，不参与任何过滤/搜索/排序；DEFAULT '' 兼容老数据
      `ALTER TABLE users ADD COLUMN pronouns VARCHAR(32) DEFAULT ''`,
      // previous_display_names: JSON 数组，VRChat 用户改名历史。
      //   容量按典型上限 50 条算，长度保守 4096 字符，溢出后由写入端裁剪。
      `ALTER TABLE users ADD COLUMN previous_display_names JSON`,
      // last_platform: 最近一次登录设备（standaloneandroid / standalonewindows / web / ...）
      //   用 VARCHAR(32) 而非 ENUM，方便未来扩展（VRChat 偶发新增 platform 类型）
      `ALTER TABLE users ADD COLUMN last_platform VARCHAR(32) DEFAULT ''`,
    ];
    let migrationErrors = [];
    for (const sql of usersSecurityCols) {
      try { 
        await holder.pool.query(sql); 
        console.log(`  ✓ 迁移: ${sql.split(' ').slice(5).join(' ')}`);
      } catch (e) {
        if (e.errno === 1060 || e.code === 'ER_DUP_FIELDNAME') { 
          console.log(`  ✓ 已存在: ${sql.split(' ').slice(5).join(' ')}`);
        } else { 
          console.warn(`  ⚠️ 迁移失败: ${sql.split(' ').slice(5).join(' ')} - ${e.message}`);
          migrationErrors.push(sql);
        }
      }
    }
    
    if (migrationErrors.length > 0) {
      console.warn(`  ⚠️ 检测到 ${migrationErrors.length} 个迁移失败，尝试检查表结构...`);
      try {
        const [cols] = await holder.pool.query('SHOW COLUMNS FROM users');
        const existingCols = cols.map(c => c.Field);
        console.log(`  当前 users 表字段: ${existingCols.join(', ')}`);
        
        const missingCols = ['approved', 'banned', 'failed_login_attempts', 'locked_until', 'location_updated_at'].filter(c => !existingCols.includes(c));
        if (missingCols.length > 0) {
          console.warn(`  缺少字段: ${missingCols.join(', ')}`);
          console.log(`  正在尝试修复...`);
          for (const col of missingCols) {
            try {
              let sql;
              switch(col) {
                case 'approved': sql = `ALTER TABLE users ADD COLUMN ${col} TINYINT DEFAULT 0`; break;
                case 'banned': sql = `ALTER TABLE users ADD COLUMN ${col} TINYINT DEFAULT 0`; break;
                case 'failed_login_attempts': sql = `ALTER TABLE users ADD COLUMN ${col} INT DEFAULT 0`; break;
                case 'locked_until': sql = `ALTER TABLE users ADD COLUMN ${col} DATETIME NULL`; break;
                case 'location_updated_at': sql = `ALTER TABLE users ADD COLUMN ${col} DATETIME NULL`; break;
              }
              if (sql) {
                await holder.pool.query(sql);
                console.log(`    ✓ 已添加字段: ${col}`);
              }
            } catch (e2) {
              console.warn(`    ✗ 添加字段 ${col} 失败: ${e2.message}`);
            }
          }
        }
      } catch (e) {
        console.error(`  ✗ 检查表结构失败: ${e.message}`);
      }
    }

    // V6.37: 为 event 表添加事件与实例关联字段及缺失索引
    const eventV637Cols = [
      `ALTER TABLE event ADD COLUMN instance_id VARCHAR(200) NULL COMMENT 'VRChat实例ID（事件与实例关联）'`,
      `ALTER TABLE event ADD COLUMN instance_type VARCHAR(50) NULL COMMENT '实例类型: public/private/group'`,
    ];
    for (const sql of eventV637Cols) {
      try { await holder.pool.query(sql); } catch (e) {
        if (e.errno === 1060 || e.code === 'ER_DUP_FIELDNAME') { /* column exists */ }
        else { console.warn('  ⚠️ event V6.37 migration:', e.message); }
      }
    }
    const eventV637Indexes = [
      `ALTER TABLE event ADD INDEX idx_visibility(visibility)`,
      `ALTER TABLE event ADD INDEX idx_create_admin(create_admin)`,
      `ALTER TABLE event ADD INDEX idx_instance(instance_id)`,
    ];
    for (const sql of eventV637Indexes) {
      try { await holder.pool.query(sql); } catch (e) {
        if (e.errno === 1061 || e.code === 'ER_DUP_KEYNAME') { /* index exists */ }
        else { console.warn('  ⚠️ event V6.37 index:', e.message); }
      }
    }

    // V6.37: 为 users 表添加缺失索引
    const usersV637Indexes = [
      `ALTER TABLE users ADD INDEX idx_vrchat_id(vrchat_id)`,
      `ALTER TABLE users ADD INDEX idx_vrchat_verified(vrchat_verified)`,
      `ALTER TABLE users ADD INDEX idx_email(email)`,
    ];
    for (const sql of usersV637Indexes) {
      try { await holder.pool.query(sql); } catch (e) {
        if (e.errno === 1061 || e.code === 'ER_DUP_KEYNAME') { /* index exists */ }
        else { console.warn('  ⚠️ users V6.37 index:', e.message); }
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

    // V6.12: album_photo 表加 event_id 列（关联活动ID）
    const albumPhotoEventCols = [
      `ALTER TABLE album_photo ADD COLUMN event_id INT NULL COMMENT '关联活动ID'`,
      `ALTER TABLE album_photo ADD INDEX idx_event(event_id)`,
    ];
    for (const sql of albumPhotoEventCols) {
      try { await holder.pool.query(sql); } catch (e) {
        if (e.errno === 1060 || e.code === 'ER_DUP_FIELDNAME') { /* column exists */ }
        else if (e.errno === 1061 || e.code === 'ER_DUP_KEYNAME') { /* index exists */ }
        else { console.warn('  ⚠️ album_photo event_id migration:', e.message); }
      }
    }

    // V6.14: notifications 表加 target_type/target_id/post_id 列（解决 related_id 语义歧义）
    const notificationTargetCols = [
      `ALTER TABLE notifications ADD COLUMN target_type VARCHAR(20) DEFAULT NULL COMMENT '目标类型: announcement/post/comment/event/chat/group'`,
      `ALTER TABLE notifications ADD COLUMN target_id INT DEFAULT NULL COMMENT '目标对象ID'`,
      `ALTER TABLE notifications ADD COLUMN post_id INT DEFAULT NULL COMMENT '关联帖子ID（用于跳转）'`,
      `ALTER TABLE notifications ADD INDEX idx_target(target_type, target_id)`,
    ];
    for (const sql of notificationTargetCols) {
      try { await holder.pool.query(sql); } catch (e) {
        if (e.errno === 1060 || e.code === 'ER_DUP_FIELDNAME') { /* column exists */ }
        else if (e.errno === 1061 || e.code === 'ER_DUP_KEYNAME') { /* index exists */ }
        else { console.warn('  ⚠️ notifications target migration:', e.message); }
      }
    }

    // V6.14.1: event 表加 create_user_id 列（存储创建者用户ID，用于发送报名通知）
    const eventCreateUserIdCols = [
      `ALTER TABLE event ADD COLUMN create_user_id INT NULL DEFAULT 0 COMMENT '创建者用户ID（0=系统/VRChat同步）'`,
      `ALTER TABLE event ADD INDEX idx_create_user(create_user_id)`,
    ];
    for (const sql of eventCreateUserIdCols) {
      try { await holder.pool.query(sql); } catch (e) {
        if (e.errno === 1060 || e.code === 'ER_DUP_FIELDNAME') { /* column exists */ }
        else if (e.errno === 1061 || e.code === 'ER_DUP_KEYNAME') { /* index exists */ }
        else { console.warn('  ⚠️ event create_user_id migration:', e.message); }
      }
    }

    // V6.15: chat_group_members 表加 is_admin 列（群管理员支持）
    const chatGroupAdminCols = [
      `ALTER TABLE chat_group_members ADD COLUMN is_admin TINYINT(1) DEFAULT 0 COMMENT '是否管理员'`,
    ];
    for (const sql of chatGroupAdminCols) {
      try { await holder.pool.query(sql); } catch (e) {
        if (e.errno === 1060 || e.code === 'ER_DUP_FIELDNAME') { /* column exists */ }
        else { console.warn('  ⚠️ chat_group_members is_admin migration:', e.message); }
      }
    }

    // V6.8: 插入默认系统配置
    const defaultConfigs = [
      ['site_name', '境途同游'],
      ['allow_register', '0'],
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
      ['hide_forgot_password', '0'],
    ];
    for (const [key, val] of defaultConfigs) {
      await holder.pool.query(
        `INSERT IGNORE INTO system_config (config_key, config_value) VALUES (?, ?)`, [key, val]
      );
    }

    // V6.17: notifications 添加 is_archived 字段（通知归档）
    try { await holder.pool.query(`ALTER TABLE notifications ADD COLUMN is_archived TINYINT(1) DEFAULT 0 COMMENT '是否归档'`); } catch (e) {
      if (e.errno !== 1060 && e.code !== 'ER_DUP_FIELDNAME') console.warn('  ⚠️ notifications is_archived migration:', e.message);
    }

    // V6.18: messages 和 chat_group_messages 添加 edited_at 字段（消息编辑）
    try { await holder.pool.query(`ALTER TABLE messages ADD COLUMN edited_at DATETIME NULL COMMENT '编辑时间'`); } catch (e) {
      if (e.errno !== 1060 && e.code !== 'ER_DUP_FIELDNAME') console.warn('  ⚠️ messages edited_at migration:', e.message);
    }
    try { await holder.pool.query(`ALTER TABLE chat_group_messages ADD COLUMN edited_at DATETIME NULL COMMENT '编辑时间'`); } catch (e) {
      if (e.errno !== 1060 && e.code !== 'ER_DUP_FIELDNAME') console.warn('  ⚠️ chat_group_messages edited_at migration:', e.message);
    }

    // V6.16: messages 和 chat_group_messages 添加 deleted_at 字段（软删除）
    const softDeleteCols = [
      `ALTER TABLE messages ADD COLUMN deleted_at DATETIME NULL COMMENT '删除时间'`,
      `ALTER TABLE chat_group_messages ADD COLUMN deleted_at DATETIME NULL COMMENT '删除时间'`,
    ];
    for (const sql of softDeleteCols) {
      try { await holder.pool.query(sql); } catch (e) {
        if (e.errno === 1060 || e.code === 'ER_DUP_FIELDNAME') { /* column exists */ }
        else { console.warn('  ⚠️ soft_delete migration:', e.message); }
      }
    }

    // V6.88: member_note 表结构修复 - 将 owner_vrcid/target_vrcid (VARCHAR) 改为 owner_id/target_id (INT)
    try {
      const [cols] = await holder.pool.query('SHOW COLUMNS FROM member_note');
      const hasVrcidCols = cols.some(c => c.Field === 'owner_vrcid');
      if (hasVrcidCols) {
        await holder.pool.query(`ALTER TABLE member_note 
          CHANGE COLUMN owner_vrcid owner_id INT NOT NULL,
          CHANGE COLUMN target_vrcid target_id INT NOT NULL,
          DROP INDEX uk_owner_target,
          ADD UNIQUE KEY uk_owner_target(owner_id, target_id),
          ADD INDEX idx_owner(owner_id),
          ADD INDEX idx_target(target_id)`);
        console.log('  ✅ member_note 表结构已修复');
      }
    } catch (e) {
      if (e.errno !== 1054 && e.errno !== 1060 && e.errno !== 1061) {
        console.warn('  ⚠️ member_note migration:', e.message);
      }
    }

    // F-15: 用户备注彩色标签 - 为 member_note 增加 note_color / note_tags 列
    try {
      const [cols] = await holder.pool.query('SHOW COLUMNS FROM member_note');
      const colNames = cols.map(c => c.Field);
      if (!colNames.includes('note_color')) {
        await holder.pool.query('ALTER TABLE member_note ADD COLUMN note_color VARCHAR(16) DEFAULT NULL');
      }
      if (!colNames.includes('note_tags')) {
        await holder.pool.query('ALTER TABLE member_note ADD COLUMN note_tags VARCHAR(255) DEFAULT NULL');
      }
    } catch (e) {
      if (e.errno !== 1054 && e.errno !== 1060 && e.errno !== 1061) {
        console.warn('  ⚠️ member_note F-15 migration:', e.message);
      }
    }

    // ==================== V7.00: 签到/成就/收藏/队伍 系统迁移 ====================

    // V7.00: users 表添加签到相关字段
    const checkinUserCols = [
      `ALTER TABLE users ADD COLUMN total_checkins INT DEFAULT 0 COMMENT '累计签到次数'`,
      `ALTER TABLE users ADD COLUMN current_streak INT DEFAULT 0 COMMENT '当前连续签到天数'`,
      `ALTER TABLE users ADD COLUMN max_streak INT DEFAULT 0 COMMENT '最长连续签到天数'`,
      `ALTER TABLE users ADD COLUMN checkin_points INT DEFAULT 0 COMMENT '签到积分'`,
      `ALTER TABLE users ADD COLUMN last_checkin_date DATE NULL COMMENT '最后签到日期'`,
    ];
    for (const sql of checkinUserCols) {
      try { await holder.pool.query(sql); } catch (e) {
        if (e.errno === 1060 || e.code === 'ER_DUP_FIELDNAME') { /* column exists */ }
        else { console.warn('  ⚠️ checkin user migration:', e.message); }
      }
    }

    // V7.00: users 表添加成就积分字段
    try { await holder.pool.query(`ALTER TABLE users ADD COLUMN achievement_points INT DEFAULT 0 COMMENT '成就积分'`); } catch (e) {
      if (e.errno !== 1060 && e.code !== 'ER_DUP_FIELDNAME') console.warn('  ⚠️ achievement_points migration:', e.message);
    }

    // V7.13 §11.8.8: users 表添加 avatar_visible（头像总显示开关，与 avatar_type 选哪种解耦）
    try { await holder.pool.query(`ALTER TABLE users ADD COLUMN avatar_visible TINYINT DEFAULT 1 COMMENT '头像是否显示（1=显示，0=隐藏；与 avatar_type 选哪种解耦）'`); } catch (e) {
      if (e.errno !== 1060 && e.code !== 'ER_DUP_FIELDNAME') console.warn('  ⚠️ avatar_visible migration:', e.message);
    }

    // V7.00 R25 §66: chat_groups 添加 is_public/invite_code 字段（已存在库升级，新建库已在 CREATE TABLE 中包含）
    try { await holder.pool.query(`ALTER TABLE chat_groups ADD COLUMN is_public TINYINT(1) DEFAULT 1 COMMENT '是否公开群（1=任何人可加入，0=需邀请码）'`); } catch (e) {
      if (e.errno !== 1060 && e.code !== 'ER_DUP_FIELDNAME') console.warn('  ⚠️ chat_groups is_public migration:', e.message);
    }
    try { await holder.pool.query(`ALTER TABLE chat_groups ADD COLUMN invite_code VARCHAR(32) DEFAULT NULL COMMENT '加群邀请码（is_public=0 时必填）'`); } catch (e) {
      if (e.errno !== 1060 && e.code !== 'ER_DUP_FIELDNAME') console.warn('  ⚠️ chat_groups invite_code migration:', e.message);
    }
    try { await holder.pool.query(`ALTER TABLE chat_groups ADD INDEX idx_is_public (is_public)`); } catch (e) {
      if (e.errno !== 1061 && e.code !== 'ER_DUP_KEYNAME') console.warn('  ⚠️ chat_groups idx_is_public migration:', e.message);
    }

    // V7.10: live_streams 添加 stream_key（推流码）。
    // 此前推流地址直接用自增 ID 拼成站内相对路径 /live/rtmp/<id>，OBS 无法使用，
    // 且任何人猜到 ID 就能顶替推流。现改为随机推流码 + 完整 rtmp:// 地址。
    try { await holder.pool.query(`ALTER TABLE live_streams ADD COLUMN stream_key VARCHAR(64) COMMENT 'OBS 推流码'`); } catch (e) {
      if (e.errno !== 1060 && e.code !== 'ER_DUP_FIELDNAME') console.warn('  ⚠️ live_streams stream_key migration:', e.message);
    }
    try { await holder.pool.query(`ALTER TABLE live_streams ADD UNIQUE INDEX uk_stream_key (stream_key)`); } catch (e) {
      if (e.errno !== 1061 && e.code !== 'ER_DUP_KEYNAME') console.warn('  ⚠️ live_streams uk_stream_key migration:', e.message);
    }

    // V7.10: 聊天消息的媒体附件列。
    // routes/chat.js 的 SELECT 和 INSERT 一直引用 media_url / media_type / file_size，
    // 但这三列从未出现在任何建表语句里，于是只要发送或读取一条消息就会
    // ER_BAD_FIELD_ERROR 500 —— 私聊和群聊 100% 不可用。
    // 这就是"创建完群聊，一发消息就报错"的直接原因。
    for (const table of ['messages', 'chat_group_messages']) {
      const cols = [
        [`media_url`, `VARCHAR(500) DEFAULT NULL COMMENT '媒体文件相对路径'`],
        [`media_type`, `VARCHAR(20) DEFAULT NULL COMMENT 'image/video/audio'`],
        [`file_size`, `INT DEFAULT NULL COMMENT '媒体文件字节数'`]
      ];
      for (const [col, def] of cols) {
        try { await holder.pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${col}\` ${def}`); } catch (e) {
          if (e.errno !== 1060 && e.code !== 'ER_DUP_FIELDNAME') console.warn(`  ⚠️ ${table}.${col} migration:`, e.message);
        }
      }
    }

    // V8.0: 模型收藏馆扩展字段迁移
    // 为已有 model_collections 表补充详情增强列（VRChat API 不提供下载量/评分，
    // 用 favorite_count 收藏数近似热度、rating_* 本地社区评分）。
    const modelCollAddCols = [
      [`version`, `VARCHAR(32) DEFAULT '' COMMENT '模型版本号'`],
      [`favorite_count`, `INT NOT NULL DEFAULT 0 COMMENT '收藏数(VRChat favoriteCount)'`],
      [`performance_rating`, `VARCHAR(16) DEFAULT '' COMMENT '性能负载 Excellent/Good/Medium/Poor/VeryPoor'`],
      [`size_bytes`, `BIGINT NOT NULL DEFAULT 0 COMMENT '资源包大小(字节)'`],
      [`content_rating`, `ENUM('all','18+') NOT NULL DEFAULT 'all' COMMENT '内容分级'`],
      [`category`, `ENUM('white','functional') NOT NULL DEFAULT 'white' COMMENT '模型定位 white=白模 functional=功能模型'`],
      [`tags_snapshot`, `TEXT COMMENT '标签快照(JSON数组)'`],
      [`created_at_vrc`, `DATETIME DEFAULT NULL COMMENT 'VRChat 发布时间'`],
      [`rating_avg`, `DECIMAL(3,2) NOT NULL DEFAULT 0.00 COMMENT '社区平均评分'`],
      [`rating_count`, `INT NOT NULL DEFAULT 0 COMMENT '社区评分人数'`]
    ];
    for (const [col, def] of modelCollAddCols) {
      try { await holder.pool.query(`ALTER TABLE model_collections ADD COLUMN \`${col}\` ${def}`); } catch (e) {
        if (e.errno !== 1060 && e.code !== 'ER_DUP_FIELDNAME') console.warn(`  ⚠️ model_collections.${col} migration:`, e.message);
      }
    }
    // V8.1: 模型收藏馆第三方获取(BOOTH)字段迁移
    // 用 BOOTH 商品链接替代 VRChat 缺失的"下载"动作。
    for (const [col, def] of [
      [`booth_url`, `VARCHAR(512) DEFAULT '' COMMENT 'BOOTH 商品页链接(替代下载动作)'`]
    ]) {
      try { await holder.pool.query(`ALTER TABLE model_collections ADD COLUMN \`${col}\` ${def}`); } catch (e) {
        if (e.errno !== 1060 && e.code !== 'ER_DUP_FIELDNAME') console.warn(`  ⚠️ model_collections.${col} migration:`, e.message);
      }
    }

    // 社区评分表与标签字典表（首次启动自动建表；已存在则忽略）
    for (const sql of [
      `CREATE TABLE IF NOT EXISTS model_ratings (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        model_collection_id BIGINT NOT NULL,
        user_id INT NOT NULL,
        rating TINYINT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_model_user (model_collection_id, user_id),
        INDEX idx_model (model_collection_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS model_tag_dict (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tag VARCHAR(64) NOT NULL,
        category VARCHAR(32) DEFAULT 'general',
        COUNT INT NOT NULL DEFAULT 0,
        UNIQUE KEY uk_tag (tag)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    ]) {
      try { await holder.pool.query(sql); } catch (e) { console.warn('  ⚠️ model ratings/tags table migration:', e.message); }
    }

    // V7.00: 插入签到奖励默认数据
    const checkinRewards = [
      [1, 10, 'checkin_1', '首次签到'],
      [3, 30, 'checkin_3', '连续3天签到'],
      [7, 70, 'checkin_7', '连续7天签到'],
      [14, 150, 'checkin_14', '连续14天签到'],
      [30, 300, 'checkin_30', '连续30天签到'],
      [60, 600, 'checkin_60', '连续60天签到'],
      [100, 1000, 'checkin_100', '连续100天签到'],
    ];
    for (const [streak, points, badge, desc] of checkinRewards) {
      await holder.pool.query(
        `INSERT IGNORE INTO checkin_rewards (streak, points, badge, description) VALUES (?, ?, ?, ?)`,
        [streak, points, badge, desc]
      );
    }

    // V7.00: 插入成就默认数据
    const achievements = [
      ['first_checkin', '初次签到', '完成第一次签到', '🎯', 'checkin', 'count', 1, 10, 'common'],
      ['checkin_3_days', '坚持不懈', '连续签到3天', '🔥', 'checkin', 'streak', 3, 30, 'common'],
      ['checkin_7_days', '一周达人', '连续签到7天', '🌟', 'checkin', 'streak', 7, 70, 'rare'],
      ['checkin_14_days', '两周连胜', '连续签到14天', '💎', 'checkin', 'streak', 14, 150, 'rare'],
      ['checkin_30_days', '月度冠军', '连续签到30天', '👑', 'checkin', 'streak', 30, 300, 'epic'],
      ['checkin_60_days', '双月王者', '连续签到60天', '🏆', 'checkin', 'streak', 60, 600, 'epic'],
      ['checkin_100_days', '百日征程', '连续签到100天', '⚡', 'checkin', 'streak', 100, 1000, 'legendary'],
      ['total_checkin_50', '签到爱好者', '累计签到50次', '📅', 'checkin', 'total', 50, 200, 'common'],
      ['total_checkin_100', '签到达人', '累计签到100次', '📚', 'checkin', 'total', 100, 500, 'rare'],
      ['total_checkin_365', '年度坚守', '累计签到365次', '📅', 'checkin', 'total', 365, 2000, 'legendary'],
      ['first_post', '初次发帖', '发布第一篇动态', '✍️', 'post', 'count', 1, 20, 'common'],
      ['post_10', '活跃用户', '发布10篇动态', '📝', 'post', 'count', 10, 100, 'common'],
      ['post_50', '内容创作者', '发布50篇动态', '📖', 'post', 'count', 50, 500, 'rare'],
      ['first_like', '初次点赞', '给动态点第一次赞', '👍', 'like', 'count', 1, 10, 'common'],
      ['like_50', '点赞达人', '累计点赞50次', '❤️', 'like', 'count', 50, 150, 'common'],
      ['first_comment', '初次评论', '发表第一条评论', '💬', 'comment', 'count', 1, 10, 'common'],
      ['comment_50', '评论大师', '发表50条评论', '🔊', 'comment', 'count', 50, 150, 'common'],
      ['first_event_sign', '初次报名', '报名参加第一次活动', '🎟️', 'event', 'sign', 1, 20, 'common'],
      ['event_sign_10', '活动常客', '报名参加10次活动', '🎪', 'event', 'sign', 10, 100, 'common'],
      ['first_chat', '初次聊天', '发送第一条消息', '💬', 'chat', 'count', 1, 10, 'common'],
      ['chat_100', '话痨', '发送100条消息', '📱', 'chat', 'count', 100, 200, 'common'],
      ['chat_1000', '社交达人', '发送1000条消息', '🌐', 'chat', 'count', 1000, 1000, 'rare'],
      ['first_album_upload', '初次上传', '上传第一张照片', '📷', 'album', 'upload', 1, 20, 'common'],
      ['album_upload_10', '摄影爱好者', '上传10张照片', '📸', 'album', 'upload', 10, 100, 'common'],
      ['member_30_days', '满月达人', '注册满30天', '🎉', 'member', 'days', 30, 100, 'common'],
      ['member_100_days', '百日达人', '注册满100天', '🎊', 'member', 'days', 100, 300, 'rare'],
      ['member_365_days', '年度达人', '注册满365天', '🎁', 'member', 'days', 365, 1000, 'legendary'],
      ['vrc_online_10', 'VRC常客', '在VRChat中在线10小时', '🎮', 'vrc', 'online', 10, 100, 'common'],
      ['vrc_online_100', 'VRC达人', '在VRChat中在线100小时', '🎲', 'vrc', 'online', 100, 500, 'rare'],
    ];
    for (const [keyName, name, desc, icon, type, condType, condVal, points, rarity] of achievements) {
      await holder.pool.query(
        `INSERT IGNORE INTO achievements (key_name, name, description, icon, type, condition_type, condition_value, points, rarity) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [keyName, name, desc, icon, type, condType, condVal, points, rarity]
      );
    }

    // V7.00: 成就名称修复（兼容旧数据）
    await holder.pool.query(`UPDATE achievements SET name='满月达人' WHERE key_name='member_30_days' AND name='满月会员'`);
    await holder.pool.query(`UPDATE achievements SET name='百日达人' WHERE key_name='member_100_days' AND name='百日会员'`);
    await holder.pool.query(`UPDATE achievements SET name='年度达人' WHERE key_name='member_365_days' AND name='年度会员'`);

    // V7.00: 插入迁移版本记录
    await holder.pool.query(
      `INSERT IGNORE INTO system_config (config_key, config_value) VALUES ('db_migration_version', '7.00')`
    );
    await holder.pool.query(
      `INSERT IGNORE INTO system_config (config_key, config_value) VALUES ('db_last_migration', NOW())`
    );

    // ==================== 统一收藏系统 (V8.2 合并收藏馆/收藏夹) ====================
    // 合并原 model_collections(模型收藏馆, avatar_model) / world_favorites(世界) / avatar_favorites(头像)
    // 为单一 collections 表，并按用户维度新增 collection_folders 个性化分组。
    await holder.pool.query(`
      CREATE TABLE IF NOT EXISTS collection_folders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL COMMENT '所属用户',
        name VARCHAR(100) NOT NULL COMMENT '分组名称',
        sort_order INT NOT NULL DEFAULT 0 COMMENT '排序',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_user_name (user_id, name),
        INDEX idx_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await holder.pool.query(`
      CREATE TABLE IF NOT EXISTS collections (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL COMMENT '收藏者用户ID',
        kind ENUM('avatar_model','world','avatar_favorite') NOT NULL COMMENT '收藏类型',
        target_id VARCHAR(100) NOT NULL COMMENT 'VRChat ID (avtr_/wrld_/usr_)',
        name VARCHAR(255) DEFAULT '' COMMENT '名称',
        author VARCHAR(255) DEFAULT '' COMMENT '作者/所有者',
        author_id VARCHAR(64) DEFAULT '' COMMENT '作者ID (usr_)',
        thumbnail VARCHAR(1024) DEFAULT '' COMMENT '缩略图URL',
        description TEXT COMMENT '描述',
        world_type VARCHAR(32) DEFAULT '' COMMENT 'world 专用：worldType',
        platform VARCHAR(32) DEFAULT '' COMMENT '支持平台 (standalonewindows 等)',
        load_type VARCHAR(32) DEFAULT '' COMMENT '加载类型 (avatar_model 专用)',
        size_bytes BIGINT NOT NULL DEFAULT 0 COMMENT '资源包大小(字节)',
        size_category VARCHAR(16) DEFAULT '' COMMENT '尺寸分级 (avatar_model 专用)',
        category ENUM('white','functional') NOT NULL DEFAULT 'white' COMMENT '模型定位',
        content_rating ENUM('all','18+') NOT NULL DEFAULT 'all' COMMENT '内容分级',
        tags JSON COMMENT '标签快照 (JSON 数组)',
        status ENUM('unknown','valid','invalid') NOT NULL DEFAULT 'unknown' COMMENT '有效性',
        invalid_reason VARCHAR(255) DEFAULT '' COMMENT '失效原因',
        last_checked_at DATETIME DEFAULT NULL COMMENT '最近检测时间',
        invalid_at DATETIME DEFAULT NULL COMMENT '失效时间',
        unity_version VARCHAR(64) DEFAULT '' COMMENT 'Unity 版本',
        asset_url VARCHAR(1024) DEFAULT '' COMMENT '资源包URL',
        unity_package_url VARCHAR(1024) DEFAULT '' COMMENT 'world 启动URL',
        booth_url VARCHAR(1024) DEFAULT '' COMMENT 'BOOTH 商品链接',
        favorite_count INT NOT NULL DEFAULT 0 COMMENT 'VRChat 收藏数',
        collector_count INT NOT NULL DEFAULT 0 COMMENT '本站收藏用户数',
        rating_avg DECIMAL(3,2) NOT NULL DEFAULT 0.00 COMMENT '社区平均评分',
        rating_count INT NOT NULL DEFAULT 0 COMMENT '社区评分人数',
        heat INT NOT NULL DEFAULT 0 COMMENT '社区热度',
        visibility ENUM('private','public') NOT NULL DEFAULT 'private' COMMENT '可见性',
        show_author TINYINT(1) NOT NULL DEFAULT 0 COMMENT '公开时是否显示公开者名字（署名公开）',
        is_recommended TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否管理员推荐',
        recommended_by INT NULL COMMENT '推荐者用户ID',
        folder_id INT NULL COMMENT '所属分组',
        notes TEXT COMMENT '用户备注',
        created_at_vrc DATETIME DEFAULT NULL COMMENT 'VRChat 发布时间',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_user_kind_target (user_id, kind, target_id),
        INDEX idx_user (user_id),
        INDEX idx_kind (kind),
        INDEX idx_target (target_id),
        INDEX idx_visibility (visibility),
        INDEX idx_status (status),
        INDEX idx_content_rating (content_rating),
        INDEX idx_category (category),
        INDEX idx_folder (folder_id),
        INDEX idx_heat (heat),
        INDEX idx_public_heat (visibility, heat)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // V8.5: 收藏署名公开（show_author）字段迁移（幂等，重复列忽略）
    try {
      await holder.pool.query(`ALTER TABLE collections ADD COLUMN \`show_author\` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '公开时是否显示公开者名字'`);
    } catch (e) {
      if (e.errno !== 1060 && e.code !== 'ER_DUP_FIELDNAME') console.warn('  ⚠️ collections.show_author migration:', e.message);
    }

    await holder.pool.query(`
      CREATE TABLE IF NOT EXISTS collection_ratings (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        collection_id BIGINT NOT NULL COMMENT 'collections.id',
        user_id INT NOT NULL COMMENT '评分用户',
        rating TINYINT NOT NULL COMMENT '1-5',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_coll_user (collection_id, user_id),
        INDEX idx_coll (collection_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // 一次性迁移：将历史三个表并入 collections（幂等，只在未迁移时执行）
    const [migFlag] = await holder.pool.query(
      `SELECT config_value FROM system_config WHERE config_key = 'collections_migrated' LIMIT 1`
    );
    if (!migFlag || migFlag.length === 0) {
      console.log('🔄 迁移历史收藏数据到统一 collections 表...');
      await holder.pool.query(`
        INSERT IGNORE INTO collections
          (user_id, kind, target_id, name, author, author_id, thumbnail, description, platform, status, invalid_reason, last_checked_at, invalid_at, unity_version, asset_url, size_bytes, content_rating, category, tags, favorite_count, rating_avg, rating_count, heat, visibility, is_recommended, recommended_by, notes, created_at, updated_at)
        SELECT user_id, 'avatar_model', model_id, model_name, author_name, author_id, thumbnail_url, description, platform, status, invalid_reason, last_checked_at, NULL, unity_version, asset_url, size_bytes, content_rating, category,
               NULLIF(tags_snapshot,''), favorite_count, rating_avg, rating_count, 0,
               IF(is_public=1,'public','private'), is_recommended, recommended_by, notes, created_at, updated_at
        FROM model_collections
      `);
      await holder.pool.query(`
        INSERT IGNORE INTO collections
          (user_id, kind, target_id, name, thumbnail, is_recommended, recommended_by, visibility, created_at, updated_at)
        SELECT user_id, 'world', world_id, world_name, image_url, is_recommended, recommended_by, 'private', created_at, created_at
        FROM world_favorites
      `);
      await holder.pool.query(`
        INSERT IGNORE INTO collections
          (user_id, kind, target_id, name, thumbnail, is_recommended, recommended_by, visibility, created_at, updated_at)
        SELECT user_id, 'avatar_favorite', avatar_id, avatar_name, image_url, is_recommended, recommended_by, 'private', created_at, created_at
        FROM avatar_favorites
      `);
      await holder.pool.query(
        `INSERT IGNORE INTO system_config (config_key, config_value) VALUES ('collections_migrated', '1')`
      );
      console.log('✅ 历史收藏迁移完成');
    }

    await holder.pool.query(`SET FOREIGN_KEY_CHECKS = 1`);
    console.log('🔒 已重新启用外键约束检查');

    console.log('✅ 数据库初始化完成（73张表 + 默认数据）');
  } catch (err) {
    try {
      await holder.pool.query(`SET FOREIGN_KEY_CHECKS = 1`);
      console.log('🔒 异常时已重新启用外键约束检查');
    } catch (e) { console.warn('[db_init] 恢复外键约束检查失败:', e.message); }
    console.error('❌ 建表失败:', err.message);
    throw err;
  }
}

// ==================== 迁移版本与回滚机制 ====================

const CURRENT_MIGRATION_VERSION = 7;

async function getMigrationVersion() {
  try {
    const [rows] = await holder.pool.query(
      `SELECT config_value FROM system_config WHERE config_key = 'db_migration_version'`
    );
    return rows.length ? parseInt(rows[0].config_value, 10) : 0;
  } catch { return 0; }
}

async function setMigrationVersion(version) {
  await holder.pool.query(
    `INSERT INTO system_config (config_key, config_value) VALUES ('db_migration_version', ?)
     ON DUPLICATE KEY UPDATE config_value = ?`,
    [String(version), String(version)]
  );
}

async function backupDatabase() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(__dirname, '..', 'backups', 'migrations');
  try { require('fs').promises.mkdir(backupDir, { recursive: true }); } catch {}
  const filename = `migration_backup_v${CURRENT_MIGRATION_VERSION}_${timestamp}.sql`;
  const filepath = path.join(backupDir, filename);
  console.log('📦 创建迁移前备份:', filename);
  return { filepath, version: CURRENT_MIGRATION_VERSION, timestamp };
}

async function rollbackToVersion(targetVersion) {
  const current = await getMigrationVersion();
  if (current <= targetVersion) {
    console.log('ℹ️ 已是目标版本或更低，无需回滚');
    return;
  }
  console.log(`🔄 准备从版本 ${current} 回滚到版本 ${targetVersion}`);
  console.log('⚠️ 回滚需要手动恢复备份，请使用以下命令：');
  console.log(`   mysql -u<user> -p <database> < backups/migrations/migration_backup_v${targetVersion}_*.sql`);
  await setMigrationVersion(targetVersion);
  console.log(`✅ 版本号已回滚至 ${targetVersion}（数据需手动恢复）`);
}

module.exports = initDatabase;
module.exports.initDatabase = initDatabase;
module.exports.getMigrationVersion = getMigrationVersion;
module.exports.setMigrationVersion = setMigrationVersion;
module.exports.backupDatabase = backupDatabase;
module.exports.rollbackToVersion = rollbackToVersion;
module.exports.CURRENT_MIGRATION_VERSION = CURRENT_MIGRATION_VERSION;
