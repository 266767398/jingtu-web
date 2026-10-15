/**
 * 境途同游 V6.14 — VRChat 群组路由共享 helper
 *
 * P2-66 god-route 拆分时自 routes/groups.js 抽出，实现逐字保留：
 * - sleep：原 groups.js L11 模块级实现，逐字移动。
 * - parseVrcLocation：原 groups.js L32–68 实现（含注释），逐字移动。
 * - vrcWithFallback：原 groups.js L107–142 工厂内闭包的机械改写，唯一差别是把
 *   getVRCCookieFn / getUserVRCCookieFn 由闭包捕获改为显式入参；401 判定、
 *   invalidate 条件、降级重试顺序逐字不变。
 */

const { vrchatGetGroupMembers } = require('../vrc');
const logger = require('../logger');

const sleep = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds));

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
 * @param {Function} getVRCCookieFn 取首选 cookie 的函数（带 .invalidate）
 * @param {Function} [getUserVRCCookieFn] 取用户绑定 cookie 的函数
 */
async function vrcWithFallback(req, run, getVRCCookieFn, getUserVRCCookieFn) {
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

// ==================== 全量同步群组成员名册（共享核心） ====================
// 手动「同步 VRChat」路由与定时任务「系统账号名册兜底」共用同一实现：
// 分页拉取 VRChat 群成员 → 事务写回 group_roster（is_member 翻转 / 批量 upsert /
// 加入离开变更记录 / sync_log）→ 成功后调用 broadcast 回调（用于 WS 广播）。
// 调用方负责：cookie 探活、排他锁（GET_LOCK / 进程内标志）、冷却与错误响应映射。
// 上游非 2xx / 分页异常时抛错并附带 upstreamStatus / upstreamData，
// 由路由按 sendVrcError 分流（401 引导重登 / 429 限流退避 / 其余照常）。
const SYNC_PAGE_RETRY = 4;
const SYNC_PAGE_GAP_MS = 250;
const SYNC_MAX_PAGES = 200;
const SYNC_CHUNK = 200;

async function syncRosterFromVrc({ pool, groupId, vrcCookie, broadcast }) {
  // — 1) 分页拉取全部成员（429 本页退避重试；页间限速；页数上限防上游忽略 offset 死循环）—
  let allMembers = [];
  let offset = 0;
  const pageSize = 100;
  let page = 0;
  while (page < SYNC_MAX_PAGES) {
    let mr = null;
    for (let attempt = 0; attempt <= SYNC_PAGE_RETRY; attempt++) {
      mr = await vrchatGetGroupMembers(groupId, vrcCookie, pageSize, offset);
      if (mr.status === 200) break;
      if (mr.status === 429) {
        const waitMs = 3000 * (attempt + 1); // 3s, 6s, 9s... 退避
        logger.warn('groups', 'sync 拉取成员分页遇 429，退避后重试本页', { page, attempt, waitMs });
        await sleep(waitMs);
        continue;
      }
      break;
    }
    if (mr.status !== 200) {
      const e = new Error('获取群组成员列表上游非 2xx: ' + mr.status);
      e.upstreamStatus = mr.status;
      e.upstreamData = mr.data;
      throw e;
    }
    const batch = Array.isArray(mr.data) ? mr.data : [];
    allMembers = allMembers.concat(batch);
    if (batch.length < pageSize) break;
    offset += pageSize;
    page++;
    await sleep(SYNC_PAGE_GAP_MS);
  }
  if (page >= SYNC_MAX_PAGES) {
    logger.error('groups', 'VRChat 成员分页超过上限，疑似上游忽略 offset', { pages: page, got: allMembers.length });
    const e = new Error('VRChat 返回的成员分页异常（未按 offset 翻页）');
    e.upstreamStatus = 502;
    e.upstreamData = { error: 'VRChat 返回的成员分页异常（未按 offset 翻页）' };
    throw e;
  }

  // — 2) 事务写回名册 —
  let conn = null;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [oldMembers] = await conn.query(`SELECT vrchat_id, vrchat_name, is_member FROM group_roster WHERE is_member=1`);
    const oldMap = new Map(oldMembers.map(m => [m.vrchat_id, m]));

    await conn.query(`UPDATE group_roster SET is_member=0 WHERE is_member=1`);

    let joinedCount = 0, updatedCount = 0;
    const newMemberIds = new Set();
    const now = new Date();

    const [allRows] = await conn.query(`SELECT vrchat_id FROM group_roster`);
    const existingIds = new Set(allRows.map(r => r.vrchat_id));

    const validMembers = allMembers.filter(m => m.userId);
    const CHUNK = SYNC_CHUNK;
    for (let i = 0; i < validMembers.length; i += CHUNK) {
      const chunk = validMembers.slice(i, i + CHUNK);
      const params = [];
      for (const m of chunk) {
        const uid = m.userId;
        newMemberIds.add(uid);
        const isNew = !oldMap.has(uid);
        if (isNew) joinedCount++;
        updatedCount++;
        // 注意：信任等级不在此处推断/写入！VRChat 群成员接口（GET /groups/{id}/members）
        // 返回的 GroupMember.user 是 GroupMemberLimitedUser（精简对象），**不含 tags 字段**
        //（仅 current_avatar_tags 等头像标签），system_trust_* 信任标签只通过完整资料
        // /users/{id} 返回。若在此用 m.user.tags 推断，全群都会落成 visitor（20261015r 线上
        // 实测 467 人全 visitor），污染 trust_level 且挤掉 schedule 补充任务的回填候选。
        // 正确口径：信任等级只由 schedule.js /users/{id} 补充任务 + 玩家详情接口写入；
        // 全量同步保持「不写 trust_level」（新成员默认 ''，已有成员保留现值不被覆盖）。
        params.push(
          uid,
          m.user?.displayName || '',
          m.user?.currentAvatarThumbnailImageUrl || m.user?.iconUrl || '',
          m.membershipStatus || 'member',
          JSON.stringify(m.roleIds || []),
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
    const result = { total: allMembers.length, joined: joinedCount, left: leftCount, updated: updatedCount };
    // 成员加入/离开后立即广播最新在线统计（广播失败不阻断同步结果）
    if (typeof broadcast === 'function') {
      try { await broadcast(result); } catch (be) { logger.warn('groups', 'sync 后广播群组状态失败', be.message); }
    }
    return result;
  } catch (e) {
    if (conn) { try { await conn.rollback(); } catch {} }
    try { await pool.query(`INSERT INTO group_sync_log (sync_type, total_members, success, error_msg) VALUES ('full', 0, 0, ?)`, [e.message]); } catch {}
    throw e;
  } finally {
    if (conn) { try { conn.release(); } catch {} }
  }
}

module.exports = { sleep, parseVrcLocation, vrcWithFallback, syncRosterFromVrc };
