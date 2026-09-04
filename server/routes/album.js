/**
 * 境途同游 V6.14 — 相册路由（从 server.js 提取）
 * 涵盖：相册分类、照片列表/CRUD、点赞/评论、回收站、文件上传
 * 挂载前缀 /api — 内部路由路径有 /album/* 和 /photos/* 两类
 * 
 * @swagger
 * tags:
 *   name: Album
 *   description: 相册管理相关接口
 */
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const { ok, getPool, logOper, handleError , sendError, ErrorCodes, createFileFilter, secureUpload } = require('../utils');
const { extractVideoThumbnail, getVideoDuration } = require('../video_utils');
const { requireAdminCompat, ROLE_LEVEL, getAvatarUrl } = require('../auth');
const logger = require('../logger');

/**
 * @param {object} authStateRef - 系统 VRChat 认证状态的引用对象
 * @param {object} notificationService - 通知服务
 */
module.exports = function (authStateRef, notificationService) {
  const router = express.Router();

  const ROOT_DIR = path.join(__dirname, '..', '..');
  const ASSETS_DIR = path.join(ROOT_DIR, 'assets');
  const ALBUM_DIR = path.join(ASSETS_DIR, 'album');

  // §L2: 防御性路径断言，确保任何落盘路径都严格位于 ALBUM_DIR 内（防路径穿越回归）
  function isWithinAlbum(fullPath) {
    const root = path.resolve(ALBUM_DIR);
    const target = path.resolve(fullPath);
    return target === root || target.startsWith(root + path.sep);
  }

  function getUserId(req) {
    // 不再兜底到系统账号身份：匿名请求一律视为未登录，由各 handler 的 `if (!uid) return 401` 拦截。
    // 旧实现会用系统账号执行写/读，存在越权 footgun（虽被 CSRF 的 session 绑定挡住远程利用，但仍不安全）。
    return req.session?.userId || null;
  }

  /**
     * @swagger
     * /api/album/categories:
     *   get:
     *     summary: 获取相册分类列表
     *     description: 获取所有相册分类
     *     tags: [Album]
     *     responses:
     *       200:
     *         description: 分类列表
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 categories:
     *                   type: array
     *                   items:
     *                     type: object
     *                     properties:
     *                       id:
     *                         type: integer
     *                       name:
     *                         type: string
     */
  router.get('/album/categories', async (req, res) => {
    try {
      const [rows] = await getPool().query(`SELECT id, cate_name AS name, sort FROM album_cate ORDER BY sort ASC, id ASC`);
      res.json({ categories: rows });
    } catch (e) { handleError(res, e, '[album/categories/list]'); }
  });

  /**
     * @swagger
     * /api/album/categories:
     *   post:
     *     summary: 创建相册分类
     *     description: 创建新的相册分类（管理员权限）
     *     tags: [Album]
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               name:
     *                 type: string
     *                 description: 分类名称
     *             required:
     *               - name
     *     responses:
     *       200:
     *         description: 创建成功
     *       400:
     *         description: 参数错误或分类已存在
     *       403:
     *         description: 权限不足
     */
  router.post('/album/categories', requireAdminCompat, async (req, res) => {
    try {
      const { name } = req.body;
      if (!name || !name.trim()) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请输入分类名称');
      const [result] = await getPool().query(`INSERT INTO album_cate (cate_name) VALUES (?)`, [name.trim()]);
      ok(res, {id: result.insertId});
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return sendError(res, 400, ErrorCodes.BAD_REQUEST, '该分类名称已存在');
      handleError(res, e, '[album/categories/create]');
    }
  });

  /**
     * @swagger
     * /api/album/categories/{id}:
     *   delete:
     *     summary: 删除相册分类
     *     description: 删除相册分类，分类下的照片将移至默认分类（管理员权限）
     *     tags: [Album]
     *     parameters:
     *       - name: id
     *         in: path
     *         required: true
     *         type: integer
     *         description: 分类ID
     *     responses:
     *       200:
     *         description: 删除成功
     *       403:
     *         description: 权限不足
     */
  router.delete('/album/categories/:id', requireAdminCompat, async (req, res) => {
    try {
      await getPool().query(`UPDATE album_photo SET cate_id=1 WHERE cate_id=?`, [req.params.id]);
      await getPool().query(`DELETE FROM album_cate WHERE id=? AND id!=1`, [req.params.id]);
      ok(res);
    } catch (e) { handleError(res, e, '[album/categories/delete]'); }
  });

  /**
     * @swagger
     * /api/album/photos:
     *   get:
     *     summary: 获取照片列表
     *     description: 获取相册照片列表，支持分页、分类筛选和排序
     *     tags: [Album]
     *     parameters:
     *       - name: page
     *         in: query
     *         type: integer
     *         description: 页码
     *       - name: cate
     *         in: query
     *         type: integer
     *         description: 分类ID
     *       - name: sort
     *         in: query
     *         type: string
     *         description: 排序方式 (newest/oldest/most_liked)
     *     responses:
     *       200:
     *         description: 照片列表
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 photos:
     *                   type: array
     *                   items:
     *                     type: object
     *                     properties:
     *                       id:
     *                         type: integer
     *                       url:
     *                         type: string
     *                       thumbnail:
     *                         type: string
     *                       likes:
     *                         type: integer
     *                 hasMore:
     *                   type: boolean
     */
  router.get('/album/photos', async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const pageSize = 40;
      const offset = (page - 1) * pageSize;
      const cateId = parseInt(req.query.cate) || 0;
      const albumId = parseInt(req.query.album) || 0;
      const sort = req.query.sort || 'newest';
      let orderBy = 'p.create_time DESC';
      if (sort === 'oldest') orderBy = 'p.create_time ASC';
      if (sort === 'most_liked') orderBy = 'p.like_count DESC, p.create_time DESC';
      let where = 'p.is_recycle=0';
      const params = [];
      if (cateId > 0) { where += ' AND p.cate_id=?'; params.push(cateId); }
      // 前端相册详情页传 ?album=<cateId>，此前被静默忽略导致返回全量照片
      if (albumId > 0) { where += ' AND p.cate_id=?'; params.push(albumId); }
      params.push(pageSize, offset);
      const [rows] = await getPool().query(
        `SELECT p.id, p.cate_id AS cateId, p.event_id AS eventId, p.photo_path AS url, p.thumb_path AS thumbnail, p.photo_desc AS caption, p.upload_vrcid AS uploader, p.upload_name AS uploaderName, p.like_count AS likes, p.media_type AS mediaType, p.file_size AS fileSize, p.is_recycle AS isRecycle, p.recycle_time AS recycleTime, p.create_time AS createTime FROM album_photo p WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
        params
      );
      const [total] = await getPool().query(`SELECT COUNT(*) as c FROM album_photo p WHERE ${where}`, params.slice(0, -2));
      const hasMore = offset + pageSize < total[0].c;
      res.json({ photos: rows, hasMore });
    } catch (e) { handleError(res, e, '[album/photos/list]'); }
  });

  // ==================== 创建照片记录 ====================
  router.post('/photos', async (req, res) => {
    const uid = getUserId(req);
    if (!uid) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, '请先登录');
    const { caption, eventId } = req.body;
    const photoPath = req.body.photo_path;
    const thumbPath = req.body.thumb_path;
    if (!photoPath || !thumbPath) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数不全');
    if (!photoPath.startsWith('assets/album/') || !thumbPath.startsWith('assets/album/')) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '路径不合法');
    }
    try {
      const [result] = await getPool().query(
        `INSERT INTO album_photo (photo_path, thumb_path, photo_desc, upload_vrcid, upload_name, event_id) VALUES (?, ?, ?, ?, ?, ?)`,
        [photoPath, thumbPath, caption || '', uid, req.session.displayName || '', eventId || null]
      );
      ok(res, {id: result.insertId});
    } catch (e) { handleError(res, e, '[album/photos/create]'); }
  });

  // ==================== 更新照片描述 ====================
  router.put('/photos/:id', async (req, res) => {
    const uid = getUserId(req);
    if (!uid) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, '请先登录');
    const { caption } = req.body;
    if (typeof caption === 'string' && caption.length > 50000) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '描述过长');
    const isAdmin = req.session?.role && ['super_admin', 'admin'].includes(req.session.role);
    try {
      if (isAdmin) {
        await getPool().query(`UPDATE album_photo SET photo_desc=? WHERE id=?`, [caption || '', req.params.id]);
      } else {
        await getPool().query(`UPDATE album_photo SET photo_desc=? WHERE id=? AND upload_vrcid=?`, [caption || '', req.params.id, uid]);
      }
      ok(res);
    } catch (e) { handleError(res, e, '[album/photos/update]'); }
  });

  // ==================== 删除照片（移至回收站） ====================
  router.delete('/photos/:id', async (req, res) => {
    const uid = getUserId(req);
    if (!uid) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, '请先登录');
    const isAdminUser = req.session?.role && ['super_admin', 'admin'].includes(req.session.role);
    try {
      if (isAdminUser) {
        await getPool().query(`UPDATE album_photo SET is_recycle=1, recycle_time=NOW() WHERE id=?`, [req.params.id]);
      } else {
        await getPool().query(`UPDATE album_photo SET is_recycle=1, recycle_time=NOW() WHERE id=? AND upload_vrcid=?`, [req.params.id, uid]);
      }
      // 审计：删除照片（管理员代删会留下痕迹）
      try { await logOper(uid, isAdminUser ? '删除照片(管理)' : '删除照片', `照片#${req.params.id}`); } catch (_) {}
      ok(res);
    } catch (e) { handleError(res, e, '[album/photos/delete]'); }
  });

  // ==================== 点赞 ====================
  router.post('/photos/:id/like', async (req, res) => {
    const uid = getUserId(req);
    if (!uid) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, '请先登录');
    try {
      const [[photo]] = await getPool().query(`SELECT id, event_id AS eventId FROM album_photo WHERE id=?`, [req.params.id]);
      if (!photo) return sendError(res, 404, ErrorCodes.NOT_FOUND, '照片不存在');
      // 关联活动已结束则禁止点赞
      if (photo.eventId) {
        const [[evt]] = await getPool().query(`SELECT event_time AS eventTime, ends_at AS endsAt FROM event WHERE id=?`, [photo.eventId]);
        if (evt) {
          const now = new Date();
          const ended = evt.endsAt ? now > new Date(evt.endsAt) : (evt.eventTime ? now > new Date(evt.eventTime) : false);
          if (ended) return sendError(res, 403, ErrorCodes.FORBIDDEN, '活动已结束，无法点赞');
        }
      }
      const [existing] = await getPool().query(`SELECT 1 FROM album_like WHERE photo_id=? AND user_vrcid=?`, [req.params.id, uid]);
      if (existing.length === 0) {
        await getPool().query(`INSERT INTO album_like (photo_id, user_vrcid) VALUES (?, ?)`, [req.params.id, uid]);
        await getPool().query(`UPDATE album_photo SET like_count = (SELECT COUNT(*) FROM album_like WHERE photo_id = ?) WHERE id = ?`, [req.params.id, req.params.id]);
        const [photo] = await getPool().query(`SELECT upload_vrcid FROM album_photo WHERE id = ?`, [req.params.id]);
        if (photo.length > 0 && photo[0].upload_vrcid && photo[0].upload_vrcid !== uid && notificationService) {
          const [uploader] = await getPool().query(`SELECT id FROM users WHERE login_id = ?`, [photo[0].upload_vrcid]);
          if (uploader.length > 0) {
            const [user] = await getPool().query(`SELECT display_name FROM users WHERE id = ?`, [uid]);
            const userName = user[0]?.display_name || '用户';
            notificationService.notifyUser(
              uploader[0].id,
              'like',
              `${userName} 赞了你的照片`,
              '',
              { targetType: 'album', targetId: parseInt(req.params.id) }
            );
          }
        }
      }
      const [[{ cnt }]] = await getPool().query(`SELECT COUNT(*) AS cnt FROM album_like WHERE photo_id = ?`, [req.params.id]);
      ok(res, {likes: cnt});
    } catch (e) { handleError(res, e, '[album/photos/like]'); }
  });

  // ==================== 取消点赞 ====================
  router.delete('/photos/:id/like', async (req, res) => {
    const uid = getUserId(req);
    if (!uid) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, '请先登录');
    try {
      await getPool().query(`DELETE FROM album_like WHERE photo_id=? AND user_vrcid=?`, [req.params.id, uid]);
      await getPool().query(`UPDATE album_photo SET like_count = (SELECT COUNT(*) FROM album_like WHERE photo_id = ?) WHERE id = ?`, [req.params.id, req.params.id]);
      const [[{ cnt }]] = await getPool().query(`SELECT COUNT(*) AS cnt FROM album_like WHERE photo_id = ?`, [req.params.id]);
      ok(res, {likes: cnt});
    } catch (e) { handleError(res, e, '[album/photos/unlike]'); }
  });

  // ==================== 评论列表 ====================
  router.get('/photos/:id/comments', async (req, res) => {
    try {
      const [rows] = await getPool().query(
        `SELECT c.id, c.comment AS content, c.create_time AS createdAt, c.user_vrcid AS userVrcId,
                u.id AS userId, u.display_name AS userName, u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url
         FROM album_comment c LEFT JOIN users u ON c.user_vrcid = u.login_id
         WHERE c.photo_id=? ORDER BY c.create_time ASC`, [req.params.id]
      );
      const mapped = rows.map(r => ({
        id: r.id, content: r.content, createdAt: r.createdAt, userId: r.userId,
        userName: r.userName || r.userVrcId,
        avatarUrl: getAvatarUrl(r)
      }));
      res.json(mapped);
    } catch (e) { handleError(res, e, '[album/comments/list]'); }
  });

  // ==================== 发表评论 ====================
  router.post('/photos/:id/comments', async (req, res) => {
    const uid = getUserId(req);
    if (!uid) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, '请先登录');
    try {
      const { content } = req.body;
      if (!content) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请输入评论');
      if (typeof content !== 'string' || content.length > 2000) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '评论内容不能超过2000字');
      const name = req.session.displayName || '用户';
      const [photo] = await getPool().query(`SELECT upload_vrcid FROM album_photo WHERE id = ?`, [req.params.id]);
      await getPool().query(`INSERT INTO album_comment (photo_id, user_vrcid, user_name, comment) VALUES (?, ?, ?, ?)`,
        [req.params.id, req.session.loginId || uid, name, content]);
      if (photo.length > 0 && photo[0].upload_vrcid && photo[0].upload_vrcid !== uid && notificationService) {
        const [uploader] = await getPool().query(`SELECT id FROM users WHERE login_id = ?`, [photo[0].upload_vrcid]);
        if (uploader.length > 0) {
          notificationService.notifyUser(
            uploader[0].id,
            'comment',
            `${name} 评论了你的照片`,
            content.slice(0, 50),
            { targetType: 'album', targetId: parseInt(req.params.id) }
          );
        }
      }
      ok(res);
    } catch (e) { handleError(res, e, '[album/comments/create]'); }
  });

  // ==================== 编辑评论 ====================
  router.put('/photos/:photoId/comments/:commentId', async (req, res) => {
    const uid = getUserId(req);
    if (!uid) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, '请先登录');
    try {
      const commentId = parseInt(req.params.commentId);
      const photoId = parseInt(req.params.photoId);
      const { content } = req.body;
      if (!commentId || !photoId) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      if (!content || !content.trim()) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请输入评论内容');
      if (typeof content !== 'string' || content.length > 2000) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '评论内容不能超过2000字');
      const [comments] = await getPool().query(`SELECT user_vrcid FROM album_comment WHERE id=? AND photo_id=?`, [commentId, photoId]);
      if (!comments.length) return sendError(res, 404, ErrorCodes.NOT_FOUND, '评论不存在');
      const userRole = ROLE_LEVEL[req.session.role] || 0;
      const currentLogin = req.session.loginId || uid;
      if (comments[0].user_vrcid !== currentLogin && userRole < ROLE_LEVEL.admin) {
        return sendError(res, 403, ErrorCodes.FORBIDDEN, '无权编辑此评论');
      }
      await getPool().query(`UPDATE album_comment SET comment=? WHERE id=?`, [content.trim(), commentId]);
      ok(res, {content: content.trim()});
    } catch (e) { handleError(res, e, '[album/comments/update]'); }
  });

  // ==================== 删除评论 ====================
  router.delete('/photos/:photoId/comments/:commentId', async (req, res) => {
    const uid = getUserId(req);
    if (!uid) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, '请先登录');
    try {
      const userRole = ROLE_LEVEL[req.session.role] || 0;
      if (userRole >= ROLE_LEVEL.admin) {
        await getPool().query(`DELETE FROM album_comment WHERE id=?`, [req.params.commentId]);
      } else {
        await getPool().query(`DELETE FROM album_comment WHERE id=? AND user_vrcid=?`, [req.params.commentId, req.session.loginId || uid]);
      }
      ok(res);
    } catch (e) { handleError(res, e, '[album/comments/delete]'); }
  });

  // ==================== 用户已点赞 ID 列表 ====================
  router.get('/album/my-likes', async (req, res) => {
    const uid = getUserId(req);
    if (!uid) return res.json({ likedIds: [] });
    try {
      const [rows] = await getPool().query(`SELECT photo_id FROM album_like WHERE user_vrcid = ?`, [uid]);
      res.json({ likedIds: rows.map(r => r.photo_id) });
    } catch (e) { logger.error('album', e); res.json({ likedIds: [] }); }
  });

  // ==================== 批量删除 ====================
  router.post('/album/photos/batch-delete', async (req, res) => {
    const uid = getUserId(req);
    if (!uid) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, '请先登录');
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请选择照片');
    if (ids.length > 50) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '单次最多操作 50 张照片');
    try {
      const isAdminUser = req.session?.role && ['super_admin', 'admin'].includes(req.session.role);
      const placeholders = ids.map(() => '?').join(',');
      const [photos] = await getPool().query(`SELECT id, upload_vrcid FROM album_photo WHERE id IN (${placeholders}) AND is_recycle = 0`, ids);
      const validIds = photos.filter(p => isAdminUser || p.upload_vrcid === uid).map(p => p.id);
      if (validIds.length === 0) return sendError(res, 403, ErrorCodes.FORBIDDEN, '无权删除所选照片');
      await getPool().query(`UPDATE album_photo SET is_recycle = 1, recycle_time = NOW() WHERE id IN (${validIds.map(() => '?').join(',')})`, validIds);
      await logOper(uid, '批量删除照片', `IDs: ${validIds.join(',')}`);
      ok(res, {count: validIds.length});
    } catch (e) { handleError(res, e, '[album/photos/batch-delete]'); }
  });

  // ==================== 回收站 ====================
  router.get('/album/recycle', requireAdminCompat, async (req, res) => {
    try {
      const [rows] = await getPool().query(
        `SELECT p.id, p.photo_path AS path, p.thumb_path AS thumbPath, p.photo_desc AS \`desc\`,
                p.upload_name AS uploaderName, p.recycle_time AS recycleTime
         FROM album_photo p WHERE p.is_recycle = 1 ORDER BY p.recycle_time DESC LIMIT 50`
      );
      res.json(rows);
    } catch (e) { handleError(res, e, '[album/recycle/list]'); }
  });

  router.post('/album/photos/:id/restore', requireAdminCompat, async (req, res) => {
    try {
      const [result] = await getPool().query(`UPDATE album_photo SET is_recycle = 0, recycle_time = NULL WHERE id = ? AND is_recycle = 1`, [req.params.id]);
      if (result.affectedRows === 0) return sendError(res, 404, ErrorCodes.NOT_FOUND, '照片不存在或不在回收站');
      try { await logOper(req.session.userId, '还原照片', `照片#${req.params.id}`); } catch (_) {}
      ok(res);
    } catch (e) { handleError(res, e, '[album/recycle/restore]'); }
  });

  router.delete('/album/photos/:id/permanent', requireAdminCompat, async (req, res) => {
    try {
      const [photos] = await getPool().query(`SELECT photo_path, thumb_path FROM album_photo WHERE id = ? AND is_recycle = 1`, [req.params.id]);
      if (photos.length === 0) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '只能永久删除回收站中的照片');
      try { fs.unlinkSync(path.join(ROOT_DIR, photos[0].photo_path)); } catch {}
      if (photos[0].thumb_path !== photos[0].photo_path) { try { fs.unlinkSync(path.join(ROOT_DIR, photos[0].thumb_path)); } catch {} }
      await getPool().query(`DELETE FROM album_like WHERE photo_id = ?`, [req.params.id]);
      await getPool().query(`DELETE FROM album_comment WHERE photo_id = ?`, [req.params.id]);
      await getPool().query(`DELETE FROM notifications WHERE target_type='comment' AND target_id=?`, [req.params.id]);
      await getPool().query(`DELETE FROM album_photo WHERE id = ?`, [req.params.id]);
      try { await logOper(req.session.userId, '永久删除照片', `照片#${req.params.id}`); } catch (_) {}
      ok(res);
    } catch (e) { handleError(res, e, '[album/recycle/permanent]'); }
  });

  // ==================== 文件上传（照片/视频上传） ====================
  const photoUpload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => { if (!fs.existsSync(ALBUM_DIR)) fs.mkdirSync(ALBUM_DIR, { recursive: true }); cb(null, ALBUM_DIR); },
      filename: (req, file, cb) => { cb(null, `media_${Date.now()}_${Math.round(Math.random() * 1000)}${path.extname(file.originalname)}`); }
    }),
    limits: { fileSize: 500 * 1024 * 1024 },
    fileFilter: createFileFilter(['IMAGE', 'VIDEO'])
  });

  router.post('/album/upload', async (req, res) => {
    const uid = getUserId(req);
    if (!uid) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, '请先登录');
    secureUpload(photoUpload.single('photo'))(req, res, async (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') return sendError(res, 400, ErrorCodes.BAD_REQUEST, '文件超过大小限制(500MB)');
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '文件上传失败，请检查文件大小与格式');
      }
      if (!req.file) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请选择文件');
      const isVideo = req.file.mimetype.startsWith('video/');
      try {
        let photoPath, thumbPath, fileSize;
        if (isVideo) {
          const videoName = `video_${Date.now()}_${Math.round(Math.random() * 10000)}${path.extname(req.file.originalname)}`;
          const fullVideoPath = path.join(ALBUM_DIR, videoName);
          if (!isWithinAlbum(fullVideoPath)) { try { fs.unlinkSync(req.file.path); } catch {} return sendError(res, 400, ErrorCodes.BAD_REQUEST, '非法存储路径'); }
          photoPath = `assets/album/${videoName}`;
          fileSize = req.file.size;
          fs.renameSync(req.file.path, fullVideoPath);
          // 尝试提取视频帧作为缩略图，失败则使用占位图
          const thumbName = await extractVideoThumbnail(fullVideoPath, ALBUM_DIR);
          if (thumbName) {
            thumbPath = `assets/album/${thumbName}`;
          } else {
            thumbPath = `assets/album/thumb_video_placeholder.png`;
            const placeholderPath = path.join(ALBUM_DIR, 'thumb_video_placeholder.png');
            if (!fs.existsSync(placeholderPath)) {
              try { await sharp({ create: { width: 300, height: 300, channels: 3, background: { r: 30, g: 30, b: 50 } } }).png().toFile(placeholderPath); } catch {}
            }
          }
        } else {
          const ext = '.jpg';
          const photoName = `photo_${Date.now()}_${Math.round(Math.random() * 10000)}${ext}`;
          const thumbName = `thumb_${photoName}`;
          photoPath = `assets/album/${photoName}`;
          thumbPath = `assets/album/${thumbName}`;
          fileSize = req.file.size;
          const fullPhotoPath = path.join(ALBUM_DIR, photoName);
          const fullThumbPath = path.join(ALBUM_DIR, thumbName);
          if (!isWithinAlbum(fullPhotoPath) || !isWithinAlbum(fullThumbPath)) { try { fs.unlinkSync(req.file.path); } catch {} return sendError(res, 400, ErrorCodes.BAD_REQUEST, '非法存储路径'); }
          await sharp(req.file.path).resize(1920, 1080, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toFile(fullPhotoPath);
          await sharp(req.file.path).resize(300, 300, { fit: 'cover' }).jpeg({ quality: 75 }).toFile(fullThumbPath);
          try { fs.unlinkSync(req.file.path); } catch {}
        }
        const cateId = parseInt(req.body.cateId) || 1;
        const eventId = req.body.eventId ? parseInt(req.body.eventId) : null;
        const [result] = await getPool().query(
          `INSERT INTO album_photo (photo_path, thumb_path, photo_desc, upload_vrcid, upload_name, media_type, file_size, cate_id, event_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [photoPath, thumbPath, req.body.caption || '', uid, req.session.displayName || '', isVideo ? 'video' : 'image', fileSize, cateId, eventId]
        );
        ok(res, {id: result.insertId, url: '/' + photoPath, thumbnail: '/' + thumbPath, mediaType: isVideo ? 'video' : 'image'});
      } catch (e) {
        try { if (req.file && req.file.path) fs.unlinkSync(req.file.path); } catch {}
        handleError(res, e, '[album/upload]');
      }
    });
  });

  
// ==================== 精选照片（首页/相册 Tab 用） ====================
// 按点赞数 + 创建时间排序，返回未回收的相册照片供精选位使用。
// 之前曾被前端误调（404），此处补齐兜底接口，避免历史残留脚本再次踩坑。
router.get('/album/featured', async (req, res) => {
  try {
    const limit = Math.min(30, Math.max(1, parseInt(req.query.limit) || 12));
    const [rows] = await getPool().query(
      `SELECT p.id, p.cate_id AS cateId, p.event_id AS eventId, p.photo_path AS url, p.thumb_path AS thumbnail, p.photo_desc AS caption, p.upload_vrcid AS uploader, p.upload_name AS uploaderName, p.like_count AS likes, p.media_type AS mediaType, p.file_size AS fileSize, p.create_time AS createTime
       FROM album_photo p WHERE p.is_recycle = 0
       ORDER BY p.like_count DESC, p.create_time DESC LIMIT ?`,
      [limit]
    );
    ok(res, {photos: rows, total: rows.length});
  } catch (e) { handleError(res, e, '[album/featured]'); }
});

router.get('/album/search', async (req, res) => {
  try {
    const q = req.query.q ? req.query.q.trim() : '';
    if (!q || q.length < 2) return res.json({ photos: [], total: 0 });
    const like = '%' + q + '%';
    const [rows] = await getPool().query(
      'SELECT id, photo_path, thumb_path, photo_desc, media_type, file_size, cate_id, event_id, upload_name, upload_time FROM album_photo WHERE photo_desc LIKE ? AND recycle_time IS NULL ORDER BY upload_time DESC LIMIT 20',
      [like]
    );
    const photos = rows.map(p => ({
      ...p,
      url: '/' + p.photo_path,
      thumbnail: '/' + p.thumb_path,
      description: p.photo_desc.length > 50 ? p.photo_desc.substring(0, 50) + '…' : p.photo_desc
    }));
    res.json({ photos, total: photos.length });
  } catch (e) {
    handleError(res, e, '[album/search]');
  }
});


return router;
};
