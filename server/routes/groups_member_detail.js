/**
 * 境途同游 V6.14 — VRChat 群组成员详情路由
 * 成员本地详情 / VRChat 真实资料（stale-while-revalidate 缓存）/ 成员快照
 *
 * P2-66：自 groups.js 按域拆出（原 L912–1290），行为逐字保留。
 *
 * @swagger
 * tags:
 *   name: GroupsMemberDetail
 *   description: VRChat群组成员详情与资料缓存接口
 */
const express = require('express');
const logger = require('../logger');
const { getPool, handleError, sendError, ErrorCodes } = require('../utils');
const { requireAuth } = require('../auth');
const { vrchatGetUserPublicAvatars, vrchatGetUser } = require('../vrc');
const { parseVrcLocation, vrcWithFallback } = require('./groups_helpers');

module.exports = function (getVRCCookieFn, GROUP_ID, getUserVRCCookieFn) {
  const router = express.Router();

  // 后台 VRChat 资料刷新去重：同一玩家在缓存过期窗口内被并发请求时，只拉一次 API。
  const vrcRefreshInFlight = new Set();

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

      // --- DB 基础信息（并行）---
      const [rows] = await pool.query(
        `SELECT vrchat_id AS vrchatId, display_name AS displayName, avatar_url AS avatarUrl,
                avatar_id AS avatarId,
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
        vrchatId, displayName: '', avatarUrl: '', avatarId: '', profilePicOverrideThumbnail: '', userIcon: '',
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
        // F-16: 当前使用的头像 ID（avtr_xxx，来自定时任务写回的 group_roster.avatar_id），前端标签/收藏的键
        avatarId: base.avatarId || '',
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
          bound: true, id: localUser.id, loginId: localUser.login_id, displayName: localUser.display_name,
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
  const VRC_CACHE_TTL = 30 * 60 * 1000;     
  const VRC_CACHE_REFRESH = 5 * 60 * 1000;  

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

    // P1-34: 改走 vrchatGetUser，汇入全站统一令牌桶（旧裸 fetch 是旁路，
    // 且复用 vrchatRequest 的超时控制与 429 退避），保持 {status, data} 语义。
    const vrcFetch = async (cookie) => {
      try {
        const r = await vrchatGetUser(vrchatId, cookie);
        return { status: r.status, data: (r.status >= 200 && r.status < 300) ? r.data : null };
      } catch { return { status: 0, data: null }; }
    };
    const { cookie: vrcCookie, result: vrc } = await vrcWithFallback(req, (c) => vrcFetch(c), getVRCCookieFn, getUserVRCCookieFn);
    const user = vrc?.data;

    const vrcData = {
      displayName: '', avatarUrl: '', profilePicOverrideThumbnail: '', userIcon: '',
      bio: '', bioLinks: [], status: '', statusDescription: '',
      trustLevel: '', trustLevelCn: '', trustRank: 0,
      developerType: 'none', developerTypeCn: '普通用户', badges: [],
      platform: '', location: '', instance: null,
      isVrcPlus: false, isTroll: false, ageVerified: false, ageVerificationStatus: '',
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
    // F-7: troll 判定（与 vrc.js 好友/用户查询口径一致：system_troll 或 admin_troll_roll）
    vrcData.isTroll = Array.isArray(user.tags) && (user.tags.includes('system_troll') || user.tags.includes('admin_troll_roll'));
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
      logger.warn('groups-member-detail', '[groups/vrchat] 拉取公开模型失败，已忽略:', modelErr && modelErr.message);
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

      // P1-46: 只允许查询本群成员（group_roster）或本人绑定的 VRChat ID，
      // 杜绝注册站内账号后借系统账号 cookie 批量枚举任意 VRChat 玩家实时资料并写缓存。
      const isSelf = req.session && req.session.vrchatId === vrchatId;
      if (!isSelf) {
        const [[rosterRow]] = await pool.query(
          `SELECT 1 FROM group_roster WHERE vrchat_id = ? AND is_member = 1 LIMIT 1`,
          [vrchatId]
        );
        if (!rosterRow) {
          return sendError(res, 403, ErrorCodes.FORBIDDEN, '仅群成员可查询 VRChat 实时资料');
        }
      }

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
              .catch(e => logger.warn('groups-member-detail', '[groups/vrchat] 后台补拉模型失败:', e && e.message))
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

  

  return router;
};
