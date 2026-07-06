/**
 * 境途同游 V6.6 — 用户资料系统路由
 * 用户资料 CRUD + 相册 + 照片 + 视频 + 隐私控制
 */
const express = require('express');
const router = express.Router();
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const { requireAuth } = require('../auth');
const { getPool, safeError } = require('../utils');
const { extractVideoThumbnail, getVideoDuration } = require('../video_utils');

const ROOT_DIR = path.join(__dirname, '..', '..');
const PROFILE_PHOTOS_DIR = path.join(ROOT_DIR, 'uploads', 'profile', 'photos');
const PROFILE_VIDEOS_DIR = path.join(ROOT_DIR, 'uploads', 'profile', 'videos');

// ==================== Multer 配置 ====================

const photoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(PROFILE_PHOTOS_DIR)) fs.mkdirSync(PROFILE_PHOTOS_DIR, { recursive: true });
    cb(null, PROFILE_PHOTOS_DIR);
  },
  filename: (req, file, cb) => {
    const uid = req.session?.userId || '0';
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `photo_${uid}_${Date.now()}${ext}`);
  }
});

const videoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(PROFILE_VIDEOS_DIR)) fs.mkdirSync(PROFILE_VIDEOS_DIR, { recursive: true });
    cb(null, PROFILE_VIDEOS_DIR);
  },
  filename: (req, file, cb) => {
    const uid = req.session?.userId || '0';
    const ext = path.extname(file.originalname) || '.mp4';
    cb(null, `video_${uid}_${Date.now()}${ext}`);
  }
});

const uploadPhoto = multer({
  storage: photoStorage,
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) return cb(null, true);
    cb(new Error('仅支持图片和视频文件'));
  }
});

const uploadVideo = multer({
  storage: videoStorage,
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.mp4', '.mov', '.avi', '.webm', '.mkv'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) return cb(null, true);
    cb(new Error('仅支持 MP4/MOV/AVI/WEBM/MKV 格式'));
  }
});

// ==================== 辅助函数 ====================

/**
 * 生成缩略图
 */
async function generateThumb(originalPath) {
  const parsed = path.parse(originalPath);
  const thumbPath = path.join(parsed.dir, `thumb_${parsed.name}.jpg`);
  try {
    await sharp(originalPath)
      .resize(400, null, { withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toFile(thumbPath);
    return thumbPath;
  } catch (e) {
    console.warn('[profile] 缩略图生成失败:', e.message);
    return '';
  }
}

/**
 * 构建隐私条件 SQL
 */
function privacyCondition(userId, isLoggedIn, tableAlias = '') {
  const col = tableAlias ? `${tableAlias}.privacy` : 'privacy';
  const ownerCol = tableAlias ? `${tableAlias}.user_id` : 'user_id';
  if (!isLoggedIn) {
    return `AND ${col} = 'public'`;
  }
  return `AND (${col} = 'public' OR (${col} = 'members_only' AND 1=1) OR (${col} = 'private' AND ${ownerCol} = ?))`;
}

/**
 * 构建隐私查询参数
 */
function privacyParams(userId, isLoggedIn) {
  if (!isLoggedIn) return [];
  return [userId];
}

/**
 * 获取头像 URL（与 auth.js 中 getAvatarUrl 逻辑一致）
 */
function getAvatarUrl(user) {
  if (user.avatar_type === 'custom' && user.custom_avatar_path) {
    return user.custom_avatar_path;
  }
  if (user.avatar_type === 'vrchat' && user.vrchat_avatar_url) {
    return user.vrchat_avatar_url;
  }
  return null;
}

// ==================== 路由 ====================

/**
 * GET /:userId - 获取用户公开资料
 */
router.get('/:userId', async (req, res) => {
  try {
    const targetUserId = parseInt(req.params.userId, 10);
    const currentUserId = req.session?.userId;
    const isLoggedIn = !!currentUserId;

    // 查询用户基本信息
    const [users] = await getPool().query(
      `SELECT id, login_id AS loginId, display_name AS displayName,
              avatar_type, custom_avatar_path, vrchat_avatar_url,
              role, vrchat_id AS vrchatId, vrchat_name AS vrchatName,
              birthday
       FROM users WHERE id = ? AND deleted_at IS NULL`,
      [targetUserId]
    );
    if (!users.length) return res.status(404).json({ error: '用户不存在' });

    const user = users[0];

    // 查询资料
    const [profiles] = await getPool().query(
      `SELECT motto, bio, cover_image AS coverImage,
              location, website, social_links AS socialLinks
       FROM user_profile WHERE user_id = ?`,
      [targetUserId]
    );
    const profile = profiles.length ? profiles[0] : {
      motto: '', bio: '', coverImage: '', location: '', website: '', socialLinks: null
    };

    // 查询相册（隐私控制）
    let albumsSql = `SELECT id, user_id AS userId, name, description, cover_photo AS coverPhoto,
                      sort, privacy, photo_count AS photoCount,
                      created_at AS createdAt, updated_at AS updatedAt
               FROM user_albums WHERE user_id = ?`;
    let albumsParams = [targetUserId];
    if (targetUserId !== currentUserId) {
      albumsSql += ' ' + privacyCondition(targetUserId, isLoggedIn);
      albumsParams = albumsParams.concat(privacyParams(targetUserId, isLoggedIn));
    }
    albumsSql += ' ORDER BY sort ASC, created_at DESC';
    const [albums] = await getPool().query(albumsSql, albumsParams);

    // 查询视频（隐私控制）
    let videosSql = `SELECT id, user_id AS userId, title, description,
                      video_path AS videoPath, thumb_path AS thumbPath,
                      duration, privacy, view_count AS viewCount,
                      created_at AS createdAt
               FROM user_videos WHERE user_id = ?`;
    let videosParams = [targetUserId];
    if (targetUserId !== currentUserId) {
      videosSql += ' ' + privacyCondition(targetUserId, isLoggedIn);
      videosParams = videosParams.concat(privacyParams(targetUserId, isLoggedIn));
    }
    videosSql += ' ORDER BY created_at DESC';
    const [videos] = await getPool().query(videosSql, videosParams);
    // 为前端映射 thumbnailUrl
    const mappedVideos = videos.map(v => ({
      ...v,
      thumbnailUrl: v.thumbPath ? '/' + v.thumbPath.replace(/\\/g, '/') : null
    }));

    res.json({
      user: {
        id: user.id,
        loginId: user.loginId,
        displayName: user.displayName,
        avatarUrl: getAvatarUrl(user),
        role: user.role,
        vrchatId: user.vrchatId,
        vrchatName: user.vrchatName,
        birthday: user.birthday
      },
      profile,
      albums,
      videos: mappedVideos
    });
  } catch (e) {
    console.error('[profile] GET /:userId error:', e);
    res.status(500).json({ error: safeError(e.message) });
  }
});

/**
 * POST /update - 更新自己的资料（需登录）
 */
router.post('/update', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const { motto, bio, coverImage, location, website, socialLinks, privacySettings } = req.body;

    // upsert user_profile
    await getPool().query(
      `INSERT INTO user_profile (user_id, motto, bio, cover_image, location, website, social_links, privacy_settings)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         motto = VALUES(motto),
         bio = VALUES(bio),
         cover_image = VALUES(cover_image),
         location = VALUES(location),
         website = VALUES(website),
         social_links = VALUES(social_links),
         privacy_settings = VALUES(privacy_settings)`,
      [
        userId,
        motto || '',
        bio || null,
        coverImage || '',
        location || '',
        website || '',
        socialLinks ? JSON.stringify(socialLinks) : null,
        privacySettings ? JSON.stringify(privacySettings) : null
      ]
    );

    res.json({ success: true, message: '资料更新成功' });
  } catch (e) {
    console.error('[profile] POST /update error:', e);
    res.status(500).json({ error: safeError(e.message) });
  }
});

// ==================== 相册路由 ====================

/**
 * GET /:userId/albums - 获取用户相册列表
 */
router.get('/:userId/albums', async (req, res) => {
  try {
    const targetUserId = parseInt(req.params.userId, 10);
    const currentUserId = req.session?.userId;
    const isLoggedIn = !!currentUserId;

    let sql = `SELECT id, user_id AS userId, name, description, cover_photo AS coverPhoto,
                sort, privacy, photo_count AS photoCount,
                created_at AS createdAt, updated_at AS updatedAt
         FROM user_albums WHERE user_id = ?`;
    let params = [targetUserId];

    if (targetUserId !== currentUserId) {
      sql += ' ' + privacyCondition(targetUserId, isLoggedIn);
      params = params.concat(privacyParams(targetUserId, isLoggedIn));
    }
    sql += ' ORDER BY sort ASC, created_at DESC';

    const [albums] = await getPool().query(sql, params);
    res.json({ albums });
  } catch (e) {
    console.error('[profile] GET /:userId/albums error:', e);
    res.status(500).json({ error: safeError(e.message) });
  }
});

/**
 * POST /albums - 创建相册（需登录）
 */
router.post('/albums', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const { name, description, privacy } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: '相册名称不能为空' });
    }

    const [result] = await getPool().query(
      `INSERT INTO user_albums (user_id, name, description, privacy)
       VALUES (?, ?, ?, ?)`,
      [userId, name.trim(), description || null, privacy || 'public']
    );

    res.json({
      success: true,
      album: { id: result.insertId, userId, name: name.trim(), description: description || null, privacy: privacy || 'public', photoCount: 0 }
    });
  } catch (e) {
    console.error('[profile] POST /albums error:', e);
    res.status(500).json({ error: safeError(e.message) });
  }
});

/**
 * PUT /albums/:id - 编辑相册（需登录，仅拥有者）
 */
router.put('/albums/:id', requireAuth, async (req, res) => {
  try {
    const albumId = parseInt(req.params.id, 10);
    const userId = req.session.userId;
    const { name, description, privacy, sort, coverPhoto } = req.body;

    const [albums] = await getPool().query(
      `SELECT id, user_id FROM user_albums WHERE id = ?`, [albumId]
    );
    if (!albums.length) return res.status(404).json({ error: '相册不存在' });
    if (albums[0].user_id !== userId) return res.status(403).json({ error: '无权编辑此相册' });

    const updates = [];
    const values = [];
    if (name !== undefined) { updates.push('name = ?'); values.push(name.trim()); }
    if (description !== undefined) { updates.push('description = ?'); values.push(description); }
    if (privacy !== undefined) { updates.push('privacy = ?'); values.push(privacy); }
    if (sort !== undefined) { updates.push('sort = ?'); values.push(sort); }
    if (coverPhoto !== undefined) { updates.push('cover_photo = ?'); values.push(coverPhoto); }

    if (updates.length > 0) {
      values.push(albumId);
      await getPool().query(`UPDATE user_albums SET ${updates.join(', ')} WHERE id = ?`, values);
    }

    res.json({ success: true, message: '相册已更新' });
  } catch (e) {
    console.error('[profile] PUT /albums/:id error:', e);
    res.status(500).json({ error: safeError(e.message) });
  }
});

/**
 * PUT /albums/:id/privacy - 更新相册隐私设置（需登录，仅拥有者）
 */
router.put('/albums/:id/privacy', requireAuth, async (req, res) => {
  try {
    const albumId = parseInt(req.params.id, 10);
    const userId = req.session.userId;
    const { privacy } = req.body;

    if (!['public', 'members_only', 'private'].includes(privacy)) {
      return res.status(400).json({ error: '无效的隐私设置' });
    }

    const [albums] = await getPool().query(
      `SELECT id, user_id FROM user_albums WHERE id = ?`, [albumId]
    );
    if (!albums.length) return res.status(404).json({ error: '相册不存在' });
    if (albums[0].user_id !== userId) return res.status(403).json({ error: '无权修改此相册' });

    await getPool().query(`UPDATE user_albums SET privacy = ? WHERE id = ?`, [privacy, albumId]);

    res.json({ success: true, message: '隐私设置已更新' });
  } catch (e) {
    console.error('[profile] PUT /albums/:id/privacy error:', e);
    res.status(500).json({ error: safeError(e.message) });
  }
});

/**
 * DELETE /albums/:id - 删除相册（需登录，仅拥有者）
 */
router.delete('/albums/:id', requireAuth, async (req, res) => {
  try {
    const albumId = parseInt(req.params.id, 10);
    const userId = req.session.userId;

    const [albums] = await getPool().query(
      `SELECT id, user_id FROM user_albums WHERE id = ?`, [albumId]
    );
    if (!albums.length) return res.status(404).json({ error: '相册不存在' });
    if (albums[0].user_id !== userId) return res.status(403).json({ error: '无权删除此相册' });

    // 删除相册下所有照片
    const [photos] = await getPool().query(
      `SELECT photo_path, thumb_path FROM user_photos WHERE album_id = ?`, [albumId]
    );
    for (const p of photos) {
      try { if (p.photo_path) fs.unlinkSync(path.join(ROOT_DIR, p.photo_path)); } catch (_) {}
      try { if (p.thumb_path) fs.unlinkSync(path.join(ROOT_DIR, p.thumb_path)); } catch (_) {}
    }
    await getPool().query(`DELETE FROM user_photos WHERE album_id = ?`, [albumId]);
    await getPool().query(`DELETE FROM user_albums WHERE id = ?`, [albumId]);

    res.json({ success: true, message: '相册已删除' });
  } catch (e) {
    console.error('[profile] DELETE /albums/:id error:', e);
    res.status(500).json({ error: safeError(e.message) });
  }
});

// ==================== 照片路由 ====================

/**
 * POST /albums/:id/photos - 上传照片到相册
 */
router.post('/albums/:id/photos', requireAuth, uploadPhoto.array('photos', 20), async (req, res) => {
  try {
    const albumId = parseInt(req.params.id, 10);
    const userId = req.session.userId;

    const [albums] = await getPool().query(
      `SELECT id, user_id FROM user_albums WHERE id = ?`, [albumId]
    );
    if (!albums.length) return res.status(404).json({ error: '相册不存在' });
    if (albums[0].user_id !== userId) return res.status(403).json({ error: '无权上传到此相册' });

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: '请选择要上传的文件' });
    }

    const uploadedPhotos = [];
    for (const file of req.files) {
      const isVideo = file.mimetype.startsWith('video/');
      let thumbPath = '';
      let fileSize = file.size || 0;

      if (isVideo) {
        // 视频：尝试提取帧缩略图，失败则使用占位图
        const tn = await extractVideoThumbnail(file.path);
        if (tn) {
          thumbPath = path.relative(ROOT_DIR, path.join(path.dirname(file.path), tn)).replace(/\\/g, '/');
        } else {
          const placeholderDir = path.join(ROOT_DIR, 'assets', 'album');
          if (!fs.existsSync(placeholderDir)) fs.mkdirSync(placeholderDir, { recursive: true });
          const placeholderPath = path.join(placeholderDir, 'thumb_video_placeholder.png');
          if (!fs.existsSync(placeholderPath)) {
            try {
              await sharp({ create: { width: 300, height: 300, channels: 3, background: { r: 30, g: 30, b: 50 } } }).png().toFile(placeholderPath);
            } catch (_) {}
          }
          thumbPath = 'assets/album/thumb_video_placeholder.png';
        }
      } else {
        // 图片：生成缩略图
        thumbPath = await generateThumb(file.path);
        thumbPath = thumbPath ? path.relative(ROOT_DIR, thumbPath).replace(/\\/g, '/') : '';
      }

      // 保存相对路径
      const relativePath = path.relative(ROOT_DIR, file.path).replace(/\\/g, '/');

      const [result] = await getPool().query(
        `INSERT INTO user_photos (album_id, user_id, photo_path, thumb_path, description, media_type, file_size)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [albumId, userId, relativePath, thumbPath, req.body.description || null, isVideo ? 'video' : 'image', fileSize]
      );

      uploadedPhotos.push({
        id: result.insertId,
        albumId,
        userId,
        photoPath: relativePath,
        thumbPath: thumbPath,
        mediaType: isVideo ? 'video' : 'image',
        fileSize,
        description: req.body.description || null
      });
    }

    // 更新相册照片计数和封面
    const [countRows] = await getPool().query(
      `SELECT COUNT(*) AS cnt FROM user_photos WHERE album_id = ?`, [albumId]
    );
    const photoCount = countRows[0].cnt;
    let coverPhoto = albums[0].cover_photo;
    if (!coverPhoto && uploadedPhotos.length > 0) {
      coverPhoto = uploadedPhotos[0].thumbPath || uploadedPhotos[0].photoPath;
    }
    await getPool().query(
      `UPDATE user_albums SET photo_count = ?, cover_photo = COALESCE(NULLIF(cover_photo, ''), ?) WHERE id = ?`,
      [photoCount, coverPhoto, albumId]
    );

    res.json({ success: true, photos: uploadedPhotos, photoCount });
  } catch (e) {
    console.error('[profile] POST /albums/:id/photos error:', e);
    res.status(500).json({ error: safeError(e.message) });
  }
});

/**
 * GET /albums/:id/photos - 获取相册照片列表
 */
router.get('/albums/:id/photos', async (req, res) => {
  try {
    const albumId = parseInt(req.params.id, 10);
    const currentUserId = req.session?.userId;

    // 查询相册信息
    const [albums] = await getPool().query(
      `SELECT id, user_id AS userId, privacy FROM user_albums WHERE id = ?`, [albumId]
    );
    if (!albums.length) return res.status(404).json({ error: '相册不存在' });

    const album = albums[0];

    // 隐私检查
    if (album.userId !== currentUserId) {
      if (album.privacy === 'private') return res.status(403).json({ error: '该相册为私密相册' });
      if (album.privacy === 'members_only' && !currentUserId) {
        return res.status(401).json({ error: '请先登录' });
      }
    }

    const [photos] = await getPool().query(
      `SELECT id, album_id AS albumId, user_id AS userId,
              photo_path AS photoPath, thumb_path AS thumbPath,
              description, sort, like_count AS likeCount,
              comment_count AS commentCount,
              media_type AS mediaType, file_size AS fileSize,
              created_at AS createdAt
       FROM user_photos WHERE album_id = ?
       ORDER BY sort ASC, created_at DESC`, [albumId]
    );

    res.json({ albumId, photos });
  } catch (e) {
    console.error('[profile] GET /albums/:id/photos error:', e);
    res.status(500).json({ error: safeError(e.message) });
  }
});

/**
 * DELETE /photos/:id - 删除单张照片
 */
router.delete('/photos/:id', requireAuth, async (req, res) => {
  try {
    const photoId = parseInt(req.params.id, 10);
    const userId = req.session.userId;

    const [photos] = await getPool().query(
      `SELECT id, user_id, album_id, photo_path, thumb_path FROM user_photos WHERE id = ?`, [photoId]
    );
    if (!photos.length) return res.status(404).json({ error: '照片不存在' });
    if (photos[0].user_id !== userId) return res.status(403).json({ error: '无权删除此照片' });

    const photo = photos[0];

    // 删除文件
    try { if (photo.photo_path) fs.unlinkSync(path.join(ROOT_DIR, photo.photo_path)); } catch (_) {}
    try { if (photo.thumb_path) fs.unlinkSync(path.join(ROOT_DIR, photo.thumb_path)); } catch (_) {}

    // 删除数据库记录
    await getPool().query(`DELETE FROM user_photos WHERE id = ?`, [photoId]);

    // 更新相册照片计数
    const [countRows] = await getPool().query(
      `SELECT COUNT(*) AS cnt FROM user_photos WHERE album_id = ?`, [photo.album_id]
    );
    const photoCount = countRows[0].cnt;

    // 如果删除的恰好是封面，重新选择封面
    const [albums] = await getPool().query(
      `SELECT cover_photo FROM user_albums WHERE id = ?`, [photo.album_id]
    );
    let coverPhoto = albums[0]?.cover_photo;
    if (photoCount === 0) {
      coverPhoto = '';
    } else if (coverPhoto === photo.photo_path || coverPhoto === photo.thumb_path) {
      const [firstPic] = await getPool().query(
        `SELECT thumb_path, photo_path FROM user_photos WHERE album_id = ? ORDER BY sort ASC, created_at ASC LIMIT 1`,
        [photo.album_id]
      );
      coverPhoto = firstPic[0]?.thumb_path || firstPic[0]?.photo_path || '';
    }

    await getPool().query(
      `UPDATE user_albums SET photo_count = ?, cover_photo = ? WHERE id = ?`,
      [photoCount, coverPhoto, photo.album_id]
    );

    res.json({ success: true, message: '照片已删除', photoCount });
  } catch (e) {
    console.error('[profile] DELETE /photos/:id error:', e);
    res.status(500).json({ error: safeError(e.message) });
  }
});

// ==================== 视频路由 ====================

/**
 * POST /videos - 上传视频（需登录）
 */
router.post('/videos', requireAuth, uploadVideo.single('video'), async (req, res) => {
  try {
    const userId = req.session.userId;

    if (!req.file) {
      return res.status(400).json({ error: '请选择要上传的视频' });
    }

    const { title, description, privacy } = req.body;
    if (!title || !title.trim()) {
      // 删除已上传文件
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      return res.status(400).json({ error: '视频标题不能为空' });
    }

    const relativePath = path.relative(ROOT_DIR, req.file.path).replace(/\\/g, '/');

    const [result] = await getPool().query(
      `INSERT INTO user_videos (user_id, title, description, video_path, privacy, file_size)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, title.trim(), description || null, relativePath, privacy || 'public', req.file.size || 0]
    );

    // 异步提取缩略图和时长（不阻塞响应）
    (async () => {
      try {
        const tn = await extractVideoThumbnail(req.file.path);
        if (tn) {
          const thumbRel = path.relative(ROOT_DIR, path.join(path.dirname(req.file.path), tn)).replace(/\\/g, '/');
          const duration = await getVideoDuration(req.file.path);
          await getPool().query(
            `UPDATE user_videos SET thumb_path = ?, duration = ? WHERE id = ?`,
            [thumbRel, duration > 0 ? duration : 0, result.insertId]
          );
        }
      } catch (_) { /* 静默处理 */ }
    })();

    res.json({
      success: true,
      video: {
        id: result.insertId,
        userId,
        title: title.trim(),
        description: description || null,
        videoPath: relativePath,
        thumbnail: null,  // 异步生成后更新
        privacy: privacy || 'public',
        duration: 0,      // 异步获取后更新
        fileSize: req.file.size || 0
      }
    });
  } catch (e) {
    console.error('[profile] POST /videos error:', e);
    // 清理上传的文件
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch (_) {} }
    res.status(500).json({ error: safeError(e.message) });
  }
});

/**
 * GET /:userId/videos - 获取用户视频列表
 */
router.get('/:userId/videos', async (req, res) => {
  try {
    const targetUserId = parseInt(req.params.userId, 10);
    const currentUserId = req.session?.userId;
    const isLoggedIn = !!currentUserId;

    let sql = `SELECT id, user_id AS userId, title, description,
                video_path AS videoPath, thumb_path AS thumbPath,
                duration, file_size AS fileSize, privacy,
                view_count AS viewCount, created_at AS createdAt
         FROM user_videos WHERE user_id = ?`;
    let params = [targetUserId];

    if (targetUserId !== currentUserId) {
      sql += ' ' + privacyCondition(targetUserId, isLoggedIn);
      params = params.concat(privacyParams(targetUserId, isLoggedIn));
    }
    sql += ' ORDER BY created_at DESC';

    const [videos] = await getPool().query(sql, params);
    const mappedVideos = videos.map(v => ({
      ...v,
      thumbnailUrl: v.thumbPath ? '/' + v.thumbPath.replace(/\\/g, '/') : null
    }));
    res.json({ videos: mappedVideos });
  } catch (e) {
    console.error('[profile] GET /:userId/videos error:', e);
    res.status(500).json({ error: safeError(e.message) });
  }
});

/**
 * DELETE /videos/:id - 删除视频
 */
router.delete('/videos/:id', requireAuth, async (req, res) => {
  try {
    const videoId = parseInt(req.params.id, 10);
    const userId = req.session.userId;

    const [videos] = await getPool().query(
      `SELECT id, user_id, video_path, thumb_path FROM user_videos WHERE id = ?`, [videoId]
    );
    if (!videos.length) return res.status(404).json({ error: '视频不存在' });
    if (videos[0].user_id !== userId) return res.status(403).json({ error: '无权删除此视频' });

    const video = videos[0];

    // 删除文件
    try { if (video.video_path) fs.unlinkSync(path.join(ROOT_DIR, video.video_path)); } catch (_) {}
    try { if (video.thumb_path) fs.unlinkSync(path.join(ROOT_DIR, video.thumb_path)); } catch (_) {}

    await getPool().query(`DELETE FROM user_videos WHERE id = ?`, [videoId]);

    res.json({ success: true, message: '视频已删除' });
  } catch (e) {
    console.error('[profile] DELETE /videos/:id error:', e);
    res.status(500).json({ error: safeError(e.message) });
  }
});

/**
 * PUT /videos/:id/privacy - 更新视频隐私设置（需登录，仅拥有者）
 */
router.put('/videos/:id/privacy', requireAuth, async (req, res) => {
  try {
    const videoId = parseInt(req.params.id, 10);
    const userId = req.session.userId;
    const { privacy } = req.body;

    if (!['public', 'members_only', 'private'].includes(privacy)) {
      return res.status(400).json({ error: '无效的隐私设置' });
    }

    const [videos] = await getPool().query(
      `SELECT id, user_id FROM user_videos WHERE id = ?`, [videoId]
    );
    if (!videos.length) return res.status(404).json({ error: '视频不存在' });
    if (videos[0].user_id !== userId) return res.status(403).json({ error: '无权修改此视频' });

    await getPool().query(`UPDATE user_videos SET privacy = ? WHERE id = ?`, [privacy, videoId]);

    res.json({ success: true, message: '隐私设置已更新' });
  } catch (e) {
    console.error('[profile] PUT /videos/:id/privacy error:', e);
    res.status(500).json({ error: safeError(e.message) });
  }
});

module.exports = router;
