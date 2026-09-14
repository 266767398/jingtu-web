const express = require('express');
const router = express.Router();
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const { ok, fail, safeError } = require('../utils');
const { requireAdminCompat } = require('../auth');
const { validateRequest, migrationValidations } = require('../validation');
const logger = require('../logger');

const PANEL_CONFIGS = {
  standalone: { name: '独立MySQL', defaultPort: 3306, userPattern: '', defaultUser: 'root' },
  baota: { name: '宝塔面板', defaultPort: 3306, userPattern: '用户名_b前缀', defaultUser: '' },
  onepanel: { name: '1Panel', defaultPort: 3306, userPattern: '数据库名', defaultUser: '' },
  aapanel: { name: 'aaPanel', defaultPort: 3306, userPattern: '用户名_前缀', defaultUser: '' }
};

// 数据迁移可探测内网数据库并读取本机配置，仅允许管理员使用。
router.use(requireAdminCompat);

router.get('/detect', async (req, res) => {
  try {
    const results = [];
    const ports = [3306, 3307, 3308, 3309];
    const hosts = ['127.0.0.1', 'localhost'];
    
    for (const host of hosts) {
      for (const port of ports) {
        try {
          const conn = await mysql.createConnection({
            host,
            port,
            user: 'root',
            password: '',
            connectTimeout: 2000
          });
          
          const [databases] = await conn.query(`SHOW DATABASES`);
          await conn.end();
          
          results.push({
            host,
            port,
            success: true,
            databases: databases.map(d => d.Database),
            message: `连接成功，发现 ${databases.length} 个数据库`
          });
        } catch (e) {
          results.push({
            host,
            port,
            success: false,
            databases: [],
            message: e.message
          });
        }
      }
    }
    
    ok(res, { results });
  } catch (e) {
    fail(res, 200, safeError(e.message), { results: [] });
  }
});

router.post('/test-connection', validateRequest(migrationValidations.testConnection), async (req, res) => {
  try {
    const { host, port, database, user, password } = req.body;
    
    if (!host || !port || !database || !user || !password) {
      return fail(res, 400, '参数不完整');
    }
    
    const conn = await mysql.createConnection({
      host,
      port: parseInt(port),
      database,
      user,
      password,
      connectTimeout: 5000
    });
    
    await conn.end();
    
    ok(res, { message: '数据库连接成功！' });
  } catch (e) {
    let errorType = 'unknown';
    let errorMsg = e.message;
    
    if (e.code === 'ER_ACCESS_DENIED_ERROR') {
      errorType = 'auth';
      errorMsg = '用户名或密码错误';
    } else if (e.code === 'ER_BAD_DB_ERROR') {
      errorType = 'database';
      errorMsg = '数据库不存在';
    } else if (e.code === 'ECONNREFUSED') {
      errorType = 'connection';
      errorMsg = '连接被拒绝，请检查主机和端口';
    } else if (e.code === 'ETIMEDOUT') {
      errorType = 'timeout';
      errorMsg = '连接超时';
    }
    
    fail(res, 200, errorMsg, { errorType });
  }
});

router.post('/get-databases', async (req, res) => {
  try {
    const { host, port, user, password } = req.body;
    
    if (!host || !port || !user || !password) {
      return fail(res, 400, '参数不完整');
    }
    
    const conn = await mysql.createConnection({
      host,
      port: parseInt(port),
      user,
      password,
      connectTimeout: 5000
    });
    
    const [databases] = await conn.query(`SHOW DATABASES`);
    await conn.end();
    
    const filtered = databases
      .map(d => d.Database)
      .filter(db => !['information_schema', 'mysql', 'performance_schema', 'sys'].includes(db));
    
    ok(res, { databases: filtered });
  } catch (e) {
    fail(res, 200, safeError(e.message));
  }
});

router.post('/get-tables', async (req, res) => {
  try {
    const { host, port, database, user, password } = req.body;
    
    if (!host || !port || !database || !user || !password) {
      return fail(res, 400, '参数不完整');
    }
    
    const conn = await mysql.createConnection({
      host,
      port: parseInt(port),
      database,
      user,
      password,
      connectTimeout: 5000
    });
    
    const [tables] = await conn.query(`SHOW TABLES`);
    await conn.end();
    
    const tableNames = tables.map(t => Object.values(t)[0]);
    
    ok(res, { tables: tableNames });
  } catch (e) {
    fail(res, 200, safeError(e.message));
  }
});

// P2-78：按主键游标分批搬运单表数据，替代旧实现 `SELECT * FROM 表` 整表载入内存
// （docs/09 迁移章节自身都标注大表会打爆内存）。无主键 / 复合主键时回退
// LIMIT/OFFSET 稳定排序分页，并在日志中如实给出内存告警。
async function migrateTableDataInBatches(sourceConn, targetConn, tableName, logs) {
  const BATCH = 500;

  async function insertRows(rows) {
    if (!rows.length) return 0;
    const columns = Object.keys(rows[0]);
    const insertSql = `INSERT INTO \`${tableName}\` (${columns.map((c) => `\`${c}\``).join(', ')}) VALUES ?`;
    for (let j = 0; j < rows.length; j += 100) {
      const values = rows.slice(j, j + 100).map((row) => columns.map((c) => row[c]));
      await targetConn.query(insertSql, [values]);
    }
    return rows.length;
  }

  let pkCol = null;
  let pkType = null;
  try {
    const [pkRows] = await sourceConn.query(
      'SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS'
      + ' WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_KEY = ?',
      [tableName, 'PRI']
    );
    if (pkRows.length === 1) { pkCol = pkRows[0].COLUMN_NAME; pkType = String(pkRows[0].DATA_TYPE).toLowerCase(); }
  } catch (e) {
    logs.push(`[WARN] 探测表 ${tableName} 主键失败，回退整表读取：${e.message}`);
  }

  const numericPk = pkCol && /^(int|bigint|mediumint|smallint|tinyint)/.test(pkType);
  let migrated = 0;

  if (numericPk) {
    let last = null;
    for (;;) {
      const rows = last === null
        ? (await sourceConn.query(`SELECT * FROM \`${tableName}\` ORDER BY \`${pkCol}\` ASC LIMIT ${BATCH}`))[0]
        : (await sourceConn.query(`SELECT * FROM \`${tableName}\` WHERE \`${pkCol}\` > ? ORDER BY \`${pkCol}\` ASC LIMIT ${BATCH}`, [last]))[0];
      if (!rows.length) break;
      migrated += await insertRows(rows);
      last = rows[rows.length - 1][pkCol];
      if (rows.length < BATCH) break;
    }
    return { migrated, note: `按主键 ${pkCol} 游标分批` };
  }

  logs.push(`[WARN] 表 ${tableName} 无单列数值主键，使用 LIMIT/OFFSET 分页搬运；超大表仍可能有内存与性能压力`);
  for (let offset = 0; ; offset += BATCH) {
    let rows;
    if (pkCol) {
      rows = (await sourceConn.query(`SELECT * FROM \`${tableName}\` ORDER BY \`${pkCol}\` ASC LIMIT ${BATCH} OFFSET ${offset}`))[0];
    } else {
      rows = (await sourceConn.query(`SELECT * FROM \`${tableName}\` LIMIT ${BATCH} OFFSET ${offset}`))[0];
    }
    if (!rows.length) break;
    migrated += await insertRows(rows);
    if (rows.length < BATCH) break;
  }
  return { migrated, note: pkCol ? `按主键 ${pkCol} 排序分页` : '无主键顺序分页' };
}

router.post('/migrate', requireAdminCompat, validateRequest(migrationValidations.migrate), async (req, res) => {
  let sourceConn = null;
  let targetConn = null;
  
  try {
    const { sourceDb, targetDb, tables } = req.body;
    
    if (!sourceDb || !targetDb) {
      return fail(res, 400, '源数据库和目标数据库配置不能为空');
    }
    
    sourceConn = await mysql.createConnection({
      host: sourceDb.host,
      port: parseInt(sourceDb.port),
      database: sourceDb.database,
      user: sourceDb.user,
      password: sourceDb.password,
      connectTimeout: 10000
    });
    
    targetConn = await mysql.createConnection({
      host: targetDb.host,
      port: parseInt(targetDb.port),
      database: targetDb.database,
      user: targetDb.user,
      password: targetDb.password,
      connectTimeout: 10000
    });
    
    const logs = [];
    logs.push(`[INFO] 开始迁移：${sourceDb.host}:${sourceDb.port}/${sourceDb.database} -> ${targetDb.host}:${targetDb.port}/${targetDb.database}`);
    
    const [sourceTables] = await sourceConn.query(`SHOW TABLES`);
    const tableNames = tables && tables.length > 0 
      ? tables 
      : sourceTables.map(t => Object.values(t)[0]);

    // 安全白名单：只允许迁移源库中真实存在的表，杜绝表名注入
    // （下方 SHOW CREATE TABLE / SELECT 用反引号拼接表名，若表名含反引号即可逃逸定界符）。
    const allowedTables = new Set(sourceTables.map(t => Object.values(t)[0]));
    const invalidTables = tableNames.filter(t => !allowedTables.has(t));
    if (invalidTables.length > 0) {
      return fail(res, 400, `包含非法或不存在的表: ${invalidTables.join(', ')}`);
    }

    logs.push(`[INFO] 待迁移表数量：${tableNames.length}`);
    
    await targetConn.query(`SET FOREIGN_KEY_CHECKS = 0`);
    logs.push(`[INFO] 已在目标专用连接上禁用外键约束（仅作用于本连接，迁移结束/异常均恢复）`);

    // P2-78：旧实现 beginTransaction() + 结尾 commit()，但循环体内是
    // DROP TABLE / CREATE TABLE——MySQL DDL 触发隐式提交，所谓「事务」从未包住
    // 任何结构变更，失败时回滚也是空操作，原子性纯属虚构。现删除假事务，
    // 如实按「逐表独立迁移」建模：每表成功/失败都进日志，最终响应如实反映
    // successCount/failCount，部分失败不再伪装整体成功。
    let successCount = 0;
    let failCount = 0;
    
    for (let i = 0; i < tableNames.length; i++) {
      const tableName = tableNames[i];
      const progress = ((i + 1) / tableNames.length * 100).toFixed(1);
      logs.push(`[INFO] [${progress}%] 正在迁移表：${tableName}`);
      
      try {
        const [createTableResult] = await sourceConn.query(`SHOW CREATE TABLE \`${tableName}\``);
        const createTableSql = createTableResult[0]['Create Table'];
        
        await targetConn.query(`DROP TABLE IF EXISTS \`${tableName}\``);
        await targetConn.query(createTableSql);

        const { migrated } = await migrateTableDataInBatches(sourceConn, targetConn, tableName, logs);

        successCount++;
        logs.push(`[SUCCESS] 表 ${tableName} 迁移成功 (${migrated} 条记录)`);
      } catch (e) {
        failCount++;
        logs.push(`[ERROR] 表 ${tableName} 迁移失败：${e.message}`);
      }
    }

    // 尽力恢复外键并验证引用完整性（专用连接，随 close 自动回收）
    let fkRestoreOk = true;
    try {
      await targetConn.query(`SET FOREIGN_KEY_CHECKS = 1`);
      logs.push(`[SUCCESS] 已恢复目标数据库外键约束`);
    } catch (e) {
      fkRestoreOk = false;
      logs.push(`[WARN] 恢复外键约束失败：${e.message}`);
    }

    await sourceConn.end();
    await targetConn.end();
    
    logs.push(`[INFO] 迁移完成！成功：${successCount} 表，失败：${failCount} 表`);

    if (failCount > 0 || !fkRestoreOk) {
      const reason = failCount > 0
        ? `迁移部分失败：${successCount} 表成功、${failCount} 表失败（DDL 不支持整体回滚，失败表需人工核对）`
        : '表迁移完成，但外键约束恢复失败，请人工核查目标库';
      fail(res, 200, reason, { logs, successCount, failCount, partial: failCount > 0 });
    } else {
      ok(res, { logs, successCount, failCount });
    }
  } catch (e) {
    try {
      if (targetConn) await targetConn.query(`SET FOREIGN_KEY_CHECKS = 1`);
    } catch (restoreErr) {
      logger.error('migration', '[migration] 恢复外键约束失败:', restoreErr);
    }
    
    try {
      if (sourceConn) await sourceConn.end();
      if (targetConn) await targetConn.end();
    } catch (closeErr) {
      logger.error('migration', '[migration] 关闭连接失败:', closeErr);
    }
    
    fail(res, 200, safeError(e.message), { logs: [`[ERROR] 迁移失败：${e.message}`] });
  }
});

router.post('/scan-config', async (req, res) => {
  try {
    const projectRoot = path.join(__dirname, '..', '..');
    const configFiles = [
      '.env',
      'server/.env',
      'config.js',
      'server/config.js',
      'database.php',
      'server/database.php',
      'config.yml',
      'server/config.yml',
      'config.yaml',
      'server/config.yaml'
    ];
    
    const foundFiles = [];
    
    for (const filePath of configFiles) {
      const fullPath = path.join(projectRoot, filePath);
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, 'utf8');
        foundFiles.push({
          path: filePath,
          size: content.length,
          hasDbConfig: /mysql|database|host|port|user|password/i.test(content)
        });
      }
    }
    
    ok(res, { files: foundFiles });
  } catch (e) {
    fail(res, 200, safeError(e.message), { files: [] });
  }
});

const ALLOWED_CONFIG_FILES = [
  '.env',
  'server/.env',
  'config.js',
  'server/config.js',
  'database.php',
  'server/database.php',
  'config.yml',
  'server/config.yml',
  'config.yaml',
  'server/config.yaml',
  'config.json',
  'server/config.json',
  '.config.js',
  '.database.php',
  'config.ini',
  'server/config.ini',
  'database.ini',
  'server/database.ini',
  'settings.json',
  'server/settings.json'
];

router.post('/replace-config', requireAdminCompat, validateRequest(migrationValidations.replaceConfig), async (req, res) => {
  try {
    const { files, dbConfig } = req.body;
    
    if (!files || !dbConfig) {
      return fail(res, 400, '参数不完整');
    }
    
    const projectRoot = path.join(__dirname, '..', '..');
    const results = [];
    
    for (const filePath of files) {
      try {
        if (!ALLOWED_CONFIG_FILES.includes(filePath)) {
          results.push({ file: filePath, success: false, error: '不允许修改此文件' });
          continue;
        }
        
        if (filePath.includes('..')) {
          results.push({ file: filePath, success: false, error: '非法路径' });
          continue;
        }
        
        const fullPath = path.join(projectRoot, filePath);
        if (!fs.existsSync(fullPath)) {
          results.push({ file: filePath, success: false, error: '文件不存在' });
          continue;
        }
        
        let content = fs.readFileSync(fullPath, 'utf8');
        
        if (filePath.endsWith('.env')) {
          content = content.replace(/MYSQL_HOST\s*=\s*.*/, `MYSQL_HOST=${dbConfig.host}`);
          content = content.replace(/MYSQL_PORT\s*=\s*.*/, `MYSQL_PORT=${dbConfig.port}`);
          content = content.replace(/MYSQL_DATABASE\s*=\s*.*/, `MYSQL_DATABASE=${dbConfig.database}`);
          content = content.replace(/MYSQL_USER\s*=\s*.*/, `MYSQL_USER=${dbConfig.user}`);
          content = content.replace(/MYSQL_PASSWORD\s*=\s*.*/, `MYSQL_PASSWORD=${dbConfig.password}`);
          
          content = content.replace(/DB_HOST\s*=\s*.*/, `DB_HOST=${dbConfig.host}`);
          content = content.replace(/DB_PORT\s*=\s*.*/, `DB_PORT=${dbConfig.port}`);
          content = content.replace(/DB_NAME\s*=\s*.*/, `DB_NAME=${dbConfig.database}`);
          content = content.replace(/DB_DATABASE\s*=\s*.*/, `DB_DATABASE=${dbConfig.database}`);
          content = content.replace(/DB_USER\s*=\s*.*/, `DB_USER=${dbConfig.user}`);
          content = content.replace(/DB_USERNAME\s*=\s*.*/, `DB_USERNAME=${dbConfig.user}`);
          content = content.replace(/DB_PASSWORD\s*=\s*.*/, `DB_PASSWORD=${dbConfig.password}`);
        } else if (filePath.endsWith('.js') || filePath.endsWith('.ts')) {
          content = content.replace(/host\s*[:=]\s*["'].*?["']/, `host: "${dbConfig.host}"`);
          content = content.replace(/port\s*[:=]\s*\d+/, `port: ${dbConfig.port}`);
          content = content.replace(/database\s*[:=]\s*["'].*?["']/, `database: "${dbConfig.database}"`);
          content = content.replace(/dbname\s*[:=]\s*["'].*?["']/, `dbname: "${dbConfig.database}"`);
          content = content.replace(/user\s*[:=]\s*["'].*?["']/, `user: "${dbConfig.user}"`);
          content = content.replace(/username\s*[:=]\s*["'].*?["']/, `username: "${dbConfig.user}"`);
          content = content.replace(/password\s*[:=]\s*["'].*?["']/, `password: "${dbConfig.password}"`);
        } else if (filePath.endsWith('.php')) {
          content = content.replace(/['"]host['"]\s*=>\s*['"].*?['"]/, `"host" => "${dbConfig.host}"`);
          content = content.replace(/['"]port['"]\s*=>\s*\d+/, `"port" => ${dbConfig.port}`);
          content = content.replace(/['"]database['"]\s*=>\s*['"].*?['"]/, `"database" => "${dbConfig.database}"`);
          content = content.replace(/['"]dbname['"]\s*=>\s*['"].*?['"]/, `"dbname" => "${dbConfig.database}"`);
          content = content.replace(/['"]user['"]\s*=>\s*['"].*?['"]/, `"user" => "${dbConfig.user}"`);
          content = content.replace(/['"]username['"]\s*=>\s*['"].*?['"]/, `"username" => "${dbConfig.user}"`);
          content = content.replace(/['"]password['"]\s*=>\s*['"].*?['"]/, `"password" => "${dbConfig.password}"`);
        } else if (filePath.endsWith('.yml') || filePath.endsWith('.yaml')) {
          content = content.replace(/host:\s*.*/, `host: ${dbConfig.host}`);
          content = content.replace(/port:\s*\d+/, `port: ${dbConfig.port}`);
          content = content.replace(/database:\s*.*/, `database: ${dbConfig.database}`);
          content = content.replace(/dbname:\s*.*/, `dbname: ${dbConfig.database}`);
          content = content.replace(/user:\s*.*/, `user: ${dbConfig.user}`);
          content = content.replace(/username:\s*.*/, `username: ${dbConfig.user}`);
          content = content.replace(/password:\s*.*/, `password: ${dbConfig.password}`);
        } else if (filePath.endsWith('.json')) {
          try {
            const configObj = JSON.parse(content);
            const updateDbConfig = (obj) => {
              if (obj && typeof obj === 'object') {
                if (obj.host !== undefined) obj.host = dbConfig.host;
                if (obj.port !== undefined) obj.port = parseInt(dbConfig.port);
                if (obj.database !== undefined) obj.database = dbConfig.database;
                if (obj.dbname !== undefined) obj.dbname = dbConfig.database;
                if (obj.user !== undefined) obj.user = dbConfig.user;
                if (obj.username !== undefined) obj.username = dbConfig.user;
                if (obj.password !== undefined) obj.password = dbConfig.password;
                for (const key of Object.keys(obj)) {
                  updateDbConfig(obj[key]);
                }
              }
            };
            updateDbConfig(configObj);
            content = JSON.stringify(configObj, null, 2);
          } catch {
            results.push({ file: filePath, success: false, error: 'JSON解析失败' });
            continue;
          }
        } else if (filePath.endsWith('.ini')) {
          content = content.replace(/host\s*=\s*.*/, `host=${dbConfig.host}`);
          content = content.replace(/port\s*=\s*\d+/, `port=${dbConfig.port}`);
          content = content.replace(/database\s*=\s*.*/, `database=${dbConfig.database}`);
          content = content.replace(/dbname\s*=\s*.*/, `dbname=${dbConfig.database}`);
          content = content.replace(/user\s*=\s*.*/, `user=${dbConfig.user}`);
          content = content.replace(/username\s*=\s*.*/, `username=${dbConfig.user}`);
          content = content.replace(/password\s*=\s*.*/, `password=${dbConfig.password}`);
        }
        
        // P2-73：先写临时文件、备份原文件、再 rename 覆盖——rename 是原子操作，
        // 避免旧实现「备份后直接 writeFileSync 目标文件」在写入中途崩溃时留下
        // 半截配置文件（.env 被截断 = 全库连接配置损坏）。
        const backupPath = fullPath + '.bak.' + Date.now();
        const tmpPath = fullPath + '.tmp';
        fs.writeFileSync(tmpPath, content, 'utf8');
        fs.copyFileSync(fullPath, backupPath);
        fs.renameSync(tmpPath, fullPath);
        results.push({ file: filePath, success: true, message: '配置已更新' });
      } catch (e) {
        results.push({ file: filePath, success: false, error: e.message });
      }
    }
    
    ok(res, { results });
  } catch (e) {
    fail(res, 200, safeError(e.message), { results: [] });
  }
});

router.get('/panel-configs', (req, res) => {
  ok(res, { panels: PANEL_CONFIGS });
});

module.exports = router;