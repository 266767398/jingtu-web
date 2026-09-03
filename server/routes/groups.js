/**
 * 境途同游 V6.14 — VRChat 群组路由（从 server.js 提取）
 * 群组信息、成员同步/在线状态/变更日志、VRChat user/world 查询
 * 
 * @swagger
 * tags:
 *   name: Groups
 *   description: VRChat群组相关接口
 */
const express = require('express');
const sleep = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds));
const { getPool, handleError , sendError, sendVrcError, ErrorCodes } = require('../utils');
const { requireAuth, requireAdminCompat } = require('../auth');
const {
  vrchatRequest, vrchatGetCurrentUser, vrchatGetCurrentUserResult, vrchatGetGroupMembers,
  vrchatGetUser, vrchatResolveOnlineStatuses, vrchatGetFriendsOnlineMap, vrchatGetWorld, vrchatGetInstance, vrchatSearchWorlds,
  vrchatSearchAvatars, vrchatGetAvatar, vrchatSetAvatar, vrchatGetUserPublicAvatars, VRC_API_KEY, USER_AGENT
} = require('../vrc');
const logger = require('../logger');
const schedule = require('../schedule');

const VRC = require('../vrc');
const VRC_API = VRC.VRC_API || 'https://api.vrchat.cloud/api/1';
const VRC_INSTANCE_PATTERN = VRC.VRC_INSTANCE_PATTERN || /^wrld_[0-9a-fA-F-]+:.+$/;

// ==================== VRChat 实例字符串解析（借鉴 VRCX $location） ====================
// 输入形如 wrld_xxx:84292~group(grp_yyy)~groupAccessType(plus)~region(jp) 的 location，
// 拆解为结构化对象：房间数字名 / 所属群 / 区域 / 访问类型 / 是否离线或私密。
// 注意：location 为空 / 形如 "offline" / 不含 ":" 表示离线，返回 null。
function parseVrcLocation(location) {
  if (!location || typeof location !== 'string') return null;
  const loc = location.trim();
  if (loc === 'offline' || loc === 'private' || !loc.includes(':')) return null;
  const [worldId, instanceId = ''] = loc.split(':');
  const out = {
    worldId: worldId || '',
    instanceId: instanceId || '',
    instanceName: '',          // 房间随机数字名
    groupId: '',               // 当前房间所属群组
    groupAccessType: '',       // plus / public 等
    accessTypeName: '',        // groupPlus / public 等
    region: '',                // 服务器区域
    isOffline: false,
    isPrivate: false,
    isTraveling: false
  };
  // 房间数字名：instanceId 第一个 ~ 之前的片段
  const parts = instanceId.split('~');
  out.instanceName = (parts[0] || '').trim();
  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i];
    const g = seg.match(/^group\(([^)]+)\)$/);
    if (g) { out.groupId = g[1]; continue; }
    const ga = seg.match(/^groupAccessType\(([^)]+)\)$/);
    if (ga) { out.groupAccessType = ga[1]; out.accessTypeName = ga[1] === 'plus' ? 'groupPlus' : ga[1]; continue; }
    const rg = seg.match(/^region\(([^)]+)\)$/);
    if (rg) { out.region = rg[1]; continue; }
    if (/^(private|hidden)/.test(seg)) out.isPrivate = true;
    if (/^traveling/.test(seg)) out.isTraveling = true;
  }
  return out;
}

// ==================== 角色中文映射 ====================
const ROLE_CN_MAP = {
  'Group Owner': '群主', 'Owner': '群主', 'Admin': '管理员', 'Manager': '管理员',
  'Moderator': '协管', 'Mod': '协管', 'Member': '成员', 'Guest': '访客',
  'Recruiter': '招募官', 'Event Host': '活动主持', 'Event Coordinator': '活动协调',
  'Event Organizer': '活动组织者', 'Supporter': '支持者',
  'Contributor': '贡献者', 'Developer': '开发者', 'Artist': '画师',
  'Musician': '音乐人', 'Streamer': '主播', 'Tester': '测试员',
  'Bot': '机器人', 'Everyone': '所有人', 'Citizen': '公民', 'Resident': '居民',
};

/**
 * @param {Function} getVRCCookieFn - 获取 VRChat cookie 的函数
 */
module.exports = function (getVRCCookieFn, GROUP_ID, getUserVRCCookieFn) {
  const router = express.Router();

  // 全量同步的互斥标志：同一时刻只允许一次，避免并发同步互相看到对方的中间态
  // 而写出成片的假"已离开群组"变更记录。
  let syncInFlight = false;
  // 全量同步 / 在线状态刷新已对全体登录用户开放，用内存冷却（按用户隔离，重启即清零）
  // 防止频繁触发打爆 VRChat 限流（429）。
  const SYNC_COOLDOWN_MS = 5 * 60 * 1000;   // 全量同步：5 分钟一次
  const REFRESH_COOLDOWN_MS = 30 * 1000;    // 在线状态刷新：30 秒一次
  // 同步分页拉取：单页遇上游 429 时本页重试次数与页间限速，降低触发 VRChat 全局限流的概率，
  // 并避免"一次 429 就让整次同步 abort"导致前端反复点、雪崩 429。
  const SYNC_PAGE_RETRY = 4;
  const SYNC_PAGE_GAP_MS = 250;
  // 在线状态刷新改为「按用户」冷却：一人刷新不再冻结其他人的手动刷新
  // （原全局冷却会让任意用户刷新后 30s 内全员吃 429）。
  const lastRefreshByUser = new Map();
  // 全量同步同样改为「按用户」冷却：一人同步不再冻结其他用户的手动同步。
  // 全量同步仍需全局互斥锁（syncInFlight），但冷却窗口按用户隔离，避免误伤。
  const lastSyncByUser = new Map();
  // 后台 VRChat 资料刷新去重：同一玩家在缓存过期窗口内被并发请求时，只拉一次 API。
  const vrcRefreshInFlight = new Set();

  /**
   * 执行一次 VRChat 调用。若首选 cookie 确实已失效（上游返回 401），
   * 标记其失效并自动降级到下一个候选（用户绑定 cookie -> 系统账号 cookie）后重试一次。
   * 修复：用户绑定的 cookie 过期后，getVRCCookie 会一直返回这份死 cookie，
   * 永远不会 fallback 到有效的系统 cookie，导致「面板显示已登录、点同步却报登录已过期」。
   *
   * 注意这里**只认 401**：早先的判据是 `result === null || result?.status === 401`，
   * 而 vrchatGetCurrentUser 对任何非 2xx（429 限流、500、超时）都返回 null，
   * 于是 VRChat 偶发抖动一次就会把用户 session 里的 VRChat cookie 清空，
   * 用户刷新后发现"绑定又没了"。上游临时故障绝不能销毁用户的登录凭据。
   * 因此传进来的 run 必须返回带 status 的结果（见 vrchatGetCurrentUserResult）。
   * @param {object} req
   * @param {(cookie: string) => Promise<any>} run 用给定 cookie 执行的实际调用
   * @returns {Promise<{cookie: string|null, result: any}>}
   */
  async function vrcWithFallback(req, run) {
    let cookie = getVRCCookieFn(req);
    if (!cookie) return { cookie: null, result: null };
    let result = await run(cookie);
    const unauthorized = result?.status === 401;
    if (unauthorized && typeof getVRCCookieFn.invalidate === 'function') {
      // 仅当 401 来自「用户自己绑定的 cookie」时，才标记失效并降级到系统账号重试。
      // 若 cookie 实际来自系统账号兜底（用户未绑定 VRChat 的常态），绝不调用 invalidate，
      // 避免把一次偶发 401（VRChat 2FA 重查）误当成"系统账号过期"而注销全站系统登录。
      const userCookie = (typeof getUserVRCCookieFn === 'function' ? getUserVRCCookieFn(req) : null);
      const isUserCookie = !!userCookie && userCookie === cookie;
      if (isUserCookie && await getVRCCookieFn.invalidate(req, cookie)) {
        const next = getVRCCookieFn(req);
        if (next && next !== cookie) {
          cookie = next;
          result = await run(cookie);
        }
      }
    }
    return { cookie, result };
  }

  // ==================== VRChat 用户查询 ====================
  router.post('/vrc/lookup', async (req, res) => {
    if (!getVRCCookieFn(req)) return res.status(401).json({ error: '请先在个人中心绑定VRChat账号，或由管理员在后台登录VRChat系统账号', code: 'VRC_SYSTEM_OFFLINE' });
    try {
      const { query } = req.body;
      if (!query) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请输入搜索内容');
      const encoded = encodeURIComponent(query);
      const vrcFetch = async (url, cookie) => {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 15000);
        try {
          const r = await fetch(url, {
            headers: { 'User-Agent': USER_AGENT, 'Cookie': cookie },
            signal: ac.signal
          });
          // 交给 vrcWithFallback 识别 401 并降级
          return { status: r.status, res: r };
        } finally { clearTimeout(t); }
      };
      const { cookie: vrcCookie, result: direct } = await vrcWithFallback(req,
        (c) => vrcFetch(`${VRC_API}/users/${encoded}?apiKey=${VRC_API_KEY}`, c));
      if (!direct.res.ok) {
        const searchOut = await vrcFetch(`${VRC_API}/users?search=${encoded}&n=5&apiKey=${VRC_API_KEY}`, vrcCookie);
        if (!searchOut.res.ok) return sendVrcError(res, { status: searchOut.status }, '查询 VRChat 用户');
        const users = await searchOut.res.json();
        return res.json({ users: users.map(u => ({ id: u.id, displayName: u.displayName, avatarUrl: u.currentAvatarThumbnailImageUrl || u.userIcon || '' })) });
      }
      const user = await direct.res.json();
      res.json({ user: { id: user.id, displayName: user.displayName, avatarUrl: user.currentAvatarThumbnailImageUrl || user.userIcon || '' } });
    } catch (e) { handleError(res, e, 'groups/vrc-lookup'); }
  });

  // ==================== 获取群组信息 ====================
  router.get('/group', async (req, res) => {
    if (!getVRCCookieFn(req)) return res.status(401).json({ error: '请先在个人中心绑定VRChat账号，或由管理员在后台登录VRChat系统账号', code: 'VRC_SYSTEM_OFFLINE' });
    try {
      const { cookie: vrcCookie, result: groupRes } = await vrcWithFallback(req,
        (c) => vrchatRequest('GET', `/groups/${GROUP_ID}?apiKey=${VRC_API_KEY}`, null, c));
      if (groupRes.status !== 200) return sendVrcError(res, groupRes, '获取群组信息');
      const group = groupRes.data;
      const memberRes = await vrchatRequest('GET', `/groups/${GROUP_ID}/members?apiKey=${VRC_API_KEY}&n=100`, null, vrcCookie);
      let members = [];
      if (memberRes.status === 200) {
        members = Array.isArray(memberRes.data) ? memberRes.data : [];
      }
      res.json({ group, members: members.map(m => ({
        id: m.id, displayName: m.displayName,
        role: ROLE_CN_MAP[m.role] || m.role,
        avatarUrl: m.profilePicUrl || m.thumbnailUrl || '',
        isOnline: m.isOnline || false
      })) });
    } catch (e) { handleError(res, e, 'groups/group'); }
  });

  // ==================== VRChat World 详情 ====================
  router.get('/vrc/world/:worldId', async (req, res) => {
    if (!getVRCCookieFn(req)) return res.status(401).json({ error: '请先在个人中心绑定VRChat账号，或由管理员在后台登录VRChat系统账号', code: 'VRC_SYSTEM_OFFLINE' });
    try {
      const { result: wr } = await vrcWithFallback(req, (c) => vrchatGetWorld(req.params.worldId, c));
      if (wr.status !== 200) return sendVrcError(res, wr, '获取世界详情');
      res.json(wr.data);
    } catch (e) { handleError(res, e, 'groups/world'); }
  });

  // ==================== VRChat World 搜索 ====================
  router.get('/vrc/worlds/search', async (req, res) => {
    if (!getVRCCookieFn(req)) return res.status(401).json({ error: '请先在个人中心绑定VRChat账号，或由管理员在后台登录VRChat系统账号', code: 'VRC_SYSTEM_OFFLINE' });
    try {
      const q = req.query.q || '';
      const n = parseInt(req.query.n) || 10;
      if (!q) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请输入搜索关键词');
      const { result: wr } = await vrcWithFallback(req, (c) => vrchatSearchWorlds(q, n, c));
      if (wr.status !== 200) return sendVrcError(res, wr, '搜索世界');
      res.json({ worlds: wr.data });
    } catch (e) { handleError(res, e, 'groups/worlds-search'); }
  });

  // ==================== VRChat Avatar 搜索 ====================
  router.get('/vrc/avatars/search', async (req, res) => {
    if (!getVRCCookieFn(req)) return res.status(401).json({ error: '请先在个人中心绑定VRChat账号，或由管理员在后台登录VRChat系统账号', code: 'VRC_SYSTEM_OFFLINE' });
    try {
      const q = req.query.q || '';
      const n = parseInt(req.query.n) || 10;
      if (!q) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请输入搜索关键词');
      const { result: av } = await vrcWithFallback(req, (c) => vrchatSearchAvatars(q, n, c));
      if (av.status !== 200) return sendVrcError(res, av, '搜索模型');
      res.json({ avatars: av.data });
    } catch (e) { handleError(res, e, 'groups/avatars-search'); }
  });

  // ==================== VRChat Avatar 详情 ====================
  router.get('/vrc/avatar/:avatarId', async (req, res) => {
    if (!getVRCCookieFn(req)) return res.status(401).json({ error: '请先在个人中心绑定VRChat账号，或由管理员在后台登录VRChat系统账号', code: 'VRC_SYSTEM_OFFLINE' });
    try {
      const { result: av } = await vrcWithFallback(req, (c) => vrchatGetAvatar(req.params.avatarId, c));
      if (av.status !== 200) return sendVrcError(res, av, '获取模型详情');
      res.json(av.data);
    } catch (e) { handleError(res, e, 'groups/avatar'); }
  });

  // ==================== VRChat 切换 Avatar ====================
  // 注意：这是代表「当前用户」的写操作，绝不能 fallback 到系统账号 cookie，
  // 否则会把系统账号的模型改掉。
  // 因此这里用 getUserVRCCookieFn（仅取当前用户绑定 cookie、缺失即 401），
  // 而不是会回退系统账号的 getVRCCookieFn。
  router.post('/vrc/avatar/set', async (req, res) => {
    const vrcCookie = (typeof getUserVRCCookieFn === 'function' ? getUserVRCCookieFn : getVRCCookieFn)(req);
    if (!vrcCookie) return res.status(401).json({ error: '请先在个人中心绑定VRChat账号', code: 'VRC_SYSTEM_OFFLINE' });
    try {
      const { avatarId } = req.body;
      if (!avatarId) return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'avatarId 不能为空');
      const result = await vrchatSetAvatar(avatarId, vrcCookie);
      if (result.status !== 200) return sendVrcError(res, result, '切换模型');
      res.json({ ok: true, avatarId });
    } catch (e) { handleError(res, e, 'groups/avatar-set'); }
  });

  // ==================== 全面同步群组成员 ====================
  router.post('/group/members/sync', requireAuth, async (req, res) => {
    if (!getVRCCookieFn(req)) {
      return res.status(401).json({
        error: '缺少可用的 VRChat 登录状态',
        detail: '请先在个人中心绑定您的 VRChat 账号，或在管理面板的"系统 VRChat 账号"卡片中登录系统账号',
        code: 'VRC_SYSTEM_OFFLINE'
      });
    }
    const pool = getPool();
    let conn;
    // 全量同步是重操作，已对全体登录用户开放，走「按用户」冷却（5 分钟一次）再走互斥锁，
    // 防止有人反复点同步把 VRChat API 打到限流（429）。冷却按用户隔离，一人同步不冻结他人。
    const nowMs = Date.now();
    const syncUserKey = String((req.user && (req.user.id || req.user.login_id)) || 'unknown');
    const lastUserSync = lastSyncByUser.get(syncUserKey) || 0;
    if (lastUserSync && nowMs - lastUserSync < SYNC_COOLDOWN_MS) {
      const retryAfterSec = Math.ceil((SYNC_COOLDOWN_MS - (nowMs - lastUserSync)) / 1000);
      return res.status(429).json({
        error: '同步冷却中',
        detail: `距离上次群组同步还需约 ${Math.ceil(retryAfterSec / 60)} 分钟，请稍后再试`,
        code: 'SYNC_COOLDOWN',
        retryAfterSec
      });
    }
    // 同一时刻只允许一次全量同步。前端曾因 api() 的 10 秒超时而看起来"没反应"，
    // 用户会反复点击；并发的同步会各自 `UPDATE ... is_member=0` 再补回，
    // 互相看到对方的中间态，往 group_member_changes 里写出大量假的"已离开群组"记录。
    if (syncInFlight) {
      return res.status(409).json({
        error: '同步正在进行中',
        detail: '上一次群组同步还没结束，请等它完成后再试',
        code: ErrorCodes.CONFLICT
      });
    }
    syncInFlight = true;
    lastSyncByUser.set(syncUserKey, Date.now());
    try {
      const { cookie: vrcCookie, result: meRes } =
        await vrcWithFallback(req, (c) => vrchatGetCurrentUserResult(c));
      // 401 = cookie 真的过期了；其它非 2xx = VRChat 上游故障（限流/维护），
      // 两者必须分开报，否则用户会被误导去重新绑定，而且上一版还会顺手清掉绑定。
      if (!meRes || meRes.status === 401) {
        return res.status(401).json({
          error: 'VRChat 登录已过期',
          detail: '请在管理面板重新登录系统 VRChat 账号，或在个人中心重新绑定您的 VRChat 账号',
          code: 'VRC_COOKIE_EXPIRED'
        });
      }
      if (meRes.status !== 200 || !meRes.data) {
        return sendVrcError(res, meRes, '校验 VRChat 登录状态');
      }
      let allMembers = [];
      let offset = 0;
      const pageSize = 100;
      // 上限保护：原来是 while(true)，只要上游忽略 offset 一直返回满页
      // （VRChat 故障或权限不足时确有此表现），这个请求就永远不会结束，
      // 还会一直反复打 VRChat 直到撞限流。
      const MAX_PAGES = 200; // 200 × 100 = 2 万人，远超任何真实群组规模
      let page = 0;
      while (page < MAX_PAGES) {
        // 分页拉取：遇 VRChat 上游 429 时本页退避重试，避免整次同步因瞬时限流直接 abort。
        let mr = null;
        for (let attempt = 0; attempt <= SYNC_PAGE_RETRY; attempt++) {
          mr = await vrchatGetGroupMembers(GROUP_ID, vrcCookie, pageSize, offset);
          if (mr.status === 200) break;
          if (mr.status === 429) {
            const waitMs = 3000 * (attempt + 1); // 3s, 6s, 9s... 退避
            logger.warn('groups', 'sync 拉取成员分页遇 429，退避后重试本页', { page, attempt, waitMs });
            await sleep(waitMs);
            continue;
          }
          // 其它非 2xx（401/5xx 等）直接上报，不再重试
          return sendVrcError(res, mr, '获取群组成员列表');
        }
        if (mr.status !== 200) return sendVrcError(res, mr, '获取群组成员列表');
        const batch = Array.isArray(mr.data) ? mr.data : [];
        allMembers = allMembers.concat(batch);
        if (batch.length < pageSize) break;
        offset += pageSize;
        page++;
        // 页间限速：降低对 VRChat 的请求频率，减少触发全局限流的概率
        await sleep(SYNC_PAGE_GAP_MS);
      }
      if (page >= MAX_PAGES) {
        logger.error('groups', 'VRChat 成员分页超过上限，疑似上游忽略 offset', { pages: page, got: allMembers.length });
        // 走 sendVrcError 统一分流，不裸写 502：前端靠 code 区分"该重新登录 VRChat"
        // 还是"VRChat 那边出问题了"。
        return sendVrcError(res, { status: 502, data: { error: 'VRChat 返回的成员分页异常（未按 offset 翻页）' } }, '获取群组成员列表');
      }
      conn = await pool.getConnection();
      await conn.beginTransaction();

      const [oldMembers] = await conn.query(`SELECT vrchat_id, vrchat_name, is_member FROM group_roster WHERE is_member=1`);
      const oldMap = new Map(oldMembers.map(m => [m.vrchat_id, m]));

      await conn.query(`UPDATE group_roster SET is_member=0 WHERE is_member=1`);

      let joinedCount = 0, updatedCount = 0;
      const newMemberIds = new Set();
      const now = new Date();

      // 原来这里对每个成员先 SELECT 再 UPDATE/INSERT，一千人就是两千次串行往返，
      // 全部压在同一个事务里，长时间锁住 group_roster。改为一次性取回全部已存在的 ID，
      // 再用批量 upsert（vrchat_id 上有 UNIQUE 约束）。
      const [allRows] = await conn.query(`SELECT vrchat_id FROM group_roster`);
      const existingIds = new Set(allRows.map(r => r.vrchat_id));

      const validMembers = allMembers.filter(m => m.userId);
      const CHUNK = 200;
      for (let i = 0; i < validMembers.length; i += CHUNK) {
        const chunk = validMembers.slice(i, i + CHUNK);
        const params = [];
        for (const m of chunk) {
          const uid = m.userId;
          newMemberIds.add(uid);
          const isNew = !oldMap.has(uid);
          if (isNew) joinedCount++;
          updatedCount++;
          params.push(
            uid,
            m.user?.displayName || '',
            m.user?.currentAvatarThumbnailImageUrl || '',
            m.membershipStatus || 'member',
            JSON.stringify(m.roleIds || []),
            // 只有从未在册的人才写 joined_at；已在册的用 COALESCE 保留原值
            existingIds.has(uid) ? null : now
          );
        }
        const placeholders = chunk.map(() => '(?, ?, ?, 1, ?, ?, ?, NOW())').join(', ');
        await conn.query(
          `INSERT INTO group_roster (vrchat_id, vrchat_name, avatar_url, is_member, membership_status, role_ids, joined_at, synced_at)
           VALUES ${placeholders}
           ON DUPLICATE KEY UPDATE
             vrchat_name = VALUES(vrchat_name),
             avatar_url = VALUES(avatar_url),
             is_member = 1,
             membership_status = VALUES(membership_status),
             role_ids = VALUES(role_ids),
             joined_at = COALESCE(group_roster.joined_at, VALUES(joined_at)),
             left_at = NULL,
             synced_at = NOW()`,
          params
        );
      }

      let leftCount = 0;
      const leftIds = [...oldMap.keys()].filter(id => !newMemberIds.has(id));
      if (leftIds.length > 0) {
        for (let i = 0; i < leftIds.length; i += CHUNK) {
          const chunk = leftIds.slice(i, i + CHUNK);
          await conn.query(
            `UPDATE group_roster SET is_member=0, left_at=NOW(), is_online=0, vrchat_status='offline'
             WHERE vrchat_id IN (${chunk.map(() => '?').join(',')})`,
            chunk
          );
          const changeParams = [];
          for (const id of chunk) changeParams.push(id, oldMap.get(id).vrchat_name, '已离开群组（同步检测）');
          await conn.query(
            `INSERT INTO group_member_changes (vrchat_id, vrchat_name, change_type, detail)
             VALUES ${chunk.map(() => "(?, ?, 'left', ?)").join(', ')}`,
            changeParams
          );
        }
        leftCount = leftIds.length;
      }

      const joinedMembers = validMembers.filter(m => !oldMap.has(m.userId));
      for (let i = 0; i < joinedMembers.length; i += CHUNK) {
        const chunk = joinedMembers.slice(i, i + CHUNK);
        const changeParams = [];
        for (const m of chunk) changeParams.push(m.userId, m.user?.displayName || '', '加入群组（同步检测）');
        await conn.query(
          `INSERT INTO group_member_changes (vrchat_id, vrchat_name, change_type, detail)
           VALUES ${chunk.map(() => "(?, ?, 'joined', ?)").join(', ')}`,
          changeParams
        );
      }

      await conn.query(
        `INSERT INTO group_sync_log (sync_type, total_members, online_count, joined_count, left_count, success) VALUES ('full', ?, 0, ?, ?, 1)`,
        [allMembers.length, joinedCount, leftCount]
      );

      await conn.commit();
      // 成员加入/离开后，立即向前端实时广播该群组最新在线统计（解决"加入/离开状态未更新"）。
      try { await schedule.forceRosterBroadcast(GROUP_ID); } catch (be) { logger.warn('groups', 'sync 后广播群组状态失败', be.message); }
      res.json({ success: true, total: allMembers.length, joined: joinedCount, left: leftCount, updated: updatedCount });
    } catch (e) {
      if (conn) { try { await conn.rollback(); } catch {} }
      try { await getPool().query(`INSERT INTO group_sync_log (sync_type, total_members, success, error_msg) VALUES ('full', 0, 0, ?)`, [e.message]); } catch {}
      // VRChat 限流排队超时：这不是"服务器内部错误"，而是上游繁忙，返回 503 让前端明确提示稍后重试。
      if (e?.code === 'VRC_RATE_TIMEOUT') {
        logger.warn('groups', 'sync 遭遇 VRChat 限流排队超时，本次同步未执行');
        return res.status(503).json({ success: false, code: 'VRC_RATE_LIMITED', error: 'VRChat 接口当前繁忙（限流），请稍后重试' });
      }
      handleError(res, e, 'groups/sync');
    } finally {
      syncInFlight = false;
      if (conn) conn.release();
    }
  });

  // ==================== 刷新在线状态 ====================
  router.get('/group/members/refresh', requireAuth, async (req, res) => {
    // 在线状态刷新已对全体登录用户开放，走按用户冷却（每人 30 秒一次），
    // 防止同一人频繁点刷新把 VRChat 好友接口打到限流（429），且不误伤其他用户。
    const nowMs = Date.now();
    const refreshUserKey = String((req.user && (req.user.id || req.user.login_id)) || 'unknown');
    const lastUserRefresh = lastRefreshByUser.get(refreshUserKey) || 0;
    if (lastUserRefresh && nowMs - lastUserRefresh < REFRESH_COOLDOWN_MS) {
      const retryAfterSec = Math.ceil((REFRESH_COOLDOWN_MS - (nowMs - lastUserRefresh)) / 1000);
      return res.status(429).json({
        error: '刷新太频繁',
        detail: `在线状态刷新太频繁，请 ${retryAfterSec} 秒后再试`,
        code: 'SYNC_COOLDOWN',
        retryAfterSec
      });
    }
    if (!getVRCCookieFn(req)) {
      return res.status(401).json({ error: '请先在个人中心绑定VRChat账号，或由管理员在后台登录VRChat系统账号', code: 'VRC_SYSTEM_OFFLINE' });
    }
    lastRefreshByUser.set(refreshUserKey, nowMs);
    const pool = getPool();
    try {
      const [members] = await pool.query(`SELECT vrchat_id, vrchat_name, avatar_url FROM group_roster WHERE is_member=1`);
      if (members.length === 0) return res.json({ success: true, online: 0, offline: 0, total: 0 });

      // 不再对输入做硬截断：好友在线状态走 /auth/user/friends 一次全量解析，
      // 非好友详细状态由 vrchatResolveOnlineStatuses 内部的 maxFallback 上限（默认 25）兜底，
      // 避免「超过 100 人就静默丢弃、且前 100 人按名册顺序任意截取」导致的遗漏。
      const toProcess = members;
      if (members.length > 200) {
        logger.warn('groups', `刷新在线状态: ${members.length} 名成员；好友在线状态全量解析，非好友详细状态受 VRChat 接口限流约束`);
      }

      // vrcWithFallback：优先使用当前登录用户自己绑定的 VRChat cookie（用户好友视角），
      // 用户 cookie 401 过期后再降级到系统账号 cookie。
      // 这与 VRCX 一致：只有用自己的账号、看自己的好友列表，才能得到最准确的在线状态。
      // VRChat 限流（429）时令牌桶排队超时会抛 VRC_RATE_TIMEOUT，这里捕获后降级为
      // 仅用「群友共享状态」兜底，而不是把整个刷新接口打成 500。
      let onlineMap = new Map();
      let degraded = false;
      try {
        const { cookie: vrcCookie, result: onlineResult } = await vrcWithFallback(req, async (cookie) => {
          // 探活：若该 cookie 已过期（401），让 vrcWithFallback 有机会降级重试。
          const probe = await vrchatGetUser(toProcess[0].vrchat_id, cookie);
          if (probe.status === 401) return { status: 401 };
          // 批量解析：/auth/user/friends 优先拿到所有好友状态，非好友再回退 /users/{id}。
          const map = await vrchatResolveOnlineStatuses(cookie, toProcess.map(m => m.vrchat_id), {
            concurrency: 5,
            fallbackDelayMs: 1000,
            maxPages: 20,
          });
          return { status: 200, data: map };
        });

        if (!vrcCookie) {
          return res.status(401).json({ error: '请先在个人中心绑定VRChat账号，或由管理员在后台登录VRChat系统账号', code: 'VRC_SYSTEM_OFFLINE' });
        }
        if (onlineResult?.status === 401) {
          return res.status(401).json({ error: 'VRChat 账号登录已过期，请重新绑定或在管理面板重新登录系统账号', code: 'VRC_COOKIE_EXPIRED' });
        }
        if (!onlineResult?.data) {
          return sendVrcError(res, onlineResult, '刷新在线状态');
        }
        onlineMap = onlineResult.data;
      } catch (e) {
        if (e?.code === 'VRC_RATE_TIMEOUT') {
          degraded = true;
          logger.warn('groups', 'refresh 在线状态解析遭遇 VRChat 限流排队超时，降级为仅用群友共享状态');
        } else {
          throw e;
        }
      }

      // 方案 B：加载群友共享的在线状态（最近 15 分钟内上报，好友视角可信）
      const [sharedRows] = await pool.query(
        `SELECT vrchat_id, is_online, vrchat_status, world_name, location, last_login, updated_at
         FROM group_presence_share WHERE updated_at >= NOW() - INTERVAL 15 MINUTE`
      );
      const sharedMap = new Map();
      const nowMs = Date.now();
      for (const s of sharedRows) {
        const ua = s.updated_at ? new Date(s.updated_at).getTime() : 0;
        if (nowMs - ua <= 15 * 60 * 1000) sharedMap.set(s.vrchat_id, s);
      }

      let onlineCount = 0, offlineCount = 0, updatedCount = 0;
      const results = [];

      for (const m of toProcess) {
        let info = onlineMap.get(m.vrchat_id);
        let isFriend = info && info.isFriend ? true : false;
        // 方案 B：系统视角（非好友）看不到时，采用群友共享的可信状态。
        if (!isFriend && sharedMap.has(m.vrchat_id)) {
          const s = sharedMap.get(m.vrchat_id);
          info = {
            vrchatId: m.vrchat_id,
            displayName: m.vrchat_name || '',
            avatarUrl: m.avatar_url || '',
            status: s.vrchat_status || 'offline',
            location: s.location || '',
            worldId: s.world_name || '',
            isOnline: !!s.is_online,
            // 从群友共享态推算：在线且 location 非网页端（非 'web'/空）即视为游戏内。
            isInGame: !!(s.is_online && s.location && s.location !== 'web'),
            isFriend: true,
            source: 'shared',
            last_login: s.last_login || null,
          };
          isFriend = true;
        }
        if (!info) {
          // 状态未知，保留原在线状态，仅刷新 synced_at，不误标离线。
          await pool.query(`UPDATE group_roster SET synced_at=NOW() WHERE vrchat_id=?`, [m.vrchat_id]);
          continue;
        }
        const status = info.status || 'offline';
        const isOnline = info.isOnline;
        const location = info.location || '';
        let worldName = info.worldId || '';
        if (location && !worldName) {
          const parts = location.split(':');
          if (parts[0]) worldName = parts[0];
        }
        await pool.query(
          `UPDATE group_roster SET display_name=?, avatar_url=?, is_online=?, is_in_game=?, vrchat_status=?, location=?, world_name=?, is_friend=?,
              is_vrc_plus=?, age_verified=?, age_verification_status=?, profile_pic_override_thumbnail=?, user_icon=?, last_seen=NOW(), synced_at=NOW()
           WHERE vrchat_id=?`,
          [info.displayName || m.vrchat_name || '', info.avatarUrl || m.avatar_url || '',
           isOnline ? 1 : 0, info.isInGame ? 1 : 0,
           status, location, worldName, isFriend ? 1 : 0,
           info.isVrcPlus ? 1 : 0, info.ageVerified ? 1 : 0, info.ageVerificationStatus || '',
           info.profilePicOverrideThumbnail || '', info.userIcon || '', m.vrchat_id]
        );
        results.push({
          vrchatId: m.vrchat_id, displayName: info.displayName, status, isOnline, isInGame: !!info.isInGame, isFriend,
          location, worldName, avatarUrl: info.avatarUrl, lastLogin: info.last_login,
          isVrcPlus: info.isVrcPlus, ageVerified: info.ageVerified,
          ageVerificationStatus: info.ageVerificationStatus,
          profilePicOverrideThumbnail: info.profilePicOverrideThumbnail,
          userIcon: info.userIcon
        });
        if (isOnline) onlineCount++; else offlineCount++;
        updatedCount++;
      }

      await pool.query(
        `INSERT INTO group_sync_log (sync_type, total_members, online_count, joined_count, left_count, success) VALUES ('status', ?, ?, 0, 0, 1)`,
        [members.length, onlineCount]
      );

      res.json({ success: true, degraded, online: onlineCount, offline: offlineCount, total: members.length, updated: updatedCount, results });
      // 手动刷新在线状态后，立即向前端实时广播该群组最新在线统计。
      try { await schedule.forceRosterBroadcast(GROUP_ID); } catch (be) { logger.warn('groups', 'refresh 后广播群组状态失败', be.message); }
    } catch (e) {
      handleError(res, e, 'groups/refresh');
    }
  });

  // ==================== 方案 B: 贡献本人好友在线状态（群友互助） ====================
  // 已登录且绑定 VRChat 的用户，在查看群组时把自己的好友视角上报给服务器，
  // 补充系统账号因 VRChat 隐私墙看不到的非好友成员的真实在线状态。
  // 仅上报"当前用户的好友"中属于本群成员的人（好友视角可信），其他成员不上报。
  router.post('/group/presence/contribute', requireAuth, async (req, res) => {
    const pool = getPool();
    try {
      const { cookie, result } = await vrcWithFallback(req, async (c) => {
        // 取当前用户自己的好友在线列表（好友视角，状态最准确）
        const friendMap = await vrchatGetFriendsOnlineMap(c, { maxPages: 20, delayMs: 0 });
        if (!friendMap || friendMap.size === 0) return { shared: 0 };
        const [rows] = await pool.query(`SELECT vrchat_id FROM group_roster WHERE is_member=1`);
        const ids = rows.map(r => r.vrchat_id);
        const [u] = await pool.query(`SELECT vrchat_id FROM users WHERE id=?`, [req.user.id]);
        const sourceVid = (u[0] && u[0].vrchat_id) ? u[0].vrchat_id : null;
        let shared = 0;
        for (const vid of ids) {
          const f = friendMap.get(vid);
          if (!f) continue; // 只上报本群中"我的好友"
          await pool.query(
            `INSERT INTO group_presence_share (vrchat_id, is_online, vrchat_status, world_name, location, last_login, source_vrchat_id, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
             ON DUPLICATE KEY UPDATE is_online=VALUES(is_online), vrchat_status=VALUES(vrchat_status),
               world_name=VALUES(world_name), location=VALUES(location), last_login=VALUES(last_login),
               source_vrchat_id=VALUES(source_vrchat_id), updated_at=NOW()`,
            [vid, f.isOnline ? 1 : 0, f.status || 'offline', f.worldId || '', f.location || '', f.last_login || null, sourceVid]
          );
          shared++;
        }
        return { shared };
      });
      if (!cookie) {
        return res.status(401).json({ success: false, error: 'VRChat 账号未绑定或已过期', code: 'VRC_SYSTEM_OFFLINE' });
      }
      const shared = result && result.shared !== undefined ? result.shared : 0;
      res.json({ success: true, shared });
    } catch (e) {
      // 贡献是增强特性，失败不应阻断主流程（如 VRChat 限流 / cookie 过期）
      logger.warn('groups', 'presence/contribute 失败', e.message);
      res.json({ success: true, shared: 0, skipped: true });
    }
  });

  // ==================== 获取群组成员列表（本地 DB） ====================
  router.get('/group/members', requireAuth, async (req, res) => {
    try {
      const filter = req.query.filter || 'all';
      const search = (req.query.search || '').trim();
      let sql = `SELECT vrchat_id AS vrchatId, vrchat_name AS vrchatName, display_name AS displayName, avatar_url AS avatarUrl,
                profile_pic_override_thumbnail AS profilePicOverrideThumbnail,
                is_member AS isMember, is_online AS isOnline, is_in_game AS isInGame, vrchat_status AS vrchatStatus,
                status_description AS statusDescription,
                location, world_name AS worldName, last_login AS lastLogin, last_seen AS lastSeen,
                joined_at AS joinedAt, left_at AS leftAt, role_ids AS roleIds,
                membership_status AS membershipStatus, is_friend AS isFriend, synced_at AS syncedAt,
                trust_level AS trustLevel, trust_level_cn AS trustLevelCn
                FROM group_roster WHERE is_member=1`;
      if (filter === 'online') sql += ` AND is_online=1`;
      else if (filter === 'offline') sql += ` AND is_online=0`;
      else if (filter === 'nonfriend') sql += ` AND is_friend=0`;
      // 网页端在线：VRChat 用户通过 vrchat.com 登录但未进入任何世界（location='web'），
      // 账号在线（is_online=1）但不在客户端游戏内（is_in_game=0）。
      else if (filter === 'web') sql += ` AND is_online=1 AND is_in_game=0`;
      // 游戏内在线：客户端在任意世界/Home 内（is_in_game=1）。
      else if (filter === 'ingame') sql += ` AND is_in_game=1`;

      const params = [];
      if (search) {
        // 玩家搜索：匹配显示名 / VRChat 名称 / VRChat ID（大小写不敏感）
        sql += ` AND (LOWER(display_name) LIKE ? OR LOWER(vrchat_name) LIKE ? OR LOWER(vrchat_id) LIKE ?)`;
        const like = `%${search.toLowerCase()}%`;
        params.push(like, like, like);
      }

      if (filter === 'online') sql += ` ORDER BY last_seen DESC`;
      else if (filter === 'offline') sql += ` ORDER BY last_login DESC`;
      else if (filter === 'nonfriend') sql += ` ORDER BY is_online DESC, last_seen DESC`;
      else if (filter === 'web') sql += ` ORDER BY last_seen DESC`;
      else sql += ` ORDER BY is_online DESC, last_seen DESC`;

      const [rows] = await getPool().query(sql, params);
      for (const r of rows) {
        try { r.roleIds = JSON.parse(r.roleIds || '[]'); } catch { r.roleIds = []; }
      }
      res.json({ members: rows, total: rows.length });
    } catch (e) {
      handleError(res, e, 'groups/members');
    }
  });

  // ==================== 成员变更历史 ====================
  router.get('/group/members/changes', requireAuth, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 30, 100);
      const [rows] = await getPool().query(
        `SELECT vrchat_id AS vrchatId, vrchat_name AS vrchatName, change_type AS changeType,
                old_status AS oldStatus, new_status AS newStatus, detail, created_at AS createdAt
         FROM group_member_changes ORDER BY created_at DESC LIMIT ?`, [limit]
      );
      res.json({ changes: rows });
    } catch (e) {
      handleError(res, e, 'groups/changes');
    }
  });

  // ==================== 同步日志 ====================
  router.get('/group/members/sync-log', requireAuth, async (req, res) => {
    try {
      const [rows] = await getPool().query(
        `SELECT sync_type AS syncType, total_members AS totalMembers, online_count AS onlineCount,
                joined_count AS joinedCount, left_count AS leftCount, success, error_msg AS errorMsg,
                created_at AS createdAt
         FROM group_sync_log ORDER BY created_at DESC LIMIT 10`
      );
      res.json({ logs: rows });
    } catch (e) {
      handleError(res, e, 'groups/sync-log');
    }
  });

  // ==================== 手动添加成员到名单 ====================
  router.post('/admin/roster/sync', requireAdminCompat, async (req, res) => {
    try {
      const { vrchatId, displayName } = req.body;
      if (!vrchatId) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '缺少 VRChat ID');
      await getPool().query(`INSERT INTO group_roster (vrchat_id, vrchat_name, is_member) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE vrchat_name=?, is_member=1`,
        [vrchatId, displayName || '', displayName || '']);
      res.json({ success: true });
    } catch (e) { handleError(res, e, 'groups/admin-roster-sync'); }
  });

  // ==================== 检查 VRChat ID 是否在群组中 ====================
  router.get('/group/check/:vrchatId', requireAuth, async (req, res) => {
    try {
      const [rows] = await getPool().query(`SELECT id FROM group_roster WHERE vrchat_id=? AND is_member=1`, [req.params.vrchatId]);
      res.json({ inGroup: rows.length > 0 });
    } catch (e) { handleError(res, e, 'groups/check'); }
  });

  // ==================== 群组实时统计 ====================
  router.get('/group/stats', requireAuth, async (req, res) => {
    try {
      const pool = getPool();
      const [totalRes] = await pool.query(`SELECT COUNT(*) as count FROM group_roster WHERE is_member=1`);
      const [onlineRes] = await pool.query(`SELECT COUNT(*) as count FROM group_roster WHERE is_member=1 AND is_online=1`);
      const [inGameRes] = await pool.query(`SELECT COUNT(*) as count FROM group_roster WHERE is_member=1 AND is_in_game=1`);
      const [unknownRes] = await pool.query(`SELECT COUNT(*) as count FROM group_roster WHERE is_member=1 AND is_online=1 AND is_friend=0`);
      const [statusRes] = await pool.query(`SELECT vrchat_status AS status, COUNT(*) as count FROM group_roster WHERE is_member=1 GROUP BY vrchat_status`);
      const [worldRes] = await pool.query(`SELECT world_name AS worldName, COUNT(*) as count FROM group_roster WHERE is_member=1 AND is_online=1 AND world_name IS NOT NULL AND world_name != '' GROUP BY world_name ORDER BY count DESC LIMIT 10`);
      const [locationRes] = await pool.query(`SELECT location, COUNT(*) as count FROM group_roster WHERE is_member=1 AND is_online=1 AND location IS NOT NULL AND location != '' GROUP BY location ORDER BY count DESC LIMIT 10`);
      const [recentRes] = await pool.query(`SELECT vrchat_name AS displayName, vrchat_status AS status, world_name AS worldName, last_seen AS lastSeen FROM group_roster WHERE is_member=1 ORDER BY last_seen DESC LIMIT 10`);
      const [joinedTodayRes] = await pool.query(`SELECT COUNT(*) as count FROM group_roster WHERE is_member=1 AND DATE(joined_at) = CURDATE()`);
      const [leftTodayRes] = await pool.query(`SELECT COUNT(*) as count FROM group_member_changes WHERE change_type='left' AND DATE(created_at) = CURDATE()`);

      const statusMap = {};
      for (const row of statusRes) {
        statusMap[row.status] = row.count;
      }

      const webOnlineCount = onlineRes[0].count - inGameRes[0].count; // 网页端在线 = 账号在线 - 游戏内在线
      const worldDistribution = worldRes.map(r => ({ worldName: r.worldName, count: r.count }));
      const locationDistribution = locationRes.map(r => ({ location: r.location, count: r.count }));

      res.json({
        totalMembers: totalRes[0].count,
        onlineCount: onlineRes[0].count,
        inGameCount: inGameRes[0].count,
        webOnlineCount,
        offlineCount: totalRes[0].count - onlineRes[0].count,
        unknownCount: unknownRes[0].count,
        onlineRate: totalRes[0].count > 0 ? Math.round((onlineRes[0].count / totalRes[0].count) * 100) : 0,
        statusDistribution: {
          active: statusMap['active'] || 0,
          online: statusMap['online'] || statusMap['join me'] || statusMap['ask me'] || statusMap['busy'] || 0,
          offline: statusMap['offline'] || 0,
          web: webOnlineCount,
          ingame: inGameRes[0].count
        },
        worldDistribution,
        locationDistribution,
        recentMembers: recentRes.map(r => ({
          displayName: r.displayName,
          status: r.status,
          worldName: r.worldName,
          lastSeen: r.lastSeen
        })),
        joinedToday: joinedTodayRes[0].count,
        leftToday: leftTodayRes[0].count,
        updatedAt: new Date().toISOString()
      });
    } catch (e) { handleError(res, e, 'groups/stats'); }
  });

  // ==================== 在线成员世界分布详情 ====================
  // 返回群组成员当前所在 VRChat 世界聚合：包含房间真实总人数（调用 VRC API 查询实例）、
  // 好友人数、本站成员人数，避免「人数」歧义。
  router.get('/group/worlds', requireAuth, async (req, res) => {
    try {
      const pool = getPool();
      const [worlds] = await pool.query(
        `SELECT world_name AS worldName, vrchat_id AS vrchatId, display_name AS displayName,
                avatar_url AS avatarUrl, vrchat_status AS status, location, is_friend AS isFriend
         FROM group_roster
         WHERE is_member=1 AND is_online=1 AND world_name IS NOT NULL AND world_name != ''
           AND location IS NOT NULL AND location != ''
         ORDER BY world_name, display_name`
      );

      const worldMap = new Map();
      for (const member of worlds) {
        if (!worldMap.has(member.worldName)) {
          worldMap.set(member.worldName, {
            worldName: member.worldName,
            count: 0,
            friendCount: 0,
            members: [],
            instanceIds: new Set()
          });
        }
        const entry = worldMap.get(member.worldName);
        entry.count++;
        if (member.isFriend) entry.friendCount++;
        entry.members.push({
          vrchatId: member.vrchatId,
          displayName: member.displayName,
          avatarUrl: member.avatarUrl,
          status: member.status,
          isFriend: !!member.isFriend
        });

        // 仅把合法的 VRChat 实例 ID（wrld_xxx:...）加入查询集合；
        // offline/private/traveling 或 "offline: undefined" 等非法串不查询，避免无意义的告警。
        if (member.location && VRC_INSTANCE_PATTERN.test(member.location)) {
          entry.instanceIds.add(member.location);
        }
      }

      // 并发查询每个实例的真实人数（去重 + 单次请求内缓存 + 并发限制）
      const instanceCache = new Map();
      const instanceList = [];
      for (const entry of worldMap.values()) {
        for (const instanceId of entry.instanceIds) {
          instanceList.push({ worldName: entry.worldName, instanceId });
        }
      }

      const CONCURRENCY = 5;
      async function fetchInstance(instanceId) {
        if (instanceCache.has(instanceId)) return instanceCache.get(instanceId);
        try {
          const { result } = await vrcWithFallback(req, (c) => vrchatGetInstance(instanceId, c));
          if (result && result.status === 200 && result.data) {
            const data = result.data;
            const n = typeof data.n_users === 'number' ? data.n_users
              : typeof data.userCount === 'number' ? data.userCount
              : 0;
            instanceCache.set(instanceId, { ok: true, n });
            return instanceCache.get(instanceId);
          }
        } catch (err) {
          logger.warn(`[groups/worlds] 获取实例人数失败 ${instanceId}: ${err.message || err}`);
        }
        instanceCache.set(instanceId, { ok: false, n: 0 });
        return instanceCache.get(instanceId);
      }

      // 实例人数查询整体限时：VRChat 限流时 vrcAcquire 会排队（最长 12s），若成批实例
      // 每个都等满排队超时，/group/worlds 会被拖到几十秒（用户看到的「群组加载超时」）。
      // 这里整体限时 8s，超时后未查完的实例直接走 DB 估算人数，接口秒级返回。
      const INSTANCE_TOTAL_TIMEOUT = 8000;
      const drain = (async () => {
        for (let i = 0; i < instanceList.length; i += CONCURRENCY) {
          const batch = instanceList.slice(i, i + CONCURRENCY);
          await Promise.all(batch.map(item => fetchInstance(item.instanceId)));
        }
      })();
      await Promise.race([
        drain,
        new Promise(r => setTimeout(() => r('timeout'), INSTANCE_TOTAL_TIMEOUT))
      ]);

      const result = [];
      for (const entry of worldMap.values()) {
        let totalCount = 0;
        let hasReal = false;
        for (const instanceId of entry.instanceIds) {
          const cached = instanceCache.get(instanceId);
          if (cached && cached.ok) {
            totalCount += cached.n;
            hasReal = true;
          }
        }
        // 房间总人数不应小于本站可见成员数（避免 API 抖动或跨实例聚合导致显示异常）
        if (!hasReal || totalCount < entry.count) {
          totalCount = entry.count;
        }

        result.push({
          worldName: entry.worldName,
          count: entry.count,
          friendCount: entry.friendCount,
          totalCount,
          totalCountEstimated: !hasReal || totalCount === entry.count,
          members: entry.members
        });
      }

      result.sort((a, b) => b.count - a.count);
      res.json({ worlds: result });
    } catch (e) { handleError(res, e, 'groups/worlds'); }
  });

  // ==================== 群组成员 VRChat 真实信息详情 ====================
  // 在成员名片中点击查看详情时调用，返回该成员在 VRChat 上的真实资料：
  // 头像、昵称、简介、信任等级、徽章、在线状态、当前所在世界等。
  // ============ 成员详情【阶段1：仅 DB，极速返回 ~10ms】============
  // 设计：用户点开名片时立刻看到 DB 基础信息（昵称/状态/信任等级/贡献度/活动/本站模型），
  // 不再被 VRChat API（15~30s）阻塞 spinner。VRChat 实时资料由前端渲染后异步调用
  // /detail/vrchat 局部刷新（头像/在线状态/公开模型等）。解决"加载慢、一直转圈"问题。
  router.get('/group/members/:vrchatId/detail', requireAuth, async (req, res) => {
    try {
      const { vrchatId } = req.params;
      if (!/^usr_[0-9a-fA-F-]+$/.test(vrchatId)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '非法的 VRChat 用户 ID');
      }

      const pool = getPool();
      const TRUST_RANK = { 'negative': 0, 'visitor': 1, 'new': 2, 'user': 3, 'known': 4, 'trusted': 5, 'vetted': 6, 'veteran': 7, 'legend': 8 };
      const TRUST_CN = { 'negative': '恶劣玩家', 'visitor': '游客', 'new': '新用户', 'user': '用户', 'known': '常驻玩家', 'trusted': '信任', 'vetted': '审核', 'veteran': '资深玩家', 'legend': '资深玩家' };
      const DEV_CN = { 'none': '普通用户', 'trusted': '可信开发者', 'internal': '内部人员', 'moderator': '管理员' };

      // --- DB 基础信息（并行）---
      const [rows] = await pool.query(
        `SELECT vrchat_id AS vrchatId, display_name AS displayName, avatar_url AS avatarUrl,
                profile_pic_override_thumbnail AS profilePicOverrideThumbnail, user_icon AS userIcon,
                vrchat_status AS vrchatStatus, status_description AS statusDescription,
                world_name AS worldName, location, joined_instance_at AS joinedInstanceAt,
                is_online AS isOnline, is_in_game AS isInGame,
                is_friend AS isFriend, is_vrc_plus AS isVrcPlus,
                age_verified AS ageVerified, age_verification_status AS ageVerificationStatus,
                last_login AS lastLogin, last_seen AS lastSeen, joined_at AS joinedAt,
                trust_level AS trustLevel, trust_level_cn AS trustLevelCn,
                status_trust AS statusTrust
         FROM group_roster WHERE vrchat_id = ? LIMIT 1`,
        [vrchatId]
      );
      const base = rows[0] || {
        vrchatId, displayName: '', avatarUrl: '', profilePicOverrideThumbnail: '', userIcon: '',
        vrchatStatus: 'offline', isOnline: 0, isInGame: 0, isFriend: 0, isVrcPlus: 0, ageVerified: 0,
        ageVerificationStatus: '',
      };

      // --- 本地账户（并行）---
      // V9.2: 同时返回 VRCX 风格扩展字段（pronouns / previous_display_names / last_platform）
      //   previous_display_names 是 JSON 列，MySQL 5.7 会以字符串返回，应用层安全解析
      const [localUsers] = await pool.query(
        `SELECT id, login_id, display_name, role, created_at, total_checkins,
                pronouns, previous_display_names AS previousDisplayNames,
                last_platform AS lastPlatform
         FROM users WHERE vrchat_id = ? AND deleted_at IS NULL LIMIT 1`,
        [vrchatId]
      );
      let localUser = localUsers[0] || null;
      if (localUser && typeof localUser.previousDisplayNames === 'string') {
        try { localUser.previousDisplayNames = JSON.parse(localUser.previousDisplayNames); }
        catch (_) { localUser.previousDisplayNames = []; }
      }
      if (localUser && !Array.isArray(localUser.previousDisplayNames)) {
        localUser.previousDisplayNames = [];
      }

      // --- 本地账户相关查询（依赖 localUser，并行）---
      let publicModels = 0, eventSigns = 0, recentActivity = [], localPublicModels = [];
      if (localUser) {
        const [pm] = await pool.query(
          `SELECT COUNT(*) AS c FROM collections
           WHERE user_id = ? AND kind='avatar_model' AND visibility='public' AND status='valid'`,
          [localUser.id]
        );
        const [es] = await pool.query(`SELECT COUNT(*) AS c FROM event_sign WHERE user_id = ?`, [localUser.id]);
        const [recent] = await pool.query(
          `(SELECT '活动报名' AS type, e.title AS title, es.created_at AS at
            FROM event_sign es LEFT JOIN event e ON es.event_id = e.id WHERE es.user_id = ?)
           UNION ALL
           (SELECT '活动签到' AS type, e.title AS title, ec.created_at AS at
            FROM event_checkin ec LEFT JOIN event e ON ec.event_id = e.id WHERE ec.user_id = ?)
           ORDER BY at DESC LIMIT 8`,
          [localUser.id, localUser.id]
        );
        const [models] = await pool.query(
          `SELECT id, target_id, name, thumbnail, platform, favorite_count
           FROM collections
           WHERE user_id = ? AND kind='avatar_model' AND visibility='public' AND status='valid'
           ORDER BY favorite_count DESC LIMIT 6`,
          [localUser.id]
        );
        publicModels = pm[0] ? pm[0].c : 0;
        eventSigns = es[0] ? es[0].c : 0;
        recentActivity = recent || [];
        localPublicModels = (models || []).map(m => ({
          modelId: m.target_id, name: m.name,
          authorName: base.displayName || (localUser.display_name || ''),
          thumbnailUrl: m.thumbnail || '', tags: [], createdAt: '',
          performanceRating: '', platform: m.platform || '',
          favoriteCount: m.favorite_count || '', source: 'local', url: '/collections'
        }));
      }

      // --- 活跃度 ---
      let activityLevel = 'inactive';
      const ref = base.lastSeen || base.lastLogin;
      if (ref) {
        const days = (Date.now() - new Date(ref).getTime()) / 86400000;
        if (days <= 7) activityLevel = 'active7d';
        else if (days <= 30) activityLevel = 'active30d';
      }

      // --- 服务端 VRChat 资料缓存：静态字段（简介/徽章/语言/头像等）秒开，无需等阶段2 ---
      const vrcCached = await vrcCacheRead(pool, vrchatId);
      const v = (vrcCached.data && vrcCached.age < VRC_CACHE_TTL) ? vrcCached.data : {};
      // 缓存新鲜（≤5min）时无需再补拉：前端据此跳过阶段2，省一次请求；
      // 缓存 5~30min 或缺失时 vrcPending=true，由阶段2 走 stale-while-revalidate 或实时下载回写
      const vrcPending = !(vrcCached.data && vrcCached.age < VRC_CACHE_REFRESH);

      const detail = {
        vrchatId: base.vrchatId,
        displayName: base.displayName || '',
        avatarUrl: v.avatarUrl || base.avatarUrl || '',
        profilePicOverrideThumbnail: v.profilePicOverrideThumbnail || base.profilePicOverrideThumbnail || '',
        bio: v.bio || '', bioLinks: Array.isArray(v.bioLinks) ? v.bioLinks : [],
        status: (base.vrchatStatus || 'offline'), statusDescription: base.statusDescription || '',
        userIcon: v.userIcon || base.userIcon || '',
        trustLevel: base.trustLevel || '', trustLevelCn: base.trustLevelCn || '',
        trustRank: TRUST_RANK[(base.trustLevel || '').toLowerCase()] || 0,
        developerType: v.developerType || 'none', developerTypeCn: v.developerTypeCn || '普通用户',
        badges: Array.isArray(v.badges) ? v.badges : [],
        worldName: base.worldName || '', location: base.location || '', instance: null,
        isOnline: !!base.isOnline, isFriend: !!base.isFriend, isVrcPlus: !!base.isVrcPlus,
        ageVerified: !!base.ageVerified, ageVerificationStatus: base.ageVerificationStatus || '',
        lastLogin: base.lastLogin || null, lastSeen: base.lastSeen || null, platform: v.platform || '',
        representedGroup: v.representedGroup || null, languages: Array.isArray(v.languages) ? v.languages : [],
        pronouns: v.pronouns || '', dateJoined: v.dateJoined || '',
        allowAvatarCopying: (typeof v.allowAvatarCopying === 'boolean') ? v.allowAvatarCopying : null,
        bannerColor: v.bannerColor || '', bannerType: v.bannerType || '',
        joinedAt: base.joinedAt || null, activityLevel: activityLevel,
        localUser: localUser ? {
          bound: true, loginId: localUser.login_id, displayName: localUser.display_name,
          role: localUser.role, registeredAt: localUser.created_at,
          totalCheckins: localUser.total_checkins || 0
        } : { bound: false },
        contribution: {
          publicModels: publicModels, eventSigns: eventSigns,
          totalCheckins: localUser ? (localUser.total_checkins || 0) : 0
        },
        recentActivity: recentActivity, publicModels: localPublicModels,
        // 标记：实时 VRChat 资料是否需异步补拉（新鲜缓存则 false，跳过阶段2）
        vrcPending: vrcPending
      };

      // 立即返回 DB 数据（~10ms），spinner 立刻消失
      res.json({ detail, vrcPending });
    } catch (e) { handleError(res, e, 'groups/members-detail'); }
  });

  // ==================== VRChat 资料服务端缓存（详情秒开） ====================
  // 把阶段2 实时拉取的 VRChat 用户资料（简介/徽章/公开模型等）缓存到 group_member_vrc_cache。
  // 玩家点开详情先返回 DB 缓存、后台再刷新，避免每次都等 VRChat API（15~30s）。
  const VRC_CACHE_TTL = 30 * 60 * 1000;     // 缓存 30 分钟过期
  const VRC_CACHE_REFRESH = 5 * 60 * 1000;  // 缓存超过 5 分钟即后台静默刷新（stale-while-revalidate）

  function vrcCacheWrite(pool, vrchatId, data) {
    return pool.query(
      `INSERT INTO group_member_vrc_cache (vrchat_id, data, updated_at)
       VALUES (?, ?, NOW())
       ON DUPLICATE KEY UPDATE data = VALUES(data), updated_at = NOW()`,
      [vrchatId, JSON.stringify(data)]
    );
  }

  async function vrcCacheRead(pool, vrchatId) {
    try {
      const [rows] = await pool.query(
        `SELECT data, updated_at FROM group_member_vrc_cache WHERE vrchat_id = ?`, [vrchatId]
      );
      if (!rows[0] || !rows[0].data) return { data: null, age: Infinity };
      const data = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
      const age = rows[0].updated_at ? (Date.now() - new Date(rows[0].updated_at).getTime()) : Infinity;
      return { data, age };
    } catch { return { data: null, age: Infinity }; }
  }

  // 实时拉取 VRChat 用户核心资料（不含公开模型）。返回 { data, ok, cookie, displayName }。
  // ok=false 表示未拉到真实资料（不写缓存）。公开模型由后台任务补拉，不阻塞主响应
  // （国内访问 VRChat API 慢，users + avatars 串行可达 12~30s，必须拆开）。
  async function fetchVrcCore(vrchatId, req) {
    const TRUST_RANK = { 'negative': 0, 'visitor': 1, 'new': 2, 'user': 3, 'known': 4, 'trusted': 5, 'vetted': 6, 'veteran': 7, 'legend': 8 };
    const TRUST_CN = { 'negative': '恶劣玩家', 'visitor': '游客', 'new': '新用户', 'user': '用户', 'known': '常驻玩家', 'trusted': '信任', 'vetted': '审核', 'veteran': '资深玩家', 'legend': '资深玩家' };
    const DEV_CN = { 'none': '普通用户', 'trusted': '可信开发者', 'internal': '内部人员', 'moderator': '管理员' };

    const vrcFetch = async (cookie) => {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 5000); // 5s 快速失败，避免详情实时资料拖到十几秒
      try {
        const r = await fetch(`${VRC_API}/users/${encodeURIComponent(vrchatId)}?apiKey=${VRC_API_KEY}`, {
          headers: { 'User-Agent': USER_AGENT, 'Cookie': cookie },
          signal: ac.signal
        });
        if (!r.ok) return { status: r.status, data: null };
        return { status: r.status, data: await r.json() };
      } catch { return { status: 0, data: null }; }
      finally { clearTimeout(t); }
    };
    const { cookie: vrcCookie, result: vrc } = await vrcWithFallback(req, (c) => vrcFetch(c));
    const user = vrc?.data;

    const vrcData = {
      displayName: '', avatarUrl: '', profilePicOverrideThumbnail: '', userIcon: '',
      bio: '', bioLinks: [], status: '', statusDescription: '',
      trustLevel: '', trustLevelCn: '', trustRank: 0,
      developerType: 'none', developerTypeCn: '普通用户', badges: [],
      platform: '', location: '', instance: null,
      isVrcPlus: false, ageVerified: false, ageVerificationStatus: '',
      representedGroup: null, languages: [], pronouns: '', dateJoined: '',
      allowAvatarCopying: null, bannerColor: '', bannerType: '',
      hasVrcPublicModels: false, publicModels: []
    };

    if (!user) return { data: vrcData, ok: false, cookie: null, displayName: '' };

    vrcData.displayName = user.displayName || '';
    vrcData.avatarUrl = user.currentAvatarThumbnailImageUrl || user.profilePicOverrideThumbnail || '';
    vrcData.profilePicOverrideThumbnail = user.profilePicOverrideThumbnail || '';
    vrcData.userIcon = user.userIcon || '';
    vrcData.bio = user.bio || '';
    vrcData.bioLinks = Array.isArray(user.bioLinks) ? user.bioLinks : [];
    vrcData.status = user.status || '';
    vrcData.statusDescription = user.statusDescription || '';
    vrcData.trustLevel = user.trustLevel || '';
    vrcData.trustLevelCn = TRUST_CN[user.trustLevel] || user.trustLevel || '';
    vrcData.trustRank = TRUST_RANK[(user.trustLevel || '').toLowerCase()] || 0;
    vrcData.developerType = user.developerType || 'none';
    vrcData.developerTypeCn = DEV_CN[user.developerType] || DEV_CN['none'];
    vrcData.platform = user.last_platform || '';
    vrcData.location = user.location || '';
    vrcData.instance = parseVrcLocation(user.location || '');
    vrcData.isVrcPlus = Array.isArray(user.tags) && user.tags.includes('system_supporter');
    vrcData.ageVerified = user.ageVerified === true;
    vrcData.ageVerificationStatus = user.ageVerificationStatus || '';
    if (user.profile && user.profile.representedGroup) {
      const rg = user.profile.representedGroup;
      vrcData.representedGroup = { id: rg.id || '', name: rg.name || '', iconUrl: rg.iconUrl || '' };
    }
    if (user.profile) {
      if (Array.isArray(user.profile.languages)) vrcData.languages = user.profile.languages.filter(Boolean);
      if (user.profile.pronouns) vrcData.pronouns = user.profile.pronouns;
      if (user.profile.bannerColor) vrcData.bannerColor = user.profile.bannerColor;
      if (user.profile.bannerType) vrcData.bannerType = user.profile.bannerType;
    }
    if (user.date_joined) vrcData.dateJoined = user.date_joined;
    if (typeof user.allowAvatarCopying === 'boolean') vrcData.allowAvatarCopying = user.allowAvatarCopying;
    if (Array.isArray(user.tags)) {
      vrcData.badges = user.tags.filter(t => /^system_/.test(t)).map(t => t.replace(/^system_/, '').replace(/_/g, ' '));
    }

    return { data: vrcData, ok: true, cookie: vrcCookie, displayName: user.displayName || '' };
  }

  // 拉取 VRChat 公开模型（后台执行，失败返回 { models: [], ok: false }，不抛异常）
  async function fetchVrcModels(vrchatId, cookie, displayName) {
    try {
      if (!cookie) return { models: [], ok: false };
      const avRes = await vrchatGetUserPublicAvatars(vrchatId, cookie, 12);
      if (!avRes || avRes.status !== 200 || !Array.isArray(avRes.data)) return { models: [], ok: false };
      const models = avRes.data
        .filter(a => a && a.id)
        .map(a => ({
          modelId: a.id, name: a.name || '未命名模型',
          authorName: a.authorName || displayName || '',
          thumbnailUrl: a.thumbnailImageUrl || '',
          tags: Array.isArray(a.tags) ? a.tags.filter(t => !/^(author_|language_|system_|admin_)/.test(t)) : [],
          createdAt: a.created_at || '', performanceRating: a.performanceRating || '',
          platform: a.platform || (a.unityVersion ? 'PC' : ''),
          favoriteCount: (typeof a.favoriteCount === 'number') ? a.favoriteCount : '',
          assetUrl: a.assetUrl || '', unityVersion: a.unityVersion || '',
          description: a.description || '', source: 'vrchat',
          url: 'https://vrchat.com/home/avatar/' + (a.id || '')
        }));
      return { models, ok: true };
    } catch (modelErr) {
      console.warn('[groups/vrchat] 拉取公开模型失败，已忽略:', modelErr && modelErr.message);
      return { models: [], ok: false };
    }
  }

  // 全量（核心资料 + 公开模型）——供后台刷新路径使用，不参与主响应
  async function fetchVrcData(vrchatId, req) {
    const core = await fetchVrcCore(vrchatId, req);
    if (!core.ok) return { data: core.data, ok: false };
    const m = await fetchVrcModels(vrchatId, core.cookie, core.displayName);
    const full = Object.assign({}, core.data, {
      hasVrcPublicModels: (m.models || []).length > 0,
      publicModels: m.models || []
    });
    return { data: full, ok: true };
  }

  // ============ 成员详情【阶段2：VRChat 实时资料，异步补拉】============
  // 前端在阶段1渲染后调用。优先返回 DB 缓存（秒开），缓存过期/缺失时实时拉取并回写。
  router.get('/group/members/:vrchatId/vrchat', requireAuth, async (req, res) => {
    try {
      const { vrchatId } = req.params;
      if (!/^usr_[0-9a-fA-F-]+$/.test(vrchatId)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '非法的 VRChat 用户 ID');
      }
      const pool = getPool();

      // 1) 先查服务端缓存：未过期直接返回，必要时后台静默刷新
      const cached = await vrcCacheRead(pool, vrchatId);
      if (cached.data && cached.age < VRC_CACHE_TTL) {
        res.json({ vrc: cached.data, cached: true });
        if (cached.age > VRC_CACHE_REFRESH && !vrcRefreshInFlight.has(vrchatId)) {
          // stale-while-revalidate：缓存稍旧 → 后台刷新回写，不阻塞本次响应。
          // 加 in-flight 去重：同一玩家在过期窗口内被并发请求时只拉一次 VRChat API。
          vrcRefreshInFlight.add(vrchatId);
          setImmediate(() => {
            fetchVrcData(vrchatId, req)
              .then(r => { if (r && r.ok) return vrcCacheWrite(pool, vrchatId, r.data); })
              .catch(() => {})
              .finally(() => vrcRefreshInFlight.delete(vrchatId));
          });
        }
        return;
      }

      // 2) 缓存未命中/过期：主响应只等核心资料（≤5s，通常 1~2s），公开模型后台补拉回写
      const core = await fetchVrcCore(vrchatId, req);
      res.json({ vrc: core.data, cached: false, modelsPending: true });
      if (core.ok) {
        const modelKey = vrchatId + ':models';
        if (!vrcRefreshInFlight.has(modelKey)) {
          vrcRefreshInFlight.add(modelKey);
          setImmediate(() => {
            fetchVrcModels(vrchatId, core.cookie, core.displayName)
              .then(m => {
                const full = Object.assign({}, core.data, {
                  hasVrcPublicModels: (m.models || []).length > 0,
                  publicModels: m.models || []
                });
                return vrcCacheWrite(pool, vrchatId, full);
              })
              .catch(e => console.warn('[groups/vrchat] 后台补拉模型失败:', e && e.message))
              .finally(() => vrcRefreshInFlight.delete(modelKey));
          });
        }
      }
    } catch (e) { handleError(res, e, 'groups/members-vrchat'); }
  });

  // ==================== 成员状态变化实时推送（供内部使用） ====================
  router.get('/group/members/snapshot', requireAuth, async (req, res) => {
    try {
      const pool = getPool();
      const [online] = await pool.query(`SELECT vrchat_id AS vrchatId, display_name AS displayName, avatar_url AS avatarUrl, vrchat_status AS status, world_name AS worldName FROM group_roster WHERE is_member=1 AND is_online=1 ORDER BY last_seen DESC`);
      const [offline] = await pool.query(`SELECT vrchat_id AS vrchatId, display_name AS displayName, avatar_url AS avatarUrl, vrchat_status AS status, last_login AS lastLogin FROM group_roster WHERE is_member=1 AND is_online=0 ORDER BY last_login DESC LIMIT 20`);
      
      res.json({
        online: online.map(m => ({
          vrchatId: m.vrchatId,
          displayName: m.displayName,
          avatarUrl: m.avatarUrl,
          status: m.status,
          worldName: m.worldName
        })),
        offline: offline.map(m => ({
          vrchatId: m.vrchatId,
          displayName: m.displayName,
          avatarUrl: m.avatarUrl,
          status: m.status,
          lastLogin: m.lastLogin
        }))
      });
    } catch (e) { handleError(res, e, 'groups/snapshot'); }
  });

  

  // ==================== VRChat账号状态检测 ====================
  router.post('/vrc/status/check', requireAdminCompat, async (req, res) => {
    try {
      const { vrchatId } = req.body;
      if (!vrchatId) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '缺少VRChat ID');
      
      const vrcCookie = getVRCCookieFn(req);
      if (!vrcCookie) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, 'VRChat系统账号未登录');
      
      const userRes = await vrchatRequest('GET', `/users/${vrchatId}?apiKey=${VRC_API_KEY}`, null, vrcCookie);
      let status = 'unknown';
      let errorMsg = '';
      
      if (userRes.status === 200) {
        const user = userRes.data;
        if (user.isBanned) {
          status = 'banned';
          errorMsg = '账号已被封禁';
        } else if (user.currentInstance === null && user.last_login) {
          status = 'offline';
        } else {
          status = 'valid';
        }
        await getPool().query(
          'INSERT INTO vrc_account_status (vrchat_id, display_name, status, last_check, error_msg) VALUES (?, ?, ?, NOW(), ?) ON DUPLICATE KEY UPDATE display_name=?, status=?, last_check=NOW(), error_msg=?',
          [vrchatId, user.displayName || '', status, errorMsg, user.displayName || '', status, errorMsg]
        );
      } else {
        status = 'invalid';
        errorMsg = '账号不存在或无法访问';
        await getPool().query(
          'INSERT INTO vrc_account_status (vrchat_id, display_name, status, last_check, error_msg) VALUES (?, ?, ?, NOW(), ?) ON DUPLICATE KEY UPDATE status=?, last_check=NOW(), error_msg=?',
          [vrchatId, '', status, errorMsg, status, errorMsg]
        );
      }
      
      res.json({ success: true, vrchatId, status, errorMsg });
    } catch (e) { handleError(res, e, 'groups/status-check'); }
  });

  router.post('/vrc/status/batch-check', requireAdminCompat, async (req, res) => {
    try {
      const { vrchatIds } = req.body;
      if (!Array.isArray(vrchatIds) || vrchatIds.length === 0) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '缺少VRChat ID列表');
      
      const vrcCookie = getVRCCookieFn(req);
      if (!vrcCookie) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, 'VRChat系统账号未登录');
      
      const results = [];
      for (const vrchatId of vrchatIds.slice(0, 50)) {
          await sleep(200);
        try {
          const userRes = await vrchatRequest('GET', `/users/${vrchatId}?apiKey=${VRC_API_KEY}`, null, vrcCookie);
          let status = 'unknown';
          let errorMsg = '';
          
          if (userRes.status === 200) {
            const user = userRes.data;
            if (user.isBanned) {
              status = 'banned';
              errorMsg = '账号已被封禁';
            } else {
              status = 'valid';
            }
            await getPool().query(
              'INSERT INTO vrc_account_status (vrchat_id, display_name, status, last_check, error_msg) VALUES (?, ?, ?, NOW(), ?) ON DUPLICATE KEY UPDATE display_name=?, status=?, last_check=NOW(), error_msg=?',
              [vrchatId, user.displayName || '', status, errorMsg, user.displayName || '', status, errorMsg]
            );
          } else {
            status = 'invalid';
            errorMsg = '账号不存在';
            await getPool().query(
              'INSERT INTO vrc_account_status (vrchat_id, display_name, status, last_check, error_msg) VALUES (?, ?, ?, NOW(), ?) ON DUPLICATE KEY UPDATE status=?, last_check=NOW(), error_msg=?',
              [vrchatId, '', status, errorMsg, status, errorMsg]
            );
          }
          results.push({ vrchatId, status, errorMsg });
        } catch (e) {
          results.push({ vrchatId, status: 'error', errorMsg: e.message });
        }
      }
      
      res.json({ success: true, results });
    } catch (e) { handleError(res, e, 'groups/batch-status'); }
  });

  router.get('/vrc/status/list', requireAdminCompat, async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const pageSize = parseInt(req.query.pageSize) || 20;
      const offset = (page - 1) * pageSize;
      const statusFilter = req.query.status ? req.query.status.trim() : '';
      
      let where = '1=1';
      const params = [];
      if (statusFilter) {
        where += ' AND status = ?';
        params.push(statusFilter);
      }
      params.push(pageSize, offset);
      
      const [rows] = await getPool().query(
        `SELECT vrchat_id AS vrchatId, display_name AS displayName, status, last_check AS lastCheck, error_msg AS errorMsg FROM vrc_account_status WHERE ${where} ORDER BY last_check DESC LIMIT ? OFFSET ?`,
        params
      );
      const [count] = await getPool().query(`SELECT COUNT(*) as total FROM vrc_account_status WHERE ${where}`, params.slice(0, -2));
      
      res.json({ statuses: rows, total: count[0].total, page, pageSize });
    } catch (e) { handleError(res, e, 'groups/status-list'); }
  });


  // ==================== 批量邀请功能 ====================
  router.post('/group/invites/batch', requireAdminCompat, async (req, res) => {
    try {
      const { vrchatIds, message } = req.body;
      if (!Array.isArray(vrchatIds) || vrchatIds.length === 0) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '缺少VRChat ID列表');
      
      const vrcCookie = getVRCCookieFn(req);
      if (!vrcCookie) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, 'VRChat系统账号未登录');
      
      const inviterId = req.session.userId;
      const inviterName = req.session.displayName || '管理员';
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const results = [];
      
      for (const vrchatId of vrchatIds.slice(0, 100)) {
          await sleep(200);
        try {
          const [existingMember] = await getPool().query(`SELECT id FROM group_roster WHERE vrchat_id=? AND is_member=1`, [vrchatId]);
          if (existingMember.length > 0) {
            results.push({ vrchatId, status: 'already_member', message: '已是群成员' });
            continue;
          }
          
          const [existingInvite] = await getPool().query(`SELECT id FROM group_invites WHERE vrchat_id=? AND status='pending'`, [vrchatId]);
          if (existingInvite.length > 0) {
            results.push({ vrchatId, status: 'pending_invite', message: '已有待处理邀请' });
            continue;
          }
          
          const userRes = await vrchatRequest('GET', `/users/${vrchatId}?apiKey=${VRC_API_KEY}`, null, vrcCookie);
          const vrchatName = userRes.status === 200 ? userRes.data.displayName || '' : '';
          
          await getPool().query(
            'INSERT INTO group_invites (vrchat_id, vrchat_name, inviter_id, inviter_name, status, message, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [vrchatId, vrchatName, inviterId, inviterName, 'pending', message || '', expiresAt]
          );
          
          results.push({ vrchatId, status: 'invited', message: '邀请已发送' });
        } catch (e) {
          results.push({ vrchatId, status: 'error', message: e.message });
        }
      }
      
      await logOper(req.session.userId, '批量邀请', `邀请人数: ${vrchatIds.length}`);
      res.json({ success: true, results });
    } catch (e) { handleError(res, e, 'groups/batch-invite'); }
  });

  router.get('/group/invites', requireAdminCompat, async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const pageSize = parseInt(req.query.pageSize) || 20;
      const offset = (page - 1) * pageSize;
      const statusFilter = req.query.status ? req.query.status.trim() : '';
      
      let where = '1=1';
      const params = [];
      if (statusFilter) {
        where += ' AND status = ?';
        params.push(statusFilter);
      }
      params.push(pageSize, offset);
      
      const [rows] = await getPool().query(
        `SELECT id, vrchat_id AS vrchatId, vrchat_name AS vrchatName, inviter_id AS inviterId, inviter_name AS inviterName, status, message, expires_at AS expiresAt, created_at AS createdAt, responded_at AS respondedAt FROM group_invites WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        params
      );
      const [count] = await getPool().query(`SELECT COUNT(*) as total FROM group_invites WHERE ${where}`, params.slice(0, -2));
      
      res.json({ invites: rows, total: count[0].total, page, pageSize });
    } catch (e) { handleError(res, e, 'groups/invites-list'); }
  });

  router.post('/group/invites/:id/accept', async (req, res) => {
    try {
      const uid = req.session?.userId;
      if (!uid) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, '请先登录');
      
      const [invite] = await getPool().query(`SELECT * FROM group_invites WHERE id = ? AND status = 'pending' AND expires_at > NOW()`, [req.params.id]);
      if (invite.length === 0) return sendError(res, 404, ErrorCodes.NOT_FOUND, '邀请不存在或已过期');
      
      const vrcId = req.session.vrchat_id;
      if (!vrcId || vrcId !== invite[0].vrchat_id) return sendError(res, 403, ErrorCodes.FORBIDDEN, '无权接受此邀请');
      
      await getPool().query(`UPDATE group_invites SET status = 'accepted', responded_at = NOW() WHERE id = ?`, [req.params.id]);
      
      await getPool().query(
        `INSERT IGNORE INTO group_roster (vrchat_id, vrchat_name, is_member, joined_at) VALUES (?, ?, 1, NOW())`,
        [invite[0].vrchat_id, invite[0].vrchat_name]
      );
      
      res.json({ success: true });
    } catch (e) { handleError(res, e, 'groups/invite-accept'); }
  });

  router.post('/group/invites/:id/reject', async (req, res) => {
    try {
      const uid = req.session?.userId;
      if (!uid) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, '请先登录');
      
      const [invite] = await getPool().query(`SELECT * FROM group_invites WHERE id = ? AND status = 'pending' AND expires_at > NOW()`, [req.params.id]);
      if (invite.length === 0) return sendError(res, 404, ErrorCodes.NOT_FOUND, '邀请不存在或已过期');
      
      const vrcId = req.session.vrchat_id;
      if (!vrcId || vrcId !== invite[0].vrchat_id) return sendError(res, 403, ErrorCodes.FORBIDDEN, '无权拒绝此邀请');
      
      await getPool().query(`UPDATE group_invites SET status = 'rejected', responded_at = NOW() WHERE id = ?`, [req.params.id]);
      res.json({ success: true });
    } catch (e) { handleError(res, e, 'groups/invite-reject'); }
  });

  router.get('/group/invites/my', requireAuth, async (req, res) => {
    try {
      const uid = req.session?.userId;
      if (!uid) return sendError(res, 401, ErrorCodes.UNAUTHORIZED, '请先登录');
      
      const vrcId = req.session.vrchat_id;
      if (!vrcId) return res.json({ invites: [] });
      
      const [rows] = await getPool().query(
        `SELECT id, vrchat_id AS vrchatId, vrchat_name AS vrchatName, inviter_id AS inviterId, inviter_name AS inviterName, status, message, expires_at AS expiresAt, created_at AS createdAt FROM group_invites WHERE vrchat_id = ? AND status = 'pending' ORDER BY created_at DESC`,
        [vrcId]
      );
      
      res.json({ invites: rows });
    } catch (e) { handleError(res, e, 'groups/my-invites'); }
  });
return router;
};
