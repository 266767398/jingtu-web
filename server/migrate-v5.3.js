/**
 * 境途同游 V5.3 — 数据库迁移脚本
 * 1. event 表加字段：event_type, vrchat_event_id, ends_at, source
 * 2. event_sign 表加 user_id 关联 users.id
 *
 * §P3-86: 失败项累计计数——存在失败以非零码退出（原实现只 console.log ❌ 后 continue，
 * 进程最终 exit 0 假成功）；migrate()/addNewTables() 均用 try/finally 关闭连接，
 * 中途抛错不再泄漏 mysql 连接。
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');
const { DB_NAME, DB_CONFIG } = require('./db');

let totalFail = 0;

function isDupField(e) {
  return e.code === 'ER_DUP_FIELDNAME' || e.errno === 1060;
}
function isDupIndex(e) {
  return e.errno === 1061;
}

async function migrate() {
  let conn = null;
  try {
    conn = await mysql.createConnection(DB_CONFIG);
    await conn.query(`USE \`${DB_NAME}\``);

    console.log('=== V5.3 数据库迁移 ===\n');

    // 1. event 表扩展
    const eventCols = [
      `ALTER TABLE event ADD COLUMN event_type ENUM('activity','birthday') DEFAULT 'activity' AFTER max_sign`,
      `ALTER TABLE event ADD COLUMN vrchat_event_id VARCHAR(100) NULL UNIQUE AFTER event_type`,
      `ALTER TABLE event ADD COLUMN ends_at DATETIME NULL AFTER event_time`,
      `ALTER TABLE event ADD COLUMN source ENUM('manual','vrchat') DEFAULT 'manual' AFTER visibility`
    ];
    for (const sql of eventCols) {
      try {
        await conn.query(sql);
        console.log(`  ✅ event: ${sql.split('ADD COLUMN')[1].split('(')[0].trim()}`);
      } catch (e) {
        if (isDupField(e)) {
          console.log(`  ⏭️  已存在，跳过`);
        } else {
          console.log(`  ❌ ${e.message}`);
          totalFail++;
        }
      }
    }

    // 2. event_sign 表加 user_id
    try {
      await conn.query(`ALTER TABLE event_sign ADD COLUMN user_id INT NULL AFTER user_name`);
      console.log(`  ✅ event_sign: user_id`);
    } catch (e) {
      if (isDupField(e)) {
        console.log(`  ⏭️  event_sign.user_id 已存在，跳过`);
      } else {
        console.log(`  ❌ ${e.message}`);
        totalFail++;
      }
    }

    // 3. 建索引
    const indexCols = [
      { name: 'idx_event_type', sql: `ALTER TABLE event ADD INDEX idx_event_type(event_type)` },
      { name: 'idx_source', sql: `ALTER TABLE event ADD INDEX idx_source(source)` },
      { name: 'idx_ends_at', sql: `ALTER TABLE event ADD INDEX idx_ends_at(ends_at)` }
    ];
    for (const item of indexCols) {
      try {
        await conn.query(item.sql);
        console.log(`  ✅ event: ${item.name}`);
      } catch (e) {
        if (isDupIndex(e)) {
          console.log(`  ⏭️  ${item.name} 已存在，跳过`);
        } else {
          console.log(`  ❌ ${e.message}`);
          totalFail++;
        }
      }
    }

    console.log('\n=== 迁移完成 ===');
  } finally {
    if (conn) { try { await conn.end(); } catch (_) {} }
  }
}

async function addNewTables() {
  let conn = null;
  try {
    conn = await mysql.createConnection(DB_CONFIG);
    await conn.query(`USE \`${DB_NAME}\``);
    console.log('\n=== 新表创建 ===\n');

    // name_change_requests
    try {
      await conn.query(`CREATE TABLE IF NOT EXISTS name_change_requests (
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      console.log('  ✅ name_change_requests 表');
    } catch (e) {
      console.log(`  ❌ name_change_requests: ${e.message}`);
      totalFail++;
    }

    // P2-79：permissions 是死表——RBAC 早已迁移到 group_permission_entries（docs/04），
    // 本脚本却仍会把它重建出来，制造「有权限系统」的错觉与双源漂移。
    // 不再建表；也不主动 DROP（遗留脚本保持非破坏性），如库中残留可自行清理。
    console.log('  ⏭️ permissions 表已废弃（RBAC 迁移至 group_permission_entries），跳过创建');

    console.log('\n=== 新表创建完成 ===');
  } finally {
    if (conn) { try { await conn.end(); } catch (_) {} }
  }
}

(async () => {
  await migrate();
  await addNewTables();
  if (totalFail > 0) {
    console.error(`❌ 迁移存在 ${totalFail} 项失败，以非零码退出（供 CI / shell 链路感知）`);
    process.exit(1);
  }
})().catch(e => {
  console.error('❌ 迁移失败:', e.message);
  process.exit(1);
});
