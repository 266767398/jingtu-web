/**
 * 境途同游 V6.6 — 用户资料系统路由
 * 用户资料 CRUD + 相册 + 照片 + 视频 + 隐私控制
 * 
 * @swagger
 * tags:
 *   name: Profile
 *   description: 用户资料相关接口
 */
const express = require('express');
const router = express.Router();
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const { requireAuth } = require('../auth');
const { ok,  getPool, getAvatarUrl, handleError , sendError, ErrorCodes, createFileFilter, secureUpload  } = require('../utils');;
const logger = require('../logger');
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
  fileFilter: createFileFilter(['IMAGE', 'VIDEO'])
});

const uploadVideo = multer({
  storage: videoStorage,
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: createFileFilter(['VIDEO'])
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
    logger.warn('profile', '[profile] 缩略图生成失败:', e.message);
    return '';
  }
}

/**
 * 构建隐私条件 SQL
 * members_only 仅对好友可见（杜绝"任意登录用户可见"的 1=1 恒真漏洞）
 * @param {number} ownerId   内容所属用户
 * @param {boolean} isLoggedIn 当前是否有登录态
 * @param {boolean} viewerIsFriend 当前用户是否为 owner 的好友（accepted）
 * @param {string} tableAlias 表别名
 */
function privacyCondition(ownerId, isLoggedIn, viewerIsFriend, tableAlias = '') {
  const col = tableAlias ? `${tableAlias}.privacy` : 'privacy';
  // 仅当 viewer 非 owner 时调用（调用方用 if(targetUserId!==currentUserId) 保证），
  // 故此处 viewer 必非 owner：private 内容仅 owner 本人可见，绝不对他人（含好友）可见。
  if (!isLoggedIn) {
    return `AND ${col} = 'public'`;
  }
  if (!viewerIsFriend) {
    // 非好友（已登录）：仅 public 可见
    return `AND ${col} = 'public'`;
  }
  // 好友：public + members_only 可见；private 不可见
  return `AND (${col} = 'public' OR ${col} = 'members_only')`;
}

/**
 * 构建隐私查询参数。
 * 新隐私条件已移除 private 的 user_id=? 占位子句，不再需要任何占位符，
 * 统一返回空数组，与 privacyCondition 生成的无 ? 片段保持一致，避免参数数量不匹配。
 */
function privacyParams(ownerId, isLoggedIn, viewerIsFriend) {
  return [];
}

/**
 * 判断 currentUserId 是否为 targetUserId 的已接受好友（内部 try-catch，失败按非好友）
 */
async function getViewerIsFriend(currentUserId, targetUserId) {
  if (!currentUserId || currentUserId === targetUserId) return !!currentUserId;
  try {
    const [fr] = await getPool().query(
      `SELECT 1 FROM user_friends WHERE user_id = ? AND friend_id = ? AND status = 'accepted'`,
      [currentUserId, targetUserId]
    );
    return fr.length > 0;
  } catch (e) {
    logger.warn('[profile] 好友关系查询失败，按非好友处理:', e.message);
    return false;
  }
}

// ==================== 路由 ====================

// `/:userId` 是一个通配路由，任何没被前面精确路由匹配到的单段路径都会落进来
// （例如用 GET 访问只支持 DELETE 的 /delete，或访问 /albums）。
// 以前这里直接 parseInt 后拿 NaN 去查库，数据库报错被当成 500 抛出，
// 用户只会看到"服务器错误"，日志里则是一条误导性的 SQL 异常。
// 统一在参数层拦截：非正整数一律 400。
router.param('userId', (req, res, next, value) => {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    return sendError(res, 400, ErrorCodes.BAD_REQUEST, '无效的用户ID');
  }
  req.targetUserId = id;
  next();
});

/**
 * GET /stats - 获取当前用户的统计数据
 */
router.get('/stats', requireAuth, async (req, res) => {
  const uid = req.session?.userId;
  if (!uid) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, '请先登录');
  try {
    const pool = getPool();
    const [posts] = await pool.query('SELECT COUNT(*) as c FROM posts WHERE user_id = ?', [uid]);
    // §34: album_photo 表用 upload_vrcid 存上传者标识（user.id 字符串），photos/comments 表不存在
    const [photos] = await pool.query('SELECT COUNT(*) as c FROM album_photo WHERE upload_vrcid = ?', [String(uid)]);
    const [events] = await pool.query('SELECT COUNT(*) as c FROM event WHERE create_user_id = ?', [uid]);
    const [comments] = await pool.query('SELECT COUNT(*) as c FROM post_comment WHERE user_id = ?', [uid]);
    res.json({
      posts: posts[0].c,
      photos: photos[0].c,
      events: events[0].c,
      comments: comments[0].c
    });
  } catch (e) { handleError(res, e, '[profile/stats]'); }
});

router.get('/export', requireAuth, async (req, res) => {
  const uid = req.session?.userId;
  if (!uid) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, '请先登录');
  try {
    const pool = getPool();
    const [users] = await pool.query('SELECT id, login_id, display_name, email, birthday, created_at FROM users WHERE id = ?', [uid]);
    const [profile] = await pool.query('SELECT * FROM profiles WHERE user_id = ?', [uid]);
    const [posts] = await pool.query('SELECT id, content, created_at FROM posts WHERE user_id = ?', [uid]);
    // §34: photos→album_photo（字段 url→photo_path、caption→photo_desc、created_at→create_time，用别名保持响应兼容）；comments→post_comment
    const [photos] = await pool.query('SELECT id, photo_path AS url, photo_desc AS caption, create_time AS created_at FROM album_photo WHERE upload_vrcid = ?', [String(uid)]);
    const [events] = await pool.query('SELECT id, title, description, created_at FROM event WHERE created_by = ?', [uid]);
    const [comments] = await pool.query('SELECT id, content, created_at FROM post_comment WHERE user_id = ?', [uid]);
    
    const data = {
      exportedAt: new Date().toISOString(),
      user: users[0] || null,
      profile: profile[0] || null,
      posts: posts.map ? posts : [],
      photos: photos.map ? photos : [],
      events: events.map ? events : [],
      comments: comments.map ? comments : []
    };
    
    const jsonStr = JSON.stringify(data, null, 2);
    const buffer = Buffer.from(jsonStr, 'utf-8');
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="user-data-${uid}-${Date.now()}.json"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (e) { handleError(res, e, '[profile/export]'); }
});

router.delete('/delete', requireAuth, async (req, res) => {
  const uid = req.session?.userId;
  if (!uid) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, '请先登录');
  let conn;
  try {
    const pool = getPool();
    conn = await pool.getConnection();
    await conn.beginTransaction();
    const [users] = await conn.query('SELECT login_id FROM users WHERE id = ? FOR UPDATE', [uid]);
    if (users.length === 0) {
      await conn.rollback();
      return sendError(res, 404, ErrorCodes.NOT_FOUND, '用户不存在');
    }
    const loginId = users[0].login_id;
    await conn.query('DELETE FROM user_like WHERE from_user_id = ? OR to_user_id = ?', [uid, uid]);
    await conn.query('DELETE FROM member_note WHERE owner_id = ? OR target_id = ?', [uid, uid]);
    await conn.query('DELETE FROM post_comment WHERE user_id = ?', [uid]);
    await conn.query('DELETE FROM posts WHERE user_id = ?', [uid]);
    await conn.query('DELETE FROM album_comment WHERE user_vrcid = ?', [loginId]);
    await conn.query('DELETE FROM album_like WHERE user_vrcid = ?', [loginId]);
    await conn.query('DELETE FROM album_comment WHERE photo_id IN (SELECT id FROM album_photo WHERE upload_vrcid = ?)', [String(uid)]);
    await conn.query('DELETE FROM album_like WHERE photo_id IN (SELECT id FROM album_photo WHERE upload_vrcid = ?)', [String(uid)]);
    await conn.query('DELETE FROM album_photo WHERE upload_vrcid = ?', [String(uid)]);
    await conn.query('DELETE FROM event WHERE create_user_id = ?', [uid]);
    await conn.query('DELETE FROM profiles WHERE user_id = ?', [uid]);
    await conn.query('DELETE FROM users WHERE id = ?', [uid]);
    await conn.commit();
    
    req.session.destroy(() => {
      res.clearCookie('connect.sid');
      ok(res, { message: '账号已删除' });
    });
  } catch (e) {
    if (conn) {
      try { await conn.rollback(); } catch (rollbackError) {
        logger.error('profile', '账号删除事务回滚失败:', rollbackError.message);
      }
    }
    handleError(res, e, '[profile/delete]');
  } finally {
    if (conn) conn.release();
  }
});

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
              birthday, location, bio
       FROM users WHERE id = ? AND deleted_at IS NULL`,
      [targetUserId]
    );
    if (!users.length) return sendError(res, 404, ErrorCodes.NOT_FOUND, '用户不存在');

    const user = users[0];

    // 好友关系判定（用于隐私墙：members_only 仅好友可见）
    const isSelf = currentUserId && currentUserId === targetUserId;
    let viewerIsFriend = false;
    if (currentUserId && !isSelf) {
      try {
        const [fr] = await getPool().query(
          `SELECT 1 FROM user_friends WHERE user_id = ? AND friend_id = ? AND status = 'accepted'`,
          [currentUserId, targetUserId]
        );
        viewerIsFriend = fr.length > 0;
      } catch (e) {
        logger.warn('[profile] 好友关系查询失败，按非好友处理:', e.message);
      }
    } else if (isSelf) {
      viewerIsFriend = true;
    }

    const canSeeSensitive = isSelf || viewerIsFriend;

    // 查询资料（user_profile 仅含 motto/bio；location 取自 users 主表）
    const [profiles] = await getPool().query(
      `SELECT motto, bio
       FROM user_profile WHERE vrchat_id = (SELECT vrchat_id FROM users WHERE id = ?)`,
      [targetUserId]
    );
    const profile = profiles.length ? profiles[0] : {
      motto: '', bio: ''
    };
    // location 优先取 users 主表（隐私：非好友/游客按隐私设置隐藏）
    profile.location = (user.location && (canSeeSensitive || user.location_visible)) ? user.location : '';

    // 查询相册（隐私控制）
    let albumsSql = `SELECT id, user_id AS userId, name, description, cover_photo AS coverPhoto,
                      sort, privacy, photo_count AS photoCount,
                      created_at AS createdAt, updated_at AS updatedAt
               FROM user_albums WHERE user_id = ?`;
    let albumsParams = [targetUserId];
    if (targetUserId !== currentUserId) {
      albumsSql += ' ' + privacyCondition(targetUserId, isLoggedIn, viewerIsFriend);
      albumsParams = albumsParams.concat(privacyParams(targetUserId, isLoggedIn, viewerIsFriend));
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
      videosSql += ' ' + privacyCondition(targetUserId, isLoggedIn, viewerIsFriend);
      videosParams = videosParams.concat(privacyParams(targetUserId, isLoggedIn, viewerIsFriend));
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
        // 隐私墙：vrchatId / vrchatName / birthday 仅本人或好友可见（游客/陌生者隐藏）
        vrchatId: canSeeSensitive ? user.vrchatId : null,
        vrchatName: canSeeSensitive ? user.vrchatName : null,
        birthday: canSeeSensitive ? user.birthday : null
      },
      profile,
      albums,
      videos: mappedVideos
    });
  } catch (e) {
    handleError(res, e, '[profile/get-user]');
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

    ok(res, { message: '资料更新成功' });
  } catch (e) {
    handleError(res, e, '[profile/update]');
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
    const viewerIsFriend = await getViewerIsFriend(currentUserId, targetUserId);

    let sql = `SELECT id, user_id AS userId, name, description, cover_photo AS coverPhoto,
                sort, privacy, photo_count AS photoCount,
                created_at AS createdAt, updated_at AS updatedAt
         FROM user_albums WHERE user_id = ?`;
    let params = [targetUserId];

    if (targetUserId !== currentUserId) {
      sql += ' ' + privacyCondition(targetUserId, isLoggedIn, viewerIsFriend);
      params = params.concat(privacyParams(targetUserId, isLoggedIn, viewerIsFriend));
    }
    sql += ' ORDER BY sort ASC, created_at DESC';

    const [albums] = await getPool().query(sql, params);
    res.json({ albums });
  } catch (e) {
    handleError(res, e, '[profile/albums]');
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
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '相册名称不能为空');
    }

    const [result] = await getPool().query(
      `INSERT INTO user_albums (user_id, name, description, privacy)
       VALUES (?, ?, ?, ?)`,
      [userId, name.trim(), description || null, privacy || 'public']
    );

    ok(res, {
      album: { id: result.insertId, userId, name: name.trim(), description: description || null, privacy: privacy || 'public', photoCount: 0 }
    });
  } catch (e) {
    handleError(res, e, '[profile/create-album]');
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
    if (!albums.length) return sendError(res, 404, ErrorCodes.NOT_FOUND, '相册不存在');
    if (albums[0].user_id !== userId) return sendError(res, 403, ErrorCodes.FORBIDDEN, '无权编辑此相册');

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

    ok(res, { message: '相册已更新' });
  } catch (e) {
    handleError(res, e, '[profile/update-album]');
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
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '无效的隐私设置');
    }

    const [albums] = await getPool().query(
      `SELECT id, user_id FROM user_albums WHERE id = ?`, [albumId]
    );
    if (!albums.length) return sendError(res, 404, ErrorCodes.NOT_FOUND, '相册不存在');
    if (albums[0].user_id !== userId) return sendError(res, 403, ErrorCodes.FORBIDDEN, '无权修改此相册');

    await getPool().query(`UPDATE user_albums SET privacy = ? WHERE id = ?`, [privacy, albumId]);

    ok(res, { message: '隐私设置已更新' });
  } catch (e) {
    handleError(res, e, '[profile/update-album-privacy]');
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
    if (!albums.length) return sendError(res, 404, ErrorCodes.NOT_FOUND, '相册不存在');
    if (albums[0].user_id !== userId) return sendError(res, 403, ErrorCodes.FORBIDDEN, '无权删除此相册');

    // 删除相册下所有照片
    const [photos] = await getPool().query(
      `SELECT photo_path, thumb_path FROM user_photos WHERE album_id = ?`, [albumId]
    );
    for (const p of photos) {
      try { if (p.photo_path) fs.unlinkSync(path.join(ROOT_DIR, p.photo_path)); } catch (err) { logger.warn('profile', '[profile] 删除照片文件失败:', p.photo_path, err.message); }
      try { if (p.thumb_path) fs.unlinkSync(path.join(ROOT_DIR, p.thumb_path)); } catch (err) { logger.warn('profile', '[profile] 删除缩略图失败:', p.thumb_path, err.message); }
    }
    await getPool().query(`DELETE FROM user_photos WHERE album_id = ?`, [albumId]);
    await getPool().query(`DELETE FROM user_albums WHERE id = ?`, [albumId]);

    ok(res, { message: '相册已删除' });
  } catch (e) {
    handleError(res, e, '[profile/delete-album]');
  }
});

// ==================== 照片路由 ====================

/**
 * POST /albums/:id/photos - 上传照片到相册
 */
router.post('/albums/:id/photos', requireAuth, secureUpload(uploadPhoto.array('photos', 20)), async (req, res) => {
  try {
    const albumId = parseInt(req.params.id, 10);
    const userId = req.session.userId;

    const [albums] = await getPool().query(
      `SELECT id, user_id FROM user_albums WHERE id = ?`, [albumId]
    );
    if (!albums.length) return sendError(res, 404, ErrorCodes.NOT_FOUND, '相册不存在');
    if (albums[0].user_id !== userId) return sendError(res, 403, ErrorCodes.FORBIDDEN, '无权上传到此相册');

    if (!req.files || req.files.length === 0) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请选择要上传的文件');
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
            } catch (e) { logger.warn('profile', '[profile] 生成视频占位图失败:', e.message); }
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

    ok(res, { photos: uploadedPhotos, photoCount });
  } catch (e) {
    handleError(res, e, '[profile/upload-photos]');
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
    if (!albums.length) return sendError(res, 404, ErrorCodes.NOT_FOUND, '相册不存在');

    const album = albums[0];

    // 隐私检查
    if (album.userId !== currentUserId) {
      if (album.privacy === 'private') {
        return sendError(res, 403, ErrorCodes.FORBIDDEN, '该相册为私密相册');
      }
      if (album.privacy === 'members_only') {
        if (!currentUserId) {
          return sendError(res, 401, ErrorCodes.UNAUTHORIZED, '请先登录');
        }
        const viewerIsFriend = await getViewerIsFriend(currentUserId, album.userId);
        if (!viewerIsFriend) {
          return sendError(res, 403, ErrorCodes.FORBIDDEN, '该相册仅好友可见');
        }
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
    handleError(res, e, '[profile/get-photos]');
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
    if (!photos.length) return sendError(res, 404, ErrorCodes.NOT_FOUND, '照片不存在');
    if (photos[0].user_id !== userId) return sendError(res, 403, ErrorCodes.FORBIDDEN, '无权删除此照片');

    const photo = photos[0];

    // 删除文件
    try { if (photo.photo_path) fs.unlinkSync(path.join(ROOT_DIR, photo.photo_path)); } catch (err) { logger.warn('profile', '[profile] 删除照片文件失败:', photo.photo_path, err.message); }
    try { if (photo.thumb_path) fs.unlinkSync(path.join(ROOT_DIR, photo.thumb_path)); } catch (err) { logger.warn('profile', '[profile] 删除缩略图失败:', photo.thumb_path, err.message); }

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

    ok(res, { message: '照片已删除', photoCount });
  } catch (e) {
    handleError(res, e, '[profile/delete-photo]');
  }
});

// ==================== 视频路由 ====================

/**
 * POST /videos - 上传视频（需登录）
 */
router.post('/videos', requireAuth, secureUpload(uploadVideo.single('video')), async (req, res) => {
  try {
    const userId = req.session.userId;

    if (!req.file) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请选择要上传的视频');
    }

    const { title, description, privacy } = req.body;
    if (!title || !title.trim()) {
      // 删除已上传文件
      try { fs.unlinkSync(req.file.path); } catch (err) { logger.warn('profile', '[profile] 清理上传文件失败:', req.file.path, err.message); }
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '视频标题不能为空');
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

    ok(res, {
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
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch (err) { logger.warn('profile', '[profile] 清理上传文件失败:', req.file.path, err.message); } }
    handleError(res, e, '[profile/upload-video]');
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
    const viewerIsFriend = await getViewerIsFriend(currentUserId, targetUserId);

    let sql = `SELECT id, user_id AS userId, title, description,
                video_path AS videoPath, thumb_path AS thumbPath,
                duration, file_size AS fileSize, privacy,
                view_count AS viewCount, created_at AS createdAt
         FROM user_videos WHERE user_id = ?`;
    let params = [targetUserId];

    if (targetUserId !== currentUserId) {
      sql += ' ' + privacyCondition(targetUserId, isLoggedIn, viewerIsFriend);
      params = params.concat(privacyParams(targetUserId, isLoggedIn, viewerIsFriend));
    }
    sql += ' ORDER BY created_at DESC';

    const [videos] = await getPool().query(sql, params);
    const mappedVideos = videos.map(v => ({
      ...v,
      thumbnailUrl: v.thumbPath ? '/' + v.thumbPath.replace(/\\/g, '/') : null
    }));
    res.json({ videos: mappedVideos });
  } catch (e) {
    handleError(res, e, '[profile/videos]');
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
    if (!videos.length) return sendError(res, 404, ErrorCodes.NOT_FOUND, '视频不存在');
    if (videos[0].user_id !== userId) return sendError(res, 403, ErrorCodes.FORBIDDEN, '无权删除此视频');

    const video = videos[0];

    // 删除文件
    try { if (video.video_path) fs.unlinkSync(path.join(ROOT_DIR, video.video_path)); } catch (err) { logger.warn('profile', '[profile] 删除视频文件失败:', video.video_path, err.message); }
    try { if (video.thumb_path) fs.unlinkSync(path.join(ROOT_DIR, video.thumb_path)); } catch (err) { logger.warn('profile', '[profile] 删除视频缩略图失败:', video.thumb_path, err.message); }

    await getPool().query(`DELETE FROM user_videos WHERE id = ?`, [videoId]);

    ok(res, { message: '视频已删除' });
  } catch (e) {
    handleError(res, e, '[profile/delete-video]');
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
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '无效的隐私设置');
    }

    const [videos] = await getPool().query(
      `SELECT id, user_id FROM user_videos WHERE id = ?`, [videoId]
    );
    if (!videos.length) return sendError(res, 404, ErrorCodes.NOT_FOUND, '视频不存在');
    if (videos[0].user_id !== userId) return sendError(res, 403, ErrorCodes.FORBIDDEN, '无权修改此视频');

    await getPool().query(`UPDATE user_videos SET privacy = ? WHERE id = ?`, [privacy, videoId]);

    ok(res, { message: '隐私设置已更新' });
  } catch (e) {
    handleError(res, e, '[profile/update-video-privacy]');
  }
});

module.exports = router;
