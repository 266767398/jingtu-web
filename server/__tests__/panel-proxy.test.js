/**
 * P3-96: panel_proxy.js 行为测试
 * 覆盖：/ops 入口先过超管鉴权（requireSuperAdmin 先执行）、
 * proxyToPanel 成功透传（状态码/头/管道）、GET/HEAD 首次失败自动拉起后重试、
 * 非幂等方法失败直接 502、重试仍失败 502。
 * 通过 mock http.request 控制上游行为，避免真实网络。
 */
jest.mock('http', () => ({ request: jest.fn() }));

const http = require('http');
const { setupPanelProxy } = require('../panel_proxy');

function fakeProxyRes(statusCode = 200) {
  return { statusCode, headers: { 'content-type': 'text/plain' }, pipe: jest.fn(), resume: jest.fn() };
}
function fakeProxyReq() {
  const handlers = {};
  return {
    on(ev, h) { handlers[ev] = h; },
    emit(ev, ...args) { handlers[ev] && handlers[ev](...args); },
    end: jest.fn(),
    destroy: jest.fn(),
    _handlers: handlers
  };
}
// trySpawnPanelServer 的 /api/bootstrap 探测与 proxyToPanel 的透传都会走 http.request，
// 统一从 calls 中筛出「非探测」的代理调用
const proxyCalls = () => http.request.mock.calls.filter(c => c[0].path !== '/api/bootstrap');

const app = {
  use: jest.fn()
};

beforeEach(() => {
  jest.clearAllMocks();
  http.request.mockClear();
});

describe('P3-96 setupPanelProxy 挂载', () => {
  test('挂载 /ops/ 并先经过 requireSuperAdmin', () => {
    setupPanelProxy(app, { ROOT_DIR: '/tmp/root', requireSuperAdmin: jest.fn() });
    expect(app.use).toHaveBeenCalledWith('/ops/', expect.any(Function), expect.any(Function));
  });

  test('未授权用户被 requireSuperAdmin 拦截，不触发代理', () => {
    const app2 = { use: jest.fn() };
    const requireSuperAdmin = jest.fn((req, res) => res.status(403).json({ ok: false }));
    setupPanelProxy(app2, { ROOT_DIR: '/tmp/root', requireSuperAdmin });
    const [, guard, handler] = app2.use.mock.calls[0];
    const req = { method: 'GET', url: '/ops/api', headers: { host: 'localhost' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    guard(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('授权通过后进入代理处理', () => {
    const app3 = { use: jest.fn() };
    const requireSuperAdmin = jest.fn((req, res, next) => next());
    const trySpawnSpy = jest.fn();
    setupPanelProxy(app3, { ROOT_DIR: '/tmp/root', requireSuperAdmin });
    const [, guard, handler] = app3.use.mock.calls[0];
    const req = { method: 'GET', url: '/ops/api', headers: { host: 'localhost' }, pipe: jest.fn() };
    const res = { writeHead: jest.fn(), json: jest.fn(), headersSent: false };
    guard(req, res, jest.fn());
    expect(requireSuperAdmin).toHaveBeenCalled();
  });
});

describe('P3-96 proxyToPanel 透传与失败', () => {
  function mountApp() {
    const uses = [];
    const appMock = { use: jest.fn((path, guard, handler) => { uses.push({ path, guard, handler }); }) };
    setupPanelProxy(appMock, { ROOT_DIR: '/tmp/root', requireSuperAdmin: (req, res, next) => next() });
    return uses[0];
  }

  // 模拟 Express 链式执行：guard 通过 next 后进入 handler
  function dispatch(entry, req, res) {
    entry.guard(req, res, () => entry.handler(req, res));
  }

  test('上游 200：写入状态码与头并管道', async () => {
    jest.useFakeTimers();
    const entry = mountApp();
    const proxyRes = fakeProxyRes(200);
    const proxyReq = fakeProxyReq();
    http.request.mockImplementation((opts, cb) => {
      if (opts.path === '/api/bootstrap') return fakeProxyReq(); // 探测请求
      cb(proxyRes);
      return proxyReq;
    });
    const res = { writeHead: jest.fn(), json: jest.fn(), headersSent: false, end: jest.fn(), status: jest.fn().mockReturnThis() };
    const req = { method: 'GET', url: '/ops/api/list?x=1', headers: { host: 'example.com' }, pipe: jest.fn() };
    dispatch(entry, req, res);
    const proxyReqCall = proxyCalls().find(c => c[0].path.includes('/api/list'));
    expect(proxyReqCall).toBeDefined();
    const opts = proxyReqCall[0];
    expect(opts.path).toBe('/api/list?x=1');
    expect(opts.host).toBe('127.0.0.1');
    expect(res.writeHead).toHaveBeenCalledWith(200, proxyRes.headers);
    expect(proxyRes.pipe).toHaveBeenCalledWith(res);
    expect(proxyReq.end).toHaveBeenCalled(); // GET 直发
    jest.advanceTimersByTime(12000);
    jest.useRealTimers();
  });

  test('代理透传注入 x-real-ip / x-ops-proxy 可信标记并改写 host', async () => {
    jest.useFakeTimers();
    const entry = mountApp();
    const proxyRes = fakeProxyRes(200);
    const proxyReq = fakeProxyReq();
    http.request.mockImplementation((opts, cb) => {
      if (opts.path === '/api/bootstrap') return fakeProxyReq();
      cb(proxyRes);
      return proxyReq;
    });
    const res = { writeHead: jest.fn(), json: jest.fn(), headersSent: false, end: jest.fn(), status: jest.fn().mockReturnThis() };
    const req = { method: 'GET', url: '/ops/api/list', headers: { host: 'example.com' }, ip: '203.0.113.7', pipe: jest.fn() };
    dispatch(entry, req, res);
    const call = proxyCalls().find(c => c[0].path.includes('/api/list'));
    expect(call).toBeDefined();
    const opts = call[0];
    expect(opts.headers['x-ops-proxy']).toBe('1');
    expect(opts.headers['x-real-ip']).toBe('203.0.113.7');
    expect(opts.headers.host).toBe('127.0.0.1:3457');
    jest.advanceTimersByTime(12000);
    jest.useRealTimers();
  });

  test('非 GET/HEAD 首错：不重试，直接 502', async () => {
    jest.useFakeTimers();
    const entry = mountApp();
    const proxyReq = fakeProxyReq();
    http.request.mockImplementation((opts) => (opts.path === '/api/bootstrap' ? fakeProxyReq() : proxyReq));
    const res = { writeHead: jest.fn(), json: jest.fn(), headersSent: false, status: jest.fn().mockReturnThis() };
    const req = { method: 'POST', url: '/ops/write', headers: { host: 'example.com' }, pipe: jest.fn() };
    dispatch(entry, req, res);
    proxyReq.emit('error', new Error('ECONNREFUSED'));
    expect(res.json).toHaveBeenCalledWith({ ok: false, message: expect.stringContaining('运维面板不可达') });
    jest.advanceTimersByTime(12000);
    jest.useRealTimers();
  });

  test('GET 首错：自动拉起后 3s 重试一次，仍失败则 502', async () => {
    jest.useFakeTimers();
    const entry = mountApp();
    const proxyReqList = [fakeProxyReq(), fakeProxyReq()];
    let proxyIdx = 0;
    http.request.mockImplementation((opts) => {
      if (opts.path === '/api/bootstrap') return fakeProxyReq();
      return proxyReqList[proxyIdx++];
    });
    const res = { writeHead: jest.fn(), json: jest.fn(), headersSent: false, status: jest.fn().mockReturnThis() };
    const req = { method: 'GET', url: '/ops/api', headers: { host: 'example.com' }, pipe: jest.fn() };
    dispatch(entry, req, res);
    proxyReqList[0].emit('error', new Error('ECONNREFUSED'));
    expect(proxyCalls()).toHaveLength(1);
    jest.advanceTimersByTime(3000);
    expect(proxyCalls()).toHaveLength(2); // 重试
    proxyReqList[1].emit('error', new Error('ECONNREFUSED'));
    expect(res.json).toHaveBeenCalledWith({ ok: false, message: expect.stringContaining('运维面板不可达') });
    // 推进 trySpawnPanelServer 的 10s 探测去重定时器，避免 open handle
    jest.advanceTimersByTime(12000);
    jest.useRealTimers();
  });

  test('timeout 事件销毁请求（不抛错）', () => {
    jest.useFakeTimers();
    const entry = mountApp();
    const proxyReq = fakeProxyReq();
    http.request.mockImplementation((opts) => (opts.path === '/api/bootstrap' ? fakeProxyReq() : proxyReq));
    const res = { writeHead: jest.fn(), json: jest.fn(), headersSent: false };
    const req = { method: 'GET', url: '/ops/api', headers: { host: 'example.com' }, pipe: jest.fn() };
    dispatch(entry, req, res);
    expect(() => proxyReq.emit('timeout')).not.toThrow();
    expect(proxyReq.destroy).toHaveBeenCalled();
    jest.advanceTimersByTime(12000);
    jest.useRealTimers();
  });
});