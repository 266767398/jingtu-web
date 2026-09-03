/**
 * 境途同游 — 文件管理路由
 *
 * @swagger
 * tags:
 *   name: Files
 *   description: 文件管理相关接口
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { requireAdminCompat } = require('../auth');
const { handleError , sendError, ErrorCodes } = require('../utils');

const router = express.Router();
const uploadsDir = path.join(__dirname, '..', '..', 'uploads');

// §69: 路径校验，防止兄弟目录前缀绕过（如 uploads-evil 以 uploads 开头但非子目录）
function isWithinUploads(fullPath) {
  return fullPath === uploadsDir || fullPath.startsWith(uploadsDir + path.sep);
}

// §35: walkDir 递归深度上限，防止循环符号链接或异常深目录导致栈溢出
const WALK_MAX_DEPTH = 10;

/**
 * @swagger
 * /api/admin/files:
 *   get:
 *     summary: 获取文件列表
 *     description: 获取上传目录下的所有文件列表（管理员权限）
 *     tags: [Files]
 *     responses:
 *       200:
 *         description: 文件列表
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 files:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                       path:
 *                         type: string
 *                       size:
 *                         type: integer
 *                       sizeFormatted:
 *                         type: string
 *                 total:
 *                   type: integer
 *       403:
 *         description: 权限不足
 */
router.get('/admin/files', requireAdminCompat, async (req, res) => {
  try {
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
      return res.json({ files: [], total: 0 });
    }

    const files = [];
    // §35: 改用 fs.promises 异步 API；walkDir 增加 maxDepth 限制递归深度
    const walkDir = async (dir, prefix = '', depth = 0) => {
      if (depth > WALK_MAX_DEPTH) return;
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          await walkDir(fullPath, relPath, depth + 1);
        } else {
          const stat = await fs.promises.stat(fullPath);
          files.push({
            name: entry.name,
            path: relPath,
            size: stat.size,
            sizeFormatted: stat.size < 1024
              ? `${stat.size} B`
              : stat.size < 1024 * 1024
                ? `${(stat.size / 1024).toFixed(1)} KB`
                : `${(stat.size / 1024 / 1024).toFixed(2)} MB`,
            type: path.extname(entry.name).slice(1).toUpperCase() || 'FILE',
            createdAt: stat.birthtime.toISOString(),
            modifiedAt: stat.mtime.toISOString()
          });
        }
      }
    };
    await walkDir(uploadsDir);

    const totalSize = files.reduce((sum, f) => sum + f.size, 0);

    res.json({
      files,
      total: files.length,
      totalSize: totalSize < 1024 * 1024
        ? `${(totalSize / 1024).toFixed(1)} KB`
        : `${(totalSize / 1024 / 1024).toFixed(2)} MB`,
      totalSizeBytes: totalSize
    });
  } catch (e) { handleError(res, e, '[files/list]'); }
});

router.delete('/admin/files/:filepath', requireAdminCompat, async (req, res) => {
  try {
    const filePath = decodeURIComponent(req.params.filepath);
    const fullPath = path.join(uploadsDir, filePath);

    // §69: 用严格前缀校验防止兄弟目录绕过
    if (!isWithinUploads(fullPath)) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '无效的文件路径');
    }

    if (!fs.existsSync(fullPath)) {
      return sendError(res, 404, ErrorCodes.NOT_FOUND, '文件不存在');
    }

    // §35: 异步 unlink
    await fs.promises.unlink(fullPath);
    res.json({ success: true, message: '文件已删除' });
  } catch (e) { handleError(res, e, '[files/delete]'); }
});

router.get('/admin/files/:filepath/download', requireAdminCompat, (req, res) => {
  try {
    const filePath = decodeURIComponent(req.params.filepath);
    const fullPath = path.join(uploadsDir, filePath);

    // §69: 严格前缀校验
    if (!isWithinUploads(fullPath)) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '无效的文件路径');
    }

    if (!fs.existsSync(fullPath)) {
      return sendError(res, 404, ErrorCodes.NOT_FOUND, '文件不存在');
    }

    const filename = path.basename(fullPath);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.sendFile(fullPath);
  } catch (e) { handleError(res, e, '[files/download]'); }
});

router.post('/admin/files/create-dir', requireAdminCompat, (req, res) => {
  try {
    const { name, parent } = req.body;
    if (!name || !name.trim()) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '目录名称不能为空');
    }

    const parentPath = parent ? path.join(uploadsDir, parent) : uploadsDir;
    const newDir = path.join(parentPath, name.trim());

    // §69: 严格前缀校验
    if (!isWithinUploads(newDir)) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '无效的目录路径');
    }

    fs.mkdirSync(newDir, { recursive: true });
    res.json({ success: true, message: '目录已创建' });
  } catch (e) { handleError(res, e, '[files/create-dir]'); }
});

router.post('/admin/files/cleanup', requireAdminCompat, async (req, res) => {
  try {
    const { days } = req.body;
    // §35: 校验 days 类型与范围，避免 days=-1 删除未来文件、days="abc" 算 NaN
    if (!Number.isFinite(days) || days < 0 || days > 3650) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'days 参数无效（需为 0-3650 之间的数字）');
    }
    const threshold = Date.now() - days * 24 * 60 * 60 * 1000;

    let deleted = 0;
    let freed = 0;

    // §35: 异步遍历 + 深度限制
    const cleanupDir = async (dir, depth = 0) => {
      if (depth > WALK_MAX_DEPTH) return;
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await cleanupDir(fullPath, depth + 1);
        } else {
          const stat = await fs.promises.stat(fullPath);
          if (stat.mtime.getTime() < threshold) {
            freed += stat.size;
            await fs.promises.unlink(fullPath);
            deleted++;
          }
        }
      }
    };

    if (fs.existsSync(uploadsDir)) {
      await cleanupDir(uploadsDir);
    }

    res.json({
      success: true,
      deleted,
      freed: freed < 1024 * 1024
        ? `${(freed / 1024).toFixed(1)} KB`
        : `${(freed / 1024 / 1024).toFixed(2)} MB`,
      freedBytes: freed,
      message: `已清理 ${deleted} 个过期文件，释放 ${freed < 1024 * 1024 ? (freed / 1024).toFixed(1) + ' KB' : (freed / 1024 / 1024).toFixed(2) + ' MB'}`
    });
  } catch (e) { handleError(res, e, '[files/cleanup]'); }
});

router.post('/admin/files/rename', requireAdminCompat, async (req, res) => {
  try {
    const { filepath, newName } = req.body;
    if (!filepath || !newName || !newName.trim()) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '文件路径和新名称不能为空');
    }

    const fullPath = path.join(uploadsDir, filepath);

    // §69: 严格前缀校验
    if (!isWithinUploads(fullPath)) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '无效的文件路径');
    }

    if (!fs.existsSync(fullPath)) {
      return sendError(res, 404, ErrorCodes.NOT_FOUND, '文件不存在');
    }

    const dir = path.dirname(fullPath);
    const newFullPath = path.join(dir, newName.trim());

    // §69: 严格前缀校验
    if (!isWithinUploads(newFullPath)) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '新文件路径无效');
    }

    if (fs.existsSync(newFullPath)) {
      return sendError(res, 409, ErrorCodes.CONFLICT, '目标文件已存在');
    }

    // §35: 异步 rename
    await fs.promises.rename(fullPath, newFullPath);
    res.json({ success: true, message: '文件已重命名', newPath: newFullPath.replace(uploadsDir + path.sep, '') });
  } catch (e) { handleError(res, e, '[files/rename]'); }
});

module.exports = router;
