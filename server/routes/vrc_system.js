/**
 * 境途同游 V5.2 — 系统 VRChat 路由
 * 系统 VRChat 登录/2FA/登出
 * 
 * @swagger
 * tags:
 *   name: VRCSystem
 *   description: 系统VRChat相关接口
 */
const express = require('express');
const {
  vrchatBasicLogin,
  vrchatGetCurrentUserResult,
  vrchatRequest,
  vrchatVerifyTwoFactor,
  vrchatGetNotifications,
  VRC_API_KEY
} = require('../vrc');
const { fail, ok, handleError , sendError, ErrorCodes } = require('../utils');
const { requireAdminCompat } = require('../auth');
const logger = require('../logger');

module.exports = function (authStateRef, saveAuthStateFn, vrcAuthHelpers) {
  const router = express.Router();
  const {
    saveVRCCredentials = async () => { throw new Error('未接入自动重登凭据保存'); },
    clearVRCCredentials = async () => { throw new Error('未接入自动重登凭据清除'); },
    hasVRCCredentials = () => false,
    getAutoReloginStatus = () => null
  } = vrcAuthHelpers || {};

  // 系统 VRChat 登录（系统账号）
  router.post('/login', requireAdminCompat, async (req, res) => {
    try {
      const { username, password } = req.body;
      if (!username || !password) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请输入VRChat账号和密码');
      const loginRes = await vrchatBasicLogin(username, password);
      if (loginRes.status !== 200) return fail(res, 401, loginRes.data?.error?.message || '登录失败');
      const vrcUser = loginRes.data;
      const needs2fa = loginRes.needs2fa;
      if (needs2fa) {
        req.session._vrcLoginCookie = loginRes.cookie;
        req.session._vrcLoginMethods = vrcUser.requiresTwoFactorAuth;
        return res.json({ need2fa: true, methods: vrcUser.requiresTwoFactorAuth });
      }
      if (!loginRes.cookie || !vrcUser?.id) {
        return sendError(res, 502, ErrorCodes.INTERNAL_ERROR, 'VRChat 登录响应不完整，请稍后重试');
      }
      authStateRef.loggedIn = true;
      authStateRef.cookie = loginRes.cookie;
      authStateRef.userId = vrcUser.id;
      authStateRef.displayName = vrcUser.displayName;
      authStateRef.cookieSetAt = Date.now(); // V8.2: 记录 cookie 设置时间（用于软性过期判断）
      await saveAuthStateFn();
      ok(res, {user: vrcUser});
    } catch (e) { handleError(res, e, '[vrc-system/login]'); }
  });

  // 系统 VRChat 2FA
  router.post('/2fa', requireAdminCompat, async (req, res) => {
    try {
      const { code, method } = req.body;
      if (!code) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请输入验证码');
      const cookie = req.session._vrcLoginCookie;
      const methods = req.session._vrcLoginMethods;
      if (!cookie || !Array.isArray(methods)) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '会话过期，请重新登录');
      if (!methods.includes(method)) return sendError(res, 400, ErrorCodes.BAD_REQUEST, '双重验证方式无效，请重新登录');

      const normalizedCode = method === 'otp'
        ? code.trim().replace(/^(\d{4})(\d{4})$/, '$1-$2')
        : code.trim();
      const twoFaRes = await vrchatVerifyTwoFactor(method, normalizedCode, cookie);
      if (twoFaRes.status !== 200 || twoFaRes.data?.verified !== true) {
        return sendError(res, 401, ErrorCodes.UNAUTHORIZED, twoFaRes.data?.error?.message || '验证码错误');
      }

      const finalCookie = twoFaRes.cookie;
      const currentUserRes = await vrchatGetCurrentUserResult(finalCookie);
      if (currentUserRes.status !== 200 || !currentUserRes.data?.id) {
        return sendError(res, 502, ErrorCodes.INTERNAL_ERROR, '双重验证成功，但 VRChat 会话校验失败，请重新登录');
      }
      const finalUser = currentUserRes.data;
      authStateRef.loggedIn = true;
      authStateRef.cookie = finalCookie;
      authStateRef.userId = finalUser.id;
      authStateRef.displayName = finalUser.displayName;
      authStateRef.cookieSetAt = Date.now(); // V8.2: 记录 cookie 设置时间（用于软性过期判断）
      delete req.session._vrcLoginCookie;
      delete req.session._vrcLoginMethods;
      await saveAuthStateFn();
      ok(res, {user: finalUser});
    } catch (e) { handleError(res, e, '[vrc-system/2fa]'); }
  });

  // 系统 VRChat 登出
  router.post('/logout', requireAdminCompat, async (req, res) => {
    try {
      if (authStateRef.cookie) {
        await vrchatRequest('PUT', `/logout?apiKey=${VRC_API_KEY}`, null, authStateRef.cookie);
      }
    } catch (e) { logger.warn('vrc', '⚠️ VRChat 登出请求失败（本地状态已清除）:', e.message); }
    authStateRef.loggedIn = false;
    authStateRef.cookie = null;
    authStateRef.userId = null;
    authStateRef.displayName = null;
    authStateRef.cookieSetAt = null;
    await saveAuthStateFn();
    ok(res);
  });

  // F-29: 保存系统账号自动重登凭据（用于会话被拒 / 服务端迁移后自动重新登录，加密存储于 session.json）
  router.post('/vrc-save-credentials', requireAdminCompat, async (req, res) => {
    try {
      const { username, password, totpSecret } = req.body;
      if (!username || !password) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '请输入 VRChat 账号和密码');
      }
      const result = await saveVRCCredentials({ username, password, totpSecret });
      ok(res, result);
    } catch (e) { handleError(res, e, '[vrc-system/save-credentials]'); }
  });

  // F-29: 清除系统账号自动重登凭据（停止自动重登，恢复仅手动登录/换 cookie 模式）
  router.post('/vrc-clear-credentials', requireAdminCompat, async (req, res) => {
    try {
      await clearVRCCredentials();
      ok(res, { cleared: true });
    } catch (e) { handleError(res, e, '[vrc-system/clear-credentials]'); }
  });

  // F-29: 查询当前是否已配置自动重登凭据（供前端渲染保存按钮状态）
  // F-30: 附带熔断/退避状态（供前端展示防封禁退避横幅）
  router.get('/vrc-credentials-status', requireAdminCompat, async (req, res) => {
    try {
      ok(res, { configured: hasVRCCredentials(), autoRelogin: getAutoReloginStatus() });
    } catch (e) { handleError(res, e, '[vrc-system/credentials-status]'); }
  });

  // F-19: 拉取系统 VRChat 账号的官方通知（REST 兜底，与 pipeline WS 实时推送互补）
  router.get('/vrc-notifications', requireAdminCompat, async (req, res) => {
    try {
      if (!authStateRef.loggedIn || !authStateRef.cookie) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '系统 VRChat 未登录');
      }
      const r = await vrchatGetNotifications(authStateRef.cookie, req.query.n, req.query.offset);
      if (r.status !== 200) {
        return fail(res, 502, r.data?.error?.message || 'VRChat 通知拉取失败');
      }
      const list = Array.isArray(r.data) ? r.data : [];
      ok(res, {
        notifications: list.map(nt => ({
          id: nt.id,
          type: nt.type,
          title: nt.title || nt.senderUsername || nt.type,
          message: nt.message,
          senderUserId: nt.senderUserId,
          senderUsername: nt.senderUsername,
          link: nt.link,
          imageUrl: nt.imageUrl,
          createdAt: nt.createdAt
        }))
      });
    } catch (e) { handleError(res, e, '[vrc-system/notifications]'); }
  });

  return router;
};
