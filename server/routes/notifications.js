/**
 * 境途同游 V6.15 — 通知系统路由
 * 
 * @swagger
 * tags:
 *   name: Notifications
 *   description: 通知系统相关接口
 */
const express = require('express');
const { ok, fail, getPool, handleError , sendError, ErrorCodes, paginate } = require('../utils');
const { requireAuth } = require('../auth');
const { vrchatGetNotifications } = require('../vrc');

// ==================== VRChat 通知联动（V9.6） ====================
// 仅同步「会员自己绑定账号」的 VRChat 官方通知到站内通知：
//  - cookie 只取 getVRCCookieUserOnly（绝不降级系统账号，避免把系统通知写进他人通知列表）
//  - 去重用 vrc_notif_sync 表（VRChat 通知 id 全局唯一）
//  - 同用户 60 秒防抖 + 并发重入保护，防止打开面板刷爆 VRChat API
const VRC_NOTIF_SYNC_TTL_MS = 60 * 1000;
const VRC_SYNC_LOOP_MS = 30 * 1000; // H6: 同步循环总超时兜底——上游/DB 慢时避免长期占用连接
const _vrcSyncThrottle = new Map();
const _vrcSyncInflight = new Set();

const VRC_NOTIF_DEFAULT_MSG = {
  friendRequest: '有新的好友请求，快去处理',
  invite: '对方邀请你进入同一个实例游玩',
  requestInvite: '对方希望加入你所在的实例',
  message: '对方给你发来一条 VRChat 私信',
  groupInvite: '你被邀请加入一个 VRChat 群组',
  groupJoinRequest: '有人请求加入你的 VRChat 群组',
  groupJoinResponse: '你的群组入群申请有结果了',
  groupAnnouncement: '你所在的群组发布了新公告',
  groupAnnouncementCancelled: '你所在的群组取消了公告',
  partyInvite: '对方邀请你参加派对',
  giftOne: '对方送了你一个礼物',
  voteToKick: '有人发起了投票踢人',
  userOnline: '好友上线了',
  boop: '有人在游戏里戳了戳你（Boop）'
};

function vrcNotifTitle(nt) {
  const sender = nt.senderUsername || 'VRChat';
  switch (nt.type) {
    case 'friendRequest': return `${sender} 向你发送了好友请求`;
    case 'invite': return `${sender} 邀请你加入游戏`;
    case 'requestInvite': return `${sender} 请求加入你的实例`;
    case 'message': return `${sender} 给你发来一条私信`;
    case 'groupInvite': return `${sender} 邀请你加入群组`;
    case 'groupJoinRequest': return `${sender} 请求加入群组`;
    case 'groupJoinResponse': return `群组入群申请结果`;
    case 'groupAnnouncement': return `📢 群组公告`;
    case 'groupAnnouncementCancelled': return `群组公告已取消`;
    case 'partyInvite': return `${sender} 邀请你参加派对`;
    case 'giftOne': return `${sender} 送了你一个礼物`;
    case 'voteToKick': return `${sender} 发起了投票踢人`;
    case 'userOnline': return `${sender} 上线了`;
    case 'boop': return `👉 ${sender} 在游戏里戳了戳你`;
    default: return `${sender} · ${nt.type || 'VRChat 通知'}`;
  }
}

module.exports = function (authStateRef, notificationService, getVRCCookieUserOnly) {
  const router = express.Router();

  router.get('/notifications', async (req, res) => {
    const uid = req.session?.userId || null;
    if (!uid) return res.json({ notifications: [], unread: 0, page: 1, totalPages: 0, total: 0 });
    try {
      const type = req.query.type;        // 按类型过滤：system/event/comment/announcement/... 或 'unread' 仅未读
      const onlyUnread = type === 'unread';
      const { page, pageSize, offset } = paginate(req, { defaultSize: 30, maxSize: 100 });

      const where = ['user_id = ?'];
      const params = [uid];
      if (onlyUnread) where.push('is_read = 0');
      else if (type && type !== 'all') { where.push('type = ?'); params.push(type); }
      const whereSql = 'WHERE ' + where.join(' AND ');

      const [unreadCount] = await getPool().query(`SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND is_archived = 0 AND is_read = 0`, [uid]);
      const [totalRow] = await getPool().query(`SELECT COUNT(*) as c FROM notifications ${whereSql}`, params);
      const total = totalRow[0].c;
      const totalPages = Math.max(Math.ceil(total / pageSize), 1);

      const [rows] = await getPool().query(
        `SELECT id, type, title, message, related_id AS relatedId,
                target_type AS targetType, target_id AS targetId, post_id AS postId,
                is_read AS isRead, created_at AS createdAt
         FROM notifications ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        params.concat([pageSize, offset])
      );
      res.json({ notifications: rows, unread: unreadCount[0].c, page, pageSize, totalPages, total });
    } catch (e) { handleError(res, e, '[notifications]'); }
  });

  router.get('/notifications/unread', async (req, res) => {
    const uid = req.session?.userId || null;
    if (!uid) return res.json({ count: 0 });
    try {
      const [rows] = await getPool().query('SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND is_archived = 0 AND is_read = 0', [uid]);
      res.json({ count: rows[0].c });
    } catch (e) { handleError(res, e, '[notifications/unread]'); }
  });

  // V9.6: 把本人 VRChat 官方通知并入站内通知（仅会员自己绑定的账号，绝不降级系统账号）
  router.get('/notifications/vrc-sync', requireAuth, async (req, res) => {
    const uid = req.session.userId;
    try {
      const cookie = (typeof getVRCCookieUserOnly === 'function') ? getVRCCookieUserOnly(req) : null;
      if (!cookie) return ok(res, { bound: false, synced: 0 });
      const now = Date.now();
      const last = _vrcSyncThrottle.get(uid) || 0;
      if (now - last < VRC_NOTIF_SYNC_TTL_MS) return ok(res, { bound: true, cached: true, synced: 0 });
      if (_vrcSyncInflight.has(uid)) return ok(res, { bound: true, busy: true, synced: 0 });
      _vrcSyncInflight.add(uid);
      try {
        const resp = await vrchatGetNotifications(cookie, 50, 0);
        if (!resp || resp.status !== 200) {
          return fail(res, 502, (resp && resp.data && resp.data.error && resp.data.error.message) || 'VRChat 通知拉取失败');
        }
        const list = Array.isArray(resp.data) ? resp.data : [];
        if (_vrcSyncThrottle.size > 10000) _vrcSyncThrottle.clear();
        let synced = 0;
        const pool = getPool();
        const deadline = Date.now() + VRC_SYNC_LOOP_MS; // H6: 总超时，超过即返回已同步部分
        for (const nt of list) {
          if (Date.now() > deadline) break;
          const nid = nt.id || '';
          if (!nid) continue;
          try {
            const [ins] = await pool.query(`INSERT IGNORE INTO vrc_notif_sync (user_id, vrc_notif_id) VALUES (?, ?)`, [uid, nid]);
            if (!ins || !ins.affectedRows) continue; // 已同步过，跳过
            const title = (vrcNotifTitle(nt) || 'VRChat 通知').slice(0, 255);
            const message = (nt.message || VRC_NOTIF_DEFAULT_MSG[nt.type] || 'VRChat 收到一条新通知').slice(0, 500);
            if (notificationService) {
              await notificationService.notifyUser(uid, 'vrc', title, message, { targetType: 'vrc_notification' });
            }
            synced++;
          } catch (e) {
            // H6: 单条失败不中断整批同步（如某条已刷新的通知写入冲突），记一条日志后继续
            logger.error('[notifications/vrc-sync] 单条同步失败', e && e.message ? e.message : e);
            continue;
          }
        }
        _vrcSyncThrottle.set(uid, now);
        ok(res, { bound: true, synced, total: list.length });
      } finally {
        _vrcSyncInflight.delete(uid);
      }
    } catch (e) { handleError(res, e, '[notifications/vrc-sync]'); }
  });

  router.post('/notifications/read', async (req, res) => {
    const uid = req.session?.userId || null;
    if (!uid) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, '请先登录');
    try {
      await getPool().query(`UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0`, [uid]);
      ok(res);
    } catch (e) { handleError(res, e, '[notifications/read]'); }
  });

  router.post('/notifications/read-all', async (req, res) => {
    const uid = req.session?.userId || null;
    if (!uid) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, '请先登录');
    try {
      await getPool().query(`UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0`, [uid]);
      ok(res);
    } catch (e) { handleError(res, e, '[notifications/read-all]'); }
  });

  router.post('/notifications/archive-all', async (req, res) => {
    const uid = req.session?.userId || null;
    if (!uid) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, '请先登录');
    try {
      await getPool().query('UPDATE notifications SET is_archived = 1 WHERE user_id = ?', [uid]);
      ok(res);
    } catch (e) { handleError(res, e, '[notifications/archive-all]'); }
  });

  router.get('/notifications/settings', requireAuth, async (req, res) => {
    try {
      const [rows] = await getPool().query(`SELECT notification_settings FROM users WHERE id = ?`, [req.session.userId]);
      if (rows.length === 0) {
        return res.json({ email: false, browser: true, sound: true, vrc: true });
      }
      const settings = rows[0].notification_settings ? JSON.parse(rows[0].notification_settings) : {};
      res.json({
        email: settings.email || false,
        browser: settings.browser !== false,
        sound: settings.sound !== false,
        vrc: settings.vrc !== false
      });
    } catch (e) { handleError(res, e, '[notifications/settings]'); }
  });

  router.post('/notifications/settings', requireAuth, async (req, res) => {
    try {
      const { email, browser, sound, vrc } = req.body;
      const settings = { email: !!email, browser: !!browser, sound: !!sound, vrc: vrc !== false };
      await getPool().query(
        `UPDATE users SET notification_settings = ? WHERE id = ?`,
        [JSON.stringify(settings), req.session.userId]
      );
      if (notificationService) notificationService.invalidateSettingsCache(req.session.userId);
      ok(res, {settings});
    } catch (e) { handleError(res, e, '[notifications/settings]'); }
  });

  router.delete('/notifications', async (req, res) => {
    const uid = req.session?.userId || null;
    if (!uid) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, '请先登录');
    try {
      await getPool().query(`DELETE FROM notifications WHERE user_id = ?`, [uid]);
      ok(res);
    } catch (e) { handleError(res, e, '[notifications/delete]'); }
  });

  router.post('/notifications/:id/read', async (req, res) => {
    const uid = req.session?.userId || null;
    if (!uid) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, '请先登录');
    try {
      await getPool().query(`UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?`, [req.params.id, uid]);
      ok(res);
    } catch (e) { handleError(res, e, '[notifications/:id/read]'); }
  });

  router.put('/notifications/:id/archive', async (req, res) => {
    const uid = req.session?.userId || null;
    if (!uid) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, '请先登录');
    try {
      const { archived } = req.body;
      await getPool().query('UPDATE notifications SET is_archived = ? WHERE id = ? AND user_id = ?', [archived ? 1 : 0, req.params.id, uid]);
      ok(res, {archived: !!archived});
    } catch (e) { handleError(res, e, '[notifications/:id/archive]'); }
  });

  router.delete('/notifications/:id', async (req, res) => {
    const uid = req.session?.userId;
    if (!uid) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, '请先登录');
    try {
      await getPool().query(`DELETE FROM notifications WHERE id = ? AND user_id = ?`, [req.params.id, uid]);
      ok(res);
    } catch (e) { handleError(res, e, '[notifications/:id]'); }
  });

  return router;
};
