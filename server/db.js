require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');

const DB_CONFIG = {
  host: process.env.MYSQL_HOST || '127.0.0.1',
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || 'root',
  port: parseInt(process.env.MYSQL_PORT) || 3306,
  timezone: '+08:00',
  charset: 'utf8mb4'
};

const DB_NAME = process.env.MYSQL_DATABASE || 'jingtu_group';

// holder 模式：所有模块通过 holder.pool 访问，recreate 后自动生效
const holder = { pool: null };

function createPoolWithoutDB() {
  holder.pool = mysql.createPool({
    ...DB_CONFIG,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 50,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000
  });
}

function recreatePool() {
  // 先关闭旧池，释放所有连接句柄
  if (holder.pool) {
    holder.pool.end().catch(() => {});
  }
  holder.pool = mysql.createPool({
    ...DB_CONFIG,
    database: DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 50,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000
  });
}

createPoolWithoutDB();

// ==================== 数据库心跳重连（MySQL 意外停止后自动恢复） ====================
const DB_HEARTBEAT_INTERVAL = 15000; // 每 15 秒检查一次
let _dbReconnecting = false;

async function _dbHeartbeat() {
  // 尚未使用 DB 时跳过（login 阶段不需要）
  if (!holder.pool) return;
  try {
    const [rows] = await holder.pool.query('SELECT 1 AS ping');
  } catch (e) {
    console.warn('⚠️ 数据库心跳检测失败:', e.message);
    if (_dbReconnecting) return;
    _dbReconnecting = true;
    console.log('🔄 尝试重建数据库连接池...');
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        recreatePool();
        // 验证新池是否可用
        await holder.pool.query('SELECT 1 AS ping');
        console.log('✅ 数据库连接池重建成功（第' + attempt + '次）');
        _dbReconnecting = false;
        return;
      } catch (e2) {
        console.warn('⚠️ 数据库重建失败（第' + attempt + '次）:', e2.message);
        await new Promise(r => setTimeout(r, 3000)); // 重试间隔
      }
    }
    console.error('❌ 数据库连接池重建失败，将在 ' + (DB_HEARTBEAT_INTERVAL / 1000) + ' 秒后重试');
    _dbReconnecting = false;
  }
}

setInterval(_dbHeartbeat, DB_HEARTBEAT_INTERVAL);
console.log('⏰ 数据库心跳监测已启动（间隔 ' + (DB_HEARTBEAT_INTERVAL / 1000) + ' 秒）');

module.exports = { holder, DB_NAME, DB_CONFIG, recreatePool };
