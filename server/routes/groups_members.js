/**
 * 境途同游 V6.14 — VRChat 群组成员名册路由
 * 成员列表 / 变更记录 / 同步日志 / 花名册登记 / 入群检查 / 统计 / 成员所在世界
 *
 * P2-66：自 groups.js 按域拆出（原 L643–911），行为逐字保留。
 *
 * @swagger
 * tags:
 *   name: GroupsMembers
 *   description: VRChat群组名册与统计接口
 */
const express = require('express');
const { ok, getPool, handleError, sendError, ErrorCodes, paginate, escapeLike } = require('../utils');
const { requireAuth, requireAdminCompat } = require('../auth');
const { vrchatGetInstance } = require('../vrc');
const logger = require('../logger');
const { vrcWithFallback } = require('./groups_helpers');
const { getCachedWorld } = require('../world_cache');

const VRC = require('../vrc');
const VRC_INSTANCE_PATTERN = VRC.VRC_INSTANCE_PATTERN || /^wrld_[0-9a-fA-F-]+:.+$/;

module.exports = function (getVRCCookieFn, GROUP_ID, getUserVRCCookieFn) {
  const router = express.Router();

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
        sql += ` AND (LOWER(display_name) LIKE ? ESCAPE '!' OR LOWER(vrchat_name) LIKE ? ESCAPE '!' OR LOWER(vrchat_id) LIKE ? ESCAPE '!')`;
        const like = `%${escapeLike(search.toLowerCase())}%`;
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
      const { pageSize: limit } = paginate(req, { sizeParam: 'limit', defaultSize: 30, maxSize: 100 });
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
      ok(res);
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
          location: member.location || '',
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
          const { result } = await vrcWithFallback(req, (c) => vrchatGetInstance(instanceId, c), getVRCCookieFn, getUserVRCCookieFn);
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

      // P2-99：group_roster.world_name 存的是 VRCX location 首段——通常是 wrld_ 裸 ID 而非世界名，
      // 面板头会显示 ID。这里接 world_cache 批量富化真实名称/缩略图：
      // 缓存（vrc_worlds_cache，24h）命中零回源；miss 才回源 VRChat，与收藏富化同口径：并发 5、冷回源预算 25。
      const WRID_PATTERN = /^wrld_[0-9a-fA-F-]+$/i;
      const enrichQueue = [];
      for (const entry of worldMap.values()) {
        if (WRID_PATTERN.test(entry.worldName) && !enrichQueue.includes(entry.worldName)) {
          enrichQueue.push(entry.worldName);
        }
      }
      enrichQueue.splice(25); // 单次请求冷回源上限，超额条目维持裸 ID 展示
      const worldMetaMap = new Map();
      let enrichCursor = 0;
      async function enrichWorker() {
        while (enrichCursor < enrichQueue.length) {
          const worldId = enrichQueue[enrichCursor++];
          try {
            const { result } = await vrcWithFallback(req, (c) => getCachedWorld(worldId, c), getVRCCookieFn, getUserVRCCookieFn);
            const w = result && typeof result === 'object' && (result.name || result.imageUrl) ? result : null;
            if (w) {
              worldMetaMap.set(worldId, {
                name: w.name || '',
                image: w.imageUrl || w.thumbnailImageUrl || (w.thumbnail && w.thumbnail.url) || ''
              });
            }
          } catch (err) {
            logger.warn(`[groups/worlds] 世界信息富化失败 ${worldId}: ${err.message || err}`);
          }
        }
      }
      const enrich = Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, enrichQueue.length) }, () => enrichWorker())
      );

      await Promise.all([
        Promise.race([drain, new Promise(r => setTimeout(() => r('timeout'), INSTANCE_TOTAL_TIMEOUT))]),
        // 富化以 DB 缓存读为主，整体限时 6s：超时后未完成的世界按裸 ID 展示，不拖慢接口返回
        Promise.race([enrich, new Promise(r => setTimeout(() => r('timeout'), 6000))])
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

        const meta = WRID_PATTERN.test(entry.worldName) ? worldMetaMap.get(entry.worldName) : null;
        result.push({
          worldName: entry.worldName,
          worldId: WRID_PATTERN.test(entry.worldName) ? entry.worldName : '',
          worldDisplayName: (meta && meta.name) || entry.worldName,
          worldImageUrl: (meta && meta.image) || '',
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

  return router;
};
