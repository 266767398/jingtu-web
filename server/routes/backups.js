/**
 * 境途同游 — 备份系统路由
 * 
 * @swagger
 * tags:
 *   name: Backups
 *   description: 数据库备份相关接口
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { requireAdminCompat } = require('../auth');
const { ok, handleError , sendError, ErrorCodes } = require('../utils');
const { DB_NAME, DB_CONFIG } = require('../db');

const router = express.Router();
const backupDir = path.join(__dirname, '..', '..', 'backups');

router.get('/admin/backups', requireAdminCompat, (req, res) => {
  try {
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
      return res.json({ backups: [], total: 0 });
    }

    const files = fs.readdirSync(backupDir)
      .filter(f => f.endsWith('.sql'))
      .map(f => {
        const stat = fs.statSync(path.join(backupDir, f));
        return {
          name: f,
          size: stat.size,
          sizeFormatted: stat.size < 1024 * 1024 
            ? `${(stat.size / 1024).toFixed(1)} KB` 
            : `${(stat.size / 1024 / 1024).toFixed(2)} MB`,
          createdAt: stat.birthtime.toISOString(),
          modifiedAt: stat.mtime.toISOString()
        };
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json({ backups: files, total: files.length });
  } catch (e) { handleError(res, e, '[backups/list]'); }
});

router.get('/admin/backups/:filename/download', requireAdminCompat, (req, res) => {
  try {
    // §47：用 path.basename 去除任何路径前缀，防止路径穿越
    const filename = path.basename(req.params.filename);
    if (!filename.endsWith('.sql')) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '无效的备份文件名');
    }

    const filePath = path.join(backupDir, filename);
    if (!fs.existsSync(filePath)) {
      return sendError(res, 404, ErrorCodes.NOT_FOUND, '备份文件不存在');
    }

    res.setHeader('Content-Type', 'application/sql');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.sendFile(filePath);
  } catch (e) { handleError(res, e, '[backups/download]'); }
});

router.delete('/admin/backups/:filename', requireAdminCompat, (req, res) => {
  try {
    // §47：用 path.basename 去除任何路径前缀，防止路径穿越
    const filename = path.basename(req.params.filename);
    if (!filename.endsWith('.sql')) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '无效的备份文件名');
    }

    const filePath = path.join(backupDir, filename);
    if (!fs.existsSync(filePath)) {
      return sendError(res, 404, ErrorCodes.NOT_FOUND, '备份文件不存在');
    }

    fs.unlinkSync(filePath);
    ok(res, {message: '备份文件已删除'});
  } catch (e) { handleError(res, e, '[backups/delete]'); }
});

router.post('/admin/backups/cleanup', requireAdminCompat, (req, res) => {
  try {
    const { keepDays } = req.body;
    const days = parseInt(keepDays) || 30;
    const threshold = Date.now() - days * 24 * 60 * 60 * 1000;

    if (!fs.existsSync(backupDir)) {
      return ok(res, {deleted: 0, message: '备份目录不存在'});
    }

    let deleted = 0;
    const files = fs.readdirSync(backupDir).filter(f => f.endsWith('.sql'));

    for (const f of files) {
      const filePath = path.join(backupDir, f);
      const stat = fs.statSync(filePath);
      if (stat.birthtime.getTime() < threshold) {
        fs.unlinkSync(filePath);
        deleted++;
      }
    }

    ok(res, {deleted, message: `已清理 ${deleted} 个过期备份`});
  } catch (e) { handleError(res, e, '[backups/cleanup]'); }
});

router.post('/admin/backups/create', requireAdminCompat, async (req, res) => {
  try {
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${DB_NAME}_${timestamp}.sql`;
    const filePath = path.join(backupDir, filename);

    const args = [
      '-h', DB_CONFIG.host,
      '-P', DB_CONFIG.port,
      '-u', DB_CONFIG.user,
      DB_NAME
    ];

    const mysqldump = spawn('mysqldump', args, {
      env: { ...process.env, MYSQL_PWD: DB_CONFIG.password || '' }
    });
    const writeStream = fs.createWriteStream(filePath);

    mysqldump.stdout.pipe(writeStream);

    return new Promise((resolve, reject) => {
      mysqldump.on('error', (err) => {
        if (err.code === 'ENOENT') {
          handleError(res, new Error('mysqldump 命令未找到，请确保 MySQL 已正确安装且 mysqldump 在 PATH 中'), 'backups');
          return resolve();
        }
        reject(err);
      });

      mysqldump.on('close', (code) => {
        if (code === 0) {
          const stat = fs.statSync(filePath);
          resolve(ok(res, {filename,
            size: stat.size,
            sizeFormatted: stat.size < 1024 * 1024 
              ? `${(stat.size / 1024).toFixed(1)} KB` 
              : `${(stat.size / 1024 / 1024).toFixed(2)} MB`,
            createdAt: stat.birthtime.toISOString(),
            message: '数据库备份创建成功'}));
        } else {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
          handleError(res, new Error('备份失败，mysqldump 退出码: ' + code), 'backups');
          resolve();
        }
      });
    });
  } catch (e) { handleError(res, e, '[backups/create]'); }
});

router.post('/admin/backups/restore/:filename', requireAdminCompat, async (req, res) => {
  try {
    // §47：用 path.basename 去除任何路径前缀，防止路径穿越
    const filename = path.basename(req.params.filename);
    if (!filename.endsWith('.sql')) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '无效的备份文件名');
    }

    const filePath = path.join(backupDir, filename);
    if (!fs.existsSync(filePath)) {
      return sendError(res, 404, ErrorCodes.NOT_FOUND, '备份文件不存在');
    }

    const args = [
      '-h', DB_CONFIG.host,
      '-P', DB_CONFIG.port,
      '-u', DB_CONFIG.user,
      DB_NAME
    ];

    const mysql = spawn('mysql', args, {
      env: { ...process.env, MYSQL_PWD: DB_CONFIG.password || '' }
    });
    const readStream = fs.createReadStream(filePath);

    readStream.pipe(mysql.stdin);

    return new Promise((resolve, reject) => {
      mysql.on('error', (err) => {
        if (err.code === 'ENOENT') {
          handleError(res, new Error('mysql 命令未找到，请确保 MySQL 已正确安装且 mysql 在 PATH 中'), 'backups');
          return resolve();
        }
        reject(err);
      });

      mysql.on('close', (code) => {
        if (code === 0) {
          resolve(ok(res, {filename,
            message: '数据库恢复成功'}));
        } else {
          handleError(res, new Error('恢复失败，mysql 退出码: ' + code), 'backups');
          resolve();
        }
      });
    });
  } catch (e) { handleError(res, e, '[backups/restore]'); }
});

module.exports = router;
