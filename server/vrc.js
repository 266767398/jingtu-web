/**
 * 境途同游 V5.2 — VRChat API 共享模块
 * 统一管理 VRChat API 常量和请求方法
 */
const VRC_API = 'https://api.vrchat.cloud/api/1';
const VRC_API_KEY = process.env.VRC_API_KEY || '';
const USER_AGENT = process.env.VRC_USER_AGENT || 'JingTuWeb/1.3.0';
const VRC_FETCH_TIMEOUT = 30000; // VRChat API 请求超时 30 秒
const TWO_FACTOR_ENDPOINTS = Object.freeze({
  totp: '/auth/twofactorauth/totp/verify',
  otp: '/auth/twofactorauth/otp/verify',
  emailOtp: '/auth/twofactorauth/emailotp/verify'
});

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// VRChat ID 白名单正则：wrld_/usr_/avtr_/grp_ 主体 ID + gapp_(群公告)/gald_(群相册)/grol_(群角色) 子资源 ID
// + 十六进制与连字符；防止传入 ../../auth/user 等路径穿越至非预期 API 端点
const VRC_ID_PATTERN = /^(wrld|usr|avtr|grp|gapp|gald|grol)_[0-9a-fA-F-]+$/;

/**
 * 校验并编码 VRChat ID，拒绝不符合格式的 ID（防止路径穿越至 /auth/user 等）
 * @param {string} id - 原始 VRChat ID
 * @returns {string} encodeURIComponent 后的 ID
 */
function sanitizeVrcId(id) {
  if (typeof id !== 'string' || !VRC_ID_PATTERN.test(id)) {
    const err = new Error(`非法 VRChat ID 格式: ${id}`);
    err.code = 'INVALID_VRC_ID';
    // 这是调用方传错了参数，属于客户端错误。不标记 statusCode 的话
    // handleError 会按默认的 500 返回，前端只会提示"服务器错误"，
    // 排查时也会被误导成后端故障。
    err.statusCode = 400;
    throw err;
  }
  return encodeURIComponent(id);
}

/**
 * 带超时的 fetch 包装
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = VRC_FETCH_TIMEOUT) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timeoutId);
  }
}

function getSetCookieHeaders(headers) {
  if (typeof headers?.getSetCookie === 'function') return headers.getSetCookie();
  const combined = headers?.get?.('set-cookie');
  return combined ? combined.split(/,(?=\s*[^;,=\s]+=[^;,]+)/).map(value => value.trim()) : [];
}

function cookieHeaderToMap(cookieHeader) {
  const cookies = new Map();
  if (!cookieHeader) return cookies;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    cookies.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  return cookies;
}

function mergeCookieHeaders(cookieHeader, setCookieHeaders = []) {
  const cookies = cookieHeaderToMap(cookieHeader);
  for (const setCookie of setCookieHeaders) {
    const pair = setCookie.split(';', 1)[0];
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!value || /(?:^|;)\s*max-age=0(?:;|$)/i.test(setCookie)) cookies.delete(name);
    else cookies.set(name, value);
  }
  return Array.from(cookies, ([name, value]) => `${name}=${value}`).join('; ');
}

async function readJsonResponse(res) {
  try {
    const buffer = await res.arrayBuffer();
    const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/**
 * V8.4: VRChat API 全局令牌桶限流
 * VRChat 认证 API 限流约 50 req/min（官方）。此前 vrchatRequest 无任何限速，
 * 30s 定时刷新 + 手动刷新 + 多用户并发 + 探活叠加时，易瞬时超 50/min 触发 429。
 * 这里统一在 vrchatRequest 入口串行+限速，所有 VRChat 调用都经此闸门，
 * 保证全站对 VRChat 的请求 ≤40/min（留 20% 余量），从根上避免 429。
 */
const VRC_RATE_LIMIT = 40;                 // 目标上限（< 50/min，留余量）
const VRC_RATE_WINDOW_MS = 60 * 1000;      //  refill 时间窗
let vrcTokens = VRC_RATE_LIMIT;
let vrcLastTs = Date.now();
const vrcQueue = [];
let vrcDripTimer = null;

function vrcRefill() {
  const now = Date.now();
  const elapsed = now - vrcLastTs;
  if (elapsed > 0) {
    vrcTokens = Math.min(VRC_RATE_LIMIT, vrcTokens + (elapsed / VRC_RATE_WINDOW_MS) * VRC_RATE_LIMIT);
    vrcLastTs = now;
  }
}

// 令牌补充循环：周期性把令牌放回并唤醒排队者
function vrcDrip() {
  vrcRefill();
  while (vrcQueue.length && vrcTokens >= 1) {
    vrcTokens -= 1;
    vrcQueue.shift()();
  }
  vrcDripTimer = vrcQueue.length ? setTimeout(vrcDrip, 200) : null;
}

// 获取一个令牌（必要时排队等待，最长 12s 后放弃以免请求永久挂起）。
// 排队超时从 25s 降到 12s：VRChat 限流时令牌桶耗尽，若单个请求等满 25s，
// /group/worlds、/group/members/refresh 等接口会被成批排队请求拖到几十秒才 500。
// 缩短到 12s 让限流时快速失败，配合各接口的降级逻辑（世界人数用 DB 估算、刷新用共享状态兜底）。
function vrcAcquire() {
  vrcRefill();
  if (vrcTokens >= 1) { vrcTokens -= 1; return Promise.resolve(); }
  return new Promise((resolve, reject) => {
    let settled = false;
    // 持有排队项引用：超时清理需按引用移除（vrcQueue 存的是 wrapper 而非 resolve，
    // 用 indexOf(resolve) 永远找不到，超时项会残留队列，之后 vrcDrip 出队时白耗 1 个令牌）。
    let queueEntry = null;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const idx = vrcQueue.indexOf(queueEntry);
      if (idx >= 0) vrcQueue.splice(idx, 1);
      reject(Object.assign(new Error('VRChat 限流排队超时'), { code: 'VRC_RATE_TIMEOUT' }));
    }, 12000);
    queueEntry = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    vrcQueue.push(queueEntry);
    if (!vrcDripTimer) vrcDripTimer = setTimeout(vrcDrip, 200);
  });
}

// 429 惩罚：罚没一批令牌制造短暂冷却，避免立即重试再次被打
function vrcPenalize() {
  vrcRefill();
  vrcTokens = Math.max(0, vrcTokens - 12); // 约 18s 冷却
  vrcLastTs = Date.now();
}

/**
 * 通用的 VRChat API 请求函数（带 Cookie）。
 * 经全局令牌桶限速；遇 429 触发退避重试（最多 3 次），透明降级，
 * 不让瞬时限流直接暴露为失败（从而避免上游误判/误标离线）。
 */
async function vrchatRequest(method, endpoint, body = null, cookie = null, _retry = 0) {
  await vrcAcquire();
  const url = `${VRC_API}${endpoint}`;
  const headers = { 'User-Agent': USER_AGENT, 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);
  let res;
  try {
    res = await fetchWithTimeout(url, options);
  } catch (e) {
    // 网络层失败（超时/重置）：若令牌桶只是排队超时则直接抛出；否则按退避重试
    if (e?.code === 'VRC_RATE_TIMEOUT') throw e;
    if (_retry < 3) { await sleep(800 * (_retry + 1)); return vrchatRequest(method, endpoint, body, cookie, _retry + 1); }
    throw e;
  }
  // 429 = 触发限流：罚没令牌退避后重试，不让其冒泡成业务错误
  if (res.status === 429) {
    vrcPenalize();
    if (_retry < 3) { await sleep(Math.min(4000, 800 * (_retry + 1))); return vrchatRequest(method, endpoint, body, cookie, _retry + 1); }
  }
  const data = await readJsonResponse(res);
  const setCookie = getSetCookieHeaders(res.headers);
  return {
    status: res.status,
    data,
    setCookie,
    cookie: mergeCookieHeaders(cookie, setCookie)
  };
}

/**
 * 按 VRCX 的顺序使用 Basic Auth 登录 VRChat。
 */
async function vrchatBasicLogin(username, password) {
  await vrchatRequest('GET', '/config');
  const encodedUsername = encodeURIComponent(username);
  const encodedPassword = encodeURIComponent(password);
  const basic = Buffer.from(`${encodedUsername}:${encodedPassword}`, 'utf8').toString('base64');
  const loginRes = await fetchWithTimeout(`${VRC_API}/auth/user`, {
    method: 'GET',
    headers: { 'User-Agent': USER_AGENT, 'Authorization': `Basic ${basic}` }
  });
  const data = await readJsonResponse(loginRes);
  const cookie = mergeCookieHeaders('', getSetCookieHeaders(loginRes.headers));
  const needs2fa = Array.isArray(data?.requiresTwoFactorAuth) && data.requiresTwoFactorAuth.length > 0;
  return { status: loginRes.status, data, cookie, needs2fa };
}

async function vrchatVerifyTwoFactor(method, code, cookie) {
  const endpoint = TWO_FACTOR_ENDPOINTS[method];
  if (!endpoint) {
    const err = new Error(`不支持的 VRChat 双重验证方式: ${method}`);
    err.code = 'INVALID_VRC_2FA_METHOD';
    err.statusCode = 400;
    throw err;
  }
  return vrchatRequest('POST', endpoint, { code }, cookie);
}

/**
 * 用 Cookie 获取 VRChat 当前用户信息（保留 HTTP 状态）
 *
 * 为什么需要它：vrchatGetCurrentUser 对任何非 2xx 都只 return null，
 * 调用方无从分辨「cookie 真的过期了（401）」还是「VRChat 限流/抽风（429/500/超时）」。
 * groups.js 的 vrcWithFallback 把 null 一律当成 401，于是 VRChat 偶发一次 429
 * 就会把用户存在 session 里的 VRChat cookie 清掉 —— 用户刷新页面后发现绑定没了。
 * @returns {Promise<{status:number, data:any}>}
 */
async function vrchatGetCurrentUserResult(cookie) {
  // 经 vrchatRequest，纳入全局令牌桶限速（探活 30s 定时 + 手动刷新高频调用）
  const r = await vrchatRequest('GET', '/auth/user', null, cookie);
  return { status: r.status, data: r.data };
}

/**
 * 用 Cookie 获取 VRChat 当前用户信息（失败返回 null，保持既有调用方语义不变）
 */
async function vrchatGetCurrentUser(cookie) {
  const { status, data } = await vrchatGetCurrentUserResult(cookie);
  return status >= 200 && status < 300 ? data : null;
}

/**
 * 验证 VRChat Cookie 是否有效（内部使用）
 */
async function vrchatVerifyCookie(cookie) {
  const user = await vrchatGetCurrentUser(cookie);
  return user !== null;
}

/**
 * V5.3: 获取群组日历事件列表
 */
async function vrchatGetGroupEvents(groupId, cookie = null, n = 100, offset = 0) {
  const safeId = sanitizeVrcId(groupId);
  const endpoint = `/calendar/${safeId}?n=${n}&offset=${offset}&apiKey=${VRC_API_KEY}`;
  return await vrchatRequest('GET', endpoint, null, cookie);
}

/**
 * V5.6: 获取 VRChat World 详情
 */
async function vrchatGetWorld(worldId, cookie = null) {
  const safeId = sanitizeVrcId(worldId);
  const endpoint = `/worlds/${safeId}?apiKey=${VRC_API_KEY}`;
  return await vrchatRequest('GET', endpoint, null, cookie);
}

// 实例 ID 格式：wrld_<uuid>:<instance>... 含 worldId + instanceId，可能带 ~private(...)~nonce(...)
const VRC_INSTANCE_PATTERN = /^wrld_[0-9a-fA-F-]+:.+$/;

/**
 * V6.15: 获取 VRChat World 实例详情（含当前人数 n_users / userCount）
 * @param {string} instanceId - 完整实例 ID，例如 wrld_xxx:12345~private(usr_xxx)~nonce(xxx)
 */
async function vrchatGetInstance(instanceId, cookie = null) {
  if (typeof instanceId !== 'string' || !VRC_INSTANCE_PATTERN.test(instanceId)) {
    const err = new Error(`非法 VRChat 实例 ID 格式: ${instanceId}`);
    err.code = 'INVALID_VRC_INSTANCE_ID';
    err.statusCode = 400;
    throw err;
  }
  const endpoint = `/instances/${encodeURIComponent(instanceId)}?apiKey=${VRC_API_KEY}`;
  return await vrchatRequest('GET', endpoint, null, cookie);
}

/**
 * V5.6: 搜索 VRChat World
 */
async function vrchatSearchWorlds(query, n = 10, cookie = null) {
  const encoded = encodeURIComponent(query);
  const endpoint = `/worlds?search=${encoded}&n=${n}&apiKey=${VRC_API_KEY}`;
  return await vrchatRequest('GET', endpoint, null, cookie);
}

/**
 * F-世界搜索/热门排行: 获取 VRChat 世界列表（VRCX 同款 GET /worlds 变体）。
 * 参考 VRCX src/api/world.js getWorlds(params)：
 *   - sort=popularity        → 热门（按热度/人数排序）
 *   - sort=order&featured=true → 精选（featured 列表）
 *   - sort=updated            → 最近更新
 *   - sort=created            → 最新创建
 *   - sort=_active            → 当前活跃（/worlds/active，按在线人数）
 * 参数白名单化，避免任意外泄到上游；n 限制在 1~100。
 * @param {object} opts - { search?, sort?, featured?, n?, offset?, tag? }
 * @param {string|null} cookie
 * @returns {Promise<{status:number, data:any}>}
 */
async function vrchatListWorlds(opts = {}, cookie = null) {
  const n = Math.min(100, Math.max(1, parseInt(opts.n) || 20));
  const offset = Math.max(0, parseInt(opts.offset) || 0);
  const params = new URLSearchParams({ apiKey: VRC_API_KEY, n: String(n), offset: String(offset) });
  const sort = opts.sort || 'popularity';
  const sortWhitelist = ['popularity', 'order', 'updated', 'created', 'heat', 'shuffle', 'random', 'releaseStatus'];
  if (sortWhitelist.includes(sort)) params.set('sort', sort);
  if (opts.search) params.set('search', String(opts.search));
  if (opts.featured === true || opts.featured === 'true') params.set('featured', 'true');
  if (opts.tag) params.set('tag', String(opts.tag));
  if (opts.releaseStatus) params.set('releaseStatus', String(opts.releaseStatus));
  let endpoint = `/worlds?${params.toString()}`;
  // active 变体：按在线人数排序的活跃世界（/worlds/active）
  if (sort === 'active') endpoint = `/worlds/active?${params.toString()}`;
  return await vrchatRequest('GET', endpoint, null, cookie);
}

/**
 * F-世界搜索/热门排行: 获取热门世界排行（VRCX "Trending" 对应 sort=popularity）。
 * 兼容旧签名 vrchatGetPopularWorlds(n, cookie)。
 */
async function vrchatGetPopularWorlds(n = 20, cookie = null) {
  const opts = (typeof n === 'object') ? n : { n, sort: 'popularity' };
  return await vrchatListWorlds({ sort: 'popularity', ...opts }, cookie);
}

/**
 * F-世界搜索/热门排行: 获取精选世界（VRCX "Featured" 对应 sort=order&featured=true）。
 */
async function vrchatGetFeaturedWorlds(n = 20, cookie = null) {
  const opts = (typeof n === 'object') ? n : { n };
  return await vrchatListWorlds({ sort: 'order', featured: true, ...opts }, cookie);
}

/**
 * V7.0: 搜索 VRChat Avatar
 */
async function vrchatSearchAvatars(query, n = 10, cookie = null) {
  const encoded = encodeURIComponent(query);
  const endpoint = `/avatars?search=${encoded}&n=${n}&marketplace=all&apiKey=${VRC_API_KEY}`;
  return await vrchatRequest('GET', endpoint, null, cookie);
}

/**
 * V8.1: 获取某 VRChat 用户**公开发布**的 Avatar 模型列表。
 *
 * 数据来源与 VRCX 完全一致：VRChat API `GET /avatars?userId=<usr_id>&releaseStatus=public`。
 * 该端点返回该用户以 author 身份上传、且 releaseStatus=public 的模型（即"玩家公开的模型"），
 * 与"收藏的模型"（需登录态 GET /avatars/favorites）不同 —— 后者是玩家自己收藏的，前者才是其创作/发布的。
 *
 * @param {string} userId - 形如 usr_xxx 的 VRChat 用户 ID
 * @param {string|null} cookie - VRChat Cookie（公开模型可空，但带 cookie 可避免匿名限流）
 * @param {number} [n=12] - 返回数量上限
 * @returns {Promise<{status:number, data:Array}>} data 为 Avatar 数组（可能为空数组）
 */
async function vrchatGetUserPublicAvatars(userId, cookie = null, n = 12) {
  const safeId = sanitizeVrcId(userId);
  const endpoint = `/avatars?userId=${safeId}&releaseStatus=public&n=${Math.min(Math.max(parseInt(n) || 12, 1), 100)}&apiKey=${VRC_API_KEY}`;
  return await vrchatRequest('GET', endpoint, null, cookie);
}


/**
 * V7.0: 获取 VRChat Avatar 详情
 */
async function vrchatGetAvatar(avatarId, cookie = null) {
  const safeId = sanitizeVrcId(avatarId);
  const endpoint = `/avatars/${safeId}?apiKey=${VRC_API_KEY}`;
  return await vrchatRequest('GET', endpoint, null, cookie);
}

/**
 * V7.0: 切换当前用户的 Avatar
 * PUT /auth/user/avatar
 */
async function vrchatSetAvatar(avatarId, cookie) {
  const safeId = sanitizeVrcId(avatarId);
  const endpoint = `/auth/user/avatar?apiKey=${VRC_API_KEY}`;
  return await vrchatRequest('PUT', endpoint, { avatarId: safeId }, cookie);
}

/**
 * V8.4: 从基座克隆公共模型到本人库存（VRCX 同款内部接口）。
 * 对应游戏内"站模型台复制"，调用成功即把陌生人的公开发布模型加入自己账号库存，
 * 之后才能用 vrchatSetAvatar 切换。
 *
 * @param {string} inventoryItemId - 克隆基座的 inventory item id（GET /avatars/{id} 返回的 unityPackages[].id）
 * @param {string} cookie - 本人 VRChat Cookie
 * @returns {Promise<boolean>} 克隆请求是否成功（已存在库存也会返回成功/202）
 */
async function vrchatCloneAvatar(inventoryItemId, cookie) {
  if (!cookie) return false;
  const safeId = sanitizeVrcId(inventoryItemId);
  const endpoint = `/inventory/cloning/pedestal?apiKey=${VRC_API_KEY}`;
  try {
    await vrchatRequest('POST', endpoint, { inventoryItemId: safeId }, cookie);
    return true;
  } catch (e) {
    // 已在库存 / 无需克隆 → 视为成功，交由后续 set-avatar 处理
    const sc = e && e.status;
    if (sc === 400 || sc === 404 || sc === 409) return true;
    throw e;
  }
}

/**
 * F-18 玩家审核（远程写操作）——对 VRChat 官方账号执行屏蔽/静音。
 * 这些是「代表当前登录用户」的写操作：调用方必须传入用户本人绑定的 Cookie，
 * 切勿回退到系统账号 Cookie（getVRCCookieUserOnly）。
 * 端点均返回 200（成功）；404 表示目标用户不存在；401 表示 Cookie 失效。
 */

/**
 * 屏蔽玩家：PUT /auth/user/{userId}/block
 * @returns {Promise<{status:number,data:any}>}
 */
async function vrchatBlockUser(userId, cookie) {
  const safeId = sanitizeVrcId(userId);
  return await vrchatRequest('PUT', `/auth/user/${safeId}/block?apiKey=${VRC_API_KEY}`, {}, cookie);
}

/**
 * 取消屏蔽玩家：DELETE /auth/user/{userId}/block
 */
async function vrchatUnblockUser(userId, cookie) {
  const safeId = sanitizeVrcId(userId);
  return await vrchatRequest('DELETE', `/auth/user/${safeId}/block?apiKey=${VRC_API_KEY}`, null, cookie);
}

/**
 * 静音玩家：POST /auth/user/{userId}/mute
 */
async function vrchatMuteUser(userId, cookie) {
  const safeId = sanitizeVrcId(userId);
  return await vrchatRequest('POST', `/auth/user/${safeId}/mute?apiKey=${VRC_API_KEY}`, {}, cookie);
}

/**
 * 取消静音玩家：DELETE /auth/user/{userId}/mute
 */
async function vrchatUnmuteUser(userId, cookie) {
  const safeId = sanitizeVrcId(userId);
  return await vrchatRequest('DELETE', `/auth/user/${safeId}/mute?apiKey=${VRC_API_KEY}`, null, cookie);
}

/**
 * V6.4: 获取群组信息
 * GET /groups/{groupId}
 */
async function vrchatGetGroup(groupId, cookie) {
  const safeId = sanitizeVrcId(groupId);
  const endpoint = `/groups/${safeId}?apiKey=${VRC_API_KEY}`;
  return await vrchatRequest('GET', endpoint, null, cookie);
}

/**
 * V6.4: 获取群组成员列表（分页）
 * GET /groups/{groupId}/members
 */
async function vrchatGetGroupMembers(groupId, cookie, n = 100, offset = 0) {
  const safeId = sanitizeVrcId(groupId);
  const endpoint = `/groups/${safeId}/members?apiKey=${VRC_API_KEY}&n=${n}&offset=${offset}`;
  return await vrchatRequest('GET', endpoint, null, cookie);
}

// ---------------------------------------------------------------------------
// F-6 组完整内容管理 + F-23 细化（公告/相册/角色/审计日志/经济/黑名单/日历关注）
// 写操作一律由调用方传入本人 VRC cookie，群管理权限由 VRChat 侧校验。
// ---------------------------------------------------------------------------

/**
 * 群公告列表
 * GET /groups/{groupId}/announcement
 */
async function vrchatGetGroupAnnouncements(groupId, cookie, n = 10, offset = 0) {
  const safeId = sanitizeVrcId(groupId);
  const endpoint = `/groups/${safeId}/announcement?apiKey=${VRC_API_KEY}&n=${n}&offset=${offset}`;
  return await vrchatRequest('GET', endpoint, null, cookie);
}

/**
 * 创建群公告
 * POST /groups/{groupId}/announcement  body: { title, text, sendNotification }
 */
async function vrchatCreateGroupAnnouncement(groupId, cookie, body) {
  const safeId = sanitizeVrcId(groupId);
  const endpoint = `/groups/${safeId}/announcement?apiKey=${VRC_API_KEY}`;
  return await vrchatRequest('POST', endpoint, body, cookie);
}

/**
 * 删除群公告
 * DELETE /groups/{groupId}/announcement/{announcementId}
 */
async function vrchatDeleteGroupAnnouncement(groupId, announcementId, cookie) {
  const safeId = sanitizeVrcId(groupId);
  const safeAnn = sanitizeVrcId(announcementId);
  const endpoint = `/groups/${safeId}/announcement/${safeAnn}?apiKey=${VRC_API_KEY}`;
  return await vrchatRequest('DELETE', endpoint, null, cookie);
}

/**
 * 群相册列表
 * GET /groups/{groupId}/gallery
 */
async function vrchatGetGroupGalleries(groupId, cookie) {
  const safeId = sanitizeVrcId(groupId);
  const endpoint = `/groups/${safeId}/gallery?apiKey=${VRC_API_KEY}`;
  return await vrchatRequest('GET', endpoint, null, cookie);
}

/**
 * 创建群相册
 * POST /groups/{groupId}/gallery  body: { name, description? }
 */
async function vrchatCreateGroupGallery(groupId, cookie, body) {
  const safeId = sanitizeVrcId(groupId);
  const endpoint = `/groups/${safeId}/gallery?apiKey=${VRC_API_KEY}`;
  return await vrchatRequest('POST', endpoint, body, cookie);
}

/**
 * 群相册详情（含照片）
 * GET /groups/{groupId}/gallery/{galleryId}
 */
async function vrchatGetGroupGallery(groupId, galleryId, cookie) {
  const safeId = sanitizeVrcId(groupId);
  const safeGallery = sanitizeVrcId(galleryId);
  const endpoint = `/groups/${safeId}/gallery/${safeGallery}?apiKey=${VRC_API_KEY}`;
  return await vrchatRequest('GET', endpoint, null, cookie);
}

/**
 * 更新群相册（改名/描述）
 * PUT /groups/{groupId}/gallery/{galleryId}
 */
async function vrchatUpdateGroupGallery(groupId, galleryId, cookie, body) {
  const safeId = sanitizeVrcId(groupId);
  const safeGallery = sanitizeVrcId(galleryId);
  const endpoint = `/groups/${safeId}/gallery/${safeGallery}?apiKey=${VRC_API_KEY}`;
  return await vrchatRequest('PUT', endpoint, body, cookie);
}

/**
 * 删除群相册
 * DELETE /groups/{groupId}/gallery/{galleryId}
 */
async function vrchatDeleteGroupGallery(groupId, galleryId, cookie) {
  const safeId = sanitizeVrcId(groupId);
  const safeGallery = sanitizeVrcId(galleryId);
  const endpoint = `/groups/${safeId}/gallery/${safeGallery}?apiKey=${VRC_API_KEY}`;
  return await vrchatRequest('DELETE', endpoint, null, cookie);
}

/**
 * 群角色列表
 * GET /groups/{groupId}/roles
 */
async function vrchatGetGroupRoles(groupId, cookie) {
  const safeId = sanitizeVrcId(groupId);
  const endpoint = `/groups/${safeId}/roles?apiKey=${VRC_API_KEY}`;
  return await vrchatRequest('GET', endpoint, null, cookie);
}

/**
 * 创建群角色
 * POST /groups/{groupId}/roles  body: { name, description?, isSelfAssignable? }
 */
async function vrchatCreateGroupRole(groupId, cookie, body) {
  const safeId = sanitizeVrcId(groupId);
  const endpoint = `/groups/${safeId}/roles?apiKey=${VRC_API_KEY}`;
  return await vrchatRequest('POST', endpoint, body, cookie);
}

/**
 * 更新群角色
 * PUT /groups/{groupId}/roles/{groupIdRole}
 */
async function vrchatUpdateGroupRole(groupId, roleId, cookie, body) {
  const safeId = sanitizeVrcId(groupId);
  const safeRole = sanitizeVrcId(roleId);
  const endpoint = `/groups/${safeId}/roles/${safeRole}?apiKey=${VRC_API_KEY}`;
  return await vrchatRequest('PUT', endpoint, body, cookie);
}

/**
 * 删除群角色
 * DELETE /groups/{groupId}/roles/{groupIdRole}
 */
async function vrchatDeleteGroupRole(groupId, roleId, cookie) {
  const safeId = sanitizeVrcId(groupId);
  const safeRole = sanitizeVrcId(roleId);
  const endpoint = `/groups/${safeId}/roles/${safeRole}?apiKey=${VRC_API_KEY}`;
  return await vrchatRequest('DELETE', endpoint, null, cookie);
}

/**
 * 给群成员添加角色
 * PUT /groups/{groupId}/members/{userId}/roles/{groupIdRole}
 */
async function vrchatAddGroupMemberRole(groupId, userId, roleId, cookie) {
  const safeId = sanitizeVrcId(groupId);
  const safeUser = sanitizeVrcId(userId);
  const safeRole = sanitizeVrcId(roleId);
  const endpoint = `/groups/${safeId}/members/${safeUser}/roles/${safeRole}?apiKey=${VRC_API_KEY}`;
  return await vrchatRequest('PUT', endpoint, null, cookie);
}

/**
 * 移除群成员角色
 * DELETE /groups/{groupId}/members/{userId}/roles/{groupIdRole}
 */
async function vrchatRemoveGroupMemberRole(groupId, userId, roleId, cookie) {
  const safeId = sanitizeVrcId(groupId);
  const safeUser = sanitizeVrcId(userId);
  const safeRole = sanitizeVrcId(roleId);
  const endpoint = `/groups/${safeId}/members/${safeUser}/roles/${safeRole}?apiKey=${VRC_API_KEY}`;
  return await vrchatRequest('DELETE', endpoint, null, cookie);
}

/**
 * 群审计日志
 * GET /groups/{groupId}/auditLogs
 */
async function vrchatGetGroupAuditLogs(groupId, cookie, n = 50, offset = 0) {
  const safeId = sanitizeVrcId(groupId);
  const endpoint = `/groups/${safeId}/auditLogs?apiKey=${VRC_API_KEY}&n=${n}&offset=${offset}`;
  return await vrchatRequest('GET', endpoint, null, cookie);
}

/**
 * 群经济信息
 * GET /groups/{groupId}/economy
 */
async function vrchatGetGroupEconomy(groupId, cookie) {
  const safeId = sanitizeVrcId(groupId);
  const endpoint = `/groups/${safeId}/economy?apiKey=${VRC_API_KEY}`;
  return await vrchatRequest('GET', endpoint, null, cookie);
}

/**
 * 群黑名单列表
 * GET /groups/{groupId}/bans
 */
async function vrchatGetGroupBans(groupId, cookie, n = 50, offset = 0) {
  const safeId = sanitizeVrcId(groupId);
  const endpoint = `/groups/${safeId}/bans?apiKey=${VRC_API_KEY}&n=${n}&offset=${offset}`;
  return await vrchatRequest('GET', endpoint, null, cookie);
}

/**
 * 加入群黑名单（封禁成员）
 * POST /groups/{groupId}/bans  body: { userId }
 */
async function vrchatBanGroupMember(groupId, cookie, userId) {
  const safeId = sanitizeVrcId(groupId);
  const endpoint = `/groups/${safeId}/bans?apiKey=${VRC_API_KEY}`;
  return await vrchatRequest('POST', endpoint, { userId }, cookie);
}

/**
 * 移出群黑名单（解封）
 * DELETE /groups/{groupId}/bans/{userId}
 */
async function vrchatUnbanGroupMember(groupId, userId, cookie) {
  const safeId = sanitizeVrcId(groupId);
  const safeUser = sanitizeVrcId(userId);
  const endpoint = `/groups/${safeId}/bans/${safeUser}?apiKey=${VRC_API_KEY}`;
  return await vrchatRequest('DELETE', endpoint, null, cookie);
}

/**
 * 关注群日历
 * POST /calendar/{groupId}/follow
 */
async function vrchatFollowGroupCalendar(groupId, cookie) {
  const safeId = sanitizeVrcId(groupId);
  const endpoint = `/calendar/${safeId}/follow?apiKey=${VRC_API_KEY}`;
  return await vrchatRequest('POST', endpoint, null, cookie);
}

/**
 * 取消关注群日历
 * DELETE /calendar/{groupId}/follow
 */
async function vrchatUnfollowGroupCalendar(groupId, cookie) {
  const safeId = sanitizeVrcId(groupId);
  const endpoint = `/calendar/${safeId}/follow?apiKey=${VRC_API_KEY}`;
  return await vrchatRequest('DELETE', endpoint, null, cookie);
}

/**
 * V6.5: 获取 VRChat 用户详情（含在线状态和位置）
 * GET /users/{userId}
 */
async function vrchatGetUser(userId, cookie) {
  const safeId = sanitizeVrcId(userId);
  const endpoint = `/users/${safeId}?apiKey=${VRC_API_KEY}`;
  return await vrchatRequest('GET', endpoint, null, cookie);
}

/**
 * V6.97: 获取 VRChat 好友列表
 * GET /auth/user/friends
 *
 * 参数说明（VRChat 官方 OpenAPI）：
 * - offline=false：仅返回 online / active 的好友
 * - offline=true：仅返回 offline 的好友
 * - n：每页数量，1~100，默认 60
 * - offset：分页偏移
 */
async function vrchatGetFriends(cookie, options = {}) {
  // 兼容旧签名 vrchatGetFriends(cookie, n, offset)
  if (typeof options === 'number') {
    options = { n: options, offset: arguments[2] || 0 };
  }
  const { n = 100, offset = 0, offline } = options;
  const params = new URLSearchParams({ apiKey: VRC_API_KEY, n: String(n), offset: String(offset) });
  if (offline !== undefined) params.set('offline', String(offline));
  const endpoint = `/auth/user/friends?${params.toString()}`;
  return await vrchatRequest('GET', endpoint, null, cookie);
}

/**
 * 获取全部好友（online/active + offline），自动分页。
 * 这是 VRCX 等客户端用来追踪好友在线状态的核心数据源：
 * 一次获取即可拿到所有好友的 status / location / last_login，而无需对每个用户调 /users/{id}。
 */
async function vrchatGetAllFriends(cookie, options = {}) {
  const { n = 100, maxPages = 20, delayMs = 0 } = options;
  const all = [];
  for (const offline of [false, true]) {
    for (let page = 0; page < maxPages; page++) {
      const res = await vrchatGetFriends(cookie, { n, offset: page * n, offline });
      const pageArr = Array.isArray(res) ? res : (res?.data || []);
      if (!Array.isArray(pageArr)) break;
      all.push(...pageArr);
      if (pageArr.length < n) break;
      if (delayMs) await sleep(delayMs);
    }
  }
  return all;
}

/**
 * 将好友列表转换为 userId -> 在线状态信息的 Map。
 * 返回对象字段与 schedule.js 中 group_roster 表使用的字段对齐。
 */
async function vrchatGetFriendsOnlineMap(cookie, options = {}) {
  const friends = await vrchatGetAllFriends(cookie, options);
  const map = new Map();
  for (const f of friends) {
    const id = f.id;
    if (!id) continue;
    const status = String(f.status || 'offline');
    const statusLower = status.toLowerCase();
    // VRChat UserStatus：online / offline / join me / ask me / busy 等；"offline" 视为离线，其余都算在线/活跃
    const isOnline = statusLower !== 'offline';
    const location = f.location || '';
    // 网页端在线 vs 游戏内在线：location==='web' 表示仅通过 vrchat.com 登录、未进任何世界。
    // 此时账号在线但不在客户端游戏内。见 parseVrcUserStatus 说明。
    const isInGame = isOnline && !!location && location !== 'web';
    map.set(id, {
      vrchatId: id,
      displayName: f.displayName || '',
      // 头像：优先当前模型缩略图；自定义头像大图作为第二选择（用户自己上传的头像）。
      // 注意：不要把 userIcon 作为头像兜底，它是自定义小图标/徽章，不是头像。
      avatarUrl: f.currentAvatarThumbnailImageUrl || f.profilePicOverrideThumbnail || '',
      // F-16: VRChat API 的 currentAvatar 字段即当前使用的头像 ID（avtr_xxx），头像历史的键
      currentAvatar: f.currentAvatar || '',
      profilePicOverrideThumbnail: f.profilePicOverrideThumbnail || '',
      userIcon: f.userIcon || '',
      status,
      statusDescription: f.statusDescription || '',
      location,
      worldId: f.worldId || '',
      last_login: f.last_login || f.lastLogin || null,
      isOnline,
      isInGame,
      isVrcPlus: Array.isArray(f.tags) && f.tags.includes('system_supporter'),
      ageVerificationStatus: f.ageVerificationStatus || '',
      ageVerified: f.ageVerified === true,
      trustLevel: f.trustLevel || '',
      statusDescription: f.statusDescription || '',
      tags: Array.isArray(f.tags) ? f.tags : [],
      source: 'friends',
    });
  }
  return map;
}

/**
 * 批量解析一组 VRChat userId 的在线状态。
 * 策略（参考 VRCX）：
 * 1. 先用 /auth/user/friends 批量拿到所有好友的准确状态（好友无论是否在线都可见）。
 * 2. 不在好友列表里的 userId，回退到 GET /users/{userId} 获取公开资料；
 *    非好友的公开资料通常 status/state 为 offline，location 不可见——这是 VRChat 隐私限制，无法绕过。
 *
 * @param {string} cookie - VRChat auth cookie
 * @param {string[]} userIds - 要查询的 VRChat userId 数组
 * @param {object} options
 * @param {number} options.concurrency - 非好友回退查询并发数，默认 5
 * @param {number} options.fallbackDelayMs - 非好友查询间隔，默认 0
 * @param {number} options.maxFallback - 每轮非好友回退查询上限，默认 25（超出部分不再查 /users/{id}）
 * @returns {Promise<Map<string, object>>} - userId -> 状态信息
 */
async function vrchatResolveOnlineStatuses(cookie, userIds, options = {}) {
  const { concurrency = 5, fallbackDelayMs = 0, maxFallback = 25, ...friendOptions } = options;
  const friendMap = await vrchatGetFriendsOnlineMap(cookie, friendOptions);
  const result = new Map();

  // 第一遍：好友状态（最准确）
  for (const id of userIds) {
    if (friendMap.has(id)) {
      result.set(id, { ...friendMap.get(id), isFriend: true });
    }
  }

  // 第二遍：非好友回退到 /users/{id}。
  // VRChat 对非好友公开资料有隐私墙（状态多为 offline、location 不可见），逐个 /users/{id}
  // 性价比低、又极耗 API 额度——这是限流排队超时的主因之一。这里限制每轮回退数量，
  // 超出部分不再查询，交给「群友共享状态」或 DB 旧值兜底，避免打爆 VRChat 限流。
  let nonFriends = userIds.filter(id => !result.has(id));
  if (nonFriends.length === 0) return result;
  if (nonFriends.length > maxFallback) nonFriends = nonFriends.slice(0, maxFallback);

  const queue = nonFriends.slice();
  async function worker() {
    while (queue.length) {
      const id = queue.shift();
      try {
        const userRes = await vrchatGetUser(id, cookie);
        const userData = userRes?.data || {};
        if (userRes?.status === 200 && (userData.id || userData.displayName)) {
          const state = String(userData.state || '').toLowerCase();
          const status = String(userData.status || 'offline');
          const statusLower = status.toLowerCase();
          const isOnline = ['online', 'active'].includes(state) ||
            ['online', 'active', 'join me', 'ask me'].includes(statusLower);
          const location = userData.location || '';
          // 网页端在线 vs 游戏内在线（见 parseVrcUserStatus 说明）
          const isInGame = isOnline && !!location && location !== 'web';
          result.set(id, {
            vrchatId: id,
            displayName: userData.displayName || '',
            avatarUrl: userData.currentAvatarThumbnailImageUrl || userData.profilePicOverrideThumbnail || '',
            currentAvatar: userData.currentAvatar || '',
            profilePicOverrideThumbnail: userData.profilePicOverrideThumbnail || '',
            userIcon: userData.userIcon || '',
            status,
            statusDescription: userData.statusDescription || '',
            location,
            worldId: userData.worldId || '',
            last_login: userData.last_login || null,
            isOnline,
            isInGame,
            isFriend: false,
            isVrcPlus: Array.isArray(userData.tags) && userData.tags.includes('system_supporter'),
            ageVerificationStatus: userData.ageVerificationStatus || '',
            ageVerified: userData.ageVerified === true,
            trustLevel: userData.trustLevel || '',
            statusDescription: userData.statusDescription || '',
            tags: Array.isArray(userData.tags) ? userData.tags : [],
            source: 'user',
          });
        }
      } catch (err) {
        // 单个用户查询失败（被删号、限流等）不影响整体
        if (process.env.NODE_ENV !== 'production') {
          // eslint-disable-next-line no-console
          console.warn('[vrc] resolveOnlineStatuses fallback failed for', id, err.message);
        }
      }
      if (fallbackDelayMs) await sleep(fallbackDelayMs);
    }
  }

  const workers = Array(Math.min(concurrency, nonFriends.length)).fill().map(worker);
  await Promise.all(workers);
  return result;
}

module.exports = {
  VRC_API,
  VRC_API_KEY,
  USER_AGENT,
  VRC_INSTANCE_PATTERN,
  vrchatRequest,
  vrchatBasicLogin,
  vrchatVerifyTwoFactor,
  vrchatGetCurrentUser,
  vrchatGetCurrentUserResult,
  vrchatGetGroupEvents,
  vrchatGetWorld,
  vrchatGetInstance,
  vrchatSearchWorlds,
  vrchatListWorlds,
  vrchatGetPopularWorlds,
  vrchatGetFeaturedWorlds,
  vrchatSearchAvatars,
  vrchatGetUserPublicAvatars,
  vrchatGetAvatar,
  vrchatSetAvatar,
  vrchatCloneAvatar,
  vrchatBlockUser,
  vrchatUnblockUser,
  vrchatMuteUser,
  vrchatUnmuteUser,
  vrchatGetGroup,
  vrchatGetGroupMembers,
  vrchatGetGroupAnnouncements,
  vrchatCreateGroupAnnouncement,
  vrchatDeleteGroupAnnouncement,
  vrchatGetGroupGalleries,
  vrchatCreateGroupGallery,
  vrchatGetGroupGallery,
  vrchatUpdateGroupGallery,
  vrchatDeleteGroupGallery,
  vrchatGetGroupRoles,
  vrchatCreateGroupRole,
  vrchatUpdateGroupRole,
  vrchatDeleteGroupRole,
  vrchatAddGroupMemberRole,
  vrchatRemoveGroupMemberRole,
  vrchatGetGroupAuditLogs,
  vrchatGetGroupEconomy,
  vrchatGetGroupBans,
  vrchatBanGroupMember,
  vrchatUnbanGroupMember,
  vrchatFollowGroupCalendar,
  vrchatUnfollowGroupCalendar,
  vrchatGetFriends,
  vrchatGetAllFriends,
  vrchatGetFriendsOnlineMap,
  vrchatResolveOnlineStatuses,
  vrchatGetUser
};
