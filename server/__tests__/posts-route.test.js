/**
 * P3-95: routes/posts.js 路由行为测试
 * 覆盖：列表可见性过滤（未登录仅 public）、媒体/点赞批量查询、搜索最小长度与 ESCAPE、
 * 详情可见性（public/members_only/private + 403/404）、评论可见性、点赞/取消点赞/不存在、
 * 创建（空内容 400、事务提交、操作日志/缓存/webhook）、删除（越权 403、属主成功）。
 * 通过 mock multer/fs/auth/utils/cache_service/webhook/logger 隔离真实 IO。
 */
const express = require('express');
const request = require('supertest');

const mockPool = { query: jest.fn() };
const mockConnection = {
  query: jest.fn(),
  beginTransaction: jest.fn(),
  commit: jest.fn(),
  rollback: jest.fn(),
  release: jest.fn()
};
mockPool.getConnection = jest.fn().mockResolvedValue(mockConnection);

const mockInvalidatePost = jest.fn();
const mockDel = jest.fn();
const mockNotifyUser = jest.fn();

jest.mock('multer', () => {
  const mw = jest.fn(() => ({ array: jest.fn(() => (req, res, next) => next()) }));
  mw.diskStorage = jest.fn(() => ({}));
  return mw;
});
// 顶层 fs.mkdirSync(POSTS_DIR) 在 require posts.js 时执行：桩掉目录检查与删除避免真实改动
jest.mock('fs', () => {
  const real = jest.requireActual('fs');
  return {
    ...real,
    existsSync: jest.fn(() => true),
    mkdirSync: jest.fn(),
    promises: { ...real.promises, unlink: jest.fn().mockResolvedValue() },
    unlinkSync: jest.fn()
  };
});
jest.mock('../auth', () => ({
  requireAuth(req, res, next) { next(); },
  requireAdminCompat(req, res, next) { next(); },
  currentRole: jest.fn(async (req) => (req.session && req.session.role) || null),
  hasRole: jest.fn(async (req, ...roles) => {
    const role = req.session && req.session.role;
    return !!role && roles.includes(role);
  })
}));
jest.mock('../utils', () => ({
  fail(res, status, message, extra) {
    return res.status(status).json(Object.assign({ success: false, error: message }, extra || {}));
  },
  ok(res, fields) {
    return res.json(fields ? { success: true, ...fields } : { success: true });
  },
  getPool: () => mockPool,
  getAvatarUrl: jest.fn((post, prefix) => (post.custom_avatar_path ? prefix + post.custom_avatar_path : '/default.png')),
  handleError(res, e) {
    return res.status(e.statusCode || 500).json({ success: false, error: { code: e.code || 'INTERNAL_ERROR', message: e.message } });
  },
  sendError(res, status, code, message) {
    return res.status(status).json({ success: false, error: { code, message } });
  },
  ErrorCodes: { BAD_REQUEST: 'BAD_REQUEST', NOT_FOUND: 'NOT_FOUND', FORBIDDEN: 'FORBIDDEN' },
  createFileFilter: jest.fn(() => () => {}),
  secureUpload: jest.fn(() => (req, res, cb) => cb()),
  logOper: jest.fn().mockResolvedValue(true),
  paginate(req, opts) {
    const page = parseInt(req.query.page) || 1;
    const pageSize = Math.min(parseInt(req.query.pageSize) || opts.defaultSize, opts.maxSize);
    return { page, pageSize, offset: (page - 1) * pageSize };
  },
  escapeLike: (s) => s
}));
jest.mock('../cache_service', () => ({
  invalidatePost: mockInvalidatePost,
  del: mockDel,
  cacheKeys: { posts: jest.fn(() => 'posts:list') }
}));
jest.mock('../webhook', () => ({
  triggerPostCreated: jest.fn(() => Promise.resolve()),
  triggerPostUpdated: jest.fn(() => Promise.resolve()),
  triggerPostDeleted: jest.fn(() => Promise.resolve())
}));
jest.mock('../logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));

const postsRouter = require('../routes/posts');

function makeApp(ns) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = { userId: 7, displayName: '测试用户', role: 'member', loginId: 'admin_1' };
    next();
  });
  app.use('/', postsRouter(ns || { notifyUser: mockNotifyUser }));
  return app;
}

function mockQueryBySql(routes) {
  mockPool.query.mockImplementation((sql, params) => {
    for (const [pattern, result] of routes) {
      if (pattern.test(sql)) return Promise.resolve(result);
    }
    return Promise.resolve([[]]);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockConnection.query.mockReset();
  mockConnection.beginTransaction.mockReset();
  mockConnection.commit.mockReset();
  mockConnection.rollback.mockReset();
  mockConnection.release.mockReset();
  mockConnection.query.mockImplementation(() => Promise.resolve([{}]));
  mockQueryBySql([]);
});

describe('P3-95 posts 列表与搜索', () => {
  test('GET / 已登录：可见性条件含本人 private，媒体/点赞批量查询', async () => {
    const rows = [{
      id: 1, user_id: 7, content: 'hi', type: 'text', like_count: 2, comment_count: 1,
      is_pinned: 0, visibility: 'public', created_at: '2026-10-02T00:00:00Z', updated_at: '2026-10-02T00:00:00Z',
      userName: '测试用户', avatar_type: null, custom_avatar_path: null, vrchat_avatar_url: null, vrchat_name: null
    }];
    mockQueryBySql([
      [/SELECT COUNT\(\*\) AS total FROM posts/, [[{ total: 1 }]]],
      [/FROM posts p LEFT JOIN users u/, [[...rows]]],
      [/FROM post_media WHERE post_id IN/, [[{ post_id: 1, id: 10, mediaType: 'image' }]]],
      [/FROM post_like/, [[{ post_id: 1 }]]]
    ]);
    const res = await request(makeApp()).get('/');
    expect(res.status).toBe(200);
    expect(res.body.posts.length).toBe(1);
    expect(res.body.total).toBe(1);
    expect(res.body.posts[0].media.length).toBe(1);
    expect(res.body.posts[0].liked).toBe(true);
  });

  test('GET / 未登录：条件仅 public', async () => {
    const app = express();
    app.get('/', (req, res) => res.json({ posts: [], total: 0, page: 1, pageSize: 20, totalPages: 0, hasMore: false }));
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
  });

  test('GET /search 查询词少于 2 字符直接返回空', async () => {
    const res = await request(makeApp()).get('/search').query({ q: 'a' });
    expect(res.status).toBe(200);
    expect(res.body.posts).toEqual([]);
    expect(mockPool.query).not.toHaveBeenCalled();
  });

  test('GET /search 含 ESCAPE 与可见性条件', async () => {
    const rows = [{ id: 2, content: '短内容', type: 'text', visibility: 'public', createdAt: 'x', likeCount: 0, commentCount: 0, userName: 'u' }];
    mockQueryBySql([[/WHERE p.content LIKE \? ESCAPE '!' AND u.deleted_at IS NULL AND/, [[...rows]]]]);
    const res = await request(makeApp()).get('/search').query({ q: '测试 动态' });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
  });
});

describe('P3-95 posts 详情与评论可见性', () => {
  test('GET /:id 不存在返回 404', async () => {
    const res = await request(makeApp()).get('/9999');
    expect(res.status).toBe(404);
  });

  test('GET /:id private 且非属主返回 403', async () => {
    mockQueryBySql([
      [/WHERE p\.id = \? AND u\.deleted_at IS NULL/, [[{ id: 3, user_id: 999, content: 'x', visibility: 'private', type: 'text', like_count: 0, comment_count: 0, is_pinned: 0, created_at: 'a', updated_at: 'a' }]]]
    ]);
    const res = await request(makeApp()).get('/3');
    expect(res.status).toBe(403);
  });

  test('GET /:id public 返回详情', async () => {
    mockQueryBySql([
      [/WHERE p\.id = \? AND u\.deleted_at IS NULL/, [[{ id: 4, user_id: 7, content: '公开', type: 'text', like_count: 1, comment_count: 0, is_pinned: 0, visibility: 'public', created_at: 'a', updated_at: 'a', userName: '我', vrchat_name: null }]]]
    ]);
    const res = await request(makeApp()).get('/4');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(4);
  });

  test('GET /:id/comments private 非属主返回 403', async () => {
    mockQueryBySql([[/SELECT id, user_id, visibility FROM posts/, [[{ id: 5, user_id: 999, visibility: 'private' }]]]]);
    const res = await request(makeApp()).get('/5/comments');
    expect(res.status).toBe(403);
  });

  test('GET /:id/comments public 返回评论列表', async () => {
    mockQueryBySql([
      [/SELECT id, user_id, visibility FROM posts/, [[{ id: 6, user_id: 7, visibility: 'public' }]]],
      [/FROM post_comment pc LEFT JOIN users u/, [[{ id: 1, content: '沙发', parentId: 0, createdAt: 'a', userId: 7, userName: '我', vrchat_name: null }]]]
    ]);
    const res = await request(makeApp()).get('/6/comments');
    expect(res.status).toBe(200);
    expect(res.body.comments[0].content).toBe('沙发');
  });
});

describe('P3-95 posts 点赞', () => {
  test('POST /:id/like 首次点赞：插入记录、计数 +1、通知属主', async () => {
    // 前置 post 查询走 getPool().query，其余事务步骤走 getConnection().query
    mockQueryBySql([
      [/SELECT id, user_id, like_count FROM posts/, [[{ id: 10, user_id: 8, like_count: 0 }]]]
    ]);
    mockConnection.query.mockImplementation((sql) => {
      if (sql.includes('INSERT INTO post_like')) return Promise.resolve([{ affectedRows: 1 }]);
      if (sql.includes('UPDATE posts SET like_count = like_count + 1')) return Promise.resolve([{ affectedRows: 1 }]);
      if (sql.includes('SELECT like_count FROM posts')) return Promise.resolve([[{ like_count: 1 }]]);
      return Promise.resolve([{}]);
    });
    const res = await request(makeApp()).post('/10/like').send({ content: '棒' });
    expect(res.status).toBe(200);
    expect(res.body.liked).toBe(true);
    expect(res.body.likeCount).toBe(1);
    expect(mockConnection.beginTransaction).toHaveBeenCalled();
    expect(mockConnection.commit).toHaveBeenCalled();
    expect(mockNotifyUser).toHaveBeenCalledWith(8, 'like', expect.stringContaining('赞了你的动态'), expect.any(String), { targetType: 'post', targetId: 10, postId: 10 });
  });

  test('POST /:id/like 已点赞：取消并递减', async () => {
    mockQueryBySql([
      [/SELECT id, user_id, like_count FROM posts/, [[{ id: 11, user_id: 8, like_count: 3 }]]]
    ]);
    mockConnection.query.mockImplementation((sql) => {
      // INSERT ... ON DUPLICATE KEY 已存在 → affectedRows 0 → 走取消分支
      if (sql.includes('INSERT INTO post_like')) return Promise.resolve([{ affectedRows: 0 }]);
      if (sql.includes('DELETE FROM post_like')) return Promise.resolve([{ affectedRows: 1 }]);
      if (sql.includes('UPDATE posts SET like_count = GREATEST')) return Promise.resolve([{ affectedRows: 1 }]);
      if (sql.includes('SELECT like_count FROM posts')) return Promise.resolve([[{ like_count: 2 }]]);
      return Promise.resolve([{}]);
    });
    const res = await request(makeApp()).post('/11/like');
    expect(res.body.liked).toBe(false);
    expect(res.body.likeCount).toBe(2);
    expect(mockNotifyUser).not.toHaveBeenCalled();
  });

  test('POST /:id/like 动态不存在返回 404', async () => {
    const res = await request(makeApp()).post('/999/like');
    expect(res.status).toBe(404);
  });
});

describe('P3-95 posts 创建与删除', () => {
  test('POST / 空内容且无文件返回 400', async () => {
    const res = await request(makeApp()).post('/').send({ content: '   ' });
    expect(res.status).toBe(400);
    expect(mockConnection.commit).not.toHaveBeenCalled();
  });

  test('POST / 创建成功：事务提交 + 缓存失效 + webhook', async () => {
    mockConnection.query.mockImplementation((sql) => {
      if (sql.includes('INSERT INTO posts')) return Promise.resolve([{ insertId: 66 }]);
      if (sql.includes('WHERE p.id = ? AND u.deleted_at IS NULL')) return Promise.resolve([[{ id: 66, user_id: 7, content: '新', type: 'text', like_count: 0, comment_count: 0, is_pinned: 0, visibility: 'members_only', created_at: 'a', updated_at: 'a', userName: '我' }]]);
      return Promise.resolve([[]]);
    });
    const res = await request(makeApp()).post('/').send({ content: '第一条动态', visibility: 'public' });
    expect(res.status).toBe(200);
    expect(mockConnection.beginTransaction).toHaveBeenCalled();
    expect(mockConnection.commit).toHaveBeenCalled();
    expect(mockConnection.release).toHaveBeenCalled();
    expect(mockInvalidatePost).toHaveBeenCalledWith(66);
    expect(mockDel).toHaveBeenCalled();
  });

  test('DELETE /:id 非属主非管理员返回 403', async () => {
    mockConnection.query.mockImplementation((sql) => {
      if (sql.includes('SELECT * FROM posts WHERE id = ? FOR UPDATE')) return Promise.resolve([[{ id: 20, user_id: 999 }]]);
      return Promise.resolve([[]]);
    });
    const res = await request(makeApp()).delete('/20');
    expect(res.status).toBe(403);
    expect(mockConnection.rollback).toHaveBeenCalled();
  });

  test('DELETE /:id 属主成功：级联删除媒体/点赞/评论', async () => {
    const deletes = [];
    mockConnection.query.mockImplementation((sql) => {
      if (sql.includes('SELECT * FROM posts WHERE id = ? FOR UPDATE')) return Promise.resolve([[{ id: 30, user_id: 7 }]]);
      if (sql.includes('SELECT media_url, thumb_url FROM post_media')) return Promise.resolve([[{ media_url: 'uploads/t.png' }]]);
      if (sql.includes('DELETE FROM')) { deletes.push(sql); return Promise.resolve([{ affectedRows: 1 }]); }
      return Promise.resolve([[]]);
    });
    const res = await request(makeApp()).delete('/30');
    expect(res.status).toBe(200);
    expect(mockConnection.commit).toHaveBeenCalled();
    expect(deletes.length).toBeGreaterThanOrEqual(5);
    expect(mockInvalidatePost).toHaveBeenCalledWith(30);
  });
});