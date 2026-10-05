/**
 * 境途同游 — 直播管理与内容管理路由（P2-4 第三批：自 admin.js 按域拆出）
 * 行为逐字保留：直播监管（强制结束/删除）+ 动态/公告/活动/相册后台管理（含级联清理）。
 */
const express = require('express');
const { fail, ok, getPool, handleError, logOper, paginate, escapeLike } = require('../utils');
const { requireAdminCompat } = require('../auth');

module.exports = function createAdminContentLiveRouter() {
  const router = express.Router();

  // ==================== 直播管理（管理员监管） ====================
  router.get('/admin/live', requireAdminCompat, async (req, res) => {
    try {
      const { page, pageSize, offset } = paginate(req, { defaultSize: 20 });
      const status = req.query.status === 'live' ? 'live' : (req.query.status === 'ended' ? 'ended' : '');
      const kw = req.query.kw ? req.query.kw.trim() : '';
      const where = [];
      const params = [];
      if (status) { where.push('l.status = ?'); params.push(status); }
      if (kw) { where.push('(l.title LIKE ? ESCAPE \'!\' OR u.display_name LIKE ? ESCAPE \'!\' OR u.login_id LIKE ? ESCAPE \'!\')'); params.push('%' + escapeLike(kw) + '%', '%' + escapeLike(kw) + '%', '%' + escapeLike(kw) + '%'); }
      const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const [{ 0: count }] = await getPool().query(`SELECT COUNT(*) AS c FROM live_streams l LEFT JOIN users u ON u.id = l.user_id ${whereSql}`, params);
      const [list] = await getPool().query(
        `SELECT l.id, l.user_id AS userId, l.title, l.status, l.created_at AS startedAt, l.ended_at AS endedAt,
                u.display_name AS displayName, u.login_id AS loginId
         FROM live_streams l LEFT JOIN users u ON u.id = l.user_id
         ${whereSql} ORDER BY (l.status='live') DESC, l.created_at DESC LIMIT ? OFFSET ?`,
        params.concat([pageSize, offset])
      );
      const totalPages = Math.max(1, Math.ceil(count.c / pageSize));
      res.json({ list, page, totalPages, total: count.c });
    } catch (e) { handleError(res, e, '[admin/live:get]'); }
  });

  router.post('/admin/live/:id/end', requireAdminCompat, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!id) return fail(res, 400, 'invalid id');
      await getPool().query(`UPDATE live_streams SET status = 'ended', ended_at = NOW() WHERE id = ?`, [id]);
      await logOper(req.session.userId, '强制结束直播', '直播ID: ' + id);
      ok(res);
    } catch (e) { handleError(res, e, '[admin/live:end]'); }
  });

  router.delete('/admin/live/:id', requireAdminCompat, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!id) return fail(res, 400, 'invalid id');
      await getPool().query(`DELETE FROM live_streams WHERE id = ?`, [id]);
      await logOper(req.session.userId, '删除直播', '直播ID: ' + id);
      ok(res);
    } catch (e) { handleError(res, e, '[admin/live:delete]'); }
  });

  // ==================== 内容管理（动态/公告/活动/相册） ====================
  const CONTENT_TYPES = {
    posts: { table: 'posts', id: 'id', author: 'user_id', title: 'content', q: ['content'] },
    // 公告表无 author_id，作者存 create_admin 文本字段，author 配 create_admin 使其按 authorId 返回文本
    // 公告表无 author_id，作者存 create_admin 文本字段；textAuthor=true 时 authorId 直接当文本展示、不查 users 表
    announcements: { table: 'announcement', id: 'id', author: 'create_admin', title: 'title', q: ['title', 'content'], textAuthor: true },
    events: {
      table: 'event', id: 'id', author: 'create_user_id', title: 'title', q: ['title', 'description'],
      // 活动表字段更丰富：补充类型/时间/归档/创建者文本/参与人数，便于后台管理页展示
      extra: 'event_type AS eventType, event_time AS eventTime, ends_at AS endsAt, is_archive AS isArchive, create_admin AS createAdmin',
      signJoin: 'LEFT JOIN (SELECT event_id, COUNT(*) AS signCount FROM event_sign GROUP BY event_id) es ON es.event_id = event.id',
      signCount: 'es.signCount AS signCount'
    },
    // album_photo 表无 user_id/caption：上传者为 upload_name 文本，描述为 photo_desc；extra 带回缩略图/原图路径供后台展示
    album: {
      table: 'album_photo', id: 'id', author: 'upload_name', title: 'photo_desc', q: ['photo_desc', 'upload_name'], textAuthor: true,
      extra: 'thumb_path AS thumbPath, photo_path AS photoPath, media_type AS mediaType'
    }
  };

  router.get('/admin/content', requireAdminCompat, async (req, res) => {
    try {
      const type = CONTENT_TYPES[req.query.type] ? req.query.type : 'posts';
      const cfg = CONTENT_TYPES[type];
      const { page, pageSize, offset } = paginate(req, { defaultSize: 20 });
      const kw = req.query.kw ? req.query.kw.trim() : '';
      const where = [];
      const params = [];
      if (kw && cfg.q.length) {
        where.push('(' + cfg.q.map(function (c) { return c + ' LIKE ? ESCAPE \'!\''; }).join(' OR ') + ')');
        cfg.q.forEach(function () { params.push('%' + escapeLike(kw) + '%'); });
      }
      // 活动列表支持按类型 / 归档状态筛选
      if (type === 'events') {
        const etype = req.query.eventType;
        if (etype === 'activity' || etype === 'birthday') {
          where.push('event_type = ?');
          params.push(etype);
        }
        const arch = req.query.archived;
        if (arch === '1') { where.push('is_archive = 1'); }
        else if (arch === '0') { where.push('is_archive = 0'); }
      }
      const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const [{ 0: count }] = await getPool().query(`SELECT COUNT(*) AS c FROM ${cfg.table} ${whereSql}`, params);
      // 组装 SELECT 字段：通用字段 + 活动专属字段 + 参与人数
      let selectCols = `${cfg.id} AS id, ${cfg.author} AS authorId, ${cfg.title} AS content`;
      let joins = '';
      if (cfg.extra) selectCols += ', ' + cfg.extra;
      if (type === 'events') {
        if (cfg.signCount) selectCols += ', ' + cfg.signCount;
        if (cfg.signJoin) joins = ' ' + cfg.signJoin;
      }
      const [list] = await getPool().query(
        `SELECT ${selectCols} FROM ${cfg.table}${joins} ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`,
        params.concat([pageSize, offset])
      );
      // 补作者名（textAuthor 类型：authorId 即文本作者名，不查 users 表；活动表 create_user_id 可能为 NULL，回退 create_admin 文本）
      const isTextAuthor = cfg.textAuthor === true;
      const ids = isTextAuthor ? [] : list.map(function (it) { return it.authorId; }).filter(Boolean);
      let nameMap = {};
      if (ids.length) {
        const [us] = await getPool().query(`SELECT id, display_name FROM users WHERE id IN (?)`, [ids]);
        us.forEach(function (u) { nameMap[u.id] = u.display_name; });
      }
      list.forEach(function (it) {
        it.displayName = isTextAuthor ? (it.authorId || '-') : (nameMap[it.authorId] || it.createAdmin || '-');
        if (it.signCount === undefined) it.signCount = 0;
      });
      const totalPages = Math.max(1, Math.ceil(count.c / pageSize));
      res.json({ list, page, totalPages, total: count.c });
    } catch (e) { handleError(res, e, '[admin/content:get]'); }
  });

  router.delete('/admin/content/:type/:id', requireAdminCompat, async (req, res) => {
    const cfg = CONTENT_TYPES[req.params.type];
    if (!cfg) return fail(res, 400, 'invalid type');
    const id = parseInt(req.params.id);
    if (!id) return fail(res, 400, 'invalid id');
    let conn;
    try {
      // P2-124: events 类型 5 条级联 DELETE/UPDATE 包进事务，中途失败整体回滚，杜绝孤儿记录
      conn = await getPool().getConnection();
      await conn.beginTransaction();
      if (req.params.type === 'events') {
        // 级联清理活动关联数据，避免孤儿记录（与 /api/events/:id 删除逻辑一致）
        await conn.query(`UPDATE album_photo SET is_recycle=1, recycle_time=NOW() WHERE event_id=?`, [id]);
        await conn.query(`DELETE FROM event_checkin WHERE event_id=?`, [id]);
        await conn.query(`DELETE FROM event_sign WHERE event_id=?`, [id]);
        await conn.query(`DELETE FROM event_comment WHERE event_id=?`, [id]);
        await conn.query(`DELETE FROM notifications WHERE target_type='event' AND target_id=?`, [id]);
      }
      await conn.query(`DELETE FROM ${cfg.table} WHERE ${cfg.id} = ?`, [id]);
      await conn.commit();
      await logOper(req.session.userId, '删除内容(' + req.params.type + ')', 'ID: ' + id);
      ok(res);
    } catch (e) {
      if (conn) { try { await conn.rollback(); } catch (_e) {} }
      handleError(res, e, '[admin/content:delete]');
    } finally {
      if (conn) { try { conn.release(); } catch (_e) {} }
    }
  });

  router.post('/admin/content/batch', requireAdminCompat, async (req, res) => {
    try {
      const cfg = CONTENT_TYPES[req.body.type];
      if (!cfg) return fail(res, 400, 'invalid type');
      const ids = Array.isArray(req.body.ids) ? req.body.ids.map(function (x) { return parseInt(x); }).filter(function (x) { return x; }) : [];
      if (!ids.length) return fail(res, 400, 'empty ids');
      let conn;
      try {
        // P4-XX: 与原批量直删不同，events 批量删除复用与单条删除一致的级联清理，
        // 避免遗留孤儿报名/签到/评论/通知；整体包进事务，中途失败回滚。
        conn = await getPool().getConnection();
        await conn.beginTransaction();
        if (req.body.type === 'events') {
          await conn.query(`UPDATE album_photo SET is_recycle=1, recycle_time=NOW() WHERE event_id IN (?)`, [ids]);
          await conn.query(`DELETE FROM event_checkin WHERE event_id IN (?)`, [ids]);
          await conn.query(`DELETE FROM event_sign WHERE event_id IN (?)`, [ids]);
          await conn.query(`DELETE FROM event_comment WHERE event_id IN (?)`, [ids]);
          await conn.query(`DELETE FROM notifications WHERE target_type='event' AND target_id IN (?)`, [ids]);
        }
        await conn.query(`DELETE FROM ${cfg.table} WHERE ${cfg.id} IN (?)`, [ids]);
        await conn.commit();
        await logOper(req.session.userId, '批量删除内容(' + req.body.type + ')', 'IDs: ' + ids.join(','));
        ok(res, { deleted: ids.length });
      } catch (e) {
        if (conn) { try { await conn.rollback(); } catch (_e) {} }
        handleError(res, e, '[admin/content:batch]');
      } finally {
        if (conn) { try { conn.release(); } catch (_e) {} }
      }
    } catch (e) { handleError(res, e, '[admin/content:batch]'); }
  });

  return router;
};
