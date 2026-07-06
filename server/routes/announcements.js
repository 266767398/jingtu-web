/**
 * 境途同游 V5.2 — 公告路由
 */
const express = require('express');
const router = express.Router();
const { getPool, safeError, logOper } = require('../utils');
const { requireAdminCompat } = require('../auth');

// 辅助函数 — 群发通知
async function notifyAllMembers(type, title, message, relatedId) {
  try {
    const [users] = await getPool().query(`SELECT id FROM users WHERE deleted_at IS NULL AND banned = 0`);
    for (const u of users) {
      await getPool().query(
        `INSERT INTO notifications (user_id, type, title, message, related_id) VALUES (?, ?, ?, ?, ?)`,
        [u.id, type, title, message, relatedId || null]
      );
    }
  } catch (e) { console.warn('⚠️ 群发通知失败:', e.message); }
}

// GET /api/announcements — 获取公告列表
router.get('/', async (req, res) => {
  try {
    const userRole = req.session?.role;
    const visFilter = !userRole ? " AND visibility='public'" : '';
    const sql = `SELECT id, title, content, create_admin AS admin, create_time AS createTime, create_time AS updatedAt, IFNULL(is_pinned, 0) AS pinned, IFNULL(visibility, 'public') AS visibility FROM announcement WHERE 1=1${visFilter} ORDER BY is_pinned DESC, create_time DESC LIMIT 30`;
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
      try {
        const [rows] = await getPool().query(`SELECT id, title, content, create_admin AS admin, create_time AS createTime, create_time AS updatedAt, 0 AS pinned, 'public' AS visibility FROM announcement ORDER BY create_time DESC LIMIT 30`);
        rows.forEach(r => { r.createdAt = r.createTime; });
        return res.json({ announcements: rows });
      } catch (e2) { return res.status(500).json({ error: safeError(e2.message) }); }
    }
    res.status(500).json({ error: safeError(e.message) });
  }
});

// GET /api/announcements/:id — 获取公告详情
router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: '参数错误' });
    const [rows] = await getPool().query(
      `SELECT id, title, content, create_admin AS admin, create_time AS createTime, create_time AS updatedAt, IFNULL(is_pinned, 0) AS pinned, visibility FROM announcement WHERE id = ?`, [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: '公告不存在' });
    if (!rows[0].updatedAt) rows[0].updatedAt = rows[0].createTime;
    rows[0].createdAt = rows[0].createTime;
    res.json({ announcement: rows[0] });
  } catch (e) { console.error('[announcements]', e); res.status(500).json({ error: safeError(e.message) }); }
});

// POST /api/announcements — 创建公告
router.post('/', requireAdminCompat, async (req, res) => {
  const { title, content, pinned, visibility } = req.body;
  if (!title || !content) return res.status(400).json({ error: '标题和内容不能为空' });
  if (typeof title !== 'string' || title.length > 200) return res.status(400).json({ error: '标题不能超过200字' });
  if (typeof content !== 'string' || content.length > 50000) return res.status(400).json({ error: '内容不能超过50000字' });
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
    notifyAllMembers('announcement', `📢 新公告: ${title}`, content.substring(0, 100), result.insertId);
    res.json({ success: true, id: result.insertId });
  } catch (e) { console.error('[announcements]', e); res.status(500).json({ error: safeError(e.message) }); }
});

// PUT /api/announcements/:id — 编辑公告
router.put('/:id', requireAdminCompat, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: '参数错误' });
    const { title, content, pinned, visibility } = req.body;
    if (title && (typeof title !== 'string' || title.length > 200)) return res.status(400).json({ error: '标题不能超过200字' });
    if (content && (typeof content !== 'string' || content.length > 50000)) return res.status(400).json({ error: '内容不能超过50000字' });
    const updates = {};
    if (title !== undefined) updates.title = title;
    if (content !== undefined) updates.content = content;
    if (pinned !== undefined) updates.is_pinned = pinned ? 1 : 0;
    if (visibility !== undefined) updates.visibility = visibility;
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: '无更新字段' });
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
        if (!fSets) return res.status(400).json({ error: '该版本不支持置顶/可见性' });
        const fVals = Object.values(fallbackUpdates);
        fVals.push(id);
        await getPool().query(`UPDATE announcement SET ${fSets} WHERE id=?`, fVals);
      } else throw e2;
    }
    await logOper(req.session.userId, '编辑公告', `ID: ${id}, 标题: ${title || '不变'}`);
    res.json({ success: true });
  } catch (e) { console.error('[announcements]', e); res.status(500).json({ error: safeError(e.message) }); }
});

// DELETE /api/announcements/:id — 删除公告
router.delete('/:id', requireAdminCompat, async (req, res) => {
  try {
    await getPool().query(`DELETE FROM announcement WHERE id = ?`, [req.params.id]);
    res.json({ success: true });
  } catch (e) { console.error('[announcements]', e); res.status(500).json({ error: safeError(e.message) }); }
});

module.exports = router;
