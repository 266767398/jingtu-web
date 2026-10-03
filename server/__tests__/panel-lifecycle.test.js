/**
 * 运维面板生命周期测试
 * 覆盖：setupPanelLifecycle 挂载 /api/ops/start 与 /api/ops/status（先过超管鉴权）、
 * 空闲超时自动关闭面板进程（Windows taskkill / POSIX SIGTERM）、心跳保活刷新活动时间。
 * 通过 mock http.request 控制探测结果、mock child_process 控制 spawn/taskkill。
 *
 * 采用真实定时器 + waitFor 轮询：轮询间隔 / 空闲检查周期 / 空闲阈值都通过环境变量
 * 调成毫秒级（PANEL_START_POLL_MS / PANEL_IDLE_CHECK_SECONDS / PANEL_IDLE_MINUTES），
 * 避免 fake-timers 在「定时器回调内 clear 自身」场景下的原生竞态崩溃。
 */
jest.mock('http', () => ({ request: jest.fn() }));
jest.mock('child_process', () => ({ spawn: jest.fn(), spawnSync: jest.fn() }));

const path = require('path');

let http = require('http');
let childProcess = require('child_process');
// 指向真实项目根目录，保证 panel/panel-server.js 存在，doSpawnPanel 才能走到 spawn
const ROOT_DIR = path.resolve(__dirname, '..', '..');
const originalEnv = {
  PANEL_IDLE_MINUTES: process.env.PANEL_IDLE_MINUTES,
  PANEL_IDLE_CHECK_SECONDS: process.env.PANEL_IDLE_CHECK_SECONDS,
  PANEL_START_POLL_MS: process.env.PANEL_START_POLL_MS
};

function fakeProbeReq() {
  const handlers = {};
  return {
    on(ev, h) { handlers[ev] = h; },
    emit(ev, ...args) { if (handlers[ev]) handlers[ev](...args); },
    end: jest.fn(),
    destroy: jest.fn(),
    resume: jest.fn(),
    _handlers: handlers
  };
}
function fakeChild(pid) {
  return { pid, exitCode: null, signalCode: null, on: jest.fn(), unref: jest.fn() };
}

/** 让所有 /api/bootstrap 探测请求立即失败（模拟面板未运行） */
function failProbes() {
  http.request.mockImplementation((opts, cb) => {
    const req = fakeProbeReq();
    process.nextTick(() => req.emit('error', new Error('ECONNREFUSED')));
    return req;
  });
}
/** 让所有 /api/bootstrap 探测请求立即成功 */
function okProbes() {
  http.request.mockImplementation((opts, cb) => {
    const req = fakeProbeReq();
    process.nextTick(() => { if (cb) cb({ resume: jest.fn(), statusCode: 200 }); else req.emit('error', new Error('no-cb')); });
    return req;
  });
}

/** 重置模块缓存并重新取回 http/child_process 的 mock 实例（resetModules 会重建 mock 工厂） */
function freshModule() {
  jest.resetModules();
  const mod = require('../panel_proxy');
  http = require('http');
  childProcess = require('child_process');
  return mod;
}

/** 轮询等待条件成立（真实定时器，毫秒级间隔） */
async function waitFor(fn, timeoutMs = 3000, interval = 15) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fn()) return;
    } catch (e) { /* 继续轮询 */ }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error('waitFor 超时，条件未满足');
}

beforeEach(() => {
  // IDLE_MS≈60ms、空闲检查周期≈50ms、健康轮询≈5ms：全部落在真实毫秒级，测试无需长等
  process.env.PANEL_IDLE_MINUTES = '0.001';
  process.env.PANEL_IDLE_CHECK_SECONDS = '0.05';
  process.env.PANEL_START_POLL_MS = '5';
});

afterEach(() => {
  Object.keys(originalEnv).forEach((k) => {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  });
});

describe('运维面板生命周期 API', () => {
  test('挂载 /api/ops/start 与 /api/ops/status 并先经过 requireSuperAdmin', () => {
    const { setupPanelLifecycle, stopIdleMonitor } = freshModule();
    const app = { post: jest.fn(), get: jest.fn() };
    const requireSuperAdmin = jest.fn();
    setupPanelLifecycle(app, { ROOT_DIR, requireSuperAdmin });
    expect(app.post).toHaveBeenCalledWith('/api/ops/start', requireSuperAdmin, expect.any(Function));
    expect(app.get).toHaveBeenCalledWith('/api/ops/status', requireSuperAdmin, expect.any(Function));
    stopIdleMonitor(); // 清理定时器，避免 open handle
  });

  test('/api/ops/start 面板未运行：spawn 拉起并返回 running:true', async () => {
    const { setupPanelLifecycle, stopIdleMonitor } = freshModule();
    failProbes();
    childProcess.spawn.mockReturnValue(fakeChild(9001));
    const app = { post: jest.fn(), get: jest.fn() };
    setupPanelLifecycle(app, { ROOT_DIR, requireSuperAdmin: (r, s, n) => n() });
    const [, , handler] = app.post.mock.calls[0];
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    handler({}, res);
    // 首次探测失败 → doSpawnPanel → spawn；随后把探测切为成功，等待健康轮询回调
    await waitFor(() => childProcess.spawn.mock.calls.length > 0);
    okProbes();
    await waitFor(() => res.json.mock.calls.length > 0);
    expect(childProcess.spawn).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, running: true, pid: 9001 }));
    stopIdleMonitor();
  });

  test('/api/ops/start 面板已在运行：不再 spawn，直接返回 running:true', async () => {
    const { setupPanelLifecycle, stopIdleMonitor } = freshModule();
    okProbes();
    const app = { post: jest.fn(), get: jest.fn() };
    setupPanelLifecycle(app, { ROOT_DIR, requireSuperAdmin: (r, s, n) => n() });
    const [, , handler] = app.post.mock.calls[0];
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    handler({}, res);
    await waitFor(() => res.json.mock.calls.length > 0);
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, running: true }));
    stopIdleMonitor();
  });

  test('/api/ops/status 返回运行状态与空闲信息', async () => {
    const { setupPanelLifecycle, stopIdleMonitor } = freshModule();
    okProbes();
    const app = { post: jest.fn(), get: jest.fn() };
    setupPanelLifecycle(app, { ROOT_DIR, requireSuperAdmin: (r, s, n) => n() });
    const [, , handler] = app.get.mock.calls[0];
    const res = { json: jest.fn() };
    handler({}, res);
    await waitFor(() => res.json.mock.calls.length > 0);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, running: true, idleMinutes: 0 }));
    stopIdleMonitor();
  });
});

describe('空闲超时自动关闭', () => {
  test('面板为本模块拉起且空闲超时：Windows 下 taskkill 关闭进程', async () => {
    const { setupPanelLifecycle, stopIdleMonitor } = freshModule();
    failProbes();
    childProcess.spawn.mockReturnValue(fakeChild(4321));
    childProcess.spawnSync.mockReturnValue({ status: 0 });
    const app = { post: jest.fn(), get: jest.fn() };
    setupPanelLifecycle(app, { ROOT_DIR, requireSuperAdmin: (r, s, n) => n() });
    const [, , handler] = app.post.mock.calls[0];
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    handler({}, res);
    await waitFor(() => childProcess.spawn.mock.calls.length > 0); // 探测失败→spawn
    okProbes();
    await waitFor(() => res.json.mock.calls.length > 0); // start 成功并刷新活动时间
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ running: true, pid: 4321 }));
    // 空闲检查（≈50ms 周期）发现超过 IDLE_MS（≈60ms）无活动 → 自动关闭
    await waitFor(() => childProcess.spawnSync.mock.calls.length > 0);
    if (process.platform === 'win32') {
      expect(childProcess.spawnSync).toHaveBeenCalledWith('taskkill', expect.arrayContaining(['/pid', '4321']), expect.anything());
    }
    stopIdleMonitor();
  });
});