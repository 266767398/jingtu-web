/**
 * 境途同游 — 备份系统路由
 *
 * P1-12 / P1-16 / P2-75：备份的创建/恢复/清理统一委托 backup-core，
 * 由其做「退出码 + 文件体积 + mysqldump 文件头」三重校验并实时读取当前库名
 * （holder.dbName），避免旧实现中 mysqldump 失败仍留 0 字节假备份、
 * 空备份"恢复成功"、DB_NAME 模块加载期快照过期等问题。
 *
 * @swagger
 * tags:
 *   name: Backups
 *   description: 数据库备份相关接口
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { requireAdminCompat, requireSuperAdmin } = require('../auth');
const { ok, handleError, sendError, ErrorCodes } = require('../utils');
const {
  BACKUP_DIR: backupDir,
  AUTO_PREFIX,
  ensureBackupDir,
  formatSize,
  createBackup,
  restoreBackup,
  cleanupAutoBackups
} = require('../backup-core');

const router = express.Router();

router.get('/admin/backups', requireAdminCompat, (req, res) => {
  try {
    if (!fs.existsSync(backupDir)) {
      ensureBackupDir();
      return res.json({ backups: [], total: 0 });
    }

    const files = fs.readdirSync(backupDir)
      .filter(f => f.endsWith('.sql'))
      .map(f => {
        const stat = fs.statSync(path.join(backupDir, f));
        return {
          name: f,
          type: f.startsWith(AUTO_PREFIX) ? 'auto' : 'manual',
          size: stat.size,
          sizeFormatted: formatSize(stat.size),
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

router.delete('/admin/backups/:filename', requireSuperAdmin, (req, res) => {
  // P2-160（R1）：删除/清理/创建/恢复均提升为 requireSuperAdmin——备份含全库 PII 与
  // 可回滚到任意状态的恢复能力，普通管理员（admin）不得触及破坏性操作；仅列表/下载保留 admin。
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

router.post('/admin/backups/cleanup', requireSuperAdmin, (req, res) => {
  try {
    const { keepDays } = req.body;
    const days = parseInt(keepDays) || 30;

    if (!fs.existsSync(backupDir)) {
      return ok(res, {deleted: 0, message: '备份目录不存在'});
    }

    // P2-75：只清理过期的自动备份（auto_ 前缀）；手动备份仅能由管理员显式删除
    const deleted = cleanupAutoBackups(days);

    ok(res, {deleted, message: `已清理 ${deleted} 个过期自动备份（手动备份不受自动清理影响）`});
  } catch (e) { handleError(res, e, '[backups/cleanup]'); }
});

router.post('/admin/backups/create', requireSuperAdmin, async (req, res) => {
  try {
    // P1-12：backup-core 内做 mysqldump 三重校验（退出码/体积/文件头），
    // 校验不通过自动丢弃残file并抛错，不再产生"看起来成功"的空备份
    const info = await createBackup();
    ok(res, {
      filename: info.filename,
      size: info.size,
      sizeFormatted: info.sizeFormatted,
      createdAt: info.createdAt,
      message: '数据库备份创建成功'
    });
  } catch (e) { handleError(res, e, '[backups/create]'); }
});

router.post('/admin/backups/restore/:filename', requireSuperAdmin, async (req, res) => {
  try {
    // §47：用 path.basename 去除任何路径前缀，防止路径穿越
    const filename = path.basename(req.params.filename);
    if (!filename.endsWith('.sql')) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '无效的备份文件名');
    }

    // P1-12：恢复前强制完整性校验，空/截断/伪造备份直接拒绝
    const info = await restoreBackup(filename);
    ok(res, {
      filename: info.filename,
      message: '数据库恢复成功'
    });
  } catch (e) {
    if (e && /无效的备份文件名|备份文件不存在|完整性校验|已有恢复任务/.test(e.message)) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, e.message);
    }
    if (e && /命令未找到/.test(e.message)) {
      return sendError(res, 500, ErrorCodes.INTERNAL_ERROR, e.message);
    }
    // P1-48: 恢复失败（含自动回滚结果）直接透出给管理员，不被通用安全消息吞掉
    if (e && typeof e.rolledBack !== 'undefined') {
      return sendError(res, 500, ErrorCodes.INTERNAL_ERROR,
        '恢复失败：' + (e.message || '未知错误')
        + (e.rollbackNote ? '；' + e.rollbackNote : '')
        + (e.rollbackFatal ? '；回滚也失败，请立即人工介入：' + e.rollbackFatal : ''));
    }
    handleError(res, e, '[backups/restore]');
  }
});

module.exports = router;
