const express = require('express');
const router = express.Router();
const { getPool, handleError, sendError, ErrorCodes, getAvatarUrl } = require('../utils');
const { requireAuth, requireRole, ROLE_LEVEL } = require('../auth');
const notificationService = require('../notification-service');

router.get('/:eventId', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const [teams] = await pool.query(
      `SELECT et.*, u.display_name AS leaderName 
       FROM event_teams et
       LEFT JOIN users u ON et.leader_id = u.id
       WHERE et.event_id = ?
       ORDER BY et.created_at DESC`,
      [req.params.eventId]
    );

    for (const team of teams) {
      const [members] = await pool.query(
        `SELECT etm.user_id, u.display_name, u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url 
         FROM event_team_members etm
         LEFT JOIN users u ON etm.user_id = u.id
         WHERE etm.team_id = ?`,
        [team.id]
      );
      team.members = members.map(m => ({ ...m, avatarUrl: getAvatarUrl(m) }));
      team.memberCount = members.length;
    }

    res.json({ teams });
  } catch (e) {
    handleError(res, e, '[event-teams]');
  }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const { eventId, name, maxMembers } = req.body;
    if (!eventId || !name) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '缺少必要参数');

    const pool = getPool();
    const [event] = await pool.query(`SELECT id FROM event WHERE id = ? AND is_archive = 0`, [eventId]);
    if (event.length === 0) {
      return sendError(res, 404, ErrorCodes.NOT_FOUND, '活动不存在或已归档');
    }

    const [existing] = await pool.query(
      `SELECT id FROM event_teams WHERE event_id = ? AND name = ?`,
      [eventId, name]
    );
    if (existing.length > 0) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '队伍名称已存在');
    }

    const [result] = await pool.query(
      `INSERT INTO event_teams (event_id, name, leader_id, max_members) VALUES (?, ?, ?, ?)`,
      [eventId, name, req.session.userId, maxMembers || 5]
    );

    await pool.query(
      `INSERT INTO event_team_members (team_id, user_id) VALUES (?, ?)`,
      [result.insertId, req.session.userId]
    );

    res.json({ ok: true, teamId: result.insertId, name });
  } catch (e) {
    handleError(res, e, '[event-teams]');
  }
});

router.post('/:teamId/join', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const [team] = await pool.query(
      `SELECT et.*, COUNT(etm.id) as currentCount 
       FROM event_teams et
       LEFT JOIN event_team_members etm ON et.id = etm.team_id
       WHERE et.id = ?
       GROUP BY et.id`,
      [req.params.teamId]
    );

    if (team.length === 0) {
      return sendError(res, 404, ErrorCodes.NOT_FOUND, '队伍不存在');
    }

    if (team[0].currentCount >= team[0].max_members) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '队伍已满');
    }

    const [existing] = await pool.query(
      `SELECT id FROM event_team_members WHERE team_id = ? AND user_id = ?`,
      [req.params.teamId, req.session.userId]
    );

    if (existing.length > 0) {
      return res.json({ ok: true, alreadyJoined: true });
    }

    await pool.query(
      `INSERT INTO event_team_members (team_id, user_id) VALUES (?, ?)`,
      [req.params.teamId, req.session.userId]
    );

    notificationService.notifyUser(team[0].leader_id, 'team_join', '新成员加入', `${req.session.userId} 加入了您的队伍`);

    res.json({ ok: true });
  } catch (e) {
    handleError(res, e, '[event-teams]');
  }
});

router.post('/:teamId/leave', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const [team] = await pool.query(`SELECT leader_id FROM event_teams WHERE id = ?`, [req.params.teamId]);

    if (team.length === 0) {
      return sendError(res, 404, ErrorCodes.NOT_FOUND, '队伍不存在');
    }

    if (team[0].leader_id === req.session.userId) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '队长不能离开队伍，请先解散队伍');
    }

    const [result] = await pool.query(
      `DELETE FROM event_team_members WHERE team_id = ? AND user_id = ?`,
      [req.params.teamId, req.session.userId]
    );

    if (result.affectedRows > 0) {
      res.json({ ok: true });
    } else {
      sendError(res, 404, ErrorCodes.NOT_FOUND, '您不在该队伍中');
    }
  } catch (e) {
    handleError(res, e, '[event-teams]');
  }
});

router.delete('/:teamId', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const [team] = await pool.query(`SELECT leader_id FROM event_teams WHERE id = ?`, [req.params.teamId]);

    if (team.length === 0) {
      return sendError(res, 404, ErrorCodes.NOT_FOUND, '队伍不存在');
    }

    if (team[0].leader_id !== req.session.userId) {
      return sendError(res, 403, ErrorCodes.FORBIDDEN, '只有队长可以解散队伍');
    }

    await pool.query(`DELETE FROM event_teams WHERE id = ?`, [req.params.teamId]);

    res.json({ ok: true });
  } catch (e) {
    handleError(res, e, '[event-teams]');
  }
});

router.post('/:teamId/kick/:userId', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const [team] = await pool.query(`SELECT leader_id FROM event_teams WHERE id = ?`, [req.params.teamId]);

    if (team.length === 0) {
      return sendError(res, 404, ErrorCodes.NOT_FOUND, '队伍不存在');
    }

    if (team[0].leader_id !== req.session.userId) {
      return sendError(res, 403, ErrorCodes.FORBIDDEN, '只有队长可以踢人');
    }

    if (parseInt(req.params.userId) === req.session.userId) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '不能踢自己');
    }

    const [result] = await pool.query(
      `DELETE FROM event_team_members WHERE team_id = ? AND user_id = ?`,
      [req.params.teamId, req.params.userId]
    );

    if (result.affectedRows > 0) {
      res.json({ ok: true });
    } else {
      sendError(res, 404, ErrorCodes.NOT_FOUND, '该用户不在队伍中');
    }
  } catch (e) {
    handleError(res, e, '[event-teams]');
  }
});

module.exports = router;
