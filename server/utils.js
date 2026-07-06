/**
 * 境途同游 — 服务端共享工具模块
 * 集中管理 getPool、safeError、操作日志、通知群发等重复代码
 * 所有路由模块统一从此导入，消除7处重复定义
 */
const crypto = require('crypto');
const dbMod = require('./db');

// ==================== 数据库连接 ====================
const getPool = () => dbMod.holder.pool;

// ==================== 错误处理 ====================
const IS_DEV = process.env.NODE_ENV !== 'production';
function safeError(msg) { return IS_DEV ? msg : '操作失败，请稍后重试'; }

/**
 * 统一 500 错误响应
 * 支持自定义日志标签（默认 'utils'）
 */
function handleError(res, e, tag = 'utils') {
  console.error(`[${tag}]`, e);
  res.status(500).json({ error: safeError(e.message) });
}

// ==================== 操作日志（仅写 DB，无 WebSocket） ====================
async function logOper(adminId, operType, content) {
  try {
    await getPool().query(
      `INSERT INTO sys_oper_log (admin_vrcid, oper_type, content) VALUES (?, ?, ?)`,
      [String(adminId), operType, content]
    );
  } catch (e) { console.warn('⚠️ 操作日志写入失败:', e.message); }
}

// ==================== VRChat Cookie 加解密 ====================
const CRYPTO_ALGO = 'aes-256-gcm';
const CRYPT_PREFIX = 'enc:';

/**
 * 使用 AES-256-GCM 加密 VRChat Cookie
 * @param {string} plaintext - 原始 Cookie 字符串
 * @returns {string|null} 加密后的字符串（enc:base64格式），失败返回 null
 */
function encryptCookie(plaintext) {
  if (!plaintext || typeof plaintext !== 'string') return null;
  try {
    const key = Buffer.from(process.env.ENCRYPT_KEY, 'hex');
    if (key.length !== 32) throw new Error('ENCRYPT_KEY 必须是 64 位十六进制（32 字节）');
    const iv = crypto.randomBytes(12); // GCM 推荐 12 字节 IV
    const cipher = crypto.createCipheriv(CRYPTO_ALGO, key, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'binary');
    encrypted += cipher.final('binary');
    const tag = cipher.getAuthTag();
    // 格式: iv(12) + tag(16) + ciphertext
    const buf = Buffer.concat([iv, tag, Buffer.from(encrypted, 'binary')]);
    return CRYPT_PREFIX + buf.toString('base64');
  } catch (e) {
    console.error('⚠️ VRChat Cookie 加密失败:', e.message);
    return null;
  }
}

/**
 * 解密 VRChat Cookie
 * @param {string} stored - 加密后的 Cookie 字符串（含 enc: 前缀）
 * @returns {string|null} 原始 Cookie 字符串
 */
function decryptCookie(stored) {
  if (!stored || typeof stored !== 'string') return null;
  // 兼容未加密的旧 Cookie（迁移过渡）
  if (!stored.startsWith(CRYPT_PREFIX)) return stored;
  try {
    const key = Buffer.from(process.env.ENCRYPT_KEY, 'hex');
    if (key.length !== 32) throw new Error('ENCRYPT_KEY 必须是 64 位十六进制（32 字节）');
    const buf = Buffer.from(stored.slice(CRYPT_PREFIX.length), 'base64');
    if (buf.length < 28) throw new Error('密文不完整');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ciphertext = buf.subarray(28);
    const decipher = crypto.createDecipheriv(CRYPTO_ALGO, key, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(ciphertext, 'binary', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    console.error('⚠️ VRChat Cookie 解密失败:', e.message);
    return null;
  }
}

module.exports = { getPool, IS_DEV, safeError, handleError, logOper, encryptCookie, decryptCookie };
