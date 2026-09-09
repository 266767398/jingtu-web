/**
 * 境途同游 — 激活码服务（纯本地 JSON 文件，支持离线生成与离线校验）
 *
 * 设计要点：
 * - 存储：server/data/activation-codes.json，网站只做读取/校验/消耗，不依赖数据库与网络
 * - 离线工具（server/scripts/generate-activation-codes.js）与网站进程共用同一文件
 * - 并发安全：进程内 Promise 互斥串行化 + 跨进程文件锁（独占创建 + 过期锁接管）
 * - 写入安全：临时文件 + 同目录 rename 原子替换，杜绝半截 JSON
 * - 消耗语义：used=true / used_by / used_at 永久作废，条目永不删除（留档排查）
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let DATA_DIR = path.join(__dirname, 'data');
let DATA_FILE = path.join(DATA_DIR, 'activation-codes.json');
let LOCK_FILE = DATA_FILE + '.lock';

/**
 * 重设数据文件路径（离线部署时可把激活码文件放到任意位置）
 * 由 CLI 的 --file 参数或环境变量 ACTIVATION_CODES_FILE 触发，锁文件始终与数据文件同目录同名加 .lock
 */
function setFilePath(filePath) {
  if (filePath) {
    DATA_FILE = path.resolve(String(filePath));
    DATA_DIR = path.dirname(DATA_FILE);
    LOCK_FILE = DATA_FILE + '.lock';
  }
}
if (process.env.ACTIVATION_CODES_FILE) setFilePath(process.env.ACTIVATION_CODES_FILE);

// 无易混淆字符（0/O/1/I/L）的 32 字符集，便于人工抄写
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_PATTERN = /^JT-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/;

const LOCK_WAIT_MS = 10000;  // 获取跨进程文件锁的最长等待
const LOCK_STALE_MS = 5000;  // 锁文件超过此时长视为残留死锁，可接管
const RENAME_RETRY = 3;      // Windows 下 rename 可能被杀软短暂占用，重试几次

class ActivationCodeError extends Error {
  constructor(reason, message, cause) {
    super(message || reason);
    this.name = 'ActivationCodeError';
    this.reason = reason;
    if (cause) this.cause = cause;
  }
}

// ==================== 进程内互斥 ====================
// 同一进程内所有读-改-写操作串行化，请求排队进入文件锁，避免自旋互相踩踏
let mutex = Promise.resolve();
function withProcessMutex(fn) {
  const run = mutex.then(fn, fn);
  mutex = run.then(() => {}, () => {});
  return run;
}

// ==================== 跨进程文件锁 ====================
async function acquireFileLock() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const start = Date.now();
  for (;;) {
    try {
      // wx 独占创建：拿到锁的唯一凭据；内容为 PID + 持锁时间，便于排查与判断陈旧锁
      fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' });
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let stale = false;
      try {
        stale = Date.now() - fs.statSync(LOCK_FILE).mtimeMs > LOCK_STALE_MS;
      } catch { stale = true; }
      if (stale) {
        try { fs.unlinkSync(LOCK_FILE); } catch {}
        continue;
      }
      if (Date.now() - start > LOCK_WAIT_MS) {
        throw new ActivationCodeError('LOCK_TIMEOUT', '激活码文件忙，请稍后重试');
      }
      await new Promise(r => setTimeout(r, 25));
    }
  }
}

function releaseFileLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch {}
}

async function withFileLock(fn) {
  await acquireFileLock();
  try {
    return await fn();
  } finally {
    releaseFileLock();
  }
}

// ==================== 读写（原子替换） ====================
function readData() {
  if (!fs.existsSync(DATA_FILE)) return { version: 1, codes: [] };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    // 损坏留证：先复制证据副本再抛错，避免排查前被下次原子写覆盖
    try { fs.copyFileSync(DATA_FILE, `${DATA_FILE}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`); } catch {}
    throw new ActivationCodeError('FILE_CORRUPT', '激活码文件损坏，已留存证据副本（*.corrupt-*），请人工检查', e);
  }
  if (!parsed || !Array.isArray(parsed.codes)) return { version: 1, codes: [] };
  return parsed;
}

async function writeData(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DATA_FILE}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  // 0o600：仅运行进程属主可读写，保证网站进程拥有读写权限且不向其他用户暴露
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  let lastErr = null;
  for (let i = 0; i < RENAME_RETRY; i++) {
    try {
      fs.renameSync(tmp, DATA_FILE);
      return;
    } catch (e) {
      lastErr = e;
      if (e.code !== 'EPERM' && e.code !== 'EACCES') break;
      await new Promise(r => setTimeout(r, 40));
    }
  }
  try { fs.unlinkSync(tmp); } catch {}
  throw new ActivationCodeError('WRITE_FAILED', '激活码文件写入失败', lastErr);
}

// ==================== 码值生成 ====================
function randomCode() {
  const bytes = crypto.randomBytes(12);
  let s = '';
  for (let i = 0; i < 12; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return `JT-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

function normalizeCode(input) {
  return String(input || '').trim().toUpperCase().replace(/\s+/g, '');
}

function isValidCodeFormat(code) {
  return CODE_PATTERN.test(normalizeCode(code));
}

// ==================== 对外 API ====================

/**
 * 生成激活码（离线 CLI 与超管后台共用）
 * @param {number} count 生成数量（1~200）
 * @param {string} operator 操作者（离线工具传 'offline-cli'，后台传超管 login_id）
 * @param {string} note 备注（批次用途等，可选）
 * @returns {Promise<Array<{code, created_at, created_by, note, used, used_by, used_at}>>}
 */
async function generateCodes(count, operator, note) {
  const n = Math.max(1, Math.min(200, parseInt(count, 10) || 1));
  return withProcessMutex(() => withFileLock(async () => {
    const data = readData();
    const now = new Date().toISOString();
    const existing = new Set(data.codes.map(c => c.code));
    const created = [];
    while (created.length < n) {
      const code = randomCode();
      if (existing.has(code)) continue;
      existing.add(code);
      const entry = {
        code,
        created_at: now,
        created_by: operator || 'unknown',
        note: String(note || ''),
        used: false,
        used_by: null,
        used_at: null
      };
      data.codes.push(entry);
      created.push(entry);
    }
    await writeData(data);
    return created;
  }));
}

/**
 * 校验并消耗激活码（原子：文件锁内完成 校验→beforeMark→标记→写回）
 *
 * beforeMark 是可选钩子：在标记 used 前执行（如建号事务）。钩子抛错时
 * 激活码不会被消耗，返回 { ok:false, reason:'BEFORE_HOOK_FAILED', error }。
 *
 * @returns {Promise<{ok:true, code:string, entry:object}
 *           |{ok:false, reason:string, error?:Error, used_by?:string, used_at?:string}>}
 *   reason: INVALID_FORMAT / NOT_FOUND / ALREADY_USED / REVOKED / BEFORE_HOOK_FAILED / WRITE_FAILED / LOCK_TIMEOUT / FILE_CORRUPT
 */
async function validateAndConsume(code, username, beforeMark) {
  const normalized = normalizeCode(code);
  if (!CODE_PATTERN.test(normalized)) return { ok: false, reason: 'INVALID_FORMAT' };
  return withProcessMutex(() => withFileLock(async () => {
    const data = readData();
    const entry = data.codes.find(c => c.code === normalized);
    if (!entry) return { ok: false, reason: 'NOT_FOUND' };
    if (entry.used) return { ok: false, reason: 'ALREADY_USED', used_by: entry.used_by, used_at: entry.used_at };
    if (entry.revoked) return { ok: false, reason: 'REVOKED', revoked_by: entry.revoked_by, revoked_at: entry.revoked_at };
    if (typeof beforeMark === 'function') {
      try {
        await beforeMark(normalized);
      } catch (e) {
        return { ok: false, reason: 'BEFORE_HOOK_FAILED', error: e };
      }
    }
    entry.used = true;
    entry.used_by = username;
    entry.used_at = new Date().toISOString();
    try {
      await writeData(data);
    } catch (e) {
      return { ok: false, reason: 'WRITE_FAILED', error: e.cause || e };
    }
    return { ok: true, code: normalized, entry };
  }));
}

/**
 * 列出全部激活码（超管后台展示用；只读，加锁防止读到半截写入）
 */
async function listCodes() {
  return withProcessMutex(() => withFileLock(async () => {
    const data = readData();
    return {
      total: data.codes.length,
      used: data.codes.filter(c => c.used).length,
      unused: data.codes.filter(c => !c.used && !c.revoked).length,
      revoked: data.codes.filter(c => c.revoked).length,
      codes: data.codes
    };
  }));
}

/**
 * 只读查询激活码状态（供 P2P 侧离线校验；不消耗、不写盘）
 */
async function checkCode(code) {
  const normalized = normalizeCode(code);
  if (!CODE_PATTERN.test(normalized)) {
    return { valid: false, reason: 'INVALID_FORMAT', exists: false, used: false };
  }
  return withProcessMutex(() => withFileLock(async () => {
    const data = readData();
    const entry = data.codes.find(c => c.code === normalized);
    if (!entry) {
      return { valid: false, reason: 'NOT_FOUND', exists: false, used: false, code: normalized };
    }
    return {
      valid: !entry.used && !entry.revoked,
      reason: entry.used ? 'ALREADY_USED' : (entry.revoked ? 'REVOKED' : undefined),
      exists: true,
      used: !!entry.used,
      used_by: entry.used_by,
      used_at: entry.used_at,
      revoked: !!entry.revoked,
      revoked_by: entry.revoked_by,
      revoked_at: entry.revoked_at,
      code: normalized,
      note: entry.note
    };
  }));
}

/**
 * 作废激活码（超管处置泄露码等场景；与消耗同一把锁、同样的原子写）
 * @returns {{ok:true, entry}|{ok:false, reason:'INVALID_FORMAT'|'NOT_FOUND'|'ALREADY_USED'|'ALREADY_REVOKED'|'WRITE_FAILED', ...}}
 */
async function revokeCode(code, operator, reason) {
  const normalized = normalizeCode(code);
  if (!CODE_PATTERN.test(normalized)) return { ok: false, reason: 'INVALID_FORMAT' };
  return withProcessMutex(() => withFileLock(async () => {
    const data = readData();
    const entry = data.codes.find(c => c.code === normalized);
    if (!entry) return { ok: false, reason: 'NOT_FOUND' };
    if (entry.used) return { ok: false, reason: 'ALREADY_USED', used_by: entry.used_by, used_at: entry.used_at };
    if (entry.revoked) return { ok: false, reason: 'ALREADY_REVOKED', revoked_by: entry.revoked_by, revoked_at: entry.revoked_at };
    entry.revoked = true;
    entry.revoked_by = String(operator || 'unknown');
    entry.revoked_at = new Date().toISOString();
    entry.revoked_reason = String(reason || '');
    try { await writeData(data); } catch (e) { return { ok: false, reason: 'WRITE_FAILED', error: e.cause || e }; }
    return { ok: true, entry };
  }));
}

/**
 * 批量导入激活码（本地软件启动推送 / 离线文件导入；幂等合并）
 * - 逐条校验格式；已存在的码原样跳过（不覆盖，不触碰网站侧 used/revoked 状态）
 * - 与生成/消耗同一把进程锁 + 文件锁，保证与网站侧并发操作互斥
 * @param {Array<{code:string, created_at?:string, created_by?:string, note?:string, used?:boolean, used_by?:string, used_at?:string, revoked?:boolean, revoked_by?:string, revoked_at?:string, revoked_reason?:string}>} incoming
 * @param {string} operator 导入来源标识（如 'p2p-sync'）
 * @returns {Promise<{ok:true, imported:string[], skipped:string[], invalid:string[]}
 *           |{ok:false, reason:string, invalid?:string[], error?:Error}>}
 *   reason: EMPTY_BATCH / BATCH_TOO_LARGE / NO_VALID_CODES / WRITE_FAILED / LOCK_TIMEOUT / FILE_CORRUPT
 */
async function importCodes(incoming, operator) {
  if (!Array.isArray(incoming) || incoming.length === 0) {
    return { ok: false, reason: 'EMPTY_BATCH' };
  }
  if (incoming.length > 500) {
    return { ok: false, reason: 'BATCH_TOO_LARGE' };
  }
  const valid = [];
  const invalid = [];
  for (const item of incoming) {
    const raw = item && typeof item === 'object' ? item.code : item;
    const normalized = normalizeCode(raw);
    if (!CODE_PATTERN.test(normalized)) {
      invalid.push(String(raw == null ? '' : raw).slice(0, 32));
      continue;
    }
    valid.push({
      code: normalized,
      created_at: (item && typeof item.created_at === 'string' && item.created_at) || new Date().toISOString(),
      created_by: (item && typeof item.created_by === 'string' && item.created_by) || operator || 'unknown',
      note: (item && typeof item.note === 'string') ? item.note.slice(0, 100) : '',
      used: !!(item && item.used),
      used_by: (item && typeof item.used_by === 'string' && item.used_by) || null,
      used_at: (item && typeof item.used_at === 'string' && item.used_at) || null,
      revoked: !!(item && item.revoked),
      revoked_by: (item && typeof item.revoked_by === 'string' && item.revoked_by) || null,
      revoked_at: (item && typeof item.revoked_at === 'string' && item.revoked_at) || null,
      revoked_reason: (item && typeof item.revoked_reason === 'string') ? item.revoked_reason : ''
    });
  }
  if (valid.length === 0) return { ok: false, reason: 'NO_VALID_CODES', invalid };
  return withProcessMutex(() => withFileLock(async () => {
    const data = readData();
    const existing = new Set(data.codes.map(c => c.code));
    const imported = [];
    const skipped = [];
    for (const entry of valid) {
      if (existing.has(entry.code)) { skipped.push(entry.code); continue; }
      existing.add(entry.code);
      data.codes.push(entry);
      imported.push(entry.code);
    }
    if (imported.length > 0) {
      try { await writeData(data); } catch (e) { return { ok: false, reason: 'WRITE_FAILED', invalid, error: e.cause || e }; }
    }
    return { ok: true, imported, skipped, invalid };
  }));
}

function getCodeFilePath() {
  return DATA_FILE;
}

module.exports = {
  generateCodes,
  importCodes,
  validateAndConsume,
  checkCode,
  listCodes,
  revokeCode,
  setFilePath,
  getCodeFilePath,
  normalizeCode,
  isValidCodeFormat,
  ActivationCodeError
};
