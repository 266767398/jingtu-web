/**
 * CSRF 保护
 * token 生成后绑定当前 sessionID（防跨用户复用），可重用直至过期或会话不匹配；
 * 豁免 GET/HEAD/OPTIONS 与登录/初始化路径。含 /api/auth/check-init 与 /api/csrf-token 两个路由。
 *
 * P1-1（条件触发项）：token 记录本地 Map + Redis 双写。
 * - 本地 Map 始终写入，作为权威副本 → Redis 抖动/未配置时行为与迁移前完全一致；
 * - Redis 可用时同步写入 csrf:<token>（带 TTL）→ 多 worker 部署下可跨进程校验他机颁发的 token。
 */
const crypto = require('crypto');
const logger = require('../logger');
const cache = require('../cache');
const { fail, getPool, safeError } = require('../utils');

const csrfTokens = new Map();
const CSRF_EXPIRY = 60 * 60 * 1000;
const CSRF_EXPIRY_SECONDS = Math.ceil(CSRF_EXPIRY / 1000);
const CSRF_KEY_PREFIX = 'csrf:';

function generateCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

function csrfRedisKey(token) {
  return `${CSRF_KEY_PREFIX}${token}`;
}

function isUsableRecord(record) {
  return !!record
    && typeof record === 'object'
    && typeof record.sid === 'string'
    && Number.isFinite(record.createdAt);
}

// 双写：本地 Map 为权威副本，Redis 仅在启用时同步（失败静默降级，不影响本地校验）
async function csrfStoreSet(token, record) {
  csrfTokens.set(token, record);
  if (!cache.isEnabled()) return;
  try {
    await cache.set(csrfRedisKey(token), record, CSRF_EXPIRY_SECONDS);
  } catch (e) {
    logger.warn('[csrf] Redis 写入失败，已降级为本地存储:', e?.message);
  }
}

// 先查本地，未命中再查 Redis（覆盖「token 由其他 worker 颁发」场景），命中后回填本地
async function csrfStoreGet(token) {
  const local = csrfTokens.get(token);
  if (local) return local;
  if (!cache.isEnabled()) return null;
  try {
    const shared = await cache.get(csrfRedisKey(token));
    if (isUsableRecord(shared)) {
      csrfTokens.set(token, shared);
      return shared;
    }
  } catch (e) {
    logger.warn('[csrf] Redis 读取失败，已降级为本地存储:', e?.message);
  }
  return null;
}

async function csrfStoreDelete(token) {
  csrfTokens.delete(token);
  if (!cache.isEnabled()) return;
  try {
    await cache.del(csrfRedisKey(token));
  } catch (e) {
    logger.warn('[csrf] Redis 删除失败，已降级为本地存储:', e?.message);
  }
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
  app.get('/api/csrf-token', async (req, res) => {
    const token = generateCsrfToken();
    const sid = req.sessionID || 'anon';
    await csrfStoreSet(token, { sid, createdAt: Date.now() });
    // token 已绑定到当前 sessionID，校验时仅需验证记录中的 sid 匹配
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
  app.use('/api', async (req, res, next) => {
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
    const record = token ? await csrfStoreGet(token) : null;
    if (!record) return fail(res, 403, 'CSRF token 无效');
    if (Date.now() - record.createdAt > CSRF_EXPIRY) {
      await csrfStoreDelete(token);
      return fail(res, 403, 'CSRF token 已过期，请刷新页面');
    }
    // session 绑定检查：校验 token 生成时所绑定的 sessionID 是否与当前请求一致
    // 防止 token 被跨用户/跨会话复用（例如 CSRF token 泄露后攻击者用自己的 session 使用）
    if (record.sid && record.sid !== 'anon' && record.sid !== req.sessionID) {
      await csrfStoreDelete(token);
      return fail(res, 403, 'CSRF token 与当前会话不匹配');
    }
    // token 可重用：仅在过期（CSRF_EXPIRY）或会话不匹配时清除
    // 解决并发 POST 请求竞争（A 消费 token 后 B 仍可使用同一 token）
    next();
  });

  return { csrfCleanupInterval };
}

module.exports = { setupCsrf };
