/**
 * 境途同游 V6.14 — VRChat 群组路由（从 server.js 提取）
 * 群组信息、成员同步/在线状态/变更日志、VRChat user/world 查询
 * 
 * @swagger
 * tags:
 *   name: Groups
 *   description: VRChat群组相关接口
 */
const express = require('express');
const { fail, ok,  getPool, handleError , sendError, sendVrcError, ErrorCodes, logOper  } = require('../utils');;
const { requireAuth, requireAdminCompat } = require('../auth');
const {
  vrchatRequest, vrchatGetCurrentUser, vrchatGetCurrentUserResult, vrchatGetGroupMembers,
  vrchatGetUser, vrchatResolveOnlineStatuses, vrchatGetFriendsOnlineMap, vrchatGetWorld, vrchatGetInstance, vrchatSearchWorlds,
  vrchatSearchAvatars, vrchatGetAvatar, vrchatSetAvatar, vrchatGetUserPublicAvatars, VRC_API_KEY,
  vrchatGetGroupAnnouncements, vrchatCreateGroupAnnouncement, vrchatDeleteGroupAnnouncement,
  vrchatGetGroupGalleries, vrchatCreateGroupGallery, vrchatGetGroupGallery, vrchatUpdateGroupGallery, vrchatDeleteGroupGallery,
  vrchatGetGroupRoles, vrchatCreateGroupRole, vrchatUpdateGroupRole, vrchatDeleteGroupRole,
  vrchatAddGroupMemberRole, vrchatRemoveGroupMemberRole,
  vrchatGetGroupAuditLogs, vrchatGetGroupEconomy, vrchatGetGroupBans, vrchatBanGroupMember, vrchatUnbanGroupMember,
  vrchatFollowGroupCalendar, vrchatUnfollowGroupCalendar
} = require('../vrc');
const logger = require('../logger');
const schedule = require('../schedule');

const VRC = require('../vrc');
const VRC_API = VRC.VRC_API || 'https://api.vrchat.cloud/api/1';
const { vrcWithFallback: vrcWithFallbackCore } = require('./groups_helpers');

// ==================== 角色中文映射 ====================
const ROLE_CN_MAP = {
  'Group Owner': '群主', 'Owner': '群主', 'Admin': '管理员', 'Manager': '管理员',
  'Moderator': '协管', 'Mod': '协管', 'Member': '成员', 'Guest': '访客',
  'Recruiter': '招募官', 'Event Host': '活动主持', 'Event Coordinator': '活动协调',
  'Event Organizer': '活动组织者', 'Supporter': '支持者',
  'Contributor': '贡献者', 'Developer': '开发者', 'Artist': '画师',
  'Musician': '音乐人', 'Streamer': '主播', 'Tester': '测试员',
  'Bot': '机器人', 'Everyone': '所有人', 'Citizen': '公民', 'Resident': '居民',
};

/**
 * @param {Function} getVRCCookieFn - 获取 VRChat cookie 的函数
 */
module.exports = function (getVRCCookieFn, GROUP_ID, getUserVRCCookieFn) {
  const router = express.Router();

  /**
   * VRChat 调用 + 401 降级重试的薄封装。
   * 实现已随 P2-66 拆分收敛到 routes/groups_helpers.js（单一实现，getVRCCookieFn /
   * getUserVRCCookieFn 改为显式入参），各子路由直连 helper；这里仅保留 (req, run)
   * 闭包签名供本文件留守路由使用，行为与拆分前逐字一致。
   * @param {object} req
   * @param {(cookie: string) => Promise<any>} run 用给定 cookie 执行的实际调用
   * @returns {Promise<{cookie: string|null, result: any}>}
   */
  async function vrcWithFallback(req, run) {
    return vrcWithFallbackCore(req, run, getVRCCookieFn, getUserVRCCookieFn);
  }

  // ==================== VRChat 用户查询 ====================
  router.post('/vrc/lookup', async (req, res) => {
    if (!getVRCCookieFn(req)) return fail(res, 401, '请先在个人中心绑定VRChat账号，或由管理员在后台登录VRChat系统账号', { code: 'VRC_SYSTEM_OFFLINE' });
    try {
      const { query } = req.body;
      if (!query) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请输入搜索内容');
      const encoded = encodeURIComponent(query);
      // P1-34: 改走 vrchatRequest，汇入全站统一令牌桶（旧裸 fetch 是旁路，
      // 高峰期可与定时任务叠加超过 VRChat 官方限速），并复用其超时/429 退避。
      const vrcFetch = async (endpoint, cookie) => {
        const r = await vrchatRequest('GET', endpoint, null, cookie);
        return { status: r.status, ok: r.status >= 200 && r.status < 300, data: r.data };
      };
      const { cookie: vrcCookie, result: direct } = await vrcWithFallback(req,
        (c) => vrcFetch(`/users/${encoded}?apiKey=${VRC_API_KEY}`, c));
      if (!direct.ok) {
        const searchOut = await vrcFetch(`/users?search=${encoded}&n=5&apiKey=${VRC_API_KEY}`, vrcCookie);
        if (!searchOut.ok) return sendVrcError(res, { status: searchOut.status }, '查询 VRChat 用户');
        const users = Array.isArray(searchOut.data) ? searchOut.data : [];
        return res.json({ users: users.map(u => ({ id: u.id, displayName: u.displayName, avatarUrl: u.currentAvatarThumbnailImageUrl || u.userIcon || '' })) });
      }
      const user = direct.data;
      res.json({ user: { id: user.id, displayName: user.displayName, avatarUrl: user.currentAvatarThumbnailImageUrl || user.userIcon || '' } });
    } catch (e) { handleError(res, e, 'groups/vrc-lookup'); }
  });

  // ==================== 获取群组信息 ====================
  router.get('/group', async (req, res) => {
    if (!getVRCCookieFn(req)) return fail(res, 401, '请先在个人中心绑定VRChat账号，或由管理员在后台登录VRChat系统账号', { code: 'VRC_SYSTEM_OFFLINE' });
    try {
      const { cookie: vrcCookie, result: groupRes } = await vrcWithFallback(req,
        (c) => vrchatRequest('GET', `/groups/${GROUP_ID}?apiKey=${VRC_API_KEY}`, null, c));
      if (groupRes.status !== 200) return sendVrcError(res, groupRes, '获取群组信息');
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
    } catch (e) { handleError(res, e, 'groups/group'); }
  });

  // ==================== VRChat World 详情 ====================
  router.get('/vrc/world/:worldId', async (req, res) => {
    if (!getVRCCookieFn(req)) return fail(res, 401, '请先在个人中心绑定VRChat账号，或由管理员在后台登录VRChat系统账号', { code: 'VRC_SYSTEM_OFFLINE' });
    try {
      const { result: wr } = await vrcWithFallback(req, (c) => vrchatGetWorld(req.params.worldId, c));
      if (wr.status !== 200) return sendVrcError(res, wr, '获取世界详情');
      res.json(wr.data);
    } catch (e) { handleError(res, e, 'groups/world'); }
  });

  // ==================== VRChat World 搜索 ====================
  router.get('/vrc/worlds/search', async (req, res) => {
    if (!getVRCCookieFn(req)) return fail(res, 401, '请先在个人中心绑定VRChat账号，或由管理员在后台登录VRChat系统账号', { code: 'VRC_SYSTEM_OFFLINE' });
    try {
      const q = req.query.q || '';
      const n = parseInt(req.query.n) || 10;
      if (!q) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请输入搜索关键词');
      const { result: wr } = await vrcWithFallback(req, (c) => vrchatSearchWorlds(q, n, c));
      if (wr.status !== 200) return sendVrcError(res, wr, '搜索世界');
      res.json({ worlds: wr.data });
    } catch (e) { handleError(res, e, 'groups/worlds-search'); }
  });

  // ==================== VRChat Avatar 搜索 ====================
  router.get('/vrc/avatars/search', async (req, res) => {
    if (!getVRCCookieFn(req)) return fail(res, 401, '请先在个人中心绑定VRChat账号，或由管理员在后台登录VRChat系统账号', { code: 'VRC_SYSTEM_OFFLINE' });
    try {
      const q = req.query.q || '';
      const n = parseInt(req.query.n) || 10;
      if (!q) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请输入搜索关键词');
      const { result: av } = await vrcWithFallback(req, (c) => vrchatSearchAvatars(q, n, c));
      if (av.status !== 200) return sendVrcError(res, av, '搜索模型');
      res.json({ avatars: av.data });
    } catch (e) { handleError(res, e, 'groups/avatars-search'); }
  });

  // ==================== VRChat Avatar 详情 ====================
  router.get('/vrc/avatar/:avatarId', async (req, res) => {
    if (!getVRCCookieFn(req)) return fail(res, 401, '请先在个人中心绑定VRChat账号，或由管理员在后台登录VRChat系统账号', { code: 'VRC_SYSTEM_OFFLINE' });
    try {
      const { result: av } = await vrcWithFallback(req, (c) => vrchatGetAvatar(req.params.avatarId, c));
      if (av.status !== 200) return sendVrcError(res, av, '获取模型详情');
      res.json(av.data);
    } catch (e) { handleError(res, e, 'groups/avatar'); }
  });

  // ==================== VRChat 切换 Avatar ====================
  // 注意：这是代表「当前用户」的写操作，绝不能 fallback 到系统账号 cookie，
  // 否则会把系统账号的模型改掉。
  // 因此这里用 getUserVRCCookieFn（仅取当前用户绑定 cookie、缺失即 401），
  // 而不是会回退系统账号的 getVRCCookieFn。
  router.post('/vrc/avatar/set', async (req, res) => {
    const vrcCookie = (typeof getUserVRCCookieFn === 'function' ? getUserVRCCookieFn : getVRCCookieFn)(req);
    if (!vrcCookie) return fail(res, 401, '请先在个人中心绑定VRChat账号', { code: 'VRC_SYSTEM_OFFLINE' });
    try {
      const { avatarId } = req.body;
      if (!avatarId) return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'avatarId 不能为空');
      const result = await vrchatSetAvatar(avatarId, vrcCookie);
      if (result.status !== 200) return sendVrcError(res, result, '切换模型');
      res.json({ ok: true, avatarId });
    } catch (e) { handleError(res, e, 'groups/avatar-set'); }
  });

  // 按域拆出的子路由（P2-66 god-route 拆分）：原 L261–642 成员同步域（/group/members/sync、/group/members/refresh、/group/presence/contribute），在原代码块位置透传挂载，注册顺序不变
  router.use(require('./groups_members_sync')(getVRCCookieFn, GROUP_ID, getUserVRCCookieFn));

  // 按域拆出的子路由（P2-66 god-route 拆分）：原 L643–911 成员名册域（列表/变更/同步日志/花名册/入群检查/统计/所在世界），在原代码块位置透传挂载，注册顺序不变
  router.use(require('./groups_members')(getVRCCookieFn, GROUP_ID, getUserVRCCookieFn));

  // 按域拆出的子路由（P2-66 god-route 拆分）：原 L912–1290 成员详情域（详情/vrchat 资料/snapshot），在原代码块位置透传挂载，注册顺序不变
  router.use(require('./groups_member_detail')(getVRCCookieFn, GROUP_ID, getUserVRCCookieFn));

  // 按域拆出的子路由（P2-66 god-route 拆分）：原 L1291–1402 账号状态检测域（check/batch-check/list），在原代码块位置透传挂载，注册顺序不变
  router.use(require('./groups_vrc_status')(getVRCCookieFn, GROUP_ID, getUserVRCCookieFn));

  // 按域拆出的子路由（P2-66 god-route 拆分）：原 L1403–1530 邀请管理域（batch/list/accept/reject/my），在原代码块位置透传挂载，注册顺序不变
  router.use(require('./groups_invites')(getVRCCookieFn, GROUP_ID, getUserVRCCookieFn));

  // 按域拆出的子路由（P2-66 god-route 拆分）：原 L1531–1773 F-6 内容域（公告/相册/角色/审计/金流/黑名单/日历），在原代码块位置透传挂载，注册顺序不变
  router.use(require('./groups_content')(getVRCCookieFn, GROUP_ID, getUserVRCCookieFn));

return router;
};
