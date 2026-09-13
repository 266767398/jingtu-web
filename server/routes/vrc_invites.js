// F-10 VRChat 官方邀请/好友申请（/api/vrc-invites）
// 直连 VRChat 官方写接口：POST /invite/{userId}（世界实例邀请）与
// POST /user/{userId}/friendRequest（好友申请）。
// Cookie 策略：两类均为「代表当前用户」的写操作，严格限定用户自己绑定的
// cookie（getVRCCookieUserOnly），未绑定用户直接返回 NEED_BIND 引导绑定，
// 绝不回退系统账号（防止借系统账号向陌生玩家发邀请/好友申请）。
const express = require('express');
const { ok, fail, sendVrcError, handleError, ErrorCodes } = require('../utils');
const { requireAuth } = require('../auth');
const { vrchatSendInvite, vrchatSendFriendRequest, VRC_INSTANCE_PATTERN } = require('../vrc');

module.exports = function (getVRCCookieUserOnly) {
  const router = express.Router();

  router.post('/world', requireAuth, async (req, res) => {
    const cookie = getVRCCookieUserOnly(req);
    if (!cookie) return fail(res, 400, '请先在个人中心绑定你的 VRChat 账号后再发送邀请', { code: ErrorCodes.NEED_BIND });
    const targetUserId = (req.body?.targetUserId || '').trim();
    const instanceId = (req.body?.instanceId || '').trim();
    if (!/^usr_[0-9a-fA-F-]{30,50}$/.test(targetUserId)) {
      return fail(res, 400, '缺少合法的目标用户 ID', { code: ErrorCodes.VALIDATION_ERROR });
    }
    if (!VRC_INSTANCE_PATTERN.test(instanceId)) {
      return fail(res, 400, '实例 ID 无效或对方当前不在任何世界中', { code: ErrorCodes.VALIDATION_ERROR });
    }
    try {
      const upstream = await vrchatSendInvite(targetUserId, instanceId, cookie);
      if (upstream.status < 200 || upstream.status >= 300) return sendVrcError(res, upstream, '发送世界邀请');
      ok(res, { sent: true });
    } catch (e) { handleError(res, e, 'vrcinvites.world'); }
  });

  router.post('/friend-request', requireAuth, async (req, res) => {
    const cookie = getVRCCookieUserOnly(req);
    if (!cookie) return fail(res, 400, '请先在个人中心绑定你的 VRChat 账号后再发送好友申请', { code: ErrorCodes.NEED_BIND });
    const targetUserId = (req.body?.targetUserId || '').trim();
    if (!/^usr_[0-9a-fA-F-]{30,50}$/.test(targetUserId)) {
      return fail(res, 400, '缺少合法的目标用户 ID', { code: ErrorCodes.VALIDATION_ERROR });
    }
    try {
      const upstream = await vrchatSendFriendRequest(targetUserId, cookie);
      if (upstream.status < 200 || upstream.status >= 300) return sendVrcError(res, upstream, '发送好友申请');
      ok(res, { sent: true });
    } catch (e) { handleError(res, e, 'vrcinvites.friendRequest'); }
  });

  return router;
};
