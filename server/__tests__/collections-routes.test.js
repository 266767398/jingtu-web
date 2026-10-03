// collections 统一收藏路由回归测试
// 对齐当前实现（V8.2+）：函数工厂导出、snake_case 字段、kind=avatar_model、
// getPool().query 直接查询（无 getConnection 事务）、vrc 拉取降级。
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
  requireAdminCompat(req, res, next) {
    req.session = { userId: 7, role: 'admin' };
    next();
  }
}));

jest.mock('../vrc', () => ({
  vrchatGetAvatar: jest.fn().mockResolvedValue(null),
  vrchatGetWorld: jest.fn().mockResolvedValue(null),
  vrchatGetUser: jest.fn().mockResolvedValue(null),
  vrchatSetAvatar: jest.fn().mockResolvedValue(true),
  vrchatCloneAvatar: jest.fn().mockResolvedValue(true),
  sanitizeVrcId: (id) => /^(wrld|usr|avtr|grp)_[0-9a-fA-F-]+$/.test(id),
  USER_AGENT: 'JingTuWeb/1.3.0-test'
}));

jest.mock('../utils', () => ({
  getPool: () => mockPool,
  ok(res, fields) {
    return res.json(fields ? { success: true, ...fields } : { success: true });
  },
  ErrorCodes: {
    BAD_REQUEST: 'BAD_REQUEST',
    NOT_FOUND: 'NOT_FOUND',
    CONFLICT: 'CONFLICT',
    FORBIDDEN: 'FORBIDDEN',
    INTERNAL_ERROR: 'INTERNAL_ERROR'
  },
  createErr(code, message, statusCode) {
    const e = new Error(message);
    e.code = code;
    e.statusCode = statusCode;
    return e;
  },
  proxyVrcAvatar: (url) => url,
  // P2-70 分页收口后 routes/collections.js 模块加载期即解构 paginate；
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
  escapeLike: (s) => String(s || '').replace(/[%_!]/g, (m) => '!' + m),
  handleError(res, error) {
    const status = error.statusCode || error.status || 500;
    return res.status(status).json({ success: false, error: { code: error.code, message: error.message } });
  }
}));

// 当前模块是函数工厂：collections(getVRCCookie) -> router
const collectionsFactory = require('../routes/collections');
const { vrchatGetAvatar } = require('../vrc');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/collections', collectionsFactory(() => null));
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

describe('collections routes', () => {
  beforeEach(() => jest.clearAllMocks());

  test('rejects malformed targets before querying the database', async () => {
    const response = await request(createApp())
      .post('/api/collections')
      .send({ kind: 'avatar_model', target_id: 'wrld_wrong-kind' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('BAD_REQUEST');
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  test('rejects unknown kind with 400', async () => {
    const response = await request(createApp())
      .post('/api/collections')
      .send({ kind: 'gadget', target_id: 'avtr_abc' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('BAD_REQUEST');
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  test('lists owned items with snake_case target_id passthrough', async () => {
    mockQueryBySql([
      [/COUNT\(\*\) AS total/, [[{ total: 1 }]]],
      [/FROM collections c/, [[{ id: 9, kind: 'world', target_id: 'wrld_abc' }]]]
    ]);

    const response = await request(createApp()).get('/api/collections?kind=world');

    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(1);
    expect(mockPool.query).toHaveBeenCalled();
    expect(mockPool.query.mock.calls[0][0]).toMatch(/c\.user_id = \?/);
  });

  test('creating a collection writes via getPool().query (no legacy transaction)', async () => {
    mockQueryBySql([
      [/SELECT id FROM collections WHERE user_id/, [[]]],            // 去重
      [/INSERT INTO collections/, [{ insertId: 22 }]],              // 插入
      [/SELECT \* FROM collections WHERE id=\?/, [[{ id: 22, kind: 'avatar_model', target_id: 'avtr_abcd' }]]]
    ]);

    const response = await request(createApp())
      .post('/api/collections')
      .send({ kind: 'avatar_model', target_id: 'avtr_abcd', name: 'Avatar' });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    const insertCall = mockPool.query.mock.calls.find(c => /INSERT INTO collections/.test(c[0]));
    expect(insertCall).toBeTruthy();
    expect(mockPool.getConnection).toBeUndefined();
  });

  test('deleting a collection uses getPool().query direct delete', async () => {
    mockQueryBySql([
      [/SELECT \* FROM collections WHERE id=\? AND user_id=\?/, [[{ id: 22, kind: 'avatar_model', target_id: 'avtr_abcd', user_id: 7 }]]],
      [/DELETE FROM collections/, [{ affectedRows: 1 }]]
    ]);

    const response = await request(createApp()).delete('/api/collections/22');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(mockPool.query.mock.calls[0][0]).toMatch(/SELECT \* FROM collections WHERE id=\? AND user_id=\?/);
    expect(mockPool.query.mock.calls[1][0]).toMatch(/DELETE FROM collections/);
  });
});
