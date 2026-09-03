/**
 * VRChat 上游错误精细化分类（P1-10，借鉴 VRCX $throw + shouldIgnoreError）。
 *
 * 用户症状（线上事故三类）：
 *   1. VRChat 限流（429）被归入 VRC_UPSTREAM_ERROR，前端无法区分"限流"与"真故障"，
 *      导致列表页反复重试、把账号打进更深的限流（雪崩）。
 *   2. cookie 过期 与 "需要两步验证(2FA)" 被混为一谈，2FA 场景也被当成过期处理。
 *   3. VRC_FETCH_FAILED 等已使用但未登记的 code，前端不识别为 VRChat 业务错误，
 *      可能误判为本地会话失效而踢人。
 *
 * 这里直接对 sendVrcError 纯函数做断言，不再依赖完整路由，聚焦错误归类本身。
 */

const { sendVrcError } = require('../utils');

// 构造一个收集 json 体的假 res
function fakeRes() {
  const res = {};
  res._json = null;
  res.status = (code) => { res._status = code; return res; };
  res.json = (body) => { res._json = body; return res; };
  return res;
}

describe('sendVrcError 错误码精细化分类', () => {
  test('429 限流 → VRC_RATE_LIMITED（不再混入 VRC_UPSTREAM_ERROR）', () => {
    const res = fakeRes();
    sendVrcError(res, { status: 429, data: { error: { message: 'Too Many Requests' } } }, '搜索世界');
    expect(res._json.code).toBe('VRC_RATE_LIMITED');
    expect(res._json.retryAfter).toBeGreaterThan(0);
    expect(res._status).toBe(429);
  });

  test('401 含 2FA 提示 → VRC_2FA_REQUIRED（不误判为 cookie 过期）', () => {
    const res = fakeRes();
    sendVrcError(res, { status: 401, data: { error: { message: 'You must use a two factor auth code to login' } } }, '同步群组');
    expect(res._json.code).toBe('VRC_2FA_REQUIRED');
    expect(res._json.code).not.toBe('VRC_COOKIE_EXPIRED');
  });

  test('401 普通 → VRC_COOKIE_EXPIRED', () => {
    const res = fakeRes();
    sendVrcError(res, { status: 401, data: { error: { message: 'Unauthorized' } } }, '同步群组');
    expect(res._json.code).toBe('VRC_COOKIE_EXPIRED');
  });

  test('5xx / 超时 → VRC_UPSTREAM_ERROR', () => {
    const res = fakeRes();
    sendVrcError(res, { status: 502, data: { error: { message: 'Bad Gateway' } } }, '搜索世界');
    expect(res._json.code).toBe('VRC_UPSTREAM_ERROR');
  });
});
