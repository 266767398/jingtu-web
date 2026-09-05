/**
 * P2-1：server.js 整机（app 级）集成测试。
 * 与 router 级套件（jest.mock 掉 utils/auth 后拼临时 express）不同，这里直接
 * require('../server') 拿到完整装配的 app，走真实中间件链：
 *   安全响应头 → ddosLimiter → /api no-store → apiVersion → WAF → session → CSRF → 路由 → 404 兜底
 * 环境约定（NODE_ENV=test，由 Jest 自动设置并在本文件顶部显式兜底）：
 *   - server.js 用 MemoryStore session（不依赖 MySQL，也避开 express-mysql-session 未 unref 的定时器）
 *   - require.main 守卫使 require 不触发端口监听 / 信号接管 / 启动初始化
 * 只覆盖无数据库依赖的确定性路径（存活探针、404 包络、CSRF 签发与拦截、响应头契约）。
 */
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../server');

describe('P2-1 server.js 整机集成（app 级 supertest）', () => {
  test('GET /api/health/live 存活探针：200 + {status:alive}，不依赖数据库', async () => {
    const res = await request(app).get('/api/health/live');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'alive' });
  });

  test('存活探针携带完整响应头契约：X-API-Version、安全头、no-store 缓存策略', async () => {
    const res = await request(app).get('/api/health/live');
    expect(res.headers['x-api-version']).toBe('v1');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    // API 一律 no-store：防止 ETag/304 破坏前端 res.ok 语义的历史回归（见 server.js 注释）
    expect(res.headers['cache-control']).toBe('no-store, no-cache, must-revalidate');
    expect(res.headers['pragma']).toBe('no-cache');
    // HSTS 仅生产环境启用，测试环境不应出现
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  test('显式版本前缀 /api/v1、/api/v2 正确剥离路径并回写 X-API-Version', async () => {
    const v1 = await request(app).get('/api/v1/health/live');
    expect(v1.status).toBe(200);
    expect(v1.body).toEqual({ status: 'alive' });
    expect(v1.headers['x-api-version']).toBe('v1');

    const v2 = await request(app).get('/api/v2/health/live');
    expect(v2.status).toBe(200);
    expect(v2.headers['x-api-version']).toBe('v2');
  });

  test('未知 /api 路由返回 404 中文 JSON 包络（全局兜底，非 Express 默认 HTML）', async () => {
    const res = await request(app).get('/api/definitely-not-a-route');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ success: false, error: '请求的资源不存在' });
  });

  test('非 API 未匹配路径返回 404 中文 HTML 页面（P2-4 全局兜底，非 Express 默认英文）', async () => {
    const res = await request(app).get('/definitely-not-a-page');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('页面不存在');
    expect(res.text).not.toMatch(/Cannot GET/i);
  });

  test('CORS 默认拒绝未授权跨域来源：不回写 Access-Control-Allow-Origin', async () => {
    const res = await request(app)
      .get('/api/health/live')
      .set('Origin', 'https://evil.example.com');
    // 服务端照常应答（拦截由浏览器执行），但绝不回写 ACAO 头
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('GET /api/csrf-token 签发 CSRF token（纯内存签发，不依赖数据库）', async () => {
    const res = await request(app).get('/api/csrf-token');
    expect(res.status).toBe(200);
    expect(typeof res.body.csrfToken).toBe('string');
    expect(res.body.csrfToken.length).toBeGreaterThanOrEqual(16);
  });

  test('非豁免 POST 缺少 CSRF token 时在到达路由前被 403 拦截', async () => {
    const res = await request(app)
      .post('/api/definitely-not-a-route')
      .send({ foo: 'bar' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'CSRF token 无效' });
  });
});
