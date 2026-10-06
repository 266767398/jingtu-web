/**
 * 境途同游 — 权限查看接口（只读检视器）
 *
 * 提供「单独调用」的两类权限视图：
 *   1) 网站用户权限（website） ：站点角色 + 所属权限组 + 合并后的有效权限矩阵 + 遗留 user_permissions。
 *   2) 群组用户权限（group）   ：该用户在 VRChat 群组（group_roster）的成员状态 / 角色 / 在线 / 世界。
 *
 * 设计：只读、不写；查看他人需 super_admin，查看自己只需登录。
 * 与 permission_groups.js（写操作 / 权限组 CRUD）职责分离：本文件只负责"看"。
 *
 * @swagger
 * tags:
 *   name: PermissionsView
 *   description: 用户权限查看（网站权限 + 群组权限，可单独调用）
 */
const express = require('express');
const router = express.Router();
const { fail, getPool, handleError, getAvatarUrl, sendError, ErrorCodes } = require('../utils');
const { requireAuth, ROLE_LEVEL, ROLE_LABELS, currentRole } = require('../auth');
const { ALL_PERMISSIONS, PERMISSION_LABELS } = require('./permission_groups');

// VRChat 群组成员状态 → 中文（membership_status 取值）
const MEMBERSHIP_STATUS_CN = {
  owner: '群主',
  admin: '管理员',
  manager: '协管',
  moderator: '协管',
  member: '成员',
  guest: '访客',
  invited: '已邀请',
  banned: '已封禁'
};

// 角色 → 基础权限组（与创建用户时一致：1=super_admin 2=admin 3=member）
const ROLE_BASE_GROUP = { super_admin: 1, admin: 2, member: 3 };

/**
 * 鉴权：看自己只需登录；看他人必须是 super_admin。
 * （权限详情属敏感信息，不允许普通 admin 越权查看其它账号。）
 */
async function resolveTarget(req, res, next) {
  const targetId = parseInt(req.params.userId, 10);
  if (!targetId) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '无效的用户ID');
  if (targetId === req.session.userId) return next();
  // IDOR-2: 实时 DB 角色判断
  const role = await currentRole(req);
  if ((ROLE_LEVEL[role] || 0) < ROLE_LEVEL.super_admin) {
    return fail(res, 403, '权限不足，仅可查看自己的权限');
  }
  next();
}

// ==================== 网站用户权限 ====================
async function getWebsitePermissions(userId) {
  const pool = getPool();
  const [[user]] = await pool.query(
    `SELECT id, login_id, display_name, role, vrchat_id, vrchat_name, banned, approved,
            avatar_type, custom_avatar_path, vrchat_avatar_url, email
     FROM users WHERE id = ? AND deleted_at IS NULL`,
    [userId]
  );
  if (!user) return null;

  // 所属权限组
  const [groups] = await pool.query(
    `SELECT pg.id, pg.name, pg.description, pg.parent_id AS parentId,
            pg.is_default AS isDefault, pg.is_system AS isSystem
     FROM user_group_membership ugm
     JOIN permission_groups pg ON ugm.group_id = pg.id
     WHERE ugm.user_id = ?
     ORDER BY pg.is_system DESC, pg.id ASC`,
    [userId]
  );
  const groupIds = groups.map(g => g.id);

  // 合并有效权限：任意组允许 = 允许（MAX 聚合）
  const effective = {};
  if (groupIds.length) {
    const [permRows] = await pool.query(
      `SELECT permission_key AS k, MAX(permission_value) AS v
       FROM group_permission_entries WHERE group_id IN (?)
       GROUP BY permission_key`,
      [groupIds]
    );
    for (const r of permRows) effective[r.k] = !!r.v;
  }
  // 完整权限矩阵（未设置的键默认 false，方便前端一次性渲染开关态）
  const fullMatrix = {};
  for (const k of ALL_PERMISSIONS) fullMatrix[k] = !!effective[k];

  // 遗留 user_permissions（旧表，当前未被任何业务路由强制，仅作透明展示）
  const [legacyRows] = await pool.query(
    `SELECT permission, granted FROM user_permissions WHERE user_id = ?`,
    [userId]
  );
  const legacy = {};
  for (const r of legacyRows) legacy[r.permission] = !!r.granted;

  return {
    userId: user.id,
    loginId: user.login_id,
    displayName: user.display_name,
    avatarUrl: getAvatarUrl(user),
    role: user.role,
    roleLabel: ROLE_LABELS[user.role] || user.role,
    roleLevel: ROLE_LEVEL[user.role] || 0,
    banned: !!user.banned,
    approved: !!user.approved,
    email: user.email || null,
    vrchatId: user.vrchat_id || null,
    vrchatName: user.vrchat_name || null,
    permissionGroups: groups,
    baseGroupId: ROLE_BASE_GROUP[user.role] || 3,
    effectivePermissions: fullMatrix,
    legacyPermissions: legacy
  };
}

// ==================== 群组用户权限（VRChat 群组） ====================
async function getGroupPermissions(userId) {
  const pool = getPool();
  const [[user]] = await pool.query(
    `SELECT vrchat_id, vrchat_name, display_name FROM users WHERE id = ? AND deleted_at IS NULL`,
    [userId]
  );
  if (!user) return { inGroup: false, reason: '用户不存在' };
  if (!user.vrchat_id) {
    return { inGroup: false, vrchatId: null, reason: '该用户未绑定 VRChat 账号' };
  }
  const [rows] = await pool.query(
    `SELECT vrchat_id, vrchat_name, display_name, is_member, is_online, vrchat_status,
            location, world_name, joined_at, left_at, role_ids, membership_status
     FROM group_roster WHERE vrchat_id = ?`,
    [user.vrchat_id]
  );
  if (rows.length === 0 || !rows[0].is_member) {
    return { inGroup: false, vrchatId: user.vrchat_id, reason: '不在 VRChat 群组中' };
  }
  const r = rows[0];
  let roleIds = [];
  try { roleIds = JSON.parse(r.role_ids || '[]'); } catch { roleIds = []; }
  return {
    inGroup: true,
    vrchatId: r.vrchat_id,
    vrchatName: r.vrchat_name,
    displayName: r.display_name,
    membershipStatus: r.membership_status || 'member',
    membershipStatusLabel: MEMBERSHIP_STATUS_CN[r.membership_status] || r.membership_status || '成员',
    roleIds,
    isOnline: !!r.is_online,
    vrchatStatus: r.vrchat_status || 'offline',
    location: r.location || '',
    worldName: r.world_name || '',
    joinedAt: r.joined_at,
    leftAt: r.left_at
  };
}

// ==================== 路由 ====================

// 网站用户权限（单独调用）
router.get('/user/:userId/website', resolveTarget, async (req, res) => {
  try {
    const data = await getWebsitePermissions(parseInt(req.params.userId, 10));
    if (!data) return sendError(res, 404, ErrorCodes.NOT_FOUND, '用户不存在');
    res.json({ website: data });
  } catch (e) { handleError(res, e, '[permissions-view/website]'); }
});

// 群组用户权限（单独调用）
router.get('/user/:userId/group', resolveTarget, async (req, res) => {
  try {
    const data = await getGroupPermissions(parseInt(req.params.userId, 10));
    res.json({ group: data });
  } catch (e) { handleError(res, e, '[permissions-view/group]'); }
});

// 合并视图（网站 + 群组）
router.get('/user/:userId', resolveTarget, async (req, res) => {
  try {
    const id = parseInt(req.params.userId, 10);
    const website = await getWebsitePermissions(id);
    if (!website) return sendError(res, 404, ErrorCodes.NOT_FOUND, '用户不存在');
    const group = await getGroupPermissions(id);
    res.json({ website, group });
  } catch (e) { handleError(res, e, '[permissions-view/user]'); }
});

// 自身合并视图（登录即可）
router.get('/me', requireAuth, async (req, res) => {
  try {
    const website = await getWebsitePermissions(req.session.userId);
    const group = await getGroupPermissions(req.session.userId);
    res.json({ website, group });
  } catch (e) { handleError(res, e, '[permissions-view/me]'); }
});

// 全量权限键定义（供前端渲染标签）
router.get('/definitions', requireAuth, (req, res) => {
  res.json({ allKeys: ALL_PERMISSIONS, labels: PERMISSION_LABELS });
});

module.exports = router;
