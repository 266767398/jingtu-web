/**
 * 境途同游 V5.2 — 用户标签与备注路由（P2-66：自 users.js 按域拆出，行为逐字保留）
 * 覆盖：标签字典/用户标签增删查、用户备注颜色白名单与备注增删。
 */
const express = require('express');
const router = express.Router();
const { requireAuth, requireAdminCompat } = require('../auth');
// P2-68 首轮 lint 修复：本文件自 users.js 拆出时漏掉 logOper 导入，
// 4 个写端点会在成功后抛 ReferenceError 并被 handleError 转成 500（数据已写、响应却报失败）。
const { getPool, ok, handleError, sendError, ErrorCodes, logOper } = require('../utils');

// ==================== 用户标签 API ====================
router.get('/tags/list', requireAdminCompat, async (req, res) => {
  try {
    const [rows] = await getPool().query(
      'SELECT tag_name AS name, COUNT(*) AS count FROM user_tags GROUP BY tag_name ORDER BY count DESC LIMIT 20'
    );
    res.json({ tags: rows });
  } catch (e) { handleError(res, e, '[users/tags]'); }
});

router.get('/:userId/tags', requireAdminCompat, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const [rows] = await getPool().query(
      'SELECT id, tag_name AS name, color, create_time AS createTime FROM user_tags WHERE user_id = ? ORDER BY create_time DESC',
      [userId]
    );
    res.json({ tags: rows });
  } catch (e) { handleError(res, e, '[users/tag-get]'); }
});

router.post('/:userId/tags', requireAdminCompat, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const { name, color } = req.body;
    if (!name || !name.trim()) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '标签名称不能为空');
    if (name.length > 50) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '标签名称不能超过50字');
    await getPool().query(
      'INSERT INTO user_tags (user_id, tag_name, color) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE color = ?',
      [userId, name.trim(), color || '#1890ff', color || '#1890ff']
    );
    await logOper(req.session.userId, '添加用户标签', `用户ID: ${userId}, 标签: ${name}`);
    ok(res);
  } catch (e) { handleError(res, e, '[users/tag-add]'); }
});

router.delete('/:userId/tags/:tagId', requireAdminCompat, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const tagId = parseInt(req.params.tagId);
    await getPool().query('DELETE FROM user_tags WHERE id = ? AND user_id = ?', [tagId, userId]);
    await logOper(req.session.userId, '删除用户标签', `用户ID: ${userId}, 标签ID: ${tagId}`);
    ok(res);
  } catch (e) { handleError(res, e, '[users/tag-delete]'); }
});

// ==================== 用户备注 API ====================
router.get('/:userId/notes', requireAuth, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const [rows] = await getPool().query(
      'SELECT id, target_id, note_text, note_color, note_tags, update_time AS updateTime FROM member_note WHERE owner_id = ? AND target_id = ?',
      [req.session.userId, userId]
    );
    if (rows.length > 0) {
      const r = rows[0];
      res.json({
        note: {
          id: r.id,
          noteText: r.note_text,
          noteColor: r.note_color || '',
          noteTags: r.note_tags ? r.note_tags.split(',').filter(Boolean) : [],
          updateTime: r.updateTime
        }
      });
    } else {
      res.json({ note: null });
    }
  } catch (e) { handleError(res, e, '[users/notes-get]'); }
});

const NOTE_COLORS = ['', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'gray'];
router.post('/:userId/notes', requireAuth, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const { noteText, noteColor, noteTags } = req.body;
    if (!noteText) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '备注内容不能为空');
    if (noteText.length > 200) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '备注内容不能超过200字');
    const color = NOTE_COLORS.includes(noteColor) ? noteColor : '';
    let tagsStr = '';
    if (Array.isArray(noteTags)) tagsStr = noteTags.slice(0, 8).map(String).join(',').slice(0, 255);
    else if (typeof noteTags === 'string') tagsStr = noteTags.slice(0, 255);
    await getPool().query(
      'INSERT INTO member_note (owner_id, target_id, note_text, note_color, note_tags) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE note_text = ?, note_color = ?, note_tags = ?, update_time = NOW()',
      [req.session.userId, userId, noteText, color, tagsStr, noteText, color, tagsStr]
    );
    await logOper(req.session.userId, '设置用户备注', `用户ID: ${userId}, 备注: ${noteText}`);
    ok(res);
  } catch (e) { handleError(res, e, '[users/notes-set]'); }
});

router.delete('/:userId/notes', requireAuth, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    await getPool().query('DELETE FROM member_note WHERE owner_id = ? AND target_id = ?', [req.session.userId, userId]);
    await logOper(req.session.userId, '删除用户备注', `用户ID: ${userId}`);
    ok(res);
  } catch (e) { handleError(res, e, '[users/notes-delete]'); }
});

module.exports = router;
