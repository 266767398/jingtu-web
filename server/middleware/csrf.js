/**
 * CSRF 保护
 * token 生成后绑定当前 sessionID（防跨用户复用），可重用直至过期或会话不匹配；
 * 豁免 GET/HEAD/OPTIONS 与登录/初始化路径。含 /api/auth/check-init 与 /api/csrf-token 两个路由。
 */
const crypto = require('crypto');
const logger = require('../logger');
const { fail, getPool, safeError } = require('../utils');

const csrfTokens = new Map();
const CSRF_EXPIRY = 60 * 60 * 1000;

function generateCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * 挂载 CSRF 路由与中间件；须在 auth/migration/database 路由挂载之前调用。
 * 返回清理定时器句柄（供 gracefulShutdown clearInterval）。
 * @param {import('express').Express} app
 */
function setupCsrf(app) {
  // 检查是否已有用户（用于控制初始化流程）
  app.get('/api/auth/check-init', async (req, res) => {
    try {
      let rows;
      try {
        [rows] = await getPool().query(`SELECT COUNT(*) AS count FROM users WHERE deleted_at IS NULL`);
      } catch (e) {
        if (e.code === 'ER_BAD_FIELD_ERROR') {
          [rows] = await getPool().query(`SELECT COUNT(*) AS count FROM users`);
        } else {
          throw e;
        }
      }
      res.json({ hasUser: rows[0].count > 0 });
    } catch (e) { logger.error('[server]', e.message, e.stack); fail(res, 500, safeError(e.message)); }
  });

  // 获取 CSRF Token（绑定到当前 session，防止 token 被跨用户复用）
  app.get('/api/csrf-token', (req, res) => {
    const token = generateCsrfToken();
    const sid = req.sessionID || 'anon';
    csrfTokens.set(token, { sid, createdAt: Date.now() });
    // token 已在 csrfTokens Map 中绑定到当前 sessionID，校验时仅需验证 Map 中的 sid 匹配
    res.json({ csrfToken: token });
  });

  // 定时清理过期 CSRF Token（每15分钟）
  const csrfCleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [token, record] of csrfTokens) {
      if (now - record.createdAt > CSRF_EXPIRY) csrfTokens.delete(token);
    }
    if (csrfTokens.size > 10000) {
      // 防内存泄漏：超过上限强制清理一半最旧的
      const sorted = [...csrfTokens.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
      const toDelete = Math.floor(sorted.length / 2);
      for (let i = 0; i < toDelete; i++) csrfTokens.delete(sorted[i][0]);
    }
  }, 15 * 60 * 1000).unref();

  // CSRF 中间件（豁免 GET/HEAD/OPTIONS + 登录/初始化路径）
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    // ⚠️ Express app.use('/api', ...) 会裁剪 req.path，所以豁免路径使用相对于 /api 的路径
    const exemptPaths = ['/vrchat-login', '/init',
      '/auth/login', '/auth/register', '/auth/init', '/csrf-token',
      '/auth/logout', '/auth/vrchat-login',
      '/auth/forgot-password', '/auth/verify-reset-code', '/auth/reset-password',
      '/setup/test-db', '/setup/test-email', '/setup/save',
      '/setup/state', '/setup/reset',
      '/system/db-recover',
      // 境途联动（JTT）签名端点：请求不依赖 Cookie 会话，CSRF 安全由 ED25519 签名保证（契约 04 §6.2）
      '/jtt/accounts/verify', '/jtt/accounts/register', '/jtt/states'];
    if (exemptPaths.some(p => req.path === p)) return next();
    const token = req.headers['x-csrf-token'];
    if (!token || !csrfTokens.has(token)) return fail(res, 403, 'CSRF token 无效');
    const record = csrfTokens.get(token);
    if (Date.now() - record.createdAt > CSRF_EXPIRY) {
      csrfTokens.delete(token);
      return fail(res, 403, 'CSRF token 已过期，请刷新页面');
    }
    // session 绑定检查：校验 token 生成时所绑定的 sessionID 是否与当前请求一致
    // 防止 token 被跨用户/跨会话复用（例如 CSRF token 泄露后攻击者用自己的 session 使用）
    if (record.sid && record.sid !== 'anon' && record.sid !== req.sessionID) {
      csrfTokens.delete(token);
      return fail(res, 403, 'CSRF token 与当前会话不匹配');
    }
    // token 可重用：仅在过期（CSRF_EXPIRY）或会话不匹配时清除
    // 解决并发 POST 请求竞争（A 消费 token 后 B 仍可使用同一 token）
    next();
  });

  return { csrfCleanupInterval };
}

module.exports = { setupCsrf };
