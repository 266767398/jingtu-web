/**
 * 境途同游 V6.18 — 分享路由
 * 涵盖：动态分享、活动分享、相册分享
 * 
 * @swagger
 * tags:
 *   name: Share
 *   description: 分享系统相关接口
 */
const express = require('express');
const crypto = require('crypto');
const { ok, getPool, handleError , sendError, ErrorCodes } = require('../utils');
const { requireAuth } = require('../auth');

module.exports = function () {
  const router = express.Router();

  function generateShareCode() {
    // 使用加密随机数生成 share_code，避免 Math.random 可预测性
    return crypto.randomBytes(6).toString('base64url');
  }

  async function isShareable(type, targetId) {
    const queries = {
      post: `SELECT 1 FROM posts WHERE id = ? AND visibility = 'public'`,
      event: `SELECT 1 FROM event WHERE id = ? AND visibility = 'public'`,
      album: `SELECT 1 FROM album_photo WHERE id = ? AND visibility = 'public' AND is_recycle = 0`
    };
    const [rows] = await getPool().query(queries[type], [targetId]);
    return rows.length > 0;
  }

  // 把响应体中的 /uploads/... 媒体 URL 改写为附带分享令牌的形式，
  // 使匿名分享查看者可在 server.js 的 /uploads 鉴权中间件处凭 ?share=<code> 放行，
  // 同时不暴露其它用户的上传资源。结构无关，全payload统一处理。
  function embedShareTokenInUrls(payload, code) {
    const json = JSON.stringify(payload);
    const replaced = json.replace(/"(\/uploads\/[^"]+)"/g, (m, url) => {
      const sep = url.includes('?') ? '&' : '?';
      return `"${url}${sep}share=${code}"`;
    });
    return JSON.parse(replaced);
  }

  router.post('/', requireAuth, async (req, res) => {
    try {
      const uid = req.session?.userId;
      const { type, targetId } = req.body;
      if (!type || !targetId) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      const validTypes = ['post', 'event', 'album'];
      if (!validTypes.includes(type)) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '不支持的分享类型');
      if (!await isShareable(type, targetId)) {
        return sendError(res, 404, ErrorCodes.NOT_FOUND, '分享内容不存在或不可公开分享');
      }

      let shareCode;
      let exists = true;
      while (exists) {
        shareCode = generateShareCode();
        const [rows] = await getPool().query('SELECT id FROM share_links WHERE share_code = ?', [shareCode]);
        exists = rows.length > 0;
      }

      await getPool().query(
        'INSERT INTO share_links (share_code, type, target_id, creator_id, expires_at) VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 7 DAY))',
        [shareCode, type, targetId, uid]
      );

      const shareUrl = `${req.protocol}://${req.get('host')}/api/share/${shareCode}`;
      ok(res, {shareCode, shareUrl, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()});
    } catch (e) { handleError(res, e, '[share]'); }
  });

  router.get('/list', requireAuth, async (req, res) => {
    try {
      const uid = req.session.userId;
      const [rows] = await getPool().query(
        `SELECT id, share_code AS shareCode, type, target_id AS targetId,
                expires_at AS expiresAt, created_at AS createdAt
         FROM share_links WHERE creator_id = ?
         ORDER BY created_at DESC LIMIT 20`,
        [uid]
      );
      res.json({ shares: rows });
    } catch (e) { handleError(res, e, '[share]'); }
  });

  router.get('/:code', async (req, res) => {
    try {
      const [links] = await getPool().query('SELECT * FROM share_links WHERE share_code = ? AND expires_at > NOW()', [req.params.code]);
      if (links.length === 0) return sendError(res, 404, ErrorCodes.NOT_FOUND, '分享链接不存在或已过期');

      const link = links[0];
      let content = null;

      if (link.type === 'post') {
        const [posts] = await getPool().query(
          `SELECT id, user_id AS userId, content, type, visibility,
                  like_count AS likes, comment_count AS comments, created_at AS createdAt
           FROM posts WHERE id = ? AND visibility = 'public'`,
          [link.target_id]
        );
        if (posts.length > 0) {
          const [media] = await getPool().query(
            `SELECT id, media_type AS mediaType, media_url AS mediaUrl, thumb_url AS thumbUrl
             FROM post_media WHERE post_id = ? ORDER BY sort, id`,
            [link.target_id]
          );
          content = { ...posts[0], media };
        }
      } else if (link.type === 'event') {
        const [events] = await getPool().query(
          `SELECT id, title, description, event_time AS eventTime, place, visibility,
                  world_id AS worldId, world_name AS worldName, world_image_url AS worldImageUrl,
                  create_time AS createdAt
           FROM event WHERE id = ? AND visibility = 'public'`,
          [link.target_id]
        );
        if (events.length > 0) content = events[0];
      } else if (link.type === 'album') {
        const [photos] = await getPool().query('SELECT id, cate_id AS cateId, photo_path AS url, thumb_path AS thumbnail, photo_desc AS caption, upload_vrcid AS uploader, upload_name AS uploaderName, like_count AS likes, create_time AS createTime FROM album_photo WHERE id = ? AND visibility = "public" AND is_recycle=0', [link.target_id]);
        if (photos.length > 0) content = photos[0];
      }

      if (!content) return sendError(res, 404, ErrorCodes.NOT_FOUND, '分享内容不存在');

      res.json(embedShareTokenInUrls({
        success: true,
        type: link.type,
        shareCode: link.share_code,
        content,
        expiresAt: link.expires_at,
        createdAt: link.created_at
      }, link.share_code));
    } catch (e) { handleError(res, e, '[share]'); }
  });

  // HTML 转义，防止分享内容中的用户生成文本造成 XSS
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // 把分享内容渲染成一张独立的落地页（供匿名访客直接打开分享链接查看）
  // 媒体 URL 已通过 embedShareTokenInUrls 携带 ?share=<code>，可在 /uploads 鉴权处放行。
  function renderSharePage(link, content) {
    const typeLabel = { post: '动态', event: '活动', album: '相册' }[link.type] || link.type;
    const head = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(typeLabel)}分享 · 境途同游</title>
<meta property="og:title" content="${esc(typeLabel)}分享 · 境途同游">
<meta property="og:type" content="website">
<meta name="description" content="来自境途同游社群的${esc(typeLabel)}分享">
<link rel="stylesheet" href="/css/01-variables.css">
<link rel="stylesheet" href="/css/share-page.css">
</head>
<body class="share-page">
<main class="sp-card">
  <header class="sp-head">
    <span class="sp-badge">${esc(typeLabel)}</span>
    <h1>境途同游 · 分享</h1>
  </header>`;

    let body = '';
    if (link.type === 'post') {
      const text = content.content ? esc(content.content) : '';
      let media = '';
      if (Array.isArray(content.media) && content.media.length) {
        media = '<div class="sp-media">' + content.media.map(m => {
          const url = esc(m.mediaUrl) + (m.mediaUrl.includes('?') ? '&' : '?') + 'share=' + esc(link.share_code);
          if (m.mediaType === 'image') return `<img src="${url}" alt="${esc(m.thumbUrl || '')}" loading="lazy">`;
          if (m.mediaType === 'video') return `<video src="${url}" controls preload="metadata"></video>`;
          return '';
        }).join('') + '</div>';
      }
      const meta = `<div class="sp-meta">${content.likes || 0} 赞 · ${content.comments || 0} 评论</div>`;
      body = `<article class="sp-post"><p class="sp-text">${text}</p>${media}${meta}</article>`;
    } else if (link.type === 'event') {
      const img = content.worldImageUrl
        ? `<img class="sp-cover" src="${esc(content.worldImageUrl)}" alt="">`
        : '';
      body = `<article class="sp-event">
        ${img}
        <h2>${esc(content.title)}</h2>
        <p class="sp-desc">${esc(content.description || '')}</p>
        <ul class="sp-info">
          <li>时间：${esc(content.eventTime || '')}</li>
          <li>地点：${esc(content.place || '')}</li>
          <li>世界：${esc(content.worldName || '')}</li>
        </ul>
      </article>`;
    } else if (link.type === 'album') {
      const url = esc(content.url) + (content.url.includes('?') ? '&' : '?') + 'share=' + esc(link.share_code);
      body = `<article class="sp-album">
        <img class="sp-photo" src="${url}" alt="${esc(content.caption || '')}" loading="lazy">
        ${content.caption ? `<p class="sp-cap">${esc(content.caption)}</p>` : ''}
        <div class="sp-meta">${content.likes || 0} 赞 · 上传者 ${esc(content.uploaderName || '')}</div>
      </article>`;
    }

    const foot = `<footer class="sp-foot">
      <p>该内容由「境途同游」社群成员公开分享</p>
      <a class="sp-cta" href="/">加入境途同游</a>
      <p class="sp-exp">分享有效期至 ${esc(String(link.expires_at || ''))}</p>
    </footer>
  </main>
  </body>
</html>`;
    return head + body + foot;
  }

  // 分享落地页（HTML）：匿名访客直接打开 /api/share/:code/html 查看
  router.get('/:code/html', async (req, res) => {
    try {
      const [links] = await getPool().query('SELECT * FROM share_links WHERE share_code = ? AND expires_at > NOW()', [req.params.code]);
      if (links.length === 0) return res.status(404).send('<h1>分享链接不存在或已过期</h1>');
      const link = links[0];
      let content = null;
      // 复用在 JSON 路由中相同的查询（保持单一数据源）
      if (link.type === 'post') {
        const [posts] = await getPool().query(
          `SELECT id, user_id AS userId, content, type, visibility,
                  like_count AS likes, comment_count AS comments, created_at AS createdAt
           FROM posts WHERE id = ? AND visibility = 'public'`,
          [link.target_id]
        );
        if (posts.length > 0) {
          const [media] = await getPool().query(
            `SELECT id, media_type AS mediaType, media_url AS mediaUrl, thumb_url AS thumbUrl
             FROM post_media WHERE post_id = ? ORDER BY sort, id`,
            [link.target_id]
          );
          content = { ...posts[0], media };
        }
      } else if (link.type === 'event') {
        const [events] = await getPool().query(
          `SELECT id, title, description, event_time AS eventTime, place, visibility,
                  world_id AS worldId, world_name AS worldName, world_image_url AS worldImageUrl,
                  create_time AS createdAt
           FROM event WHERE id = ? AND visibility = 'public'`,
          [link.target_id]
        );
        if (events.length > 0) content = events[0];
      } else if (link.type === 'album') {
        const [photos] = await getPool().query('SELECT id, cate_id AS cateId, photo_path AS url, thumb_path AS thumbnail, photo_desc AS caption, upload_vrcid AS uploader, upload_name AS uploaderName, like_count AS likes, create_time AS createTime FROM album_photo WHERE id = ? AND visibility = "public" AND is_recycle=0', [link.target_id]);
        if (photos.length > 0) content = photos[0];
      }
      if (!content) return res.status(404).send('<h1>分享内容不存在</h1>');
      res.type('html').send(renderSharePage(link, content));
    } catch (e) { handleError(res, e, '[share:page]'); }
  });

  router.delete('/:code', requireAuth, async (req, res) => {
    try {
      const uid = req.session?.userId;
      const role = req.session?.role;
      const isAdmin = role === 'admin' || role === 'super_admin';
      const [links] = await getPool().query('SELECT id, creator_id FROM share_links WHERE share_code = ?', [req.params.code]);
      if (links.length === 0) return sendError(res, 404, ErrorCodes.NOT_FOUND, '分享链接不存在');
      // creator_id 为 null（匿名分享）时也不允许删除，除非管理员
      if (links[0].creator_id !== uid && !isAdmin) return sendError(res, 403, ErrorCodes.FORBIDDEN, '无权删除此分享');
      await getPool().query('DELETE FROM share_links WHERE share_code = ?', [req.params.code]);
      ok(res);
    } catch (e) { handleError(res, e, '[share]'); }
  });

  return router;
};
