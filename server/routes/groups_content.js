/**
 * 境途同游 V6.14 — 群组内容管理路由（F-6 完整内容域 + F-23 细化）
 * 公告 / 相册 / 角色 / 成员角色 / 审计日志 / 金流 / 黑名单 / 日历关注
 *
 * P2-66：自 groups.js 按域拆出（原 L1531–1773），行为逐字保留。
 * P0-2（2026-09-13 修复）：封堵全站零鉴权洞——
 *   读侧普通群内容（公告/相册/角色）加 requireAuth；
 *   管理员专属数据（审计日志/金流/黑名单）加 requireAdminCompat（vrcWithFallback
 *   可静默降级系统 cookie，若不升级门禁将向任意匿名访客暴露管理员数据）；
 *   写侧全部 13 个端点加 adminLimiter + requireAdminCompat，成功后 logOper 留痕。
 *   路由路径与数量不变，仅插入中间件。
 *
 * @swagger
 * tags:
 *   name: GroupsContent
 *   description: 群组公告相册角色审计金流黑名单日历接口
 */
const express = require('express');
const { fail, ok, handleError, sendError, sendVrcError, ErrorCodes, logOper } = require('../utils');
const {
  vrchatGetGroupAnnouncements, vrchatCreateGroupAnnouncement, vrchatDeleteGroupAnnouncement,
  vrchatGetGroupGalleries, vrchatCreateGroupGallery, vrchatGetGroupGallery,
  vrchatUpdateGroupGallery, vrchatDeleteGroupGallery,
  vrchatGetGroupRoles, vrchatCreateGroupRole, vrchatUpdateGroupRole, vrchatDeleteGroupRole,
  vrchatAddGroupMemberRole, vrchatRemoveGroupMemberRole,
  vrchatGetGroupAuditLogs, vrchatGetGroupEconomy, vrchatGetGroupBans,
  vrchatBanGroupMember, vrchatUnbanGroupMember,
  vrchatFollowGroupCalendar, vrchatUnfollowGroupCalendar
} = require('../vrc');
const { vrcWithFallback } = require('./groups_helpers');
const { requireAuth, requireAdminCompat } = require('../auth');
const { adminLimiter } = require('../middleware/security');

module.exports = function (getVRCCookieFn, GROUP_ID, getUserVRCCookieFn) {
  const router = express.Router();

  // ==================== F-6 组完整内容管理 + F-23 细化 ====================
  // 读侧：vrcWithFallback（用户绑定 cookie 失效可降级系统账号）；
  // 写侧：仅用户本人 cookie（群管理权限由 VRChat 侧校验，不降级系统账号，对齐 /vrc/avatar/set）。
  const groupContentCookie = (req) => (typeof getUserVRCCookieFn === 'function' ? getUserVRCCookieFn : getVRCCookieFn)(req);

  // ---- 群公告 ----
  router.get('/group/announcements', requireAuth, async (req, res) => {
    try {
      const { cookie, result } = await vrcWithFallback(req, (ck) => vrchatGetGroupAnnouncements(GROUP_ID, ck), getVRCCookieFn, getUserVRCCookieFn);
      if (!cookie) return fail(res, 401, '请先在个人中心绑定VRChat账号，或由管理员在后台登录VRChat系统账号', { code: 'VRC_SYSTEM_OFFLINE' });
      if (result.status !== 200) return sendVrcError(res, result, '获取群公告');
      // VRChat GET /groups/{id}/announcement 返回单条对象（非数组），统一包装为数组
      let data = result.data;
      if (!Array.isArray(data)) data = Array.isArray(data?.announcements) ? data.announcements : (data && typeof data === 'object' && data.announcementId ? [data] : []);
      ok(res, { announcements: data });
    } catch (e) { handleError(res, e, 'groups/announcements-list'); }
  });

  router.post('/group/announcements', adminLimiter, requireAdminCompat, async (req, res) => {
    try {
      const vrcCookie = groupContentCookie(req);
      if (!vrcCookie) return fail(res, 401, '请先在个人中心绑定VRChat账号', { code: 'VRC_SYSTEM_OFFLINE' });
      const { title, text, sendNotification } = req.body || {};
      if (!title || !String(title).trim()) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '公告标题不能为空');
      if (!text || !String(text).trim()) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '公告内容不能为空');
      const result = await vrchatCreateGroupAnnouncement(GROUP_ID, vrcCookie, {
        title: String(title).trim().slice(0, 120),
        text: String(text).slice(0, 3000),
        sendNotification: sendNotification !== false
      });
      if (result.status !== 200) return sendVrcError(res, result, '发布群公告');
      await logOper(req.session.userId, '发布群公告', `标题: ${String(title).trim().slice(0, 60)}`);
      ok(res, { announcement: result.data });
    } catch (e) { handleError(res, e, 'groups/announcements-create'); }
  });

  router.delete('/group/announcements/:announcementId', adminLimiter, requireAdminCompat, async (req, res) => {
    try {
      const vrcCookie = groupContentCookie(req);
      if (!vrcCookie) return fail(res, 401, '请先在个人中心绑定VRChat账号', { code: 'VRC_SYSTEM_OFFLINE' });
      const result = await vrchatDeleteGroupAnnouncement(GROUP_ID, req.params.announcementId, vrcCookie);
      if (result.status !== 200) return sendVrcError(res, result, '删除群公告');
      await logOper(req.session.userId, '删除群公告', `公告ID: ${req.params.announcementId}`);
      ok(res);
    } catch (e) { handleError(res, e, 'groups/announcements-delete'); }
  });

  // ---- 群相册 ----
  router.get('/group/galleries', requireAuth, async (req, res) => {
    try {
      const { cookie, result } = await vrcWithFallback(req, (ck) => vrchatGetGroupGalleries(GROUP_ID, ck), getVRCCookieFn, getUserVRCCookieFn);
      if (!cookie) return fail(res, 401, '请先在个人中心绑定VRChat账号，或由管理员在后台登录VRChat系统账号', { code: 'VRC_SYSTEM_OFFLINE' });
      if (result.status !== 200) return sendVrcError(res, result, '获取群相册');
      const data = Array.isArray(result.data) ? result.data : (result.data?.galleries || []);
      ok(res, { galleries: data });
    } catch (e) { handleError(res, e, 'groups/galleries-list'); }
  });

  router.get('/group/galleries/:galleryId', requireAuth, async (req, res) => {
    try {
      const { cookie, result } = await vrcWithFallback(req, (ck) => vrchatGetGroupGallery(GROUP_ID, req.params.galleryId, ck), getVRCCookieFn, getUserVRCCookieFn);
      if (!cookie) return fail(res, 401, '请先在个人中心绑定VRChat账号，或由管理员在后台登录VRChat系统账号', { code: 'VRC_SYSTEM_OFFLINE' });
      if (result.status !== 200) return sendVrcError(res, result, '获取群相册详情');
      ok(res, { gallery: result.data });
    } catch (e) { handleError(res, e, 'groups/galleries-detail'); }
  });

  router.post('/group/galleries', adminLimiter, requireAdminCompat, async (req, res) => {
    try {
      const vrcCookie = groupContentCookie(req);
      if (!vrcCookie) return fail(res, 401, '请先在个人中心绑定VRChat账号', { code: 'VRC_SYSTEM_OFFLINE' });
      const { name, description } = req.body || {};
      if (!name || !String(name).trim()) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '相册名称不能为空');
      const result = await vrchatCreateGroupGallery(GROUP_ID, vrcCookie, {
        name: String(name).trim().slice(0, 60),
        description: String(description || '').slice(0, 500)
      });
      if (result.status !== 200) return sendVrcError(res, result, '创建群相册');
      await logOper(req.session.userId, '创建群相册', `名称: ${String(name).trim().slice(0, 60)}`);
      ok(res, { gallery: result.data });
    } catch (e) { handleError(res, e, 'groups/galleries-create'); }
  });

  router.put('/group/galleries/:galleryId', adminLimiter, requireAdminCompat, async (req, res) => {
    try {
      const vrcCookie = groupContentCookie(req);
      if (!vrcCookie) return fail(res, 401, '请先在个人中心绑定VRChat账号', { code: 'VRC_SYSTEM_OFFLINE' });
      const { name, description } = req.body || {};
      const body = {};
      if (name !== undefined) body.name = String(name).trim().slice(0, 60);
      if (description !== undefined) body.description = String(description).slice(0, 500);
      if (Object.keys(body).length === 0) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '没有需要更新的字段');
      const result = await vrchatUpdateGroupGallery(GROUP_ID, req.params.galleryId, vrcCookie, body);
      if (result.status !== 200) return sendVrcError(res, result, '更新群相册');
      await logOper(req.session.userId, '更新群相册', `相册ID: ${req.params.galleryId}`);
      ok(res, { gallery: result.data });
    } catch (e) { handleError(res, e, 'groups/galleries-update'); }
  });

  router.delete('/group/galleries/:galleryId', adminLimiter, requireAdminCompat, async (req, res) => {
    try {
      const vrcCookie = groupContentCookie(req);
      if (!vrcCookie) return fail(res, 401, '请先在个人中心绑定VRChat账号', { code: 'VRC_SYSTEM_OFFLINE' });
      const result = await vrchatDeleteGroupGallery(GROUP_ID, req.params.galleryId, vrcCookie);
      if (result.status !== 200) return sendVrcError(res, result, '删除群相册');
      await logOper(req.session.userId, '删除群相册', `相册ID: ${req.params.galleryId}`);
      ok(res);
    } catch (e) { handleError(res, e, 'groups/galleries-delete'); }
  });

  // ---- 群角色管理 ----
  router.get('/group/roles', requireAuth, async (req, res) => {
    try {
      const { cookie, result } = await vrcWithFallback(req, (ck) => vrchatGetGroupRoles(GROUP_ID, ck), getVRCCookieFn, getUserVRCCookieFn);
      if (!cookie) return fail(res, 401, '请先在个人中心绑定VRChat账号，或由管理员在后台登录VRChat系统账号', { code: 'VRC_SYSTEM_OFFLINE' });
      if (result.status !== 200) return sendVrcError(res, result, '获取群角色');
      const data = Array.isArray(result.data) ? result.data : (result.data?.roles || []);
      ok(res, { roles: data });
    } catch (e) { handleError(res, e, 'groups/roles-list'); }
  });

  router.post('/group/roles', adminLimiter, requireAdminCompat, async (req, res) => {
    try {
      const vrcCookie = groupContentCookie(req);
      if (!vrcCookie) return fail(res, 401, '请先在个人中心绑定VRChat账号', { code: 'VRC_SYSTEM_OFFLINE' });
      const { name, description, isSelfAssignable } = req.body || {};
      if (!name || !String(name).trim()) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '角色名称不能为空');
      const body = { name: String(name).trim().slice(0, 60) };
      if (description !== undefined) body.description = String(description).slice(0, 500);
      if (isSelfAssignable !== undefined) body.isSelfAssignable = !!isSelfAssignable;
      const result = await vrchatCreateGroupRole(GROUP_ID, vrcCookie, body);
      if (result.status !== 200) return sendVrcError(res, result, '创建群角色');
      await logOper(req.session.userId, '创建群角色', `名称: ${String(name).trim().slice(0, 60)}`);
      ok(res, { role: result.data });
    } catch (e) { handleError(res, e, 'groups/roles-create'); }
  });

  router.put('/group/roles/:roleId', adminLimiter, requireAdminCompat, async (req, res) => {
    try {
      const vrcCookie = groupContentCookie(req);
      if (!vrcCookie) return fail(res, 401, '请先在个人中心绑定VRChat账号', { code: 'VRC_SYSTEM_OFFLINE' });
      const { name, description, isSelfAssignable } = req.body || {};
      const body = {};
      if (name !== undefined) body.name = String(name).trim().slice(0, 60);
      if (description !== undefined) body.description = String(description).slice(0, 500);
      if (isSelfAssignable !== undefined) body.isSelfAssignable = !!isSelfAssignable;
      if (Object.keys(body).length === 0) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '没有需要更新的字段');
      const result = await vrchatUpdateGroupRole(GROUP_ID, req.params.roleId, vrcCookie, body);
      if (result.status !== 200) return sendVrcError(res, result, '更新群角色');
      await logOper(req.session.userId, '更新群角色', `角色ID: ${req.params.roleId}`);
      ok(res, { role: result.data });
    } catch (e) { handleError(res, e, 'groups/roles-update'); }
  });

  router.delete('/group/roles/:roleId', adminLimiter, requireAdminCompat, async (req, res) => {
    try {
      const vrcCookie = groupContentCookie(req);
      if (!vrcCookie) return fail(res, 401, '请先在个人中心绑定VRChat账号', { code: 'VRC_SYSTEM_OFFLINE' });
      const result = await vrchatDeleteGroupRole(GROUP_ID, req.params.roleId, vrcCookie);
      if (result.status !== 200) return sendVrcError(res, result, '删除群角色');
      await logOper(req.session.userId, '删除群角色', `角色ID: ${req.params.roleId}`);
      ok(res);
    } catch (e) { handleError(res, e, 'groups/roles-delete'); }
  });

  router.put('/group/members/:vrchatId/roles/:roleId', adminLimiter, requireAdminCompat, async (req, res) => {
    try {
      const vrcCookie = groupContentCookie(req);
      if (!vrcCookie) return fail(res, 401, '请先在个人中心绑定VRChat账号', { code: 'VRC_SYSTEM_OFFLINE' });
      const { action } = req.body || {};
      const wantRemove = action === 'remove';
      const result = wantRemove
        ? await vrchatRemoveGroupMemberRole(GROUP_ID, req.params.vrchatId, req.params.roleId, vrcCookie)
        : await vrchatAddGroupMemberRole(GROUP_ID, req.params.vrchatId, req.params.roleId, vrcCookie);
      if (result.status !== 200) return sendVrcError(res, result, wantRemove ? '移除成员角色' : '授予成员角色');
      await logOper(req.session.userId, wantRemove ? '移除成员角色' : '授予成员角色', `成员: ${req.params.vrchatId}, 角色: ${req.params.roleId}`);
      ok(res);
    } catch (e) { handleError(res, e, 'groups/member-role'); }
  });

  // ---- F-23：审计日志 / 经济 / 黑名单 / 日历关注 ----
  // 审计日志、金流、黑名单为 VRChat 群管理员专属数据：读侧同样 requireAdminCompat，
  // 防止 vrcWithFallback 降级系统 cookie 后向任意匿名访客泄露（P0-2）。
  router.get('/group/audit-logs', requireAdminCompat, async (req, res) => {
    try {
      const { cookie, result } = await vrcWithFallback(req, (ck) => vrchatGetGroupAuditLogs(GROUP_ID, ck), getVRCCookieFn, getUserVRCCookieFn);
      if (!cookie) return fail(res, 401, '请先在个人中心绑定VRChat账号，或由管理员在后台登录VRChat系统账号', { code: 'VRC_SYSTEM_OFFLINE' });
      if (result.status !== 200) return sendVrcError(res, result, '获取群审计日志');
      const data = Array.isArray(result.data) ? result.data : (result.data?.auditLogs || []);
      ok(res, { auditLogs: data });
    } catch (e) { handleError(res, e, 'groups/audit-logs'); }
  });

  router.get('/group/economy', requireAdminCompat, async (req, res) => {
    try {
      const { cookie, result } = await vrcWithFallback(req, (ck) => vrchatGetGroupEconomy(GROUP_ID, ck), getVRCCookieFn, getUserVRCCookieFn);
      if (!cookie) return fail(res, 401, '请先在个人中心绑定VRChat账号，或由管理员在后台登录VRChat系统账号', { code: 'VRC_SYSTEM_OFFLINE' });
      if (result.status !== 200) return sendVrcError(res, result, '获取群经济信息');
      ok(res, { economy: result.data });
    } catch (e) { handleError(res, e, 'groups/economy'); }
  });

  router.get('/group/bans', requireAdminCompat, async (req, res) => {
    try {
      const { cookie, result } = await vrcWithFallback(req, (ck) => vrchatGetGroupBans(GROUP_ID, ck), getVRCCookieFn, getUserVRCCookieFn);
      if (!cookie) return fail(res, 401, '请先在个人中心绑定VRChat账号，或由管理员在后台登录VRChat系统账号', { code: 'VRC_SYSTEM_OFFLINE' });
      if (result.status !== 200) return sendVrcError(res, result, '获取群黑名单');
      const data = Array.isArray(result.data) ? result.data : (result.data?.bans || []);
      ok(res, { bans: data });
    } catch (e) { handleError(res, e, 'groups/bans-list'); }
  });

  router.post('/group/bans', adminLimiter, requireAdminCompat, async (req, res) => {
    try {
      const vrcCookie = groupContentCookie(req);
      if (!vrcCookie) return fail(res, 401, '请先在个人中心绑定VRChat账号', { code: 'VRC_SYSTEM_OFFLINE' });
      const { userId } = req.body || {};
      if (!userId) return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'userId 不能为空');
      const result = await vrchatBanGroupMember(GROUP_ID, vrcCookie, userId);
      if (result.status !== 200) return sendVrcError(res, result, '封禁群成员');
      await logOper(req.session.userId, '封禁群成员', `成员: ${userId}`);
      ok(res, { ban: result.data });
    } catch (e) { handleError(res, e, 'groups/bans-create'); }
  });

  router.delete('/group/bans/:vrchatId', adminLimiter, requireAdminCompat, async (req, res) => {
    try {
      const vrcCookie = groupContentCookie(req);
      if (!vrcCookie) return fail(res, 401, '请先在个人中心绑定VRChat账号', { code: 'VRC_SYSTEM_OFFLINE' });
      const result = await vrchatUnbanGroupMember(GROUP_ID, req.params.vrchatId, vrcCookie);
      if (result.status !== 200) return sendVrcError(res, result, '解封群成员');
      await logOper(req.session.userId, '解封群成员', `成员: ${req.params.vrchatId}`);
      ok(res);
    } catch (e) { handleError(res, e, 'groups/bans-delete'); }
  });

  router.post('/group/calendar/follow', adminLimiter, requireAdminCompat, async (req, res) => {
    try {
      const vrcCookie = groupContentCookie(req);
      if (!vrcCookie) return fail(res, 401, '请先在个人中心绑定VRChat账号', { code: 'VRC_SYSTEM_OFFLINE' });
      const result = await vrchatFollowGroupCalendar(GROUP_ID, vrcCookie);
      if (result.status !== 200) return sendVrcError(res, result, '关注群日历');
      await logOper(req.session.userId, '关注群日历', `群组: ${GROUP_ID}`);
      ok(res);
    } catch (e) { handleError(res, e, 'groups/calendar-follow'); }
  });

  router.delete('/group/calendar/follow', adminLimiter, requireAdminCompat, async (req, res) => {
    try {
      const vrcCookie = groupContentCookie(req);
      if (!vrcCookie) return fail(res, 401, '请先在个人中心绑定VRChat账号', { code: 'VRC_SYSTEM_OFFLINE' });
      const result = await vrchatUnfollowGroupCalendar(GROUP_ID, vrcCookie);
      if (result.status !== 200) return sendVrcError(res, result, '取消关注群日历');
      await logOper(req.session.userId, '取消关注群日历', `群组: ${GROUP_ID}`);
      ok(res);
    } catch (e) { handleError(res, e, 'groups/calendar-unfollow'); }
  });

  return router;
};
