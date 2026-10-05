/**
 * 境途同游 — VRChat 头像代理路由
 *
 * 背景：VRChat 头像缩略图来自 api.vrchat.cloud / assets.amlcdn.com，URL 带签名且会过期，
 *       直接在前端 <img> 引用会出现裂图（ERR_NAME_NOT_RESOLVED / 403 / 过期签名）。
 *
 * 解决：后端代理拉取并缓存到本地磁盘（jingtu-web/assets/avatar-cache/），
 *       之后即使源签名过期，本地缓存副本仍长期可用 → 头像"不过期"。
 *       同时带 Referer/Origin 头绕过 VRChat CDN 防盗链。
 *
 * F-5（可配置媒体代理源池）：回源不再单源直连 VRChat CDN，改走
 *       server/media_providers.js 的 provider 链（官方 CDN + 管理员配置的备用镜像），
 *       失败自动切换 + 熔断冷却；缓存分级为 L1 内存 LRU → L2 本地磁盘 → L3 源池回源。
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fail, handleError } = require('../utils');
const { requireAdminCompat } = require('../auth');
const mediaProviders = require('../media_providers');
const { vrchatGetUser } = require('../vrc');

const ALLOWED_HOSTS = [
  'api.vrchat.cloud',
  'api.vrchat.com',
  'assets.amlcdn.com',
  'assets.vrchat.com'
];

// 与 server/vrc.js 一致的 VRChat ID 白名单（usr_ 前缀为主；本接口仅消费用户 ID）
const VRC_UID_PATTERN = /^usr_[0-9a-fA-F-]+$/;

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

// 回源成功结果写入 L1 内存热缓存（整群头像浏览时避免每请求都读磁盘）。
// 双上限：条目数 + 总字节，防止大图把进程内存吃穿。
const L1_MAX_ENTRIES = 1500;
const L1_MAX_BYTES = 24 * 1024 * 1024;
const L1_MAX_AGE_MS = 5 * 60 * 1000; // 5 分钟
const _l1 = new Map();
let _l1Bytes = 0;
function l1Get(key) {
  const e = _l1.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > L1_MAX_AGE_MS) { _l1.delete(key); _l1Bytes -= e.buf.length; return null; }
  return e; // { buf, ct, ts }
}
function l1Put(key, buf, ct) {
  if (_l1.has(key)) {
    const old = _l1.get(key);
    _l1Bytes -= old.buf.length;
    _l1.delete(key);
  }
  if (buf.length > L1_MAX_BYTES / 4) return; // 单张过大不进 L1
  _l1.set(key, { buf, ct, ts: Date.now() });
  _l1Bytes += buf.length;
  while (_l1.size > L1_MAX_ENTRIES || _l1Bytes > L1_MAX_BYTES) {
    const first = _l1.keys().next().value; // Map 保持插入序 → 淘汰最旧
    if (first === undefined) break;
    const old = _l1.get(first);
    _l1Bytes -= old.buf.length;
    _l1.delete(first);
  }
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

// （原单源 fetchRemote 已迁至 server/media_providers.js，并升级为多源 failover：
//   fetchWithFailover 按链序尝试官方 CDN 与管理员配置的镜像源，失败自动切换。）

function sendBuffer(res, buf, contentType) {
  res.set('Content-Type', contentType);
  res.set('Cache-Control', 'public, max-age=604800, immutable');
  // 不再返回 Access-Control-Allow-Origin:*（M3）：同源站点即可用，避免被任意第三方站点盗用代理
  res.send(buf);
}

// ============ 按 VRChat 用户 ID 解析头像（/api/avatar/user） ============
// 背景：群成员列表同步时，非好友成员拿不到 user 对象（VRChat 群成员 API 的 user 字段为 null），
//       头像字段为空。此前前端兜底 api.vrchat.com/api/1/users/{id}/image 已是一条死链
//       （VRChat 先 307 重定向到 api.vrchat.cloud 后返回 404，端点已弃用）；
//       而剩余真实头像 URL 若落在 assets.amlcdn.com，在国内多数网络 TLS 层即被阻断，回源约 19s 超时。
//       本接口用系统 VRChat 账号会话调用 GET /users/{id}（需鉴权）解析出真实头像文件 URL，
//       随后 302 到 /proxy 复用 L1/L2 缓存 / CDN 令牌桶 / 多源 failover 链路，避免重复造轮子。
// 并发与限流：内存缓存 10min（失败冷却 5min）+ 并发去重（同 ID 只查一次）+ 每 IP 60/min 限速，
//       防止整群浏览时把 VRChat 用户 API 额度打爆。限速仅对「回源解析」计费——缓存命中
//       在第 1 步直接返回、不消耗配额（/proxy 同款修复），否则整群头像即使已缓存也会被
//       每 IP 上限卡成占位图。
const _userAvatarCache = new Map();   // uid -> { url, ok, ts }
const _userAvatarInflight = new Map();// uid -> Promise（并发去重）
const USER_AVATAR_OK_TTL_MS = 10 * 60 * 1000;
const USER_AVATAR_FAIL_TTL_MS = 5 * 60 * 1000;
const USER_AVATAR_RATE_MIN = 60;
const _userRateBuckets = new Map();
function userAvatarRateLimited(ip) {
  const now = Date.now();
  let b = _userRateBuckets.get(ip);
  if (!b || now - b.start > 60 * 1000) {
    b = { start: now, count: 0 };
    _userRateBuckets.set(ip, b);
  }
  b.count++;
  if (b.count > USER_AVATAR_RATE_MIN) return true;
  if (_userRateBuckets.size > 5000) {
    for (const [k, v] of _userRateBuckets) {
      if (now - v.start > 60 * 1000) _userRateBuckets.delete(k);
    }
  }
  return false;
}
async function resolveUserAvatarUrl(cookie, uid) {
  const inflight = _userAvatarInflight.get(uid);
  if (inflight) return inflight;
  const p = (async () => {
    const userRes = await vrchatGetUser(uid, cookie);
    if (!userRes || userRes.status !== 200) return '';
    const d = userRes.data || {};
    const url = d.profilePicOverrideThumbnail || d.currentAvatarThumbnailImageUrl || d.currentAvatarImageUrl || '';
    if (!url) return '';
    try {
      const h = new URL(url).hostname;
      if (ALLOWED_HOSTS.includes(h)) return url;
    } catch (e) { /* 非法 URL 走失败缓存 */ }
    return '';
  })();
  _userAvatarInflight.set(uid, p);
  p.finally(() => _userAvatarInflight.delete(uid)).catch(() => {});
  return p;
}

module.exports = function (authStateRef) {
  const router = express.Router();

  // 默认头像路由已移除（P2-15 路由冲突清理）：server.js 顶部的 app.get('/api/avatar/default')
  // 先注册生效，此处重复注册不可达；DEFAULT_AVATAR_SVG 仍被 /proxy 与 fallback 使用。

  // 按 VRChat 用户 ID 解析真实头像并 302 到 /proxy（复用 L1/L2 缓存与源池 failover）。
  // 前端在成员头像 URL 缺失/不可达（如 assets.amlcdn.com 被墙）时使用。
  router.get('/user', async (req, res) => {
    const uid = String(req.query.u || '');
    if (!VRC_UID_PATTERN.test(uid)) return fail(res, 400, 'bad user id');

    // 1) 内存缓存命中：直接返回，不消耗限速配额（/proxy 同款根因修复）。
    //    旧逻辑在缓存命中之前就限速，缓存 IP 的 60/min 配额也被整群浏览瞬间耗尽，
    //    第 61 个请求起全部降级为占位图（线上实测：同一 uid 连发 62 次，前 60 次 302、之后全占位）。
    const now = Date.now();
    const hit = _userAvatarCache.get(uid);
    if (hit && (hit.ok ? (now - hit.ts < USER_AVATAR_OK_TTL_MS) : (now - hit.ts < USER_AVATAR_FAIL_TTL_MS))) {
      if (hit.ok) return res.redirect(302, '/api/avatar/proxy?u=' + encodeURIComponent(hit.url));
      return sendBuffer(res, Buffer.from(DEFAULT_AVATAR_SVG), 'image/svg+xml');
    }
    if (!authStateRef || !authStateRef.loggedIn || !authStateRef.cookie) {
      // 系统账号未登录时无法解析（/users/{id} 需鉴权），直接占位且不写失败缓存，
      // 待系统账号登录后自然恢复，也避免把"未登录"误判为"该用户无头像"。
      return sendBuffer(res, Buffer.from(DEFAULT_AVATAR_SVG), 'image/svg+xml');
    }

    // 2) 限速（仅对「回源解析」计费）：未命中缓存、真正要调 VRChat 用户 API 前才限速，
    //    防止批量冷查打爆用户 API；已缓存头像的请求在第 1 步即返回，不消耗配额。
    // P3-119：仅当直连对端为回环（即经本机 nginx 反代）时才信任 x-forwarded-for。
    const socketAddr = (req.socket && req.socket.remoteAddress) || '';
    const isLoopbackPeer = socketAddr === '::1' || socketAddr === '127.0.0.1' || socketAddr === '::ffff:127.0.0.1';
    const clientIp = (isLoopbackPeer && req.headers['x-forwarded-for'])
      ? String(req.headers['x-forwarded-for']).split(',')[0].trim()
      : socketAddr;
    if (userAvatarRateLimited(clientIp)) return sendBuffer(res, Buffer.from(DEFAULT_AVATAR_SVG), 'image/svg+xml');

    try {
      const url = await resolveUserAvatarUrl(authStateRef.cookie, uid);
      if (url) {
        _userAvatarCache.set(uid, { url, ok: true, ts: now });
        return res.redirect(302, '/api/avatar/proxy?u=' + encodeURIComponent(url));
      }
      _userAvatarCache.set(uid, { url: '', ok: false, ts: now });
      return sendBuffer(res, Buffer.from(DEFAULT_AVATAR_SVG), 'image/svg+xml');
    } catch (e) {
      _userAvatarCache.set(uid, { url: '', ok: false, ts: now });
      return sendBuffer(res, Buffer.from(DEFAULT_AVATAR_SVG), 'image/svg+xml');
    }
  });

  // 代理 VRChat 头像：缓存到本地，源过期也不影响
  router.get('/proxy', async (req, res) => {
    const u = req.query.u;
    if (!u || typeof u !== 'string') return fail(res, 400, 'missing u');

    const host = safeHost(u);
    if (!ALLOWED_HOSTS.includes(host)) {
      return fail(res, 400, 'host not allowed: ' + host);
    }
    if (!/^https?:\/\//i.test(u)) return fail(res, 400, 'bad url');

    ensureCacheDir();
    const key = cacheKeyFor(u);
    const cacheFile = path.join(CACHE_DIR, key + '.img');

    // 1) L1 内存热缓存：直接返回，不读磁盘、不消耗限速配额
    const hit = l1Get(key);
    if (hit) return sendBuffer(res, hit.buf, hit.ct);

    // 2) L2 命中本地缓存：直接返回，不消耗限速配额。
    //    （根因修复：旧逻辑在缓存之前就限速，导致头像已缓存也会被每 IP 上限卡成 429）
    try {
      if (fs.existsSync(cacheFile)) {
        const stat = fs.statSync(cacheFile);
        if (Date.now() - stat.mtimeMs < CACHE_MAX_AGE_MS) {
          const buf = fs.readFileSync(cacheFile);
          let ct = 'image/jpeg';
          try { ct = fs.readFileSync(cacheFile + '.ct', 'utf8'); } catch (e) { /* 缺 content-type 文件则回退 */ }
          l1Put(key, buf, ct);
          return sendBuffer(res, buf, ct);
        }
      }
    } catch (e) { /* 缓存读失败则回源 */ }

    // 3) 限速（仅对「回源」计费）：超限返回占位头像而非 429 JSON，
    //    避免 <img> 裂图并刷满控制台；上游节流由 CDN 全局令牌桶兜底。
    // P3-119：仅当直连对端为回环（即经本机 nginx 反代）时才信任 x-forwarded-for，
    // 否则回退 socket 地址——客户端直接连时不采信可自造的 XFF，避免轮换桶绕过每 IP 限速。
    const socketAddr = (req.socket && req.socket.remoteAddress) || '';
    const isLoopbackPeer = socketAddr === '::1' || socketAddr === '127.0.0.1' || socketAddr === '::ffff:127.0.0.1';
    const clientIp = (isLoopbackPeer && req.headers['x-forwarded-for'])
      ? String(req.headers['x-forwarded-for']).split(',')[0].trim()
      : socketAddr;
    if (avatarRateLimited(clientIp)) {
      res.set('Content-Type', 'image/svg+xml');
      res.set('Cache-Control', 'no-store');
      return res.send(DEFAULT_AVATAR_SVG);
    }

    // 4) 回源：经 CDN 全局令牌桶限速 + 多源 failover（官方 CDN →/← 镜像池，熔断冷却跳过死源）
    try {
      await cdnAcquire();
      const { buffer, contentType } = await mediaProviders.fetchWithFailover(u);
      // 写 L1/L2 缓存（忽略写失败），并触发磁盘缓存清理
      l1Put(key, buffer, contentType);
      try {
        fs.writeFileSync(cacheFile, buffer);
        fs.writeFileSync(cacheFile + '.ct', contentType);
        pruneCacheIfNeeded();
      } catch (e) { /* 忽略 */ }
      return sendBuffer(res, buffer, contentType);
    } catch (e) {
      // 5) 回源失败：若有旧缓存（即便超龄）也兜底返回，避免裂图
      try {
        if (fs.existsSync(cacheFile)) {
          const buf = fs.readFileSync(cacheFile);
          let ct = 'image/jpeg';
          try { ct = fs.readFileSync(cacheFile + '.ct', 'utf8'); } catch (e2) { /* 缺 content-type 文件则回退 */ }
          return sendBuffer(res, buf, ct);
        }
      } catch (e2) { /* ignore */ }
      // 无缓存兜底：返回占位头像而非 502 JSON，避免 <img> 裂图
      res.set('Content-Type', 'image/svg+xml');
      res.set('Cache-Control', 'no-store');
      return res.send(DEFAULT_AVATAR_SVG);
    }
  });

  // 源池状态（管理员排障用）：当前生效配置 + 各源熔断状态
  router.get('/providers', requireAdminCompat, async (req, res) => {
    try {
      const cfg = mediaProviders.getConfig();
      res.json({
        mirrorFirst: cfg.media_provider_mirror_first === '1',
        timeoutMs: Number(cfg.media_provider_timeout_ms),
        mirrors: (() => { try { return JSON.parse(cfg.media_provider_mirrors || '[]'); } catch (e) { return []; } })(),
        chain: mediaProviders.getChain().map((p) => ({
          name: p.name,
          coolingDown: mediaProviders.isCoolingDown(p.name),
        })),
      });
    } catch (e) { handleError(res, e, '[avatar/providers]'); }
  });

  return router;
};
