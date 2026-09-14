const express = require('express');
const request = require('supertest');

const mockPool = {
  query: jest.fn(),
  getConnection: jest.fn()
};

const errorCodes = {
  BAD_REQUEST: 'BAD_REQUEST',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  SELF_FRIEND: 'SELF_FRIEND',
  FRIEND_NOT_FOUND: 'FRIEND_NOT_FOUND',
  SELF_FOLLOW: 'SELF_FOLLOW',
  NOT_FOLLOWING: 'NOT_FOLLOWING',
  ALREADY_BLOCKED: 'ALREADY_BLOCKED',
  ALREADY_FOLLOWING: 'ALREADY_FOLLOWING',
  BLOCKED: 'BLOCKED'
};

jest.mock('../auth', () => ({
  requireAuth(req, res, next) {
    req.session = { userId: 1 };
    next();
  }
}));

jest.mock('../utils', () => ({
  getPool: () => mockPool,
  getAvatarUrl: () => null,
  ErrorCodes: errorCodes,
  ok(res, fields) {
    return res.json(fields ? { success: true, ...fields } : { success: true });
  },
  // P2-70 分页收口后 routes/friends.js 与 routes/follows.js 解构 paginate；
  // 手写 mock 工厂必须同步补名，否则命中分页的处理器一调用即 TypeError→500。
  // 实现与 utils.js 的 paginate 保持一致（page≥1、pageSize 受 defaultSize/maxSize 钳制）。
  paginate(req, opts = {}) {
    const { sizeParam = 'pageSize', defaultSize = 20, maxSize = Infinity, minSize = 1, fixedSize } = opts;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = fixedSize !== undefined
      ? fixedSize
      : Math.min(maxSize, Math.max(minSize, parseInt(req.query[sizeParam], 10) || defaultSize));
    return { page, pageSize, offset: (page - 1) * pageSize };
  },
  sendError(res, status, code, message) {
    return res.status(status).json({ success: false, error: { code, message } });
  },
  handleError(res, error) {
    return res.status(500).json({ error: error.message });
  }
}));

const createFriendsRouter = require('../routes/friends');
const createFollowsRouter = require('../routes/follows');

function appFor(path, router) {
  const app = express();
  app.use(express.json());
  app.use(path, router);
  return app;
}

describe('friends routes', () => {
  beforeEach(() => jest.clearAllMocks());

  test('rejects adding yourself without querying the database', async () => {
    const app = appFor('/api/friends', createFriendsRouter());
    const response = await request(app).post('/api/friends/request').send({ targetUserId: 1 });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('SELF_FRIEND');
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  test('does not let another user respond to an incoming request', async () => {
    mockPool.query.mockResolvedValueOnce([[{ id: 8, user_id: 3, friend_id: 2 }]]);
    const app = appFor('/api/friends', createFriendsRouter());
    const response = await request(app)
      .post('/api/friends/respond')
      .send({ requestId: 8, action: 'accept' });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
    expect(mockPool.getConnection).not.toHaveBeenCalled();
  });

  test('returns requestId for both incoming and outgoing requests', async () => {
    const incoming = [{ id: 2, display_name: 'A', requestId: 11, requestedAt: '2026-08-20' }];
    const outgoing = [{ id: 3, display_name: 'B', requestId: 12, requestedAt: '2026-08-20' }];
    mockPool.query
      .mockResolvedValueOnce([incoming])
      .mockResolvedValueOnce([outgoing]);
    const app = appFor('/api/friends', createFriendsRouter());
    const response = await request(app).get('/api/friends/requests');
    expect(response.status).toBe(200);
    expect(response.body.incoming[0].requestId).toBe(11);
    expect(response.body.outgoing[0].requestId).toBe(12);
  });

  test('blocking removes follows in the same transaction', async () => {
    const connection = {
      beginTransaction: jest.fn().mockResolvedValue(),
      query: jest.fn().mockResolvedValue([{ affectedRows: 1 }]),
      commit: jest.fn().mockResolvedValue(),
      rollback: jest.fn().mockResolvedValue(),
      release: jest.fn()
    };
    mockPool.query
      .mockResolvedValueOnce([[{ id: 2 }]])   // userExists
      .mockResolvedValueOnce([[]]);           // existing blocked → 未拉黑
    mockPool.getConnection.mockResolvedValue(connection);

    const response = await request(appFor('/api/friends', createFriendsRouter()))
      .post('/api/friends/block')
      .send({ targetUserId: 2 });

    expect(response.status).toBe(200);
    expect(connection.query.mock.calls.some(call => /DELETE FROM user_follows/.test(call[0]))).toBe(true);
    expect(connection.commit).toHaveBeenCalled();
    expect(connection.rollback).not.toHaveBeenCalled();
  });
});

describe('follows routes', () => {
  beforeEach(() => jest.clearAllMocks());

  test('rejects following yourself without querying the database', async () => {
    const app = appFor('/api/follows', createFollowsRouter());
    const response = await request(app).post('/api/follows').send({ targetUserId: 1 });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('SELF_FOLLOW');
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  test('following an existing target is idempotent and does not duplicate notifications', async () => {
    const notifications = { notifyUser: jest.fn() };
    mockPool.query
      .mockResolvedValueOnce([[{ id: 2 }]])   // userExists
      .mockResolvedValueOnce([[{ 1: 1 }]]);    // existing 命中 → 已关注
    const app = appFor('/api/follows', createFollowsRouter(notifications));
    const response = await request(app).post('/api/follows').send({ targetUserId: 2 });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, ok: true, following: true });
    expect(notifications.notifyUser).not.toHaveBeenCalled();
  });

  test('does not allow either side of a block to create a follow', async () => {
    mockPool.query
      .mockResolvedValueOnce([[{ id: 2 }]])   // userExists
      .mockResolvedValueOnce([[]])            // existing → 未关注
      .mockResolvedValueOnce([[{ blocked: 1 }]]); // block 双向命中
    const response = await request(appFor('/api/follows', createFollowsRouter()))
      .post('/api/follows')
      .send({ targetUserId: 2 });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('BLOCKED');
    expect(mockPool.query).toHaveBeenCalledTimes(3);
  });
});
