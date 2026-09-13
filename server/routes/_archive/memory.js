// ==================== "那年今日" 记忆卡 API (V7.10) ====================
// GET /api/memory/memories — 从历史帖子/照片/活动中取"同月同日（往年）"的内容；
// 若站点数据不足（站龄 < 1 年），自动降级为"近一周"的回忆，保证卡片始终有内容可展示。

const express = require('express');
const router = express.Router();
const { getPool, handleError } = require('../../utils');
const { requireAuth } = require('../../auth');

router.get('/memories', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const month = new Date().getMonth() + 1;
    const day = new Date().getDate();

    // ---------- 往年同月同日 ----------
    let posts = [];
    let photos = [];
    let events = [];

    [posts] = await pool.query(
      `SELECT p.id, LEFT(p.content, 200) AS content, p.like_count, p.created_at,
              u.display_name AS author_name
       FROM posts p
       LEFT JOIN users u ON p.user_id = u.id
       WHERE YEAR(p.created_at) < YEAR(CURDATE())
         AND MONTH(p.created_at) = ? AND DAY(p.created_at) = ?
         AND p.visibility <> 'private'
       ORDER BY p.created_at DESC LIMIT 3`,
      [month, day]
    );

    [photos] = await pool.query(
      `SELECT ap.id, ap.thumb_path, LEFT(ap.photo_desc, 120) AS photo_desc, ap.create_time
       FROM album_photo ap
       WHERE ap.is_recycle = 0
         AND YEAR(ap.create_time) < YEAR(CURDATE())
         AND MONTH(ap.create_time) = ? AND DAY(ap.create_time) = ?
       ORDER BY ap.create_time DESC LIMIT 4`,
      [month, day]
    );

    [events] = await pool.query(
      `SELECT e.id, e.title, e.event_time
       FROM event e
       WHERE YEAR(e.event_time) < YEAR(CURDATE())
         AND MONTH(e.event_time) = ? AND DAY(e.event_time) = ?
       ORDER BY e.event_time DESC LIMIT 2`,
      [month, day]
    );

    let source = 'thisday';
    if (!posts.length && !photos.length && !events.length) {
      // ---------- 降级：近一周回忆（站龄不足一年时） ----------
      source = 'lastweek';
      [posts] = await pool.query(
        `SELECT p.id, LEFT(p.content, 200) AS content, p.like_count, p.created_at,
                u.display_name AS author_name
         FROM posts p
         LEFT JOIN users u ON p.user_id = u.id
         WHERE p.created_at >= NOW() - INTERVAL 7 DAY
           AND p.visibility <> 'private'
         ORDER BY p.created_at DESC LIMIT 3`
      );

      [photos] = await pool.query(
        `SELECT ap.id, ap.thumb_path, LEFT(ap.photo_desc, 120) AS photo_desc, ap.create_time
         FROM album_photo ap
         WHERE ap.is_recycle = 0 AND ap.create_time >= NOW() - INTERVAL 7 DAY
         ORDER BY ap.create_time DESC LIMIT 4`
      );

      [events] = await pool.query(
        `SELECT e.id, e.title, e.event_time
         FROM event e
         WHERE e.event_time >= NOW() - INTERVAL 7 DAY AND e.event_time < CURDATE()
         ORDER BY e.event_time DESC LIMIT 2`
      );

      if (!posts.length && !photos.length && !events.length) {
        return res.json({ source: null, posts: [], photos: [], events: [] });
      }
    }

    res.json({ source, posts, photos, events });
  } catch (e) {
    handleError(res, e, '[memory/memories]');
  }
});

module.exports = router;