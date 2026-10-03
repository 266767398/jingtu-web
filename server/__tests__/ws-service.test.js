/**
 * P3-96: ws_service.js 导出函数行为测试
 * 覆盖：broadcastToUser（在线/离线/死连接清理）、getOnlineUsers 状态快照、
 * broadcastOnlineUsers（_wss 未启动时静默）、gracefulShutdown 幂等安全、
 * getRtcRoomStats 空房统计、invalidateGroupMemberCache 安全调用。
 * 通过 jest.mock 隔离 ws/express-session/cookie/utils/logger，无需真实 WebSocket。
 */
jest.mock('ws', () => ({ WebSocketServer: jest.fn() }));
jest.mock('express-session', () => jest.fn(() => (req, res, next) => next()));
jest.mock('cookie', () => ({ parse: jest.fn(), serialize: jest.fn() }));
jest.mock('cookie-signature', () => ({ unsign: jest.fn(), sign: jest.fn() }));
jest.mock('../utils', () => ({ getPool: jest.fn(() => ({ query: jest.fn().mockResolvedValue([[]]) })) }));
jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const wsService = require('../ws_service');

function fakeWs(readyState = 1) {
  return { readyState, send: jest.fn(), close: jest.fn(), terminate: jest.fn(), userId: null };
}

beforeEach(() => {
  jest.clearAllMocks();
  wsService.userWsMap.clear();
  wsService.onlineUsers.clear();
});

describe('P3-96 broadcastToUser 推送', () => {
  test('用户不在线时静默返回', () => {
    expect(() => wsService.broadcastToUser(999, { type: 'notification', payload: {} })).not.toThrow();
  });

  test('在线用户收到 JSON 消息', () => {
    const ws = fakeWs(1);
    wsService.userWsMap.set(42, new Set([ws]));
    wsService.onlineUsers.set(42, { displayName: 'A', avatarUrl: '', lastPing: Date.now() });
    wsService.broadcastToUser(42, { type: 'notification', payload: { title: 'hi' } });
    expect(ws.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(ws.send.mock.calls[0][0]);
    expect(sent.type).toBe('notification');
  });

  test('死连接被移除，全部死亡后清空用户状态', () => {
    const dead = fakeWs(3); // CLOSED
    wsService.userWsMap.set(7, new Set([dead]));
    wsService.onlineUsers.set(7, { displayName: 'B', avatarUrl: '', lastPing: 0 });
    wsService.broadcastToUser(7, { type: 'notification', payload: {} });
    expect(wsService.userWsMap.has(7)).toBe(false);
    expect(wsService.onlineUsers.has(7)).toBe(false);
  });

  test('send 抛错时同样清理该连接', () => {
    const bad = fakeWs(1);
    bad.send = jest.fn(() => { throw new Error('socket closed'); });
    const good = fakeWs(1);
    wsService.userWsMap.set(8, new Set([bad, good]));
    wsService.onlineUsers.set(8, { displayName: 'C', avatarUrl: '', lastPing: 0 });
    wsService.broadcastToUser(8, { type: 'notification', payload: {} });
    expect(good.send).toHaveBeenCalledTimes(1);
    expect(bad.send).toHaveBeenCalled();
    expect(wsService.userWsMap.get(8).has(bad)).toBe(false);
  });
});

describe('P3-96 getOnlineUsers / broadcastOnlineUsers / 状态查询', () => {
  test('getOnlineUsers 返回用户快照', () => {
    wsService.onlineUsers.set(1, { displayName: '甲', avatarUrl: '/a.png', lastPing: 100 });
    wsService.onlineUsers.set(2, { displayName: '乙', avatarUrl: '/b.png', lastPing: 200 });
    const list = wsService.getOnlineUsers();
    expect(list).toHaveLength(2);
    expect(list.find(u => u.userId === 1).displayName).toBe('甲');
  });

  test('broadcastOnlineUsers 在 _wss 未初始化时静默（不抛错）', () => {
    expect(() => wsService.broadcastOnlineUsers()).not.toThrow();
  });

  test('gracefulShutdown 在无 _wss 时安全幂等', () => {
    expect(() => wsService.gracefulShutdown()).not.toThrow();
    expect(() => wsService.gracefulShutdown()).not.toThrow();
  });

  test('getRtcRoomStats 空房统计结构', () => {
    const stats = wsService.getRtcRoomStats();
    expect(stats.roomCount).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(stats.rooms)).toBe(true);
  });

  test('invalidateGroupMemberCache 安全调用', () => {
    expect(() => wsService.invalidateGroupMemberCache(5)).not.toThrow();
  });
});