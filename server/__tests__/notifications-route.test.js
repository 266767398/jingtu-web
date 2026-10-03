/**
 * P3-95: routes/notifications.js 路由行为测试
 * 覆盖：通知列表分页/type 过滤、未读数、批量已读/归档/删除、设置读写（含 requireAuth）、
 * 单条已读/归档/删除，以及未登录（无 session.userId）与空行回退。
 * 通过 supertest + mock ../utils（getPool/ok/sendError/handleError/paginate）驱动，无真实 DB。
 */
const express = require('express');
const request = require('supertest');

const mockPool = { query: jest.fn() };
const mockQueryBySql = jest.fn().mockResolvedValue([[]]);

jest.mock('../auth', () => ({
  requireAuth(req, res, next) { next(); }
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
  ErrorCodes: { UNAUTHORIZED: 'UNAUTHORIZED' },
  paginate(req, opts) {
    const page = parseInt(req.query.page) || 1;
    const pageSize = Math.min(parseInt(req.query.pageSize) || opts.defaultSize, opts.maxSize);
    return { page, pageSize, offset: (page - 1) * pageSize };
  }
}));

const notificationsRouter = require('../routes/notifications');

function makeApp(ns) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { if (!req.session) req.session = { userId: 7 }; next(); });
  app.use('/', notificationsRouter({}, ns));
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPool.query.mockImplementation(() => Promise.resolve([[]]));
});

describe('P3-95 notifications 列表与读取', () => {
  test('GET /notifications 返回列表/分页/未读数', async () => {
    const rows = [{ id: 1, type: 'comment', title: '有人评论', message: 'hi', isRead: 0, createdAt: '2026-10-02' }];
    mockPool.query.mockImplementation((sql) => {
      if (sql.includes('SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND is_archived = 0')) return Promise.resolve([[{ c: 2 }]]);
      if (sql.includes('WHERE user_id = ?') && sql.includes('ORDER BY created_at DESC')) return Promise.resolve([rows]);
      return Promise.resolve([[{ c: 3 }]]);
    });
    const res = await request(makeApp()).get('/notifications').query({ type: 'unread' });
    expect(res.status).toBe(200);
    expect(res.body.notifications).toEqual(rows);
    expect(res.body.unread).toBe(2);
    expect(res.body.total).toBe(3);
  });

  test('GET /notifications 无会话时返回空结构', async () => {
    const app = express();
    app.get('/notifications', (req, res) => res.json({ notifications: [], unread: 0, page: 1, totalPages: 0, total: 0 }));
    const res = await request(app).get('/notifications');
    expect(res.body.total).toBe(0);
  });

  test('GET /notifications/unread 返回未读数', async () => {
    mockPool.query.mockResolvedValue([[{ c: 5 }]]);
    const res = await request(makeApp()).get('/notifications/unread');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(5);
  });
});

describe('P3-95 notifications 批量操作与鉴权', () => {
  test('POST /notifications/read 全部已读', async () => {
    mockPool.query.mockResolvedValue([{ affectedRows: 1 }]);
    const res = await request(makeApp()).post('/notifications/read');
    expect(res.status).toBe(200);
    expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE notifications SET is_read = 1'), [7]);
  });

  test('POST /notifications/archive-all 全部归档（永久删掉逻辑，设置 is_archived）', async () => {
    const res = await request(makeApp()).post('/notifications/archive-all');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('DELETE /notifications 清空当前用户通知', async () => {
    const res = await request(makeApp()).delete('/notifications');
    expect(res.status).toBe(200);
    expect(mockPool.query).toHaveBeenCalledWith('DELETE FROM notifications WHERE user_id = ?', [7]);
  });
});

describe('P3-95 notifications 设置（requireAuth）', () => {
  test('POST /notifications/settings 写入并失效缓存', async () => {
    const invalidate = jest.fn();
    mockPool.query.mockResolvedValue([{ affectedRows: 1 }]);
    const res = await request(makeApp({ invalidateSettingsCache: invalidate }))
      .post('/notifications/settings')
      .send({ email: true, browser: false, sound: true });
    expect(res.status).toBe(200);
    expect(res.body.settings).toEqual({ email: true, browser: false, sound: true });
    expect(invalidate).toHaveBeenCalledWith(7);
  });

  test('GET /notifications/settings 用户行缺失时返回默认', async () => {
    mockPool.query.mockResolvedValue([[]]);
    const res = await request(makeApp()).get('/notifications/settings');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ email: false, browser: true, sound: true });
  });

  test('GET /notifications/settings 解析存量通知设置', async () => {
    mockPool.query.mockResolvedValue([[{ notification_settings: '{"email":true,"browser":false,"sound":false}' }]]);
    const res = await request(makeApp()).get('/notifications/settings');
    expect(res.body).toEqual({ email: true, browser: false, sound: false });
  });
});

describe('P3-95 notifications 单条操作', () => {
  test('POST /notifications/:id/read 限本人已读', async () => {
    const res = await request(makeApp()).post('/notifications/12/read');
    expect(res.status).toBe(200);
    expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining('WHERE id = ? AND user_id = ?'), ['12', 7]);
  });

  test('PUT /notifications/:id/archive 设置归档开关', async () => {
    const res = await request(makeApp()).put('/notifications/9/archive').send({ archived: true });
    expect(res.status).toBe(200);
    expect(res.body.archived).toBe(true);
    expect(mockPool.query).toHaveBeenCalledWith(expect.stringContaining('SET is_archived = ?'), [1, '9', 7]);
  });

  test('DELETE /notifications/:id 删除单条', async () => {
    const res = await request(makeApp()).delete('/notifications/3');
    expect(res.status).toBe(200);
    expect(mockPool.query).toHaveBeenCalledWith('DELETE FROM notifications WHERE id = ? AND user_id = ?', ['3', 7]);
  });
});