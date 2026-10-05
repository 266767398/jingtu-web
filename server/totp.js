// S-6: TOTP（RFC 6238 / HOTP RFC 4226）——超管可选 2FA，零第三方依赖。
//  - secret：160-bit（20 字节）随机数，Base32 编码（去填充），与 Google Authenticator 兼容
//  - 时间步长 30s、HMAC-SHA1、6 位动态码、±1 窗口容差（时钟偏移容忍）
const crypto = require('crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

function base32Decode(str) {
  const clean = String(str || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// HOTP：counter 按 8 字节大端序列化后做 HMAC-SHA1，动态截断取 6 位
function hotp(secretBase32, counter, digits = 6) {
  const key = base32Decode(secretBase32);
  if (key.length === 0) throw new Error('invalid base32 secret');
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter), 0);
  const hs = crypto.createHmac('sha1', key).update(counterBuf).digest();
  const offset = hs[hs.length - 1] & 0x0f;
  const binCode = ((hs[offset] & 0x7f) << 24) |
    (hs[offset + 1] << 16) |
    (hs[offset + 2] << 8) |
    hs[offset + 3];
  return String(binCode % Math.pow(10, digits)).padStart(digits, '0');
}

function generateSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

function generateTotp(secretBase32, { timeStepSec = 30, timestampMs = Date.now() } = {}) {
  const counter = Math.floor(timestampMs / 1000 / timeStepSec);
  return hotp(secretBase32, counter);
}

// 校验：token 需为 6 位数字；window 为时间步容差（默认 ±1，覆盖时钟漂移 ±30s）
function verifyTotp(secretBase32, token, { window = 1, timeStepSec = 30, timestampMs = Date.now() } = {}) {
  const expected = String(token || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(expected)) return false;
  const counter = Math.floor(timestampMs / 1000 / timeStepSec);
  for (let i = -window; i <= window; i++) {
    try {
      if (hotp(secretBase32, counter + i) === expected) return true;
    } catch (e) { return false; }
  }
  return false;
}

// otpauth:// URI：Google Authenticator / Authy / Microsoft Authenticator 扫码绑定
function otpauthUri(secretBase32, accountName, issuer = 'JingTu') {
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30'
  });
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(String(accountName))}?${params.toString()}`;
}

module.exports = { generateSecret, generateTotp, verifyTotp, otpauthUri, hotp, base32Encode, base32Decode };
