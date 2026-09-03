const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..', '..');
const ENV_PATH = path.join(ROOT, '.env');

function stripQuotes(value) {
  const v = String(value || '').trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function parseEnvFile(filePath) {
  const parsed = {};
  if (!fs.existsSync(filePath)) return parsed;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1);
    parsed[key] = stripQuotes(value);
  }
  return parsed;
}

async function main() {
  const env = parseEnvFile(ENV_PATH);
  const dbConfig = {
    host: env.MYSQL_HOST || '127.0.0.1',
    port: parseInt(env.MYSQL_PORT || '3306', 10),
    user: env.MYSQL_USER || 'root',
    database: env.MYSQL_DATABASE || 'jingtu_group'
  };
  if (env.MYSQL_PASSWORD) dbConfig.password = env.MYSQL_PASSWORD;

  console.log('== 境途同游初始化重置 ==');
  console.log(`项目根目录: ${ROOT}`);
  console.log(`.env: ${fs.existsSync(ENV_PATH) ? '存在' : '不存在'}`);

  let conn = null;
  try {
    conn = await mysql.createConnection(dbConfig);
    const [beforeRows] = await conn.query(
      "SELECT COUNT(*) AS cnt FROM users WHERE role = 'super_admin' AND deleted_at IS NULL"
    );
    const beforeCount = beforeRows[0].cnt || 0;
    const [updateResult] = await conn.query(
      "UPDATE users SET role = 'member' WHERE role = 'super_admin' AND deleted_at IS NULL"
    );

    console.log(`已将 ${updateResult.affectedRows || 0} 个 super_admin 降级为 member`);
    console.log(`重置前 super_admin 数量: ${beforeCount}`);
    console.log('重置完成。可通过「安装向导」重新创建超级管理员（.env 与登录会话均不会被删除）。');
  } catch (error) {
    console.error('重置失败：', error.message);
    process.exitCode = 1;
  } finally {
    if (conn) await conn.end();
  }
}

main();
