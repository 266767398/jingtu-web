/**
 * 安全函数单元测试（纯函数，无需数据库）
 * 运行：node --test server/test
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 在加载被测模块之前，拦截会启动定时器/网络连接的模块，避免进程挂起（不改源码）
const Module = require('module');
const _origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === './db') {
    return { holder: { pool: null }, DB_NAME: '', DB_CONFIG: {}, getPool: () => null, recreatePool: () => {} };
  }
  if (request === './security_alert') {
    return {
      setNotificationService() {}, onLoginFailure() {}, onSuspiciousRequest() {},
      onRateLimitTriggered() {}, onCsrfFailure() {}, onSecurityBreach() {}, getStats() {}
    };
  }
  if (request === 'express-rate-limit') {
    // 被测函数均不依赖限流中间件，stub 掉以移除其加载时创建的句柄，保证测试进程干净退出
    return function rateLimit() { return (req, res, next) => next(); };
  }
  return _origLoad.call(this, request, parent, isMain);
};

const { validateUploadFile, suspiciousRequestDetector } = require('../middleware/security');
const { secureUpload } = require('../utils');

// ---------- 辅助：临时文件 ----------
function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jingtu-sec-test-'));
}
function writeTempFile(dir, name, buf) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, buf);
  return p;
}
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const PHP_MAGIC = Buffer.from('<?php exit; ?>', 'utf8');

// ---------- 桩 ----------
function makeRes() {
  const res = {};
  res.statusCode = null;
  res.body = null;
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { res.body = obj; return res; };
  return res;
}
function makeNext() {
  const next = (arg) => { next.called = true; next.arg = arg; };
  next.called = false;
  next.arg = undefined;
  return next;
}

// ================= 任务一.1 validateUploadFile =================
test('validateUploadFile: 合法 PNG 通过校验', async () => {
  const dir = makeTempDir();
  const p = writeTempFile(dir, 'ok.png', Buffer.concat([PNG_MAGIC, Buffer.from('payload')]));
  const file = { originalname: 'ok.png', mimetype: 'image/png', size: 100, path: p };
  const result = await validateUploadFile(file, 200 * 1024 * 1024);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(result.valid, true);
  assert.deepStrictEqual(result.errors, []);
});

test('validateUploadFile: 伪装 PNG（扩展名合法但魔数不符）被拦截', async () => {
  const dir = makeTempDir();
  const p = writeTempFile(dir, 'evil.png', PHP_MAGIC);
  const file = { originalname: 'evil.png', mimetype: 'image/png', size: 100, path: p };
  const result = await validateUploadFile(file, 200 * 1024 * 1024);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(result.valid, false);
  assert.ok(Array.isArray(result.errors) && result.errors.length > 0);
});

test('validateUploadFile: 危险扩展名 evil.exe 被拦截', async () => {
  const file = { originalname: 'evil.exe', mimetype: 'application/x-msdownload', size: 100 };
  const result = await validateUploadFile(file, 200 * 1024 * 1024);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.length > 0);
});

// ================= 任务一.2 suspiciousRequestDetector =================
test('suspiciousRequestDetector: 试探 /.env 被拦截（next 不调用，404）', () => {
  const req = { url: '/.env', method: 'GET', headers: {}, ip: '1.2.3.4', path: '/.env' };
  const res = makeRes();
  const next = makeNext();
  suspiciousRequestDetector(req, res, next);
  assert.strictEqual(next.called, false);
  assert.strictEqual(res.statusCode, 404);
});

test('suspiciousRequestDetector: 试探 /.git/config 被拦截（next 不调用，404）', () => {
  const req = { url: '/.git/config', method: 'GET', headers: {}, ip: '1.2.3.4', path: '/.git/config' };
  const res = makeRes();
  const next = makeNext();
  suspiciousRequestDetector(req, res, next);
  assert.strictEqual(next.called, false);
  assert.strictEqual(res.statusCode, 404);
});

test('suspiciousRequestDetector: 合法嵌套路由 /api/admin/analytics/system 不被误伤', () => {
  const req = { url: '/api/admin/analytics/system?x=1', method: 'GET', headers: {}, ip: '1.2.3.4', path: '/api/admin/analytics/system' };
  const res = makeRes();
  const next = makeNext();
  suspiciousRequestDetector(req, res, next);
  assert.strictEqual(next.called, true);
  assert.strictEqual(res.statusCode, null);
});

// ================= 任务一.3 secureUpload =================
// secureUpload 在伪装文件时不调用 next/cb，只 res.status(400)，故等待“next 或 status 任一触发”
function runSecureUpload(wrap, req) {
  return new Promise((resolve) => {
    const res = makeRes();
    const next = (arg) => resolve({ nextCalled: true, nextArg: arg, res });
    res.status = (code) => { res.statusCode = code; resolve({ nextCalled: false, nextArg: undefined, res }); return res; };
    wrap(req, res, next);
  });
}

test('secureUpload: 合法文件 → next 被调用', async () => {
  const dir = makeTempDir();
  const p = writeTempFile(dir, 'ok.png', Buffer.concat([PNG_MAGIC, Buffer.from('payload')]));
  const fakeMulter = (req, res, cb) => {
    req.file = { originalname: 'ok.png', mimetype: 'image/png', size: 100, path: p };
    cb(null);
  };
  const wrap = secureUpload(fakeMulter, { maxSize: 200 * 1024 * 1024 });
  const { nextCalled } = await runSecureUpload(wrap, {});
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(nextCalled, true);
});

test('secureUpload: 伪装文件 → 返回 400、next 不被调用、临时文件被清理', async () => {
  const dir = makeTempDir();
  const p = writeTempFile(dir, 'evil.png', PHP_MAGIC);
  const fakeMulter = (req, res, cb) => {
    req.file = { originalname: 'evil.png', mimetype: 'image/png', size: 100, path: p };
    cb(null);
  };
  const wrap = secureUpload(fakeMulter, { maxSize: 200 * 1024 * 1024 });
  const { nextCalled, res } = await runSecureUpload(wrap, {});
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(fs.existsSync(p), false, '伪装文件应被删除');
  fs.rmSync(dir, { recursive: true, force: true });
});

// 保险：node --test 在本环境下因残留 IPC 句柄不会自动退出，用 unref 定时器在测试结束后强制干净退出
const _exitTimer = setTimeout(() => process.exit(0), 5000);
if (typeof _exitTimer.unref === 'function') _exitTimer.unref();
