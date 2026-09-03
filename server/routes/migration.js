const express = require('express');
const router = express.Router();
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const { safeError } = require('../utils');
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
    
    res.json({ success: true, results });
  } catch (e) {
    res.json({ success: false, error: safeError(e.message), results: [] });
  }
});

router.post('/test-connection', validateRequest(migrationValidations.testConnection), async (req, res) => {
  try {
    const { host, port, database, user, password } = req.body;
    
    if (!host || !port || !database || !user || !password) {
      return res.status(400).json({ success: false, error: '参数不完整' });
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
    
    res.json({ success: true, message: '数据库连接成功！' });
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
    
    res.json({ success: false, error: errorMsg, errorType });
  }
});

router.post('/get-databases', async (req, res) => {
  try {
    const { host, port, user, password } = req.body;
    
    if (!host || !port || !user || !password) {
      return res.status(400).json({ success: false, error: '参数不完整' });
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
    
    res.json({ success: true, databases: filtered });
  } catch (e) {
    res.json({ success: false, error: safeError(e.message) });
  }
});

router.post('/get-tables', async (req, res) => {
  try {
    const { host, port, database, user, password } = req.body;
    
    if (!host || !port || !database || !user || !password) {
      return res.status(400).json({ success: false, error: '参数不完整' });
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
    
    res.json({ success: true, tables: tableNames });
  } catch (e) {
    res.json({ success: false, error: safeError(e.message) });
  }
});

router.post('/migrate', requireAdminCompat, validateRequest(migrationValidations.migrate), async (req, res) => {
  let sourceConn = null;
  let targetConn = null;
  
  try {
    const { sourceDb, targetDb, tables } = req.body;
    
    if (!sourceDb || !targetDb) {
      return res.status(400).json({ success: false, error: '源数据库和目标数据库配置不能为空' });
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
      return res.status(400).json({
        success: false,
        error: `包含非法或不存在的表: ${invalidTables.join(', ')}`
      });
    }

    logs.push(`[INFO] 待迁移表数量：${tableNames.length}`);
    
    await targetConn.query(`SET FOREIGN_KEY_CHECKS = 0`);
    logs.push(`[INFO] 已禁用目标数据库外键约束`);
    
    await targetConn.beginTransaction();
    logs.push(`[INFO] 已开始数据库事务`);
    
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
        
        const [data] = await sourceConn.query(`SELECT * FROM \`${tableName}\``);
        if (data.length > 0) {
          const columns = Object.keys(data[0]);
          const insertSql = `INSERT INTO \`${tableName}\` (${columns.map(c => `\`${c}\``).join(', ')}) VALUES ?`;
          
          const batchSize = 100;
          for (let j = 0; j < data.length; j += batchSize) {
            const batch = data.slice(j, j + batchSize);
            const values = batch.map(row => columns.map(c => row[c]));
            await targetConn.query(insertSql, [values]);
          }
        }
        
        successCount++;
        logs.push(`[SUCCESS] 表 ${tableName} 迁移成功 (${data.length} 条记录)`);
      } catch (e) {
        failCount++;
        logs.push(`[ERROR] 表 ${tableName} 迁移失败：${e.message}`);
      }
    }
    
    await targetConn.commit();
    logs.push(`[SUCCESS] 事务已提交`);
    
    await targetConn.query(`SET FOREIGN_KEY_CHECKS = 1`);
    logs.push(`[INFO] 已启用目标数据库外键约束`);
    
    await sourceConn.end();
    await targetConn.end();
    
    logs.push(`[INFO] 迁移完成！成功：${successCount} 表，失败：${failCount} 表`);
    
    res.json({ success: true, logs });
  } catch (e) {
    try {
      if (targetConn) {
        await targetConn.query(`SET FOREIGN_KEY_CHECKS = 1`);
        await targetConn.rollback();
      }
    } catch (rollbackErr) {
      logger.error('migration', '[migration] 回滚失败:', rollbackErr);
    }
    
    try {
      if (sourceConn) await sourceConn.end();
      if (targetConn) await targetConn.end();
    } catch (closeErr) {
      logger.error('migration', '[migration] 关闭连接失败:', closeErr);
    }
    
    res.json({ success: false, error: safeError(e.message), logs: [`[ERROR] 迁移失败：${e.message}`] });
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
    
    res.json({ success: true, files: foundFiles });
  } catch (e) {
    res.json({ success: false, error: safeError(e.message), files: [] });
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
      return res.status(400).json({ success: false, error: '参数不完整' });
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
        
        const backupPath = fullPath + '.bak.' + Date.now();
        fs.writeFileSync(backupPath, fs.readFileSync(fullPath, 'utf8'), 'utf8');
        
        fs.writeFileSync(fullPath, content, 'utf8');
        results.push({ file: filePath, success: true, message: '配置已更新' });
      } catch (e) {
        results.push({ file: filePath, success: false, error: e.message });
      }
    }
    
    res.json({ success: true, results });
  } catch (e) {
    res.json({ success: false, error: safeError(e.message), results: [] });
  }
});

router.get('/panel-configs', (req, res) => {
  res.json({ success: true, panels: PANEL_CONFIGS });
});

module.exports = router;