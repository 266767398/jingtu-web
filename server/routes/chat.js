/**
 * 境途同游 V6.13 — 聊天系统路由（私信 + 群聊 + 实时位置）
 * 
 * @swagger
 * tags:
 *   name: Chat
 *   description: 聊天系统相关接口
 */
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const logger = require('../logger');
const { getPool, getAvatarUrl, handleError, sendError, ErrorCodes, createFileFilter, secureUpload, paginate, escapeLike } = require('../utils');
const { hybridStore } = require('../middleware/rate_limit_store');
// §67: 引入 ws_service 以在成员变更后失效群成员缓存
const wsService = require('../ws_service');

module.exports = function (notificationService) {
  const router = express.Router();

const CHAT_DIR = path.join(__dirname, '..', '..', 'uploads', 'chat');
if (!fs.existsSync(CHAT_DIR)) fs.mkdirSync(CHAT_DIR, { recursive: true });

const chatStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, CHAT_DIR),
  filename: (req, file, cb) => {
    const uid = req.session?.userId || '0';
    const ext = path.extname(file.originalname) || '.bin';
    const crypto = require('crypto');
    cb(null, `chat_${uid}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`);
  }
});

const chatUpload = multer({
  storage: chatStorage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: createFileFilter(['IMAGE', 'VIDEO', 'AUDIO'])
});

// 聊天系统额外检查：游客不能聊天
function requireChatAuth(req, res, next) {
  if (!req.session.userId) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, '未登录');
  if (req.session.userId === 0) return sendError(res, 403, ErrorCodes.FORBIDDEN, '游客不能聊天');
  next();
}

// 头像辅助
function getAvatar(u) {
  return getAvatarUrl(u) || '/api/avatar/default';
}

// ==================== 私信（V6.12 保留） ====================

// 获取会话列表
router.get('/conversations', requireChatAuth, async (req, res) => {
  try {
    const uid = req.session.userId;
    // P3-114：内层与最终展示一致过滤已删除私信（与 /history 口径统一）
    const [rows] = await getPool().query(`
      SELECT
        m.id, m.sender_id AS senderId, m.receiver_id AS receiverId,
        m.content, m.is_read AS isRead, m.created_at AS createdAt,
        u.display_name AS otherDisplayName,
        u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url
      FROM messages m
      INNER JOIN (
        SELECT CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END AS other_id, MAX(id) AS max_id
        FROM messages WHERE (sender_id = ? OR receiver_id = ?) AND deleted_at IS NULL GROUP BY other_id
      ) latest ON m.id = latest.max_id
      LEFT JOIN users u ON u.id = latest.other_id
      WHERE m.deleted_at IS NULL
      ORDER BY m.created_at DESC
    `, [uid, uid, uid]);
    const [unreads] = await getPool().query(
      `SELECT sender_id, COUNT(*) AS cnt FROM messages WHERE receiver_id = ? AND is_read = 0 AND deleted_at IS NULL GROUP BY sender_id`, [uid]
    );
    const unreadMap = {};
    unreads.forEach(r => { unreadMap[r.sender_id] = r.cnt; });
    const conversations = rows.map(r => ({
      userId: r.senderId === uid ? r.receiverId : r.senderId,
      displayName: r.otherDisplayName || '已注销',
      avatarUrl: getAvatar(r),
      lastMessage: r.content,
      lastTime: r.createdAt,
      unreadCount: unreadMap[r.senderId === uid ? r.receiverId : r.senderId] || 0
    }));
    res.json({ conversations });
  } catch (e) { handleError(res, e, '[chat/conversations]'); }
});

// 获取私信历史（支持分页）
router.get('/history/:userId', requireChatAuth, async (req, res) => {
  try {
    const uid = req.session.userId;
    const otherId = parseInt(req.params.userId);
    if (isNaN(otherId)) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
    const { page, pageSize, offset } = paginate(req, { defaultSize: 50, maxSize: 100 });
    const [rows] = await getPool().query(
      `SELECT id, sender_id AS senderId, receiver_id AS receiverId, content, media_url AS mediaUrl, media_type AS mediaType, file_size AS fileSize, is_read AS isRead, created_at AS createdAt
       FROM messages WHERE deleted_at IS NULL AND ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))
       ORDER BY created_at ASC LIMIT ? OFFSET ?`,
      [uid, otherId, otherId, uid, pageSize, offset]);
    const [count] = await getPool().query(
      `SELECT COUNT(*) AS total FROM messages WHERE deleted_at IS NULL AND ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))`,
      [uid, otherId, otherId, uid]);
    res.json({ messages: rows, total: count[0].total, page, pageSize });
  } catch (e) { handleError(res, e, '[chat/history]'); }
});

// 发送私信（支持文字和媒体）
router.post('/send', requireChatAuth, secureUpload(chatUpload.single('file')), async (req, res) => {
  try {
    const uid = req.session.userId;
    const { receiverId, content } = req.body;
    const rId = parseInt(receiverId);
    // §65: 修复校验优先级错误。原 (content && !content.trim()) && !req.file 在 content 为空时短路为 falsy，导致空消息入库
    if (!receiverId || (!content?.trim() && !req.file)) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数不完整');
    const trimmed = content ? content.trim().slice(0, 2000) : '';
    const [user] = await getPool().query(`SELECT id FROM users WHERE id = ? AND deleted_at IS NULL`, [rId]);
    if (user.length === 0) return sendError(res, 404, ErrorCodes.NOT_FOUND, '用户不存在');
    // IDOR-6: 对方已拉黑我 → 拒绝发信（blocked 单向优先，见 friends.js 约定）
    const [blocked] = await getPool().query(
      `SELECT 1 FROM user_friends WHERE user_id = ? AND friend_id = ? AND status = 'blocked' LIMIT 1`,
      [rId, uid]
    );
    if (blocked.length) return sendError(res, 403, ErrorCodes.FORBIDDEN, '对方已拉黑你，无法发送消息');
    
    let mediaUrl = null, mediaType = null, fileSize = null;
    if (req.file) {
      mediaUrl = `/uploads/chat/${req.file.filename}`;
      const ext = path.extname(req.file.originalname).toLowerCase();
      const mime = (req.file.mimetype || '').toLowerCase();
      // §RTC 优先按 MIME 判定：audio/webm 按住说话录音不得被 vidExts 的 .webm 误判为视频
      if (mime.startsWith('image/')) mediaType = 'image';
      else if (mime.startsWith('audio/')) mediaType = 'audio';
      else if (mime.startsWith('video/')) mediaType = 'video';
      else {
        const imgExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
        const vidExts = ['.mp4', '.mov', '.webm', '.avi', '.mkv'];
        if (imgExts.includes(ext)) mediaType = 'image';
        else if (vidExts.includes(ext)) mediaType = 'video';
        else mediaType = 'audio';
      }
      fileSize = req.file.size;
    }
    
    const [result] = await getPool().query(
      `INSERT INTO messages (sender_id, receiver_id, content, media_url, media_type, file_size) VALUES (?, ?, ?, ?, ?, ?)`,
      [uid, rId, trimmed, mediaUrl, mediaType, fileSize]);
    const msg = { id: result.insertId, senderId: uid, receiverId: rId, content: trimmed, mediaUrl, mediaType, fileSize, isRead: 0, createdAt: new Date().toISOString() };
    if (notificationService) {
      const [sender] = await getPool().query(`SELECT display_name FROM users WHERE id = ?`, [uid]);
      const senderName = sender[0]?.display_name || '用户';
      const notifyContent = mediaType ? `${senderName} 发送了${mediaType === 'image' ? '图片' : mediaType === 'video' ? '视频' : '语音'}` : `${senderName}: ${trimmed.substring(0, 50)}`;
      notificationService.notifyUser(rId, 'chat', '💬 新消息', notifyContent, { targetType: 'chat', targetId: uid });
    }
    // HTTP 路径（图片/媒体必走此处）实时下发：此前只发通知，对端在线也要刷新才能看到。
    // 自发自收场景由前端 chat:new 分支的 senderId 判等过滤，不会重复渲染。
    wsService.broadcastToUser(rId, { type: 'chat:new', message: msg });
    res.json({ ok: true, message: msg });
  } catch (e) { handleError(res, e, '[chat/send]'); }
});

// 标记已读
router.post('/read/:userId', requireChatAuth, async (req, res) => {
  try {
    await getPool().query(
      `UPDATE messages SET is_read = 1, read_at = NOW() WHERE sender_id = ? AND receiver_id = ? AND is_read = 0`,
      [parseInt(req.params.userId), req.session.userId]);
    res.json({ ok: true });
  } catch (e) { handleError(res, e, '[chat/read]'); }
});

// ==================== 群聊系统 V6.13 ====================

// 创建群聊
router.post('/groups', requireChatAuth, async (req, res) => {
  try {
    const uid = req.session.userId;
    const { name, memberIds, isPublic, inviteCode } = req.body;
    if (!name || !name.trim()) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '群聊名称不能为空');
    const groupName = name.trim().slice(0, 50);
    // §P1-6: 支持私密群。默认公开，仅当显式 isPublic===false 时创建私密群并分配邀请码
    const isPublicBool = (isPublic === false || isPublic === 'false') ? 0 : 1;
    let inviteCodeVal = null;
    if (isPublicBool === 0) {
      if (inviteCode && typeof inviteCode === 'string' && /^[A-Za-z0-9]{4,32}$/.test(inviteCode)) {
        inviteCodeVal = inviteCode;
      } else {
        // 自动生成 8 位邀请码（base64 去符号后取前 8 位，大写）
        inviteCodeVal = crypto.randomBytes(6).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase();
      }
    }
    const conn = await getPool().getConnection();
    try {
      await conn.beginTransaction();
      const [grp] = await conn.query(
        `INSERT INTO chat_groups (name, creator_id, is_public, invite_code) VALUES (?, ?, ?, ?)`,
        [groupName, uid, isPublicBool, inviteCodeVal]);
      // 创建者自动加入
      await conn.query(
        `INSERT IGNORE INTO chat_group_members (group_id, user_id) VALUES (?, ?)`, [grp.insertId, uid]);
      // 添加其他成员（先校验 memberIds 均为存在的用户，过滤无效 id，避免 INSERT IGNORE 静默丢弃难排查）
      let invalidMemberIds = [];
      if (memberIds && Array.isArray(memberIds) && memberIds.length) {
        const validInts = [];
        for (const mid of memberIds) {
          const midInt = parseInt(mid);
          if (midInt && midInt !== uid) validInts.push(midInt);
        }
        if (validInts.length) {
          const [existRows] = await conn.query(
            `SELECT id FROM users WHERE id IN (?)`, [validInts]);
          const existing = new Set(existRows.map(r => r.id));
          const toAdd = validInts.filter(id => existing.has(id));
          invalidMemberIds = validInts.filter(id => !existing.has(id));
          for (const id of toAdd) {
            await conn.query(
              `INSERT IGNORE INTO chat_group_members (group_id, user_id) VALUES (?, ?)`, [grp.insertId, id]);
          }
        }
      }
      await conn.commit();
      const resp = { ok: true, groupId: grp.insertId, name: groupName, isPublic: !!isPublicBool };
      if (isPublicBool === 0) resp.inviteCode = inviteCodeVal;
      if (invalidMemberIds.length) resp.invalidMemberIds = invalidMemberIds;
      res.json(resp);
    } catch (e2) { await conn.rollback(); throw e2; } finally { conn.release(); }
  } catch (e) { handleError(res, e, '[chat/groups-create]'); }
});

// 获取我的群聊列表
router.get('/groups', requireChatAuth, async (req, res) => {
  try {
    const uid = req.session.userId;
    const [rows] = await getPool().query(`
      SELECT g.id, g.name, g.creator_id AS creatorId, g.created_at AS createdAt,
             (SELECT COUNT(*) FROM chat_group_members WHERE group_id = g.id) AS memberCount,
             (SELECT content FROM chat_group_messages WHERE group_id = g.id AND deleted_at IS NULL ORDER BY id DESC LIMIT 1) AS lastMessage,
             (SELECT created_at FROM chat_group_messages WHERE group_id = g.id AND deleted_at IS NULL ORDER BY id DESC LIMIT 1) AS lastTime
      FROM chat_groups g
      JOIN chat_group_members gm ON gm.group_id = g.id
      WHERE gm.user_id = ?
      ORDER BY lastTime DESC, g.created_at DESC
    `, [uid]);
    res.json({ groups: rows });
  } catch (e) { handleError(res, e, '[chat/groups-list]'); }
});

// 获取群聊详情（含成员列表）
router.get('/groups/:groupId', requireChatAuth, async (req, res) => {
  try {
    const gid = parseInt(req.params.groupId);
    const uid = req.session.userId;
    // 检查成员
    const [memCheck] = await getPool().query(
      `SELECT id FROM chat_group_members WHERE group_id = ? AND user_id = ?`, [gid, uid]);
    if (memCheck.length === 0) return sendError(res, 403, ErrorCodes.FORBIDDEN, '你不是该群成员');
    const [groupInfo] = await getPool().query(
      `SELECT id, name, creator_id AS creatorId, is_public, invite_code, created_at AS createdAt FROM chat_groups WHERE id = ?`, [gid]);
    if (groupInfo.length === 0) return sendError(res, 404, ErrorCodes.NOT_FOUND, '群聊不存在');
    const g = groupInfo[0];
    const group = {
      id: g.id, name: g.name, creatorId: g.creatorId, createdAt: g.createdAt,
      isPublic: g.is_public === null ? true : !!g.is_public
    };
    // 邀请码仅返回给群主，避免泄露私密群入口（SQL 已别名 creatorId，勿再读 creator_id）
    if (g.creatorId === uid && g.invite_code) group.inviteCode = g.invite_code;
    const [members] = await getPool().query(`
      SELECT u.id, u.display_name AS displayName, u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url
      FROM chat_group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ?`, [gid]);
    res.json({ group, members: members.map(m => ({ id: m.id, displayName: m.displayName, avatarUrl: getAvatar(m) })) });
  } catch (e) { handleError(res, e, '[chat/groups-detail]'); }
});

// §P1-6: 群主修改群隐私设置（公开/私密切换）与邀请码管理（仅群主）
router.patch('/groups/:groupId', requireChatAuth, async (req, res) => {
  try {
    const gid = parseInt(req.params.groupId);
    const uid = req.session.userId;
    if (!Number.isInteger(gid) || gid <= 0) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '无效的群组ID');
    const [rows] = await getPool().query(`SELECT id, creator_id, is_public, invite_code FROM chat_groups WHERE id = ?`, [gid]);
    if (rows.length === 0) return sendError(res, 404, ErrorCodes.NOT_FOUND, '群聊不存在');
    const grp = rows[0];
    if (grp.creator_id !== uid) return sendError(res, 403, ErrorCodes.FORBIDDEN, '只有群主可以修改群设置');
    const body = req.body || {};
    const updates = [];
    const params = [];
    let newCode = null;
    let isPublicBool = null;
    if (body.isPublic !== undefined) {
      isPublicBool = (body.isPublic === false || body.isPublic === 'false') ? 0 : 1;
      updates.push('is_public = ?'); params.push(isPublicBool);
      if (isPublicBool === 1) {
        updates.push('invite_code = NULL'); // 转公开清空邀请码
      } else if (!grp.invite_code) {
        newCode = crypto.randomBytes(6).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase();
        updates.push('invite_code = ?'); params.push(newCode);
      }
    }
    // 重新生成邀请码 或 显式设置邀请码（需为私密群）
    const wantRegen = body.regenerateCode === true || body.regenerateCode === 'true';
    const setCode = (typeof body.inviteCode === 'string' && /^[A-Za-z0-9]{4,32}$/.test(body.inviteCode)) ? body.inviteCode : null;
    if (wantRegen || setCode) {
      if (isPublicBool === null) { updates.push('is_public = ?'); params.push(0); } // 有邀请码即视为私密
      newCode = wantRegen
        ? crypto.randomBytes(6).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase()
        : setCode;
      updates.push('invite_code = ?'); params.push(newCode);
    }
    if (updates.length === 0) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '没有需要更新的内容');
    await getPool().query(`UPDATE chat_groups SET ${updates.join(', ')} WHERE id = ?`, [...params, gid]);
    const resp = { ok: true };
    if (newCode) resp.inviteCode = newCode;
    res.json(resp);
  } catch (e) { handleError(res, e, '[chat/groups-update]'); }
});

// §66: 加入群聊速率限制，防止批量枚举 groupId 遍历加入全部群
const joinGroupLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: hybridStore('chat-join-group'),
  message: { ok: false, error: '操作过于频繁，请稍后再试' }
});

// 加入群聊
router.post('/groups/:groupId/join', requireChatAuth, joinGroupLimiter, async (req, res) => {
  try {
    const gid = parseInt(req.params.groupId);
    const uid = req.session.userId;
    // §66: 校验群存在性，防止 IDOR 枚举加入任意群
    const [group] = await getPool().query(`SELECT id, is_public, invite_code FROM chat_groups WHERE id = ?`, [gid]);
    if (group.length === 0) return sendError(res, 404, ErrorCodes.NOT_FOUND, '群聊不存在');
    // 已是成员直接返回成功（幂等）
    const [memCheck] = await getPool().query(`SELECT id FROM chat_group_members WHERE group_id = ? AND user_id = ?`, [gid, uid]);
    if (memCheck.length > 0) return res.json({ ok: true });
    // §66: 非公开群要求邀请码匹配；公开群（is_public=1 或字段为 NULL 兼容旧库）允许直接加入
    const grp = group[0];
    const isPublic = grp.is_public === undefined || grp.is_public === null || grp.is_public === 1;
    if (!isPublic) {
      const code = req.body && req.body.inviteCode ? String(req.body.inviteCode) : (req.query.inviteCode ? String(req.query.inviteCode) : '');
      if (!code || !grp.invite_code || code !== grp.invite_code) {
        return sendError(res, 403, ErrorCodes.FORBIDDEN, '该群为私密群，需有效邀请码才能加入');
      }
    }
    await getPool().query(`INSERT IGNORE INTO chat_group_members (group_id, user_id) VALUES (?, ?)`, [gid, uid]);
    // §67: 成员变更后失效群成员缓存，避免新成员延迟 60s 才收到消息
    wsService.invalidateGroupMemberCache(gid);
    res.json({ ok: true });
  } catch (e) { handleError(res, e, '[chat/groups-join]'); }
});

// §P1-6: 凭邀请码加入私密群（无需先知道 groupId）
router.post('/groups/join-by-code', requireChatAuth, joinGroupLimiter, async (req, res) => {
  try {
    const uid = req.session.userId;
    const code = req.body && req.body.inviteCode ? String(req.body.inviteCode).trim().toUpperCase() : '';
    if (!code) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请输入邀请码');
    const [groups] = await getPool().query(
      `SELECT id, name, is_public, invite_code FROM chat_groups WHERE invite_code = ?`, [code]);
    if (groups.length === 0) return sendError(res, 404, ErrorCodes.NOT_FOUND, '邀请码无效或群聊不存在');
    const grp = groups[0];
    // 已是成员直接返回（幂等）
    const [memCheck] = await getPool().query(`SELECT id FROM chat_group_members WHERE group_id = ? AND user_id = ?`, [grp.id, uid]);
    if (memCheck.length > 0) return res.json({ ok: true, groupId: grp.id, name: grp.name });
    await getPool().query(`INSERT IGNORE INTO chat_group_members (group_id, user_id) VALUES (?, ?)`, [grp.id, uid]);
    // §67: 成员变更后失效群成员缓存
    wsService.invalidateGroupMemberCache(grp.id);
    res.json({ ok: true, groupId: grp.id, name: grp.name });
  } catch (e) { handleError(res, e, '[chat/groups-join-by-code]'); }
});

// 获取群消息（支持分页）
router.get('/groups/:groupId/messages', requireChatAuth, async (req, res) => {
  try {
    const gid = parseInt(req.params.groupId);
    if (!Number.isInteger(gid) || gid <= 0) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '无效的群组ID');
    }
    const uid = req.session.userId;
    const [memCheck] = await getPool().query(
      `SELECT id FROM chat_group_members WHERE group_id = ? AND user_id = ?`, [gid, uid]);
    if (memCheck.length === 0) return sendError(res, 403, ErrorCodes.FORBIDDEN, '你不是该群成员');
    const { page, pageSize, offset } = paginate(req, { defaultSize: 50, maxSize: 100 });
    const [rows] = await getPool().query(`
      SELECT m.id, m.sender_id AS senderId, m.content, m.msg_type AS msgType, m.media_url AS mediaUrl, m.media_type AS mediaType, m.file_size AS fileSize,
             m.lat, m.lng, m.created_at AS createdAt,
             u.display_name AS senderName, u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url,
             r.read_at IS NOT NULL AS isRead
      FROM chat_group_messages m
      LEFT JOIN users u ON u.id = m.sender_id
      LEFT JOIN chat_group_message_reads r ON r.group_id = m.group_id AND r.message_id = m.id AND r.user_id = ?
      WHERE m.deleted_at IS NULL AND m.group_id = ?
      ORDER BY m.created_at ASC LIMIT ? OFFSET ?`, [uid, gid, pageSize, offset]);
    const [count] = await getPool().query(`SELECT COUNT(*) AS total FROM chat_group_messages WHERE deleted_at IS NULL AND group_id = ?`, [gid]);
    res.json({ messages: rows.map(r => ({ ...r, senderAvatar: getAvatar(r) })), total: count[0].total, page, pageSize });
  } catch (e) { handleError(res, e, '[chat/group-messages]'); }
});

// 发送群消息（支持文字和媒体）
router.post('/groups/:groupId/messages', requireChatAuth, secureUpload(chatUpload.single('file')), async (req, res) => {
  try {
    const gid = parseInt(req.params.groupId);
    if (!Number.isInteger(gid) || gid <= 0) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '无效的群组ID');
    }
    const uid = req.session.userId;
    const { content, msgType, lat, lng } = req.body;
    const [memCheck] = await getPool().query(
      `SELECT id FROM chat_group_members WHERE group_id = ? AND user_id = ?`, [gid, uid]);
    if (memCheck.length === 0) return sendError(res, 403, ErrorCodes.FORBIDDEN, '你不是该群成员');
    // 白名单校验消息类型，防止注入非预期类型值
    const ALLOWED_MSG_TYPES = ['text', 'image', 'video', 'audio', 'location'];
    const safeMsgType = ALLOWED_MSG_TYPES.includes(msgType) ? msgType : 'text';
    let safeLat = null, safeLng = null;
    if (safeMsgType === 'location') {
      safeLat = (lat !== undefined && lat !== null && lat !== '') ? parseFloat(lat) : null;
      safeLng = (lng !== undefined && lng !== null && lng !== '') ? parseFloat(lng) : null;
      if (safeLat === null || safeLng === null || isNaN(safeLat) || isNaN(safeLng)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '位置消息缺少有效坐标');
      }
    }
    const trimmed = content ? content.trim().slice(0, 2000) : '';
    
    let mediaUrl = null, mediaType = null, fileSize = null;
    if (req.file) {
      mediaUrl = `/uploads/chat/${req.file.filename}`;
      const ext = path.extname(req.file.originalname).toLowerCase();
      const mime = (req.file.mimetype || '').toLowerCase();
      // §RTC 优先按 MIME 判定：audio/webm 按住说话录音不得被 vidExts 的 .webm 误判为视频
      if (mime.startsWith('image/')) mediaType = 'image';
      else if (mime.startsWith('audio/')) mediaType = 'audio';
      else if (mime.startsWith('video/')) mediaType = 'video';
      else {
        const imgExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
        const vidExts = ['.mp4', '.mov', '.webm', '.avi', '.mkv'];
        if (imgExts.includes(ext)) mediaType = 'image';
        else if (vidExts.includes(ext)) mediaType = 'video';
        else mediaType = 'audio';
      }
      fileSize = req.file.size;
    }
    
    if (!trimmed && !mediaUrl && safeMsgType !== 'location') return sendError(res, 400, ErrorCodes.BAD_REQUEST, '消息不能为空');
    const [result] = await getPool().query(
      `INSERT INTO chat_group_messages (group_id, sender_id, content, msg_type, lat, lng, media_url, media_type, file_size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [gid, uid, trimmed, safeMsgType, safeLat, safeLng, mediaUrl, mediaType, fileSize]);
    const [senderRow] = await getPool().query(`SELECT display_name FROM users WHERE id = ?`, [uid]);
    const senderName = senderRow[0]?.display_name || '用户';
    if (notificationService) {
      const [group] = await getPool().query(`SELECT name FROM chat_groups WHERE id = ?`, [gid]);
      const groupName = group[0]?.name || '群聊';
      const notifyContent = mediaType ? `${senderName} 发送了${mediaType === 'image' ? '图片' : mediaType === 'video' ? '视频' : '语音'}` : trimmed.substring(0, 50);
      const [members] = await getPool().query(`SELECT user_id FROM chat_group_members WHERE group_id = ? AND user_id != ?`, [gid, uid]);
      for (const member of members) {
        notificationService.notifyUser(
          member.user_id,
          'chat',
          `💬 ${groupName}: ${senderName}`,
          notifyContent,
          { targetType: 'group', targetId: gid }
        );
      }
    }
    // 返回完整消息对象（字段与 GET /groups/:id/messages 对齐），供 HTTP 兜底路径前端直接渲染
    const message = {
      id: result.insertId,
      groupId: gid,
      senderId: uid,
      senderName,
      content: trimmed,
      msgType: safeMsgType,
      lat: safeLat,
      lng: safeLng,
      mediaUrl,
      mediaType,
      fileSize,
      createdAt: new Date().toISOString()
    };
    // HTTP 路径实时下发群消息（图片必走此处）：排除发送者避免与本地回显重复，
    // 走 tier 版广播以复用离线汇总与成员缓存，与 WS handleGroupChat 行为对齐
    wsService.broadcastToGroupWithTier(gid, { type: 'group:new', groupId: gid, message }, uid)
      .catch(() => {});
    res.json({ ok: true, messageId: result.insertId, message });
  } catch (e) { handleError(res, e, '[chat/group-send]'); }
});

// 退出群聊
router.post('/groups/:groupId/leave', requireChatAuth, async (req, res) => {
  try {
    const gid = parseInt(req.params.groupId);
    const uid = req.session.userId;
    const [groupInfo] = await getPool().query(`SELECT creator_id FROM chat_groups WHERE id = ?`, [gid]);
    if (groupInfo.length === 0) return sendError(res, 404, ErrorCodes.NOT_FOUND, '群聊不存在');
    if (groupInfo[0].creator_id === uid) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '群主不能退出群聊，请先转让群主');
    }
    const [memCheck] = await getPool().query(
      `SELECT id FROM chat_group_members WHERE group_id = ? AND user_id = ?`, [gid, uid]);
    if (memCheck.length === 0) return sendError(res, 403, ErrorCodes.FORBIDDEN, '你不是该群成员');
    await getPool().query(`DELETE FROM chat_group_members WHERE group_id = ? AND user_id = ?`, [gid, uid]);
    // §67: 退群后失效群成员缓存，避免被踢/退群用户 60s 内仍能收到群广播
    wsService.invalidateGroupMemberCache(gid);
    res.json({ ok: true, message: '已退出群聊' });
  } catch (e) { handleError(res, e, '[chat/groups-leave]'); }
});

// 解散群聊（仅群主）：物理删除群及全部关联数据，并向成员广播解散通知
router.delete('/groups/:groupId', requireChatAuth, async (req, res) => {
  try {
    const gid = parseInt(req.params.groupId);
    const uid = req.session.userId;
    if (!Number.isInteger(gid) || gid <= 0) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '无效的群组ID');
    const [groupInfo] = await getPool().query(`SELECT id, name, creator_id FROM chat_groups WHERE id = ?`, [gid]);
    if (groupInfo.length === 0) return sendError(res, 404, ErrorCodes.NOT_FOUND, '群聊不存在');
    if (groupInfo[0].creator_id !== uid) return sendError(res, 403, ErrorCodes.FORBIDDEN, '仅群主可以解散群聊');
    // 先广播解散通知（依赖成员列表，必须在删除成员前发送），再物理清理数据
    wsService.broadcastToGroup(gid, { type: 'group:dissolved', groupId: gid, name: groupInfo[0].name });
    const conn = await getPool().getConnection();
    try {
      await conn.beginTransaction();
      // 显式逐表清理，避免依赖延迟外键级联造成脏数据
      await conn.query(`DELETE FROM chat_group_message_reads WHERE group_id = ?`, [gid]);
      await conn.query(`DELETE FROM chat_group_messages WHERE group_id = ?`, [gid]);
      await conn.query(`DELETE FROM chat_group_members WHERE group_id = ?`, [gid]);
      await conn.query(`DELETE FROM chat_groups WHERE id = ?`, [gid]);
      await conn.commit();
    } catch (e2) { await conn.rollback(); throw e2; } finally { conn.release(); }
    // §67: 群已删除，失效群成员缓存避免残留
    wsService.invalidateGroupMemberCache(gid);
    res.json({ ok: true, message: '群聊已解散' });
  } catch (e) { handleError(res, e, '[chat/groups-dissolve]'); }
});

// 获取群管理员列表
router.get('/groups/:groupId/admins', requireChatAuth, async (req, res) => {
  try {
    const gid = parseInt(req.params.groupId);
    const uid = req.session.userId;
    const [memCheck] = await getPool().query(
      `SELECT id FROM chat_group_members WHERE group_id = ? AND user_id = ?`, [gid, uid]);
    if (memCheck.length === 0) return sendError(res, 403, ErrorCodes.FORBIDDEN, '你不是该群成员');
    const [group] = await getPool().query(`SELECT id, name, creator_id AS creatorId FROM chat_groups WHERE id = ?`, [gid]);
    if (group.length === 0) return sendError(res, 404, ErrorCodes.NOT_FOUND, '群聊不存在');
    const [admins] = await getPool().query(`
      SELECT u.id, u.display_name AS displayName, u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url
      FROM chat_group_members gm JOIN users u ON u.id = gm.user_id
      WHERE gm.group_id = ? AND (gm.is_admin = 1 OR gm.user_id = ?)`, [gid, group[0].creatorId]);
    res.json({ admins: admins.map(a => ({ id: a.id, displayName: a.displayName, avatarUrl: getAvatar(a) })) });
  } catch (e) { handleError(res, e, '[chat/groups-admins]'); }
});

// 添加群管理员
router.post('/groups/:groupId/admins', requireChatAuth, async (req, res) => {
  try {
    const gid = parseInt(req.params.groupId);
    const uid = req.session.userId;
    const { userId } = req.body;
    const targetId = parseInt(userId);
    if (!targetId) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
    const [group] = await getPool().query(`SELECT creator_id FROM chat_groups WHERE id = ?`, [gid]);
    if (group.length === 0) return sendError(res, 404, ErrorCodes.NOT_FOUND, '群聊不存在');
    if (group[0].creator_id !== uid) return sendError(res, 403, ErrorCodes.FORBIDDEN, '仅群主可以添加管理员');
    if (targetId === uid) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '群主已是管理员');
    const [memCheck] = await getPool().query(
      `SELECT id FROM chat_group_members WHERE group_id = ? AND user_id = ?`, [gid, targetId]);
    if (memCheck.length === 0) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '用户不是群成员');
    await getPool().query(`UPDATE chat_group_members SET is_admin = 1 WHERE group_id = ? AND user_id = ?`, [gid, targetId]);
    res.json({ ok: true, message: '已添加管理员' });
  } catch (e) { handleError(res, e, '[chat/groups-add-admin]'); }
});

// 移除群管理员
router.delete('/groups/:groupId/admins/:userId', requireChatAuth, async (req, res) => {
  try {
    const gid = parseInt(req.params.groupId);
    const uid = req.session.userId;
    const targetId = parseInt(req.params.userId);
    if (!targetId) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
    const [group] = await getPool().query(`SELECT creator_id FROM chat_groups WHERE id = ?`, [gid]);
    if (group.length === 0) return sendError(res, 404, ErrorCodes.NOT_FOUND, '群聊不存在');
    if (group[0].creator_id !== uid) return sendError(res, 403, ErrorCodes.FORBIDDEN, '仅群主可以移除管理员');
    if (targetId === uid) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '不能移除群主');
    await getPool().query(`UPDATE chat_group_members SET is_admin = 0 WHERE group_id = ? AND user_id = ?`, [gid, targetId]);
    res.json({ ok: true, message: '已移除管理员' });
  } catch (e) { handleError(res, e, '[chat/groups-remove-admin]'); }
});

// 踢人出群
router.post('/groups/:groupId/kick', requireChatAuth, async (req, res) => {
  try {
    const gid = parseInt(req.params.groupId);
    const uid = req.session.userId;
    const { userId } = req.body;
    const targetId = parseInt(userId);
    if (!targetId) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
    const [group] = await getPool().query(`SELECT creator_id FROM chat_groups WHERE id = ?`, [gid]);
    if (group.length === 0) return sendError(res, 404, ErrorCodes.NOT_FOUND, '群聊不存在');
    const [myRole] = await getPool().query(`SELECT is_admin FROM chat_group_members WHERE group_id = ? AND user_id = ?`, [gid, uid]);
    const isAdmin = myRole.length > 0 && myRole[0].is_admin === 1;
    if (group[0].creator_id !== uid && !isAdmin) return sendError(res, 403, ErrorCodes.FORBIDDEN, '仅群主和管理员可以踢人');
    if (targetId === uid) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '不能踢出自己');
    // P3-116：群主通常 is_admin=0，原守卫只拦「目标为管理员」导致可被普通管理员踢出；
    // 明确禁止踢群主本人（群主必须先转让才能被移除），与 leave 接口禁止群主退群的语义一致
    if (targetId === group[0].creator_id) return sendError(res, 403, ErrorCodes.FORBIDDEN, '不能踢出群主');
    const [targetRole] = await getPool().query(`SELECT is_admin FROM chat_group_members WHERE group_id = ? AND user_id = ?`, [gid, targetId]);
    const isTargetAdmin = targetRole.length > 0 && targetRole[0].is_admin === 1;
    if (isTargetAdmin && group[0].creator_id !== uid) return sendError(res, 403, ErrorCodes.FORBIDDEN, '仅群主可以踢出管理员');
    await getPool().query(`DELETE FROM chat_group_members WHERE group_id = ? AND user_id = ?`, [gid, targetId]);
    // §67: 踢人后失效群成员缓存，避免被踢用户 60s 内仍能收到群广播
    wsService.invalidateGroupMemberCache(gid);
    res.json({ ok: true, message: '已踢出群聊' });
  } catch (e) { handleError(res, e, '[chat/groups-kick]'); }
});




// 未读消息数（必须在 /messages/:id 之前，否则被吞噬）
router.get('/unread-count', requireChatAuth, async (req, res) => {
    try {
      const uid = req.session.userId;
      const [pmCount] = await getPool().query(
        `SELECT COUNT(*) AS count FROM messages WHERE receiver_id = ? AND is_read = 0`, [uid]);
      const [groupCounts] = await getPool().query(`
        SELECT m.group_id, COUNT(*) AS count
        FROM chat_group_messages m
        LEFT JOIN chat_group_message_reads r ON r.group_id = m.group_id AND r.message_id = m.id AND r.user_id = ?
        LEFT JOIN chat_group_members gm ON gm.group_id = m.group_id AND gm.user_id = ?
        WHERE gm.id IS NOT NULL AND r.read_at IS NULL AND m.sender_id <> ? AND m.created_at >= gm.joined_at
        GROUP BY m.group_id`, [uid, uid, uid]);
      // P3-115：排除本人发送的消息 + 入群前历史消息（m.sender_id<>? / m.created_at>=gm.joined_at），避免未读红点虚高
      const totalUnread = pmCount[0].count + groupCounts.reduce((sum, g) => sum + g.count, 0);
      res.json({
        total: totalUnread,
        privateMessages: pmCount[0].count,
        groups: groupCounts.map(g => ({ groupId: g.group_id, count: g.count }))
      });
    } catch (e) { handleError(res, e, '[chat/unread-count]'); }
  });

// 聊天搜索（必须在 /messages/:id 之前，否则被吞噬）
router.get('/search', requireChatAuth, async (req, res) => {
    try {
      const uid = req.session.userId;
      const keyword = (req.query.keyword || '').trim();
      const scope = (req.query.scope || 'all').toLowerCase();
      if (!keyword || keyword.length < 2) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '搜索关键词至少需要2个字符');
      }
      if (keyword.length > 100) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '搜索关键词不能超过100个字符');
      }
      const { pageSize, offset } = paginate(req, { defaultSize: 20, maxSize: 50 });
      const likeKeyword = `%${escapeLike(keyword)}%`;
      const results = { privateMessages: [], groupMessages: [], privateMessagesTotal: 0, groupMessagesTotal: 0 };
      if (scope === 'all' || scope === 'private') {
        const [pmCount] = await getPool().query(`
          SELECT COUNT(*) AS total FROM messages m
          WHERE (m.sender_id = ? OR m.receiver_id = ?) AND m.content LIKE ? ESCAPE '!' AND m.deleted_at IS NULL`, [uid, uid, likeKeyword]);
        results.privateMessagesTotal = pmCount[0].total;
        const [pmRows] = await getPool().query(`
          SELECT m.id, m.sender_id AS senderId, m.receiver_id AS receiverId, m.content, m.is_read AS isRead, m.created_at AS createdAt,
                 u.display_name AS senderName, u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url
          FROM messages m
          LEFT JOIN users u ON u.id = m.sender_id
          WHERE (m.sender_id = ? OR m.receiver_id = ?) AND m.content LIKE ? ESCAPE '!' AND m.deleted_at IS NULL
          ORDER BY m.created_at DESC LIMIT ? OFFSET ?`, [uid, uid, likeKeyword, pageSize, offset]);
        results.privateMessages = pmRows.map(r => ({ ...r, senderAvatar: getAvatar(r) }));
      }
      if (scope === 'all' || scope === 'group') {
        const [gmCount] = await getPool().query(`
          SELECT COUNT(*) AS total FROM chat_group_messages m
          LEFT JOIN chat_group_members gm ON gm.group_id = m.group_id AND gm.user_id = ?
          WHERE gm.id IS NOT NULL AND m.content LIKE ? ESCAPE '!' AND m.deleted_at IS NULL`, [uid, likeKeyword]);
        results.groupMessagesTotal = gmCount[0].total;
        const [gmRows] = await getPool().query(`
          SELECT m.id, m.group_id AS groupId, m.sender_id AS senderId, m.content, m.created_at AS createdAt,
                 u.display_name AS senderName, u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url,
                 g.name AS groupName
          FROM chat_group_messages m
          LEFT JOIN users u ON u.id = m.sender_id
          LEFT JOIN chat_groups g ON g.id = m.group_id
          LEFT JOIN chat_group_members gm ON gm.group_id = m.group_id AND gm.user_id = ?
          WHERE gm.id IS NOT NULL AND m.content LIKE ? ESCAPE '!' AND m.deleted_at IS NULL
          ORDER BY m.created_at DESC LIMIT ? OFFSET ?`, [uid, likeKeyword, pageSize, offset]);
        results.groupMessages = gmRows.map(r => ({ ...r, senderAvatar: getAvatar(r) }));
      }
      res.json(results);
    } catch (e) { handleError(res, e, '[chat/search]'); }
  });

router.patch('/messages/read-batch', requireChatAuth, async (req, res) => {
    try {
      const uid = req.session.userId;
      const { messageIds } = req.body;
      if (!messageIds || !Array.isArray(messageIds) || messageIds.length === 0) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'messageIds不能为空');
      }
      if (messageIds.length > 100) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '单次最多更新100条消息');
      }
      const validIds = messageIds.filter(id => typeof id === 'number' && id > 0);
      if (validIds.length === 0) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '无效的messageIds');
      }
      await getPool().query(
        'UPDATE messages SET is_read = 1, read_at = NOW() WHERE receiver_id = ? AND id IN (?)',
        [uid, validIds]
      );
      res.json({ ok: true, count: validIds.length, message: `${validIds.length}条消息已标记为已读` });
    } catch (e) { handleError(res, e, '[chat/read-batch]'); }
  });



router.put('/messages/:id', requireChatAuth, async (req, res) => {
    try {
      const msgId = parseInt(req.params.id);
      const uid = req.session.userId;
      if (!msgId) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      const { content } = req.body;
      if (!content || !content.trim()) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '消息内容不能为空');
      const [msgs] = await getPool().query('SELECT sender_id, receiver_id FROM messages WHERE id = ? AND deleted_at IS NULL', [msgId]);
      if (msgs.length === 0) return sendError(res, 404, ErrorCodes.NOT_FOUND, '消息不存在');
      if (msgs[0].sender_id !== uid && msgs[0].receiver_id !== uid) return sendError(res, 403, ErrorCodes.FORBIDDEN, '只能编辑自己或收到的消息');
      await getPool().query('UPDATE messages SET content = ?, edited_at = NOW() WHERE id = ?', [content.trim(), msgId]);
      res.json({ ok: true, message: '消息已编辑' });
    } catch (e) { handleError(res, e, '[chat/edit-message]'); }
  });

router.patch('/groups/:groupId/messages/read-batch', requireChatAuth, async (req, res) => {
    try {
      const gid = parseInt(req.params.groupId);
      const uid = req.session.userId;
      const { messageIds } = req.body;
      if (!gid) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '群组ID不能为空');
      if (!messageIds || !Array.isArray(messageIds) || messageIds.length === 0) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'messageIds不能为空');
      }
      if (messageIds.length > 100) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '单次最多更新100条消息');
      }
      const [memCheck] = await getPool().query('SELECT id FROM chat_group_members WHERE group_id = ? AND user_id = ?', [gid, uid]);
      if (memCheck.length === 0) return sendError(res, 403, ErrorCodes.FORBIDDEN, '你不是该群成员');
      const validIds = messageIds.filter(id => typeof id === 'number' && id > 0);
      if (validIds.length === 0) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '无效的messageIds');
      }
      const values = validIds.map(mid => [gid, mid, uid]);
      await getPool().query(
        'INSERT IGNORE INTO chat_group_message_reads (group_id, message_id, user_id) VALUES ?',
        [values]
      );
      res.json({ ok: true, count: validIds.length, message: `${validIds.length}条群消息已标记为已读` });
    } catch (e) { handleError(res, e, '[chat/group-read-batch]'); }
  });

router.put('/groups/:groupId/messages/:msgId', requireChatAuth, async (req, res) => {
    try {
      const gid = parseInt(req.params.groupId);
      const msgId = parseInt(req.params.msgId);
      const uid = req.session.userId;
      if (!msgId) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      const { content } = req.body;
      if (!content || !content.trim()) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '消息内容不能为空');
      const [memCheck] = await getPool().query('SELECT id FROM chat_group_members WHERE group_id = ? AND user_id = ?', [gid, uid]);
      if (memCheck.length === 0) return sendError(res, 403, ErrorCodes.FORBIDDEN, '你不是该群成员');
      const [msgs] = await getPool().query('SELECT sender_id FROM chat_group_messages WHERE id = ? AND group_id = ? AND deleted_at IS NULL', [msgId, gid]);
      if (msgs.length === 0) return sendError(res, 404, ErrorCodes.NOT_FOUND, '消息不存在');
      const msgSender = msgs[0].sender_id;
      // 群主或管理员可撤回/编辑群内任意成员的不当消息，具备社区审核能力
      const [grp] = await getPool().query('SELECT creator_id FROM chat_groups WHERE id = ?', [gid]);
      const [memAdmin] = await getPool().query('SELECT is_admin FROM chat_group_members WHERE group_id = ? AND user_id = ?', [gid, uid]);
      const isCreator = grp.length > 0 && grp[0].creator_id === uid;
      const isGroupAdmin = memAdmin.length > 0 && memAdmin[0].is_admin === 1;
      if (msgSender !== uid && !isCreator && !isGroupAdmin) return sendError(res, 403, ErrorCodes.FORBIDDEN, '只能编辑自己或收到的消息');
      await getPool().query('UPDATE chat_group_messages SET content = ?, edited_at = NOW() WHERE id = ?', [content.trim(), msgId]);
      res.json({ ok: true, message: '消息已编辑' });
    } catch (e) { handleError(res, e, '[chat/edit-group-message]'); }
  });

router.delete('/messages/:id', requireChatAuth, async (req, res) => {
    try {
      const msgId = parseInt(req.params.id);
      const uid = req.session.userId;
      if (!msgId) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      const [msgs] = await getPool().query(
        'SELECT sender_id, receiver_id, TIMESTAMPDIFF(SECOND, created_at, NOW()) AS ageSec FROM messages WHERE id = ? AND deleted_at IS NULL', [msgId]);
      if (msgs.length === 0) return sendError(res, 404, ErrorCodes.NOT_FOUND, '消息不存在');
      const m = msgs[0];
      const isSender = m.sender_id === uid;
      const isReceiver = m.receiver_id === uid;
      if (!isSender && !isReceiver) return sendError(res, 403, ErrorCodes.FORBIDDEN, '只能删除自己或收到的消息');
      // 撤回语义：发送者仅可撤回10分钟内发送的消息；接收方删除仅清理消息（保留原行为）
      if (isSender && Number(m.ageSec) > 600) return sendError(res, 403, ErrorCodes.FORBIDDEN, '仅可撤回10分钟内发送的消息');
      await getPool().query('UPDATE messages SET deleted_at = NOW() WHERE id = ?', [msgId]);
      // 实时通知对端该消息已撤回（发送者撤回时通知接收方；接收方删除时通知发送方）
      const peerId = isSender ? m.receiver_id : m.sender_id;
      wsService.broadcastToUser(peerId, { type: 'chat:recalled', messageId: msgId });
      res.json({ ok: true, message: '消息已撤回' });
    } catch (e) { handleError(res, e, '[chat/delete-message]'); }
  });

router.delete('/groups/:groupId/messages/:msgId', requireChatAuth, async (req, res) => {
    try {
      const gid = parseInt(req.params.groupId);
      const msgId = parseInt(req.params.msgId);
      const uid = req.session.userId;
      if (!msgId) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      const [memCheck] = await getPool().query('SELECT id FROM chat_group_members WHERE group_id = ? AND user_id = ?', [gid, uid]);
      if (memCheck.length === 0) return sendError(res, 403, ErrorCodes.FORBIDDEN, '你不是该群成员');
      const [msgs] = await getPool().query(
        'SELECT sender_id, TIMESTAMPDIFF(SECOND, created_at, NOW()) AS ageSec FROM chat_group_messages WHERE id = ? AND group_id = ? AND deleted_at IS NULL', [msgId, gid]);
      if (msgs.length === 0) return sendError(res, 404, ErrorCodes.NOT_FOUND, '消息不存在');
      const msgSender = msgs[0].sender_id;
      // 群主或管理员可撤回/删除群内任意成员的不当消息（无时间限制）
      const [grp] = await getPool().query('SELECT creator_id FROM chat_groups WHERE id = ?', [gid]);
      const [memAdmin] = await getPool().query('SELECT is_admin FROM chat_group_members WHERE group_id = ? AND user_id = ?', [gid, uid]);
      const isCreator = grp.length > 0 && grp[0].creator_id === uid;
      const isGroupAdmin = memAdmin.length > 0 && memAdmin[0].is_admin === 1;
      if (msgSender !== uid && !isCreator && !isGroupAdmin) return sendError(res, 403, ErrorCodes.FORBIDDEN, '只能撤回自己或由群主/管理员撤回的消息');
      // 普通成员撤回自己的消息须在10分钟内；群主/管理员不受时间限制
      if (msgSender === uid && !isCreator && !isGroupAdmin && Number(msgs[0].ageSec) > 600) {
        return sendError(res, 403, ErrorCodes.FORBIDDEN, '仅可撤回10分钟内发送的消息');
      }
      await getPool().query('UPDATE chat_group_messages SET deleted_at = NOW() WHERE id = ?', [msgId]);
      // 实时通知全群成员撤回该消息（离线成员下次拉取消息列表时已排除 deleted_at，无需离线汇总）
      wsService.broadcastToGroup(gid, { type: 'group:recalled', groupId: gid, messageId: msgId, recalledBy: uid });
      res.json({ ok: true, message: '消息已撤回' });
    } catch (e) { handleError(res, e, '[chat/delete-group-message]'); }
  });


// ==================== RTC 通话信令配置（供 WebRTC 建立连接） ====================
// 返回 iceServers：TURN 在管理设置里配置（rtc_turn_urls / rtc_turn_username / rtc_turn_credential /
// rtc_turn_secret），STUN 内置兜底，未配置 TURN 时依然能用 P2P/中继退化场景。
// P2-160（R6）：凭据策略两级——
//  1) 配置 rtc_turn_secret（coturn --use-auth-secret REST 认证密钥）时，按
//     username=<expiry>:<userId> / credential=HMAC-SHA1(secret, username) 动态生成
//     短时（1 天）临时凭据，不再下发长期静态 credential，泄露面收敛为单次有效窗口；
//  2) 未配置时回退静态凭据并打警告（R6 前行为），提示管理员接入 REST 模式。
router.get('/rtc/config', requireChatAuth, async (req, res) => {
  try {
    const [rows] = await getPool().query(
      `SELECT config_key AS configKey, config_value AS configValue
       FROM system_config WHERE config_key IN ('rtc_turn_urls', 'rtc_turn_username', 'rtc_turn_credential', 'rtc_turn_secret')`
    );
    const cfg = {};
    rows.forEach(r => { cfg[r.configKey] = r.configValue; });
    const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    const turnUrls = (cfg.rtc_turn_urls || '').split(',').map(s => s.trim()).filter(Boolean);
    if (turnUrls.length) {
      const turn = { urls: turnUrls };
      if (cfg.rtc_turn_secret && cfg.rtc_turn_secret.length >= 16) {
        const TURN_REST_TTL_SEC = 24 * 60 * 60;
        const expiry = Math.floor(Date.now() / 1000) + TURN_REST_TTL_SEC;
        const username = `${expiry}:${req.session.userId}`;
        turn.username = username;
        turn.credential = crypto.createHmac('sha1', String(cfg.rtc_turn_secret)).update(username).digest('base64');
        turn.rest = true;
      } else {
        if (cfg.rtc_turn_username) turn.username = cfg.rtc_turn_username;
        if (cfg.rtc_turn_credential) turn.credential = cfg.rtc_turn_credential;
        if (!cfg.rtc_turn_secret) {
          logger.warn('chat', '[rtc/config] TURN 使用静态凭据下发——建议在系统设置配置 rtc_turn_secret 启用 coturn REST 临时凭据（--use-auth-secret）');
        }
      }
      iceServers.push(turn);
    }
    res.json({ iceServers, turnConfigured: turnUrls.length > 0 });
  } catch (e) { handleError(res, e, '[chat/rtc/config]'); }
});

return router;
};
