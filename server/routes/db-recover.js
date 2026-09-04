/**
 * 境途同游 — 数据库连接恢复路由
 *
 * 场景：站点已安装（.env 存在）但 MySQL 当前不可达（例如密码被轮换、服务停止、
 * 地址变更），导致所有读写接口 500、连超管都登录不进去，进而无法走「重走建站引导」
 * （重走要求超管登录，而登录又依赖 DB）——形成死锁。本路由提供一条脱离 DB 与登录
 * 的「自救」通道。
 *
 * 安全约束：
 *  - GET  /system/db-status  无鉴权、不依赖 DB：仅 ping 当前连接池，报告可用状态。
 *  - POST /system/db-recover 仅在「当前 DB 确实不可用」且「.env 已存在」时放行：
 *      否则返回 409（健康系统不允许被篡改数据库配置）/ 403（未安装请走建站引导）。
 *    这样即便站点暴露在公网，攻击者也只能在「系统已坏」时重连数据库，且只能指向
 *    一个可连通的 MySQL；与首次安装引导的威胁模型一致（首次安装同样允许任何人配置）。
 *
 * @swagger
 * tags:
 *   name: DbRecover
 *   description: 数据库连接恢复（脱离登录的自救通道）
 */
const express = require('express');
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { getPool, applyDbConfig, DB_CONFIG } = require('../db');
const { ok, handleError, sendError, ErrorCodes } = require('../utils');
const logger = require('../logger');

const router = express.Router();
const ENV_PATH = path.join(__dirname, '..', '..', '.env');

// ============ 恢复令牌（RECOVERY_TOKEN）鉴权 ============
// 这是「脱离登录的自救通道」的最后一道闸门：即便站点已坏、任何人都可触发恢复，
// 也必须持有服务端在 .env 中显式配置的 RECOVERY_TOKEN 才能执行写操作（重连/改 .env）。
// 这样可防止公网上的任意访客在系统故障时接管数据库配置。
//
// - 生产环境 MUST 在 .env 配置一个高强度 RECOVERY_TOKEN（建议 ≥32 字节随机串）。
// - 若未配置：写接口一律返回 503，明确提示「恢复令牌未启用」，绝不在无令牌时放行。
// - 令牌传递：Authorization: Bearer <token>，或查询参数 ?token=<token>，或头 X-Recovery-Token。
// - 校验失败计入安全告警 + 限流，避免被暴力枚举。
const RECOVERY_TOKEN = process.env.RECOVERY_TOKEN || '';
if (!RECOVERY_TOKEN) {
  // 仅打印一次告警（模块加载期）。生产部署请立即配置 RECOVERY_TOKEN。
  logger && logger.warn('[db-recover]',
    '⚠️ RECOVERY_TOKEN 未在 .env 中配置。数据库恢复写接口已禁用（返回 503）。' +
    '生产环境请在 .env 设置高强度 RECOVERY_TOKEN，否则恢复通道不可用且无鉴权保护。');
}

let recoveryFailStreak = 0;
function requireRecoveryToken(req, res, next) {
  if (!RECOVERY_TOKEN) {
    return res.status(503).json({
      error: '数据库恢复通道未启用：请管理员在服务器 .env 配置 RECOVERY_TOKEN 后重试。',
      code: 'RECOVERY_DISABLED'
    });
  }
  const auth = req.headers['authorization'] || '';
  const fromBearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const fromQuery = req.query && req.query.token ? String(req.query.token) : '';
  const fromHeader = req.headers['x-recovery-token'] || '';
  const provided = fromBearer || fromQuery || fromHeader;

  // 恒定时间比较，避免时序侧信道泄露令牌长度/前缀
  const a = Buffer.from(provided || '');
  const b = Buffer.from(RECOVERY_TOKEN);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!ok) {
    recoveryFailStreak++;
    // 失败次数较多时通过安全告警模块提示（若有）
    if (recoveryFailStreak >= 5 && typeof securityAlert === 'function') {
      try { securityAlert('db_recover_token_fail', { ip: req.ip, fails: recoveryFailStreak }); } catch (_) {}
    }
    logger && logger.warn('[db-recover]', '恢复令牌校验失败（疑似爆破）', { ip: req.ip, fails: recoveryFailStreak });
    return res.status(401).json({ error: '恢复令牌无效', code: 'BAD_RECOVERY_TOKEN' });
  }
  recoveryFailStreak = 0;
  next();
}

// ============ .env 读写（仅 MYSQL_*）============
function readEnv() {
  const obj = {};
  try {
    const raw = fs.readFileSync(ENV_PATH, 'utf8');
    raw.split(/\r?\n/).forEach((line) => {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
      if (m) obj[m[1]] = m[2];
    });
  } catch (_) {}
  return obj;
}
function writeEnv(obj) {
  const MYSQL_KEYS = ['MYSQL_HOST', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE', 'MYSQL_PORT'];
  const order = [
    ...MYSQL_KEYS.filter((k) => k in obj),
    ...Object.keys(obj).filter((k) => !MYSQL_KEYS.includes(k))
  ];
  const lines = order.map((k) => {
    const v = obj[k] == null ? '' : obj[k];
    if (k === 'MYSQL_PASSWORD') return `${k}="${v}"`;
    return `${k}=${v}`;
  });
  fs.writeFileSync(ENV_PATH, lines.join('\n') + '\n', 'utf8');
}

// 当前 DB 是否可用（用于恢复门禁）；池未创建或 ping 失败均视为不可用
async function isDbDown() {
  const pool = getPool();
  if (!pool) return true;
  try {
    await pool.query('SELECT 1 AS ping');
    return false;
  } catch (_) {
    return true;
  }
}

// ============ 健康检查（无鉴权）============
router.get('/db-status', async (req, res) => {
  const down = await isDbDown();
  if (down) {
    let detail = '连接池未初始化';
    const pool = getPool();
    if (pool) {
      try { await pool.query('SELECT 1 AS ping'); }
      catch (e) { detail = e.message; }
    }
    return res.json({ ok: false, error: detail });
  }
  res.json({ ok: true });
});

// ============ 恢复（仅 DB 不可用时放行，且必须持恢复令牌）============
router.post('/db-recover', requireRecoveryToken, async (req, res) => {
  // 1) 必须已安装：未安装请走建站引导（首次安装本就允许任何人配置，无需此通道）
  if (!fs.existsSync(ENV_PATH)) {
    return sendError(res, 403, ErrorCodes.FORBIDDEN, '系统尚未安装，请使用「配置向导」完成首次建站');
  }
  // 2) 必须当前 DB 不可用：防止攻击者用它篡改健康系统的数据库配置
  if (!(await isDbDown())) {
    return sendError(res, 409, ErrorCodes.CONFLICT, '数据库当前可用，无需恢复；如需修改数据库配置请在系统正常时操作');
  }

  const body = req.body || {};
  const testOnly = body.testOnly === true;
  const cur = readEnv();
  // 留空沿用现有 .env 值（恢复场景通常只改密码/地址）
  const host = body.host || cur.MYSQL_HOST || DB_CONFIG.host;
  const port = body.port || cur.MYSQL_PORT || '3306';
  const user = body.user || cur.MYSQL_USER || DB_CONFIG.user;
  const database = body.database || cur.MYSQL_DATABASE;
  const password = body.password !== undefined ? body.password : cur.MYSQL_PASSWORD;

  if (!host || !user || !database) {
    return sendError(res, 400, ErrorCodes.BAD_REQUEST, '数据库地址 / 用户名 / 库名 必填');
  }

  // 3) 测试新连接（独立于当前损坏的连接池）
  let conn;
  try {
    conn = await mysql.createConnection({
      host,
      port: parseInt(port, 10) || 3306,
      user,
      password: password || undefined,
      database
    });
    await conn.query('SELECT 1 AS ping');
  } catch (e) {
    return sendError(res, 400, ErrorCodes.BAD_REQUEST, '数据库连接测试失败：' + e.message);
  } finally {
    if (conn) { try { await conn.end(); } catch (_) {} }
  }

  if (testOnly) {
    return ok(res, {tested: true});
  }

  // 4) 写入 .env（仅 MYSQL_*，合并保留其它键）
  const merged = readEnv();
  merged.MYSQL_HOST = host;
  merged.MYSQL_USER = user;
  merged.MYSQL_PASSWORD = password || '';
  merged.MYSQL_DATABASE = database;
  merged.MYSQL_PORT = String(port);
  writeEnv(merged);

  // 5) 热切换连接池并重新初始化（无需重启进程）
  try {
    applyDbConfig({ host, port, user, password, database });
    const initDatabase = require('../db_init');
    await initDatabase();
  } catch (e) {
    // 配置已写入磁盘；初始化失败（如表不存在）提示用户手动跑 db_init.js
    return ok(res, {reinitialized: false,
      warning: '数据库已连接，但表结构初始化失败：' + e.message + '（可能需要先在服务器运行 `node db_init.js`）'});
  }
  ok(res, {reinitialized: true});
});

module.exports = router;
