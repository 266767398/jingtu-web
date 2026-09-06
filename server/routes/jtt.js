// 境途 × 境途同游 联动接口骨架（挂载前缀 /api/jtt）
// 依据：p2p/docs/04-jingtu-web-integration.md（契约 0.3 草案）
// 本文件已实现联调：方向①②③④ 的数据库读写、ED25519 验签、绑定码 TOFU 注册均落地；见 docs/24 联调说明。
// 四个方向：
//   ① 账号文件签发（管理端 super_admin，Session + CSRF）
//   ② 游戏状态上报（客户端，X-JTT-* 头 + ED25519 签名认证，免 Session）
//   ③ jt1:// 深链生成（Web 登录用户）
//   ④ 客户端账号注册联动（仅超管可创建账号文件——客户端超管即网站 super_admin，为同一角色；普通用户不可自助创建；凭一次性绑定码注册，TOFU 首次信任）
const express = require('express');
const crypto = require('crypto');
const { ok, getPool, handleError, sendError, ErrorCodes } = require('../utils');
const { requireAuth, requireRole } = require('../auth');

const router = express.Router();

// ==================== 常量与工具 ====================
const SIGNATURE_WINDOW_SEC = 300; // 签名时间戳允许 ±300s 偏移（契约 §4.1）
const GAME_KEY_PATTERN = /^[a-z0-9][a-z0-9-_]{1,63}$/; // 游戏 key：小写字母数字开头，长度 2-64
const JTT_ROLE_WHITELIST = ['member', 'admin', 'super_admin']; // 境途侧角色白名单（契约 §3.1）
const DEEPLINK_TYPES = ['join', 'session/start', 'account/import']; // 深链类型白名单（契约 §5.2）
const STATE_RATE_LIMIT_MS = 15 * 1000; // 状态上报限流：≤1 次/15s/accountId（契约 §6.2）
const JTT_ACCOUNT_PREFIX = 'jt_'; // 账号ID前缀：jt_ + 32 位 hex（契约 §2.1）

// 状态上报限流缓存（内存实现，重启失效；联调时可换 Redis/DB 见契约 §7-2）
const stateReportCache = new Map(); // accountId -> lastReportTs
// 签名 nonce 防重放缓存（内存实现，重启失效；契约 §7-2 接受，可换 jtt_nonce 表）
const nonceCache = new Map(); // key: accountId + ':' + nonce -> ts
// 深链票据缓存（内存实现，一次性、10 分钟有效；契约 §7-2 接受，可换 jtt_deeplink_tickets 表）
const deeplinkTickets = new Map(); // ticket -> { type, targetId, inviteCode, expiresAt }

// 构造签名串：METHOD \n PATH \n TIMESTAMP \n NONCE \n RAW_BODY（契约 §4.1）
function buildSignatureString(method, path, timestamp, nonce, rawBody) {
  return [method, path, String(timestamp), String(nonce), rawBody == null ? '' : String(rawBody)].join('\n');
}

// ED25519 验签（Node 内置 crypto.verify，零第三方依赖）
// 注意：Node v23 + OpenSSL 3.x 下，DER Buffer 直接传给 crypto.verify 会抛
// ERR_OSSL_UNSUPPORTED；须先用 createPublicKey 构造 KeyObject，再以 algorithm=null 调 verify。
function verifyEd25519(publicKeyBase64, signatureBase64, message) {
  try {
    const key = crypto.createPublicKey({
      key: Buffer.from(publicKeyBase64, 'base64'),
      format: 'der',
      type: 'spki'
    });
    return crypto.verify(
      null,
      Buffer.from(message, 'utf8'),
      key,
      Buffer.from(signatureBase64, 'base64')
    );
  } catch (e) {
    return false;
  }
}

// 签名用 PATH：挂载前缀 + 路由内相对路径（如 /api/jtt/states），客户端须按同一字符串签名（契约 §4.1）
function signaturePath(req) {
  return (req.baseUrl || '') + req.path;
}

// 日期转 ISO（mysql2 DATETIME 为 Date，统一输出 ISO 字符串；空值保持 null）
function toIso(d) {
  if (d == null) return null;
  const dt = d instanceof Date ? d : new Date(d);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

// 公钥指纹：SHA-256(publicKey) hex（64 位，对齐 jtt_accounts.fingerprint VARCHAR(64)）
function fingerprintOf(publicKey) {
  return crypto.createHash('sha256').update(String(publicKey), 'utf8').digest('hex');
}

// 兜底生成 ED25519 密钥对（Base64 DER）。契约 §7-1 推荐客户端自持私钥、Web 只存公钥；
// 仅当签发请求未携带 publicKey 时 Web 代生成，私钥随响应一次性返回、绝不落库。
function generateKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
  };
}

// 构造 jttAccountFile（契约 §3.1；§7-5 与 @jingtup/core AccountFile 逐字段对齐前，
// signature/encryptedSecret 按待确认项占位 null）。row 兼容 snake_case（DB 行）与 camelCase（签发入参）。
function buildAccountFile(row, opts) {
  const o = opts || {};
  const file = {
    format: 'jttaccount@1',
    accountId: row.accountId || row.account_id,
    displayName: row.displayName || row.display_name,
    role: row.role || 'member',
    permissions: row.permissions || null,
    allowedRooms: row.allowedRooms || row.allowed_rooms || null,
    issuedBy: 'web:' + (row.issuedBy || row.issued_by),
    issuedAt: toIso(row.issuedAt || row.issued_at),
    expiresAt: toIso(row.expiresAt || row.expires_at),
    publicKey: row.publicKey || row.public_key,
    encryptedSecret: o.encryptedSecret != null ? o.encryptedSecret : null,
    fingerprint: row.fingerprint,
    signature: o.signature != null ? o.signature : null
  };
  return file;
}

// RAW_BODY 近似值：无 body 签空串；有 body 用 JSON.stringify 重序列化（express.json 先解析，
// 精确原文需前置捕获中间件，见 docs/24 §8 待确认项）。客户端须按同一规则构造签名串。
function rawBodyApprox(req) {
  if (typeof req.body === 'string') return req.body;
  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
    return JSON.stringify(req.body);
  }
  return '';
}

// 注册成功响应的 webUrl（契约 §3.7/§5.3）：/launch?jt=<base64url(深链)>，落地页拉起客户端导入账号
function webLaunchUrl(req, accountId) {
  const host = req.get('host') || 'localhost';
  const protocol = req.protocol || 'http';
  const jt = 'jt1://account/import?accountId=' + encodeURIComponent(accountId);
  return protocol + '://' + host + '/launch?jt=' + Buffer.from(jt, 'utf8').toString('base64url');
}

// 客户端签名认证中间件（契约 §4.1）
// 读取 X-JTT-Account / X-JTT-Timestamp / X-JTT-Nonce / X-JTT-Signature，
// 校验时间戳窗口与签名；通过后把 { account } 挂到 req.jttAccount 供下游使用。
async function jttAuth(req, res, next) {
  try {
    const accountId = req.headers['x-jtt-account'];
    const timestamp = req.headers['x-jtt-timestamp'];
    const nonce = req.headers['x-jtt-nonce'];
    const signature = req.headers['x-jtt-signature'];
    if (!accountId || !timestamp || !nonce || !signature) {
      return sendError(res, 401, ErrorCodes.JTT_SIGNATURE_INVALID, '缺少 JTT 签名请求头');
    }
    // 时间戳窗口校验（±300s）
    const ts = parseInt(timestamp, 10);
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > SIGNATURE_WINDOW_SEC) {
      return sendError(res, 401, ErrorCodes.JTT_TIMESTAMP_STALE, '请求时间戳超窗');
    }
    // 1) 按 accountId 查 jtt_accounts 加载账号：无记录 → 401 JTT_ACCOUNT_NOT_FOUND；
    //    已撤销 → 401 JTT_ACCOUNT_REVOKED；已过期 → 401 JTT_ACCOUNT_EXPIRED
    const pool = getPool();
    const [rows] = await pool.query('SELECT * FROM jtt_accounts WHERE account_id = ? LIMIT 1', [accountId]);
    if (!rows.length) {
      return sendError(res, 401, ErrorCodes.JTT_ACCOUNT_NOT_FOUND, '账号文件未找到');
    }
    const account = rows[0];
    if (account.revoked) {
      return sendError(res, 401, ErrorCodes.JTT_ACCOUNT_REVOKED, '账号文件已撤销');
    }
    if (account.expires_at && new Date(account.expires_at).getTime() < Date.now()) {
      return sendError(res, 401, ErrorCodes.JTT_ACCOUNT_EXPIRED, '账号文件已过期');
    }
    // 2) nonce 防重放：内存 Map（重启失效，契约 §7-2 接受；可换 jtt_nonce 表），重复 nonce → 401
    const now = Date.now();
    const nonceKey = accountId + ':' + nonce;
    if (nonceCache.has(nonceKey)) {
      return sendError(res, 401, ErrorCodes.JTT_SIGNATURE_INVALID, 'nonce 重复（防重放）');
    }
    nonceCache.set(nonceKey, now);
    if (nonceCache.size > 10000) {
      for (const [k, v] of nonceCache) {
        if (now - v > SIGNATURE_WINDOW_SEC * 1000) nonceCache.delete(k);
      }
    }
    // 3) RAW_BODY：全局 express.json 先于本中间件解析，用 rawBodyApprox 近似（无 body 签空串）
    const rawBody = rawBodyApprox(req);
    const message = buildSignatureString(req.method, signaturePath(req), timestamp, nonce, rawBody);
    if (!account.public_key || !verifyEd25519(account.public_key, signature, message)) {
      return sendError(res, 401, ErrorCodes.JTT_SIGNATURE_INVALID, '签名验证失败');
    }
    req.jttAccount = {
      id: account.id,
      userId: account.user_id,
      accountId: account.account_id,
      displayName: account.display_name,
      role: account.role,
      publicKey: account.public_key,
      permissions: account.permissions,
      allowedRooms: account.allowed_rooms,
      fingerprint: account.fingerprint,
      issuedBy: account.issued_by,
      issuedAt: account.issued_at,
      expiresAt: account.expires_at,
      revoked: !!account.revoked
    };
    next();
  } catch (e) { handleError(res, e, '[jtt/jttAuth]'); }
}

// ==================== 方向①：账号文件签发（管理端，Session + CSRF） ====================

// POST /api/jtt/accounts/issue — 签发账号文件（契约 §3.1）
router.post('/accounts/issue', requireRole('super_admin'), async (req, res) => {
  try {
    const { userId, role = 'member', permissions, allowedRooms, expiresInDays, publicKey: reqPublicKey, force } = req.body || {};
    if (!userId || typeof userId !== 'number') {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'userId 必填且为数字');
    }
    if (!JTT_ROLE_WHITELIST.includes(role)) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'role 不在白名单 member/admin/super_admin');
    }
    // 1) 校验目标用户存在且未封禁/软删（users 表，失败 → 400 USER_NOT_FOUND / USER_UNAVAILABLE）
    const pool = getPool();
    const [userRows] = await pool.query(
      'SELECT id, display_name, banned FROM users WHERE id = ? AND deleted_at IS NULL LIMIT 1',
      [userId]
    );
    if (!userRows.length) {
      return sendError(res, 400, ErrorCodes.USER_NOT_FOUND, '目标用户不存在');
    }
    if (userRows[0].banned) {
      return sendError(res, 400, ErrorCodes.USER_UNAVAILABLE, '目标用户已封禁');
    }
    // 2) 检查是否已有有效账号文件（未撤销未过期 → 409 JTT_ACCOUNT_EXISTS，支持 force 覆盖）
    const [existRows] = await pool.query(
      'SELECT id FROM jtt_accounts WHERE user_id = ? AND revoked = 0 AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1',
      [userId]
    );
    if (existRows.length && !force) {
      return sendError(res, 409, ErrorCodes.JTT_ACCOUNT_EXISTS, '该用户已有有效账号文件，先撤销或指定 force:true');
    }
    if (existRows.length && force) {
      await pool.query('UPDATE jtt_accounts SET revoked = 1, revoked_at = NOW() WHERE user_id = ? AND revoked = 0', [userId]);
    }
    // 3) 密钥对：§7-1 推荐客户端生成、Web 永不接触私钥。请求可携带 publicKey（联调终态）；
    //    未携带时 Web 兜底代生成，私钥仅随本次响应返回、不落库
    let publicKey = reqPublicKey;
    let privateKey = null;
    if (!publicKey || typeof publicKey !== 'string') {
      const kp = generateKeypair();
      publicKey = kp.publicKey;
      privateKey = kp.privateKey;
    }
    // 4) accountId（jt_ + 32 位 hex）与 fingerprint（公钥 SHA-256 hex）
    const accountId = JTT_ACCOUNT_PREFIX + crypto.randomBytes(16).toString('hex');
    const fingerprint = fingerprintOf(publicKey);
    const issuedBy = req.session.userId || null;
    const expiresAt = Number.isFinite(expiresInDays) && expiresInDays > 0
      ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
      : null;
    const permsJson = Array.isArray(permissions) ? JSON.stringify(permissions) : null;
    const roomsJson = Array.isArray(allowedRooms) ? JSON.stringify(allowedRooms) : null;
    // 5) 写库：只存公钥与签发元数据，私钥不落库
    await pool.query(
      'INSERT INTO jtt_accounts (user_id, account_id, display_name, role, public_key, permissions, allowed_rooms, fingerprint, issued_by, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [userId, accountId, userRows[0].display_name, role, publicKey, permsJson, roomsJson, fingerprint, issuedBy, expiresAt]
    );
    // 6) 构造 jttAccountFile（§7-5 与 @jingtup/core AccountFile 对齐前，signature 待定）
    const file = buildAccountFile({
      accountId,
      displayName: userRows[0].display_name,
      role,
      permissions: Array.isArray(permissions) ? permissions : null,
      allowedRooms: Array.isArray(allowedRooms) ? allowedRooms : null,
      issuedBy,
      issuedAt: new Date(),
      expiresAt,
      publicKey,
      fingerprint
    });
    const data = { accountId, jttAccountFile: file };
    if (privateKey) {
      data.privateKey = privateKey; // 仅 Web 兜底代生成时一次性返回，客户端应立即本地保存；Web 不落库
      data.warning = '私钥为本次一次性返回，请立即安全保存；正式联调应由客户端本地生成密钥对后仅提交 publicKey';
    }
    return ok(res, data);
  } catch (e) { handleError(res, e, '[jtt/accounts/issue]'); }
});

// GET /api/jtt/accounts — 签发记录列表（契约 §3.2）
router.get('/accounts', requireRole('super_admin'), async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
    const pool = getPool();
    const where = [];
    const params = [];
    const uid = parseInt(req.query.userId, 10);
    if (Number.isFinite(uid)) { where.push('user_id = ?'); params.push(uid); }
    if (req.query.revoked === '0' || req.query.revoked === '1') {
      where.push('revoked = ?');
      params.push(parseInt(req.query.revoked, 10));
    }
    const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const [countRows] = await pool.query('SELECT COUNT(*) AS total FROM jtt_accounts' + whereSql, params);
    const total = countRows[0].total;
    const [rows] = await pool.query(
      'SELECT id, user_id, account_id, display_name, role, issued_at, expires_at, revoked, fingerprint FROM jtt_accounts' + whereSql +
      ' ORDER BY id DESC LIMIT ? OFFSET ?',
      params.concat([pageSize, (page - 1) * pageSize])
    );
    const accounts = rows.map(r => ({
      id: r.id,
      userId: r.user_id,
      accountId: r.account_id,
      displayName: r.display_name,
      role: r.role,
      issuedAt: toIso(r.issued_at),
      expiresAt: toIso(r.expires_at),
      revoked: !!r.revoked,
      fingerprint: r.fingerprint
    }));
    return ok(res, { accounts, total, page, pageSize });
  } catch (e) { handleError(res, e, '[jtt/accounts/list]'); }
});

// GET /api/jtt/accounts/export/:id — 下载 .jttaccount 文件（契约 §3.5）
// 注意：字面路由须注册在 GET /accounts/:id 参数路由之前，避免被截胡（route_guard shadow 告警）
router.get('/accounts/export/:id', requireRole('super_admin'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'id 非法');
    const pool = getPool();
    const [rows] = await pool.query('SELECT * FROM jtt_accounts WHERE id = ? LIMIT 1', [id]);
    if (!rows.length) {
      return sendError(res, 404, ErrorCodes.JTT_ACCOUNT_NOT_FOUND, '账号文件记录不存在');
    }
    const row = rows[0];
    if (row.revoked) {
      return sendError(res, 409, ErrorCodes.JTT_ACCOUNT_REVOKED, '账号文件已撤销，无法导出');
    }
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
      return sendError(res, 409, ErrorCodes.JTT_ACCOUNT_EXPIRED, '账号文件已过期，无法导出');
    }
    const file = buildAccountFile(row);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="' + row.account_id + '.jttaccount"');
    return res.send(JSON.stringify(file, null, 2));
  } catch (e) { handleError(res, e, '[jtt/accounts/export]'); }
});

// GET /api/jtt/accounts/:id — 签发记录详情（契约 §3.3）
router.get('/accounts/:id', requireRole('super_admin'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'id 非法');
    const pool = getPool();
    const [rows] = await pool.query('SELECT * FROM jtt_accounts WHERE id = ? LIMIT 1', [id]);
    if (!rows.length) {
      return sendError(res, 404, ErrorCodes.JTT_ACCOUNT_NOT_FOUND, '账号文件记录不存在');
    }
    const r = rows[0];
    return ok(res, {
      account: {
        id: r.id,
        userId: r.user_id,
        accountId: r.account_id,
        displayName: r.display_name,
        role: r.role,
        publicKey: r.public_key,
        permissions: r.permissions,
        allowedRooms: r.allowed_rooms,
        fingerprint: r.fingerprint,
        issuedBy: r.issued_by,
        issuedAt: toIso(r.issued_at),
        expiresAt: toIso(r.expires_at),
        revoked: !!r.revoked,
        revokedAt: toIso(r.revoked_at),
        createdAt: toIso(r.created_at),
        updatedAt: toIso(r.updated_at)
      }
    });
  } catch (e) { handleError(res, e, '[jtt/accounts/detail]'); }
});

// DELETE /api/jtt/accounts/:id — 撤销账号文件（契约 §3.4，逻辑撤销）
router.delete('/accounts/:id', requireRole('super_admin'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'id 非法');
    // 逻辑撤销；幂等：重复撤销（含记录不存在/已撤销）不报错
    const pool = getPool();
    await pool.query('UPDATE jtt_accounts SET revoked = 1, revoked_at = NOW() WHERE id = ? AND revoked = 0', [id]);
    return ok(res, { revoked: true });
  } catch (e) { handleError(res, e, '[jtt/accounts/revoke]'); }
});

// POST /api/jtt/accounts/verify — 客户端校验账号文件（契约 §3.6，签名端点，已加入 CSRF 豁免）
router.post('/accounts/verify', jttAuth, async (req, res) => {
  try {
    const { accountId, fingerprint, clientPublicKey } = req.body || {};
    // 独立查库以给出精确 reason（jttAuth 已保证签名有效、账号存在且未撤销未过期；
    // 此处仍按契约 §3.6 全分支防御，兼容后续中间件策略调整）
    const pool = getPool();
    const [rows] = await pool.query('SELECT * FROM jtt_accounts WHERE account_id = ? LIMIT 1', [accountId]);
    if (!rows.length) {
      return res.json({ valid: false, reason: 'not_found' });
    }
    const r = rows[0];
    if (r.revoked) {
      return res.json({ valid: false, reason: 'revoked' });
    }
    if (r.expires_at && new Date(r.expires_at).getTime() < Date.now()) {
      return res.json({ valid: false, reason: 'expired' });
    }
    if ((fingerprint && r.fingerprint !== fingerprint) || (clientPublicKey && r.public_key !== clientPublicKey)) {
      return res.json({ valid: false, reason: 'fingerprint_mismatch' });
    }
    return res.json({
      valid: true,
      account: {
        userId: r.user_id,
        displayName: r.display_name,
        role: r.role,
        permissions: r.permissions,
        allowedRooms: r.allowed_rooms,
        expiresAt: toIso(r.expires_at)
      }
    });
  } catch (e) { handleError(res, e, '[jtt/accounts/verify]'); }
});

// ==================== 方向②：游戏状态上报（客户端，签名认证） ====================

// POST /api/jtt/states — 上报/更新游戏状态（契约 §4.2，UPSERT 到 jtt_game_states）
router.post('/states', jttAuth, async (req, res) => {
  try {
    const { game, startedAt, visibility = 'public' } = req.body || {};
    const gameKey = game && game.key;
    if (!gameKey || !GAME_KEY_PATTERN.test(String(gameKey))) {
      return sendError(res, 400, ErrorCodes.JTT_GAME_INVALID, 'game.key 非法（小写字母数字开头，2-64 位）');
    }
    // 限流：≤1 次/15s/accountId（内存 Map，重启失效）
    const accountId = req.jttAccount && req.jttAccount.accountId;
    const now = Date.now();
    const last = accountId && stateReportCache.get(accountId);
    if (last && now - last < STATE_RATE_LIMIT_MS) {
      return sendError(res, 429, ErrorCodes.RATE_LIMITED, '状态上报过于频繁，请 15 秒后再试');
    }
    if (accountId) stateReportCache.set(accountId, now);
    // UPSERT：以 user_id 为唯一键（jtt_game_states.uk_user）写当前状态（契约 §4.2）
    if (!['public', 'members_only', 'private'].includes(visibility)) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'visibility 须为 public/members_only/private');
    }
    const pool = getPool();
    const userId = req.jttAccount.userId;
    const gameName = game.name ? String(game.name) : gameKey;
    const startedAtVal = new Date(startedAt || Date.now()).toISOString().slice(0, 19).replace('T', ' ');
    await pool.query(
      "INSERT INTO jtt_game_states (user_id, game_key, game_name, started_at, visibility, source) VALUES (?, ?, ?, ?, ?, 'client') ON DUPLICATE KEY UPDATE game_key = VALUES(game_key), game_name = VALUES(game_name), started_at = VALUES(started_at), visibility = VALUES(visibility), source = 'client'",
      [userId, gameKey, gameName, startedAtVal, visibility]
    );
    const [stateRows] = await pool.query(
      'SELECT user_id, game_key, game_name, started_at, updated_at, visibility FROM jtt_game_states WHERE user_id = ? LIMIT 1',
      [userId]
    );
    const s = stateRows[0];
    return ok(res, {
      state: {
        userId: s.user_id,
        gameKey: s.game_key,
        gameName: s.game_name,
        startedAt: toIso(s.started_at),
        updatedAt: toIso(s.updated_at),
        source: 'client',
        visibility: s.visibility
      }
    });
  } catch (e) { handleError(res, e, '[jtt/states/upsert]'); }
});

// DELETE /api/jtt/states — 清除游戏状态（契约 §4.3，幂等）
router.delete('/states', jttAuth, async (req, res) => {
  try {
    // 幂等：无记录也返回成功（契约 §4.3）
    const pool = getPool();
    await pool.query('DELETE FROM jtt_game_states WHERE user_id = ?', [req.jttAccount.userId]);
    return ok(res, { cleared: true });
  } catch (e) { handleError(res, e, '[jtt/states/clear]'); }
});

// GET /api/jtt/states/me — 查询自己的状态（契约 §4.4，签名认证）
router.get('/states/me', jttAuth, async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query(
      'SELECT user_id, game_key, game_name, started_at, updated_at, visibility FROM jtt_game_states WHERE user_id = ? LIMIT 1',
      [req.jttAccount.userId]
    );
    if (!rows.length) return ok(res, { state: null });
    const s = rows[0];
    return ok(res, {
      state: {
        userId: s.user_id,
        gameKey: s.game_key,
        gameName: s.game_name,
        startedAt: toIso(s.started_at),
        updatedAt: toIso(s.updated_at),
        visibility: s.visibility
      }
    });
  } catch (e) { handleError(res, e, '[jtt/states/me]'); }
});

// GET /api/jtt/states/online — 当前"正在玩"成员列表（契约 §4.6，Web 展示用）
router.get('/states/online', requireAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
    const gameKey = req.query.gameKey ? String(req.query.gameKey) : null;
    // 仅返回 visibility != 'private' 且 updated_at 距今 ≤15 分钟（TTL 可配置，契约 §7-3）的记录
    const pool = getPool();
    const where = ['s.visibility != ?', 's.updated_at >= DATE_SUB(NOW(), INTERVAL 15 MINUTE)'];
    const params = ['private'];
    if (gameKey) { where.push('s.game_key = ?'); params.push(gameKey); }
    const whereSql = ' WHERE ' + where.join(' AND ');
    const [countRows] = await pool.query('SELECT COUNT(*) AS total FROM jtt_game_states s' + whereSql, params);
    const total = countRows[0].total;
    const [rows] = await pool.query(
      'SELECT s.user_id, u.display_name, s.game_key, s.game_name, s.started_at, s.updated_at FROM jtt_game_states s LEFT JOIN users u ON u.id = s.user_id' + whereSql +
      ' ORDER BY s.updated_at DESC LIMIT ? OFFSET ?',
      params.concat([pageSize, (page - 1) * pageSize])
    );
    const online = rows.map(r => ({
      userId: r.user_id,
      displayName: r.display_name || '',
      gameKey: r.game_key,
      gameName: r.game_name,
      startedAt: toIso(r.started_at),
      updatedAt: toIso(r.updated_at)
    }));
    return ok(res, { online, total, page, pageSize });
  } catch (e) { handleError(res, e, '[jtt/states/online]'); }
});

// GET /api/jtt/states/:userId — 查询指定用户状态（契约 §4.5，Web 展示用）
// 注意：须注册在 GET /states/online 与 GET /states/me 之后，避免字面路由被参数路由截胡
router.get('/states/:userId', requireAuth, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    if (!Number.isFinite(userId)) return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'userId 非法');
    // 目标用户存在性校验（契约 §4.5 → 404 USER_NOT_FOUND）
    const pool = getPool();
    const [userRows] = await pool.query('SELECT id FROM users WHERE id = ? AND deleted_at IS NULL LIMIT 1', [userId]);
    if (!userRows.length) {
      return sendError(res, 404, ErrorCodes.USER_NOT_FOUND, '目标用户不存在');
    }
    const [rows] = await pool.query(
      'SELECT user_id, game_key, game_name, started_at, updated_at, visibility FROM jtt_game_states WHERE user_id = ? LIMIT 1',
      [userId]
    );
    if (!rows.length) return ok(res, { state: null });
    const s = rows[0];
    // 越权：private 仅本人/super_admin 可见（契约 §4.5 → 403 FORBIDDEN）
    if (s.visibility === 'private' && req.session.userId !== userId && req.session.role !== 'super_admin') {
      return sendError(res, 403, ErrorCodes.FORBIDDEN, '无权查看该用户的状态');
    }
    return ok(res, {
      state: {
        userId: s.user_id,
        gameKey: s.game_key,
        gameName: s.game_name,
        startedAt: toIso(s.started_at),
        updatedAt: toIso(s.updated_at),
        visibility: s.visibility
      }
    });
  } catch (e) { handleError(res, e, '[jtt/states/by-user]'); }
});

// ==================== 方向③：jt1:// 深链生成（Web 登录用户） ====================

// POST /api/jtt/deeplink/generate — 生成深链（契约 §5.2）
router.post('/deeplink/generate', requireAuth, async (req, res) => {
  try {
    const { type, targetId, inviteCode, expiresInMinutes = 10 } = req.body || {};
    if (!DEEPLINK_TYPES.includes(type)) {
      return sendError(res, 400, ErrorCodes.DEEPLINK_TYPE_INVALID, 'type 不在白名单 join/session/start/account/import');
    }
    const minutes = Number.isFinite(expiresInMinutes) && expiresInMinutes > 0 && expiresInMinutes <= 60 ? expiresInMinutes : 10;
    // 生成一次性票据（内存缓存，10 分钟有效；契约 §7-2 接受，可换 jtt_deeplink_tickets 表）
    const ticket = crypto.randomBytes(18).toString('hex');
    const expiresAt = new Date(Date.now() + minutes * 60 * 1000);
    deeplinkTickets.set(ticket, { type, targetId: targetId != null ? targetId : null, inviteCode: inviteCode != null ? String(inviteCode) : null, expiresAt: expiresAt.getTime() });
    // 按 type 构造 jt1:// 链接（契约 §5.1），参数 URL 编码；targetId 按 type 复用（join=房间ID / session/start=gameKey / account/import=账号文件URL）
    const enc = v => encodeURIComponent(v == null ? '' : String(v));
    let deepLink;
    if (type === 'join') {
      deepLink = 'jt1://join?roomId=' + enc(targetId) + '&inviteCode=' + enc(inviteCode) + '&ticket=' + enc(ticket);
    } else if (type === 'session/start') {
      deepLink = 'jt1://session/start?game=' + enc(targetId) + '&ticket=' + enc(ticket);
    } else {
      deepLink = 'jt1://account/import?url=' + enc(targetId) + '&token=' + enc(ticket);
    }
    return ok(res, { deepLink, expiresAt: expiresAt.toISOString() });
  } catch (e) { handleError(res, e, '[jtt/deeplink/generate]'); }
});

// ==================== 方向④：客户端账号注册联动（绑定码注册，TOFU 首次信任） ====================

// POST /api/jtt/bind-codes — 生成一次性绑定码（契约 §3.8，管理端点：super_admin + Session + CSRF）
// 原始绑定码仅本次响应返回一次；库中仅存 SHA-256 哈希，防存储侧泄漏（契约 §2.3）
router.post('/bind-codes', requireRole('super_admin'), async (req, res) => {
  try {
    const { userId, displayName, role = 'member', expiresInDays = 7 } = req.body || {};
    if (!userId || typeof userId !== 'number') {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'userId 必填且为数字');
    }
    if (!JTT_ROLE_WHITELIST.includes(role)) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'role 不在白名单 member/admin/super_admin');
    }
    if (!Number.isFinite(expiresInDays) || expiresInDays < 1 || expiresInDays > 30) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'expiresInDays 须为 1-30 天');
    }
    // 1) 校验目标用户存在且未封禁/软删（users 表，失败 → 400 USER_NOT_FOUND / USER_UNAVAILABLE）
    const pool = getPool();
    const [userRows] = await pool.query(
      'SELECT id, display_name, banned FROM users WHERE id = ? AND deleted_at IS NULL LIMIT 1',
      [userId]
    );
    if (!userRows.length) {
      return sendError(res, 400, ErrorCodes.USER_NOT_FOUND, '目标用户不存在');
    }
    if (userRows[0].banned) {
      return sendError(res, 400, ErrorCodes.USER_UNAVAILABLE, '目标用户已封禁');
    }
    // 2) 生成绑定码：JTBC- 前缀 + 24 位随机大写字母数字（字符集 A-Z0-9）
    const BIND_CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let bindCode = 'JTBC-';
    for (let i = 0; i < 24; i += 1) {
      bindCode += BIND_CODE_CHARS[crypto.randomInt(0, BIND_CODE_CHARS.length)];
    }
    // 3) 落库：只存 SHA-256 哈希（防存储侧泄漏，契约 §2.3）；expires_at = NOW() + expiresInDays 天
    const finalDisplayName = displayName && typeof displayName === 'string' ? displayName : userRows[0].display_name;
    await pool.query(
      'INSERT INTO jtt_bind_codes (code_hash, user_id, display_name, role, expires_at, created_by) VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? DAY), ?)',
      [crypto.createHash('sha256').update(bindCode, 'utf8').digest('hex'), userId, finalDisplayName, role, expiresInDays, req.session.userId || null]
    );
    // 4) 原始码仅本次返回，之后不可再查（库中只有哈希）
    return ok(res, {
      bindCode,
      userId,
      displayName: finalDisplayName,
      role,
      expiresAt: new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString()
    });
  } catch (e) { handleError(res, e, '[jtt/bind-codes/create]'); }
});

// POST /api/jtt/accounts/register — 客户端账号注册联动（契约 §3.7，签名端点，已加入 CSRF 豁免，TOFU）
// 注册时账号尚不存在，故不挂 jttAuth：用请求体 publicKey 验签（首次信任由一次性绑定码带外保证）
router.post('/accounts/register', async (req, res) => {
  try {
    const { accountId, displayName, publicKey, bindCode } = req.body || {};
    const timestamp = req.headers['x-jtt-timestamp'];
    const nonce = req.headers['x-jtt-nonce'];
    const signature = req.headers['x-jtt-signature'];
    const accountIdPattern = new RegExp('^' + JTT_ACCOUNT_PREFIX + '[0-9a-f]{32}$');
    if (!accountId || typeof accountId !== 'string' || !accountIdPattern.test(accountId)) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'accountId 非法（须为 ' + JTT_ACCOUNT_PREFIX + ' + 32 位 hex）');
    }
    if (!publicKey || typeof publicKey !== 'string' || !bindCode || typeof bindCode !== 'string') {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'publicKey/bindCode 必填且为字符串');
    }
    if (!timestamp || !nonce || !signature) {
      return sendError(res, 401, ErrorCodes.JTT_SIGNATURE_INVALID, '缺少 JTT 签名请求头');
    }
    const pool = getPool();
    // ① 绑定码校验（契约 §3.7 顺序：存在 → 未使用 → 未过期）
    const codeHash = crypto.createHash('sha256').update(String(bindCode), 'utf8').digest('hex');
    const [codeRows] = await pool.query('SELECT * FROM jtt_bind_codes WHERE code_hash = ? LIMIT 1', [codeHash]);
    if (!codeRows.length) {
      return sendError(res, 400, ErrorCodes.JTT_BIND_CODE_INVALID, '绑定码无效（不存在）');
    }
    const codeRow = codeRows[0];
    // 幂等优先：绑码已使用但该 accountId 已注册 → 返回首次成功结果（不重复落库）
    if (codeRow.used_at) {
      const [existRows] = await pool.query('SELECT * FROM jtt_accounts WHERE account_id = ? LIMIT 1', [accountId]);
      if (existRows.length) {
        const ex = existRows[0];
        return ok(res, {
          accountId: ex.account_id,
          userId: ex.user_id,
          displayName: ex.display_name,
          role: ex.role,
          fingerprint: ex.fingerprint,
          expiresAt: toIso(ex.expires_at),
          webUrl: webLaunchUrl(req, ex.account_id)
        });
      }
      return sendError(res, 409, ErrorCodes.JTT_BIND_CODE_USED, '绑定码已使用');
    }
    if (new Date(codeRow.expires_at).getTime() < Date.now()) {
      return sendError(res, 409, ErrorCodes.JTT_BIND_CODE_EXPIRED, '绑定码已过期');
    }
    // ② 时间戳窗口校验（±300s，超窗 → 401 JTT_TIMESTAMP_STALE）+ nonce 防重放
    const ts = parseInt(timestamp, 10);
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > SIGNATURE_WINDOW_SEC) {
      return sendError(res, 401, ErrorCodes.JTT_TIMESTAMP_STALE, '请求时间戳超窗');
    }
    const now = Date.now();
    const nonceKey = accountId + ':register:' + nonce;
    if (nonceCache.has(nonceKey)) {
      return sendError(res, 401, ErrorCodes.JTT_SIGNATURE_INVALID, 'nonce 重复（防重放）');
    }
    nonceCache.set(nonceKey, now);
    if (nonceCache.size > 10000) {
      for (const [k, v] of nonceCache) {
        if (now - v > SIGNATURE_WINDOW_SEC * 1000) nonceCache.delete(k);
      }
    }
    // ③ TOFU 验签：账号尚未入表，用请求体 publicKey 验签（首次信任由绑定码带外保证）
    const rawBody = rawBodyApprox(req);
    const message = buildSignatureString(req.method, signaturePath(req), timestamp, nonce, rawBody);
    if (!verifyEd25519(String(publicKey), String(signature), message)) {
      return sendError(res, 401, ErrorCodes.JTT_SIGNATURE_INVALID, '签名验证失败（TOFU）');
    }
    // ④ accountId 未注册检查 + 落库（事务：jtt_accounts 插入 + 绑定码标记已用）
    const fingerprint = fingerprintOf(publicKey);
    const conn = await pool.getConnection();
    try {
      const [existRows] = await conn.query('SELECT id FROM jtt_accounts WHERE account_id = ? LIMIT 1', [accountId]);
      if (existRows.length) {
        return sendError(res, 409, ErrorCodes.JTT_ACCOUNT_EXISTS, '该 accountId 已注册');
      }
      await conn.query(
        'INSERT INTO jtt_accounts (user_id, account_id, display_name, role, public_key, fingerprint, issued_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [codeRow.user_id, accountId, codeRow.display_name, codeRow.role, String(publicKey), fingerprint, codeRow.created_by || null]
      );
      await conn.query('UPDATE jtt_bind_codes SET used_at = NOW(), used_by = ? WHERE id = ?', [accountId, codeRow.id]);
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
    // ⑤ 返回注册结果（契约 §3.7）
    return ok(res, {
      accountId,
      userId: codeRow.user_id,
      displayName: codeRow.display_name,
      role: codeRow.role,
      fingerprint,
      expiresAt: null,
      webUrl: webLaunchUrl(req, accountId)
    });
  } catch (e) { handleError(res, e, '[jtt/accounts/register]'); }
});

module.exports = router;