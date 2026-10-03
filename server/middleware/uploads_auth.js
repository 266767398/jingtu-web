/**
 * 上传目录鉴权
 * /uploads 含用户上传的私人媒体，默认禁止匿名访问（避免被枚举/爬取）。
 * 放行条件：① 已登录（任意登录用户）；② 携带有效且未过期的公开分享令牌 ?share=<code>。
 * 分享链接由 routes/share.js 在返回内容时把 /uploads/... 或 /assets/album/... 改写为
 * /uploads/...?share=<code>，从而让匿名分享查看者仍能加载其媒体，但不暴露其它用户的上传。
 * P1-53: 相册媒体位于 /assets/album（express.static 无鉴权），提供同款鉴权中间件 setupAssetsAlbumAuth，
 * 使相册分享令牌在 /assets/album 下同样严格绑定资源，游客直接访问相册文件一律 401。
 */
const { fail, getPool } = require('../utils');
const { sharePathAllowed } = require('../share-auth-util');

// 根据分享的 type/target_id 反查该分享内容关联的媒体路径集合（用于严格鉴权，防止用任一有效码访问全站私有媒体）。
// P1-53: paths 规整为「与中间件内 req.path 相同的挂载后相对形式」（剥掉挂载前缀），
// 修复合挂载('/uploads')前会输出 '/uploads/xxx'、与 req.path('/xxx') 恒不匹配导致分享媒体全部 401 的问题。
async function getShareAuthPaths(pool, type, targetId, opts = {}) {
  const mount = opts.mount || 'uploads';
  const paths = [];
  const push = (v) => {
    if (!v || typeof v !== 'string') return;
    if (/^https?:/i.test(v)) return; // 跳过外链
    let rel = v.replace(/^\/+/, '');
    if (mount === 'uploads') {
      if (rel.startsWith('uploads/')) rel = rel.slice('uploads/'.length);
      else if (rel.startsWith('uploads')) rel = rel.slice('uploads'.length);
    } else if (mount === 'assets/album') {
      if (rel.startsWith('assets/album/')) rel = rel.slice('assets/album/'.length);
      else return; // 非相册目录路径不参与 /assets/album 挂载比对
    }
    paths.push('/' + rel);
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

// P3-140：分享码校验结果短 TTL 内存缓存——同一 code+mount+path 的连续请求
// （分享页批量加载媒体）不再重复串行查库，消除「有效码拼不同路径」的 DB 查询放大；
// 15s 窗口在链接失效/资源删除后的陈旧期可控，Map 带上限防内存无界增长。
const SHARE_VERIFY_TTL_MS = 15 * 1000;
const SHARE_VERIFY_MAX = 2000;
const shareVerifyCache = new Map();

function shareVerifyKey(code, mount, reqPath) {
  return `${mount}|${code}|${reqPath}`;
}

function getShareVerifyCached(key) {
  const hit = shareVerifyCache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > SHARE_VERIFY_TTL_MS) {
    shareVerifyCache.delete(key);
    return undefined;
  }
  return { ok: hit.ok, reason: hit.reason };
}

function setShareVerifyCached(key, value) {
  if (shareVerifyCache.size >= SHARE_VERIFY_MAX) {
    // 简单淘汰：先清已过期项，仍超限则整表清空（低概率兜底，宁可多查一次库）
    for (const [k, v] of shareVerifyCache) {
      if (Date.now() - v.at > SHARE_VERIFY_TTL_MS) shareVerifyCache.delete(k);
    }
    if (shareVerifyCache.size >= SHARE_VERIFY_MAX) shareVerifyCache.clear();
  }
  shareVerifyCache.set(key, { ...value, at: Date.now() });
}

// 校验分享令牌并做严格路径绑定（两个挂载点共用）
async function verifyShareCode(pool, code, mount, reqPath) {
  const cacheKey = shareVerifyKey(code, mount, reqPath);
  const cached = getShareVerifyCached(cacheKey);
  if (cached) return cached;

  const [links] = await pool.query(
    'SELECT type, target_id FROM share_links WHERE share_code = ? AND expires_at > NOW() LIMIT 1',
    [code]
  );
  let result;
  if (links.length === 0) {
    result = { ok: false, reason: 'invalid' };
  } else {
    const authPaths = await getShareAuthPaths(pool, links[0].type, links[0].target_id, { mount });
    // 严格边界匹配：精确相等，或为其子路径（防 /uploads/x.jpg 越权匹配 /uploads/x1.jpg）
    result = sharePathAllowed(reqPath, authPaths)
      ? { ok: true }
      : { ok: false, reason: 'forbidden' };
  }
  setShareVerifyCached(cacheKey, result);
  return result;
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
          const v = await verifyShareCode(pool, code, 'uploads', req.path);
          if (v.ok) return next();
          return fail(res, 401, v.reason === 'forbidden' ? '分享链接无权访问该资源' : '分享链接无效或已过期，需要登录后访问');
        } catch (e) {
          return fail(res, 401, '需要登录后才能访问该资源');
        }
      }
    }
    fail(res, 401, '需要登录后才能访问该资源');
  });
}

/**
 * P1-53: /assets/album（相册媒体）前置鉴权中间件——与 /uploads 同款契约：
 * 登录用户放行；匿名仅凭分享令牌且严格绑定到该分享的资源放行。
 * @param {import('express').Express} app
 */
function setupAssetsAlbumAuth(app) {
  app.use('/assets/album', async (req, res, next) => {
    if (req.session && req.session.userId) return next();
    const code = typeof req.query.share === 'string' ? req.query.share : '';
    if (code) {
      const pool = getPool();
      if (pool) {
        try {
          const v = await verifyShareCode(pool, code, 'assets/album', req.path);
          if (v.ok) return next();
          return fail(res, 401, v.reason === 'forbidden' ? '分享链接无权访问该资源' : '分享链接无效或已过期，需要登录后访问');
        } catch (e) {
          return fail(res, 401, '需要登录后才能访问该资源');
        }
      }
    }
    fail(res, 401, '需要登录后才能访问该资源');
  });
}

module.exports = { getShareAuthPaths, verifyShareCode, setupUploadsAuth, setupAssetsAlbumAuth };
