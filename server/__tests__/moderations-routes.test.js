// 玩家/头像审核路由回归测试（F-18）
// 对齐当前实现：函数工厂 moderations(getVRCCookieUserOnly) -> router、
// getPool().query 直接查询、applyRemoteModeration 返回 remoteResult 序列化、
// POST /:id/revert 撤销远程屏蔽/静音（unblock/unmute）、avatar 类型仅站内处理。
const express = require('express');
const request = require('supertest');

const mockPool = {
  query: jest.fn()
};

jest.mock('../auth', () => ({
  requireAuth(req, res, next) {
    req.session = { userId: 7 };
    next();
  },
  requireRole(role) {
    return (req, res, next) => {
      req.session = { userId: 7, role };
      next();
    };
  }
}));

jest.mock('../utils', () => ({
  getPool: () => mockPool,
  ok(res, fields) {
    return res.json(fields ? { success: true, ...fields } : { success: true });
  },
  sendError(res, status, code, message) {
    return res.status(status).json({ success: false, error: { code, message } });
  },
  logOper: jest.fn().mockResolvedValue(undefined),
  // P2-70 分页收口后 routes/moderations.js 模块加载期即解构 paginate；
  // mock 工厂缺名会导致路由调用 undefined 抛 TypeError 变 500。
  // 以下实现与 utils.js 的 paginate 保持一致（page≥1、pageSize 受 defaultSize/maxSize 钳制）。
  paginate(req, opts = {}) {
    const { sizeParam = 'pageSize', defaultSize = 20, maxSize = Infinity, minSize = 1, fixedSize } = opts;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = fixedSize !== undefined
      ? fixedSize
      : Math.min(maxSize, Math.max(minSize, parseInt(req.query[sizeParam], 10) || defaultSize));
    return { page, pageSize, offset: (page - 1) * pageSize };
  },
  handleError(res, error) {
    const status = error.statusCode || error.status || 500;
    return res.status(status).json({ success: false, error: { code: error.code || 'INTERNAL_ERROR', message: error.message } });
  },
  ErrorCodes: {
    BAD_REQUEST: 'BAD_REQUEST',
    NOT_FOUND: 'NOT_FOUND',
    CONFLICT: 'CONFLICT',
    FORBIDDEN: 'FORBIDDEN',
    INTERNAL_ERROR: 'INTERNAL_ERROR'
  }
}));

// 顶层解构陷阱：路由模块在 require 时已解构 vrc 函数引用，
// 因此必须在 mock 工厂中用 jest.fn() 定义，再通过 require 取同一引用配置行为。
jest.mock('../vrc', () => ({
  vrchatBlockUser: jest.fn(),
  vrchatMuteUser: jest.fn(),
  vrchatUnblockUser: jest.fn(),
  vrchatUnmuteUser: jest.fn()
}));

const moderationsFactory = require('../routes/moderations');
const { vrchatBlockUser, vrchatMuteUser, vrchatUnblockUser, vrchatUnmuteUser } = require('../vrc');

let adminCookie = null;
function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/moderations', moderationsFactory(() => adminCookie));
  return app;
}

// 按 SQL 内容路由 mock 返回，避免依赖 query 调用顺序
function mockQueryBySql(routes) {
  mockPool.query.mockImplementation((sql) => {
    for (const [pattern, result] of routes) {
      if (pattern.test(sql)) return Promise.resolve(result);
    }
    return Promise.resolve([[]]);
  });
}

// mysql2 query 返回 [rows, fields]，故行数据需包一层，路由内 `[rows] = await query(...)` 才能得到数组
const PENDING_PLAYER = [[{ id: 1, target_user_id: 5, target_type: 'player', status: 'pending' }]];
const APPROVED_PLAYER = [[{ id: 1, target_user_id: 5, target_type: 'player', status: 'approved', remote_result: '{"applied":true,"block":"blocked","mute":"muted"}' }]];
const APPROVED_AVATAR = [[{ id: 1, target_user_id: 5, target_type: 'avatar', status: 'approved', remote_result: '{"applied":false,"reason":"avatar-local"}' }]];
const VRC_USER = [[{ id: 5, vrchat_id: 'usr_12345678-1234-1234-1234-123456789abc' }]];

describe('moderations routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    adminCookie = null;
    vrchatBlockUser.mockResolvedValue({ status: 'blocked' });
    vrchatMuteUser.mockResolvedValue({ status: 'muted' });
    vrchatUnblockUser.mockResolvedValue({ status: 'unblocked' });
    vrchatUnmuteUser.mockResolvedValue({ status: 'unmuted' });
  });

  // ==================== 提交举报 ====================
  test('rejects invalid targetType with 400', async () => {
    const response = await request(createApp())
      .post('/api/moderations')
      .send({ targetType: 'gadget', targetUserId: 5, reason: '测试' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('BAD_REQUEST');
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  test('rejects empty reason and self-report', async () => {
    const noReason = await request(createApp())
      .post('/api/moderations')
      .send({ targetType: 'player', targetUserId: 5, reason: '  ' });
    expect(noReason.status).toBe(400);

    const self = await request(createApp())
      .post('/api/moderations')
      .send({ targetType: 'player', targetUserId: 7, reason: '自己举报自己' });
    expect(self.status).toBe(400);
    expect(self.body.error.code).toBe('BAD_REQUEST');
  });

  test('rejects duplicate pending report with 409', async () => {
    mockQueryBySql([
      [/SELECT id FROM moderations WHERE reporter_id/, [[{ id: 3 }]]]
    ]);
    const response = await request(createApp())
      .post('/api/moderations')
      .send({ targetType: 'player', targetUserId: 5, reason: '重复举报' });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('CONFLICT');
  });

  test('submits a report and logs the operation', async () => {
    mockQueryBySql([
      [/SELECT id FROM moderations WHERE reporter_id/, [[]]],
      [/INSERT INTO moderations/, [{ insertId: 9 }]]
    ]);
    const response = await request(createApp())
      .post('/api/moderations')
      .send({ targetType: 'player', targetUserId: 5, reason: '在公屏骚扰' });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    const { logOper } = require('../utils');
    expect(logOper).toHaveBeenCalled();
  });

  // ==================== 审核队列 ====================
  test('lists the queue with remoteResult passthrough', async () => {
    mockQueryBySql([
      [/COUNT\(\*\) AS c/, [[{ c: 1 }]]],
      [/SELECT m.id, m.target_type/, [[{ id: 1, target_type: 'player', reason: '骚扰', status: 'pending', remote_result: '', reporter_name: '甲', target_name: '乙', resolution_note: '', resolved_at: null }]]]
    ]);
    const response = await request(createApp()).get('/api/moderations?status=pending');

    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0]).toHaveProperty('remoteResult', '');
    expect(mockPool.query.mock.calls[0][0]).toMatch(/m\.remote_result/);
  });

  // ==================== 通过/驳回 ====================
  test('reject action updates status to rejected without remote call', async () => {
    mockQueryBySql([
      [/SELECT id, target_user_id, target_type, status FROM moderations/, PENDING_PLAYER],
      [/UPDATE moderations SET status/, [{ affectedRows: 1 }]]
    ]);
    const response = await request(createApp())
      .post('/api/moderations/1/resolve')
      .send({ action: 'reject', note: '证据不足' });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('rejected');
    expect(response.body.remote).toBeNull();
    expect(vrchatBlockUser).not.toHaveBeenCalled();
  });

  test('approve for avatar stores avatar-local remoteResult', async () => {
    mockQueryBySql([
      [/SELECT id, target_user_id, target_type, status FROM moderations/, [[{ id: 1, target_user_id: 5, target_type: 'avatar', status: 'pending' }]]],
      [/UPDATE moderations SET status/, [{ affectedRows: 1 }]],
      [/SET remote_result/, [{ affectedRows: 1 }]]
    ]);
    const response = await request(createApp())
      .post('/api/moderations/1/resolve')
      .send({ action: 'approve' });

    expect(response.status).toBe(200);
    expect(response.body.remote).toBeNull();
    const remoteSql = mockPool.query.mock.calls.find(c => /SET remote_result/.test(c[0]));
    const stored = JSON.parse(remoteSql[1][0]);
    expect(stored).toEqual({ applied: false, reason: 'avatar-local' });
    expect(vrchatBlockUser).not.toHaveBeenCalled();
  });

  test('approve for player without vrchat_id skips remote gracefully', async () => {
    mockQueryBySql([
      [/SELECT id, target_user_id, target_type, status FROM moderations/, PENDING_PLAYER],
      [/UPDATE moderations SET status/, [{ affectedRows: 1 }]],
      [/SELECT id, vrchat_id FROM users/, [[]]],
      [/SET remote_result/, [{ affectedRows: 1 }]]
    ]);
    const response = await request(createApp())
      .post('/api/moderations/1/resolve')
      .send({ action: 'approve' });

    expect(response.status).toBe(200);
    const remoteSql = mockPool.query.mock.calls.find(c => /SET remote_result/.test(c[0]));
    expect(JSON.parse(remoteSql[1][0])).toEqual({ applied: false, reason: 'no-vrchat-id' });
    expect(vrchatBlockUser).not.toHaveBeenCalled();
  });

  test('approve for player without admin cookie skips remote gracefully', async () => {
    mockQueryBySql([
      [/SELECT id, target_user_id, target_type, status FROM moderations/, PENDING_PLAYER],
      [/UPDATE moderations SET status/, [{ affectedRows: 1 }]],
      [/SELECT id, vrchat_id FROM users/, VRC_USER],
      [/SET remote_result/, [{ affectedRows: 1 }]]
    ]);
    const response = await request(createApp())
      .post('/api/moderations/1/resolve')
      .send({ action: 'approve' });

    expect(response.status).toBe(200);
    const remoteSql = mockPool.query.mock.calls.find(c => /SET remote_result/.test(c[0]));
    expect(JSON.parse(remoteSql[1][0])).toEqual({ applied: false, reason: 'no-admin-cookie' });
  });

  test('approve for player runs block+mute and stores applied result', async () => {
    adminCookie = 'auth=admin-token';
    mockQueryBySql([
      [/SELECT id, target_user_id, target_type, status FROM moderations/, PENDING_PLAYER],
      [/UPDATE moderations SET status/, [{ affectedRows: 1 }]],
      [/SELECT id, vrchat_id FROM users/, VRC_USER],
      [/SET remote_result/, [{ affectedRows: 1 }]]
    ]);
    const response = await request(createApp())
      .post('/api/moderations/1/resolve')
      .send({ action: 'approve' });

    expect(response.status).toBe(200);
    expect(vrchatBlockUser).toHaveBeenCalledWith('usr_12345678-1234-1234-1234-123456789abc', 'auth=admin-token');
    expect(vrchatMuteUser).toHaveBeenCalled();
    expect(response.body.remote).toEqual({ block: 'blocked', mute: 'muted' });
    const remoteSql = mockPool.query.mock.calls.find(c => /SET remote_result/.test(c[0]));
    expect(JSON.parse(remoteSql[1][0])).toEqual({ applied: true, block: 'blocked', mute: 'muted' });
  });

  test('resolve rejects already-handled item with 409', async () => {
    // P3-121：条件翻转「WHERE status='pending'」失败（affectedRows=0）→ 409
    mockQueryBySql([
      [/SELECT id, target_user_id, target_type, status FROM moderations/, [[{ id: 1, target_user_id: 5, target_type: 'player', status: 'approved' }]]],
      [/UPDATE moderations SET status/, [{ affectedRows: 0 }]]
    ]);
    const response = await request(createApp())
      .post('/api/moderations/1/resolve')
      .send({ action: 'approve' });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('CONFLICT');
  });

  // ==================== 撤销远程动作 ====================
  test('revert returns 404 for missing item', async () => {
    mockQueryBySql([[/SELECT id, target_user_id, target_type, status, remote_result FROM moderations/, [[]]]]);
    const response = await request(createApp()).post('/api/moderations/99/revert');
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });

  test('revert returns 409 unless the item is approved', async () => {
    mockQueryBySql([
      [/SELECT id, target_user_id, target_type, status, remote_result FROM moderations/, [[{ id: 1, target_user_id: 5, target_type: 'player', status: 'pending', remote_result: '' }]]]
    ]);
    const response = await request(createApp()).post('/api/moderations/1/revert');
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('CONFLICT');
  });

  test('revert for avatar marks revoked without remote calls', async () => {
    mockQueryBySql([
      [/SELECT id, target_user_id, target_type, status, remote_result FROM moderations/, APPROVED_AVATAR],
      [/SET remote_result/, [{ affectedRows: 1 }]]
    ]);
    const response = await request(createApp()).post('/api/moderations/1/revert');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, remote: null, revoked: true });
    const remoteSql = mockPool.query.mock.calls.find(c => /SET remote_result/.test(c[0]));
    const stored = JSON.parse(remoteSql[1][0]);
    expect(stored.revoked).toBe(true);
    expect(stored.revokeNote).toMatch(/站内处理/);
    expect(vrchatUnblockUser).not.toHaveBeenCalled();
  });

  test('revert for player without admin cookie records skipped status', async () => {
    mockQueryBySql([
      [/SELECT id, target_user_id, target_type, status, remote_result FROM moderations/, APPROVED_PLAYER],
      [/SELECT id, vrchat_id FROM users/, VRC_USER],
      [/SET remote_result/, [{ affectedRows: 1 }]]
    ]);
    const response = await request(createApp()).post('/api/moderations/1/revert');

    expect(response.status).toBe(200);
    expect(response.body.remote).toEqual({ unblock: 'skipped:no-admin-cookie', unmute: 'skipped:no-admin-cookie' });
    expect(vrchatUnblockUser).not.toHaveBeenCalled();
  });

  test('revert for player runs unblock+unmute and merges into remote_result', async () => {
    adminCookie = 'auth=admin-token';
    mockQueryBySql([
      [/SELECT id, target_user_id, target_type, status, remote_result FROM moderations/, APPROVED_PLAYER],
      [/SELECT id, vrchat_id FROM users/, VRC_USER],
      [/SET remote_result/, [{ affectedRows: 1 }]]
    ]);
    const response = await request(createApp()).post('/api/moderations/1/revert');

    expect(response.status).toBe(200);
    expect(vrchatUnblockUser).toHaveBeenCalledWith('usr_12345678-1234-1234-1234-123456789abc', 'auth=admin-token');
    expect(vrchatUnmuteUser).toHaveBeenCalled();
    expect(response.body.remote).toEqual({ unblock: 'unblocked', unmute: 'unmuted' });
    const remoteSql = mockPool.query.mock.calls.find(c => /SET remote_result/.test(c[0]));
    const stored = JSON.parse(remoteSql[1][0]);
    expect(stored).toMatchObject({
      applied: true,
      block: 'blocked',
      mute: 'muted',
      revoked: true,
      unblock: 'unblocked',
      unmute: 'unmuted'
    });
  });

  test('revert tolerates remote failures and records error status', async () => {
    adminCookie = 'auth=admin-token';
    vrchatUnblockUser.mockRejectedValue(new Error('rate limited'));
    mockQueryBySql([
      [/SELECT id, target_user_id, target_type, status, remote_result FROM moderations/, APPROVED_PLAYER],
      [/SELECT id, vrchat_id FROM users/, VRC_USER],
      [/SET remote_result/, [{ affectedRows: 1 }]]
    ]);
    const response = await request(createApp()).post('/api/moderations/1/revert');

    expect(response.status).toBe(200);
    expect(response.body.remote.unblock).toMatch(/^error:/);
    expect(response.body.remote.unmute).toBe('unmuted');
    const remoteSql = mockPool.query.mock.calls.find(c => /SET remote_result/.test(c[0]));
    expect(JSON.parse(remoteSql[1][0]).revoked).toBe(true);
  });

  test('revert is idempotent: repeating keeps revoked true and refreshes status', async () => {
    adminCookie = 'auth=admin-token';
    const alreadyRevoked = [[{
      id: 1, target_user_id: 5, target_type: 'player', status: 'approved',
      remote_result: '{"applied":true,"block":"blocked","mute":"muted","revoked":true,"unblock":"unblocked","unmute":"unmuted"}'
    }]];
    mockQueryBySql([
      [/SELECT id, target_user_id, target_type, status, remote_result FROM moderations/, alreadyRevoked],
      [/SELECT id, vrchat_id FROM users/, VRC_USER],
      [/SET remote_result/, [{ affectedRows: 1 }]]
    ]);
    const response = await request(createApp()).post('/api/moderations/1/revert');

    expect(response.status).toBe(200);
    const remoteSql = mockPool.query.mock.calls.find(c => /SET remote_result/.test(c[0]));
    const stored = JSON.parse(remoteSql[1][0]);
    expect(stored.revoked).toBe(true);
    expect(stored.unblock).toBe('unblocked');
    expect(stored.unmute).toBe('unmuted');
  });
});
