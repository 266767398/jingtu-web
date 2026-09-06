// 世界标签 API (F-17)
// 私有标签：owner_id 为当前登录用户，标签仅对自己可见（与 avatar_tags 同模式）。
// 一个世界可打多个标签，同一 (owner, world_id, tag) 唯一，最多 8 个标签。
const express = require('express');
const { ok, getPool, handleError, sendError, ErrorCodes } = require('../utils');
const { requireAuth } = require('../auth');

const router = express.Router();
const WRID_ID_PATTERN = /^(wrld)_[0-9a-fA-F-]+$/;
const MAX_TAGS = 8;
const MAX_TAG_LEN = 50;

function isValidWorldId(id) {
  return typeof id === 'string' && WRID_ID_PATTERN.test(id);
}

// GET /api/world-tags/:worldId — 获取当前用户对该世界的标签列表
router.get('/:worldId', requireAuth, async (req, res) => {
  try {
    const worldId = String(req.params.worldId || '');
    if (!isValidWorldId(worldId)) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '世界 ID 格式错误');
    }
    const [rows] = await getPool().query(
      `SELECT tag FROM world_tags WHERE owner_id = ? AND world_id = ? ORDER BY created_at ASC`,
      [req.session.userId, worldId]
    );
    res.json({ tags: rows.map(r => r.tag) });
  } catch (e) { handleError(res, e, '[world-tags/get]'); }
});

// POST /api/world-tags/:worldId — 覆盖式设置当前用户对该世界的标签（最多 8 个）
router.post('/:worldId', requireAuth, async (req, res) => {
  try {
    const worldId = String(req.params.worldId || '');
    if (!isValidWorldId(worldId)) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '世界 ID 格式错误');
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
    // 事务：先删后插，实现覆盖式语义（同一世界的历史标签整体替换）
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(`DELETE FROM world_tags WHERE owner_id = ? AND world_id = ?`, [req.session.userId, worldId]);
      for (const tag of cleaned) {
        await conn.query(
          `INSERT INTO world_tags (owner_id, world_id, tag) VALUES (?, ?, ?)`,
          [req.session.userId, worldId, tag]
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
  } catch (e) { handleError(res, e, '[world-tags/set]'); }
});

// DELETE /api/world-tags/:worldId — 清空当前用户对该世界的全部标签
router.delete('/:worldId', requireAuth, async (req, res) => {
  try {
    const worldId = String(req.params.worldId || '');
    if (!isValidWorldId(worldId)) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '世界 ID 格式错误');
    }
    await getPool().query(
      `DELETE FROM world_tags WHERE owner_id = ? AND world_id = ?`,
      [req.session.userId, worldId]
    );
    ok(res);
  } catch (e) { handleError(res, e, '[world-tags/delete]'); }
});

module.exports = router;
