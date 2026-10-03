/**
 * 境途同游 V6.14 — 活动路由（从 server.js 提取）
 * 支持：活动 CRUD、报名/取消、签到、评论、VRChat 同步、生日派对、归档、日历导出
 * 通过工厂模式接收 notifyAllMembers 引用
 *
 * P0-3（2026-09-13 修复）：封堵活动可见性零执行洞——
 *   列表侧（活动列表/生日派对/iCal 导出/日历/有关联 World）统一按 visibilityFilter 过滤：
 *     匿名仅见 public；普通登录用户不见 private（或本人创建）；管理员全量。
 *   详情侧：members_only 需登录、private 仅组织者/管理员；出勤名单（signList/checkinList）
 *     收敛为组织者/管理员可见，人数保持公开（前端按 null 优雅跳过名单渲染）。
 *   另封堵两个同源泄露面：/:id/signs 匿名全量名单、/:id/google-calendar 匿名标题跳转。
 *   路由路径与数量不变，仅收紧数据可见范围。
 *
 * 注：说明文字不得置于 @swagger 之后——swagger-jsdoc 会把 @swagger 起的整块注释
 * 按 YAML 解析，中文散文会导致解析报错、本文件 tags 规范被整体丢弃。
 */
/**
 * @swagger
 * tags:
 *   name: Events
 *   description: 活动管理相关接口
 */
const express = require('express');
const { fail, ok,  getPool, safeError, logOper, validateFields, handleError , sendError, sendVrcError, ErrorCodes, paginate, escapeLike  } = require('../utils');;
const { requireAuth, requireAdminCompat, getAvatarUrl, ROLE_LEVEL } = require('../auth');
const { vrchatGetGroupEvents } = require('../vrc');
const cacheService = require('../cache_service');
const webhook = require('../webhook');



// 判断活动是否已结束（过期校验统一入口）：
// 有结束时间且已过期 => 结束；无结束时间但开始时间已过 => 视为已开始且未定义结束，按“已结束”处理。
function eventHasEnded(evt) {
  if (!evt) return false;
  const now = new Date();
  const ends = evt.ends_at || evt.endsAt;
  const start = evt.event_time || evt.eventTime;
  if (ends) return now > new Date(ends);
  if (start) return now > new Date(start);
  return false;
}

function formatICalDate(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  return date.toISOString().replace(/-|:|\.\d+/g, '');
}

function generateICal(events) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//JingTu//境途同游//ZH',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'NAME:境途同游活动日历',
    'X-WR-CALNAME:境途同游活动日历'
  ];

  events.forEach(evt => {
    const start = formatICalDate(evt.eventTime);
    const end = formatICalDate(evt.endsAt) || start.replace('T', '') + '235959';
    const uid = `event-${evt.id}@jingtu`;
    const title = (evt.eventType === 'birthday' ? '🎂 ' : '📅 ') + evt.title;
    
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${uid}`);
    lines.push(`DTSTAMP:${formatICalDate(new Date())}`);
    lines.push(`DTSTART:${start}`);
    lines.push(`DTEND:${end}`);
    lines.push(`SUMMARY:${title}`);
    if (evt.place) lines.push(`LOCATION:${evt.place}`);
    if (evt.description) lines.push(`DESCRIPTION:${evt.description.replace(/\n/g, '\\n')}`);
    if (evt.worldName) lines.push(`X-ALT-DESC;FMTTYPE=text/html:<p>${evt.description || ''}</p><p>World: ${evt.worldName}</p>`);
    lines.push('END:VEVENT');
  });

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

function generateGoogleCalendarUrl(evt) {
  const start = new Date(evt.eventTime);
  const end = evt.endsAt ? new Date(evt.endsAt) : new Date(start.getTime() + 2 * 60 * 60 * 1000);
  const title = encodeURIComponent((evt.eventType === 'birthday' ? '🎂 ' : '📅 ') + evt.title);
  const details = encodeURIComponent(evt.description || '');
  const location = encodeURIComponent(evt.place || evt.worldName || '');
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${formatICalDate(start)}/${formatICalDate(end)}&details=${details}&location=${location}`;
}

// P0-3 可见性执行：按当前会话身份生成 visibility 过滤 SQL 片段。
// 匿名 => 仅 public；管理员及以上 => 全量；普通登录用户 => 非 private，或本人创建。
// NULL 视同 public（DB DEFAULT 'public'，兼容历史行）。prefix 用于带表别名的查询。
function visibilityFilter(req, prefix = '') {
  const uid = req.session?.userId || 0;
  if (!uid) return { clause: `COALESCE(${prefix}visibility, 'public') = 'public'`, params: [] };
  const roleLevel = ROLE_LEVEL[req.session?.role] || 0;
  if (roleLevel >= ROLE_LEVEL.admin) return { clause: '1=1', params: [] };
  return { clause: `(COALESCE(${prefix}visibility, 'public') <> 'private' OR ${prefix}create_user_id = ?)`, params: [uid] };
}

// P1-43：写操作/详情子资源入口的可见性闸门（与 detail 路由保持一致）：
// members_only 需登录；private 仅组织者/管理员。返回 { ok, status, message, evt }，
// 不通过时已写入响应，调用方直接 return。
async function enforceEventVisibility(req, res) {
  const uid = req.session?.userId || 0;
  const [rows] = await getPool().query(
    `SELECT visibility, create_user_id AS createUserId FROM event WHERE id = ?`, [req.params.id]);
  if (rows.length === 0) return { ok: false, status: 404, message: '活动不存在' };
  const evt = rows[0];
  const vis = evt.visibility || 'public';
  const roleLevel = ROLE_LEVEL[req.session?.role] || 0;
  const isOwner = !!uid && evt.createUserId === uid;
  const isAdmin = roleLevel >= ROLE_LEVEL.admin;
  if (vis === 'members_only' && !uid) return { ok: false, status: 401, message: '请先登录后查看该活动' };
  if (vis === 'private' && !isOwner && !isAdmin) return { ok: false, status: 403, message: '仅组织者或管理员可查看该活动' };
  return { ok: true, evt };
}

/**
 * @param {Function} getVRCCookieFn - 获取 VRChat cookie 的函数
 * @param {object} notificationService - 通知服务
 */
module.exports = function (getVRCCookieFn, notificationService, GROUP_ID) {

  const router = express.Router();

  /**
 * @swagger
 * /api/events:
 *   get:
 *     summary: 获取活动列表
 *     description: 获取活动列表，支持筛选和分页
 *     tags: [Events]
 *     parameters:
 *       - name: status
 *         in: query
 *         type: string
 *         description: 状态筛选 (ongoing)
 *       - name: type
 *         in: query
 *         type: string
 *         description: 活动类型筛选
 *       - name: include_archived
 *         in: query
 *         type: string
 *         description: 是否包含归档 (1)
 *     responses:
 *       200:
 *         description: 活动列表
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 events:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: integer
 *                       title:
 *                         type: string
 *                       place:
 *                         type: string
 *                       eventTime:
 *                         type: string
 *                       eventType:
 *                         type: string
 */
router.get('/', async (req, res) => {
    try {
      const { status, type, include_archived } = req.query;
      const q = (req.query.q || '').trim(); // VN-9 命令面板：活动标题搜索
      const { page, pageSize, offset } = paginate(req, { defaultSize: 20, maxSize: 50 });
      const uid = req.session?.userId || 0;
      
      const whereClauses = ['1=1'];
      const params = [];
      if (include_archived !== '1') whereClauses.push(`is_archive=0`);
      if (type) { whereClauses.push(`event_type = ?`); params.push(type); }
      if (status === 'ongoing') {
        whereClauses.push(`event_time <= NOW() AND (ends_at IS NULL OR ends_at >= NOW())`);
      } else if (status === 'upcoming') {
        whereClauses.push(`event_time > NOW()`);
      } else if (status === 'past') {
        whereClauses.push(`((ends_at IS NOT NULL AND ends_at < NOW()) OR (ends_at IS NULL AND event_time < NOW()))`);
      }
      // VN-9 命令面板：按标题模糊搜索（无表别名，COUNT 与主查询共用 whereStr）
      if (q) { whereClauses.push('title LIKE ? ESCAPE \'!\''); params.push('%' + escapeLike(q) + '%'); }
      // P0-3：按身份过滤可见性（COUNT 与主查询共用 whereStr，列名无歧义）
      const vis = visibilityFilter(req);
      whereClauses.push(vis.clause);
      params.push(...vis.params);
      const whereStr = whereClauses.join(' AND ');

      const [count] = await getPool().query(`SELECT COUNT(*) as total FROM event WHERE ${whereStr}`, params);
      const total = count[0].total;
      
      const sql = `SELECT e.id, e.title, e.place, e.event_time AS eventTime, e.description, e.max_sign AS maxSign, e.event_type AS eventType, e.vrchat_event_id AS vrchatEventId, e.ends_at AS endsAt, e.create_admin AS createAdmin, e.create_user_id AS createUserId, e.is_archive AS isArchive, e.visibility, e.source, e.world_id AS worldId, e.world_name AS worldName, e.world_image_url AS worldImageUrl, e.instance_id AS instanceId, e.instance_type AS instanceType, e.create_time AS createTime, e.updated_at AS updatedAt, COALESCE(s.signCount,0) AS signedCount, (SELECT 1 FROM event_sign esx WHERE esx.event_id = e.id AND esx.user_vrcid = ? AND esx.is_sign=1) AS signedByMe FROM event e LEFT JOIN (SELECT event_id, COUNT(*) AS signCount FROM event_sign WHERE is_sign=1 GROUP BY event_id) s ON s.event_id = e.id WHERE ${whereStr} ORDER BY e.event_time DESC LIMIT ? OFFSET ?`;
      // 注意占位符顺序：SELECT 子查询的 ?(signedByMe) 在 WHERE 之前，故 uid 必须排在 params 之前
      const queryParams = [uid, ...params, pageSize, offset];
      
      const [rows] = await getPool().query(sql, queryParams);
      // 用 LEFT JOIN 一次性带出报名数，避免 N+1 查询拖慢首页活动列表
      const eventsWithSigns = rows.map((evt) => {
        const sc = evt.signedCount || 0;
        return { ...evt, signedCount: sc, signedByMe: !!evt.signedByMe, time: evt.eventTime, participants: sc, maxParticipants: evt.maxSign, signCount: sc };
      });

      const totalPages = Math.ceil(total / pageSize);
      const hasMore = offset + pageSize < total;
      res.json({ events: eventsWithSigns, total, page, pageSize, totalPages, hasMore });
    } catch (e) { handleError(res, e, '[events/list]'); }
  });

  // ==================== 生日派对 ====================
  router.get('/birthday-parties', async (req, res) => {
    try {
      const vis = visibilityFilter(req);
      const [rows] = await getPool().query(
        `SELECT id, title, event_time AS eventTime, ends_at AS endsAt, description, create_admin AS createAdmin, create_user_id AS createUserId, event_type AS eventType FROM event WHERE event_type='birthday' AND ${vis.clause} ORDER BY event_time DESC LIMIT 20`,
        vis.params
      );
      res.json(rows);
    } catch (e) { handleError(res, e, '[events/birthday-parties]'); }
  });

  // ==================== 活动日历导出（iCal格式） ====================
  router.get('/export/ical', async (req, res) => {
    try {
      const vis = visibilityFilter(req);
      const [rows] = await getPool().query(
        `SELECT id, title, place, event_time AS eventTime, description, event_type AS eventType, ends_at AS endsAt, world_name AS worldName
         FROM event WHERE is_archive=0 AND ${vis.clause} ORDER BY event_time ASC LIMIT 50`,
        vis.params
      );
      const ical = generateICal(rows);
      res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename=jingtu-events.ics');
      res.send(ical);
    } catch (e) { handleError(res, e, '[events/export-ical]'); }
  });

  // ==================== 获取活动日历数据（JSON格式） ====================
  router.get('/calendar', async (req, res) => {
    try {
      const { year, month } = req.query;
      const vis = visibilityFilter(req);
      let sql = `SELECT id, title, event_time AS eventTime, ends_at AS endsAt, event_type AS eventType, visibility FROM event WHERE is_archive=0 AND ${vis.clause}`;
      const params = [...vis.params];
      if (year && month) {
        const start = `${year}-${String(month).padStart(2, '0')}-01`;
        const end = new Date(parseInt(year), parseInt(month), 0).toISOString().split('T')[0];
        sql += ` AND event_time BETWEEN ? AND ?`;
        params.push(start, end);
      }
      sql += ` ORDER BY event_time ASC`;
      const [rows] = await getPool().query(sql, params);
      res.json({ events: rows });
    } catch (e) { handleError(res, e, '[events/calendar]'); }
  });

  // ==================== 有关联 World 的活动 ====================
  router.get('/with-worlds', async (req, res) => {
    try {
      const vis = visibilityFilter(req);
      const [rows] = await getPool().query(
        `SELECT id, title, event_time AS eventTime, event_time AS time, ends_at AS endsAt, world_id AS worldId, world_name AS worldName, world_image_url AS worldImageUrl, visibility FROM event WHERE world_id IS NOT NULL AND ${vis.clause} ORDER BY event_time DESC LIMIT 50`,
        vis.params
      );
      const events = rows.map(e => ({ ...e, participants: 0, maxParticipants: 0, signCount: 0, description: '', eventType: 'activity', visibility: e.visibility || 'public' }));
      res.json({ events });
    } catch (e) { handleError(res, e, '[events/with-worlds]'); }
  });

  // ==================== 活动详情 ====================
  router.get('/detail/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!id) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      const [rows] = await getPool().query(
          `SELECT id, title, place, event_time AS eventTime, description, max_sign AS maxSign,
                  event_type AS eventType, vrchat_event_id AS vrchatEventId, ends_at AS endsAt,
                  create_admin AS createAdmin, create_user_id AS createUserId, is_archive AS isArchive, visibility, source,
                  world_id AS worldId, world_name AS worldName, world_image_url AS worldImageUrl,
                  instance_id AS instanceId, instance_type AS instanceType,
                  create_time AS createTime, updated_at AS updatedAt
           FROM event WHERE id = ?`, [id]
      );
      if (rows.length === 0) return sendError(res, 404, ErrorCodes.NOT_FOUND, '活动不存在');
      const evt = rows[0];
      // P0-3：详情页可见性执行——members_only 需登录；private（防御性）仅组织者/管理员
      const uid = req.session?.userId || 0;
      const vis = evt.visibility || 'public';
      const roleLevel = ROLE_LEVEL[req.session?.role] || 0;
      const isOwner = !!uid && evt.createUserId === uid;
      const isAdmin = roleLevel >= ROLE_LEVEL.admin;
      if (vis === 'members_only' && !uid) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, '请先登录后查看该活动');
      if (vis === 'private' && !isOwner && !isAdmin) return sendError(res, 403, ErrorCodes.FORBIDDEN, '仅组织者或管理员可查看该活动');
      // P0-3：出勤名单（报名/打卡）含用户昵称与 ID，仅组织者/管理员可见；人数保持公开
      const canSeeRoster = !!uid && (isOwner || isAdmin);
      // 当前用户是否已报名（用于前端按钮态，避免依赖前端本地 Set 的初始缺失）
      const [[signedRow]] = await getPool().query('SELECT 1 AS ok FROM event_sign WHERE event_id=? AND user_vrcid=? AND is_sign=1', [id, uid]);
      const signedByMe = !!signedRow;
      const [signCount] = await getPool().query(`SELECT COUNT(*) as c FROM event_sign WHERE event_id=? AND is_sign=1`, [id]);
      const [[{ checkinCount }]] = await getPool().query(`SELECT COUNT(*) AS checkinCount FROM event_checkin WHERE event_id=?`, [id]);
      let signList = null;
      let checkinList = null;
      if (canSeeRoster) {
        const [signs] = await getPool().query(
          `SELECT s.id, s.user_vrcid, s.user_name, s.sign_time, u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url, u.avatar_visible
           FROM event_sign s LEFT JOIN users u ON u.id = s.user_vrcid
           WHERE s.event_id=? AND s.is_sign=1 ORDER BY s.sign_time`, [id]);
        signList = signs.map(s => ({ id: s.id, user_name: s.user_name, avatarUrl: getAvatarUrl(s) }));
        const [checkins] = await getPool().query(`SELECT id, user_id, user_name, checkin_time AS checkinTime FROM event_checkin WHERE event_id=? ORDER BY checkin_time`, [id]);
        checkinList = checkins;
      }
      // 结束状态：用于前端置灰/隐藏过期活动的操作入口
      const now = new Date();
      const ended = evt.endsAt ? now > new Date(evt.endsAt) : (evt.eventTime ? now > new Date(evt.eventTime) : false);
      res.json({ ...evt, time: evt.eventTime, desc: evt.description, signedByMe, signCount: signCount[0].c, maxSign: evt.maxSign, signList, checkinList, checkinCount, ended });
    } catch (e) { handleError(res, e, '[events/detail]'); }
  });

  // ==================== 创建活动 ====================
  router.post('/', requireAuth, async (req, res) => {
    try {
      let { title, place, eventTime, time, description, desc, maxSign, eventType, endsAt, visibility, worldId, worldName, worldImageUrl, instanceId, instanceType } = req.body;
        if (!eventTime && time) eventTime = time;
        if (!description && desc) description = desc;
        if (!title || !eventTime) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '标题和时间不能为空');
        if (typeof title === 'string' && title.length > 100) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '标题不能超过100个字符');
        const validTypes = ['activity', 'birthday', 'meetup', 'vrchat', 'other'];
        const validVisibilities = ['public', 'members_only', 'private'];
        if (eventType && !validTypes.includes(eventType)) eventType = 'activity';
        if (visibility && !validVisibilities.includes(visibility)) visibility = 'members_only';
        if (maxSign !== undefined && (isNaN(maxSign) || maxSign < 0 || maxSign > 9999)) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '人数限制必须是0-9999之间的数字');
        if (description && description.length > 2000) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '描述不能超过2000个字符');
        if (endsAt && eventTime && new Date(endsAt) <= new Date(eventTime)) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '结束时间必须晚于开始时间');
        const [result] = await getPool().query(
          `INSERT INTO event (title, place, event_time, description, max_sign, event_type, ends_at, visibility, world_id, world_name, world_image_url, instance_id, instance_type, source, create_admin, create_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [title, place || '', eventTime, description || '', maxSign || 0, eventType || 'activity', endsAt || null, visibility || 'members_only', worldId || null, worldName || null, worldImageUrl || null, instanceId || null, instanceType || null, 'manual', req.session.displayName || req.session.userId || '未知用户', req.session.userId]
      );
      await logOper(req.session.userId, '创建活动', `活动: ${title}`);
      const evtType = eventType === 'birthday' ? '🎂 生日派对' : '📅 活动';
      if (notificationService) notificationService.notifyAllMembers('event_reminder', `${evtType}: ${title}`, `活动时间: ${new Date(eventTime).toLocaleString('zh-CN')}`, { relatedId: result.insertId, targetType: 'event', targetId: result.insertId });
      // 失效缓存并触发webhook
      await cacheService.invalidateRelated('activity');
      webhook.triggerEventCreated({ id: result.insertId, title, description, start_time: eventTime, end_time: endsAt }).catch(() => {});
      ok(res, { id: result.insertId });
    } catch (e) { handleError(res, e, '[events/create]'); }
  });

  // ==================== 编辑活动 ====================
  router.put('/:id', requireAuth, async (req, res) => {
    try {
      const uid = req.session?.userId;
      const roleLevel = ROLE_LEVEL[req.session?.role] || 0;
      const [[evt0]] = await getPool().query(`SELECT id, create_user_id AS createUserId FROM event WHERE id=?`, [req.params.id]);
      if (!evt0) return sendError(res, 404, ErrorCodes.NOT_FOUND, '活动不存在');
      // 权限：管理员（roleLevel>=3）或活动创建者本人可编辑（与删除逻辑一致）
      if (roleLevel < 3 && evt0.createUserId !== uid) {
        return sendError(res, 403, ErrorCodes.FORBIDDEN, '只有管理员或活动创建者可以编辑该活动');
      }
      let { title, place, eventTime, time, description, desc, maxSign, eventType, endsAt, visibility, worldId, worldName, worldImageUrl, isArchive, instanceId, instanceType } = req.body;
        if (!eventTime && time) eventTime = time;
        if (!description && desc) description = desc;
        // 输入校验（与创建保持一致，避免脏数据）
        if (title !== undefined && typeof title === 'string' && title.length > 100) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '标题不能超过100个字符');
        if (description !== undefined && typeof description === 'string' && description.length > 2000) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '描述不能超过2000个字符');
        if (maxSign !== undefined && (isNaN(maxSign) || maxSign < 0 || maxSign > 9999)) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '人数限制必须是0-9999之间的数字');
        const validTypes = ['activity', 'birthday', 'meetup', 'vrchat', 'other'];
        const validVisibilities = ['public', 'members_only', 'private'];
        if (eventType !== undefined && !validTypes.includes(eventType)) eventType = 'activity';
        if (visibility !== undefined && !validVisibilities.includes(visibility)) visibility = 'members_only';
        if (endsAt && eventTime && new Date(endsAt) <= new Date(eventTime)) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '结束时间必须晚于开始时间');
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
        if (instanceId !== undefined) updates.instance_id = instanceId;
        if (instanceType !== undefined) updates.instance_type = instanceType;
        // 归档仅管理员可操作，普通创建者不可自行归档/取消归档
        if (isArchive !== undefined && roleLevel >= 3) updates.is_archive = isArchive ? 1 : 0;
      const ALLOWED_FIELDS = ['title', 'place', 'event_time', 'description', 'max_sign', 'event_type', 'ends_at', 'visibility', 'world_id', 'world_name', 'world_image_url', 'instance_id', 'instance_type', 'is_archive'];
      validateFields(updates, ALLOWED_FIELDS);
      if (Object.keys(updates).length === 0) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '无更新字段');
      const sets = Object.keys(updates).map(k => `${k}=?`).join(',');
      const vals = Object.values(updates);
      vals.push(req.params.id);
      await getPool().query(`UPDATE event SET ${sets} WHERE id=?`, vals);
      await cacheService.invalidateActivity(req.params.id);
      webhook.triggerEventUpdated({ id: parseInt(req.params.id), ...updates }).catch(() => {});
      ok(res);
    } catch (e) { handleError(res, e, '[events/update]'); }
  });

  // ==================== 删除活动（内部复用：单条 + 批量） ====================
  // 在已开启的事务 conn 上删除单个活动：权限校验 + 级联清理 + 审计。
  // 任一失败（无权限/已结束/不存在）抛出带状态码的错误，由调用方决定回滚或整体拒绝。
  async function deleteOneEvent(conn, eventId, uid, roleLevel) {
    // 权限：管理员（roleLevel>=3）或活动创建者本人可删除
    const [[evt]] = await conn.query(`SELECT id, create_user_id AS createUserId, event_time AS eventTime, ends_at AS endsAt FROM event WHERE id=? FOR UPDATE`, [eventId]);
    if (!evt) {
      const err = new Error('活动不存在');
      err.status = 404; err.code = ErrorCodes.NOT_FOUND;
      throw err;
    }
    if (roleLevel < 3 && evt.createUserId !== uid) {
      const err = new Error('只有管理员或活动创建者可以删除');
      err.status = 403; err.code = ErrorCodes.FORBIDDEN;
      throw err;
    }
    // 已结束活动：普通用户（非管理员）禁止删除，防止误删历史活动记录；
    // 管理员（roleLevel>=3）可删除已结束活动（含生日活动），便于后台清理。
    if (roleLevel < 3 && eventHasEnded(evt)) {
      const err = new Error('活动已结束，不能删除');
      err.status = 409; err.code = ErrorCodes.CONFLICT;
      throw err;
    }
    await conn.query(`UPDATE album_photo SET is_recycle=1, recycle_time=NOW() WHERE event_id=?`, [eventId]);
    await conn.query(`DELETE FROM event_checkin WHERE event_id=?`, [eventId]);
    await conn.query(`DELETE FROM event_sign WHERE event_id=?`, [eventId]);
    await conn.query(`DELETE FROM event_comment WHERE event_id=?`, [eventId]);
    await conn.query(`DELETE FROM notifications WHERE target_type='event' AND target_id=?`, [eventId]);
    // 级联清理活动下的队伍及成员，避免孤儿数据（D3）
    await conn.query(`DELETE FROM event_team_members WHERE team_id IN (SELECT id FROM event_teams WHERE event_id=?)`, [eventId]);
    await conn.query(`DELETE FROM event_teams WHERE event_id=?`, [eventId]);
    await conn.query(`DELETE FROM event WHERE id=?`, [eventId]);
    // 删除操作审计留痕，与创建/编辑对称（D6）
    if (uid) await logOper(uid, '删除活动', `活动ID: ${eventId}`);
    await cacheService.invalidateActivity(eventId);
    webhook.triggerEventDeleted(eventId).catch(() => {});
  }

  router.delete('/:id', requireAuth, async (req, res) => {
    const uid = req.session?.userId;
    // 采用全站统一的权限判定：基于 ROLE_LEVEL[req.session.role]，避免 roleLevel 字段缺失/类型错误导致的越权或误拒（D2）
    const roleLevel = ROLE_LEVEL[req.session?.role] || 0;
    let conn;
    try {
      conn = await getPool().getConnection();
      await conn.beginTransaction();
      await deleteOneEvent(conn, parseInt(req.params.id), uid, roleLevel);
      await conn.commit();
      ok(res);
    } catch (e) {
      if (conn) await conn.rollback();
      // deleteOneEvent 抛出的错误携带 status/code，直接透传
      if (e.status) return sendError(res, e.status, e.code, e.message);
      handleError(res, e, '[events/delete]');
    } finally {
      if (conn) conn.release();
    }
  });

  // ==================== 批量删除活动 ====================
  // 入参：{ ids: number[] }。先全量预校验权限（任一条越权/已结束/不存在即整体 403/409/404 拒绝，
  // 避免「部分删除」的不一致）；全部通过才在一个事务内批量删除。
  router.post('/batch-delete', requireAuth, async (req, res) => {
    const uid = req.session?.userId;
    const roleLevel = ROLE_LEVEL[req.session?.role] || 0;
    let ids = req.body && req.body.ids;
    if (!Array.isArray(ids) || ids.length === 0) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请选择要删除的活动');
    }
    // 去重 + 限容（一次最多 100 条，防止滥用）
    ids = Array.from(new Set(ids.map(id => parseInt(id, 10)))).filter(id => Number.isInteger(id) && id > 0).slice(0, 100);
    if (ids.length === 0) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '活动 ID 无效');
    }
    let conn;
    try {
      conn = await getPool().getConnection();
      await conn.beginTransaction();
      // 预校验：逐条确认权限，任一不满足则整体回滚拒绝（无部分删除）
      for (const id of ids) {
        const [[evt]] = await conn.query(`SELECT id, create_user_id AS createUserId, event_time AS eventTime, ends_at AS endsAt FROM event WHERE id=? FOR UPDATE`, [id]);
        if (!evt) { await conn.rollback(); return sendError(res, 404, ErrorCodes.NOT_FOUND, `活动 ${id} 不存在`); }
        if (roleLevel < 3 && evt.createUserId !== uid) {
          await conn.rollback();
          return sendError(res, 403, ErrorCodes.FORBIDDEN, `无权删除活动 ${id}`);
        }
        if (roleLevel < 3 && eventHasEnded(evt)) {
          await conn.rollback();
          return sendError(res, 409, ErrorCodes.CONFLICT, `活动 ${id} 已结束，不能删除`);
        }
      }
      // 校验通过：事务内批量删除
      for (const id of ids) {
        await deleteOneEvent(conn, id, uid, roleLevel);
      }
      await conn.commit();
      // 审计：批量删除活动
      try { await logOper(uid, '批量删除活动', `IDs: ${ids.join(',')}`); } catch (_) {}
      ok(res, { deleted: ids.length });
    } catch (e) {
      if (conn) await conn.rollback();
      if (e.status) return sendError(res, e.status, e.code, e.message);
      handleError(res, e, '[events/batch-delete]');
    } finally {
      if (conn) conn.release();
    }
  });

  // ==================== 批量归档活动 ====================
  // 入参：{ ids: number[] }。仅管理员可操作（归档属后台整理动作）。
  // 预校验存在性（任一条不存在即整体 404 拒绝），全部通过才在一个事务内批量置 is_archive=1。
  router.post('/batch-archive', requireAdminCompat, async (req, res) => {
    const uid = req.session?.userId;
    let ids = req.body && req.body.ids;
    if (!Array.isArray(ids) || ids.length === 0) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请选择要归档的活动');
    }
    ids = Array.from(new Set(ids.map(id => parseInt(id, 10)))).filter(id => Number.isInteger(id) && id > 0).slice(0, 100);
    if (ids.length === 0) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '活动 ID 无效');
    }
    let conn;
    try {
      conn = await getPool().getConnection();
      await conn.beginTransaction();
      for (const id of ids) {
        const [[evt]] = await conn.query(`SELECT id FROM event WHERE id=? FOR UPDATE`, [id]);
        if (!evt) { await conn.rollback(); return sendError(res, 404, ErrorCodes.NOT_FOUND, `活动 ${id} 不存在`); }
      }
      for (const id of ids) {
        await conn.query(`UPDATE event SET is_archive=1 WHERE id=?`, [id]);
        await cacheService.invalidateActivity(id);
      }
      await conn.commit();
      // 审计：批量归档活动
      try { await logOper(uid, '批量归档活动', `IDs: ${ids.join(',')}`); } catch (_) {}
      ok(res, { archived: ids.length });
    } catch (e) {
      if (conn) await conn.rollback();
      handleError(res, e, '[events/batch-archive]');
    } finally {
      if (conn) conn.release();
    }
  });

  // ==================== 从 VRChat 同步活动 ====================
  router.post('/sync-vrchat', requireAdminCompat, async (req, res) => {
    const vrcCookie = getVRCCookieFn ? getVRCCookieFn(req) : null;
    if (!vrcCookie) return fail(res, 401, '请先在个人中心绑定VRChat账号，或由管理员在后台登录VRChat系统账号', { code: 'VRC_SYSTEM_OFFLINE' });
    try {
      let ge = await vrchatGetGroupEvents(GROUP_ID, vrcCookie, 100, 0);
      // 用户绑定的 cookie 可能已过期；标记失效后降级到系统账号 cookie 重试一次
      // invalidate 现仅清除「用户自己绑定的 session cookie」，不会误注销系统账号
      // （系统 cookie 偶发 401 是 VRChat 2FA 重查常态，不应连坐注销全站系统登录）。
      if (ge.status === 401 && typeof getVRCCookieFn.invalidate === 'function' && await getVRCCookieFn.invalidate(req, vrcCookie)) {
        const next = getVRCCookieFn(req);
        if (next && next !== vrcCookie) ge = await vrchatGetGroupEvents(GROUP_ID, next, 100, 0);
      }
      if (ge.status !== 200) return sendVrcError(res, ge, '获取 VRChat 日历');
      const events = Array.isArray(ge.data) ? ge.data : [];
      let added = 0;
      for (const evt of events) {
        const [result] = await getPool().query(
          `INSERT IGNORE INTO event (title, event_time, description, event_type, vrchat_event_id, ends_at, source, visibility, create_admin, create_user_id) VALUES (?, ?, ?, 'activity', ?, NULL, 'vrchat', 'members_only', ?, 0)`,
          [evt.name || evt.title || 'VRChat 活动', evt.scheduledAt || evt.startTime || new Date(), evt.description || '', String(evt.id), 'VRChat Sync']
        );
        if (result.affectedRows > 0) added++;
      }
      ok(res, { added, total: events.length });
    } catch (e) { handleError(res, e, '[events/sync-vrchat]'); }
  });

  // ==================== 活动报名 ====================
  router.post('/:id/sign', async (req, res) => {
    const uid = req.session?.userId;
    if (!uid) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, '请先登录');
    // P1-43：private/members_only 活动不得被非组织者报名
    const gate = await enforceEventVisibility(req, res);
    if (!gate.ok) return sendError(res, gate.status, gate.status === 404 ? ErrorCodes.NOT_FOUND : gate.status === 401 ? ErrorCodes.UNAUTHORIZED : ErrorCodes.FORBIDDEN, gate.message);
    // 封禁用户禁止报名
    const [[meRow]] = await getPool().query('SELECT banned FROM users WHERE id = ? AND deleted_at IS NULL', [uid]);
    if (meRow && meRow.banned) return sendError(res, 403, ErrorCodes.FORBIDDEN, '账户已被封禁，无法报名');
    let conn;
    try {
      conn = await getPool().getConnection();
      await conn.beginTransaction();
      const [evt] = await conn.query(`SELECT max_sign AS maxSign, title, create_user_id AS createUserId, create_admin AS createAdmin, event_time AS eventTime, ends_at AS endsAt FROM event WHERE id=? FOR UPDATE`, [req.params.id]);
      if (evt.length === 0) { await conn.rollback(); return sendError(res, 404, ErrorCodes.NOT_FOUND, '活动不存在'); }
      if (eventHasEnded(evt[0])) { await conn.rollback(); return sendError(res, 403, ErrorCodes.FORBIDDEN, '活动已结束，无法报名'); }
      const [existing] = await conn.query(`SELECT id FROM event_sign WHERE event_id=? AND user_vrcid=? FOR UPDATE`, [req.params.id, uid]);
      if (existing.length > 0) { await conn.rollback(); return ok(res, { alreadySigned: true }); }
      if (evt[0].maxSign > 0) {
        const [cnt] = await conn.query(`SELECT COUNT(*) AS c FROM event_sign WHERE event_id=?`, [req.params.id]);
        if (cnt[0].c >= evt[0].maxSign) { await conn.rollback(); return sendError(res, 400, ErrorCodes.BAD_REQUEST, '活动已满员'); }
      }
      const name = req.session.displayName || '用户';
      await conn.query(`INSERT INTO event_sign (event_id, user_vrcid, user_name, is_sign, sign_time) VALUES (?, ?, ?, 1, NOW())`, [req.params.id, uid, name]);
      await conn.commit();
      if (notificationService && evt[0].createUserId && evt[0].createUserId !== uid) {
        notificationService.notifyUser(
          evt[0].createUserId,
          'event_sign',
          `${name} 报名了你的活动`,
          `活动: ${evt[0].title}`,
          { targetType: 'event', targetId: parseInt(req.params.id) }
        );
      }
      ok(res);
    } catch (e) { if (conn) await conn.rollback().catch(()=>{}); handleError(res, e, '[events/sign]'); }
    finally { if (conn) conn.release(); }
  });

  // ==================== 取消报名 ====================
  router.post('/:id/unsign', async (req, res) => {
    const uid = req.session?.userId;
    if (!uid) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, '请先登录');
    // P1-43：private 活动同样不可被非组织者操作（防御性闸门）
    const gate = await enforceEventVisibility(req, res);
    if (!gate.ok) return sendError(res, gate.status, gate.status === 404 ? ErrorCodes.NOT_FOUND : gate.status === 401 ? ErrorCodes.UNAUTHORIZED : ErrorCodes.FORBIDDEN, gate.message);
    const [[meRow2]] = await getPool().query('SELECT banned FROM users WHERE id = ? AND deleted_at IS NULL', [uid]);
    if (meRow2 && meRow2.banned) return sendError(res, 403, ErrorCodes.FORBIDDEN, '账户已被封禁');
    try {
      const [[evt]] = await getPool().query(`SELECT event_time AS eventTime, ends_at AS endsAt FROM event WHERE id=?`, [req.params.id]);
      if (eventHasEnded(evt)) return sendError(res, 403, ErrorCodes.FORBIDDEN, '活动已结束，无法取消报名');
      await getPool().query(`DELETE FROM event_sign WHERE event_id=? AND user_vrcid=?`, [req.params.id, uid]);
      ok(res);
    } catch (e) { handleError(res, e, '[events/unsign]'); }
  });

  // ==================== 活动签到 ====================
  router.post('/:id/checkin', requireAdminCompat, async (req, res) => {
    try {
      const [[evt]] = await getPool().query(`SELECT id, event_time AS eventTime, ends_at AS endsAt FROM event WHERE id=?`, [req.params.id]);
      if (!evt) return sendError(res, 404, ErrorCodes.NOT_FOUND, '活动不存在');
      if (eventHasEnded(evt)) return sendError(res, 403, ErrorCodes.FORBIDDEN, '活动已结束，无法签到');
      const name = req.session.displayName || '管理员';
      await getPool().query(`INSERT INTO event_checkin (event_id, user_id, user_name) VALUES (?, ?, ?)`, [req.params.id, req.session.userId, name]);
      ok(res, { message: '签到成功' });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return ok(res, { message: '已签到' });
      handleError(res, e, '[events/checkin]');
    }
  });

  // ==================== 生成签到码 ====================
  router.get('/:id/checkin-qr', requireAdminCompat, async (req, res) => {
    try {
      const eventId = parseInt(req.params.id);
      const [events] = await getPool().query(`SELECT id, title FROM event WHERE id=?`, [eventId]);
      if (events.length === 0) {
        return sendError(res, 404, ErrorCodes.NOT_FOUND, '活动不存在');
      }
      const event = events[0];
      const qrData = JSON.stringify({ eventId, timestamp: Date.now() });
      const qrCodeUrl = `/api/qr?data=${encodeURIComponent(qrData)}&size=300`;
      res.json({ qrCodeUrl, eventId, title: event.title });
    } catch (e) {
      handleError(res, e, '[events/checkin-qr]');
    }
  });

  // ==================== 获取报名列表 ====================
  router.get('/:id/signs', async (req, res) => {
    try {
      // P0-3：报名名单含用户昵称/ID（出勤 PII），仅登录的组织者或管理员可见
      const uid = req.session?.userId || 0;
      if (!uid) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, '请先登录');
      const [evRows] = await getPool().query(`SELECT create_user_id AS createUserId FROM event WHERE id = ?`, [req.params.id]);
      if (evRows.length === 0) return sendError(res, 404, ErrorCodes.NOT_FOUND, '活动不存在');
      const roleLevel = ROLE_LEVEL[req.session?.role] || 0;
      if (evRows[0].createUserId !== uid && roleLevel < ROLE_LEVEL.admin) {
        return sendError(res, 403, ErrorCodes.FORBIDDEN, '仅组织者或管理员可查看报名名单');
      }
      const [rows] = await getPool().query(`SELECT id, user_vrcid AS userVrcId, user_name AS userName, sign_time AS signTime FROM event_sign WHERE event_id=? AND is_sign=1`, [req.params.id]);
      res.json(rows);
    } catch (e) { handleError(res, e, '[events/signs]'); }
  });

  // ==================== 活动评论列表 ====================
  router.get('/:id/comments', async (req, res) => {
    try {
      // P1-43：private 活动的评论（含用户 PII）仅组织者/管理员可见
      const gate = await enforceEventVisibility(req, res);
      if (!gate.ok) return sendError(res, gate.status, gate.status === 404 ? ErrorCodes.NOT_FOUND : gate.status === 401 ? ErrorCodes.UNAUTHORIZED : ErrorCodes.FORBIDDEN, gate.message);
      const [rows] = await getPool().query(
        `SELECT ec.id, ec.content, ec.create_time AS createdAt, u.id AS userId, u.display_name AS userName, u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url
         FROM event_comment ec LEFT JOIN users u ON ec.user_id = u.id
         WHERE ec.event_id=? ORDER BY ec.create_time ASC`, [req.params.id]
      );
      const mapped = rows.map(r => ({ id: r.id, content: r.content, createdAt: r.createdAt, userId: r.userId, userName: r.userName, avatarUrl: getAvatarUrl(r) }));
      res.json(mapped);
    } catch (e) { handleError(res, e, '[events/comments]'); }
  });

  // ==================== 发布评论 ====================
  router.post('/:id/comments', async (req, res) => {
    const uid = req.session?.userId;
    if (!uid) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, '请先登录');
    // P1-43：private 活动不得被非组织者评论
    const gate = await enforceEventVisibility(req, res);
    if (!gate.ok) return sendError(res, gate.status, gate.status === 404 ? ErrorCodes.NOT_FOUND : gate.status === 401 ? ErrorCodes.UNAUTHORIZED : ErrorCodes.FORBIDDEN, gate.message);
    try {
      const { content } = req.body;
      if (!content) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请输入评论内容');
      if (typeof content !== 'string' || content.length > 2000) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '评论内容不能超过2000字');
      const [[evt]] = await getPool().query(`SELECT title, create_user_id AS createUserId, event_time AS eventTime, ends_at AS endsAt FROM event WHERE id=?`, [req.params.id]);
      if (!evt) return sendError(res, 404, ErrorCodes.NOT_FOUND, '活动不存在');
      if (eventHasEnded(evt)) return sendError(res, 403, ErrorCodes.FORBIDDEN, '活动已结束，无法评论');
      const name = req.session.displayName || '用户';
      await getPool().query(`INSERT INTO event_comment (event_id, user_id, user_name, content) VALUES (?, ?, ?, ?)`, [req.params.id, uid, name, content]);
      if (notificationService && evt && evt.createUserId && evt.createUserId !== uid) {
        notificationService.notifyUser(
          evt.createUserId,
          'comment',
          `${name} 评论了你的活动`,
          `活动: ${evt.title}\n评论: ${content.slice(0, 50)}`,
          { targetType: 'event', targetId: parseInt(req.params.id) }
        );
      }
      ok(res);
    } catch (e) { handleError(res, e, '[events/create-comment]'); }
  });

  // ==================== 活动关联照片 ====================
  router.get('/:id/photos', async (req, res) => {
    try {
      // P1-43：private 活动的照片同样遵循可见性闸门
      const gate = await enforceEventVisibility(req, res);
      if (!gate.ok) return sendError(res, gate.status, gate.status === 404 ? ErrorCodes.NOT_FOUND : gate.status === 401 ? ErrorCodes.UNAUTHORIZED : ErrorCodes.FORBIDDEN, gate.message);
      const [rows] = await getPool().query(
        `SELECT p.id, p.photo_path AS url, p.thumb_path AS thumbnail, p.photo_desc AS caption,
                p.upload_vrcid AS uploader, p.upload_name AS uploaderName, p.like_count AS likes,
                p.media_type AS mediaType, p.file_size AS fileSize,
                p.create_time AS createTime FROM album_photo p WHERE p.event_id=? AND p.is_recycle=0 ORDER BY p.create_time DESC`,
        [parseInt(req.params.id)]
      );
      res.json(rows);
    } catch (e) { handleError(res, e, '[events/photos]'); }
  });

  // ==================== 删除活动照片 ====================
  router.delete('/:eventId/photos/:photoId', requireAdminCompat, async (req, res) => {
    try {
      const eventId = parseInt(req.params.eventId);
      const photoId = parseInt(req.params.photoId);
      await getPool().query(`UPDATE album_photo SET is_recycle=1, recycle_time=NOW() WHERE id=? AND event_id=?`, [photoId, eventId]);
      ok(res);
    } catch (e) { handleError(res, e, '[events/delete-photo]'); }
  });

  // ==================== 编辑评论 ====================
  router.put('/:eventId/comments/:commentId', async (req, res) => {
    const uid = req.session?.userId;
    if (!uid) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, '请先登录');
    try {
      const commentId = parseInt(req.params.commentId);
      const eventId = parseInt(req.params.eventId);
      const { content } = req.body;
      if (!commentId || !eventId) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      if (!content || !content.trim()) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请输入评论内容');
      if (typeof content !== 'string' || content.length > 2000) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '评论内容不能超过2000字');
      const [comments] = await getPool().query(`SELECT user_id FROM event_comment WHERE id=? AND event_id=?`, [commentId, eventId]);
      if (!comments.length) return sendError(res, 404, ErrorCodes.NOT_FOUND, '评论不存在');
      const userRole = ROLE_LEVEL[req.session.role] || 0;
      if (comments[0].user_id !== uid && userRole < ROLE_LEVEL.admin) {
        return sendError(res, 403, ErrorCodes.FORBIDDEN, '无权编辑此评论');
      }
      await getPool().query(`UPDATE event_comment SET content=? WHERE id=?`, [content.trim(), commentId]);
      ok(res, { content: content.trim() });
    } catch (e) { handleError(res, e, '[events/update-comment]'); }
  });

  // ==================== 删除评论 ====================
  router.delete('/:eventId/comments/:commentId', async (req, res) => {
    const uid = req.session?.userId;
    if (!uid) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, '请先登录');
    try {
      const userRole = ROLE_LEVEL[req.session.role] || 0;
      if (userRole >= ROLE_LEVEL.admin) {
        await getPool().query(`DELETE FROM event_comment WHERE id=?`, [req.params.commentId]);
      } else {
        await getPool().query(`DELETE FROM event_comment WHERE id=? AND user_id=?`, [req.params.commentId, uid]);
      }
      ok(res);
    } catch (e) { handleError(res, e, '[events/delete-comment]'); }
  });

  // ==================== 活动归档/恢复 ====================
  router.post('/:id/archive', requireAdminCompat, async (req, res) => {
    try { await getPool().query(`UPDATE event SET is_archive=1 WHERE id=?`, [req.params.id]); ok(res); }
    catch (e) { handleError(res, e, '[events/archive]'); }
  });
  router.post('/:id/unarchive', requireAdminCompat, async (req, res) => {
    try { await getPool().query(`UPDATE event SET is_archive=0 WHERE id=?`, [req.params.id]); ok(res); }
    catch (e) { handleError(res, e, '[events/unarchive]'); }
  });

  // ==================== 单个活动导出到Google日历 ====================
  router.get('/:id/google-calendar', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!id) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      const [rows] = await getPool().query(
        `SELECT id, title, place, event_time AS eventTime, description, event_type AS eventType, ends_at AS endsAt, world_name AS worldName, visibility, create_user_id AS createUserId
         FROM event WHERE id = ?`, [id]
      );
      if (rows.length === 0) return sendError(res, 404, ErrorCodes.NOT_FOUND, '活动不存在');
      // P0-3：跳转 URL 携带标题/简介/地点，按与详情页一致的可见性规则执行
      const uid = req.session?.userId || 0;
      const vis = rows[0].visibility || 'public';
      const roleLevel = ROLE_LEVEL[req.session?.role] || 0;
      if (vis === 'members_only' && !uid) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, '请先登录后查看该活动');
      if (vis === 'private' && rows[0].createUserId !== uid && roleLevel < ROLE_LEVEL.admin) {
        return sendError(res, 403, ErrorCodes.FORBIDDEN, '仅组织者或管理员可查看该活动');
      }
      const url = generateGoogleCalendarUrl(rows[0]);
      res.redirect(url);
    } catch (e) { handleError(res, e, '[events/google-calendar]'); }
  });

  return router;
};
