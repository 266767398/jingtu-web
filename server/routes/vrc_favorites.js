// F-20 VRChat 官方收藏管理（/api/vrc-favorites）
// 与站内收藏系统（/api/collections, V8.2）并存：本路由直接操作 VRChat
// 账号内的官方收藏（游戏内同样可见），数据归属 VRChat 官方。
// Cookie 策略：读操作可用系统账号兜底（getVRCCookie）；写操作严格限定
// 用户自己绑定的 cookie（getVRCCookieUserOnly），防止未绑定用户借系统
// 账号改写官方收藏。上游错误统一走 sendVrcError 透传真实原因。
const express = require('express');
const { ok, fail, sendVrcError, handleError, ErrorCodes } = require('../utils');
const { requireAuth } = require('../auth');
const {
  vrchatGetFavorites, vrchatAddFavorite, vrchatRemoveFavorite,
  vrchatGetFavoriteGroups, vrchatUpdateFavoriteGroup, vrchatClearFavoriteGroup,
  vrchatGetAvatar, vrchatGetUser,
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

async function fetchFavoriteMeta(type, targetId, cookie) {
  try {
    if (type === 'world' && /^wrld_/.test(targetId)) {
      const w = await getCachedWorld(targetId, cookie);
      if (w && w.id && w.name) {
        const meta = {
          name: w.name,
          thumbnailImageUrl: w.thumbnailImageUrl || w.imageUrl || (w.thumbnail && w.thumbnail.url) || '',
          authorName: w.authorName || ''
        };
        favMetaSet(targetId, meta);
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
          authorName: a.authorName || ''
        };
        favMetaSet(targetId, meta);
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
          thumbnailImageUrl: u.profilePicOverrideThumbnail || u.currentAvatarThumbnailImageUrl || '',
          authorName: ''
        };
        favMetaSet(targetId, meta);
        return meta;
      }
      return null;
    }
  } catch (e) { /* 富化失败不影响收藏列表主流程 */ }
  return null;
}

async function enrichFavoriteItems(items, cookie) {
  const CONCURRENCY = 5;
  let budget = 25; // 单页冷回源上限，防止收藏极多时列表拖垮响应
  const pending = [];
  for (const it of items) {
    const targetId = it && it.favoriteId;
    if (!targetId) continue;
    const cached = favMetaGet(targetId);
    if (cached) {
      it.name = cached.name;
      it.thumbnailImageUrl = cached.thumbnailImageUrl;
      it.authorName = cached.authorName;
      continue;
    }
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
        it.authorName = meta.authorName;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, () => worker()));
  return items;
}

module.exports = function (getVRCCookie, getVRCCookieUserOnly) {
  const router = express.Router();

  // Cookie 解析中间件：读操作用户优先/系统兜底；写操作仅用户自己的绑定
  router.use((req, res, next) => {
    req.vrcCookieRead = getVRCCookie(req);
    req.vrcCookieWrite = getVRCCookieUserOnly(req);
    next();
  });

  // ============ 分组（Favorite Groups） ============

  // 列出官方收藏分组（全类型混合返回，前端按 type 归类）
  router.get('/groups', requireAuth, async (req, res) => {
    if (!req.vrcCookieRead) return fail(res, 400, '暂无可用的 VRChat 登录态，请先绑定或配置 VRChat 账号', { code: ErrorCodes.NEED_BIND });
    try {
      const n = clampInt(req.query.n, 50, 1, MAX_PAGE);
      const offset = clampInt(req.query.offset, 0, 0, 10000);
      const upstream = await vrchatGetFavoriteGroups(req.vrcCookieRead, n, offset);
      if (upstream.status < 200 || upstream.status >= 300) return sendVrcError(res, upstream, '获取收藏分组');
      const groups = Array.isArray(upstream.data) ? upstream.data : [];
      ok(res, { groups });
    } catch (e) { handleError(res, e, 'vrcfav.groups'); }
  });

  // 重命名分组（ownerUserId 来自分组列表，防越权由 VRChat 上游校验归属）
  router.put('/groups/:type/:name', requireAuth, async (req, res) => {
    if (!req.vrcCookieWrite) return fail(res, 400, '请先在个人中心绑定你的 VRChat 账号后再操作官方收藏', { code: ErrorCodes.NEED_BIND });
    const { type, name } = req.params;
    if (!isValidType(type)) return fail(res, 400, '不支持的收藏类型', { code: ErrorCodes.INVALID_TARGET_TYPE });
    const displayName = (req.body?.displayName || '').trim();
    const ownerUserId = (req.body?.ownerUserId || '').trim();
    if (!displayName) return fail(res, 400, '分组显示名不能为空', { code: ErrorCodes.VALIDATION_ERROR });
    if (!ownerUserId) return fail(res, 400, '缺少分组归属用户 ID', { code: ErrorCodes.VALIDATION_ERROR });
    try {
      const upstream = await vrchatUpdateFavoriteGroup(req.vrcCookieWrite, type, name, ownerUserId, displayName);
      if (upstream.status < 200 || upstream.status >= 300) return sendVrcError(res, upstream, '重命名收藏分组');
      ok(res, { group: upstream.data });
    } catch (e) { handleError(res, e, 'vrcfav.group.rename'); }
  });

  // 清空分组（删除分组内全部条目，分组本身保留）
  router.delete('/groups/:type/:name', requireAuth, async (req, res) => {
    if (!req.vrcCookieWrite) return fail(res, 400, '请先在个人中心绑定你的 VRChat 账号后再操作官方收藏', { code: ErrorCodes.NEED_BIND });
    const { type, name } = req.params;
    if (!isValidType(type)) return fail(res, 400, '不支持的收藏类型', { code: ErrorCodes.INVALID_TARGET_TYPE });
    const ownerUserId = (req.query.ownerUserId || '').trim();
    if (!ownerUserId) return fail(res, 400, '缺少分组归属用户 ID', { code: ErrorCodes.VALIDATION_ERROR });
    try {
      const upstream = await vrchatClearFavoriteGroup(req.vrcCookieWrite, type, name, ownerUserId);
      if (upstream.status < 200 || upstream.status >= 300) return sendVrcError(res, upstream, '清空收藏分组');
      ok(res);
    } catch (e) { handleError(res, e, 'vrcfav.group.clear'); }
  });

  // ============ 收藏条目（Favorites） ============

  // 列出收藏条目（type 可选过滤；tag 为分组名过滤）
  router.get('/items', requireAuth, async (req, res) => {
    if (!req.vrcCookieRead) return fail(res, 400, '暂无可用的 VRChat 登录态，请先绑定或配置 VRChat 账号', { code: ErrorCodes.NEED_BIND });
    try {
      const type = (req.query.type || '').trim();
      if (type && !isValidType(type)) return fail(res, 400, '不支持的收藏类型', { code: ErrorCodes.INVALID_TARGET_TYPE });
      const n = clampInt(req.query.n, 50, 1, MAX_PAGE);
      const offset = clampInt(req.query.offset, 0, 0, 10000);
      const tag = (req.query.tag || '').trim() || null;
      const upstream = await vrchatGetFavorites(req.vrcCookieRead, n, offset, tag);
      if (upstream.status < 200 || upstream.status >= 300) return sendVrcError(res, upstream, '获取收藏列表');
      let items = Array.isArray(upstream.data) ? upstream.data : [];
      // VRChat 官方未提供按 type 的服务端过滤（tag 过滤已等价于按分组过滤），
      // 前端选择"全部分组"时在这里按 type 兜底过滤一次
      if (type && !tag) items = items.filter(it => it?.type === type);
      // 前端渲染卡片标题与图片需要名字/缩略图，尽力回源富化（带缓存与并发上限）
      items = await enrichFavoriteItems(items, req.vrcCookieRead);
      ok(res, { items });
    } catch (e) { handleError(res, e, 'vrcfav.items'); }
  });

  // 添加收藏（tag 传分组名，不存在时 VRChat 自动建组）
  router.post('/items', requireAuth, async (req, res) => {
    if (!req.vrcCookieWrite) return fail(res, 400, '请先在个人中心绑定你的 VRChat 账号后再操作官方收藏', { code: ErrorCodes.NEED_BIND });
    const type = (req.body?.type || '').trim();
    const favoriteId = (req.body?.favoriteId || '').trim();
    const tag = (req.body?.tag || '').trim();
    if (!isValidType(type)) return fail(res, 400, '不支持的收藏类型', { code: ErrorCodes.INVALID_TARGET_TYPE });
    if (!favoriteId) return fail(res, 400, '收藏目标 ID 不能为空', { code: ErrorCodes.VALIDATION_ERROR });
    if (!tag) return fail(res, 400, '请选择要加入的收藏分组', { code: ErrorCodes.VALIDATION_ERROR });
    try {
      const upstream = await vrchatAddFavorite(req.vrcCookieWrite, type, favoriteId, [tag]);
      if (upstream.status < 200 || upstream.status >= 300) return sendVrcError(res, upstream, '添加收藏');
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
    if (!req.vrcCookieWrite) return fail(res, 400, '请先在个人中心绑定你的 VRChat 账号后再操作官方收藏', { code: ErrorCodes.NEED_BIND });
    try {
      const upstream = await vrchatRemoveFavorite(req.vrcCookieWrite, req.params.id);
      if (upstream.status < 200 || upstream.status >= 300) return sendVrcError(res, upstream, '移除收藏');
      ok(res);
    } catch (e) { handleError(res, e, 'vrcfav.item.remove'); }
  });

  return router;
};
