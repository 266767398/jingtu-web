/**
 * 关注系统路由集成测试（V7.10）
 * 覆盖 docs/10 §6 的契约：关注/取关幂等、防自关、错误码、状态与计数。
 */
const request = require('supertest');
const express = require('express');

const mockPool = { query: jest.fn(), getConnection: jest.fn() };

jest.mock('../utils', () => {
  const actual = jest.requireActual('../utils');
  return {
    ...actual,
    getPool: jest.fn(() => mockPool),
    sendError: jest.fn((res, status, code, message) => res.status(status).json({ success: false, error: { code, message } })),
    handleError: jest.fn((res, e) => res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: e.message } })),
    getAvatarUrl: jest.fn(() => '/api/avatar/default'),
    ErrorCodes: actual.ErrorCodes
  };
});
jest.mock('../auth', () => ({
  requireAuth: (req, res, next) => next(),
  requireRole: () => (req, res, next) => next()
}));

const followsRouter = require('../routes/follows');
const notificationService = { notifyUser: jest.fn(() => Promise.resolve()) };
const ME = 1;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.session = { userId: ME }; next(); });
  app.use('/api/follows', followsRouter(notificationService));
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPool.query.mockReset();
});

function expectCode(res, code) {
  expect(res.body.success).toBe(false);
  expect(res.body.error.code).toBe(code);
}

describe('关注 POST /api/follows', () => {
  test('不能关注自己 → SELF_FOLLOW(400)', async () => {
    const res = await request(buildApp()).post('/api/follows').send({ targetUserId: ME });
    expect(res.status).toBe(400);
    expectCode(res, 'SELF_FOLLOW');
  });

  test('目标不存在 → NOT_FOUND(404)', async () => {
    mockPool.query.mockResolvedValueOnce([[]]); // userExists
    const res = await request(buildApp()).post('/api/follows').send({ targetUserId: 999 });
    expect(res.status).toBe(404);
    expectCode(res, 'NOT_FOUND');
  });

  test('正常关注 → following:true 并通知', async () => {
    mockPool.query
      .mockResolvedValueOnce([[{ id: 2 }]])                          // userExists
      .mockResolvedValueOnce([[]])                                  // existing check
      .mockResolvedValueOnce([[]])                                  // blockRel check
      .mockResolvedValueOnce([{ insertId: 1, affectedRows: 1 }])    // insert
      .mockResolvedValueOnce([[{ display_name: 'Me' }]]);           // notify name
    const res = await request(buildApp()).post('/api/follows').send({ targetUserId: 2 });
    expect(res.status).toBe(200);
    expect(res.body.following).toBe(true);
    expect(notificationService.notifyUser).toHaveBeenCalledWith(
      2, 'follow', '新的关注', expect.any(String), { targetType: 'user', targetId: ME }
    );
  });

  test('已关注 → 幂等返回成功（不重复插入、不通知）', async () => {
    mockPool.query
      .mockResolvedValueOnce([[{ id: 2 }]])   // userExists
      .mockResolvedValueOnce([[{ 1: 1 }]]);   // existing 命中
    const res = await request(buildApp()).post('/api/follows').send({ targetUserId: 2 });
    expect(res.status).toBe(200);
    expect(res.body.following).toBe(true);
    expect(mockPool.query).toHaveBeenCalledTimes(2);
    expect(notificationService.notifyUser).not.toHaveBeenCalled();
  });
});

describe('取消关注 DELETE /api/follows/:targetUserId', () => {
  test('正常取关 → following:false', async () => {
    mockPool.query.mockResolvedValueOnce([{ affectedRows: 1 }]);
    const res = await request(buildApp()).delete('/api/follows/2');
    expect(res.status).toBe(200);
    expect(res.body.following).toBe(false);
  });

  test('未关注 → NOT_FOLLOWING(404)', async () => {
    mockPool.query.mockResolvedValueOnce([{ affectedRows: 0 }]);
    const res = await request(buildApp()).delete('/api/follows/2');
    expect(res.status).toBe(404);
    expectCode(res, 'NOT_FOLLOWING');
  });
});

describe('列表 / 状态 / 计数', () => {
  test('GET /following 分页', async () => {
    mockPool.query
      .mockResolvedValueOnce([[{ total: 1 }]])  // count
      .mockResolvedValueOnce([[ // rows
        { id: 2, display_name: 'Bob', vrchat_name: 'b', avatar_type: 'none', custom_avatar_path: null, vrchat_avatar_url: null, followedAt: '2026-01-01' }
      ]]);
    const res = await request(buildApp()).get('/api/follows/following');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.list[0].displayName).toBe('Bob');
  });

  test('GET /followers 分页', async () => {
    mockPool.query
      .mockResolvedValueOnce([[{ total: 0 }]])
      .mockResolvedValueOnce([[]]);
    const res = await request(buildApp()).get('/api/follows/followers');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });

  test('GET /status/:userId', async () => {
    mockPool.query
      .mockResolvedValueOnce([[]])   // following?
      .mockResolvedValueOnce([[]]);  // followedBy?
    const res = await request(buildApp()).get('/api/follows/status/2');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ following: false, followedBy: false });
  });

  test('GET /counts/:userId', async () => {
    mockPool.query
      .mockResolvedValueOnce([[{ following: 5 }]])
      .mockResolvedValueOnce([[{ followers: 3 }]]);
    const res = await request(buildApp()).get('/api/follows/counts/2');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ following: 5, followers: 3 });
  });
});
