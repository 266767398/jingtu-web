// S-6: TOTP 两步验证 + login_history 审计测试
// totp.js（RFC6238 单元）+ auth_local_service 登录分步 2FA + 管理 API
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
const totp = require('../totp');
const authRouter = require('../routes/auth');

function mockQueryBySql(routes) {
  mockPool.query.mockImplementation((sql, params) => {
    for (const [pattern, result] of routes) {
      if (pattern.test(sql)) return Promise.resolve(result);
    }
    return Promise.resolve([[]]);
  });
}

function sessionFactory(extra) {
  const s = {
    userId: undefined,
    loginId: undefined,
    role: undefined,
    regenerate(cb) { cb(null); },
    save() { return Promise.resolve(); },
    destroy(cb) { cb(null); }
  };
  return Object.assign(s, extra || {});
}

function createApp(sessionExtra) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.session = sessionFactory(sessionExtra); next(); });
  app.use('/api/auth', authRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockActivation.validateAndConsume.mockReset();
  mockQueryBySql([]);
});

// ─────────────────────────── totp.js（RFC6238） ───────────────────────────
describe('S-6 totp.js RFC6238 工具', () => {
  test('hotp 匹配 RFC4226 SHA1 官方测试向量（counter 0/1）', () => {
    // secret = "12345678901234567890" → base32 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    expect(totp.hotp(secret, 0)).toBe('755224');
    expect(totp.hotp(secret, 1)).toBe('287082');
  });

  test('generateSecret 输出 32 位 base32 密钥；generateTotp/verifyTotp 往返', () => {
    const secret = totp.generateSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    const code = totp.generateTotp(secret);
    expect(code).toMatch(/^\d{6}$/);
    expect(totp.verifyTotp(secret, code)).toBe(true);
    expect(totp.verifyTotp(secret, '000000')).toBe(false);
  });

  test('verifyTotp 拒绝非 6 位数字输入', () => {
    expect(totp.verifyTotp(totp.generateSecret(), 'abc123')).toBe(false);
    expect(totp.verifyTotp(totp.generateSecret(), '123')).toBe(false);
  });

  test('otpauthUri 生成标准 otpauth 链接', () => {
    const uri = totp.otpauthUri('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 'alice', 'JingTu');
    expect(uri).toMatch(/^otpauth:\/\/totp\/JingTu:alice\?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ/);
    expect(uri).toContain('algorithm=SHA1&digits=6&period=30');
  });
});

// ─────────────────────────── 登录分步 2FA ───────────────────────────
describe('S-6 登录分步 2FA（/login → /2fa/verify）', () => {
  let realHash;
  beforeAll(async () => { realHash = await auth.hashPassword('Abc12345'); });

  function userRow(extra) {
    return Object.assign({
      id: 7, login_id: 'tester', display_name: 'Tester', password_hash: realHash,
      role: 'super_admin', approved: 1, banned: 0, deleted_at: null,
      locked_until: null, failed_login_attempts: 0,
      totp_secret: null, totp_enabled: 0
    }, extra || {});
  }

  test('/login 开启 2FA 的账号：密码通过 → need2fa + userId，不建会话', async () => {
    const secret = totp.generateSecret();
    mockQueryBySql([[/SELECT \* FROM users/, [[userRow({ totp_secret: secret, totp_enabled: 1 })]]]]);
    const app = createApp();
    const res = await request(app).post('/api/auth/login').send({ loginId: 'tester', password: 'Abc12345' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.need2fa).toBe(true);
    expect(res.body.code).toBe('2FA_REQUIRED');
    expect(res.body.userId).toBe(7);
    // 未建会话
    expect(res.body.user).toBeUndefined();
    // 写审计：等待两步验证（success=0）
    const historyInsert = mockPool.query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO login_history'));
    expect(historyInsert.length).toBe(1);
    expect(historyInsert[0][1][3]).toBe(0);
  });

  test('/2fa/verify 无密码阶段会话标记 → 拒绝（防绕过密码爆破）', async () => {
    const app = createApp(); // session 无 pending2faUserId
    const res = await request(app).post('/api/auth/2fa/verify').send({ userId: 7, code: '123456' });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe('2FA_STEP_REQUIRED');
  });

  test('/2fa/verify 验证码错误：不建会话 + 递增计数 + 审计失败', async () => {
    const secret = totp.generateSecret();
    mockQueryBySql([
      [/SELECT \* FROM users/, [[userRow({ totp_secret: secret, totp_enabled: 1 })]]],
      [/SELECT failed_login_attempts/, [[{ failed_login_attempts: 1 }]]]
    ]);
    const app = createApp({ pending2faUserId: 7 });
    const res = await request(app).post('/api/auth/2fa/verify').send({ userId: 7, code: '000000' });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe('2FA_CODE_WRONG');
    expect(res.body.user).toBeUndefined();
    const history = mockPool.query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO login_history'));
    expect(history.length).toBe(1);
    expect(history[0][1][3]).toBe(0);
  });

  test('/2fa/verify 验证码错误 5 次 → 锁定 15 分钟', async () => {
    const secret = totp.generateSecret();
    mockQueryBySql([
      [/SELECT \* FROM users/, [[userRow({ totp_secret: secret, totp_enabled: 1 })]]],
      [/SELECT failed_login_attempts/, [[{ failed_login_attempts: 5 }]]]
    ]);
    const app = createApp({ pending2faUserId: 7 });
    const res = await request(app).post('/api/auth/2fa/verify').send({ userId: 7, code: '000000' });
    expect(res.body.code).toBe('ACCOUNT_LOCKED');
    expect(res.body.lockMinutes).toBe(15);
    expect(mockPool.query.mock.calls.some(([sql]) => String(sql).includes('locked_until = DATE_ADD'))).toBe(true);
  });

  test('/2fa/verify 验证码正确：建会话 + 清计数 + 审计成功', async () => {
    const secret = totp.generateSecret();
    const code = totp.generateTotp(secret);
    mockQueryBySql([
      [/SELECT \* FROM users/, [[userRow({ totp_secret: secret, totp_enabled: 1 })]]]
    ]);
    const app = createApp({ pending2faUserId: 7 });
    const res = await request(app).post('/api/auth/2fa/verify').send({ userId: 7, code });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.user.id).toBe(7);
    const history = mockPool.query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO login_history'));
    expect(history.length).toBe(1);
    expect(history[0][1][3]).toBe(1);
  });
});

// ─────────────────────────── TOTP 管理 API（仅超管） ───────────────────────────
describe('S-6 TOTP 设置 API（requireSuperAdmin）', () => {
  function superAdminSession() {
    return { userId: 7, loginId: 'tester', role: 'super_admin', pending2faUserId: undefined };
  }

  test('GET /totp/status 返回开关状态', async () => {
    mockQueryBySql([
      [/SELECT role FROM users/, [[{ role: 'super_admin' }]]],
      [/SELECT totp_enabled FROM users/, [[{ totp_enabled: 1 }]]]
    ]);
    const res = await request(createApp(superAdminSession())).get('/api/auth/totp/status');
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
  });

  test('POST /totp/setup 生成密钥并写入（totp_enabled 归零）', async () => {
    mockQueryBySql([
      [/SELECT role FROM users/, [[{ role: 'super_admin' }]]]
    ]);
    const res = await request(createApp(superAdminSession())).post('/api/auth/totp/setup').send({});
    expect(res.status).toBe(200);
    expect(res.body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(res.body.otpauthUri).toContain('otpauth://totp/');
    expect(mockPool.query.mock.calls.some(([sql]) => String(sql).includes('UPDATE users SET totp_secret'))).toBe(true);
  });

  test('POST /totp/confirm 用验证码确认后启用', async () => {
    const secret = totp.generateSecret();
    const code = totp.generateTotp(secret);
    mockQueryBySql([
      [/SELECT role FROM users/, [[{ role: 'super_admin' }]]],
      [/SELECT totp_secret FROM users/, [[{ totp_secret: secret }]]]
    ]);
    const res = await request(createApp(superAdminSession())).post('/api/auth/totp/confirm').send({ code });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockPool.query.mock.calls.some(([sql]) => String(sql).includes('UPDATE users SET totp_enabled = 1'))).toBe(true);
  });

  test('POST /totp/confirm 错误验证码拒绝', async () => {
    mockQueryBySql([
      [/SELECT role FROM users/, [[{ role: 'super_admin' }]]],
      [/SELECT totp_secret FROM users/, [[{ totp_secret: totp.generateSecret() }]]]
    ]);
    const res = await request(createApp(superAdminSession())).post('/api/auth/totp/confirm').send({ code: '123456' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('2FA_CODE_WRONG');
  });

  test('POST /totp/disable 需当前密码复核', async () => {
    const realHash = await auth.hashPassword('Abc12345');
    mockQueryBySql([
      [/SELECT role FROM users/, [[{ role: 'super_admin' }]]],
      [/SELECT password_hash FROM users/, [[{ password_hash: realHash }]]]
    ]);
    // 错误密码
    const bad = await request(createApp(superAdminSession())).post('/api/auth/totp/disable').send({ password: 'wrong' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('PASSWORD_WRONG');
    // 正确密码
    const okRes = await request(createApp(superAdminSession())).post('/api/auth/totp/disable').send({ password: 'Abc12345' });
    expect(okRes.status).toBe(200);
    expect(okRes.body.success).toBe(true);
    expect(mockPool.query.mock.calls.some(([sql]) => String(sql).includes("totp_secret = NULL"))).toBe(true);
  });

  test('非超管访问 TOTP 设置 → 403', async () => {
    mockQueryBySql([
      [/SELECT role FROM users/, [[{ role: 'admin' }]]]
    ]);
    const app = createApp({ userId: 7, loginId: 'tester', role: 'admin', pending2faUserId: undefined });
    const res = await request(app).post('/api/auth/totp/setup').send({});
    expect(res.status).toBe(403);
  });
});
