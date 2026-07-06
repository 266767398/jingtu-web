// ==================== 聊天系统 V6.13（私信 + 群聊 + 实时位置） ====================
const express = require('express');
const router = express.Router();
const { getPool } = require('../utils');
const { requireAuth } = require('../auth');

// 聊天系统额外检查：游客不能聊天
function requireChatAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: '未登录' });
  if (req.session.userId === 0) return res.status(403).json({ error: '游客不能聊天' });
  next();
}

// 头像辅助
function getAvatar(u) {
  if (!u) return '/api/avatar/default';
  if (u.custom_avatar_path) return '/' + u.custom_avatar_path.replace(/\\/g, '/');
  if (u.vrchat_avatar_url) return u.vrchat_avatar_url;
  return '/api/avatar/default';
}

// ==================== 私信（V6.12 保留） ====================

// 获取会话列表
router.get('/conversations', requireChatAuth, async (req, res) => {
  try {
    const uid = req.session.userId;
    const [rows] = await getPool().query(`
      SELECT
        m.id, m.sender_id AS senderId, m.receiver_id AS receiverId,
        m.content, m.is_read AS isRead, m.created_at AS createdAt,
        u.display_name AS otherDisplayName,
        u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url
      FROM messages m
      INNER JOIN (
        SELECT CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END AS other_id, MAX(id) AS max_id
        FROM messages WHERE sender_id = ? OR receiver_id = ? GROUP BY other_id
      ) latest ON m.id = latest.max_id
      LEFT JOIN users u ON u.id = latest.other_id
      ORDER BY m.created_at DESC
    `, [uid, uid, uid]);
    const [unreads] = await getPool().query(
      `SELECT sender_id, COUNT(*) AS cnt FROM messages WHERE receiver_id = ? AND is_read = 0 GROUP BY sender_id`, [uid]
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
  } catch (e) { console.error('[chat]', e); res.status(500).json({ error: '服务器错误' }); }
});

// 获取私信历史
router.get('/history/:userId', requireChatAuth, async (req, res) => {
  try {
    const uid = req.session.userId;
    const otherId = parseInt(req.params.userId);
    if (isNaN(otherId)) return res.status(400).json({ error: '参数错误' });
    const [rows] = await getPool().query(
      `SELECT id, sender_id AS senderId, receiver_id AS receiverId, content, is_read AS isRead, created_at AS createdAt
       FROM messages WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
       ORDER BY created_at ASC LIMIT 200`,
      [uid, otherId, otherId, uid]);
    res.json({ messages: rows });
  } catch (e) { console.error('[chat]', e); res.status(500).json({ error: '服务器错误' }); }
});

// 发送私信
router.post('/send', requireChatAuth, async (req, res) => {
  try {
    const uid = req.session.userId;
    const { receiverId, content } = req.body;
    if (!receiverId || !content || !content.trim()) return res.status(400).json({ error: '参数不完整' });
    const trimmed = content.trim().slice(0, 2000);
    const rId = parseInt(receiverId);
    const [user] = await getPool().query(`SELECT id FROM users WHERE id = ? AND deleted_at IS NULL`, [rId]);
    if (user.length === 0) return res.status(404).json({ error: '用户不存在' });
    const [result] = await getPool().query(
      `INSERT INTO messages (sender_id, receiver_id, content) VALUES (?, ?, ?)`, [uid, rId, trimmed]);
    res.json({ ok: true, message: { id: result.insertId, senderId: uid, receiverId: rId, content: trimmed, isRead: 0, createdAt: new Date().toISOString() } });
  } catch (e) { console.error('[chat]', e); res.status(500).json({ error: '服务器错误' }); }
});

// 标记已读
router.post('/read/:userId', requireChatAuth, async (req, res) => {
  try {
    await getPool().query(
      `UPDATE messages SET is_read = 1, read_at = NOW() WHERE sender_id = ? AND receiver_id = ? AND is_read = 0`,
      [parseInt(req.params.userId), req.session.userId]);
    res.json({ ok: true });
  } catch (e) { console.error('[chat]', e); res.status(500).json({ error: '服务器错误' }); }
});

// ==================== 群聊系统 V6.13 ====================

// 创建群聊
router.post('/groups', requireChatAuth, async (req, res) => {
  try {
    const uid = req.session.userId;
    const { name, memberIds } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: '群聊名称不能为空' });
    const groupName = name.trim().slice(0, 50);
    const conn = await getPool().getConnection();
    try {
      await conn.beginTransaction();
      const [grp] = await conn.query(
        `INSERT INTO chat_groups (name, creator_id) VALUES (?, ?)`, [groupName, uid]);
      // 创建者自动加入
      await conn.query(
        `INSERT IGNORE INTO chat_group_members (group_id, user_id) VALUES (?, ?)`, [grp.insertId, uid]);
      // 添加其他成员
      if (memberIds && Array.isArray(memberIds)) {
        for (const mid of memberIds) {
          const midInt = parseInt(mid);
          if (midInt && midInt !== uid) {
            await conn.query(
              `INSERT IGNORE INTO chat_group_members (group_id, user_id) VALUES (?, ?)`, [grp.insertId, midInt]);
          }
        }
      }
      await conn.commit();
      res.json({ ok: true, groupId: grp.insertId, name: groupName });
    } catch (e2) { await conn.rollback(); throw e2; } finally { conn.release(); }
  } catch (e) { console.error('[chat-group]', e); res.status(500).json({ error: '创建失败' }); }
});

// 获取我的群聊列表
router.get('/groups', requireChatAuth, async (req, res) => {
  try {
    const uid = req.session.userId;
    const [rows] = await getPool().query(`
      SELECT g.id, g.name, g.creator_id AS creatorId, g.created_at AS createdAt,
             (SELECT COUNT(*) FROM chat_group_members WHERE group_id = g.id) AS memberCount,
             (SELECT content FROM chat_group_messages WHERE group_id = g.id ORDER BY id DESC LIMIT 1) AS lastMessage,
             (SELECT created_at FROM chat_group_messages WHERE group_id = g.id ORDER BY id DESC LIMIT 1) AS lastTime
      FROM chat_groups g
      JOIN chat_group_members gm ON gm.group_id = g.id
      WHERE gm.user_id = ?
      ORDER BY lastTime DESC, g.created_at DESC
    `, [uid]);
    res.json({ groups: rows });
  } catch (e) { console.error('[chat-group]', e); res.status(500).json({ error: '服务器错误' }); }
});

// 获取群聊详情（含成员列表）
router.get('/groups/:groupId', requireChatAuth, async (req, res) => {
  try {
    const gid = parseInt(req.params.groupId);
    const uid = req.session.userId;
    // 检查成员
    const [memCheck] = await getPool().query(
      `SELECT id FROM chat_group_members WHERE group_id = ? AND user_id = ?`, [gid, uid]);
    if (memCheck.length === 0) return res.status(403).json({ error: '你不是该群成员' });
    const [groupInfo] = await getPool().query(`SELECT id, name, creator_id AS creatorId, created_at AS createdAt FROM chat_groups WHERE id = ?`, [gid]);
    if (groupInfo.length === 0) return res.status(404).json({ error: '群聊不存在' });
    const [members] = await getPool().query(`
      SELECT u.id, u.display_name AS displayName, u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url
      FROM chat_group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ?`, [gid]);
    res.json({ group: groupInfo[0], members: members.map(m => ({ id: m.id, displayName: m.displayName, avatarUrl: getAvatar(m) })) });
  } catch (e) { console.error('[chat-group]', e); res.status(500).json({ error: '服务器错误' }); }
});

// 加入群聊
router.post('/groups/:groupId/join', requireChatAuth, async (req, res) => {
  try {
    const gid = parseInt(req.params.groupId);
    const uid = req.session.userId;
    await getPool().query(`INSERT IGNORE INTO chat_group_members (group_id, user_id) VALUES (?, ?)`, [gid, uid]);
    res.json({ ok: true });
  } catch (e) { console.error('[chat-group]', e); res.status(500).json({ error: '加入失败' }); }
});

// 获取群消息
router.get('/groups/:groupId/messages', requireChatAuth, async (req, res) => {
  try {
    const gid = parseInt(req.params.groupId);
    const uid = req.session.userId;
    const [memCheck] = await getPool().query(
      `SELECT id FROM chat_group_members WHERE group_id = ? AND user_id = ?`, [gid, uid]);
    if (memCheck.length === 0) return res.status(403).json({ error: '你不是该群成员' });
    const [rows] = await getPool().query(`
      SELECT m.id, m.sender_id AS senderId, m.content, m.msg_type AS msgType,
             m.lat, m.lng, m.created_at AS createdAt,
             u.display_name AS senderName, u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url
      FROM chat_group_messages m
      LEFT JOIN users u ON u.id = m.sender_id
      WHERE m.group_id = ?
      ORDER BY m.created_at ASC LIMIT 200`, [gid]);
    res.json({ messages: rows.map(r => ({ ...r, senderAvatar: getAvatar(r) })) });
  } catch (e) { console.error('[chat-group]', e); res.status(500).json({ error: '服务器错误' }); }
});

// 发送群消息
router.post('/groups/:groupId/messages', requireChatAuth, async (req, res) => {
  try {
    const gid = parseInt(req.params.groupId);
    const uid = req.session.userId;
    const { content, msgType, lat, lng } = req.body;
    const [memCheck] = await getPool().query(
      `SELECT id FROM chat_group_members WHERE group_id = ? AND user_id = ?`, [gid, uid]);
    if (memCheck.length === 0) return res.status(403).json({ error: '你不是该群成员' });
    const trimmed = content ? content.trim().slice(0, 2000) : '';
    if (!trimmed && msgType !== 'location') return res.status(400).json({ error: '消息不能为空' });
    const [result] = await getPool().query(
      `INSERT INTO chat_group_messages (group_id, sender_id, content, msg_type, lat, lng) VALUES (?, ?, ?, ?, ?, ?)`,
      [gid, uid, trimmed, msgType || 'text', lat || null, lng || null]);
    res.json({ ok: true, messageId: result.insertId });
  } catch (e) { console.error('[chat-group]', e); res.status(500).json({ error: '服务器错误' }); }
});

module.exports = router;
