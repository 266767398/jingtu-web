/**
 * 境途同游 V6.14 — VRChat 群组路由（从 server.js 提取）
 * 群组信息、成员同步/在线状态/变更日志、VRChat user/world 查询
 */
const express = require('express');
const { getPool, safeError } = require('../utils');
const { requireAdminCompat } = require('../auth');
const {
  vrchatRequest, vrchatGetCurrentUser, vrchatGetGroupMembers,
  vrchatGetUser, vrchatGetWorld, vrchatSearchWorlds, VRC_API_KEY
} = require('../vrc');

const GROUP_ID = process.env.GROUP_ID || 'grp_7a45b436-159c-4d9c-8303-e186ec25fc35';
const VRC_API = require('../vrc').VRC_API || 'https://api.vrchat.cloud/api/1';

// ==================== 角色中文映射 ====================
const ROLE_CN_MAP = {
  'Group Owner': '群主', 'Owner': '群主', 'Admin': '管理员', 'Manager': '管理员',
  'Moderator': '协管', 'Mod': '协管', 'Member': '成员', 'Guest': '访客',
  'Recruiter': '招募官', 'Event Host': '活动主持', 'Event Coordinator': '活动协调',
  'Event Organizer': '活动组织者', 'VIP': '贵宾', 'Supporter': '支持者',
  'Contributor': '贡献者', 'Developer': '开发者', 'Artist': '画师',
  'Musician': '音乐人', 'Streamer': '主播', 'Tester': '测试员',
  'Bot': '机器人', 'Everyone': '所有人', 'Citizen': '公民', 'Resident': '居民',
};

/**
 * @param {Function} getVRCCookieFn - 获取 VRChat cookie 的函数
 */
module.exports = function (getVRCCookieFn) {
  const router = express.Router();

  // ==================== VRChat 用户查询 ====================
  router.post('/vrc/lookup', async (req, res) => {
    const vrcCookie = getVRCCookieFn(req);
    if (!vrcCookie) return res.status(401).json({ error: '请先在个人中心绑定VRChat账号，或由管理员在后台登录VRChat系统账号', code: 'VRC_SYSTEM_OFFLINE' });
    try {
      const { query } = req.body;
      if (!query) return res.status(400).json({ error: '请输入搜索内容' });
      const encoded = encodeURIComponent(query);
      const ac1 = new AbortController();
      const t1 = setTimeout(() => ac1.abort(), 15000);
      let r;
      try {
        r = await fetch(`${VRC_API}/users/${encoded}?apiKey=${VRC_API_KEY}`, {
          headers: { 'User-Agent': 'JingTuWeb/5.2', 'Cookie': vrcCookie },
          signal: ac1.signal
        });
      } finally { clearTimeout(t1); }
      if (!r.ok) {
        const ac2 = new AbortController();
        const t2 = setTimeout(() => ac2.abort(), 15000);
        try {
          const searchRes = await fetch(`${VRC_API}/users?search=${encoded}&n=5&apiKey=${VRC_API_KEY}`, {
            headers: { 'User-Agent': 'JingTuWeb/5.2', 'Cookie': vrcCookie },
            signal: ac2.signal
          });
          if (!searchRes.ok) return res.status(502).json({ error: 'VRChat API 错误' });
          const users = await searchRes.json();
          return res.json({ users: users.map(u => ({ id: u.id, displayName: u.displayName, avatarUrl: u.currentAvatarThumbnailImageUrl || u.userIcon || '' })) });
        } finally { clearTimeout(t2); }
      }
      const user = await r.json();
      res.json({ user: { id: user.id, displayName: user.displayName, avatarUrl: user.currentAvatarThumbnailImageUrl || user.userIcon || '' } });
    } catch (e) { console.error('[groups]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  // ==================== 获取群组信息 ====================
  router.get('/group', async (req, res) => {
    const vrcCookie = getVRCCookieFn(req);
    if (!vrcCookie) return res.status(401).json({ error: '请先在个人中心绑定VRChat账号，或由管理员在后台登录VRChat系统账号', code: 'VRC_SYSTEM_OFFLINE' });
    try {
      const groupRes = await vrchatRequest('GET', `/groups/${GROUP_ID}?apiKey=${VRC_API_KEY}`, null, vrcCookie);
      if (groupRes.status !== 200) return res.status(502).json({ error: '无法获取群组信息' });
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
    } catch (e) { console.error('[groups]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  // ==================== VRChat World 详情 ====================
  router.get('/vrc/world/:worldId', async (req, res) => {
    const vrcCookie = getVRCCookieFn(req);
    if (!vrcCookie) return res.status(401).json({ error: '请先在个人中心绑定VRChat账号，或由管理员在后台登录VRChat系统账号', code: 'VRC_SYSTEM_OFFLINE' });
    try {
      const wr = await vrchatGetWorld(req.params.worldId, vrcCookie);
      if (wr.status !== 200) return res.status(502).json({ error: '获取 World 失败' });
      res.json(wr.data);
    } catch (e) { console.error('[groups]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  // ==================== VRChat World 搜索 ====================
  router.get('/vrc/worlds/search', async (req, res) => {
    const vrcCookie = getVRCCookieFn(req);
    if (!vrcCookie) return res.status(401).json({ error: '请先在个人中心绑定VRChat账号，或由管理员在后台登录VRChat系统账号', code: 'VRC_SYSTEM_OFFLINE' });
    try {
      const q = req.query.q || '';
      const n = parseInt(req.query.n) || 10;
      if (!q) return res.status(400).json({ error: '请输入搜索关键词' });
      const wr = await vrchatSearchWorlds(q, n, vrcCookie);
      if (wr.status !== 200) return res.status(502).json({ error: '搜索 World 失败' });
      res.json({ worlds: wr.data });
    } catch (e) { console.error('[groups]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  // ==================== 全面同步群组成员 ====================
  router.post('/group/members/sync', requireAdminCompat, async (req, res) => {
    const vrcCookie = getVRCCookieFn(req);
    if (!vrcCookie) {
      return res.status(401).json({
        error: '缺少可用的 VRChat 登录状态',
        detail: '请先在个人中心绑定您的 VRChat 账号，或在管理面板的"系统 VRChat 账号"卡片中登录系统账号',
        code: 'VRC_SYSTEM_OFFLINE'
      });
    }
    const pool = getPool();
    try {
      console.log('[sync] 校验 VRChat cookie 有效性...');
      const currentUser = await vrchatGetCurrentUser(vrcCookie);
      if (!currentUser) {
        return res.status(401).json({
          error: 'VRChat 登录已过期',
          detail: '请在管理面板重新登录系统 VRChat 账号，或在个人中心重新绑定您的 VRChat 账号',
          code: 'VRC_COOKIE_EXPIRED'
        });
      }
      console.log(`[sync] Cookie 有效，当前用户: ${currentUser.displayName}`);
      let allMembers = [];
      let offset = 0;
      const pageSize = 100;
      while (true) {
        const mr = await vrchatGetGroupMembers(GROUP_ID, vrcCookie, pageSize, offset);
        if (mr.status !== 200) return res.status(502).json({ error: '获取成员列表失败: ' + (mr.data?.error?.message || mr.status) });
        const batch = Array.isArray(mr.data) ? mr.data : [];
        allMembers = allMembers.concat(batch);
        if (batch.length < pageSize) break;
        offset += pageSize;
      }
      console.log(`[sync] 共获取 ${allMembers.length} 名群组成员`);

      const [oldMembers] = await pool.query(`SELECT vrchat_id, vrchat_name, is_member FROM group_roster WHERE is_member=1`);
      const oldMap = new Map(oldMembers.map(m => [m.vrchat_id, m]));

      await pool.query(`UPDATE group_roster SET is_member=0 WHERE is_member=1`);

      let joinedCount = 0, updatedCount = 0;
      const newMemberIds = new Set();
      const now = new Date();

      for (const m of allMembers) {
        const uid = m.userId;
        if (!uid) continue;
        newMemberIds.add(uid);
        const isNew = !oldMap.has(uid);

        const [existing] = await pool.query(`SELECT id FROM group_roster WHERE vrchat_id=?`, [uid]);
        if (existing.length > 0) {
          await pool.query(
            `UPDATE group_roster SET vrchat_name=?, avatar_url=?, is_member=1, membership_status=?, role_ids=?, joined_at=COALESCE(joined_at, ?), left_at=NULL, synced_at=NOW()
             WHERE vrchat_id=?`,
            [m.user?.displayName || '', m.user?.currentAvatarThumbnailImageUrl || '', m.membershipStatus || 'member', JSON.stringify(m.roleIds || []), isNew ? now : null, uid]
          );
        } else {
          await pool.query(
            `INSERT INTO group_roster (vrchat_id, vrchat_name, avatar_url, is_member, membership_status, role_ids, joined_at, synced_at)
             VALUES (?, ?, ?, 1, ?, ?, ?, NOW())`,
            [uid, m.user?.displayName || '', m.user?.currentAvatarThumbnailImageUrl || '', m.membershipStatus || 'member', JSON.stringify(m.roleIds || []), now]
          );
        }
        if (isNew) joinedCount++;
        updatedCount++;
      }

      let leftCount = 0;
      for (const [oldId, oldData] of oldMap) {
        if (!newMemberIds.has(oldId)) {
          await pool.query(`UPDATE group_roster SET is_member=0, left_at=NOW(), is_online=0, vrchat_status='offline' WHERE vrchat_id=?`, [oldId]);
          await pool.query(
            `INSERT INTO group_member_changes (vrchat_id, vrchat_name, change_type, detail) VALUES (?, ?, 'left', ?)`,
            [oldId, oldData.vrchat_name, `已离开群组（同步检测）`]
          );
          leftCount++;
        }
      }

      for (const m of allMembers) {
        const uid = m.userId;
        if (uid && !oldMap.has(uid)) {
          await pool.query(
            `INSERT INTO group_member_changes (vrchat_id, vrchat_name, change_type, detail) VALUES (?, ?, 'joined', ?)`,
            [uid, m.user?.displayName || '', `加入群组（同步检测）`]
          );
        }
      }

      await pool.query(
        `INSERT INTO group_sync_log (sync_type, total_members, online_count, joined_count, left_count, success) VALUES ('full', ?, 0, ?, ?, 1)`,
        [allMembers.length, joinedCount, leftCount]
      );

      console.log(`[sync] 完成 — 总计 ${allMembers.length}, 新增 ${joinedCount}, 离开 ${leftCount}`);
      res.json({ success: true, total: allMembers.length, joined: joinedCount, left: leftCount, updated: updatedCount });
    } catch (e) {
      console.error('[sync]', e);
      try { await getPool().query(`INSERT INTO group_sync_log (sync_type, total_members, success, error_msg) VALUES ('full', 0, 0, ?)`, [e.message]); } catch {}
      res.status(500).json({ error: safeError(e.message) });
    }
  });

  // ==================== 刷新在线状态 ====================
  router.get('/group/members/refresh', async (req, res) => {
    const vrcCookie = getVRCCookieFn(req);
    if (!vrcCookie) return res.status(401).json({ error: '请先在个人中心绑定VRChat账号，或由管理员在后台登录VRChat系统账号', code: 'VRC_SYSTEM_OFFLINE' });
    const pool = getPool();
    try {
      const [members] = await pool.query(`SELECT vrchat_id, vrchat_name FROM group_roster WHERE is_member=1`);
      if (members.length === 0) return res.json({ success: true, online: 0, offline: 0, total: 0 });

      let onlineCount = 0, offlineCount = 0, updatedCount = 0;
      const results = [];
      const MAX_REQUESTS = 100;
      const BATCH_SIZE = 5;

      const toProcess = members.slice(0, MAX_REQUESTS);
      if (members.length > MAX_REQUESTS) {
        console.warn(`[groups] 刷新在线状态: ${members.length} 成员超过上限 ${MAX_REQUESTS}，仅处理前 ${MAX_REQUESTS} 人`);
      }

      for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
        const batch = toProcess.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.allSettled(batch.map(async (m) => {
          const ur = await vrchatGetUser(m.vrchat_id, vrcCookie);
          if (ur.status === 200 && ur.data) {
            const u = ur.data;
            const status = u.status || 'offline';
            const isOnline = status !== 'offline';
            const location = u.location || '';
            let worldName = u.worldId || '';
            if (location && !worldName) {
              const parts = location.split(':');
              if (parts[0]) worldName = parts[0];
            }
            await pool.query(
              `UPDATE group_roster SET display_name=?, avatar_url=?, is_online=?, vrchat_status=?, location=?, world_name=?, last_login=?, last_seen=NOW(), synced_at=NOW()
               WHERE vrchat_id=?`,
              [u.displayName || '', u.currentAvatarThumbnailImageUrl || u.userIcon || '', isOnline ? 1 : 0,
               status, location, worldName, u.last_login || null, m.vrchat_id]
            );
            return { vrchatId: m.vrchat_id, displayName: u.displayName, status, isOnline, location, worldName, avatarUrl: u.currentAvatarThumbnailImageUrl || u.userIcon || '', lastLogin: u.last_login || null };
          } else {
            await pool.query(`UPDATE group_roster SET is_online=0, vrchat_status='offline', synced_at=NOW() WHERE vrchat_id=?`, [m.vrchat_id]);
            return null;
          }
        }));
        for (const r of batchResults) {
          if (r.status === 'fulfilled' && r.value) { results.push(r.value); onlineCount++; updatedCount++; }
          else { offlineCount++; }
        }
        if (i + BATCH_SIZE < toProcess.length) await new Promise(r => setTimeout(r, 1000));
      }

      await pool.query(
        `INSERT INTO group_sync_log (sync_type, total_members, online_count, joined_count, left_count, success) VALUES ('status', ?, ?, 0, 0, 1)`,
        [members.length, onlineCount]
      );

      console.log(`[refresh] 完成 — ${members.length} 成员, ${onlineCount} 在线, ${offlineCount} 离线`);
      res.json({ success: true, online: onlineCount, offline: offlineCount, total: members.length, updated: updatedCount, results });
    } catch (e) {
      console.error('[refresh]', e);
      res.status(500).json({ error: safeError(e.message) });
    }
  });

  // ==================== 获取群组成员列表（本地 DB） ====================
  router.get('/group/members', async (req, res) => {
    try {
      const filter = req.query.filter || 'all';
      let sql = `SELECT vrchat_id AS vrchatId, vrchat_name AS vrchatName, display_name AS displayName, avatar_url AS avatarUrl,
                is_member AS isMember, is_online AS isOnline, vrchat_status AS vrchatStatus,
                location, world_name AS worldName, last_login AS lastLogin, last_seen AS lastSeen,
                joined_at AS joinedAt, left_at AS leftAt, role_ids AS roleIds,
                membership_status AS membershipStatus, synced_at AS syncedAt
                FROM group_roster WHERE is_member=1`;
      if (filter === 'online') sql += ` AND is_online=1 ORDER BY last_seen DESC`;
      else if (filter === 'offline') sql += ` AND is_online=0 ORDER BY last_login DESC`;
      else sql += ` ORDER BY is_online DESC, last_seen DESC`;

      const [rows] = await getPool().query(sql);
      for (const r of rows) {
        try { r.roleIds = JSON.parse(r.roleIds || '[]'); } catch { r.roleIds = []; }
      }
      res.json({ members: rows, total: rows.length });
    } catch (e) {
      console.error('[members]', e);
      res.status(500).json({ error: safeError(e.message) });
    }
  });

  // ==================== 成员变更历史 ====================
  router.get('/group/members/changes', async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 30, 100);
      const [rows] = await getPool().query(
        `SELECT vrchat_id AS vrchatId, vrchat_name AS vrchatName, change_type AS changeType,
                old_status AS oldStatus, new_status AS newStatus, detail, created_at AS createdAt
         FROM group_member_changes ORDER BY created_at DESC LIMIT ?`, [limit]
      );
      res.json({ changes: rows });
    } catch (e) {
      console.error('[changes]', e);
      res.status(500).json({ error: safeError(e.message) });
    }
  });

  // ==================== 同步日志 ====================
  router.get('/group/members/sync-log', async (req, res) => {
    try {
      const [rows] = await getPool().query(
        `SELECT sync_type AS syncType, total_members AS totalMembers, online_count AS onlineCount,
                joined_count AS joinedCount, left_count AS leftCount, success, error_msg AS errorMsg,
                created_at AS createdAt
         FROM group_sync_log ORDER BY created_at DESC LIMIT 10`
      );
      res.json({ logs: rows });
    } catch (e) {
      console.error('[sync-log]', e);
      res.status(500).json({ error: safeError(e.message) });
    }
  });

  // ==================== 手动添加成员到名单 ====================
  router.post('/admin/roster/sync', requireAdminCompat, async (req, res) => {
    try {
      const { vrchatId, displayName } = req.body;
      if (!vrchatId) return res.status(400).json({ error: '缺少 VRChat ID' });
      await getPool().query(`INSERT INTO group_roster (vrchat_id, vrchat_name, is_member) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE vrchat_name=?, is_member=1`,
        [vrchatId, displayName || '', displayName || '']);
      res.json({ success: true });
    } catch (e) { console.error('[groups]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  // ==================== 检查 VRChat ID 是否在群组中 ====================
  router.get('/group/check/:vrchatId', async (req, res) => {
    try {
      const [rows] = await getPool().query(`SELECT id FROM group_roster WHERE vrchat_id=? AND is_member=1`, [req.params.vrchatId]);
      res.json({ inGroup: rows.length > 0 });
    } catch (e) { console.error('[groups]', e); res.status(500).json({ error: safeError(e.message) }); }
  });

  return router;
};
