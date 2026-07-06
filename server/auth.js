/**
 * 境途同游 V6.2 — 认证与权限中间件
 * 三元权限：super_admin(4) / admin(3) / member(2)
 * QQ号 AES-256-CBC 加密 / bcrypt 密码哈希
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// ==================== 权限定义 ====================
const ROLE_LEVEL = {
  super_admin: 4,
  admin: 3,
  member: 2
};

const ROLE_LABELS = {
  super_admin: '超级管理员',
  admin: '管理员',
  member: '成员'
};

// ==================== AES-256-CBC 加密（用于 QQ 号） ====================
// 重要: 生产环境必须设置 ENCRYPT_KEY（64位十六进制字符串）
// 可通过 `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` 生成
const AES_KEY = (() => {
  const envKey = process.env.ENCRYPT_KEY;
  if (!envKey || envKey.length !== 64) {
    console.error('❌ FATAL: ENCRYPT_KEY (64-hex) 未在 .env 中设置！');
    console.error('   生成方法: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    console.error('   然后添加到 .env: ENCRYPT_KEY=<生成的密钥>');
    process.exit(1);
  }
  return Buffer.from(envKey, 'hex');
})();

const AES_IV_LEN = 16;

function encryptAES(plainText) {
  if (!plainText) return null;
  const iv = crypto.randomBytes(AES_IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-cbc', AES_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decryptAES(cipherText) {
  if (!cipherText) return null;
  const parts = cipherText.split(':');
  if (parts.length !== 2) return null;
  try {
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = Buffer.from(parts[1], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', AES_KEY, iv);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch { return null; }
}

// ==================== bcrypt 密码 ====================
const BCRYPT_ROUNDS = 12;

async function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

// ==================== 密码强度校验 ====================
function validatePasswordStrength(password) {
  const errors = [];
  if (password.length < 8) errors.push('密码至少8位');
  if (!/[a-z]/.test(password)) errors.push('需包含小写字母');
  if (!/[A-Z]/.test(password)) errors.push('需包含大写字母');
  if (!/[0-9]/.test(password)) errors.push('需包含数字');
  return { valid: errors.length === 0, errors };
}

// ==================== Session 中间件 ====================
function requireAuth(req, res, next) {
  if (!req.session || req.session.userId === undefined) {
    return res.status(401).json({ error: '请先登录' });
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session || req.session.userId === undefined) {
      return res.status(401).json({ error: '请先登录' });
    }
    const userLevel = ROLE_LEVEL[req.session.role] || 0;
    const requiredLevel = Math.max(...roles.map(r => ROLE_LEVEL[r] || 0));
    if (userLevel < requiredLevel) {
      return res.status(403).json({ error: '权限不足' });
    }
    next();
  };
}

// 获取当前用户的权限等级
function getUserLevel(session) {
  if (!session || session.userId === undefined) return 0;
  return ROLE_LEVEL[session.role] || 2;
}

// 兼容旧版：检查是否有管理员权限（admin 及以上）
async function requireAdminCompat(req, res, next) {
  if (!req.session || req.session.userId === undefined) {
    return res.status(401).json({ error: '请先登录' });
  }
  const level = ROLE_LEVEL[req.session.role] || 0;
  if (level < ROLE_LEVEL.admin) {
    return res.status(403).json({ error: '需要管理员权限' });
  }
  next();
}

/**
 * 统一获取用户头像URL（消除10+处重复模式）
 * @param {object} u 数据库用户行（含 avatar_type, custom_avatar_path, vrchat_avatar_url）
 * @returns {string|null}
 */
function getAvatarUrl(u) {
  if (!u) return null;
  return u.avatar_type === 'custom' ? u.custom_avatar_path : (u.vrchat_avatar_url || null);
}

module.exports = {
  ROLE_LEVEL,
  ROLE_LABELS,
  encryptAES,
  decryptAES,
  hashPassword,
  verifyPassword,
  validatePasswordStrength,
  requireAuth,
  requireRole,
  requireAdminCompat,
  getAvatarUrl
};
