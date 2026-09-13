/**
 * 境途同游 V6.14 — VRChat 群组成员同步路由
 * 全量同步 / 在线状态刷新 / 群友互助 presence 上报
 *
 * P2-66：自 groups.js 按域拆出（原 L261–642），行为逐字保留。
 *
 * @swagger
 * tags:
 *   name: GroupsMembersSync
 *   description: VRChat群组成员同步接口
 */
const express = require('express');
const { fail, ok, getPool, handleError, sendVrcError, ErrorCodes } = require('../utils');
const { requireAuth } = require('../auth');
const {
  vrchatGetCurrentUserResult, vrchatGetGroupMembers,
  vrchatGetUser, vrchatResolveOnlineStatuses, vrchatGetFriendsOnlineMap
} = require('../vrc');
const logger = require('../logger');
const schedule = require('../schedule');
const { sleep, vrcWithFallback } = require('./groups_helpers');

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

  // ==================== 全面同步群组成员 ====================
  router.post('/group/members/sync', requireAuth, async (req, res) => {
    if (!getVRCCookieFn(req)) {
      return fail(res, 401, '缺少可用的 VRChat 登录状态', { detail: '请先在个人中心绑定您的 VRChat 账号，或在管理面板的"系统 VRChat 账号"卡片中登录系统账号', code: 'VRC_SYSTEM_OFFLINE' });
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
      return fail(res, 429, '同步冷却中', { detail: `距离上次群组同步还需约 ${Math.ceil(retryAfterSec / 60)} 分钟，请稍后再试`, code: 'SYNC_COOLDOWN', retryAfterSec });
    }
    // 同一时刻只允许一次全量同步。前端曾因 api() 的 10 秒超时而看起来"没反应"，
    // 用户会反复点击；并发的同步会各自 `UPDATE ... is_member=0` 再补回，
    // 互相看到对方的中间态，往 group_member_changes 里写出大量假的"已离开群组"记录。
    if (syncInFlight) {
      return fail(res, 409, '同步正在进行中', { detail: '上一次群组同步还没结束，请等它完成后再试', code: ErrorCodes.CONFLICT });
    }
    syncInFlight = true;
    lastSyncByUser.set(syncUserKey, Date.now());
    try {
      const { cookie: vrcCookie, result: meRes } =
        await vrcWithFallback(req, (c) => vrchatGetCurrentUserResult(c), getVRCCookieFn, getUserVRCCookieFn);
      // 401 = cookie 真的过期了；其它非 2xx = VRChat 上游故障（限流/维护），
      // 两者必须分开报，否则用户会被误导去重新绑定，而且上一版还会顺手清掉绑定。
      if (!meRes || meRes.status === 401) {
        return fail(res, 401, 'VRChat 登录已过期', { detail: '请在管理面板重新登录系统 VRChat 账号，或在个人中心重新绑定您的 VRChat 账号', code: 'VRC_COOKIE_EXPIRED' });
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
      ok(res, { total: allMembers.length, joined: joinedCount, left: leftCount, updated: updatedCount });
    } catch (e) {
      if (conn) { try { await conn.rollback(); } catch {} }
      try { await getPool().query(`INSERT INTO group_sync_log (sync_type, total_members, success, error_msg) VALUES ('full', 0, 0, ?)`, [e.message]); } catch {}
      // VRChat 限流排队超时：这不是"服务器内部错误"，而是上游繁忙，返回 503 让前端明确提示稍后重试。
      if (e?.code === 'VRC_RATE_TIMEOUT') {
        logger.warn('groups', 'sync 遭遇 VRChat 限流排队超时，本次同步未执行');
        return fail(res, 503, 'VRChat 接口当前繁忙（限流），请稍后重试', { code: 'VRC_RATE_LIMITED' });
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
      return fail(res, 429, '刷新太频繁', { detail: `在线状态刷新太频繁，请 ${retryAfterSec} 秒后再试`, code: 'SYNC_COOLDOWN', retryAfterSec });
    }
    if (!getVRCCookieFn(req)) {
      return fail(res, 401, '请先在个人中心绑定VRChat账号，或由管理员在后台登录VRChat系统账号', { code: 'VRC_SYSTEM_OFFLINE' });
    }
    lastRefreshByUser.set(refreshUserKey, nowMs);
    const pool = getPool();
    try {
      const [members] = await pool.query(`SELECT vrchat_id, vrchat_name, avatar_url FROM group_roster WHERE is_member=1`);
      if (members.length === 0) return ok(res, { online: 0, offline: 0, total: 0 });

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
        }, getVRCCookieFn, getUserVRCCookieFn);

        if (!vrcCookie) {
          return fail(res, 401, '请先在个人中心绑定VRChat账号，或由管理员在后台登录VRChat系统账号', { code: 'VRC_SYSTEM_OFFLINE' });
        }
        if (onlineResult?.status === 401) {
          return fail(res, 401, 'VRChat 账号登录已过期，请重新绑定或在管理面板重新登录系统账号', { code: 'VRC_COOKIE_EXPIRED' });
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

      ok(res, { degraded, online: onlineCount, offline: offlineCount, total: members.length, updated: updatedCount, results });
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
      }, getVRCCookieFn, getUserVRCCookieFn);
      if (!cookie) {
        return fail(res, 401, 'VRChat 账号未绑定或已过期', { code: 'VRC_SYSTEM_OFFLINE' });
      }
      const shared = result && result.shared !== undefined ? result.shared : 0;
      ok(res, { shared });
    } catch (e) {
      // 贡献是增强特性，失败不应阻断主流程（如 VRChat 限流 / cookie 过期）
      logger.warn('groups', 'presence/contribute 失败', e.message);
      ok(res, { shared: 0, skipped: true });
    }
  });

  return router;
};
