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

router.get('/admin/config/env', requireAdminCompat, (req, res) => {
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    const config = {};
    for (const line of content.split('\n')) {
      if (line.trim() && !line.startsWith('#')) {
        const [key, ...valueParts] = line.split('=');
        const value = valueParts.join('=').trim();
        if (!key.includes('PASSWORD') && !key.includes('SECRET') && !key.includes('KEY')) {
          config[key] = value;
        } else {
          config[key] = '******';
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
      if (/(PASSWORD|SECRET|KEY|TOKEN)/i.test(key)) {
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

    fs.writeFileSync(envPath, content, 'utf8');

    for (const [key, value] of Object.entries(safeUpdates)) {
      process.env[key] = value;
    }

    ok(res, {message: '配置已更新，部分配置需要重启服务生效'});
  } catch (e) { handleError(res, e, '[config/env-put]'); }
});

router.post('/admin/config/reload', requireAdminCompat, (req, res) => {
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      if (line.trim() && !line.startsWith('#')) {
        const [key, ...valueParts] = line.split('=');
        const value = valueParts.join('=').trim();
        process.env[key] = value;
      }
    }
    ok(res, {message: '环境变量已重新加载'});
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
