/**
 * P2-69：代表批次端点集成测试（app 级 supertest）。
 * 启动模板与 server-app.test.js 一致：NODE_ENV=test 下 require('../server')
 * 拿完整装配的 app（MemoryStore session、require.main 守卫不监听端口）。
 * 本文件只收无数据库依赖、结果确定的端点：
 *   - GET /api/client-config    公开，WS_URL 环境透传
 *   - GET /api/setup/check      公开，仅读 fs，断言信封字段形状（不断言环境值）
 *   - requireAuth 匿名 GET      统一 401 JSON 信封（auth.js fail → {success:false,error}）
 * 另含 P2-67 建站向导隔离守卫的静态防回退断言。
 */
process.env.NODE_ENV = 'test';

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../server');

describe('P2-69 GET /api/client-config（WS 地址环境透传）', () => {
  const original = process.env.WS_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.WS_URL;
    else process.env.WS_URL = original;
  });

  test('未设置 WS_URL 时返回空串（前端按当前协议自动探测）', async () => {
    delete process.env.WS_URL;
    const res = await request(app).get('/api/client-config');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ wsUrl: '' });
  });

  test('WS_URL 在请求时读取并原样透传', async () => {
    process.env.WS_URL = 'wss://relay.example.test/ws';
    const res = await request(app).get('/api/client-config');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ wsUrl: 'wss://relay.example.test/ws' });
  });
});

describe('P2-69 GET /api/setup/check（安装态探测信封）', () => {
  test('六个契约字段齐全且类型稳定（值随部署环境变化，不锁死）', async () => {
    const res = await request(app).get('/api/setup/check');
    expect(res.status).toBe(200);
    expect(typeof res.body.configured).toBe('boolean');
    expect(typeof res.body.envValid).toBe('boolean');
    expect(Array.isArray(res.body.missingEnvKeys)).toBe(true);
    expect(typeof res.body.wizardCompleted).toBe('boolean');
    expect(res.body.authenticated).toBe(false);
    expect(res.body.isSuperAdmin).toBe(false);
  });
});

describe('P2-69 requireAuth 匿名 GET 统一 401 JSON 信封', () => {
  test.each([
    '/api/stats',
    '/api/notifications/settings'
  ])('%s 未登录应得 401 + {success:false,error}', async (url) => {
    const res = await request(app).get(url);
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toMatchObject({ success: false, error: '请先登录' });
  });
});

describe('P2-67 建站向导状态端点的超管隔离守卫（静态防回退）', () => {
  const setupSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'setup.js'), 'utf8');

  test('GET /setup/state：已安装且非超管会话 → restricted 空草稿', () => {
    const getStart = setupSrc.indexOf("router.get('/setup/state'");
    const postStart = setupSrc.indexOf("router.post('/setup/state'");
    expect(getStart).toBeGreaterThan(-1);
    expect(postStart).toBeGreaterThan(getStart);
    const getBlock = setupSrc.slice(getStart, postStart);
    expect(getBlock).toContain('isSiteInstalled() && !isSuperAdminSession(req)');
    expect(getBlock).toContain('restricted: true');
  });

  test('POST /setup/state：已安装且非超管会话 → 403 拒绝写入草稿', () => {
    const postStart = setupSrc.indexOf("router.post('/setup/state'");
    const postBlock = setupSrc.slice(postStart, postStart + 1200);
    expect(postBlock).toContain('isSiteInstalled() && !isSuperAdminSession(req)');
    expect(postBlock).toContain('403');
  });
});
