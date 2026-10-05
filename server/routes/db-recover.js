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
const { fail, ok, handleError, sendError, ErrorCodes } = require('../utils');
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
// - 令牌传递：仅接受 Authorization: Bearer <token> 与头 X-Recovery-Token（P3-57：
//   查询参数方式已移除——令牌进 URL 会落入访问日志 / 反向代理日志 / Referer，扩大泄露面）。
// - 校验失败计入安全告警 + 限流，避免被暴力枚举。
// P1-16：令牌必须每次请求实时读取 process.env——模块加载期的常量快照会过期：
// 本路由的核心场景就是「运维改了 .env 里的凭证后自救」，快照导致新令牌不生效、
// 旧令牌撤不掉。
function getRecoveryToken() {
  return process.env.RECOVERY_TOKEN || '';
}
if (!getRecoveryToken()) {
  // 仅打印一次告警（模块加载期）。生产部署请立即配置 RECOVERY_TOKEN。
  logger && logger.warn('[db-recover]',
    '⚠️ RECOVERY_TOKEN 未在 .env 中配置。数据库恢复写接口已禁用（返回 503）。' +
    '生产环境请在 .env 设置高强度 RECOVERY_TOKEN，否则恢复通道不可用且无鉴权保护。');
}

let recoveryFailStreak = 0;
function requireRecoveryToken(req, res, next) {
  const recoveryToken = getRecoveryToken();
  if (!recoveryToken) {
    return fail(res, 503, '数据库恢复通道未启用：请管理员在服务器 .env 配置 RECOVERY_TOKEN 后重试。', { code: 'RECOVERY_DISABLED' });
  }
  const auth = req.headers['authorization'] || '';
  const fromBearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const fromHeader = req.headers['x-recovery-token'] || '';
  // P3-57：不再接受 ?token=<token> 查询参数——令牌进 URL 会进入访问日志、反向代理
  // 日志与外部 Referer，扩大泄露面；该令牌是脱离登录的数据库接管凭据。
  const provided = fromBearer || fromHeader;

  // 恒定时间比较，避免时序侧信道泄露令牌长度/前缀
  const a = Buffer.from(provided || '');
  const b = Buffer.from(recoveryToken);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!ok) {
    recoveryFailStreak++;
    // 失败次数较多时通过安全告警模块提示
    // P1-16 关联：旧代码 `typeof securityAlert === 'function'` 永假（securityAlert 未在本
    // 模块定义，security_alert.js 导出的是命名函数对象），爆破告警分支从未触发过。
    if (recoveryFailStreak >= 5) {
      try {
        const { onSecurityBreach } = require('../security_alert');
        if (typeof onSecurityBreach === 'function') {
          onSecurityBreach('数据库恢复令牌疑似爆破', { ip: req.ip, fails: recoveryFailStreak });
        }
      } catch (_) {}
    }
    logger && logger.warn('[db-recover]', '恢复令牌校验失败（疑似爆破）', { ip: req.ip, fails: recoveryFailStreak });
    return fail(res, 401, '恢复令牌无效', { code: 'BAD_RECOVERY_TOKEN' });
  }
  recoveryFailStreak = 0;
  next();
}

// ============ .env 读写（仅 MYSQL_*）============
// P2-95：与 setup.js readEnv 同口径（值全捕获、仅剥一层成对引号），旧正则遇内嵌
// 双引号的值会整行不匹配丢键，恢复页会误判「.env 缺少 MYSQL_* 键」。
function readEnv() {
  const obj = {};
  try {
    const raw = fs.readFileSync(ENV_PATH, 'utf8');
    raw.split(/\r?\n/).forEach((line) => {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) return;
      let v = m[2].trim();
      if (v.length >= 2 && ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'"))) {
        v = v.slice(1, -1);
      }
      obj[m[1]] = v;
    });
  } catch (_) {}
  return obj;
}
// P2-73①②：旧 writeEnv 会把 .env 整文件重排重写（未知键被挪到尾部、注释与格式丢失、
// 非原子写），且密码含引号/换行时可破坏文件结构。现改为：
//  - 原位替换：逐行扫描，只改动目标 MYSQL_* 行，其余行（注释/顺序/格式）原样保留；
//  - 原子落盘：写 .env.tmp 后 rename，避免半截文件；
//  - 值中的换行直接剔除，防止注入额外键值行。
function writeEnv(obj) {
  const MYSQL_KEYS = ['MYSQL_HOST', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE', 'MYSQL_PORT'];
  const sanitize = (v) => String(v == null ? '' : v).replace(/[\r\n]/g, '');
  const targets = {};
  for (const k of MYSQL_KEYS) {
    if (k in obj) {
      const v = sanitize(obj[k]);
      // P2-95：与 setup.js writeEnv 同规则——值含双引号必须裸写，包裹写法会让
      // dotenv 在第一个未转义 " 处截断值（静默改密），裸写两侧解析均可原样还原。
      targets[k] = v.includes('"') ? `${k}=${v}` : `${k}="${v}"`;
    }
  }

  const raw = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (m && Object.prototype.hasOwnProperty.call(targets, m[1])) {
      if (!seen.has(m[1])) {
        out.push(targets[m[1]]);
        seen.add(m[1]);
      }
      // 重复键只保留第一次出现，其余丢弃
      continue;
    }
    out.push(line);
  }
  // .env 中原本不存在的 MYSQL_* 键追加到末尾（保持尾部无空行）
  for (const k of MYSQL_KEYS) {
    if (Object.prototype.hasOwnProperty.call(targets, k) && !seen.has(k)) {
      out.push(targets[k]);
    }
  }
  const content = out.join(eol).replace(/\s+$/, '') + eol;
  const tmpPath = ENV_PATH + '.tmp';
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, ENV_PATH);
  // 同步刷新当前进程 env（P1-16：热切换后模块内实时读取才能拿到新值）
  for (const k of MYSQL_KEYS) {
    if (k in obj) process.env[k] = sanitize(obj[k]);
  }
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
// P4-XX: 该端点无鉴权，DB 报错原文可能含主机/用户/库名等内部拓扑信息，
// 对外仅返回通用文案，具体错误细节只写服务端日志，避免辅助攻击者侦察。
router.get('/db-status', async (req, res) => {
  const down = await isDbDown();
  if (down) {
    const pool = getPool();
    if (pool) {
      try { await pool.query('SELECT 1 AS ping'); }
      catch (e) { logger.error('db-recover', '[db-status] 数据库不可用详情:', e.message); }
    }
    return res.json({ ok: false, error: '数据库连接不可用' });
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

  // 5) 热切换连接池并重新初始化（应用主池无需重启即生效）
  const switchedToNewDb = !!(cur.MYSQL_DATABASE && database !== cur.MYSQL_DATABASE);
  // P1-16：旧实现对任意「可连通的目标库」无条件跑 db_init（81 张表建表脚本），
  // 一旦恢复时误填了别的库名，就会在别人正在用的库上强行建表/改结构。
  // 现在：库名未变（常见场景：只是密码/地址变了）→ 照常初始化以保证表结构齐备；
  // 库名变了 → 必须显式 confirmInitialize=true 才初始化，否则只切换不建表。
  const shouldInit = !switchedToNewDb || body.confirmInitialize === true;
  let reinitialized = false;
  let initWarning = null;
  if (shouldInit) {
    try {
      applyDbConfig({ host, port, user, password, database });
      const initDatabase = require('../db_init');
      await initDatabase();
      reinitialized = true;
    } catch (e) {
      // 配置已写入磁盘；初始化失败（如表不存在）提示用户手动跑 db_init.js
      initWarning = '数据库已连接，但表结构初始化失败：' + e.message + '（可能需要先在服务器运行 `node db_init.js`）';
    }
  } else {
    applyDbConfig({ host, port, user, password, database });
    initWarning = '目标库与原库不同，未自动执行表结构初始化（避免在无关库上建表）。如确认新库需要建站表结构，请携带 confirmInitialize=true 重新提交。';
  }

  // P1-16：会话存储（express-mysql-session 独立连接池）与 WS 服务在启动时各自持有
  // 独立连接池，热切换无法刷新它们——响应中如实告知「需重启进程彻底生效」，
  // 不再伪装成完全免重启的切换。
  const restartWarning = '注意：登录会话存储与 WebSocket 服务的连接池仍指向旧配置，' +
    '需重启 Node 进程后才能彻底生效（重启前可能出现无法登录新会话的情况）。';

  ok(res, {
    reinitialized,
    warning: [restartWarning, initWarning].filter(Boolean).join(' ') || undefined
  });
});

module.exports = router;
