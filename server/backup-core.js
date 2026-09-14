/**
 * 境途同游 — 备份核心模块（P1-12 / P2-75）
 *
 * 统一手动备份（routes/backups.js）与定时自动备份（tasks.js）的实现，解决：
 *  - 「假成功」：旧实现用 stdout 管道预创建写文件，mysqldump 不存在时留下 0 字节
 *    空文件且退出码被忽略；现改为 --result-file 直写 + 退出码/体积/文件头三重校验，
 *    校验不通过一律删除残file并 reject。
 *  - 「盲删」：旧清理逻辑会删除 backups/ 目录下所有过期 .sql（含手动备份）；
 *    现自动清理仅针对 auto_ 前缀文件，手动备份只能由管理员显式删除。
 *  - 「库名快照过期」：备份目标库实时读取 holder.dbName（applyDbConfig 热切换后
 *    导出的 DB_NAME 常量不会更新）。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { holder, DB_CONFIG } = require('./db');

const BACKUP_DIR = path.join(__dirname, '..', 'backups');
const AUTO_PREFIX = 'auto_';
const MIN_VALID_BYTES = 512;

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
  return BACKUP_DIR;
}

/**
 * 校验 dump 文件头（mysqldump 输出必以含 "MySQL dump" 的注释行开头）。
 * 空文件 / 被中断的截断文件 / 错误信息文件均不通过。
 */
function dumpLooksValid(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(MIN_VALID_BYTES);
      const bytes = fs.readSync(fd, buf, 0, MIN_VALID_BYTES, 0);
      if (bytes < MIN_VALID_BYTES) return false;
      return buf.toString('utf8', 0, bytes).includes('MySQL dump');
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {
    return false;
  }
}

function formatSize(bytes) {
  return bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)} KB`
    : `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * 创建一次数据库备份。
 * @param {{ prefix?: string }} options prefix 如 'auto_'（定时任务），默认手动备份无前缀
 * @returns {Promise<{filename:string,filePath:string,size:number,sizeFormatted:string,createdAt:string}>}
 */
function createBackup({ prefix = '' } = {}) {
  return new Promise((resolve, reject) => {
    let filePath;
    try {
      ensureBackupDir();
      const dbName = holder.dbName || DB_CONFIG.database || 'jingtu_group';
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `${prefix}${dbName}_${timestamp}.sql`;
      filePath = path.join(BACKUP_DIR, filename);

      const args = [
        '--single-transaction',
        '--routines',
        '--events',
        '--hex-blob',
        '-h', String(DB_CONFIG.host),
        '-P', String(DB_CONFIG.port),
        '-u', String(DB_CONFIG.user),
        `--result-file=${filePath}`,
        dbName
      ];

      const child = spawn('mysqldump', args, {
        env: { ...process.env, MYSQL_PWD: DB_CONFIG.password || '' }
      });

      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d.toString(); });

      child.on('error', (err) => {
        if (err.code === 'ENOENT') {
          try { if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) {}
          return reject(new Error('mysqldump 命令未找到，请确保 MySQL 已正确安装且 mysqldump 在 PATH 中'));
        }
        reject(err);
      });

      child.on('close', (code) => {
        let stat = null;
        try { stat = fs.statSync(filePath); } catch (_) {}
        const valid = code === 0 && stat && stat.size >= MIN_VALID_BYTES && dumpLooksValid(filePath);
        if (!valid) {
          try { if (stat) fs.unlinkSync(filePath); } catch (_) {}
          const reason = code !== 0
            ? `mysqldump 退出码 ${code}${stderr ? '：' + stderr.trim().slice(0, 300) : ''}`
            : (!stat || stat.size < MIN_VALID_BYTES)
              ? '备份文件为空或过小，判定为无效备份'
              : '备份文件缺少 mysqldump 文件头，判定为无效备份';
          return reject(new Error('备份失败（已丢弃无效文件）：' + reason));
        }
        resolve({
          filename: path.basename(filePath),
          filePath,
          size: stat.size,
          sizeFormatted: formatSize(stat.size),
          createdAt: stat.birthtime.toISOString()
        });
      });
    } catch (e) {
      try { if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) {}
      reject(e);
    }
  });
}

/**
 * 从备份文件恢复数据库（仅接受通过完整性校验的备份）。
 * @param {string} filename backups/ 目录下的 .sql 文件名（内部会 path.basename 防穿越）
 */
function restoreBackup(filename) {
  return new Promise((resolve, reject) => {
    try {
      const safeName = path.basename(String(filename || ''));
      if (!safeName.endsWith('.sql')) {
        return reject(new Error('无效的备份文件名'));
      }
      const filePath = path.join(BACKUP_DIR, safeName);
      if (!fs.existsSync(filePath)) {
        return reject(new Error('备份文件不存在'));
      }
      if (!dumpLooksValid(filePath)) {
        return reject(new Error('备份文件未通过完整性校验（空文件或非 mysqldump 输出），拒绝恢复'));
      }

      const dbName = holder.dbName || DB_CONFIG.database || 'jingtu_group';
      const args = [
        '-h', String(DB_CONFIG.host),
        '-P', String(DB_CONFIG.port),
        '-u', String(DB_CONFIG.user),
        dbName
      ];
      const child = spawn('mysql', args, {
        env: { ...process.env, MYSQL_PWD: DB_CONFIG.password || '' }
      });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d.toString(); });

      child.on('error', (err) => {
        if (err.code === 'ENOENT') {
          return reject(new Error('mysql 命令未找到，请确保 MySQL 已正确安装且 mysql 在 PATH 中'));
        }
        reject(err);
      });

      const readStream = fs.createReadStream(filePath);
      readStream.on('error', reject);
      readStream.pipe(child.stdin);

      child.on('close', (code) => {
        if (code === 0) {
          resolve({ filename: safeName });
        } else {
          reject(new Error('恢复失败，mysql 退出码: ' + code + (stderr ? '：' + stderr.trim().slice(0, 300) : '')));
        }
      });
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * 清理过期的「自动备份」（仅 auto_ 前缀），手动备份永不被自动删除。
 * @param {number} daysToKeep
 * @returns {number} 删除数量
 */
function cleanupAutoBackups(daysToKeep) {
  if (!fs.existsSync(BACKUP_DIR)) return 0;
  const threshold = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;
  let deleted = 0;
  fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith('.sql') && f.startsWith(AUTO_PREFIX))
    .forEach((f) => {
      const fullPath = path.join(BACKUP_DIR, f);
      try {
        const stat = fs.statSync(fullPath);
        const ctime = stat.birthtime && stat.birthtime.getTime() ? stat.birthtime.getTime() : stat.ctime.getTime();
        if (ctime < threshold) {
          fs.unlinkSync(fullPath);
          deleted++;
        }
      } catch (_) {}
    });
  return deleted;
}

module.exports = {
  BACKUP_DIR,
  AUTO_PREFIX,
  ensureBackupDir,
  dumpLooksValid,
  formatSize,
  createBackup,
  restoreBackup,
  cleanupAutoBackups
};
