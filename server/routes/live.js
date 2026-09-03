/**
 * 境途同游 V6.14 — 直播系统路由
 * 
 * @swagger
 * tags:
 *   name: Live
 *   description: 直播相关接口
 */
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getPool, getAvatarUrl, handleError , sendError, ErrorCodes, createFileFilter, secureUpload } = require('../utils');
const { requireAuth, requireAdminCompat } = require('../auth');

module.exports = function (notificationService) {
  const router = express.Router();

const LIVE_DIR = path.join(__dirname, '..', '..', 'uploads', 'live');
if (!fs.existsSync(LIVE_DIR)) fs.mkdirSync(LIVE_DIR, { recursive: true });

const liveStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, LIVE_DIR),
  filename: (req, file, cb) => {
    const uid = req.session?.userId || '0';
    const ext = path.extname(file.originalname) || '.jpg';
    const crypto = require('crypto');
    cb(null, `live_${uid}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`);
  }
});

const liveUpload = multer({
  storage: liveStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: createFileFilter(['IMAGE'])
});

function getAvatar(u) {
  return getAvatarUrl(u) || '/api/avatar/default';
}

// ==================== 推流地址生成 ====================
// 以前这里直接写成 `/live/rtmp/${streamId}`，是一个站内相对路径。
// OBS 等推流软件需要的是带协议和主机的完整 RTMP URL，相对路径根本无法使用。
// 现在按 RTMP_* 环境变量拼装，并把推流码与流 ID 分开，避免仅凭自增 ID 就能顶替他人推流。
const RTMP_HOST = process.env.RTMP_HOST || '';
const RTMP_PORT = process.env.RTMP_PORT || '1935';
const RTMP_APP = process.env.RTMP_APP || 'live';
const HLS_BASE = process.env.HLS_BASE_URL || '';

function buildRtmpUrls(req, streamId, streamKey) {
  // 未配置 RTMP_HOST 时退回到当前请求的主机名，至少保证地址是可用的绝对地址
  const host = RTMP_HOST || (req.hostname || 'localhost');
  const ingest = `rtmp://${host}:${RTMP_PORT}/${RTMP_APP}`;
  const hlsBase = HLS_BASE || `${req.protocol}://${req.get('host')}`;
  return {
    // OBS：「服务器」填 rtmpUrl，「推流码」填 streamKey
    rtmpUrl: ingest,
    streamKey,
    // 完整地址，方便直接复制到只有单个输入框的推流工具
    rtmpFullUrl: `${ingest}/${streamKey}`,
    streamUrl: `${hlsBase}/${RTMP_APP}/hls/${streamKey}/index.m3u8`
  };
}

async function getAccessibleStream(req, streamId) {
  const [rows] = await getPool().query(
    `SELECT user_id, status, is_public FROM live_streams WHERE id = ?`,
    [streamId]
  );
  if (rows.length === 0) return null;
  const stream = rows[0];
  const canViewPrivate = stream.user_id === req.session?.userId ||
    ['admin', 'super_admin'].includes(req.session?.role);
  return stream.is_public || canViewPrivate ? stream : null;
}

// ==================== 直播管理 ====================

// 创建直播
router.post('/', requireAuth, secureUpload(liveUpload.single('thumbnail')), async (req, res) => {
  try {
    const uid = req.session.userId;
    const { title, description, isPublic } = req.body;
    if (!title || !title.trim()) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '直播标题不能为空');
    
    let thumbnailUrl = null;
    if (req.file) {
      thumbnailUrl = `/uploads/live/${req.file.filename}`;
    }
    
    const [result] = await getPool().query(
      `INSERT INTO live_streams (user_id, title, description, thumbnail_url, is_public) VALUES (?, ?, ?, ?, ?)`,
      [uid, title.trim(), description || '', thumbnailUrl, isPublic !== 'false']);
    
    const streamId = result.insertId;
    // 推流码不能直接用自增 ID：别人猜到 ID 就能顶替推流。用随机串并持久化。
    const streamKey = `s${streamId}_${require('crypto').randomBytes(12).toString('hex')}`;
    const urls = buildRtmpUrls(req, streamId, streamKey);

    await getPool().query(
      `UPDATE live_streams SET rtmp_url = ?, stream_url = ?, stream_key = ? WHERE id = ?`,
      [urls.rtmpFullUrl, urls.streamUrl, streamKey, streamId]);

    res.json({
      ok: true, streamId, title: title.trim(),
      rtmpUrl: urls.rtmpUrl,
      streamKey: urls.streamKey,
      rtmpFullUrl: urls.rtmpFullUrl,
      streamUrl: urls.streamUrl
    });
  } catch (e) { handleError(res, e, '[live/create]'); }
});

// 开始直播
router.post('/:streamId/start', requireAuth, async (req, res) => {
  try {
    const streamId = parseInt(req.params.streamId);
    const uid = req.session.userId;
    
    const [stream] = await getPool().query(`SELECT user_id, status, is_public FROM live_streams WHERE id = ?`, [streamId]);
    if (stream.length === 0) return sendError(res, 404, ErrorCodes.NOT_FOUND, '直播不存在');
    if (stream[0].user_id !== uid) return sendError(res, 403, ErrorCodes.FORBIDDEN, '只能开始自己的直播');
    if (stream[0].status === 'live') return sendError(res, 400, ErrorCodes.BAD_REQUEST, '直播已在进行中');
    
    // 重置观众计数并清理上一次异常结束可能遗留的脏观众记录（断线未走 leave 的情况），
    // 避免 viewer_count 在重启直播后持续偏高或残留在线观众。
    await getPool().query(`UPDATE live_viewers SET left_at = NOW() WHERE stream_id = ? AND left_at IS NULL`, [streamId]);
    await getPool().query(`UPDATE live_streams SET status = 'live', viewer_count = 0 WHERE id = ?`, [streamId]);
    
    if (notificationService && stream[0].is_public) {
      const [user] = await getPool().query(`SELECT display_name FROM users WHERE id = ?`, [uid]);
      const userName = user[0]?.display_name || '用户';
      await notificationService.notifyAllMembers('live', '🔴 直播开始', `${userName} 开始直播了！`, {
        targetType: 'live',
        targetId: streamId
      });
    }
    
    res.json({ ok: true, message: '直播已开始' });
  } catch (e) { handleError(res, e, '[live/start]'); }
});

// 结束直播
router.post('/:streamId/end', requireAuth, async (req, res) => {
  try {
    const streamId = parseInt(req.params.streamId);
    const uid = req.session.userId;
    
    const [stream] = await getPool().query(`SELECT user_id, status FROM live_streams WHERE id = ?`, [streamId]);
    if (stream.length === 0) return sendError(res, 404, ErrorCodes.NOT_FOUND, '直播不存在');
    if (stream[0].user_id !== uid) return sendError(res, 403, ErrorCodes.FORBIDDEN, '只能结束自己的直播');
    if (stream[0].status !== 'live') return sendError(res, 400, ErrorCodes.BAD_REQUEST, '直播未在进行中');
    
    await getPool().query(`UPDATE live_streams SET status = 'ended', ended_at = NOW() WHERE id = ?`, [streamId]);
    
    // 清理观众
    await getPool().query(`UPDATE live_viewers SET left_at = NOW() WHERE stream_id = ? AND left_at IS NULL`, [streamId]);
    
    res.json({ ok: true, message: '直播已结束' });
  } catch (e) { handleError(res, e, '[live/end]'); }
});

// 获取我的直播记录。必须位于 /:streamId 之前，避免被参数路由遮蔽。
router.get('/user/history', requireAuth, async (req, res) => {
  try {
    const uid = req.session.userId;
    const page = parseInt(req.query.page) || 1;
    const pageSize = Math.min(parseInt(req.query.pageSize) || 20, 50);
    const offset = (page - 1) * pageSize;

    const [rows] = await getPool().query(
      `SELECT * FROM live_streams WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [uid, pageSize, offset]
    );
    const [count] = await getPool().query(`SELECT COUNT(*) AS total FROM live_streams WHERE user_id = ?`, [uid]);

    res.json({ streams: rows, total: count[0].total, page, pageSize });
  } catch (e) { handleError(res, e, '[live/history]'); }
});

// 获取直播详情
router.get('/:streamId', async (req, res) => {
  try {
    const streamId = parseInt(req.params.streamId);
    if (isNaN(streamId)) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '无效的直播ID');
    const [stream] = await getPool().query(`
      SELECT s.*, u.display_name AS userName, u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url
      FROM live_streams s LEFT JOIN users u ON s.user_id = u.id WHERE s.id = ?`, [streamId]);
    
    if (stream.length === 0) return sendError(res, 404, ErrorCodes.NOT_FOUND, '直播不存在');
    
    const s = stream[0];
    const canViewPrivate = req.session?.userId === s.user_id || ['admin', 'super_admin'].includes(req.session?.role);
    if (!s.is_public && !canViewPrivate) {
      return sendError(res, 404, ErrorCodes.NOT_FOUND, '直播不存在');
    }
    res.json({
      id: s.id,
      userId: s.user_id,
      userName: s.userName,
      userAvatar: getAvatar(s),
      title: s.title,
      description: s.description,
      streamUrl: s.stream_url,
      rtmpUrl: s.rtmp_url,
      thumbnailUrl: s.thumbnail_url,
      status: s.status,
      viewerCount: s.viewer_count,
      maxViewers: s.max_viewers,
      isPublic: s.is_public,
      createdAt: s.created_at,
      endedAt: s.endedAt
    });
  } catch (e) { handleError(res, e, '[live/get]'); }
});

// 获取直播列表
router.get('/', async (req, res) => {
  try {
    const status = req.query.status || 'live';
    const page = parseInt(req.query.page) || 1;
    const pageSize = Math.min(parseInt(req.query.pageSize) || 20, 50);
    const offset = (page - 1) * pageSize;
    
    const conditions = [];
    const params = [];
    if (status === 'live' || status === 'ended') {
      conditions.push('s.status = ?');
      params.push(status);
    }
    if (!['admin', 'super_admin'].includes(req.session?.role)) {
      conditions.push('(s.is_public = 1 OR s.user_id = ?)');
      params.push(req.session?.userId || 0);
    }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    
    const [rows] = await getPool().query(`
      SELECT s.*, u.display_name AS userName, u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url
      FROM live_streams s LEFT JOIN users u ON s.user_id = u.id
      ${whereClause} ORDER BY s.created_at DESC LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
    
    const [count] = await getPool().query(`SELECT COUNT(*) AS total FROM live_streams s ${whereClause}`, params);
    
    res.json({
      streams: rows.map(s => ({
        id: s.id,
        userId: s.user_id,
        userName: s.userName,
        userAvatar: getAvatar(s),
        title: s.title,
        description: s.description,
        thumbnailUrl: s.thumbnail_url,
        status: s.status,
        viewerCount: s.viewer_count,
        maxViewers: s.max_viewers,
        isPublic: s.is_public,
        createdAt: s.created_at,
        endedAt: s.ended_at
      })),
      total: count[0].total,
      page,
      pageSize
    });
  } catch (e) { handleError(res, e, '[live/list]'); }
});

// ==================== 观众管理 ====================

// 进入直播间
router.post('/:streamId/enter', requireAuth, async (req, res) => {
  try {
    const streamId = parseInt(req.params.streamId);
    const uid = req.session.userId;
    
    const stream = await getAccessibleStream(req, streamId);
    if (!stream) return sendError(res, 404, ErrorCodes.NOT_FOUND, '直播不存在');
    if (stream.status !== 'live') return sendError(res, 400, ErrorCodes.BAD_REQUEST, '直播未开始');
    
    await getPool().query(
      `INSERT INTO live_viewers (stream_id, user_id, left_at) VALUES (?, ?, NULL)
       ON DUPLICATE KEY UPDATE left_at = NULL`,
      [streamId, uid]
    );
    
    const [viewers] = await getPool().query(`SELECT COUNT(*) AS cnt FROM live_viewers WHERE stream_id = ? AND left_at IS NULL`, [streamId]);
    await getPool().query(`UPDATE live_streams SET viewer_count = ? WHERE id = ?`, [viewers[0].cnt, streamId]);
    const [max] = await getPool().query(`SELECT max_viewers FROM live_streams WHERE id = ?`, [streamId]);
    
    if (viewers[0].cnt > max[0].max_viewers) {
      await getPool().query(`UPDATE live_streams SET max_viewers = ? WHERE id = ?`, [viewers[0].cnt, streamId]);
    }
    
    res.json({ ok: true, viewerCount: viewers[0].cnt });
  } catch (e) { handleError(res, e, '[live/enter]'); }
});

// 离开直播间
router.post('/:streamId/leave', requireAuth, async (req, res) => {
  try {
    const streamId = parseInt(req.params.streamId);
    const uid = req.session.userId;
    if (!await getAccessibleStream(req, streamId)) {
      return sendError(res, 404, ErrorCodes.NOT_FOUND, '直播不存在');
    }
    
    await getPool().query(`UPDATE live_viewers SET left_at = NOW() WHERE stream_id = ? AND user_id = ? AND left_at IS NULL`, [streamId, uid]);
    
    const [viewers] = await getPool().query(`SELECT COUNT(*) AS cnt FROM live_viewers WHERE stream_id = ? AND left_at IS NULL`, [streamId]);
    await getPool().query(`UPDATE live_streams SET viewer_count = ? WHERE id = ?`, [viewers[0].cnt, streamId]);
    
    res.json({ ok: true, viewerCount: viewers[0].cnt });
  } catch (e) { handleError(res, e, '[live/leave]'); }
});

// 获取直播间观众列表
router.get('/:streamId/viewers', requireAuth, async (req, res) => {
  try {
    const streamId = parseInt(req.params.streamId);
    if (!await getAccessibleStream(req, streamId)) {
      return sendError(res, 404, ErrorCodes.NOT_FOUND, '直播不存在');
    }
    const [viewers] = await getPool().query(`
      SELECT u.id, u.display_name AS displayName, u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url, v.joined_at AS joinedAt
      FROM live_viewers v LEFT JOIN users u ON v.user_id = u.id
      WHERE v.stream_id = ? AND v.left_at IS NULL ORDER BY v.joined_at DESC`, [streamId]);
    
    res.json({ viewers: viewers.map(v => ({
      id: v.id,
      displayName: v.displayName,
      avatarUrl: getAvatar(v),
      joinedAt: v.joinedAt
    })) });
  } catch (e) { handleError(res, e, '[live/viewers]'); }
});

// ==================== 弹幕系统 ====================

// 发送弹幕
router.post('/:streamId/comments', requireAuth, async (req, res) => {
  try {
    const streamId = parseInt(req.params.streamId);
    const uid = req.session.userId;
    const { content } = req.body;
    
    if (!content || !content.trim()) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '弹幕内容不能为空');
    
    const stream = await getAccessibleStream(req, streamId);
    if (!stream) return sendError(res, 404, ErrorCodes.NOT_FOUND, '直播不存在');
    if (stream.status !== 'live') return sendError(res, 400, ErrorCodes.BAD_REQUEST, '直播未开始');
    
    const [result] = await getPool().query(
      `INSERT INTO live_comments (stream_id, user_id, content) VALUES (?, ?, ?)`,
      [streamId, uid, content.trim()]);
    
    const [user] = await getPool().query(`SELECT display_name FROM users WHERE id = ?`, [uid]);
    
    res.json({
      ok: true,
      comment: {
        id: result.insertId,
        userId: uid,
        userName: user[0]?.display_name || '用户',
        content: content.trim(),
        createdAt: new Date().toISOString()
      }
    });
  } catch (e) { handleError(res, e, '[live/comments]'); }
});

// 获取弹幕历史
router.get('/:streamId/comments', requireAuth, async (req, res) => {
  try {
    const streamId = parseInt(req.params.streamId);
    if (!await getAccessibleStream(req, streamId)) {
      return sendError(res, 404, ErrorCodes.NOT_FOUND, '直播不存在');
    }
    const page = parseInt(req.query.page) || 1;
    const pageSize = Math.min(parseInt(req.query.pageSize) || 100, 200);
    const offset = (page - 1) * pageSize;
    
    const [rows] = await getPool().query(`
      SELECT c.id, c.user_id AS userId, c.content, c.created_at AS createdAt,
             u.display_name AS userName, u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url
      FROM live_comments c LEFT JOIN users u ON c.user_id = u.id
      WHERE c.stream_id = ? ORDER BY c.created_at DESC LIMIT ? OFFSET ?`, [streamId, pageSize, offset]);
    
    const [count] = await getPool().query(`SELECT COUNT(*) AS total FROM live_comments WHERE stream_id = ?`, [streamId]);
    
    res.json({
      comments: rows.map(c => ({
        id: c.id,
        userId: c.userId,
        userName: c.userName,
        userAvatar: getAvatar(c),
        content: c.content,
        createdAt: c.createdAt
      })),
      total: count[0].total,
      page,
      pageSize
    });
  } catch (e) { handleError(res, e, '[live/comments-history]'); }
});

// ==================== 点赞系统 ====================

// 点赞直播
router.post('/:streamId/like', requireAuth, async (req, res) => {
  try {
    const streamId = parseInt(req.params.streamId);
    const uid = req.session.userId;
    
    const stream = await getAccessibleStream(req, streamId);
    if (!stream) return sendError(res, 404, ErrorCodes.NOT_FOUND, '直播不存在');
    
    await getPool().query(`INSERT IGNORE INTO live_likes (stream_id, user_id) VALUES (?, ?)`, [streamId, uid]);
    
    const [count] = await getPool().query(`SELECT COUNT(*) AS cnt FROM live_likes WHERE stream_id = ?`, [streamId]);
    
    res.json({ ok: true, likeCount: count[0].cnt });
  } catch (e) { handleError(res, e, '[live/like]'); }
});

// 获取直播点赞数
router.get('/:streamId/likes', async (req, res) => {
  try {
    const streamId = parseInt(req.params.streamId);
    if (!await getAccessibleStream(req, streamId)) {
      return sendError(res, 404, ErrorCodes.NOT_FOUND, '直播不存在');
    }
    const [count] = await getPool().query(`SELECT COUNT(*) AS cnt FROM live_likes WHERE stream_id = ?`, [streamId]);
    res.json({ likeCount: count[0].cnt });
  } catch (e) { handleError(res, e, '[live/likes-count]'); }
});

// ==================== 主播管理 ====================

// 删除直播记录
router.delete('/:streamId', requireAuth, async (req, res) => {
  try {
    const streamId = parseInt(req.params.streamId);
    const uid = req.session.userId;
    
    const [stream] = await getPool().query(`SELECT user_id, status FROM live_streams WHERE id = ?`, [streamId]);
    if (stream.length === 0) return sendError(res, 404, ErrorCodes.NOT_FOUND, '直播不存在');
    if (stream[0].user_id !== uid) return sendError(res, 403, ErrorCodes.FORBIDDEN, '只能删除自己的直播');
    if (stream[0].status === 'live') return sendError(res, 400, ErrorCodes.BAD_REQUEST, '直播进行中不能删除');
    
    await getPool().query(`DELETE FROM live_comments WHERE stream_id = ?`, [streamId]);
    await getPool().query(`DELETE FROM live_likes WHERE stream_id = ?`, [streamId]);
    await getPool().query(`DELETE FROM live_viewers WHERE stream_id = ?`, [streamId]);
    await getPool().query(`DELETE FROM live_streams WHERE id = ?`, [streamId]);
    
    res.json({ ok: true, message: '直播记录已删除' });
  } catch (e) { handleError(res, e, '[live/delete]'); }
});

return router;
};
