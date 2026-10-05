// P2-148: 认证服务层 5 模块行为测试
// auth.js（bcrypt/强度/权限中间件实时回查）、auth_session.js（会话构建/映射）、
// auth_local_service（登录计数/锁定/注册）、auth_reset_service（找回码 5 次作废）、
// auth_vrc_service（2FA 规范化/刷新）此前零行为测试。
const express = require('express');
const request = require('supertest');

const mockPool = { query: jest.fn() };
const mockLogger = { warn: jest.fn(), error: jest.fn(), info: jest.fn() };
const mockActivation = {
  validateAndConsume: jest.fn(),
  ActivationCodeError: class extends Error {
    constructor(message, reason) { super(message); this.reason = reason; }
  }
};
const mockMailer = { sendEmail: jest.fn(() => ({ success: true })) };

jest.mock('../db', () => ({ getPool: () => mockPool }));
jest.mock('../utils', () => ({
    getPool: () => mockPool,
    encryptCookie: jest.fn((v) => (v ? 'enc:' + v : v)),
    getAvatarUrl: jest.fn(() => null),
    ErrorCodes: {
      BAD_REQUEST: 'BAD_REQUEST', FORBIDDEN: 'FORBIDDEN', NOT_FOUND: 'NOT_FOUND',
      CONFLICT: 'CONFLICT', INTERNAL_ERROR: 'INTERNAL_ERROR', UNAUTHORIZED: 'UNAUTHORIZED',
      ACCOUNT_PENDING: 'ACCOUNT_PENDING', VRC_AUTH_FAILED: 'VRC_AUTH_FAILED', VRC_UPSTREAM_ERROR: 'VRC_UPSTREAM_ERROR'
    },
    fail(res, status, message, extra) {
      return res.status(status).json(Object.assign({ success: false, error: message }, extra || {}));
    },
    ok(res, fields) {
      return res.json(fields ? { success: true, ...fields } : { success: true });
    },
    sendError(res, status, code, message) {
      return res.status(status).json({ success: false, error: { code, message } });
    },
    handleError(res, e) {
      return res.status(e.statusCode || 500).json({ success: false, error: { code: e.code || 'INTERNAL_ERROR', message: e.message } });
    }
  }));
jest.mock('../logger', () => mockLogger);
jest.mock('../mailer', () => mockMailer);
jest.mock('../middleware/rate_limit', () => ({
  passwordResetLimiter: (req, res, next) => next(),
  registerLimiter: (req, res, next) => next(),
  createCustomLimiter: () => (req, res, next) => next()
}));
jest.mock('../activation_code_service', () => mockActivation);
jest.mock('../vrc', () => ({
  VRC_API_KEY: 'key',
  vrchatRequest: jest.fn(),
  vrchatBasicLogin: jest.fn(),
  vrchatGetCurrentUserResult: jest.fn(),
  vrchatGetUser: jest.fn(),
  vrchatVerifyTwoFactor: jest.fn()
}));

const auth = require('../auth');
const authSession = require('../auth_session');
const { verifyVrc2fa } = require('../auth_vrc_service');
const authRouter = require('../routes/auth');
const { vrchatVerifyTwoFactor, vrchatGetCurrentUserResult, vrchatBasicLogin } = require('../vrc');

// ─────────────────────────── 工具 ───────────────────────────
function mockQueryBySql(routes) {
  mockPool.query.mockImplementation((sql, params) => {
    for (const [pattern, result] of routes) {
      if (pattern.test(sql)) return Promise.resolve(result);
    }
    return Promise.resolve([[]]);
  });
}

function defaultSessionMiddleware(req, res, next) {
  req.session = {
    userId: 7,
    loginId: 'tester',
    displayName: 'Tester',
    role: 'admin',
    regenerate(cb) { cb(null); },
    save() { return Promise.resolve(); },
    destroy(cb) { cb(null); }
  };
  next();
}

function createApp(extra) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (extra && extra.sessionFactory) {
      req.session = extra.sessionFactory();
      if (typeof req.session.regenerate !== 'function') req.session.regenerate = (cb) => cb(null);
      if (typeof req.session.save !== 'function') req.session.save = () => Promise.resolve();
      if (typeof req.session.destroy !== 'function') req.session.destroy = (cb) => cb(null);
      return next();
    }
    defaultSessionMiddleware(req, res, next);
  });
  app.use('/api/auth', authRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockActivation.validateAndConsume.mockReset();
  mockMailer.sendEmail.mockImplementation(() => ({ success: true }));
  // 默认：无超管 → needInit
  mockQueryBySql([]);
});

// ─────────────────────────── auth.js ───────────────────────────
describe('P2-148 auth.js 密码与权限', () => {
  let realHash;
  beforeAll(async () => {
    realHash = await auth.hashPassword('Abc12345');
  });

  test('hashPassword/verifyPassword 往返', async () => {
    expect(await auth.verifyPassword('Abc12345', realHash)).toBe(true);
    expect(await auth.verifyPassword('wrong', realHash)).toBe(false);
  });

  test('validatePasswordStrength 强度规则', () => {
    expect(auth.validatePasswordStrength('Abc12345')).toEqual({ valid: true, errors: [] });
    const weak = auth.validatePasswordStrength('short');
    expect(weak.valid).toBe(false);
    expect(weak.errors).toContain('密码至少8位');
    expect(auth.validatePasswordStrength('abcdefgh')).toEqual({
      valid: false,
      errors: ['需包含大写字母', '需包含数字']
    });
  });

  test('encryptAES/decryptAES 往返与容错', () => {
    const enc = auth.encryptAES('hello-qq');
    expect(enc).toMatch(/^[0-9a-f]{32}:[0-9a-f]+$/);
    expect(auth.decryptAES(enc)).toBe('hello-qq');
    expect(auth.encryptAES(null)).toBeNull();
    expect(auth.decryptAES(null)).toBeNull();
    expect(auth.decryptAES('bad-format')).toBeNull();
  });

  test('requireAuth 未登录 401 / 已登录放行', () => {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    auth.requireAuth({}, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(401);

    const next = jest.fn();
    auth.requireAuth({ session: { userId: 1 } }, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('requireRole 实时回查数据库角色（member→db admin 放行 admin 门槛）', async () => {
    mockQueryBySql([[/SELECT role FROM users/, [[{ role: 'admin' }]]]]);
    const mw = auth.requireRole('admin');
    const next = jest.fn();
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await mw({ session: { userId: 5, role: 'member' } }, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(403);
  });

  test('requireRole 数据库降级后 403（session 高权不续）', async () => {
    mockQueryBySql([[/SELECT role FROM users/, [[{ role: 'member' }]]]]);
    const mw = auth.requireRole('admin');
    const next = jest.fn();
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await mw({ session: { userId: 5, role: 'admin' } }, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('requireSuperAdmin 仅超管放行', async () => {
    const next = jest.fn();
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await auth.requireSuperAdmin({ session: { userId: 5, role: 'super_admin' } }, res, next);
    expect(next).toHaveBeenCalled();

    const next2 = jest.fn();
    const res2 = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await auth.requireSuperAdmin({ session: { userId: 5, role: 'admin' } }, res2, next2);
    expect(res2.status).toHaveBeenCalledWith(403);
    expect(next2).not.toHaveBeenCalled();
  });
});

// ─────────────────────────── auth_session.js ───────────────────────────
describe('P2-148 auth_session.js 会话构建', () => {
  test('buildSession 写入全部会话字段', () => {
    const req = { session: {} };
    authSession.buildSession(req, {
      id: 3, login_id: 'a', display_name: 'Alice', vrchat_id: 'usr_1',
      vrchat_name: 'A', vrchat_verified: 1, vrchat_avatar_url: 'https://x/av.png',
      role: 'member', avatar_type: 'custom', custom_avatar_path: '/uploads/a.png'
    });
    const s = req.session;
    expect(s.loggedIn).toBe(true);
    expect(s.userId).toBe(3);
    expect(s.role).toBe('member');
    expect(s.vrchatVerified).toBe(true);
    expect(s.avatarUrl).toBe('/uploads/a.png');
    expect(s.vrchatAvatarUrl).toBe('https://x/av.png');
  });

  test('buildSession 加密 vrchat cookie 并记录设置时间', () => {
    const req = { session: {} };
    const { encryptCookie } = require('../utils');
    encryptCookie.mockReturnValue('enc:secret');
    authSession.buildSession(req, baseUser(), 'auth=cookie');
    expect(req.session.vrchatCookie).toBe('enc:secret');
    expect(req.session.vrcCookieSetAt).toEqual(expect.any(Number));
  });

  test('buildSession cookie 加密失败抛错', () => {
    const req = { session: {} };
    const { encryptCookie } = require('../utils');
    encryptCookie.mockReturnValue(null);
    expect(() => authSession.buildSession(req, baseUser(), 'auth=cookie')).toThrow('cookie 加密失败');
  });

  test('sessionUser 未登录/无 userId 返回 null；已登录映射字段', () => {
    expect(authSession.sessionUser(undefined)).toBeNull();
    expect(authSession.sessionUser({})).toBeNull();
    const u = authSession.sessionUser({
      userId: 1, loginId: 'l', displayName: 'D', role: 'admin',
      avatarType: 'none', vrchatVerified: false
    });
    expect(u.id).toBe(1);
    expect(u.roleLabel).toBe('管理员');
    expect(u.vrchatVerified).toBe(false);
  });
});

function baseUser() {
  return {
    id: 3, login_id: 'a', display_name: 'Alice', vrchat_id: null,
    vrchat_name: null, vrchat_verified: 0, vrchat_avatar_url: null,
    role: 'member', avatar_type: 'none', custom_avatar_path: null
  };
}

// ─────────────────────────── auth_local_service ───────────────────────────
describe('P2-148 auth_local_service 登录/锁定/注册', () => {
  let realHash;
  beforeAll(async () => {
    realHash = await auth.hashPassword('Abc12345');
  });

  test('GET /init 无超管 → needInit true', async () => {
    mockQueryBySql([[/\bCOUNT\(\*\) as cnt\b/, [[{ cnt: 0 }]]]]);
    const res = await request(createApp()).get('/api/auth/init');
    expect(res.status).toBe(200);
    expect(res.body.needInit).toBe(true);
  });

  test('密码错误递增 failed_login_attempts 并返回 401', async () => {
    mockQueryBySql([
      [/SELECT \* FROM users WHERE/, [[{ id: 5, login_id: 'alice', display_name: 'Alice', password_hash: realHash, role: 'member', approved: 1, banned: 0, locked_until: null, failed_login_attempts: 1 }]]],
      // AUTH-1：原子递增后回读计数（新 SQL 形态）
      [/SELECT failed_login_attempts FROM/, [[{ failed_login_attempts: 2 }]]]
    ]);
    const res = await request(createApp())
      .post('/api/auth/login')
      .send({ loginId: 'alice', password: 'WrongPass9' });
    expect(res.status).toBe(401);
    expect(res.body.error).toContain('登录失败');
    // AUTH-1：原子 SQL（failed_login_attempts = failed_login_attempts + 1），非「读快照再写回」
    const upd = mockPool.query.mock.calls.find(c => /failed_login_attempts\s*=\s*failed_login_attempts\s*\+\s*1 WHERE/.test(c[0]));
    expect(upd).toBeTruthy();
    expect(upd[1]).toEqual([5]);
  });

  test('第 5 次失败锁定 423（locked_until +15MIN）', async () => {
    mockQueryBySql([
      [/SELECT \* FROM users WHERE/, [[{ id: 5, login_id: 'alice', display_name: 'Alice', password_hash: realHash, role: 'member', approved: 1, banned: 0, locked_until: null, failed_login_attempts: 4 }]]],
      // AUTH-1：原子递增后回读计数 = 5 → 触发锁定
      [/SELECT failed_login_attempts FROM/, [[{ failed_login_attempts: 5 }]]]
    ]);
    const res = await request(createApp())
      .post('/api/auth/login')
      .send({ loginId: 'alice', password: 'WrongPass9' });
    expect(res.status).toBe(423);
    expect(res.body.code).toBe('ACCOUNT_LOCKED');
    const upd = mockPool.query.mock.calls.find(c => /locked_until = DATE_ADD/.test(c[0]));
    expect(upd).toBeTruthy();
    expect(upd[1][0]).toBe(5);
  });

  test('封禁/待审核/锁定中拦截', async () => {
    const base = { id: 5, login_id: 'b', display_name: 'B', password_hash: realHash, role: 'member' };
    mockQueryBySql([
      [/SELECT \* FROM users WHERE/, [[{ ...base, approved: 1, banned: 1, locked_until: null, failed_login_attempts: 0 }]]]
    ]);
    let res = await request(createApp()).post('/api/auth/login').send({ loginId: 'b', password: 'WrongPass9' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('ACCOUNT_BANNED');

    mockQueryBySql([
      [/SELECT \* FROM users WHERE/, [[{ ...base, approved: 0, banned: 0, locked_until: null, failed_login_attempts: 0 }]]]
    ]);
    res = await request(createApp()).post('/api/auth/login').send({ loginId: 'b', password: 'WrongPass9' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('ACCOUNT_PENDING');

    mockQueryBySql([
      [/SELECT \* FROM users WHERE/, [[{ ...base, approved: 1, banned: 0, locked_until: new Date(Date.now() + 6e5).toISOString(), failed_login_attempts: 0 }]]]
    ]);
    res = await request(createApp()).post('/api/auth/login').send({ loginId: 'b', password: 'WrongPass9' });
    expect(res.status).toBe(423);
    expect(res.body.code).toBe('ACCOUNT_LOCKED');
  });

  test('登录成功清空失败计数并建会话', async () => {
    mockQueryBySql([
      [/SELECT \* FROM users WHERE/, [[{ id: 5, login_id: 'alice', display_name: 'Alice', password_hash: realHash, role: 'member', approved: 1, banned: 0, locked_until: null, failed_login_attempts: 3 }]]]
    ]);
    const res = await request(createApp())
      .post('/api/auth/login')
      .send({ loginId: 'alice', password: 'Abc12345' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.user.id).toBe(5);
    const clear = mockPool.query.mock.calls.find(c => /failed_login_attempts = 0/.test(c[0]));
    expect(clear).toBeTruthy();
  });

  test('GET /session 回显登录用户', async () => {
    const res = await request(createApp()).get('/api/auth/session');
    expect(res.status).toBe(200);
    expect(res.body.loggedIn).toBe(true);
    expect(res.body.user.id).toBe(7);
  });

  test('POST /logout 销毁会话并清 cookie', async () => {
    const res = await request(createApp()).post('/api/auth/logout');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('GET /preview 空 loginId 不查库', async () => {
    const res = await request(createApp()).get('/api/auth/preview');
    expect(res.status).toBe(200);
    expect(res.body.avatarUrl).toBeNull();
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  test('POST /register 激活码注册成功', async () => {
    mockActivation.validateAndConsume.mockImplementation(async (code, username, hook) => {
      await hook();
      return { ok: true, code };
    });
    mockQueryBySql([
      [/SELECT id FROM users WHERE LOWER/, [[]]],
      [/INSERT INTO users/, [{ insertId: 11 }]],
      [/INSERT IGNORE INTO user_group_membership/, [{}]],
      [/INSERT INTO sys_oper_log/, [{}]]
    ]);
    const res = await request(createApp())
      .post('/api/auth/register')
      .send({ username: 'newbie', password: 'Abc12345', activationCode: 'ABC-123' });
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(11);
    expect(mockActivation.validateAndConsume).toHaveBeenCalled();
  });

  test('POST /register 用户名重复不消耗激活码', async () => {
    mockQueryBySql([[/(SELECT id FROM users|LOWER)/, [[{ id: 1 }]]]]);
    const res = await request(createApp())
      .post('/api/auth/register')
      .send({ username: 'taken', password: 'Abc12345', activationCode: 'ABC-123' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(mockActivation.validateAndConsume).not.toHaveBeenCalled();
  });

  test('POST /init 创建首个超管', async () => {
    mockQueryBySql([
      [/\bCOUNT\(\*\) as cnt\b/, [[{ cnt: 0 }]]],
      [/INSERT INTO users/, [{ insertId: 1 }]],
      [/INSERT INTO sys_oper_log/, [{}]]
    ]);
    const res = await request(createApp())
      .post('/api/auth/init')
      .send({ loginId: 'root', password: 'Abc12345', displayName: 'Root' });
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(1);
    expect(res.body.success).toBe(true);
  });
});

// ─────────────────────────── auth_reset_service ───────────────────────────
describe('P2-148 auth_reset_service 找回码生命周期', () => {
  function extractCodeFromMail() {
    const html = mockMailer.sendEmail.mock.calls[0][2];
    // AUTH-3：OTP 已提升为 8 位数字
    const m = /(\d{8})/.exec(html);
    return m[1];
  }

  test('forgot-password 未知邮箱与存在邮箱响应不可区分（P2-125）', async () => {
    mockQueryBySql([[/(banned = 0)/, [[]]]]);
    const miss = await request(createApp()).post('/api/auth/forgot-password').send({ email: 'nobody@x.com' });
    expect(miss.status).toBe(200);
    // AUTH-4：未知邮箱同样返回真实随机 token（响应完全对称），仅验证码不存在
    expect(miss.body.token).toMatch(/^[0-9a-f]{64}$/);

    mockQueryBySql([[/(banned = 0)/, [[{ id: 9, display_name: 'D', login_id: 'd' }]]]]);
    const hit = await request(createApp()).post('/api/auth/forgot-password').send({ email: 'd@x.com' });
    expect(hit.status).toBe(200);
    expect(hit.body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(mockMailer.sendEmail).toHaveBeenCalled();
    expect(extractCodeFromMail()).toMatch(/^\d{8}$/);
  });

  test('forgot-password 缺 email 400', async () => {
    const res = await request(createApp()).post('/api/auth/forgot-password').send({});
    expect(res.status).toBe(400);
  });

  test('verify-reset-code 正确码通过 / 错码 5 次作废', async () => {
    mockQueryBySql([[/(banned = 0)/, [[{ id: 9, display_name: 'D', login_id: 'd' }]]]]);
    const { body } = await request(createApp()).post('/api/auth/forgot-password').send({ email: 'd@x.com' });
    const token = body.token;
    const code = extractCodeFromMail();

    const ok = await request(createApp()).post('/api/auth/verify-reset-code').send({ token, code });
    expect(ok.status).toBe(200);
    expect(ok.body.message).toBe('验证通过');

    // 新建 token 连续错 6 次 → 第 6 次起过期
    const { body: b2 } = await request(createApp()).post('/api/auth/forgot-password').send({ email: 'd@x.com' });
    const t2 = b2.token;
    for (let i = 1; i <= 5; i++) {
      const r = await request(createApp()).post('/api/auth/verify-reset-code').send({ token: t2, code: '000000' });
      expect(r.status).toBe(400);
      expect(r.body.error.message).toContain('验证码错误');
    }
    const r6 = await request(createApp()).post('/api/auth/verify-reset-code').send({ token: t2, code: '000000' });
    expect(r6.status).toBe(400);
    expect(r6.body.error).toContain('过期');
  });

  test('reset-password 完整链路：改密+清会话', async () => {
    mockQueryBySql([[/(banned = 0)/, [[{ id: 9, display_name: 'D', login_id: 'd' }]]]]);
    const { body } = await request(createApp()).post('/api/auth/forgot-password').send({ email: 'd@x.com' });
    const token = body.token;
    const code = extractCodeFromMail();

    mockQueryBySql([
      [/UPDATE users SET password_hash/, [{}]],
      [/DELETE FROM sessions/, [{}]],
      [/INSERT INTO sys_oper_log/, [{}]]
    ]);
    const res = await request(createApp())
      .post('/api/auth/reset-password')
      .send({ token, code, newPassword: 'Abc12345' });
    expect(res.status).toBe(200);
    expect(res.body.message).toContain('重置成功');
    const upd = mockPool.query.mock.calls.find(c => /UPDATE users SET password_hash/.test(c[0]));
    expect(upd[1][0]).not.toBe('Abc12345'); // 必须已是哈希
    expect(mockPool.query.mock.calls.some(c => /DELETE FROM sessions/.test(c[0]) && c[1][0] === '9')).toBe(true);
  });

  test('reset-password 弱密码拒绝', async () => {
    mockQueryBySql([[/(banned = 0)/, [[{ id: 9, display_name: 'D', login_id: 'd' }]]]]);
    const { body } = await request(createApp()).post('/api/auth/forgot-password').send({ email: 'd@x.com' });
    const res = await request(createApp())
      .post('/api/auth/reset-password')
      .send({ token: body.token, code: extractCodeFromMail(), newPassword: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('密码强度不足');
  });
});

// ─────────────────────────── auth_vrc_service ───────────────────────────
describe('P2-148 auth_vrc_service 2FA', () => {
  test('verifyVrc2fa OTP 验证码规范化 12341234 → 1234-1234', async () => {
    vrchatVerifyTwoFactor.mockResolvedValue({ status: 200, data: { verified: true }, cookie: 'c2' });
    vrchatGetCurrentUserResult.mockResolvedValue({ status: 200, data: { id: 'usr_1', displayName: 'V' } });
    const r = await verifyVrc2fa('12341234', 'otp', 'auth=x');
    expect(vrchatVerifyTwoFactor).toHaveBeenCalledWith('otp', '1234-1234', 'auth=x');
    expect(r.success).toBe(true);
    expect(r.cookie).toBe('c2');
    expect(r.user.id).toBe('usr_1');
    expect(vrchatGetCurrentUserResult).toHaveBeenCalledWith('c2');
  });

  test('verifyVrc2fa 上游未验证 → success:false', async () => {
    vrchatVerifyTwoFactor.mockResolvedValue({ status: 200, data: { verified: false, error: { message: 'bad code' } }, cookie: 'c2' });
    const r = await verifyVrc2fa('123456', 'totp', 'auth=x');
    expect(r.success).toBe(false);
    expect(r.error).toBe('bad code');
  });

  test('verifyVrc2fa 上游非 200 → 默认错误文案', async () => {
    vrchatVerifyTwoFactor.mockResolvedValue({ status: 401, data: {} });
    const r = await verifyVrc2fa('123456', 'totp', 'auth=x');
    expect(r.success).toBe(false);
    expect(r.error).toBe('验证码错误');
  });

  test('verifyVrc2fa refreshUser=false 不拉取当前用户', async () => {
    vrchatVerifyTwoFactor.mockResolvedValue({ status: 200, data: { verified: true }, cookie: 'c2' });
    const r = await verifyVrc2fa('123456', 'totp', 'auth=x', { refreshUser: false });
    expect(r.success).toBe(true);
    expect(vrchatGetCurrentUserResult).not.toHaveBeenCalled();
  });

  test('verifyVrc2fa 用户信息获取失败置 userError', async () => {
    vrchatVerifyTwoFactor.mockResolvedValue({ status: 200, data: { verified: true }, cookie: 'c2' });
    vrchatGetCurrentUserResult.mockResolvedValue({ status: 500, data: {} });
    const r = await verifyVrc2fa('123456', 'totp', 'auth=x');
    expect(r.success).toBe(true);
    expect(r.userError).toBe('VRChat 未返回账号信息');
  });

  test('/vrchat-login 第二段 loginToken 无效 → 会话过期', async () => {
    const res = await request(createApp())
      .post('/api/auth/vrchat-login')
      .send({ loginToken: 'nope', code: '123456', method: 'totp' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('过期');
  });

  // P3-70: 2FA 验证码失败次数逐 token 累计，≥5 删除会话（后续同 token 一律过期）并触发安全告警
  test('2FA 验证码失败累计 5 次后会话锁定（429 2FA_LOCKED）且同一 token 作废', async () => {
    vrchatBasicLogin.mockResolvedValue({
      status: 200,
      data: { id: 'usr_1', displayName: 'V', requiresTwoFactorAuth: ['totp'], currentAvatarThumbnailImageUrl: '' },
      cookie: 'auth=x',
      needs2fa: true
    });
    mockQueryBySql([[/SELECT \* FROM users WHERE vrchat_id/, [[{ id: 7, vrchat_name: 'V', login_id: 't', display_name: 'T', locked_until: null, approved: 1, vrchat_avatar_url: '' }]]]]);
    vrchatVerifyTwoFactor.mockResolvedValue({ status: 200, data: { verified: false, error: { message: 'bad code' } }, cookie: 'c2' });
    vrchatGetCurrentUserResult.mockResolvedValue({ status: 200, data: {} });

    const app = createApp();
    const step1 = await request(app).post('/api/auth/vrchat-login').send({ username: 'u', password: 'p' });
    expect(step1.status).toBe(200);
    expect(step1.body.need2fa).toBe(true);
    const token = step1.body.loginToken;
    expect(token).toBeTruthy();

    for (let i = 1; i <= 4; i++) {
      const r = await request(app).post('/api/auth/vrchat-login').send({ loginToken: token, code: '000000', method: 'totp' });
      expect(r.status).toBe(401);
      expect(r.body.remaining).toBe(5 - i);
    }
    const r5 = await request(app).post('/api/auth/vrchat-login').send({ loginToken: token, code: '000000', method: 'totp' });
    expect(r5.status).toBe(429);
    expect(r5.body.code).toBe('2FA_LOCKED');
    expect(mockLogger.warn).toHaveBeenCalled();

    // 会话已删除：同一 token 再提交 → 视为过期
    const r6 = await request(app).post('/api/auth/vrchat-login').send({ loginToken: token, code: '000000', method: 'totp' });
    expect(r6.status).toBe(400);
    expect(r6.body.error).toContain('过期');
  });
});