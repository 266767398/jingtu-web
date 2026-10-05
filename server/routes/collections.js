// 统一收藏系统 (V8.2)
// 合并原「模型收藏馆」(model_collections, avatar_model) 与「收藏夹」(world_favorites, avatar_favorites)
// 提供统一的收藏 CRUD、分组(folders)、多维筛选、搜索、公开发现(discover)、评分与失效检测。
const express = require('express');
const router = express.Router();
const logger = require('../logger');
const { ok,  getPool, handleError, createErr, proxyVrcAvatar, ErrorCodes, paginate, escapeLike  } = require('../utils');;
const { requireAuth, requireAdminCompat } = require('../auth');
const {
  vrchatGetAvatar, vrchatGetUser, vrchatSetAvatar, vrchatCloneAvatar,
  vrchatListWorlds, vrchatGetPopularWorlds, vrchatGetFeaturedWorlds,
  sanitizeVrcId, USER_AGENT
} = require('../vrc');
// F-17 世界详情缓存服务：收藏世界时优先走缓存，减少对 VRChat API 的重复回源
const { getCachedWorld } = require('../world_cache');

const AVTR_ID_PATTERN = /^(avtr)_[0-9a-fA-F-]+$/;
const WRID_ID_PATTERN = /^(wrld)_[0-9a-fA-F-]+$/;
const USR_ID_PATTERN = /^(usr)_[0-9a-fA-F-]+$/;

function isValidTargetId(kind, id) {
  if (kind === 'avatar_model') return AVTR_ID_PATTERN.test(id);
  if (kind === 'world') return WRID_ID_PATTERN.test(id);
  if (kind === 'avatar_favorite') return USR_ID_PATTERN.test(id) || AVTR_ID_PATTERN.test(id);
  return false;
}

function proxyThumb(url) {
  return proxyVrcAvatar ? proxyVrcAvatar(url) : url;
}

// 计算社区热度（与旧模型收藏馆一致）
function computeHeat(ratingAvg, ratingCount, favoriteCount, collectorCount, tagHeat) {
  const r = Number(ratingAvg) || 0;
  const rc = Number(ratingCount) || 0;
  const fc = Number(favoriteCount) || 0;
  const cc = Number(collectorCount) || 0;
  const th = Number(tagHeat) || 0;
  return Math.round(r * rc * 10 + fc * 0.5 + cc * 3 + th * 0.1);
}

// 重新统计收藏数/收藏用户数并刷新热度
async function refreshAggregates(pool, targetId, kind) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS collector_count, SUM(favorite_count) AS fav_sum,
            SUM(rating_count) AS rc_sum, SUM(rating_avg*rating_count) AS rsum,
            SUM(heat) AS tag_heat
     FROM collections WHERE target_id = ? AND kind = ?`,
    [targetId, kind]
  );
  const row = rows[0] || {};
  const collectorCount = row.collector_count || 0;
  const favSum = row.fav_sum || 0;
  const rcSum = row.rc_sum || 0;
  const rsum = row.rsum || 0;
  const tagHeat = row.tag_heat || 0;
  const ratingAvg = rcSum > 0 ? (rsum / rcSum) : 0;
  const heat = computeHeat(ratingAvg, rcSum, favSum, collectorCount, tagHeat);
  await pool.query(
    `UPDATE collections SET collector_count = ?, favorite_count = ?, rating_count = ?, rating_avg = ?, heat = ?
     WHERE target_id = ? AND kind = ?`,
    [collectorCount, favSum, rcSum, ratingAvg.toFixed(2), heat, targetId, kind]
  );
}

// ============ 历史空名行自愈回填 ============
// 早期写入 bug（把上游 {status,data} 包装体当对象取值）留下 name/thumbnail 全空的收藏行。
// 列表加载时 fire-and-forget 回源补齐：进程内去重 + 每页预算 6 条，避免刷爆 VRChat API。
const backfillInflight = new Set();

async function fetchRemotePatch(kind, targetId, cookie) {
  if (kind === 'world') {
    const w = await getCachedWorld(targetId, cookie);
    if (w && w.name) {
      return {
        name: w.name || '', author: w.authorName || '', author_id: w.authorId || '',
        thumbnail: (w.imageUrl || w.thumbnailImageUrl || (w.thumbnail && w.thumbnail.url) || ''),
        description: w.description || ''
      };
    }
    return null;
  }
  const isAvatar = kind === 'avatar_model' || /^avtr_/.test(targetId);
  if (isAvatar) {
    const resp = await vrchatGetAvatar(targetId, cookie);
    const a = (resp && resp.status >= 200 && resp.status < 300) ? resp.data : null;
    if (a && a.id && a.name) {
      return {
        name: a.name || '', author: a.authorName || '', author_id: a.authorId || '',
        thumbnail: a.thumbnailImageUrl || (a.images && a.images.thumbnail ? a.images.thumbnail.url : '') || '',
        description: a.description || ''
      };
    }
    return null;
  }
  const resp = await vrchatGetUser(targetId, cookie);
  const u = (resp && resp.status >= 200 && resp.status < 300) ? resp.data : null;
  if (u && u.id) {
    return {
      name: u.displayName || u.username || '', author: u.displayName || '', author_id: u.id || '',
      thumbnail: u.profilePicOverrideThumbnail || u.currentAvatarThumbnailImageUrl || '',
      description: ''
    };
  }
  return null;
}

async function backfillMissingInfo(rows, cookie) {
  const pool = getPool();
  const targets = [];
  for (const r of rows) {
    if (!(r.name || '') && r.target_id && !backfillInflight.has(r.id)) targets.push(r);
    if (targets.length >= 6) break;
  }
  if (!targets.length) return;
  for (const r of targets) backfillInflight.add(r.id);
  try {
    for (const r of targets) {
      try {
        const patch = await fetchRemotePatch(r.kind, r.target_id, cookie);
        if (patch && patch.name) {
          await pool.query(
            `UPDATE collections SET name=?, author=?, author_id=?, thumbnail=?,
               description=IF(description IS NULL OR description='', ?, description), updated_at=NOW()
             WHERE id=? AND (name IS NULL OR name='')`,
            [patch.name, patch.author, patch.author_id, patch.thumbnail, patch.description, r.id]
          );
        }
      } catch (_) { /* 单条失败静默，下轮列表加载再试 */ }
    }
  } finally {
    for (const r of targets) backfillInflight.delete(r.id);
  }
}

// ============ 分组 folders ============
// 列表
router.get('/folders', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const uid = req.session.userId;
    const [rows] = await pool.query(
      `SELECT f.*, (SELECT COUNT(*) FROM collections c WHERE c.folder_id = f.id) AS item_count
       FROM collection_folders f WHERE f.user_id = ? ORDER BY f.sort_order ASC, f.id ASC`,
      [uid]
    );
    ok(res, { folders: rows });
  } catch (e) { handleError(res, e, 'collections.folders'); }
});

// 创建
router.post('/folders', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const uid = req.session.userId;
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ success: false, error: { code: ErrorCodes.BAD_REQUEST, message: '分组名称不能为空' } });
    if (name.length > 100) return res.status(400).json({ success: false, error: { code: ErrorCodes.BAD_REQUEST, message: '分组名称过长' } });
    const [ex] = await pool.query(`SELECT id FROM collection_folders WHERE user_id=? AND name=?`, [uid, name]);
    if (ex.length) return res.status(409).json({ success: false, error: { code: ErrorCodes.BAD_REQUEST, message: '分组已存在' } });
    const [r] = await pool.query(
      `INSERT INTO collection_folders (user_id, name, sort_order) VALUES (?, ?, (SELECT COALESCE(MAX(sort_order)+1,0) FROM collection_folders f2 WHERE f2.user_id=?))`,
      [uid, name, uid]
    );
    ok(res, { folder: { id: r.insertId, user_id: uid, name, sort_order: 0, item_count: 0 } });
  } catch (e) { handleError(res, e, 'collections.folder.create'); }
});

// 重命名 / 排序 / 删除
router.put('/folders/:id', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const uid = req.session.userId;
    const id = Number(req.params.id);
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ success: false, error: { code: ErrorCodes.BAD_REQUEST, message: '分组名称不能为空' } });
    const [ex] = await pool.query(`SELECT id FROM collection_folders WHERE user_id=? AND name=? AND id<>?`, [uid, name, id]);
    if (ex.length) return res.status(409).json({ success: false, error: { code: ErrorCodes.BAD_REQUEST, message: '分组已存在' } });
    await pool.query(`UPDATE collection_folders SET name=? WHERE id=? AND user_id=?`, [name, id, uid]);
    ok(res);
  } catch (e) { handleError(res, e, 'collections.folder.update'); }
});

router.delete('/folders/:id', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const uid = req.session.userId;
    const id = Number(req.params.id);
    // 分组下项目移回未分组
    await pool.query(`UPDATE collections SET folder_id=NULL WHERE folder_id=? AND user_id=?`, [id, uid]);
    await pool.query(`DELETE FROM collection_folders WHERE id=? AND user_id=?`, [id, uid]);
    ok(res);
  } catch (e) { handleError(res, e, 'collections.folder.delete'); }
});

// ============ 收藏列表 ============
function buildListWhere(q, uid) {
  const conds = [];
  const params = [];
  const scope = q.scope || 'mine'; // mine | public
  if (scope === 'public') {
    conds.push('c.visibility = ?');
    params.push('public');
  } else {
    conds.push('c.user_id = ?');
    params.push(uid);
  }
  if (q.kind) { conds.push('c.kind = ?'); params.push(q.kind); }
  if (q.folderId) { conds.push('c.folder_id = ?'); params.push(Number(q.folderId)); }
  if (q.worldType) { conds.push('c.world_type = ?'); params.push(q.worldType); }
  if (q.platform) { conds.push('c.platform = ?'); params.push(q.platform); }
  if (q.contentRating) { conds.push('c.content_rating = ?'); params.push(q.contentRating); }
  if (q.category) { conds.push('c.category = ?'); params.push(q.category); }
  if (q.status) { conds.push('c.status = ?'); params.push(q.status); }
  if (q.tag) {
    conds.push('JSON_CONTAINS(c.tags, ?)');
    params.push(JSON.stringify(q.tag));
  }
  if (q.search) {
    conds.push('(c.name LIKE ? ESCAPE \'!\' OR c.target_id LIKE ? ESCAPE \'!\' OR c.author LIKE ? ESCAPE \'!\' OR c.description LIKE ? ESCAPE \'!\')');
    const s = `%${escapeLike(q.search)}%`;
    params.push(s, s, s, s);
  }
  return { conds, params };
}

router.get('/', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const uid = req.session.userId;
    const q = req.query;
    const { conds, params } = buildListWhere(q, uid);
    const allowedSort = {
      updated: 'c.updated_at DESC',
      created: 'c.created_at DESC',
      favorite: 'c.favorite_count DESC',
      rating: 'c.rating_avg DESC, c.rating_count DESC',
      name: 'c.name ASC',
      heat: 'c.heat DESC, c.updated_at DESC'
    };
    const sort = allowedSort[q.sort] || allowedSort.heat;
    const { page, pageSize, offset } = paginate(req, { defaultSize: 24, maxSize: 60 });

    const whereSql = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const [countRows] = await pool.query(`SELECT COUNT(*) AS total FROM collections c ${whereSql}`, params);
    const total = countRows[0].total;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    const [rows] = await pool.query(
      `SELECT c.*,
         (SELECT COUNT(*) FROM collections d WHERE d.target_id = c.target_id AND d.visibility='public' AND d.id <> c.id) AS public_duplicate
       FROM collections c ${whereSql} ORDER BY ${sort} LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );
    // 缩略图代理 + 去重标记（同模型ID是否已有他人公开副本）
    rows.forEach(r => { if (r.thumbnail) r.thumbnail = proxyThumb(r.thumbnail); r.public_duplicate = !!Number(r.public_duplicate); });
    // 自愈：本页存在历史空名行时后台回源补齐，不阻塞本次响应
    backfillMissingInfo(rows, req.vrcCookie || null).catch(() => {});
    ok(res, {
      items: rows,
      page, pageSize, total, totalPages,
      scope: q.scope || 'mine'
    });
  } catch (e) { handleError(res, e, 'collections.list'); }
});

// ============ 公开发现 ============
router.get('/discover', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const q = req.query;
    const params = ['public'];
    const conds = ['c.visibility = ?'];
    if (q.kind) { conds.push('c.kind = ?'); params.push(q.kind); }
    if (q.worldType) { conds.push('c.world_type = ?'); params.push(q.worldType); }
    if (q.platform) { conds.push('c.platform = ?'); params.push(q.platform); }
    if (q.contentRating) { conds.push('c.content_rating = ?'); params.push(q.contentRating); }
    if (q.category) { conds.push('c.category = ?'); params.push(q.category); }
    if (q.status) { conds.push('c.status = ?'); params.push(q.status); }
    if (q.search) {
      conds.push('(c.name LIKE ? ESCAPE \'!\' OR c.target_id LIKE ? ESCAPE \'!\' OR c.author LIKE ? ESCAPE \'!\')');
      const s = `%${escapeLike(q.search)}%`;
      params.push(s, s, s);
    }
    const sort = q.sort === 'new' ? 'c.created_at DESC' : 'c.heat DESC, c.updated_at DESC';
    const { page, pageSize, offset } = paginate(req, { defaultSize: 24, maxSize: 60 });
    // 同模型ID去重：公开发现页每个 target_id 仅保留热度最高的一个副本，避免重复展示
    conds.push(`c.id = (SELECT d2.id FROM collections d2 WHERE d2.target_id = c.target_id AND d2.visibility='public' ORDER BY d2.heat DESC, d2.id ASC LIMIT 1)`);
    const whereSql = `WHERE ${conds.join(' AND ')}`;
    const [countRows] = await pool.query(`SELECT COUNT(*) AS total FROM collections c ${whereSql}`, params);
    const total = countRows[0].total;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const [rows] = await pool.query(
      `SELECT c.*, u.display_name AS owner_name,
         (SELECT COUNT(*) FROM collections d WHERE d.target_id = c.target_id AND d.visibility='public' AND d.id <> c.id) AS public_duplicate
       FROM collections c
       LEFT JOIN users u ON u.id = c.user_id ${whereSql}
       ORDER BY ${sort} LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );
    rows.forEach(r => { if (r.thumbnail) r.thumbnail = proxyThumb(r.thumbnail); delete r.notes; r.public_duplicate = !!Number(r.public_duplicate); });
    backfillMissingInfo(rows, req.vrcCookie || null).catch(() => {});
    ok(res, { items: rows, page, pageSize, total, totalPages });
  } catch (e) { handleError(res, e, 'collections.discover'); }
});

// ============ 公开标签云 ============
router.get('/tags', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT tag, COUNT(*) AS count FROM (
         SELECT JSON_UNQUOTE(JSON_EXTRACT(tags, CONCAT('$[', n.n, ']'))) AS tag
         FROM collections, (SELECT 0 n UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) n
         WHERE visibility='public' AND tags IS NOT NULL
       ) t WHERE tag IS NOT NULL GROUP BY tag ORDER BY count DESC LIMIT 30`
    );
    ok(res, { tags: rows });
  } catch (e) { handleError(res, e, 'collections.tags'); }
});

// ============ 匿名 VRChat 模型搜索（VRCX 公开接口，无需登录） ============
// 数据来源：https://requi.dev/vrcx_search.php —— 社区维护的 VRChat Avatar 搜索引擎，
// 底层基于 api.vrchat.cloud/api/1，无需鉴权。本端点做服务端代理：规避浏览器跨域、
// 输入校验、本地缓存降低上游压力、上游失败时优雅降级。
// 该能力由孤儿模块 model-collections.js 的 /search 端点迁移而来，现已并入统一收藏系统。
const VRCX_SEARCH_URL = process.env.VRCX_SEARCH_URL || 'https://requi.dev/vrcx_search.php';
const vrcxSearchCache = new Map(); // key -> { ts, data }
const VRCX_CACHE_TTL = 10 * 60 * 1000;

router.get('/search-models', async (req, res) => {
  try {
    const q = (req.query.q || req.query.search || '').trim();
    const n = Math.min(30, Math.max(1, parseInt(req.query.n) || 12));
    if (!q) return res.status(400).json({ success: false, error: { code: ErrorCodes.BAD_REQUEST, message: '搜索关键词不能为空' } });
    // 仅允许中文/英文/数字/空格/连字符/点/下划线/@，避免注入到上游 URL（外加 encodeURIComponent 双层防护）
    if (!/^[一-龥A-Za-z0-9\s\-_.@]+$/.test(q)) {
      return res.status(400).json({ success: false, error: { code: ErrorCodes.BAD_REQUEST, message: '搜索关键词包含非法字符' } });
    }
    const cacheKey = q.toLowerCase() + '|' + n;
    const cached = vrcxSearchCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < VRCX_CACHE_TTL) {
      return ok(res, { results: cached.data, cached: true });
    }
    let upstream;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      upstream = await fetch(`${VRCX_SEARCH_URL}?search=${encodeURIComponent(q)}&n=${n}`, {
        headers: { 'User-Agent': USER_AGENT || 'JingTuWeb_1.3.0' }
      });
    } catch (e) {
      clearTimeout(timer);
      // 上游不可达：返回空结果 + 提示，不让前端崩溃（降级）
      return ok(res, { results: [], error: '搜索服务暂不可用，请稍后重试' });
    }
    clearTimeout(timer);
    if (!upstream.ok) {
      return ok(res, { results: [], error: '上游搜索服务返回异常' });
    }
    const raw = await upstream.json().catch(() => null);
    const arr = Array.isArray(raw) ? raw
      : (Array.isArray(raw?.result) ? raw.result
        : (Array.isArray(raw?.results) ? raw.results : []));
    const results = arr
      .map(it => ({
        id: it?.id || '',
        name: it?.name || '',
        authorId: it?.authorId || '',
        authorName: it?.authorName || '',
        description: it?.description || '',
        imageUrl: it?.imageUrl || '',
        thumbnailImageUrl: it?.thumbnailImageUrl || it?.imageUrl || '',
        releaseStatus: it?.releaseStatus || 'public'
      }))
      .filter(x => x.id && /^avtr_/i.test(x.id))
      .slice(0, n);
    vrcxSearchCache.set(cacheKey, { ts: Date.now(), data: results });
    ok(res, { results });
  } catch (e) {
    // 兜底：任何未预期错误都返回空结果，不抛 500（搜索非核心功能）。
    // P3-113：不回显 e.message（可能含上游 URL/模块细节），固定文案 + 服务端日志。
    logger.error('[collections/search-models]', e);
    ok(res, { results: [], error: '模型搜索失败，请稍后重试' });
  }
});

// ============ 世界搜索 + 热门世界排行（F-世界搜索/热门排行） ============
// 借鉴 VRCX src/api/world.js getWorlds() 与 useSearchWorld.js：
//   - 关键词搜索：GET /worlds?search=...（VRChat 官方 API）
//   - 热门排行：sort=popularity（VRCX "Trending"）
//   - 精选：sort=order&featured=true（VRCX "Featured"）
// 本端点做服务端代理：规避浏览器跨域、输入校验、本地缓存、上游失败优雅降级。
const vrcWorldSearchCache = new Map();
const VRC_WORLD_CACHE_TTL = 10 * 60 * 1000;

// 归一化世界列表字段（对齐前端展示与收藏录入所需的字段）
function normalizeWorldList(raw, n) {
  const arr = Array.isArray(raw) ? raw
    : (Array.isArray(raw?.data) ? raw.data
      : (Array.isArray(raw?.result) ? raw.result
        : (Array.isArray(raw?.results) ? raw.results : [])));
  return arr
    .map(w => ({
      id: w?.id || '',
      name: w?.name || '',
      authorId: w?.authorId || '',
      authorName: w?.authorName || '',
      description: w?.description || '',
      imageUrl: w?.imageUrl || '',
      thumbnailImageUrl: w?.thumbnailImageUrl || w?.imageUrl || '',
      capacity: w?.capacity || 0,
      occupants: w?.occupants || 0,
      favorites: w?.favorites || 0,
      heat: w?.heat || 0,
      visits: w?.visits || 0,
      popularity: w?.popularity || 0,
      releaseStatus: w?.releaseStatus || 'public',
      publicationDate: w?.publicationDate || w?.created_at || '',
      updated_at: w?.updated_at || '',
      tags: Array.isArray(w?.tags) ? w.tags : [],
      platform: w?.platform || (w?.platforms && w.platforms[0]) || ''
    }))
    .filter(x => x.id && /^wrld_/i.test(x.id))
    .slice(0, n);
}

// 世界搜索（关键词）：GET /api/collections/search-worlds?q=...&n=...
router.get('/search-worlds', async (req, res) => {
  try {
    const q = (req.query.q || req.query.search || '').trim();
    const n = Math.min(30, Math.max(1, parseInt(req.query.n) || 12));
    if (!q) return res.status(400).json({ success: false, error: { code: ErrorCodes.BAD_REQUEST, message: '搜索关键词不能为空' } });
    // 仅允许中文/英文/数字/空格/连字符/点/下划线/@
    if (!/^[一-龥A-Za-z0-9\s\-_.@]+$/.test(q)) {
      return res.status(400).json({ success: false, error: { code: ErrorCodes.BAD_REQUEST, message: '搜索关键词包含非法字符' } });
    }
    const cacheKey = 'w:' + q.toLowerCase() + '|' + n;
    const cached = vrcWorldSearchCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < VRC_WORLD_CACHE_TTL) {
      return ok(res, { results: cached.data, cached: true });
    }
    let resp;
    try {
      resp = await vrchatListWorlds({ search: q, n, sort: 'popularity' }, req.vrcCookie || null);
    } catch (e) {
      // 上游不可达/限流：返回空结果，不抛 500
      return ok(res, { results: [], error: '世界搜索服务暂不可用，请稍后重试' });
    }
    const results = normalizeWorldList(resp?.data, n);
    vrcWorldSearchCache.set(cacheKey, { ts: Date.now(), data: results });
    ok(res, { results });
  } catch (e) {
    // P3-113：不回显 e.message，固定文案 + 服务端日志
    logger.error('[collections/search-worlds]', e);
    ok(res, { results: [], error: '世界搜索失败，请稍后重试' });
  }
});

// 热门世界排行 / 精选 / 活跃世界：GET /api/collections/popular-worlds?sort=popularity|featured|active|recent&n=...
router.get('/popular-worlds', async (req, res) => {
  try {
    const sort = (req.query.sort || 'popularity').trim();
    const n = Math.min(30, Math.max(1, parseInt(req.query.n) || 20));
    const allowed = ['popularity', 'featured', 'active', 'recent', 'updated'];
    const key = allowed.includes(sort) ? sort : 'popularity';
    const cacheKey = 'pw:' + key + '|' + n;
    const cached = vrcWorldSearchCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < VRC_WORLD_CACHE_TTL) {
      return ok(res, { results: cached.data, sort: key, cached: true });
    }
    let resp;
    try {
      if (key === 'featured') resp = await vrchatGetFeaturedWorlds(n, req.vrcCookie || null);
      else if (key === 'active') resp = await vrchatListWorlds({ sort: 'active', n }, req.vrcCookie || null);
      else if (key === 'recent') resp = await vrchatListWorlds({ sort: 'created', n }, req.vrcCookie || null);
      else if (key === 'updated') resp = await vrchatListWorlds({ sort: 'updated', n }, req.vrcCookie || null);
      else resp = await vrchatGetPopularWorlds(n, req.vrcCookie || null);
    } catch (e) {
      return ok(res, { results: [], sort: key, error: '世界排行服务暂不可用，请稍后重试' });
    }
    const results = normalizeWorldList(resp?.data, n);
    vrcWorldSearchCache.set(cacheKey, { ts: Date.now(), data: results });
    ok(res, { results, sort: key });
  } catch (e) {
    // P3-113：不回显 e.message，固定文案 + 服务端日志
    logger.error('[collections/popular-worlds]', e);
    ok(res, { results: [], error: '世界排行失败，请稍后重试' });
  }
});

// ============ 收藏详情 ============
// 用于详情弹窗：返回完整字段 + public_duplicate(同模型是否已有他人公开副本) 标记。
// 隐私：公开收藏任何人可看；私密收藏仅本人可看。
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const uid = req.session.userId;
    const id = Number(req.params.id);
    const [rows] = await pool.query(
      `SELECT c.*, u.display_name AS owner_name,
         (SELECT COUNT(*) FROM collections d WHERE d.target_id = c.target_id AND d.visibility='public' AND d.id <> c.id) AS public_duplicate
       FROM collections c LEFT JOIN users u ON u.id = c.user_id WHERE c.id = ?`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: { code: ErrorCodes.NOT_FOUND, message: '收藏不存在' } });
    const it = rows[0];
    if (it.visibility !== 'public' && it.user_id !== uid)
      return res.status(403).json({ success: false, error: { code: ErrorCodes.FORBIDDEN, message: '无权查看' } });
    if (it.thumbnail) it.thumbnail = proxyThumb(it.thumbnail);
    it.public_duplicate = !!Number(it.public_duplicate);
    ok(res, { item: it });
  } catch (e) { handleError(res, e, 'collections.detail'); }
});

// ============ 添加收藏 ============
router.post('/', requireAuth, async (req, res) => {
  let conn;
  try {
    const pool = getPool();
    const uid = req.session.userId;
    const kind = req.body.kind;
    const targetId = (req.body.target_id || '').trim();
    const visibility = req.body.visibility === 'public' ? 'public' : 'private';
    const showAuthor = (visibility === 'public' && req.body.show_author) ? 1 : 0;
    const folderId = req.body.folder_id ? Number(req.body.folder_id) : null;
    const notes = req.body.notes || '';
    const boothUrl = req.body.booth_url || '';

    if (!['avatar_model', 'world', 'avatar_favorite'].includes(kind))
      return res.status(400).json({ success: false, error: { code: ErrorCodes.BAD_REQUEST, message: '无效的收藏类型' } });
    if (!targetId || !isValidTargetId(kind, targetId))
      return res.status(400).json({ success: false, error: { code: ErrorCodes.BAD_REQUEST, message: '无效的 VRChat ID' } });
    if (folderId) {
      const [f] = await pool.query(`SELECT id FROM collection_folders WHERE id=? AND user_id=?`, [folderId, uid]);
      if (!f.length) return res.status(400).json({ success: false, error: { code: ErrorCodes.BAD_REQUEST, message: '分组不存在' } });
    }

    // 去重
    const [dup] = await pool.query(`SELECT id FROM collections WHERE user_id=? AND kind=? AND target_id=?`, [uid, kind, targetId]);
    if (dup.length) return res.status(409).json({ success: false, error: { code: ErrorCodes.BAD_REQUEST, message: '已在收藏中' } });

    // 公开唯一性：同一 target_id 全站至多一个公开副本，避免公开发现页重复展示
    if (visibility === 'public') {
      const [pd] = await pool.query(`SELECT id FROM collections WHERE target_id=? AND visibility='public'`, [targetId]);
      if (pd.length) return res.status(409).json({ success: false, error: { code: 'DUPLICATE_PUBLIC', message: '该模型已被他人公开，无法重复公开' } });
    }

    const rec = {
      name: '', author: '', author_id: '', thumbnail: '', description: '',
      platform: '', world_type: '', load_type: '', size_bytes: 0, size_category: '',
      category: 'white', content_rating: 'all', tags: null,
      status: 'unknown', unity_version: '', asset_url: '', unity_package_url: '',
      favorite_count: 0, rating_avg: 0, rating_count: 0, heat: 0
    };

    if (kind === 'avatar_model') {
      const cookie = req.vrcCookie || null;
      try {
        // vrchatGetAvatar 返回 {status,data} 包装体，须解包后使用（否则 name/thumbnail 全空、且 404 也被当成功）
        const resp = await vrchatGetAvatar(targetId, cookie);
        const avatar = (resp && resp.status >= 200 && resp.status < 300) ? resp.data : null;
        if (avatar && avatar.id) {
          rec.name = avatar.name || '';
          rec.author = avatar.authorName || '';
          rec.author_id = avatar.authorId || '';
          rec.thumbnail = avatar.thumbnailImageUrl || (avatar.images && avatar.images.thumbnail ? avatar.images.thumbnail.url : '') || '';
          rec.description = avatar.description || '';
          rec.platform = (avatar.unityPackages && avatar.unityPackages[0] && avatar.unityPackages[0].platform) || '';
          rec.unity_version = avatar.unityVersion || '';
          rec.asset_url = (avatar.unityPackages && avatar.unityPackages[0] && avatar.unityPackages[0].assetUrl) || '';
          rec.size_bytes = (avatar.unityPackages && avatar.unityPackages[0] && avatar.unityPackages[0].assetVersion) ? 0 : 0;
          rec.content_rating = (avatar.tags || []).some(t => /sex|nsfw|18\+/i.test(t)) ? '18+' : 'all';
          rec.category = (avatar.tags || []).includes('author_tag_avatar_functional') ? 'functional' : 'white';
          rec.tags = JSON.stringify(avatar.tags || []);
          rec.favorite_count = avatar.favoriteCount || 0;
        }
      } catch (e) { /* 拉取失败不阻断，标记为 unknown */ }
      rec.heat = computeHeat(rec.rating_avg, rec.rating_count, rec.favorite_count, 0, 0);
    } else if (kind === 'world') {
      try {
        // F-17: 走世界详情缓存，命中直接返回、miss 才回源 VRChat 并回写缓存
        const w = await getCachedWorld(targetId, req.vrcCookie || null);
        if (w) {
          rec.name = w.name || '';
          rec.author = w.authorName || '';
          rec.author_id = w.authorId || '';
          rec.thumbnail = (w.imageUrl || (w.thumbnail ? w.thumbnail.url : '')) || '';
          rec.description = w.description || '';
          rec.world_type = w.worldType || '';
          rec.unity_package_url = w.unityPackageUrl || '';
          rec.asset_url = w.assetUrl || '';
          rec.platform = (w.platform || '');
          rec.tags = JSON.stringify(w.tags || []);
          rec.content_rating = (w.tags || []).some(t => /sex|nsfw|18\+/i.test(t)) ? '18+' : 'all';
        }
      } catch (e) { /* ignore */ }
    } else if (kind === 'avatar_favorite') {
      try {
        // vrchatGetUser 同样返回 {status,data} 包装体，解包后再取 displayName/头像字段
        const resp = await vrchatGetUser(targetId, req.vrcCookie || null);
        const u = (resp && resp.status >= 200 && resp.status < 300) ? resp.data : null;
        if (u && u.id) {
          rec.name = u.displayName || u.username || '';
          rec.author = u.displayName || '';
          rec.author_id = u.id || targetId;
          rec.thumbnail = (u.profilePicOverrideThumbnail || u.currentAvatarThumbnailImageUrl || '') || '';
        }
      } catch (e) { /* ignore */ }
    }

    rec.thumbnail = rec.thumbnail || '';
    // P2-159: 公开收藏唯一性改由 DB 约束兜底（生成列 public_key + uk_public_key）。
    // 前置于 L536-540 的 SELECT 预检仅为快速失败；并发窗口下的重复插入由唯一键
    // 拦截为 ER_DUP_ENTRY（SQLite 模式由 mapSQLError 映射 errno=1062），此处转 409。
    let insertId;
    try {
      const [r] = await pool.query(
        `INSERT INTO collections
          (user_id, kind, target_id, name, author, author_id, thumbnail, description, world_type, platform, load_type, size_bytes, size_category, category, content_rating, tags, status, unity_version, asset_url, unity_package_url, booth_url, favorite_count, rating_avg, rating_count, heat, visibility, show_author, folder_id, notes, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())`,
        [uid, kind, targetId, rec.name, rec.author, rec.author_id, rec.thumbnail, rec.description, rec.world_type, rec.platform, rec.load_type, rec.size_bytes, rec.size_category, rec.category, rec.content_rating, rec.tags, rec.status, rec.unity_version, rec.asset_url, rec.unity_package_url, boothUrl, rec.favorite_count, rec.rating_avg, rec.rating_count, rec.heat, visibility, showAuthor, folderId, notes]
      );
      insertId = r.insertId;
    } catch (dupErr) {
      if (dupErr && (dupErr.errno === 1062 || dupErr.code === 'ER_DUP_ENTRY')) {
        return res.status(409).json({
          success: false,
          error: {
            code: visibility === 'public' ? 'DUPLICATE_PUBLIC' : ErrorCodes.BAD_REQUEST,
            message: visibility === 'public' ? '该模型已被他人公开，无法重复公开' : '已在收藏中'
          }
        });
      }
      throw dupErr;
    }
    await refreshAggregates(pool, targetId, kind);
    const [item] = await pool.query(`SELECT * FROM collections WHERE id=?`, [insertId]);
    if (item[0] && item[0].thumbnail) item[0].thumbnail = proxyThumb(item[0].thumbnail);
    ok(res, { item: item[0] });
  } catch (e) { handleError(res, e, 'collections.add'); }
});

// ============ 更新 ============
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const uid = req.session.userId;
    const id = Number(req.params.id);
    const [cur] = await pool.query(`SELECT * FROM collections WHERE id=? AND user_id=?`, [id, uid]);
    if (!cur.length) return res.status(404).json({ success: false, error: { code: ErrorCodes.NOT_FOUND, message: '收藏不存在' } });

    // 公开唯一性：同一 target_id 全站至多一个公开副本（已公开的不受此限，仅拦截"设为公开"）
    if (req.body.visibility === 'public' && cur[0].visibility !== 'public') {
      const [pd] = await pool.query(`SELECT id FROM collections WHERE target_id=? AND visibility='public' AND id<>?`, [cur[0].target_id, id]);
      if (pd.length) return res.status(409).json({ success: false, error: { code: 'DUPLICATE_PUBLIC', message: '该模型已被他人公开，为避免重复展示无法重复公开' } });
    }

    const sets = [];
    const params = [];
    if (typeof req.body.notes === 'string') { sets.push('notes=?'); params.push(req.body.notes); }
    if (req.body.visibility === 'public' || req.body.visibility === 'private') { sets.push('visibility=?'); params.push(req.body.visibility); }
    // 署名公开：仅在公开状态有意义。设为私密时一并复位，避免再次公开残留旧署名偏好。
    // 本路由已通过 WHERE user_id=? 限制仅收藏所有者可改，因此"只有公开者本人能关闭/修改署名"天然成立。
    if (typeof req.body.show_author === 'boolean' || req.body.show_author === 0 || req.body.show_author === 1) {
      const sa = (req.body.visibility === 'private') ? 0 : (req.body.show_author ? 1 : 0);
      sets.push('show_author=?'); params.push(sa);
    }
    if (req.body.folder_id !== undefined) {
      const fid = req.body.folder_id ? Number(req.body.folder_id) : null;
      if (fid) {
        const [f] = await pool.query(`SELECT id FROM collection_folders WHERE id=? AND user_id=?`, [fid, uid]);
        if (!f.length) return res.status(400).json({ success: false, error: { code: ErrorCodes.BAD_REQUEST, message: '分组不存在' } });
      }
      sets.push('folder_id=?'); params.push(fid);
    }
    if (typeof req.body.name === 'string' && req.body.name.trim()) { sets.push('name=?'); params.push(req.body.name.trim()); }
    if (sets.length) {
      sets.push('updated_at=NOW()');
      try {
        await pool.query(`UPDATE collections SET ${sets.join(',')} WHERE id=?`, [...params, id]);
      } catch (dupErr) {
        // P2-159: 并发「设为公开」同样可能撞唯一键，转为既有 409 语义
        if (dupErr && (dupErr.errno === 1062 || dupErr.code === 'ER_DUP_ENTRY')) {
          return res.status(409).json({ success: false, error: { code: 'DUPLICATE_PUBLIC', message: '该模型已被他人公开，为避免重复展示无法重复公开' } });
        }
        throw dupErr;
      }
    }
    const [item] = await pool.query(`SELECT * FROM collections WHERE id=?`, [id]);
    if (item[0] && item[0].thumbnail) item[0].thumbnail = proxyThumb(item[0].thumbnail);
    ok(res, { item: item[0] });
  } catch (e) { handleError(res, e, 'collections.update'); }
});

// ============ 删除 ============
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const uid = req.session.userId;
    const id = Number(req.params.id);
    const [cur] = await pool.query(`SELECT * FROM collections WHERE id=? AND user_id=?`, [id, uid]);
    if (!cur.length) return res.status(404).json({ success: false, error: { code: ErrorCodes.NOT_FOUND, message: '收藏不存在' } });
    await pool.query(`DELETE FROM collections WHERE id=?`, [id]);
    await refreshAggregates(pool, cur[0].target_id, cur[0].kind);
    ok(res);
  } catch (e) { handleError(res, e, 'collections.delete'); }
});

// ============ 失效重检 (仅 avatar_model) ============
router.post('/:id/check', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const uid = req.session.userId;
    const id = Number(req.params.id);
    const [cur] = await pool.query(`SELECT * FROM collections WHERE id=? AND user_id=?`, [id, uid]);
    if (!cur.length) return res.status(404).json({ success: false, error: { code: ErrorCodes.NOT_FOUND, message: '收藏不存在' } });
    if (cur[0].kind !== 'avatar_model') return res.status(400).json({ success: false, error: { code: ErrorCodes.BAD_REQUEST, message: '该类型不支持失效检测' } });
    let status = 'unknown', invalidReason = '', invalidAt = null;
    try {
      // 解包 {status,data} 包装体；仅 404 判定为失效，401/403（登录态失效）保持 unknown 不误伤原状态
      const resp = await vrchatGetAvatar(cur[0].target_id, req.vrcCookie || null);
      const httpStatus = resp && resp.status;
      const avatar = (resp && resp.status >= 200 && resp.status < 300) ? resp.data : null;
      if (avatar && avatar.id) {
        status = 'valid';
        // 顺手自愈：历史空名行在检测时回填名字/作者/缩略图
        if (!(cur[0].name || '')) {
          const thumb = avatar.thumbnailImageUrl || (avatar.images && avatar.images.thumbnail ? avatar.images.thumbnail.url : '') || '';
          await pool.query(
            `UPDATE collections SET name=?, author=?, author_id=?, thumbnail=?, updated_at=NOW() WHERE id=? AND (name IS NULL OR name='')`,
            [avatar.name || '', avatar.authorName || '', avatar.authorId || '', thumb, id]
          );
        }
      } else if (httpStatus === 404 || httpStatus === 410) {
        status = 'invalid'; invalidReason = 'VRChat 未返回该模型'; invalidAt = new Date();
      } else if (httpStatus === 401 || httpStatus === 403) {
        invalidReason = 'VRChat 登录态失效，无法检测';
      } else {
        invalidReason = 'VRChat 接口未返回可判定结果';
      }
    } catch (e) {
      status = 'invalid'; invalidReason = e.message || '检测失败'; invalidAt = new Date();
    }
    await pool.query(
      `UPDATE collections SET status=?, invalid_reason=?, last_checked_at=NOW(), invalid_at=? WHERE id=?`,
      [status, invalidReason, invalidAt, id]
    );
    ok(res, { status, invalidReason });
  } catch (e) { handleError(res, e, 'collections.check'); }
});

// ============ 评分 (仅 avatar_model) ============
router.post('/:id/rate', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const uid = req.session.userId;
    const id = Number(req.params.id);
    // P2-160: 严格整数评分（拒绝 5.5 / "abc" / 越界），不再静默 clamp
    const ratingNum = Number(req.body.rating);
    if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5)
      return res.status(400).json({ success: false, error: { code: ErrorCodes.BAD_REQUEST, message: '评分需为 1-5 的整数' } });
    const [cur] = await pool.query(`SELECT * FROM collections WHERE id=?`, [id]);
    if (!cur.length) return res.status(404).json({ success: false, error: { code: ErrorCodes.NOT_FOUND, message: '收藏不存在' } });
    // P2-160: 仅公开收藏可被社区评分——私密收藏直接拒绝（防自刷热度，也避免借评分接口枚举他人私密收藏）
    if (cur[0].visibility !== 'public')
      return res.status(403).json({ success: false, error: { code: ErrorCodes.FORBIDDEN, message: '仅公开收藏可参与评分' } });
    // P2-160: 本人排除——收藏者不能给自己的收藏评分（自刷热度）
    if (cur[0].user_id === uid)
      return res.status(400).json({ success: false, error: { code: ErrorCodes.BAD_REQUEST, message: '不能给自己的收藏评分' } });

    // 评分存到收藏者本人记录（轻量：更新 rating_avg/count 基于所有评分者）
    const [myRate] = await pool.query(`SELECT id FROM collection_ratings WHERE collection_id=? AND user_id=?`, [id, uid]);
    if (myRate.length) await pool.query(`UPDATE collection_ratings SET rating=?, updated_at=NOW() WHERE id=?`, [ratingNum, myRate[0].id]);
    else await pool.query(`INSERT INTO collection_ratings (collection_id, user_id, rating) VALUES (?,?,?)`, [id, uid, ratingNum]);
    const [agg] = await pool.query(`SELECT AVG(rating) AS avg, COUNT(*) AS cnt FROM collection_ratings WHERE collection_id=?`, [id]);
    await pool.query(`UPDATE collections SET rating_avg=?, rating_count=? WHERE id=?`, [(agg[0].avg || 0).toFixed(2), agg[0].cnt || 0, id]);
    await refreshAggregates(pool, cur[0].target_id, cur[0].kind);
    ok(res, { rating_avg: agg[0].avg, rating_count: agg[0].cnt });
  } catch (e) { handleError(res, e, 'collections.rate'); }
});

// ============ 复制模型到游戏内 (仅 avatar_model, 需本人 cookie) ============
// V8.4: 借鉴 VRCX 行为 —— 先尝试从基座克隆(加入本人库存)，再切换穿戴。
// 对已在库存的模型克隆会返回 409/400，视为成功继续切换；克隆失败则直接尝试切换。
router.post('/:id/set-avatar', requireAuth, async (req, res) => {
  try {
    const cookie = req.vrcCookie;
    if (!cookie) return res.status(400).json({ success: false, error: { code: ErrorCodes.BAD_REQUEST, message: '未绑定 VRChat 账号' } });
    const pool = getPool();
    const uid = req.session.userId;
    const id = Number(req.params.id);
    const [cur] = await pool.query(`SELECT * FROM collections WHERE id=? AND user_id=?`, [id, uid]);
    if (!cur.length) return res.status(404).json({ success: false, error: { code: ErrorCodes.NOT_FOUND, message: '收藏不存在' } });
    const avatarId = cur[0].target_id;
    // 1) 拉详情拿 inventoryItemId（unityPackages[0].id），用于克隆到本人库存
    let inventoryItemId = null;
    try {
      // 解包后再取 unityPackages（此前直接读包装体恒为 undefined，克隆步骤从未真正执行）
      const resp = await vrchatGetAvatar(avatarId, cookie);
      const detail = (resp && resp.status >= 200 && resp.status < 300) ? resp.data : null;
      const ups = detail && detail.unityPackages;
      if (Array.isArray(ups) && ups.length) inventoryItemId = ups[0].id;
    } catch (_) { /* 详情拉取失败不阻断，直接进入切换 */ }
    // 2) 先克隆（陌生人的公开发布模型必须先在库存才能穿戴）
    if (inventoryItemId) {
      try { await vrchatCloneAvatar(inventoryItemId, cookie); } catch (_) { /* 可能已在库存，忽略 */ }
    }
    // 3) 切换穿戴
    const switched = await vrchatSetAvatar(avatarId, cookie);
    if (switched) ok(res);
    else res.status(400).json({ success: false, error: { code: ErrorCodes.BAD_REQUEST, message: '切换失败' } });
  } catch (e) { handleError(res, e, 'collections.setAvatar'); }
});

// ============ 全站失效检测 (admin) ============
router.post('/scan', requireAdminCompat, async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query(`SELECT id, target_id FROM collections WHERE kind='avatar_model' AND status<>'invalid' ORDER BY updated_at ASC LIMIT 200`);
    let checked = 0, newInvalid = 0;
    for (const r of rows) {
      try {
        // 解包包装体；无 cookie 场景下 401/403 跳过本轮，不误批量标记失效
        const resp = await vrchatGetAvatar(r.target_id, null);
        const httpStatus = resp && resp.status;
        const data = (resp && resp.status >= 200 && resp.status < 300) ? resp.data : null;
        if (data && data.id) {
          checked++;
          await pool.query(`UPDATE collections SET status='valid', last_checked_at=NOW() WHERE id=?`, [r.id]);
        } else if (httpStatus === 404 || httpStatus === 410) {
          checked++; newInvalid++;
          await pool.query(`UPDATE collections SET status='invalid', invalid_reason='VRChat 未返回', last_checked_at=NOW(), invalid_at=NOW() WHERE id=?`, [r.id]);
        }
      } catch (e) { /* skip */ }
    }
    ok(res, { checked, newInvalid });
  } catch (e) { handleError(res, e, 'collections.scan'); }
});

// ============ 后台管理子路由（兼容原模型收藏馆后台，映射到 kind=avatar_model） ============
router.get('/admin/stats', requireAdminCompat, async (req, res) => {
  try {
    const pool = getPool();
    const [total] = await pool.query(`SELECT COUNT(*) AS c FROM collections WHERE kind='avatar_model'`);
    const [valid] = await pool.query(`SELECT COUNT(*) AS c FROM collections WHERE kind='avatar_model' AND status='valid'`);
    const [invalid] = await pool.query(`SELECT COUNT(*) AS c FROM collections WHERE kind='avatar_model' AND status='invalid'`);
    const [unknown] = await pool.query(`SELECT COUNT(*) AS c FROM collections WHERE kind='avatar_model' AND status='unknown'`);
    const [userC] = await pool.query(`SELECT COUNT(DISTINCT user_id) AS c FROM collections WHERE kind='avatar_model'`);
    ok(res, { summary: { total: total[0].c, valid: valid[0].c, invalid: invalid[0].c, unknown: unknown[0].c }, userCount: userC[0].c });
  } catch (e) { handleError(res, e, 'collections.admin.stats'); }
});

router.get('/admin/invalid', requireAdminCompat, async (req, res) => {
  try {
    const pool = getPool();
    const { page, pageSize, offset } = paginate(req, { defaultSize: 30, maxSize: 100 });
    const [count] = await pool.query(`SELECT COUNT(*) AS c FROM collections WHERE kind='avatar_model' AND status='invalid'`);
    const total = count[0].c;
    const [rows] = await pool.query(
      `SELECT c.*, u.display_name AS owner_name FROM collections c LEFT JOIN users u ON u.id=c.user_id
       WHERE c.kind='avatar_model' AND c.status='invalid' ORDER BY c.invalid_at DESC LIMIT ? OFFSET ?`,
      [pageSize, offset]
    );
    const items = rows.map(r => ({
      id: r.id, modelId: r.target_id, modelName: r.name, ownerName: r.author,
      ownerVrcName: r.author_id, thumbnailUrl: r.thumbnail ? proxyThumb(r.thumbnail) : '',
      status: r.status, invalidReason: r.invalid_reason, notes: r.notes, isRecommended: r.is_recommended
    }));
    ok(res, { items, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
  } catch (e) { handleError(res, e, 'collections.admin.invalid'); }
});

router.get('/admin/user/:userId', requireAdminCompat, async (req, res) => {
  try {
    const pool = getPool();
    const userId = Number(req.params.userId);
    const [rows] = await pool.query(`SELECT * FROM collections WHERE kind='avatar_model' AND user_id=? ORDER BY created_at DESC`, [userId]);
    const collections = rows.map(r => ({
      id: r.id, modelId: r.target_id, modelName: r.name, ownerName: r.author,
      ownerVrcName: r.author_id, thumbnailUrl: r.thumbnail ? proxyThumb(r.thumbnail) : '',
      status: r.status, invalidReason: r.invalid_reason, notes: r.notes, isRecommended: r.is_recommended
    }));
    const [sv] = await pool.query(`SELECT COUNT(*) AS c FROM collections WHERE kind='avatar_model' AND user_id=? AND status='valid'`, [userId]);
    const [si] = await pool.query(`SELECT COUNT(*) AS c FROM collections WHERE kind='avatar_model' AND user_id=? AND status='invalid'`, [userId]);
    const [su] = await pool.query(`SELECT COUNT(*) AS c FROM collections WHERE kind='avatar_model' AND user_id=? AND status='unknown'`, [userId]);
    const [u] = await pool.query(`SELECT id, display_name, login_id FROM users WHERE id=?`, [userId]);
    ok(res, { user: u[0] || { id: userId },
      summary: { total: rows.length, valid: sv[0].c, invalid: si[0].c, unknown: su[0].c },
      collections
    });
  } catch (e) { handleError(res, e, 'collections.admin.user'); }
});

router.delete('/admin/user/:userId', requireAdminCompat, async (req, res) => {
  try {
    const pool = getPool();
    const userId = Number(req.params.userId);
    const [r] = await pool.query(`DELETE FROM collections WHERE kind='avatar_model' AND user_id=?`, [userId]);
    ok(res, { deleted: r.affectedRows });
  } catch (e) { handleError(res, e, 'collections.admin.user.delete'); }
});

router.delete('/admin/:id', requireAdminCompat, async (req, res) => {
  try {
    const pool = getPool();
    const id = Number(req.params.id);
    const [cur] = await pool.query(`SELECT * FROM collections WHERE id=?`, [id]);
    if (!cur.length) return res.status(404).json({ success: false, error: { code: ErrorCodes.NOT_FOUND, message: '不存在' } });
    await pool.query(`DELETE FROM collections WHERE id=?`, [id]);
    await refreshAggregates(pool, cur[0].target_id, cur[0].kind);
    ok(res);
  } catch (e) { handleError(res, e, 'collections.admin.delete'); }
});

router.post('/admin/user/:userId/scan', requireAdminCompat, async (req, res) => {
  try {
    const pool = getPool();
    const userId = Number(req.params.userId);
    const [rows] = await pool.query(`SELECT id, target_id FROM collections WHERE kind='avatar_model' AND user_id=? AND status<>'invalid'`, [userId]);
    let scanned = 0, newlyInvalid = 0;
    for (const r of rows) {
      try {
        const resp = await vrchatGetAvatar(r.target_id, null);
        scanned++;
        const httpStatus = resp && resp.status;
        const avatar = (httpStatus >= 200 && httpStatus < 300) ? resp.data : null;
        if (avatar && avatar.id) await pool.query(`UPDATE collections SET status='valid' WHERE id=?`, [r.id]);
        else if (httpStatus === 404 || httpStatus === 410) { newlyInvalid++; await pool.query(`UPDATE collections SET status='invalid', invalid_reason='VRChat 模型不存在', invalid_at=NOW() WHERE id=?`, [r.id]); }
        // 其余状态（401/403/5xx 等）跳过判定，防止误标失效
      } catch (e) { /* skip */ }
    }
    ok(res, { scanned, newlyInvalid });
  } catch (e) { handleError(res, e, 'collections.admin.scan'); }
});

router.post('/admin/scan', requireAdminCompat, async (req, res) => {
  try {
    const pool = getPool();
    const batchSize = Math.min(500, Math.max(1, parseInt(req.body && req.body.batchSize) || 200));
    const [rows] = await pool.query(`SELECT id, target_id FROM collections WHERE kind='avatar_model' AND status<>'invalid' LIMIT ?`, [batchSize]);
    let scanned = 0, newlyInvalid = 0;
    for (const r of rows) {
      try {
        const resp = await vrchatGetAvatar(r.target_id, null);
        scanned++;
        const httpStatus = resp && resp.status;
        const avatar = (httpStatus >= 200 && httpStatus < 300) ? resp.data : null;
        if (avatar && avatar.id) await pool.query(`UPDATE collections SET status='valid' WHERE id=?`, [r.id]);
        else if (httpStatus === 404 || httpStatus === 410) { newlyInvalid++; await pool.query(`UPDATE collections SET status='invalid', invalid_reason='VRChat 模型不存在', invalid_at=NOW() WHERE id=?`, [r.id]); }
        // 其余状态（401/403/5xx 等）跳过判定，防止误标失效
      } catch (e) { /* skip */ }
    }
    ok(res, { scanned, newlyInvalid });
  } catch (e) { handleError(res, e, 'collections.admin.scanAll'); }
});

// ============ 共享失效检测（供定时任务与后台手动扫描复用，保留 model_invalid 通知） ============
// 扫描 collections(kind=avatar_model)，更新状态并对新失效的收藏推送通知。
// 旧 model-collection-service 已删除，统一收敛到此处，消除「双实现 + 扫描旧表」问题。
async function scanAvatarModels(pool, opt = {}) {
  const { getVRCCookieFn, notificationService, batchSize = 200,
          onlyUnchecked = false, specificUserId = null, vrcCookie = null } = opt;
  const where = [`kind='avatar_model'`, `status<>'invalid'`];
  const params = [];
  if (onlyUnchecked) where.push(`(last_checked_at IS NULL OR last_checked_at < DATE_SUB(NOW(), INTERVAL 7 DAY))`);
  if (specificUserId) { where.push('user_id = ?'); params.push(specificUserId); }
  const [rows] = await pool.query(
    `SELECT id, user_id, target_id, status FROM collections
     WHERE ${where.join(' AND ')} ORDER BY last_checked_at ASC LIMIT ?`,
    [...params, batchSize]
  );
  if (rows.length === 0) return { scanned: 0, newlyInvalid: 0 };
  const cookie = vrcCookie || (typeof getVRCCookieFn === 'function' ? getVRCCookieFn({ session: {} }) : null);
  let scanned = 0, newlyInvalid = 0;
  for (const r of rows) {
    scanned++;
    let newStatus = 'unknown', reason = '';
    try {
      const resp = await vrchatGetAvatar(r.target_id, cookie);
      const httpStatus = resp && resp.status;
      const avatar = (httpStatus >= 200 && httpStatus < 300) ? resp.data : null;
      if (avatar && avatar.id) newStatus = 'valid';
      else if (httpStatus === 404 || httpStatus === 410) { newStatus = 'invalid'; reason = 'VRChat 模型不存在'; }
      else if (httpStatus === 401 || httpStatus === 403) { newStatus = 'unknown'; reason = 'VRChat 鉴权失败，跳过判定'; }
      else { newStatus = 'unknown'; reason = httpStatus ? `VRChat 返回 ${httpStatus}` : 'VRChat 无响应'; }
    } catch (e) { newStatus = 'unknown'; reason = e.message || '检测异常'; }
    const wasInvalid = r.status === 'invalid';
    const invalidAtSql = newStatus === 'invalid' ? ', invalid_at=NOW()' : ', invalid_at=NULL';
    await pool.query(
      `UPDATE collections SET status=?, invalid_reason=?, last_checked_at=NOW()${invalidAtSql} WHERE id=?`,
      [newStatus, reason, r.id]
    );
    if (newStatus === 'invalid' && !wasInvalid) {
      newlyInvalid++;
      if (notificationService && typeof notificationService.notifyUser === 'function') {
        notificationService.notifyUser(
          r.user_id, 'model_invalid', '⚠️ 收藏的模型已失效',
          `您收藏的模型 ${r.target_id} 已无法访问（${reason}），建议删除后重新收藏。`,
          { targetType: 'model_collection', targetId: String(r.id) }
        );
      }
    }
    await new Promise(r => setTimeout(r, 200));
  }
  return { scanned, newlyInvalid };
}

module.exports = function (getVRCCookie) {
  // 统一注入获取 VRChat cookie 的方法
  const vrcCookieOf = getVRCCookie || (() => null);
  // 把 req.vrcCookie 的引用就地换成 vrcCookieOf(req)
  router.use((req, res, next) => { req.vrcCookie = vrcCookieOf(req); next(); });
  return router;
};
module.exports.scanAvatarModels = scanAvatarModels;
