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
const { getPool } = require('../db');

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

// V9.5（省流量）：VRCX convertFileUrlToImageUrl 同款——把 VRChat 原图 URL
//   /file/file_{id}/{v}/file 或 /file/file_{id}/{v}（原图可数 MB）
// 转成缩略图 URL /image/file_{id}/{v}/256（几十 KB，省 95%+ 流量）。
// 已是缩略图（/image/.../{v}/{size}）的 URL 正则不匹配、保持原样，幂等。
// /proxy 磁盘缓存直接缓存 256 小图，反复浏览不再下载大图。
function toThumbnailUrl(u) {
  if (!u || typeof u !== 'string') return u;
  return u.replace(/file\/file_([a-f0-9-]+)\/(\d+)(?:\/file)?\/?$/, 'image/file_$1/$2/256');
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

// 失败兜底统一返回占位 SVG（V9.2 起统一返回 200，不再 502）：
//   - sendPlaceholderOk(res)：200 = 会话/存储/CDN 均无可用的真实头像，浏览器 <img>
//     直接渲染默认占位，不制造控制台 502 噪音；列表每 30s 刷新会重新请求，源恢复后自动出图。
// no-store 防止浏览器缓存失败结果，避免源恢复后仍显示旧占位。
// sendPlaceholder（502）保留定义作兼容，当前 avatar.js 内已无调用点。
function sendPlaceholder(res) {
  res.status(502);
  res.set('Content-Type', 'image/svg+xml');
  res.set('Cache-Control', 'no-store');
  return res.send(DEFAULT_AVATAR_SVG);
}

function sendPlaceholderOk(res) {
  res.status(200);
  res.set('Content-Type', 'image/svg+xml');
  res.set('Cache-Control', 'no-store');
  return res.send(DEFAULT_AVATAR_SVG);
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
async function resolveUserAvatarUrl(cookie, uid, isSystemCookie) {
  const inflight = _userAvatarInflight.get(uid);
  if (inflight) return inflight;
  const p = (async () => {
    const userRes = await vrchatGetUser(uid, cookie);
    if (userRes && (userRes.status === 401 || userRes.status === 403)) {
      // V9.2: 任意会话被拒（系统或用户绑定 cookie）都触发全局熔断，
      // 避免「用户 cookie 被顶号 → 每个 uid 每次都真实回源 9s → 502」的页面级洪流。
      markGlobalVrcFail();
      if (isSystemCookie) {
        // 系统账号 cookie 已被 VRChat 拒绝：进入 10 分钟熔断窗口，
        // 期间对其它成员不再重复发起注定 401 的回源（见 isSystemCookieStale）。
        markSystemCookieStale(cookie);
      }
    }
    if (!userRes || userRes.status !== 200) return '';
    const d = userRes.data || {};
    // V9.3: /users/{id} 已不再返回 currentAvatar*（VRChat 升级个人资料体系后废弃），
    // 新字段 iconUrl（个人资料图标，非好友/隐私受限成员也始终返回）作为头像兜底。
    const url = d.profilePicOverrideThumbnail || d.currentAvatarThumbnailImageUrl || d.currentAvatarImageUrl || d.iconUrl || '';
    if (!url) return '';
    try {
      const h = new URL(url).hostname;
      if (ALLOWED_HOSTS.includes(h)) return toThumbnailUrl(url);
    } catch (e) { /* 非法 URL 走失败缓存 */ }
    return '';
  })();
  _userAvatarInflight.set(uid, p);
  p.finally(() => _userAvatarInflight.delete(uid)).catch(() => {});
  return p;
}

// 库内头像兜底链（V9.1 + F-24 扩展）：按优先级依次查
//   1) group_roster.avatar_url —— schedule「信任等级+头像联合补充循环」每轮 20 人实时解析写入的最新头像；
//   2) users.vrchat_avatar_url —— 站内用户绑定 VRChat 时落库的直链；
//   3) group_member_vrc_cache.data.avatarUrl —— 群成员资料缓存的头像缩略图；
//   4) avatar_history_current.avatar_url —— 头像历史最近一次成功记录。
// 全部命中失败才返回空（调用方降级占位）。URL 一律过 ALLOWED_HOSTS 白名单，防 SSRF。
async function resolveStoredAvatarFromDb(uid) {
  try {
    const pool = await getPool();
    const [rosterRows] = await pool.query(
      `SELECT avatar_url FROM group_roster WHERE vrchat_id = ? AND avatar_url IS NOT NULL AND avatar_url != '' LIMIT 1`,
      [uid]
    );
    const r = rosterRows && rosterRows[0] && rosterRows[0].avatar_url;
    if (r) {
      const h = safeHost(r);
      if (ALLOWED_HOSTS.includes(h)) return toThumbnailUrl(r);
    }
    const [userRows] = await pool.query(
      `SELECT vrchat_avatar_url FROM users WHERE vrchat_id = ? AND vrchat_avatar_url IS NOT NULL AND vrchat_avatar_url != '' AND deleted_at IS NULL LIMIT 1`,
      [uid]
    );
    const ur = userRows && userRows[0] && userRows[0].vrchat_avatar_url;
    if (ur) {
      const h = safeHost(ur);
      if (ALLOWED_HOSTS.includes(h)) return toThumbnailUrl(ur);
    }
    const [cacheRows] = await pool.query(
      `SELECT data FROM group_member_vrc_cache WHERE vrchat_id = ? LIMIT 1`,
      [uid]
    );
    if (cacheRows && cacheRows[0]) {
      let d = null;
      try { d = typeof cacheRows[0].data === 'string' ? JSON.parse(cacheRows[0].data) : cacheRows[0].data; } catch (e) { d = null; }
      const c = d && (d.avatarUrl || d.currentAvatarThumbnailImageUrl || d.iconUrl || '');
      if (c) {
        const h = safeHost(c);
        if (ALLOWED_HOSTS.includes(h)) return toThumbnailUrl(c);
      }
    }
    const [histRows] = await pool.query(
      `SELECT avatar_url FROM avatar_history_current WHERE vrchat_id = ? AND avatar_url IS NOT NULL AND avatar_url != '' ORDER BY synced_at DESC LIMIT 1`,
      [uid]
    );
    const u = histRows && histRows[0] && histRows[0].avatar_url;
    if (u) {
      const h = safeHost(u);
      if (ALLOWED_HOSTS.includes(h)) return toThumbnailUrl(u);
    }
    return '';
  } catch (e) {
    return '';
  }
}

// V9.4: 回源解析成功后将头像 URL 落库（group_roster.avatar_url，仅当为空时写），
// 后续同一成员的头像请求直接命中存储兜底，不再重复回源 VRChat API。
// 与 schedule 补充循环共用同一字段，双向互不覆盖（仅空值写入，保留较新值）。
// fire-and-forget：落库失败不影响本次响应（图片已 302 到 /proxy）。
async function persistAvatarUrlToDb(uid, url) {
  try {
    if (!url) return;
    const h = safeHost(url);
    if (!ALLOWED_HOSTS.includes(h)) return;
    const pool = await getPool();
    await pool.query(
      `UPDATE group_roster SET avatar_url = ? WHERE vrchat_id = ? AND (avatar_url IS NULL OR avatar_url = '')`,
      [toThumbnailUrl(url), uid]
    );
  } catch (e) { /* 忽略：落库失败下次回源会再写 */ }
}

// 系统账号 cookie 失效熔断（V9.1 头像加固）：系统账号被 VRChat 顶号/401 后，
// 若不加熔断，/user 路由会在 5 分钟失败冷却 TTL 内对每个成员都发起一次真实回源
// /users/{id}（全部 401），群组一屏 50+ 成员 → 每次刷新都是 50+ 次无效上游调用，
// 既浪费 VRChat API 额度又拖慢头像加载。这里在首次 401 后熔断 10 分钟：
// 期间系统 cookie 的回源解析直接跳过，只走库内存储兜底（已绑定/已缓存成员仍可出图，
// 无存储数据的成员快速降级占位，不再制造无意义的 401 洪流）。
// 用户自己绑定的 cookie 不受熔断影响（getVRCCookieFn 内部已做软过期判定）。
let _systemCookieStaleUntil = 0;
let _systemCookieStaleId = '';
const SYSTEM_COOKIE_STALE_TTL_MS = 10 * 60 * 1000;

// V9.2: 全局 401 熔断——覆盖「用户绑定 cookie 被顶号」场景。此前只熔断系统 cookie，
// 用户 cookie 失效时每个 uid 每次都真实回源（约 9s/次）后 502，页面一刷新就是一整屏
// 慢请求 + 502。改为：任意会话（系统或用户绑定）被 VRChat 401/403 拒绝后，全局熔断
// GLOBAL_VRC_FAIL_TTL_MS(5min)，期间所有 uid 跳过注定失败的回源，直接走存储兜底/占位。
// 误伤面：A 用户的失效 cookie 会短暂屏蔽 B 用户的有效会话 5 分钟——远轻于 401 洪流代价。
let _globalVrcFailUntil = 0;
const GLOBAL_VRC_FAIL_TTL_MS = 5 * 60 * 1000;

function markGlobalVrcFail() {
  _globalVrcFailUntil = Date.now() + GLOBAL_VRC_FAIL_TTL_MS;
}

function isGlobalVrcFail() {
  return Date.now() < _globalVrcFailUntil;
}

function markSystemCookieStale(cookie) {
  _systemCookieStaleUntil = Date.now() + SYSTEM_COOKIE_STALE_TTL_MS;
  _systemCookieStaleId = cookie || '';
}

function isSystemCookieStale(cookie) {
  if (!cookie || Date.now() > _systemCookieStaleUntil) return false;
  return !_systemCookieStaleId || _systemCookieStaleId === cookie;
}

// V9.1: 系统 VRChat 会话实时失效判定——优先复用 server.js 健康检查同款信号
//（vrc-pipeline 的 sessionRejected：服务端已拒绝 authToken，无需等本模块首个 401）。
// 重启/熔断内存清空后仍能立刻短路回源，避免「每次重启后首轮 50+ 次注定 401 的请求」。
function isSystemCookieUnusable() {
  if (typeof global.__getVrcPipelineStatus !== 'function') return false;
  try {
    const ph = global.__getVrcPipelineStatus();
    return !!(ph && ph.sessionRejected);
  } catch (e) {
    return false;
  }
}

module.exports = function (authStateRef, getVRCCookieFn) {
  const router = express.Router();

  // 按候选顺序取「可用于解析 /users/{id} 的 VRChat 会话」：
  //   1) 请求者本人绑定的 VRChat cookie（getVRCCookie 内部已处理解密与软性过期）——用户会话绑定优先
  //   2) 系统账号 cookie（authStateRef）
  // 背景：群成员头像解析依赖 VRChat API 鉴权，此前只认系统账号；系统账号被 VRChat 顶号/失效时
  // 全站头像全部降级为占位。改为优先用请求者自己的绑定 cookie 后，只要站点上任意在线用户
  // 绑定了 VRChat，群成员头像仍可解析，系统账号失效不再是一票否决。
  function resolveAvatarCookie(req) {
    try {
      const userCookie = (typeof getVRCCookieFn === 'function') ? getVRCCookieFn(req) : null;
      if (userCookie) return userCookie;
    } catch (e) { /* 取用户 cookie 失败则回退系统账号 */ }
    if (authStateRef && authStateRef.loggedIn && authStateRef.cookie) return authStateRef.cookie;
    return null;
  }

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
      return sendPlaceholderOk(res);
    }

    // 2) V9.4 存储兜底提前到回源之前（顺序从「回源失败才查库」改为「先查库再回源」）：
    //    补充循环已把头像回填到 group_roster.avatar_url，命中即 0 次 VRChat API 调用——
    //    462 人整群刷新本应对每个 uid 回源一次 API，回填完成后全部改走库内直出。
    //    四级链：group_roster → users 绑定 → 群成员资料缓存 → 头像历史，全部仅查库。
    const storedUrl = await resolveStoredAvatarFromDb(uid);
    if (storedUrl) {
      _userAvatarCache.set(uid, { url: storedUrl, ok: true, ts: now });
      return res.redirect(302, '/api/avatar/proxy?u=' + encodeURIComponent(storedUrl));
    }

    const avatarCookie = resolveAvatarCookie(req);
    if (!avatarCookie) {
      // 无任何可用的 VRChat 会话（请求者未绑定 & 系统账号未登录/已失效）且库内无存储：
      // 短期不可恢复，200 占位（不产生 502 控制台噪音）。
      return sendPlaceholderOk(res);
    }
    // V9.1 系统账号熔断：该 cookie 是系统账号且近期已被 VRChat 401 拒绝——
    // 直接跳过注定 401 的回源（群组一屏 50+ 成员不再每次刷新都制造 50+ 次无效上游调用）。
    const isSystemCookie = !!(authStateRef && authStateRef.cookie && avatarCookie === authStateRef.cookie);
    // V9.2: 全局 401 熔断（任意会话被拒）同样跳过回源；系统 cookie 单独熔断判断保持
    if (isGlobalVrcFail() || (isSystemCookie && (isSystemCookieStale(avatarCookie) || isSystemCookieUnusable()))) {
      // 存储兜底已在步骤 2 查过：熔断窗口内必然 401，重试无用，200 占位（不刷 502 控制台）
      return sendPlaceholderOk(res);
    }

    // 3) 限速（仅对「回源解析」计费）：未命中缓存、真正要调 VRChat 用户 API 前才限速，
    //    防止批量冷查打爆用户 API；已缓存头像的请求在前两步即返回，不消耗配额。
    // P3-119：仅当直连对端为回环（即经本机 nginx 反代）时才信任 x-forwarded-for。
    const socketAddr = (req.socket && req.socket.remoteAddress) || '';
    const isLoopbackPeer = socketAddr === '::1' || socketAddr === '127.0.0.1' || socketAddr === '::ffff:127.0.0.1';
    const clientIp = (isLoopbackPeer && req.headers['x-forwarded-for'])
      ? String(req.headers['x-forwarded-for']).split(',')[0].trim()
      : socketAddr;
    if (userAvatarRateLimited(clientIp)) return sendPlaceholderOk(res);

    try {
      const url = await resolveUserAvatarUrl(avatarCookie, uid, isSystemCookie);
      if (url) {
        _userAvatarCache.set(uid, { url, ok: true, ts: now });
        // V9.4: 回源成功落库，后续请求（含内存缓存过期后）直接走步骤 2 存储兜底，免重复回源
        persistAvatarUrlToDb(uid, url);
        return res.redirect(302, '/api/avatar/proxy?u=' + encodeURIComponent(url));
      }
      // 回源返回空（该成员 API 无头像字段 / 隐私受限）：写失败缓存 5 分钟避免反复回源
      _userAvatarCache.set(uid, { url: '', ok: false, ts: now });
      return sendPlaceholderOk(res);
    } catch (e) {
      // 异常（网络/超时）：写失败缓存 5 分钟，避免整群打满重试；库内已无存储可兜
      _userAvatarCache.set(uid, { url: '', ok: false, ts: now });
      return sendPlaceholderOk(res);
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

    // 3) 限速（仅对「回源」计费）：超限返回 200 占位头像（而非 429 JSON 或 502），
    //    既不会 <img> 裂图，也不刷满控制台（V9.2 起统一 200 占位语义）。
    //    上游节流由 CDN 全局令牌桶兜底。
    // P3-119：仅当直连对端为回环（即经本机 nginx 反代）时才信任 x-forwarded-for，
    // 否则回退 socket 地址——客户端直接连时不采信可自造的 XFF，避免轮换桶绕过每 IP 限速。
    const socketAddr = (req.socket && req.socket.remoteAddress) || '';
    const isLoopbackPeer = socketAddr === '::1' || socketAddr === '127.0.0.1' || socketAddr === '::ffff:127.0.0.1';
    const clientIp = (isLoopbackPeer && req.headers['x-forwarded-for'])
      ? String(req.headers['x-forwarded-for']).split(',')[0].trim()
      : socketAddr;
    if (avatarRateLimited(clientIp)) return sendPlaceholderOk(res);

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
      // 无缓存兜底：返回 200 占位头像（V9.2 起不再返回 502；即使源图暂时不可达，
      // 浏览器也以默认占位正常显示，不制造控制台 502 噪音，30s 列表刷新后自动重试）
      return sendPlaceholderOk(res);
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
