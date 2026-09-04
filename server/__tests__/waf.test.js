const express = require('express');
const request = require('supertest');

jest.mock('../logger', () => ({
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn()
}));

jest.mock('../security_alert', () => ({
  onSuspiciousRequest: jest.fn()
}));

const { wafMiddleware, detectAttack } = require('../middleware/waf');
const { onSuspiciousRequest } = require('../security_alert');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(wafMiddleware);
  app.post('/echo', (req, res) => res.json({ ok: true, body: req.body }));
  app.get('/echo', (req, res) => res.json({ ok: true, query: req.query }));
  return app;
}

describe('WAF 中间件', () => {
  beforeEach(() => jest.clearAllMocks());

  test('放行正常请求与讨论 SQL 的普通文本', async () => {
    const app = buildApp();
    const response = await request(app)
      .post('/echo')
      .send({ content: 'SELECT name FROM users 是常见查询写法', title: '数据库学习笔记' });
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(onSuspiciousRequest).not.toHaveBeenCalled();
  });

  test('拦截 JSON body 值中的 SQL 注入', async () => {
    const app = buildApp();
    const response = await request(app)
      .post('/echo')
      .send({ name: "' OR 1=1 --" });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('WAF_BLOCKED');
    expect(response.body.type).toBe('SQL注入');
    expect(onSuspiciousRequest).toHaveBeenCalledTimes(1);
  });

  test('拦截 JSON body 值中的 XSS', async () => {
    const app = buildApp();
    const response = await request(app)
      .post('/echo')
      .send({ bio: '<script>alert(1)</script>' });
    expect(response.status).toBe(403);
    expect(response.body.type).toBe('XSS攻击');
  });

  test('拦截 JSON body key 中的注入载荷', async () => {
    const app = buildApp();
    const response = await request(app)
      .post('/echo')
      .send({ 'onerror=alert(1)': 'x' });
    expect(response.status).toBe(403);
    expect(response.body.type).toBe('XSS攻击');
  });

  test('拦截 URL 编码的 XSS 载荷（解码复扫）', async () => {
    const app = buildApp();
    const response = await request(app)
      .post('/echo')
      .send({ comment: '%3Csvg onload%3E' });
    expect(response.status).toBe(403);
    expect(response.body.type).toBe('XSS攻击');
  });

  test('拦截双重 URL 编码载荷', async () => {
    const app = buildApp();
    const response = await request(app)
      .post('/echo')
      .send({ comment: '%253Cscript%253Ealert(1)%253C%252Fscript%253E' });
    expect(response.status).toBe(403);
    expect(response.body.type).toBe('XSS攻击');
  });

  test('拦截 query 中的编码路径遍历', async () => {
    const app = buildApp();
    const response = await request(app).get('/echo?path=..%2f..%2fetc%2fpasswd');
    expect(response.status).toBe(403);
    expect(response.body.type).toBe('路径遍历');
  });

  test('detectAttack 能识别嵌套 body 中的攻击', () => {
    const req = {
      url: '/api/posts',
      path: '/api/posts',
      body: { meta: { tags: ['普通', '<script>alert(1)</script>'] } },
      query: {},
      params: {},
      ip: '127.0.0.1'
    };
    const result = detectAttack(req);
    expect(result.detected).toBe(true);
    expect(result.type).toBe('XSS攻击');
    expect(result.source).toBe('Body');
  });

  test('畸形编码不会抛异常且按原文放行', async () => {
    const app = buildApp();
    const response = await request(app)
      .post('/echo')
      .send({ note: '进度 100% 完成，折扣 5%z%' });
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });
});
