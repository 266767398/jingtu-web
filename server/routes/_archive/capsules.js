// ==================== 时光胶囊 API (V7.10) ====================
// POST   /api/capsules        — 封存一个胶囊（title + content + openAt，可指定送给某位成员）
// GET    /api/capsules/my     — 我封存的列表 + 已到开启时间的数量
// GET    /api/capsules/inbox  — 别人送给我、且已到开启时间的胶囊
// POST   /api/capsules/:id/open — 开启（仅创建者或收件人；封存期未满不可开）
// DELETE /api/capsules/:id    — 删除（仅创建者可删未开启的）

const express = require('express');
const router = express.Router();
const { getPool, handleError, sendError, ErrorCodes } = require('../../utils');
const { requireAuth } = require('../../auth');

router.post('/', requireAuth, async (req, res) => {
  try {
    const { title, content, openAt, recipientType = 'self', recipientUserId = null } = req.body || {};
    const t = String(title || '').trim();
    const c = String(content || '').trim();
    if (!t) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '胶囊标题不能为空');
    if (c.length > 500) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '内容最多 500 字');

    const openDate = new Date(openAt);
    if (!openAt || isNaN(openDate.getTime())) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '开启时间无效');
    }
    // 至少封存 1 小时，避免"立刻开"失去仪式感；上限 10 年防止脏数据
    if (openDate - Date.now() < 60 * 60 * 1000) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '开启时间至少要在 1 小时之后');
    }
    if (openDate > new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000)) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '开启时间最远不能超过 10 年');
    }

    const pool = getPool();
    let recipientId = null;
    if (recipientType === 'member') {
      recipientId = parseInt(recipientUserId, 10);
      if (!recipientId) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请选择收件成员');
      const [[target]] = await pool.query(
        `SELECT id FROM users WHERE id = ? AND deleted_at IS NULL`, [recipientId]
      );
      if (!target) return sendError(res, 400, ErrorCodes.NOT_FOUND, '收件成员不存在');
    }

    const [result] = await pool.query(
      `INSERT INTO time_capsules (creator_id, recipient_type, recipient_user_id, title, content, open_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [req.session.userId, recipientType === 'member' ? 'member' : 'self', recipientId, t, c, openDate]
    );
    res.json({ ok: true, id: result.insertId });
  } catch (e) {
    handleError(res, e, '[capsules/create]');
  }
});

router.get('/my', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT tc.id, tc.recipient_type, tc.recipient_user_id, tc.title, tc.open_at,
              tc.status, tc.opened_at, tc.create_time, u.display_name AS recipient_name
       FROM time_capsules tc
       LEFT JOIN users u ON tc.recipient_user_id = u.id
       WHERE tc.creator_id = ?
       ORDER BY tc.status ASC, tc.open_at DESC`,
      [req.session.userId]
    );
    const [[{ readyCount }]] = await pool.query(
      `SELECT COUNT(*) AS readyCount FROM time_capsules
       WHERE creator_id = ? AND status = 0 AND open_at <= NOW()`,
      [req.session.userId]
    );
    res.json({ capsules: rows, readyCount });
  } catch (e) {
    handleError(res, e, '[capsules/my]');
  }
});

router.get('/inbox', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT tc.id, tc.title, tc.open_at, tc.status, u.display_name AS creator_name
       FROM time_capsules tc
       LEFT JOIN users u ON tc.creator_id = u.id
       WHERE tc.recipient_type = 'member' AND tc.recipient_user_id = ? AND tc.status = 0
       ORDER BY tc.open_at ASC`,
      [req.session.userId]
    );
    res.json({ capsules: rows });
  } catch (e) {
    handleError(res, e, '[capsules/inbox]');
  }
});

router.post('/:id/open', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '胶囊ID无效');

    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT * FROM time_capsules WHERE id = ?`, [id]
    );
    if (!rows.length) return sendError(res, 404, ErrorCodes.NOT_FOUND, '胶囊不存在');

    const capsule = rows[0];
    const isCreator = capsule.creator_id === req.session.userId;
    const isRecipient = capsule.recipient_type === 'member' && capsule.recipient_user_id === req.session.userId;
    if (!isCreator && !isRecipient) {
      return sendError(res, 403, ErrorCodes.FORBIDDEN, '无权开启这个胶囊');
    }
    if (capsule.status !== 0) {
      return sendError(res, 400, ErrorCodes.CONFLICT, '胶囊已经开启了');
    }
    const openAt = new Date(capsule.open_at);
    if (!isNaN(openAt.getTime()) && openAt > new Date()) {
      return sendError(res, 400, ErrorCodes.FORBIDDEN, '胶囊还在封存中，到时间才能开启哦');
    }

    await pool.query(
      `UPDATE time_capsules SET status = 1, opened_by = ?, opened_at = NOW() WHERE id = ? AND status = 0`,
      [req.session.userId, id]
    );

    const [[opened]] = await pool.query(
      `SELECT tc.title, tc.content, tc.opened_at FROM time_capsules tc WHERE tc.id = ?`, [id]
    );
    res.json({ ok: true, capsule: opened });
  } catch (e) {
    handleError(res, e, '[capsules/open]');
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '胶囊ID无效');

    const pool = getPool();
    const [rows] = await pool.query(`SELECT * FROM time_capsules WHERE id = ?`, [id]);
    if (!rows.length) return sendError(res, 404, ErrorCodes.NOT_FOUND, '胶囊不存在');

    const capsule = rows[0];
    if (capsule.creator_id !== req.session.userId) {
      return sendError(res, 403, ErrorCodes.FORBIDDEN, '只能删除自己封存的胶囊');
    }
    if (capsule.status !== 0) {
      return sendError(res, 400, ErrorCodes.CONFLICT, '已开启的胶囊不能删除');
    }

    await pool.query(`DELETE FROM time_capsules WHERE id = ?`, [id]);
    res.json({ ok: true });
  } catch (e) {
    handleError(res, e, '[capsules/delete]');
  }
});

module.exports = router;