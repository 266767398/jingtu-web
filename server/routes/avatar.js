/**
 * 境途同游 — VRChat 头像代理路由
 *
 * 背景：VRChat 头像缩略图来自 api.vrchat.cloud / assets.amlcdn.com，URL 带签名且会过期，
 *       直接在前端 <img> 引用会出现裂图（ERR_NAME_NOT_RESOLVED / 403 / 过期签名）。
 *
 * 解决：后端代理拉取并缓存到本地磁盘（jingtu-web/assets/avatar-cache/），
 *       之后即使源签名过期，本地缓存副本仍长期可用 → 头像"不过期"。
 *       同时带 Referer/Origin 头绕过 VRChat CDN 防盗链。
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const ALLOWED_HOSTS = [
  'api.vrchat.cloud',
  'api.vrchat.com',
  'assets.amlcdn.com',
  'assets.vrchat.com'
];

// 回源最大体积（防止通过代理拉取超大资源撑爆内存/磁盘）
const MAX_BODY_BYTES = 8 * 1024 * 1024; // 8MB

// 默认占位头像（纯文本 SVG，绝不裂图）—— /default 与限速兜底共用
const DEFAULT_AVATAR_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">' +
  '<rect width="120" height="120" rx="60" fill="#2b3553"/>' +
  '<circle cx="60" cy="46" r="22" fill="#8aa0c8"/>' +
  '<path d="M20 108 C20 80 100 80 100 108 Z" fill="#8aa0c8"/></svg>';

// 简单内存限速：每 IP 每分钟最多 1000 次「回源」请求（防滥用填充磁盘的 DoS）。
// 命中本地缓存的请求不消耗配额（缓存命中在限速之前返回），否则整群头像即使已缓存，
// 也会被卡成 429（线上实锤：群组一屏 + 四处浏览，冷缓存下 1 分钟极易超过 120）。
// 真正的上游节流由下方 CDN 全局令牌桶（200/min）兜底；磁盘填充由 CACHE_MAX_FILES 兜底。
const _rateBuckets = new Map();
const AVATAR_RATE_LIMIT = 1000;
const AVATAR_RATE_WINDOW_MS = 60 * 1000;
function avatarRateLimited(ip) {
  const now = Date.now();
  let b = _rateBuckets.get(ip);
  if (!b || now - b.start > AVATAR_RATE_WINDOW_MS) {
    b = { start: now, count: 0 };
    _rateBuckets.set(ip, b);
  }
  b.count++;
  if (b.count > AVATAR_RATE_LIMIT) return true;
  // 定期清理过期桶，避免内存泄漏
  if (_rateBuckets.size > 5000) {
    for (const [k, v] of _rateBuckets) {
      if (now - v.start > AVATAR_RATE_WINDOW_MS) _rateBuckets.delete(k);
    }
  }
  return false;
}

const CACHE_DIR = path.join(__dirname, '..', '..', 'assets', 'avatar-cache');
const CACHE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30; // 本地缓存 30 天（源过期也不影响）
const CACHE_MAX_FILES = 20000; // 缓存文件上限，超出则清理最旧的（防磁盘被撑爆）

function ensureCacheDir() {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  } catch (e) {
    // 忽略
  }
}

function safeHost(u) {
  try {
    return new URL(u).hostname;
  } catch (e) {
    return '';
  }
}

function cacheKeyFor(u) {
  return crypto.createHash('sha256').update(u).digest('hex');
}

// 缓存超限时清理最旧文件（按 mtime 升序删到上限的 90%）
function pruneCacheIfNeeded() {
  try {
    const files = fs.readdirSync(CACHE_DIR)
      .filter((f) => f.endsWith('.img'))
      .map((f) => ({ f, m: fs.statSync(path.join(CACHE_DIR, f)).mtimeMs }))
      .sort((a, b) => a.m - b.m);
    if (files.length > CACHE_MAX_FILES) {
      const drop = files.slice(0, Math.ceil(files.length * 0.1));
      for (const { f } of drop) {
        try { fs.unlinkSync(path.join(CACHE_DIR, f)); } catch (e) {}
        try { fs.unlinkSync(path.join(CACHE_DIR, f + '.ct')); } catch (e) {}
      }
    }
  } catch (e) { /* ignore */ }
}

/**
 * V9.0: VRChat 图片 CDN 全局令牌桶（同 VRChat API 限流思路）
 * 头像代理回源时若瞬时并行拉取整群头像（数百张），会打爆 VRChat CDN 触发 429。
 * 这里对"回源请求"做全局限速，避免代理自身成为 429 制造者。
 * 命中本地缓存的请求不消耗令牌（见 /proxy 路由）。
 *
 * 调整：原 40/min 过于保守——它把"所有头像（我的 + 群组一屏）"都塞进同一个
 * 40/min 串行队列，导致头像普遍要等数十秒才出现（用户报"我的头像和群组头像一样慢"）。
 * VRChat 图片 CDN（amlcdn）限流远比 API 宽松，提高到 200/min 足以覆盖整群头像热加载，
 * 同时仍远低于会触发 429 的阈值。配合前端懒加载（仅可见头像才请求），实际并发更低。
 *
 * 另外：把"严格串行（一次只放一个令牌）"改为"不串行等待"——令牌充足时立即放行，
 * 不足时才进队列按 drip 节奏放行。这样单张回源卡住（10s 超时）不会拖累队列里 others。
 */
const CDN_RATE_LIMIT = 200;
const CDN_RATE_WINDOW_MS = 60 * 1000;
let cdnTokens = CDN_RATE_LIMIT;
let cdnLastTs = Date.now();
const cdnQueue = [];
let cdnDripTimer = null;
function cdnRefill() {
  const now = Date.now();
  const elapsed = now - cdnLastTs;
  if (elapsed > 0) {
    cdnTokens = Math.min(CDN_RATE_LIMIT, cdnTokens + (elapsed / CDN_RATE_WINDOW_MS) * CDN_RATE_LIMIT);
    cdnLastTs = now;
  }
}
function cdnDrip() {
  cdnRefill();
  while (cdnQueue.length && cdnTokens >= 1) { cdnTokens -= 1; cdnQueue.shift()(); }
  cdnDripTimer = cdnQueue.length ? setTimeout(cdnDrip, 200) : null;
}
function cdnAcquire() {
  cdnRefill();
  if (cdnTokens >= 1) { cdnTokens -= 1; return Promise.resolve(); }
  // 回源令牌暂不可用：排队等待 drip 补充。最多等待 8s，超时则直接放行（宁可被源站 429 兜底，
  // 也不让头像无限期卡在队列里——429 会触发 fetchRemote 的退避重试，最终仍会出图）。
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; cdnQueue.splice(cdnQueue.indexOf(run), 1); resolve(); }
    }, 8000);
    const run = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    cdnQueue.push(run);
    if (!cdnDripTimer) cdnDripTimer = setTimeout(cdnDrip, 200);
  });
}

// 用内置 http/https 拉取（零依赖，绕开 Node fetch 版本差异）。
// _retry 用于 429 / 网络抖动的指数退避重试，避免偶发限流直接暴露为裂图。
function fetchRemote(u, redirects, _retry) {
  redirects = redirects || 0;
  _retry = _retry || 0;
  return new Promise((resolve, reject) => {
    if (redirects > 4) return reject(new Error('too many redirects'));
    const parsed = new URL(u);
    const lib = parsed.protocol === 'http:' ? http : https;
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      'Referer': 'https://vrchat.com/',
      'Origin': 'https://vrchat.com',
      'Accept': 'image/avif,image/webp,image/png,image/*,*/*'
    };
    const req = lib.request(u, { method: 'GET', headers, timeout: 10000 }, (resp) => {
      const { statusCode, headers: h } = resp;
      if (statusCode >= 300 && statusCode < 400 && h.location) {
        resp.resume();
        const next = new URL(h.location, u).toString();
        return resolve(fetchRemote(next, redirects + 1, _retry));
      }
      if (statusCode === 429) {
        resp.resume();
        if (_retry < 3) { setTimeout(() => resolve(fetchRemote(u, redirects, _retry + 1)), Math.min(4000, 800 * (_retry + 1))); return; }
        return reject(new Error('upstream status 429'));
      }
      if (statusCode !== 200) {
        resp.resume();
        return reject(new Error('upstream status ' + statusCode));
      }
      // 体积硬上限：超直接断开
      const len = parseInt(h['content-length'] || '0', 10);
      if (len > MAX_BODY_BYTES) {
        resp.resume();
        return reject(new Error('payload too large'));
      }
      let total = 0;
      const chunks = [];
      resp.on('data', (c) => {
        total += c.length;
        if (total > MAX_BODY_BYTES) {
          resp.destroy(new Error('payload too large'));
          return;
        }
        chunks.push(c);
      });
      resp.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType: h['content-type'] || 'image/jpeg' }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

function sendBuffer(res, buf, contentType) {
  res.set('Content-Type', contentType);
  res.set('Cache-Control', 'public, max-age=604800, immutable');
  // 不再返回 Access-Control-Allow-Origin:*（M3）：同源站点即可用，避免被任意第三方站点盗用代理
  res.send(buf);
}

module.exports = function () {
  const router = express.Router();

  // 默认头像（兜底，纯文本 SVG，绝不裂图）
  router.get('/default', (req, res) => {
    res.set('Content-Type', 'image/svg+xml');
    res.set('Cache-Control', 'public, max-age=604800, immutable');
    res.send(DEFAULT_AVATAR_SVG);
  });

  // 代理 VRChat 头像：缓存到本地，源过期也不影响
  router.get('/proxy', async (req, res) => {
    const u = req.query.u;
    if (!u || typeof u !== 'string') return res.status(400).json({ error: 'missing u' });

    const host = safeHost(u);
    if (!ALLOWED_HOSTS.includes(host)) {
      return res.status(400).json({ error: 'host not allowed: ' + host });
    }
    if (!/^https?:\/\//i.test(u)) return res.status(400).json({ error: 'bad url' });

    ensureCacheDir();
    const key = cacheKeyFor(u);
    const cacheFile = path.join(CACHE_DIR, key + '.img');

    // 1) 命中本地缓存：直接返回，不消耗限速配额。
    //    （根因修复：旧逻辑在缓存之前就限速，导致头像已缓存也会被每 IP 上限卡成 429）
    try {
      if (fs.existsSync(cacheFile)) {
        const stat = fs.statSync(cacheFile);
        if (Date.now() - stat.mtimeMs < CACHE_MAX_AGE_MS) {
          const buf = fs.readFileSync(cacheFile);
          let ct = 'image/jpeg';
          try { ct = fs.readFileSync(cacheFile + '.ct', 'utf8'); } catch (e) { /* 缺 content-type 文件则回退 */ }
          return sendBuffer(res, buf, ct);
        }
      }
    } catch (e) { /* 缓存读失败则回源 */ }

    // 2) 限速（仅对「回源」计费）：超限返回占位头像而非 429 JSON，
    //    避免 <img> 裂图并刷满控制台；上游节流由 CDN 全局令牌桶兜底。
    const clientIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
    if (avatarRateLimited(clientIp)) {
      res.set('Content-Type', 'image/svg+xml');
      res.set('Cache-Control', 'no-store');
      return res.send(DEFAULT_AVATAR_SVG);
    }

    // 3) 回源拉取（经 CDN 全局令牌桶限速，避免瞬时数百请求打爆 VRChat CDN 触发 429）
    try {
      await cdnAcquire();
      const { buffer, contentType } = await fetchRemote(u, 0);
      // 写缓存（忽略写失败），并触发缓存清理
      try {
        fs.writeFileSync(cacheFile, buffer);
        fs.writeFileSync(cacheFile + '.ct', contentType);
        pruneCacheIfNeeded();
      } catch (e) { /* 忽略 */ }
      return sendBuffer(res, buffer, contentType);
    } catch (e) {
      // 3) 回源失败：若有旧缓存（即便超龄）也兜底返回，避免裂图
      try {
        if (fs.existsSync(cacheFile)) {
          const buf = fs.readFileSync(cacheFile);
          let ct = 'image/jpeg';
          try { ct = fs.readFileSync(cacheFile + '.ct', 'utf8'); } catch (e) { /* 缺 content-type 文件则回退 */ }
          return sendBuffer(res, buf, ct);
        }
      } catch (e2) { /* ignore */ }
      // 无缓存兜底：返回占位头像而非 502 JSON，避免 <img> 裂图
      res.set('Content-Type', 'image/svg+xml');
      res.set('Cache-Control', 'no-store');
      return res.send(DEFAULT_AVATAR_SVG);
    }
  });

  return router;
};
