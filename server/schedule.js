const schedule = require('node-schedule');
const fs = require('fs');
const path = require('path');
const dbMod = require('./db');
const { getPool, safeError } = require('./utils');
const { vrchatGetUser, vrchatResolveOnlineStatuses } = require('./vrc');
const cacheService = require('./cache_service');
const { scanAvatarModels } = require('./routes/collections');

const jobs = [];
let notificationService = null;
let _getVRCCookie = null;
let _wsService = null;

function setNotificationService(ns) {
  notificationService = ns;
}

function setVRCCookieFn(fn) {
  _getVRCCookie = fn;
}

// 注入 WS 服务，使群组在线状态变化能实时推送给前端（避免仅依赖前端轮询造成滞后）
function setWsService(ws) {
  _wsService = ws;
}

// 聚合当前 VRChat 群组在线/总数统计（数据来源：group_roster，权威）。
// 注意：group_roster 表无 group_id 列，整张表即对应唯一的 VRChat 群（由 GROUP_ID 环境变量标识），
// 因此统计针对全表，不按 group_id 分组。返回单元素数组以兼容前端多群组结构。
const VRC_GROUP_ID = process.env.GROUP_ID || 'vrc_group';
async function getGroupStatsSnapshot(pool) {
  const [rows] = await pool.query(
    `SELECT SUM(is_member = 1) AS total,
            SUM(is_member = 1 AND is_online = 1) AS online,
            SUM(is_member = 1 AND is_in_game = 1) AS ingame,
            SUM(is_member = 1 AND is_online = 1 AND is_friend = 0) AS unknown
            FROM group_roster
     WHERE vrchat_id IS NOT NULL AND vrchat_id != ''`
  );
  const total = parseInt(rows[0] && rows[0].total, 10) || 0;
  const online = parseInt(rows[0] && rows[0].online, 10) || 0;
  const ingame = parseInt(rows[0] && rows[0].ingame, 10) || 0;
  const unknown = parseInt(rows[0] && rows[0].unknown, 10) || 0;
  return [{ groupId: VRC_GROUP_ID, totalCount: total, onlineCount: online, inGameCount: ingame, webOnlineCount: online - ingame, offlineCount: total - online, unknownCount: unknown }];
}

// 立即重算并向所有客户端广播最新在线统计。
// 在成员加入/离开群组、手动同步/刷新后由 routes/groups.js 调用，解决"加入离开后状态未更新"。
// groupId 参数保留以兼容调用方，但实际统计基于整张 group_roster（单一 VRChat 群）。
async function forceRosterBroadcast(groupId) {
  if (!_wsService) return;
  try {
    const pool = getPool();
    const groups = await getGroupStatsSnapshot(pool);
    // 取出全部成员的在线明细，供前端增量更新卡片状态点（增量 diff 更安全）
    const [members] = await pool.query(
      `SELECT vrchat_id, is_online, is_in_game, vrchat_status, world_name, is_friend, status_description
       FROM group_roster WHERE is_member = 1 AND vrchat_id IS NOT NULL AND vrchat_id != ''`
    );
    const detail = members.map(m => ({
      vrchatId: m.vrchat_id,
      isOnline: !!m.is_online,
      isInGame: !!m.is_in_game,
      status: m.vrchat_status || (m.is_online ? 'active' : 'offline'),
      statusDescription: m.status_description || '',
      worldName: m.world_name || '',
      isFriend: !!m.is_friend
    }));
    _wsService.broadcastRosterUpdate({ groups, members: detail, forced: true });
    console.log(`📡 [群组状态] 强制广播在线统计: 在线 ${groups[0].onlineCount}/${groups[0].totalCount}`);
  } catch (e) {
    console.error('❌ [群组状态] 强制广播失败:', e.message);
  }
}

function startSchedule() {
  // 每天凌晨 2:00 — 清理超过 7 天的回收站图片
  jobs.push(schedule.scheduleJob('0 0 2 * * *', async () => {
    console.log('🔄 [定时任务] 开始清理过期回收站图片...');
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const [rows] = await dbMod.holder.pool.query(
        `SELECT id, photo_path, thumb_path FROM album_photo WHERE is_recycle = 1 AND recycle_time < ?`,
        [sevenDaysAgo]
      );

      for (const row of rows) {
        try {
          const pp = path.join(__dirname, '..', row.photo_path);
          const tp = path.join(__dirname, '..', row.thumb_path);
          if (fs.existsSync(pp)) fs.unlinkSync(pp);
          if (tp !== pp && fs.existsSync(tp)) fs.unlinkSync(tp);
        } catch (e) { /* 文件删除失败忽略 */ }

        await dbMod.holder.pool.query(`DELETE FROM album_like WHERE photo_id = ?`, [row.id]);
        await dbMod.holder.pool.query(`DELETE FROM album_comment WHERE photo_id = ?`, [row.id]);
        await dbMod.holder.pool.query(`DELETE FROM album_photo WHERE id = ?`, [row.id]);
      }
      console.log(`✅ [定时任务] 清理完成，删除 ${rows.length} 张过期图片`);
    } catch (e) {
      console.error('❌ [定时任务] 回收站清理失败:', e.message);
    }
  }));

  // 每天凌晨 3:00 — 自动归档过期活动
  jobs.push(schedule.scheduleJob('0 0 3 * * *', async () => {
    console.log('🔄 [定时任务] 归档过期活动...');
    try {
      const [result] = await dbMod.holder.pool.query(
        `UPDATE event SET is_archive = 1 WHERE event_time < NOW() AND is_archive = 0`
      );
      console.log(`✅ [定时任务] 归档完成，共 ${result.affectedRows} 个活动`);
    } catch (e) {
      console.error('❌ [定时任务] 活动归档失败:', e.message);
    }
  }));

  // 每天凌晨 4:00 — 自动过期邀请
  jobs.push(schedule.scheduleJob('0 0 4 * * *', async () => {
    console.log('🔄 [定时任务] 清理过期邀请...');
    try {
      const [result] = await dbMod.holder.pool.query(
        `UPDATE group_invites SET status = 'expired', responded_at = NOW() WHERE status = 'pending' AND expires_at < NOW()`
      );
      console.log(`✅ [定时任务] 邀请清理完成，共过期 ${result.affectedRows} 个邀请`);
    } catch (e) {
      console.error('❌ [定时任务] 邀请清理失败:', e.message);
    }
  }));

  // 每天中午 12:00 — VRChat 系统账号 Token 验证提醒
  jobs.push(schedule.scheduleJob('0 0 12 * * *', () => {
    console.log('🔔 [定时任务] VRChat 系统账号 Token 验证提醒 — 请确认群组数据拉取正常');
  }));

  // 每分钟检查 — 活动开始前1小时提醒报名用户（带去重）
  jobs.push(schedule.scheduleJob('0 * * * * *', async () => {
    try {
      if (!notificationService) return;
      const oneHourLater = new Date(Date.now() + 60 * 60 * 1000);
      const [events] = await dbMod.holder.pool.query(
        `SELECT id, title, event_time AS eventTime FROM event 
         WHERE event_time >= ? AND event_time < ? AND is_archive = 0`,
        [oneHourLater, new Date(Date.now() + 61 * 60 * 1000)]
      );
      for (const evt of events) {
        const [signups] = await dbMod.holder.pool.query(
          `SELECT user_id FROM event_sign WHERE event_id = ?`, [evt.id]
        );
        let notifiedCount = 0;
        for (const signup of signups) {
          const [existing] = await dbMod.holder.pool.query(
            `SELECT id FROM notifications WHERE user_id = ? AND type = 'event_reminder' AND target_type = 'event' AND target_id = ?`,
            [signup.user_id, evt.id]
          );
          if (existing.length === 0) {
            notificationService.notifyUser(
              signup.user_id,
              'event_reminder',
              `🔔 活动即将开始: ${evt.title}`,
              `活动将在约1小时后开始，请提前做好准备！`,
              { targetType: 'event', targetId: evt.id }
            );
            notifiedCount++;
          }
        }
        if (notifiedCount > 0) {
          console.log(`🔔 [定时任务] 活动提醒: "${evt.title}" 已通知 ${notifiedCount} 位报名用户`);
        }
      }
    } catch (e) {
      console.error('❌ [定时任务] 活动提醒失败:', e.message);
    }
  }));

  // 每60秒刷新群组成员在线状态（实时同步）。
  // 频率从 30s 放宽到 60s：VRChat 官方限流约 50 req/min，30s 一轮在线状态解析
  // （好友列表翻页 + 非好友回退）叠加前端 /group/worlds 轮询、手动刷新后极易触发 429，
  // 导致令牌桶排队超时、群组接口 500/超时。放宽后给手动操作与其它接口留出额度。
  // 关键点：
  // 1) 游标轮转：每轮只同步固定数量成员，但用持久游标保证长期覆盖全员，
  //    避免大群组（>50人）第51名之后永远不刷新（旧实现固定 slice(0,50)）。
  // 2) inFlight 互斥：上一轮未结束则跳过，防止任务重叠打爆 VRChat API。
  // 3) 系统 cookie 探活：仅用合法样本做一次轻量查询，401 则跳过本轮保留现状，
  //    绝不误标全员离线。
  let onlineRefreshCursor = 0;
  let onlineRefreshInFlight = false;
  const ONLINE_REFRESH_BATCH = 50;
  // 群组规模阈值：成员数 <= 此值时每轮刷新全员（实时性强、无游标滞后）；
  // 超过时才启用游标分批，避免大群单次打爆 VRChat API。
  const FULL_REFRESH_THRESHOLD = 80;

  jobs.push(schedule.scheduleJob('0 * * * * *', async () => {
    if (!_getVRCCookie) return;
    if (onlineRefreshInFlight) return;
    onlineRefreshInFlight = true;
    try {
      const vrcCookie = _getVRCCookie({ session: {} });
      if (!vrcCookie) return;

      const pool = getPool();
      // 仅取真实 VRChat 成员（vrchat_id 非空），NULL/空的直接排除，
      // 既不浪费 API 额度，也避免探活/刷新时对非法 ID 抛错导致整轮被静默跳过。
      const [members] = await pool.query(
        `SELECT vrchat_id, vrchat_name FROM group_roster WHERE is_member=1 AND vrchat_id IS NOT NULL AND vrchat_id != ''`
      );
      if (members.length === 0) return;

      // 系统 cookie 探活：优先选一个合法（usr_ 开头）成员做轻量查询，
      // 若返回 401 说明系统账号 cookie 已过期。此时不再依赖系统账号刷新，
      // 但仍会应用"群友共享状态"（方案 B，来自已登录用户自己的好友视角），不整轮跳过。
      const probeMember = members.find(m => /^usr_/i.test(m.vrchat_id)) || members[0];
      let systemCookieUsable = true;
      try {
        const probe = await vrchatGetUser(probeMember.vrchat_id, vrcCookie);
        if (probe.status === 401) {
          console.warn('⚠️ [定时任务] 系统 VRChat cookie 已过期(401)，本轮将仅应用群友共享状态');
          systemCookieUsable = false;
        }
      } catch (e) {
        console.warn('⚠️ [定时任务] 系统 VRChat 查询异常，本轮将仅应用群友共享状态', e.message);
        systemCookieUsable = false;
      }

      // 本批成员：小群组每轮刷新全员；大群组按游标轮转环形覆盖（避免第51名之后永远不刷新）。
      let toProcess;
      if (members.length <= FULL_REFRESH_THRESHOLD) {
        toProcess = members;
        onlineRefreshCursor = 0;
      } else {
        let start = onlineRefreshCursor;
        if (start >= members.length) start = 0;
        toProcess = [];
        for (let i = 0; i < ONLINE_REFRESH_BATCH; i++) {
          toProcess.push(members[(start + i) % members.length]);
        }
        onlineRefreshCursor = (start + toProcess.length) % members.length;
      }

      // 状态稳定化窗口（秒）：只有候选状态持续达到该时长才正式翻转 is_online 并广播，
      // 过滤 VRChat 自身 status 抖动 / 退出重连瞬时反复造成的"状态窜动"。
      const STABLE_WINDOW = 2 * 30; // 2 个刷新周期（60s）
      // 可信度等级：3=群友共享(好友视角) 2=系统账号好友 1=非好友回退 0=未知
      const TRUST_SHARED = 3, TRUST_FRIEND = 2, TRUST_FALLBACK = 1;

      const changedMembers = []; // 正式翻转、需广播的成员（供前端增量更新）
      const batchWrites = [];      // 本批所有成员的新值，最后统一写回（避免逐条 UPDATE 的中间态碎片广播）
      let touched = 0;

      // 批量解析在线状态：优先用 /auth/user/friends（VRCX 同款数据源，好友状态最准确），
      // 非好友再回退到 /users/{id}（公开资料，非好友通常显示 offline，受 VRChat 隐私限制）。
      const idsToProcess = toProcess.map(m => m.vrchat_id);
      let onlineMap = new Map();
      if (systemCookieUsable) {
        onlineMap = await vrchatResolveOnlineStatuses(vrcCookie, idsToProcess, {
          concurrency: 5,
          fallbackDelayMs: 500,
          maxPages: 20,
          delayMs: 0,
        });
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

      // 读取本批成员已有的正式状态与候选时间戳，用于稳定化判定（单条查询，避免 N+1）
      const [existingRows] = await pool.query(
        `SELECT vrchat_id, is_online, status_candidate, status_changed_at, status_trust, vrchat_status
         FROM group_roster WHERE vrchat_id IN (?)`,
        [idsToProcess]
      );
      const existingMap = new Map(existingRows.map(r => [r.vrchat_id, r]));

      for (const m of toProcess) {
        let info = onlineMap.get(m.vrchat_id);
        let isFriend = info && info.isFriend ? true : false;
        // 方案 B：若系统视角（非好友）看不到，但群友共享了可信状态，则采用共享值。
        if (!isFriend && sharedMap.has(m.vrchat_id)) {
          const s = sharedMap.get(m.vrchat_id);
          info = {
            vrchatId: m.vrchat_id,
            displayName: m.display_name || m.vrchat_name || '',
            avatarUrl: m.avatar_url || '',
            status: s.vrchat_status || 'offline',
            location: s.location || '',
            worldId: s.world_name || '',
            isOnline: !!s.is_online,
            // 从群友共享态推算：在线且 location 非网页端（非 'web'/空）即视为游戏内。
            // 与 groups.js 手动刷新的共享态分支保持一致，否则定时任务会把共享态成员强制写回 is_in_game=0。
            isInGame: !!(s.is_online && s.location && s.location !== 'web'),
            isFriend: true,
            source: 'shared',
            last_login: s.last_login || null,
          };
          isFriend = true;
        }

        if (!info) {
          // 查询失败/未返回有效数据：保留原在线状态，仅刷新 synced_at，
          // 避免误把成员标为离线（尤其系统 cookie 过期时不应全员离线）。
          batchWrites.push({ vrchatId: m.vrchat_id, touchOnly: true });
          touched++;
          continue;
        }

        // 可信度：群友共享 > 系统好友 > 非好友回退
        const trust = sharedMap.has(m.vrchat_id) ? TRUST_SHARED
          : (isFriend ? TRUST_FRIEND : TRUST_FALLBACK);
        const status = info.status || 'offline';
        const isOnline = info.isOnline;
        // 网页端在线 vs 游戏内在线：info.isInGame 由解析器按 location!=='web' 计算。
        const isInGame = info.isInGame;
        const location = info.location || '';
        let worldName = info.worldId || '';
        if (location && !worldName) {
          const parts = location.split(':');
          if (parts[0]) worldName = parts[0];
        }

        const prev = existingMap.get(m.vrchat_id) || {};
        const prevOnline = prev.is_online === 1;
        const prevTrust = parseInt(prev.status_trust, 10) || 0;

        // 数据覆盖防护：低可信度探测不允许覆盖高可信度已存在的确定状态。
        // 例：系统账号非好友回退读到 offline，但群友共享/系统好友此前已确认 online ——
        // 保留高可信度结果，仅刷新 synced_at，避免把真实在线的成员误标离线（数据覆盖式窜动）。
        if (trust < prevTrust && prevTrust >= TRUST_FRIEND && prev.status_candidate === null) {
          batchWrites.push({ vrchatId: m.vrchat_id, touchOnly: true });
          touched++;
          continue;
        }

        // 状态稳定化：与正式状态不同 → 进入候选（确认窗口），不直接翻转；
        // 与正式状态一致 → 候选作废（瞬时回弹已平息）。
        let finalOnline = isOnline;
        let candidate = (prev.status_candidate === null ? null : prev.status_candidate);
        let changedAt = prev.status_changed_at ? new Date(prev.status_changed_at).getTime() : 0;
        const now = Date.now();

        if (isOnline !== prevOnline) {
          if (candidate === null || candidate !== (isOnline ? 1 : 0)) {
            candidate = isOnline ? 1 : 0;
            changedAt = now;
          }
          // 仅当候选持续 ≥ STABLE_WINDOW 才正式翻转
          if (now - changedAt >= STABLE_WINDOW * 1000) {
            finalOnline = isOnline; // 确认翻转
            candidate = null;
            changedMembers.push({ vrchatId: m.vrchat_id, groupId: VRC_GROUP_ID, isOnline, status, statusDescription: info.statusDescription || '', worldName, isFriend });
          } else {
            finalOnline = prevOnline; // 维持原状，等待确认窗口
          }
        } else {
          candidate = null;
        }

        // 游戏内/网页端状态：跟随稳定化后的 finalOnline。
        // 离线期强制 is_in_game=0；在线期采用当前探测值（网页端/游戏内切换不触发"在线/离线"窜动，
        // 但保持与 finalOnline 一致可避免候选等待期写入不一致的瞬时状态）。
        const prevInGame = prev.is_in_game === 1;
        const finalInGame = finalOnline ? (isInGame || false) : false;
        if (finalInGame !== prevInGame) {
          changedMembers.push({ vrchatId: m.vrchat_id, groupId: VRC_GROUP_ID, isOnline: finalOnline, isInGame: finalInGame, status, statusDescription: info.statusDescription || '', worldName, isFriend });
        }

        batchWrites.push({
          vrchatId: m.vrchat_id,
          touchOnly: false,
          displayName: info.displayName || m.vrchat_name || '',
          avatarUrl: info.avatarUrl || m.avatar_url || '',
          // F-16: 头像 ID（avtr_xxx）随主采样一起落 group_roster，供头像历史 cron diff
          avatarId: info.currentAvatar || m.avatar_id || '',
          isOnline: finalOnline,
          isInGame: finalInGame,
          status,
          location,
          worldName,
          isFriend,
          trust,
          candidate,
          changedAt: candidate !== null ? new Date(changedAt) : null,
          isVrcPlus: info.isVrcPlus ? 1 : 0,
          ageVerified: info.ageVerified ? 1 : 0,
          ageVerificationStatus: info.ageVerificationStatus || '',
          profilePicOverrideThumbnail: info.profilePicOverrideThumbnail || '',
          userIcon: info.userIcon || '',
          trustLevel: info.trustLevel || '',
          statusDescription: info.statusDescription || '',
        });
        touched++;
      }

      // 批量写回：touchOnly 仅刷新 synced_at；其余整行更新（含稳定化字段）。
      for (const w of batchWrites) {
        if (w.touchOnly) {
          await pool.query(`UPDATE group_roster SET synced_at=NOW() WHERE vrchat_id=?`, [w.vrchatId]);
        } else {
          await pool.query(
            `UPDATE group_roster SET display_name=?, avatar_url=?, avatar_id=?, is_online=?, is_in_game=?, vrchat_status=?, location=?, world_name=?, is_friend=?,
                is_vrc_plus=?, age_verified=?, age_verification_status=?, profile_pic_override_thumbnail=?, user_icon=?, trust_level=?,
                status_description=?,
                status_candidate=?, status_changed_at=?, status_trust=?, last_seen=NOW(), synced_at=NOW()
             WHERE vrchat_id=?`,
            [w.displayName, w.avatarUrl, w.avatarId || '', w.isOnline ? 1 : 0, w.isInGame ? 1 : 0, w.status, w.location, w.worldName, w.isFriend ? 1 : 0,
             w.isVrcPlus, w.ageVerified, w.ageVerificationStatus, w.profilePicOverrideThumbnail, w.userIcon, w.trustLevel || '',
             w.statusDescription || '',
             w.candidate === null ? null : w.candidate, w.changedAt, w.trust, w.vrchatId]
          );
        }
      }

      // ── 信任等级补充查询（P2-44）──
      // VRChat 好友列表 API（/auth/user/friends）不返回 trustLevel，
      // 只有 /users/{id} 个人资料接口才返回。本步骤对缺少 trust_level 的成员
      // 逐个调用 vrchatGetUser 获取完整资料，补充写入 DB。
      // 每轮最多处理 TRUST_ENRICH_BATCH 个成员，避免触发 429 限流。
      try {
        const TRUST_ENRICH_BATCH = 20; // 每轮最多补充查询的成员数
        // P2-56：只补「信任等级缺失」的成员，且用 trust_checked_at 去重——
        // 隐私墙成员（非好友）调用 /users/{id} 永远拿不到 trustLevel，
        // 若不标记会导致每轮都重复查询这同一批人，占满 20 个名额，
        // 使真正能查到 trustLevel 的好友成员永远轮不上。12 小时后再重试。
        const [missingTrust] = await pool.query(
          `SELECT vrchat_id FROM group_roster WHERE is_member=1
           AND (trust_level='' OR trust_level IS NULL)
           AND (trust_checked_at IS NULL OR trust_checked_at < NOW() - INTERVAL 12 HOUR)
           ORDER BY trust_checked_at IS NOT NULL, synced_at ASC
           LIMIT ?`,
          [TRUST_ENRICH_BATCH]
        );
        if (missingTrust.length > 0 && systemCookieUsable) {
          let enriched = 0;
          for (const row of missingTrust) {
            try {
              const resp = await vrchatGetUser(row.vrchat_id, vrcCookie);
              // P2-56: vrchatGetUser 返回 {status, data, ...}，数据在 resp.data，
              // 此前误写成 resp.trustLevel（顶层永远 undefined），导致补充查询从未写入。
              const userData = resp && resp.status === 200 ? resp.data : null;
              if (userData && (userData.trustLevel || userData.currentAvatarThumbnailImageUrl || userData.profilePicOverrideThumbnail)) {
                const tl = userData.trustLevel;
                const tlCn = ({ negative:'恶劣玩家', visitor:'游客', new:'新用户', user:'用户', known:'常驻玩家', trusted:'信任', vetted:'审核', veteran:'资深玩家', legend:'资深玩家' })[tl] || tl;
                // P2-51: /users/{id} 返回完整资料，顺带补全头像字段（friends API 不返回头像）
                const avatarUrl = userData.currentAvatarThumbnailImageUrl || '';
                const profilePic = userData.profilePicOverrideThumbnail || '';
                await pool.query(
                  `UPDATE group_roster SET trust_level=?, trust_level_cn=?, avatar_url=?, profile_pic_override_thumbnail=?, trust_checked_at=NOW() WHERE vrchat_id=?`,
                  [tl, tlCn, avatarUrl, profilePic, row.vrchat_id]
                );
                enriched++;
              } else {
                // 未拿到 trustLevel（隐私墙/非好友/404）：仅标记已尝试，避免反复占用名额
                await pool.query(
                  `UPDATE group_roster SET trust_checked_at=NOW() WHERE vrchat_id=?`,
                  [row.vrchat_id]
                );
              }
            } catch (e) {
              // 单个用户查询失败不阻断整体（429/网络抖动等），同样标记已尝试避免死循环占用名额
              console.warn(`⚠️ [信任等级补充] ${row.vrchat_id}: ${e.message}`);
              try {
                await pool.query(
                  `UPDATE group_roster SET trust_checked_at=NOW() WHERE vrchat_id=?`,
                  [row.vrchat_id]
                );
              } catch (e3) { /* 忽略 */ }
            }
            // 请求间隔：避免 429（VRChat 认证接口约 40-60 次/分钟）
            await new Promise(r => setTimeout(r, 1200));
          }
          if (enriched > 0) console.log(`✅ [信任等级补充] 本轮补充 ${enriched}/${missingTrust.length} 人，剩余待补充将在后续轮次逐步完成`);
        }
      } catch (e2) {
        console.warn('⚠️ [定时任务] 信任等级补充查询异常（非致命）:', e2.message);
      }

      // 每轮刷新后，仅广播"正式翻转"的成员 + 权威统计（前端增量更新，无需整页轮询）。
      // 数据来源统一为 group_roster，确保前端展示与服务器实际状态一致。
      if (touched > 0 && _wsService) {
        const groups = await getGroupStatsSnapshot(pool);
        _wsService.broadcastRosterUpdate({ groups, members: changedMembers });
        console.log(`🔄 [定时任务] 群组成员状态刷新: ${touched}/${toProcess.length} 人写回 [cursor=${onlineRefreshCursor}/${members.length}]，正式翻转 ${changedMembers.length} 人，已广播`);
      } else if (touched > 0) {
        console.log(`🔄 [定时任务] 群组成员状态刷新: ${touched}/${toProcess.length} 人写回 [cursor=${onlineRefreshCursor}/${members.length}]`);
      }
    } catch (e) {
      console.error('❌ [定时任务] 群组成员状态刷新失败:', e.message);
    } finally {
      onlineRefreshInFlight = false;
    }
  }));

  // 每天凌晨 1:00 — 缓存预热（预热首页、活动列表等高频接口缓存）
  jobs.push(schedule.scheduleJob('0 0 1 * * *', async () => {
    console.log('🔄 [定时任务] 开始缓存预热...');
    try {
      await cacheService.warmup(getPool);
      console.log('✅ [定时任务] 缓存预热完成');
    } catch (e) {
      console.error('❌ [定时任务] 缓存预热失败:', e.message);
    }
  }));

  // 每5分钟 — 刷新在线用户列表缓存
  jobs.push(schedule.scheduleJob('*/5 * * * *', async () => {
    try {
      const pool = getPool();
      const [onlineUsers] = await pool.query(
        `SELECT vrchat_id, vrchat_name, display_name, avatar_url, world_name 
         FROM group_roster WHERE is_member = 1 AND is_online = 1`
      );
      await cacheService.setGroupRosterOnline(onlineUsers);
    } catch (e) {
      console.warn('⚠️ [定时任务] 在线用户缓存刷新失败:', e.message);
    }
  }));

  // 每分钟 — F-13 好友变更历史：对 group_roster 好友（is_friend=1）Diff 快照，
  // 把改名/换头像/上下线/状态/世界变化写入 friend_log（当前态表 friend_log_current 跨轮次比较）。
  jobs.push(schedule.scheduleJob('* * * * *', async () => {
    try {
      const pool = getPool();
      // 取所有可信好友（is_friend=1）的当前关键状态字段
      const [rows] = await pool.query(
        `SELECT vrchat_id, display_name, avatar_url, is_online, vrchat_status, world_name
         FROM group_roster WHERE is_friend = 1 AND vrchat_id IS NOT NULL AND vrchat_id != ''`
      );
      if (!rows.length) return;

      // 读当前态快照（跨轮次比较基准）
      const [cur] = await pool.query(`SELECT * FROM friend_log_current`);
      const curMap = new Map(cur.map(r => [r.vrchat_id, r]));

      const historyInserts = [];
      const currentUpserts = [];
      for (const r of rows) {
        const prev = curMap.get(r.vrchat_id);
        const disp = r.display_name || '';
        const ava = r.avatar_url || '';
        const online = r.is_online === 1;
        const status = r.vrchat_status || 'offline';
        const world = r.world_name || '';

        // 首次出现：仅落当前态，不产生历史（无基准可 diff）
        if (!prev) {
          currentUpserts.push([r.vrchat_id, disp, ava, online ? 1 : 0, status, world]);
          continue;
        }

        const push = (type, oldV, newV) => {
          if (oldV === newV) return;
          historyInserts.push([r.vrchat_id, type, String(oldV).slice(0, 500), String(newV).slice(0, 500)]);
        };

        if ((prev.display_name || '') !== disp) push('name', prev.display_name || '', disp);
        if ((prev.avatar_url || '') !== ava) push('avatar', prev.avatar_url || '', ava);
        const prevOnline = prev.is_online === 1;
        if (prevOnline !== online) push(online ? 'online' : 'offline', prevOnline ? '1' : '0', online ? '1' : '0');
        if ((prev.vrchat_status || 'offline') !== status) push('status', prev.vrchat_status || 'offline', status);
        if ((prev.world_name || '') !== world) push('world', prev.world_name || '', world);

        // 更新当前态（UPSERT）
        currentUpserts.push([r.vrchat_id, disp, ava, online ? 1 : 0, status, world]);
      }

      // 批量写历史（去重：同一 vrchat_id + type + new_value 在 60 秒内不重复写，防抖动刷屏）
      if (historyInserts.length) {
        for (const h of historyInserts) {
          const [dup] = await pool.query(
            `SELECT id FROM friend_log WHERE vrchat_id=? AND change_type=? AND new_value=? AND created_at >= NOW() - INTERVAL 60 SECOND`,
            [h[0], h[1], h[3]]
          );
          if (!dup.length) {
            await pool.query(
              `INSERT INTO friend_log (vrchat_id, change_type, old_value, new_value) VALUES (?,?,?,?)`,
              h
            );
          }
        }
      }

      // 批量 UPSERT 当前态快照
      if (currentUpserts.length) {
        for (const c of currentUpserts) {
          await pool.query(
            `INSERT INTO friend_log_current (vrchat_id, display_name, avatar_url, is_online, vrchat_status, world_name)
             VALUES (?,?,?,?,?,?)
             ON DUPLICATE KEY UPDATE display_name=VALUES(display_name), avatar_url=VALUES(avatar_url),
               is_online=VALUES(is_online), vrchat_status=VALUES(vrchat_status), world_name=VALUES(world_name), synced_at=NOW()`,
            c
          );
        }
      }
    } catch (e) {
      console.warn('⚠️ [定时任务] 好友变更历史 diff 失败:', e.message);
    }
  }));

  // 每分钟 — F-14 世界访问历史：对 group_roster 好友（is_friend=1）Diff world_name，
  // 检测到世界变化且新世界非空时写一条访问事件（world_visit_log），并 UPSERT 聚合访问次数。
  // world_id 取 VRCX location 的 worldId 部分；若 world_name 本身即世界 ID（无展示名），则 world_id=world_name。
  jobs.push(schedule.scheduleJob('* * * * *', async () => {
    try {
      const pool = getPool();
      const [rows] = await pool.query(
        `SELECT vrchat_id, world_name FROM group_roster WHERE is_friend = 1 AND vrchat_id IS NOT NULL AND vrchat_id != ''`
      );
      if (!rows.length) return;

      // 读当前态快照（跨轮次比较基准）
      const [cur] = await pool.query(`SELECT * FROM world_visit_current`);
      const curMap = new Map(cur.map(r => [r.vrchat_id, r]));

      const events = [];   // 世界发生变化且新世界非空 → 写访问事件
      const currentUpserts = [];
      for (const r of rows) {
        const world = (r.world_name || '').trim();
        const prev = curMap.get(r.vrchat_id);

        // 首次出现：仅落当前态，不产生事件（无基准可 diff）
        if (!prev) {
          currentUpserts.push([r.vrchat_id, world, world]);
          continue;
        }

        const prevWorld = (prev.world_id || '').trim();
        // 世界变化（含从空→非空进入世界，或 A→B 切换世界）才记事件；离开世界（非空→空）不记
        if (world && world !== prevWorld) {
          events.push({ vrchatId: r.vrchat_id, worldId: world, worldName: world });
        }
        currentUpserts.push([r.vrchat_id, world, world]);
      }

      // 批量写访问事件：同 (vrchat_id, world_id) 聚合访问次数，首次/最近访问时间
      for (const ev of events) {
        await pool.query(
          `INSERT INTO world_visit_log (vrchat_id, world_id, world_name, visit_count, first_visit_at, last_visit_at)
           VALUES (?,?,?,1,NOW(),NOW())
           ON DUPLICATE KEY UPDATE visit_count = visit_count + 1, last_visit_at = NOW(), world_name = VALUES(world_name)`,
          [ev.vrchatId, ev.worldId, ev.worldName]
        );
      }

      // 批量 UPSERT 当前态快照
      if (currentUpserts.length) {
        for (const c of currentUpserts) {
          await pool.query(
            `INSERT INTO world_visit_current (vrchat_id, world_id, world_name)
             VALUES (?,?,?)
             ON DUPLICATE KEY UPDATE world_id=VALUES(world_id), world_name=VALUES(world_name), synced_at=NOW()`,
            c
          );
        }
      }
    } catch (e) {
      console.warn('⚠️ [定时任务] 世界访问历史 diff 失败:', e.message);
    }
  }));

  // 每分钟 — F-16 头像使用历史：对 group_roster 好友（is_friend=1）Diff avatar_id，
  // 检测到头像变化且新头像非空时 UPSERT 使用次数（avatar_history_log），并刷新当前态快照（avatar_history_current）。
  // avatar_id 由主采样（vrc.js 的 currentAvatar 字段）写回 group_roster；avatar_url 冗余存最近观测的缩略图便于展示。
  jobs.push(schedule.scheduleJob('* * * * *', async () => {
    try {
      const pool = getPool();
      const [rows] = await pool.query(
        `SELECT vrchat_id, avatar_id, avatar_url FROM group_roster WHERE is_friend = 1 AND vrchat_id IS NOT NULL AND vrchat_id != ''`
      );
      if (!rows.length) return;

      // 读当前态快照（跨轮次比较基准）
      const [cur] = await pool.query(`SELECT * FROM avatar_history_current`);
      const curMap = new Map(cur.map(r => [r.vrchat_id, r]));

      const events = [];   // 头像发生变化且新头像非空 → 记一次使用
      const currentUpserts = [];
      for (const r of rows) {
        const avatarId = (r.avatar_id || '').trim();
        const avatarUrl = r.avatar_url || '';
        const prev = curMap.get(r.vrchat_id);

        // 首次出现：仅落当前态，不产生事件（无基准可 diff）
        if (!prev) {
          currentUpserts.push([r.vrchat_id, avatarId, avatarUrl]);
          continue;
        }

        const prevAvatarId = (prev.avatar_id || '').trim();
        // 头像变化（含从空→非空启用头像，或 A→B 切换头像）才记使用；当前无头像（非空→空）不记
        if (avatarId && avatarId !== prevAvatarId) {
          events.push({ vrchatId: r.vrchat_id, avatarId, avatarUrl });
        }
        currentUpserts.push([r.vrchat_id, avatarId, avatarUrl]);
      }

      // 批量写使用事件：同 (vrchat_id, avatar_id) 聚合使用次数，首次/最近使用时间
      for (const ev of events) {
        await pool.query(
          `INSERT INTO avatar_history_log (vrchat_id, avatar_id, avatar_url, use_count, first_seen_at, last_seen_at)
           VALUES (?,?,?,1,NOW(),NOW())
           ON DUPLICATE KEY UPDATE use_count = use_count + 1, last_seen_at = NOW(), avatar_url = VALUES(avatar_url)`,
          [ev.vrchatId, ev.avatarId, ev.avatarUrl]
        );
      }

      // 批量 UPSERT 当前态快照
      if (currentUpserts.length) {
        for (const c of currentUpserts) {
          await pool.query(
            `INSERT INTO avatar_history_current (vrchat_id, avatar_id, avatar_url)
             VALUES (?,?,?)
             ON DUPLICATE KEY UPDATE avatar_id=VALUES(avatar_id), avatar_url=VALUES(avatar_url), synced_at=NOW()`,
            c
          );
        }
      }
    } catch (e) {
      console.warn('⚠️ [定时任务] 头像使用历史 diff 失败:', e.message);
    }
  }));

// 每天凌晨 5:00 — 检测失效的模型收藏并通知用户（统一扫描函数，来源 collections 路由）
  jobs.push(schedule.scheduleJob('0 0 5 * * *', async () => {
    console.log('🔄 [定时任务] 开始检测失效的模型收藏...');
    try {
      const result = await scanAvatarModels(getPool(), {
        getVRCCookieFn: _getVRCCookie,
        notificationService,
        batchSize: 200,
        onlyUnchecked: true
      });
      console.log(`✅ [定时任务] 模型收藏检测完成: 扫描 ${result.scanned} 个, 新失效 ${result.newlyInvalid} 个`);
    } catch (e) {
      console.error('❌ [定时任务] 模型收藏检测失败:', e.message);
    }
  }));

  console.log('⏰ 定时任务已启动（缓存预热: 每天 1:00 / 回收站清理: 每天 2:00 / 活动归档: 每天 3:00 / 邀请清理: 每天 4:00 / Token提醒: 每天 12:00 / 活动提醒: 每分钟 / 成员状态刷新: 每30秒 / 在线用户缓存: 每5分钟 / 模型收藏检测: 每天 5:00）');
}

function gracefulShutdown() {
  for (const job of jobs) {
    try { job.cancel(); } catch {}
  }
  jobs.length = 0;
  console.log('  ✓ 定时任务已取消');
}

module.exports = startSchedule;
module.exports.gracefulShutdown = gracefulShutdown;
module.exports.setNotificationService = setNotificationService;
module.exports.setVRCCookieFn = setVRCCookieFn;
module.exports.setWsService = setWsService;
module.exports.forceRosterBroadcast = forceRosterBroadcast;
