// ==================== "同游" API (V7.10) ====================
// GET /api/journey/presence — 当前可见的 VRChat 在线状态（vrc_presence，由 Pipeline 事件 upsert）
// GET /api/journey/moments   — 同游时刻墙（分页；mine=1 只看含自己的）

const express = require('express');
const router = express.Router();
const { getPool, handleError } = require('../../utils');
const { requireAuth } = require('../../auth');

// 当前在线列表：优先展示已进入世界的成员，其次按最近更新时间排序
router.get('/presence', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT vp.vrchat_id, vp.display_name, vp.user_id, vp.online,
              vp.world_id, vp.world_name, vp.instance_id, vp.updated_at,
              u.display_name AS site_name, u.avatar_type AS avatar_type,
              u.custom_avatar_path AS custom_avatar_path, u.vrchat_avatar_url AS vrchat_avatar_url
       FROM vrc_presence vp
       LEFT JOIN users u ON vp.user_id = u.id AND u.deleted_at IS NULL
       WHERE vp.online = 1
       ORDER BY (vp.world_id IS NOT NULL AND vp.world_id <> '') DESC, vp.updated_at DESC`
    );
    res.json({ presence: rows });
  } catch (e) {
    handleError(res, e, '[journey/presence]');
  }
});

// 同游时刻墙：分页历史 + mine 过滤
router.get('/moments', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const page = Math.max(0, parseInt(req.query.page, 10) || 0);
    const perPage = Math.min(50, Math.max(1, parseInt(req.query.per_page, 10) || 20));

    let where = '1=1';
    const params = [];
    if (req.query.mine === '1') {
      const [[me]] = await pool.query(
        `SELECT vrchat_id FROM users WHERE id = ?`, [req.session.userId]
      );
      if (!me || !me.vrchat_id) {
        return res.json({ moments: [], total: 0, page, hasMore: false });
      }
      where += ' AND (member1_vrcid = ? OR member2_vrcid = ?)';
      params.push(me.vrchat_id, me.vrchat_id);
    }

    const [rows] = await pool.query(
      `SELECT * FROM together_moments WHERE ${where}
       ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?`,
      [...params, perPage, page * perPage]
    );
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM together_moments WHERE ${where}`, params
    );

    res.json({ moments: rows, total, page, hasMore: (page + 1) * perPage < total });
  } catch (e) {
    handleError(res, e, '[journey/moments]');
  }
});

module.exports = router;