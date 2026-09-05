/**
 * 境途同游 V6.2 — 权限组系统路由
 * 支持：创建/删除/编辑权限组、父子层级、默认用户组、用户多组归属、权限冲突检测
 * 
 * @swagger
 * tags:
 *   name: PermissionGroups
 *   description: 权限组系统相关接口
 */
const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../auth');
const { fail, ok, getPool, handleError, validateFields , sendError, ErrorCodes } = require('../utils');

// 所有已定义的权限键（用英文常量，前端映射中文显示）
const ALL_PERMISSIONS = [
  'can_create_album', 'can_create_photo', 'can_delete_photo',
  'can_create_announcement', 'can_edit_announcement', 'can_delete_announcement',
  'can_create_event', 'can_edit_event', 'can_delete_event',
  'can_sign_event', 'can_comment_event',
  'can_manage_users', 'can_manage_roles',
  'can_review_names', 'can_manage_permissions',
  'can_sync_vrchat', 'can_manage_rosters',
  'can_view_logs', 'can_upload_group_image',
  'can_edit_profile', 'can_change_password',
  'can_view_members', 'can_view_map',
  'can_view_album', 'can_view_events',
  'can_create_album_category',
  // V6.9: 动态/朋友圈
  'can_create_post', 'can_delete_post', 'can_comment_post', 'can_like_post',
  // V7.x: 模型收藏馆（服务器端 VRChat 模型收藏管理）
  'can_manage_model_collections'
];

const PERMISSION_LABELS = {
  can_create_album: '创建相册',
  can_create_photo: '上传照片',
  can_delete_photo: '删除照片',
  can_create_announcement: '发布公告',
  can_edit_announcement: '编辑公告',
  can_delete_announcement: '删除公告',
  can_create_event: '创建活动',
  can_edit_event: '编辑活动',
  can_delete_event: '删除活动',
  can_sign_event: '报名活动',
  can_comment_event: '活动评论',
  can_manage_users: '管理用户',
  can_manage_roles: '管理角色',
  can_review_names: '审核改名',
  can_manage_permissions: '管理权限',
  can_sync_vrchat: '同步VRChat',
  can_manage_rosters: '管理名册',
  can_view_logs: '查看日志',
  can_upload_group_image: '上传群图',
  can_edit_profile: '编辑资料',
  can_change_password: '修改密码',
  can_view_members: '查看成员',
  can_view_map: '查看地图',
  can_view_album: '查看相册',
  can_view_events: '查看活动',
  can_create_album_category: '创建相册分类',
  // V6.9: 动态/朋友圈
  can_create_post: '发布动态',
  can_delete_post: '删除动态',
  can_comment_post: '评论动态',
  can_like_post: '点赞动态',
  // V7.x: 模型收藏馆
  can_manage_model_collections: '管理模型收藏'
};

// ==================== 权限组 CRUD ====================

/**
 * @swagger
 * /api/groups:
 *   get:
 *     summary: 获取权限组列表
 *     description: 获取所有权限组，包含权限条目（超级管理员权限）
 *     tags: [PermissionGroups]
 *     responses:
 *       200:
 *         description: 权限组列表
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 groups:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: integer
 *                       name:
 *                         type: string
 *                       description:
 *                         type: string
 *                       parentId:
 *                         type: integer
 *                       permissions:
 *                         type: object
 *       403:
 *         description: 权限不足
 */
router.get('/groups', requireRole('super_admin'), async (req, res) => {
  try {
    const [rows] = await getPool().query(
      `SELECT id, name, description, parent_id AS parentId, is_default AS isDefault,
              is_system AS isSystem, created_at AS createdAt, updated_at AS updatedAt
       FROM permission_groups ORDER BY is_system DESC, id ASC`
    );
    // 获取每个组的权限条目
    const groups = await Promise.all(rows.map(async g => {
      const [perms] = await getPool().query(
        `SELECT permission_key AS perm_key, permission_value AS value FROM group_permission_entries WHERE group_id = ?`,
        [g.id]
      );
      const permMap = {};
      for (const p of perms) permMap[p.perm_key] = !!p.value;
      return { ...g, permissions: permMap };
    }));
    res.json({ groups });
  } catch (e) { handleError(res, e, '[permission-groups/list]'); }
});

// 创建权限组
router.post('/groups', requireRole('super_admin'), async (req, res) => {
  try {
    const { name, description, parentId } = req.body;
    if (!name || !name.trim()) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '权限组名称不能为空');
    const trimmed = name.trim();
    const [dup] = await getPool().query(`SELECT id FROM permission_groups WHERE name = ?`, [trimmed]);
    if (dup.length > 0) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '该权限组名称已存在');
    // 检查父组是否存在
    if (parentId) {
      const [parentCheck] = await getPool().query(`SELECT id FROM permission_groups WHERE id = ?`, [parentId]);
      if (parentCheck.length === 0) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '父权限组不存在');
    }
    const [result] = await getPool().query(
      `INSERT INTO permission_groups (name, description, parent_id) VALUES (?, ?, ?)`,
      [trimmed, description || '', parentId || null]
    );
    // 新组默认继承父组的权限
    if (parentId) {
      const [parentPerms] = await getPool().query(
        `SELECT permission_key, permission_value FROM group_permission_entries WHERE group_id = ?`, [parentId]
      );
      for (const p of parentPerms) {
        await getPool().query(
          `INSERT INTO group_permission_entries (group_id, permission_key, permission_value) VALUES (?, ?, ?)`,
          [result.insertId, p.permission_key, p.permission_value]
        );
      }
    }
    ok(res, {id: result.insertId, message: '权限组已创建'});
  } catch (e) { handleError(res, e, '[permission-groups/create]'); }
});

// 更新权限组（名称/描述/父组）
router.put('/groups/:id', requireRole('super_admin'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
    // 检查是否系统内置组
    const [group] = await getPool().query(`SELECT is_system FROM permission_groups WHERE id = ?`, [id]);
    if (group.length === 0) return sendError(res, 404, ErrorCodes.NOT_FOUND, '权限组不存在');
    const { name, description, parentId } = req.body;
    const updates = {};
    if (name !== undefined) {
      if (!name.trim()) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '名称不能为空');
      const [dup] = await getPool().query(`SELECT id FROM permission_groups WHERE name = ? AND id != ?`, [name.trim(), id]);
      if (dup.length > 0) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '名称已存在');
      updates.name = name.trim();
    }
    if (description !== undefined) updates.description = description;
    if (parentId !== undefined) {
      // 防止循环引用
      if (parentId === id) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '不能将自己设为父组');
      if (parentId) {
        const [check] = await getPool().query(`SELECT id FROM permission_groups WHERE id = ?`, [parentId]);
        if (check.length === 0) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '父组不存在');
      }
      updates.parent_id = parentId || null;
    }
    validateFields(updates, ['name', 'description', 'parent_id']);
    if (Object.keys(updates).length === 0) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '无更新字段');
    const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const vals = Object.values(updates);
    vals.push(id);
    await getPool().query(`UPDATE permission_groups SET ${fields} WHERE id = ?`, vals);
    ok(res, {message: '权限组已更新'});
  } catch (e) { handleError(res, e, '[permission-groups/update]'); }
});

// 删除权限组
router.delete('/groups/:id', requireRole('super_admin'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
    const [group] = await getPool().query(`SELECT is_system FROM permission_groups WHERE id = ?`, [id]);
    if (group.length === 0) return sendError(res, 404, ErrorCodes.NOT_FOUND, '权限组不存在');
    if (group[0].is_system) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '系统内置组不可删除');
    // 将属于该组的用户移到默认组
    const [defaultGroup] = await getPool().query(`SELECT id FROM permission_groups WHERE is_default = 1 LIMIT 1`);
    const defaultId = defaultGroup.length > 0 ? defaultGroup[0].id : 3;

    // 用事务包裹三条语句，避免部分失败导致孤儿数据
    const conn = await getPool().getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(`UPDATE user_group_membership SET group_id = ? WHERE group_id = ?`, [defaultId, id]);
      await conn.query(`DELETE FROM group_permission_entries WHERE group_id = ?`, [id]);
      await conn.query(`DELETE FROM permission_groups WHERE id = ?`, [id]);
      await conn.commit();
    } catch (e2) {
      await conn.rollback();
      throw e2;
    } finally {
      conn.release();
    }
    ok(res, {message: '权限组已删除'});
  } catch (e) { handleError(res, e, '[permission-groups/delete]'); }
});

// ==================== 权限条目管理 ====================

// 获取某个组的权限列表
router.get('/groups/:id/permissions', requireRole('super_admin'), async (req, res) => {
  try {
    const [rows] = await getPool().query(
      `SELECT permission_key AS perm_key, permission_value AS value FROM group_permission_entries WHERE group_id = ?`,
      [req.params.id]
    );
    const permMap = {};
    for (const p of rows) permMap[p.perm_key] = !!p.value;
    res.json({ permissions: permMap, allKeys: ALL_PERMISSIONS, labels: PERMISSION_LABELS });
  } catch (e) { handleError(res, e, '[permission-groups/permissions]'); }
});

// 更新组的单个权限
router.post('/groups/:id/permissions/set', requireRole('super_admin'), async (req, res) => {
  try {
    const groupId = parseInt(req.params.id);
    const { key, value } = req.body;
    if (!key) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '缺少权限键');
    if (!ALL_PERMISSIONS.includes(key)) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '无效的权限键');
    // 检查是否有冲突（父组权限与此相反则警告但不阻止）
    const [group] = await getPool().query(`SELECT parent_id FROM permission_groups WHERE id = ?`, [groupId]);
    let conflict = null;
    if (group.length > 0 && group[0].parent_id) {
      const [parentPerm] = await getPool().query(
        `SELECT permission_value FROM group_permission_entries WHERE group_id = ? AND permission_key = ?`,
        [group[0].parent_id, key]
      );
      if (parentPerm.length > 0 && !!parentPerm[0].permission_value !== !!value) {
        conflict = '与父权限组的设置相反';
      }
    }
    const v = value ? 1 : 0;
    await getPool().query(
      `INSERT INTO group_permission_entries (group_id, permission_key, permission_value) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE permission_value = ?`,
      [groupId, key, v, v]
    );
    ok(res, {conflict, message: '权限已更新' + (conflict ? '（注意：' + conflict + '）' : '')});
  } catch (e) { handleError(res, e, '[permission-groups/set-permission]'); }
});

// 批量更新组的权限
router.post('/groups/:id/permissions/batch', requireRole('super_admin'), async (req, res) => {
  try {
    const groupId = parseInt(req.params.id);
    const { permissions } = req.body; // { key: value, ... }
    if (!permissions || typeof permissions !== 'object') return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
    let count = 0;
    for (const [key, value] of Object.entries(permissions)) {
      if (!ALL_PERMISSIONS.includes(key)) continue;
      const v = value ? 1 : 0;
      await getPool().query(
        `INSERT INTO group_permission_entries (group_id, permission_key, permission_value) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE permission_value = ?`,
        [groupId, key, v, v]
      );
      count++;
    }
    ok(res, {updated: count, message: `${count} 项权限已更新`});
  } catch (e) { handleError(res, e, '[permission-groups/batch-permissions]'); }
});

// ==================== 用户归属管理 ====================

// 获取某个用户的权限组归属
router.get('/users/:userId/groups', requireRole('super_admin'), async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    if (!Number.isInteger(userId) || userId <= 0) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '无效的用户ID');
    const [rows] = await getPool().query(
      `SELECT pg.id, pg.name, pg.description, pg.parent_id AS parentId,
              pg.is_default AS isDefault, pg.is_system AS isSystem,
              ugm.joined_at AS joinedAt
       FROM user_group_membership ugm
       JOIN permission_groups pg ON ugm.group_id = pg.id
       WHERE ugm.user_id = ?`, [userId]
    );
    // 获取可用（未加入的）组
    const [allGroups] = await getPool().query(
      `SELECT id, name FROM permission_groups ORDER BY name`
    );
    const joinedIds = new Set(rows.map(r => r.id));
    const available = allGroups.filter(g => !joinedIds.has(g.id));
    res.json({ groups: rows, available });
  } catch (e) { handleError(res, e, '[permission-groups/user-groups]'); }
});

// 为用户添加权限组
router.post('/users/:userId/groups', requireRole('super_admin'), async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    if (!Number.isInteger(userId) || userId <= 0) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '无效的用户ID');
    const { groupId } = req.body;
    if (!groupId) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '缺少权限组ID');
    // 检查是否已加入
    const [existing] = await getPool().query(
      `SELECT id FROM user_group_membership WHERE user_id = ? AND group_id = ?`, [userId, groupId]
    );
    if (existing.length > 0) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '用户已加入该权限组');
    // 冲突检测：同一层级组不能同时加入（如果有相同父组）
    const [newGroup] = await getPool().query(`SELECT parent_id FROM permission_groups WHERE id = ?`, [groupId]);
    if (newGroup.length === 0) return sendError(res, 404, ErrorCodes.NOT_FOUND, '权限组不存在');
    const [userGroups] = await getPool().query(
      `SELECT pg.id, pg.parent_id FROM user_group_membership ugm
       JOIN permission_groups pg ON ugm.group_id = pg.id
       WHERE ugm.user_id = ?`, [userId]
    );
    let conflicts = [];
    if (newGroup[0].parent_id) {
      // 检查是否已加入同父组的其他组
      const sameParent = userGroups.filter(g => g.parent_id === newGroup[0].parent_id);
      if (sameParent.length > 0) {
        conflicts = sameParent.map(g => `已加入同层组(ID:${g.id})`);
      }
    }
    await getPool().query(
      `INSERT INTO user_group_membership (user_id, group_id) VALUES (?, ?)`, [userId, groupId]
    );
    ok(res, {message: '用户已加入权限组' + (conflicts.length > 0 ? '（注意：' + conflicts.join('; ') + '）' : '')});
  } catch (e) { handleError(res, e, '[permission-groups/add-user-group]'); }
});

// 从权限组移除用户
router.delete('/users/:userId/groups/:groupId', requireRole('super_admin'), async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    if (!Number.isInteger(userId) || userId <= 0) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '无效的用户ID');
    const groupId = parseInt(req.params.groupId);
    // 检查是否是用户的最后一个默认组
    const [defaultGroup] = await getPool().query(`SELECT id FROM permission_groups WHERE is_default = 1 LIMIT 1`);
    const defaultId = defaultGroup.length > 0 ? defaultGroup[0].id : 3;
    const [membership] = await getPool().query(
      `SELECT ugm.id FROM user_group_membership ugm WHERE ugm.user_id = ? AND ugm.group_id = ?`,
      [userId, groupId]
    );
    if (membership.length === 0) return sendError(res, 404, ErrorCodes.NOT_FOUND, '用户不在该权限组中');
    await getPool().query(`DELETE FROM user_group_membership WHERE user_id = ? AND group_id = ?`, [userId, groupId]);
    // 如果用户没有组了，自动加入默认组
    const [remaining] = await getPool().query(
      `SELECT COUNT(*) as c FROM user_group_membership WHERE user_id = ?`, [userId]
    );
    if (remaining[0].c === 0) {
      await getPool().query(
        `INSERT INTO user_group_membership (user_id, group_id) VALUES (?, ?)`, [userId, defaultId]
      );
    }
    ok(res, {message: '用户已从权限组移除'});
  } catch (e) { handleError(res, e, '[permission-groups/remove-user-group]'); }
});

// ==================== 获取当前用户有效权限 ====================
router.get('/my', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    // 获取用户所在的所有组
    const [userGroups] = await getPool().query(
      `SELECT group_id FROM user_group_membership WHERE user_id = ?`, [userId]
    );
    if (userGroups.length === 0) return res.json({ permissions: {}, groupIds: [] });
    const groupIds = userGroups.map(g => g.group_id);
    // 从所有组获取权限并合并（任意组允许=允许）
    const [permRows] = await getPool().query(
      `SELECT permission_key AS perm_key, MAX(permission_value) AS value
       FROM group_permission_entries
       WHERE group_id IN (${groupIds.map(() => '?').join(',')})
       GROUP BY permission_key`,
      groupIds
    );
    const permMap = {};
    for (const p of permRows) permMap[p.perm_key] = !!p.value;
    res.json({ permissions: permMap, groupIds });
  } catch (e) {
    console.error('[permission-groups/my] 权限查询失败:', e.message);
    return fail(res, 500, '权限查询失败，请稍后重试', { code: 'PERM_QUERY_FAILED' });
  }
});

// ==================== 获取所有权限定义 ====================
router.get('/definitions', requireRole('super_admin'), (req, res) => {
  res.json({ allKeys: ALL_PERMISSIONS, labels: PERMISSION_LABELS });
});

// 同时导出权限常量，供权限查看接口复用（单一事实来源，避免与前端标签漂移）
module.exports = router;
module.exports.ALL_PERMISSIONS = ALL_PERMISSIONS;
module.exports.PERMISSION_LABELS = PERMISSION_LABELS;
