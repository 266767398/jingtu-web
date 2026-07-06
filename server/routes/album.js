/**
 * 境途同游 V6.14 — 相册路由（从 server.js 提取）
 * 涵盖：相册分类、照片列表/CRUD、点赞/评论、回收站、文件上传
 * 挂载前缀 /api — 内部路由路径有 /album/* 和 /photos/* 两类
 */
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const { getPool, safeError, logOper } = require('../utils');
const { extractVideoThumbnail, getVideoDuration } = require('../video_utils');
const { requireAdminCompat, ROLE_LEVEL, getAvatarUrl } = require('../auth');

/**
 * @param {object} authStateRef - 系统 VRChat 认证状态的引用对象
 */
module.exports = function (authStateRef) {
  const router = express.Router();

  const ROOT_DIR = path.join(__dirname, '..', '..');
  const ASSETS_DIR = path.join(ROOT_DIR, 'assets');
  const ALBUM_DIR = path.join(ASSETS_DIR, 'album');

  function getUserId(req) {
    return req.session?.userId || (authStateRef.loggedIn ? authStateRef.userId : null);
  }

  // ==================== 相册分类 ====================
  router.get('/album/categories', async (req, res) => {
    try {
      const [rows] = await getPool().query(`SELECT id, cate_name AS name, sort FROM album_cate ORDER BY sort ASC, id ASC`);
      res.json({ categories: rows });
    } catch (e) { console.error('[album]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  router.post('/album/categories', requireAdminCompat, async (req, res) => {
    try {
      const { name } = req.body;
      if (!name || !name.trim()) return res.status(400).json({ error: '请输入分类名称' });
      const [result] = await getPool().query(`INSERT INTO album_cate (cate_name) VALUES (?)`, [name.trim()]);
      res.json({ success: true, id: result.insertId });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: '该分类名称已存在' });
      console.error('[album]', e); res.status(500).json({ error: safeError(e.message) });
    }
  });

  router.delete('/album/categories/:id', requireAdminCompat, async (req, res) => {
    try {
      await getPool().query(`UPDATE album_photo SET cate_id=1 WHERE cate_id=?`, [req.params.id]);
      await getPool().query(`DELETE FROM album_cate WHERE id=? AND id!=1`, [req.params.id]);
      res.json({ success: true });
    } catch (e) { console.error('[album]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  // ==================== 照片列表 ====================
  router.get('/album/photos', async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const pageSize = 40;
      const offset = (page - 1) * pageSize;
      const cateId = parseInt(req.query.cate) || 0;
      let where = 'p.is_recycle=0';
      const params = [];
      if (cateId > 0) { where += ' AND p.cate_id=?'; params.push(cateId); }
      params.push(pageSize, offset);
      const [rows] = await getPool().query(
        `SELECT p.id, p.cate_id AS cateId, p.photo_path AS url, p.thumb_path AS thumbnail, p.photo_desc AS caption, p.upload_vrcid AS uploader, p.upload_name AS uploaderName, p.like_count AS likes, p.media_type AS mediaType, p.file_size AS fileSize, p.is_recycle AS isRecycle, p.recycle_time AS recycleTime, p.create_time AS createTime FROM album_photo p WHERE ${where} ORDER BY p.create_time DESC LIMIT ? OFFSET ?`,
        params
      );
      const [total] = await getPool().query(`SELECT COUNT(*) as c FROM album_photo p WHERE ${where}`, params.slice(0, -2));
      const hasMore = offset + pageSize < total[0].c;
      res.json({ photos: rows, hasMore });
    } catch (e) { console.error('[album]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  // ==================== 创建照片记录 ====================
  router.post('/photos', async (req, res) => {
    const uid = getUserId(req);
    if (!uid) return res.status(401).json({ error: '请先登录' });
    const { caption } = req.body;
    const photoPath = req.body.photo_path;
    const thumbPath = req.body.thumb_path;
    if (!photoPath || !thumbPath) return res.status(400).json({ error: '参数不全' });
    if (!photoPath.startsWith('assets/album/') || !thumbPath.startsWith('assets/album/')) {
      return res.status(400).json({ error: '路径不合法' });
    }
    try {
      const [result] = await getPool().query(
        `INSERT INTO album_photo (photo_path, thumb_path, photo_desc, upload_vrcid, upload_name) VALUES (?, ?, ?, ?, ?)`,
        [photoPath, thumbPath, caption || '', uid, req.session.displayName || '']
      );
      res.json({ success: true, id: result.insertId });
    } catch (e) { console.error('[album]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  // ==================== 更新照片描述 ====================
  router.put('/photos/:id', async (req, res) => {
    const uid = getUserId(req);
    if (!uid) return res.status(401).json({ error: '请先登录' });
    const { caption } = req.body;
    if (caption !== undefined && caption.length > 50000) return res.status(400).json({ error: '描述过长' });
    try {
      await getPool().query(
        `UPDATE album_photo SET photo_desc=? WHERE id=? AND (upload_vrcid=? OR ? IN (SELECT id FROM users WHERE role IN ('admin','super_admin')))`,
        [caption || '', req.params.id, uid, uid]
      );
      res.json({ success: true });
    } catch (e) { console.error('[album]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  // ==================== 删除照片（移至回收站） ====================
  router.delete('/photos/:id', async (req, res) => {
    const uid = getUserId(req);
    if (!uid) return res.status(401).json({ error: '请先登录' });
    const isAdminUser = req.session?.role && ['super_admin', 'admin'].includes(req.session.role);
    try {
      if (isAdminUser) {
        await getPool().query(`UPDATE album_photo SET is_recycle=1, recycle_time=NOW() WHERE id=?`, [req.params.id]);
      } else {
        await getPool().query(`UPDATE album_photo SET is_recycle=1, recycle_time=NOW() WHERE id=? AND upload_vrcid=?`, [req.params.id, uid]);
      }
      res.json({ success: true });
    } catch (e) { console.error('[album]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  // ==================== 点赞 ====================
  router.post('/photos/:id/like', async (req, res) => {
    const uid = getUserId(req);
    if (!uid) return res.status(401).json({ error: '请先登录' });
    try {
      await getPool().query(`INSERT IGNORE INTO album_like (photo_id, user_vrcid) VALUES (?, ?)`, [req.params.id, uid]);
      await getPool().query(`UPDATE album_photo SET like_count = (SELECT COUNT(*) FROM album_like WHERE photo_id = ?) WHERE id = ?`, [req.params.id, req.params.id]);
      const [[{ cnt }]] = await getPool().query(`SELECT COUNT(*) AS cnt FROM album_like WHERE photo_id = ?`, [req.params.id]);
      res.json({ success: true, likes: cnt });
    } catch (e) { console.error('[album]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  // ==================== 取消点赞 ====================
  router.delete('/photos/:id/like', async (req, res) => {
    const uid = getUserId(req);
    if (!uid) return res.status(401).json({ error: '请先登录' });
    try {
      await getPool().query(`DELETE FROM album_like WHERE photo_id=? AND user_vrcid=?`, [req.params.id, uid]);
      await getPool().query(`UPDATE album_photo SET like_count = (SELECT COUNT(*) FROM album_like WHERE photo_id = ?) WHERE id = ?`, [req.params.id, req.params.id]);
      const [[{ cnt }]] = await getPool().query(`SELECT COUNT(*) AS cnt FROM album_like WHERE photo_id = ?`, [req.params.id]);
      res.json({ success: true, likes: cnt });
    } catch (e) { console.error('[album]', e); res.status(500).json({ error: safeError(e.message) }); }
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
        avatarUrl: r.avatar_type === 'custom' ? r.custom_avatar_path : (r.vrchat_avatar_url || null)
      }));
      res.json(mapped);
    } catch (e) { console.error('[album]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  // ==================== 发表评论 ====================
  router.post('/photos/:id/comments', async (req, res) => {
    const uid = getUserId(req);
    if (!uid) return res.status(401).json({ error: '请先登录' });
    try {
      const { content } = req.body;
      if (!content) return res.status(400).json({ error: '请输入评论' });
      if (typeof content !== 'string' || content.length > 2000) return res.status(400).json({ error: '评论内容不能超过2000字' });
      const name = req.session.displayName || '用户';
      await getPool().query(`INSERT INTO album_comment (photo_id, user_vrcid, user_name, comment) VALUES (?, ?, ?, ?)`,
        [req.params.id, req.session.loginId || uid, name, content]);
      res.json({ success: true });
    } catch (e) { console.error('[album]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  // ==================== 删除评论 ====================
  router.delete('/photos/:photoId/comments/:commentId', async (req, res) => {
    const uid = getUserId(req);
    if (!uid) return res.status(401).json({ error: '请先登录' });
    try {
      const userRole = ROLE_LEVEL[req.session.role] || 0;
      if (userRole >= ROLE_LEVEL.admin) {
        await getPool().query(`DELETE FROM album_comment WHERE id=?`, [req.params.commentId]);
      } else {
        await getPool().query(`DELETE FROM album_comment WHERE id=? AND user_vrcid=?`, [req.params.commentId, req.session.loginId || uid]);
      }
      res.json({ success: true });
    } catch (e) { console.error('[album]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  // ==================== 用户已点赞 ID 列表 ====================
  router.get('/album/my-likes', async (req, res) => {
    const uid = getUserId(req);
    if (!uid) return res.json({ likedIds: [] });
    try {
      const [rows] = await getPool().query(`SELECT photo_id FROM album_like WHERE user_vrcid = ?`, [uid]);
      res.json({ likedIds: rows.map(r => r.photo_id) });
    } catch (e) { console.error('[album]', e); res.json({ likedIds: [] }); }
  });

  // ==================== 批量删除 ====================
  router.post('/album/photos/batch-delete', async (req, res) => {
    const uid = getUserId(req);
    if (!uid) return res.status(401).json({ error: '请先登录' });
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: '请选择照片' });
    if (ids.length > 50) return res.status(400).json({ error: '单次最多操作 50 张照片' });
    try {
      const isAdminUser = req.session?.role && ['super_admin', 'admin'].includes(req.session.role);
      const placeholders = ids.map(() => '?').join(',');
      const [photos] = await getPool().query(`SELECT id, upload_vrcid FROM album_photo WHERE id IN (${placeholders}) AND is_recycle = 0`, ids);
      const validIds = photos.filter(p => isAdminUser || p.upload_vrcid === uid).map(p => p.id);
      if (validIds.length === 0) return res.status(403).json({ error: '无权删除所选照片' });
      await getPool().query(`UPDATE album_photo SET is_recycle = 1, recycle_time = NOW() WHERE id IN (${validIds.map(() => '?').join(',')})`, validIds);
      await logOper(uid, '批量删除照片', `IDs: ${validIds.join(',')}`);
      res.json({ success: true, count: validIds.length });
    } catch (e) { console.error('[album]', e); res.status(500).json({ error: safeError(e.message) }); }
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
    } catch (e) { console.error('[album]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  router.post('/album/photos/:id/restore', requireAdminCompat, async (req, res) => {
    try {
      const [result] = await getPool().query(`UPDATE album_photo SET is_recycle = 0, recycle_time = NULL WHERE id = ? AND is_recycle = 1`, [req.params.id]);
      if (result.affectedRows === 0) return res.status(404).json({ error: '照片不存在或不在回收站' });
      res.json({ success: true });
    } catch (e) { console.error('[album]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  router.delete('/album/photos/:id/permanent', requireAdminCompat, async (req, res) => {
    try {
      const [photos] = await getPool().query(`SELECT photo_path, thumb_path FROM album_photo WHERE id = ? AND is_recycle = 1`, [req.params.id]);
      if (photos.length === 0) return res.status(400).json({ error: '只能永久删除回收站中的照片' });
      try { fs.unlinkSync(path.join(ROOT_DIR, photos[0].photo_path)); } catch {}
      if (photos[0].thumb_path !== photos[0].photo_path) { try { fs.unlinkSync(path.join(ROOT_DIR, photos[0].thumb_path)); } catch {} }
      await getPool().query(`DELETE FROM album_like WHERE photo_id = ?`, [req.params.id]);
      await getPool().query(`DELETE FROM album_comment WHERE photo_id = ?`, [req.params.id]);
      await getPool().query(`DELETE FROM album_photo WHERE id = ?`, [req.params.id]);
      res.json({ success: true });
    } catch (e) { console.error('[album]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  // ==================== 文件上传（照片/视频上传） ====================
  const photoUpload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => { if (!fs.existsSync(ALBUM_DIR)) fs.mkdirSync(ALBUM_DIR, { recursive: true }); cb(null, ALBUM_DIR); },
      filename: (req, file, cb) => { cb(null, `media_${Date.now()}_${Math.round(Math.random() * 1000)}${path.extname(file.originalname)}`); }
    }),
    limits: { fileSize: 200 * 1024 * 1024 },
    fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/'))
  });

  router.post('/upload', async (req, res) => {
    const uid = getUserId(req);
    if (!uid) return res.status(401).json({ error: '请先登录' });
    photoUpload.single('photo')(req, res, async (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: '文件超过大小限制(200MB)' });
        return res.status(400).json({ error: '上传失败: ' + (err.message || '') });
      }
      if (!req.file) return res.status(400).json({ error: '请选择文件' });
      const isVideo = req.file.mimetype.startsWith('video/');
      try {
        let photoPath, thumbPath, fileSize;
        if (isVideo) {
          const videoName = `video_${Date.now()}_${Math.round(Math.random() * 10000)}${path.extname(req.file.originalname)}`;
          const fullVideoPath = path.join(ALBUM_DIR, videoName);
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
          await sharp(req.file.path).resize(1920, 1080, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toFile(fullPhotoPath);
          await sharp(req.file.path).resize(300, 300, { fit: 'cover' }).jpeg({ quality: 75 }).toFile(fullThumbPath);
          try { fs.unlinkSync(req.file.path); } catch {}
        }
        const [result] = await getPool().query(
          `INSERT INTO album_photo (photo_path, thumb_path, photo_desc, upload_vrcid, upload_name, media_type, file_size${req.body.eventId ? ', event_id' : ''}) VALUES (?, ?, ?, ?, ?, ?, ?${req.body.eventId ? ', ?' : ''})`,
          req.body.eventId
            ? [photoPath, thumbPath, req.body.caption || '', uid, req.session.displayName || '', isVideo ? 'video' : 'image', fileSize, parseInt(req.body.eventId)]
            : [photoPath, thumbPath, req.body.caption || '', uid, req.session.displayName || '', isVideo ? 'video' : 'image', fileSize]
        );
        res.json({ success: true, id: result.insertId, url: '/' + photoPath, thumbnail: '/' + thumbPath, mediaType: isVideo ? 'video' : 'image' });
      } catch (e) {
        try { if (req.file && req.file.path) fs.unlinkSync(req.file.path); } catch {}
        res.status(500).json({ error: (isVideo ? '视频' : '图片') + '处理失败: ' + e.message });
      }
    });
  });

  return router;
};
