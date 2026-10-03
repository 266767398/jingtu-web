/**
 * P3-27（CI 红灯收尾）：routes/admin_name_change.js 路由行为测试。
 * 覆盖：用户自助申请改名（空名/超长/非法字符/重名/已有待审/成功，含 P3-118 事务加锁）、
 * 我的申请列表、管理员待审/全量列表、审核（参数错/不存在/已审核/目标名不合法/被占用/通过/拒绝）。
 * 通过 supertest + mock ../utils（getPool/ok/sendError/handleError/logOper/ErrorCodes）驱动，无真实 DB。
 */
const express = require('express');
const request = require('supertest');

const mockConn = {
  beginTransaction: jest.fn().mockResolvedValue(),
  commit: jest.fn().mockResolvedValue(),
  rollback: jest.fn().mockResolvedValue(),
  release: jest.fn().mockResolvedValue(),
  query: jest.fn().mockResolvedValue([[]])
};
const mockPool = {
  query: jest.fn().mockResolvedValue([[]]),
  getConnection: jest.fn().mockResolvedValue(mockConn)
};
const mockLogOper = jest.fn().mockResolvedValue();

jest.mock('../auth', () => ({
  requireAuth(req, res, next) { next(); },
  requireAdminCompat(req, res, next) { next(); }
}));

jest.mock('../utils', () => ({
  getPool: () => mockPool,
  handleError(res, e) {
    return res.status(e.statusCode || 500).json({ success: false, error: { code: e.code || 'INTERNAL_ERROR', message: e.message } });
  },
  sendError(res, status, code, message) {
    return res.status(status).json({ success: false, error: { code, message } });
  },
  ok(res, fields) {
    return res.json(fields ? { success: true, ...fields } : { success: true });
  },
  logOper: (...args) => mockLogOper(...args),
  ErrorCodes: { BAD_REQUEST: 'BAD_REQUEST', NOT_FOUND: 'NOT_FOUND', CONFLICT: 'CONFLICT', UNAUTHORIZED: 'UNAUTHORIZED' }
}));

const routerFactory = require('../routes/admin_name_change');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { if (!req.session) req.session = { userId: 7, displayName: '老名字' }; next(); });
  app.use('/', routerFactory());
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPool.query.mockResolvedValue([[]]);
  mockConn.query.mockResolvedValue([[]]);
  mockLogOper.mockResolvedValue();
});

describe('P3-27 改名申请（requireAuth 侧）', () => {
  test('空名 400', async () => {
    const res = await request(makeApp()).post('/name-change/request').send({ newName: '  ', reason: 'x' });
    expect(res.status).toBe(400);
  });

  test('超 50 字 400', async () => {
    const res = await request(makeApp()).post('/name-change/request').send({ newName: 'x'.repeat(51) });
    expect(res.status).toBe(400);
  });

  test('非法字符 400', async () => {
    const res = await request(makeApp()).post('/name-change/request').send({ newName: '张三<script>' });
    expect(res.status).toBe(400);
  });

  test('新名已被他人占用 400，不落库', async () => {
    mockPool.query.mockImplementation((sql) => {
      if (sql.includes('SELECT id FROM users WHERE display_name=?')) return Promise.resolve([[{ id: 3 }]]);
      return Promise.resolve([[]]);
    });
    const res = await request(makeApp()).post('/name-change/request').send({ newName: '被占用的名字' });
    expect(res.status).toBe(400);
    expect(mockPool.getConnection).not.toHaveBeenCalled();
  });

  test('已有待审核申请 400（FOR UPDATE 检出后回滚）', async () => {
    mockConn.query.mockResolvedValue([[{ id: 1 }]]);
    const res = await request(makeApp()).post('/name-change/request').send({ newName: '新名字A' });
    expect(res.status).toBe(400);
    expect(mockConn.beginTransaction).toHaveBeenCalled();
    expect(mockConn.rollback).toHaveBeenCalled();
    expect(mockConn.commit).not.toHaveBeenCalled();
  });

  test('成功提交：事务插入 + 操作日志', async () => {
    const res = await request(makeApp()).post('/name-change/request').send({ newName: '新名字B', reason: '想改名' });
    expect(res.status).toBe(200);
    expect(mockConn.beginTransaction).toHaveBeenCalled();
    expect(mockConn.commit).toHaveBeenCalled();
    expect(mockConn.release).toHaveBeenCalled();
    expect(mockConn.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO name_change_requests'),
      [7, '老名字', '新名字B', '想改名']
    );
    expect(mockLogOper).toHaveBeenCalledWith(7, '提交改名申请', '老名字 → 新名字B');
  });

  test('事务异常回滚并透传（500）', async () => {
    mockConn.beginTransaction.mockRejectedValueOnce(new Error('tx boom'));
    const res = await request(makeApp()).post('/name-change/request').send({ newName: '新名字C' });
    expect(res.status).toBe(500);
    expect(mockConn.rollback).toHaveBeenCalled();
    expect(mockConn.release).toHaveBeenCalled();
  });

  test('GET /name-change/my-requests 返回本人申请', async () => {
    const rows = [{ id: 1, oldName: 'a', newName: 'b', status: 'pending' }];
    mockPool.query.mockResolvedValue([rows]);
    const res = await request(makeApp()).get('/name-change/my-requests');
    expect(res.status).toBe(200);
    expect(res.body.requests).toEqual(rows);
    expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining('WHERE user_id=?'), [7]);
  });
});

describe('P3-27 改名审核（requireAdminCompat 侧）', () => {
  test('GET /name-change/pending 返回待审列表', async () => {
    const rows = [{ id: 2, oldName: 'a', newName: 'b' }];
    mockPool.query.mockResolvedValue([rows]);
    const res = await request(makeApp()).get('/name-change/pending');
    expect(res.status).toBe(200);
    expect(res.body.requests).toEqual(rows);
  });

  test('GET /name-change/all 返回全量列表', async () => {
    const rows = [{ id: 2, oldName: 'a', newName: 'b', status: 'approved' }];
    mockPool.query.mockResolvedValue([rows]);
    const res = await request(makeApp()).get('/name-change/all');
    expect(res.status).toBe(200);
    expect(res.body.requests).toEqual(rows);
  });

  test('审核参数缺失/非法 400', async () => {
    const res = await request(makeApp()).post('/name-change/review').send({ id: 1, action: 'whatever' });
    expect(res.status).toBe(400);
  });

  test('申请不存在 404', async () => {
    mockPool.query.mockResolvedValue([[]]);
    const res = await request(makeApp()).post('/name-change/review').send({ id: 99, action: 'approve' });
    expect(res.status).toBe(404);
  });

  test('已审核的申请 400', async () => {
    mockPool.query.mockResolvedValue([[{ user_id: 1, old_name: 'a', new_name: 'b', status: 'approved' }]]);
    const res = await request(makeApp()).post('/name-change/review').send({ id: 5, action: 'approve' });
    expect(res.status).toBe(400);
  });

  test('approve 目标名不合法：拒绝申请并留痕，返回 400', async () => {
    mockPool.query.mockImplementation((sql) => {
      if (sql.includes('SELECT user_id, old_name, new_name, status FROM name_change_requests')) {
        return Promise.resolve([[{ user_id: 1, old_name: 'a', new_name: '非法<script>', status: 'pending' }]]);
      }
      if (sql.includes(`UPDATE name_change_requests SET status='rejected'`)) return Promise.resolve([{ affectedRows: 1 }]);
      return Promise.resolve([[]]);
    });
    const res = await request(makeApp()).post('/name-change/review').send({ id: 5, action: 'approve', comment: '' });
    expect(res.status).toBe(400);
    expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining("status='rejected'"), [7, expect.stringContaining('不合法'), 5]);
  });

  test('approve 目标名被他人占用：拒绝申请并留痕，返回 409', async () => {
    mockPool.query.mockImplementation((sql) => {
      if (sql.includes('SELECT user_id, old_name, new_name, status FROM name_change_requests')) {
        return Promise.resolve([[{ user_id: 1, old_name: 'a', new_name: '被人用了', status: 'pending' }]]);
      }
      if (sql.includes('SELECT id FROM users WHERE display_name=? AND id<>?')) return Promise.resolve([[{ id: 9 }]]);
      if (sql.includes(`UPDATE name_change_requests SET status='rejected'`)) return Promise.resolve([{ affectedRows: 1 }]);
      return Promise.resolve([[]]);
    });
    const res = await request(makeApp()).post('/name-change/review').send({ id: 5, action: 'approve' });
    expect(res.status).toBe(409);
    expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining("status='rejected'"), [7, expect.stringContaining('已被他人占用'), 5]);
  });

  test('approve 成功：更新用户显示名 + 置为 approved + 操作日志', async () => {
    mockPool.query.mockImplementation((sql) => {
      if (sql.includes('SELECT user_id, old_name, new_name, status FROM name_change_requests')) {
        return Promise.resolve([[{ user_id: 1, old_name: '老名字', new_name: '新名字D', status: 'pending' }]]);
      }
      if (sql.includes('SELECT id FROM users WHERE display_name=? AND id<>?')) return Promise.resolve([[]]);
      if (sql.includes('UPDATE users SET display_name=?')) return Promise.resolve([{ affectedRows: 1 }]);
      if (sql.includes("status='approved'")) return Promise.resolve([{ affectedRows: 1 }]);
      return Promise.resolve([[]]);
    });
    const res = await request(makeApp()).post('/name-change/review').send({ id: 5, action: 'approve', comment: '通过啦' });
    expect(res.status).toBe(200);
    expect(mockPool.query).toHaveBeenCalledWith('UPDATE users SET display_name=? WHERE id=?', ['新名字D', 1]);
    expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining("status='approved'"), [7, '通过啦', 5]);
    expect(mockLogOper).toHaveBeenCalledWith(7, '通过改名', '老名字 → 新名字D');
  });

  test('reject 成功：置为 rejected + 操作日志', async () => {
    mockPool.query.mockImplementation((sql) => {
      if (sql.includes('SELECT user_id, old_name, new_name, status FROM name_change_requests')) {
        return Promise.resolve([[{ user_id: 1, old_name: 'a', new_name: 'b', status: 'pending' }]]);
      }
      if (sql.includes(`UPDATE name_change_requests SET status='rejected'`)) return Promise.resolve([{ affectedRows: 1 }]);
      return Promise.resolve([[]]);
    });
    const res = await request(makeApp()).post('/name-change/review').send({ id: 5, action: 'reject', comment: '不符合规范' });
    expect(res.status).toBe(200);
    expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining("status='rejected'"), [7, '不符合规范', 5]);
    expect(mockLogOper).toHaveBeenCalledWith(7, '拒绝改名', 'a → b: 不符合规范');
  });
});
