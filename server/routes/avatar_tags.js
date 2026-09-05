// 头像标签 API (F-16)
// 私有标签：owner_id 为当前登录用户，标签仅对自己可见（与 member_note 的私有语义一致）。
// 一个头像可打多个标签，同一 (owner, avatar, tag) 唯一，最多 8 个标签。
const express = require('express');
const { ok, getPool, handleError, sendError, ErrorCodes } = require('../utils');
const { requireAuth } = require('../auth');

const router = express.Router();
const AVTR_ID_PATTERN = /^(avtr)_[0-9a-fA-F-]+$/;
const MAX_TAGS = 8;
const MAX_TAG_LEN = 50;

function isValidAvatarId(id) {
  return typeof id === 'string' && AVTR_ID_PATTERN.test(id);
}

// GET /api/avatar-tags/:avatarId — 获取当前用户对该头像的标签列表
router.get('/:avatarId', requireAuth, async (req, res) => {
  try {
    const avatarId = String(req.params.avatarId || '');
    if (!isValidAvatarId(avatarId)) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '头像 ID 格式错误');
    }
    const [rows] = await getPool().query(
      `SELECT tag FROM avatar_tags WHERE owner_id = ? AND avatar_id = ? ORDER BY created_at ASC`,
      [req.session.userId, avatarId]
    );
    res.json({ tags: rows.map(r => r.tag) });
  } catch (e) { handleError(res, e, '[avatar-tags/get]'); }
});

// POST /api/avatar-tags/:avatarId — 覆盖式设置当前用户对该头像的标签（最多 8 个）
router.post('/:avatarId', requireAuth, async (req, res) => {
  try {
    const avatarId = String(req.params.avatarId || '');
    if (!isValidAvatarId(avatarId)) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '头像 ID 格式错误');
    }
    let tags = req.body && req.body.tags;
    if (!Array.isArray(tags)) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'tags 必须为字符串数组');
    }
    // 清洗：去重、去空、截断长度、限制数量
    const cleaned = [];
    for (const t of tags) {
      const s = String(t == null ? '' : t).trim().slice(0, MAX_TAG_LEN);
      if (s && !cleaned.includes(s)) cleaned.push(s);
      if (cleaned.length >= MAX_TAGS) break;
    }
    const pool = getPool();
    // 事务：先删后插，实现覆盖式语义（同一头像的历史标签整体替换）
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(`DELETE FROM avatar_tags WHERE owner_id = ? AND avatar_id = ?`, [req.session.userId, avatarId]);
      for (const tag of cleaned) {
        await conn.query(
          `INSERT INTO avatar_tags (owner_id, avatar_id, tag) VALUES (?, ?, ?)`,
          [req.session.userId, avatarId, tag]
        );
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
    res.json({ tags: cleaned });
  } catch (e) { handleError(res, e, '[avatar-tags/set]'); }
});

// DELETE /api/avatar-tags/:avatarId — 清空当前用户对该头像的全部标签
router.delete('/:avatarId', requireAuth, async (req, res) => {
  try {
    const avatarId = String(req.params.avatarId || '');
    if (!isValidAvatarId(avatarId)) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '头像 ID 格式错误');
    }
    await getPool().query(
      `DELETE FROM avatar_tags WHERE owner_id = ? AND avatar_id = ?`,
      [req.session.userId, avatarId]
    );
    ok(res);
  } catch (e) { handleError(res, e, '[avatar-tags/delete]'); }
});

module.exports = router;
