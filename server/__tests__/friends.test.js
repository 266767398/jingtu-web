/**
 * 好友系统路由集成测试（V7.10）
 * 通过 jest.mock 替身 ../utils(getPool) 与 ../auth(requireAuth)，用 supertest 驱动真实 router，
 * 覆盖 docs/10 §3 的状态机与错误码契约（申请/接受/拒绝/删除/拉黑/状态）。
 */
const request = require('supertest');
const express = require('express');

// 替身连接池：query 按调用顺序出队；事务走 conn（独立 mock）
const mockConn = {
  beginTransaction: jest.fn(() => Promise.resolve()),
  commit: jest.fn(() => Promise.resolve()),
  rollback: jest.fn(() => Promise.resolve()),
  release: jest.fn(() => Promise.resolve()),
  query: jest.fn()
};
const mockPool = {
  query: jest.fn(),
  getConnection: jest.fn(() => mockConn)
};

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

const friendsRouter = require('../routes/friends');
const notificationService = { notifyUser: jest.fn(() => Promise.resolve()) };

const ME = 1;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.session = { userId: ME }; next(); });
  app.use('/api/friends', friendsRouter(notificationService));
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPool.query.mockReset();
  mockConn.query.mockReset();
});

// 辅助：断言错误码
function expectCode(res, code) {
  expect(res.body.success).toBe(false);
  expect(res.body.error.code).toBe(code);
}

describe('好友申请 POST /api/friends/request', () => {
  test('不能添加自己为好友 → SELF_FRIEND(400)', async () => {
    const res = await request(buildApp()).post('/api/friends/request').send({ targetUserId: ME });
    expect(res.status).toBe(400);
    expectCode(res, 'SELF_FRIEND');
  });

  test('目标不存在 → NOT_FOUND(404)', async () => {
    mockPool.query.mockResolvedValueOnce([[]]); // userExists
    const res = await request(buildApp()).post('/api/friends/request').send({ targetUserId: 999 });
    expect(res.status).toBe(404);
    expectCode(res, 'NOT_FOUND');
  });

  test('正常申请 → pending 并通知', async () => {
    mockPool.query
      .mockResolvedValueOnce([[{ id: 2 }]])          // userExists
      .mockResolvedValueOnce([[{ display_name: 'Me' }]]);        // notify name
    mockConn.query
      .mockResolvedValueOnce([[]])                    // blockedByThem
      .mockResolvedValueOnce([[]])                    // mine
      .mockResolvedValueOnce([[]])                    // incoming
      .mockResolvedValueOnce([{ insertId: 7, affectedRows: 1 }]); // insert pending
    const res = await request(buildApp()).post('/api/friends/request').send({ targetUserId: 2 });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');
    expect(notificationService.notifyUser).toHaveBeenCalledWith(
      2, 'friend_request', '新的好友请求', expect.any(String), { targetType: 'user', targetId: ME }
    );
  });

  test('对方已申请我 → 我的申请即接受（auto-accept）', async () => {
    mockPool.query
      .mockResolvedValueOnce([[{ id: 2 }]])          // userExists
      .mockResolvedValueOnce([[{ display_name: 'Me' }]]);   // notify name
    mockConn.query
      .mockResolvedValueOnce([[]])                    // blockedByThem
      .mockResolvedValueOnce([[]])                    // mine
      .mockResolvedValueOnce([[{ id: 10, requester: 2 }]]) // incoming pending
      .mockResolvedValueOnce([{ affectedRows: 1 }])   // UPDATE → accepted
      .mockResolvedValueOnce([{ insertId: 11, affectedRows: 1 }]); // INSERT IGNORE 对称行
    const res = await request(buildApp()).post('/api/friends/request').send({ targetUserId: 2 });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('accepted');
    expect(mockConn.query).toHaveBeenCalledTimes(5);
    expect(notificationService.notifyUser).toHaveBeenCalledWith(
      2, 'friend_accepted', '好友请求已通过', expect.any(String), { targetType: 'user', targetId: ME }
    );
  });

  test('已是好友 → ALREADY_FRIENDS(409)', async () => {
    mockPool.query
      .mockResolvedValueOnce([[{ id: 2 }]]);          // userExists
    mockConn.query
      .mockResolvedValueOnce([[]])                    // blockedByThem
      .mockResolvedValueOnce([[{ status: 'accepted' }]]);     // mine
    const res = await request(buildApp()).post('/api/friends/request').send({ targetUserId: 2 });
    expect(res.status).toBe(409);
    expectCode(res, 'ALREADY_FRIENDS');
  });

  test('已被对方拉黑 → BLOCKED(403)', async () => {
    mockPool.query
      .mockResolvedValueOnce([[{ id: 2 }]]);   // userExists
    mockConn.query
      .mockResolvedValueOnce([[{ 1: 1 }]]);    // blockedByThem -> 命中
    const res = await request(buildApp()).post('/api/friends/request').send({ targetUserId: 2 });
    expect(res.status).toBe(403);
    expectCode(res, 'BLOCKED');
  });
});

describe('好友响应 POST /api/friends/respond', () => {
  test('接受 → 双向 accepted + 通知', async () => {
    mockPool.query
      .mockResolvedValueOnce([[{ id: 10, user_id: 2, friend_id: ME, status: 'pending' }]]) // SELECT *
      .mockResolvedValueOnce([[{ display_name: 'Me' }]]);                                  // notify name
    mockConn.query
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ insertId: 11, affectedRows: 1 }]);
    const res = await request(buildApp()).post('/api/friends/respond').send({ requestId: 10, action: 'accept' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('accepted');
    expect(mockConn.query).toHaveBeenCalledTimes(2);
    expect(notificationService.notifyUser).toHaveBeenCalledWith(
      2, 'friend_accepted', '好友请求已通过', expect.any(String), { targetType: 'user', targetId: ME }
    );
  });

  test('拒绝 → 删除申请', async () => {
    mockPool.query
      .mockResolvedValueOnce([[{ id: 10, user_id: 2, friend_id: ME, status: 'pending' }]]) // SELECT *
      .mockResolvedValueOnce([{ affectedRows: 1 }]);                                       // DELETE
    const res = await request(buildApp()).post('/api/friends/respond').send({ requestId: 10, action: 'reject' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
  });

  test('处理非自己的申请 → FORBIDDEN(403)', async () => {
    mockPool.query.mockResolvedValueOnce([[{ id: 10, user_id: 2, friend_id: 3, status: 'pending' }]]);
    const res = await request(buildApp()).post('/api/friends/respond').send({ requestId: 10, action: 'accept' });
    expect(res.status).toBe(403);
    expectCode(res, 'FORBIDDEN');
  });

  test('申请不存在 → FRIEND_NOT_FOUND(404)', async () => {
    mockPool.query.mockResolvedValueOnce([[]]);
    const res = await request(buildApp()).post('/api/friends/respond').send({ requestId: 99, action: 'accept' });
    expect(res.status).toBe(404);
    expectCode(res, 'FRIEND_NOT_FOUND');
  });
});

describe('删除好友 DELETE /api/friends/:friendUserId', () => {
  test('双向清除 → ok', async () => {
    mockPool.query.mockResolvedValueOnce([{ affectedRows: 2 }]);
    const res = await request(buildApp()).delete('/api/friends/2');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('关系不存在 → FRIEND_NOT_FOUND(404)', async () => {
    mockPool.query.mockResolvedValueOnce([{ affectedRows: 0 }]);
    const res = await request(buildApp()).delete('/api/friends/2');
    expect(res.status).toBe(404);
    expectCode(res, 'FRIEND_NOT_FOUND');
  });
});

describe('拉黑 / 解除拉黑', () => {
  test('拉黑 → 写入 blocked 并清对称行', async () => {
    mockPool.query
      .mockResolvedValueOnce([[{ id: 2 }]])                              // userExists
      .mockResolvedValueOnce([[]])                                        // 已拉黑检查
      .mockResolvedValueOnce([{ insertId: 12, affectedRows: 1 }])         // upsert block
      .mockResolvedValueOnce([{ affectedRows: 0 }]);                      // DELETE 对称行
    const res = await request(buildApp()).post('/api/friends/block').send({ targetUserId: 2 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('重复拉黑 → ALREADY_BLOCKED(409)', async () => {
    mockPool.query
      .mockResolvedValueOnce([[{ id: 2 }]])              // userExists
      .mockResolvedValueOnce([[{ 1: 1 }]]);              // 已拉黑命中
    const res = await request(buildApp()).post('/api/friends/block').send({ targetUserId: 2 });
    expect(res.status).toBe(409);
    expectCode(res, 'ALREADY_BLOCKED');
  });

  test('解除拉黑 → ok', async () => {
    mockPool.query.mockResolvedValueOnce([{ affectedRows: 1 }]);
    const res = await request(buildApp()).delete('/api/friends/block/2');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('解除未拉黑 → FRIEND_NOT_FOUND(404)', async () => {
    mockPool.query.mockResolvedValueOnce([{ affectedRows: 0 }]);
    const res = await request(buildApp()).delete('/api/friends/block/2');
    expect(res.status).toBe(404);
    expectCode(res, 'FRIEND_NOT_FOUND');
  });
});

describe('关系状态 GET /api/friends/status/:userId', () => {
  test('accepted', async () => {
    mockPool.query
      .mockResolvedValueOnce([[{ status: 'accepted' }]])  // mine
      .mockResolvedValueOnce([[]]);                        // theirs
    const res = await request(buildApp()).get('/api/friends/status/2');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'accepted', direction: null, blockedByThem: false });
  });

  test('outgoing pending', async () => {
    mockPool.query
      .mockResolvedValueOnce([[{ status: 'pending' }]])  // mine
      .mockResolvedValueOnce([[]]);
    const res = await request(buildApp()).get('/api/friends/status/2');
    expect(res.body).toEqual({ status: 'pending', direction: 'out', blockedByThem: false });
  });

  test('incoming pending', async () => {
    mockPool.query
      .mockResolvedValueOnce([[]])                        // mine
      .mockResolvedValueOnce([[{ status: 'pending' }]]);  // theirs
    const res = await request(buildApp()).get('/api/friends/status/2');
    expect(res.body).toEqual({ status: 'pending', direction: 'in', blockedByThem: false });
  });

  test('被对方拉黑', async () => {
    mockPool.query
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[{ status: 'blocked' }]]);
    const res = await request(buildApp()).get('/api/friends/status/2');
    expect(res.body).toEqual({ status: 'blocked', direction: 'in', blockedByThem: true });
  });
});

describe('列表 / 待处理', () => {
  test('GET /api/friends 返回 accepted 列表', async () => {
    mockPool.query
      .mockResolvedValueOnce([[ // list rows
        { id: 2, display_name: 'Bob', vrchat_name: 'bob', avatar_type: 'none', custom_avatar_path: null, vrchat_avatar_url: null, status: 'accepted', since: '2026-01-01', requested_by: 2 }
      ]])
      .mockResolvedValueOnce([[{ total: 1 }]]); // count
    const res = await request(buildApp()).get('/api/friends');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.list[0].displayName).toBe('Bob');
  });

  test('GET /api/friends/requests 返回 incoming/outgoing', async () => {
    mockPool.query
      .mockResolvedValueOnce([[ // incoming
        { id: 2, display_name: 'Bob', vrchat_name: 'b', avatar_type: 'none', custom_avatar_path: null, vrchat_avatar_url: null, requestId: 10, requestedAt: '2026-01-01' }
      ]])
      .mockResolvedValueOnce([[]]); // outgoing
    const res = await request(buildApp()).get('/api/friends/requests');
    expect(res.status).toBe(200);
    expect(res.body.incoming).toHaveLength(1);
    expect(res.body.outgoing).toHaveLength(0);
  });
});
