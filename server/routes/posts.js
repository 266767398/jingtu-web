/**
 * 境途同游 V6.9 — 动态/朋友圈系统路由
 * 完全独立模块，所有 API 路径均为 /api/posts
 */
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { requireAuth } = require('../auth');
const { getPool, safeError } = require('../utils');

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
  fileFilter: (req, file, cb) => {
    const imgExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    const vidExts = ['.mp4', '.mov', '.webm', '.avi', '.mkv'];
    const ext = path.extname(file.originalname).toLowerCase();
    if ([...imgExts, ...vidExts].includes(ext)) return cb(null, true);
    cb(new Error('仅支持 JPG/PNG/GIF/WEBP/MP4/MOV/WEBM 格式'));
  }
});

// ==================== 辅助函数 ====================
function getAvatarUrl(user) {
  if (user.avatar_type === 'custom' && user.custom_avatar_path) return `/uploads/${user.custom_avatar_path}`;
  if (user.avatar_type === 'vrchat' && user.vrchat_avatar_url) return user.vrchat_avatar_url;
  return null;
}

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
 * GET /api/posts — 获取动态列表（分页）
 * 查询参数：page, pageSize, userId(查看指定用户), type(text/image/video/mixed)
 */
router.get('/', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize) || 20));
    const offset = (page - 1) * pageSize;
    const targetUserId = req.query.userId ? parseInt(req.query.userId) : null;
    const typeFilter = req.query.type || '';
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

    const posts = await Promise.all(rows.map(async (post) => {
      const [media] = await getPool().query(
        `SELECT id, media_type AS mediaType, media_url AS mediaUrl, thumb_url AS thumbUrl, width, height, sort
         FROM post_media WHERE post_id = ? ORDER BY sort ASC, id ASC`,
        [post.id]
      );
      let liked = false;
      if (currentUserId) {
        const [lk] = await getPool().query(`SELECT 1 FROM post_like WHERE post_id = ? AND user_id = ?`, [post.id, currentUserId]);
        liked = lk.length > 0;
      }
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
        media,
        liked
      };
    }));

    const totalPages = Math.ceil(total / pageSize);
    const hasMore = offset + pageSize < total;
    res.json({ posts, total, page, pageSize, totalPages, hasMore });
  } catch (e) {
    console.error('[posts] GET / error:', e);
    res.status(500).json({ error: safeError(e.message) });
  }
});

/**
 * GET /api/posts/:id — 获取单条动态详情（含全部评论）
 */
router.get('/:id', async (req, res) => {
  try {
    const postId = parseInt(req.params.id);
    if (!postId) return res.status(400).json({ error: '参数错误' });
    const post = await getPostDetail(postId, req.session?.userId);
    if (!post) return res.status(404).json({ error: '动态不存在' });
    res.json(post);
  } catch (e) {
    console.error('[posts] GET /:id error:', e);
    res.status(500).json({ error: safeError(e.message) });
  }
});

/**
 * POST /api/posts — 创建动态（支持文字/图片/视频混合）
 * Content-Type: multipart/form-data
 * 字段：content(文字), visibility(可见性), media(文件数组)
 */
router.post('/', requireAuth, (req, res, next) => {
  postUpload.array('media', 12)(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: '文件大小超过限制（图片10MB/视频200MB）' });
      return res.status(400).json({ error: err.message || '上传失败' });
    }
    next();
  });
}, async (req, res) => {
  try {
    const userId = req.session.userId;
    const content = (req.body.content || '').trim();
    const visibility = ['public', 'members_only', 'private'].includes(req.body.visibility) ? req.body.visibility : 'members_only';
    const files = req.files || [];

    if (!content && files.length === 0) {
      return res.status(400).json({ error: '请输入文字或选择图片/视频' });
    }

    // 确定动态类型
    let postType = 'text';
    if (files.length > 0) {
      const hasImage = files.some(f => f.mimetype?.startsWith('image/'));
      const hasVideo = files.some(f => f.mimetype?.startsWith('video/'));
      if (hasImage && hasVideo) postType = 'mixed';
      else if (hasVideo) postType = 'video';
      else postType = 'image';
    }

    // 插入动态
    const [result] = await getPool().query(
      `INSERT INTO posts (user_id, content, type, visibility) VALUES (?, ?, ?, ?)`,
      [userId, content || '', postType, visibility]
    );
    const postId = result.insertId;

    // 插入媒体
    if (files.length > 0) {
      const mediaValues = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const relativePath = path.relative(ROOT_DIR, file.path).replace(/\\/g, '/');
        const mediaType = file.mimetype?.startsWith('video/') ? 'video' : 'image';
        mediaValues.push([postId, userId, mediaType, relativePath, '', 0, 0, file.size || 0, i]);
      }
      await getPool().query(
        `INSERT INTO post_media (post_id, user_id, media_type, media_url, thumb_url, width, height, file_size, sort) VALUES ?`,
        [mediaValues]
      );
    }

    const post = await getPostDetail(postId, userId);

    // 记录操作日志
    try {
      await getPool().query(
        `INSERT INTO sys_oper_log (admin_vrcid, oper_type, content) VALUES (?, '发布动态', ?)`,
        [req.session.loginId || userId, `用户 ${req.session.displayName} 发布了新动态 #${postId}`]
      );
    } catch (_) {}

    res.json({ success: true, post });
  } catch (e) {
    console.error('[posts] POST / error:', e);
    res.status(500).json({ error: safeError(e.message) });
  }
});

/**
 * DELETE /api/posts/:id — 删除动态（仅作者和管理员）
 */
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const postId = parseInt(req.params.id);
    if (!postId) return res.status(400).json({ error: '参数错误' });
    const userId = req.session.userId;
    const userRole = req.session.role;

    const [posts] = await getPool().query(`SELECT * FROM posts WHERE id = ?`, [postId]);
    if (!posts.length) return res.status(404).json({ error: '动态不存在' });
    if (posts[0].user_id !== userId && userRole !== 'super_admin' && userRole !== 'admin') {
      return res.status(403).json({ error: '无权删除此动态' });
    }

    // 删除媒体文件
    const [media] = await getPool().query(`SELECT media_url, thumb_url FROM post_media WHERE post_id = ?`, [postId]);
    for (const m of media) {
      try { if (m.media_url) fs.unlinkSync(path.join(ROOT_DIR, m.media_url)); } catch (_) {}
      try { if (m.thumb_url) fs.unlinkSync(path.join(ROOT_DIR, m.thumb_url)); } catch (_) {}
    }

    // 删除数据库记录
    await getPool().query(`DELETE FROM post_like WHERE post_id = ?`, [postId]);
    await getPool().query(`DELETE FROM post_comment WHERE post_id = ?`, [postId]);
    await getPool().query(`DELETE FROM post_media WHERE post_id = ?`, [postId]);
    await getPool().query(`DELETE FROM posts WHERE id = ?`, [postId]);

    res.json({ success: true, message: '动态已删除' });
  } catch (e) {
    console.error('[posts] DELETE /:id error:', e);
    res.status(500).json({ error: safeError(e.message) });
  }
});

/**
 * POST /api/posts/:id/like — 点赞/取消点赞
 */
router.post('/:id/like', requireAuth, async (req, res) => {
  try {
    const postId = parseInt(req.params.id);
    const userId = req.session.userId;

    const [posts] = await getPool().query(`SELECT id, like_count FROM posts WHERE id = ?`, [postId]);
    if (!posts.length) return res.status(404).json({ error: '动态不存在' });

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
        try {
          const notifyPool = getPool();
          await notifyPool.query(
            `INSERT INTO notifications (user_id, type, title, message, related_id) VALUES (?, 'like', ?, ?, ?)`,
            [posts[0].user_id, `${req.session.displayName} 赞了你的动态`, `「${req.body.content?.slice(0, 50) || ''}」`, postId]
          );
        } catch (_) {}
      }

      return res.json({ liked: true, likeCount: like_count });
    }
  } catch (e) {
    console.error('[posts] POST /:id/like error:', e);
    res.status(500).json({ error: safeError(e.message) });
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
        avatarUrl: getAvatarUrl(r)
      }
    }));
    res.json({ comments });
  } catch (e) {
    console.error('[posts] GET /:id/comments error:', e);
    res.status(500).json({ error: safeError(e.message) });
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

    if (!content || !content.trim()) return res.status(400).json({ error: '请输入评论内容' });
    if (content.length > 2000) return res.status(400).json({ error: '评论内容不能超过2000字' });

    const [posts] = await getPool().query(`SELECT id, user_id FROM posts WHERE id = ?`, [postId]);
    if (!posts.length) return res.status(404).json({ error: '动态不存在' });

    const [result] = await getPool().query(
      `INSERT INTO post_comment (post_id, user_id, parent_id, content) VALUES (?, ?, ?, ?)`,
      [postId, userId, parentId || 0, content.trim()]
    );
    await getPool().query(`UPDATE posts SET comment_count = comment_count + 1 WHERE id = ?`, [postId]);

    // 通知被回复用户
    if (parentId) {
      const [parentComment] = await getPool().query(`SELECT user_id FROM post_comment WHERE id = ?`, [parentId]);
      if (parentComment.length > 0 && parentComment[0].user_id !== userId) {
        try {
          await getPool().query(
            `INSERT INTO notifications (user_id, type, title, message, related_id) VALUES (?, 'comment', ?, ?, ?)`,
            [parentComment[0].user_id, `${req.session.displayName} 回复了你的评论`, content.trim().slice(0, 100), postId]
          );
        } catch (_) {}
      }
    } else if (posts[0].user_id !== userId) {
      // 通知动态作者
      try {
        await getPool().query(
          `INSERT INTO notifications (user_id, type, title, message, related_id) VALUES (?, 'comment', ?, ?, ?)`,
          [posts[0].user_id, `${req.session.displayName} 评论了你的动态`, content.trim().slice(0, 100), postId]
        );
      } catch (_) {}
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
    console.error('[posts] POST /:id/comments error:', e);
    res.status(500).json({ error: safeError(e.message) });
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
    if (!comments.length) return res.status(404).json({ error: '评论不存在' });

    if (comments[0].user_id !== userId && userRole !== 'super_admin' && userRole !== 'admin') {
      return res.status(403).json({ error: '无权删除此评论' });
    }

    await getPool().query(`DELETE FROM post_comment WHERE id = ?`, [commentId]);
    await getPool().query(`UPDATE posts SET comment_count = GREATEST(0, comment_count - 1) WHERE id = ?`, [postId]);

    const [[{ comment_count }]] = await getPool().query(`SELECT comment_count FROM posts WHERE id = ?`, [postId]);

    res.json({ success: true, commentCount: comment_count });
  } catch (e) {
    console.error('[posts] DELETE /:id/comments/:commentId error:', e);
    res.status(500).json({ error: safeError(e.message) });
  }
});

/**
 * PUT /api/posts/:id/pin — 置顶/取消置顶（管理员）
 */
router.put('/:id/pin', requireAuth, async (req, res) => {
  try {
    const postId = parseInt(req.params.id);
    const userRole = req.session.role;
    if (userRole !== 'super_admin' && userRole !== 'admin') {
      return res.status(403).json({ error: '无权操作' });
    }
    const { pinned } = req.body;
    await getPool().query(`UPDATE posts SET is_pinned = ? WHERE id = ?`, [pinned ? 1 : 0, postId]);
    res.json({ success: true, pinned: !!pinned });
  } catch (e) {
    console.error('[posts] PUT /:id/pin error:', e);
    res.status(500).json({ error: safeError(e.message) });
  }
});

module.exports = router;
