/**
 * F-24：routes/vrc_invites.js 新增写操作（/note 保存备注、/boop 发送 Boop）路由行为测试。
 * 覆盖：未绑定 cookie → NEED_BIND；非法目标 ID / 备注超长 → VALIDATION_ERROR；
 * 成功委托 vrchatSaveNote/vrchatBoop 并返回包装响应；上游非 2xx → sendVrcError 透传。
 * 通过 supertest + mock ../utils/../auth/../vrc 驱动，无真实 VRChat 调用。
 */
const express = require('express');
const request = require('supertest');

let mockCookie = 'auth=test-cookie';
let mockNoteRes = { status: 200, body: { success: { message: 'ok', status_code: 200 } } };
let mockBoopRes = { status: 200, body: { success: { message: 'User booped!', status_code: 200 } } };

jest.mock('../auth', () => ({
  requireAuth(req, res, next) { next(); }
}));

jest.mock('../utils', () => ({
  ok(res, fields) {
    return res.json(fields ? { success: true, ...fields } : { success: true });
  },
  fail(res, status, message, opts) {
    return res.status(status).json({ success: false, error: { code: (opts && opts.code) || 'BAD_REQUEST', message } });
  },
  sendVrcError(res, upstream) {
    return res.status(upstream.status || 502).json({ success: false, error: { code: 'VRC_UPSTREAM', message: `VRChat 上游错误 ${upstream.status}` } });
  },
  handleError(res, e) {
    return res.status(e.statusCode || 500).json({ success: false, error: { code: e.code || 'INTERNAL_ERROR', message: e.message } });
  },
  ErrorCodes: { NEED_BIND: 'NEED_BIND', VALIDATION_ERROR: 'VALIDATION_ERROR' }
}));

const mockSaveNote = jest.fn();
const mockBoop = jest.fn();
jest.mock('../vrc', () => ({
  vrchatSendInvite: jest.fn().mockResolvedValue({ status: 200 }),
  vrchatSendFriendRequest: jest.fn().mockResolvedValue({ status: 200 }),
  vrchatSaveNote: (...a) => mockSaveNote(...a),
  vrchatBoop: (...a) => mockBoop(...a),
  VRC_INSTANCE_PATTERN: /^wrld_[0-9a-fA-F-]+:/
}));

const routerFactory = require('../routes/vrc_invites');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/', routerFactory(() => mockCookie));
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCookie = 'auth=test-cookie';
  mockNoteRes = { status: 200, body: { success: { message: 'ok', status_code: 200 } } };
  mockBoopRes = { status: 200, body: { success: { message: 'User booped!', status_code: 200 } } };
  mockSaveNote.mockResolvedValue(mockNoteRes);
  mockBoop.mockResolvedValue(mockBoopRes);
});

describe('F-24 /api/vrc-invites/note 保存备注', () => {
  test('未绑定 cookie → 400 NEED_BIND，不调上游', async () => {
    mockCookie = null;
    const res = await request(makeApp()).post('/note').send({ targetUserId: 'usr_00000000-0000-0000-0000-000000000000', note: 'hi' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NEED_BIND');
    expect(mockSaveNote).not.toHaveBeenCalled();
  });

  test('非法目标 ID → 400 VALIDATION_ERROR', async () => {
    const res = await request(makeApp()).post('/note').send({ targetUserId: 'not-a-user', note: 'hi' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(mockSaveNote).not.toHaveBeenCalled();
  });

  test('备注超 512 字符 → 400 VALIDATION_ERROR', async () => {
    const res = await request(makeApp()).post('/note').send({ targetUserId: 'usr_00000000-0000-0000-0000-000000000000', note: 'x'.repeat(513) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(mockSaveNote).not.toHaveBeenCalled();
  });

  test('成功：委托 vrchatSaveNote(targetUserId, note, cookie)，返回包装', async () => {
    const res = await request(makeApp()).post('/note').send({ targetUserId: 'usr_00000000-0000-0000-0000-000000000000', note: '  老朋友  ' });
    expect(mockSaveNote).toHaveBeenCalledWith('usr_00000000-0000-0000-0000-000000000000', '老朋友', 'auth=test-cookie');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, saved: true, note: '老朋友' });
  });

  test('空备注（清除）也委托上游且成功返回', async () => {
    const res = await request(makeApp()).post('/note').send({ targetUserId: 'usr_00000000-0000-0000-0000-000000000000', note: '' });
    expect(mockSaveNote).toHaveBeenCalledWith('usr_00000000-0000-0000-0000-000000000000', '', 'auth=test-cookie');
    expect(res.status).toBe(200);
    expect(res.body.saved).toBe(true);
  });

  test('上游非 2xx → sendVrcError 透传（保留上游状态码）', async () => {
    mockSaveNote.mockResolvedValue({ status: 404, body: { error: { message: 'User not found', status_code: 404 } } });
    const res = await request(makeApp()).post('/note').send({ targetUserId: 'usr_00000000-0000-0000-0000-000000000000', note: 'hi' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('VRC_UPSTREAM');
  });
});

describe('F-24 /api/vrc-invites/boop 发送 Boop', () => {
  test('未绑定 cookie → 400 NEED_BIND，不调上游', async () => {
    mockCookie = null;
    const res = await request(makeApp()).post('/boop').send({ targetUserId: 'usr_00000000-0000-0000-0000-000000000000' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NEED_BIND');
    expect(mockBoop).not.toHaveBeenCalled();
  });

  test('非法目标 ID → 400 VALIDATION_ERROR', async () => {
    const res = await request(makeApp()).post('/boop').send({ targetUserId: 'xxx' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(mockBoop).not.toHaveBeenCalled();
  });

  test('成功：委托 vrchatBoop(targetUserId, cookie) 且不带 emojiId', async () => {
    const res = await request(makeApp()).post('/boop').send({ targetUserId: 'usr_00000000-0000-0000-0000-000000000000' });
    expect(mockBoop).toHaveBeenCalledWith('usr_00000000-0000-0000-0000-000000000000', 'auth=test-cookie', null);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, booped: true });
  });

  test('携带 emojiId 时透传给 vrchatBoop 第三参', async () => {
    await request(makeApp()).post('/boop').send({ targetUserId: 'usr_00000000-0000-0000-0000-000000000000', emojiId: 'file_abc' });
    expect(mockBoop).toHaveBeenCalledWith('usr_00000000-0000-0000-0000-000000000000', 'auth=test-cookie', 'file_abc');
  });

  test('上游非 2xx（如非好友 400）→ sendVrcError 透传', async () => {
    mockBoop.mockResolvedValue({ status: 400, body: { error: { message: 'These users are not friends', status_code: 400 } } });
    const res = await request(makeApp()).post('/boop').send({ targetUserId: 'usr_00000000-0000-0000-0000-000000000000' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VRC_UPSTREAM');
  });
});