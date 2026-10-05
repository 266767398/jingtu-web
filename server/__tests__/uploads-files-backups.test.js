// P2-153: 上传/下载域拒绝路径测试
// 覆盖此前分支覆盖 0% 的安全边界：uploads_auth 分享令牌严格绑定（防用任一有效码访问全站私有媒体）、
// files 路由的路径穿越/参数校验、backups 路由的 basename 穿越拦截与错误码映射。
const express = require('express');
const request = require('supertest');
const fs = require('fs');
const os = require('os');
const path = require('path');

const mockPool = { query: jest.fn() };
const mockCreateBackup = jest.fn();
const mockRestoreBackup = jest.fn();
const mockCleanup = jest.fn();

jest.mock('../auth', () => ({
  requireAdminCompat(req, res, next) { next(); },
  requireSuperAdmin(req, res, next) { next(); }
}));

jest.mock('../utils', () => ({
  getPool: () => mockPool,
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
  },
  ErrorCodes: {
    BAD_REQUEST: 'BAD_REQUEST', NOT_FOUND: 'NOT_FOUND', CONFLICT: 'CONFLICT',
    FORBIDDEN: 'FORBIDDEN', INTERNAL_ERROR: 'INTERNAL_ERROR'
  }
}));

jest.mock('../backup-core', () => {
  const osp = require('os');
  const pathp = require('path');
  return {
    BACKUP_DIR: process.env.BACKUP_DIR || pathp.join(osp.tmpdir(), 'bk-route'),
    AUTO_PREFIX: 'auto_',
    ensureBackupDir: jest.fn(),
    formatSize: (b) => (b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 / 1024).toFixed(2)} MB`),
    createBackup: mockCreateBackup,
    restoreBackup: mockRestoreBackup,
    cleanupAutoBackups: mockCleanup
  };
});

const { getShareAuthPaths, verifyShareCode, setupUploadsAuth, setupAssetsAlbumAuth } = require('../middleware/uploads_auth');
const filesRouter = require('../routes/files');
const backupsRouter = require('../routes/backups');

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
  mockQueryBySql([]);
});

function uploadsApp(mountPath) {
  const app = express();
  setupUploadsAuth(app);
  setupAssetsAlbumAuth(app);
  app.use(mountPath, (req, res) => res.json({ ok: true }));
  return app;
}

// ─────────────────────────── uploads_auth 分享令牌严格绑定 ───────────────────────────
describe('P2-153 uploads_auth 分享令牌严格绑定', () => {
  test('getShareAuthPaths：post 类型媒体路径与挂载规整（uploads）', async () => {
    mockQueryBySql([[/post_media/, [[{ media_url: '/uploads/post/5/a.jpg', thumb_url: '/uploads/post/5/t.jpg' }]]]]);
    const paths = await getShareAuthPaths(mockPool, 'post', 5);
    expect(paths).toEqual(['/post/5/a.jpg', '/post/5/t.jpg']);
  });

  test('getShareAuthPaths：album 类型含 thumb 且 assets/album 挂载只收相册路径', async () => {
    mockQueryBySql([[/album_photo/, [[{ photo_path: 'assets/album/6/p.jpg', thumb_path: 'assets/album/6/t.jpg' }]]]]);
    const paths = await getShareAuthPaths(mockPool, 'album', 6, { mount: 'assets/album' });
    expect(paths).toEqual(['/6/p.jpg', '/6/t.jpg']);
  });

  test('getShareAuthPaths：event 类型 world_image_url；外链与空值跳过', async () => {
    mockQueryBySql([[/FROM event/, [[{ world_image_url: 'https://cdn/x.png' }]]]]);
    let paths = await getShareAuthPaths(mockPool, 'event', 1);
    expect(paths).toEqual([]);

    mockQueryBySql([[/FROM event/, [[{ world_image_url: '/uploads/e/1/w.png' }]]]]);
    paths = await getShareAuthPaths(mockPool, 'event', 1);
    expect(paths).toEqual(['/e/1/w.png']);
  });

  test('verifyShareCode：无效码 invalid；路径越权 forbidden；精确命中 ok', async () => {
    mockQueryBySql([
      [/share_links/, [[{ type: 'post', target_id: 5 }]]],
      [/post_media/, [[{ media_url: '/uploads/post/5/a.jpg', thumb_url: null }]]]
    ]);
    const v = await verifyShareCode(mockPool, 'CODE', 'uploads', '/post/5/a.jpg');
    expect(v).toEqual({ ok: true });

    const forbidden = await verifyShareCode(mockPool, 'CODE', 'uploads', '/post/5/b.jpg');
    expect(forbidden).toEqual({ ok: false, reason: 'forbidden' });

    // 前缀误伤防护：/post/5/a1.jpg 不得匹配 /post/5/a.jpg
    const prefix = await verifyShareCode(mockPool, 'CODE', 'uploads', '/post/5/a1.jpg');
    expect(prefix.ok).toBe(false);

    mockQueryBySql([[/share_links/, [[]]]]);
    const invalid = await verifyShareCode(mockPool, 'BAD', 'uploads', '/post/5/a.jpg');
    expect(invalid).toEqual({ ok: false, reason: 'invalid' });
  });

  test('setupUploadsAuth：登录/avatars 放行，匿名 401', async () => {
    const app = express();
    setupUploadsAuth(app);
    app.use('/uploads', (req, res) => res.json({ ok: true }));

    // 头像目录公开放行
    let r = await request(app).get('/uploads/avatars/u1.png');
    expect(r.status).toBe(200);

    // 匿名访问私有媒体 401
    r = await request(app).get('/uploads/post/5/a.jpg');
    expect(r.status).toBe(401);

    // 登录放行
    r = await request(app).get('/uploads/post/5/a.jpg').set('Cookie', 'connect.sid=x');
    // 无真实 session 中间件 → 仍匿名 → 401
    expect(r.status).toBe(401);
  });

  test('setupUploadsAuth：携带绑定正确资源的分享码放行；越权资源 401', async () => {
    const app = express();
    setupUploadsAuth(app);
    app.use('/uploads', (req, res) => res.json({ ok: true }));
    mockQueryBySql([
      [/share_links/, [[{ type: 'post', target_id: 5 }]]],
      [/post_media/, [[{ media_url: '/uploads/post/5/a.jpg', thumb_url: null }]]]
    ]);
    let r = await request(app).get('/uploads/post/5/a.jpg').query({ share: 'GOOD' });
    expect(r.status).toBe(200);

    r = await request(app).get('/uploads/post/5/b.jpg').query({ share: 'GOOD' });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('分享链接无权访问该资源');
  });

  test('setupUploadsAuth：无效/过期分享码 401 统一文案', async () => {
    const app = express();
    setupUploadsAuth(app);
    app.use('/uploads', (req, res) => res.json({ ok: true }));
    mockQueryBySql([[/share_links/, [[]]]]);
    const r = await request(app).get('/uploads/post/5/a.jpg').query({ share: 'EXPIRED' });
    expect(r.status).toBe(401);
    expect(r.body.error).toContain('分享链接无效或已过期');
  });

  test('setupAssetsAlbumAuth：匿名相册媒体无码 401；有效码绑定资源放行', async () => {
    const app = express();
    setupAssetsAlbumAuth(app);
    app.use('/assets/album', (req, res) => res.json({ ok: true }));
    mockQueryBySql([
      [/share_links/, [[{ type: 'album', target_id: 6 }]]],
      [/album_photo/, [[{ photo_path: 'assets/album/6/p.jpg', thumb_path: null }]]]
    ]);
    let r = await request(app).get('/assets/album/6/p.jpg');
    expect(r.status).toBe(401);

    r = await request(app).get('/assets/album/6/p.jpg').query({ share: 'ALBUM' });
    expect(r.status).toBe(200);

    r = await request(app).get('/assets/album/6/other.jpg').query({ share: 'ALBUM' });
    expect(r.status).toBe(401);
  });
});

// ─────────────────────── P3-140 shareVerifyCache 缓存路径 ───────────────────────
describe('P3-140 uploads_auth shareVerifyCache 缓存路径', () => {
  test('同 code+mount+path 连续校验命中缓存，DB 查询不重复', async () => {
    mockQueryBySql([
      [/share_links/, [[{ type: 'post', target_id: 5 }]]],
      [/post_media/, [[{ media_url: '/uploads/post/5/a.jpg', thumb_url: null }]]]
    ]);
    const first = await verifyShareCode(mockPool, 'CACHE1', 'uploads', '/post/5/a.jpg');
    expect(first).toEqual({ ok: true });
    const calls = mockPool.query.mock.calls.length;
    const second = await verifyShareCode(mockPool, 'CACHE1', 'uploads', '/post/5/a.jpg');
    expect(second).toEqual({ ok: true });
    expect(mockPool.query.mock.calls.length).toBe(calls);
  });

  test('code/mount/path 任一变体均不命中缓存，各自重新查库', async () => {
    mockQueryBySql([
      [/share_links/, [[{ type: 'post', target_id: 5 }]]],
      [/post_media/, [[{ media_url: '/uploads/post/5/a.jpg', thumb_url: null }]]]
    ]);
    await verifyShareCode(mockPool, 'CACHE2', 'uploads', '/post/5/a.jpg');
    const calls = mockPool.query.mock.calls.length;
    await verifyShareCode(mockPool, 'CACHE2', 'uploads', '/post/5/b.jpg'); // path 不同
    await verifyShareCode(mockPool, 'CACHE2', 'assets/album', '/post/5/a.jpg'); // mount 不同
    await verifyShareCode(mockPool, 'CACHE2X', 'uploads', '/post/5/a.jpg'); // code 不同
    // 每个变体各触发 share_links + post_media 两次查询
    expect(mockPool.query.mock.calls.length).toBe(calls + 6);
  });

  test('invalid 结果同样入缓存，避免对无效码重复查库', async () => {
    mockQueryBySql([[/share_links/, [[]]]]);
    const first = await verifyShareCode(mockPool, 'CACHE3', 'uploads', '/post/5/a.jpg');
    expect(first).toEqual({ ok: false, reason: 'invalid' });
    const calls = mockPool.query.mock.calls.length;
    const second = await verifyShareCode(mockPool, 'CACHE3', 'uploads', '/post/5/a.jpg');
    expect(second).toEqual({ ok: false, reason: 'invalid' });
    expect(mockPool.query.mock.calls.length).toBe(calls);
  });

  test('TTL 窗口内命中缓存，过期后失效并重新查库', async () => {
    const realNow = Date.now;
    const fakeNow = { v: realNow() };
    jest.spyOn(Date, 'now').mockImplementation(() => fakeNow.v);
    try {
      mockQueryBySql([
        [/share_links/, [[{ type: 'post', target_id: 5 }]]],
        [/post_media/, [[{ media_url: '/uploads/post/5/a.jpg', thumb_url: null }]]]
      ]);
      fakeNow.v = 1000000;
      const first = await verifyShareCode(mockPool, 'CACHE4', 'uploads', '/post/5/a.jpg');
      expect(first).toEqual({ ok: true });
      const calls = mockPool.query.mock.calls.length;
      fakeNow.v += 1000; // 15s 内 → 缓存命中
      const hit = await verifyShareCode(mockPool, 'CACHE4', 'uploads', '/post/5/a.jpg');
      expect(hit).toEqual({ ok: true });
      expect(mockPool.query.mock.calls.length).toBe(calls);
      fakeNow.v += 15001; // 超 15s → 缓存过期，重新查库
      const expired = await verifyShareCode(mockPool, 'CACHE4', 'uploads', '/post/5/a.jpg');
      expect(expired).toEqual({ ok: true });
      expect(mockPool.query.mock.calls.length).toBe(calls + 2);
    } finally {
      jest.restoreAllMocks();
    }
  });

  test('Map 达上限后整表清空兜底；过期条目先行淘汰', async () => {
    const realNow = Date.now;
    const fakeNow = { v: realNow() };
    jest.spyOn(Date, 'now').mockImplementation(() => fakeNow.v);
    const fill = async (prefix, n) => {
      for (let i = 0; i < n; i++) {
        await verifyShareCode(mockPool, `${prefix}-${i}`, 'uploads', `/p/${i}.jpg`);
      }
    };
    try {
      mockQueryBySql([[/share_links/, [[]]]]);
      fakeNow.v = 3000000;
      // 填满 2000（上限检查在插入前，填满本身不触发淘汰）
      await fill('EVICT-A', 2000);

      // 场景①：全为新鲜条目时再写入 → 无过期可清 → 整表清空兜底
      const r1 = await verifyShareCode(mockPool, 'EVICT-TRIGGER', 'uploads', '/p/x.jpg');
      expect(r1).toEqual({ ok: false, reason: 'invalid' });
      // 清空后旧 key 缓存失效 → 重新查库
      const calls1 = mockPool.query.mock.calls.length;
      await verifyShareCode(mockPool, 'EVICT-A-0', 'uploads', '/p/0.jpg');
      expect(mockPool.query.mock.calls.length).toBe(calls1 + 1);
      // 上一行插回一条，size 已回到 2000 以下

      // 场景②：填满后把时间推到 TTL 之外 → 新写入触发逐条删除过期条目
      fakeNow.v = 4000000;
      await fill('EVICT-B', 2000);
      fakeNow.v = 4000000 + 15001;
      const r2 = await verifyShareCode(mockPool, 'EVICT-B2', 'uploads', '/p/x2.jpg');
      expect(r2).toEqual({ ok: false, reason: 'invalid' });
      // 逐条删除后 size 低于上限 → 未整表清空，EVICT-B2 正常入缓存
      const calls2 = mockPool.query.mock.calls.length;
      await verifyShareCode(mockPool, 'EVICT-B2', 'uploads', '/p/x2.jpg');
      expect(mockPool.query.mock.calls.length).toBe(calls2);
    } finally {
      jest.restoreAllMocks();
    }
  });
});

// ─────────────────────── P3-140 中间件兜底分支 ───────────────────────
describe('P3-140 uploads_auth 中间件兜底分支', () => {
  test('setupUploadsAuth：已登录用户（session.userId）放行', async () => {
    const app = express();
    app.use((req, res, next) => { req.session = { userId: 1 }; next(); });
    setupUploadsAuth(app);
    app.use('/uploads', (req, res) => res.json({ ok: true }));
    const r = await request(app).get('/uploads/post/5/a.jpg');
    expect(r.status).toBe(200);
  });

  test('setupAssetsAlbumAuth：已登录用户（session.userId）放行', async () => {
    const app = express();
    app.use((req, res, next) => { req.session = { userId: 1 }; next(); });
    setupAssetsAlbumAuth(app);
    app.use('/assets/album', (req, res) => res.json({ ok: true }));
    const r = await request(app).get('/assets/album/6/p.jpg');
    expect(r.status).toBe(200);
  });

  test('setupUploadsAuth：查询抛错时统一 401 兜底', async () => {
    const app = express();
    setupUploadsAuth(app);
    app.use('/uploads', (req, res) => res.json({ ok: true }));
    mockPool.query.mockImplementation(() => Promise.reject(new Error('db down')));
    const r = await request(app).get('/uploads/post/5/a.jpg').query({ share: 'X' });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('需要登录后才能访问该资源');
  });

  test('setupAssetsAlbumAuth：查询抛错时统一 401 兜底', async () => {
    const app = express();
    setupAssetsAlbumAuth(app);
    app.use('/assets/album', (req, res) => res.json({ ok: true }));
    mockPool.query.mockImplementation(() => Promise.reject(new Error('db down')));
    const r = await request(app).get('/assets/album/6/p.jpg').query({ share: 'X' });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('需要登录后才能访问该资源');
  });

  test('setupUploadsAuth：pool 缺失（getPool 空）时 401', async () => {
    const utils = require('../utils');
    const spy = jest.spyOn(utils, 'getPool').mockReturnValue(null);
    try {
      const app = express();
      setupUploadsAuth(app);
      app.use('/uploads', (req, res) => res.json({ ok: true }));
      const r = await request(app).get('/uploads/post/5/a.jpg').query({ share: 'X' });
      expect(r.status).toBe(401);
    } finally {
      spy.mockRestore();
    }
  });

  test('setupAssetsAlbumAuth：pool 缺失（getPool 空）时 401', async () => {
    const utils = require('../utils');
    const spy = jest.spyOn(utils, 'getPool').mockReturnValue(null);
    try {
      const app = express();
      setupAssetsAlbumAuth(app);
      app.use('/assets/album', (req, res) => res.json({ ok: true }));
      const r = await request(app).get('/assets/album/6/p.jpg').query({ share: 'X' });
      expect(r.status).toBe(401);
    } finally {
      spy.mockRestore();
    }
  });
});

// ─────────────────────────── routes/files 拒绝路径 ───────────────────────────
describe('P2-153 routes/files 拒绝路径', () => {
  function filesApp() {
    const app = express();
    app.use(express.json());
    app.use('/api', filesRouter);
    return app;
  }

  test('DELETE 路径穿越（..%2F）拒绝', async () => {
    const realExists = fs.existsSync;
    const realUnlink = fs.promises.unlink;
    const unlinkSpy = jest.fn();
    fs.existsSync = jest.fn(() => true);
    fs.promises.unlink = unlinkSpy;
    try {
      const r = await request(filesApp()).delete('/api/admin/files/..%2F..%2F..%2Fetc%2Fpasswd');
      expect(r.status).toBe(400);
      expect(r.body.error.message).toBe('无效的文件路径');
      expect(unlinkSpy).not.toHaveBeenCalled();
    } finally {
      fs.existsSync = realExists;
      fs.promises.unlink = realUnlink;
    }
  });

  test('DELETE 目标不存在 404', async () => {
    const realExists = fs.existsSync;
    const realUnlink = fs.promises.unlink;
    const unlinkSpy = jest.fn();
    fs.existsSync = jest.fn(() => false);
    fs.promises.unlink = unlinkSpy;
    try {
      const r = await request(filesApp()).delete('/api/admin/files/nope.txt');
      expect(r.status).toBe(404);
      expect(r.body.error.message).toBe('文件不存在');
      expect(unlinkSpy).not.toHaveBeenCalled();
    } finally {
      fs.existsSync = realExists;
      fs.promises.unlink = realUnlink;
    }
  });

  test('download 路径穿越拒绝', async () => {
    const realExists = fs.existsSync;
    fs.existsSync = jest.fn(() => false);
    try {
      const r = await request(filesApp()).get('/api/admin/files/..%2F..%2F..%2Fwindows%2Fwin.ini/download');
      expect(r.status).toBe(400);
    } finally {
      fs.existsSync = realExists;
    }
  });

  test('create-dir parent 穿越拒绝', async () => {
    const realExists = fs.existsSync;
    const realMkdir = fs.mkdirSync;
    fs.existsSync = jest.fn(() => true);
    fs.mkdirSync = jest.fn();
    try {
      const r = await request(filesApp())
        .post('/api/admin/files/create-dir')
        .send({ name: 'x', parent: '../../..' });
      expect(r.status).toBe(400);
      expect(fs.mkdirSync).not.toHaveBeenCalled();
    } finally {
      fs.existsSync = realExists;
      fs.mkdirSync = realMkdir;
    }
  });

  test('cleanup days 参数非法拒绝（NaN/-1/超上限）', async () => {
    for (const days of ['abc', -1, 4000]) {
      const r = await request(filesApp()).post('/api/admin/files/cleanup').send({ days });
      expect(r.status).toBe(400);
      expect(r.body.error.message).toContain('days 参数无效');
    }
  });

  test('rename 穿越与目标已存在拒绝', async () => {
    const realExists = fs.existsSync;
    const realRename = fs.promises.rename;
    fs.promises.rename = jest.fn();
    try {
      // 源路径穿越
      fs.existsSync = jest.fn(() => false);
      let r = await request(filesApp()).post('/api/admin/files/rename').send({ filepath: '../../x.txt', newName: 'y.txt' });
      expect(r.status).toBe(400);

      // 新名称穿越（源存在，目标穿越）
      fs.existsSync = jest.fn((p) => String(p).includes('x.txt') && !String(p).includes('..'));
      r = await request(filesApp()).post('/api/admin/files/rename').send({ filepath: 'x.txt', newName: '../y.txt' });
      expect(r.status).toBe(400);

      // 目标已存在
      fs.existsSync = jest.fn(() => true);
      r = await request(filesApp()).post('/api/admin/files/rename').send({ filepath: 'x.txt', newName: 'y.txt' });
      expect(r.status).toBe(409);
    } finally {
      fs.existsSync = realExists;
      fs.promises.rename = realRename;
    }
  });
});

// ─────────────────────────── routes/backups 穿越拦截与错误映射 ───────────────────────────
describe('P2-153 routes/backups 穿越拦截与错误映射', () => {
  function backupsApp() {
    const app = express();
    app.use(express.json());
    app.use('/api', backupsRouter);
    return app;
  }

  test('download/delete/restore 均以 basename 归一化拦截穿越', async () => {
    const realExists = fs.existsSync;
    fs.existsSync = jest.fn(() => false);
    try {
      const r1 = await request(backupsApp()).get('/api/admin/backups/..%2F..%2F..%2Fetc%2Fpasswd/download');
      expect(r1.status).toBe(400);
      expect(r1.body.error.message).toBe('无效的备份文件名');

      const r2 = await request(backupsApp()).delete('/api/admin/backups/..%2F..%2F..%2Fetc%2Fpasswd');
      expect(r2.status).toBe(400);

      const r3 = await request(backupsApp()).post('/api/admin/backups/restore/..%2F..%2F..%2Fetc%2Fpasswd');
      expect(r3.status).toBe(400);
      expect(mockRestoreBackup).not.toHaveBeenCalled();
    } finally {
      fs.existsSync = realExists;
    }
  });

  test('download 不存在的备份 404', async () => {
    const realExists = fs.existsSync;
    fs.existsSync = jest.fn(() => false);
    try {
      const r = await request(backupsApp()).get('/api/admin/backups/auto_x.sql/download');
      expect(r.status).toBe(404);
    } finally {
      fs.existsSync = realExists;
    }
  });

  test('create 委托 backup-core 并返回元信息', async () => {
    mockCreateBackup.mockResolvedValue({
      filename: 'db_2026.sql', size: 1024, sizeFormatted: '1.0 KB', createdAt: '2026-01-01T00:00:00.000Z'
    });
    const r = await request(backupsApp()).post('/api/admin/backups/create');
    expect(r.status).toBe(200);
    expect(r.body.filename).toBe('db_2026.sql');
    expect(mockCreateBackup).toHaveBeenCalled();
  });

  test('cleanup 委托 cleanupAutoBackups 并回显删除数', async () => {
    const realExists = fs.existsSync;
    fs.existsSync = jest.fn(() => true);
    try {
      mockCleanup.mockReturnValue(3);
      const r = await request(backupsApp()).post('/api/admin/backups/cleanup').send({ keepDays: 7 });
      expect(r.status).toBe(200);
      expect(r.body.deleted).toBe(3);
      expect(mockCleanup).toHaveBeenCalledWith(7);
    } finally {
      fs.existsSync = realExists;
    }
  });

  test('restore 成功路径委托 backup-core', async () => {
    mockRestoreBackup.mockResolvedValue({ filename: 'ok.sql', message: '数据库恢复成功' });
    const r = await request(backupsApp()).post('/api/admin/backups/restore/ok.sql');
    expect(r.status).toBe(200);
    expect(r.body.message).toBe('数据库恢复成功');
  });
});