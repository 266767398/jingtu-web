// F-20 VRChat 官方收藏管理（/api/vrc-favorites）
// 与站内收藏系统（/api/collections, V8.2）并存：本路由直接操作 VRChat
// 账号内的官方收藏（游戏内同样可见），数据归属 VRChat 官方。
// Cookie 策略：读操作可用系统账号兜底（getVRCCookie）；写操作严格限定
// 用户自己绑定的 cookie（getVRCCookieUserOnly），防止未绑定用户借系统
// 账号改写官方收藏。上游错误统一走 sendVrcError 透传真实原因。
const express = require('express');
const { ok, fail, sendVrcError, handleError, ErrorCodes, decryptCookie } = require('../utils');
const { requireAuth } = require('../auth');
const { getPool } = require('../db');
const {
  vrchatGetFavorites, vrchatAddFavorite, vrchatRemoveFavorite,
  vrchatGetFavoriteGroups, vrchatUpdateFavoriteGroup, vrchatClearFavoriteGroup,
  vrchatGetAvatar, vrchatGetUser, vrchatGetWorld, vrcBacklog,
  VRC_FAV_TYPES
} = require('../vrc');
// 条目名字/缩略图富化：世界走缓存服务（含回源与自愈），头像/用户直接回源
const { getCachedWorld } = require('../world_cache');

const MAX_PAGE = 100;

function clampInt(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function isValidType(type) {
  return VRC_FAV_TYPES.includes(type);
}

// ============ 收藏条目名字/缩略图富化 ============
// 官方收藏条目本身只带 favoriteId（wrld_/avtr_/usr_），需回源目标对象才能显示
// 名字与图片。进程内缓存 + 限并发尽力回源：失败保留原始条目，由前端以 ID 兜底展示。
const FAV_META_TTL_MS = 6 * 60 * 60 * 1000;
const FAV_META_MAX = 600;
const favMetaCache = new Map();

function favMetaGet(id) {
  const hit = favMetaCache.get(id);
  if (!hit) return null;
  if (Date.now() - hit.at > FAV_META_TTL_MS) { favMetaCache.delete(id); return null; }
  return hit.meta;
}

function favMetaSet(id, meta) {
  if (favMetaCache.size >= FAV_META_MAX) favMetaCache.delete(favMetaCache.keys().next().value);
  favMetaCache.set(id, { at: Date.now(), meta });
}

// P5-54: 负缓存冷却。回源失败（限流/断网/目标不存在）的条目短暂记录失败时刻，
// 冷却期内同目标不再回源，让前端「等冷却后重拉」的节奏落到后端，避免漏载条目
// 在每一轮补拉里都对着 VRChat 重复打同一个 miss，反而加剧限流。
const FAV_FAIL_COOLDOWN_MS = 60 * 1000;
const favFailCache = new Map();
function favFailActive(targetId) {
  const at = favFailCache.get(targetId);
  if (!at) return false;
  if (Date.now() - at > FAV_FAIL_COOLDOWN_MS) { favFailCache.delete(targetId); return false; }
  return true;
}
function favFailMark(targetId) {
  if (favFailCache.size >= FAV_META_MAX) favFailCache.delete(favFailCache.keys().next().value);
  favFailCache.set(targetId, Date.now());
}

// V9.10: 数据库持久化缓存。target_id 全局唯一（wrld_/avtr_/usr_），跨用户、跨进程重启共享。
// 内存优先（favMetaCache），miss 时读库；回源成功写库 + 写内存。TTL 7 天（与 VRChat 收藏变动节奏匹配）。
const FAV_DB_TTL_DAYS = 7;
async function dbGetFavMeta(type, targetId) {
  try {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT name, thumbnail, author, author_id FROM vrc_fav_cache
       WHERE target_id=? AND type=? AND fetched_at > DATE_SUB(NOW(), INTERVAL ? DAY) LIMIT 1`,
      [targetId, type, FAV_DB_TTL_DAYS]
    );
    const r = rows && rows[0];
    if (!r || !(r.name)) return null;
    return { name: r.name, thumbnailImageUrl: r.thumbnail || '', authorName: r.author || '' };
  } catch (e) { return null; }
}
function dbSetFavMeta(type, targetId, meta) {
  if (!targetId || !meta || !meta.name) return;
  try {
    const pool = getPool();
    pool.query(
      `INSERT INTO vrc_fav_cache (target_id, type, name, thumbnail, author, author_id, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE type=VALUES(type), name=VALUES(name), thumbnail=VALUES(thumbnail),
         author=VALUES(author), author_id=VALUES(author_id), fetched_at=NOW()`,
      [targetId, type, meta.name, meta.thumbnailImageUrl || '', meta.authorName || '', meta.authorId || '']
    ).catch(() => {});
  } catch (e) { /* 缓存写入失败不影响主流程 */ }
}

// P5-54: 缓存表清理。vrc_fav_cache 行无生命周期管理会随收藏增长无限膨胀，
// 每次收藏页加载顺带清理一次（进程级 1h 节流），删除超过 TTL 的过期行。
let favLastPruneAt = 0;
function pruneFavCacheIfDue() {
  const now = Date.now();
  if (now - favLastPruneAt < 60 * 60 * 1000) return;
  favLastPruneAt = now;
  try {
    getPool().query(
      `DELETE FROM vrc_fav_cache WHERE fetched_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
      [FAV_DB_TTL_DAYS + 1]
    ).catch(() => {});
  } catch (e) { /* 清理失败不影响主流程 */ }
}

// ============ 收藏快照缓存（首次官方同步 + 刷新重拉，之后只读本地秒开） ============
// 背景：官方收藏页每次打开都要拉分组 + 逐条回源富化（受 40/min 令牌桶限制，慢且易失败）。
// 方案：把「分组 + 各类型条目列表（已富化）」落库为 vrc_fav_snapshot，读取命中直接返回（零回源）；
// 同步策略 V11：登录/刷新【只读本地快照】，仅首次（本地无数据）自动拉官方一次；
// 之后只有手动点击「刷新/重新同步」/群组同步/在线状态刷新才从官方拉取（force=refresh 或 POST /sync）。
const SNAP_SCOPES = ['groups', 'items:world', 'items:avatar', 'items:friend'];
// V9.8 安全：快照按用户隔离。scope 加 `u{userId}:` 前缀，杜绝跨用户缓存泄露
//（此前 scope 为全局固定值，用户 A 登录会读到用户 B 的官方收藏快照）。
function userSnapScope(uid, scope) { return 'u' + Number(uid) + ':' + scope; }
// 后台同步单作业（进程内 single-flight），前端轮询 /sync-status 读取
const favSync = {
  running: false,
  startedAt: 0,
  step: '',        // 'groups' | 'items:world' | ...
  stepLabel: '',   // 中文步骤标签
  stepIndex: 0,
  stepTotal: 0,
  lastAt: 0,
  lastError: ''
};

function snapScopeOfType(type) { return 'items:' + (type || 'world'); }

// F-20.5: 标记当前页条目是否已在本站收藏库（collections）中，并带上本地收藏 id，
// 供前端渲染「已收藏 / 取消收藏」切换按钮。一次 IN 查询覆盖整页，避免逐条轮询。
async function attachLocalCollected(uid, items) {
  if (!Array.isArray(items) || !items.length) return items;
  const targets = items.map(it => it && it.favoriteId).filter(Boolean);
  if (!targets.length) return items;
  try {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT id, kind, target_id FROM collections WHERE user_id=? AND target_id IN (?)`,
      [uid, targets]
    );
    const byTarget = new Map();
    for (const r of rows) if (!byTarget.has(r.target_id)) byTarget.set(r.target_id, r);
    for (const it of items) {
      if (!it || !it.favoriteId) continue;
      const hit = byTarget.get(it.favoriteId);
      it.localCollected = !!hit;
      it.localCollectionId = hit ? hit.id : null;
    }
  } catch (e) { /* 标记失败不影响收藏列表主流程 */ }
  return items;
}

async function snapGet(scope) {
  try {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT payload, item_count, fetched_at FROM vrc_fav_snapshot WHERE scope=? LIMIT 1`, [scope]
    );
    const r = rows && rows[0];
    if (!r) return null;
    let payload = null;
    try { payload = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload; } catch (e) { payload = null; }
    if (!Array.isArray(payload)) return null;
    return { payload, itemCount: r.item_count || payload.length, fetchedAt: r.fetched_at };
  } catch (e) { return null; }
}

async function snapSet(scope, payload) {
  if (!Array.isArray(payload)) return;
  try {
    const pool = getPool();
    await pool.query(
      `INSERT INTO vrc_fav_snapshot (scope, payload, item_count, fetched_at) VALUES (?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE payload=VALUES(payload), item_count=VALUES(item_count), fetched_at=NOW()`,
      [scope, JSON.stringify(payload), payload.length]
    );
  } catch (e) { /* 快照写入失败不影响主流程 */ }
}

async function snapInvalidate(scopeLike) {
  try {
    const pool = getPool();
    await pool.query(`DELETE FROM vrc_fav_snapshot WHERE scope LIKE ?`, [scopeLike]);
  } catch (e) { /* 静默 */ }
}

function favSyncProgress() {
  return {
    running: favSync.running,
    startedAt: favSync.startedAt,
    step: favSync.step,
    stepLabel: favSync.stepLabel,
    stepIndex: favSync.stepIndex,
    stepTotal: favSync.stepTotal,
    lastAt: favSync.lastAt,
    lastError: favSync.lastError
  };
}

// 后台同步收藏快照（分组 + 三类条目）。single-flight：已有作业在跑时直接返回当前作业状态。
// 单步骤失败不中断整体（VRChat 限流/单类型异常只影响该类型），下次登录/刷新自动补齐。
// 收藏条目：VRChat 官方接口不按 type 服务端过滤，整批分页抓全后按类型切分落快照，
// 避免同一批数据为三类各回源一次（既省 API 又保证 >100 条的用户也能全量入库）。
async function startFavSync(cookie, uid) {
  if (favSync.running) return favSync;
  favSync.running = true;
  favSync.startedAt = Date.now();
  favSync.lastError = '';
  const userScope = s => userSnapScope(uid, s);
  const itemSteps = [
    { scope: userScope('items:world'), label: '地图', type: 'world' },
    { scope: userScope('items:avatar'), label: '模型', type: 'avatar' },
    { scope: userScope('items:friend'), label: '好友', type: 'friend' }
  ];
  const steps = [{ scope: userScope('groups'), label: '收藏分组' }, ...itemSteps];
  favSync.stepTotal = steps.length;
  const byType = { world: [], avatar: [], friend: [] };
  try {
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      favSync.stepIndex = i + 1;
      favSync.step = s.scope;
      favSync.stepLabel = s.label;
      try {
        if (s.scope === 'groups') {
          const upstream = await vrchatGetFavoriteGroups(cookie, 100, 0);
          if (upstream.status >= 200 && upstream.status < 300) {
            const groups = Array.isArray(upstream.data) ? upstream.data : [];
            await snapSet(userScope('groups'), groups);
          }
        } else {
          // 首次进条目步骤时整批分页抓全（上限 600 条，防止异常大收藏刷爆令牌桶）
          const rawTotal = byType.world.length + byType.avatar.length + byType.friend.length;
          if (rawTotal === 0) {
            let offset = 0;
            while (offset < 600) {
              const upstream = await vrchatGetFavorites(cookie, 100, offset, null);
              if (upstream.status < 200 || upstream.status >= 300) break;
              const page = Array.isArray(upstream.data) ? upstream.data : [];
              if (!page.length) break;
              for (const it of page) {
                if (it && it.type && byType[it.type]) byType[it.type].push(it);
              }
              if (page.length < 100) break;
              offset += page.length;
            }
          }
          const items = byType[s.type] || [];
          const enriched = await enrichFavoriteItems(items, cookie);
          await snapSet(s.scope, enriched);
        }
      } catch (e) {
        if (e && e.code === 'VRC_RATE_TIMEOUT') throw e;
        favSync.lastError = String((e && e.message) || e || '');
      }
    }
    pruneFavCacheIfDue();
    favSync.lastAt = Date.now();
  } finally {
    favSync.running = false;
    favSync.step = '';
    favSync.stepLabel = '';
    favSync.stepIndex = 0;
  }
  return favSync;
}

// P1-34: single-flight 防惊群——TTL 缓存只挡先后请求，挡不住同时 miss 的并发请求；
// 同一目标的并发富化共享一次回源（世界一层另有 world_cache 去重，此处覆盖 avatar/friend）。
const favMetaInflight = new Map();
function fetchFavoriteMeta(type, targetId, cookie) {
  const key = `${type}:${targetId}`;
  const existing = favMetaInflight.get(key);
  if (existing) return existing;
  const p = (async () => {
    const mem = favMetaGet(targetId);
    if (mem) return mem;
    // 数据库持久化缓存命中 → 免回源（V9.10）
    const dbMeta = await dbGetFavMeta(type, targetId);
    if (dbMeta) { favMetaSet(targetId, dbMeta); return dbMeta; }
    // 负缓存冷却期内免回源：让前端等冷却后重拉，冷却到期自然重试
    if (favFailActive(targetId)) return null;
    const meta = await _fetchFavoriteMeta(type, targetId, cookie);
    if (!meta) favFailMark(targetId);
    return meta;
  })().finally(() => favMetaInflight.delete(key));
  favMetaInflight.set(key, p);
  return p;
}

async function _fetchFavoriteMeta(type, targetId, cookie) {
  try {
    if (type === 'world' && /^wrld_/.test(targetId)) {
      const w = await getCachedWorld(targetId, cookie);
      if (w && w.id && w.name) {
        const meta = {
          name: w.name,
          thumbnailImageUrl: w.thumbnailImageUrl || w.imageUrl || (w.thumbnail && w.thumbnail.url) || '',
          authorName: w.authorName || '',
          authorId: w.authorId || ''
        };
        favMetaSet(targetId, meta);
        dbSetFavMeta(type, targetId, meta);
        return meta;
      }
      return null;
    }
    if (type === 'avatar' && /^avtr_/.test(targetId)) {
      const resp = await vrchatGetAvatar(targetId, cookie);
      const a = (resp && resp.status >= 200 && resp.status < 300) ? resp.data : null;
      if (a && a.id && a.name) {
        const meta = {
          name: a.name,
          thumbnailImageUrl: a.thumbnailImageUrl || (a.images && a.images.thumbnail && a.images.thumbnail.url) || '',
          authorName: a.authorName || '',
          authorId: a.authorId || ''
        };
        favMetaSet(targetId, meta);
        dbSetFavMeta(type, targetId, meta);
        return meta;
      }
      return null;
    }
    if (type === 'friend' && /^usr_/.test(targetId)) {
      const resp = await vrchatGetUser(targetId, cookie);
      const u = (resp && resp.status >= 200 && resp.status < 300) ? resp.data : null;
      if (u && u.id && (u.displayName || u.name)) {
        const meta = {
          name: u.displayName || u.name || '',
          thumbnailImageUrl: u.profilePicOverrideThumbnail || u.currentAvatarThumbnailImageUrl || u.iconUrl || '',
          authorName: ''
        };
        favMetaSet(targetId, meta);
        dbSetFavMeta(type, targetId, { ...meta, authorId: u.id || '' });
        return meta;
      }
      return null;
    }
  } catch (e) { /* 富化失败不影响收藏列表主流程 */ }
  return null;
}

async function enrichFavoriteItems(items, cookie) {
  // V9.9（修正 V9.8）：实测 VRChat GET /favorites 对每条收藏只返回 favoriteId/type，几乎不带 name/thumbnailUrl，
  // 因此每条仍需回源才能显示名字与封面。V9.8 把预算压到 4 且只回“缺名”，导致大量条目缺封面/缺名。
  // 现在「名字或封面任一缺失」即回源补齐，预算放宽到 18（覆盖当前页主力），并发保持小并发走全局 40/min 令牌桶；
  // 剩余条目由前端自动重拉兜底（缓存随回源填充，重拉时命中即补齐）。作者随回源顺带补。
  // P5-56：令牌桶排队深度感知——排队（vrcBacklog()>0）说明上游正饱和，动态砍预算与并发，
  // 让列表接口尽快返回而不是继续把请求塞进队列拖到 12s 排队超时（剩余条目由前端补全循环在缓存命中后补齐）。
  let CONCURRENCY = 4;
  let budget = 18;
  if (vrcBacklog() > 0) { CONCURRENCY = 2; budget = 8; }
  const pending = [];
  for (const it of items) {
    const targetId = it && it.favoriteId;
    if (!targetId) continue;
    it.authorName = typeof it.authorName === 'string' ? it.authorName : '';
    const cached = favMetaGet(targetId);
    if (cached) {
      it.name = cached.name;
      it.thumbnailImageUrl = cached.thumbnailImageUrl;
      if (cached.authorName) it.authorName = cached.authorName;
      continue;
    }
    const ownName = (typeof it.name === 'string' && it.name) ? it.name : '';
    const ownThumb = (typeof it.thumbnailUrl === 'string' && /^https?:\/\//i.test(it.thumbnailUrl)) ? it.thumbnailUrl : '';
    if (ownName) it.name = ownName;
    if (ownThumb) it.thumbnailImageUrl = ownThumb;
    if (ownName && ownThumb) continue;
    if (budget > 0) { budget--; pending.push(it); }
  }
  let cursor = 0;
  async function worker() {
    while (cursor < pending.length) {
      const it = pending[cursor++];
      const meta = await fetchFavoriteMeta(it.type, it.favoriteId, cookie);
      if (meta) {
        it.name = meta.name;
        it.thumbnailImageUrl = meta.thumbnailImageUrl;
        it.authorName = meta.authorName || it.authorName || '';
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, () => worker()));
  return items;
}

// P5-56: 官方收藏目标详情（模型/世界/好友）——列表富化只取名字/缩略图，详情要完整字段，
// 供前端复用本地收藏详情样式展示。命中即写回 favMetaCache + DB（顺带喂列表富化缓存）。
async function fetchTargetDetail(type, targetId, cookie) {
  try {
    if (type === 'world' && /^wrld_/.test(targetId)) {
      const w = await getCachedWorld(targetId, cookie);
      if (!w) return null;
      const meta = {
        id: w.id, name: w.name, description: w.description || '',
        thumbnailImageUrl: w.thumbnailImageUrl || w.imageUrl || (w.thumbnail && w.thumbnail.url) || '',
        imageUrl: w.imageUrl || '', authorName: w.authorName || '', authorId: w.authorId || '',
        worldType: w.worldType || '', capacity: w.capacity || 0,
        platform: w.platform || '', tags: Array.isArray(w.tags) ? w.tags : [],
        releaseStatus: w.releaseStatus || '', assetUrl: w.assetUrl || '',
        unityPackageUrl: w.unityPackageUrl || '', type: 'world'
      };
      favMetaSet(targetId, meta);
      dbSetFavMeta(type, targetId, meta);
      return meta;
    }
    const resp = (type === 'avatar') ? await vrchatGetAvatar(targetId, cookie)
      : ((type === 'friend') ? await vrchatGetUser(targetId, cookie) : null);
    const o = (resp && resp.status >= 200 && resp.status < 300) ? resp.data : null;
    if (!o) return null;
    if (type === 'avatar') {
      const meta = {
        id: o.id, name: o.name, description: o.description || '',
        thumbnailImageUrl: o.thumbnailImageUrl || (o.images && o.images.thumbnail && o.images.thumbnail.url) || '',
        imageUrl: o.imageUrl || (o.images && o.images.image && o.images.image.url) || '',
        authorName: o.authorName || '', authorId: o.authorId || '',
        platform: o.platform || '', releaseStatus: o.releaseStatus || '',
        unityVersion: o.unityVersion || '', featured: !!o.featured,
        tags: Array.isArray(o.tags) ? o.tags : [], type: 'avatar'
      };
      favMetaSet(targetId, meta);
      dbSetFavMeta(type, targetId, meta);
      return meta;
    }
    const meta = {
      id: o.id, name: o.displayName || o.name || '', description: o.bio || o.statusDescription || '',
      thumbnailImageUrl: o.profilePicOverrideThumbnail || o.currentAvatarThumbnailImageUrl || o.iconUrl || '',
      imageUrl: o.currentAvatarImageUrl || '', authorName: '', authorId: o.id || '',
      status: o.status || '', tags: Array.isArray(o.tags) ? o.tags : [], type: 'friend'
    };
    favMetaSet(targetId, meta);
    dbSetFavMeta(type, targetId, { ...meta, authorId: o.id || '' });
    return meta;
  } catch (e) {
    if (e && e.code === 'VRC_RATE_TIMEOUT') throw e;
    return null;
  }
}

module.exports = function (getVRCCookie, getVRCCookieUserOnly) {
  const router = express.Router();

  // Cookie 解析中间件：读操作用户优先/系统兜底；写操作仅用户自己的绑定
  // BUG 修复：写操作 cookie 缺失时，尝试从 DB（users.vrchat_token_enc）恢复，
  // 避免会话丢失但 DB 仍有绑定 cookie 时误报「未绑定」。
  router.use(async (req, res, next) => {
    req.vrcCookieRead = getVRCCookie(req);
    req.vrcCookieWrite = getVRCCookieUserOnly(req);
    if (!req.vrcCookieWrite && req.session && req.session.userId) {
      try {
        const [rows] = await getPool().query(
          `SELECT vrchat_token_enc, vrchat_id FROM users WHERE id = ? AND deleted_at IS NULL`,
          [req.session.userId]
        );
        const u = rows && rows[0];
        if (u && u.vrchat_token_enc) {
          const plain = decryptCookie(u.vrchat_token_enc);
          if (plain) {
            // DB 有有效 cookie：恢复到会话，本次即可使用
            req.session.vrchatCookie = u.vrchat_token_enc;
            req.session.vrcCookieSetAt = Date.now();
            req.vrcCookieWrite = plain;
          } else {
            // DB cookie 解密失败（如 ENCRYPT_KEY 变更）：清除无效副本，避免反复误报
            await getPool().query(`UPDATE users SET vrchat_token_enc = NULL WHERE id = ?`, [req.session.userId]);
          }
        }
      } catch (e) { /* DB 恢复失败不阻断，按无 cookie 处理 */ }
    }
    next();
  });

  // ============ 分组（Favorite Groups） ============

  // 列出官方收藏分组（全类型混合返回，前端按 type 归类）
  // 同步策略 V11：命中本地快照直接返回（零回源）；仅 refresh=1（手动刷新）或本地无快照（首次）才拉官方。
  router.get('/groups', requireAuth, async (req, res) => {
    if (!req.vrcCookieRead) return fail(res, 400, '暂无可用的 VRChat 登录态，请先绑定或配置 VRChat 账号', { code: ErrorCodes.NEED_BIND });
    try {
      const gscope = userSnapScope(req.session.userId, 'groups');
      if (req.query.refresh !== '1') {
        const snap = await snapGet(gscope);
        if (snap) {
          // 命中本地快照即返回，不自动拉官方（仅手动刷新才回源）
          return ok(res, { groups: snap.payload, cached: true });
        }
      }
      const n = clampInt(req.query.n, 50, 1, MAX_PAGE);
      const offset = clampInt(req.query.offset, 0, 0, 10000);
      const upstream = await vrchatGetFavoriteGroups(req.vrcCookieRead, n, offset);
      if (upstream.status < 200 || upstream.status >= 300) return sendVrcError(res, upstream, '获取收藏分组');
      const groups = Array.isArray(upstream.data) ? upstream.data : [];
      await snapSet(gscope, groups);
      ok(res, { groups });
    } catch (e) { handleError(res, e, 'vrcfav.groups'); }
  });

  // 重命名分组（ownerUserId 来自分组列表，防越权由 VRChat 上游校验归属）
  router.put('/groups/:type/:name', requireAuth, async (req, res) => {
    if (!req.vrcCookieWrite) return fail(res, 400, 'VRChat 登录态已失效，请在个人中心重新绑定 VRChat 账号', { code: ErrorCodes.NEED_BIND });
    const { type, name } = req.params;
    if (!isValidType(type)) return fail(res, 400, '不支持的收藏类型', { code: ErrorCodes.INVALID_TARGET_TYPE });
    const displayName = (req.body?.displayName || '').trim();
    const ownerUserId = (req.body?.ownerUserId || '').trim();
    if (!displayName) return fail(res, 400, '分组显示名不能为空', { code: ErrorCodes.VALIDATION_ERROR });
    if (!ownerUserId) return fail(res, 400, '缺少分组归属用户 ID', { code: ErrorCodes.VALIDATION_ERROR });
    try {
      const upstream = await vrchatUpdateFavoriteGroup(req.vrcCookieWrite, type, name, ownerUserId, displayName);
      if (upstream.status < 200 || upstream.status >= 300) return sendVrcError(res, upstream, '重命名收藏分组');
      await snapInvalidate(userSnapScope(req.session.userId, 'groups%'));
      ok(res, { group: upstream.data });
    } catch (e) { handleError(res, e, 'vrcfav.group.rename'); }
  });

  // 清空分组（删除分组内全部条目，分组本身保留）
  router.delete('/groups/:type/:name', requireAuth, async (req, res) => {
    if (!req.vrcCookieWrite) return fail(res, 400, 'VRChat 登录态已失效，请在个人中心重新绑定 VRChat 账号', { code: ErrorCodes.NEED_BIND });
    const { type, name } = req.params;
    if (!isValidType(type)) return fail(res, 400, '不支持的收藏类型', { code: ErrorCodes.INVALID_TARGET_TYPE });
    const ownerUserId = (req.query.ownerUserId || '').trim();
    if (!ownerUserId) return fail(res, 400, '缺少分组归属用户 ID', { code: ErrorCodes.VALIDATION_ERROR });
    try {
      const upstream = await vrchatClearFavoriteGroup(req.vrcCookieWrite, type, name, ownerUserId);
      if (upstream.status < 200 || upstream.status >= 300) return sendVrcError(res, upstream, '清空收藏分组');
      await snapInvalidate(userSnapScope(req.session.userId, 'items:%'));
      await snapInvalidate(userSnapScope(req.session.userId, 'groups%'));
      ok(res);
    } catch (e) { handleError(res, e, 'vrcfav.group.clear'); }
  });

  // ============ 收藏条目（Favorites） ============

  // 列出收藏条目（type 可选过滤；tag 为分组名过滤）
  // 同步策略 V11：命中本地快照直接返回（零回源、零富化等待）；仅 refresh=1（手动刷新）或本地无快照（首次）走实时路径。
  router.get('/items', requireAuth, async (req, res) => {
    if (!req.vrcCookieRead) return fail(res, 400, '暂无可用的 VRChat 登录态，请先绑定或配置 VRChat 账号', { code: ErrorCodes.NEED_BIND });
    try {
      const type = (req.query.type || '').trim();
      if (type && !isValidType(type)) return fail(res, 400, '不支持的收藏类型', { code: ErrorCodes.INVALID_TARGET_TYPE });
      const n = clampInt(req.query.n, 50, 1, MAX_PAGE);
      const offset = clampInt(req.query.offset, 0, 0, 10000);
      const tag = (req.query.tag || '').trim() || null;
      // 仅「首页 + 无分组过滤」命中快照；分组过滤/翻页语义不同，直接实时拉取
      if (offset === 0 && !tag && req.query.refresh !== '1') {
        const scope = userSnapScope(req.session.userId, snapScopeOfType(type || 'world'));
        const snap = await snapGet(scope);
        if (snap) {
          // 命中本地快照即返回，不自动拉官方（仅手动刷新才回源）
          await attachLocalCollected(req.session.userId, snap.payload);
          return ok(res, { items: snap.payload, cached: true });
        }
      }
      let upstream;
      try {
        upstream = await vrchatGetFavorites(req.vrcCookieRead, n, offset, tag);
      } catch (e) {
        // P5-56: 令牌桶排队超时（VRC_RATE_TIMEOUT）不按 500 暴露——前端识别 code 后
        // 显示「VRChat 限流排队中」友好提示并等冷却窗口自动重试，而不是「请求超时，请稍后再试」。
        if (e && e.code === 'VRC_RATE_TIMEOUT') {
          return fail(res, 429, 'VRChat 限流排队超时，正在自动重试', { code: 'VRC_RATE_TIMEOUT', retryAfter: 15 });
        }
        throw e;
      }
      if (upstream.status < 200 || upstream.status >= 300) return sendVrcError(res, upstream, '获取收藏列表');
      let items = Array.isArray(upstream.data) ? upstream.data : [];
      // VRChat 官方未提供按 type 的服务端过滤（tag 过滤已等价于按分组过滤），
      // 前端选择"全部分组"时在这里按 type 兜底过滤一次
      if (type && !tag) items = items.filter(it => it?.type === type);
      // 前端渲染卡片标题与图片需要名字/缩略图，尽力回源富化（带缓存与并发上限）
      items = await enrichFavoriteItems(items, req.vrcCookieRead);
      pruneFavCacheIfDue();
      // 首页全量列表顺带写回快照，供下次秒开（仅无分组过滤时）
      if (offset === 0 && !tag) await snapSet(userSnapScope(req.session.userId, snapScopeOfType(type || 'world')), items);
      await attachLocalCollected(req.session.userId, items);
      ok(res, { items });
    } catch (e) { handleError(res, e, 'vrcfav.items'); }
  });

  // 添加收藏（tag 传分组名，不存在时 VRChat 自动建组）
  router.post('/items', requireAuth, async (req, res) => {
    if (!req.vrcCookieWrite) return fail(res, 400, 'VRChat 登录态已失效，请在个人中心重新绑定 VRChat 账号', { code: ErrorCodes.NEED_BIND });
    const type = (req.body?.type || '').trim();
    const favoriteId = (req.body?.favoriteId || '').trim();
    const tag = (req.body?.tag || '').trim();
    if (!isValidType(type)) return fail(res, 400, '不支持的收藏类型', { code: ErrorCodes.INVALID_TARGET_TYPE });
    if (!favoriteId) return fail(res, 400, '收藏目标 ID 不能为空', { code: ErrorCodes.VALIDATION_ERROR });
    if (!tag) return fail(res, 400, '请选择要加入的收藏分组', { code: ErrorCodes.VALIDATION_ERROR });
    try {
      const upstream = await vrchatAddFavorite(req.vrcCookieWrite, type, favoriteId, [tag]);
      if (upstream.status < 200 || upstream.status >= 300) return sendVrcError(res, upstream, '添加收藏');
      // 快照失效：下个请求实时重拉，避免列表与官方不一致
      await snapInvalidate(userSnapScope(req.session.userId, snapScopeOfType(type)) + '%');
      await snapInvalidate(userSnapScope(req.session.userId, 'groups%'));
      ok(res, { favorite: upstream.data });
    } catch (e) {
      // 目标已在收藏中：上游 400 "already in favorites" 转 409 便于前端识别
      const msg = String(e.message || '');
      if (/already|exists/i.test(msg)) {
        return fail(res, 409, '该内容已在此收藏分组中', { code: ErrorCodes.CONFLICT });
      }
      handleError(res, e, 'vrcfav.item.add');
    }
  });

  // 移除单条收藏（:id 为 fvrt_ 开头的收藏条目 ID）
  router.delete('/items/:id', requireAuth, async (req, res) => {
    if (!req.vrcCookieWrite) return fail(res, 400, 'VRChat 登录态已失效，请在个人中心重新绑定 VRChat 账号', { code: ErrorCodes.NEED_BIND });
    try {
      const upstream = await vrchatRemoveFavorite(req.vrcCookieWrite, req.params.id);
      if (upstream.status < 200 || upstream.status >= 300) return sendVrcError(res, upstream, '移除收藏');
      // 快照失效：无法预知类型，全部条目快照失效，下个请求实时重拉
      await snapInvalidate(userSnapScope(req.session.userId, 'items:%'));
      await snapInvalidate(userSnapScope(req.session.userId, 'groups%'));
      ok(res);
    } catch (e) { handleError(res, e, 'vrcfav.item.remove'); }
  });

  // P5-56: 官方收藏目标详情（world/avatar/friend）——返回完整字段，前端复用本地收藏详情样式渲染
  router.get('/detail/:type/:id', requireAuth, async (req, res) => {
    if (!req.vrcCookieRead) return fail(res, 400, '暂无可用的 VRChat 登录态，请先绑定或配置 VRChat 账号', { code: ErrorCodes.NEED_BIND });
    const { type, id } = req.params;
    if (!isValidType(type)) return fail(res, 400, '不支持的收藏类型', { code: ErrorCodes.INVALID_TARGET_TYPE });
    if (!/^(wrld_|avtr_|usr_)/.test(id || '')) {
      return fail(res, 400, '收藏目标 ID 格式不正确', { code: ErrorCodes.VALIDATION_ERROR });
    }
    try {
      const item = await fetchTargetDetail(type, id, req.vrcCookieRead);
      if (!item) return fail(res, 404, '未能获取该收藏目标的详细信息', { code: ErrorCodes.NOT_FOUND });
      ok(res, { item });
    } catch (e) {
      if (e && e.code === 'VRC_RATE_TIMEOUT') {
        return fail(res, 429, 'VRChat 限流排队超时，请稍后重试', { code: 'VRC_RATE_TIMEOUT', retryAfter: 15 });
      }
      handleError(res, e, 'vrcfav.detail');
    }
  });

  // ============ 收藏快照同步（顶部状态栏驱动） ============

  // 触发后台同步：登录/进入 VRC 页签时由前端调用。内部 single-flight，
  // 已有作业运行时立即返回当前状态（不会叠加请求）；调用方随后轮询 /sync-status。
  // 注意：任务在后台执行（不 await 全程，避免请求被拖到上游限流超时），立即响应。
  router.post('/sync', requireAuth, async (req, res) => {
    if (!req.vrcCookieRead) return fail(res, 400, '暂无可用的 VRChat 登录态，请先绑定或配置 VRChat 账号', { code: ErrorCodes.NEED_BIND });
    try {
      if (favSync.running) return ok(res, { running: true, startedAt: favSync.startedAt });
      startFavSync(req.vrcCookieRead, req.session.userId).catch(() => {});
      ok(res, { running: true, startedAt: Date.now() });
    } catch (e) { handleError(res, e, 'vrcfav.sync'); }
  });

  // 同步进度与快照概览（顶部状态栏轮询）：作业进度 + 各 scope 条目数与上次拉取时间
  router.get('/sync-status', requireAuth, async (req, res) => {
    try {
      const perScope = {};
      for (const scope of SNAP_SCOPES) {
        const snap = await snapGet(userSnapScope(req.session.userId, scope));
        perScope[scope] = snap
          ? { count: snap.itemCount, fetchedAt: snap.fetchedAt }
          : { count: 0, fetchedAt: null };
      }
      ok(res, { sync: favSyncProgress(), perScope });
    } catch (e) { handleError(res, e, 'vrcfav.sync-status'); }
  });

  // F-20.6 收藏页「零加载」：一次返回全量本地快照（分组 + 三类条目），
  // 前端拿到后分组过滤 / 翻页全部本地完成，不再逐次打网络。
  // 本地无快照时 empty=true，由前端回退到常规实时加载（首次绑定自动触发官方同步）。
  router.get('/snapshot', requireAuth, async (req, res) => {
    try {
      const uid = req.session.userId;
      const out = { groups: [], items: { world: [], avatar: [], friend: [] }, cached: false, empty: false };
      const g = await snapGet(userSnapScope(uid, 'groups'));
      if (g) { out.groups = g.payload; out.cached = true; }
      for (const type of ['world', 'avatar', 'friend']) {
        const s = await snapGet(userSnapScope(uid, 'items:' + type));
        if (s) out.items[type] = s.payload;
      }
      const hasAny = out.groups.length || out.items.world.length || out.items.avatar.length || out.items.friend.length;
      if (!hasAny) { out.empty = true; return ok(res, out); }
      // 一次性标记本站收藏状态（仅标记本地快照中的条目）
      const all = [...out.items.world, ...out.items.avatar, ...out.items.friend];
      await attachLocalCollected(uid, all);
      ok(res, out);
    } catch (e) { handleError(res, e, 'vrcfav.snapshot'); }
  });

  return router;
};
