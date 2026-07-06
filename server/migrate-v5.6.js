/**
 * 境途同游 V5.6 — VRChat World 活动地图迁移脚本
 * 1. event 表新增 world_id, world_name, world_image_url 字段
 * 2. 新建 vrc_worlds_cache 表用于缓存 World 信息
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');
const { DB_NAME, DB_CONFIG, recreatePool, holder } = require('./db');

async function migrate() {
  console.log('🔄 [V5.6] 开始数据库迁移...');

  // 创建连接池
  recreatePool();
  const pool = holder.pool;

  try {
    // 1. event 表添加 world 相关字段
    const eventColumns = [
      { name: 'world_id', def: `VARCHAR(100) NULL COMMENT 'VRChat World ID'` },
      { name: 'world_name', def: `VARCHAR(255) NULL COMMENT 'VRChat World 名称'` },
      { name: 'world_image_url', def: `VARCHAR(500) NULL COMMENT 'VRChat World 缩略图URL'` }
    ];

    // 获取当前表结构
    const [cols] = await pool.query(`SHOW COLUMNS FROM event`);
    const existingCols = new Set(cols.map(c => c.Field));

    for (const col of eventColumns) {
      if (!existingCols.has(col.name)) {
        await pool.query(`ALTER TABLE event ADD COLUMN \`${col.name}\` ${col.def}`);
        console.log(`  ✅ event 表添加字段: ${col.name}`);
      } else {
        console.log(`  ℹ️  event 表字段已存在: ${col.name}`);
      }
    }

    // 2. 为 world_id 建索引
    const [idxs] = await pool.query(`SHOW INDEX FROM event WHERE Key_name = 'idx_world_id'`);
    if (idxs.length === 0) {
      await pool.query(`CREATE INDEX idx_world_id ON event(world_id)`);
      console.log('  ✅ 创建索引: idx_world_id');
    }

    // 3. 新建 vrc_worlds_cache 表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vrc_worlds_cache (
        world_id VARCHAR(100) PRIMARY KEY,
        world_name VARCHAR(255) NOT NULL,
        description TEXT,
        image_url VARCHAR(500),
        author_name VARCHAR(100),
        capacity INT DEFAULT 0,
        tags JSON,
        release_status VARCHAR(50),
        cached_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('  ✅ 创建表: vrc_worlds_cache');

    console.log('✅ [V5.6] 数据库迁移完成!');
  } catch (e) {
    console.error('❌ [V5.6] 迁移失败:', e.message);
    throw e;
  } finally {
    await pool.end();
  }
}

migrate().catch(() => process.exit(1));
