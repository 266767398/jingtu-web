/**
 * 境途同游 — VRChat 黑名单路由（超管维护）
 * 超管可在管理后台维护黑名单：用户名 / 用户URL / 做了什么（原因详情）。
 * 群组名册接口 LEFT JOIN 本表后，前端成员卡片展示黑名单徽标。
 *
 * V6.XX：黑名单联动增强——
 *   1. 与 VRChat 群黑名单合并成一站视图：本表是唯一本地存储；群黑名单（VRChat API）
 *      同步进来后用 source='group' 标记，手动添加的用 source='manual'。
 *   2. 每条记录可单独编辑「详情」（reason），直接写入本地数据库并展示。
 *   3. banned 字段表示该用户当前是否在 VRChat 群黑名单中（1=在，0=已撤销/未同步）。
 *   4. 双向联动：添加带 vrchat_id 的记录时尽力同步封禁到 VRChat 群；删除时尽力同步解封；
 *      POST /sync 手动同步 + schedule.js 定时同步——VRChat 侧撤销群封禁后，
 *      本地 source='group' 的记录自动撤销删除，source='manual' 的保留但标记 banned=0。
 */
const express = require('express');
const { ok, getPool, handleError, sendError, ErrorCodes, logOper } = require('../utils');
const { requireAuth, requireSuperAdmin } = require('../auth');
const { vrchatGetGroupBans, vrchatBanGroupMember, vrchatUnbanGroupMember } = require('../vrc');
const logger = require('../logger');

const GROUP_ID = process.env.GROUP_ID || 'vrc_group';

// VRChat 信任等级 → 中文展示名（与 groups_member_detail.js 的 TRUST_CN 同款映射）
const TRUST_CN = { 'negative': '恶劣玩家', 'visitor': '游客', 'new': '新用户', 'user': '用户', 'known': '常驻玩家', 'trusted': '信任', 'vetted': '审核', 'veteran': '资深玩家', 'legend': '资深玩家' };

// 系统账号 Cookie 注入点：server.js 启动时通过 setSystemVRCCookieFn(getVRCCookie) 注入，
// 供后台黑名单「同步封禁/同步解封到 VRChat 群」这类无会话上下文的写操作使用。
let _systemCookieFn = null;
function setSystemVRCCookieFn(fn) { _systemCookieFn = fn; }
function getSystemVRCCookie() {
  if (typeof _systemCookieFn !== 'function') return null;
  try { return _systemCookieFn({ session: {} }) || null; } catch (e) { return null; }
}

/**
 * 黑名单 ↔ VRChat 群黑名单同步（手动按钮 / schedule.js 定时任务共用）。
 * 流程：拉取 VRChat 群黑名单 → 与本地 vrc_blacklist 对账：
 *   - VRChat 中有、本地没有 → INSERT（source='group', banned=1）
 *   - VRChat 中有、本地已有 → UPDATE banned=1 + synced_at（保持原 source/reason 不覆盖）
 *   - VRChat 已撤销、本地 source='group' → 自动撤销（DELETE）
 *   - VRChat 已撤销、本地 source='manual' → 保留但 banned=0（提示已解封，可手动处置）
 * @returns {Promise<{added:number, updated:number, revoked:number, unbanSynced:number}>}
 */
async function syncBlacklistWithVrcBans(pool, vrcCookie) {
  const result = { added: 0, updated: 0, revoked: 0, unbanSynced: 0 };
  let bans = [];
  try {
    const resp = await vrchatGetGroupBans(GROUP_ID, vrcCookie);
    if (resp.status !== 200) {
      // 系统账号不可用/没权限时保持本地现状，不误删
      logger.warn('schedule', `⚠️ [黑名单同步] VRChat 群黑名单拉取失败(${resp.status})，跳过本轮`);
      return result;
    }
    const raw = resp.data;
    bans = Array.isArray(raw) ? raw : (raw && raw.bans) || [];
  } catch (e) {
    logger.warn('schedule', '⚠️ [黑名单同步] VRChat 群黑名单拉取异常，跳过本轮:', e.message);
    return result;
  }

  const now = new Date();
  // 当前 VRChat 群黑名单中的 vrchat_id 集合（尽力收集；个别条目缺 userId 时跳过）
  const activeVids = new Set();
  for (const b of bans) {
    if (b && b.userId && typeof b.userId === 'string' && /^usr_/i.test(b.userId)) {
      activeVids.add(b.userId);
    }
  }

  for (const b of bans) {
    const vid = b.userId;
    if (!vid || !/^usr_/i.test(vid)) continue;
    const url = String(b.userUrl || '');
    const name = String(b.displayName || '').trim().slice(0, 255) || '';
    try {
      const [existing] = await pool.query(
        `SELECT id FROM vrc_blacklist WHERE vrchat_id = ?`, [vid]
      );
      if (existing.length > 0) {
        // 已存在：仅刷新封禁状态与同步时间；不覆盖手动维护的 reason/source
        await pool.query(
          `UPDATE vrc_blacklist SET banned=1, synced_at=?
           WHERE id=?`,
          [now, existing[0].id]
        );
        result.updated++;
      } else {
        // VRChat bans API 不带 displayName——从本地名册取真名（无则回退占位名），
        // 避免黑名单里存 "群成员 usr_xxx" 这种不可读的名字
        let realName = name;
        if (!realName) {
          try {
            const [roster] = await pool.query(
              `SELECT display_name FROM group_roster WHERE vrchat_id = ? LIMIT 1`, [vid]
            );
            if (roster.length > 0 && roster[0].display_name) realName = roster[0].display_name;
          } catch (e4) { /* 名册查询失败不阻塞 */ }
        }
        await pool.query(
          `INSERT INTO vrc_blacklist (vrchat_id, username, url, reason, source, banned, synced_at, created_by)
           VALUES (?, ?, ?, NULL, 'group', 1, ?, 0)`,
          [vid, realName || ('群成员 ' + vid), url, now]
        );
        result.added++;
      }
    } catch (e2) { /* 单条失败不阻塞整轮 */ }
  }

  // VRChat 已撤销 → 本地联动撤销
  try {
    const [locals] = await pool.query(
      `SELECT id, vrchat_id, source FROM vrc_blacklist WHERE vrchat_id IS NOT NULL AND vrchat_id != ''`
    );
    for (const row of locals) {
      const stillBanned = activeVids.has(row.vrchat_id);
      if (stillBanned) continue;
      if (row.source === 'group') {
        // 群同步来源且 VRChat 已解封 → 自动撤销删除
        await pool.query(`DELETE FROM vrc_blacklist WHERE id=?`, [row.id]);
        result.revoked++;
      } else {
        // 手动来源 → 保留记录，但标记为已撤销（详情仍可查）
        await pool.query(`UPDATE vrc_blacklist SET banned=0, synced_at=? WHERE id=?`, [now, row.id]);
        result.unbanSynced++;
      }
    }
  } catch (e3) { /* 忽略 */ }

  return result;
}

module.exports = function createAdminVrcBlacklistRouter() {
  const router = express.Router();

  // ==================== 黑名单列表（所有登录用户可见，维护仍仅超管） ====================
  // 与群组名册联动：LEFT JOIN group_roster 带出群内名册名/头像/信任等级，群黑名单不再只有 URL。
  router.get('/admin/vrc-blacklist', requireAuth, async (req, res) => {
    try {
      const [rows] = await getPool().query(
        `SELECT b.id, b.vrchat_id AS vrchatId, b.username, b.url, b.reason, b.source, b.banned,
                b.synced_at AS syncedAt, b.created_at AS createdAt,
                b.created_by AS createdBy, u.display_name AS createdByName,
                gr.display_name AS memberName, gr.avatar_url AS avatarUrl, gr.trust_level AS trustLevel,
                gr.trust_level_cn AS trustLevelCn,
                rg.display_name AS registeredName, rg.vrchat_avatar_url AS registeredAvatar
         FROM vrc_blacklist b
         LEFT JOIN users u ON b.created_by = u.id AND b.created_by != 0
         LEFT JOIN group_roster gr ON gr.vrchat_id = b.vrchat_id AND b.vrchat_id IS NOT NULL AND b.vrchat_id != ''
         LEFT JOIN users rg ON rg.vrchat_id = b.vrchat_id AND b.vrchat_id IS NOT NULL AND b.vrchat_id != ''
         ORDER BY b.created_at DESC`
      );
      // 名字/头像优先级：群名册 → 网站注册用户 → 手动填写；信任等级中文名后端一次算好
      const items = rows.map(r => ({
        ...r,
        memberName: r.memberName || r.registeredName || null,
        avatarUrl: r.avatarUrl || r.registeredAvatar || null,
        trustLevelCn: TRUST_CN[r.trustLevel] || r.trustLevel || null
      }));
      res.json({ items });
    } catch (e) { handleError(res, e, '[admin/vrc-blacklist/list]'); }
  });

  // ==================== 添加黑名单（超管） ====================
  // 联动：带 vrchat_id 时尽力同步封禁到 VRChat 群（系统账号可用时），两表一致。
  router.post('/admin/vrc-blacklist', requireSuperAdmin, async (req, res) => {
    try {
      const { vrchatId, username, url, reason } = req.body;
      const usernameTrim = String(username || '').trim();
      if (!usernameTrim) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请输入用户名');
      if (usernameTrim.length > 255) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '用户名不能超过255字');
      const urlTrim = String(url || '').trim();
      if (urlTrim.length > 2048) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '用户URL不能超过2048字');
      const reasonStr = String(reason || '').trim();
      if (reasonStr.length > 2000) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '原因描述不能超过2000字');
      // VRChat ID 可选：填写则按 ID 去重（同 ID 不可重复拉黑）；未填写时按用户名去重，避免重复录入噪音
      const vid = String(vrchatId || '').trim() || null;
      if (vid && !/^usr_[0-9a-fA-F-]+$/.test(vid)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'VRChat ID 格式不正确（应为 usr_ 开头）');
      }
      const [dup] = vid
        ? await getPool().query(`SELECT id FROM vrc_blacklist WHERE vrchat_id=?`, [vid])
        : await getPool().query(`SELECT id FROM vrc_blacklist WHERE vrchat_id IS NULL AND username=?`, [usernameTrim]);
      if (dup.length > 0) return sendError(res, 409, ErrorCodes.CONFLICT, '该用户已在黑名单中');
      const pool = getPool();
      // 尽力在 VRChat 群同步封禁：成功则 banned=1；系统账号不可用则仅存本地（后续同步再补状态）
      let banned = 0;
      if (vid) {
        const systemCookie = getSystemVRCCookie();
        if (systemCookie) {
          try {
            const banResp = await vrchatBanGroupMember(GROUP_ID, systemCookie, vid);
            banned = banResp.status === 200 ? 1 : 0;
          } catch { banned = 0; }
        }
      }
      await pool.query(
        `INSERT INTO vrc_blacklist (vrchat_id, username, url, reason, source, banned, created_by) VALUES (?, ?, ?, ?, 'manual', ?, ?)`,
        [vid, usernameTrim, urlTrim, reasonStr || null, banned, req.session.userId]
      );
      await logOper(req.session.userId, '添加VRChat黑名单', `${usernameTrim}${vid ? ` (${vid})` : ''}`);
      ok(res, { message: '已加入黑名单' });
    } catch (e) { handleError(res, e, '[admin/vrc-blacklist/add]'); }
  });

  // ==================== 编辑黑名单详情（超管，本地库直接写详情） ====================
  router.put('/admin/vrc-blacklist/:id', requireSuperAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id || Number.isNaN(id)) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      const { username, url, reason } = req.body || {};
      const usernameTrim = String(username || '').trim();
      if (usernameTrim.length > 255) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '用户名不能超过255字');
      const urlTrim = String(url || '').trim();
      if (urlTrim.length > 2048) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '用户URL不能超过2048字');
      const reasonStr = String(reason || '').trim();
      if (reasonStr.length > 2000) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '原因描述不能超过2000字');
      const [rows] = await getPool().query(`SELECT id FROM vrc_blacklist WHERE id=?`, [id]);
      if (rows.length === 0) return sendError(res, 404, ErrorCodes.NOT_FOUND, '黑名单记录不存在');
      await getPool().query(
        `UPDATE vrc_blacklist SET username=?, url=?, reason=? WHERE id=?`,
        [usernameTrim, urlTrim, reasonStr || null, id]
      );
      await logOper(req.session.userId, '编辑VRChat黑名单详情', `#${id} ${usernameTrim}`);
      ok(res, { message: '详情已更新' });
    } catch (e) { handleError(res, e, '[admin/vrc-blacklist/edit]'); }
  });

  // ==================== 移除黑名单（超管） ====================
  // 联动：带 vrchat_id 时尽力同步从 VRChat 群解封（VRChat 撤销 → 禁止本地残留不一致）。
  router.delete('/admin/vrc-blacklist/:id', requireSuperAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id || Number.isNaN(id)) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
      const [rows] = await getPool().query(`SELECT username, vrchat_id FROM vrc_blacklist WHERE id=?`, [id]);
      if (rows.length === 0) return sendError(res, 404, ErrorCodes.NOT_FOUND, '黑名单记录不存在');
      await getPool().query(`DELETE FROM vrc_blacklist WHERE id=?`, [id]);
      if (rows[0].vrchat_id) {
        const systemCookie = getSystemVRCCookie();
        if (systemCookie) {
          try {
            await vrchatUnbanGroupMember(GROUP_ID, rows[0].vrchat_id, systemCookie);
          } catch { /* 解封失败不影响本地删除 */ }
        }
      }
      await logOper(req.session.userId, '移除VRChat黑名单', rows[0].username);
      ok(res, { message: '已移除黑名单' });
    } catch (e) { handleError(res, e, '[admin/vrc-blacklist/remove]'); }
  });

  // ==================== 手动同步 VRChat 群黑名单 ⇄ 本地（超管） ====================
  router.post('/admin/vrc-blacklist/sync', requireSuperAdmin, async (req, res) => {
    try {
      const pool = getPool();
      // 群黑名单属群管理数据，同步封禁/对账以系统账号为准（具备群管理权限）
      const vrcCookie = getSystemVRCCookie();
      if (!vrcCookie) {
        return sendError(res, 409, ErrorCodes.CONFLICT, '系统 VRChat 账号未登录，无法同步群黑名单');
      }
      const result = await syncBlacklistWithVrcBans(pool, vrcCookie);
      await logOper(req.session.userId, '同步VRChat群黑名单',
        `新增 ${result.added}，更新 ${result.updated}，自动撤销 ${result.revoked}，解封标记 ${result.unbanSynced}`);
      ok(res, { message: '同步完成', ...result });
    } catch (e) { handleError(res, e, '[admin/vrc-blacklist/sync]'); }
  });

  return router;
};

module.exports.syncBlacklistWithVrcBans = syncBlacklistWithVrcBans;
module.exports.setSystemVRCCookieFn = setSystemVRCCookieFn;