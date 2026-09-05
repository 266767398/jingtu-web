/**
 * 上传目录鉴权
 * /uploads 含用户上传的私人媒体，默认禁止匿名访问（避免被枚举/爬取）。
 * 放行条件：① 已登录（任意登录用户）；② 携带有效且未过期的公开分享令牌 ?share=<code>。
 * 分享链接由 routes/share.js 在返回内容时把 /uploads/... 改写为 /uploads/...?share=<code>，
 * 从而让匿名分享查看者仍能加载其媒体，但不暴露其它用户的上传。
 */
const { fail, getPool } = require('../utils');
const { sharePathAllowed } = require('../share-auth-util');

// 根据分享的 type/target_id 反查该分享内容关联的媒体路径集合（用于严格鉴权，防止用任一有效码访问全站私有媒体）
async function getShareAuthPaths(pool, type, targetId) {
  const paths = [];
  const push = (v) => {
    if (!v || typeof v !== 'string') return;
    if (/^https?:/i.test(v)) return; // 跳过外链
    paths.push(v.startsWith('/uploads/') ? v : '/uploads/' + v.replace(/^\/+/, ''));
  };
  if (type === 'album') {
    const [rows] = await pool.query('SELECT photo_path, thumb_path FROM album_photo WHERE id = ?', [targetId]);
    rows.forEach((r) => { push(r.photo_path); push(r.thumb_path); });
  } else if (type === 'post') {
    const [rows] = await pool.query('SELECT media_url, thumb_url FROM post_media WHERE post_id = ?', [targetId]);
    rows.forEach((r) => { push(r.media_url); push(r.thumb_url); });
  } else if (type === 'event') {
    const [rows] = await pool.query('SELECT world_image_url FROM event WHERE id = ?', [targetId]);
    if (rows[0]) push(rows[0].world_image_url);
  }
  return paths;
}

/**
 * /uploads 静态资源前置鉴权中间件
 * @param {import('express').Express} app
 */
function setupUploadsAuth(app) {
  app.use('/uploads', async (req, res, next) => {
    // 头像为用户公开资料图，允许公开访问（无需登录/分享令牌），避免游客视图头像回退为占位图
    if (req.path.startsWith('/avatars/')) return next();
    if (req.session && req.session.userId) return next();
    const code = typeof req.query.share === 'string' ? req.query.share : '';
    if (code) {
      const pool = getPool();
      if (pool) {
        try {
          // P0 修复：分享令牌必须与具体资源绑定，禁止用任一有效码访问全站私有媒体
          const [links] = await pool.query(
            'SELECT type, target_id FROM share_links WHERE share_code = ? AND expires_at > NOW() LIMIT 1',
            [code]
          );
          if (links.length === 0) {
            return fail(res, 401, '分享链接无效或已过期，需要登录后访问');
          }
          const authPaths = await getShareAuthPaths(pool, links[0].type, links[0].target_id);
          // 严格边界匹配：精确相等，或为其子路径（防 /uploads/x.jpg 越权匹配 /uploads/x1.jpg）
          const allowed = sharePathAllowed(req.path, authPaths);
          if (allowed) return next();
          return fail(res, 401, '分享链接无权访问该资源');
        } catch (e) {
          return fail(res, 401, '需要登录后才能访问该资源');
        }
      }
    }
    fail(res, 401, '需要登录后才能访问该资源');
  });
}

module.exports = { getShareAuthPaths, setupUploadsAuth };
