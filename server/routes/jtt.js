// 境途 × 境途同游 联动接口骨架（挂载前缀 /api/jtt）
// 依据：p2p/docs/04-jingtu-web-integration.md（契约 0.3 草案）
// 本文件为代码骨架：端点、权限、签名规范已按契约落地；数据库写入与联调实现留 TODO。
// 四个方向：
//   ① 账号文件签发（管理端 super_admin，Session + CSRF）
//   ② 游戏状态上报（客户端，X-JTT-* 头 + ED25519 签名认证，免 Session）
//   ③ jt1:// 深链生成（Web 登录用户）
//   ④ 客户端账号注册联动（仅客户端超管可创建账号文件，普通用户不可自助创建；凭一次性绑定码注册，TOFU 首次信任）
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

// 构造签名串：METHOD \n PATH \n TIMESTAMP \n NONCE \n RAW_BODY（契约 §4.1）
function buildSignatureString(method, path, timestamp, nonce, rawBody) {
  return [method, path, String(timestamp), String(nonce), rawBody == null ? '' : String(rawBody)].join('\n');
}

// ED25519 验签（Node 内置 crypto.verify，零第三方依赖）
function verifyEd25519(publicKeyBase64, signatureBase64, message) {
  try {
    return crypto.verify(
      'ed25519',
      Buffer.from(message, 'utf8'),
      Buffer.from(publicKeyBase64, 'base64'),
      Buffer.from(signatureBase64, 'base64')
    );
  } catch (e) {
    return false;
  }
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
    // TODO: 联调实现
    //  1) 按 accountId 查 jtt_accounts 加载账号：无记录 → 401 JTT_ACCOUNT_NOT_FOUND；
    //     已撤销 → 401 JTT_ACCOUNT_REVOKED；已过期 → 401 JTT_ACCOUNT_EXPIRED
    //  2) nonce 防重放：落 jtt_nonce 表（或内存 Map，重启失效），重复 nonce → 401 JTT_SIGNATURE_INVALID
    //  3) RAW_BODY 需在 express.json 之前捕获原始请求体（骨架暂用 JSON.stringify(req.body) 近似）
    const account = null; // 骨架阶段不加载账号，一律视为未联调
    if (!account) {
      return sendError(res, 401, ErrorCodes.JTT_ACCOUNT_NOT_FOUND, '账号文件未找到（骨架阶段，联调后按 jtt_accounts 验签）');
    }
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
    const message = buildSignatureString(req.method, req.path, timestamp, nonce, rawBody);
    if (!account.publicKey || !verifyEd25519(account.publicKey, signature, message)) {
      return sendError(res, 401, ErrorCodes.JTT_SIGNATURE_INVALID, '签名验证失败');
    }
    req.jttAccount = account;
    next();
  } catch (e) { handleError(res, e, '[jtt/jttAuth]'); }
}

// ==================== 方向①：账号文件签发（管理端，Session + CSRF） ====================

// POST /api/jtt/accounts/issue — 签发账号文件（契约 §3.1）
router.post('/accounts/issue', requireRole('super_admin'), async (req, res) => {
  try {
    const { userId, role = 'member', permissions, allowedRooms, expiresInDays } = req.body || {};
    if (!userId || typeof userId !== 'number') {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'userId 必填且为数字');
    }
    if (!JTT_ROLE_WHITELIST.includes(role)) {
      return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'role 不在白名单 member/admin/super_admin');
    }
    // TODO: 联调实现
    //  1) 校验目标用户存在且未封禁/软删（users 表，失败 → 400 USER_NOT_FOUND / USER_UNAVAILABLE）
    //  2) 检查是否已有有效账号文件（未撤销未过期 → 409 JTT_ACCOUNT_EXISTS，支持 force 覆盖）
    //  3) 生成 accountId（jt_ + 32 位 hex）与 fingerprint（公钥哈希）
    //  4) 生成/接收 ED25519 密钥对并写库（私钥处理见契约 §7-1 待确认项）
    //  5) 构造 jttAccountFile 完整对象（与 @jingtup/core AccountFile 逐字段对齐，见契约 §7-5）
    return ok(res, {
      skeleton: true,
      accountId: JTT_ACCOUNT_PREFIX + crypto.randomBytes(16).toString('hex'),
      message: '骨架占位，联调实现后返回完整 jttAccountFile'
    });
  } catch (e) { handleError(res, e, '[jtt/accounts/issue]'); }
});

// GET /api/jtt/accounts — 签发记录列表（契约 §3.2）
router.get('/accounts', requireRole('super_admin'), async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
    // TODO: 联调实现 —— 按 userId/revoked 过滤分页查询 jtt_accounts，
    //       返回 { accounts, total, page, pageSize }，不含 publicKey 之外敏感字段
    return ok(res, { skeleton: true, accounts: [], total: 0, page, pageSize, message: '骨架占位，联调实现' });
  } catch (e) { handleError(res, e, '[jtt/accounts/list]'); }
});

// GET /api/jtt/accounts/export/:id — 下载 .jttaccount 文件（契约 §3.5）
// 注意：字面路由须注册在 GET /accounts/:id 参数路由之前，避免被截胡（route_guard shadow 告警）
router.get('/accounts/export/:id', requireRole('super_admin'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'id 非法');
    // TODO: 联调实现 —— 查 jtt_accounts 取 jttAccountFile 对象，
    //       以 application/json 附件返回（Content-Disposition: attachment; filename="<accountId>.jttaccount"）；
    //       已撤销/过期 → 409 JTT_ACCOUNT_REVOKED / JTT_ACCOUNT_EXPIRED；无记录 → 404 JTT_ACCOUNT_NOT_FOUND
    return ok(res, { skeleton: true, message: '骨架占位，联调实现后返回 .jttaccount 附件' });
  } catch (e) { handleError(res, e, '[jtt/accounts/export]'); }
});

// GET /api/jtt/accounts/:id — 签发记录详情（契约 §3.3）
router.get('/accounts/:id', requireRole('super_admin'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'id 非法');
    // TODO: 联调实现 —— 返回完整签发记录（含 publicKey/permissions/allowedRooms）；无记录 → 404 JTT_ACCOUNT_NOT_FOUND
    return ok(res, { skeleton: true, account: null, message: '骨架占位，联调实现' });
  } catch (e) { handleError(res, e, '[jtt/accounts/detail]'); }
});

// DELETE /api/jtt/accounts/:id — 撤销账号文件（契约 §3.4，逻辑撤销）
router.delete('/accounts/:id', requireRole('super_admin'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'id 非法');
    // TODO: 联调实现 —— UPDATE jtt_accounts SET revoked=1, revoked_at=NOW() WHERE id=?；
    //       幂等：重复撤销不报错
    return ok(res, { skeleton: true, revoked: true, message: '骨架占位，联调实现' });
  } catch (e) { handleError(res, e, '[jtt/accounts/revoke]'); }
});

// POST /api/jtt/accounts/verify — 客户端校验账号文件（契约 §3.6，签名端点，已加入 CSRF 豁免）
router.post('/accounts/verify', jttAuth, async (req, res) => {
  try {
    const { accountId, fingerprint, clientPublicKey } = req.body || {};
    // TODO: 联调实现 —— 按 accountId 查库，比对 fingerprint 与 clientPublicKey；
    //       有效 → { valid:true, account:{...} }；
    //       无效 → 200 { valid:false, reason:'revoked'|'expired'|'not_found'|'fingerprint_mismatch' }
    return res.json({ valid: false, reason: 'not_implemented', skeleton: true });
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
    // TODO: 联调实现 —— 以 user_id 为 UPSERT 键写入 jtt_game_states
    //       （INSERT ... ON DUPLICATE KEY UPDATE），返回完整 state 对象
    return ok(res, {
      skeleton: true,
      state: { userId: null, gameKey, gameName: game.name || '', startedAt, visibility },
      message: '骨架占位，联调实现后写入 jtt_game_states'
    });
  } catch (e) { handleError(res, e, '[jtt/states/upsert]'); }
});

// DELETE /api/jtt/states — 清除游戏状态（契约 §4.3，幂等）
router.delete('/states', jttAuth, async (req, res) => {
  try {
    // TODO: 联调实现 —— DELETE FROM jtt_game_states WHERE user_id = ?（无记录也返回成功）
    return ok(res, { skeleton: true, cleared: true, message: '骨架占位，联调实现' });
  } catch (e) { handleError(res, e, '[jtt/states/clear]'); }
});

// GET /api/jtt/states/me — 查询自己的状态（契约 §4.4，签名认证）
router.get('/states/me', jttAuth, async (req, res) => {
  try {
    // TODO: 联调实现 —— 按 user_id 查 jtt_game_states；无记录 → { state: null }
    return ok(res, { skeleton: true, state: null, message: '骨架占位，联调实现' });
  } catch (e) { handleError(res, e, '[jtt/states/me]'); }
});

// GET /api/jtt/states/online — 当前"正在玩"成员列表（契约 §4.6，Web 展示用）
router.get('/states/online', requireAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
    const gameKey = req.query.gameKey ? String(req.query.gameKey) : null;
    // TODO: 联调实现 —— 查询 visibility != 'private' 且 updated_at 距今 ≤15 分钟（TTL 可配置，契约 §7-3）
    //       的记录，JOIN users 取 displayName；返回 { online, total, page, pageSize }
    return ok(res, { skeleton: true, online: [], total: 0, page, pageSize, message: '骨架占位，联调实现' });
  } catch (e) { handleError(res, e, '[jtt/states/online]'); }
});

// GET /api/jtt/states/:userId — 查询指定用户状态（契约 §4.5，Web 展示用）
// 注意：须注册在 GET /states/online 与 GET /states/me 之后，避免字面路由被参数路由截胡
router.get('/states/:userId', requireAuth, async (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    if (!Number.isFinite(userId)) return sendError(res, 400, ErrorCodes.BAD_REQUEST, 'userId 非法');
    // TODO: 联调实现 —— 目标 visibility=private 时仅本人/super_admin 可见（403 FORBIDDEN）；
    //       无记录 → { state: null }
    return ok(res, { skeleton: true, state: null, message: '骨架占位，联调实现' });
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
    // TODO: 联调实现
    //  1) 按 type 构造 jt1:// 链接（join / session/start / account/import），参数 URL 编码
    //  2) ticket/token 落 jtt_deeplink_tickets 表（可选表，见契约 §7-2），有效期 10 分钟一次性
    return ok(res, {
      skeleton: true,
      deepLink: 'jt1://' + String(type) + '?skeleton=1',
      expiresAt: new Date(Date.now() + expiresInMinutes * 60 * 1000).toISOString(),
      message: '骨架占位，联调实现'
    });
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
    // TODO: 联调实现
    //  1) 校验目标用户存在且未封禁/软删（users 表，失败 → 400 USER_NOT_FOUND / USER_UNAVAILABLE）
    //  2) 生成绑定码：JTBC- 前缀 + 24 位随机大写字母数字；落库 jtt_bind_codes（code_hash=SHA-256(bindCode)）
    //  3) expires_at = NOW() + expiresInDays 天；原始码仅本次返回，之后不可再查
    const bindCode = 'JTBC-' + crypto.randomBytes(18).toString('hex').toUpperCase().slice(0, 24);
    return ok(res, {
      skeleton: true,
      bindCode,
      userId,
      displayName: displayName || '',
      role,
      expiresInDays,
      expiresAt: new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString(),
      message: '骨架占位，原始码仅本次返回，联调后入库 jtt_bind_codes'
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
    // TODO: 联调实现
    //  1) 校验绑定码：查 jtt_bind_codes（code_hash=SHA-256(bindCode)）
    //     - 无记录 → 400 JTT_BIND_CODE_INVALID；used_at 非空 → 409 JTT_BIND_CODE_USED；expires_at < NOW() → 409 JTT_BIND_CODE_EXPIRED
    //  2) 时间戳窗口校验（±300s，超窗 → 401 JTT_TIMESTAMP_STALE）+ nonce 防重放（重复 → 401 JTT_SIGNATURE_INVALID）
    //  3) TOFU 验签：buildSignatureString(METHOD, PATH, TIMESTAMP, NONCE, RAW_BODY)，用请求体 publicKey 验签（账号未入表）
    //  4) 幂等：按 accountId 查 jtt_accounts，已存在 → 返回首次成功结果（success:true）
    //  5) 落库 jtt_accounts：user_id=绑定码目标用户、issued_by=绑定码 created_by、fingerprint=公钥哈希、role=绑定码 role；
    //     标记绑定码 used_at/used_by；返回 { success:true, accountId, userId, displayName, role, fingerprint, expiresAt, webUrl }
    return ok(res, {
      skeleton: true,
      success: false,
      accountId,
      userId: null,
      displayName: displayName || '',
      role: null,
      fingerprint: null,
      expiresAt: null,
      webUrl: null,
      message: '骨架占位，联调实现后完成绑定码校验与 TOFU 注册'
    });
  } catch (e) { handleError(res, e, '[jtt/accounts/register]'); }
});

module.exports = router;