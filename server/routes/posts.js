/**
 * 境途同游 V6.9 — 动态/朋友圈系统路由
 * 完全独立模块，所有 API 路径均为 /api/posts
 * 
 * @swagger
 * tags:
 *   name: Posts
 *   description: 动态/朋友圈相关接口
 */
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { requireAuth } = require('../auth');
const { getPool, getAvatarUrl, handleError , sendError, ErrorCodes, createFileFilter, secureUpload, logOper } = require('../utils');
const cacheService = require('../cache_service');
const webhook = require('../webhook');
const logger = require('../logger');

module.exports = function (notificationService) {
  const router = express.Router();

const ROOT_DIR = path.join(__dirname, '..', '..');
const POSTS_DIR = path.join(ROOT_DIR, 'uploads', 'posts');
if (!fs.existsSync(POSTS_DIR)) fs.mkdirSync(POSTS_DIR, { recursive: true });

// ==================== Multer 配置 ====================
const postStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, POSTS_DIR),
  filename: (req, file, cb) => {
    const uid = req.session?.userId || '0';
    const ext = path.extname(file.originalname) || '.jpg';
const crypto = require('crypto');
    cb(null, `post_${uid}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}${ext}`);
  }
});

const postUpload = multer({
  storage: postStorage,
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: createFileFilter(['IMAGE', 'VIDEO'])
});

// ==================== 辅助函数 ====================


/**
 * 获取动态详情（含用户信息和媒体）
 */
async function getPostDetail(postId, currentUserId) {
  const [rows] = await getPool().query(
    `SELECT p.*, u.display_name AS userName, u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url, u.vrchat_name
     FROM posts p LEFT JOIN users u ON p.user_id = u.id
     WHERE p.id = ? AND u.deleted_at IS NULL`,
    [postId]
  );
  if (!rows.length) return null;
  const post = rows[0];

  // 媒体
  const [media] = await getPool().query(
    `SELECT id, media_type AS mediaType, media_url AS mediaUrl, thumb_url AS thumbUrl, width, height, sort
     FROM post_media WHERE post_id = ? ORDER BY sort ASC, id ASC`,
    [postId]
  );

  // 是否已赞
  let liked = false;
  if (currentUserId) {
    const [lk] = await getPool().query(`SELECT 1 FROM post_like WHERE post_id = ? AND user_id = ?`, [postId, currentUserId]);
    liked = lk.length > 0;
  }

  // 评论（前5条预览）
  const [comments] = await getPool().query(
    `SELECT pc.id, pc.content, pc.parent_id AS parentId, pc.created_at AS createdAt,
            u.id AS userId, u.display_name AS userName, u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url
     FROM post_comment pc LEFT JOIN users u ON pc.user_id = u.id
     WHERE pc.post_id = ? ORDER BY pc.created_at ASC LIMIT 5`,
    [postId]
  );
  const commentCount = post.comment_count;

  // 补充子评论
  const parentIds = comments.filter(c => c.id).map(c => c.id);
  let childComments = [];
  if (parentIds.length > 0) {
    [childComments] = await getPool().query(
      `SELECT pc.id, pc.content, pc.parent_id AS parentId, pc.created_at AS createdAt,
              u.id AS userId, u.display_name AS userName, u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url
       FROM post_comment pc LEFT JOIN users u ON pc.user_id = u.id
       WHERE pc.post_id = ? AND pc.parent_id IN (?) ORDER BY pc.created_at ASC`,
      [postId, parentIds]
    );
  }

  return {
    id: post.id,
    userId: post.user_id,
    content: post.content,
    type: post.type,
    likeCount: post.like_count,
    commentCount,
    isPinned: !!post.is_pinned,
    visibility: post.visibility,
    createdAt: post.created_at,
    updatedAt: post.updated_at,
    user: {
      id: post.user_id,
      name: post.userName,
      vrchatName: post.vrchat_name,
      avatarUrl: getAvatarUrl(post)
    },
    media,
    liked,
    comments: [...comments, ...childComments]
  };
}

// ==================== 路由 ====================

/**
 * @swagger
 * /api/posts:
 *   get:
 *     summary: 获取动态列表
 *     description: 获取动态列表，支持分页、用户筛选和类型筛选
 *     tags: [Posts]
 *     parameters:
 *       - name: page
 *         in: query
 *         type: integer
 *         description: 页码
 *       - name: pageSize
 *         in: query
 *         type: integer
 *         description: 每页数量
 *       - name: userId
 *         in: query
 *         type: integer
 *         description: 查看指定用户的动态
 *       - name: type
 *         in: query
 *         type: string
 *         description: 动态类型 (text/image/video/mixed)
 *     responses:
 *       200:
 *         description: 动态列表
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 posts:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: integer
 *                       content:
 *                         type: string
 *                       type:
 *                         type: string
 *                       likeCount:
 *                         type: integer
 *                       commentCount:
 *                         type: integer
 */
router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize) || 20));
    const offset = (page - 1) * pageSize;
    const targetUserId = req.query.userId ? parseInt(req.query.userId) : null;
    const typeFilter = req.query.type || '';
    const dateFilter = (req.query.date || '').trim(); // YYYY-MM-DD，VN-12 时间线日期筛选
    const currentUserId = req.session?.userId;
    const isLoggedIn = !!currentUserId;

    let conditions = [];
    let params = [];

    // 权限：未登录只看 public，已登录看 public + members_only，自己的全部可见
    if (!isLoggedIn) {
      conditions.push(`p.visibility = 'public'`);
    } else if (targetUserId && targetUserId !== currentUserId) {
      conditions.push(`(p.visibility IN ('public','members_only') OR (p.visibility = 'private' AND p.user_id = ?))`);
      params.push(currentUserId);
    } else if (!targetUserId) {
      conditions.push(`(p.visibility IN ('public','members_only') OR (p.user_id = ? AND p.visibility = 'private'))`);
      params.push(currentUserId);
    }

    if (targetUserId) {
      conditions.push(`p.user_id = ?`);
      params.push(targetUserId);
    }

    if (typeFilter && ['text','image','video','mixed'].includes(typeFilter)) {
      conditions.push(`p.type = ?`);
      params.push(typeFilter);
    }

    // VN-12：按日期筛选（时间线今日模式 / 日期筛选）
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateFilter)) {
      conditions.push(`DATE(p.created_at) = ?`);
      params.push(dateFilter);
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const [count] = await getPool().query(`SELECT COUNT(*) AS total FROM posts p ${where}`, params);
    const total = count[0].total;

    const [rows] = await getPool().query(
      `SELECT p.*, u.display_name AS userName, u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url, u.vrchat_name
       FROM posts p LEFT JOIN users u ON p.user_id = u.id
       ${where}
       ORDER BY p.is_pinned DESC, p.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    // §42: 批量查询媒体与点赞状态，替代每条动态 2 次查询的 N+1
    const postIds = rows.map(p => p.id);
    let mediaMap = {};
    let likedSet = new Set();
    if (postIds.length > 0) {
      const [allMedia] = await getPool().query(
        `SELECT post_id, id, media_type AS mediaType, media_url AS mediaUrl, thumb_url AS thumbUrl, width, height, sort
         FROM post_media WHERE post_id IN (?) ORDER BY sort ASC, id ASC`,
        [postIds]
      );
      for (const m of allMedia) {
        if (!mediaMap[m.post_id]) mediaMap[m.post_id] = [];
        mediaMap[m.post_id].push({
          id: m.id, mediaType: m.mediaType, mediaUrl: m.mediaUrl,
          thumbUrl: m.thumbUrl, width: m.width, height: m.height, sort: m.sort
        });
      }
      if (currentUserId) {
        const [likedRows] = await getPool().query(
          `SELECT post_id FROM post_like WHERE user_id = ? AND post_id IN (?)`,
          [currentUserId, postIds]
        );
        likedSet = new Set(likedRows.map(r => r.post_id));
      }
    }

    const posts = rows.map((post) => {
      return {
        id: post.id,
        userId: post.user_id,
        content: post.content,
        type: post.type,
        likeCount: post.like_count,
        commentCount: post.comment_count,
        isPinned: !!post.is_pinned,
        visibility: post.visibility,
        createdAt: post.created_at,
        updatedAt: post.updated_at,
        user: {
          id: post.user_id,
          name: post.userName,
          vrchatName: post.vrchat_name,
          avatarUrl: getAvatarUrl(post)
        },
        media: mediaMap[post.id] || [],
        liked: likedSet.has(post.id)
      };
    });

    const totalPages = Math.ceil(total / pageSize);
    const hasMore = offset + pageSize < total;
    res.json({ posts, total, page, pageSize, totalPages, hasMore });
  } catch (e) {
    handleError(res, e, '[posts/list]');
  }
});

router.get('/search', async (req, res) => {
  try {
    const q = req.query.q ? req.query.q.trim() : '';
    if (!q || q.length < 2) return res.json({ posts: [], total: 0 });
    const like = '%' + q + '%';
    // 权限：参考列表接口，未登录只看 public，已登录看 public + members_only + 自己的 private
    const currentUserId = req.session?.userId;
    const isLoggedIn = !!currentUserId;
    let visCond;
    let visParams = [];
    if (!isLoggedIn) {
      visCond = `p.visibility = 'public'`;
    } else {
      visCond = `(p.visibility IN ('public','members_only') OR (p.visibility = 'private' AND p.user_id = ?))`;
      visParams.push(currentUserId);
    }
    const [rows] = await getPool().query(
      `SELECT p.id, p.content, p.type, p.visibility, p.created_at AS createdAt, p.like_count AS likeCount, p.comment_count AS commentCount, u.display_name AS userName, u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url
       FROM posts p LEFT JOIN users u ON p.user_id = u.id
       WHERE p.content LIKE ? AND u.deleted_at IS NULL AND ${visCond}
       ORDER BY p.created_at DESC LIMIT 20`,
      [like, ...visParams]
    );
    const posts = rows.map(p => ({
      ...p,
      avatarUrl: getAvatarUrl(p, '/uploads/'),
      content: p.content.length > 100 ? p.content.substring(0, 100) + '…' : p.content
    }));
    res.json({ posts, total: posts.length });
  } catch (e) {
    handleError(res, e, '[posts/search]');
  }
});

/**
 * GET /api/posts/:id — 获取单条动态详情（含全部评论）
 */
router.get('/:id', async (req, res) => {
  try {
    const postId = parseInt(req.params.id);
    if (!postId) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
    // 详情包含当前用户的 liked 状态，不使用跨用户共享缓存。
    const post = await getPostDetail(postId, req.session?.userId);
    if (!post) return sendError(res, 404, ErrorCodes.NOT_FOUND, '动态不存在');
    // visibility 校验：参考列表接口逻辑，防止私密动态详情泄露
    const currentUserId = req.session?.userId;
    const isLoggedIn = !!currentUserId;
    const vis = post.visibility;
    const isOwner = isLoggedIn && post.userId === currentUserId;
    const allowed = vis === 'public'
      ? true
      : vis === 'members_only'
        ? isLoggedIn
        : vis === 'private'
          ? isOwner
          : false;
    if (!allowed) return sendError(res, 403, ErrorCodes.FORBIDDEN, '无权查看此动态');
    res.json(post);
  } catch (e) {
    handleError(res, e, '[posts/detail]');
  }
});

/**
 * POST /api/posts — 创建动态（支持文字/图片/视频混合）
 * Content-Type: multipart/form-data
 * 字段：content(文字), visibility(可见性), media(文件数组)
 */
router.post('/', requireAuth, (req, res, next) => {
  secureUpload(postUpload.array('media', 12))(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return sendError(res, 400, ErrorCodes.BAD_REQUEST, '文件大小超过限制（图片10MB/视频200MB）');
      return res.status(400).json({ error: err.message || '上传失败' });
    }
    next();
  });
}, async (req, res) => {
  const userId = req.session.userId;
  const content = (req.body.content || '').trim();
  const visibility = ['public', 'members_only', 'private'].includes(req.body.visibility) ? req.body.visibility : 'members_only';
  const files = req.files || [];
  const cleanupFiles = () => {
    for (const file of files) {
      fs.promises.unlink(file.path).catch(() => {});
    }
  };

  if (!content && files.length === 0) {
    return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请输入文字或选择图片/视频');
  }

  let connection;
  let committed = false;
  try {
    let postType = 'text';
    if (files.length > 0) {
      const hasImage = files.some(f => f.mimetype?.startsWith('image/'));
      const hasVideo = files.some(f => f.mimetype?.startsWith('video/'));
      if (hasImage && hasVideo) postType = 'mixed';
      else if (hasVideo) postType = 'video';
      else postType = 'image';
    }

    connection = await getPool().getConnection();
    await connection.beginTransaction();
    const [result] = await connection.query(
      `INSERT INTO posts (user_id, content, type, visibility) VALUES (?, ?, ?, ?)`,
      [userId, content || '', postType, visibility]
    );
    const postId = result.insertId;

    if (files.length > 0) {
      const mediaValues = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const relativePath = path.relative(ROOT_DIR, file.path).replace(/\\/g, '/');
        const mediaType = file.mimetype?.startsWith('video/') ? 'video' : 'image';
        mediaValues.push([postId, userId, mediaType, relativePath, '', 0, 0, file.size || 0, i]);
      }
      await connection.query(
        `INSERT INTO post_media (post_id, user_id, media_type, media_url, thumb_url, width, height, file_size, sort) VALUES ?`,
        [mediaValues]
      );
    }
    await connection.commit();
    committed = true;

    const post = await getPostDetail(postId, userId);

    // 记录操作日志
    try {
      await getPool().query(
        `INSERT INTO sys_oper_log (admin_vrcid, oper_type, content) VALUES (?, '发布动态', ?)`,
        [req.session.loginId || userId, `用户 ${req.session.displayName} 发布了新动态 #${postId}`]
      );
    } catch (e) { logger.warn('posts', '[posts] 操作日志记录失败:', e.message); }

    // 失效缓存并触发webhook
    await cacheService.invalidatePost(postId);
    await cacheService.del(cacheService.cacheKeys.posts());
    webhook.triggerPostCreated(post).catch(() => {});
    res.json({ success: true, post });
  } catch (e) {
    if (connection && !committed) await connection.rollback();
    if (!committed) cleanupFiles();
    handleError(res, e, '[posts/create]');
  } finally {
    if (connection) connection.release();
  }
});

/**
 * PUT /api/posts/:id — 编辑动态（仅作者和管理员）
 */
router.put('/:id', requireAuth, (req, res, next) => {
  secureUpload(postUpload.array('media', 12))(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return sendError(res, 400, ErrorCodes.BAD_REQUEST, '文件大小超过限制');
      return res.status(400).json({ error: err.message || '上传失败' });
    }
    next();
  });
}, async (req, res) => {
  const postId = parseInt(req.params.id);
  const userId = req.session.userId;
  const files = req.files || [];
  const cleanupNewFiles = () => {
    for (const file of files) {
      try { fs.unlinkSync(file.path); } catch {}
    }
  };

  if (!postId) {
    cleanupNewFiles();
    return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
  }

  let removeMediaIds = [];
  if (req.body.removeMediaIds) {
    try {
      const parsed = JSON.parse(req.body.removeMediaIds);
      if (!Array.isArray(parsed)) throw new Error('not an array');
      removeMediaIds = parsed.map(Number).filter(Number.isInteger);
    } catch {
      cleanupNewFiles();
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'removeMediaIds 格式错误');
    }
  }

  let connection;
  let removedMedia = [];
  try {
    connection = await getPool().getConnection();
    await connection.beginTransaction();
    const [posts] = await connection.query(`SELECT user_id FROM posts WHERE id = ? FOR UPDATE`, [postId]);
    if (!posts.length) {
      await connection.rollback();
      cleanupNewFiles();
      return sendError(res, 404, ErrorCodes.NOT_FOUND, '动态不存在');
    }
    const isAdmin = ['admin', 'super_admin'].includes(req.session.role);
    if (posts[0].user_id !== userId && !isAdmin) {
      await connection.rollback();
      cleanupNewFiles();
      return sendError(res, 403, ErrorCodes.FORBIDDEN, '无权编辑此动态');
    }

    if (removeMediaIds.length > 0) {
      [removedMedia] = await connection.query(
        `SELECT id, media_url FROM post_media WHERE post_id = ? AND id IN (?)`,
        [postId, removeMediaIds]
      );
      if (removedMedia.length > 0) {
        await connection.query(`DELETE FROM post_media WHERE post_id = ? AND id IN (?)`, [postId, removeMediaIds]);
      }
    }

    if (files.length > 0) {
      const [sortRows] = await connection.query(
        `SELECT COALESCE(MAX(sort), -1) AS maxSort FROM post_media WHERE post_id = ?`,
        [postId]
      );
      const startSort = sortRows[0].maxSort + 1;
      const values = files.map((file, index) => [
        postId,
        userId,
        file.mimetype?.startsWith('video/') ? 'video' : 'image',
        path.relative(ROOT_DIR, file.path).replace(/\\/g, '/'),
        '',
        0,
        0,
        file.size || 0,
        startSort + index
      ]);
      await connection.query(
        `INSERT INTO post_media
         (post_id, user_id, media_type, media_url, thumb_url, width, height, file_size, sort)
         VALUES ?`,
        [values]
      );
    }

    const content = (req.body.content || '').trim();
    const visibility = ['public', 'members_only', 'private'].includes(req.body.visibility)
      ? req.body.visibility
      : 'members_only';
    const [mediaRows] = await connection.query(`SELECT media_type FROM post_media WHERE post_id = ?`, [postId]);
    if (!content && mediaRows.length === 0) {
      await connection.rollback();
      cleanupNewFiles();
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '动态内容不能为空');
    }

    const hasImage = mediaRows.some(row => row.media_type === 'image');
    const hasVideo = mediaRows.some(row => row.media_type === 'video');
    const type = hasImage && hasVideo ? 'mixed' : hasVideo ? 'video' : hasImage ? 'image' : 'text';
    await connection.query(
      `UPDATE posts SET content = ?, visibility = ?, type = ?, updated_at = NOW() WHERE id = ?`,
      [content, visibility, type, postId]
    );
    await connection.commit();

    for (const media of removedMedia) {
      const filePath = path.resolve(ROOT_DIR, media.media_url);
      if (filePath.startsWith(ROOT_DIR + path.sep)) {
        fs.promises.unlink(filePath).catch(() => {});
      }
    }

    await cacheService.invalidatePost(postId);
    await cacheService.del(cacheService.cacheKeys.posts());
    const post = await getPostDetail(postId, userId);
    webhook.triggerPostUpdated(post).catch(() => {});
    // 审计：编辑动态（管理员代编辑时内容里追加操作者标记）
    try {
      const isAdmin = ['admin', 'super_admin'].includes(req.session.role) && posts[0].user_id !== userId;
      await logOper(userId, isAdmin ? '编辑动态(管理)' : '编辑动态', `动态#${postId}` + (isAdmin ? `, 原作者#${posts[0].user_id}` : ''));
    } catch (_) { /* 审计失败不影响主流程 */ }
    res.json({ success: true, post });
  } catch (e) {
    if (connection) await connection.rollback();
    cleanupNewFiles();
    handleError(res, e, '[posts/update]');
  } finally {
    if (connection) connection.release();
  }
});

/**
 * DELETE /api/posts/:id — 删除动态（仅作者和管理员）
 */
router.delete('/:id', requireAuth, async (req, res) => {
  let connection;
  let committed = false;
  try {
    const postId = parseInt(req.params.id);
    if (!postId) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
    const userId = req.session.userId;
    const userRole = req.session.role;

    connection = await getPool().getConnection();
    await connection.beginTransaction();
    const [posts] = await connection.query(`SELECT * FROM posts WHERE id = ? FOR UPDATE`, [postId]);
    if (!posts.length) {
      await connection.rollback();
      return sendError(res, 404, ErrorCodes.NOT_FOUND, '动态不存在');
    }
    if (posts[0].user_id !== userId && userRole !== 'super_admin' && userRole !== 'admin') {
      await connection.rollback();
      return sendError(res, 403, ErrorCodes.FORBIDDEN, '无权删除此动态');
    }

    const [media] = await connection.query(`SELECT media_url, thumb_url FROM post_media WHERE post_id = ?`, [postId]);
    await connection.query(`DELETE FROM post_like WHERE post_id = ?`, [postId]);
    await connection.query(`DELETE FROM post_comment WHERE post_id = ?`, [postId]);
    await connection.query(`DELETE FROM post_media WHERE post_id = ?`, [postId]);
    await connection.query(`DELETE FROM notifications WHERE (target_type='post' OR target_type='comment') AND post_id=?`, [postId]);
    await connection.query(`DELETE FROM posts WHERE id = ?`, [postId]);
    await connection.commit();
    committed = true;

    for (const item of media) {
      for (const relativePath of [item.media_url, item.thumb_url]) {
        if (!relativePath) continue;
        const filePath = path.resolve(ROOT_DIR, relativePath.replace(/^[/\\]+/, ''));
        if (filePath.startsWith(ROOT_DIR + path.sep)) {
          fs.promises.unlink(filePath).catch(err => {
            logger.warn('posts', '[posts] 删除媒体文件失败:', relativePath, err.message);
          });
        }
      }
    }

    await cacheService.invalidatePost(postId);
    await cacheService.del(cacheService.cacheKeys.posts());
    webhook.triggerPostDeleted(postId, userId).catch(() => {});

    // 审计：删除动态
    try {
      const isAdmin = ['admin', 'super_admin'].includes(userRole) && posts[0].user_id !== userId;
      await logOper(userId, isAdmin ? '删除动态(管理)' : '删除动态', `动态#${postId}, 媒体数 ${media.length}` + (isAdmin ? `, 原作者#${posts[0].user_id}` : ''));
    } catch (_) { /* 审计失败不影响主流程 */ }

    res.json({ success: true, message: '动态已删除' });
  } catch (e) {
    if (connection && !committed) await connection.rollback();
    handleError(res, e, '[posts/delete]');
  } finally {
    if (connection) connection.release();
  }
});

/**
 * POST /api/posts/:id/like — 点赞/取消点赞
 */
router.post('/:id/like', requireAuth, async (req, res) => {
  try {
    const postId = parseInt(req.params.id);
    const userId = req.session.userId;

    const [posts] = await getPool().query(`SELECT id, user_id, like_count FROM posts WHERE id = ?`, [postId]);
    if (!posts.length) return sendError(res, 404, ErrorCodes.NOT_FOUND, '动态不存在');

    const [existing] = await getPool().query(`SELECT 1 FROM post_like WHERE post_id = ? AND user_id = ?`, [postId, userId]);

    if (existing.length > 0) {
      // 取消点赞
      await getPool().query(`DELETE FROM post_like WHERE post_id = ? AND user_id = ?`, [postId, userId]);
      await getPool().query(`UPDATE posts SET like_count = GREATEST(0, like_count - 1) WHERE id = ?`, [postId]);
      const [[{ like_count }]] = await getPool().query(`SELECT like_count FROM posts WHERE id = ?`, [postId]);
      return res.json({ liked: false, likeCount: like_count });
    } else {
      // 点赞
      await getPool().query(`INSERT INTO post_like (post_id, user_id) VALUES (?, ?)`, [postId, userId]);
      await getPool().query(`UPDATE posts SET like_count = like_count + 1 WHERE id = ?`, [postId]);
      const [[{ like_count }]] = await getPool().query(`SELECT like_count FROM posts WHERE id = ?`, [postId]);

      // 通知被点赞用户
      if (posts[0].user_id && posts[0].user_id !== userId) {
        if (notificationService) {
          notificationService.notifyUser(
            posts[0].user_id,
            'like',
            `${req.session.displayName} 赞了你的动态`,
            `「${req.body.content?.slice(0, 50) || ''}」`,
            { targetType: 'post', targetId: postId, postId }
          );
        }
      }

      return res.json({ liked: true, likeCount: like_count });
    }
  } catch (e) {
    handleError(res, e, '[posts/like]');
  }
});

/**
 * GET /api/posts/:id/comments — 获取动态全部评论
 */
router.get('/:id/comments', async (req, res) => {
  try {
    const postId = parseInt(req.params.id);
    const [rows] = await getPool().query(
      `SELECT pc.id, pc.content, pc.parent_id AS parentId, pc.created_at AS createdAt,
              u.id AS userId, u.display_name AS userName, u.avatar_type, u.custom_avatar_path, u.vrchat_avatar_url, u.vrchat_name
       FROM post_comment pc LEFT JOIN users u ON pc.user_id = u.id
       WHERE pc.post_id = ?
       ORDER BY pc.created_at ASC`,
      [postId]
    );
    const comments = rows.map(r => ({
      id: r.id, content: r.content, parentId: r.parentId || 0,
      createdAt: r.createdAt,
      user: {
        id: r.userId, name: r.userName,
        vrchatName: r.vrchat_name,
        avatarUrl: getAvatarUrl(r, '/uploads/')
      }
    }));
    res.json({ comments });
  } catch (e) {
    handleError(res, e, '[posts/comments]');
  }
});

/**
 * POST /api/posts/:id/comments — 添加评论
 */
router.post('/:id/comments', requireAuth, async (req, res) => {
  try {
    const postId = parseInt(req.params.id);
    const userId = req.session.userId;
    const { content, parentId } = req.body;

    if (!content || !content.trim()) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请输入评论内容');
    if (content.length > 2000) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '评论内容不能超过2000字');

    const [posts] = await getPool().query(`SELECT id, user_id FROM posts WHERE id = ?`, [postId]);
    if (!posts.length) return sendError(res, 404, ErrorCodes.NOT_FOUND, '动态不存在');

    const [result] = await getPool().query(
      `INSERT INTO post_comment (post_id, user_id, parent_id, content) VALUES (?, ?, ?, ?)`,
      [postId, userId, parentId || 0, content.trim()]
    );
    await getPool().query(`UPDATE posts SET comment_count = comment_count + 1 WHERE id = ?`, [postId]);

    // 通知被回复用户或动态作者
    if (parentId) {
      const [parentComment] = await getPool().query(`SELECT user_id FROM post_comment WHERE id = ?`, [parentId]);
      if (parentComment.length > 0 && parentComment[0].user_id !== userId && notificationService) {
        notificationService.notifyUser(
          parentComment[0].user_id,
          'comment',
          `${req.session.displayName} 回复了你的评论`,
          content.trim().slice(0, 100),
          { targetType: 'comment', targetId: result.insertId, postId }
        );
      }
    } else if (posts[0].user_id !== userId && notificationService) {
      // 通知动态作者
      notificationService.notifyUser(
        posts[0].user_id,
        'comment',
        `${req.session.displayName} 评论了你的动态`,
        content.trim().slice(0, 100),
        { targetType: 'comment', targetId: result.insertId, postId }
      );
    }

    const [[{ comment_count }]] = await getPool().query(`SELECT comment_count FROM posts WHERE id = ?`, [postId]);

    res.json({
      success: true,
      comment: {
        id: result.insertId,
        content: content.trim(),
        parentId: parentId || 0,
        createdAt: new Date().toISOString(),
        user: {
          id: userId,
          name: req.session.displayName,
          avatarUrl: null
        }
      },
      commentCount: comment_count
    });
  } catch (e) {
    handleError(res, e, '[posts/comment-create]');
  }
});

/**
 * PUT /api/posts/:id/comments/:commentId — 编辑评论（仅作者本人或管理员）
 */
router.put('/:id/comments/:commentId', requireAuth, async (req, res) => {
  try {
    const commentId = parseInt(req.params.commentId);
    const postId = parseInt(req.params.id);
    const userId = req.session.userId;
    const userRole = req.session.role;
    const { content } = req.body;

    if (!commentId || !postId) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
    if (!content || !content.trim()) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请输入评论内容');
    if (typeof content !== 'string' || content.length > 2000) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '评论内容不能超过2000字');

    const [comments] = await getPool().query(`SELECT user_id FROM post_comment WHERE id = ? AND post_id = ?`, [commentId, postId]);
    if (!comments.length) return sendError(res, 404, ErrorCodes.NOT_FOUND, '评论不存在');
    if (comments[0].user_id !== userId && userRole !== 'super_admin' && userRole !== 'admin') {
      return sendError(res, 403, ErrorCodes.FORBIDDEN, '无权编辑此评论');
    }

    await getPool().query(`UPDATE post_comment SET content = ? WHERE id = ?`, [content.trim(), commentId]);
    res.json({ success: true, content: content.trim() });
  } catch (e) {
    handleError(res, e, '[posts/comment-update]');
  }
});

/**
 * DELETE /api/posts/:id/comments/:commentId — 删除评论
 */
router.delete('/:id/comments/:commentId', requireAuth, async (req, res) => {
  try {
    const commentId = parseInt(req.params.commentId);
    const postId = parseInt(req.params.id);
    const userId = req.session.userId;
    const userRole = req.session.role;

    const [comments] = await getPool().query(`SELECT * FROM post_comment WHERE id = ? AND post_id = ?`, [commentId, postId]);
    if (!comments.length) return sendError(res, 404, ErrorCodes.NOT_FOUND, '评论不存在');

    if (comments[0].user_id !== userId && userRole !== 'super_admin' && userRole !== 'admin') {
      return sendError(res, 403, ErrorCodes.FORBIDDEN, '无权删除此评论');
    }

    await getPool().query(`DELETE FROM post_comment WHERE id = ?`, [commentId]);
    await getPool().query(`DELETE FROM notifications WHERE target_type = 'comment' AND target_id = ?`, [commentId]);
    await getPool().query(`UPDATE posts SET comment_count = GREATEST(0, comment_count - 1) WHERE id = ?`, [postId]);

    const [[{ comment_count }]] = await getPool().query(`SELECT comment_count FROM posts WHERE id = ?`, [postId]);

    res.json({ success: true, commentCount: comment_count });
  } catch (e) {
    handleError(res, e, '[posts/comment-delete]');
  }
});

/**
 * PUT /api/posts/:id/pin — 置顶/取消置顶（仅 super_admin / admin，见下方内联 403 校验）
 */
router.put('/:id/pin', requireAuth, async (req, res) => {
  try {
    const postId = parseInt(req.params.id);
    const userRole = req.session.role;
    if (userRole !== 'super_admin' && userRole !== 'admin') {
      return sendError(res, 403, ErrorCodes.FORBIDDEN, '无权操作');
    }
    const { pinned } = req.body;
    await getPool().query(`UPDATE posts SET is_pinned = ? WHERE id = ?`, [pinned ? 1 : 0, postId]);
    // 审计：置顶/取消置顶（管理动作）
    try {
      await logOper(req.session.userId, pinned ? '置顶动态' : '取消置顶动态', `动态#${postId}`);
    } catch (_) { /* 审计失败不影响主流程 */ }
    res.json({ success: true, pinned: !!pinned });
  } catch (e) {
    handleError(res, e, '[posts/pin]');
  }
});


return router;
};
