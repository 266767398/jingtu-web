/**
 * 境途同游 — 站点地图路由
 * 
 * @swagger
 * tags:
 *   name: Sitemap
 *   description: 站点地图相关接口
 */
const express = require('express');
const router = express.Router();
const { getPool, handleError } = require('../utils');
const logger = require('../logger');

// baseUrl 仅从环境变量读取，忽略 Host 头，防止 Host 头注入导致 SEO 劫持
// P2-72：接入 APP_URL（docker-compose 实际透传的站点地址变量）作为回退，
// 否则容器部署下 sitemap 会落到本地默认值；默认端口同步修正为真实监听端口 3456。
function getBaseUrl() {
  return process.env.SITEMAP_BASE_URL || process.env.APP_URL || process.env.APP_BASE_URL || 'http://localhost:3456';
}

router.get('/sitemap.xml', async (req, res) => {
  try {
    const baseUrl = getBaseUrl();
    const now = new Date().toISOString().split('T')[0];

    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${baseUrl}/</loc>
    <lastmod>${now}</lastmod>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${baseUrl}/members</loc>
    <lastmod>${now}</lastmod>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>${baseUrl}/events</loc>
    <lastmod>${now}</lastmod>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>${baseUrl}/posts</loc>
    <lastmod>${now}</lastmod>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${baseUrl}/album</loc>
    <lastmod>${now}</lastmod>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${baseUrl}/announcements</loc>
    <lastmod>${now}</lastmod>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${baseUrl}/chat</loc>
    <lastmod>${now}</lastmod>
    <priority>0.7</priority>
  </url>`;

    try {
      const [events] = await getPool().query(
        `SELECT id, updated_at FROM event WHERE is_archive = 0 AND visibility = 'public' ORDER BY updated_at DESC LIMIT 100`
      );
      events.forEach(evt => {
        const lastmod = evt.updated_at ? new Date(evt.updated_at).toISOString().split('T')[0] : now;
        xml += `
  <url>
    <loc>${baseUrl}/events/${evt.id}</loc>
    <lastmod>${lastmod}</lastmod>
    <priority>0.6</priority>
  </url>`;
      });
    } catch (e) {
      logger.warn('sitemap', '[sitemap] Failed to query events:', e.message);
    }

    try {
      const [posts] = await getPool().query(
        `SELECT id, updated_at FROM posts WHERE visibility = 'public' ORDER BY updated_at DESC LIMIT 100`
      );
      posts.forEach(post => {
        const lastmod = post.updated_at ? new Date(post.updated_at).toISOString().split('T')[0] : now;
        xml += `
  <url>
    <loc>${baseUrl}/posts/${post.id}</loc>
    <lastmod>${lastmod}</lastmod>
    <priority>0.5</priority>
  </url>`;
      });
    } catch (e) {
      logger.warn('sitemap', '[sitemap] Failed to query posts:', e.message);
    }

    try {
      const [photos] = await getPool().query(
        `SELECT id, create_time FROM album_photo WHERE is_recycle = 0 AND visibility = 'public' ORDER BY create_time DESC LIMIT 100`
      );
      photos.forEach(photo => {
        const lastmod = photo.create_time ? new Date(photo.create_time).toISOString().split('T')[0] : now;
        xml += `
  <url>
    <loc>${baseUrl}/album/photo/${photo.id}</loc>
    <lastmod>${lastmod}</lastmod>
    <priority>0.5</priority>
  </url>`;
      });
    } catch (e) {
      logger.warn('sitemap', '[sitemap] Failed to query photos:', e.message);
    }

    xml += `
</urlset>`;

    res.setHeader('Content-Type', 'application/xml');
    res.send(xml);
  } catch (e) {
    handleError(res, e, '[sitemap]');
  }
});

router.get('/robots.txt', (req, res) => {
  const baseUrl = getBaseUrl();
  const robots = `User-agent: *
Allow: /
Disallow: /admin/
Disallow: /api/
Disallow: /setup
Sitemap: ${baseUrl}/sitemap.xml
`;
  res.setHeader('Content-Type', 'text/plain');
  res.send(robots);
});

module.exports = router;