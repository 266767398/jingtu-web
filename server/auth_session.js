/**
 * 境途同游 V5.2 — 会话构建共享模块（auth.js 按域拆分）
 * buildSession / sessionUser 被本地登录、VRChat、/init 多个域共用，
 * 抽为独立小模块，避免各 service 间循环依赖。
 */
const { encryptCookie } = require('./utils');
const { ROLE_LABELS } = require('./auth');

// 从用户记录构建session
function buildSession(req, user, vrchatCookie) {
  req.session.loggedIn = true;
  req.session.userId = user.id;
  req.session.loginId = user.login_id;
  req.session.displayName = user.display_name;
  req.session.vrchatId = user.vrchat_id || null;
  req.session.vrchatName = user.vrchat_name || null;
  req.session.vrchatVerified = !!user.vrchat_verified;
  req.session.vrchatAvatarUrl = user.vrchat_avatar_url || null;
  req.session.role = user.role;
  req.session.avatarType = user.avatar_type || 'none';
  req.session.avatarUrl = user.avatar_type === 'custom'
    ? user.custom_avatar_path
    : (user.vrchat_avatar_url || null);
  if (vrchatCookie) {
    const encrypted = encryptCookie(vrchatCookie);
    if (!encrypted) throw new Error('cookie 加密失败');
    req.session.vrchatCookie = encrypted;
    req.session.vrcCookieSetAt = Date.now(); // V8.2: 记录 cookie 设置时间（用于软性过期判断）
  }
}

function sessionUser(session) {
  if (!session || (session.userId === undefined)) return null;
  return {
    id: session.userId,
    loginId: session.loginId,
    displayName: session.displayName,
    vrchatId: session.vrchatId,
    vrchatName: session.vrchatName,
    vrchatVerified: !!session.vrchatVerified,
    vrchatAvatarUrl: session.vrchatAvatarUrl || null,
    role: session.role,
    roleLabel: ROLE_LABELS[session.role] || '未知',
    avatarType: session.avatarType,
    avatarUrl: session.avatarUrl
  };
}

module.exports = { buildSession, sessionUser };
