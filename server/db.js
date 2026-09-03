const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

// 从 .env 文件直接解析一个键值（兜底：当进程环境变量未注入 MYSQL_PASSWORD 时使用，
// 例如 ServBay 以自身方式拉起 Node 而未 source .env 的场景）。
function readEnvValueFromFile(key) {
  try {
    const envPath = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(envPath)) return undefined;
    const txt = fs.readFileSync(envPath, 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(new RegExp('^\\s*' + key + '\\s*=\\s*(.*)$'));
      if (m) {
        let v = m[1].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.substring(1, v.length - 1);
        }
        return v;
      }
    }
  } catch (e) {
    // 读不到就返回 undefined，回退到环境变量
  }
  return undefined;
}

function normalizeSecret(v) {
  if (!v) return '';
  v = String(v).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.substring(1, v.length - 1);
  }
  return v;
}

let password = normalizeSecret(process.env.MYSQL_PASSWORD);
if (!password) {
  // 进程环境无密码：尝试从 .env 文件兜底读取，避免 root@localhost 无密码连接
  const fromFile = readEnvValueFromFile('MYSQL_PASSWORD');
  if (fromFile) password = normalizeSecret(fromFile);
}
const DB_CONFIG = {
  host: process.env.MYSQL_HOST || '127.0.0.1',
  user: process.env.MYSQL_USER || 'root',
  port: parseInt(process.env.MYSQL_PORT) || 3306,
  timezone: '+08:00',
  charset: 'utf8mb4'
};
if (password && password !== '') {
  DB_CONFIG.password = password;
}

const DB_NAME = process.env.MYSQL_DATABASE || 'jingtu_group';

// holder 模式：所有模块通过 holder.pool 访问，recreate 后自动生效
const holder = { pool: null, dbName: DB_NAME };

function createPoolWithoutDB() {
  holder.pool = mysql.createPool({
    ...DB_CONFIG,
    database: holder.dbName,
    waitForConnections: true,
    connectionLimit: 50,
    queueLimit: 100,
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
    database: holder.dbName,
    waitForConnections: true,
    connectionLimit: 50,
    queueLimit: 100,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000
  });
}

// §恢复：运行时用新配置重建连接池（无需重启进程）。
// 用于「数据库恢复页」在 MySQL 密码/地址变更后就地重连。
// 注意：db_init.js 在启动时已按值捕获 DB_NAME，本函数仅更新连接池用的库名；
// 恢复场景通常只改 host/密码、库名不变，故不影响建表逻辑。
function applyDbConfig({ host, port, user, password, database } = {}) {
  if (host) DB_CONFIG.host = host;
  if (port) DB_CONFIG.port = parseInt(port, 10) || DB_CONFIG.port;
  if (user) DB_CONFIG.user = user;
  if (password !== undefined) {
    if (password) DB_CONFIG.password = password;
    else delete DB_CONFIG.password;
  }
  if (database) holder.dbName = database;
  recreatePool();
}

function getPool() {
  return holder.pool;
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

module.exports = { holder, DB_NAME, DB_CONFIG, getPool, recreatePool, applyDbConfig };
