/**
 * 境途同游 V5.2 — 公告路由
 * 
 * @swagger
 * tags:
 *   name: Announcements
 *   description: 公告管理相关接口
 */
const express = require('express');
const { getPool, logOper, validateFields, handleError , sendError, ErrorCodes } = require('../utils');
const { requireAdminCompat } = require('../auth');



module.exports = function (notificationService) {
  const router = express.Router();

// POST /api/announcements/:id/attachments — 上传公告附件
router.post('/:id/attachments', requireAdminCompat, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
    const [announcement] = await getPool().query('SELECT id FROM announcement WHERE id = ?', [id]);
    if (announcement.length === 0) return sendError(res, 404, ErrorCodes.NOT_FOUND, '公告不存在');
    const { filename, url, fileSize, mimeType } = req.body;
    if (!filename || !url) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '缺少文件名或URL');
    await getPool().query(
      'INSERT INTO announcement_attachments (announcement_id, filename, url, file_size, mime_type) VALUES (?, ?, ?, ?, ?)',
      [id, filename, url, fileSize || 0, mimeType || '']
    );
    await logOper(req.session.userId, '上传公告附件', `公告ID: ${id}, 文件: ${filename}`);
    res.json({ success: true });
  } catch (e) { handleError(res, e, '[announcements/attachments/upload]'); }
});

// GET /api/announcements/:id/attachments — 获取公告附件列表
router.get('/:id/attachments', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
    const [rows] = await getPool().query(
      'SELECT id, filename, url, file_size AS fileSize, mime_type AS mimeType, create_time AS createTime FROM announcement_attachments WHERE announcement_id = ? ORDER BY create_time ASC',
      [id]
    );
    res.json({ attachments: rows });
  } catch (e) { handleError(res, e, '[announcements/attachments/list]'); }
});

// DELETE /api/announcements/:id/attachments/:attachmentId — 删除公告附件
router.delete('/:id/attachments/:attachmentId', requireAdminCompat, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const attachmentId = parseInt(req.params.attachmentId);
    if (!id || !attachmentId) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
    await getPool().query('DELETE FROM announcement_attachments WHERE id = ? AND announcement_id = ?', [attachmentId, id]);
    await logOper(req.session.userId, '删除公告附件', `公告ID: ${id}, 附件ID: ${attachmentId}`);
    res.json({ success: true });
  } catch (e) { handleError(res, e, '[announcements/attachments/delete]'); }
});

// GET /api/announcements/:id/history — 获取公告历史版本
router.get('/:id/history', requireAdminCompat, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
    const [rows] = await getPool().query(
      'SELECT id, version, title, content, create_admin AS admin, create_time AS createTime FROM announcement_history WHERE announcement_id = ? ORDER BY version DESC',
      [id]
    );
    res.json({ history: rows });
  } catch (e) { handleError(res, e, '[announcements/history]'); }
});

// POST /api/announcements/:id/restore/:version — 恢复公告历史版本
router.post('/:id/restore/:version', requireAdminCompat, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const version = parseInt(req.params.version);
    if (!id || !version) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
    const [history] = await getPool().query(
      'SELECT title, content FROM announcement_history WHERE announcement_id = ? AND version = ?',
      [id, version]
    );
    if (history.length === 0) return sendError(res, 404, ErrorCodes.NOT_FOUND, '历史版本不存在');
    const current = history[0];
    await getPool().query('UPDATE announcement SET title = ?, content = ? WHERE id = ?', [current.title, current.content, id]);
    await logOper(req.session.userId, '恢复公告版本', `公告ID: ${id}, 版本: ${version}`);
    res.json({ success: true });
  } catch (e) { handleError(res, e, '[announcements/restore]'); }
});

/**
 * @swagger
 * /api/announcements:
 *   get:
 *     summary: 获取公告列表
 *     description: 获取公告列表，未登录用户仅能查看公开公告
 *     tags: [Announcements]
 *     responses:
 *       200:
 *         description: 公告列表
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 announcements:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: integer
 *                       title:
 *                         type: string
 *                       content:
 *                         type: string
 *                       pinned:
 *                         type: integer
 *                       visibility:
 *                         type: string
 */
router.get('/', async (req, res) => {
  try {
    const userRole = req.session?.role;
    const visFilter = !userRole ? " AND visibility='public'" : '';
    const sql = `SELECT id, title, content, create_admin AS admin, create_time AS createTime, IFNULL(updated_at, create_time) AS updatedAt, IFNULL(is_pinned, 0) AS pinned, IFNULL(visibility, 'public') AS visibility FROM announcement WHERE 1=1${visFilter} ORDER BY is_pinned DESC, create_time DESC LIMIT 30`;
    const [rows] = await getPool().query(sql);
    rows.forEach(r => {
      if (!r.updatedAt) r.updatedAt = r.createTime;
      r.createdAt = r.createTime;
    });
    return res.json({ announcements: rows });
  } catch (e) {
    if (e.code === 'ER_BAD_FIELD_ERROR') {
      try { await getPool().query(`ALTER TABLE announcement ADD COLUMN is_pinned TINYINT DEFAULT 0`); } catch {}
      try { await getPool().query(`ALTER TABLE announcement ADD COLUMN visibility ENUM('public','members_only') DEFAULT 'public'`); } catch {}
      try { await getPool().query(`ALTER TABLE announcement ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`); } catch {}
      try {
        const [rows] = await getPool().query(`SELECT id, title, content, create_admin AS admin, create_time AS createTime, IFNULL(updated_at, create_time) AS updatedAt, 0 AS pinned, 'public' AS visibility FROM announcement ORDER BY create_time DESC LIMIT 30`);
        rows.forEach(r => { r.createdAt = r.createTime; });
        return res.json({ announcements: rows });
      } catch (e2) { return handleError(res, e2, '[announcements/list/fallback]'); }
    }
    handleError(res, e, '[announcements/list]');
  }
});

router.get('/search', async (req, res) => {
  try {
    const q = req.query.q ? req.query.q.trim() : '';
    if (!q || q.length < 2) return res.json({ announcements: [], total: 0 });
    const like = '%' + q + '%';
    // 仅登录用户可见 members_only 公告，匿名仅可见 public
    const userId = req.session?.userId || null;
    const [rows] = await getPool().query(
      "SELECT id, title, content, create_time, is_pinned, visibility FROM announcement WHERE (title LIKE ? OR content LIKE ?) AND (visibility='public' OR (? IS NOT NULL AND visibility IN ('members_only','public'))) ORDER BY is_pinned DESC, create_time DESC LIMIT 20",
      [like, like, userId]
    );
    const announcements = rows.map(a => ({
      ...a,
      content: a.content.length > 100 ? a.content.substring(0, 100) + '…' : a.content
    }));
    res.json({ announcements, total: announcements.length });
  } catch (e) {
    handleError(res, e, '[announcements/search]');
  }
});

router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
    const [rows] = await getPool().query(
      `SELECT id, title, content, create_admin AS admin, create_time AS createTime, IFNULL(updated_at, create_time) AS updatedAt, IFNULL(is_pinned, 0) AS pinned, visibility FROM announcement WHERE id = ?`, [id]
    );
    if (rows.length === 0) return sendError(res, 404, ErrorCodes.NOT_FOUND, '公告不存在');
    // 可见性控制：members_only 公告仅登录用户可见，匿名用户访问返回 404（与列表/搜索接口保持一致，避免越权）
    if (rows[0].visibility === 'members_only' && !req.session?.userId) {
      return sendError(res, 404, ErrorCodes.NOT_FOUND, '公告不存在');
    }
    if (!rows[0].updatedAt) rows[0].updatedAt = rows[0].createTime;
    rows[0].createdAt = rows[0].createTime;
    res.json({ announcement: rows[0] });
  } catch (e) { handleError(res, e, '[announcements/get]'); }
});

// POST /api/announcements — 创建公告
router.post('/', requireAdminCompat, async (req, res) => {
  const { title, content, pinned, visibility } = req.body;
  if (!title || !content) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '标题和内容不能为空');
  if (typeof title !== 'string' || title.length > 200) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '标题不能超过200字');
  if (typeof content !== 'string' || content.length > 50000) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '内容不能超过50000字');
  const vis = visibility || 'members_only';
  try {
    let result;
    try {
      [result] = await getPool().query(
        `INSERT INTO announcement (title, content, create_admin, is_pinned, visibility) VALUES (?, ?, ?, ?, ?)`,
        [title, content, req.session.displayName || '管理员', pinned ? 1 : 0, vis]
      );
    } catch (e2) {
      if (e2.code === 'ER_BAD_FIELD_ERROR') {
        [result] = await getPool().query(
          `INSERT INTO announcement (title, content, create_admin) VALUES (?, ?, ?)`,
          [title, content, req.session.displayName || '管理员']
        );
      } else throw e2;
    }
    await logOper(req.session.userId, '发布公告', `标题: ${title}`);
    if (notificationService) notificationService.notifyAllMembers('announcement', `📢 新公告: ${title}`, content.substring(0, 100), { relatedId: result.insertId, targetType: 'announcement', targetId: result.insertId });
    res.json({ success: true, id: result.insertId });
  } catch (e) { handleError(res, e, '[announcements/create]'); }
});

// PUT /api/announcements/:id — 编辑公告
router.put('/:id', requireAdminCompat, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
    const { title, content, pinned, visibility } = req.body;
    if (title && (typeof title !== 'string' || title.length > 200)) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '标题不能超过200字');
    if (content && (typeof content !== 'string' || content.length > 50000)) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '内容不能超过50000字');
    const [current] = await getPool().query('SELECT title, content, create_admin FROM announcement WHERE id = ?', [id]);
    if (current.length > 0) {
      const [maxVer] = await getPool().query('SELECT MAX(version) as mv FROM announcement_history WHERE announcement_id = ?', [id]);
      const nextVer = (maxVer[0].mv || 0) + 1;
      await getPool().query(
        'INSERT INTO announcement_history (announcement_id, version, title, content, create_admin) VALUES (?, ?, ?, ?, ?)',
        [id, nextVer, current[0].title, current[0].content, current[0].create_admin]
      ).catch(() => {});
    }
    const updates = {};
    if (title !== undefined) updates.title = title;
    if (content !== undefined) updates.content = content;
    if (pinned !== undefined) updates.is_pinned = pinned ? 1 : 0;
    if (visibility !== undefined) updates.visibility = visibility;
    const ALLOWED_FIELDS = ['title', 'content', 'is_pinned', 'visibility'];
    validateFields(updates, ALLOWED_FIELDS);
    if (Object.keys(updates).length === 0) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '无更新字段');
    const sets = Object.keys(updates).map(k => `${k}=?`).join(',');
    const vals = Object.values(updates);
    vals.push(id);
    try {
      await getPool().query(`UPDATE announcement SET ${sets} WHERE id=?`, vals);
    } catch (e2) {
      if (e2.code === 'ER_BAD_FIELD_ERROR') {
        const fallbackUpdates = {};
        if (title !== undefined) fallbackUpdates.title = title;
        if (content !== undefined) fallbackUpdates.content = content;
        const fSets = Object.keys(fallbackUpdates).map(k => `${k}=?`).join(',');
        if (!fSets) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '该版本不支持置顶/可见性');
        const fVals = Object.values(fallbackUpdates);
        fVals.push(id);
        await getPool().query(`UPDATE announcement SET ${fSets} WHERE id=?`, fVals);
      } else throw e2;
    }
    await logOper(req.session.userId, '编辑公告', `ID: ${id}, 标题: ${title || '不变'}`);
    res.json({ success: true });
  } catch (e) { handleError(res, e, '[announcements/update]'); }
});

// DELETE /api/announcements/:id — 删除公告
router.delete('/:id', requireAdminCompat, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
    // 级联清理：通知、附件、历史版本、公告本身，避免孤儿数据
    await getPool().query(`DELETE FROM notifications WHERE target_type='announcement' AND target_id=?`, [id]);
    await getPool().query(`DELETE FROM announcement_attachments WHERE announcement_id=?`, [id]);
    await getPool().query(`DELETE FROM announcement_history WHERE announcement_id=?`, [id]);
    await getPool().query(`DELETE FROM announcement WHERE id = ?`, [id]);
    await logOper(req.session.userId, '删除公告', `ID: ${id}`);
    res.json({ success: true });
  } catch (e) { handleError(res, e, '[announcements/delete]'); }
});


return router;
};
