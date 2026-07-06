/**
 * 境途同游 V6.14 — 活动路由（从 server.js 提取）
 * 支持：活动 CRUD、报名/取消、签到、评论、VRChat 同步、生日派对、归档
 * 通过工厂模式接收 notifyAllMembers 引用
 */
const express = require('express');
const { getPool, safeError, logOper } = require('../utils');
const { requireAuth, requireAdminCompat, getAvatarUrl, ROLE_LEVEL } = require('../auth');
const { vrchatGetGroupEvents } = require('../vrc');

const GROUP_ID = process.env.GROUP_ID;
if (!GROUP_ID) {
  console.error('❌ FATAL: GROUP_ID 未在 .env 中设置，无法同步 VRChat 活动');
}

/**
 * @param {Function} getVRCCookieFn - 获取 VRChat cookie 的函数
 * @param {Function} notifyFn - notifyAllMembers 函数引用
 */
module.exports = function (getVRCCookieFn, notifyFn) {

  const router = express.Router();

  // ==================== 活动列表 ====================
  router.get('/', async (req, res) => {
    try {
      const { status, type, include_archived } = req.query;
      let sql = `SELECT id, title, place, event_time AS eventTime, description, max_sign AS maxSign, event_type AS eventType, vrchat_event_id AS vrchatEventId, ends_at AS endsAt, create_admin AS createAdmin, is_archive AS isArchive, visibility, source, world_id AS worldId, world_name AS worldName, world_image_url AS worldImageUrl, create_time AS createTime, updated_at AS updatedAt FROM event WHERE 1=1`;
      const params = [];
      if (include_archived !== '1') sql += ` AND is_archive=0`;
      if (type) { sql += ` AND event_type = ?`; params.push(type); }
      if (status === 'ongoing') {
        sql += ` AND event_time <= NOW() AND (ends_at IS NULL OR ends_at >= NOW())`;
      } else if (status === 'upcoming') {
        sql += ` AND event_time > NOW()`;
      } else if (status === 'past') {
        sql += ` AND ((ends_at IS NOT NULL AND ends_at < NOW()) OR (ends_at IS NULL AND event_time < NOW()))`;
      }
      sql += ` ORDER BY event_time DESC LIMIT 50`;
      const [rows] = await getPool().query(sql, params);
      const eventsWithSigns = await Promise.all(rows.map(async (evt) => {
        const [signs] = await getPool().query(`SELECT COUNT(*) as count FROM event_sign WHERE event_id = ?`, [evt.id]);
        const sc = signs[0].count;
        return { ...evt, signedCount: sc, time: evt.eventTime, participants: sc, maxParticipants: evt.maxSign, signCount: sc };
      }));
      res.json({ events: eventsWithSigns, total: eventsWithSigns.length });
    } catch (e) { console.error('[events]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  // ==================== 活动详情 ====================
  router.get('/detail/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!id) return res.status(400).json({ error: '参数错误' });
      const [rows] = await getPool().query(
        `SELECT id, title, place, event_time AS eventTime, description, max_sign AS maxSign,
                event_type AS eventType, vrchat_event_id AS vrchatEventId, ends_at AS endsAt,
                create_admin AS createAdmin, is_archive AS isArchive, visibility, source,
                world_id AS worldId, world_name AS worldName, world_image_url AS worldImageUrl,
                create_time AS createTime, updated_at AS updatedAt
         FROM event WHERE id = ?`, [id]
      );
      if (rows.length === 0) return res.status(404).json({ error: '活动不存在' });
      const evt = rows[0];
      const [signs] = await getPool().query(`SELECT id, user_vrcid, user_name, sign_time FROM event_sign WHERE event_id=? AND is_sign=1 ORDER BY sign_time`, [id]);
      const [signCount] = await getPool().query(`SELECT COUNT(*) as c FROM event_sign WHERE event_id=? AND is_sign=1`, [id]);
      const signList = await Promise.all(signs.map(async s => {
        const [u] = await getPool().query(
          `SELECT display_name, avatar_type, custom_avatar_path, vrchat_avatar_url FROM users WHERE id = ? OR login_id = ?`,
          [s.user_vrcid, s.user_vrcid]);
        return { id: s.id, user_name: s.user_name, avatarUrl: u.length > 0 ? getAvatarUrl(u[0]) : null };
      }));
      const [checkins] = await getPool().query(`SELECT id, user_id, user_name, checkin_time AS checkinTime FROM event_checkin WHERE event_id=? ORDER BY checkin_time`, [id]);
      const [[{ checkinCount }]] = await getPool().query(`SELECT COUNT(*) AS checkinCount FROM event_checkin WHERE event_id=?`, [id]);
      res.json({ ...evt, time: evt.eventTime, desc: evt.description, signCount: signCount[0].c, maxSign: evt.maxSign, signList, checkinList: checkins, checkinCount });
    } catch (e) { console.error('[events]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  // ==================== 有关联 World 的活动 ====================
  router.get('/with-worlds', async (req, res) => {
    try {
      const [rows] = await getPool().query(
        `SELECT id, title, event_time AS eventTime, event_time AS time, ends_at AS endsAt, world_id AS worldId, world_name AS worldName, world_image_url AS worldImageUrl FROM event WHERE world_id IS NOT NULL ORDER BY event_time DESC LIMIT 50`
      );
      const events = rows.map(e => ({ ...e, participants: 0, maxParticipants: 0, signCount: 0, description: '', eventType: 'activity', visibility: 'members_only' }));
      res.json({ events });
    } catch (e) { console.error('[events]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  // ==================== 创建活动 ====================
  router.post('/', requireAuth, async (req, res) => {
    try {
      let { title, place, eventTime, time, description, desc, maxSign, eventType, endsAt, visibility, worldId, worldName, worldImageUrl } = req.body;
      if (!eventTime && time) eventTime = time;
      if (!description && desc) description = desc;
      if (!title || !eventTime) return res.status(400).json({ error: '标题和时间不能为空' });
      const [result] = await getPool().query(
        `INSERT INTO event (title, place, event_time, description, max_sign, event_type, ends_at, visibility, world_id, world_name, world_image_url, create_admin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [title, place || '', eventTime, description || '', maxSign || 0, eventType || 'activity', endsAt || null, visibility || 'members_only', worldId || null, worldName || null, worldImageUrl || null, req.session.displayName || req.session.userId || '未知用户']
      );
      await logOper(req.session.userId, '创建活动', `活动: ${title}`);
      const evtType = eventType === 'birthday' ? '🎂 生日派对' : '📅 活动';
      if (notifyFn) notifyFn('event_reminder', `${evtType}: ${title}`, `活动时间: ${new Date(eventTime).toLocaleString('zh-CN')}`, result.insertId);
      res.json({ success: true, id: result.insertId });
    } catch (e) { console.error('[events]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  // ==================== 编辑活动 ====================
  router.put('/:id', requireAdminCompat, async (req, res) => {
    try {
      let { title, place, eventTime, time, description, desc, maxSign, eventType, endsAt, visibility, worldId, worldName, worldImageUrl, isArchive } = req.body;
      if (!eventTime && time) eventTime = time;
      if (!description && desc) description = desc;
      const updates = {};
      if (title !== undefined) updates.title = title;
      if (place !== undefined) updates.place = place;
      if (eventTime !== undefined) updates.event_time = eventTime;
      if (description !== undefined) updates.description = description;
      if (maxSign !== undefined) updates.max_sign = maxSign;
      if (eventType !== undefined) updates.event_type = eventType;
      if (endsAt !== undefined) updates.ends_at = endsAt || null;
      if (visibility !== undefined) updates.visibility = visibility;
      if (worldId !== undefined) updates.world_id = worldId;
      if (worldName !== undefined) updates.world_name = worldName;
      if (worldImageUrl !== undefined) updates.world_image_url = worldImageUrl;
      if (isArchive !== undefined) updates.is_archive = isArchive ? 1 : 0;
      if (Object.keys(updates).length === 0) return res.status(400).json({ error: '无更新字段' });
      const sets = Object.keys(updates).map(k => `${k}=?`).join(',');
      const vals = Object.values(updates);
      vals.push(req.params.id);
      await getPool().query(`UPDATE event SET ${sets} WHERE id=?`, vals);
      res.json({ success: true });
    } catch (e) { console.error('[events]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  // ==================== 删除活动 ====================
  router.delete('/:id', requireAdminCompat, async (req, res) => {
    try {
      await getPool().query(`DELETE FROM event WHERE id=?`, [req.params.id]);
      res.json({ success: true });
    } catch (e) { console.error('[events]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  // ==================== 从 VRChat 同步活动 ====================
  router.post('/sync-vrchat', requireAdminCompat, async (req, res) => {
    const vrcCookie = getVRCCookieFn ? getVRCCookieFn(req) : null;
    if (!vrcCookie) return res.status(401).json({ error: '请先在个人中心绑定VRChat账号，或由管理员在后台登录VRChat系统账号', code: 'VRC_SYSTEM_OFFLINE' });
    try {
      const ge = await vrchatGetGroupEvents(GROUP_ID, vrcCookie, 100, 0);
      if (ge.status !== 200) return res.status(502).json({ error: '获取 VRChat 日历失败' });
      const events = Array.isArray(ge.data) ? ge.data : [];
      let added = 0;
      for (const evt of events) {
        const [result] = await getPool().query(
          `INSERT IGNORE INTO event (title, event_time, description, event_type, vrchat_event_id, ends_at, source, visibility, create_admin) VALUES (?, ?, ?, 'activity', ?, NULL, 'vrchat', 'members_only', ?)`,
          [evt.name || evt.title || 'VRChat 活动', evt.scheduledAt || evt.startTime || new Date(), evt.description || '', String(evt.id), 'VRChat Sync']
        );
        if (result.affectedRows > 0) added++;
      }
      res.json({ success: true, added, total: events.length });
    } catch (e) { console.error('[events]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  // ==================== 活动报名 ====================
  router.post('/:id/sign', async (req, res) => {
    const uid = req.session?.userId;
    if (!uid) return res.status(401).json({ error: '请先登录' });
    let conn;
    try {
      conn = await getPool().getConnection();
      await conn.beginTransaction();
      const [evt] = await conn.query(`SELECT max_sign AS maxSign FROM event WHERE id=? FOR UPDATE`, [req.params.id]);
      if (evt.length === 0) { await conn.rollback(); return res.status(404).json({ error: '活动不存在' }); }
      const [existing] = await conn.query(`SELECT id FROM event_sign WHERE event_id=? AND user_vrcid=? FOR UPDATE`, [req.params.id, uid]);
      if (existing.length > 0) { await conn.rollback(); return res.json({ success: true, alreadySigned: true }); }
      if (evt[0].maxSign > 0) {
        const [cnt] = await conn.query(`SELECT COUNT(*) AS c FROM event_sign WHERE event_id=?`, [req.params.id]);
        if (cnt[0].c >= evt[0].maxSign) { await conn.rollback(); return res.status(400).json({ error: '活动已满员' }); }
      }
      const name = req.session.displayName || '用户';
      await conn.query(`INSERT INTO event_sign (event_id, user_vrcid, user_name, is_sign, sign_time) VALUES (?, ?, ?, 1, NOW())`, [req.params.id, uid, name]);
      await conn.commit();
      res.json({ success: true });
    } catch (e) { if (conn) await conn.rollback().catch(()=>{}); console.error('[events]', e); res.status(500).json({ error: safeError(e.message) }); }
    finally { if (conn) conn.release(); }
  });

  // ==================== 取消报名 ====================
  router.post('/:id/unsign', async (req, res) => {
    const uid = req.session?.userId;
    if (!uid) return res.status(401).json({ error: '请先登录' });
    try {
      await getPool().query(`DELETE FROM event_sign WHERE event_id=? AND user_vrcid=?`, [req.params.id, uid]);
      res.json({ success: true });
    } catch (e) { console.error('[events]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  // ==================== 活动签到 ====================
  router.post('/:id/checkin', requireAdminCompat, async (req, res) => {
    try {
      const name = req.session.displayName || '管理员';
      await getPool().query(`INSERT INTO event_checkin (event_id, user_id, user_name) VALUES (?, ?, ?)`, [req.params.id, req.session.userId, name]);
      res.json({ success: true, message: '签到成功' });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return res.json({ success: true, message: '已签到' });
      res.status(500).json({ error: safeError(e.message) });
    }
  });

  // ==================== 获取报名列表 ====================
  router.get('/:id/signs', async (req, res) => {
    try {
      const [rows] = await getPool().query(`SELECT id, user_vrcid AS userVrcId, user_name AS userName, sign_time AS signTime FROM event_sign WHERE event_id=? AND is_sign=1`, [req.params.id]);
      res.json(rows);
    } catch (e) { console.error('[events]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  // ==================== 活动评论列表 ====================
  router.get('/:id/comments', async (req, res) => {
    try {
      const [rows] = await getPool().query(
        `SELECT ec.id, ec.content, ec.create_time AS createdAt, u.id AS userId, u.display_name AS userName, u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url
         FROM event_comment ec LEFT JOIN users u ON ec.user_id = u.id
         WHERE ec.event_id=? ORDER BY ec.create_time ASC`, [req.params.id]
      );
      const mapped = rows.map(r => ({ id: r.id, content: r.content, createdAt: r.createdAt, userId: r.userId, userName: r.userName, avatarUrl: getAvatarUrl(r) }));
      res.json(mapped);
    } catch (e) { console.error('[events]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  // ==================== 发布评论 ====================
  router.post('/:id/comments', async (req, res) => {
    const uid = req.session?.userId;
    if (!uid) return res.status(401).json({ error: '请先登录' });
    try {
      const { content } = req.body;
      if (!content) return res.status(400).json({ error: '请输入评论内容' });
      if (typeof content !== 'string' || content.length > 2000) return res.status(400).json({ error: '评论内容不能超过2000字' });
      const name = req.session.displayName || '用户';
      await getPool().query(`INSERT INTO event_comment (event_id, user_id, user_name, content) VALUES (?, ?, ?, ?)`, [req.params.id, uid, name, content]);
      res.json({ success: true });
    } catch (e) { console.error('[events]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  // ==================== 活动关联照片 ====================
  router.get('/:id/photos', async (req, res) => {
    try {
      const [rows] = await getPool().query(
        `SELECT p.id, p.photo_path AS url, p.thumb_path AS thumbnail, p.photo_desc AS caption,
                p.upload_vrcid AS uploader, p.upload_name AS uploaderName, p.like_count AS likes,
                p.media_type AS mediaType, p.file_size AS fileSize,
                p.create_time AS createTime FROM album_photo p WHERE p.event_id=? AND p.is_recycle=0 ORDER BY p.create_time DESC`,
        [parseInt(req.params.id)]
      );
      res.json(rows);
    } catch (e) { console.error('[events]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  // ==================== 删除评论 ====================
  router.delete('/:eventId/comments/:commentId', async (req, res) => {
    const uid = req.session?.userId;
    if (!uid) return res.status(401).json({ error: '请先登录' });
    try {
      const userRole = ROLE_LEVEL[req.session.role] || 0;
      if (userRole >= ROLE_LEVEL.admin) {
        await getPool().query(`DELETE FROM event_comment WHERE id=?`, [req.params.commentId]);
      } else {
        await getPool().query(`DELETE FROM event_comment WHERE id=? AND user_id=?`, [req.params.commentId, uid]);
      }
      res.json({ success: true });
    } catch (e) { console.error('[events]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  // ==================== 生日派对 ====================
  router.get('/birthday-parties', async (req, res) => {
    try {
      const [rows] = await getPool().query(
        `SELECT id, title, event_time AS eventTime, ends_at AS endsAt, description, create_admin AS createAdmin, event_type AS eventType FROM event WHERE event_type='birthday' ORDER BY event_time DESC LIMIT 20`
      );
      res.json(rows);
    } catch (e) { console.error('[events]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  // ==================== 活动归档/恢复 ====================
  router.post('/:id/archive', requireAdminCompat, async (req, res) => {
    try { await getPool().query(`UPDATE event SET is_archive=1 WHERE id=?`, [req.params.id]); res.json({ success: true }); }
    catch (e) { console.error('[events]', e); res.status(500).json({ error: safeError(e.message) }); }
  });
  router.post('/:id/unarchive', requireAdminCompat, async (req, res) => {
    try { await getPool().query(`UPDATE event SET is_archive=0 WHERE id=?`, [req.params.id]); res.json({ success: true }); }
    catch (e) { console.error('[events]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  return router;
};
