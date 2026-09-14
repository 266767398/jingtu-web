/**
 * 境途同游 — 系统安装设置路由
 *
 * 设计要点（2026-08-16 增强）：
 *  - 引导相关的「进度 / 用户输入草稿」隔离存储在独立的 setup-wizard.json，
 *    与站点运行时配置（.env）完全解耦；该文件不含任何密码/密钥（仅存非敏感草稿）。
 *  - 新增「重走建站引导」能力：POST /api/setup/reset 仅清空引导专属数据，
 *    不动 .env、不动数据库、不动站点其他已填配置。
 *  - POST /api/setup/save 支持合并（reconfigure）模式：仅覆盖用户修改的项，
 *    密码/密钥留空表示沿用现有值；管理员已存在时改为 UPDATE；任何失败都不删除 .env。
 *
 * @swagger
 * tags:
 *   name: Setup
 *   description: 系统安装设置相关接口
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const { fail, ok, handleError, sendError, ErrorCodes, logger } = require('../utils');
const { requireRole } = require('../auth');
const { applyDbConfig } = require('../db');
const mailer = require('../mailer');

const router = express.Router();

function getEnvPath() {
  return path.join(__dirname, '..', '..', '.env');
}

// ============ 引导隔离状态存储（setup-wizard.json）============
function getWizardPath() {
  return path.join(__dirname, '..', '..', 'setup-wizard.json');
}
function defaultWizard() {
  return { version: 1, completed: false, step: 1, drafts: {}, updatedAt: new Date().toISOString() };
}
function readWizard() {
  try {
    const raw = fs.readFileSync(getWizardPath(), 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}
function writeWizard(obj) {
  obj.updatedAt = new Date().toISOString();
  fs.writeFileSync(getWizardPath(), JSON.stringify(obj, null, 2), 'utf8');
}

// 非敏感草稿白名单：绝不在磁盘上持久化任何密码/密钥
const NON_SECRET_DRAFT_KEYS = [
  'dbHost', 'dbPort', 'dbName', 'dbUser',
  'sitePort', 'nodeEnv',
  'adminUser', 'adminDisplayName', 'adminEmail',
  'groupId', 'groupUrl',
  'smtpHost', 'smtpPort', 'smtpUser', 'smtpFrom', 'smtpSecure'
];

// ============ .env 读写（合并模式用）============
function readEnv(envPath) {
  const obj = {};
  try {
    const raw = fs.readFileSync(envPath, 'utf8');
    raw.split(/\r?\n/).forEach((line) => {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
      if (m) obj[m[1]] = m[2];
    });
  } catch (_) {}
  return obj;
}
const ENV_ORDER = [
  'MYSQL_HOST', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE', 'MYSQL_PORT',
  'SESSION_SECRET', 'ENCRYPT_KEY', 'VRC_API_KEY', 'NODE_ENV', 'PORT',
  'GROUP_ID', 'VRC_GROUP_URL', 'KOOK_URL', 'OOPZ_URL',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_SECURE', 'SMTP_FROM',
  'LOG_LEVEL'
];
// P2-73①：写法规则与 db-recover.js 收口对齐——敏感键统一加引号、值剔除换行
// （防表单值注入额外键值行）、写临时文件后 rename 原子落盘（崩溃不再留半截 .env）。
// 向导仍按 ENV_ORDER 整文件重生成（引导产物即规范模板）；两侧读函数均兼容
// 带/不带引号格式，与 db-recover 的原位改写互不破格式。
function writeEnv(envPath, obj) {
  const keys = [
    ...ENV_ORDER.filter((k) => k in obj),
    ...Object.keys(obj).filter((k) => !ENV_ORDER.includes(k))
  ];
  const sanitize = (v) => String(v == null ? '' : v).replace(/[\r\n]/g, '');
  const isSensitive = (k) => /SECRET|PASSWORD|PASS|KEY|TOKEN/i.test(k);
  const lines = keys.map((k) => {
    const v = sanitize(obj[k]);
    return isSensitive(k) ? `${k}="${v}"` : `${k}=${v}`;
  });
  // 临时名带 pid+时间戳，避免并发安装/重走时两个请求互相覆盖同一 .tmp
  const tmpPath = `${envPath}.${process.pid}-${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, lines.join('\n') + '\n', 'utf8');
  fs.renameSync(tmpPath, envPath);
}

// ============ .env 完整性检测（.env 缺失/缺少必需项 → 引导重填）============
// 缺少任一必需键即视为 .env「损坏」：前端会引导按首次安装重新配置（原文件自动备份保留）
const REQUIRED_ENV_KEYS = [
  'MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE',
  'SESSION_SECRET', 'ENCRYPT_KEY'
];
function envValid() {
  const envPath = getEnvPath();
  if (!fs.existsSync(envPath)) return false;
  const env = readEnv(envPath);
  return REQUIRED_ENV_KEYS.every((k) => env[k] !== undefined && String(env[k]).trim() !== '');
}
function missingEnvKeys() {
  const envPath = getEnvPath();
  if (!fs.existsSync(envPath)) return REQUIRED_ENV_KEYS.slice();
  const env = readEnv(envPath);
  return REQUIRED_ENV_KEYS.filter((k) => env[k] === undefined || String(env[k]).trim() === '');
}

// §45：若 .env 已存在且非「重走(reconfigure)」则禁止访问 setup 写端点（系统已安装）
// .env 损坏（存在但缺必需键）时按「首次安装」放行，允许用户重走引导修复
function allowReconfigure(req) {
  return (req.body && req.body.reconfigure === true) ||
    (req.query && req.query.reconfigure === '1');
}
function requireNotInstalled(req, res, next) {
  if (fs.existsSync(getEnvPath()) && envValid() && !allowReconfigure(req)) {
    return sendError(res, 403, ErrorCodes.FORBIDDEN, '系统已安装');
  }
  next();
}
// 重走模式（.env 已存在）要求超级管理员；首次安装（无 .env）放行，任何人可完成初始建站
// 会话 cookie 为 SameSite=Lax，跨站 POST 不携带 cookie → requireRole 直接 401 挡掉跨站篡改
function requireSuperAdminForReconfigure(req, res, next) {
  // 判定口径与 requireNotInstalled 一致（存在且有效才算「已安装」）：
  // 此前仅看文件存在，导致 .env 损坏时「未安装放行写入」与「要求超管」互相矛盾，形成无法修复的死锁
  if (!isSiteInstalled()) return next(); // 首次安装 / .env 损坏：无超管账号可登录，放行
  if (req.session && req.session.role === 'super_admin') return next();
  return fail(res, 403, '仅超级管理员可重走建站引导（修改站点配置）');
}

// P2-67：state 两端点匿名面收口——站点安装完成后，.env 拓扑（内部主机名、DB/SMTP 用户名）
// 与磁盘草稿不再对非超管披露；POST 草稿也拒绝匿名写入，防 setup-wizard.json 被污染。
// 首次安装（无 .env 或 .env 损坏）必须保留匿名可达，否则引导无法完成。
function isSiteInstalled() {
  return fs.existsSync(getEnvPath()) && envValid();
}
function isSuperAdminSession(req) {
  return !!(req.session && req.session.userId !== undefined && req.session.role === 'super_admin');
}

// §45：/setup/check 始终可访问（用于检测安装状态 + 引导完成态）
router.get('/setup/check', (req, res) => {
  const envPath = getEnvPath();
  const exists = fs.existsSync(envPath);
  const wiz = readWizard();
  const wizardCompleted = !!(wiz && wiz.completed);
  // 报告当前会话是否为超级管理员（供前端决定是否展示「重走建站引导」按钮）
  const authenticated = !!(req.session && req.session.userId !== undefined);
  const isSuperAdmin = authenticated && req.session.role === 'super_admin';
  // envValid=false：.env 缺失或缺必需项 → 前端引导重新填写 .env（原文件自动备份）
  res.json({
    configured: exists,
    envValid: !exists ? false : envValid(),
    missingEnvKeys: !exists ? REQUIRED_ENV_KEYS.slice() : missingEnvKeys(),
    wizardCompleted,
    authenticated,
    isSuperAdmin
  });
});

// 读取引导隔离状态（进度 + 非敏感草稿）；已配置且无草稿时从 .env 提取非敏感项供预填
router.get('/setup/state', (req, res) => {
  const envExists = fs.existsSync(getEnvPath());
  const wiz = readWizard() || defaultWizard();
  // P2-67：站点安装完成后仅超管可见配置拓扑/草稿；其余调用方拿到空草稿（前端预填降级为手动填写）
  if (isSiteInstalled() && !isSuperAdminSession(req)) {
    return res.json({ configured: true, restricted: true, wizard: { completed: !!wiz.completed, step: wiz.step || 1, drafts: {} } });
  }
  let drafts = wiz.drafts || {};
  if (envExists && (!drafts || Object.keys(drafts).length === 0)) {
    const env = readEnv(getEnvPath());
    drafts = {
      dbHost: env.MYSQL_HOST, dbPort: env.MYSQL_PORT, dbName: env.MYSQL_DATABASE, dbUser: env.MYSQL_USER,
      sitePort: env.PORT, nodeEnv: env.NODE_ENV,
      groupId: env.GROUP_ID, groupUrl: env.VRC_GROUP_URL,
      smtpHost: env.SMTP_HOST, smtpPort: env.SMTP_PORT, smtpUser: env.SMTP_USER,
      smtpFrom: env.SMTP_FROM, smtpSecure: env.SMTP_SECURE
    };
  }
  res.json({ configured: envExists, wizard: { completed: !!wiz.completed, step: wiz.step || 1, drafts } });
});

// 持久化引导进度 + 非敏感草稿（隔离存储，不含任何密码/密钥）
router.post('/setup/state', (req, res) => {
  try {
    // P2-67：站点安装完成后仅超管可写向导草稿，拒绝匿名污染 setup-wizard.json
    if (isSiteInstalled() && !isSuperAdminSession(req)) {
      return sendError(res, 403, ErrorCodes.FORBIDDEN, '系统已安装，仅超级管理员可写入建站草稿');
    }
    const wiz = readWizard() || defaultWizard();
    if (typeof req.body.step === 'number') wiz.step = req.body.step;
    if (req.body.drafts && typeof req.body.drafts === 'object') {
      const clean = {};
      for (const k of NON_SECRET_DRAFT_KEYS) {
        const v = req.body.drafts[k];
        if (v !== undefined && v !== null && v !== '') clean[k] = v;
      }
      wiz.drafts = clean;
    }
    writeWizard(wiz);
    ok(res);
  } catch (e) {
    handleError(res, e, '[setup]');
  }
});

// 单独重置建站引导：仅清空引导专属数据，不影响 .env / 数据库 / 其他站点配置
// ⚠️ 仅超级管理员可调用：requireRole 门禁 + 会话 cookie SameSite=Lax 天然防跨站 CSRF
router.post('/setup/reset', requireRole('super_admin'), (req, res) => {
  try {
    writeWizard(defaultWizard());
    ok(res, { message: '建站引导数据已重置，可重新走引导流程（站点其他配置不受影响）' });
  } catch (e) {
    handleError(res, e, '[setup]');
  }
});

router.post('/setup/test-db', requireNotInstalled, requireSuperAdminForReconfigure, async (req, res) => {
  try {
    let { host, port, database, user, password } = req.body;
    if (!host || !port || !database || !user) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数不完整');
    }
    // 重走模式：密码留空时改用当前 .env 中的数据库密码
    const reconfigure = allowReconfigure(req) && fs.existsSync(getEnvPath());
    if (!password && reconfigure) {
      password = readEnv(getEnvPath()).MYSQL_PASSWORD || '';
    }
    if (!password) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '数据库密码必填');
    }

    const conn = await mysql.createConnection({ host, port, database, user, password });
    await conn.end();
    ok(res);
  } catch (e) {
    handleError(res, e, '[setup]');
  }
});

router.post('/setup/test-email', requireNotInstalled, requireSuperAdminForReconfigure, async (req, res) => {
  try {
    let { host, port, secure, user, pass, from, to } = req.body;
    if (!host || !user) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'SMTP配置不完整');
    }
    const reconfigure = allowReconfigure(req) && fs.existsSync(getEnvPath());
    if (!pass && reconfigure) {
      pass = readEnv(getEnvPath()).SMTP_PASS || '';
    }
    if (!pass) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'SMTP密码必填');
    }

    // 使用表单提交的 SMTP 配置直发测试邮件：首次安装时 .env 尚无 SMTP 配置，
    // 共享 transporter 不可用；重走模式下密码留空则沿用 .env 现有值
    const result = await mailer.sendTestEmail({ host, port, secure, user, pass, from }, to || user);
    if (!result.success) {
      return sendError(res, 500, ErrorCodes.INTERNAL, '邮件发送失败：' + (result.error || '未知错误'));
    }

    ok(res);
  } catch (e) {
    handleError(res, e, '[setup]');
  }
});

router.post('/setup/save', requireNotInstalled, requireSuperAdminForReconfigure, async (req, res) => {
  try {
    const config = req.body;
    const envExists = fs.existsSync(getEnvPath());
    const reconfigure = !!config.reconfigure && envExists;

    // 基础校验（重走模式下：密码可留空表示沿用现有值）
    if (!config.dbHost || !config.dbPort || !config.dbName || !config.dbUser) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '数据库配置不完整');
    }
    if (!reconfigure && !config.dbPass) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '数据库密码必填');
    }
    if (!config.adminUser || !config.adminDisplayName) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '管理员账号配置不完整');
    }
    if (!/^[a-zA-Z0-9_]{3,50}$/.test(config.adminUser)) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '管理员用户名仅允许 3-50 位字母/数字/下划线');
    }
    // 管理员密码：重走模式留空=保持；填写则需满足强度且两次一致
    if (config.adminPass) {
      if (config.adminPass.length < 8 || !/[a-z]/.test(config.adminPass) || !/[A-Z]/.test(config.adminPass) || !/[0-9]/.test(config.adminPass)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '管理员密码至少 8 位且需同时包含大写字母、小写字母和数字');
      }
      if (config.adminPass !== config.adminPassConfirm) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '两次输入的密码不一致');
      }
    } else if (!reconfigure) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '管理员密码必填');
    }
    if (config.adminEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.adminEmail)) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '管理员邮箱格式不正确');
    }

    // S-03 密钥安全校验（前端同样校验，后端兜底防绕过 API 直接调用）：
    // ENCRYPT_KEY 必须 64 位十六进制（AES-256 密钥）；SESSION_SECRET 至少 32 位。
    // 首次安装缺密钥时服务端自动生成安全值；重走模式留空则沿用现有值，绝不接受弱密钥落地。
    const HEX64 = /^[0-9a-fA-F]{64}$/;
    if (config.encryptKey && !HEX64.test(config.encryptKey)) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'ENCRYPT_KEY 必须为 64 位十六进制字符');
    }
    if (config.sessionSecret && config.sessionSecret.length < 32) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'SESSION_SECRET 至少 32 位');
    }

    const envPath = getEnvPath();
    const cur = envExists ? readEnv(envPath) : {};
    if (!config.encryptKey) config.encryptKey = cur.ENCRYPT_KEY || crypto.randomBytes(32).toString('hex');
    if (!config.sessionSecret) config.sessionSecret = cur.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
    const merged = Object.assign({}, cur);
    merged.MYSQL_HOST = config.dbHost;
    merged.MYSQL_USER = config.dbUser;
    merged.MYSQL_PASSWORD = config.dbPass || cur.MYSQL_PASSWORD || '';
    merged.MYSQL_DATABASE = config.dbName;
    merged.MYSQL_PORT = config.dbPort;
    merged.SESSION_SECRET = config.sessionSecret || cur.SESSION_SECRET || '';
    merged.ENCRYPT_KEY = config.encryptKey || cur.ENCRYPT_KEY || '';
    merged.VRC_API_KEY = config.vrcApiKey || cur.VRC_API_KEY || '';
    merged.NODE_ENV = config.nodeEnv || cur.NODE_ENV || 'production';
    merged.PORT = config.sitePort || cur.PORT || '3456';
    merged.GROUP_ID = config.groupId || cur.GROUP_ID || 'grp_7a45b436-159c-4d9c-8303-e186ec25fc35';
    merged.VRC_GROUP_URL = config.groupUrl || cur.VRC_GROUP_URL || 'https://vrchat.com/home/group/grp_7a45b436-159c-4d9c-8303-e186ec25fc35';
    merged.KOOK_URL = cur.KOOK_URL || 'https://www.kookapp.cn/';
    merged.OOPZ_URL = cur.OOPZ_URL || 'https://www.oopz.cc/';
    if (config.smtpHost) {
      merged.SMTP_HOST = config.smtpHost;
      merged.SMTP_PORT = config.smtpPort || '587';
      merged.SMTP_USER = config.smtpUser || '';
      merged.SMTP_PASS = config.smtpPass || cur.SMTP_PASS || '';
      merged.SMTP_SECURE = config.smtpSecure || 'false';
      merged.SMTP_FROM = config.smtpFrom || '';
    } else {
      // 清空 SMTP：移除相关键（若存在）
      delete merged.SMTP_HOST; delete merged.SMTP_PORT; delete merged.SMTP_USER;
      delete merged.SMTP_PASS; delete merged.SMTP_SECURE; delete merged.SMTP_FROM;
    }
    merged.LOG_LEVEL = cur.LOG_LEVEL || 'INFO';

    // .env 存在但缺必需键（损坏）：先备份原文件，再按首次安装重新生成（原配置保留供人工恢复）
    if (envExists && !envValid()) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(envPath, envPath + '.broken-' + ts);
    }

    // 先验后写（P1-20）：数据库连接/建库校验通过后才落盘 .env，失败不留下半损坏配置
    let adminResult = { created: false, updated: false };
    let conn = null;
    let envWritten = false;
    try {
      if (!/^[a-zA-Z0-9_]{1,64}$/.test(config.dbName)) {
        return fail(res, 200, '数据库名仅允许 1-64 位字母/数字/下划线');
      }
      conn = await mysql.createConnection({
        host: config.dbHost,
        port: parseInt(config.dbPort),
        user: config.dbUser,
        password: config.dbPass || cur.MYSQL_PASSWORD || ''
      });
      // 数据库不存在则自动创建（首次安装 / 重走引导无需手工建库）
      await conn.query('CREATE DATABASE IF NOT EXISTS `' + config.dbName + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
      await conn.changeUser({ database: config.dbName });

      // 校验通过后才写入 .env（合并模式不删除原文件；任何失败不回滚删除 .env）
      writeEnv(envPath, merged);
      envWritten = true;

      // 运行中进程连接池同步到新配置（等效于重启服务的 DB 部分，避免保存后站内请求仍连旧库导致引导死循环）
      try {
        applyDbConfig({ host: config.dbHost, port: parseInt(config.dbPort), user: config.dbUser, password: config.dbPass || cur.MYSQL_PASSWORD || '', database: config.dbName });
      } catch (e) { /* 不阻断保存 */ }

      // S-02: 检查 users 表是否存在；不存在则自动初始化表结构（等价于 `node db_init.js`，即「重新生成」网站表结构）
      const [tables] = await conn.query(
        `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users'`,
        [config.dbName]
      );
      if (tables.length === 0) {
        try {
          const initDatabase = require('../db_init');
          await initDatabase();
        } catch (initErr) {
          logger.error('[setup] 数据库表初始化失败：' + initErr.message, initErr.stack);
          return fail(res, 200, '配置已保存，但数据库表初始化失败。可手动运行 `node db_init.js` 后重试');
        }
      }

      const [existing] = await conn.query(`SELECT id, login_id, display_name, email FROM users WHERE role = 'super_admin' AND deleted_at IS NULL LIMIT 1`);
      if (existing.length > 0) {
        const admin = existing[0];
        const sets = [];
        const params = [];
        if (config.adminDisplayName && config.adminDisplayName !== admin.display_name) {
          sets.push('display_name = ?'); params.push(config.adminDisplayName);
        }
        if ((config.adminEmail || '') !== (admin.email || '')) {
          sets.push('email = ?'); params.push(config.adminEmail || null);
        }
        if (config.adminPass) {
          const passwordHash = await bcrypt.hash(config.adminPass, 12);
          sets.push('password_hash = ?'); params.push(passwordHash);
        }
        if (sets.length > 0) {
          params.push(admin.id);
          await conn.query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);
          adminResult.updated = true;
        }
        adminResult.created = false;
      } else {
        // 无超管则新建（重走模式下若未填密码则提示先填）
        if (!config.adminPass) {
          return fail(res, 200, '未找到现有超管账号，请填写管理员密码以创建新账号');
        }
        const passwordHash = await bcrypt.hash(config.adminPass, 12);
        await conn.query(
          `INSERT INTO users (login_id, display_name, password_hash, role, email, banned, approved, vrchat_verified)
           VALUES (?, ?, ?, 'super_admin', ?, 0, 1, 1)`,
          [config.adminUser, config.adminDisplayName, passwordHash, config.adminEmail || null]
        );
        adminResult.created = true;
      }
    } catch (e) {
      // 匿名可达端点：不回显内部错误详情（P1-20），完整堆栈仅入服务端日志
      logger.error('[setup] 保存失败（' + (envWritten ? '写入后处理' : '数据库校验') + '）：' + e.message, e.stack);
      return fail(res, 200, envWritten
        ? '管理员账号处理失败（站点配置已写入，可修正数据库配置后重试）'
        : '数据库连接校验失败，站点配置未写入，请检查数据库设置后重试');
    } finally {
      if (conn) {
        try { await conn.end(); } catch (_) {}
      }
      // S-07: 清除内存中的明文密码，降低日志/堆 dump 泄露风险
      config.adminPass = undefined;
      config.dbPass = undefined;
      config.smtpPass = undefined;
    }

    // 标记引导完成（清空草稿；敏感信息本就不入磁盘）
    const wiz = readWizard() || defaultWizard();
    wiz.completed = true;
    wiz.step = 6;
    wiz.drafts = {};
    writeWizard(wiz);

    const mode = envExists ? 'update' : 'install';
    ok(res, { mode, adminCreated: adminResult.created, adminUpdated: adminResult.updated });
  } catch (e) {
    handleError(res, e, '[setup]');
  }
});

module.exports = router;
