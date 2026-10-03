/**
 * P3-93: schedule.js 行为测试
 * 覆盖 getGroupStatsSnapshot（group_roster 聚合统计、空行回退、GROUP_ID 环境变量）、
 * forceRosterBroadcast（未注入 WS 服务短路、广播负载结构、异常捕获）。
 * 全部依赖（node-schedule/db/utils/vrc/cache_service/routes/collections）均 mock。
 */
process.env.GROUP_ID = 'grp_test_group';

jest.mock('node-schedule', () => ({
  scheduleJob: jest.fn(() => ({ cancel: jest.fn() }))
}));
jest.mock('../db', () => ({ holder: { pool: { query: jest.fn() } } }));
jest.mock('../utils', () => ({
  getPool: jest.fn(),
  safeError: jest.fn((msg) => msg)
}));
jest.mock('../vrc', () => ({
  vrchatGetUser: jest.fn(),
  vrchatResolveOnlineStatuses: jest.fn(),
  vrcBacklog: jest.fn()
}));
jest.mock('../cache_service', () => ({ get: jest.fn(), set: jest.fn() }));
jest.mock('../routes/collections', () => ({ scanAvatarModels: jest.fn() }));

const schedule = require('../schedule');
const { getPool } = require('../utils');

describe('P3-93 schedule.getGroupStatsSnapshot 聚合统计', () => {
  test('正常行：计算 webOnline/offline 派生指标', async () => {
    const pool = { query: jest.fn().mockResolvedValue([[{ total: 10, online: 7, ingame: 3, unknown: 2 }]]) };
    const result = await schedule.getGroupStatsSnapshot(pool);
    expect(result).toEqual([{
      groupId: 'grp_test_group',
      totalCount: 10,
      onlineCount: 7,
      inGameCount: 3,
      webOnlineCount: 4,
      offlineCount: 3,
      unknownCount: 2
    }]);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('SUM(is_member = 1)'));
  });

  test('空行/缺失字段回退为 0，SQL 带 vrchat_id 过滤', async () => {
    const pool = { query: jest.fn().mockResolvedValue([[{}]]) };
    const result = await schedule.getGroupStatsSnapshot(pool);
    expect(result[0]).toMatchObject({ totalCount: 0, onlineCount: 0, inGameCount: 0, unknownCount: 0 });
    const sql = pool.query.mock.calls[0][0];
    expect(sql).toContain('WHERE vrchat_id IS NOT NULL AND vrchat_id != \'\'');
  });

  test('rows 为空数组时同样回退为 0 不抛错', async () => {
    const pool = { query: jest.fn().mockResolvedValue([[]]) };
    const result = await schedule.getGroupStatsSnapshot(pool);
    expect(result[0].totalCount).toBe(0);
  });
});

describe('P3-93 schedule.forceRosterBroadcast 强制广播', () => {
  const poolMock = {
    query: jest.fn()
  };

  beforeEach(() => {
    jest.clearAllMocks();
    getPool.mockReturnValue(poolMock);
  });

  test('未注入 wsService 时短路返回，不查库', async () => {
    await schedule.forceRosterBroadcast('grp_x');
    expect(getPool).not.toHaveBeenCalled();
  });

  test('注入后：聚合 + 成员明细一并广播（forced:true）', async () => {
    const ws = { broadcastRosterUpdate: jest.fn() };
    schedule.setWsService(ws);
    poolMock.query
      .mockResolvedValueOnce([[{ total: 5, online: 3, ingame: 1, unknown: 1 }]])
      .mockResolvedValueOnce([[{
        vrchat_id: 'usr_1', is_online: 1, is_in_game: 0, vrchat_status: 'active',
        world_name: 'w1', is_friend: 1, status_description: 'hi'
      }]]);

    await schedule.forceRosterBroadcast('grp_x');

    expect(ws.broadcastRosterUpdate).toHaveBeenCalledTimes(1);
    const arg = ws.broadcastRosterUpdate.mock.calls[0][0];
    expect(arg.forced).toBe(true);
    expect(arg.groups[0]).toMatchObject({ totalCount: 5, onlineCount: 3, inGameCount: 1, webOnlineCount: 2, offlineCount: 2 });
    expect(arg.members[0]).toEqual({
      vrchatId: 'usr_1', isOnline: true, isInGame: false,
      status: 'active', statusDescription: 'hi', worldName: 'w1', isFriend: true
    });
  });

  test('成员缺失状态时回退 active/offline，布尔化 0/1', async () => {
    const ws = { broadcastRosterUpdate: jest.fn() };
    schedule.setWsService(ws);
    poolMock.query
      .mockResolvedValueOnce([[{ total: 2, online: 1, ingame: 0, unknown: 0 }]])
      .mockResolvedValueOnce([[{ vrchat_id: 'a', is_online: 0, is_in_game: 0, is_friend: 0 }]]);

    await schedule.forceRosterBroadcast('grp_x');
    const m = ws.broadcastRosterUpdate.mock.calls[0][0].members[0];
    expect(m).toMatchObject({ isOnline: false, isInGame: false, isFriend: false, status: 'offline', statusDescription: '', worldName: '' });
  });

  test('查询异常被捕获并记录，不向上抛', async () => {
    const ws = { broadcastRosterUpdate: jest.fn() };
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    schedule.setWsService(ws);
    poolMock.query.mockRejectedValueOnce(new Error('db down'));

    await expect(schedule.forceRosterBroadcast('grp_x')).resolves.toBeUndefined();
    expect(ws.broadcastRosterUpdate).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
