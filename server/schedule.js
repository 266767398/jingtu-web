const schedule = require('node-schedule');
const dbMod = require('./db');
const { getPool } = require('./utils');
const { vrchatGetUser, vrchatResolveOnlineStatuses, vrcBacklog, resolveTrustLevelFromTags } = require('./vrc');
const { getCachedWorld } = require('./world_cache');
const cacheService = require('./cache_service');
const logger = require('./logger');
const { scanAvatarModels } = require('./routes/collections');
const { syncRosterFromVrc } = require('./routes/groups_helpers');
const { syncBlacklistWithVrcBans } = require('./routes/admin_vrc_blacklist');
// T-15/S-07：备份恢复期间跳过每分钟写库任务，避免灌库与 diff/INSERT 交错
const { isRestoring } = require('./backup-core');
const { appNow } = require('./time_service');

const jobs = [];
let notificationService = null;
let _getVRCCookie = null;
let _wsService = null;

// 信任等级阶序（数值越大等级越高），用于「信任光环只升不降」判定。
// 信任等级随同步/补充查询更新，但任何新推断值都不得把数据库里已有的更高等级降下来——
// 例如某成员此前是 trusted，后来 tags 读不全（隐私墙）被推断成 visitor，则必须保留 trusted。
const TRUST_RANK = { legend: 9, veteran: 8, vetted: 7, trusted: 6, known: 5, user: 4, new: 3, visitor: 2, negative: 1 };

/**
 * 只升不降：比较新推断值 newLevel 与数据库现值 curLevel，返回应写入 DB 的信任等级。
 * - DB 无记录（空/缺失）→ 直接用新值
 * - 新值缺失 → 保留现值
 * - 新值等级高于或等于现值 → 升级/维持（返回新值）
 * - 新值等级低于现值 → 保留现值（不降级，trusted 不会被 visitor 覆盖）
 */
function trustUpgrade(newLevel, curLevel) {
  if (!curLevel) return newLevel || '';
  if (!newLevel) return curLevel;
  const next = TRUST_RANK[newLevel];
  const curr = TRUST_RANK[curLevel];
  if (curr === undefined) return newLevel;   // 现值不在阶序中 → 直接用新值
  if (next === undefined) return curLevel;   // 新值不在阶序中 → 保留现值
  return next >= curr ? newLevel : curLevel; // 只升不降
}

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
    logger.info('schedule', `📡 [群组状态] 强制广播在线统计: 在线 ${groups[0].onlineCount}/${groups[0].totalCount}`);
  } catch (e) {
    logger.error('schedule', '❌ [群组状态] 强制广播失败:', e.message);
  }
}

function startSchedule() {
  // T-18/V-05：四个每分钟 diff 任务防重入——单轮执行超过 60s 时跳过下一次重叠触发，
  // 避免重复 INSERT 与快照轮次交错（与 tasks.js 的 guard() 同模式）
  const diffRunning = new Set();
  const diffGuard = (key, fn) => async () => {
    if (diffRunning.has(key)) {
      logger.warn('schedule', `⚠️ [定时任务] ${key} 上一轮尚未结束，跳过本轮重叠触发`);
      return;
    }
    diffRunning.add(key);
    try {
      await fn();
    } finally {
      diffRunning.delete(key);
    }
  };

  // 每天凌晨 2:00 — 清理超过 7 天的回收站图片
  jobs.push(schedule.scheduleJob('0 0 2 * * *', async () => {
    logger.info('schedule', '🔄 [定时任务] 开始清理过期回收站图片...');
    try {
      // P1-44: 删除逻辑收敛到相册模块统一出口（cleanupRecycleBin），
      // unlink 前统一 isWithinAlbum 校验，杜绝穿越路径入库后被越界删除。
      const albumMod = require('./routes/album');
      if (!albumMod || typeof albumMod.cleanupRecycleBin !== 'function') {
        logger.warn('schedule', '⚠️ [定时任务] 相册模块未就绪，跳过本轮回收站清理');
        return;
      }
      const result = await albumMod.cleanupRecycleBin();
      logger.info('schedule', `✅ [定时任务] 清理完成，删除 ${result.deleted} 张过期图片`);
    } catch (e) {
      logger.error('schedule', '❌ [定时任务] 回收站清理失败:', e.message);
    }
  }));

  // 每天凌晨 3:00 — 自动归档过期活动
  jobs.push(schedule.scheduleJob('0 0 3 * * *', async () => {
    logger.info('schedule', '🔄 [定时任务] 归档过期活动...');
    try {
      const [result] = await dbMod.holder.pool.query(
        `UPDATE event SET is_archive = 1 WHERE event_time < NOW() AND is_archive = 0`
      );
      logger.info('schedule', `✅ [定时任务] 归档完成，共 ${result.affectedRows} 个活动`);
    } catch (e) {
      logger.error('schedule', '❌ [定时任务] 活动归档失败:', e.message);
    }
  }));

  // 每天凌晨 4:00 — 自动过期邀请
  jobs.push(schedule.scheduleJob('0 0 4 * * *', async () => {
    logger.info('schedule', '🔄 [定时任务] 清理过期邀请...');
    try {
      const [result] = await dbMod.holder.pool.query(
        `UPDATE group_invites SET status = 'expired', responded_at = NOW() WHERE status = 'pending' AND expires_at < NOW()`
      );
      logger.info('schedule', `✅ [定时任务] 邀请清理完成，共过期 ${result.affectedRows} 个邀请`);
    } catch (e) {
      logger.error('schedule', '❌ [定时任务] 邀请清理失败:', e.message);
    }
  }));

  // 每天中午 12:00 — VRChat 系统账号 Token 验证提醒
  jobs.push(schedule.scheduleJob('0 0 12 * * *', () => {
    logger.info('schedule', '🔔 [定时任务] VRChat 系统账号 Token 验证提醒 — 请确认群组数据拉取正常');
  }));

  // 每分钟检查 — 活动开始前1小时提醒报名用户（带去重）
  jobs.push(schedule.scheduleJob('0 * * * * *', async () => {
    try {
      if (!notificationService) return;
      // 提醒窗口用校准时间计算：event_time 来自数据库（会话时区已折算），两侧同源
      const oneHourLater = new Date(appNow().getTime() + 60 * 60 * 1000);
      const [events] = await dbMod.holder.pool.query(
        `SELECT id, title, event_time AS eventTime FROM event 
         WHERE event_time >= ? AND event_time < ? AND is_archive = 0`,
        [oneHourLater, new Date(appNow().getTime() + 61 * 60 * 1000)]
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
          logger.info('schedule', `🔔 [定时任务] 活动提醒: "${evt.title}" 已通知 ${notifiedCount} 位报名用户`);
        }
      }
    } catch (e) {
      logger.error('schedule', '❌ [定时任务] 活动提醒失败:', e.message);
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
  // F-42：无变化成员的心跳（touchOnly 刷新 synced_at）降频至 5 分钟一次。
  // 此前每 60s 一轮对全员重写 synced_at=NOW()——状态未变也产生全量磁盘写入，
  // 是长驻高磁盘 IO 的主因之一。synced_at 仅用于前端展示与 trust 补充候选排序，
  // 5 分钟精度语义不变；真实状态变化仍走 batchWrites 即时写回，不受降频影响。
  const TOUCH_HEARTBEAT_MS = 5 * 60 * 1000;
  let lastTouchAt = 0;
  const ONLINE_REFRESH_BATCH = 50;
  // 群组规模阈值：成员数 <= 此值时每轮刷新全员（实时性强、无游标滞后）；
  // 超过时才启用游标分批，避免大群单次打爆 VRChat API。
  const FULL_REFRESH_THRESHOLD = 80;
  // 名册兜底同步冷却：与手动「同步 VRChat」按用户冷却（1 小时）保持一致。
  // 冷却窗口内若一直无人手动点同步，定时任务在窗口结束后由系统账号兜底同步一次成员名册
  // （头像/名字/新成员加入），保证玩家信息在无人操作时也会自动更新。
  const ROSTER_SYNC_COOLDOWN_MS = 60 * 60 * 1000;

  jobs.push(schedule.scheduleJob('0 * * * * *', async () => {
    if (!_getVRCCookie) return;
    if (onlineRefreshInFlight) return;
    // VRChat 风控轮（P1-34）：令牌桶已有排队请求（多为交互流量）时本周期直接让路。
    // cron 每 60s 一轮，错过一轮无感；用户点击排队 12s 超时有感——额度永远优先还给交互。
    if (vrcBacklog() > 0) return;
    onlineRefreshInFlight = true;
    try {
      const vrcCookie = _getVRCCookie({ session: {} });
      if (!vrcCookie) return;

      const pool = getPool();
      // ── 定时任务开关（管理面板「系统设置」，默认开启）──
      // system_config 存字符串：'0' 表示关闭，其余（含缺省/空）视为开启。
      // sched_roster_refresh：定时刷新群组成员状态（名册兜底同步 + 在线状态刷新 + 广播）；
      // sched_trust_enrich：定时补充成员信任等级（老成员光环回填，与新玩家检测相互独立）。
      const [cfgRows] = await pool.query(
        `SELECT config_key, config_value FROM system_config WHERE config_key IN ('sched_roster_refresh','sched_trust_enrich')`
      );
      const cfgMap = new Map((cfgRows || []).map(r => [r.config_key, r.config_value]));
      const rosterRefreshOn = (cfgMap.get('sched_roster_refresh') || '1') !== '0';
      const trustEnrichOn = (cfgMap.get('sched_trust_enrich') || '1') !== '0';
      // 仅取真实 VRChat 成员（vrchat_id 非空），NULL/空的直接排除，
      // 既不浪费 API 额度，也避免探活/刷新时对非法 ID 抛错导致整轮被静默跳过。
      const [members] = await pool.query(
        `SELECT vrchat_id, vrchat_name, display_name, avatar_url FROM group_roster WHERE is_member=1 AND vrchat_id IS NOT NULL AND vrchat_id != ''`
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
          logger.warn('schedule', '⚠️ [定时任务] 系统 VRChat cookie 已过期(401)，本轮将仅应用群友共享状态');
          systemCookieUsable = false;
        }
      } catch (e) {
        logger.warn('schedule', '⚠️ [定时任务] 系统 VRChat 查询异常，本轮将仅应用群友共享状态', e.message);
        systemCookieUsable = false;
      }

      // ── 名册兜底同步（V8.2）──
      // 手动「同步 VRChat」按用户冷却（1 小时）窗口内若一直没人点同步，窗口结束后
      // 由系统账号兜底同步一次成员名册（头像/名字/新成员加入/离开），确保玩家信息
      // 在无人手动操作时也会自动更新。判定基准用 group_sync_log 里最近一次 full 成功
      // 同步的 created_at——synced_at 会被下方在线状态刷新每轮写回，不能当名册时间戳。
      // 与手动同步共用 GET_LOCK 互斥：正在手动同步/其它实例执行时本轮让路（幂等）。
      if (rosterRefreshOn && systemCookieUsable) {
        let rosterLockConn = null;
        try {
          const [fullSync] = await pool.query(
            `SELECT MAX(created_at) AS last_full_sync FROM group_sync_log WHERE sync_type='full' AND success=1`
          );
          const lastFullSync = fullSync && fullSync[0] && fullSync[0].last_full_sync
            ? new Date(fullSync[0].last_full_sync).getTime() : 0;
          if (!lastFullSync || Date.now() - lastFullSync > ROSTER_SYNC_COOLDOWN_MS) {
            const rosterLockName = 'group_members_sync:' + VRC_GROUP_ID;
            const sqliteMode = process.env.JINGTU_DB_ENGINE === 'sqlite';
            if (!sqliteMode) {
              try {
                rosterLockConn = await pool.getConnection();
                const [lockRows] = await rosterLockConn.query('SELECT GET_LOCK(?, 0) AS got', [rosterLockName]);
                if (!(lockRows && lockRows[0] && Number(lockRows[0].got) === 1)) {
                  try { rosterLockConn.release(); } catch (_) {}
                  rosterLockConn = null;
                  logger.info('schedule', '⏭️ [定时任务] 名册兜底同步被手动同步占锁，本轮让路');
                }
              } catch (le) {
                if (rosterLockConn) { try { rosterLockConn.release(); } catch (_) {} rosterLockConn = null; }
                logger.warn('schedule', '⚠️ [定时任务] 名册兜底 GET_LOCK 查询失败，本轮跳过', le.message);
              }
            }
            if (sqliteMode || rosterLockConn) {
              const r = await syncRosterFromVrc({
                pool,
                groupId: VRC_GROUP_ID,
                vrcCookie,
                broadcast: async () => { await forceRosterBroadcast(VRC_GROUP_ID); },
                // 定时名册兜底：新成员信任检测跟随「信任等级补充」开关（关 = 定时不做，仅手动检测）
                syncTrustNew: trustEnrichOn,
              });
              logger.info('schedule', `🔄 [定时任务] 名册兜底同步完成: 共 ${r.total} 人，新加入 ${r.joined}，离开 ${r.left}，更新 ${r.updated}`);
            }
            if (rosterLockConn) {
              try { await rosterLockConn.query('SELECT RELEASE_LOCK(?)', [rosterLockName]); } catch (_) {}
              try { rosterLockConn.release(); } catch (_) {}
            }
          }
        } catch (e2) {
          logger.warn('schedule', '⚠️ [定时任务] 名册兜底同步异常（非致命）:', e2.message);
          if (rosterLockConn) {
            try { await rosterLockConn.query('SELECT RELEASE_LOCK(?)', ['group_members_sync:' + VRC_GROUP_ID]); } catch (_) {}
            try { rosterLockConn.release(); } catch (_) {}
          }
        }
      }

      // ── 在线状态刷新主体（受「定时刷新群组成员状态」开关控制）──
      // 开关关闭时跳过 API 拉取 / DB 写回 / 广播；广播所需变量在此提升声明，
      // 仅实际刷新时才会被赋值（关闭时广播块整体跳过，零副作用）。
      // 信任补充块（trustEnrichOn）独立于本开关，见下方单独门控。
      let toProcess, touched, changedMembers, batchWrites;
      if (rosterRefreshOn) {
      // 本批成员：小群组每轮刷新全员；大群组按游标轮转环形覆盖（避免第51名之后永远不刷新）。
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
      const STABLE_WINDOW = 2 * 30; 
      // 可信度等级：3=群友共享(好友视角) 2=系统账号好友 1=非好友回退 0=未知
      const TRUST_SHARED = 3, TRUST_FRIEND = 2, TRUST_FALLBACK = 1;

      changedMembers = [];
      batchWrites = [];
      touched = 0;

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
          // VRChat 风控轮（P1-34）：显式收紧非好友回退上限（默认 25）。
          // 好友翻页最坏 maxPages(20) + 回退 25 + 信任补充 20 单轮需求可逼近 65 req/min，
          // 超过全局 40/min 令牌桶容量会自噬（cron 占满桶→交互排队超时）。压到 12 后
          // 单轮最坏 ~32，给交互请求与信任补充都留出余量；未覆盖者交给共享态/DB 旧值兜底。
          maxFallback: 12,
        });
      }

      // 方案 B：加载群友共享的在线状态（最近 15 分钟内上报，好友视角可信）
      const [sharedRows] = await pool.query(
        `SELECT vrchat_id, is_online, vrchat_status, world_name, location, last_login, status_description, trust_level, updated_at
         FROM group_presence_share WHERE updated_at >= NOW() - INTERVAL 15 MINUTE`
      );
      const sharedMap = new Map();
      const nowMs = Date.now();
      for (const s of sharedRows) {
        const ua = s.updated_at ? new Date(s.updated_at).getTime() : 0;
        if (nowMs - ua <= 15 * 60 * 1000) sharedMap.set(s.vrchat_id, s);
      }

      // 读取本批成员已有的正式状态与候选时间戳，用于稳定化判定（单条查询，避免 N+1）
      // 必须一并读取 trust_level / status_description：下方 batchWrites 用
      // `info.trustLevel || prev.trust_level || ''` 做「空值不覆盖非空旧值」保护，
      // 而 info 来自在线状态解析器（不含信任等级/tags）。此前本 SELECT 漏了这两列，
      // 导致 prev.trust_level / prev.status_description 恒为 undefined，保护形同虚设——
      // 每一轮刷新都把信任等级与自定义状态写回空串（信任光环丢失、全部退回金色默认环）。
      const [existingRows] = await pool.query(
        `SELECT vrchat_id, is_online, is_in_game, status_candidate, status_changed_at, status_trust, vrchat_status,
                trust_level, status_description, display_name, avatar_url, avatar_id, location, world_name, is_friend,
                is_vrc_plus, age_verified, age_verification_status, profile_pic_override_thumbnail, user_icon
         FROM group_roster WHERE vrchat_id IN (?)`,
        [idsToProcess]
      );
      const existingMap = new Map(existingRows.map(r => [r.vrchat_id, r]));
      // F-24: 世界名进程内去重缓存（同一轮/跨轮复用，配合 world_cache 24h DB 缓存）
      const worldNameMemo = new Map();

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
            statusDescription: s.status_description || '',
            trustLevel: s.trust_level || '',
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
        // F-24: worldId（wrld_xxx）不能直接当名称写库——玩家所在世界应展示地图名。
        // 先取 worldId（VRChat user.worldId 或 location 首段），再经 world_cache
        // （24h DB 缓存 + single-flight 回源）解析真实世界名；回源失败/隐私不可见时
        // 降级保留 worldId，前端仍可据此生成 vrchat.com 官网世界页链接。
        const worldId = info.worldId || (location && location !== 'web' ? String(location).split(':')[0] : '') || '';
        let worldName = worldId;
        if (worldId && /^wrld_[0-9a-fA-F-]+$/.test(worldId)) {
          if (worldNameMemo.has(worldId)) {
            worldName = worldNameMemo.get(worldId);
          } else {
            try {
              const w = await getCachedWorld(worldId, vrcCookie || null);
              worldName = (w && w.name) ? w.name : worldId;
            } catch (e) { /* 世界名解析失败：保持 worldId 降级显示 */ }
            worldNameMemo.set(worldId, worldName);
          }
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
            finalOnline = isOnline; 
            candidate = null;
            changedMembers.push({ vrchatId: m.vrchat_id, groupId: VRC_GROUP_ID, isOnline, status, statusDescription: info.statusDescription || '', worldName, isFriend });
          } else {
            finalOnline = prevOnline; 
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

        // 无变化判定（磁盘 IO 优化 F-40）：本轮计算值与上一轮正式状态全等时，
        // 不写 20 列 CASE WHEN 批量 UPDATE（每轮对全员重写是持续高磁盘 IO 的主因之一），
        // 降级为 touchOnly 仅刷新 synced_at 心跳——trust 排序/MAX(synced_at)/在线展示语义均不变。
        const noChange = (
          (info.displayName || m.vrchat_name || '') === (prev.display_name || '') &&
          (info.avatarUrl || m.avatar_url || '') === (prev.avatar_url || '') &&
          (info.currentAvatar || m.avatar_id || '') === (prev.avatar_id || '') &&
          finalOnline === prevOnline &&
          finalInGame === prevInGame &&
          (status || 'offline') === (prev.vrchat_status || 'offline') &&
          (location || '') === (prev.location || '') &&
          (worldName || '') === (prev.world_name || '') &&
          !!isFriend === (prev.is_friend === 1) &&
          trust === (parseInt(prev.status_trust, 10) || 0) &&
          candidate === (prev.status_candidate === null ? null : prev.status_candidate) &&
          (info.isVrcPlus ? 1 : 0) === (prev.is_vrc_plus || 0) &&
          (info.ageVerified ? 1 : 0) === (prev.age_verified || 0) &&
          (info.ageVerificationStatus || '') === (prev.age_verification_status || '') &&
          (info.profilePicOverrideThumbnail || '') === (prev.profile_pic_override_thumbnail || '') &&
          (info.userIcon || '') === (prev.user_icon || '') &&
          trustUpgrade(info.trustLevel, prev.trust_level || '') === (prev.trust_level || '') &&
          (info.statusDescription || prev.status_description || '') === (prev.status_description || '')
        );
        if (noChange) {
          batchWrites.push({ vrchatId: m.vrchat_id, touchOnly: true });
          touched++;
          continue;
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
          // 空值不覆盖非空旧值——共享态链路此前缺字段且用 '' 无条件覆盖，
          // 导致群成员的 status_description/trust_level 被定时任务清空（自定义状态与信任光环丢失）。
          // 信任等级另加「只升不降」：新值等级不低于现值才写入（trusted 不会被 visitor 覆盖）。
          trustLevel: trustUpgrade(info.trustLevel, prev.trust_level || ''),
          statusDescription: info.statusDescription || prev.status_description || '',
        });
        touched++;
      }

      // 批量写回：touchOnly 仅刷新 synced_at；其余整行更新（含稳定化字段）。
      // 性能修复：原版对 batchWrites 逐条 await pool.query 串行写入，
      // 几百成员 = 几百次数据库往返（N+1 反模式，与 presence/contribute 同类）。
      // 改为：touchOnly 聚合为单条 IN 查询；非touchOnly 用 CASE WHEN 批量 UPDATE 分片写入，
      // 分片大小 BATCH_UPDATE_SIZE 防止过长 SQL 撞 max_allowed_packet（保守 200）。
      // 两种写入互不影响——touchOnly 只是"我还活着"心跳，不会覆盖非touchOnly 的真实状态。
      const BATCH_UPDATE_SIZE = 200;
      const touchIds = [];
      const fullRows = [];
      for (const w of batchWrites) (w.touchOnly ? touchIds : fullRows).push(w);

      // touchOnly：一次 IN 查询刷所有 synced_at。
      // F-42 心跳降频：仅当距上次心跳 ≥ 5 分钟才真正落库，其余轮次零写入；
      // 本轮存在真实变化行（fullRows）时视为已发生写回，同步顺延心跳窗口。
      const touchDue = (Date.now() - lastTouchAt) >= TOUCH_HEARTBEAT_MS;
      if (touchIds.length > 0 && (touchDue || fullRows.length > 0)) {
        lastTouchAt = Date.now();
        for (let i = 0; i < touchIds.length; i += BATCH_UPDATE_SIZE) {
          const chunk = touchIds.slice(i, i + BATCH_UPDATE_SIZE).map(r => r.vrchatId);
          await pool.query(
            `UPDATE group_roster SET synced_at=NOW() WHERE vrchat_id IN (${chunk.map(() => '?').join(',')})`,
            chunk
          );
        }
      }

      // 非touchOnly：分片 CASE WHEN 批量 UPDATE。
      // 思路：遍历 chunk 里每一行，对每个需要更新的列生成 WHEN vrchat_id=? THEN ? 序列；
      // 所有列的 WHEN/THEN 对共享同一份 vrchat_id，保证对齐（chunk 每行的 key 不完全一致也安全——
      // 缺失列自动取该行的列默认值/原值，不会把其他行的值串过来）。
      const colMap = {
        displayName: 'display_name', avatarUrl: 'avatar_url', avatarId: 'avatar_id',
        isOnline: 'is_online', isInGame: 'is_in_game', status: 'vrchat_status',
        location: 'location', worldName: 'world_name', isFriend: 'is_friend',
        isVrcPlus: 'is_vrc_plus', ageVerified: 'age_verified', ageVerificationStatus: 'age_verification_status',
        profilePicOverrideThumbnail: 'profile_pic_override_thumbnail', userIcon: 'user_icon',
        trustLevel: 'trust_level', statusDescription: 'status_description',
        candidate: 'status_candidate', changedAt: 'status_changed_at', trust: 'status_trust'
      };
      const boolCols = new Set(['is_online', 'is_in_game', 'is_friend', 'is_vrc_plus', 'age_verified']);
      if (fullRows.length > 0) {
        for (let i = 0; i < fullRows.length; i += BATCH_UPDATE_SIZE) {
          const chunk = fullRows.slice(i, i + BATCH_UPDATE_SIZE);
          const ids = chunk.map(r => r.vrchatId);
          // 一次遍历同时构造 setClause 和 allVals：
          // 对每个 camelCase key → snake_case 列，生成 CASE WHEN vrchat_id=? THEN ? 序列。
          // bool 列自动 0/1 转换；null 原样传递；candidate === null 显式传 null（不是空串）。
          const setParts = [];
          const allVals = [];
          for (const k of Object.keys(colMap)) {
            const col = colMap[k];
            const pairs = [];
            for (const r of chunk) {
              if (!(k in r)) continue; // 该行不含此列 → 跳过该 CASE 分支（用列原值兜底）
              let v = r[k];
              if (boolCols.has(col)) v = v ? 1 : 0;
              else if (v === null || v === undefined) v = null;
              pairs.push(r.vrchatId, v);
            }
            if (pairs.length === 0) continue; // 全 chunk 都没这列 → 省掉
            // CASE WHEN vrchat_id=? THEN ? ... END AS col
            const cases = Array(pairs.length / 2).fill('WHEN vrchat_id = ? THEN ?').join(' ');
            setParts.push(`${col}=CASE ${cases} ELSE ${col} END`);
            allVals.push(...pairs);
          }
          if (setParts.length === 0) continue;
          await pool.query(
            `UPDATE group_roster SET ${setParts.join(',')}, last_seen=NOW(), synced_at=NOW() WHERE vrchat_id IN (${ids.map(() => '?').join(',')})`,
            [...allVals, ...ids]
          );
        }
      }
      } // ┄ rosterRefreshOn 门控（刷新主体结束）：信任补充块独立受 trustEnrichOn 控制 ┄

      // ── 信任等级 + 头像联合补充查询（P2-44 / F-24）──
      // VRChat 不直接暴露 trustLevel 字段：信任等级编码在用户 tags 的 system_trust_* 中
      //（VRCX computeTrustLevel 同款推断）。/users/{id} 对好友与非好友均返回 tags 与
      // currentAvatarThumbnailImageUrl，因此本步骤对「缺信任等级 或 缺头像」的成员
      // 逐个调用 vrchatGetUser 推断并补充写入 DB（同时解决群成员头像长期缺项）。
      // 每轮最多处理 TRUST_ENRICH_BATCH 个成员，避免触发 429 限流。
      try {
        // 20 → 25：上轮发现信任等级被 stable refresh 刷空后，回填速度受限于每轮 20 条。
        // 结合本轮已把主链路回退从 25 压到 12，额外 +5 条不会触令牌桶上限；
        // 去重 12h → 6h：隐私墙/404 成员的重试窗口减半，既能加速真正能补的成员上抬，
        // 也不会让查不到的成员长期占坑（仍有 backlog>2 中断保护 + 令牌桶限流）。
        const TRUST_ENRICH_BATCH = 25; 
        // P2-56：只补「信任等级缺失 或 头像缺失」的成员，且用 trust_checked_at 去重——
        // 无 tags/无头像的成员（隐私墙/404/删号）若不标记会导致每轮都重复查询同一批人，
        // 占满名额，使真正能补的成员永远轮不上。6 小时后再重试。
        // 20261015r 自愈：20261015q 曾误从群成员接口（GroupMemberLimitedUser 无 tags）
        // 推断信任等级，全量同步把全群写成 visitor 且 trust_checked_at=NOW()，真实等级
        // 永远无法回填。修复 = 全量同步不再写信任等级（groups_helpers.js 同步注释）+
        // 此处把 visitor 也纳入候选，让 /users/{id}（唯一正确数据源）把真实等级逐步回写。
        // visitor 按 6h 窗口复查还有保鲜收益：VRChat 信任等级会随行为变化，定期复查不长期失真。
        const [missingTrust] = await pool.query(
          `SELECT vrchat_id, trust_level FROM group_roster WHERE is_member=1
           AND ((trust_level='' OR trust_level IS NULL OR trust_level='visitor') OR (avatar_url='' OR avatar_url IS NULL))
           AND (trust_checked_at IS NULL OR trust_checked_at < NOW() - INTERVAL 6 HOUR)
           ORDER BY trust_checked_at IS NOT NULL, synced_at ASC
           LIMIT ?`,
          [TRUST_ENRICH_BATCH]
        );
        // P1-34: 有用户在排队等令牌时本轮跳过信任补充——它是纯后台增强任务，
        // 错过一轮 30 分钟无感；用户请求被拖到 12s 超时有感。
        if (trustEnrichOn && missingTrust.length > 0 && systemCookieUsable && vrcBacklog() === 0) {
          let enriched = 0;
          for (const row of missingTrust) {
            // P1-34: 循环中途若用户请求开始排队，立即收手，剩余名额留给下一轮
            if (vrcBacklog() > 2) break;
            try {
              const resp = await vrchatGetUser(row.vrchat_id, vrcCookie);
              // P2-56: vrchatGetUser 返回 {status, data, ...}，数据在 resp.data，
              // 此前误写成 resp.trustLevel（顶层永远 undefined），导致补充查询从未写入。
              const userData = resp && resp.status === 200 ? resp.data : null;
              if (userData && (Array.isArray(userData.tags) || userData.currentAvatarThumbnailImageUrl || userData.iconUrl || userData.profilePicOverrideThumbnail)) {
                // F-24: 从 tags 推断信任等级（VRCX 同款），替代不存在的 userData.trustLevel
                const tl = resolveTrustLevelFromTags(userData.tags);
                // 只升不降：即使本轮 tags 读不全推断出 visitor，也比对 DB 现值保留更高等级。
                const finalTl = trustUpgrade(tl, row.trust_level || '');
                const tlCn = ({ negative:'恶劣玩家', visitor:'游客', new:'新用户', user:'用户', known:'常驻玩家', trusted:'信任', vetted:'审核', veteran:'资深玩家', legend:'资深玩家' })[finalTl] || finalTl;
                // P2-51: /users/{id} 返回完整资料，顺带补全头像字段（friends API 不返回头像）。
                // V9.3: currentAvatarThumbnailImageUrl 已被 VRChat 弃用（2025 个人资料体系改版），
                // 新字段 iconUrl（个人资料图标）对非好友/隐私受限成员也始终返回，作为头像来源。
                const avatarUrl = userData.currentAvatarThumbnailImageUrl || userData.iconUrl || '';
                const profilePic = userData.profilePicOverrideThumbnail || '';
                await pool.query(
                  `UPDATE group_roster SET trust_level=?, trust_level_cn=?, avatar_url=?, profile_pic_override_thumbnail=?, trust_checked_at=NOW() WHERE vrchat_id=?`,
                  [finalTl, tlCn, avatarUrl, profilePic, row.vrchat_id]
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
              logger.warn('schedule', `⚠️ [信任等级补充] ${row.vrchat_id}: ${e.message}`);
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
          if (enriched > 0) logger.info('schedule', `✅ [信任等级补充] 本轮补充 ${enriched}/${missingTrust.length} 人，剩余待补充将在后续轮次逐步完成`);
        }
      } catch (e2) {
        logger.warn('schedule', '⚠️ [定时任务] 信任等级补充查询异常（非致命）:', e2.message);
      }

      // 每轮刷新后，仅广播"正式翻转"的成员 + 权威统计（前端增量更新，无需整页轮询）。
      // 数据来源统一为 group_roster，确保前端展示与服务器实际状态一致。
      // 广播跟随 rosterRefreshOn：开关关闭时跳过（touched 未被赋值，此处一并规避）。
      if (rosterRefreshOn) {
        if (touched > 0 && _wsService) {
          const groups = await getGroupStatsSnapshot(pool);
          _wsService.broadcastRosterUpdate({ groups, members: changedMembers });
          logger.info('schedule', `🔄 [定时任务] 群组成员状态刷新: ${touched}/${toProcess.length} 人写回 [cursor=${onlineRefreshCursor}/${members.length}]，正式翻转 ${changedMembers.length} 人，已广播`);
        } else if (touched > 0) {
          logger.info('schedule', `🔄 [定时任务] 群组成员状态刷新: ${touched}/${toProcess.length} 人写回 [cursor=${onlineRefreshCursor}/${members.length}]`);
        }
      }
    } catch (e) {
      logger.error('schedule', '❌ [定时任务] 群组成员状态刷新失败:', e.message);
    } finally {
      onlineRefreshInFlight = false;
    }
  }));

  // 每 30 分钟 — VRChat 群黑名单 ⇄ 本地黑名单自动同步
  // 联动规则见 routes/admin_vrc_blacklist.js：VRChat 侧撤销群封禁后，
  // 本地 source='group' 的记录自动撤销删除；手动记录保留但标记 banned=0。
  // 与手动同步共用同一对账函数，幂等；系统账号不可用/令牌桶排队时让路，不误删本地数据。
  jobs.push(schedule.scheduleJob('*/30 * * * *', async () => {
    if (!_getVRCCookie) return;
    if (vrcBacklog() > 0) return;
    try {
      const vrcCookie = _getVRCCookie({ session: {} });
      if (!vrcCookie) return;
      const result = await syncBlacklistWithVrcBans(getPool(), vrcCookie);
      if (result.added || result.revoked || result.unbanSynced) {
        logger.info('schedule', `🔁 [定时任务] 黑名单同步: 新增 ${result.added}，更新 ${result.updated}，自动撤销 ${result.revoked}，解封标记 ${result.unbanSynced}`);
      }
    } catch (e) {
      logger.warn('schedule', '⚠️ [定时任务] 黑名单同步异常（非致命）:', e.message);
    }
  }));

  // 每天凌晨 1:00 — 缓存预热（预热首页、活动列表等高频接口缓存）
  jobs.push(schedule.scheduleJob('0 0 1 * * *', async () => {
    logger.info('schedule', '🔄 [定时任务] 开始缓存预热...');
    try {
      await cacheService.warmup(getPool);
      logger.info('schedule', '✅ [定时任务] 缓存预热完成');
    } catch (e) {
      logger.error('schedule', '❌ [定时任务] 缓存预热失败:', e.message);
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
      logger.warn('schedule', '⚠️ [定时任务] 在线用户缓存刷新失败:', e.message);
    }
  }));

  // 每分钟 — F-13 好友变更历史：对 group_roster 好友（is_friend=1）Diff 快照，
  // 把改名/换头像/上下线/状态/世界变化写入 friend_log（当前态表 friend_log_current 跨轮次比较）。
  jobs.push(schedule.scheduleJob('* * * * *', diffGuard('friendLog', async () => {
    if (isRestoring()) return; // T-15/S-07：恢复期跳过写库
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

      // 批量 UPSERT 当前态快照（磁盘 IO 优化 F-40：值无变化的行跳过重写，
      // 当前态表仅作跨轮次 diff 基准，synced_at 无读取方，跳过不影响任何展示/排序）
      if (currentUpserts.length) {
        for (const c of currentUpserts) {
          const [cid, disp, ava, online, status, world] = c;
          const p = curMap.get(cid);
          if (p && (p.display_name || '') === disp && (p.avatar_url || '') === ava && p.is_online === online &&
              (p.vrchat_status || 'offline') === status && (p.world_name || '') === world) continue;
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
      logger.warn('schedule', '⚠️ [定时任务] 好友变更历史 diff 失败:', e.message);
    }
  })));

  // 每分钟 — F-14 世界访问历史：对 group_roster 好友（is_friend=1）Diff world_name，
  // 检测到世界变化且新世界非空时写一条访问事件（world_visit_log），并 UPSERT 聚合访问次数。
  // world_id 取 VRCX location 的 worldId 部分；若 world_name 本身即世界 ID（无展示名），则 world_id=world_name。
  jobs.push(schedule.scheduleJob('* * * * *', diffGuard('worldVisit', async () => {
    if (isRestoring()) return; // T-15/S-07：恢复期跳过写库
    try {
      const pool = getPool();
      const [rows] = await pool.query(
        `SELECT vrchat_id, world_name FROM group_roster WHERE is_friend = 1 AND vrchat_id IS NOT NULL AND vrchat_id != ''`
      );
      if (!rows.length) return;

      // 读当前态快照（跨轮次比较基准）
      const [cur] = await pool.query(`SELECT * FROM world_visit_current`);
      const curMap = new Map(cur.map(r => [r.vrchat_id, r]));

      const events = [];   
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

      // 批量 UPSERT 当前态快照（磁盘 IO 优化 F-40：世界无变化的行跳过重写）
      if (currentUpserts.length) {
        for (const c of currentUpserts) {
          const [cid, worldId, worldName2] = c;
          const p = curMap.get(cid);
          if (p && (p.world_id || '') === (worldId || '') && (p.world_name || '') === (worldName2 || '')) continue;
          await pool.query(
            `INSERT INTO world_visit_current (vrchat_id, world_id, world_name)
             VALUES (?,?,?)
             ON DUPLICATE KEY UPDATE world_id=VALUES(world_id), world_name=VALUES(world_name), synced_at=NOW()`,
            c
          );
        }
      }
    } catch (e) {
      logger.warn('schedule', '⚠️ [定时任务] 世界访问历史 diff 失败:', e.message);
    }
  })));

  // 每分钟 — F-21 在线活动会话：对 group_roster 好友（is_friend=1）Diff is_online，
  // 离线→在线开新会话（ended_at NULL 表示进行中），在线→离线封口回填时长与所在世界。
  // 超长会话（>30 小时未封口，进程重启/漏检兜底）按 24 小时分段并视为已封口，下一轮按在线重开。
  jobs.push(schedule.scheduleJob('* * * * *', diffGuard('activitySessions', async () => {
    if (isRestoring()) return; // T-15/S-07：恢复期跳过写库
    try {
      const pool = getPool();
      const [rows] = await pool.query(
        `SELECT vrchat_id, is_online, world_name FROM group_roster
         WHERE is_friend = 1 AND vrchat_id IS NOT NULL AND vrchat_id != ''`
      );
      if (!rows.length) return;

      // 超长分段（SQL 侧判定，无 JS/MySQL 时区差异）：进行中会话超过 30 小时 → 封口到 24 小时处，
      // 视为已封口；该成员若仍在线，下方按在线重开新会话（避免时间轴单条跨度过大）。
      await pool.query(
        `UPDATE activity_sessions SET ended_at = DATE_ADD(started_at, INTERVAL 24 HOUR),
           duration_minutes = 1440
         WHERE ended_at IS NULL AND started_at < NOW() - INTERVAL 30 HOUR`
      );

      // 进行中会话（ended_at IS NULL）
      const [openRows] = await pool.query(
        `SELECT id, vrchat_id, started_at FROM activity_sessions WHERE ended_at IS NULL`
      );
      const openMap = new Map(openRows.map(o => [o.vrchat_id, o]));

      for (const r of rows) {
        const online = r.is_online === 1;
        const open = openMap.get(r.vrchat_id);
        const world = (r.world_name || '').trim();

        if (!online) {
          // 离线且存在进行中会话 → 封口回填时长与所在世界
          if (open) {
            await pool.query(
              `UPDATE activity_sessions SET ended_at = NOW(),
                 duration_minutes = GREATEST(1, TIMESTAMPDIFF(MINUTE, started_at, NOW())),
                 world_id = ?, world_name = ? WHERE id = ?`,
              [world, world, open.id]
            );
            openMap.delete(r.vrchat_id);
          }
        } else if (!open) {
          // 在线且无进行中会话 → 开新会话
          await pool.query(
            `INSERT INTO activity_sessions (vrchat_id, started_at) VALUES (?, NOW())`,
            [r.vrchat_id]
          );
        }
      }
    } catch (e) {
      logger.warn('schedule', '⚠️ [定时任务] 在线活动会话采样失败:', e.message);
    }
  })));

  // 每分钟 — F-16 头像使用历史：对 group_roster 好友（is_friend=1）Diff avatar_id，
  // 检测到头像变化且新头像非空时 UPSERT 使用次数（avatar_history_log），并刷新当前态快照（avatar_history_current）。
  // avatar_id 由主采样（vrc.js 的 currentAvatar 字段）写回 group_roster；avatar_url 冗余存最近观测的缩略图便于展示。
  jobs.push(schedule.scheduleJob('* * * * *', diffGuard('avatarHistory', async () => {
    if (isRestoring()) return; // T-15/S-07：恢复期跳过写库
    try {
      const pool = getPool();
      const [rows] = await pool.query(
        `SELECT vrchat_id, avatar_id, avatar_url FROM group_roster WHERE is_friend = 1 AND vrchat_id IS NOT NULL AND vrchat_id != ''`
      );
      if (!rows.length) return;

      // 读当前态快照（跨轮次比较基准）
      const [cur] = await pool.query(`SELECT * FROM avatar_history_current`);
      const curMap = new Map(cur.map(r => [r.vrchat_id, r]));

      const events = [];   
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

      // 批量 UPSERT 当前态快照（磁盘 IO 优化 F-40：头像无变化的行跳过重写；
      // avatar_history_current.synced_at 被 avatar.js 用于取最近头像，头像不变时跳过不影响结果）
      if (currentUpserts.length) {
        for (const c of currentUpserts) {
          const [cid, avatarId, avatarUrl] = c;
          const p = curMap.get(cid);
          if (p && (p.avatar_id || '') === (avatarId || '') && (p.avatar_url || '') === (avatarUrl || '')) continue;
          await pool.query(
            `INSERT INTO avatar_history_current (vrchat_id, avatar_id, avatar_url)
             VALUES (?,?,?)
             ON DUPLICATE KEY UPDATE avatar_id=VALUES(avatar_id), avatar_url=VALUES(avatar_url), synced_at=NOW()`,
            c
          );
        }
      }
    } catch (e) {
      logger.warn('schedule', '⚠️ [定时任务] 头像使用历史 diff 失败:', e.message);
    }
  })));

// 每天凌晨 5:00 — 检测失效的模型收藏并通知用户（统一扫描函数，来源 collections 路由）
  jobs.push(schedule.scheduleJob('0 0 5 * * *', async () => {
    logger.info('schedule', '🔄 [定时任务] 开始检测失效的模型收藏...');
    try {
      const result = await scanAvatarModels(getPool(), {
        getVRCCookieFn: _getVRCCookie,
        notificationService,
        batchSize: 200,
        onlyUnchecked: true
      });
      logger.info('schedule', `✅ [定时任务] 模型收藏检测完成: 扫描 ${result.scanned} 个, 新失效 ${result.newlyInvalid} 个`);
    } catch (e) {
      logger.error('schedule', '❌ [定时任务] 模型收藏检测失败:', e.message);
    }
  }));

  logger.info('schedule', '⏰ 定时任务已启动（缓存预热: 每天 1:00 / 回收站清理: 每天 2:00 / 活动归档: 每天 3:00 / 邀请清理: 每天 4:00 / Token提醒: 每天 12:00 / 活动提醒: 每分钟 / 成员状态刷新: 每30秒 / 在线用户缓存: 每5分钟 / 模型收藏检测: 每天 5:00）');
}

function gracefulShutdown() {
  for (const job of jobs) {
    try { job.cancel(); } catch {}
  }
  jobs.length = 0;
  logger.info('schedule', '  ✓ 定时任务已取消');
}

module.exports = startSchedule;
module.exports.gracefulShutdown = gracefulShutdown;
module.exports.setNotificationService = setNotificationService;
module.exports.setVRCCookieFn = setVRCCookieFn;
module.exports.setWsService = setWsService;
module.exports.forceRosterBroadcast = forceRosterBroadcast;
module.exports.getGroupStatsSnapshot = getGroupStatsSnapshot;
