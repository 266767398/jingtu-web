/**
 * 境途同游 V5.2 — 系统 VRChat 路由
 * 系统 VRChat 登录/2FA/登出
 */
const express = require('express');
const { vrchatBasicLogin, vrchatGetCurrentUser, vrchatRequest, VRC_API_KEY } = require('../vrc');
const { safeError } = require('../utils');

module.exports = function (authStateRef, saveAuthStateFn) {
  const router = express.Router();

  // 系统 VRChat 登录（系统账号）
  router.post('/login', async (req, res) => {
    try {
      const { username, password } = req.body;
      if (!username || !password) return res.status(400).json({ error: '请输入VRChat账号和密码' });
      const loginRes = await vrchatBasicLogin(username, password);
      if (loginRes.status !== 200) return res.status(401).json({ error: loginRes.data?.error?.message || '登录失败' });
      const vrcUser = loginRes.data;
      const needs2fa = loginRes.needs2fa;
      if (needs2fa) {
        req.session._vrcLoginCookie = loginRes.cookie;
        req.session._vrcLoginUser = vrcUser;
        return res.json({ need2fa: true, methods: vrcUser.requiresTwoFactorAuth });
      }
      authStateRef.loggedIn = true;
      authStateRef.cookie = loginRes.cookie;
      authStateRef.userId = vrcUser.id;
      authStateRef.displayName = vrcUser.displayName;
      await saveAuthStateFn();
      res.json({ success: true, user: vrcUser });
    } catch (e) { console.error('[login] 系统VRC登录失败:', e); res.status(500).json({ error: safeError('登录失败: ' + e.message) }); }
  });

  // 系统 VRChat 2FA
  router.post('/2fa', async (req, res) => {
    try {
      const { code } = req.body;
      if (!code) return res.status(400).json({ error: '请输入验证码' });
      const cookie = req.session._vrcLoginCookie;
      const vrcUser = req.session._vrcLoginUser;
      if (!cookie || !vrcUser) return res.status(400).json({ error: '会话过期，请重新登录' });
      let twoFaRes = await vrchatRequest('POST', `/auth/twofactorauth/totp/verify?apiKey=${VRC_API_KEY}`, { code: code.trim() }, cookie);
      if (twoFaRes.status !== 200) twoFaRes = await vrchatRequest('POST', `/auth/twofactorauth/emailotp/verify?apiKey=${VRC_API_KEY}`, { code: code.trim() }, cookie);
      if (twoFaRes.status !== 200) return res.status(401).json({ error: '验证码错误' });
      let finalCookie = cookie;
      if (twoFaRes.setCookie.length > 0) finalCookie = twoFaRes.setCookie.join('; ');
      let finalUser = vrcUser;
      try {
        const u = await vrchatGetCurrentUser(finalCookie);
        if (u) finalUser = u;
      } catch (e) { console.warn('⚠️ 2FA后获取用户信息失败:', e.message); }
      authStateRef.loggedIn = true;
      authStateRef.cookie = finalCookie;
      authStateRef.userId = finalUser.id;
      authStateRef.displayName = finalUser.displayName;
      delete req.session._vrcLoginCookie;
      delete req.session._vrcLoginUser;
      await saveAuthStateFn();
      res.json({ success: true, user: finalUser });
    } catch (e) { console.error('[2fa] 系统VRC 2FA验证失败:', e); res.status(500).json({ error: safeError('2FA验证失败: ' + e.message) }); }
  });

  // 系统 VRChat 登出
  router.post('/logout', async (req, res) => {
    try {
      if (authStateRef.cookie) {
        await vrchatRequest('PUT', `/logout?apiKey=${VRC_API_KEY}`, null, authStateRef.cookie);
      }
    } catch (e) { console.warn('⚠️ VRChat 登出请求失败（本地状态已清除）:', e.message); }
    authStateRef.loggedIn = false;
    authStateRef.cookie = null;
    authStateRef.userId = null;
    authStateRef.displayName = null;
    await saveAuthStateFn();
    res.json({ success: true });
  });

  return router;
};
