/**
 * P3-93: tasks.js 清理/统计任务行为测试
 * 覆盖 cleanupExpiredSessions（秒级 expires 清理 SQL）、cleanupExpiredNotifications（保留天数参数）、
 * cleanupExpiredShareLinks、cleanupExpiredFiles（递归/保留阈值/失败计数）、
 * generateDailyStats（范围查询上/下界 + cache 写入）与失败告警节流。
 * cron/utils/mailer/cache/backup-core 均 mock；fs 通过 jest.spyOn 注入临时目录场景。
 */
jest.mock('cron', () => ({ CronJob: jest.fn() }));
jest.mock('../utils', () => ({ getPool: jest.fn() }));
jest.mock('../mailer', () => ({ sendSystemAlert: jest.fn() }));
jest.mock('../cache', () => ({ set: jest.fn(), get: jest.fn() }));
jest.mock('../backup-core', () => ({ createBackup: jest.fn(), cleanupAutoBackups: jest.fn() }));

const fs = require('fs');
const tasks = require('../tasks');
const { getPool } = require('../utils');
const { sendSystemAlert } = require('../mailer');
const cache = require('../cache');

describe('P3-93 tasks 定时清理任务', () => {
  const poolMock = { query: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    getPool.mockReturnValue(poolMock);
    poolMock.query.mockReset();
  });

  test('cleanupExpiredSessions 使用秒级 expires 对比 SQL', async () => {
    poolMock.query.mockResolvedValue([{ affectedRows: 3 }]);
    await tasks.cleanupExpiredSessions();
    const [sql] = poolMock.query.mock.calls[0];
    expect(sql).toContain('DELETE FROM sessions WHERE expires < UNIX_TIMESTAMP()');
  });

  test('cleanupExpiredNotifications 按 NOTIFICATION_RETENTION_DAYS 传参清理', async () => {
    process.env.NOTIFICATION_RETENTION_DAYS = '15';
    poolMock.query.mockResolvedValue([{ affectedRows: 0 }]);
    await tasks.cleanupExpiredNotifications();
    const [sql, params] = poolMock.query.mock.calls[0];
    expect(sql).toContain('DATE_SUB(NOW(), INTERVAL ? DAY)');
    expect(params).toEqual([15]);
    delete process.env.NOTIFICATION_RETENTION_DAYS;
  });

  test('cleanupExpiredNotifications 默认保留 30 天', async () => {
    poolMock.query.mockResolvedValue([{ affectedRows: 0 }]);
    await tasks.cleanupExpiredNotifications();
    expect(poolMock.query.mock.calls[0][1]).toEqual([30]);
  });

  test('cleanupExpiredShareLinks 删除过期短链', async () => {
    poolMock.query.mockResolvedValue([{ affectedRows: 5 }]);
    await tasks.cleanupExpiredShareLinks();
    const [sql] = poolMock.query.mock.calls[0];
    expect(sql).toBe('DELETE FROM share_links WHERE expires_at < NOW()');
  });

  test('generateDailyStats 范围查询使用北京时间上/下界并写入缓存与告警', async () => {
    poolMock.query
      .mockResolvedValueOnce([{ 0: { count: 3 } }])
      .mockResolvedValueOnce([{ 0: { count: 5 } }])
      .mockResolvedValueOnce([{ 0: { count: 2 } }])
      .mockResolvedValueOnce([{ 0: { count: 4 } }]);
    cache.set.mockResolvedValue(true);
    sendSystemAlert.mockResolvedValue(true);

    await tasks.generateDailyStats();

    expect(poolMock.query).toHaveBeenCalledTimes(4);
    const firstQuery = poolMock.query.mock.calls[0];
    expect(firstQuery[0]).toContain('created_at >= ? AND created_at < ?');
    expect(firstQuery[1].length).toBe(2);
    expect(cache.set).toHaveBeenCalledWith(expect.stringMatching(/^stats:daily:/), expect.objectContaining({
      newUsers: 3, newPosts: 5, newEvents: 2, activeUsers: 4
    }), expect.any(Number));
    expect(sendSystemAlert).toHaveBeenCalledWith('日报统计', expect.stringContaining('用户注册: 3'));
  });

  test('cleanupExpiredFiles：仅清 tmp/temp 中超过保留期的文件、失败计数与深度上限', async () => {
    const oldDate = new Date(Date.now() - 200 * 24 * 3600 * 1000);
    const nowDate = new Date();
    const dirEntry = (name, isDir) => ({ name, isDirectory: () => isDir });

    const readdirMock = jest.spyOn(fs, 'readdirSync').mockImplementation((dir) => {
      const base = String(dir).split(/[\\/]/).pop();
      if (base === 'tmp' || base === 'temp') {
        return [
          dirEntry('old.log', false),
          dirEntry('recent.log', false),
          dirEntry('sub', true)
        ];
      }
      if (base === 'sub') {
        return [dirEntry('nested.log', false), dirEntry('deep', true)];
      }
      if (base === 'deep') {
        return [dirEntry('very.log', false)];
      }
      return [];
    });
    const statMock = jest.spyOn(fs, 'statSync').mockImplementation((p) => {
      const name = String(p).split(/[\\/]/).pop();
      return { mtime: name === 'recent.log' ? nowDate : oldDate };
    });
    const existsMock = jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    const unlinkMock = jest.spyOn(fs, 'unlinkSync').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await tasks.cleanupExpiredFiles();

    // old.log、nested.log、very.log 超期被删；recent.log 保留（深度 sub→deep > MAX_CLEAN_DEPTH=8 前逐层清理）
    expect(unlinkMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('清理过期临时文件'));
    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('深度超限'))).toBe(false);

    readdirMock.mockRestore();
    statMock.mockRestore();
    existsMock.mockRestore();
    unlinkMock.mockRestore();
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  test('cleanupExpiredFiles：递归深度超限时跳过并告警', async () => {
    const oldDate = new Date(Date.now() - 200 * 24 * 3600 * 1000);
    const dirEntry = (name, isDir) => ({ name, isDirectory: () => isDir });

    const readdirMock = jest.spyOn(fs, 'readdirSync').mockImplementation((dir) => {
      return [dirEntry('x', false), dirEntry('subd', true)];
    });
    const statMock = jest.spyOn(fs, 'statSync').mockImplementation(() => ({ mtime: oldDate }));
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'unlinkSync').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    // 深度 0..8 各含子目录，触发 >MAX_CLEAN_DEPTH(8) 告警（清理文件上限同时快速触及）
    await tasks.cleanupExpiredFiles();

    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('深度超限'))).toBe(true);

    readdirMock.mockRestore();
    statMock.mockRestore();
    warnSpy.mockRestore();
  });

  test('丢弃异常时告警节流：同 key 6 小时内只发一次', async () => {
    poolMock.query.mockRejectedValue(new Error('pool burst'));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await tasks.cleanupExpiredSessions();
    await tasks.cleanupExpiredSessions();
    await tasks.cleanupExpiredSessions();

    expect(sendSystemAlert).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });
});