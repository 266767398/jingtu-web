/**
 * 境途同游 — 系统配置路由
 * 
 * @swagger
 * tags:
 *   name: Config
 *   description: 系统配置相关接口
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { requireAdminCompat } = require('../auth');
const { ok, handleError, sendError, ErrorCodes } = require('../utils');

const router = express.Router();
const envPath = path.join(__dirname, '..', '..', '.env');

// §48：允许通过 PUT /admin/config/env 修改的环境变量白名单（非敏感配置）
const ENV_KEY_WHITELIST = new Set([
  'MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_DATABASE', 'MYSQL_USER',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_FROM',
  'LOG_LEVEL', 'NODE_ENV', 'PORT',
  'WEBHOOK_URL', 'VRC_GROUP_URL', 'GROUP_ID'
]);

// P1-15：敏感键判定统一为共享正则。旧 GET 判定漏掉 TOKEN——RECOVERY_TOKEN、
// CSRF_SECRET 之外的 *TOKEN* 键（如 WEBHOOK_TOKEN、API_TOKEN）会以明文返回给
// 持有管理员会话的前端；现 GET 脱敏与 PUT 拒改共用同一正则（大小写不敏感）。
const SENSITIVE_KEY_RE = /(PASSWORD|SECRET|KEY|TOKEN|CREDENTIAL)/i;

// P2-73②：.env 原子写（tmp + rename），避免写一半崩溃导致配置文件截断
function writeEnvAtomic(envPath, content) {
  const tmpPath = envPath + '.tmp';
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, envPath);
}

router.get('/admin/config/env', requireAdminCompat, (req, res) => {
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    const config = {};
    for (const line of content.split(/\r?\n/)) {
      if (line.trim() && !line.trimStart().startsWith('#')) {
        const [key, ...valueParts] = line.split('=');
        const value = valueParts.join('=').trim();
        const envKey = key.trim();
        if (SENSITIVE_KEY_RE.test(envKey)) {
          config[envKey] = '******';
        } else {
          config[envKey] = value;
        }
      }
    }
    ok(res, {config});
  } catch (e) { handleError(res, e, '[config/env-get]'); }
});

router.put('/admin/config/env', requireAdminCompat, (req, res) => {
  try {
    const updates = req.body;
    if (!updates || typeof updates !== 'object') {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, '参数错误');
    }

    // §48：白名单 + 敏感 key 拒绝 + value 换行拒绝 + key 转义后构造 RegExp
    const safeUpdates = {};
    for (const [key, value] of Object.entries(updates)) {
      if (typeof key !== 'string' || !key.trim()) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, '无效的配置键');
      }
      if (SENSITIVE_KEY_RE.test(key)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, `不允许修改敏感配置项: ${key}`);
      }
      if (!ENV_KEY_WHITELIST.has(key)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, `配置项不在允许修改的白名单中: ${key}`);
      }
      const valStr = String(value);
      if (/[\r\n]/.test(valStr)) {
        return sendError(res, 400, ErrorCodes.BAD_REQUEST, `配置值不能包含换行符: ${key}`);
      }
      safeUpdates[key] = valStr;
    }

    let content = fs.readFileSync(envPath, 'utf8');
    for (const [key, value] of Object.entries(safeUpdates)) {
      // §48：转义 key 中的正则元字符后再构造 RegExp，避免 regex 注入
      const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`^${escapedKey}=.*$`, 'm');
      if (regex.test(content)) {
        content = content.replace(regex, `${key}=${value}`);
      } else {
        content += `\n${key}=${value}`;
      }
    }

    writeEnvAtomic(envPath, content);

    for (const [key, value] of Object.entries(safeUpdates)) {
      process.env[key] = value;
    }

    ok(res, {message: '配置已更新，部分配置需要重启服务生效'});
  } catch (e) { handleError(res, e, '[config/env-put]'); }
});

router.post('/admin/config/reload', requireAdminCompat, (req, res) => {
  try {
    // P2-73③：旧实现把 .env 全量键值直接灌进 process.env，等于绕过 PUT 白名单的
    // 「后门写通道」（手工编辑 .env 塞入任意键即可生效，如 PATH/Node 运行时变量）。
    // 现仅重载非敏感白名单键；敏感键与白名单外键一律跳过并计入 skipped 提示。
    const content = fs.readFileSync(envPath, 'utf8');
    let applied = 0;
    const skipped = [];
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      const [key, ...valueParts] = line.split('=');
      const envKey = key.trim();
      const value = valueParts.join('=').trim().replace(/^"|"$/g, '');
      if (!envKey) continue;
      if (!ENV_KEY_WHITELIST.has(envKey)) {
        skipped.push(envKey);
        continue;
      }
      process.env[envKey] = value;
      applied++;
    }
    ok(res, {
      message: `环境变量已重新加载（白名单内 ${applied} 项，跳过 ${skipped.length} 项非白名单键）`,
      applied,
      skipped
    });
  } catch (e) { handleError(res, e, '[config/reload]'); }
});

router.get('/admin/config/info', requireAdminCompat, (req, res) => {
  res.json({
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    env: process.env.NODE_ENV || 'development',
    version: 'V6.29'
  });
});

module.exports = router;
