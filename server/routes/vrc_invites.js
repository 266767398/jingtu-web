// F-10/F-24 VRChat 官方邀请/好友申请/备注/Boop（/api/vrc-invites）
// 直连 VRChat 官方写接口：POST /invite/{userId}（世界实例邀请）、
// POST /user/{userId}/friendRequest（好友申请）、
// POST /userNotes（保存备注，body { targetUserId, note }）、POST /users/{userId}/boop（发送 Boop）。
// 备注/Boop 端点均为官方新式路径（旧式单数 /user/... 已移除返回 502）。
// Cookie 策略：所有写操作均「代表当前用户」，严格限定用户自己绑定的
// cookie（getVRCCookieUserOnly），未绑定用户直接返回 NEED_BIND 引导绑定，
// 绝不回退系统账号（防止借系统账号向陌生玩家发邀请/好友申请）。
const express = require('express');
const { ok, fail, sendVrcError, handleError, ErrorCodes, getPool } = require('../utils');
const { requireAuth } = require('../auth');
const { vrchatSendInvite, vrchatSendFriendRequest, vrchatSaveNote, vrchatBoop, VRC_INSTANCE_PATTERN } = require('../vrc');

/**
 * 校验当前用户（本地 userId）与目标 VRChat 用户 ID 是否互为 accepted 好友。
 * 目标可能未在本站注册（users 表找不到 vrchat_id 匹配）→ 视为非好友。
 * 注意：这只是**本站好友关系缓存**的校验，VRChat 上游本身也会独立校验——
 * 本地校验的目的是提前拦截无效请求、给用户明确中文提示（而不是让上游返回英文 400）。
 */
async function isAcceptedFriend(myUserId, targetVrcId) {
  if (!myUserId || !targetVrcId) return false;
  const pool = getPool();
  const [friend] = await pool.query(
    `SELECT uf.id
     FROM user_friends uf
     JOIN users u ON u.id = uf.friend_id AND u.deleted_at IS NULL
     WHERE uf.user_id = ? AND u.vrchat_id = ? AND uf.status = 'accepted'
     UNION ALL
     SELECT uf.id
     FROM user_friends uf
     JOIN users u ON u.id = uf.user_id AND u.deleted_at IS NULL
     WHERE uf.friend_id = ? AND u.vrchat_id = ? AND uf.status = 'accepted'
     LIMIT 1`,
    [myUserId, targetVrcId, myUserId, targetVrcId]
  );
  return friend.length > 0;
}

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
    // 前端渲染已对非好友隐藏世界邀请按钮，但后端仍需兜底校验（VRChat 上游
    // 对非好友发邀请会返回 403 / 400，提前拦截避免用户看到机器化英文报错）。
    const isFriend = await isAcceptedFriend(req.session.userId, targetUserId);
    if (!isFriend) return fail(res, 400, '仅可对好友发送世界邀请（需先在 VRChat 成为好友）', { code: ErrorCodes.VALIDATION_ERROR });
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

  // F-24 保存用户备注（POST /userNotes）：note 为空串表示清除备注。
  router.post('/note', requireAuth, async (req, res) => {
    const cookie = getVRCCookieUserOnly(req);
    if (!cookie) return fail(res, 400, '请先在个人中心绑定你的 VRChat 账号后再保存备注', { code: ErrorCodes.NEED_BIND });
    const targetUserId = (req.body?.targetUserId || '').trim();
    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
    if (!/^usr_[0-9a-fA-F-]{30,50}$/.test(targetUserId)) {
      return fail(res, 400, '缺少合法的目标用户 ID', { code: ErrorCodes.VALIDATION_ERROR });
    }
    if (note.length > 512) {
      return fail(res, 400, '备注内容不能超过 512 字符', { code: ErrorCodes.VALIDATION_ERROR });
    }
    try {
      const upstream = await vrchatSaveNote(targetUserId, note, cookie);
      if (upstream.status < 200 || upstream.status >= 300) return sendVrcError(res, upstream, '保存备注');
      ok(res, { saved: true, note });
    } catch (e) { handleError(res, e, 'vrcinvites.note'); }
  });

  // F-24 发送 Boop（POST /users/{userId}/boop）：官方要求双方为好友，非好友由上游返回 400。
  router.post('/boop', requireAuth, async (req, res) => {
    const cookie = getVRCCookieUserOnly(req);
    if (!cookie) return fail(res, 400, '请先在个人中心绑定你的 VRChat 账号后再发送 Boop', { code: ErrorCodes.NEED_BIND });
    const targetUserId = (req.body?.targetUserId || '').trim();
    const emojiId = typeof req.body?.emojiId === 'string' && req.body.emojiId.trim() ? req.body.emojiId.trim() : null;
    if (!/^usr_[0-9a-fA-F-]{30,50}$/.test(targetUserId)) {
      return fail(res, 400, '缺少合法的目标用户 ID', { code: ErrorCodes.VALIDATION_ERROR });
    }
    // VRChat 官方 Boop 仅允许好友之间发送（上游返回 400「These users are not friends」）。
    // 前端渲染已对非好友隐藏 Boop 按钮，后端仍需兜底校验。
    const isFriend = await isAcceptedFriend(req.session.userId, targetUserId);
    if (!isFriend) return fail(res, 400, '仅可对好友发送 Boop（需先在 VRChat 成为好友）', { code: ErrorCodes.VALIDATION_ERROR });
    try {
      const upstream = await vrchatBoop(targetUserId, cookie, emojiId);
      if (upstream.status < 200 || upstream.status >= 300) return sendVrcError(res, upstream, '发送 Boop');
      ok(res, { booped: true });
    } catch (e) { handleError(res, e, 'vrcinvites.boop'); }
  });

  return router;
};
